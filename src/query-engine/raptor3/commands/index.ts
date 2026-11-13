import { adapterPinnedTable } from "@adapters/adapter-internals";
import type { Operations } from "@client/types";
import type { AnyDriver } from "@drivers/driver";
import type { QueryExecutionContext } from "@drivers/types";
import { NotFoundError, UnsupportedOperationError } from "@errors";
import type { AnyModel } from "@schema/model";
import type { Sql } from "@sql";
import { baseOperation } from "../../routed-operations";
import type { PreparedBatchOperation } from "../../types";
import { renderers } from "../shared/insert-value";
import type { Leaf, ProjectionShape, Queries, Read } from "../shared/query";
import { engineBackend } from "../shared/query-backend";
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
  type MemberRollback,
  SqlOperationContext,
} from "../shared/sql-operation-context";
import { SqlQueries } from "../shared/sql-queries";
import { nameOf } from "../shared/terms";
import { prepareCall, writeCall } from "../write";

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
   * set), `{}` (an aggregate record), `0` (`count`), `false` (`exist`). A
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

/** What the client's lifecycle knows when it runs an operation. */
export interface RoutedOperationExecution {
  /** This operation's immutable attribution, created with the operation. */
  readonly context: QueryExecutionContext;
  /** The driver of the engine this operation was created on. */
  readonly engineDriver: AnyDriver;
  /** A driver an existing transaction/array owner supplies for this run. */
  readonly driverOverride: AnyDriver | undefined;
  /** The existing read/write classification of the requested verb. */
  readonly isWrite: boolean;
  readonly committedWriteSegment: (() => Promise<void>) | undefined;
  readonly writeMayBeVisible: (() => Promise<void>) | undefined;
}

/**
 * One operation, before any execution.
 *
 * The client lifecycle is admission-first by construction — a stored answer must key
 * before it can look up, and an interceptor must see the payload before it calls
 * `proceed()` — so admission, the prepared read shape and the cardinality are
 * published here, exactly once, and execution consumes that same construction
 * (g4/unit03/note.md B-1). Admission itself stays lazy, because the client's own
 * `PendingOperation` is lazy (LX-01).
 */
export interface PreparedOperation {
  /**
   * The ONE admission of this input: the same object the statements are built
   * from, so an interceptor's `input` and the key of the call describe the
   * query that runs.
   */
  readonly args: Arguments;
  /** Present for read verbs: the one prepared read's published facts. */
  readonly read: PreparedRead | undefined;
  /** The model and the verb the caller asked for, `…OrThrow` included. */
  readonly requested: { readonly model: string; readonly operation: string };
  execute(
    binding?: ExecutionBinding,
    attribution?: QueryExecutionContext
  ): Promise<unknown>;
  /**
   * Runs it on the driver its owner selected.
   *
   * - root: no binding; the call owns its standalone envelope.
   * - an array owner's sequential fallback (`driverOverride`): the exact
   *   borrowed driver and NO grant — the array owner's transaction is the unit,
   *   so the call opens no scope and a failing statement poisons the array's.
   * - inside `$transaction(callback)` (the engine is bound to a transaction
   *   driver): the caller opened no scope for this operation, so the right to
   *   open one is TRANSFERRED. The call then applies the same envelope rule it
   *   applies everywhere — a statement-atomic write runs directly on the
   *   caller's transaction driver, a multi-statement one opens exactly one
   *   nested region and rolls back only its own work. The second grant is
   *   member isolation inside whichever of those two scopes is current.
   *
   * What a write left durable is a transport fact: the transport states it,
   * where it learns it, through the two notifications of the execution.
   */
  run(execution: RoutedOperationExecution): Promise<unknown>;
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

/** A class, not a closure: one is made per call, and its methods are made once. */
class PreparedCommand implements PreparedOperation {
  readonly #config: EngineConfig;
  readonly #queries: Queries;
  readonly #modelName: string;
  readonly #requested: Operations;
  readonly #operation: Operation;
  readonly #rawArgs: unknown;
  readonly #scope: CallScope | undefined;
  #admitted: Arguments | undefined;
  #prepared: Read | undefined;
  #facts: PreparedRead | undefined;

  constructor(
    config: EngineConfig,
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
    this.#queries = queries;
    this.#modelName = modelName;
    this.#requested = requested;
    this.#operation = baseOperation(requested);
    this.#rawArgs = rawArgs;
  }

  get #model(): AnyModel {
    return this.#config.schema[this.#modelName]!;
  }

  get requested(): { readonly model: string; readonly operation: string } {
    return { model: this.#modelName, operation: this.#requested };
  }

  /** What a verb that must find its row fails with where there is none. */
  get #missing(): (() => NotFoundError) | undefined {
    return this.#requested === this.#operation
      ? undefined
      : () =>
          new NotFoundError(nameOf(this.#model) ?? "unknown", this.#requested);
  }

  /**
   * Admitted where a required field the call's stamps write may be left out,
   * with the projection keys its domain declares kept beside the schema's.
   */
  get args(): Arguments {
    if (this.#admitted) return this.#admitted;
    const { schema } = this.#queries;
    const stamps = this.#scope?.rows.stamps;
    const domain = this.#scope?.domain;
    const own = (raw: unknown) =>
      schema.admit(this.#model, this.#operation, raw);
    const admit = domain?.projects
      ? () =>
          domain.admit(schema, this.#model, this.#operation, this.#rawArgs, own)
      : () => own(this.#rawArgs);
    return (this.#admitted =
      stamps === undefined ? admit() : parseStamped(stamps, admit));
  }

  #read(): Read | undefined {
    if (!isReadOperation(this.#operation)) return undefined;
    return (this.#prepared ??= (
      this.#scope?.domain.reads(this.#scope) ?? this.#queries
    ).read(this.#model, this.#operation, this.args));
  }

  get read(): PreparedRead | undefined {
    const value = this.#read();
    return value && (this.#facts ??= publishedFacts(value));
  }

  /** This call's context; only the binding, preparation and attribution vary. */
  #context(
    preparing: boolean,
    attribution?: QueryExecutionContext,
    binding?: ExecutionBinding
  ): SqlOperationContext {
    const { driver } = this.#config;
    return new (
      driver.backend
        ? engineBackend(driver.backend).context
        : SqlOperationContext
    )(
      this.#queries.schema,
      driver,
      this.#modelName,
      this.#operation,
      binding,
      preparing,
      attribution,
      this.#scope
    );
  }

  // Not `async`: the promise is handed back as it is. An async function
  // adopts a returned promise a microtask later, so a refusal thrown before
  // any I/O (V8003) sat rejected with no handler in between, which workerd
  // under nodejs_compat reports as an unhandled rejection.
  execute(
    binding?: ExecutionBinding,
    attribution?: QueryExecutionContext
  ): Promise<unknown> {
    try {
      const context = this.#context(false, attribution, binding);
      const value = this.#read();
      return value
        ? context.run(() => context.publish(value, this.#missing))
        : writeCall(
            context,
            this.#config.driver,
            this.#model,
            this.args,
            this.#rawArgs,
            binding
          );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  run(execution: RoutedOperationExecution): Promise<unknown> {
    const { driverOverride, engineDriver } = execution;
    const writeOutcome =
      execution.isWrite &&
      (execution.committedWriteSegment || execution.writeMayBeVisible)
        ? {
            committedSegment: execution.committedWriteSegment,
            mayBeVisible: execution.writeMayBeVisible,
          }
        : undefined;
    if (driverOverride)
      return this.execute(
        { driver: driverOverride, kind: "borrowed-transaction", writeOutcome },
        execution.context
      );
    if (engineDriver === this.#config.driver)
      return this.execute(
        writeOutcome && { kind: "standalone", writeOutcome },
        execution.context
      );
    const region: MemberRollback = (execute, scoped) =>
      engineDriver.withTransaction(execute, undefined, scoped);
    return this.execute(
      {
        driver: engineDriver,
        kind: "borrowed-transaction",
        memberRollback: region,
        operationRegion: region,
        writeOutcome,
      },
      execution.context
    );
  }

  prepareSingle(
    attribution?: QueryExecutionContext
  ): PreparedBatchOperation<unknown> | undefined {
    // Preparing admits the input whatever the verb compiles to: an operation
    // that publishes no single query still answers for the payload it was
    // handed, exactly as `prepareBatch` does.
    this.args;
    // A write is prepared by asking: its owner asks for the package.
    const value = this.#read();
    if (!value) return undefined;
    const context = this.#context(true, attribution);
    context.publishPrepared(value, this.#missing);
    return context.preparedBatch();
  }

  async prepareBatch(
    attribution?: QueryExecutionContext
  ): Promise<PreparedBatchOperation<unknown> | undefined> {
    return this.#read()
      ? this.prepareSingle(attribution)
      : prepareCall(
          this.#context(true, attribution),
          this.#config.driver,
          this.#model,
          this.args,
          this.#rawArgs
        );
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

/** The one operation owner of a client lineage: what its engines consult. */
export type CommandEngine = ReturnType<typeof createCommandEngine>;

/**
 * The engine of one client lineage, bound to that client's root driver.
 * `config.resolved` is the client's own already-composed topology index and
 * schema registry, handed over by identity: nothing is hydrated, validated or
 * registered a second time (note.md B-3).
 */
export function createCommandEngine(config: EngineConfig) {
  // One query owner for the prepared read. The adapter is pinned by identity
  // across transaction scoping (`TransactionBoundDriver` copies
  // `baseDriver.adapter`), so the statement and shape prepared here are valid for
  // every binding of this driver's lineage.
  const queries = sharedQueries(config);
  let byAdapter = renderers.get(config.schema);
  if (!byAdapter) renderers.set(config.schema, (byAdapter = new WeakMap()));
  byAdapter.set(config.driver.adapter, queries);
  const { driver } = config;
  const prepare = (
    modelName: string,
    requested: Operations,
    rawArgs: unknown,
    rows?: CallRows
  ): PreparedOperation =>
    new PreparedCommand(config, queries, modelName, requested, rawArgs, rows);
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
    if (driver.backend)
      throw new UnsupportedOperationError("$rows() needs an SQL driver");
    if (adapterPinnedTable(queries.adapter) === undefined)
      throw new UnsupportedOperationError(
        "$rows() needs a driver bound to its database (a MySQL namespace): a caller's CTE could otherwise stand for a table its rows read"
      );
    const scope = rows?.prepare(queries, instant);
    const gated = scope?.domain.projected(model)?.gates;
    if (gated !== undefined && gated.size > 0)
      throw new UnsupportedOperationError(
        `${nameOf(model)}.$rows() refuses read-gated fields: ${[...gated.keys()]}`
      );
    const view = (scope ? scope.domain.reads(scope) : queries) as SqlQueries;
    return view.rowsOf(model, alias);
  };
  /**
   * `driver` is the root driver the engine is bound to: an operation run on
   * any other driver runs in a scope its owner opened.
   */
  return { driver, prepare, rowsOf };
}
