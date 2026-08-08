import type { Model } from "@schema/model";
import type { AnyPolymorphicRelation } from "@schema/relation";
import {
  POLYMORPHIC_RESULT_STATE_INVALID,
  POLYMORPHIC_RESULT_STATE_KEY,
  POLYMORPHIC_RESULT_STATE_LINKED,
} from "../result-aliases";
import {
  type ExpectedPolymorphicResultShape,
  type Operation,
  QueryEngineError,
} from "../types";
import type { ResultParser } from "./ResultParser";
import {
  assertExpectedRowKeys,
  isResultRow,
  malformedResult,
  type RowValueParsers,
} from "./result-parser-contract";
import { createRowParser } from "./result-row-parser";

const LINKED_KEYS = [POLYMORPHIC_RESULT_STATE_KEY, "type", "data"];
const INVALID_KEYS = [
  POLYMORPHIC_RESULT_STATE_KEY,
  "storedType",
  "hasId",
];

export function parsePolymorphicValueDefault(
  ctx: ResultParser,
  ownerModel: Model<any>,
  relationName: string,
  _relation: AnyPolymorphicRelation,
  value: unknown,
  operation: Operation,
  shape: ExpectedPolymorphicResultShape | undefined,
  parsers: RowValueParsers
): unknown {
  if (!shape) {
    return malformedResult(
      ctx,
      operation,
      "a polymorphic projection has no expected result shape"
    );
  }
  if (value === undefined) {
    return malformedResult(
      ctx,
      operation,
      "an included polymorphic relation value is absent"
    );
  }
  if (value === null) {
    if (shape.optional) return null;
    return malformedResult(
      ctx,
      operation,
      "a required polymorphic relation returned empty storage"
    );
  }
  if (!isResultRow(value)) {
    return malformedResult(
      ctx,
      operation,
      "a polymorphic relation carrier must be a non-null object"
    );
  }

  const state = value[POLYMORPHIC_RESULT_STATE_KEY];
  if (state === POLYMORPHIC_RESULT_STATE_INVALID) {
    if (!hasExactKeys(value, INVALID_KEYS) || typeof value.hasId !== "boolean") {
      return malformedResult(
        ctx,
        operation,
        "the invalid polymorphic storage carrier is malformed"
      );
    }
    return malformedResult(
      ctx,
      operation,
      "a polymorphic relation contains unknown or half-null storage"
    );
  }
  if (
    state !== POLYMORPHIC_RESULT_STATE_LINKED ||
    !hasExactKeys(value, LINKED_KEYS)
  ) {
    return malformedResult(
      ctx,
      operation,
      "the polymorphic relation carrier tag or envelope is malformed"
    );
  }

  const publicType = value.type;
  if (typeof publicType !== "string") {
    return malformedResult(
      ctx,
      operation,
      "the polymorphic relation discriminator is not a string"
    );
  }
  const variant = shape.variants.get(publicType);
  if (!variant) {
    return malformedResult(
      ctx,
      operation,
      "the polymorphic relation discriminator is unknown"
    );
  }

  if (value.data === null) {
    if (shape.optional) return null;
    throw new QueryEngineError(
      `Polymorphic relation '${relationName}' references a missing '${publicType}' record.`,
      {
        meta: {
          model: ownerModel["~"].names.ts ?? "unknown",
          relation: relationName,
          type: publicType,
        },
      }
    );
  }
  if (!isResultRow(value.data)) {
    return malformedResult(
      ctx,
      operation,
      "the polymorphic relation target data is not a non-null object"
    );
  }

  assertExpectedRowKeys(ctx, operation, value.data, variant.shape);
  const parseTarget = createRowParser(
    ctx,
    operation,
    Object.keys(value.data),
    variant.model,
    variant.shape,
    parsers
  );
  return { type: publicType, data: parseTarget(value.data) };
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
