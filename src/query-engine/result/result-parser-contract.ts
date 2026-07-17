import type { AnyRelation } from "@schema/relation";
import type { Scalar } from "@schema/scalars";
import type {
  ExpectedAggregateResultShape,
  ExpectedResultShape,
  Operation,
} from "../types";
import { QueryEngineError } from "../types";
import type { ResultParser } from "./ResultParser";

export interface RowValueParsers {
  parseField(scalar: Scalar, value: unknown, operation: Operation): unknown;
  parseRelation(
    relation: AnyRelation,
    value: unknown,
    operation: Operation,
    shape?: ExpectedResultShape
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
  throw new QueryEngineError(
    `Driver "${provider}" returned a malformed result for operation "${operation}": ${reason}.`,
    { meta: { driver: provider, operation } }
  );
}

export function malformedScalarValue(
  provider: string,
  operation: Operation,
  scalarType: string,
  reason: string
): never {
  throw new QueryEngineError(
    `Driver "${provider}" returned a malformed ${scalarType} scalar for operation "${operation}": ${reason}.`,
    { meta: { driver: provider, operation, scalarType } }
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
  const rows: Record<string, unknown>[] = [];
  for (const value of values) {
    if (!isResultRow(value)) {
      return malformedResult(
        ctx,
        operation,
        "every returned row must be a non-null object"
      );
    }
    rows.push(value);
  }
  return rows;
}

export function assertUniformRowKeys(
  ctx: ResultParser,
  operation: Operation,
  rows: readonly Record<string, unknown>[],
  keys: readonly string[]
): void {
  for (const row of rows) {
    const rowKeys = Object.keys(row);
    if (
      rowKeys.length !== keys.length ||
      !keys.every((key) => Object.hasOwn(row, key))
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
  const keys = Object.keys(row);
  if (
    keys.length !== shape.rawKeys.length ||
    !shape.rawKeys.every((key) => Object.hasOwn(row, key))
  ) {
    malformedResult(
      ctx,
      operation,
      "a returned row does not match the requested result columns"
    );
  }
}
