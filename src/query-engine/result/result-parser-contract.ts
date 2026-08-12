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
  parseField(scalar: Scalar, value: unknown, operation: Operation): unknown;
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
