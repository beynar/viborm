import type { FieldState } from "@schema/fields/common";
import v, { type V } from "@validation";

// =============================================================================
// BASE TYPES
// =============================================================================

const booleanBase = v.boolean();
const booleanList = v.boolean({ array: true });

// =============================================================================
// FILTER TYPES
// =============================================================================

type BooleanFilterBase<S extends V.Schema> = {
  equals: S;
};

type BooleanFilterSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandFilter<S>,
    V.Object<
      BooleanFilterBase<S> & {
        not: V.Union<
          readonly [V.ShorthandFilter<S>, V.Object<BooleanFilterBase<S>>]
        >;
      }
    >,
  ]
>;

type BooleanListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.Boolean;
  hasEvery: V.Boolean<{ array: true }>;
  hasSome: V.Boolean<{ array: true }>;
  isEmpty: V.Boolean;
};

type BooleanListFilterSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandFilter<S>,
    V.Object<
      BooleanListFilterBase<S> & {
        not: V.Union<
          readonly [V.ShorthandFilter<S>, V.Object<BooleanListFilterBase<S>>]
        >;
      }
    >,
  ]
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

const buildBooleanFilterSchema = <S extends V.Schema>(
  schema: S
): BooleanFilterSchema<S> => {
  const filter = v.object({
    equals: schema,
  });
  return v.union([
    v.shorthandFilter(schema),
    filter.extend({
      not: v.union([v.shorthandFilter(schema), filter]),
    }),
  ]);
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
  return v.union([
    v.shorthandFilter(schema),
    filter.extend({ not: v.union([v.shorthandFilter(schema), filter]) }),
  ]);
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

export interface BooleanSchemas<F extends FieldState<"boolean">> {
  base: F["base"];
  create: V.Boolean<F>;
  update: F["array"] extends true
    ? BooleanListUpdateSchema<F["base"]>
    : BooleanUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? BooleanListFilterSchema<F["base"]>
    : BooleanFilterSchema<F["base"]>;
}

export const buildBooleanSchema = <F extends FieldState<"boolean">>(
  state: F
): BooleanSchemas<F> => {
  return {
    base: state.base as F["base"],
    create: v.boolean(state),
    update: state.array
      ? buildBooleanListUpdateSchema(state.base)
      : buildBooleanUpdateSchema(state.base),
    filter: state.array
      ? buildBooleanListFilterSchema(state.base)
      : buildBooleanFilterSchema(state.base),
  } as BooleanSchemas<F>;
};
