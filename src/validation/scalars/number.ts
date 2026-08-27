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

const numberBase = v.number();
const numberList = v.number({ array: true });

// =============================================================================
// FILTER TYPES
// =============================================================================

/**
 * Comparison operand: a literal, a field reference to another number column, an
 * SQL fragment, or a callback returning one of the latter two.
 */
type NumberOperand<
  S extends V.Schema,
  C extends V.Operand<any>,
> = V.ComparisonOperand<"number", S, C>;

type NumberFilterBase<S extends V.Schema, C extends V.Operand<any>> = {
  equals: NumberOperand<S, C>;
  in: V.Number<{ array: true }>;
  notIn: V.Number<{ array: true }>;
  lt: NumberOperand<V.Number, C>;
  lte: NumberOperand<V.Number, C>;
  gt: NumberOperand<V.Number, C>;
  gte: NumberOperand<V.Number, C>;
};

type NumberFilterSchema<
  S extends V.Schema,
  C extends V.Operand<any>,
> = NegatableFilterSchema<NumberOperand<S, C>, NumberFilterBase<S, C>>;

type NumberListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.Number;
  hasEvery: V.Number<{ array: true }>;
  hasSome: V.Number<{ array: true }>;
  isEmpty: V.Boolean;
};

type NumberListFilterSchema<S extends V.Schema> = NegatableFilterSchema<
  S,
  NumberListFilterBase<S>
>;

// =============================================================================
// UPDATE TYPES
// =============================================================================

type NumberUpdateSchema<S extends V.Schema> = V.Union<
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

type NumberListUpdateSchema<S extends V.Schema> = V.Union<
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

const numberFilterBase = v.object({
  in: numberList,
  notIn: numberList,
  lt: v.comparisonOperand("number", numberBase),
  lte: v.comparisonOperand("number", numberBase),
  gt: v.comparisonOperand("number", numberBase),
  gte: v.comparisonOperand("number", numberBase),
});

const buildNumberFilterSchema = <S extends V.Schema, C extends V.Operand<any>>(
  schema: S
): NumberFilterSchema<S, C> => {
  const operand = v.comparisonOperand("number", schema);
  const filter = numberFilterBase.extend({
    equals: operand,
  });
  return buildNegatableFilterSchema<
    NumberOperand<S, C>,
    NumberFilterBase<S, C>
  >(filter, operand);
};

const numberListFilterBase = v.object({
  has: numberBase,
  hasEvery: numberList,
  hasSome: numberList,
  isEmpty: v.boolean(),
});

const buildNumberListFilterSchema = <S extends V.Schema>(
  schema: S
): NumberListFilterSchema<S> => {
  const filter = numberListFilterBase.extend({
    equals: schema,
  });
  return buildNegatableFilterSchema<S, NumberListFilterBase<S>>(filter, schema);
};

const buildNumberUpdateSchema = <S extends V.Schema>(
  schema: S
): NumberUpdateSchema<S> =>
  v.union([
    v.shorthandUpdate(schema),
    v.object({
      set: schema,
      increment: numberBase,
      decrement: numberBase,
      multiply: numberBase,
      divide: numberBase,
    }),
  ]);

const buildNumberListUpdateSchema = <S extends V.Schema>(
  schema: S
): NumberListUpdateSchema<S> =>
  v.union([
    v.shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([v.shorthandArray(numberBase), numberList]),
      unshift: v.union([v.shorthandArray(numberBase), numberList]),
    }),
  ]);

// =============================================================================
// NUMBER SCHEMA BUILDER
// =============================================================================

export interface NumberSchemas<
  F extends ScalarState<"number">,
  C extends V.Operand<any> = V.Operand<any>,
> {
  base: F["base"];
  create: V.Number<F>;
  update: F["array"] extends true
    ? NumberListUpdateSchema<F["base"]>
    : NumberUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? NumberListFilterSchema<F["base"]>
    : NumberFilterSchema<F["base"], C>;
}

const internFilter = createScalarInterner<unknown>();
const internUpdate = createScalarInterner<unknown>();

export const buildNumberSchema = <
  F extends ScalarState<"number">,
  C extends V.Operand<any> = V.Operand<any>,
>(
  state: F
): NumberSchemas<F, C> => {
  const key = scalarInternKey(state);
  return lazyScalarSchemas<NumberSchemas<F, C>>({
    base: state.base,
    create: () => v.number(state),
    update: () =>
      internUpdate(key, () =>
        state.array
          ? buildNumberListUpdateSchema(state.base)
          : buildNumberUpdateSchema(state.base)
      ) as never,
    filter: () =>
      internFilter(key, () =>
        state.array
          ? buildNumberListFilterSchema(state.base)
          : buildNumberFilterSchema(state.base)
      ) as never,
  });
};
