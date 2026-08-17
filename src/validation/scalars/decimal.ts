import type { ScalarState } from "@schema/scalars/common";
import { lazyScalarSchemas } from "../lazy";
import v, { type V } from "../primitives/v";
import {
  buildNegatableFilterSchema,
  type NegatableFilterSchema,
} from "./negatable-filter";

// =============================================================================
// BASE TYPES
// =============================================================================

const decimalBase = v.decimal();
const decimalList = v.decimal({ array: true });

// =============================================================================
// FILTER TYPES
// =============================================================================

/**
 * Comparison operand: a literal, a field reference to another decimal column, an
 * SQL fragment, or a callback returning one of the latter two.
 */
type DecimalOperand<
  S extends V.Schema,
  C extends V.Operand<any>,
> = V.ComparisonOperand<"decimal", S, C>;

type DecimalFilterBase<S extends V.Schema, C extends V.Operand<any>> = {
  equals: DecimalOperand<S, C>;
  in: V.Decimal<{ array: true }>;
  notIn: V.Decimal<{ array: true }>;
  lt: DecimalOperand<V.Decimal, C>;
  lte: DecimalOperand<V.Decimal, C>;
  gt: DecimalOperand<V.Decimal, C>;
  gte: DecimalOperand<V.Decimal, C>;
};

type DecimalFilterSchema<
  S extends V.Schema,
  C extends V.Operand<any>,
> = NegatableFilterSchema<DecimalOperand<S, C>, DecimalFilterBase<S, C>>;

type DecimalListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.Decimal;
  hasEvery: V.Decimal<{ array: true }>;
  hasSome: V.Decimal<{ array: true }>;
  isEmpty: V.Boolean;
};

type DecimalListFilterSchema<S extends V.Schema> = NegatableFilterSchema<
  S,
  DecimalListFilterBase<S>
>;

// =============================================================================
// UPDATE TYPES
// =============================================================================

type DecimalUpdateSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandUpdate<S>,
    V.Object<{
      set: S;
      increment: V.Decimal;
      decrement: V.Decimal;
      multiply: V.Decimal;
      divide: V.Decimal;
    }>,
  ]
>;

type DecimalListUpdateSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandUpdate<S>,
    V.Object<{
      set: S;
      push: V.Union<
        readonly [V.ShorthandArray<V.Decimal>, V.Decimal<{ array: true }>]
      >;
      unshift: V.Union<
        readonly [V.ShorthandArray<V.Decimal>, V.Decimal<{ array: true }>]
      >;
    }>,
  ]
>;

// =============================================================================
// SCHEMA BUILDERS
// =============================================================================

const decimalFilterBase = v.object({
  in: decimalList,
  notIn: decimalList,
  lt: v.comparisonOperand("decimal", decimalBase),
  lte: v.comparisonOperand("decimal", decimalBase),
  gt: v.comparisonOperand("decimal", decimalBase),
  gte: v.comparisonOperand("decimal", decimalBase),
});

const buildDecimalFilterSchema = <S extends V.Schema, C extends V.Operand<any>>(
  schema: S
): DecimalFilterSchema<S, C> => {
  const operand = v.comparisonOperand("decimal", schema);
  const filter = decimalFilterBase.extend({
    equals: operand,
  });
  return buildNegatableFilterSchema<
    DecimalOperand<S, C>,
    DecimalFilterBase<S, C>
  >(filter, operand);
};

const decimalListFilterBase = v.object({
  has: decimalBase,
  hasEvery: decimalList,
  hasSome: decimalList,
  isEmpty: v.boolean(),
});

const buildDecimalListFilterSchema = <S extends V.Schema>(
  schema: S
): DecimalListFilterSchema<S> => {
  const filter = decimalListFilterBase.extend({
    equals: schema,
  });
  return buildNegatableFilterSchema<S, DecimalListFilterBase<S>>(
    filter,
    schema
  );
};

const buildDecimalUpdateSchema = <S extends V.Schema>(
  schema: S
): DecimalUpdateSchema<S> =>
  v.union([
    v.shorthandUpdate(schema),
    v.object({
      set: schema,
      increment: decimalBase,
      decrement: decimalBase,
      multiply: decimalBase,
      divide: decimalBase,
    }),
  ]);

const buildDecimalListUpdateSchema = <S extends V.Schema>(
  schema: S
): DecimalListUpdateSchema<S> =>
  v.union([
    v.shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([v.shorthandArray(decimalBase), decimalList]),
      unshift: v.union([v.shorthandArray(decimalBase), decimalList]),
    }),
  ]);

// =============================================================================
// DECIMAL SCHEMA BUILDER
// =============================================================================

export interface DecimalSchemas<
  F extends ScalarState<"decimal">,
  C extends V.Operand<any> = V.Operand<any>,
> {
  base: F["base"];
  create: V.Decimal<F>;
  update: F["array"] extends true
    ? DecimalListUpdateSchema<F["base"]>
    : DecimalUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? DecimalListFilterSchema<F["base"]>
    : DecimalFilterSchema<F["base"], C>;
}

export const buildDecimalSchema = <
  F extends ScalarState<"decimal">,
  C extends V.Operand<any> = V.Operand<any>,
>(
  state: F
): DecimalSchemas<F, C> => {
  return lazyScalarSchemas<DecimalSchemas<F, C>>({
    base: state.base,
    create: () => v.decimal(state),
    update: () =>
      (state.array
        ? buildDecimalListUpdateSchema(state.base)
        : buildDecimalUpdateSchema(state.base)) as never,
    filter: () =>
      (state.array
        ? buildDecimalListFilterSchema(state.base)
        : buildDecimalFilterSchema(state.base)) as never,
  });
};
