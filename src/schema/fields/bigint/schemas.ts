// BigInt Field Schemas
// Follows FIELD_IMPLEMENTATION_GUIDE and mirrors number schemas

import {
  array,
  bigint,
  boolean,
  nullable,
  object,
  optional,
  partial,
  union,
  _default,
  extend,
  type input as Input,
} from "zod/v4-mini";
import {
  FieldState,
  isOptional,
  shorthandFilter,
  shorthandUpdate,
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
    in: array(bigIntBase),
    notIn: array(bigIntBase),
    lt: bigIntBase,
    lte: bigIntBase,
    gt: bigIntBase,
    gte: bigIntBase,
  })
);

const bigIntNullableFilterBase = partial(
  object({
    equals: bigIntNullable,
    in: array(bigIntBase),
    notIn: array(bigIntBase),
    lt: bigIntNullable,
    lte: bigIntNullable,
    gt: bigIntNullable,
    gte: bigIntNullable,
  })
);

const bigIntListFilterBase = partial(
  object({
    equals: bigIntList,
    has: bigIntBase,
    hasEvery: array(bigIntBase),
    hasSome: array(bigIntBase),
    isEmpty: boolean(),
  })
);

const bigIntListNullableFilterBase = partial(
  object({
    equals: bigIntListNullable,
    has: bigIntBase,
    hasEvery: array(bigIntBase),
    hasSome: array(bigIntBase),
    isEmpty: boolean(),
  })
);

const bigIntFilter = union([
  extend(bigIntFilterBase, {
    not: optional(union([bigIntFilterBase, shorthandFilter(bigIntBase)])),
  }),
  shorthandFilter(bigIntBase),
]);

const bigIntNullableFilter = union([
  extend(bigIntNullableFilterBase, {
    not: optional(union([bigIntNullableFilterBase, bigIntNullable])),
  }),
  shorthandFilter(bigIntNullable),
]);

const bigIntListFilter = union([
  extend(bigIntListFilterBase, {
    not: optional(union([bigIntListFilterBase, shorthandFilter(bigIntList)])),
  }),
  shorthandFilter(bigIntList),
]);

const bigIntListNullableFilter = union([
  extend(bigIntListNullableFilterBase, {
    not: optional(
      union([bigIntListNullableFilterBase, shorthandFilter(bigIntListNullable)])
    ),
  }),
  shorthandFilter(bigIntListNullable),
]);

// =============================================================================
// CREATE SCHEMAS
// =============================================================================

export const bigIntCreate = bigIntBase;
export const bigIntNullableCreate = _default(optional(bigIntNullable), null);
export const bigIntOptionalCreate = optional(bigIntBase);
export const bigIntOptionalNullableCreate = _default(
  optional(bigIntNullable),
  null
);
export const bigIntListCreate = bigIntList;
export const bigIntListNullableCreate = _default(
  optional(bigIntListNullable),
  null
);
export const bigIntOptionalListCreate = optional(bigIntList);
export const bigIntOptionalListNullableCreate = _default(
  optional(bigIntListNullable),
  null
);

// =============================================================================
// UPDATE SCHEMAS
// =============================================================================

export const bigIntUpdate = union([
  partial(
    object({
      set: bigIntBase,
      increment: bigIntBase,
      decrement: bigIntBase,
      multiply: bigIntBase,
      divide: bigIntBase,
    })
  ),
  shorthandUpdate(bigIntBase),
]);

export const bigIntNullableUpdate = union([
  partial(
    object({
      set: bigIntNullable,
      increment: bigIntBase,
      decrement: bigIntBase,
      multiply: bigIntBase,
      divide: bigIntBase,
    })
  ),
  shorthandUpdate(bigIntNullable),
]);

export const bigIntListUpdate = union([
  partial(
    object({
      set: array(bigIntBase),
      push: union([bigIntBase, array(bigIntBase)]),
      unshift: union([bigIntBase, array(bigIntBase)]),
    })
  ),
  shorthandUpdate(bigIntList),
]);

export const bigIntListNullableUpdate = union([
  partial(
    object({
      set: bigIntListNullable,
      push: union([bigIntBase, bigIntList]),
      unshift: union([bigIntBase, bigIntList]),
    })
  ),
  shorthandUpdate(bigIntListNullable),
]);

// =============================================================================
// SCHEMA FACTORIES
// =============================================================================

export const bigIntSchemas = <Optional extends boolean>(o: Optional) => {
  return {
    base: bigIntBase,
    filter: bigIntFilter,
    create: (o === true
      ? bigIntOptionalCreate
      : bigIntCreate) as Optional extends true
      ? typeof bigIntOptionalCreate
      : typeof bigIntCreate,
    update: bigIntUpdate,
  };
};

export const bigIntNullableSchemas = <Optional extends boolean>(
  o: Optional
) => {
  return {
    base: bigIntNullable,
    filter: bigIntNullableFilter,
    create: (o === true
      ? bigIntOptionalNullableCreate
      : bigIntNullableCreate) as Optional extends true
      ? typeof bigIntOptionalNullableCreate
      : typeof bigIntNullableCreate,
    update: bigIntNullableUpdate,
  };
};

export const bigIntListSchemas = <Optional extends boolean>(o: Optional) => {
  return {
    base: bigIntList,
    filter: bigIntListFilter,
    create: (o === true
      ? bigIntOptionalListCreate
      : bigIntListCreate) as Optional extends true
      ? typeof bigIntOptionalListCreate
      : typeof bigIntListCreate,
    update: bigIntListUpdate,
  };
};

export const bigIntListNullableSchemas = <Optional extends boolean>(
  o: Optional
) => {
  return {
    base: bigIntListNullable,
    filter: bigIntListNullableFilter,
    create: (o === true
      ? bigIntOptionalListNullableCreate
      : bigIntListNullableCreate) as Optional extends true
      ? typeof bigIntOptionalListNullableCreate
      : typeof bigIntListNullableCreate,
    update: bigIntListNullableUpdate,
  };
};

// =============================================================================
// TYPE HELPERS
// =============================================================================

export type BigIntListNullableSchemas<Optional extends boolean = false> =
  ReturnType<typeof bigIntListNullableSchemas<Optional>>;
export type BigIntListSchemas<Optional extends boolean = false> = ReturnType<
  typeof bigIntListSchemas<Optional>
>;
export type BigIntNullableSchemas<Optional extends boolean = false> =
  ReturnType<typeof bigIntNullableSchemas<Optional>>;
export type BigIntSchemas<Optional extends boolean = false> = ReturnType<
  typeof bigIntSchemas<Optional>
>;

export type InferBigIntSchemas<F extends FieldState<"bigint">> =
  F["array"] extends true
    ? F["nullable"] extends true
      ? BigIntListNullableSchemas<isOptional<F>>
      : BigIntListSchemas<isOptional<F>>
    : F["nullable"] extends true
    ? BigIntNullableSchemas<isOptional<F>>
    : BigIntSchemas<isOptional<F>>;

// =============================================================================
// MAIN SCHEMA GETTER
// =============================================================================

export const getFieldBigIntSchemas = <F extends FieldState<"bigint">>(f: F) => {
  const isOpt = f.hasDefault || f.nullable;
  const isArr = f.array;
  return (
    isArr
      ? isOpt
        ? bigIntListNullableSchemas(isOpt)
        : bigIntListSchemas(isOpt)
      : isOpt
      ? bigIntNullableSchemas(isOpt)
      : bigIntSchemas(isOpt)
  ) as InferBigIntSchemas<F>;
};

// =============================================================================
// INPUT TYPE INFERENCE
// =============================================================================

export type InferBigIntInput<
  F extends FieldState<"bigint">,
  Type extends "create" | "update" | "filter"
> = Input<InferBigIntSchemas<F>[Type]>;
