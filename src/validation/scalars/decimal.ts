import type { ScalarState } from "@schema/scalars/common";
import v, { type V } from "../primitives/v";
import {
  buildNegatableFilterSchema,
  type NegatableFilterSchema,
} from "./negatable-filter";

// =============================================================================
// BASE TYPES
// =============================================================================

const decimalBase = v.number();
const decimalList = v.number({ array: true });

// =============================================================================
// FILTER TYPES
// =============================================================================

/** Comparison operand: a literal, or a field reference to another decimal column. */
type DecimalOperand<S extends V.Schema> = V.FieldRefOr<"decimal", S>;

type DecimalFilterBase<S extends V.Schema> = {
  equals: DecimalOperand<S>;
  in: V.Number<{ array: true }>;
  notIn: V.Number<{ array: true }>;
  lt: DecimalOperand<V.Number>;
  lte: DecimalOperand<V.Number>;
  gt: DecimalOperand<V.Number>;
  gte: DecimalOperand<V.Number>;
};

type DecimalFilterSchema<S extends V.Schema> = NegatableFilterSchema<
  DecimalOperand<S>,
  DecimalFilterBase<S>
>;

type DecimalListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.Number;
  hasEvery: V.Number<{ array: true }>;
  hasSome: V.Number<{ array: true }>;
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
      increment: V.Number;
      decrement: V.Number;
      multiply: V.Number;
      divide: V.Number;
    }>,
  ]
>;

type DecimalListUpdateSchema<S extends V.Schema> = V.Union<
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

const decimalFilterBase = v.object({
  in: decimalList,
  notIn: decimalList,
  lt: v.fieldRefOr("decimal", decimalBase),
  lte: v.fieldRefOr("decimal", decimalBase),
  gt: v.fieldRefOr("decimal", decimalBase),
  gte: v.fieldRefOr("decimal", decimalBase),
});

const buildDecimalFilterSchema = <S extends V.Schema>(
  schema: S
): DecimalFilterSchema<S> => {
  const operand = v.fieldRefOr("decimal", schema);
  const filter = decimalFilterBase.extend({
    equals: operand,
  });
  return buildNegatableFilterSchema<DecimalOperand<S>, DecimalFilterBase<S>>(
    filter,
    operand
  );
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

export interface DecimalSchemas<F extends ScalarState<"decimal">> {
  base: F["base"];
  create: V.Number<F>;
  update: F["array"] extends true
    ? DecimalListUpdateSchema<F["base"]>
    : DecimalUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? DecimalListFilterSchema<F["base"]>
    : DecimalFilterSchema<F["base"]>;
}

export const buildDecimalSchema = <F extends ScalarState<"decimal">>(
  state: F
): DecimalSchemas<F> => {
  return {
    base: state.base as F["base"],
    create: v.number(state),
    update: state.array
      ? buildDecimalListUpdateSchema(state.base)
      : buildDecimalUpdateSchema(state.base),
    filter: state.array
      ? buildDecimalListFilterSchema(state.base)
      : buildDecimalFilterSchema(state.base),
  } as DecimalSchemas<F>;
};
