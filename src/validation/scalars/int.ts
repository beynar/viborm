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

const intBase = v.integer();
const intList = v.integer({ array: true });

// =============================================================================
// FILTER TYPES
// =============================================================================

/**
 * Comparison operand: a literal, a field reference to another int column, an
 * SQL fragment, or a callback returning one of the latter two.
 */
type IntOperand<
  S extends V.Schema,
  C extends V.Operand<any>,
> = V.ComparisonOperand<"int", S, C>;

type IntFilterBase<S extends V.Schema, C extends V.Operand<any>> = {
  equals: IntOperand<S, C>;
  in: V.Integer<{ array: true }>;
  notIn: V.Integer<{ array: true }>;
  lt: IntOperand<V.Integer, C>;
  lte: IntOperand<V.Integer, C>;
  gt: IntOperand<V.Integer, C>;
  gte: IntOperand<V.Integer, C>;
};

type IntFilterSchema<
  S extends V.Schema,
  C extends V.Operand<any>,
> = NegatableFilterSchema<IntOperand<S, C>, IntFilterBase<S, C>>;

type IntListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.Integer;
  hasEvery: V.Integer<{ array: true }>;
  hasSome: V.Integer<{ array: true }>;
  isEmpty: V.Boolean;
};

type IntListFilterSchema<S extends V.Schema> = NegatableFilterSchema<
  S,
  IntListFilterBase<S>
>;

// =============================================================================
// UPDATE TYPES
// =============================================================================

type IntUpdateSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandUpdate<S>,
    V.Object<{
      set: S;
      increment: V.Integer;
      decrement: V.Integer;
      multiply: V.Integer;
      divide: V.Integer;
    }>,
  ]
>;

type IntListUpdateSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandUpdate<S>,
    V.Object<{
      set: S;
      push: V.Union<
        readonly [V.ShorthandArray<V.Integer>, V.Integer<{ array: true }>]
      >;
      unshift: V.Union<
        readonly [V.ShorthandArray<V.Integer>, V.Integer<{ array: true }>]
      >;
    }>,
  ]
>;

// =============================================================================
// SCHEMA BUILDERS
// =============================================================================

const intFilterBase = v.object({
  in: intList,
  notIn: intList,
  lt: v.comparisonOperand("int", intBase),
  lte: v.comparisonOperand("int", intBase),
  gt: v.comparisonOperand("int", intBase),
  gte: v.comparisonOperand("int", intBase),
});

const buildIntFilterSchema = <S extends V.Schema, C extends V.Operand<any>>(
  schema: S
): IntFilterSchema<S, C> => {
  const operand = v.comparisonOperand("int", schema);
  const filter = intFilterBase.extend({
    equals: operand,
  });
  return buildNegatableFilterSchema<IntOperand<S, C>, IntFilterBase<S, C>>(
    filter,
    operand
  );
};

const intListFilterBase = v.object({
  has: intBase,
  hasEvery: intList,
  hasSome: intList,
  isEmpty: v.boolean(),
});

const buildIntListFilterSchema = <S extends V.Schema>(
  schema: S
): IntListFilterSchema<S> => {
  const filter = intListFilterBase.extend({
    equals: schema,
  });
  return buildNegatableFilterSchema<S, IntListFilterBase<S>>(filter, schema);
};

const buildIntUpdateSchema = <S extends V.Schema>(
  schema: S
): IntUpdateSchema<S> =>
  v.union([
    v.shorthandUpdate(schema),
    v.object({
      set: schema,
      increment: intBase,
      decrement: intBase,
      multiply: intBase,
      divide: intBase,
    }),
  ]);

const buildIntListUpdateSchema = <S extends V.Schema>(
  schema: S
): IntListUpdateSchema<S> =>
  v.union([
    v.shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([v.shorthandArray(intBase), intList]),
      unshift: v.union([v.shorthandArray(intBase), intList]),
    }),
  ]);

// =============================================================================
// INT SCHEMA BUILDER
// =============================================================================

export interface IntSchemas<
  F extends ScalarState<"int">,
  C extends V.Operand<any> = V.Operand<any>,
> {
  base: F["base"];
  create: V.Integer<F>;
  update: F["array"] extends true
    ? IntListUpdateSchema<F["base"]>
    : IntUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? IntListFilterSchema<F["base"]>
    : IntFilterSchema<F["base"], C>;
}

const internFilter = createScalarInterner<unknown>();
const internUpdate = createScalarInterner<unknown>();

export const buildIntSchema = <
  F extends ScalarState<"int">,
  C extends V.Operand<any> = V.Operand<any>,
>(
  state: F
): IntSchemas<F, C> => {
  const key = scalarInternKey(state);
  return lazyScalarSchemas<IntSchemas<F, C>>({
    base: state.base,
    create: () => v.integer(state),
    update: () =>
      internUpdate(key, () =>
        state.array
          ? buildIntListUpdateSchema(state.base)
          : buildIntUpdateSchema(state.base)
      ) as never,
    filter: () =>
      internFilter(key, () =>
        state.array
          ? buildIntListFilterSchema(state.base)
          : buildIntFilterSchema(state.base)
      ) as never,
  });
};
