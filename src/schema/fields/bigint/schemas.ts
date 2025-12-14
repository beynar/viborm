// BigInt Field Schemas
// Factory pattern for bigint field variants following the number schema structure

import {
  array,
  bigint,
  boolean,
  nullable,
  object,
  optional,
  partial,
  union,
  InferInput,
  NullableSchema,
  ArraySchema,
} from "valibot";
import {
  AnySchema,
  extend,
  FieldState,
  SchemaWithDefault,
  shorthandFilter,
  shorthandUpdate,
  createWithDefault,
} from "../common";

// =============================================================================
// BASE TYPES
// =============================================================================

export const bigIntBase = bigint();
export const bigIntNullable = nullable(bigIntBase);
export const bigIntList = array(bigIntBase);
export const bigIntListNullable = nullable(bigIntList);

// =============================================================================
// FILTER SCHEMAS
// =============================================================================

const bigIntFilterBase = partial(
  object({
    equals: bigIntBase,
    in: bigIntList,
    notIn: bigIntList,
    lt: bigIntBase,
    lte: bigIntBase,
    gt: bigIntBase,
    gte: bigIntBase,
  })
);

const bigIntNullableFilterBase = partial(
  object({
    equals: bigIntNullable,
    in: bigIntList,
    notIn: bigIntList,
    lt: bigIntNullable,
    lte: bigIntNullable,
    gt: bigIntNullable,
    gte: bigIntNullable,
  })
);

const bigIntArrayFilterBase = partial(
  object({
    equals: bigIntList,
    has: bigIntBase,
    hasEvery: bigIntList,
    hasSome: bigIntList,
    isEmpty: boolean(),
  })
);

const bigIntNullableListFilterBase = partial(
  object({
    equals: bigIntListNullable,
    has: bigIntBase,
    hasEvery: bigIntList,
    hasSome: bigIntList,
    isEmpty: boolean(),
  })
);

const bigIntFilter = union([
  shorthandFilter(bigIntBase),
  extend(bigIntFilterBase, {
    not: optional(union([shorthandFilter(bigIntBase), bigIntFilterBase])),
  }),
]);

const bigIntNullableFilter = union([
  shorthandFilter(bigIntNullable),
  extend(bigIntNullableFilterBase, {
    not: optional(
      union([shorthandFilter(bigIntNullable), bigIntNullableFilterBase])
    ),
  }),
]);

const bigIntListFilter = union([
  shorthandFilter(bigIntList),
  extend(bigIntArrayFilterBase, {
    not: optional(union([shorthandFilter(bigIntList), bigIntArrayFilterBase])),
  }),
]);

const bigIntListNullableFilter = union([
  shorthandFilter(bigIntListNullable),
  extend(bigIntNullableListFilterBase, {
    not: optional(
      union([shorthandFilter(bigIntListNullable), bigIntNullableListFilterBase])
    ),
  }),
]);

// =============================================================================
// UPDATE FACTORIES
// =============================================================================

const bigIntUpdateFactory = <S extends AnySchema>(base: S) =>
  union([
    shorthandUpdate(base),
    partial(
      object({
        set: base,
        increment: base,
        decrement: base,
        multiply: base,
        divide: base,
      })
    ),
  ]);

const bigIntNullableUpdateFactory = <S extends AnySchema>(base: S) =>
  union([
    shorthandUpdate(nullable(base)),
    partial(
      object({
        set: nullable(base),
        increment: base,
        decrement: base,
        multiply: base,
        divide: base,
      })
    ),
  ]);

const bigIntListUpdateFactory = <S extends AnySchema>(base: S) =>
  union([
    shorthandUpdate(array(base)),
    partial(
      object({
        set: array(base),
        push: union([base, array(base)]),
        unshift: union([base, array(base)]),
      })
    ),
  ]);

const bigIntListNullableUpdateFactory = <S extends AnySchema>(base: S) =>
  union([
    shorthandUpdate(nullable(array(base))),
    partial(
      object({
        set: nullable(array(base)),
        push: union([base, array(base)]),
        unshift: union([base, array(base)]),
      })
    ),
  ]);

// =============================================================================
// SCHEMA BUILDERS
// =============================================================================

export const bigIntSchemas = <const F extends FieldState<"bigint">>(f: F) => {
  return {
    base: f.base,
    filter: bigIntFilter,
    create: createWithDefault(f, f.base),
    update: bigIntUpdateFactory(f.base),
  } as unknown as BigIntSchemas<F>;
};

type BigIntSchemas<F extends FieldState<"bigint">> = {
  base: F["base"];
  filter: typeof bigIntFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof bigIntUpdateFactory<F["base"]>>;
};

export const bigIntNullableSchemas = <F extends FieldState<"bigint">>(f: F) => {
  return {
    base: nullable(f.base),
    filter: bigIntNullableFilter,
    create: createWithDefault(f, nullable(f.base)),
    update: bigIntNullableUpdateFactory(f.base),
  } as unknown as BigIntNullableSchemas<F>;
};

type BigIntNullableSchemas<F extends FieldState<"bigint">> = {
  base: NullableSchema<F["base"], undefined>;
  filter: typeof bigIntNullableFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof bigIntNullableUpdateFactory<F["base"]>>;
};

export const bigIntListSchemas = <F extends FieldState<"bigint">>(f: F) => {
  return {
    base: array(f.base),
    filter: bigIntListFilter,
    create: createWithDefault(f, array(f.base)),
    update: bigIntListUpdateFactory(f.base),
  } as unknown as BigIntListSchemas<F>;
};

type BigIntListSchemas<F extends FieldState<"bigint">> = {
  base: ArraySchema<F["base"], undefined>;
  filter: typeof bigIntListFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof bigIntListUpdateFactory<F["base"]>>;
};

export const bigIntListNullableSchemas = <F extends FieldState<"bigint">>(
  f: F
) => {
  return {
    base: nullable(array(f.base)),
    filter: bigIntListNullableFilter,
    create: createWithDefault(f, nullable(array(f.base))),
    update: bigIntListNullableUpdateFactory(f.base),
  } as unknown as BigIntListNullableSchemas<F>;
};

type BigIntListNullableSchemas<F extends FieldState<"bigint">> = {
  base: NullableSchema<ArraySchema<F["base"], undefined>, undefined>;
  filter: typeof bigIntListNullableFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof bigIntListNullableUpdateFactory<F["base"]>>;
};

// =============================================================================
// TYPE INFERENCE
// =============================================================================

export type InferBigIntSchemas<F extends FieldState<"bigint">> =
  F["array"] extends true
    ? F["nullable"] extends true
      ? BigIntListNullableSchemas<F>
      : BigIntListSchemas<F>
    : F["nullable"] extends true
    ? BigIntNullableSchemas<F>
    : BigIntSchemas<F>;

// =============================================================================
// MAIN SCHEMA GETTER
// =============================================================================

export const getFieldBigIntSchemas = <F extends FieldState<"bigint">>(f: F) => {
  return (
    f.array
      ? f.nullable
        ? bigIntListNullableSchemas(f)
        : bigIntListSchemas(f)
      : f.nullable
      ? bigIntNullableSchemas(f)
      : bigIntSchemas(f)
  ) as InferBigIntSchemas<F>;
};

// =============================================================================
// INPUT TYPE INFERENCE
// =============================================================================

export type InferBigIntInput<
  F extends FieldState<"bigint">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<InferBigIntSchemas<F>[Type]>;
