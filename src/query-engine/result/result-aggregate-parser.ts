import { tryParseJsonString } from "@adapters/shared/result-parsing";
import type { Scalar } from "@schema/scalars";
import type { ExpectedAggregateResultShape, Operation } from "../types";
import type { ResultParser } from "./ResultParser";
import { parseCountValue } from "./result-count-parser";
import {
  getOwnValue,
  isResultRow,
  malformedResult,
  type ParseScalarField,
} from "./result-parser-contract";
import { parseFiniteProviderNumber } from "./scalar-structured-parser";

export function parseAggregateResult(
  ctx: ResultParser,
  operation: Operation,
  key: string,
  raw: unknown,
  scalars: Record<string, Scalar>,
  expected: ExpectedAggregateResultShape | undefined,
  parseField: ParseScalarField
): unknown {
  if (raw === undefined) {
    return malformedResult(
      ctx,
      operation,
      `aggregate column "${key}" is absent`
    );
  }
  if (raw === null) {
    return malformedResult(
      ctx,
      operation,
      `aggregate column "${key}" cannot be null`
    );
  }

  let value: unknown = raw;
  if (typeof value === "string") {
    // SQLite/MySQL return the JSON-built aggregate object as text
    const parsed = tryParseJsonString(value);
    if (parsed !== undefined) {
      value = parsed;
    }
  }

  if (!isResultRow(value)) {
    if (key === "_count" && expected?.fields === undefined) {
      return parseCountValue(ctx, operation, value);
    }
    return malformedResult(
      ctx,
      operation,
      `aggregate column "${key}" has an unsupported shape`
    );
  }

  const typed = key === "_sum" || key === "_min" || key === "_max";
  const result: Record<string, unknown> = {};
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return malformedResult(
      ctx,
      operation,
      `aggregate column "${key}" has no fields`
    );
  }
  if (
    expected &&
    (expected.fields === undefined ||
      entries.length !== expected.fields.size ||
      !entries.every(([field]) => expected.fields?.has(field) === true))
  ) {
    return malformedResult(
      ctx,
      operation,
      `aggregate column "${key}" does not match the requested fields`
    );
  }
  for (const [field, fieldValue] of entries) {
    if (fieldValue === undefined) {
      return malformedResult(
        ctx,
        operation,
        `aggregate field "${field}" is absent`
      );
    }
    if (fieldValue === null) {
      if (key === "_count") {
        return malformedResult(
          ctx,
          operation,
          `aggregate count field "${field}" cannot be null`
        );
      }
      result[field] = null;
      continue;
    }
    if (key === "_count") {
      if (field !== "_all" && !Object.hasOwn(scalars, field)) {
        return malformedResult(
          ctx,
          operation,
          `aggregate count field "${field}" is not part of the active model`
        );
      }
      result[field] = parseCountValue(ctx, operation, fieldValue);
      continue;
    }
    const scalar = getOwnValue(scalars, field);
    if (!scalar) {
      return malformedResult(
        ctx,
        operation,
        `aggregate field "${field}" is not part of the active model`
      );
    }
    // `_avg` normally widens to a JS number — but an average OF decimals is
    // still a decimal, computed exactly by the database and cast to text on the
    // way out. Parsing it as a number would reintroduce, in the one place it is
    // most likely to matter, exactly the float error this scalar avoids.
    const isDecimal = scalar["~"].state.type === "decimal";
    result[field] =
      typed || isDecimal
        ? parseField(scalar, fieldValue, operation)
        : parseAggregateNumber(ctx, operation, field, fieldValue);
  }
  return result;
}

function parseAggregateNumber(
  ctx: ResultParser,
  operation: Operation,
  field: string,
  value: unknown
): number {
  const numeric = parseFiniteProviderNumber(value);
  if (numeric === undefined) {
    return malformedResult(
      ctx,
      operation,
      `aggregate field "${field}" is not a canonical finite number`
    );
  }
  return numeric;
}
