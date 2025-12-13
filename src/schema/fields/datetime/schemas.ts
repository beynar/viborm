// DateTime Field Schemas
// Follows FIELD_IMPLEMENTATION_GUIDE and mirrors string/boolean schema structure

import {
  array,
  boolean,
  nullable,
  object,
  optional,
  partial,
  union,
  type input as Input,
  extend,
  _default,
  iso,
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

export const datetimeBase = iso.datetime();
export const datetimeNullable = nullable(datetimeBase);
export const datetimeList = array(datetimeBase);
export const datetimeListNullable = nullable(datetimeList);

// =============================================================================
// FILTER BASE SCHEMAS (without `not` - used for recursion)
// =============================================================================

const datetimeFilterBase = partial(
  object({
    equals: datetimeBase,
    in: array(datetimeBase),
    notIn: array(datetimeBase),
    lt: datetimeBase,
    lte: datetimeBase,
    gt: datetimeBase,
    gte: datetimeBase,
  })
);

const datetimeNullableFilterBase = partial(
  object({
    equals: datetimeNullable,
    in: array(datetimeBase),
    notIn: array(datetimeBase),
    lt: datetimeNullable,
    lte: datetimeNullable,
    gt: datetimeNullable,
    gte: datetimeNullable,
  })
);

const datetimeListFilterBase = partial(
  object({
    equals: datetimeList,
    has: datetimeBase,
    hasEvery: array(datetimeBase),
    hasSome: array(datetimeBase),
    isEmpty: boolean(),
  })
);

const datetimeListNullableFilterBase = partial(
  object({
    equals: datetimeListNullable,
    has: datetimeBase,
    hasEvery: array(datetimeBase),
    hasSome: array(datetimeBase),
    isEmpty: boolean(),
  })
);

// =============================================================================
// FILTER SCHEMAS (with `not` and shorthand normalization)
// =============================================================================

const datetimeFilter = union([
  extend(datetimeFilterBase, {
    not: optional(union([datetimeFilterBase, shorthandFilter(datetimeBase)])),
  }),
  shorthandFilter(datetimeBase),
]);

const datetimeNullableFilter = union([
  extend(datetimeNullableFilterBase, {
    not: optional(
      union([datetimeNullableFilterBase, shorthandFilter(datetimeNullable)])
    ),
  }),
  shorthandFilter(datetimeNullable),
]);

const datetimeListFilter = union([
  extend(datetimeListFilterBase, {
    not: optional(
      union([datetimeListFilterBase, shorthandFilter(datetimeList)])
    ),
  }),
  shorthandFilter(datetimeList),
]);

const datetimeListNullableFilter = union([
  extend(datetimeListNullableFilterBase, {
    not: optional(
      union([
        datetimeListNullableFilterBase,
        shorthandFilter(datetimeListNullable),
      ])
    ),
  }),
  shorthandFilter(datetimeListNullable),
]);

// =============================================================================
// CREATE SCHEMAS
// =============================================================================

export const datetimeCreate = datetimeBase;
export const datetimeNullableCreate = _default(
  optional(datetimeNullable),
  null
);
export const datetimeOptionalCreate = optional(datetimeBase);
export const datetimeOptionalNullableCreate = _default(
  optional(datetimeNullable),
  null
);

// List creates
export const datetimeListCreate = datetimeList;
export const datetimeListNullableCreate = _default(
  optional(datetimeListNullable),
  null
);
export const datetimeOptionalListCreate = optional(datetimeList);
export const datetimeOptionalListNullableCreate = _default(
  optional(datetimeListNullable),
  null
);

// =============================================================================
// UPDATE SCHEMAS
// =============================================================================

export const datetimeUpdate = union([
  partial(object({ set: datetimeBase })),
  shorthandUpdate(datetimeBase),
]);

export const datetimeNullableUpdate = union([
  partial(object({ set: datetimeNullable })),
  shorthandUpdate(datetimeNullable),
]);

export const datetimeListUpdate = union([
  partial(
    object({
      set: array(datetimeBase),
      push: union([datetimeBase, array(datetimeBase)]),
      unshift: union([datetimeBase, array(datetimeBase)]),
    })
  ),
  shorthandUpdate(datetimeList),
]);

export const datetimeListNullableUpdate = union([
  partial(
    object({
      set: datetimeListNullable,
      push: union([datetimeBase, datetimeList]),
      unshift: union([datetimeBase, datetimeList]),
    })
  ),
  shorthandUpdate(datetimeListNullable),
]);

// =============================================================================
// SCHEMA FACTORY FUNCTIONS
// =============================================================================

export const datetimeSchemas = <Optional extends boolean>(o: Optional) => {
  return {
    base: datetimeBase,
    filter: datetimeFilter,
    create: (o === true
      ? datetimeOptionalCreate
      : datetimeCreate) as Optional extends true
      ? typeof datetimeOptionalCreate
      : typeof datetimeCreate,
    update: datetimeUpdate,
  };
};

export const datetimeNullableSchemas = <Optional extends boolean>(
  o: Optional
) => {
  return {
    base: datetimeNullable,
    filter: datetimeNullableFilter,
    create: (o === true
      ? datetimeOptionalNullableCreate
      : datetimeNullableCreate) as Optional extends true
      ? typeof datetimeOptionalNullableCreate
      : typeof datetimeNullableCreate,
    update: datetimeNullableUpdate,
  };
};

export const datetimeListSchemas = <Optional extends boolean>(o: Optional) => {
  return {
    base: datetimeList,
    filter: datetimeListFilter,
    create: (o === true
      ? datetimeOptionalListCreate
      : datetimeListCreate) as Optional extends true
      ? typeof datetimeOptionalListCreate
      : typeof datetimeListCreate,
    update: datetimeListUpdate,
  };
};

export const datetimeListNullableSchemas = <Optional extends boolean>(
  o: Optional
) => {
  return {
    base: datetimeListNullable,
    filter: datetimeListNullableFilter,
    create: (o === true
      ? datetimeOptionalListNullableCreate
      : datetimeListNullableCreate) as Optional extends true
      ? typeof datetimeOptionalListNullableCreate
      : typeof datetimeListNullableCreate,
    update: datetimeListNullableUpdate,
  };
};

// =============================================================================
// TYPE HELPERS
// =============================================================================

export type DateTimeListNullableSchemas<Optional extends boolean = false> =
  ReturnType<typeof datetimeListNullableSchemas<Optional>>;

export type DateTimeListSchemas<Optional extends boolean = false> = ReturnType<
  typeof datetimeListSchemas<Optional>
>;

export type DateTimeNullableSchemas<Optional extends boolean = false> =
  ReturnType<typeof datetimeNullableSchemas<Optional>>;

export type DateTimeSchemas<Optional extends boolean = false> = ReturnType<
  typeof datetimeSchemas<Optional>
>;

export type InferDateTimeSchemas<F extends FieldState<"datetime">> =
  F["array"] extends true
    ? F["nullable"] extends true
      ? DateTimeListNullableSchemas<isOptional<F>>
      : DateTimeListSchemas<isOptional<F>>
    : F["nullable"] extends true
    ? DateTimeNullableSchemas<isOptional<F>>
    : DateTimeSchemas<isOptional<F>>;

// =============================================================================
// MAIN SCHEMA GETTER
// =============================================================================

export const getFieldDateTimeSchemas = <F extends FieldState<"datetime">>(
  f: F
) => {
  const isOpt = f.hasDefault || f.nullable;
  const isArr = f.array;
  return (
    isArr
      ? isOpt
        ? datetimeListNullableSchemas(isOpt)
        : datetimeListSchemas(isOpt)
      : isOpt
      ? datetimeNullableSchemas(isOpt)
      : datetimeSchemas(isOpt)
  ) as InferDateTimeSchemas<F>;
};

// =============================================================================
// INPUT TYPE INFERENCE
// =============================================================================

export type InferDateTimeInput<
  F extends FieldState<"datetime">,
  Type extends "create" | "update" | "filter"
> = Input<InferDateTimeSchemas<F>[Type]>;
