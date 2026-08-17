import type { ScalarState } from "@schema/scalars/common";
import type { EnumSchema, EnumValues } from "@validation/primitives/enum";
import { lazyScalarSchemas } from "../lazy";
import v, { type V } from "../primitives/v";
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

type EnumListFilterBase<S extends V.Schema, Values extends string[]> = {
  equals: S;
  has: V.Enum<Values>;
  hasEvery: V.Enum<Values, { array: true }>;
  hasSome: V.Enum<Values, { array: true }>;
  isEmpty: V.Boolean;
};

type EnumListFilterSchema<
  S extends V.Schema,
  Values extends string[],
> = NegatableFilterSchema<S, EnumListFilterBase<S, Values>>;

// =============================================================================
// UPDATE TYPES
// =============================================================================

type EnumUpdateSchema<S extends V.Schema> = V.Union<
  readonly [V.ShorthandUpdate<S>, V.Object<{ set: S }, { partial: false }>]
>;

type EnumListUpdateSchema<
  S extends V.Schema,
  Values extends string[],
> = V.Union<
  readonly [
    V.ShorthandUpdate<S>,
    V.Object<{
      set: S;
      push: V.Union<
        readonly [
          V.ShorthandArray<V.Enum<Values>>,
          V.Enum<Values, { array: true }>,
        ]
      >;
      unshift: V.Union<
        readonly [
          V.ShorthandArray<V.Enum<Values>>,
          V.Enum<Values, { array: true }>,
        ]
      >;
    }>,
  ]
>;

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
): EnumListFilterSchema<S, Values> => {
  const base = enumBase(values);
  const list = enumList(values);
  const enumListFilterBase = v.object({
    has: base,
    hasEvery: list,
    hasSome: list,
    isEmpty: v.boolean(),
  });

  const filter = enumListFilterBase.extend({
    equals: schema,
  });
  return buildNegatableFilterSchema<S, EnumListFilterBase<S, Values>>(
    filter,
    schema
  );
};

const buildEnumUpdateSchema = <S extends V.Schema>(
  schema: S
): EnumUpdateSchema<S> =>
  v.union([
    v.shorthandUpdate(schema),
    v.object(
      {
        set: schema,
      },
      { partial: false }
    ),
  ]);

const buildEnumListUpdateSchema = <S extends V.Schema, Values extends string[]>(
  schema: S,
  values: Values
): EnumListUpdateSchema<S, Values> => {
  const base = enumBase(values);
  const list = enumList(values);
  return v.union([
    v.shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([v.shorthandArray(base), list]),
      unshift: v.union([v.shorthandArray(base), list]),
    }),
  ]);
};

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
    : EnumUpdateSchema<F["base"]>;
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
        : buildEnumUpdateSchema(state.base)) as never,
    filter: () =>
      (state.array
        ? buildEnumListFilterSchema(state.base, values)
        : buildEnumFilterSchema(state.base, values)) as never,
  });
};
