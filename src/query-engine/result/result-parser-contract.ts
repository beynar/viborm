import { publicOperationName } from "@errors";
import type { Model } from "@schema/model";
import type { AnyPolymorphicRelation, AnyRelation } from "@schema/relation";
import type { Scalar } from "@schema/scalars";
import type {
  ExpectedAggregateResultShape,
  ExpectedPolymorphicResultShape,
  ExpectedResultShape,
  Operation,
} from "../types";
import { QueryEngineError } from "../types";
import type { ResultParser } from "./ResultParser";

export interface RowValueParsers {
  getRowParser(
    model: Model<any>,
    row: Record<string, unknown>,
    operation: Operation,
    shape?: ExpectedResultShape,
    keys?: readonly string[]
  ): (row: Record<string, unknown>) => Record<string, unknown>;
  parseField(
    scalar: Scalar,
    value: unknown,
    operation: Operation,
    captureExact?: (value: unknown) => void
  ): unknown;
  parseRelation(
    relation: AnyRelation,
    value: unknown,
    operation: Operation,
    shape?: ExpectedResultShape
  ): unknown;
  parsePolymorphic(
    model: Model<any>,
    relationName: string,
    relation: AnyPolymorphicRelation,
    value: unknown,
    operation: Operation,
    shape?: ExpectedPolymorphicResultShape
  ): unknown;
  parseAggregate(
    operation: Operation,
    key: string,
    raw: unknown,
    scalars: Record<string, Scalar>,
    expected?: ExpectedAggregateResultShape
  ): unknown;
}

export type ParseScalarField = (
  scalar: Scalar,
  value: unknown,
  operation: Operation
) => unknown;

export function malformedResult(
  ctx: ResultParser,
  operation: Operation,
  reason: string
): never {
  const provider = ctx.providerName;
  // The caller never spelled an internal *AndReturn arm; render the family name.
  const named = publicOperationName(operation);
  throw new QueryEngineError(
    `Driver "${provider}" returned a malformed result for operation "${named}": ${reason}.`,
    { meta: { driver: provider, operation: named } }
  );
}

export function malformedScalarValue(
  provider: string,
  operation: Operation,
  scalarType: string,
  reason: string
): never {
  const named = publicOperationName(operation);
  throw new QueryEngineError(
    `Driver "${provider}" returned a malformed ${scalarType} scalar for operation "${named}": ${reason}.`,
    { meta: { driver: provider, operation: named, scalarType } }
  );
}

export function isResultRow(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

export function getOwnValue<T>(
  record: Readonly<Record<string, T>>,
  key: string
): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function normalizeResultRows(
  ctx: ResultParser,
  operation: Operation,
  values: unknown[]
): Record<string, unknown>[] {
  assertResultRows(ctx, operation, values);
  return values;
}

function assertResultRows(
  ctx: ResultParser,
  operation: Operation,
  values: unknown[]
): asserts values is Record<string, unknown>[] {
  for (const value of values) {
    if (!isResultRow(value)) {
      malformedResult(
        ctx,
        operation,
        "every returned row must be a non-null object"
      );
    }
  }
}

export function parseResultRows<T>(
  rows: readonly Record<string, unknown>[],
  parseRow: (row: Record<string, unknown>) => T
): T[] {
  const parsed: T[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    parsed[i] = parseRow(rows[i]!);
  }
  return parsed;
}

function countOwnEnumerableKeys(
  row: Record<string, unknown>,
  expectedCount: number
): number {
  let count = 0;
  // Plain driver rows take one allocation-free pass. A custom row prototype
  // with inherited enumerable keys pays the owned-key fallback only on mismatch.
  for (const _key in row) count++;
  if (count === expectedCount) return count;
  count = 0;
  for (const key in row) {
    if (Object.hasOwn(row, key)) count++;
  }
  return count;
}

function hasEveryOwnKey(
  row: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  for (const key of keys) {
    if (!Object.hasOwn(row, key)) return false;
  }
  return true;
}

export function assertUniformRowKeys(
  ctx: ResultParser,
  operation: Operation,
  rows: readonly Record<string, unknown>[],
  keys: readonly string[]
): void {
  for (const row of rows) {
    if (
      countOwnEnumerableKeys(row, keys.length) !== keys.length ||
      !hasEveryOwnKey(row, keys)
    ) {
      malformedResult(
        ctx,
        operation,
        "all rows in one result set must expose the same columns"
      );
    }
  }
}

export function assertExpectedRowKeys(
  ctx: ResultParser,
  operation: Operation,
  row: Record<string, unknown>,
  shape: ExpectedResultShape
): void {
  assertExpectedKeySet(
    ctx,
    operation,
    row,
    shape,
    countOwnEnumerableKeys(row, shape.rawKeys.length)
  );
}

function assertExpectedKeySet(
  ctx: ResultParser,
  operation: Operation,
  row: Record<string, unknown>,
  shape: ExpectedResultShape,
  keyCount: number
): void {
  if (
    keyCount !== shape.rawKeys.length ||
    !hasEveryOwnKey(row, shape.rawKeys)
  ) {
    malformedResult(
      ctx,
      operation,
      "a returned row does not match the requested result columns"
    );
  }
}
