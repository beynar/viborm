import { tryParseJsonString } from "@adapters/shared/result-parsing";
import { publicOperationName } from "@errors";
import type { Model } from "@schema/model";
import type { AnyRelation } from "@schema/relation";
import type { Scalar } from "@schema/scalars";
import type { AggregateResultName } from "../result-aliases";
import type {
  ExpectedAggregateResultShape,
  ExpectedPolymorphicResultShape,
  ExpectedResultShape,
  Operation,
} from "../types";
import { QueryEngineError } from "../types";
import type { ResultParser } from "./ResultParser";
import type { CompiledRowParser } from "./result-row-parser";

export interface RowValueParsers {
  getRowParser(
    model: Model<any>,
    row: Record<string, unknown>,
    operation: Operation,
    shape?: ExpectedResultShape,
    keys?: readonly string[]
  ): CompiledRowParser;
  parseField(
    scalar: Scalar,
    value: unknown,
    operation: Operation,
    captureRowKey?: (value: unknown) => void
  ): unknown;
  /**
   * `(source, field)` is the CONTEXTUAL SLOT identity — the whole identity of a
   * relation reference, because `.extends()` may reuse one terminal under more
   * than one model. Both relation parsers take it, and both cache by it.
   */
  parseRelation(
    source: Model<any>,
    field: string,
    relation: AnyRelation,
    value: unknown,
    operation: Operation,
    shape?: ExpectedResultShape
  ): unknown;
  parsePolymorphic(
    source: Model<any>,
    field: string,
    relation: AnyRelation,
    value: unknown,
    operation: Operation,
    shape?: ExpectedPolymorphicResultShape
  ): unknown;
  parseAggregate(
    operation: Operation,
    key: AggregateResultName,
    raw: unknown,
    scalars: Record<string, Scalar>,
    expected?: ExpectedAggregateResultShape
  ): unknown;
}

/** Decode only at a boundary that already knows the value is a JSON carrier. */
export function decodeRelationCarrier(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return tryParseJsonString(value) ?? value;
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

export function parseResultRows(
  rows: readonly Record<string, unknown>[],
  parseRow: CompiledRowParser,
  useConsumable = false
): Record<string, unknown>[] {
  const parsed: Record<string, unknown>[] = new Array(rows.length);
  if (useConsumable && parseRow.containerPolicy !== "copy") {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      parsed[i] = parseRow(row, row);
    }
    return parsed;
  }
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
