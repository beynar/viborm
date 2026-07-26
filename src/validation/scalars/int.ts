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

const intBase = v.integer();
const intList = v.integer({ array: true });

// =============================================================================
// FILTER TYPES
// =============================================================================

/** Comparison operand: a literal, or a field reference to another int column. */
type IntOperand<S extends V.Schema> = V.FieldRefOr<"int", S>;

type IntFilterBase<S extends V.Schema> = {
  equals: IntOperand<S>;
  in: V.Integer<{ array: true }>;
  notIn: V.Integer<{ array: true }>;
  lt: IntOperand<V.Integer>;
  lte: IntOperand<V.Integer>;
  gt: IntOperand<V.Integer>;
  gte: IntOperand<V.Integer>;
};

type IntFilterSchema<S extends V.Schema> = NegatableFilterSchema<
  IntOperand<S>,
  IntFilterBase<S>
>;

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
  lt: v.fieldRefOr("int", intBase),
  lte: v.fieldRefOr("int", intBase),
  gt: v.fieldRefOr("int", intBase),
  gte: v.fieldRefOr("int", intBase),
});

const buildIntFilterSchema = <S extends V.Schema>(
  schema: S
): IntFilterSchema<S> => {
  const operand = v.fieldRefOr("int", schema);
  const filter = intFilterBase.extend({
    equals: operand,
  });
  return buildNegatableFilterSchema<IntOperand<S>, IntFilterBase<S>>(
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

export interface IntSchemas<F extends ScalarState<"int">> {
  base: F["base"];
  create: V.Integer<F>;
  update: F["array"] extends true
    ? IntListUpdateSchema<F["base"]>
    : IntUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? IntListFilterSchema<F["base"]>
    : IntFilterSchema<F["base"]>;
}

const internFilter = createScalarInterner<unknown>();
const internUpdate = createScalarInterner<unknown>();

export const buildIntSchema = <F extends ScalarState<"int">>(
  state: F
): IntSchemas<F> => {
  const key = scalarInternKey(state);
  return {
    base: state.base as F["base"],
    create: v.integer(state),
    update: internUpdate(key, () =>
      state.array
        ? buildIntListUpdateSchema(state.base)
        : buildIntUpdateSchema(state.base)
    ) as never,
    filter: internFilter(key, () =>
      state.array
        ? buildIntListFilterSchema(state.base)
        : buildIntFilterSchema(state.base)
    ) as never,
  } as IntSchemas<F>;
};
