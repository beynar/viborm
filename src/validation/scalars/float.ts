import type { ScalarState } from "@schema/scalars/common";
import v, { type V } from "../primitives/v";
import { createScalarInterner, scalarInternKey } from "./intern";
import {
  buildNegatableFilterSchema,
  type NegatableFilterSchema,
} from "./negatable-filter";

// =============================================================================
// BASE TYPES
// =============================================================================

const floatBase = v.number();
const floatList = v.number({ array: true });

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

type FloatFilterSchema<S extends V.Schema> = NegatableFilterSchema<
  S,
  FloatFilterBase<S>
>;

type FloatListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.Number;
  hasEvery: V.Number<{ array: true }>;
  hasSome: V.Number<{ array: true }>;
  isEmpty: V.Boolean;
};

type FloatListFilterSchema<S extends V.Schema> = NegatableFilterSchema<
  S,
  FloatListFilterBase<S>
>;

// =============================================================================
// UPDATE TYPES
// =============================================================================

type FloatUpdateSchema<S extends V.Schema> = V.Union<
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

type FloatListUpdateSchema<S extends V.Schema> = V.Union<
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

const buildFloatFilterSchema = <S extends V.Schema>(
  schema: S
): FloatFilterSchema<S> => {
  const filter = floatFilterBase.extend({
    equals: schema,
  });
  return buildNegatableFilterSchema<S, FloatFilterBase<S>>(filter, schema);
};

const floatListFilterBase = v.object({
  has: floatBase,
  hasEvery: floatList,
  hasSome: floatList,
  isEmpty: v.boolean(),
});

const buildFloatListFilterSchema = <S extends V.Schema>(
  schema: S
): FloatListFilterSchema<S> => {
  const filter = floatListFilterBase.extend({
    equals: schema,
  });
  return buildNegatableFilterSchema<S, FloatListFilterBase<S>>(filter, schema);
};

const buildFloatUpdateSchema = <S extends V.Schema>(
  schema: S
): FloatUpdateSchema<S> =>
  v.union([
    v.shorthandUpdate(schema),
    v.object({
      set: schema,
      increment: floatBase,
      decrement: floatBase,
      multiply: floatBase,
      divide: floatBase,
    }),
  ]);

const buildFloatListUpdateSchema = <S extends V.Schema>(
  schema: S
): FloatListUpdateSchema<S> =>
  v.union([
    v.shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([v.shorthandArray(floatBase), floatList]),
      unshift: v.union([v.shorthandArray(floatBase), floatList]),
    }),
  ]);

// =============================================================================
// FLOAT SCHEMA BUILDER
// =============================================================================

export interface FloatSchemas<F extends ScalarState<"float">> {
  base: F["base"];
  create: V.Number<F>;
  update: F["array"] extends true
    ? FloatListUpdateSchema<F["base"]>
    : FloatUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? FloatListFilterSchema<F["base"]>
    : FloatFilterSchema<F["base"]>;
}

const internFilter = createScalarInterner<unknown>();
const internUpdate = createScalarInterner<unknown>();

export const buildFloatSchema = <F extends ScalarState<"float">>(
  state: F
): FloatSchemas<F> => {
  const key = scalarInternKey(state);
  return {
    base: state.base as F["base"],
    create: v.number(state),
    update: internUpdate(key, () =>
      state.array
        ? buildFloatListUpdateSchema(state.base)
        : buildFloatUpdateSchema(state.base)
    ) as never,
    filter: internFilter(key, () =>
      state.array
        ? buildFloatListFilterSchema(state.base)
        : buildFloatFilterSchema(state.base)
    ) as never,
  } as FloatSchemas<F>;
};
