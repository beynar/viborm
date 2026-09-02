import type { AnyDriver, QueryExecutionContext } from "@drivers";
import { batchMayContainAssertionCollision } from "@drivers/error-mapping";
import {
  NESTED_WRITE_ASSERTION_FLOOR_MESSAGE,
  NestedWriteAssertionError,
  NestedWriteError,
  VibORMErrorCode,
} from "@errors";
import type { PreparedBatchGuard } from "./types";
import { createFailureError } from "./write-engine/OperationFragment";

/**
 * Attribute a native-batch assertion failure to the guard that raised it (P6
 * pure-leaf extraction, consumed by the client's shared-batch path): a
 * `NestedWriteAssertionError` carries the index of the offending statement when
 * the driver surfaces it, else each guard's probe is re-run to locate the
 * violated precondition. The attributed error reconstructs the guard's typed
 * failure with the correct model/operation.
 *
 * The re-probe runs AFTER the atomic batch rolled back, which makes it blind to
 * one whole class: a premise broken by a SIBLING statement inside the same batch
 * is restored by that rollback and probes clean, so no guard is blamed. When
 * every guard in the batch would raise the same failure for the same
 * model/operation, that blindness costs nothing — whichever fired, the error is
 * the same one — but only once it is established that a guard fired AT ALL.
 *
 * That last part is not free. A native batch is normalized against the JOINED
 * SQL, so one assertion statement anywhere arms the detector
 * (`src/drivers/error-mapping.ts`) for every statement in the batch: an ordinary
 * statement that raises the same provider signature — `n / 0` from a literal
 * `divide: 0` on Postgres, a malformed-JSON argument on MySQL/SQLite — arrives
 * as a `NestedWriteAssertionError` no guard caused. Blaming a guard for it
 * asserts something false about the database (a `NotFoundError`/P2025 for a row
 * that is still there, which Prisma callers branch on). So the reconstruction
 * runs only when NO ordinary statement in the batch could have produced the
 * signature — viborm built every statement, so it can tell — and the raw
 * driver-mapped error stands whenever the failure cannot be tied to a guard.
 * A batch carrying guards that DISAGREE about what went wrong likewise stays
 * un-attributable.
 */
export async function attributeOperationBatchError(
  error: unknown,
  guards: readonly PreparedBatchGuard[],
  driver: AnyDriver,
  statements: readonly {
    readonly sql: string;
    readonly context?: QueryExecutionContext;
  }[] = []
): Promise<unknown> {
  if (!(error instanceof NestedWriteAssertionError)) return error;
  const statementIndex = error.meta.statementIndex;
  if (typeof statementIndex === "number") {
    const guard = guards.find(
      (candidate) => candidate.queryIndex === statementIndex
    );
    if (guard) {
      return createFailureError(guard.failure, guard.model, guard.operation);
    }
    return error;
  }
  for (const guard of guards) {
    const result = await driver._execute(
      guard.probe,
      statements[guard.queryIndex]?.context
    );
    const exists = result.rows.length > 0;
    if (guard.premise === "exists" ? !exists : exists) {
      return createFailureError(guard.failure, guard.model, guard.operation);
    }
  }
  const [candidate] = guards;
  if (candidate) {
    const attributable =
      guards.every((guard) => sameAttribution(guard, candidate)) &&
      !batchMayContainAssertionCollision(statements, driver.dialect);
    return attributable
      ? createFailureError(
          candidate.failure,
          candidate.model,
          candidate.operation
        )
      : error;
  }
  return new NestedWriteError(NESTED_WRITE_ASSERTION_FLOOR_MESSAGE, "", {
    code: VibORMErrorCode.NESTED_WRITE_ASSERTION_FAILED,
    cause: error,
  });
}

/**
 * Two guards that would produce the SAME error: same model, same operation, and
 * a failure identical in every field the reconstruction below reads.
 */
function sameAttribution(
  guard: PreparedBatchGuard,
  other: PreparedBatchGuard
): boolean {
  return (
    guard.model === other.model &&
    guard.operation === other.operation &&
    guard.failure.kind === other.failure.kind &&
    guard.failure.message === other.failure.message &&
    guard.failure.relation === other.failure.relation &&
    guard.failure.raceable === other.failure.raceable
  );
}
