import { QueryError } from "@errors";
import type { QueryResult } from "./types";

export interface NormalizedResultContext {
  provider: string;
  operation: string;
  model?: string;
  correlationId?: string;
}

export function createNormalizedResultMeta(
  context: NormalizedResultContext
): Record<string, unknown> {
  return {
    driver: context.provider,
    operation: context.operation,
    ...(context.model ? { model: context.model } : {}),
    ...(context.correlationId ? { correlationId: context.correlationId } : {}),
  };
}

const NON_NEGATIVE_DECIMAL_REGEX = /^(?:0|[1-9]\d*)$/;

export function normalizeProviderRowCount(
  value: unknown,
  context: NormalizedResultContext,
  options?: { allowDecimalString?: boolean; nullValue?: number }
): number {
  let normalized = value === null ? options?.nullValue : value;
  if (
    options?.allowDecimalString === true &&
    typeof normalized === "string" &&
    NON_NEGATIVE_DECIMAL_REGEX.test(normalized)
  ) {
    normalized = Number(normalized);
  }
  if (
    typeof normalized !== "number" ||
    !Number.isSafeInteger(normalized) ||
    normalized < 0
  ) {
    throw new QueryError(
      `Driver "${context.provider}" returned a malformed row count for operation "${context.operation}".`,
      {
        meta: createNormalizedResultMeta(context),
      }
    );
  }
  return normalized;
}

export function normalizeProviderInsertId(
  value: unknown,
  context: NormalizedResultContext,
  options?: { allowNumber?: boolean }
): number | bigint | undefined {
  if (typeof value === "string") {
    if (!NON_NEGATIVE_DECIMAL_REGEX.test(value)) {
      throw malformedInsertId(context);
    }
    return value === "0" ? undefined : BigInt(value);
  }
  if (options?.allowNumber === true && typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw malformedInsertId(context);
    }
    return value === 0 ? undefined : value;
  }
  throw malformedInsertId(context);
}

function malformedInsertId(context: NormalizedResultContext): QueryError {
  return new QueryError(
    `Driver "${context.provider}" returned a malformed insert id for operation "${context.operation}".`,
    {
      meta: createNormalizedResultMeta(context),
    }
  );
}

function malformedNormalizedResult(
  context: NormalizedResultContext,
  resultIndex?: number
): QueryError {
  const position =
    resultIndex === undefined ? "" : ` at batch result index ${resultIndex}`;
  return new QueryError(
    `Driver "${context.provider}" returned a malformed normalized result for operation "${context.operation}"${position}; expected { rows: object[], rowCount: safe non-negative integer }.`,
    {
      meta: {
        ...createNormalizedResultMeta(context),
        ...(resultIndex === undefined ? {} : { resultIndex }),
      },
    }
  );
}

export function isNormalizedResultRow(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

function hasNormalizedRows(value: unknown): value is Record<string, unknown>[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!(Object.hasOwn(value, index) && isNormalizedResultRow(value[index]))) {
      return false;
    }
  }
  return true;
}

/**
 * Assert the single cross-driver success contract. Empty row arrays and a
 * rowCount of zero are valid; missing fields, non-record rows, and invented
 * counts are not.
 */
export function assertNormalizedQueryResult(
  result: QueryResult<unknown>,
  context: NormalizedResultContext,
  resultIndex?: number
): void {
  const hasValidInsertId =
    result?.insertId === undefined ||
    (typeof result.insertId === "bigint" && result.insertId >= 0n) ||
    (typeof result.insertId === "number" &&
      Number.isFinite(result.insertId) &&
      Number.isSafeInteger(result.insertId) &&
      result.insertId >= 0);
  if (
    !(isNormalizedResultRow(result) && hasNormalizedRows(result.rows)) ||
    typeof result.rowCount !== "number" ||
    !Number.isFinite(result.rowCount) ||
    !Number.isSafeInteger(result.rowCount) ||
    result.rowCount < 0 ||
    !hasValidInsertId
  ) {
    throw malformedNormalizedResult(context, resultIndex);
  }
}

/**
 * Native and planned batches must return one normalized result for each
 * submitted statement, in the same order.
 */
export function assertNormalizedBatchResults(
  results: readonly QueryResult<unknown>[],
  expectedStatementCount: number,
  context: NormalizedResultContext
): void {
  if (!Array.isArray(results) || results.length !== expectedStatementCount) {
    const actualResultCount = Array.isArray(results) ? results.length : 0;
    throw new QueryError(
      `Driver "${context.provider}" returned ${actualResultCount} results for operation "${context.operation}"; expected ${expectedStatementCount}, one per statement.`,
      {
        meta: {
          ...createNormalizedResultMeta(context),
          expectedStatementCount,
          actualResultCount,
        },
      }
    );
  }

  for (const [resultIndex, result] of results.entries()) {
    assertNormalizedQueryResult(result, context, resultIndex);
  }
}
