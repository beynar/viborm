import type { AnyDriver, QueryExecutionContext } from "@drivers";
import { TransactionError } from "@errors";
import type { Model } from "@schema/model";
import type { QueryEngine } from "../query-engine";
import { BulkCountOperation } from "./BulkCountOperation";
import { CreateManyOperation } from "./CreateManyOperation";
import { CreateOperation } from "./CreateOperation";
import { DeleteOperation } from "./DeleteOperation";
import { ManyAndReturnOperation } from "./ManyAndReturnOperation";
import type {
  ExecutableOperation,
  OperationExecutor,
} from "./OperationExecutor";
import { parseValidated, upsertEnvelopeSchema } from "./parse-boundary";
import { ReadOperation } from "./ReadOperation";
import { isRetryableRace } from "./race-retry";
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
): ExecutableOperation | undefined {
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
 */
export async function executeRoutedOperation<T>(
  executor: OperationExecutor,
  operation: ExecutableOperation,
  context: QueryExecutionContext,
  driverOverride?: AnyDriver
): Promise<T> {
  try {
    return await executor.execute<T>(operation, context, driverOverride);
  } catch (error) {
    if (!isRetryableRace(error)) throw error;
    return executor.execute<T>(operation, context, driverOverride);
  }
}

function constructOperation(
  engine: QueryEngine,
  model: Model<any>,
  operation: string,
  args: Record<string, unknown>
): ExecutableOperation | undefined {
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
      // E5-U3 — the ENVELOPE is validated HERE, at the one construction path a client
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
      return returnsRows(args)
        ? new ManyAndReturnOperation(engine, model, "createManyAndReturn", args)
        : new CreateManyOperation(engine, model, args);
    case "updateMany":
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
