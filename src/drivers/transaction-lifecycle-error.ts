import { TransactionError } from "@errors";
import { createTransactionCleanupError } from "./shared/transactions";

export function toTransactionOperationError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new TransactionError("Transaction operation failed", {
    cause: new Error("A transaction operation rejected without an Error"),
  });
}

export function normalizeTransactionLifecycleError(
  error: unknown,
  normalizeFailure: (failure: unknown) => Error
): Error {
  try {
    if (!(error instanceof AggregateError)) return normalizeFailure(error);
    const primaryFailure = error.cause;
    if (error.errors[0] !== primaryFailure) return normalizeFailure(error);
    const normalizedPrimary = normalizeFailure(primaryFailure);
    const normalizedCleanup = error.errors
      .slice(1)
      .map((cleanupFailure) => normalizeFailure(cleanupFailure));
    return createTransactionCleanupError(normalizedPrimary, normalizedCleanup);
  } catch {
    return normalizeFailure(error);
  }
}
