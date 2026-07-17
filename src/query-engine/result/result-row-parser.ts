import type { AnyRelation } from "@schema/relation";
import type { Scalar } from "@schema/scalars";
import {
  EMPTY_ROW_RESULT_KEY,
  getAggregateResultName,
  RELATION_COUNTS_RESULT_KEY,
  VECTOR_DISTANCE_RESULT_KEY,
} from "../result-aliases";
import {
  type ExpectedResultShape,
  isBatchOperation,
  type Operation,
} from "../types";
import type { ResultParser } from "./ResultParser";
import { assignRelationCounts } from "./relation-count-parser";
import {
  isNullableSingleRecordOperation,
  isRequiredSingleRecordOperation,
  parseCountCarrierDefault,
  parseMutationCountFor,
  parseSafeCountValue,
} from "./result-count-parser";
import {
  assertExpectedRowKeys,
  assertUniformRowKeys,
  getOwnValue,
  malformedResult,
  normalizeResultRows,
  type RowValueParsers,
} from "./result-parser-contract";
import { parseFiniteProviderNumber } from "./scalar-structured-parser";

function parseVectorDistanceValue(
  ctx: ResultParser,
  operation: Operation,
  value: unknown
): number {
  const distance = parseFiniteProviderNumber(value);
  if (distance !== undefined) return distance;
  return malformedResult(ctx, operation, "Cannot parse vector distance result");
}

export function parseResultDefault(
  ctx: ResultParser,
  operation: Operation,
  raw: unknown,
  shape: ExpectedResultShape | undefined,
  parsers: RowValueParsers
): unknown {
  if (isBatchOperation(operation)) {
    return parseMutationCountFor(ctx, operation, raw);
  }

  if (!Array.isArray(raw)) {
    return malformedResult(
      ctx,
      operation,
      "a non-batch operation must return a row array"
    );
  }

  if (shape && shape.carrier !== "rows") {
    return parseCountCarrierDefault(ctx, operation, raw, shape);
  }

  if (isNullableSingleRecordOperation(operation)) {
    if (raw.length === 0) {
      return null;
    }
    return parseRequiredSingleRow(ctx, operation, raw, shape, parsers);
  }

  if (isRequiredSingleRecordOperation(operation)) {
    return parseRequiredSingleRow(ctx, operation, raw, shape, parsers);
  }

  return parseRowArray(ctx, operation, raw, shape, parsers);
}

function parseRequiredSingleRow(
  ctx: ResultParser,
  operation: Operation,
  raw: unknown[],
  shape: ExpectedResultShape | undefined,
  parsers: RowValueParsers
): Record<string, unknown> {
  if (raw.length !== 1) {
    return malformedResult(
      ctx,
      operation,
      `expected exactly one row but received ${raw.length}`
    );
  }
  const [row] = normalizeResultRows(ctx, operation, raw);
  if (!row) {
    return malformedResult(ctx, operation, "the required row is absent");
  }
  if (operation === "aggregate" && Object.keys(row).length === 0) {
    return malformedResult(
      ctx,
      operation,
      "the aggregate row has no selected columns"
    );
  }
  if (shape) assertExpectedRowKeys(ctx, operation, row, shape);
  return parseRow(ctx, operation, row, shape, parsers);
}

function parseRowArray(
  ctx: ResultParser,
  operation: Operation,
  raw: unknown[],
  shape: ExpectedResultShape | undefined,
  parsers: RowValueParsers
): Record<string, unknown>[] {
  const rows = normalizeResultRows(ctx, operation, raw);
  const [first] = rows;
  if (!first) {
    return [];
  }

  const keys = Object.keys(first);
  if (shape) {
    for (const row of rows) assertExpectedRowKeys(ctx, operation, row, shape);
  } else {
    assertUniformRowKeys(ctx, operation, rows, keys);
  }
  const model = ctx.model;
  const rowParser = createRowParser(
    ctx,
    operation,
    keys,
    model["~"].state.scalars,
    model["~"].state.relations,
    shape,
    parsers
  );
  return rows.map(rowParser);
}

/**
 * Parse a single row, using schema info for type-aware conversion
 */
function parseRow(
  ctx: ResultParser,
  operation: Operation,
  row: Record<string, unknown>,
  shape: ExpectedResultShape | undefined,
  parsers: RowValueParsers
): Record<string, unknown> {
  const model = ctx.model;
  const keys = Object.keys(row);
  return createRowParser(
    ctx,
    operation,
    keys,
    model["~"].state.scalars,
    model["~"].state.relations,
    shape,
    parsers
  )(row);
}

/**
 * Build a row parser for a fixed set of columns: the scalar/relation/count
 * dispatch is resolved once per result set instead of once per row per field.
 */
export function createRowParser(
  ctx: ResultParser,
  operation: Operation,
  keys: string[],
  scalars: Record<string, Scalar>,
  relations: Record<string, AnyRelation>,
  shape: ExpectedResultShape | undefined,
  parsers: RowValueParsers
): (row: Record<string, unknown>) => Record<string, unknown> {
  const len = keys.length;
  const steps: ((result: Record<string, unknown>, value: unknown) => void)[] =
    new Array(len);

  for (let i = 0; i < len; i++) {
    const key = keys[i]!;

    if (key === EMPTY_ROW_RESULT_KEY) {
      steps[i] = (_result, value) => {
        if (parseSafeCountValue(value) !== 1) {
          malformedResult(
            ctx,
            operation,
            "the private empty-row carrier is malformed"
          );
        }
      };
      continue;
    }

    if (key === VECTOR_DISTANCE_RESULT_KEY) {
      steps[i] = (result, value) => {
        result._distance = parseVectorDistanceValue(ctx, operation, value);
      };
      continue;
    }

    const scalar = getOwnValue(scalars, key);
    if (scalar) {
      steps[i] = (result, value) => {
        result[key] = parsers.parseField(scalar, value, operation);
      };
      continue;
    }

    if (key === RELATION_COUNTS_RESULT_KEY) {
      const expectedRelations = shape?.relationCounts;
      if (!(expectedRelations && expectedRelations.size > 0)) {
        malformedResult(
          ctx,
          operation,
          "an unrequested relation-count carrier was returned"
        );
      }
      steps[i] = (result, value) =>
        assignRelationCounts(
          ctx,
          operation,
          result,
          value,
          relations,
          expectedRelations
        );
      continue;
    }

    const relation = getOwnValue(relations, key);
    if (relation) {
      const relationShape = shape?.relations.get(key);
      steps[i] = (result, value) => {
        result[key] = parsers.parseRelation(
          relation,
          value,
          operation,
          relationShape
        );
      };
      continue;
    }

    const aggregateName = getAggregateResultName(key);
    if (aggregateName) {
      const aggregateShape = shape?.aggregates.get(key);
      steps[i] = (result, value) => {
        result[aggregateName] = parsers.parseAggregate(
          operation,
          aggregateName,
          value,
          scalars,
          aggregateShape
        );
      };
      continue;
    }

    malformedResult(
      ctx,
      operation,
      `returned column "${key}" is not part of the active result shape`
    );
  }

  return (row) => {
    const result: Record<string, unknown> = {};
    for (let i = 0; i < len; i++) {
      steps[i]!(result, row[keys[i]!]);
    }
    return result;
  };
}
