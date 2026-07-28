import type { JsonNullKind } from "@schema/json-null";
import type { ScalarState } from "@schema/scalars/common";
import v, { type V } from "../primitives/v";

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
 * Prisma-MySQL's '$.a.b' string form. The builder parses the string form
 * into the array form (see parseJsonStringPath).
 */
type JsonPathOperand = V.Union<readonly [V.Array<V.String>, V.String]>;

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
// SCHEMA BUILDERS
// =============================================================================

const buildJsonFilterSchema = <S extends V.Schema>(
  schema: S
): JsonFilterSchema<S> => {
  const comparisonOperand = v.union([v.number(), v.string()]);
  const operand = v.noFieldRef(schema, JSON_FILTER_SITE);
  const nullOperand = v.jsonNullOr(FILTER_SENTINELS, operand, JSON_FILTER_SITE);
  const filter = v.object({
    equals: nullOperand,
    path: v.union([v.array(v.string()), v.string()]),
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
  });
  return filter.extend({
    // `not: DbNull` / `not: JsonNull` / `not: AnyNull` are the sentinel
    // spellings Prisma uses; the nested filter object stays available for
    // everything else (`not: { equals: … }`).
    not: v.jsonNullOr(FILTER_SENTINELS, filter, JSON_FILTER_SITE),
  });
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
  return {
    base: state.base as F["base"],
    create: buildJsonWriteOperand(state, v.json(state)),
    update: buildJsonUpdateSchema(state, state.base),
    filter: buildJsonFilterSchema(state.base),
  } as JsonSchemas<F>;
};
