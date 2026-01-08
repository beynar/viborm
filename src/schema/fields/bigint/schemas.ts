import v, {
  type BaseBigIntSchema,
  type InferInput,
  type InferOutput,
} from "@validation";
import type { V } from "@validation/V";
import {
  type FieldState,
  shorthandArray,
  shorthandFilter,
  shorthandUpdate,
} from "../common";

// =============================================================================
// BASE TYPES
// =============================================================================

export const bigIntBase = v.bigint();
export const bigIntNullable = v.bigint({ nullable: true });
export const bigIntList = v.bigint({ array: true });
export const bigIntListNullable = v.bigint({ array: true, nullable: true });

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

export type BigIntFilterSchema<S extends V.Schema> = V.Union<
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

export type BigIntListFilterSchema<S extends V.Schema> = V.Union<
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

export type BigIntUpdateSchema<S extends V.Schema> = V.Union<
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

export type BigIntListUpdateSchema<S extends V.Schema> = V.Union<
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
  schema: S
): BigIntFilterSchema<S> => {
  const filter = bigIntFilterBase.extend({
    equals: schema,
  });
  return v.union([
    shorthandFilter(schema),
    filter.extend({
      not: v.union([shorthandFilter(schema), filter]),
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
  schema: S
): BigIntListFilterSchema<S> => {
  const filter = bigIntListFilterBase.extend({
    equals: schema,
  });
  return v.union([
    shorthandFilter(schema),
    filter.extend({ not: v.union([shorthandFilter(schema), filter]) }),
  ]);
};

// =============================================================================
// UPDATE SCHEMA BUILDERS
// =============================================================================

const buildBigIntUpdateSchema = <S extends V.Schema>(
  schema: S
): BigIntUpdateSchema<S> =>
  v.union([
    shorthandUpdate(schema),
    v.object({
      set: schema,
      increment: bigIntBase,
      decrement: bigIntBase,
      multiply: bigIntBase,
      divide: bigIntBase,
    }),
  ]);

const buildBigIntListUpdateSchema = <S extends V.Schema>(
  schema: S
): BigIntListUpdateSchema<S> =>
  v.union([
    shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([shorthandArray(bigIntBase), bigIntList]),
      unshift: v.union([shorthandArray(bigIntBase), bigIntList]),
    }),
  ]);

// =============================================================================
// BIGINT SCHEMA BUILDER
// =============================================================================

export interface BigIntSchemas<F extends FieldState<"bigint">> {
  base: F["base"];
  create: BaseBigIntSchema<F>;
  update: F["array"] extends true
    ? BigIntListUpdateSchema<F["base"]>
    : BigIntUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? BigIntListFilterSchema<F["base"]>
    : BigIntFilterSchema<F["base"]>;
}

export const buildBigIntSchema = <F extends FieldState<"bigint">>(
  state: F
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

export type InferBigIntInput<
  F extends FieldState<"bigint">,
  Type extends keyof BigIntSchemas<F>,
> = InferInput<BigIntSchemas<F>[Type]>;

export type InferBigIntOutput<
  F extends FieldState<"bigint">,
  Type extends keyof BigIntSchemas<F>,
> = InferOutput<BigIntSchemas<F>[Type]>;
