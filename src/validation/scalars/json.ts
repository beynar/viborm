import { type JsonNullKind, jsonNullKindOf } from "@schema/json-null";
import type { ScalarState } from "@schema/scalars/common";
import { lazyScalarSchemas } from "../lazy";
import { createSchema, fail, ok } from "../primitives/helpers";
import v, { type V } from "../primitives/v";
import type { VibSchema } from "../types";
import { requireFilterOperation } from "./negatable-filter";

// =============================================================================
// FILTER TYPES
// =============================================================================

/**
 * lt/lte/gt/gte take a number OR a string operand; the operand's class picks
 * numeric vs lexicographic comparison at the path (see json-filter-builder).
 */
type JsonComparisonOperand = V.Union<readonly [V.Number, V.String]>;

/**
 * Prisma spells a JSON path two ways: the portable array form and
 * Prisma-MySQL's '$.a.b' string form. ADMISSION parses the string form into
 * the array form, so a prepared filter carries segments and nothing else —
 * the one place the two spellings become one fact.
 */
type JsonPathOperand = VibSchema<readonly string[] | string, string[]>;

/**
 * A whole-document JSON operand, re-closed to field references.
 *
 * JSON is the only surface in the schema layer that accepts an ARBITRARY
 * object, so it is the only one where a field-reference token type-checks as a
 * legal value: `{ [FIELD_REF_BRAND]: true, model, field, type, list }` is a
 * perfectly ordinary JSON document as far as `v.json` is concerned. Left
 * unguarded, `where: { data: { equals: <a field reference> } }` bound the ORM's
 * internal token as a parameter and quietly matched nothing, and
 * `create({ data: { data: ref } })` PERSISTED it as user data.
 *
 * References are not opened here for a reason, so the wrapper is a closure and
 * not a gap: an operand of `equals`/`array_*` is compared as a whole JSON
 * VALUE (`@>`, `#>`, `JSON_CONTAINS`), not as a column expression, so there is
 * nothing for a column reference to mean. Failing closed is the doctrine;
 * silently binding an ORM-internal object is the opposite of it.
 */
type JsonOperand<S extends V.Schema> = V.NoFieldRef<S>;

/**
 * Every JSON null sentinel is legal in a filter operand: `equals: DbNull`
 * asks for the SQL NULL, `equals: JsonNull` for the JSON null document, and
 * `equals: AnyNull` for either. `not` takes the same three, spelled on the
 * `not` key itself (`not: DbNull`) exactly as Prisma spells it.
 */
type JsonFilterNullOperand<S extends V.Schema> = V.JsonNullOr<
  JsonNullKind,
  JsonOperand<S>
>;

type JsonFilterBase<S extends V.Schema> = {
  equals: JsonFilterNullOperand<S>;
  path: JsonPathOperand;
  mode: V.Enum<["default", "insensitive"]>;
  lt: JsonComparisonOperand;
  lte: JsonComparisonOperand;
  gt: JsonComparisonOperand;
  gte: JsonComparisonOperand;
  string_contains: V.String;
  string_starts_with: V.String;
  string_ends_with: V.String;
  array_contains: JsonOperand<S>;
  array_starts_with: JsonOperand<S>;
  array_ends_with: JsonOperand<S>;
};

/** Where a refused reference is reported from, in the filter and write paths. */
const JSON_FILTER_SITE = "a JSON filter operand";
const JSON_DATA_SITE = "JSON write data";

/** Every sentinel is a legal filter question. */
const FILTER_SENTINELS: readonly JsonNullKind[] = [
  "DbNull",
  "JsonNull",
  "AnyNull",
];

/**
 * `AnyNull` is FILTER-ONLY, as in Prisma: "either null" is a question, not a
 * value, so a write has nothing to store for it. `DbNull` additionally needs a
 * column that can hold the SQL NULL, so a non-nullable JSON field accepts only
 * `JsonNull` — the refusal names the reason instead of deferring to a NOT NULL
 * constraint violation from the database.
 */
const NULLABLE_WRITE_SENTINELS: readonly JsonNullKind[] = [
  "DbNull",
  "JsonNull",
];
const NON_NULLABLE_WRITE_SENTINELS: readonly JsonNullKind[] = ["JsonNull"];

type JsonWriteSentinels<F extends ScalarState<"json">> =
  F["nullable"] extends true ? "DbNull" | "JsonNull" : "JsonNull";

type JsonFilterSchema<S extends V.Schema> = V.Object<
  JsonFilterBase<S> & {
    not: V.JsonNullOr<JsonNullKind, V.Object<JsonFilterBase<S>>>;
  }
>;

// =============================================================================
// UPDATE TYPES
// =============================================================================

type JsonWriteOperand<
  F extends ScalarState<"json">,
  S extends V.Schema,
> = V.JsonWrite<JsonWriteSentinels<F>, V.NoFieldRef<S>>;

type JsonUpdateSchema<
  F extends ScalarState<"json">,
  S extends V.Schema,
> = V.Coerce<
  JsonWriteOperand<F, S>,
  { set: JsonWriteOperand<F, S>[" vibInferred"]["1"] }
>;

// =============================================================================
// JSON PATH GRAMMAR (admission owns both spellings)
// =============================================================================

const JSON_PATH_ARRAY_INDEX = /^\d+$/;

const JSON_PATH_GRAMMAR =
  "The supported grammar is '$', '$.key', '$.key[0]' and nothing else; use the array form (path: ['a', 'b']) for keys containing '.', '[' or ']'.";

const unsupportedPathString = (raw: string, reason: string): string =>
  `JSON filter has an unsupported path string '${raw}': ${reason}. ${JSON_PATH_GRAMMAR}`;

/**
 * Parse Prisma-MySQL's string path form ('$.a.b', '$.arr[0]') into the array
 * form the preparer, the adapters and every dialect already speak.
 *
 * The grammar is DELIBERATELY small: '$' root, '.key' object steps, '[N]'
 * array indices. Quoted labels ('$."a b"'), wildcards ('$.*', '[*]'),
 * '[last]' and negative indices are REFUSED rather than half-supported —
 * SQLite's path grammar has no escape syntax inside quoted labels, so a
 * larger grammar could not stay portable. A '.' inside a key is a separator
 * here and can only be spelled with the array form (path: ['weird.key']).
 * A segment carrying '"' or '\\' falls through to the portability rule
 * below, which refuses it exactly as it does for the array form.
 */
const parseJsonStringPath = (raw: string): string[] | string => {
  if (!raw.startsWith("$")) {
    return unsupportedPathString(raw, "a path string must start with '$'");
  }
  const segments: string[] = [];
  let index = 1;
  while (index < raw.length) {
    const char = raw[index];
    if (char === ".") {
      index += 1;
      const start = index;
      while (index < raw.length && raw[index] !== "." && raw[index] !== "[") {
        index += 1;
      }
      const key = raw.slice(start, index);
      if (key.length === 0) {
        return unsupportedPathString(raw, "an object key may not be empty");
      }
      if (key.includes("*")) {
        // '$.*' means "any member" in MySQL's JSONPath. Reading it as a key
        // literally named '*' would silently answer a different question,
        // so refuse it; a real '*' key is addressable via the array form.
        return unsupportedPathString(raw, "wildcards are not supported");
      }
      segments.push(key);
      continue;
    }
    if (char === "[") {
      const close = raw.indexOf("]", index);
      if (close === -1) {
        return unsupportedPathString(raw, "an unclosed '['");
      }
      const digits = raw.slice(index + 1, close);
      if (!JSON_PATH_ARRAY_INDEX.test(digits)) {
        return unsupportedPathString(
          raw,
          `'[${digits}]' is not a non-negative integer array index`
        );
      }
      segments.push(digits);
      index = close + 1;
      continue;
    }
    return unsupportedPathString(raw, `unexpected '${char}'`);
  }
  return segments;
};

/**
 * ONE portability rule for BOTH spellings, asked on every dialect.
 *
 * A segment carrying '"' or '\\' cannot be addressed portably: SQLite's
 * `json_extract` path grammar has no escape syntax inside a quoted label, so
 * the key is unaddressable there and binding it silently on PostgreSQL and
 * MySQL would make one question answer three ways. The SQLite adapter's own
 * throw stays what it says it is — a defensive backstop.
 */
const portablePathRefusal = (
  segments: readonly string[]
): string | undefined =>
  segments.some((segment) => segment.includes('"') || segment.includes("\\"))
    ? "JSON filter requires a portable JSON path; segments containing '\"' or '\\' are not supported."
    : undefined;

const jsonPathSegments = v.array(v.string());
const jsonPathString = v.string();

const buildJsonPathSchema = (): JsonPathOperand => {
  const schema = createSchema<readonly string[] | string, string[]>(
    "union",
    (value) => {
      if (Array.isArray(value)) {
        const segments = value.map(String);
        const refusal = portablePathRefusal(segments);
        return refusal ? fail(refusal) : ok(segments);
      }
      if (typeof value !== "string") {
        return fail("Expected string or array of strings");
      }
      const parsed = parseJsonStringPath(value);
      if (typeof parsed === "string") return fail(parsed);
      const refusal = portablePathRefusal(parsed);
      return refusal ? fail(refusal) : ok(parsed);
    }
  );
  // `type`/`options` mirror `v.union` so introspection (JSON Schema
  // conversion) sees the two spellings it expects.
  (schema as { options?: unknown }).options = [
    jsonPathSegments,
    jsonPathString,
  ];
  return schema;
};

/**
 * The operators `mode: "insensitive"` governs. `equals`/`not`/`array_*`
 * compare whole JSON values, not text, so folding them would be meaningless
 * — which is why an inert `mode` is refused rather than ignored.
 */
const MODE_GOVERNED_OPERATORS = [
  "string_contains",
  "string_starts_with",
  "string_ends_with",
] as const;

const INERT_MODE_REFUSAL =
  "JSON filter sets mode: 'insensitive' but has no string_contains/string_starts_with/string_ends_with operation for it to apply to.";

/**
 * Fail closed on an inert `mode: "insensitive"`. A mode declared on THIS
 * object must govern a string operator here, or a nested `not` that inherits
 * it; otherwise the engine would accept the key and silently do nothing.
 * Inherited modes are exempt — `{ mode, string_contains, not: { equals } }`
 * is legitimate, and only the arm that spelled `mode` has to justify it.
 *
 * A SENTINEL `not` (`not: DbNull`) is not an exemption: it inherits nothing
 * and case-folds nothing, so a mode declared beside it governs exactly
 * nothing and has to be refused like any other inert one.
 */
const inertModeRefusal = (
  value: Record<string, unknown>
): string | undefined => {
  if (value.mode !== "insensitive") return undefined;
  if (value.not !== undefined && jsonNullKindOf(value.not) === undefined) {
    return undefined;
  }
  return MODE_GOVERNED_OPERATORS.some(
    (operator) => value[operator] !== undefined
  )
    ? undefined
    : INERT_MODE_REFUSAL;
};

// =============================================================================
// SCHEMA BUILDERS
// =============================================================================

const buildJsonFilterSchema = <S extends V.Schema>(
  schema: S
): JsonFilterSchema<S> => {
  const comparisonOperand = v.union([v.number(), v.string()]);
  const operand = v.noFieldRef(schema, JSON_FILTER_SITE);
  const nullOperand = v.jsonNullOr(FILTER_SENTINELS, operand, JSON_FILTER_SITE);
  const entries = {
    equals: nullOperand,
    path: buildJsonPathSchema(),
    mode: v.enum(["default", "insensitive"]),
    lt: comparisonOperand,
    lte: comparisonOperand,
    gt: comparisonOperand,
    gte: comparisonOperand,
    string_contains: v.string(),
    string_starts_with: v.string(),
    string_ends_with: v.string(),
    array_contains: operand,
    array_starts_with: operand,
    array_ends_with: operand,
  };
  // `path` and `mode` SCOPE the filter; the refusal below is what makes
  // `{ path: ['status'] }` fail closed instead of comparing the whole
  // document, and what makes a declared `mode` justify itself.
  const refuse = (value: Record<string, unknown>): string | undefined =>
    requireFilterOperation(value) ?? inertModeRefusal(value);
  const filter = v.object(entries, { refuse });
  return v.object(
    {
      ...entries,
      // `not: DbNull` / `not: JsonNull` / `not: AnyNull` are the sentinel
      // spellings Prisma uses; the nested filter object stays available for
      // everything else (`not: { equals: … }`).
      not: v.jsonNullOr(FILTER_SENTINELS, filter, JSON_FILTER_SITE),
    },
    { refuse }
  ) as unknown as JsonFilterSchema<S>;
};

/**
 * The refusal a bare top-level `null` gets in write position, spelled per
 * field so it can only recommend sentinels the field can actually store.
 */
const nullWriteRefusal = (nullable: boolean): string =>
  nullable
    ? "null is ambiguous in JSON write data: it could mean the database NULL or the JSON value null. Use DbNull for the database NULL, or JsonNull for the JSON value null."
    : "null is ambiguous in JSON write data: it could mean the database NULL or the JSON value null. This field is not nullable, so use JsonNull to write the JSON value null.";

const buildJsonWriteOperand = <
  F extends ScalarState<"json">,
  S extends V.Schema,
>(
  state: F,
  schema: S
): JsonWriteOperand<F, S> =>
  v.jsonWrite(
    state.nullable ? NULLABLE_WRITE_SENTINELS : NON_NULLABLE_WRITE_SENTINELS,
    // `create`/`update` are closed to field references for the same reason the
    // filter operands are, with a worse failure mode: an unguarded token is not
    // merely bound and ignored, it is WRITTEN — the ORM's own
    // `{ model, field, type, list }` record lands in the user's JSON column as
    // if it were their data.
    v.noFieldRef(schema, JSON_DATA_SITE),
    JSON_DATA_SITE,
    nullWriteRefusal(state.nullable)
  ) as JsonWriteOperand<F, S>;

const buildJsonUpdateSchema = <
  F extends ScalarState<"json">,
  S extends V.Schema,
>(
  state: F,
  schema: S
): JsonUpdateSchema<F, S> =>
  v.coerce(buildJsonWriteOperand(state, schema), (value) => {
    return {
      set: value,
    };
  });

// =============================================================================
// JSON SCHEMA BUILDER
// =============================================================================

export interface JsonSchemas<F extends ScalarState<"json">> {
  base: F["base"];
  create: JsonWriteOperand<F, V.Json<F>>;
  update: JsonUpdateSchema<F, F["base"]>;
  filter: JsonFilterSchema<F["base"]>;
}

export const buildJsonSchema = <F extends ScalarState<"json">>(
  state: F
): JsonSchemas<F> => {
  return lazyScalarSchemas<JsonSchemas<F>>({
    base: state.base,
    create: () => buildJsonWriteOperand(state, v.json(state)),
    update: () => buildJsonUpdateSchema<F, F["base"]>(state, state.base),
    filter: () => buildJsonFilterSchema<F["base"]>(state.base),
  });
};
