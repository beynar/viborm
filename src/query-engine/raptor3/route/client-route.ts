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
 * It is NOT public: nothing here is exported from the package entry, and
 * `createClient` cannot select it. The shipped default route is unchanged.
 */

import { VibORM, type VibORMClient, type VibORMConfig } from "@client/client";
import type { Operations } from "@client/types";
import type { AnyDriver, QueryExecutionContext } from "@drivers";
import { CacheConfigurationError, UnsupportedOperationError } from "@errors";
import type { Schema } from "@schema/hydration";
import type { AnyModel } from "@schema/model";
import {
  arrayCodec,
  booleanCodec,
  compileScalarCodec,
  compileWidenedSumCodec,
  countCodec,
  nullableCodec,
  numberCodec,
  recordCodec,
  taggedRelationCodec,
  type ValueCodec,
} from "../../result/cache-value-codecs";
import type { PreparedBatchOperation } from "../../types";
import {
  createCommandEngine,
  type PreparedOperation,
  type PreparedRead,
} from "../commands";
import type { WriteOutcomeSeam } from "../shared/operation-context";
import type { Leaf, ProjectionShape } from "../shared/query";
import type { ResolvedSchemaViews } from "../shared/schema";

/**
 * The detached cache representation of one read result. Structural on purpose:
 * the official cache owns this contract, and the candidate must not import the
 * shipped result engine to name it.
 */
export interface RouteCacheResultCodec {
  snapshot(value: unknown): unknown;
  materialize(snapshot: unknown): unknown;
}

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
  cacheResultCodec(): RouteCacheResultCodec;
  prepareBatch(
    context: QueryExecutionContext
  ): Promise<PreparedBatchOperation<unknown> | undefined>;
  execute<T>(execution: RoutedOperationExecution): Promise<T>;
}

/** The client-scoped route a query engine consults instead of its executor. */
export interface ClientOperationRoute {
  operation(
    model: AnyModel,
    requestedOperation: string,
    args: Record<string, unknown>
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
        await committedWriteSegment?.();
      },
      mayBeVisible: async () => {
        outcome.published = true;
        await writeMayBeVisible?.();
      },
    },
  };
  return outcome;
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
  resolved?: ResolvedSchemaViews
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
      args: Record<string, unknown>
    ): RoutedCandidateOperation {
      const modelName = model["~"].names.ts ?? "unknown";
      const operation = requestedOperation as Operations;
      // One prepared handle per client operation. Admission and the prepared
      // read stay lazy inside it (LX-01); every consumer below reads the same
      // construction, so nothing is admitted or projected twice.
      const prepared = engine.prepare(modelName, operation, args);
      let codec: RouteCacheResultCodec | undefined;
      return {
        get preparedArgs(): Record<string, unknown> {
          return prepared.args;
        },
        cacheResultCodec(): RouteCacheResultCodec {
          const read = prepared.read;
          if (!read)
            throw new UnsupportedOperationError(
              `The Raptor 3 route cannot encode a cached result for '${requestedOperation}' on model '${modelName}': the verb publishes no prepared read.`,
              { meta: { model: modelName, operation: requestedOperation } }
            );
          return (codec ??= cacheCodec(read, requestedOperation));
        },
        prepareBatch(
          context: QueryExecutionContext
        ): Promise<PreparedBatchOperation<unknown> | undefined> {
          return prepared.prepareBatch(context);
        },
        async execute<T>(execution: RoutedOperationExecution): Promise<T> {
          const outcome = execution.isWrite
            ? routeWriteOutcome(execution)
            : undefined;
          const value = await runCandidate(
            prepared,
            execution,
            factoryDriver,
            outcome?.seam
          );
          // A transport that never separated commit from success — every
          // direct statement and every borrowed scope — leaves the operation's
          // own success as the only durable fact there is. That is the arm the
          // shipped write-outcome rail keeps for itself, on the same condition
          // (`extensions/query.ts:286-293`, `publishedDirectUnits === 0`).
          if (execution.isWrite && !outcome?.published)
            await execution.committedWriteSegment?.();
          return value as T;
        },
      };
    },
  };
}

/**
 * The detached cache representation of one prepared read.
 *
 * Every value codec here comes from the OFFICIAL owner
 * (`src/query-engine/result/cache-value-codecs.ts`), addressed the way that
 * owner is addressed — by the declaring `Scalar` object, never by a leaf's type
 * name — so the candidate adds no scalar-meaning authority and a cached value
 * materializes exactly as a freshly parsed one does. The STRUCTURE comes from
 * the prepared read's own published facts (`shape`, `value`, `single`,
 * `empty`), which the read owner states beside the statement it decodes, so the
 * codec and the decoder cannot disagree about cardinality.
 */
function cacheCodec(
  read: PreparedRead,
  requestedOperation: string
): RouteCacheResultCodec {
  // The read owner's own publication for zero rows says whether the public
  // value may be absent: `null` for a located row, `[]`/`{}`/`0`/`false` for
  // the shapes that always publish a value.
  const value = shapeCodec(read.value, requestedOperation);
  const compiled = read.empty === null ? nullableCodec(value) : value;
  return Object.freeze({
    snapshot(input: unknown): unknown {
      try {
        return compiled.snapshot(input, new WeakSet<object>());
      } catch (cause) {
        throw new CacheConfigurationError(
          "The operation result cannot be represented by the cache result codec.",
          {
            cause: cause instanceof Error ? cause : undefined,
            meta: { method: "snapshot", operation: requestedOperation },
          }
        );
      }
    },
    materialize(snapshot: unknown): unknown {
      try {
        return compiled.materialize(snapshot, new WeakSet<object>());
      } catch (cause) {
        throw new CacheConfigurationError(
          "The cached result snapshot is malformed.",
          {
            cause: cause instanceof Error ? cause : undefined,
            meta: { method: "materialize", operation: requestedOperation },
          }
        );
      }
    },
  });
}

/** One published shape, composed from the official structural codecs. */
function shapeCodec(
  shape: ProjectionShape | Leaf,
  requestedOperation: string
): ValueCodec {
  // biome-ignore lint/style/useDefaultSwitchClause: the published shape union is exhaustive; a default would be dead code.
  switch (shape.kind) {
    case "scalar":
      return leafCodec(shape, requestedOperation);
    case "object": {
      const fields = new Map<string, ValueCodec>();
      for (const [name, field] of Object.entries(shape.fields))
        fields.set(name, shapeCodec(field, requestedOperation));
      return recordCodec(fields);
    }
    case "collection":
      return arrayCodec(shapeCodec(shape.row, requestedOperation));
    case "variants": {
      const arms = new Map<string, ValueCodec>();
      for (const [type, arm] of Object.entries(shape.arms))
        arms.set(type, shapeCodec(arm, requestedOperation));
      const tagged = taggedRelationCodec(arms);
      return shape.many ? arrayCodec(tagged) : nullableCodec(tagged);
    }
    case "recursive":
      // A recursive read publishes a depth the prepared shape does not bound,
      // so no fixed codec describes it. The shipped compiler refuses the same
      // shape (`compileRowCodec`'s `unknown` column), and refusing is what
      // keeps a half-encoded entry out of the store.
      throw new UnsupportedOperationError(
        `The Raptor 3 route cannot encode a cached result for '${requestedOperation}': a recursive read's published depth is not a fixed shape.`,
        { meta: { operation: requestedOperation } }
      );
  }
}

/**
 * One leaf's value codec.
 *
 * A leaf that a column declares carries that `Scalar`, and the official owner
 * compiles it: `compileWidenedSumCodec` for a decimal `_sum` (which keeps the
 * field's scale and drops its precision), `compileScalarCodec` otherwise, with
 * the DECLARED nullability switched off because the projection's own
 * `nullable` is the fact — an aggregate over a non-null column still publishes
 * `null` for an empty window.
 *
 * The leaves with no declaring scalar are the read owner's OWN values, not a
 * column's meaning: `_count` (including a relation count), `exist`, and the
 * number a non-decimal `_avg` or a `_distance` publishes. Naming those three is
 * not a second scalar authority — it is the same classification the shipped
 * compiler makes in `compileAggregateLeafCodec` and in `compileRootCodec`'s
 * `existence`/`count` carriers.
 */
function leafCodec(leaf: Leaf, requestedOperation: string): ValueCodec {
  const declared = leaf.scalar;
  let value: ValueCodec;
  if (declared) {
    value = leaf.widened
      ? compileWidenedSumCodec(declared)
      : compileScalarCodec(declared, false);
  } else if (leaf.type === "boolean") value = booleanCodec();
  else if (leaf.type === "int") value = countCodec();
  else if (leaf.type === "number") value = numberCodec();
  else
    throw new UnsupportedOperationError(
      `The Raptor 3 route cannot encode a cached '${leaf.type}' result for '${requestedOperation}': the leaf publishes no declaring scalar.`,
      { meta: { operation: requestedOperation } }
    );
  return leaf.nullable ? nullableCodec(value) : value;
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
  writeOutcome: WriteOutcomeSeam | undefined
): Promise<unknown> {
  const { context, driverOverride, engineDriver } = execution;
  if (driverOverride) {
    return prepared.execute(
      { driver: driverOverride, kind: "borrowed-transaction", writeOutcome },
      context
    );
  }
  if (engineDriver === factoryDriver)
    return prepared.execute(
      writeOutcome ? { kind: "standalone", writeOutcome } : undefined,
      context
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
    context
  );
}

/**
 * Construct a client whose model operations execute through the candidate.
 *
 * Private by construction: it is the public `createClient` configuration and
 * the public client surface, with one non-public route argument. The shipped
 * default route is untouched; a cutover (C-01) is this call becoming the
 * default inside `VibORM.create`, not a new public entry.
 */
export function createCandidateClient<C extends VibORMConfig>(
  config: C
): VibORMClient<C> {
  return VibORM.create<C>(config, createCandidateRoute);
}
