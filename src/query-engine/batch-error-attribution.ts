import type { AnyDriver } from "@drivers";
import { ASSERTION_MARKER } from "@drivers/error-mapping";
import type { Dialect } from "@drivers/types";
import {
  isVibORMError,
  NestedWriteAssertionError,
  NestedWriteError,
  NotFoundError,
  TransactionError,
  VibORMErrorCode,
} from "@errors";
import type { ProgramFailure } from "./operation-program";
import type { PreparedBatchGuard } from "./types";

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
  statements: readonly { readonly sql: string }[] = []
): Promise<unknown> {
  if (!(error instanceof NestedWriteAssertionError)) return error;
  const statementIndex = isVibORMError(error)
    ? error.meta.statementIndex
    : undefined;
  if (typeof statementIndex === "number") {
    const guard = guards.find(
      (candidate) => candidate.queryIndex === statementIndex
    );
    if (guard) {
      return createProgramFailureError(
        guard.failure,
        guard.model,
        guard.operation
      );
    }
    return error;
  }
  for (const guard of guards) {
    const result = await driver._execute(guard.probe, {
      operation: "batchGuardAttribution",
    });
    const exists = result.rows.length > 0;
    if (guard.premise === "exists" ? !exists : exists) {
      return createProgramFailureError(
        guard.failure,
        guard.model,
        guard.operation
      );
    }
  }
  const [candidate] = guards;
  if (candidate) {
    const attributable =
      guards.every((guard) => sameAttribution(guard, candidate)) &&
      !carriesForeignAssertionSignature(statements, driver.dialect);
    return attributable
      ? createProgramFailureError(
          candidate.failure,
          candidate.model,
          candidate.operation
        )
      : error;
  }
  return new NestedWriteError(
    "Nested write assertion failed: a batch precondition (e.g. a connect/disconnect target or ownership check) did not hold.",
    "",
    {
      code: VibORMErrorCode.NESTED_WRITE_ASSERTION_FAILED,
      cause: error,
    }
  );
}

/**
 * Each dialect's assertion trick, and therefore the shape an ORDINARY statement
 * must have to counterfeit it. Postgres asserts with `1 / 0`, so anything that
 * can divide or take a remainder can raise the same SQLSTATE 22012; MySQL and
 * SQLite assert with `JSON_EXTRACT` on invalid JSON, so anything calling a JSON
 * function can raise the same errno 3141 / "malformed JSON". Each dialect is
 * blind to the other's trick — MySQL's `x / 0` yields NULL or errno 1365, and
 * Postgres reports bad JSON as 22P02 — so only the executing dialect's pattern
 * is consulted.
 */
const FOREIGN_ASSERTION_SIGNATURE: Record<Dialect, RegExp> = {
  postgresql: /[/%]/,
  mysql: /json/i,
  sqlite: /json/i,
};

/**
 * Could a statement OTHER than the batch's own assertions have raised the
 * provider error that the joined-SQL normalization read as an assertion? The
 * assertion statements are the ones carrying the marker alias; every other
 * statement is ordinary, and one that matches its dialect's signature makes the
 * failure un-attributable. Over-reporting only costs attribution (the raw error
 * stands, as it did before guard reconstruction existed); under-reporting would
 * cost a fabricated `NotFoundError`.
 */
function carriesForeignAssertionSignature(
  statements: readonly { readonly sql: string }[],
  dialect: Dialect
): boolean {
  const signature = FOREIGN_ASSERTION_SIGNATURE[dialect];
  for (const statement of statements) {
    if (statement.sql.includes(ASSERTION_MARKER)) continue;
    if (signature.test(statement.sql)) return true;
  }
  return false;
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

/** Reconstruct a program guard's declared failure as its typed error. */
export function createProgramFailureError(
  failure: ProgramFailure,
  model: string,
  operation: PreparedBatchGuard["operation"]
): Error {
  if (failure.kind === "notFound") {
    return new NotFoundError(model, operation);
  }
  if (failure.kind === "nestedWrite") {
    const error = new NestedWriteError(failure.message, failure.relation ?? "");
    if (failure.raceable) error.meta.raceable = true;
    return error;
  }
  return new TransactionError(failure.message, {
    meta: { model, operation },
  });
}
