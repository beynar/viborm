import type { FieldState } from "@schema/fields/common";
import v, { type V } from "@validation";

// =============================================================================
// BASE TYPES
// =============================================================================

const bigIntBase = v.bigint();
const bigIntList = v.bigint({ array: true });

// =============================================================================
// FILTER TYPES
// =============================================================================

type BigIntFilterBase<S extends V.Schema> = {
  equals: S;
  in: V.BigInt<{ array: true }>;
  notIn: V.BigInt<{ array: true }>;
  lt: V.BigInt;
  lte: V.BigInt;
  gt: V.BigInt;
  gte: V.BigInt;
};

type BigIntFilterSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandFilter<S>,
    V.Object<
      BigIntFilterBase<S> & {
        not: V.Union<
          readonly [V.ShorthandFilter<S>, V.Object<BigIntFilterBase<S>>]
        >;
      }
    >,
  ]
>;

type BigIntListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.BigInt;
  hasEvery: V.BigInt<{ array: true }>;
  hasSome: V.BigInt<{ array: true }>;
  isEmpty: V.Boolean;
};

type BigIntListFilterSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandFilter<S>,
    V.Object<
      BigIntListFilterBase<S> & {
        not: V.Union<
          readonly [V.ShorthandFilter<S>, V.Object<BigIntListFilterBase<S>>]
        >;
      }
    >,
  ]
>;

// =============================================================================
// UPDATE TYPES
// =============================================================================

type BigIntUpdateSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandUpdate<S>,
    V.Object<{
      set: S;
      increment: V.BigInt;
      decrement: V.BigInt;
      multiply: V.BigInt;
      divide: V.BigInt;
    }>,
  ]
>;

type BigIntListUpdateSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandUpdate<S>,
    V.Object<{
      set: S;
      push: V.Union<
        readonly [V.ShorthandArray<V.BigInt>, V.BigInt<{ array: true }>]
      >;
      unshift: V.Union<
        readonly [V.ShorthandArray<V.BigInt>, V.BigInt<{ array: true }>]
      >;
    }>,
  ]
>;

// =============================================================================
// FILTER SCHEMA BUILDERS
// =============================================================================

const bigIntFilterBase = v.object({
  in: bigIntList,
  notIn: bigIntList,
  lt: bigIntBase,
  lte: bigIntBase,
  gt: bigIntBase,
  gte: bigIntBase,
});

const buildBigIntFilterSchema = <S extends V.Schema>(
  schema: S,
): BigIntFilterSchema<S> => {
  const filter = bigIntFilterBase.extend({
    equals: schema,
  });
  return v.union([
    v.shorthandFilter(schema),
    filter.extend({
      not: v.union([v.shorthandFilter(schema), filter]),
    }),
  ]);
};

const bigIntListFilterBase = v.object({
  has: bigIntBase,
  hasEvery: bigIntList,
  hasSome: bigIntList,
  isEmpty: v.boolean(),
});

const buildBigIntListFilterSchema = <S extends V.Schema>(
  schema: S,
): BigIntListFilterSchema<S> => {
  const filter = bigIntListFilterBase.extend({
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

const buildBigIntUpdateSchema = <S extends V.Schema>(
  schema: S,
): BigIntUpdateSchema<S> =>
  v.union([
    v.shorthandUpdate(schema),
    v.object({
      set: schema,
      increment: bigIntBase,
      decrement: bigIntBase,
      multiply: bigIntBase,
      divide: bigIntBase,
    }),
  ]);

const buildBigIntListUpdateSchema = <S extends V.Schema>(
  schema: S,
): BigIntListUpdateSchema<S> =>
  v.union([
    v.shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([v.shorthandArray(bigIntBase), bigIntList]),
      unshift: v.union([v.shorthandArray(bigIntBase), bigIntList]),
    }),
  ]);

// =============================================================================
// BIGINT SCHEMA BUILDER
// =============================================================================

export interface BigIntSchemas<F extends FieldState<"bigint">> {
  base: F["base"];
  create: V.BigInt<F>;
  update: F["array"] extends true
    ? BigIntListUpdateSchema<F["base"]>
    : BigIntUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? BigIntListFilterSchema<F["base"]>
    : BigIntFilterSchema<F["base"]>;
}

export const buildBigIntSchema = <F extends FieldState<"bigint">>(
  state: F,
): BigIntSchemas<F> => {
  return {
    base: state.base as F["base"],
    create: v.bigint(state),
    update: state.array
      ? buildBigIntListUpdateSchema(state.base)
      : buildBigIntUpdateSchema(state.base),
    filter: state.array
      ? buildBigIntListFilterSchema(state.base)
      : buildBigIntFilterSchema(state.base),
  } as BigIntSchemas<F>;
};
