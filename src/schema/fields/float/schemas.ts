import v, {
  type BaseNumberSchema,
  type InferInput,
  type InferOutput,
} from "@validation";
import type { V } from "@validation/V";
import {
  type FieldState,
  shorthandArray,
  shorthandFilter,
  shorthandUpdate,
} from "../common";

// =============================================================================
// BASE TYPES
// =============================================================================

export const floatBase = v.number();
export const floatNullable = v.number({ nullable: true });
export const floatList = v.number({ array: true });
export const floatListNullable = v.number({ array: true, nullable: true });

// =============================================================================
// FILTER TYPES
// =============================================================================

type FloatFilterBase<S extends V.Schema> = {
  equals: S;
  in: V.Number<{ array: true }>;
  notIn: V.Number<{ array: true }>;
  lt: V.Number;
  lte: V.Number;
  gt: V.Number;
  gte: V.Number;
};

export type FloatFilterSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandFilter<S>,
    V.Object<
      FloatFilterBase<S> & {
        not: V.Union<
          readonly [V.ShorthandFilter<S>, V.Object<FloatFilterBase<S>>]
        >;
      }
    >,
  ]
>;

type FloatListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.Number;
  hasEvery: V.Number<{ array: true }>;
  hasSome: V.Number<{ array: true }>;
  isEmpty: V.Boolean;
};

export type FloatListFilterSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandFilter<S>,
    V.Object<
      FloatListFilterBase<S> & {
        not: V.Union<
          readonly [V.ShorthandFilter<S>, V.Object<FloatListFilterBase<S>>]
        >;
      }
    >,
  ]
>;

// =============================================================================
// UPDATE TYPES
// =============================================================================

export type FloatUpdateSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandUpdate<S>,
    V.Object<{
      set: S;
      increment: V.Number;
      decrement: V.Number;
      multiply: V.Number;
      divide: V.Number;
    }>,
  ]
>;

export type FloatListUpdateSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandUpdate<S>,
    V.Object<{
      set: S;
      push: V.Union<
        readonly [V.ShorthandArray<V.Number>, V.Number<{ array: true }>]
      >;
      unshift: V.Union<
        readonly [V.ShorthandArray<V.Number>, V.Number<{ array: true }>]
      >;
    }>,
  ]
>;

// =============================================================================
// SCHEMA BUILDERS
// =============================================================================

const floatFilterBase = v.object({
  in: floatList,
  notIn: floatList,
  lt: floatBase,
  lte: floatBase,
  gt: floatBase,
  gte: floatBase,
});

export const buildFloatFilterSchema = <S extends V.Schema>(
  schema: S
): FloatFilterSchema<S> => {
  const filter = floatFilterBase.extend({
    equals: schema,
  });
  return v.union([
    shorthandFilter(schema),
    filter.extend({
      not: v.union([shorthandFilter(schema), filter]),
    }),
  ]);
};

const floatListFilterBase = v.object({
  has: floatBase,
  hasEvery: floatList,
  hasSome: floatList,
  isEmpty: v.boolean(),
});

export const buildFloatListFilterSchema = <S extends V.Schema>(
  schema: S
): FloatListFilterSchema<S> => {
  const filter = floatListFilterBase.extend({
    equals: schema,
  });
  return v.union([
    shorthandFilter(schema),
    filter.extend({ not: v.union([shorthandFilter(schema), filter]) }),
  ]);
};

export const buildFloatUpdateSchema = <S extends V.Schema>(
  schema: S
): FloatUpdateSchema<S> =>
  v.union([
    shorthandUpdate(schema),
    v.object({
      set: schema,
      increment: floatBase,
      decrement: floatBase,
      multiply: floatBase,
      divide: floatBase,
    }),
  ]);

export const buildFloatListUpdateSchema = <S extends V.Schema>(
  schema: S
): FloatListUpdateSchema<S> =>
  v.union([
    shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([shorthandArray(floatBase), floatList]),
      unshift: v.union([shorthandArray(floatBase), floatList]),
    }),
  ]);

// =============================================================================
// FLOAT SCHEMA BUILDER
// =============================================================================

export interface FloatSchemas<F extends FieldState<"float">> {
  base: F["base"];
  create: BaseNumberSchema<F>;
  update: F["array"] extends true
    ? FloatListUpdateSchema<F["base"]>
    : FloatUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? FloatListFilterSchema<F["base"]>
    : FloatFilterSchema<F["base"]>;
}

export const buildFloatSchema = <F extends FieldState<"float">>(
  state: F
): FloatSchemas<F> => {
  return {
    base: state.base as F["base"],
    create: v.number(state),
    update: state.array
      ? buildFloatListUpdateSchema(state.base)
      : buildFloatUpdateSchema(state.base),
    filter: state.array
      ? buildFloatListFilterSchema(state.base)
      : buildFloatFilterSchema(state.base),
  } as FloatSchemas<F>;
};

export type InferFloatInput<
  F extends FieldState<"float">,
  Type extends keyof FloatSchemas<F>,
> = InferInput<FloatSchemas<F>[Type]>;

export type InferFloatOutput<
  F extends FieldState<"float">,
  Type extends keyof FloatSchemas<F>,
> = InferOutput<FloatSchemas<F>[Type]>;
