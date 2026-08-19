import type { AnyDriver, QueryExecutionContext } from "@drivers";
import { hasCommittedRecordSeriesProgress, TransactionError } from "@errors";
import type { Model } from "@schema/model";
import {
  isPolymorphicCollectionRelation,
  isPolymorphicRelation,
  isRelation,
} from "../context/query-scope";
import type { QueryEngine } from "../query-engine";
import { BulkCountOperation } from "./BulkCountOperation";
import { CreateManyOperation } from "./CreateManyOperation";
import { CreateManyRecordSeries } from "./CreateManyRecordSeries";
import { CreateOperation } from "./CreateOperation";
import { DeleteOperation } from "./DeleteOperation";
import {
  ManyAndReturnOperation,
  refusesRowReturningSubstrate,
} from "./ManyAndReturnOperation";
import type { OperationExecutor } from "./OperationExecutor";
import { parseValidated, upsertEnvelopeSchema } from "./parse-boundary";
import { ReadOperation } from "./ReadOperation";
import { isRetryableRace } from "./race-retry";
import type { RoutedExecutableOperation } from "./record-series";
import { isRecord } from "./shared";
import { UpdateManyRecordSeries } from "./UpdateManyRecordSeries";
import { UpdateOperation } from "./UpdateOperation";
import { UpsertOperation } from "./UpsertOperation";

/**
 * Per-tree routing (P6 — the single engine). Construct the V2 operation for the
 * whole payload before any I/O. Every construction error propagates: a
 * `ValidationError`, the own-write preflight rejection, the documented
 * `requiresAtomicResolution` refusal, and — with V1 deleted — an
 * {@link UnsupportedOperationError} for a shape V2 does not express (a parity
 * refusal V1 also rejects, or a documented narrower boundary reached by no
 * conformance scenario; see route-inventory.test.ts). Every client operation
 * family is in ROUTED_OPERATIONS, so no client tree resolves to `undefined`.
 */

const READ_OPERATIONS: ReadonlySet<string> = new Set([
  "findMany",
  "findUnique",
  "findFirst",
  "findUniqueOrThrow",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "exist",
]);

/**
 * The operation names the engine owns a construction path for. Every client
 * operation family is here; a name outside it (there is none on the client path)
 * resolves to `undefined`.
 */
export const ROUTED_OPERATIONS: ReadonlySet<string> = new Set([
  ...READ_OPERATIONS,
  "create",
  "update",
  "delete",
  "upsert",
  "createMany",
  "updateMany",
  "deleteMany",
]);

/**
 * Construct the V2 operation for a routed payload. Returns `undefined` only for an
 * operation name outside {@link ROUTED_OPERATIONS} (no client family is — the
 * full-surface assertion in route-inventory.test.ts pins that). Every construction
 * error propagates, including an {@link UnsupportedOperationError} for a shape V2
 * does not express: with V1 deleted there is no fallback arm to catch it.
 */
export function constructRoutedOperation(
  engine: QueryEngine,
  model: Model<any>,
  operation: string,
  args: Record<string, unknown>
): RoutedExecutableOperation | undefined {
  if (!ROUTED_OPERATIONS.has(operation)) return undefined;
  // The `requiresAtomicResolution` refusal (ATOM “Error-order rules”), reproduced at the ROUTED
  // layer only. A batch-only, non-returning driver cannot resolve a single-row
  // mutation's returned identity atomically — its public result is parsed after
  // the atomic batch commits, and that parse cannot be rolled back — so
  // `update`/`delete`/`upsert` are refused before any I/O with a typed
  // `TransactionError`. V2's executor deliberately CAN run these in a forced
  // batch (via an in-batch terminal SELECT), and 31 executor-level batch
  // contracts depend on that capability, so the refusal must NOT live in the
  // operation constructor (it would regress them). It lives here, on the public
  // client path (this function is reached only through `client.ts` →
  // `PendingOperation.create`), while the executor keeps its capability for the
  // direct-executor contracts. A bulk write WITH `select` refuses in the
  // row-returning constructor instead (its identities need a post-commit read no
  // in-batch SELECT can supply); the `{ count }` arms of
  // `createMany`/`updateMany`/`deleteMany` do not require atomic resolution and
  // are unaffected.
  assertRoutedAtomicResolution(engine, operation);
  return constructOperation(engine, model, operation, args);
}

/** The single-row refetch operations whose returned identity needs atomic
 *  resolution on a non-returning driver — V1's `requiresAtomicResolution` set. */
const ATOMIC_RESOLUTION_OPERATIONS: ReadonlySet<string> = new Set([
  "update",
  "delete",
  "upsert",
]);

/**
 * Throw V1's byte-identical `TransactionError` when a batch-only, non-returning
 * driver is asked (through the public client path) for a single-row mutation
 * whose returned identity requires post-commit parsing. Mirrors V1's
 * `atomicExecutionErrorMessage` (`OperationRuntime`) exactly, per operation.
 */
function assertRoutedAtomicResolution(
  engine: QueryEngine,
  operation: string
): void {
  const { driver } = engine;
  const batchOnlyNonReturning =
    driver.supportsBatch &&
    !driver.supportsTransactions &&
    !engine.adapter.capabilities.supportsReturning;
  if (!(batchOnlyNonReturning && ATOMIC_RESOLUTION_OPERATIONS.has(operation))) {
    return;
  }
  const message =
    operation === "upsert"
      ? "cannot execute non-returning upsert writes atomically because public result parsing cannot be rolled back after an atomic batch commits"
      : `Driver '${driver.driverName}' cannot execute '${operation}' because public result parsing cannot be rolled back.`;
  throw new TransactionError(message, {
    meta: { driver: driver.driverName, operation },
  });
}

/**
 * Run a routed V2 operation with the write-race retry policy V1 applies **above**
 * the executor: a surfaced error that {@link isRetryableRace}
 * (a create-branch loser whose unique violation matched the failed step's
 * `racePin`, or a self-declared `meta.raceable` guard abort) retries the whole
 * operation ONCE. Re-planning re-reads committed state, so the loser now takes
 * its adopt arm and converges; a second failure propagates. A violation matching
 * no racePin and not `meta.raceable` never retries.
 *
 * A transaction-backed record series retries here as ONE unit because its prior
 * attempt rolled back. A progressive committed series attaches trusted progress;
 * this boundary retries only before its first committed segment. After a committed
 * prefix, only the current uncommitted member may retry inside the executor.
 */
export async function executeRoutedOperation<T>(
  executor: OperationExecutor,
  operation: RoutedExecutableOperation,
  context: QueryExecutionContext,
  driverOverride?: AnyDriver,
  committedWriteSegment?: () => Promise<void>,
  writeMayBeVisible?: () => Promise<void>
): Promise<T> {
  try {
    return await executor.execute<T>(
      operation,
      context,
      driverOverride,
      committedWriteSegment,
      writeMayBeVisible
    );
  } catch (error) {
    if (hasCommittedRecordSeriesProgress(error) || !isRetryableRace(error)) {
      throw error;
    }
    return executor.execute<T>(
      operation,
      context,
      driverOverride,
      committedWriteSegment,
      writeMayBeVisible
    );
  }
}

function constructOperation(
  engine: QueryEngine,
  model: Model<any>,
  operation: string,
  args: Record<string, unknown>
): RoutedExecutableOperation | undefined {
  if (READ_OPERATIONS.has(operation)) {
    return new ReadOperation(engine, model, operation, args);
  }
  switch (operation) {
    case "create":
      return new CreateOperation(engine, model, args);
    case "update":
      return new UpdateOperation(engine, model, args);
    case "delete":
      return new DeleteOperation(engine, model, args);
    case "upsert":
      // The ENVELOPE is validated HERE, at the one construction path a client
      // payload takes (a nested upsert never builds an `UpsertOperation`; it is a
      // relation payload the enclosing operation's schema already validated). The
      // envelope owns the three required keys, the five optional names, and the
      // object-ness of the arms — nothing about what is INSIDE the arms, which the
      // delegated sub-ops still parse raw, and which stays deferred to the taken branch.
      return new UpsertOperation(
        engine,
        model,
        parseValidated(upsertEnvelopeSchema, args, "upsert", "")
      );
    // IMPLICIT RETURNING (maintainer decision D-1). One client family per bulk
    // write; the presence of `select` — never a second operation name — chooses
    // the arm. Without it the tree is the `{ count }` machinery exactly as
    // before; with it the tree is the row-returning machinery the removed
    // `createManyAndReturn` / `updateManyAndReturn` used to reach. `select`
    // itself is validated by the ONE arg schema inside whichever arm is built,
    // so a malformed `select` still rejects with a typed ValidationError.
    case "createMany":
      // THREE DESTINATIONS, one discriminant each, in this order.
      //
      // (1) The row-returning owner comes FIRST when the substrate is the one it
      //     refuses on. A bulk write with `select` on a batch-only, non-returning
      //     driver is refused by `ManyAndReturnOperation` with a typed sentence
      //     naming `createMany` and `select`; a series on that substrate would
      //     instead inherit `withTransaction`'s generic "does not support callback
      //     transactions". Reaching for the existing owner keeps the specific
      //     message without minting a second copy of it.
      // (2) Any row carrying a general relation program — an ordinary relation key,
      //     or (plan §9.6) a polymorphic COLLECTION key, never a polymorphic to-one —
      //     routes the WHOLE operation to the record series (§5.1). Empty data has no
      //     row, so it never reaches here — and that matters more than it looks: a
      //     series REQUIRES an interactive transaction, so `createMany({ data: [] })`
      //     (what every caller spreading a possibly-empty array sends) would turn from
      //     `{ count: 0 }` into a TransactionError on every batch-only driver.
      //     Measured: the cost is NOT an extra BEGIN/COMMIT — the existing
      //     empty arm already opens one, because its plan is not a single statement.
      // (3) Otherwise the two existing owners, constructed unchanged.
      if (
        relationBearingRow(model, args.data) &&
        !refusesReturningHere(engine, args, "createManyAndReturn")
      ) {
        return new CreateManyRecordSeries(engine, model, args);
      }
      return returnsRows(args)
        ? new ManyAndReturnOperation(engine, model, "createManyAndReturn", args)
        : new CreateManyOperation(engine, model, args);
    case "updateMany":
      // PACKAGE K2 — the same three destinations J gave `createMany`, one
      // discriminant each, in the same order and for the same reasons.
      //
      // (1) The row-returning owner comes FIRST when the substrate is the one it
      //     refuses on, so its specific sentence ("cannot execute 'updateMany' with
      //     'select' because public result parsing cannot be rolled back") survives
      //     rather than degrading into `withTransaction`'s generic "does not support
      //     callback transactions". The `{ count }` arm of a relation-bearing payload
      //     DOES inherit that generic sentence on a batch-only driver — accepted, and
      //     the same trade J made: a record series needs an interactive transaction,
      //     full stop, and no typed copy of that fact would tell the caller anything
      //     the substrate error does not.
      // (2) Relation-bearing `data` routes the WHOLE operation to the record series
      //     (§5.2). Data with no relation VALUE never reaches it, so an
      //     `updateMany({ data: { name } })` keeps its one statement and its provider
      //     count exactly as before. Neither does `limit: 0`, for J's reason one
      //     operation name over: a cap of zero rows writes nothing, so no relation
      //     effect exists to be lost by answering it on the existing owner — which
      //     answers `{ count: 0 }` (or `[]`) with NO statement, where a series would
      //     open an interactive transaction and hand every batch-only driver a
      //     `TransactionError` for a call that does nothing.
      // (3) Otherwise the two existing owners, constructed unchanged.
      if (
        relationBearingData(model, args.data) &&
        !capsAtZeroRows(args) &&
        !refusesReturningHere(engine, args, "updateManyAndReturn")
      ) {
        return new UpdateManyRecordSeries(engine, model, args);
      }
      return returnsRows(args)
        ? new ManyAndReturnOperation(engine, model, "updateManyAndReturn", args)
        : new BulkCountOperation(engine, model, operation, args);
    case "deleteMany":
      // Implicit returning past Prisma, which has no returning `deleteMany`:
      // with `select` the rows are read (or RETURNED) as they are deleted.
      return returnsRows(args)
        ? new ManyAndReturnOperation(engine, model, "deleteManyAndReturn", args)
        : new BulkCountOperation(engine, model, operation, args);
    default:
      return undefined;
  }
}

/**
 * The implicit-returning discriminant, kept in ONE place so the runtime cannot
 * drift from `BulkWriteResult` in @client/types: a bulk write returns rows iff
 * the payload's `select` OR its `omit` has a VALUE. `omit` counts because it IS
 * a projection — it desugars to the `select` of everything it did not name
 * (@validation/model/args/omit) — and a projection on a write that answered
 * `{ count }` would be accepted and then ignored. `select: undefined` is an
 * absent select
 * (the spread-an-optional idiom), so it takes the `{ count }` arm — and it
 * reaches here at all only because the parse boundary treats an explicitly-
 * undefined key as absent on every path (see the dense-path rule in
 * @validation/primitives/object); it used to reject with "Expected object".
 *
 * `BulkWriteResult` applies the same VALUE rule statically, and where a static
 * type cannot decide it (a `select` whose type merely admits `undefined`) it
 * yields the union of both arms rather than guessing — the one case where the
 * two cannot be byte-identical, made explicit instead of silently wrong.
 */
function returnsRows(args: Record<string, unknown>): boolean {
  return args.select !== undefined || args.omit !== undefined;
}

/**
 * J2 — does this raw `createMany` payload carry a GENERAL relation program, the
 * thing the grouped bulk INSERT cannot express?
 *
 * It reads the RAW rows, before any parse, because §6 J2 requires the two existing
 * owners to be constructed unchanged: routing cannot hand them a pre-parsed payload,
 * and re-parsing a schema's own transformed output is measured non-idempotent (X2,
 * `parse-boundary.ts`). Raw key presence is exact here — neither the relation `create`
 * schema nor the polymorphic `createMany` union renames a key, and `undefined` is
 * absent on every path — so this agrees with what `partitionModelData` will later see.
 *
 * THE POLYMORPHIC HALF IS CARDINALITY-DISPATCHED (plan §9.6), and the asymmetry is
 * the whole point. A direct polymorphic TO-ONE key stays OUT of this set: it stores
 * private owner columns on the bulk row, and the grouped cross-row probe route in
 * `bulk-polymorphic-connect.ts` compiles it into the maximal grouped INSERT — a
 * shipped SQL contract pinned byte-for-byte (`parity-j-create-many.test.ts`). A
 * polymorphic COLLECTION key is IN: its membership lives in per-variant member
 * junction rows that cannot exist before the owner row does, so the grouped INSERT
 * cannot express it and the whole call belongs to the record series. Both halves
 * are read through one predicate pair — `isRelation` for the ordinary set,
 * `isPolymorphicCollectionRelation` for the collection half — and the collection
 * half branches through `polymorphicCardinality`, not an inline cardinality test.
 *
 * Total and non-throwing by construction. Anything it cannot see with certainty — a
 * `data` that is not an array, a row that is not a record, a relation key holding
 * garbage — falls back to the existing owner, so every malformed payload keeps its
 * current error verbatim, including which of the two arms' issue paths it carries.
 *
 * WHAT THIS IS, precisely, so it is not mistaken for a second parser: a ONE-SIDED
 * over-approximation of the parser's answer. It asks raw KEY PRESENCE; the parser
 * asks whether a PROGRAM was built. Over-approximation is reachable — `{ posts: {} }`
 * builds no program — and it costs a transaction that writes nothing extra. The other
 * direction, raw-false while the parser builds a program, would send a relation-bearing
 * payload to the grouped INSERT and silently drop it; it requires a relation schema
 * that renames or invents a key, and none does — including the collection `create`
 * family root `createMany` now mounts, which renames nothing. The hazard is asymmetric
 * and this predicate is safe on it, which is why the duplication stays rather than
 * merging into a parse-once routing envelope (that would move validation timing and
 * error text). The same property, one key set wider, holds for
 * {@link relationBearingData}.
 */
function relationBearingRow(model: Model<any>, data: unknown): boolean {
  if (!Array.isArray(data)) return false;
  for (const row of data) {
    if (!isRecord(row)) continue;
    for (const key of Object.keys(row)) {
      if (row[key] === undefined) continue;
      if (isRelation(model, key) || isPolymorphicCollectionRelation(model, key))
        return true;
    }
  }
  return false;
}

/**
 * K2 — does this raw `updateMany` payload's `data` name a relation at all?
 *
 * The sibling above deliberately asks about ORDINARY relations only, because a
 * direct polymorphic `connect` inside `createMany` has a grouped bulk route that must
 * stay reachable. There is NO such route for `updateMany`: `bulk-polymorphic-connect`
 * is imported by the two create owners alone. So this predicate must include
 * polymorphic keys, and the difference is not cosmetic — `buildSet` (the SET builder
 * behind `buildUpdateMany`) SKIPS any key that is not a scalar, so a polymorphic key
 * that failed this test would be routed to the one-statement owner and then silently
 * dropped from the UPDATE. Same shape of hazard as its sibling's, one key set wider.
 *
 * It reads the RAW `data`, before any parse, because §6 K2 requires the two existing
 * owners to be constructed unchanged: routing cannot hand them a pre-parsed payload,
 * and re-parsing a schema's transformed output is measured non-idempotent (X2). Raw
 * key presence is exact here — the relation update schemas rename no key, and
 * `undefined` is absent on every path — so this agrees with what `partitionModelData`
 * will later see.
 *
 * Total and non-throwing by construction: a `data` that is not a record falls back to
 * the existing owner, so every malformed payload keeps its current error verbatim.
 */
function relationBearingData(model: Model<any>, data: unknown): boolean {
  if (!isRecord(data)) return false;
  for (const key of Object.keys(data)) {
    if (data[key] === undefined) continue;
    if (isRelation(model, key) || isPolymorphicRelation(model, key))
      return true;
  }
  return false;
}

/**
 * Does this bulk payload cap itself at no rows at all?
 *
 * `limit: 0` is the one public spelling of "affect nothing", and both existing bulk
 * owners already compile it to the EMPTY plan (`BulkCountOperation` answers
 * `{ count: 0 }`, `ManyAndReturnOperation` answers `[]`, neither issues a statement).
 * Reading it RAW is exact for the same reason the two data predicates above read raw:
 * the schema neither renames nor derives `limit`, so a validated `0` is a raw `0`, and
 * any other spelling falls through to the owner that rejects it with its own message.
 */
function capsAtZeroRows(args: Record<string, unknown>): boolean {
  return args.limit === 0;
}

/**
 * Would the row-returning owner refuse this payload on this substrate? That refusal
 * ("cannot execute '<operation>' with 'select' because public result parsing cannot be
 * rolled back") is the specific answer for a batch-only non-returning driver, and it
 * must survive the series destinations J and K added — so the series is skipped when
 * it applies and the existing owner answers instead.
 *
 * The substrate half is that owner's OWN exported predicate, not a copy of it: this
 * file adds only the question the router alone can answer, which is whether the
 * payload asks for rows at all.
 */
function refusesReturningHere(
  engine: QueryEngine,
  args: Record<string, unknown>,
  kind: "createManyAndReturn" | "updateManyAndReturn"
): boolean {
  return returnsRows(args) && refusesRowReturningSubstrate(engine, kind);
}
