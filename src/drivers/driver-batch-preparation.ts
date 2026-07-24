import {
  BATCH_DIAGNOSTIC_PARAMS,
  snapshotDiagnosticParameters,
} from "./driver-diagnostics";
import type { ErrorLogDetails } from "./driver-instrumentation";
import { snapshotExecutionContext } from "./execution-context";
import type { BatchQuery, QueryExecutionContext } from "./types";

export interface PreparedAtomicBatch {
  readonly queries: BatchQuery[];
  readonly diagnosticParams: unknown[][];
  readonly errorLogDetails: ErrorLogDetails[];
}

export function prepareAtomicBatch(
  queries: readonly BatchQuery[],
  executionContext: QueryExecutionContext,
  getDiagnosticParameters: (query: BatchQuery) => unknown[]
): PreparedAtomicBatch {
  const preparedQueries = queries.map((query) => {
    const params = query.params ? [...query.params] : undefined;
    if (params) Object.freeze(params);
    const snapshot: BatchQuery = {
      sql: query.sql,
      ...(params ? { params } : {}),
      context: snapshotExecutionContext(
        query.context,
        executionContext,
        "executeBatch"
      ),
    };
    Object.defineProperty(snapshot, BATCH_DIAGNOSTIC_PARAMS, {
      configurable: false,
      enumerable: false,
      value: snapshotDiagnosticParameters(params ?? []),
      writable: false,
    });
    return Object.freeze(snapshot);
  });
  const diagnosticParams = preparedQueries.map(getDiagnosticParameters);
  const errorLogDetails = preparedQueries.map((query, index) => ({
    context: query.context ?? executionContext,
    params: diagnosticParams[index] ?? [],
    sql: query.sql,
  }));
  return { queries: preparedQueries, diagnosticParams, errorLogDetails };
}
