// Boolean Field Schemas
// Follows FIELD_IMPLEMENTATION_GUIDE and mirrors string schema structure

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

export const booleanBase = boolean();
export const booleanNullable = nullable(booleanBase);
export const booleanList = array(booleanBase);
export const booleanListNullable = nullable(booleanList);

// =============================================================================
// FILTER SCHEMAS
// =============================================================================

const booleanFilterBase = partial(
  object({
    equals: booleanBase,
  })
);

const booleanNullableFilterBase = partial(
  object({
    equals: booleanNullable,
  })
);

const booleanListFilterBase = partial(
  object({
    equals: booleanList,
    has: booleanBase,
    hasEvery: array(booleanBase),
    hasSome: array(booleanBase),
    isEmpty: boolean(),
  })
);

const booleanListNullableFilterBase = partial(
  object({
    equals: booleanListNullable,
    has: booleanBase,
    hasEvery: array(booleanBase),
    hasSome: array(booleanBase),
    isEmpty: boolean(),
  })
);

const booleanFilter = union([
  extend(booleanFilterBase, {
    not: optional(union([booleanFilterBase, shorthandFilter(booleanBase)])),
  }),
  shorthandFilter(booleanBase),
]);

const booleanNullableFilter = union([
  extend(booleanNullableFilterBase, {
    not: optional(union([booleanNullableFilterBase, booleanNullable])),
  }),
  shorthandFilter(booleanNullable),
]);

const booleanListFilter = union([
  extend(booleanListFilterBase, {
    not: optional(union([booleanListFilterBase, shorthandFilter(booleanList)])),
  }),
  shorthandFilter(booleanList),
]);

const booleanListNullableFilter = union([
  extend(booleanListNullableFilterBase, {
    not: optional(
      union([
        booleanListNullableFilterBase,
        shorthandFilter(booleanListNullable),
      ])
    ),
  }),
  shorthandFilter(booleanListNullable),
]);

// =============================================================================
// CREATE SCHEMAS
// =============================================================================

export const booleanCreate = booleanBase;
export const booleanNullableCreate = _default(optional(booleanNullable), null);
export const booleanOptionalCreate = optional(booleanBase);
export const booleanOptionalNullableCreate = _default(
  optional(booleanNullable),
  null
);
// List creates
export const booleanListCreate = booleanList;
export const booleanListNullableCreate = _default(
  optional(booleanListNullable),
  null
);
export const booleanOptionalListCreate = optional(booleanList);
export const booleanOptionalListNullableCreate = _default(
  optional(booleanListNullable),
  null
);

// =============================================================================
// UPDATE SCHEMAS
// =============================================================================

export const booleanUpdate = union([
  partial(object({ set: booleanBase })),
  shorthandUpdate(booleanBase),
]);

export const booleanNullableUpdate = union([
  partial(object({ set: booleanNullable })),
  shorthandUpdate(booleanNullable),
]);

export const booleanListUpdate = union([
  partial(
    object({
      set: array(booleanBase),
      push: union([booleanBase, array(booleanBase)]),
      unshift: union([booleanBase, array(booleanBase)]),
    })
  ),
  shorthandUpdate(booleanList),
]);

export const booleanListNullableUpdate = union([
  partial(
    object({
      set: booleanListNullable,
      push: union([booleanBase, booleanList]),
      unshift: union([booleanBase, booleanList]),
    })
  ),
  shorthandUpdate(booleanListNullable),
]);

// =============================================================================
// SCHEMA FACTORIES
// =============================================================================

export const booleanSchemas = <Optional extends boolean>(o: Optional) => {
  return {
    base: booleanBase,
    filter: booleanFilter,
    create: (o === true
      ? booleanOptionalCreate
      : booleanCreate) as Optional extends true
      ? typeof booleanOptionalCreate
      : typeof booleanCreate,
    update: booleanUpdate,
  };
};

export const booleanNullableSchemas = <Optional extends boolean>(
  o: Optional
) => {
  return {
    base: booleanNullable,
    filter: booleanNullableFilter,
    create: (o === true
      ? booleanOptionalNullableCreate
      : booleanNullableCreate) as Optional extends true
      ? typeof booleanOptionalNullableCreate
      : typeof booleanNullableCreate,
    update: booleanNullableUpdate,
  };
};

export const booleanListSchemas = <Optional extends boolean>(o: Optional) => {
  return {
    base: booleanList,
    filter: booleanListFilter,
    create: (o === true
      ? booleanOptionalListCreate
      : booleanListCreate) as Optional extends true
      ? typeof booleanOptionalListCreate
      : typeof booleanListCreate,
    update: booleanListUpdate,
  };
};

export const booleanListNullableSchemas = <Optional extends boolean>(
  o: Optional
) => {
  return {
    base: booleanListNullable,
    filter: booleanListNullableFilter,
    create: (o === true
      ? booleanOptionalListNullableCreate
      : booleanListNullableCreate) as Optional extends true
      ? typeof booleanOptionalListNullableCreate
      : typeof booleanListNullableCreate,
    update: booleanListNullableUpdate,
  };
};

// =============================================================================
// TYPE HELPERS
// =============================================================================

export type BooleanListNullableSchemas<Optional extends boolean = false> =
  ReturnType<typeof booleanListNullableSchemas<Optional>>;

export type BooleanListSchemas<Optional extends boolean = false> = ReturnType<
  typeof booleanListSchemas<Optional>
>;

export type BooleanNullableSchemas<Optional extends boolean = false> =
  ReturnType<typeof booleanNullableSchemas<Optional>>;

export type BooleanSchemas<Optional extends boolean = false> = ReturnType<
  typeof booleanSchemas<Optional>
>;

export type InferBooleanSchemas<F extends FieldState<"boolean">> =
  F["array"] extends true
    ? F["nullable"] extends true
      ? BooleanListNullableSchemas<isOptional<F>>
      : BooleanListSchemas<isOptional<F>>
    : F["nullable"] extends true
    ? BooleanNullableSchemas<isOptional<F>>
    : BooleanSchemas<isOptional<F>>;

// =============================================================================
// MAIN SCHEMA GETTER
// =============================================================================

export const getFieldBooleanSchemas = <F extends FieldState<"boolean">>(
  f: F
) => {
  const isOptional = f.hasDefault || f.nullable;
  const isArray = f.array;
  return (
    isArray
      ? isOptional
        ? booleanListNullableSchemas(isOptional)
        : booleanListSchemas(isOptional)
      : isOptional
      ? booleanNullableSchemas(isOptional)
      : booleanSchemas(isOptional)
  ) as InferBooleanSchemas<F>;
};

// =============================================================================
// INPUT TYPE INFERENCE
// =============================================================================

export type InferBooleanInput<
  F extends FieldState<"boolean">,
  Type extends "create" | "update" | "filter"
> = Input<InferBooleanSchemas<F>[Type]>;
