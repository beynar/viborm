import {
  FieldState,
  shorthandFilter,
  shorthandUpdate,
  shorthandArray,
} from "../common";
import v, {
  BaseBigIntSchema,
  InferInput,
  InferOutput,
  VibSchema,
} from "../../../validation";

// =============================================================================
// BASE TYPES
// =============================================================================

export const bigIntBase = v.bigint();
export const bigIntNullable = v.bigint({ nullable: true });
export const bigIntList = v.bigint({ array: true });
export const bigIntListNullable = v.bigint({ array: true, nullable: true });

// =============================================================================
// FILTER SCHEMAS
// =============================================================================

const bigIntFilterBase = v.object({
  in: bigIntList,
  notIn: bigIntList,
  lt: bigIntBase,
  lte: bigIntBase,
  gt: bigIntBase,
  gte: bigIntBase,
});

const buildBigIntFilterSchema = <S extends VibSchema>(schema: S) => {
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

const buildBigIntListFilterSchema = <S extends VibSchema>(schema: S) => {
  const filter = bigIntListFilterBase.extend({
    equals: schema,
  });
  return v.union([
    shorthandFilter(schema),
    filter.extend({ not: v.union([shorthandFilter(schema), filter]) }),
  ]);
};

const buildBigIntUpdateSchema = <S extends VibSchema>(schema: S) =>
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

const buildBigIntListUpdateSchema = <S extends VibSchema>(schema: S) =>
  v.union([
    shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([shorthandArray(bigIntBase), bigIntList]),
      unshift: v.union([shorthandArray(bigIntBase), bigIntList]),
    }),
  ]);

export const buildBigIntSchema = <F extends FieldState<"bigint">>(state: F) => {
  return {
    base: state.base,
    create: v.bigint(state),
    update: state.array
      ? buildBigIntListUpdateSchema(state.base)
      : buildBigIntUpdateSchema(state.base),
    filter: state.array
      ? buildBigIntListFilterSchema(state.base)
      : buildBigIntFilterSchema(state.base),
  } as BigIntSchemas<F>;
};

type BigIntSchemas<F extends FieldState<"bigint">> = {
  base: F["base"];
  create: BaseBigIntSchema<F>;
  update: F["array"] extends true
    ? ReturnType<typeof buildBigIntListUpdateSchema<F["base"]>>
    : ReturnType<typeof buildBigIntUpdateSchema<F["base"]>>;
  filter: F["array"] extends true
    ? ReturnType<typeof buildBigIntListFilterSchema<F["base"]>>
    : ReturnType<typeof buildBigIntFilterSchema<F["base"]>>;
};

export type InferBigIntInput<
  F extends FieldState<"bigint">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<BigIntSchemas<F>[Type]>;

export type InferBigIntOutput<
  F extends FieldState<"bigint">,
  Type extends "create" | "update" | "filter" | "base"
> = InferOutput<BigIntSchemas<F>[Type]>;
