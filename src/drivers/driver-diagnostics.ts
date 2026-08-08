import {
  isVibORMError,
  sanitizeDiagnosticParameters,
  VibORMError,
} from "@errors";
import { isRecord } from "@validation/value-guards";
import type { ErrorLogDetails } from "./driver-instrumentation";
import { snapshotExecutionContext } from "./execution-context";
import type { QueryExecutionContext } from "./types";

export const BATCH_DIAGNOSTIC_PARAMS = Symbol("viborm.batchDiagnosticParams");

export function snapshotDiagnosticParameters(
  params: readonly unknown[]
): unknown[] {
  return sanitizeDiagnosticParameters([...params], {
    includeParams: true,
    includeSql: true,
  });
}

export function findUniqueExecutionContextIndex(
  error: unknown,
  candidates: readonly { context?: QueryExecutionContext }[]
): number | undefined {
  if (!isVibORMError(error)) return undefined;
  const context = readTrustedErrorExecutionContext(error);
  if (!context?.correlationId) return undefined;
  let match: number | undefined;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidateContext = candidates[index]?.context;
    if (!candidateContext) continue;
    const isMatch =
      candidateContext.correlationId === context.correlationId &&
      candidateContext.model === context.model &&
      candidateContext.operation === context.operation;
    if (!isMatch) continue;
    if (match !== undefined) return undefined;
    match = index;
  }
  return match;
}

export function findUniqueErrorLogDetails(
  error: Error,
  details: readonly ErrorLogDetails[] | undefined
): ErrorLogDetails | undefined {
  if (!details) return undefined;
  const index = findUniqueExecutionContextIndex(error, details);
  return index === undefined ? undefined : details[index];
}

export function getErrorExecutionContext(
  error: Error,
  fallback: QueryExecutionContext
): QueryExecutionContext {
  if (!isVibORMError(error)) return fallback;
  return snapshotExecutionContext(
    readTrustedErrorExecutionContext(error),
    fallback,
    fallback.operation
  );
}

export function readTrustedErrorExecutionContext(
  error: VibORMError
): QueryExecutionContext | undefined {
  const snapshot = VibORMError.prototype.toJSON.call(error);
  const meta = snapshot.meta;
  if (!isRecord(meta)) return undefined;
  const model = typeof meta.model === "string" ? meta.model : undefined;
  const operation =
    typeof meta.operation === "string" ? meta.operation : undefined;
  const correlationId =
    typeof meta.correlationId === "string" ? meta.correlationId : undefined;
  return { model, operation, correlationId };
}
