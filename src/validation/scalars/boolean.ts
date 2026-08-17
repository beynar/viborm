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

const booleanBase = v.boolean();
const booleanList = v.boolean({ array: true });

// =============================================================================
// FILTER TYPES
// =============================================================================

/**
 * Equality operand: a literal, a field reference to another boolean column, an
 * SQL fragment, or a callback returning one of the latter two.
 */
type BooleanOperand<
  S extends V.Schema,
  C extends V.Operand<any>,
> = V.ComparisonOperand<"boolean", S, C>;

type BooleanFilterBase<S extends V.Schema, C extends V.Operand<any>> = {
  equals: BooleanOperand<S, C>;
};

type BooleanFilterSchema<
  S extends V.Schema,
  C extends V.Operand<any>,
> = NegatableFilterSchema<BooleanOperand<S, C>, BooleanFilterBase<S, C>>;

type BooleanListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.Boolean;
  hasEvery: V.Boolean<{ array: true }>;
  hasSome: V.Boolean<{ array: true }>;
  isEmpty: V.Boolean;
};

type BooleanListFilterSchema<S extends V.Schema> = NegatableFilterSchema<
  S,
  BooleanListFilterBase<S>
>;

// =============================================================================
// UPDATE TYPES
// =============================================================================

type BooleanUpdateSchema<S extends V.Schema> = V.Union<
  readonly [V.ShorthandUpdate<S>, V.Object<{ set: S }, { partial: false }>]
>;

type BooleanListUpdateSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandUpdate<S>,
    V.Object<{
      set: S;
      push: V.Union<
        readonly [V.ShorthandArray<V.Boolean>, V.Boolean<{ array: true }>]
      >;
      unshift: V.Union<
        readonly [V.ShorthandArray<V.Boolean>, V.Boolean<{ array: true }>]
      >;
    }>,
  ]
>;

// =============================================================================
// FILTER SCHEMA BUILDERS
// =============================================================================

const buildBooleanFilterSchema = <S extends V.Schema, C extends V.Operand<any>>(
  schema: S
): BooleanFilterSchema<S, C> => {
  const operand = v.comparisonOperand("boolean", schema);
  const filter = v.object({
    equals: operand,
  });
  return buildNegatableFilterSchema<
    BooleanOperand<S, C>,
    BooleanFilterBase<S, C>
  >(filter, operand);
};

const booleanListFilterBase = v.object({
  has: booleanBase,
  hasEvery: booleanList,
  hasSome: booleanList,
  isEmpty: v.boolean(),
});

const buildBooleanListFilterSchema = <S extends V.Schema>(
  schema: S
): BooleanListFilterSchema<S> => {
  const filter = booleanListFilterBase.extend({
    equals: schema,
  });
  return buildNegatableFilterSchema<S, BooleanListFilterBase<S>>(
    filter,
    schema
  );
};

// =============================================================================
// UPDATE SCHEMA BUILDERS
// =============================================================================

const buildBooleanUpdateSchema = <S extends V.Schema>(
  schema: S
): BooleanUpdateSchema<S> =>
  v.union([
    v.shorthandUpdate(schema),
    v.object(
      {
        set: schema,
      },
      { partial: false }
    ),
  ]);

const buildBooleanListUpdateSchema = <S extends V.Schema>(
  schema: S
): BooleanListUpdateSchema<S> =>
  v.union([
    v.shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([v.shorthandArray(booleanBase), booleanList]),
      unshift: v.union([v.shorthandArray(booleanBase), booleanList]),
    }),
  ]);

// =============================================================================
// BOOLEAN SCHEMA BUILDER
// =============================================================================

export interface BooleanSchemas<
  F extends ScalarState<"boolean">,
  C extends V.Operand<any> = V.Operand<any>,
> {
  base: F["base"];
  create: V.Boolean<F>;
  update: F["array"] extends true
    ? BooleanListUpdateSchema<F["base"]>
    : BooleanUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? BooleanListFilterSchema<F["base"]>
    : BooleanFilterSchema<F["base"], C>;
}

const internFilter = createScalarInterner<unknown>();
const internUpdate = createScalarInterner<unknown>();

export const buildBooleanSchema = <
  F extends ScalarState<"boolean">,
  C extends V.Operand<any> = V.Operand<any>,
>(
  state: F
): BooleanSchemas<F, C> => {
  const key = scalarInternKey(state);
  return lazyScalarSchemas<BooleanSchemas<F, C>>({
    base: state.base,
    create: () => v.boolean(state),
    update: () =>
      internUpdate(key, () =>
        state.array
          ? buildBooleanListUpdateSchema(state.base)
          : buildBooleanUpdateSchema(state.base)
      ) as never,
    filter: () =>
      internFilter(key, () =>
        state.array
          ? buildBooleanListFilterSchema(state.base)
          : buildBooleanFilterSchema(state.base)
      ) as never,
  });
};
