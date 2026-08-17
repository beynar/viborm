import { isVibORMError, type VibORMError } from "./base";
import {
  getTrustedRecordSeriesProgress,
  type RecordSeriesProgress,
  registerTrustedRecordSeriesProgress,
  sanitizeRecordSeriesProgress,
} from "./diagnostics";
import { QueryEngineError } from "./query";

/**
 * Enrich the owned failure after segment-atomic execution has stopped. The
 * database executor supplies counters only; this errors-layer boundary validates
 * them, updates direct metadata, and updates trusted serialization together.
 */
export function attachRecordSeriesProgress<T extends VibORMError>(
  error: T,
  progress: RecordSeriesProgress
): T;
export function attachRecordSeriesProgress(
  error: unknown,
  progress: RecordSeriesProgress
): unknown;
export function attachRecordSeriesProgress(
  error: unknown,
  progress: RecordSeriesProgress
): unknown {
  const ownedError = isVibORMError(error)
    ? error
    : new QueryEngineError(
        "Record-series execution failed at a committed-segment boundary.",
        error instanceof Error ? { cause: error } : undefined
      );
  // One failure crosses one terminal series boundary. If a wrapper encounters
  // the same error again, retain the first trusted observation so public
  // metadata and trusted serialization cannot diverge.
  const trusted = getTrustedRecordSeriesProgress(ownedError);
  const sanitized = trusted ?? sanitizeRecordSeriesProgress(progress);
  if (!sanitized) return error;
  Object.defineProperty(ownedError.meta, "recordSeriesProgress", {
    configurable: true,
    enumerable: true,
    value: sanitized,
    writable: true,
  });
  if (!trusted) {
    registerTrustedRecordSeriesProgress(ownedError, sanitized);
  }
  return ownedError;
}

/** A committed prefix forbids the routed whole-operation retry. */
export function hasCommittedRecordSeriesProgress(error: unknown): boolean {
  if (!isVibORMError(error)) return false;
  const progress = getTrustedRecordSeriesProgress(error);
  return (
    (progress?.committedSegments ?? 0) > 0 ||
    progress?.mayHaveCommittedSegment === true
  );
}

export function hasRecordSeriesProgress(error: unknown): boolean {
  return (
    isVibORMError(error) && getTrustedRecordSeriesProgress(error) !== undefined
  );
}
