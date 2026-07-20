import type { AnyDriver, QueryExecutionContext } from "@drivers";
import type { Model } from "@schema/model";
import type { QueryEngine } from "../query-engine/query-engine";
import { BulkCountOperation } from "./BulkCountOperation";
import { CreateManyOperation } from "./CreateManyOperation";
import { DeleteOperation } from "./DeleteOperation";
import { ManyAndReturnOperation } from "./ManyAndReturnOperation";
import type { ExecutableOperation, OperationExecutor } from "./OperationExecutor";
import { isRetryableRace } from "./race-retry";
import { ReadOperation } from "./ReadOperation";
import { UnsupportedOperationError } from "./shared";
import { UpdateOperation } from "./UpdateOperation";
import { UpsertOperation } from "./UpsertOperation";

/**
 * Per-tree routing (PLAN P5 item 1) — the production form of the P2a test proxy
 * ({@link file://../../tests/query-engine-v2/v2-client-proxy.ts}), obeying the
 * SAME routing law it proved against the oracle: construct the V2 operation for
 * the whole payload; an {@link UnsupportedOperationError} means "hand this whole
 * tree to V1"; every OTHER construction error (a `ValidationError`, the own-write
 * preflight rejection, the ATOM §7 `requiresAtomicResolution` refusal) is a real
 * failure V1 would also raise and is allowed to propagate. One client call never
 * mixes engines — the decision is made once, for the whole payload, before any
 * I/O. Operations V2 does not own (e.g. `create`) return `undefined`, so the
 * caller runs the frozen V1 path unchanged.
 *
 * The migrated tree classes are EXACTLY the set the oracle certified; the
 * `create` family, and any shape a V2 operation declines with
 * `UnsupportedOperationError`, stay V1.
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
 * The operation names V2 owns a construction path for. A name outside this set
 * is not routed (pure V1); a name inside it is constructed, and if that throws
 * {@link UnsupportedOperationError} the whole tree still falls back to V1.
 */
export const ROUTED_OPERATIONS: ReadonlySet<string> = new Set([
  ...READ_OPERATIONS,
  "update",
  "delete",
  "upsert",
  "createMany",
  "updateMany",
  "deleteMany",
  "createManyAndReturn",
  "updateManyAndReturn",
]);

/**
 * Construct the V2 operation for a routed payload, or return `undefined` when
 * V2 does not own the tree (an unrouted operation name, or a supported family
 * declining this payload with {@link UnsupportedOperationError}). Any other
 * construction error propagates — it is V1's error too.
 */
export function constructRoutedOperation(
  engine: QueryEngine,
  model: Model<any>,
  operation: string,
  args: Record<string, unknown>
): ExecutableOperation | undefined {
  if (!ROUTED_OPERATIONS.has(operation)) return undefined;
  try {
    return constructOperation(engine, model, operation, args);
  } catch (error) {
    if (error instanceof UnsupportedOperationError) return undefined;
    throw error;
  }
}

/**
 * Run a routed V2 operation with the write-race retry policy V1 applies **above**
 * the executor (PLAN P5 item 2f): a surfaced error that {@link isRetryableRace}
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
    case "update":
      return new UpdateOperation(engine, model, args);
    case "delete":
      return new DeleteOperation(engine, model, args);
    case "upsert":
      return new UpsertOperation(engine, model, args);
    case "createMany":
      return new CreateManyOperation(engine, model, args);
    case "updateMany":
    case "deleteMany":
      return new BulkCountOperation(engine, model, operation, args);
    case "createManyAndReturn":
    case "updateManyAndReturn":
      return new ManyAndReturnOperation(engine, model, operation, args);
    default:
      return undefined;
  }
}
