import { tryParseJsonString } from "@adapters/shared/result-parsing";
import type { Scalar } from "@schema/scalars";
import type { AggregateResultName } from "../result-aliases";
import type { ExpectedAggregateResultShape, Operation } from "../types";
import type { ResultParser } from "./ResultParser";
import { classifyAggregateLeaf } from "./result-aggregate-leaf";
import { parseCountValue } from "./result-count-parser";
import {
  isResultRow,
  malformedResult,
  type ParseScalarField,
} from "./result-parser-contract";
import { parseFiniteProviderNumber } from "./scalar-structured-parser";

export function parseAggregateResult(
  ctx: ResultParser,
  operation: Operation,
  key: AggregateResultName,
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
    const leaf = classifyAggregateLeaf(key, field, scalars);
    if (leaf.kind === "unknown") {
      return malformedResult(
        ctx,
        operation,
        `${key === "_count" ? "aggregate count field" : "aggregate field"} "${field}" is not part of the active model`
      );
    }
    if (fieldValue === undefined) {
      return malformedResult(
        ctx,
        operation,
        `aggregate field "${field}" is absent`
      );
    }
    if (fieldValue === null) {
      if (!leaf.nullable) {
        return malformedResult(
          ctx,
          operation,
          `aggregate count field "${field}" cannot be null`
        );
      }
      result[field] = null;
      continue;
    }
    if (leaf.kind === "count") {
      result[field] = parseCountValue(ctx, operation, fieldValue);
      continue;
    }
    result[field] =
      leaf.kind === "scalar"
        ? parseField(leaf.scalar, fieldValue, operation)
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
