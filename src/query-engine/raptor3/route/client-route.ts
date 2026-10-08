/**
 * Raptor 3 — private client route (G4-03).
 *
 * The one place that adapts the EXISTING client protocol to the candidate's
 * private prepared-operation boundary. It owns exactly one decision: which
 * driver an existing owner supplied for this run, and therefore which of the
 * two transaction grants the candidate receives. It owns no lifecycle —
 * request transforms, default omit, the extension chain, interceptors, the
 * official cache, raw SQL, transactions, arrays, observers and introspection
 * stay with their current owners, and this route is reached only through the
 * ordinary `PendingOperation` those owners already drive.
 *
 * It is NOT public: nothing here is exported from the package entry. Since the
 * C-01 cutover `VibORM`'s constructor builds it for every client, so it is the
 * ONE operation owner rather than a selectable alternative.
 */

import { officialCacheRuntime } from "@cache/capability";
import type { PhysicalSchemaCheck } from "@client/physical-schema";
import type { Operations } from "@client/types";
import type { AnyDriver, QueryExecutionContext } from "@drivers/exports";
import { UnsupportedOperationError } from "@errors";
import type { Schema } from "@schema/hydration";
import type { AnyModel } from "@schema/model";
import type { Sql } from "@sql";
import type { CacheResultCodec } from "../../cache-flow";
import type { PreparedBatchOperation } from "../../types";
import { createCommandEngine, type PreparedOperation } from "../commands";
import type { WriteOutcomeSeam } from "../shared/operation-context";
import type { CallRows } from "../shared/row-scope";
import type { ResolvedSchemaViews } from "../shared/schema";

/** What the existing pending-operation lifecycle knows when it executes. */
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

/** One client operation's facts, answered by the candidate. */
export interface RoutedCandidateOperation {
  /**
   * The payload this operation runs: the candidate's ONE admission of the
   * client-prepared input (post request transform, post default omit). The
   * same object the statements are built from, so the interceptor's `input`
   * and the cache key describe the query that actually runs.
   */
  readonly preparedArgs: Record<string, unknown>;
  /**
   * The ONE statement this operation compiles to, or `undefined` when it does
   * not compile to exactly one. A prepared read owns one and publishes it; a
   * write's fold is only reachable through the asynchronous
   * {@link RoutedCandidateOperation.prepareBatch}, which publishes a package of
   * driver-prepared queries rather than an `Sql`.
   */
  buildStatement(): Sql | undefined;
  cacheResultCodec(): CacheResultCodec;
  checkStorage(
    driver: AnyDriver,
    context: QueryExecutionContext
  ): Promise<void>;
  /**
   * The prepared package when this operation prepares to it synchronously —
   * a read, whose preparation reaches no driver. It is the SAME package
   * {@link RoutedCandidateOperation.prepareBatch} publishes, so the one query
   * an array member dispatches and the parser that reads its result come from
   * one preparation.
   */
  prepareSingle(
    context: QueryExecutionContext
  ): PreparedBatchOperation<unknown> | undefined;
  prepareBatch(
    context: QueryExecutionContext,
    driver?: AnyDriver
  ): Promise<PreparedBatchOperation<unknown> | undefined>;
  execute<T>(execution: RoutedOperationExecution): Promise<T>;
}

/** The client-scoped route a query engine consults instead of its executor. */
export interface ClientOperationRoute {
  operation(
    model: AnyModel,
    requestedOperation: string,
    args: Record<string, unknown>,
    rows?: CallRows
  ): RoutedCandidateOperation;
}

export type ClientOperationRouteFactory = (
  schema: Schema,
  driver: AnyDriver,
  resolved: ResolvedSchemaViews
) => ClientOperationRoute;

/** This operation's write-outcome seam, and whether it has already spoken. */
interface RouteWriteOutcome {
  published: boolean;
  readonly seam: WriteOutcomeSeam;
}

/**
 * Hand the candidate the client's own cache-invalidation rail.
 *
 * The durable phase of a write is a TRANSPORT fact — a segment acknowledged, or
 * a dispatch whose rollback the driver cannot prove — so the transport states
 * it, at the point it learns it, through this seam. The route reads no such
 * fact back out of a published error: `recordSeriesProgress` reports a record
 * series and nothing else (`g4/regression/note.md` "Seam round").
 */
function routeWriteOutcome(
  execution: RoutedOperationExecution
): RouteWriteOutcome | undefined {
  const { committedWriteSegment, writeMayBeVisible } = execution;
  if (!(committedWriteSegment || writeMayBeVisible)) return undefined;
  const outcome: RouteWriteOutcome = {
    published: false,
    seam: {
      committedSegment: async () => {
        outcome.published = true;
        if (committedWriteSegment) await committedWriteSegment();
      },
      mayBeVisible: async () => {
        outcome.published = true;
        if (writeMayBeVisible) await writeMayBeVisible();
      },
    },
  };
  return outcome;
}

class RoutedOperation implements RoutedCandidateOperation {
  readonly #factoryDriver: AnyDriver;
  readonly #modelName: string;
  readonly #requestedOperation: string;
  readonly #prepared: PreparedOperation;
  readonly #checkStorage: PhysicalSchemaCheck | undefined;
  #codec: CacheResultCodec | undefined;

  constructor(
    factoryDriver: AnyDriver,
    modelName: string,
    requestedOperation: string,
    prepared: PreparedOperation,
    checkStorage: PhysicalSchemaCheck | undefined
  ) {
    this.#factoryDriver = factoryDriver;
    this.#modelName = modelName;
    this.#requestedOperation = requestedOperation;
    this.#prepared = prepared;
    this.#checkStorage = checkStorage;
  }

  get preparedArgs(): Record<string, unknown> {
    return this.#prepared.args;
  }

  buildStatement(): Sql | undefined {
    return this.#prepared.read?.statement;
  }

  cacheResultCodec(): CacheResultCodec {
    // KEPT as a capability boundary (N4, plan §4). It alone owns "the
    // cache layer asked this engine to encode a verb this engine
    // publishes no prepared read for" — a boundary between two
    // independently-maintained vocabularies in two layers:
    // `CACHEABLE_OPERATIONS` (`query-engine/cache-flow.ts`, nine names,
    // including both `…OrThrow` variants) and the engine's own
    // `READ_OPERATIONS` (`shared/schema.ts`, seven), reconciled today
    // only by `admittedOperation`'s `…OrThrow` normalization. No type
    // ties them and no single upstream owner establishes the fact, so an
    // assertion here would establish a missing fact rather than state an
    // established one (ELEGANCE §5). The class stays public
    // (`UnsupportedOperationError`) because this seam
    // (`RoutedCandidateOperation`) is consumed outside raptor3.
    const read = this.#prepared.read;
    if (!read)
      throw new UnsupportedOperationError(
        `Cannot cache '${this.#requestedOperation}' on model '${this.#modelName}': the operation has no readable result.`,
        {
          meta: {
            model: this.#modelName,
            operation: this.#requestedOperation,
          },
        }
      );
    return (this.#codec ??= officialCacheRuntime().cacheCodec(
      read,
      this.#requestedOperation
    ));
  }

  async checkStorage(
    driver: AnyDriver,
    context: QueryExecutionContext
  ): Promise<void> {
    const read = this.#prepared.read;
    if (read) await this.#checkStorage?.(driver, context, read.models);
  }

  prepareSingle(
    context: QueryExecutionContext
  ): PreparedBatchOperation<unknown> | undefined {
    const prepared = this.#prepared.prepareSingle(context);
    return this.#checkStorage ? undefined : prepared;
  }

  async prepareBatch(
    context: QueryExecutionContext,
    driver = this.#factoryDriver
  ): Promise<PreparedBatchOperation<unknown> | undefined> {
    return this.#prepared.prepareBatch(context, this.#checkStorage, driver);
  }

  async execute<T>(execution: RoutedOperationExecution): Promise<T> {
    try {
      const outcome = execution.isWrite
        ? routeWriteOutcome(execution)
        : undefined;
      if (outcome)
        return runWriteCandidate<T>(
          this.#prepared,
          execution,
          this.#factoryDriver,
          outcome,
          this.#checkStorage
        );
      return runCandidate(
        this.#prepared,
        execution,
        this.#factoryDriver,
        undefined,
        this.#checkStorage
      ) as Promise<T>;
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

/**
 * Create the candidate route for one client lineage. The candidate engine is
 * factory-bound to that client's root driver, so any other driver reaching an
 * operation is a scope an existing owner opened — which is exactly the binding
 * decision below.
 *
 * `resolved` is the client's own already-composed topology index and schema
 * registry, handed over by identity: the candidate hydrates, validates and
 * registers nothing a second time (note.md B-3).
 */
export function createCandidateRoute(
  schema: Schema,
  factoryDriver: AnyDriver,
  resolved?: ResolvedSchemaViews,
  checkStorage?: PhysicalSchemaCheck
): ClientOperationRoute {
  const engine = createCommandEngine({
    schema,
    driver: factoryDriver,
    resolved,
  });
  return {
    operation(
      model: AnyModel,
      requestedOperation: string,
      args: Record<string, unknown>,
      rows?: CallRows
    ): RoutedCandidateOperation {
      const modelName = model["~"].names.ts ?? "unknown";
      const operation = requestedOperation as Operations;
      // One prepared handle per client operation. Admission and the prepared
      // read stay lazy inside it (LX-01); every consumer below reads the same
      // construction, so nothing is admitted or projected twice.
      return new RoutedOperation(
        factoryDriver,
        modelName,
        requestedOperation,
        engine.prepare(modelName, operation, args, rows),
        checkStorage
      );
    },
  };
}

async function runWriteCandidate<T>(
  prepared: PreparedOperation,
  execution: RoutedOperationExecution,
  factoryDriver: AnyDriver,
  outcome: RouteWriteOutcome,
  checkStorage?: PhysicalSchemaCheck
): Promise<T> {
  const value = await runCandidate(
    prepared,
    execution,
    factoryDriver,
    outcome.seam,
    checkStorage
  );
  // A transport that never separated commit from success — every direct
  // statement and every borrowed scope — leaves the operation's own success as
  // the only durable fact there is. That is the arm the shipped write-outcome
  // rail keeps for itself, on the same condition (`extensions/query.ts:286-293`,
  // `publishedDirectUnits === 0`).
  if (!outcome.published && execution.committedWriteSegment)
    await execution.committedWriteSegment();
  return value as T;
}

/**
 * Run one operation on the driver its owner selected.
 *
 * - root: no binding; the candidate owns its standalone envelope.
 * - an existing array owner's sequential fallback (`driverOverride`): the exact
 *   borrowed driver and NO grant — the array owner's transaction is the unit,
 *   exactly as the shipped `runLinearOn` path leaves it, so the candidate opens
 *   no scope and a failing statement poisons the array's scope.
 * - inside `$transaction(callback)` (the engine is bound to a transaction
 *   driver): the caller opened no scope for this operation, so the route
 *   TRANSFERS the right to open one. The candidate then applies the same
 *   envelope rule it applies everywhere — a statement-atomic write runs
 *   directly on the caller's transaction driver (poisoning it on failure,
 *   exactly as the shipped `runStatementAtomic` path does), a multi-statement
 *   one opens exactly one nested region and rolls back only its own work. The
 *   second grant is member isolation inside whichever of those two scopes is
 *   current.
 *
 * The route decides WHICH SITUATION it is in and states it; it never decides
 * whether an envelope is needed. `writeOutcome` is not a fourth situation: it
 * is the client's cache-invalidation rail, carried to the transport that is
 * the only thing able to say when a write became durable.
 */
function runCandidate(
  prepared: PreparedOperation,
  execution: RoutedOperationExecution,
  factoryDriver: AnyDriver,
  writeOutcome: WriteOutcomeSeam | undefined,
  checkStorage?: PhysicalSchemaCheck
): Promise<unknown> {
  const { context, driverOverride, engineDriver } = execution;
  if (driverOverride) {
    return prepared.execute(
      { driver: driverOverride, kind: "borrowed-transaction", writeOutcome },
      context,
      checkStorage
    );
  }
  if (engineDriver === factoryDriver)
    return prepared.execute(
      writeOutcome ? { kind: "standalone", writeOutcome } : undefined,
      context,
      checkStorage
    );
  return prepared.execute(
    {
      driver: engineDriver,
      kind: "borrowed-transaction",
      memberRollback: (execute, scoped) =>
        engineDriver.withTransaction(execute, undefined, scoped),
      operationRegion: (execute, scoped) =>
        engineDriver.withTransaction(execute, undefined, scoped),
      writeOutcome,
    },
    context,
    checkStorage
  );
}
