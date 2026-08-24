import type { Model } from "@schema/model";
import type { AnyRelation } from "@schema/relation";
import {
  POLYMORPHIC_COLLECTION_ARMS_KEY,
  POLYMORPHIC_COLLECTION_MEMBERSHIP_KEY,
  POLYMORPHIC_COLLECTION_ORPHANS_KEY,
  POLYMORPHIC_COLLECTION_ROWS_KEY,
  POLYMORPHIC_RESULT_STATE_COLLECTION,
  POLYMORPHIC_RESULT_STATE_INVALID,
  POLYMORPHIC_RESULT_STATE_KEY,
  POLYMORPHIC_RESULT_STATE_LINKED,
} from "../result-aliases";
import {
  type ExpectedPolymorphicResultShape,
  type ExpectedPolymorphicVariantShape,
  type Operation,
  QueryEngineError,
} from "../types";
import type { ResultParser } from "./ResultParser";
import { parseSafeCountValue } from "./result-count-parser";
import {
  assertExpectedRowKeys,
  decodeRelationCarrier,
  isResultRow,
  malformedResult,
  normalizeResultRows,
  type RowValueParsers,
} from "./result-parser-contract";

const LINKED_KEYS = [POLYMORPHIC_RESULT_STATE_KEY, "type", "data"];
const INVALID_KEYS = [POLYMORPHIC_RESULT_STATE_KEY, "storedType", "hasId"];
const COLLECTION_KEYS = [
  POLYMORPHIC_RESULT_STATE_KEY,
  POLYMORPHIC_COLLECTION_ARMS_KEY,
];
const COLLECTION_ARM_KEYS = [
  POLYMORPHIC_COLLECTION_MEMBERSHIP_KEY,
  POLYMORPHIC_COLLECTION_ORPHANS_KEY,
  POLYMORPHIC_COLLECTION_ROWS_KEY,
];

export function parsePolymorphicValueDefault(
  ctx: ResultParser,
  ownerModel: Model<any>,
  relationName: string,
  _relation: AnyRelation,
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
  if (shape.cardinality === "many") {
    return parseCollectionValue(
      ctx,
      ownerModel,
      relationName,
      decodeRelationCarrier(value),
      operation,
      shape,
      parsers,
      typeof value === "string"
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
  const carrier = decodeRelationCarrier(value);
  const ownsCarrierRows = typeof value === "string";
  if (!isResultRow(carrier)) {
    return malformedResult(
      ctx,
      operation,
      "a polymorphic relation carrier must be a non-null object"
    );
  }

  const state = carrier[POLYMORPHIC_RESULT_STATE_KEY];
  if (state === POLYMORPHIC_RESULT_STATE_INVALID) {
    if (
      !hasExactKeys(carrier, INVALID_KEYS) ||
      typeof carrier.hasId !== "boolean"
    ) {
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
    !hasExactKeys(carrier, LINKED_KEYS)
  ) {
    return malformedResult(
      ctx,
      operation,
      "the polymorphic relation carrier tag or envelope is malformed"
    );
  }

  const publicType = carrier.type;
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

  if (carrier.data === null) {
    throw missingTargetRecord(ownerModel, relationName, publicType);
  }
  if (!isResultRow(carrier.data)) {
    return malformedResult(
      ctx,
      operation,
      "the polymorphic relation target data is not a non-null object"
    );
  }

  assertExpectedRowKeys(ctx, operation, carrier.data, variant.shape);
  const parseTarget = parsers.getRowParser(
    variant.model,
    carrier.data,
    operation,
    variant.shape
  );
  return {
    type: publicType,
    data: ownsCarrierRows
      ? parseTarget(carrier.data, true)
      : parseTarget(carrier.data),
  };
}

/**
 * The COLLECTION ladder — strict, and ordered so that malformed stored
 * membership cannot be hidden by anything the caller asked for.
 *
 * The one non-obvious ordering rule: every arm's integrity facts are validated,
 * and a non-zero orphan count refuses, BEFORE any visible row of any arm is
 * parsed. An arm excluded by `only` is checked exactly like an included one —
 * a type allow-list, filter, cursor, `take` or `LIMIT` must not be able to hide
 * a membership row whose target is gone.
 *
 * Nested rows never reach root exact-field capture: `ExactFieldCapture` is
 * root-only and `getNestedRowParser` builds nested parsers without it, so this
 * branch simply must not thread `exactFields` — and does not receive it.
 */
function parseCollectionValue(
  ctx: ResultParser,
  ownerModel: Model<any>,
  relationName: string,
  value: unknown,
  operation: Operation,
  shape: ExpectedPolymorphicResultShape,
  parsers: RowValueParsers,
  ownsCarrierRows: boolean
): unknown {
  // A collection has no null state: emptiness is the empty array.
  if (value === null) {
    return malformedResult(
      ctx,
      operation,
      "a polymorphic collection returned null instead of a carrier"
    );
  }
  if (!isResultRow(value)) {
    return malformedResult(
      ctx,
      operation,
      "a polymorphic collection carrier must be a non-null object"
    );
  }
  if (
    value[POLYMORPHIC_RESULT_STATE_KEY] !==
      POLYMORPHIC_RESULT_STATE_COLLECTION ||
    !hasExactKeys(value, COLLECTION_KEYS)
  ) {
    return malformedResult(
      ctx,
      operation,
      "the polymorphic collection carrier tag or envelope is malformed"
    );
  }

  const arms = value[POLYMORPHIC_COLLECTION_ARMS_KEY];
  if (!isResultRow(arms)) {
    return malformedResult(
      ctx,
      operation,
      "the polymorphic collection arm container is not an object"
    );
  }
  // Exact ARM KEYS before any parser reuse: an arm the read did not configure,
  // or a configured arm the driver dropped, is a malformed carrier — not a
  // variant to skip.
  if (!hasExactKeys(arms, [...shape.variants.keys()])) {
    return malformedResult(
      ctx,
      operation,
      "the polymorphic collection arms do not match the configured variants"
    );
  }

  // PASS ONE — integrity only, every configured arm, no visible row parsed.
  // `shape.variants` is built by walking the storage members, so every pass
  // below runs in DECLARATION ORDER.
  const visibleArms: {
    readonly publicType: string;
    readonly variant: ExpectedPolymorphicVariantShape;
    readonly rows: unknown[];
  }[] = [];
  for (const [publicType, variant] of shape.variants) {
    const arm = arms[publicType];
    if (!(isResultRow(arm) && hasExactKeys(arm, COLLECTION_ARM_KEYS))) {
      return malformedResult(
        ctx,
        operation,
        "a polymorphic collection arm carrier is malformed"
      );
    }
    const membership = parseSafeCountValue(
      arm[POLYMORPHIC_COLLECTION_MEMBERSHIP_KEY]
    );
    const orphans = parseSafeCountValue(
      arm[POLYMORPHIC_COLLECTION_ORPHANS_KEY]
    );
    if (membership === undefined || orphans === undefined) {
      return malformedResult(
        ctx,
        operation,
        "a polymorphic collection integrity fact is not a canonical non-negative integer"
      );
    }
    if (orphans !== 0) {
      throw missingTargetRecord(ownerModel, relationName, publicType);
    }
    const rows = readArmRows(ctx, operation, arm, variant);
    if (rows) visibleArms.push({ publicType, variant, rows });
  }

  if (!ownsCarrierRows) {
    const parsed: unknown[] = [];
    for (const { publicType, variant, rows } of visibleArms) {
      const armRows = parseBorrowedArmRows(
        ctx,
        ownerModel,
        relationName,
        publicType,
        rows,
        operation,
        variant,
        parsers
      );
      parsed.push(...(variant.reversed ? armRows.reverse() : armRows));
    }
    return parsed;
  }

  // PASS TWO — validate every visible envelope and target shape before any
  // parser-owned target row is changed in place.
  const validatedArms = visibleArms.map(({ publicType, variant, rows }) => ({
    publicType,
    variant,
    targets: validateArmRows(
      ctx,
      ownerModel,
      relationName,
      publicType,
      rows,
      operation,
      variant
    ),
  }));

  // PASS THREE — visible rows only, concatenated into one FRESH array.
  const parsed: unknown[] = [];
  for (const { publicType, variant, targets } of validatedArms) {
    const armRows = parseArmRows(
      publicType,
      targets,
      operation,
      variant,
      parsers
    );
    // A negative arm-local `take` ran as a reversed window; restore this arm's
    // logical order BEFORE it joins the flat array, never after.
    parsed.push(...(variant.reversed ? armRows.reverse() : armRows));
  }
  return parsed;
}

function parseBorrowedArmRows(
  ctx: ResultParser,
  ownerModel: Model<any>,
  relationName: string,
  publicType: string,
  rows: unknown[],
  operation: Operation,
  variant: ExpectedPolymorphicVariantShape,
  parsers: RowValueParsers
): unknown[] {
  const envelopes = normalizeResultRows(ctx, operation, rows);
  const parsed: unknown[] = new Array(envelopes.length);
  for (let index = 0; index < envelopes.length; index++) {
    const envelope = envelopes[index]!;
    if (
      envelope[POLYMORPHIC_RESULT_STATE_KEY] !==
        POLYMORPHIC_RESULT_STATE_LINKED ||
      !hasExactKeys(envelope, LINKED_KEYS) ||
      envelope.type !== publicType
    ) {
      malformedResult(
        ctx,
        operation,
        "a polymorphic collection element envelope is malformed or mistagged"
      );
    }
    if (envelope.data === null) {
      throw missingTargetRecord(ownerModel, relationName, publicType);
    }
    if (!isResultRow(envelope.data)) {
      malformedResult(
        ctx,
        operation,
        "a polymorphic collection element target is not a non-null object"
      );
    }
    assertExpectedRowKeys(ctx, operation, envelope.data, variant.shape);
    const parseTarget = parsers.getRowParser(
      variant.model,
      envelope.data,
      operation,
      variant.shape
    );
    parsed[index] = {
      type: publicType,
      data: parseTarget(envelope.data),
    };
  }
  return parsed;
}

/**
 * `rows` is `null` EXACTLY when the arm is excluded, and an array otherwise —
 * the structural disambiguation the builder set up: an excluded arm emits no
 * visible-row branch at all, so its `rows` is SQL NULL by construction, while a
 * NULL aggregate over an allow-listed arm normalizes to `[]`.
 */
function readArmRows(
  ctx: ResultParser,
  operation: Operation,
  arm: Record<string, unknown>,
  variant: ExpectedPolymorphicVariantShape
): unknown[] | undefined {
  const rows = arm[POLYMORPHIC_COLLECTION_ROWS_KEY];
  if (variant.visible !== true) {
    if (rows === null) return undefined;
    return malformedResult(
      ctx,
      operation,
      "an excluded polymorphic collection arm returned visible rows"
    );
  }
  if (rows === null) return [];
  if (!Array.isArray(rows)) {
    return malformedResult(
      ctx,
      operation,
      "a polymorphic collection arm did not return a row array"
    );
  }
  return rows;
}

function parseArmRows(
  publicType: string,
  targets: readonly Record<string, unknown>[],
  operation: Operation,
  variant: ExpectedPolymorphicVariantShape,
  parsers: RowValueParsers
): unknown[] {
  const parsed: unknown[] = new Array(targets.length);
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]!;
    const parseTarget = parsers.getRowParser(
      variant.model,
      target,
      operation,
      variant.shape
    );
    parsed[index] = {
      type: publicType,
      data: parseTarget(target, true),
    };
  }
  return parsed;
}

function validateArmRows(
  ctx: ResultParser,
  ownerModel: Model<any>,
  relationName: string,
  publicType: string,
  rows: unknown[],
  operation: Operation,
  variant: ExpectedPolymorphicVariantShape
): Record<string, unknown>[] {
  const envelopes = normalizeResultRows(ctx, operation, rows);
  const targets: Record<string, unknown>[] = new Array(envelopes.length);
  for (let index = 0; index < envelopes.length; index++) {
    const envelope = envelopes[index]!;
    if (
      envelope[POLYMORPHIC_RESULT_STATE_KEY] !==
        POLYMORPHIC_RESULT_STATE_LINKED ||
      !hasExactKeys(envelope, LINKED_KEYS) ||
      envelope.type !== publicType
    ) {
      malformedResult(
        ctx,
        operation,
        "a polymorphic collection element envelope is malformed or mistagged"
      );
    }
    if (envelope.data === null) {
      throw missingTargetRecord(ownerModel, relationName, publicType);
    }
    if (!isResultRow(envelope.data)) {
      malformedResult(
        ctx,
        operation,
        "a polymorphic collection element target is not a non-null object"
      );
    }
    assertExpectedRowKeys(ctx, operation, envelope.data, variant.shape);
    targets[index] = envelope.data;
  }
  return targets;
}

function missingTargetRecord(
  ownerModel: Model<any>,
  relationName: string,
  publicType: string
): QueryEngineError {
  return new QueryEngineError(
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
