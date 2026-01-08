import v, {
  type BaseEnumSchema,
  type InferInput,
  type InferOutput,
} from "@validation";
import type { EnumValues } from "@validation/schemas/enum";
import type { V } from "@validation/V";
import {
  type FieldState,
  shorthandArray,
  shorthandFilter,
  shorthandUpdate,
} from "../common";

// =============================================================================
// FILTER TYPES
// =============================================================================

type EnumFilterBase<S extends V.Schema, Values extends string[]> = {
  equals: S;
  in: V.Enum<Values, { array: true }>;
  notIn: V.Enum<Values, { array: true }>;
};

export type EnumFilterSchema<
  S extends V.Schema,
  Values extends string[],
> = V.Union<
  readonly [
    V.ShorthandFilter<S>,
    V.Object<
      EnumFilterBase<S, Values> & {
        not: V.Union<
          readonly [V.ShorthandFilter<S>, V.Object<EnumFilterBase<S, Values>>]
        >;
      }
    >,
  ]
>;

type EnumListFilterBase<S extends V.Schema, Values extends string[]> = {
  equals: S;
  has: V.Enum<Values>;
  hasEvery: V.Enum<Values, { array: true }>;
  hasSome: V.Enum<Values, { array: true }>;
  isEmpty: V.Boolean;
};

export type EnumListFilterSchema<
  S extends V.Schema,
  Values extends string[],
> = V.Union<
  readonly [
    V.ShorthandFilter<S>,
    V.Object<
      EnumListFilterBase<S, Values> & {
        not: V.Union<
          readonly [
            V.ShorthandFilter<S>,
            V.Object<EnumListFilterBase<S, Values>>,
          ]
        >;
      }
    >,
  ]
>;

// =============================================================================
// UPDATE TYPES
// =============================================================================

export type EnumUpdateSchema<S extends V.Schema> = V.Union<
  readonly [V.ShorthandUpdate<S>, V.Object<{ set: S }, { partial: false }>]
>;

export type EnumListUpdateSchema<
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

const enumBase = <Values extends string[]>(values: Values) => v.enum(values);

const enumList = <Values extends string[]>(values: Values) =>
  v.enum(values, { array: true });

const buildEnumFilterSchema = <S extends V.Schema, Values extends string[]>(
  schema: S,
  values: Values
): EnumFilterSchema<S, Values> => {
  const list = enumList(values);
  const filter = v.object({
    equals: schema,
    in: list,
    notIn: list,
  });
  return v.union([
    shorthandFilter(schema),
    filter.extend({
      not: v.union([shorthandFilter(schema), filter]),
    }),
  ]);
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
  return v.union([
    shorthandFilter(schema),
    filter.extend({ not: v.union([shorthandFilter(schema), filter]) }),
  ]);
};

const buildEnumUpdateSchema = <S extends V.Schema>(
  schema: S
): EnumUpdateSchema<S> =>
  v.union([
    shorthandUpdate(schema),
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
    shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([shorthandArray(base), list]),
      unshift: v.union([shorthandArray(base), list]),
    }),
  ]);
};

// =============================================================================
// ENUM SCHEMA BUILDER
// =============================================================================

export interface EnumSchemas<
  Values extends string[],
  F extends FieldState<"enum">,
> {
  base: F["base"];
  create: BaseEnumSchema<Values, F>;
  update: F["array"] extends true
    ? EnumListUpdateSchema<F["base"], Values>
    : EnumUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? EnumListFilterSchema<F["base"], Values>
    : EnumFilterSchema<F["base"], Values>;
}

export const buildEnumSchema = <
  Values extends string[],
  F extends FieldState<"enum">,
>(
  values: Values,
  state: F
): EnumSchemas<Values, F> => {
  return {
    base: state.base as F["base"],
    create: v.enum(values, state),
    update: state.array
      ? buildEnumListUpdateSchema(state.base, values)
      : buildEnumUpdateSchema(state.base),
    filter: state.array
      ? buildEnumListFilterSchema(state.base, values)
      : buildEnumFilterSchema(state.base, values),
  } as EnumSchemas<Values, F>;
};

export type InferEnumInput<
  F extends FieldState<"enum">,
  Type extends keyof EnumSchemas<EnumValues<F["base"]>, F>,
> = InferInput<EnumSchemas<EnumValues<F["base"]>, F>[Type]>;

export type InferEnumOutput<
  F extends FieldState<"enum">,
  Type extends keyof EnumSchemas<EnumValues<F["base"]>, F>,
> = InferOutput<EnumSchemas<EnumValues<F["base"]>, F>[Type]>;
