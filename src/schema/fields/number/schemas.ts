// Number Field Schemas (int, float, decimal)
// Follows FIELD_IMPLEMENTATION_GUIDE and mirrors string/boolean patterns

import {
  array,
  boolean,
  number,
  nullable,
  object,
  optional,
  partial,
  refine,
  union,
  _default,
  extend,
  type input as Input,
  int,
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

export const intBase = int();
export const intNullable = nullable(intBase);
export const intList = array(intBase);
export const intListNullable = nullable(intList);

export const floatBase = number();
export const floatNullable = nullable(floatBase);
export const floatList = array(floatBase);
export const floatListNullable = nullable(floatList);

// Decimal reuses float schemas
export const decimalBase = floatBase;
export const decimalNullable = floatNullable;
export const decimalList = floatList;
export const decimalListNullable = floatListNullable;

// =============================================================================
// FILTER SCHEMAS
// =============================================================================

const intFilterBase = partial(
  object({
    equals: intBase,
    in: array(intBase),
    notIn: array(intBase),
    lt: intBase,
    lte: intBase,
    gt: intBase,
    gte: intBase,
  })
);

const intNullableFilterBase = partial(
  object({
    equals: intNullable,
    in: array(intBase),
    notIn: array(intBase),
    lt: intNullable,
    lte: intNullable,
    gt: intNullable,
    gte: intNullable,
  })
);

const intListFilterBase = partial(
  object({
    equals: intList,
    has: intBase,
    hasEvery: array(intBase),
    hasSome: array(intBase),
    isEmpty: boolean(),
  })
);

const intListNullableFilterBase = partial(
  object({
    equals: intListNullable,
    has: intBase,
    hasEvery: array(intBase),
    hasSome: array(intBase),
    isEmpty: boolean(),
  })
);

const intFilter = union([
  extend(intFilterBase, {
    not: optional(union([intFilterBase, shorthandFilter(intBase)])),
  }),
  shorthandFilter(intBase),
]);

const intNullableFilter = union([
  extend(intNullableFilterBase, {
    not: optional(union([intNullableFilterBase, intNullable])),
  }),
  shorthandFilter(intNullable),
]);

const intListFilter = union([
  extend(intListFilterBase, {
    not: optional(union([intListFilterBase, shorthandFilter(intList)])),
  }),
  shorthandFilter(intList),
]);

const intListNullableFilter = union([
  extend(intListNullableFilterBase, {
    not: optional(
      union([intListNullableFilterBase, shorthandFilter(intListNullable)])
    ),
  }),
  shorthandFilter(intListNullable),
]);

const floatFilterBase = partial(
  object({
    equals: floatBase,
    in: array(floatBase),
    notIn: array(floatBase),
    lt: floatBase,
    lte: floatBase,
    gt: floatBase,
    gte: floatBase,
  })
);

const floatNullableFilterBase = partial(
  object({
    equals: floatNullable,
    in: array(floatBase),
    notIn: array(floatBase),
    lt: floatNullable,
    lte: floatNullable,
    gt: floatNullable,
    gte: floatNullable,
  })
);

const floatListFilterBase = partial(
  object({
    equals: floatList,
    has: floatBase,
    hasEvery: array(floatBase),
    hasSome: array(floatBase),
    isEmpty: boolean(),
  })
);

const floatListNullableFilterBase = partial(
  object({
    equals: floatListNullable,
    has: floatBase,
    hasEvery: array(floatBase),
    hasSome: array(floatBase),
    isEmpty: boolean(),
  })
);

const floatFilter = union([
  extend(floatFilterBase, {
    not: optional(union([floatFilterBase, shorthandFilter(floatBase)])),
  }),
  shorthandFilter(floatBase),
]);

const floatNullableFilter = union([
  extend(floatNullableFilterBase, {
    not: optional(union([floatNullableFilterBase, floatNullable])),
  }),
  shorthandFilter(floatNullable),
]);

const floatListFilter = union([
  extend(floatListFilterBase, {
    not: optional(union([floatListFilterBase, shorthandFilter(floatList)])),
  }),
  shorthandFilter(floatList),
]);

const floatListNullableFilter = union([
  extend(floatListNullableFilterBase, {
    not: optional(
      union([floatListNullableFilterBase, shorthandFilter(floatListNullable)])
    ),
  }),
  shorthandFilter(floatListNullable),
]);

// Decimal filters reuse float filters
const decimalFilter = floatFilter;
const decimalNullableFilter = floatNullableFilter;
const decimalListFilter = floatListFilter;
const decimalListNullableFilter = floatListNullableFilter;

// =============================================================================
// CREATE SCHEMAS
// =============================================================================

export const intCreate = intBase;
export const intNullableCreate = _default(optional(intNullable), null);
export const intOptionalCreate = optional(intBase);
export const intOptionalNullableCreate = _default(optional(intNullable), null);
export const intListCreate = intList;
export const intListNullableCreate = _default(optional(intListNullable), null);
export const intOptionalListCreate = optional(intList);
export const intOptionalListNullableCreate = _default(
  optional(intListNullable),
  null
);

export const floatCreate = floatBase;
export const floatNullableCreate = _default(optional(floatNullable), null);
export const floatOptionalCreate = optional(floatBase);
export const floatOptionalNullableCreate = _default(
  optional(floatNullable),
  null
);
export const floatListCreate = floatList;
export const floatListNullableCreate = _default(
  optional(floatListNullable),
  null
);
export const floatOptionalListCreate = optional(floatList);
export const floatOptionalListNullableCreate = _default(
  optional(floatListNullable),
  null
);

// Decimal creates reuse float creates
export const decimalCreate = floatCreate;
export const decimalNullableCreate = floatNullableCreate;
export const decimalOptionalCreate = floatOptionalCreate;
export const decimalOptionalNullableCreate = floatOptionalNullableCreate;
export const decimalListCreate = floatListCreate;
export const decimalListNullableCreate = floatListNullableCreate;
export const decimalOptionalListCreate = floatOptionalListCreate;
export const decimalOptionalListNullableCreate =
  floatOptionalListNullableCreate;

// =============================================================================
// UPDATE SCHEMAS
// =============================================================================

export const intUpdate = union([
  partial(
    object({
      set: intBase,
      increment: intBase,
      decrement: intBase,
      multiply: intBase,
      divide: intBase,
    })
  ),
  shorthandUpdate(intBase),
]);

export const intNullableUpdate = union([
  partial(
    object({
      set: intNullable,
      increment: intBase,
      decrement: intBase,
      multiply: intBase,
      divide: intBase,
    })
  ),
  shorthandUpdate(intNullable),
]);

export const intListUpdate = union([
  partial(
    object({
      set: array(intBase),
      push: union([intBase, array(intBase)]),
      unshift: union([intBase, array(intBase)]),
    })
  ),
  shorthandUpdate(intList),
]);

export const intListNullableUpdate = union([
  partial(
    object({
      set: intListNullable,
      push: union([intBase, intList]),
      unshift: union([intBase, intList]),
    })
  ),
  shorthandUpdate(intListNullable),
]);

export const floatUpdate = union([
  partial(
    object({
      set: floatBase,
      increment: floatBase,
      decrement: floatBase,
      multiply: floatBase,
      divide: floatBase,
    })
  ),
  shorthandUpdate(floatBase),
]);

export const floatNullableUpdate = union([
  partial(
    object({
      set: floatNullable,
      increment: floatBase,
      decrement: floatBase,
      multiply: floatBase,
      divide: floatBase,
    })
  ),
  shorthandUpdate(floatNullable),
]);

export const floatListUpdate = union([
  partial(
    object({
      set: array(floatBase),
      push: union([floatBase, array(floatBase)]),
      unshift: union([floatBase, array(floatBase)]),
    })
  ),
  shorthandUpdate(floatList),
]);

export const floatListNullableUpdate = union([
  partial(
    object({
      set: floatListNullable,
      push: union([floatBase, floatList]),
      unshift: union([floatBase, floatList]),
    })
  ),
  shorthandUpdate(floatListNullable),
]);

// Decimal updates reuse float updates
export const decimalUpdate = floatUpdate;
export const decimalNullableUpdate = floatNullableUpdate;
export const decimalListUpdate = floatListUpdate;
export const decimalListNullableUpdate = floatListNullableUpdate;

// =============================================================================
// SCHEMA FACTORIES
// =============================================================================

export const intSchemas = <Optional extends boolean>(o: Optional) => {
  return {
    base: intBase,
    filter: intFilter,
    create: (o === true
      ? intOptionalCreate
      : intCreate) as Optional extends true
      ? typeof intOptionalCreate
      : typeof intCreate,
    update: intUpdate,
  };
};

export const intNullableSchemas = <Optional extends boolean>(o: Optional) => {
  return {
    base: intNullable,
    filter: intNullableFilter,
    create: (o === true
      ? intOptionalNullableCreate
      : intNullableCreate) as Optional extends true
      ? typeof intOptionalNullableCreate
      : typeof intNullableCreate,
    update: intNullableUpdate,
  };
};

export const intListSchemas = <Optional extends boolean>(o: Optional) => {
  return {
    base: intList,
    filter: intListFilter,
    create: (o === true
      ? intOptionalListCreate
      : intListCreate) as Optional extends true
      ? typeof intOptionalListCreate
      : typeof intListCreate,
    update: intListUpdate,
  };
};

export const intListNullableSchemas = <Optional extends boolean>(
  o: Optional
) => {
  return {
    base: intListNullable,
    filter: intListNullableFilter,
    create: (o === true
      ? intOptionalListNullableCreate
      : intListNullableCreate) as Optional extends true
      ? typeof intOptionalListNullableCreate
      : typeof intListNullableCreate,
    update: intListNullableUpdate,
  };
};

export const floatSchemas = <Optional extends boolean>(o: Optional) => {
  return {
    base: floatBase,
    filter: floatFilter,
    create: (o === true
      ? floatOptionalCreate
      : floatCreate) as Optional extends true
      ? typeof floatOptionalCreate
      : typeof floatCreate,
    update: floatUpdate,
  };
};

export const floatNullableSchemas = <Optional extends boolean>(o: Optional) => {
  return {
    base: floatNullable,
    filter: floatNullableFilter,
    create: (o === true
      ? floatOptionalNullableCreate
      : floatNullableCreate) as Optional extends true
      ? typeof floatOptionalNullableCreate
      : typeof floatNullableCreate,
    update: floatNullableUpdate,
  };
};

export const floatListSchemas = <Optional extends boolean>(o: Optional) => {
  return {
    base: floatList,
    filter: floatListFilter,
    create: (o === true
      ? floatOptionalListCreate
      : floatListCreate) as Optional extends true
      ? typeof floatOptionalListCreate
      : typeof floatListCreate,
    update: floatListUpdate,
  };
};

export const floatListNullableSchemas = <Optional extends boolean>(
  o: Optional
) => {
  return {
    base: floatListNullable,
    filter: floatListNullableFilter,
    create: (o === true
      ? floatOptionalListNullableCreate
      : floatListNullableCreate) as Optional extends true
      ? typeof floatOptionalListNullableCreate
      : typeof floatListNullableCreate,
    update: floatListNullableUpdate,
  };
};

// Decimal factories reuse float factories
export const decimalSchemas = <Optional extends boolean>(o: Optional) =>
  floatSchemas(o);
export const decimalNullableSchemas = <Optional extends boolean>(o: Optional) =>
  floatNullableSchemas(o);
export const decimalListSchemas = <Optional extends boolean>(o: Optional) =>
  floatListSchemas(o);
export const decimalListNullableSchemas = <Optional extends boolean>(
  o: Optional
) => floatListNullableSchemas(o);

// =============================================================================
// TYPE HELPERS
// =============================================================================

export type IntListNullableSchemas<Optional extends boolean = false> =
  ReturnType<typeof intListNullableSchemas<Optional>>;
export type IntListSchemas<Optional extends boolean = false> = ReturnType<
  typeof intListSchemas<Optional>
>;
export type IntNullableSchemas<Optional extends boolean = false> = ReturnType<
  typeof intNullableSchemas<Optional>
>;
export type IntSchemas<Optional extends boolean = false> = ReturnType<
  typeof intSchemas<Optional>
>;

export type FloatListNullableSchemas<Optional extends boolean = false> =
  ReturnType<typeof floatListNullableSchemas<Optional>>;
export type FloatListSchemas<Optional extends boolean = false> = ReturnType<
  typeof floatListSchemas<Optional>
>;
export type FloatNullableSchemas<Optional extends boolean = false> = ReturnType<
  typeof floatNullableSchemas<Optional>
>;
export type FloatSchemas<Optional extends boolean = false> = ReturnType<
  typeof floatSchemas<Optional>
>;

export type DecimalListNullableSchemas<Optional extends boolean = false> =
  ReturnType<typeof decimalListNullableSchemas<Optional>>;
export type DecimalListSchemas<Optional extends boolean = false> = ReturnType<
  typeof decimalListSchemas<Optional>
>;
export type DecimalNullableSchemas<Optional extends boolean = false> =
  ReturnType<typeof decimalNullableSchemas<Optional>>;
export type DecimalSchemas<Optional extends boolean = false> = ReturnType<
  typeof decimalSchemas<Optional>
>;

export type InferIntSchemas<F extends FieldState<"int">> =
  F["array"] extends true
    ? F["nullable"] extends true
      ? IntListNullableSchemas<isOptional<F>>
      : IntListSchemas<isOptional<F>>
    : F["nullable"] extends true
    ? IntNullableSchemas<isOptional<F>>
    : IntSchemas<isOptional<F>>;

export type InferFloatSchemas<F extends FieldState<"float">> =
  F["array"] extends true
    ? F["nullable"] extends true
      ? FloatListNullableSchemas<isOptional<F>>
      : FloatListSchemas<isOptional<F>>
    : F["nullable"] extends true
    ? FloatNullableSchemas<isOptional<F>>
    : FloatSchemas<isOptional<F>>;

export type InferDecimalSchemas<F extends FieldState<"decimal">> =
  InferFloatSchemas<F & FieldState<"float">>;

// =============================================================================
// MAIN SCHEMA GETTERS
// =============================================================================

export const getFieldIntSchemas = <F extends FieldState<"int">>(f: F) => {
  const isOpt = f.hasDefault || f.nullable;
  const isArr = f.array;
  return (
    isArr
      ? isOpt
        ? intListNullableSchemas(isOpt)
        : intListSchemas(isOpt)
      : isOpt
      ? intNullableSchemas(isOpt)
      : intSchemas(isOpt)
  ) as InferIntSchemas<F>;
};

export const getFieldFloatSchemas = <F extends FieldState<"float">>(f: F) => {
  const isOpt = f.hasDefault || f.nullable;
  const isArr = f.array;
  return (
    isArr
      ? isOpt
        ? floatListNullableSchemas(isOpt)
        : floatListSchemas(isOpt)
      : isOpt
      ? floatNullableSchemas(isOpt)
      : floatSchemas(isOpt)
  ) as InferFloatSchemas<F>;
};

export const getFieldDecimalSchemas = <F extends FieldState<"decimal">>(f: F) =>
  getFieldFloatSchemas(f as F & FieldState<"float">) as InferDecimalSchemas<F>;

// =============================================================================
// INPUT TYPE INFERENCE
// =============================================================================

export type InferIntInput<
  F extends FieldState<"int">,
  Type extends "create" | "update" | "filter"
> = Input<InferIntSchemas<F>[Type]>;

export type InferFloatInput<
  F extends FieldState<"float">,
  Type extends "create" | "update" | "filter"
> = Input<InferFloatSchemas<F>[Type]>;

export type InferDecimalInput<
  F extends FieldState<"decimal">,
  Type extends "create" | "update" | "filter"
> = Input<InferDecimalSchemas<F>[Type]>;
