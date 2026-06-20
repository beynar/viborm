import type { FieldState } from "@schema/fields/common";
import v, { type V } from "@validation";

// =============================================================================
// BASE TYPES
// =============================================================================

const intBase = v.integer();
const intList = v.integer({ array: true });

// =============================================================================
// FILTER TYPES
// =============================================================================

type IntFilterBase<S extends V.Schema> = {
  equals: S;
  in: V.Integer<{ array: true }>;
  notIn: V.Integer<{ array: true }>;
  lt: V.Integer;
  lte: V.Integer;
  gt: V.Integer;
  gte: V.Integer;
};

type IntFilterSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandFilter<S>,
    V.Object<
      IntFilterBase<S> & {
        not: V.Union<
          readonly [V.ShorthandFilter<S>, V.Object<IntFilterBase<S>>]
        >;
      }
    >,
  ]
>;

type IntListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.Integer;
  hasEvery: V.Integer<{ array: true }>;
  hasSome: V.Integer<{ array: true }>;
  isEmpty: V.Boolean;
};

type IntListFilterSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandFilter<S>,
    V.Object<
      IntListFilterBase<S> & {
        not: V.Union<
          readonly [V.ShorthandFilter<S>, V.Object<IntListFilterBase<S>>]
        >;
      }
    >,
  ]
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
  lt: intBase,
  lte: intBase,
  gt: intBase,
  gte: intBase,
});

const buildIntFilterSchema = <S extends V.Schema>(
  schema: S
): IntFilterSchema<S> => {
  const filter = intFilterBase.extend({
    equals: schema,
  });
  return v.union([
    v.shorthandFilter(schema),
    filter.extend({
      not: v.union([v.shorthandFilter(schema), filter]),
    }),
  ]);
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
  return v.union([
    v.shorthandFilter(schema),
    filter.extend({ not: v.union([v.shorthandFilter(schema), filter]) }),
  ]);
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

export interface IntSchemas<F extends FieldState<"int">> {
  base: F["base"];
  create: V.Integer<F>;
  update: F["array"] extends true
    ? IntListUpdateSchema<F["base"]>
    : IntUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? IntListFilterSchema<F["base"]>
    : IntFilterSchema<F["base"]>;
}

export const buildIntSchema = <F extends FieldState<"int">>(
  state: F
): IntSchemas<F> => {
  return {
    base: state.base as F["base"],
    create: v.integer(state),
    update: state.array
      ? buildIntListUpdateSchema(state.base)
      : buildIntUpdateSchema(state.base),
    filter: state.array
      ? buildIntListFilterSchema(state.base)
      : buildIntFilterSchema(state.base),
  } as IntSchemas<F>;
};
