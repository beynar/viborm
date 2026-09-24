import type { ScalarState } from "@schema/scalars/common";
import type { EnumSchema, EnumValues } from "@validation/primitives/enum";
import { lazyScalarSchemas } from "../lazy";
import v, { type V } from "../primitives/v";
import {
  buildSetUpdate,
  type ListFilterSchema,
  type ListUpdateSchema,
  listFilterFamily,
  listUpdateFamily,
  type SetUpdateSchema,
} from "./family";
import {
  buildNegatableFilterSchema,
  type NegatableFilterSchema,
} from "./negatable-filter";

// =============================================================================
// FILTER TYPES
// =============================================================================

/**
 * Equality operand: a literal, a field reference to another enum column, an SQL
 * fragment, or a callback returning one of the latter two.
 */
type EnumOperand<
  S extends V.Schema,
  C extends V.Operand<any>,
> = V.ComparisonOperand<"enum", S, C>;

type EnumFilterBase<
  S extends V.Schema,
  Values extends string[],
  C extends V.Operand<any>,
> = {
  equals: EnumOperand<S, C>;
  in: V.Enum<Values, { array: true }>;
  notIn: V.Enum<Values, { array: true }>;
  lt: V.Schema<never, never>;
  lte: V.Schema<never, never>;
  gt: V.Schema<never, never>;
  gte: V.Schema<never, never>;
};

type EnumFilterSchema<
  S extends V.Schema,
  Values extends string[],
  C extends V.Operand<any>,
> = NegatableFilterSchema<EnumOperand<S, C>, EnumFilterBase<S, Values, C>>;

/**
 * The list arms are the shared family, built PER FIELD: an enum's member and
 * list schemas are a function of that field's declared values, so unlike every
 * other kind there is no module-level pair to close over — and, for the same
 * reason, no interning (a key would have to carry the whole value list).
 */
type EnumListFilterSchema<
  S extends V.Schema,
  Values extends string[],
> = ListFilterSchema<S, V.Enum<Values>, V.Enum<Values, { array: true }>>;

type EnumListUpdateSchema<
  S extends V.Schema,
  Values extends string[],
> = ListUpdateSchema<S, V.Enum<Values>, V.Enum<Values, { array: true }>>;

// =============================================================================
// SCHEMA BUILDERS
// =============================================================================

/**
 * Ordered comparison on an enum has no portable answer, so it is refused —
 * loudly, rather than by being quietly absent.
 *
 * PostgreSQL stores an enum as its own type and orders it by DECLARATION
 * order; MySQL's `ENUM` compares as text once either side is coerced, and
 * SQLite stores plain text. `role > 'moderator'` would therefore select
 * different rows per provider, which is exactly the silent divergence a
 * portable ORM must not ship. `equals`/`not`/`in`/`notIn` are unaffected:
 * equality agrees everywhere.
 */
const orderedEnumRefusal = (operator: string) =>
  v.refused(
    `Filter operation '${operator}' is not supported on an enum field: PostgreSQL orders enum values by their declaration order while MySQL and SQLite compare them as text, so the same query would answer differently per provider. Use 'equals'/'in', or model the field as a string or int if you need ordering.`
  );

const enumBase = <Values extends string[]>(values: Values) => v.enum(values);

const enumList = <Values extends string[]>(values: Values) =>
  v.enum(values, { array: true });

const buildEnumFilterSchema = <
  S extends V.Schema,
  Values extends string[],
  C extends V.Operand<any>,
>(
  schema: S,
  values: Values
): EnumFilterSchema<S, Values, C> => {
  const list = enumList(values);
  const operand = v.comparisonOperand("enum", schema);
  const filter = v.object({
    equals: operand,
    in: list,
    notIn: list,
    lt: orderedEnumRefusal("lt"),
    lte: orderedEnumRefusal("lte"),
    gt: orderedEnumRefusal("gt"),
    gte: orderedEnumRefusal("gte"),
  });
  return buildNegatableFilterSchema<
    EnumOperand<S, C>,
    EnumFilterBase<S, Values, C>
  >(filter, operand);
};

const buildEnumListFilterSchema = <S extends V.Schema, Values extends string[]>(
  schema: S,
  values: Values
): EnumListFilterSchema<S, Values> =>
  listFilterFamily(enumBase(values), enumList(values))(schema);

const buildEnumListUpdateSchema = <S extends V.Schema, Values extends string[]>(
  schema: S,
  values: Values
): EnumListUpdateSchema<S, Values> =>
  listUpdateFamily(enumBase(values), enumList(values))(schema);

// =============================================================================
// ENUM SCHEMA BUILDER
// =============================================================================

export interface EnumSchemas<
  Values extends string[],
  F extends ScalarState<"enum">,
  C extends V.Operand<any> = V.Operand<any>,
> {
  base: F["base"];
  create: V.Enum<Values, F>;
  update: F["array"] extends true
    ? EnumListUpdateSchema<F["base"], Values>
    : SetUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? EnumListFilterSchema<F["base"], Values>
    : EnumFilterSchema<F["base"], Values, C>;
}

export const buildEnumSchema = <
  F extends ScalarState<"enum">,
  C extends V.Operand<any> = V.Operand<any>,
>(
  state: F
): EnumSchemas<EnumValues<F["base"]>, F, C> => {
  const values = (state.base as EnumSchema<EnumValues<F["base"]>>).values;
  return lazyScalarSchemas<EnumSchemas<EnumValues<F["base"]>, F, C>>({
    base: state.base,
    create: () => v.enum(values, state),
    update: () =>
      (state.array
        ? buildEnumListUpdateSchema(state.base, values)
        : buildSetUpdate(state.base)) as never,
    filter: () =>
      (state.array
        ? buildEnumListFilterSchema(state.base, values)
        : buildEnumFilterSchema(state.base, values)) as never,
  });
};
