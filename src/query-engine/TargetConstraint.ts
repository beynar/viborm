// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this compiler owner TargetConstraint.
import type { Model } from "@schema/model";
import type { ScalarType } from "@schema/scalars/common";
import { isSql } from "@sql";
import { isRecord } from "@validation/value-guards";
import {
  getWhereUniqueEntries,
  getWhereUniqueFilters,
} from "./builders/where-unique-builder";

type ExactTargetValue =
  | { readonly kind: "null" }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "bigint"; readonly value: bigint }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "date"; readonly value: number }
  | { readonly kind: "bytes"; readonly value: readonly number[] };

type TargetValue = ExactTargetValue | { readonly kind: "unknown" };

export interface TargetConstraintField {
  readonly scalarType: ScalarType | undefined;
  readonly value: TargetValue;
}

export interface TargetConstraint {
  readonly model: Model<any>;
  readonly fields: ReadonlyMap<string, TargetConstraintField>;
  readonly certainty: "exact" | "unknown";
}

export type TargetConstraintOverlap = "equal" | "disjoint" | "unknown";

export function normalizeWhereUniqueTargetConstraint(
  model: Model<any>,
  where: Record<string, unknown>
): TargetConstraint {
  const entries = getWhereUniqueEntries({ model }, where);
  const values = new Map<string, unknown>();
  const duplicateFields = new Set<string>();
  const fieldNames: string[] = [];

  for (const entry of entries) {
    fieldNames.push(entry.fieldName);
    if (values.has(entry.fieldName)) {
      const previous = normalizeTargetValue(values.get(entry.fieldName));
      const next = normalizeTargetValue(entry.value);
      if (!exactValuesEqual(previous, next)) {
        duplicateFields.add(entry.fieldName);
      }
    } else {
      values.set(entry.fieldName, entry.value);
    }
  }

  return buildTargetConstraint(model, fieldNames, (fieldName) => ({
    hasValue: !duplicateFields.has(fieldName) && values.has(fieldName),
    value: values.get(fieldName),
  }));
}

export function normalizeTargetConstraint(
  model: Model<any>,
  fieldNames: readonly string[],
  values: Readonly<Record<string, unknown>>
): TargetConstraint {
  return buildTargetConstraint(model, fieldNames, (fieldName) => ({
    hasValue: Object.hasOwn(values, fieldName),
    value: values[fieldName],
  }));
}

/**
 * Return the exact selector that a same-operation create makes visible.
 *
 * `where` and `create` are independent public inputs. Equal selectors are not
 * duplicates until an earlier create is proven to satisfy that selector, and
 * extended filters cannot be proven from the unique discriminator alone.
 */
export function getCreatedWhereUniqueTarget(
  model: Model<any>,
  where: Record<string, unknown>,
  create: Readonly<Record<string, unknown>>
): TargetConstraint | undefined {
  if (getWhereUniqueFilters({ model }, where)) return undefined;

  const selector = normalizeWhereUniqueTargetConstraint(model, where);
  const created = normalizeTargetConstraint(
    model,
    [...selector.fields.keys()],
    create
  );
  return classifyTargetConstraintOverlap(selector, created) === "equal"
    ? selector
    : undefined;
}

function buildTargetConstraint(
  model: Model<any>,
  fieldNames: readonly string[],
  getValue: (fieldName: string) => {
    readonly hasValue: boolean;
    readonly value: unknown;
  }
): TargetConstraint {
  const fields = new Map<string, TargetConstraintField>();
  const sortedFieldNames = [...new Set(fieldNames)].sort();

  for (const fieldName of sortedFieldNames) {
    const scalar = model["~"].state.scalars[fieldName];
    const scalarType = scalar?.["~"].state.type;
    const source = getValue(fieldName);
    const value: TargetValue =
      scalarType !== undefined && source.hasValue
        ? normalizeTargetValue(source.value)
        : { kind: "unknown" };
    fields.set(fieldName, { scalarType, value });
  }

  const isExact =
    fields.size > 0 &&
    [...fields.values()].every((field) => field.value.kind !== "unknown");

  return {
    model,
    fields,
    certainty: isExact ? "exact" : "unknown",
  };
}

export function classifyTargetConstraintOverlap(
  left: TargetConstraint,
  right: TargetConstraint
): TargetConstraintOverlap {
  if (left.model !== right.model) {
    return "unknown";
  }

  if (areExactlyEqual(left, right)) {
    return "equal";
  }

  for (const [fieldName, leftField] of left.fields) {
    const rightField = right.fields.get(fieldName);
    if (
      rightField !== undefined &&
      provesPortableDisjointness(leftField, rightField)
    ) {
      return "disjoint";
    }
  }

  return "unknown";
}

/** Stable key for exact constraints; unknown values deliberately stay unkeyed. */
export function exactTargetConstraintKey(
  constraint: TargetConstraint
): string | undefined {
  if (constraint.certainty !== "exact") return undefined;
  return JSON.stringify(
    [...constraint.fields].map(([name, field]) => [
      name,
      field.scalarType,
      exactTargetValueKey(field.value),
    ])
  );
}

function exactTargetValueKey(value: TargetValue): unknown {
  switch (value.kind) {
    case "null":
      return ["null"];
    case "bigint":
      return [value.kind, value.value.toString()];
    case "bytes":
      return [value.kind, [...value.value]];
    case "string":
    case "number":
    case "boolean":
    case "date":
      return [value.kind, value.value];
    case "unknown":
      return undefined;
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

function areExactlyEqual(
  left: TargetConstraint,
  right: TargetConstraint
): boolean {
  if (
    left.certainty !== "exact" ||
    right.certainty !== "exact" ||
    left.fields.size !== right.fields.size
  ) {
    return false;
  }

  for (const [fieldName, leftField] of left.fields) {
    const rightField = right.fields.get(fieldName);
    if (
      rightField === undefined ||
      leftField.scalarType !== rightField.scalarType ||
      !exactValuesEqual(leftField.value, rightField.value)
    ) {
      return false;
    }
  }

  return true;
}

function provesPortableDisjointness(
  left: TargetConstraintField,
  right: TargetConstraintField
): boolean {
  if (
    left.scalarType !== right.scalarType ||
    left.value.kind === "unknown" ||
    right.value.kind === "unknown"
  ) {
    return false;
  }

  switch (left.scalarType) {
    case "int":
      return (
        left.value.kind === "number" &&
        right.value.kind === "number" &&
        Number.isInteger(left.value.value) &&
        Number.isInteger(right.value.value) &&
        left.value.value !== right.value.value
      );
    case "bigint":
      return (
        left.value.kind === "bigint" &&
        right.value.kind === "bigint" &&
        left.value.value !== right.value.value
      );
    case "boolean":
      return (
        left.value.kind === "boolean" &&
        right.value.kind === "boolean" &&
        left.value.value !== right.value.value
      );
    default:
      return false;
  }
}

function exactValuesEqual(left: TargetValue, right: TargetValue): boolean {
  switch (left.kind) {
    case "null":
      return right.kind === "null";
    case "string":
      return right.kind === "string" && left.value === right.value;
    case "number":
      return right.kind === "number" && left.value === right.value;
    case "bigint":
      return right.kind === "bigint" && left.value === right.value;
    case "boolean":
      return right.kind === "boolean" && left.value === right.value;
    case "date":
      return right.kind === "date" && left.value === right.value;
    case "bytes":
      return (
        right.kind === "bytes" &&
        left.value.length === right.value.length &&
        left.value.every((byte, index) => byte === right.value[index])
      );
    case "unknown":
      return false;
    default: {
      const exhaustive: never = left;
      return exhaustive;
    }
  }
}

function normalizeTargetValue(value: unknown): TargetValue {
  if (value === null) return { kind: "null" };
  if (isSql(value)) return { kind: "unknown" };

  switch (typeof value) {
    case "string":
      return { kind: "string", value };
    case "number":
      return Number.isFinite(value)
        ? { kind: "number", value }
        : { kind: "unknown" };
    case "bigint":
      return { kind: "bigint", value };
    case "boolean":
      return { kind: "boolean", value };
    case "object":
      if (value instanceof Date) {
        const timestamp = value.getTime();
        return Number.isFinite(timestamp)
          ? { kind: "date", value: timestamp }
          : { kind: "unknown" };
      }
      if (value instanceof Uint8Array) {
        return { kind: "bytes", value: Array.from(value) };
      }
      return { kind: "unknown" };
    default:
      return { kind: "unknown" };
  }
}

export function selectorConstraint(
  model: Model<any>,
  where: Record<string, unknown>
): TargetConstraint {
  return normalizeWhereUniqueTargetConstraint(model, where);
}

export function createIdentityConstraint(
  model: Model<any>,
  data: Readonly<Record<string, unknown>>
): TargetConstraint {
  return normalizeTargetConstraint(model, getTargetIdentityFields(model), data);
}

export function updateResultConstraints(
  model: Model<any>,
  selector: TargetConstraint,
  data: Readonly<Record<string, unknown>>,
  where: Readonly<Record<string, unknown>>
): TargetConstraint[] {
  const changesIdentity = getTargetIdentityFields(model).some(
    (fieldName) =>
      Object.hasOwn(data, fieldName) && data[fieldName] !== undefined
  );
  if (!changesIdentity) return [];

  const scalarData = Object.fromEntries(
    Object.entries(data).filter(([field]) =>
      Object.hasOwn(model["~"].state.scalars, field)
    )
  );
  const constraints: TargetConstraint[] = [];
  for (const footprint of buildScalarUpdatePredicateFootprints(
    model,
    scalarData,
    where
  )) {
    if (
      constraints.some(
        (constraint) =>
          classifyTargetConstraintOverlap(constraint, footprint.constraint) ===
          "equal"
      )
    ) {
      continue;
    }
    constraints.push(footprint.constraint);
  }
  return constraints.length > 0 ? constraints : [selector];
}

export function unknownConstraint(model: Model<any>): TargetConstraint {
  return normalizeTargetConstraint(model, getTargetIdentityFields(model), {});
}

export type PredicateFieldSet = ReadonlySet<string> | "unknown";

export interface TargetPredicateFootprint {
  readonly changedFields: ReadonlySet<string>;
  readonly constraint: TargetConstraint;
}

export function buildScalarUpdatePredicateFootprints(
  model: Model<any>,
  scalarData: Readonly<Record<string, unknown>>,
  selector: Readonly<Record<string, unknown>> | undefined
): TargetPredicateFootprint[] {
  const changedFields = new Set(Object.keys(scalarData));
  if (changedFields.size === 0) return [];

  const identityFields = getTargetIdentityFields(model);
  const beforeConstraint = selector
    ? normalizeWhereUniqueTargetConstraint(model, { ...selector })
    : normalizeTargetConstraint(model, identityFields, {});
  const footprints: TargetPredicateFootprint[] = [
    { changedFields, constraint: beforeConstraint },
  ];
  if (!identityFields.some((field) => changedFields.has(field))) {
    return footprints;
  }

  const afterValues = getKnownSelectorValues(model, selector);
  const afterFields = new Set(Object.keys(afterValues));
  for (const field of identityFields) {
    if (!changedFields.has(field)) continue;
    afterFields.add(field);
    const update = classifyRelationKeyScalarUpdate(scalarData[field]);
    if (update.resolved) afterValues[field] = update.value;
    else delete afterValues[field];
  }

  const afterConstraint = normalizeTargetConstraint(
    model,
    [...afterFields],
    afterValues
  );
  if (
    classifyTargetConstraintOverlap(beforeConstraint, afterConstraint) !==
    "equal"
  ) {
    footprints.push({ changedFields, constraint: afterConstraint });
  }
  return footprints;
}

export function getTargetConstraintPredicateFields(
  constraint: TargetConstraint
): ReadonlySet<string> {
  return new Set(constraint.fields.keys());
}

export function getFilterPredicateFields(
  model: Model<any>,
  filter: unknown
): PredicateFieldSet {
  const fields = new Set<string>();
  return collectFilterPredicateFields(model, filter, fields)
    ? fields
    : "unknown";
}

export function getFilterTargetConstraint(
  model: Model<any>,
  filter: unknown
): TargetConstraint {
  const identityFields = getTargetIdentityFields(model);
  const values: Record<string, unknown> = {};
  if (!isRecord(filter)) {
    return normalizeTargetConstraint(model, identityFields, values);
  }
  for (const field of identityFields) {
    if (!Object.hasOwn(filter, field)) continue;
    const exactValue = getExactFilterValue(filter[field]);
    if (exactValue.known) values[field] = exactValue.value;
  }
  return normalizeTargetConstraint(model, identityFields, values);
}

/**
 * The fields a read predicates on when ONE statement evaluates two predicates — a
 * composed to-one modify locates by the supplier's selector AND by the wrapper filter's
 * conjuncts in the same probe. `"unknown"` absorbs, because a predicate whose fields
 * cannot be enumerated may name any of them.
 */
export function unionPredicateFields(
  left: PredicateFieldSet,
  right: PredicateFieldSet
): PredicateFieldSet {
  if (left === "unknown" || right === "unknown") return "unknown";
  return new Set([...left, ...right]);
}

export function predicateFieldSetsIntersect(
  changedFields: ReadonlySet<string>,
  readFields: PredicateFieldSet
): boolean {
  if (readFields === "unknown") return changedFields.size > 0;
  for (const field of changedFields) {
    if (readFields.has(field)) return true;
  }
  return false;
}

export function getTargetIdentityFields(model: Model<any>): string[] {
  const state = model["~"].state;
  const fieldNames = new Set(Object.keys(state.uniques));
  addConstraintFields(fieldNames, state.compoundId);
  addConstraintFields(fieldNames, state.compoundUniques);
  return [...fieldNames];
}

/**
 * Every field a FOREIGN KEY in this schema's DDL may point at.
 *
 * ADDRESSABILITY and REFERENCEABILITY are different questions, so they are
 * different functions. {@link getTargetIdentityFields} answers the first — the
 * column sets a `whereUnique` can NAME (`state.uniques`, `state.compoundId`,
 * `state.compoundUniques`) — and that is the right answer everywhere a selector
 * is being normalized. This one answers the second, and it is strictly wider:
 * a unique INDEX (`.index([...], { unique: true })`, which the migration driver
 * emits as `CREATE UNIQUE INDEX`) is a unique column set the database enforces
 * and therefore one a foreign key may reference, even though no selector can
 * address it. A relation spelling `.references("code")` against such a column
 * produces a real `… REFERENCES … ON UPDATE CASCADE` constraint.
 *
 * It over-approximates in one direction only, which is what its one caller
 * ({@link setCanFireReferentialAction}) needs: a partial unique index cannot be
 * an FK target in PostgreSQL, and this counts it anyway. That declines a legal
 * fold, which costs a statement — never an answer.
 */
export function getForeignKeyTargetFields(model: Model<any>): string[] {
  const fieldNames = new Set(getTargetIdentityFields(model));
  for (const index of model["~"].state.indexes) {
    if (index.options.unique !== true) continue;
    for (const fieldName of index.fields) fieldNames.add(fieldName);
  }
  return [...fieldNames];
}

export function classifyRelationKeyScalarUpdate(
  value: unknown
): { resolved: true; value: unknown } | { resolved: false } {
  if (value === null) return { resolved: true, value: null };
  if (isSql(value) || Array.isArray(value)) {
    return { resolved: false };
  }
  if (!isPlainRecord(value)) return { resolved: true, value };

  const setValue = value.set;
  if (
    Object.keys(value).length === 1 &&
    setValue !== undefined &&
    !isSql(setValue) &&
    !Array.isArray(setValue) &&
    !isPlainRecord(setValue)
  ) {
    return { resolved: true, value: setValue };
  }
  return { resolved: false };
}

function getKnownSelectorValues(
  model: Model<any>,
  selector: Readonly<Record<string, unknown>> | undefined
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (!selector) return values;
  for (const entry of getWhereUniqueEntries({ model }, { ...selector })) {
    values[entry.fieldName] = entry.value;
  }
  return values;
}

function collectFilterPredicateFields(
  model: Model<any>,
  filter: unknown,
  fields: Set<string>
): boolean {
  if (!isRecord(filter)) return false;
  for (const [field, value] of Object.entries(filter)) {
    if (field === "AND" || field === "OR" || field === "NOT") {
      const operands = Array.isArray(value) ? value : [value];
      for (const operand of operands) {
        if (!collectFilterPredicateFields(model, operand, fields)) return false;
      }
      continue;
    }
    if (!Object.hasOwn(model["~"].state.scalars, field)) return false;
    fields.add(field);
  }
  return true;
}

function addConstraintFields(
  fieldNames: Set<string>,
  constraints: Record<string, { entries: Record<string, unknown> }> | undefined
): void {
  if (!constraints) return;
  for (const constraint of Object.values(constraints)) {
    for (const fieldName of Object.keys(constraint.entries)) {
      fieldNames.add(fieldName);
    }
  }
}

function getExactFilterValue(
  value: unknown
):
  | { readonly known: true; readonly value: unknown }
  | { readonly known: false } {
  if (value instanceof Date || value instanceof Uint8Array) {
    return { known: true, value };
  }
  if (!isRecord(value)) return { known: true, value };
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "equals"
    ? { known: true, value: value.equals }
    : { known: false };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
