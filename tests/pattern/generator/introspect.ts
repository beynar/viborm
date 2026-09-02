/**
 * Introspection of the VibSchema graph, for the payload generator (unit B).
 *
 * The registry's operation schemas are plain objects built by the `v.*`
 * primitives. Every primitive publishes a `type` and the members it composes
 * (`entries`, `options`, `item`, `wrapped`, `values`, `value`), so a payload
 * can be produced by walking that graph instead of by re-deriving the operation
 * language from the model. This module normalises the runtime shapes into one
 * small `SchemaNode` vocabulary and names the kinds it does NOT handle.
 *
 * Handled: object (entries + the option set the validator reads: partial,
 * omit, atLeast, requiresOneOf, requiresOneOfKeySets, nonEmpty, and the
 * optional/nullable/array wrappers), union (`options`), array (`item`),
 * optional and nullable (`wrapped`, thunk or schema), the value wrappers that
 * forward to a `wrapped` schema (transform/coerce, comparison_operand,
 * field_ref_or, no_field_ref, json_null_or, json_write), lazyRef (`wrapped`),
 * lazy (a Proxy that forwards every read), thunk entries, and the scalar
 * primitives: string, number, integer, boolean, bigint, decimal, enum, literal,
 * json, date, iso_timestamp, iso_date, iso_time, blob, vector, point.
 *
 * Skipped (never generated, dropped from a union, dropped as an optional key):
 * `refused`, `rawRecord`, `anyValue`, `record`, an `object` without `entries`
 * (the relation filter's `null → { is: null }` member), and the JSON null
 * sentinels a `json_null_or` / `json_write` slot admits beside its wrapped
 * schema.
 */
import type { VibSchema } from "@validation/types";

export type AnySchema = VibSchema<unknown, unknown>;

export interface ObjectOptionsView {
  readonly partial: boolean;
  readonly omit: ReadonlySet<string>;
  readonly atLeast: readonly string[];
  readonly requiresOneOf: readonly (readonly string[])[];
  readonly requiresOneOfKeySets: readonly (readonly (readonly string[])[])[];
  readonly nonEmpty: boolean;
  readonly optional: boolean;
  readonly nullable: boolean;
  readonly array: boolean;
}

export interface ScalarOptionsView {
  readonly optional: boolean;
  readonly nullable: boolean;
  readonly array: boolean;
  readonly decimal:
    | { readonly precision: number; readonly scale: number }
    | undefined;
}

export type SchemaNode =
  | {
      readonly kind: "object";
      readonly schema: AnySchema;
      readonly entries: Readonly<Record<string, unknown>>;
      readonly options: ObjectOptionsView;
    }
  | { readonly kind: "union"; readonly options: readonly AnySchema[] }
  | { readonly kind: "array"; readonly item: AnySchema }
  | { readonly kind: "optional"; readonly wrapped: AnySchema }
  | { readonly kind: "nullable"; readonly wrapped: AnySchema }
  | {
      readonly kind: "wrapped";
      readonly type: string;
      readonly wrapped: AnySchema;
    }
  | {
      readonly kind: "scalar";
      readonly type: string;
      readonly options: ScalarOptionsView;
      readonly values: readonly unknown[];
      readonly value: unknown;
      readonly dimensions: number | undefined;
    }
  | { readonly kind: "refused" }
  | { readonly kind: "opaque"; readonly type: string };

export const SCALAR_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "bigint",
  "decimal",
  "enum",
  "literal",
  "json",
  "date",
  "iso_timestamp",
  "iso_date",
  "iso_time",
  "blob",
  "vector",
  "point",
]);

const WRAPPER_TYPES: ReadonlySet<string> = new Set([
  "transform",
  "comparison_operand",
  "field_ref_or",
  "no_field_ref",
  "json_null_or",
  "json_write",
]);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isSchema = (value: unknown): value is AnySchema =>
  isRecord(value) && "~standard" in value;

const readType = (schema: AnySchema): string => {
  const type = Reflect.get(schema, "type");
  return typeof type === "string" ? type : "";
};

/**
 * Follow thunks and `lazyRef`s to the schema they stand for. Returns
 * `undefined` for an entry that never settles on a schema.
 */
export function resolveSchema(entry: unknown): AnySchema | undefined {
  let current = entry;
  for (let hop = 0; hop < 16; hop++) {
    if (typeof current === "function") {
      current = (current as () => unknown)();
      continue;
    }
    if (!isSchema(current)) return undefined;
    if (readType(current) === "lazyRef") {
      current = Reflect.get(current, "wrapped");
      continue;
    }
    return current;
  }
  return undefined;
}

const stringList = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.filter((key): key is string => typeof key === "string")
    : [];

const stringGroups = (value: unknown): readonly (readonly string[])[] =>
  Array.isArray(value) ? value.map(stringList) : [];

const keySetGroups = (
  value: unknown
): readonly (readonly (readonly string[])[])[] =>
  Array.isArray(value) ? value.map(stringGroups) : [];

const objectOptions = (raw: unknown): ObjectOptionsView => {
  const options = isRecord(raw) ? raw : {};
  return {
    partial: options.partial !== false,
    omit: new Set(stringList(options.omit)),
    atLeast: stringList(options.atLeast),
    requiresOneOf: stringGroups(options.requiresOneOf),
    requiresOneOfKeySets: keySetGroups(options.requiresOneOfKeySets),
    nonEmpty: options.nonEmpty === true,
    optional: options.optional === true,
    nullable: options.nullable === true,
    array: options.array === true,
  };
};

const scalarOptions = (raw: unknown): ScalarOptionsView => {
  const options = isRecord(raw) ? raw : {};
  const decimal = isRecord(options.decimal) ? options.decimal : undefined;
  return {
    optional: options.optional === true,
    nullable: options.nullable === true,
    array: options.array === true,
    decimal:
      decimal &&
      typeof decimal.precision === "number" &&
      typeof decimal.scale === "number"
        ? { precision: decimal.precision, scale: decimal.scale }
        : undefined,
  };
};

const wrappedOf = (schema: AnySchema): AnySchema | undefined =>
  resolveSchema(Reflect.get(schema, "wrapped"));

export function classify(schema: AnySchema): SchemaNode {
  const type = readType(schema);
  if (type === "object") {
    const entries = Reflect.get(schema, "entries");
    if (!isRecord(entries)) return { kind: "opaque", type };
    return {
      kind: "object",
      schema,
      entries,
      options: objectOptions(Reflect.get(schema, "options")),
    };
  }
  if (type === "union") {
    const options = Reflect.get(schema, "options");
    if (!Array.isArray(options)) return { kind: "opaque", type };
    return { kind: "union", options: options.filter(isSchema) };
  }
  if (type === "array") {
    const item = resolveSchema(Reflect.get(schema, "item"));
    return item ? { kind: "array", item } : { kind: "opaque", type };
  }
  if (type === "optional" || type === "nullable") {
    const wrapped = wrappedOf(schema);
    return wrapped ? { kind: type, wrapped } : { kind: "opaque", type };
  }
  if (type === "refused") return { kind: "refused" };
  if (WRAPPER_TYPES.has(type)) {
    const wrapped = wrappedOf(schema);
    return wrapped
      ? { kind: "wrapped", type, wrapped }
      : { kind: "opaque", type };
  }
  if (SCALAR_TYPES.has(type)) {
    const values = Reflect.get(schema, "values");
    const dimensions = Reflect.get(schema, "dimensions");
    return {
      kind: "scalar",
      type,
      options: scalarOptions(Reflect.get(schema, "options")),
      values: Array.isArray(values) ? values : [],
      value: Reflect.get(schema, "value"),
      dimensions: typeof dimensions === "number" ? dimensions : undefined,
    };
  }
  return { kind: "opaque", type };
}

/** Whether an absent key satisfies this entry (optional, or carries a default). */
export const acceptsUndefined = (schema: AnySchema): boolean =>
  Reflect.get(schema, "acceptsUndefined") === true;

/**
 * Whether a value can be produced for this schema at all. Cycle-safe: a schema
 * met again on the same walk is assumed generatable (the cycle is through an
 * object, which is generatable by itself).
 */
export function canGenerate(
  schema: AnySchema,
  seen: Set<AnySchema> = new Set()
): boolean {
  if (seen.has(schema)) return true;
  seen.add(schema);
  const node = classify(schema);
  switch (node.kind) {
    case "scalar":
    case "object":
      return true;
    case "union":
      return node.options.some((option) => canGenerate(option, seen));
    case "array":
      return canGenerate(node.item, seen);
    case "optional":
    case "nullable":
    case "wrapped":
      return canGenerate(node.wrapped, seen);
    default:
      return false;
  }
}

/**
 * Whether this schema can be satisfied WITHOUT nesting another object — the
 * alternative the generator prefers once it reaches its depth budget.
 */
export function isLeafy(
  schema: AnySchema,
  seen: Set<AnySchema> = new Set()
): boolean {
  if (seen.has(schema)) return false;
  seen.add(schema);
  const node = classify(schema);
  switch (node.kind) {
    case "scalar":
      return true;
    case "union":
      return node.options.some((option) => isLeafy(option, seen));
    case "array":
      return isLeafy(node.item, seen);
    case "optional":
    case "nullable":
    case "wrapped":
      return isLeafy(node.wrapped, seen);
    default:
      return false;
  }
}

/**
 * The entry keys reachable from a schema without crossing an array: the keys
 * of the object it is, or of every object a union/wrapper leads to. This is
 * how a relation entry is recognised structurally (it offers verbs or relation
 * filters) and how its cardinality is read back (to-many bags offer
 * `createMany`/`set`, to-many filters offer `some`/`every`/`none`).
 */
export function collectEntryKeys(
  schema: AnySchema,
  seen: Set<AnySchema> = new Set(),
  out: Set<string> = new Set()
): ReadonlySet<string> {
  if (seen.has(schema)) return out;
  seen.add(schema);
  const node = classify(schema);
  switch (node.kind) {
    case "object":
      for (const key of Object.keys(node.entries)) {
        if (!node.options.omit.has(key)) out.add(key);
      }
      break;
    case "union":
      for (const option of node.options) collectEntryKeys(option, seen, out);
      break;
    case "optional":
    case "nullable":
    case "wrapped":
      collectEntryKeys(node.wrapped, seen, out);
      break;
    default:
      break;
  }
  return out;
}

/** Number of generatable entries of an object schema (0 for a non-object). */
export function usableEntryCount(schema: AnySchema): number {
  const node = classify(schema);
  if (node.kind !== "object") return 0;
  let count = 0;
  for (const key of Object.keys(node.entries)) {
    if (node.options.omit.has(key)) continue;
    const entry = resolveSchema(node.entries[key]);
    if (entry && canGenerate(entry)) count++;
  }
  return count;
}

/** Run a schema's own validator and report whether it refused the value. */
export function refuses(schema: AnySchema, value: unknown): boolean {
  const result = schema["~standard"].validate(value);
  return isRecord(result) && result.issues !== undefined;
}
