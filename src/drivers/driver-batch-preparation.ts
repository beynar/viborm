import {
  isVerbatimBatchQuery,
  markVerbatimBatchQuery,
} from "./driver-batch-query-kind";
import {
  BATCH_DIAGNOSTIC_PARAMS,
  EMPTY_DIAGNOSTIC_PARAMS,
} from "./driver-diagnostics";
import type { ErrorLogDetails } from "./driver-instrumentation";
import { snapshotExecutionContext } from "./execution-context";
import { transferPreparedStatement } from "./prepared-statement-provenance";
import type { BatchQuery, QueryExecutionContext } from "./types";

export interface PreparedAtomicBatch {
  readonly queries: BatchQuery[];
  readonly diagnosticParams: unknown[];
  readonly errorLogDetails: ErrorLogDetails[];
}

export function prepareAtomicBatch(
  queries: readonly BatchQuery[],
  executionContext: QueryExecutionContext,
  getDiagnosticParameters: (
    params: readonly unknown[],
    context: QueryExecutionContext
  ) => unknown[],
  discloseBatchParameters: boolean
): PreparedAtomicBatch {
  const statementDiagnosticSnapshots: unknown[][] = [];
  const preparedQueries = queries.map((query) => {
    const sourceParams = query.params;
    const params = sourceParams ? [...sourceParams] : undefined;
    if (params) Object.freeze(params);
    const context = snapshotExecutionContext(
      query.context,
      executionContext,
      "executeBatch"
    );
    let snapshot: BatchQuery = {
      sql: query.sql,
      ...(params ? { params } : {}),
      context,
    };
    if (isVerbatimBatchQuery(query)) {
      snapshot = markVerbatimBatchQuery(snapshot);
    }
    transferPreparedStatement(query, snapshot);
    const diagnosticSnapshot = getDiagnosticParameters(params ?? [], context);
    statementDiagnosticSnapshots.push(diagnosticSnapshot);
    Object.defineProperty(snapshot, BATCH_DIAGNOSTIC_PARAMS, {
      configurable: false,
      enumerable: false,
      value: diagnosticSnapshot,
      writable: false,
    });
    return Object.freeze(snapshot);
  });
  const errorLogDetails = preparedQueries.map((query, index) => ({
    context: query.context ?? executionContext,
    params: statementDiagnosticSnapshots[index] ?? EMPTY_DIAGNOSTIC_PARAMS,
    sql: query.sql,
  }));
  const diagnosticParams = discloseBatchParameters
    ? statementDiagnosticSnapshots
    : EMPTY_DIAGNOSTIC_PARAMS;
  if (discloseBatchParameters) Object.freeze(diagnosticParams);
  return { queries: preparedQueries, diagnosticParams, errorLogDetails };
}
