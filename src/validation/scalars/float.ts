import type { ScalarState } from "@schema/scalars/common";
import { lazyScalarSchemas } from "../lazy";
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

/**
 * Comparison operand: a literal, a field reference to another float column, an
 * SQL fragment, or a callback returning one of the latter two.
 */
type FloatOperand<
  S extends V.Schema,
  C extends V.Operand<any>,
> = V.ComparisonOperand<"float", S, C>;

type FloatFilterBase<S extends V.Schema, C extends V.Operand<any>> = {
  equals: FloatOperand<S, C>;
  in: V.Number<{ array: true }>;
  notIn: V.Number<{ array: true }>;
  lt: FloatOperand<V.Number, C>;
  lte: FloatOperand<V.Number, C>;
  gt: FloatOperand<V.Number, C>;
  gte: FloatOperand<V.Number, C>;
};

type FloatFilterSchema<
  S extends V.Schema,
  C extends V.Operand<any>,
> = NegatableFilterSchema<FloatOperand<S, C>, FloatFilterBase<S, C>>;

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
  lt: v.comparisonOperand("float", floatBase),
  lte: v.comparisonOperand("float", floatBase),
  gt: v.comparisonOperand("float", floatBase),
  gte: v.comparisonOperand("float", floatBase),
});

const buildFloatFilterSchema = <S extends V.Schema, C extends V.Operand<any>>(
  schema: S
): FloatFilterSchema<S, C> => {
  const operand = v.comparisonOperand("float", schema);
  const filter = floatFilterBase.extend({
    equals: operand,
  });
  return buildNegatableFilterSchema<FloatOperand<S, C>, FloatFilterBase<S, C>>(
    filter,
    operand
  );
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

export interface FloatSchemas<
  F extends ScalarState<"float">,
  C extends V.Operand<any> = V.Operand<any>,
> {
  base: F["base"];
  create: V.Number<F>;
  update: F["array"] extends true
    ? FloatListUpdateSchema<F["base"]>
    : FloatUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? FloatListFilterSchema<F["base"]>
    : FloatFilterSchema<F["base"], C>;
}

const internFilter = createScalarInterner<unknown>();
const internUpdate = createScalarInterner<unknown>();

export const buildFloatSchema = <
  F extends ScalarState<"float">,
  C extends V.Operand<any> = V.Operand<any>,
>(
  state: F
): FloatSchemas<F, C> => {
  const key = scalarInternKey(state);
  return lazyScalarSchemas<FloatSchemas<F, C>>({
    base: state.base,
    create: () => v.number(state),
    update: () =>
      internUpdate(key, () =>
        state.array
          ? buildFloatListUpdateSchema(state.base)
          : buildFloatUpdateSchema(state.base)
      ) as never,
    filter: () =>
      internFilter(key, () =>
        state.array
          ? buildFloatListFilterSchema(state.base)
          : buildFloatFilterSchema(state.base)
      ) as never,
  });
};
