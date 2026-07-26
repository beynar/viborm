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
 * unguarded, `where: { data: { equals: $fields.thing.other } }` bound the ORM's
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

type JsonFilterBase<S extends V.Schema> = {
  equals: JsonOperand<S>;
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

type JsonFilterSchema<S extends V.Schema> = V.Object<
  JsonFilterBase<S> & {
    not: V.Object<JsonFilterBase<S>>;
  }
>;

// =============================================================================
// UPDATE TYPES
// =============================================================================

type JsonUpdateSchema<S extends V.Schema> = V.NoFieldRef<
  V.Coerce<S, { set: S[" vibInferred"]["1"] }>
>;

// =============================================================================
// SCHEMA BUILDERS
// =============================================================================

const buildJsonFilterSchema = <S extends V.Schema>(
  schema: S
): JsonFilterSchema<S> => {
  const comparisonOperand = v.union([v.number(), v.string()]);
  const operand = v.noFieldRef(schema, JSON_FILTER_SITE);
  const filter = v.object({
    equals: operand,
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
    not: filter,
  });
};

const buildJsonUpdateSchema = <S extends V.Schema>(
  schema: S
): JsonUpdateSchema<S> =>
  v.noFieldRef(
    v.coerce(schema, (value: S[" vibInferred"]["0"]) => {
      return {
        set: value,
      };
    }),
    JSON_DATA_SITE
  );

// =============================================================================
// JSON SCHEMA BUILDER
// =============================================================================

export interface JsonSchemas<F extends ScalarState<"json">> {
  base: F["base"];
  create: V.NoFieldRef<V.Json<F>>;
  update: JsonUpdateSchema<F["base"]>;
  filter: JsonFilterSchema<F["base"]>;
}

export const buildJsonSchema = <F extends ScalarState<"json">>(
  state: F
): JsonSchemas<F> => {
  return {
    base: state.base as F["base"],
    // `create`/`update` are closed for the same reason the filter operands are,
    // with a worse failure mode: an unguarded token is not merely bound and
    // ignored, it is WRITTEN — the ORM's own `{ model, field, type, list }`
    // record lands in the user's JSON column as if it were their data.
    create: v.noFieldRef(v.json(state), JSON_DATA_SITE),
    update: buildJsonUpdateSchema(state.base),
    filter: buildJsonFilterSchema(state.base),
  } as JsonSchemas<F>;
};
