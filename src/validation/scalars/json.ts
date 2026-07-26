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

type JsonFilterBase<S extends V.Schema> = {
  equals: S;
  path: JsonPathOperand;
  mode: V.Enum<["default", "insensitive"]>;
  lt: JsonComparisonOperand;
  lte: JsonComparisonOperand;
  gt: JsonComparisonOperand;
  gte: JsonComparisonOperand;
  string_contains: V.String;
  string_starts_with: V.String;
  string_ends_with: V.String;
  array_contains: S;
  array_starts_with: S;
  array_ends_with: S;
};

type JsonFilterSchema<S extends V.Schema> = V.Object<
  JsonFilterBase<S> & {
    not: V.Object<JsonFilterBase<S>>;
  }
>;

// =============================================================================
// UPDATE TYPES
// =============================================================================

type JsonUpdateSchema<S extends V.Schema> = V.Coerce<
  S,
  { set: S[" vibInferred"]["1"] }
>;

// =============================================================================
// SCHEMA BUILDERS
// =============================================================================

const buildJsonFilterSchema = <S extends V.Schema>(
  schema: S
): JsonFilterSchema<S> => {
  const comparisonOperand = v.union([v.number(), v.string()]);
  const filter = v.object({
    equals: schema,
    path: v.union([v.array(v.string()), v.string()]),
    mode: v.enum(["default", "insensitive"]),
    lt: comparisonOperand,
    lte: comparisonOperand,
    gt: comparisonOperand,
    gte: comparisonOperand,
    string_contains: v.string(),
    string_starts_with: v.string(),
    string_ends_with: v.string(),
    array_contains: schema,
    array_starts_with: schema,
    array_ends_with: schema,
  });
  return filter.extend({
    not: filter,
  });
};

const buildJsonUpdateSchema = <S extends V.Schema>(
  schema: S
): JsonUpdateSchema<S> =>
  v.coerce(schema, (value: S[" vibInferred"]["0"]) => {
    return {
      set: value,
    };
  });

// =============================================================================
// JSON SCHEMA BUILDER
// =============================================================================

export interface JsonSchemas<F extends ScalarState<"json">> {
  base: F["base"];
  create: V.Json<F>;
  update: JsonUpdateSchema<F["base"]>;
  filter: JsonFilterSchema<F["base"]>;
}

export const buildJsonSchema = <F extends ScalarState<"json">>(
  state: F
): JsonSchemas<F> => {
  return {
    base: state.base as F["base"],
    create: v.json(state),
    update: buildJsonUpdateSchema(state.base),
    filter: buildJsonFilterSchema(state.base),
  } as JsonSchemas<F>;
};
