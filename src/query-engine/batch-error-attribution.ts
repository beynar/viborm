import type { AnyDriver } from "@drivers";
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
 */
export async function attributeOperationBatchError(
  error: unknown,
  guards: readonly PreparedBatchGuard[],
  driver: AnyDriver
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
  if (guards.length > 0) return error;
  return new NestedWriteError(
    "Nested write assertion failed: a batch precondition (e.g. a connect/disconnect target or ownership check) did not hold.",
    "",
    {
      code: VibORMErrorCode.NESTED_WRITE_ASSERTION_FAILED,
      cause: error,
    }
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
