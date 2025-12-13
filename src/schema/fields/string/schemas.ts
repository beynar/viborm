// String Field Schemas
// Factory pattern for string field variants with optional custom schema support

import {
  array,
  boolean,
  literal,
  nullable,
  object,
  optional,
  partial,
  string,
  union,
  type input as Input,
  extend,
  ZodMiniType,
  ZodMiniArray,
  ZodMiniNullable,
} from "zod/v4-mini";

import {
  createWithDefault,
  FieldState,
  SchemaWithDefault,
  shorthandFilter,
  shorthandUpdate,
} from "../common";

// =============================================================================
// BASE TYPES
// =============================================================================

export const stringBase = string();
export const stringNullable = nullable(stringBase);
export const stringList = array(stringBase);
export const stringListNullable = nullable(stringList);

// =============================================================================
// FILTER SCHEMAS
// =============================================================================

// Base filter object without `not` (used for recursive `not` definition)
const stringFilterBase = partial(
  object({
    equals: stringBase,
    in: array(stringBase),
    notIn: array(stringBase),
    contains: stringBase,
    startsWith: stringBase,
    endsWith: stringBase,
    mode: union([literal("default"), literal("insensitive")]),
    lt: stringBase,
    lte: stringBase,
    gt: stringBase,
    gte: stringBase,
  })
);

const stringNullableFilterBase = partial(
  object({
    equals: stringNullable,
    in: array(stringBase),
    notIn: array(stringBase),
    contains: stringBase,
    startsWith: stringBase,
    endsWith: stringBase,
    mode: union([literal("default"), literal("insensitive")]),
    lt: stringNullable,
    lte: stringNullable,
    gt: stringNullable,
    gte: stringNullable,
  })
);

const stringArrayFilterBase = partial(
  object({
    equals: stringList,
    has: stringBase,
    hasEvery: array(stringBase),
    hasSome: array(stringBase),
    isEmpty: boolean(),
  })
);

const stringNullableListFilterBase = partial(
  object({
    equals: stringListNullable,
    has: stringBase,
    hasEvery: array(stringBase),
    hasSome: array(stringBase),
    isEmpty: boolean(),
  })
);

const stringFilter = union([
  extend(stringFilterBase, {
    not: optional(union([stringFilterBase, shorthandFilter(stringBase)])),
  }),
  shorthandFilter(stringBase),
]);

const stringNullableFilter = union([
  extend(stringNullableFilterBase, {
    not: optional(union([stringNullableFilterBase, stringNullable])),
  }),
  shorthandFilter(stringNullable),
]);

const stringListFilter = union([
  extend(stringArrayFilterBase, {
    not: optional(union([stringArrayFilterBase, shorthandFilter(stringList)])),
  }),
  shorthandFilter(stringList),
]);

const stringListNullableFilter = union([
  extend(stringNullableListFilterBase, {
    not: optional(
      union([stringNullableListFilterBase, shorthandFilter(stringListNullable)])
    ),
  }),
  shorthandFilter(stringListNullable),
]);

// =============================================================================
// UPDATE FACTORIES
// =============================================================================

const stringUpdateFactory = <Z extends ZodMiniType>(base: Z) =>
  union([object({ set: base }), shorthandUpdate(base)]);

const stringNullableUpdateFactory = <Z extends ZodMiniType>(base: Z) =>
  union([object({ set: nullable(base) }), shorthandUpdate(nullable(base))]);

const stringListUpdateFactory = <Z extends ZodMiniType>(base: Z) =>
  union([
    partial(
      object({
        set: array(base),
        push: union([base, array(base)]),
        unshift: union([base, array(base)]),
      })
    ),
    shorthandUpdate(array(base)),
  ]);

const stringListNullableUpdateFactory = <Z extends ZodMiniType>(base: Z) =>
  union([
    partial(
      object({
        set: nullable(array(base)),
        push: union([base, array(base)]),
        unshift: union([base, array(base)]),
      })
    ),
    shorthandUpdate(nullable(array(base))),
  ]);

// =============================================================================
// SCHEMA BUILDERS (single FieldState generic)
// =============================================================================

export const stringSchemas = <const F extends FieldState<"string">>(f: F) => {
  return {
    base: f.base,
    filter: stringFilter,
    create: createWithDefault(f, f.base),
    update: stringUpdateFactory(f.base),
  } as unknown as StringSchemas<F>;
};

type StringSchemas<F extends FieldState<"string">> = {
  base: F["base"];
  filter: typeof stringFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof stringUpdateFactory<F["base"]>>;
};

export const stringNullableSchemas = <F extends FieldState<"string">>(f: F) => {
  return {
    base: nullable(f.base),
    filter: stringNullableFilter,
    create: createWithDefault(f, nullable(f.base)),
    update: stringNullableUpdateFactory(f.base),
  } as unknown as StringNullableSchemas<F>;
};

type StringNullableSchemas<F extends FieldState<"string">> = {
  base: ZodMiniNullable<F["base"]>;
  filter: typeof stringNullableFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof stringNullableUpdateFactory<F["base"]>>;
};

export const stringListSchemas = <F extends FieldState<"string">>(f: F) => {
  return {
    base: array(f.base),
    filter: stringListFilter,
    create: createWithDefault(f, array(f.base)),
    update: stringListUpdateFactory(f.base),
  } as unknown as StringListSchemas<F>;
};

type StringListSchemas<F extends FieldState<"string">> = {
  base: ZodMiniArray<F["base"]>;
  filter: typeof stringListFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof stringListUpdateFactory<F["base"]>>;
};

export const stringListNullableSchemas = <F extends FieldState<"string">>(
  f: F
) => {
  return {
    base: nullable(array(f.base)),
    filter: stringListNullableFilter,
    create: createWithDefault(f, nullable(array(f.base))),
    update: stringListNullableUpdateFactory(f.base),
  } as unknown as StringListNullableSchemas<F>;
};

type StringListNullableSchemas<F extends FieldState<"string">> = {
  base: ZodMiniNullable<ZodMiniArray<F["base"]>>;
  filter: typeof stringListNullableFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof stringListNullableUpdateFactory<F["base"]>>;
};

export type InferStringSchemas<F extends FieldState<"string">> =
  F["array"] extends true
    ? F["nullable"] extends true
      ? StringListNullableSchemas<F>
      : StringListSchemas<F>
    : F["nullable"] extends true
    ? StringNullableSchemas<F>
    : StringSchemas<F>;

export const getFieldStringSchemas = <F extends FieldState<"string">>(f: F) => {
  return (
    f.array
      ? f.nullable
        ? stringListNullableSchemas(f)
        : stringListSchemas(f)
      : f.nullable
      ? stringNullableSchemas(f)
      : stringSchemas(f)
  ) as InferStringSchemas<F>;
};

export type InferStringInput<
  F extends FieldState<"string">,
  Type extends "create" | "update" | "filter" | "base"
> = Input<InferStringSchemas<F>[Type]>;
