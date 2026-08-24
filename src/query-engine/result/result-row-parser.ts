import type { Model } from "@schema/model";
import { type AnyRelation, isVariantRelationState } from "@schema/relation";
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
  parseResultRows,
  type RowValueParsers,
} from "./result-parser-contract";
import { type IdentityGuard, identityGuardFor } from "./scalar-identity-parser";
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
  parsers: RowValueParsers,
  exactFields?: ExactFieldCapture
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
    return parseRequiredSingleRow(
      ctx,
      operation,
      raw,
      shape,
      parsers,
      exactFields
    );
  }

  if (isRequiredSingleRecordOperation(operation)) {
    return parseRequiredSingleRow(
      ctx,
      operation,
      raw,
      shape,
      parsers,
      exactFields
    );
  }

  return parseRowArray(ctx, operation, raw, shape, parsers, exactFields);
}

/**
 * One top-level result parse may retain selected scalar values before the
 * transitional legacy decimal conversion. Nested relation rows deliberately do
 * not receive this capture: a caller asks for keys of this parser's root model.
 */
export interface ExactFieldCapture {
  readonly fields: ReadonlySet<string>;
  readonly rows: Record<string, unknown>[];
}

function parseRequiredSingleRow(
  ctx: ResultParser,
  operation: Operation,
  raw: unknown[],
  shape: ExpectedResultShape | undefined,
  parsers: RowValueParsers,
  exactFields?: ExactFieldCapture
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
  const keys = Object.keys(row);
  return parseRow(ctx, operation, row, keys, shape, parsers, exactFields);
}

function parseRowArray(
  ctx: ResultParser,
  operation: Operation,
  raw: unknown[],
  shape: ExpectedResultShape | undefined,
  parsers: RowValueParsers,
  exactFields?: ExactFieldCapture
): Record<string, unknown>[] {
  const rows = normalizeResultRows(ctx, operation, raw);
  const [first] = rows;
  if (!first) {
    return [];
  }

  let keys: readonly string[];
  if (shape) {
    keys = Object.keys(first);
    for (const row of rows) {
      assertExpectedRowKeys(ctx, operation, row, shape);
    }
  } else {
    keys = Object.keys(first);
    assertUniformRowKeys(ctx, operation, rows, keys);
  }
  const model = ctx.model;
  const rowParser = createRowParser(
    ctx,
    operation,
    keys,
    model,
    shape,
    parsers,
    exactFields
  );
  return parseResultRows(rows, rowParser);
}

/**
 * Parse a single row, using schema info for type-aware conversion
 */
function parseRow(
  ctx: ResultParser,
  operation: Operation,
  row: Record<string, unknown>,
  keys: readonly string[],
  shape: ExpectedResultShape | undefined,
  parsers: RowValueParsers,
  exactFields?: ExactFieldCapture
): Record<string, unknown> {
  const model = ctx.model;
  return createRowParser(
    ctx,
    operation,
    keys,
    model,
    shape,
    parsers,
    exactFields
  )(row);
}

/**
 * Build a row parser for a fixed set of columns: the scalar/relation/count
 * dispatch is resolved once per result set instead of once per row per field.
 */
export function createRowParser(
  ctx: ResultParser,
  operation: Operation,
  keys: readonly string[],
  model: Model<any>,
  shape: ExpectedResultShape | undefined,
  parsers: RowValueParsers,
  exactFields?: ExactFieldCapture
): (
  row: Record<string, unknown>,
  reuseParserOwnedRow?: boolean
) => Record<string, unknown> {
  const scalars: Record<string, Scalar> = model["~"].state.scalars;
  const relations: Record<string, AnyRelation> = model["~"].state.relations;
  const len = keys.length;
  const steps: ((
    result: Record<string, unknown>,
    value: unknown,
    exact: Record<string, unknown> | undefined
  ) => void)[] = new Array(len);
  // The identity fast path (only on native-passthrough providers): a per-column
  // guard for plain string/int/float/boolean scalars. `identityGuards` is dense
  // (one entry per column) ONLY when every column is identity-eligible — the
  // signal that the whole-row passthrough below is available. Any non-identity
  // column clears it, falling the whole row back to the per-cell build.
  const identityEnabled = ctx.nativeScalarPassthrough;
  const identityGuards: IdentityGuard[] = new Array(len);
  let allIdentity = identityEnabled && len > 0;
  let preservesKeys = true;

  for (let i = 0; i < len; i++) {
    const key = keys[i]!;

    if (key === EMPTY_ROW_RESULT_KEY) {
      allIdentity = false;
      preservesKeys = false;
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
      allIdentity = false;
      preservesKeys = false;
      steps[i] = (result, value) => {
        result._distance = parseVectorDistanceValue(ctx, operation, value);
      };
      continue;
    }

    const scalar = getOwnValue(scalars, key);
    if (scalar) {
      const captureExact = exactFields?.fields.has(key) === true;
      const guard = identityEnabled ? identityGuardFor(scalar) : undefined;
      if (guard) {
        identityGuards[i] = guard;
        steps[i] = (result, value, exact) => {
          // A native value is returned unchanged; anything else (null, wrong
          // type, unsafe int, non-finite float) defers to the full parser.
          if (guard(value)) {
            result[key] = value;
            if (captureExact && exact) exact[key] = value;
            return;
          }
          result[key] = parsers.parseField(
            scalar,
            value,
            operation,
            captureExact && exact
              ? (parsed) => {
                  exact[key] = parsed;
                }
              : undefined
          );
        };
      } else {
        allIdentity = false;
        steps[i] = (result, value, exact) => {
          result[key] = parsers.parseField(
            scalar,
            value,
            operation,
            captureExact && exact
              ? (parsed) => {
                  exact[key] = parsed;
                }
              : undefined
          );
        };
      }
      continue;
    }

    if (key === RELATION_COUNTS_RESULT_KEY) {
      allIdentity = false;
      preservesKeys = false;
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
      allIdentity = false;
      // ONE map, dispatched on TARGET KIND: a variant slot arrives as a tagged
      // carrier with per-arm sub-shapes, an ordinary one as a nested row set.
      if (isVariantRelationState(relation["~"].state)) {
        const polymorphicShape = shape?.polymorphic.get(key);
        steps[i] = (result, value) => {
          result[key] = parsers.parsePolymorphic(
            model,
            key,
            relation,
            value,
            operation,
            polymorphicShape
          );
        };
        continue;
      }
      const relationShape = shape?.relations.get(key);
      steps[i] = (result, value) => {
        result[key] = parsers.parseRelation(
          model,
          key,
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
      allIdentity = false;
      preservesKeys = false;
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

  const buildRow = (
    row: Record<string, unknown>,
    initialResult?: Record<string, unknown>
  ): Record<string, unknown> => {
    const result: Record<string, unknown> = initialResult ?? {};
    const exact: Record<string, unknown> | undefined = exactFields
      ? {}
      : undefined;
    for (let i = 0; i < len; i++) {
      steps[i]!(result, row[keys[i]!], exact);
    }
    if (exact) exactFields?.rows.push(exact);
    return result;
  };

  if (!allIdentity) {
    return (row, reuseParserOwnedRow = false) =>
      buildRow(row, reuseParserOwnedRow && preservesKeys ? row : undefined);
  }

  // Whole-row passthrough: every column is an identity-eligible scalar. This is
  // the pre-existing Postgres-adapter fast path and applies equally to driver
  // and manual parsing. A non-native cell uses the full parser; a row decoded
  // from relation JSON may be updated in place on that fallback.
  return (row, reuseParserOwnedRow = false) => {
    for (let i = 0; i < len; i++) {
      if (!identityGuards[i]!(row[keys[i]!])) {
        return buildRow(
          row,
          reuseParserOwnedRow && preservesKeys ? row : undefined
        );
      }
    }
    if (exactFields) {
      const exact: Record<string, unknown> = {};
      for (const field of exactFields.fields) exact[field] = row[field];
      exactFields.rows.push(exact);
    }
    return row;
  };
}
