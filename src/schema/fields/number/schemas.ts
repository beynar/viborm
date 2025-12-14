// Number Field Schemas (int, float, decimal)
// Factory pattern for number field variants following the string/boolean/datetime schema structure

import {
  array,
  boolean,
  number,
  nullable,
  object,
  optional,
  partial,
  union,
  InferInput,
  NullableSchema,
  ArraySchema,
  pipe,
  integer,
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

export const intBase = pipe(number(), integer());
export const intNullable = nullable(intBase);
export const intList = array(intBase);
export const intListNullable = nullable(intList);

export const floatBase = number();
export const floatNullable = nullable(floatBase);
export const floatList = array(floatBase);
export const floatListNullable = nullable(floatList);

// Decimal reuses float base (same runtime behavior)
export const decimalBase = floatBase;
export const decimalNullable = floatNullable;
export const decimalList = floatList;
export const decimalListNullable = floatListNullable;

// =============================================================================
// INT FILTER SCHEMAS
// =============================================================================

const intFilterBase = partial(
  object({
    equals: intBase,
    in: intList,
    notIn: intList,
    lt: intBase,
    lte: intBase,
    gt: intBase,
    gte: intBase,
  })
);

const intNullableFilterBase = partial(
  object({
    equals: intNullable,
    in: intList,
    notIn: intList,
    lt: intNullable,
    lte: intNullable,
    gt: intNullable,
    gte: intNullable,
  })
);

const intArrayFilterBase = partial(
  object({
    equals: intList,
    has: intBase,
    hasEvery: intList,
    hasSome: intList,
    isEmpty: boolean(),
  })
);

const intNullableListFilterBase = partial(
  object({
    equals: intListNullable,
    has: intBase,
    hasEvery: intList,
    hasSome: intList,
    isEmpty: boolean(),
  })
);

const intFilter = union([
  shorthandFilter(intBase),
  extend(intFilterBase, {
    not: optional(union([shorthandFilter(intBase), intFilterBase])),
  }),
]);

const intNullableFilter = union([
  shorthandFilter(intNullable),
  extend(intNullableFilterBase, {
    not: optional(union([shorthandFilter(intNullable), intNullableFilterBase])),
  }),
]);

const intListFilter = union([
  shorthandFilter(intList),
  extend(intArrayFilterBase, {
    not: optional(union([shorthandFilter(intList), intArrayFilterBase])),
  }),
]);

const intListNullableFilter = union([
  shorthandFilter(intListNullable),
  extend(intNullableListFilterBase, {
    not: optional(
      union([shorthandFilter(intListNullable), intNullableListFilterBase])
    ),
  }),
]);

// =============================================================================
// FLOAT FILTER SCHEMAS
// =============================================================================

const floatFilterBase = partial(
  object({
    equals: floatBase,
    in: floatList,
    notIn: floatList,
    lt: floatBase,
    lte: floatBase,
    gt: floatBase,
    gte: floatBase,
  })
);

const floatNullableFilterBase = partial(
  object({
    equals: floatNullable,
    in: floatList,
    notIn: floatList,
    lt: floatNullable,
    lte: floatNullable,
    gt: floatNullable,
    gte: floatNullable,
  })
);

const floatArrayFilterBase = partial(
  object({
    equals: floatList,
    has: floatBase,
    hasEvery: floatList,
    hasSome: floatList,
    isEmpty: boolean(),
  })
);

const floatNullableListFilterBase = partial(
  object({
    equals: floatListNullable,
    has: floatBase,
    hasEvery: floatList,
    hasSome: floatList,
    isEmpty: boolean(),
  })
);

const floatFilter = union([
  shorthandFilter(floatBase),
  extend(floatFilterBase, {
    not: optional(union([shorthandFilter(floatBase), floatFilterBase])),
  }),
]);

const floatNullableFilter = union([
  shorthandFilter(floatNullable),
  extend(floatNullableFilterBase, {
    not: optional(
      union([shorthandFilter(floatNullable), floatNullableFilterBase])
    ),
  }),
]);

const floatListFilter = union([
  shorthandFilter(floatList),
  extend(floatArrayFilterBase, {
    not: optional(union([shorthandFilter(floatList), floatArrayFilterBase])),
  }),
]);

const floatListNullableFilter = union([
  shorthandFilter(floatListNullable),
  extend(floatNullableListFilterBase, {
    not: optional(
      union([shorthandFilter(floatListNullable), floatNullableListFilterBase])
    ),
  }),
]);

// Decimal filters reuse float filters
const decimalFilter = floatFilter;
const decimalNullableFilter = floatNullableFilter;
const decimalListFilter = floatListFilter;
const decimalListNullableFilter = floatListNullableFilter;

// =============================================================================
// INT UPDATE FACTORIES
// =============================================================================

const intUpdateFactory = <S extends AnySchema>(base: S) =>
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

const intNullableUpdateFactory = <S extends AnySchema>(base: S) =>
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

const intListUpdateFactory = <S extends AnySchema>(base: S) =>
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

const intListNullableUpdateFactory = <S extends AnySchema>(base: S) =>
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

// Float/Decimal update factories reuse int factories (same operations)
const floatUpdateFactory = intUpdateFactory;
const floatNullableUpdateFactory = intNullableUpdateFactory;
const floatListUpdateFactory = intListUpdateFactory;
const floatListNullableUpdateFactory = intListNullableUpdateFactory;

// =============================================================================
// INT SCHEMA BUILDERS
// =============================================================================

export const intSchemas = <const F extends FieldState<"int">>(f: F) => {
  return {
    base: f.base,
    filter: intFilter,
    create: createWithDefault(f, f.base),
    update: intUpdateFactory(f.base),
  } as unknown as IntSchemas<F>;
};

type IntSchemas<F extends FieldState<"int">> = {
  base: F["base"];
  filter: typeof intFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof intUpdateFactory<F["base"]>>;
};

export const intNullableSchemas = <F extends FieldState<"int">>(f: F) => {
  return {
    base: nullable(f.base),
    filter: intNullableFilter,
    create: createWithDefault(f, nullable(f.base)),
    update: intNullableUpdateFactory(f.base),
  } as unknown as IntNullableSchemas<F>;
};

type IntNullableSchemas<F extends FieldState<"int">> = {
  base: NullableSchema<F["base"], undefined>;
  filter: typeof intNullableFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof intNullableUpdateFactory<F["base"]>>;
};

export const intListSchemas = <F extends FieldState<"int">>(f: F) => {
  return {
    base: array(f.base),
    filter: intListFilter,
    create: createWithDefault(f, array(f.base)),
    update: intListUpdateFactory(f.base),
  } as unknown as IntListSchemas<F>;
};

type IntListSchemas<F extends FieldState<"int">> = {
  base: ArraySchema<F["base"], undefined>;
  filter: typeof intListFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof intListUpdateFactory<F["base"]>>;
};

export const intListNullableSchemas = <F extends FieldState<"int">>(f: F) => {
  return {
    base: nullable(array(f.base)),
    filter: intListNullableFilter,
    create: createWithDefault(f, nullable(array(f.base))),
    update: intListNullableUpdateFactory(f.base),
  } as unknown as IntListNullableSchemas<F>;
};

type IntListNullableSchemas<F extends FieldState<"int">> = {
  base: NullableSchema<ArraySchema<F["base"], undefined>, undefined>;
  filter: typeof intListNullableFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof intListNullableUpdateFactory<F["base"]>>;
};

// =============================================================================
// FLOAT SCHEMA BUILDERS
// =============================================================================

export const floatSchemas = <const F extends FieldState<"float">>(f: F) => {
  return {
    base: f.base,
    filter: floatFilter,
    create: createWithDefault(f, f.base),
    update: floatUpdateFactory(f.base),
  } as unknown as FloatSchemas<F>;
};

type FloatSchemas<F extends FieldState<"float">> = {
  base: F["base"];
  filter: typeof floatFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof floatUpdateFactory<F["base"]>>;
};

export const floatNullableSchemas = <F extends FieldState<"float">>(f: F) => {
  return {
    base: nullable(f.base),
    filter: floatNullableFilter,
    create: createWithDefault(f, nullable(f.base)),
    update: floatNullableUpdateFactory(f.base),
  } as unknown as FloatNullableSchemas<F>;
};

type FloatNullableSchemas<F extends FieldState<"float">> = {
  base: NullableSchema<F["base"], undefined>;
  filter: typeof floatNullableFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof floatNullableUpdateFactory<F["base"]>>;
};

export const floatListSchemas = <F extends FieldState<"float">>(f: F) => {
  return {
    base: array(f.base),
    filter: floatListFilter,
    create: createWithDefault(f, array(f.base)),
    update: floatListUpdateFactory(f.base),
  } as unknown as FloatListSchemas<F>;
};

type FloatListSchemas<F extends FieldState<"float">> = {
  base: ArraySchema<F["base"], undefined>;
  filter: typeof floatListFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof floatListUpdateFactory<F["base"]>>;
};

export const floatListNullableSchemas = <F extends FieldState<"float">>(
  f: F
) => {
  return {
    base: nullable(array(f.base)),
    filter: floatListNullableFilter,
    create: createWithDefault(f, nullable(array(f.base))),
    update: floatListNullableUpdateFactory(f.base),
  } as unknown as FloatListNullableSchemas<F>;
};

type FloatListNullableSchemas<F extends FieldState<"float">> = {
  base: NullableSchema<ArraySchema<F["base"], undefined>, undefined>;
  filter: typeof floatListNullableFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof floatListNullableUpdateFactory<F["base"]>>;
};

// =============================================================================
// DECIMAL SCHEMA BUILDERS (reuse float with decimal field state)
// =============================================================================

export const decimalSchemas = <const F extends FieldState<"decimal">>(f: F) => {
  return {
    base: f.base,
    filter: decimalFilter,
    create: createWithDefault(f, f.base),
    update: floatUpdateFactory(f.base),
  } as unknown as DecimalSchemas<F>;
};

type DecimalSchemas<F extends FieldState<"decimal">> = {
  base: F["base"];
  filter: typeof decimalFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof floatUpdateFactory<F["base"]>>;
};

export const decimalNullableSchemas = <F extends FieldState<"decimal">>(
  f: F
) => {
  return {
    base: nullable(f.base),
    filter: decimalNullableFilter,
    create: createWithDefault(f, nullable(f.base)),
    update: floatNullableUpdateFactory(f.base),
  } as unknown as DecimalNullableSchemas<F>;
};

type DecimalNullableSchemas<F extends FieldState<"decimal">> = {
  base: NullableSchema<F["base"], undefined>;
  filter: typeof decimalNullableFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof floatNullableUpdateFactory<F["base"]>>;
};

export const decimalListSchemas = <F extends FieldState<"decimal">>(f: F) => {
  return {
    base: array(f.base),
    filter: decimalListFilter,
    create: createWithDefault(f, array(f.base)),
    update: floatListUpdateFactory(f.base),
  } as unknown as DecimalListSchemas<F>;
};

type DecimalListSchemas<F extends FieldState<"decimal">> = {
  base: ArraySchema<F["base"], undefined>;
  filter: typeof decimalListFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof floatListUpdateFactory<F["base"]>>;
};

export const decimalListNullableSchemas = <F extends FieldState<"decimal">>(
  f: F
) => {
  return {
    base: nullable(array(f.base)),
    filter: decimalListNullableFilter,
    create: createWithDefault(f, nullable(array(f.base))),
    update: floatListNullableUpdateFactory(f.base),
  } as unknown as DecimalListNullableSchemas<F>;
};

type DecimalListNullableSchemas<F extends FieldState<"decimal">> = {
  base: NullableSchema<ArraySchema<F["base"], undefined>, undefined>;
  filter: typeof decimalListNullableFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof floatListNullableUpdateFactory<F["base"]>>;
};

// =============================================================================
// TYPE INFERENCE
// =============================================================================

export type InferIntSchemas<F extends FieldState<"int">> =
  F["array"] extends true
    ? F["nullable"] extends true
      ? IntListNullableSchemas<F>
      : IntListSchemas<F>
    : F["nullable"] extends true
    ? IntNullableSchemas<F>
    : IntSchemas<F>;

export type InferFloatSchemas<F extends FieldState<"float">> =
  F["array"] extends true
    ? F["nullable"] extends true
      ? FloatListNullableSchemas<F>
      : FloatListSchemas<F>
    : F["nullable"] extends true
    ? FloatNullableSchemas<F>
    : FloatSchemas<F>;

export type InferDecimalSchemas<F extends FieldState<"decimal">> =
  F["array"] extends true
    ? F["nullable"] extends true
      ? DecimalListNullableSchemas<F>
      : DecimalListSchemas<F>
    : F["nullable"] extends true
    ? DecimalNullableSchemas<F>
    : DecimalSchemas<F>;

// =============================================================================
// MAIN SCHEMA GETTERS
// =============================================================================

export const getFieldIntSchemas = <F extends FieldState<"int">>(f: F) => {
  return (
    f.array
      ? f.nullable
        ? intListNullableSchemas(f)
        : intListSchemas(f)
      : f.nullable
      ? intNullableSchemas(f)
      : intSchemas(f)
  ) as InferIntSchemas<F>;
};

export const getFieldFloatSchemas = <F extends FieldState<"float">>(f: F) => {
  return (
    f.array
      ? f.nullable
        ? floatListNullableSchemas(f)
        : floatListSchemas(f)
      : f.nullable
      ? floatNullableSchemas(f)
      : floatSchemas(f)
  ) as InferFloatSchemas<F>;
};

export const getFieldDecimalSchemas = <F extends FieldState<"decimal">>(
  f: F
) => {
  return (
    f.array
      ? f.nullable
        ? decimalListNullableSchemas(f)
        : decimalListSchemas(f)
      : f.nullable
      ? decimalNullableSchemas(f)
      : decimalSchemas(f)
  ) as InferDecimalSchemas<F>;
};

// =============================================================================
// INPUT TYPE INFERENCE
// =============================================================================

export type InferIntInput<
  F extends FieldState<"int">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<InferIntSchemas<F>[Type]>;

export type InferFloatInput<
  F extends FieldState<"float">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<InferFloatSchemas<F>[Type]>;

export type InferDecimalInput<
  F extends FieldState<"decimal">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<InferDecimalSchemas<F>[Type]>;
