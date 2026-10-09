import type { Operations } from "@client/types";
import type { AnyDriver } from "@drivers/exports";
import type { QueryExecutionContext } from "@drivers/types";
import { NotFoundError } from "@errors";
import type { Sql } from "@sql";
import type { PreparedBatchOperation } from "../../types";
import { unreachable } from "../shared/invariant";
import {
  type ExecutionBinding,
  OperationContext,
} from "../shared/operation-context";
import type { Leaf, ProjectionShape, Read } from "../shared/query";
import { PreparedDomain, Queries } from "../shared/query";
import {
  type CallRows,
  type CallScope,
  parseStamped,
  type RowDomain,
} from "../shared/row-scope";
import {
  type Arguments,
  type EngineConfig,
  EngineSchema,
  isReadOperation,
  type Operation,
} from "../shared/schema";
import { Commands, type PhysicalPlan } from "./commands";

/**
 * The admitted operation an `…OrThrow` verb shares its whole envelope with.
 *
 * Every verb the client can spell is a member of the closed `Operations`
 * union, so the arms below are the whole vocabulary and the compiler proves
 * it: the `default` arm's value has no members left. There is no operation
 * this engine does not implement — that was a sentence about a state the type
 * forbids (N4, plan §4).
 */
function admittedOperation(operation: Operations): Operation {
  switch (operation) {
    case "findUniqueOrThrow":
      return "findUnique";
    case "findFirstOrThrow":
      return "findFirst";
    case "create":
    case "createMany":
    case "update":
    case "upsert":
    case "updateMany":
    case "delete":
    case "deleteMany":
    case "findMany":
    case "findUnique":
    case "findFirst":
    case "count":
    case "exist":
    case "aggregate":
    case "groupBy":
      return operation;
    default:
      return unreachable(operation, "client operation");
  }
}

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
    attribution?: QueryExecutionContext,
    driver?: AnyDriver
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
    this.#scope = rows && {
      rows,
      domain: preparedDomain(queries, rows.domain),
      defaults: preparedDomain(queries, rows.defaults),
      instant: () => (instant ??= new Date()),
    };
    this.#config = config;
    this.#schema = schema;
    this.#queries = queries;
    this.#operation = admittedOperation(requested);
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

  /** Admitted where a required field the call's stamps write may be left out. */
  #admit(): Arguments {
    const stamps = this.#scope?.rows.stamps;
    const admit = () =>
      this.#schema.admit(this.#model, this.#operation, this.#rawArgs);
    return stamps === undefined ? admit() : parseStamped(stamps, admit);
  }

  #read(): Read | undefined {
    if (!isReadOperation(this.#operation)) return undefined;
    return (this.#prepared ??= (
      this.#scope?.domain.reads ?? this.#queries
    ).read(this.#model, this.#operation, this.args));
  }

  get read(): PreparedRead | undefined {
    const value = this.#read();
    if (!value) return undefined;
    return (this.#facts ??= publishedFacts(value));
  }

  #body(context: OperationContext) {
    const value = this.#read();
    if (value) return context.run(() => context.publish(value, this.#missing));
    // The physical form is constructed BEFORE the envelope decision and runs
    // once, whichever envelope the rule chooses.
    let planned: PhysicalPlan | undefined = new Commands(context).plan(
      this.#model,
      this.args,
      this.#rawArgs as Arguments
    );
    const single = planned.single;
    // Each ATTEMPT runs its own occurrence tree. The envelope restart and the
    // recovery both re-enter this body, and a recovery re-plans from the same
    // ADMITTED arguments — never re-validated, never re-transformed (rule 10,
    // Arnaud's D-25) — because the tree that ran carries the members it
    // captured and a series occurrence is expanded exactly once. The first
    // attempt consumes the plan built above, which is also the plan that
    // answered the envelope question, so nothing is constructed twice to
    // START an operation.
    return context.run(() => {
      const plan =
        planned ??
        new Commands(context).plan(
          this.#model,
          this.args,
          this.#rawArgs as Arguments
        );
      planned = undefined;
      return plan.run();
    }, single);
  }

  execute(
    binding?: ExecutionBinding,
    attribution?: QueryExecutionContext
  ): Promise<unknown> {
    try {
      return this.#body(
        new OperationContext(
          this.#schema,
          this.#config.driver,
          this.#modelName,
          this.#operation,
          binding,
          false,
          attribution,
          this.#scope
        )
      );
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
    const args = this.args;
    const context = new OperationContext(
      this.#schema,
      this.#config.driver,
      this.#modelName,
      this.#operation,
      undefined,
      true,
      attribution,
      this.#scope
    );
    const value = this.#read();
    if (value) {
      context.publishPrepared(value, this.#missing);
      return context.preparedBatch();
    }
    // D-20: a WRITE whose plan is one statement publishes the same package
    // (`prepareBatch` would publish it too), so the array owner parses it
    // through its own `parseResult` seam and interceptor onion instead of
    // through the batch. It is not a second preparation: this is the
    // preparation, and `Commands.plan` states the ONE-statement
    // admissibility itself. Preparation reaches no driver and queues
    // synchronously, so the package is in hand when this returns; anything
    // it would refuse — a capability gate, the dynamic-planning sentinel —
    // is refused again, and reported, by the arm that actually runs the
    // operation, which is the only arm a caller takes once no single
    // package is published.
    const plan = new Commands(context).plan(
      this.#model,
      args,
      this.#rawArgs as Arguments
    );
    if (!plan.single) return undefined;
    plan.run().catch(() => undefined);
    return context.preparedBatch();
  }

  async prepareBatch(
    attribution?: QueryExecutionContext,
    driver?: AnyDriver
  ): Promise<PreparedBatchOperation<unknown> | undefined> {
    const context = new OperationContext(
      this.#schema,
      driver ?? this.#config.driver,
      this.#modelName,
      this.#operation,
      undefined,
      true,
      attribution,
      this.#scope
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

/**
 * Each row domain a call selects, prepared once per query owner. A prepared
 * domain derives only from the domain and that owner (its adapter and result
 * parser), so clients sharing the owner share it too; a client without `rows`
 * never reaches the map.
 */
const preparedDomains = new WeakMap<
  Queries,
  WeakMap<RowDomain, PreparedDomain>
>();

function preparedDomain(queries: Queries, rows: RowDomain): PreparedDomain {
  let byDomain = preparedDomains.get(queries);
  if (!byDomain) preparedDomains.set(queries, (byDomain = new WeakMap()));
  let domain = byDomain.get(rows);
  if (!domain) byDomain.set(rows, (domain = new PreparedDomain(rows, queries)));
  return domain;
}

function sharedQueries(config: EngineConfig): Queries {
  const { adapter, result } = config.driver;
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
    return (byResult.none ??= new Queries(shared.schema, adapter, result));
  }
  let queries = byResult.parsers.get(result);
  if (!queries) {
    queries = new Queries(shared.schema, adapter, result);
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
  return { prepare };
}
