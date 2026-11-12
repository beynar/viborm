import { adapterPinnedTable } from "@adapters/adapter-internals";
import type { Operations } from "@client/types";
import type { QueryExecutionContext } from "@drivers/types";
import { NotFoundError, UnsupportedOperationError } from "@errors";
import type { AnyModel } from "@schema/model";
import type { Sql } from "@sql";
import { baseOperation } from "../../routed-operations";
import type { PreparedBatchOperation } from "../../types";
import { renderers } from "../shared/insert-value";
import type { Leaf, ProjectionShape, Queries, Read } from "../shared/query";
import {
  type CallContext,
  type EngineBackend,
  engineBackend,
} from "../shared/query-backend";
import {
  type CallRows,
  type CallScope,
  parseStamped,
} from "../shared/row-scope";
import {
  type Arguments,
  type EngineConfig,
  EngineSchema,
  isReadOperation,
  type Operation,
} from "../shared/schema";
import {
  type ExecutionBinding,
  SqlOperationContext,
} from "../shared/sql-operation-context";
import { SqlQueries } from "../shared/sql-queries";
import { prepareCall, writeCall } from "../write";

type BackendPlan = ReturnType<EngineBackend["plan"]>;

/**
 * What a prepared read publishes before it runs.
 *
 * These are not a second statement of the read owner's decision — they are read
 * FROM it, by asking the prepared `Read` what it publishes for zero rows, so the
 * two cannot disagree for any verb.
 */
export interface PreparedRead {
  /**
   * The shape of the ROW the prepared statement decodes. For every verb whose
   * public value is the row (or the rows), this is the public value's shape too;
   * `count` and `exist` publish a value DERIVED from that row (`_count`), and
   * {@link PreparedRead.empty} is what tells a consumer which it is looking at.
   */
  readonly shape: ProjectionShape;
  /**
   * The PUBLIC value's own shape, which is not always the row shape: `count`
   * publishes a number and `exist` a boolean, and `findMany`/`groupBy` publish
   * a collection of rows.
   */
  readonly value: ProjectionShape | Leaf;
  /**
   * Does this read publish ONE row-like value rather than the row set? True for
   * `findUnique`, `findFirst`, `aggregate` and a selected `count`; false for
   * `findMany`, `groupBy`, a plain `count` (a number) and `exist` (a boolean).
   */
  readonly single: boolean;
  /**
   * The read owner's own publication for zero rows: `null` (a row), `[]` (the
   * set), `{}` (an aggregate record), `0` (`count`), `false` (`exist`). A cache
   * result codec reads the public value's kind here instead of assuming the row
   * shape is the value's shape — `count` publishes `3`, never `{_count: 3}`.
   */
  readonly empty: unknown;
  /**
   * The ONE statement this read compiles to, as the prepared `Read` built it.
   * It is the `Sql` the execution runs, read from the same construction, so
   * `buildStatement()` and the run cannot describe different queries.
   */
  readonly statement: Sql;
}

/**
 * The published facts, forwarded from the prepared `Read` itself. The read owner
 * STATES the cardinality and the public value's shape beside the statement it
 * decodes (`Queries.read`), so nothing here re-derives either from behavior.
 */
function publishedFacts(value: Read): PreparedRead {
  return {
    shape: value.query.shape,
    value: value.value,
    single: value.single,
    empty: value.result([]),
    statement: value.query.sql,
  };
}

/**
 * One admitted operation, before any execution.
 *
 * The client lifecycle is admission-first by construction — a cache must key
 * before it can look up, and an interceptor must see the payload before it calls
 * `proceed()` — so admission, the prepared read shape and the cardinality are
 * published here, exactly once, and execution consumes that same construction
 * (g4/unit03/note.md B-1). Admission itself stays lazy, because the client's own
 * `PendingOperation` is lazy (LX-01).
 */
export interface PreparedOperation {
  /** The ONE admission of this input. */
  readonly args: Arguments;
  /** Present for read verbs: the one prepared read's published facts. */
  readonly read?: PreparedRead;
  execute(
    binding?: ExecutionBinding,
    attribution?: QueryExecutionContext
  ): Promise<unknown>;
  prepareBatch(
    attribution?: QueryExecutionContext
  ): Promise<PreparedBatchOperation<unknown> | undefined>;
  /**
   * The same package as {@link PreparedOperation.prepareBatch}, for the verbs
   * whose preparation reaches no driver and therefore completes synchronously:
   * a read, which queues its one statement and states its parser in one call.
   * Every other verb needs the asynchronous fold and answers `undefined`.
   */
  prepareSingle(
    attribution?: QueryExecutionContext
  ): PreparedBatchOperation<unknown> | undefined;
}

class PreparedCommand implements PreparedOperation {
  readonly #config: EngineConfig;
  readonly #schema: EngineSchema;
  /** {@link Queries} itself, unless the driver supplies another language. */
  readonly #queries: Queries;
  readonly #operation: Operation;
  readonly #model: EngineConfig["schema"][string];
  readonly #modelName: string;
  readonly #rawArgs: unknown;
  readonly #missing: (() => NotFoundError) | undefined;
  readonly #scope: CallScope | undefined;
  #admitted: Arguments | undefined;
  #prepared: Read | undefined;
  #facts: PreparedRead | undefined;

  constructor(
    config: EngineConfig,
    schema: EngineSchema,
    queries: Queries,
    modelName: string,
    requested: Operations,
    rawArgs: unknown,
    rows?: CallRows
  ) {
    // The call's one instant lives with the prepared call, so a replan and
    // every occurrence it re-admits share it.
    let instant: Date | undefined;
    this.#scope = rows?.prepare(queries, () => (instant ??= new Date()));
    this.#config = config;
    this.#schema = schema;
    this.#queries = queries;
    this.#operation = baseOperation(requested);
    this.#model = config.schema[modelName]!;
    this.#modelName = modelName;
    this.#rawArgs = rawArgs;
    this.#missing =
      requested === this.#operation
        ? undefined
        : () =>
            new NotFoundError(
              this.#model["~"].names.ts ?? "unknown",
              requested
            );
  }

  get args(): Arguments {
    return (this.#admitted ??= this.#admit());
  }

  /**
   * Admitted where a required field the call's stamps write may be left out,
   * with the projection keys its domain declares kept beside the schema's.
   */
  #admit(): Arguments {
    const stamps = this.#scope?.rows.stamps;
    const domain = this.#scope?.domain;
    const admit = domain?.projects
      ? () =>
          domain.admit(
            this.#schema,
            this.#model,
            this.#operation,
            this.#rawArgs,
            (raw) => this.#schema.admit(this.#model, this.#operation, raw)
          )
      : () => this.#schema.admit(this.#model, this.#operation, this.#rawArgs);
    return stamps === undefined ? admit() : parseStamped(stamps, admit);
  }

  #read(): Read | undefined {
    if (!isReadOperation(this.#operation)) return undefined;
    return (this.#prepared ??= (
      this.#scope?.domain.reads(this.#scope) ?? this.#queries
    ).read(this.#model, this.#operation, this.args));
  }

  get read(): PreparedRead | undefined {
    const value = this.#read();
    if (!value) return undefined;
    return (this.#facts ??= publishedFacts(value));
  }

  /** This call's context; only the binding, preparation and attribution vary. */
  #context(
    preparing: boolean,
    attribution?: QueryExecutionContext,
    binding?: ExecutionBinding
  ): CallContext {
    const { backend } = this.#config.driver;
    const Context = backend
      ? engineBackend(backend).context
      : SqlOperationContext;
    return new Context(
      this.#schema,
      this.#config.driver,
      this.#modelName,
      this.#operation,
      binding,
      preparing,
      attribution,
      this.#scope
    );
  }

  /** A write in a language of the driver's own: the driver's backend says how it runs. */
  #plan(context: CallContext): BackendPlan {
    return engineBackend(this.#config.driver.backend!).plan(
      context,
      this.#model,
      this.args,
      this.#rawArgs as Arguments
    );
  }

  #body(context: CallContext) {
    const value = this.#read();
    if (value) return context.run(() => context.publish(value, this.#missing));
    // The physical form is constructed before the envelope decision and runs
    // once, whichever envelope the rule chooses; each attempt after the first
    // plans again from the same admitted arguments.
    let planned: BackendPlan | undefined = this.#plan(context);
    const single = planned.single;
    return context.run(() => {
      const plan = planned ?? this.#plan(context);
      planned = undefined;
      return plan.run();
    }, single);
  }

  /** Whether the call is a write in SQL: the engine's own write path runs it. */
  get #writes(): boolean {
    return !(isReadOperation(this.#operation) || this.#config.driver.backend);
  }

  execute(
    binding?: ExecutionBinding,
    attribution?: QueryExecutionContext
  ): Promise<unknown> {
    try {
      const context = this.#context(false, attribution, binding);
      return this.#writes
        ? writeCall(
            context as SqlOperationContext,
            this.#config.driver,
            this.#model,
            this.args,
            this.#rawArgs,
            binding
          )
        : this.#body(context);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  prepareSingle(
    attribution?: QueryExecutionContext
  ): PreparedBatchOperation<unknown> | undefined {
    // Preparing admits the input whatever the verb compiles to: an
    // operation that publishes no single query still answers for the
    // payload it was handed, exactly as `prepareBatch` does.
    this.args;
    // A write in SQL is prepared by asking: its owner asks for the package.
    if (this.#writes) return undefined;
    const context = this.#context(true, attribution);
    const value = this.#read();
    if (value) {
      context.publishPrepared(value, this.#missing);
      return context.preparedBatch();
    }
    // A write whose plan is one statement publishes the same package.
    // Preparation reaches no driver and queues synchronously; anything it
    // would refuse is refused again by the arm that runs the operation.
    const plan = this.#plan(context);
    if (!plan.single) return undefined;
    plan.run().catch(() => undefined);
    return context.preparedBatch();
  }

  async prepareBatch(
    attribution?: QueryExecutionContext
  ): Promise<PreparedBatchOperation<unknown> | undefined> {
    const context = this.#context(true, attribution);
    if (this.#writes)
      return prepareCall(
        context as SqlOperationContext,
        this.#config.driver,
        this.#model,
        this.args,
        this.#rawArgs
      );
    try {
      await this.#body(context);
    } catch (error) {
      if (context.isIncompletePreparation(error)) return undefined;
      throw error;
    }
    return context.preparedBatch();
  }
}

/**
 * Prepared queries per driver result parser. Weak: a schema and adapter can
 * outlive every client, and a transient driver's parser (with whatever it
 * captures) must be released with it. A driver without a parser has one slot.
 */
interface QueriesByResult {
  readonly parsers: WeakMap<object, Queries>;
  none?: Queries;
}

/**
 * Engines over the same resolved registry share one schema view and, per
 * adapter and result parser, one query owner: both derive only from those
 * inputs, so a client created per request reuses the warm per-model views
 * instead of rebuilding them.
 */
const sharedEngines = new WeakMap<
  object,
  {
    schema: EngineSchema;
    queries: WeakMap<object, QueriesByResult>;
  }
>();

function sharedQueries(config: EngineConfig): Queries {
  const { adapter, result, backend } = config.driver;
  const createQueries = (
    ...args: ConstructorParameters<typeof SqlQueries>
  ): Queries =>
    backend
      ? new (engineBackend(backend).queries)(...args)
      : new SqlQueries(...args);
  const key = config.resolved?.registry;
  let shared = key && sharedEngines.get(key);
  if (!shared) {
    shared = {
      schema: new EngineSchema(config.schema, config.resolved),
      queries: new WeakMap(),
    };
    if (key) sharedEngines.set(key, shared);
  }
  let byResult = shared.queries.get(adapter);
  if (!byResult)
    shared.queries.set(adapter, (byResult = { parsers: new WeakMap() }));
  if (!result) {
    return (byResult.none ??= createQueries(shared.schema, adapter, result));
  }
  let queries = byResult.parsers.get(result);
  if (!queries) {
    queries = createQueries(shared.schema, adapter, result);
    byResult.parsers.set(result, queries);
  }
  return queries;
}

export function createCommandEngine(config: EngineConfig) {
  // One query owner for the prepared read. The adapter is pinned by identity
  // across transaction scoping (`TransactionBoundDriver` copies
  // `baseDriver.adapter`), so the statement and shape prepared here are valid for
  // every binding of this driver's lineage.
  const queries = sharedQueries(config);
  let byAdapter = renderers.get(config.schema);
  if (!byAdapter) renderers.set(config.schema, (byAdapter = new WeakMap()));
  byAdapter.set(config.driver.adapter, queries);
  const { schema } = queries;
  const prepare = (
    modelName: string,
    requested: Operations,
    rawArgs: unknown,
    rows?: CallRows
  ): PreparedOperation =>
    new PreparedCommand(
      config,
      schema,
      queries,
      modelName,
      requested,
      rawArgs,
      rows
    );
  /**
   * `$rows`: `model`'s rows a root read under `rows` takes, as a raw read's
   * `FROM` item named `alias`. A model whose layers gate a field's reads is
   * refused: `SELECT *` would disclose it to every row.
   */
  const rowsOf = (
    model: AnyModel,
    alias: string,
    rows: CallRows | undefined,
    instant: () => Date
  ): Sql => {
    if (config.driver.backend)
      throw new UnsupportedOperationError("$rows() needs an SQL driver");
    if (adapterPinnedTable(queries.adapter) === undefined)
      throw new UnsupportedOperationError(
        "$rows() needs a driver bound to its database (a MySQL namespace): a caller's CTE could otherwise stand for a table its rows read"
      );
    const scope = rows?.prepare(queries, instant);
    const gated = scope?.domain.projected(model)?.gates;
    if (gated !== undefined && gated.size > 0)
      throw new UnsupportedOperationError(
        `${model["~"].names.ts}.$rows() refuses read-gated fields: ${[...gated.keys()]}`
      );
    const view = (scope ? scope.domain.reads(scope) : queries) as SqlQueries;
    return view.rowsOf(model, alias);
  };
  return { prepare, rowsOf };
}
