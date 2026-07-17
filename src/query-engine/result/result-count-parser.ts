import { COUNT_RESULT_KEY } from "@adapters/shared/result-parsing";
import type { ExpectedResultShape, Operation } from "../types";
import { QueryEngineError } from "../types";
import type { ResultParser } from "./ResultParser";
import {
  assertExpectedRowKeys,
  isResultRow,
  malformedResult,
  normalizeResultRows,
} from "./result-parser-contract";

const CANONICAL_COUNT_STRING_REGEX = /^(?:0|[1-9]\d*)$/;

export function parseSafeCountValue(value: unknown): number | undefined {
  if (
    typeof value !== "number" &&
    typeof value !== "bigint" &&
    !(typeof value === "string" && CANONICAL_COUNT_STRING_REGEX.test(value))
  ) {
    return undefined;
  }

  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

function isCountKey(key: string): boolean {
  return key === COUNT_RESULT_KEY;
}

export function isNullableSingleRecordOperation(operation: Operation): boolean {
  return operation === "findFirst" || operation === "findUnique";
}

export function isRequiredSingleRecordOperation(operation: Operation): boolean {
  return (
    operation === "create" ||
    operation === "update" ||
    operation === "delete" ||
    operation === "upsert" ||
    operation === "aggregate"
  );
}

/**
 * Default count result parsing (called via adapter's next())
 *
 * Returns a plain number for simple count, or an object with multiple counts
 * when using select (e.g., { _all: 5, name: 4 })
 */
export function parseCountCarrierDefault(
  ctx: ResultParser,
  operation: Operation,
  raw: unknown[],
  shape: ExpectedResultShape
): boolean | number | Record<string, number> {
  if (raw.length !== 1) {
    return malformedResult(
      ctx,
      operation,
      `COUNT must return exactly one row but received ${raw.length}`
    );
  }
  const [row] = normalizeResultRows(ctx, operation, raw);
  if (!row) {
    return malformedResult(ctx, operation, "the COUNT row is absent");
  }
  assertExpectedRowKeys(ctx, operation, row, shape);
  const entries = Object.entries(row);
  if (entries.length === 0) {
    return malformedResult(ctx, operation, "the COUNT row has no columns");
  }

  const firstEntry = entries[0];
  if (shape.carrier === "existence") {
    if (entries.length !== 1 || !firstEntry || !isCountKey(firstEntry[0])) {
      return malformedResult(
        ctx,
        operation,
        "the existence COUNT row has an unknown shape"
      );
    }
    return parseCountValue(ctx, operation, firstEntry[1]) > 0;
  }
  if (entries.length === 1 && firstEntry && isCountKey(firstEntry[0])) {
    return parseCountValue(ctx, operation, firstEntry[1]);
  }

  const scalars = ctx.model["~"].state.scalars;
  const result: Record<string, number> = {};
  for (const [key, value] of entries) {
    if (key !== "_all" && !Object.hasOwn(scalars, key)) {
      return malformedResult(
        ctx,
        operation,
        `COUNT column "${key}" is not part of the active model`
      );
    }
    result[key] = parseCountValue(ctx, operation, value);
  }
  return result;
}

export function parseCountValue(
  ctx: ResultParser,
  operation: Operation,
  value: unknown
): number {
  const count = parseSafeCountValue(value);
  if (count === undefined) {
    return malformedResult(
      ctx,
      operation,
      "a COUNT value is not a canonical safe non-negative integer"
    );
  }
  return count;
}

/**
 * Parse mutation result to get affected count
 */
export function parseMutationCount(raw: unknown): { count: number } {
  if (!isResultRow(raw)) {
    throw new QueryEngineError(
      "Cannot parse mutation count: expected { rowCount: non-negative integer }."
    );
  }
  const rowCount = raw.rowCount;
  if (
    typeof rowCount !== "number" ||
    !Number.isFinite(rowCount) ||
    !Number.isSafeInteger(rowCount) ||
    rowCount < 0
  ) {
    throw new QueryEngineError(
      "Cannot parse mutation count: expected { rowCount: non-negative integer }."
    );
  }
  return { count: rowCount };
}

export function parseMutationCountFor(
  ctx: ResultParser,
  operation: "createMany" | "updateMany" | "deleteMany",
  raw: unknown
): { count: number } {
  if (!isResultRow(raw)) {
    return malformedResult(
      ctx,
      operation,
      "a batch mutation must return { rowCount: non-negative integer }"
    );
  }
  const rowCount = raw.rowCount;
  if (
    typeof rowCount !== "number" ||
    !Number.isFinite(rowCount) ||
    !Number.isSafeInteger(rowCount) ||
    rowCount < 0
  ) {
    return malformedResult(
      ctx,
      operation,
      "a batch mutation must return { rowCount: non-negative integer }"
    );
  }
  return { count: rowCount };
}
