// String Field Schemas
// Factory pattern for string field variants with optional custom schema support

import {
  array,
  boolean,
  literal,
  nullable,
  object,
  optional,
  string,
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
import v from "../../../validation";

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
const stringFilterBase = object({
  equals: optional(stringBase),
  in: optional(stringList),
  notIn: optional(stringList),
  contains: optional(stringBase),
  startsWith: optional(stringBase),
  endsWith: optional(stringBase),
  mode: optional(union([literal("default"), literal("insensitive")])),
  lt: optional(stringBase),
  lte: optional(stringBase),
  gt: optional(stringBase),
  gte: optional(stringBase),
});

const stringNullableFilterBase = object({
  equals: optional(stringNullable),
  in: optional(stringList),
  notIn: optional(stringList),
  contains: optional(stringBase),
  startsWith: optional(stringBase),
  endsWith: optional(stringBase),
  mode: optional(union([literal("default"), literal("insensitive")])),
  lt: optional(stringNullable),
  lte: optional(stringNullable),
  gt: optional(stringNullable),
  gte: optional(stringNullable),
});

const stringArrayFilterBase = object({
  equals: optional(stringList),
  has: optional(stringBase),
  hasEvery: optional(stringList),
  hasSome: optional(stringList),
  isEmpty: optional(boolean()),
});
const stringNullableListFilterBase = object({
  equals: optional(stringListNullable),
  has: optional(stringBase),
  hasEvery: optional(stringList),
  hasSome: optional(stringList),
  isEmpty: optional(boolean()),
});
const stringFilter = union([
  shorthandFilter(stringBase),
  extend(stringFilterBase, {
    not: optional(union([shorthandFilter(stringBase), stringFilterBase])),
  }),
]);

const stringNullableFilter = union([
  shorthandFilter(stringNullable),
  extend(stringNullableFilterBase, {
    not: optional(
      union([shorthandFilter(stringNullable), stringNullableFilterBase])
    ),
  }),
]);

const stringListFilter = union([
  shorthandFilter(stringList),
  extend(stringArrayFilterBase, {
    not: optional(union([shorthandFilter(stringList), stringArrayFilterBase])),
  }),
]);

const stringListNullableFilter = union([
  shorthandFilter(stringListNullable),
  extend(stringNullableListFilterBase, {
    not: optional(
      union([shorthandFilter(stringListNullable), stringNullableListFilterBase])
    ),
  }),
]);

// =============================================================================
// UPDATE FACTORIES
// =============================================================================

const stringUpdateFactory = <S extends AnySchema>(base: S) => {
  return union([shorthandUpdate(base), object({ set: base })]);
};

const stringNullableUpdateFactory = <S extends AnySchema>(base: S) => {
  return union([
    shorthandUpdate(nullable(base)),
    object({ set: nullable(base) }),
  ]);
};

const stringListUpdateFactory = <S extends AnySchema>(base: S) =>
  union([
    shorthandUpdate(array(base)),
    object({
      set: optional(array(base)),
      push: optional(union([base, array(base)])),
      unshift: optional(union([base, array(base)])),
    }),
  ]);

const stringListNullableUpdateFactory = <S extends AnySchema>(base: S) =>
  union([
    shorthandUpdate(nullable(array(base))),
    object({
      set: optional(nullable(array(base))),
      push: optional(union([base, array(base)])),
      unshift: optional(union([base, array(base)])),
    }),
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
  base: NullableSchema<F["base"], undefined>;
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
  base: ArraySchema<F["base"], undefined>;
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
  base: NullableSchema<ArraySchema<F["base"], undefined>, undefined>;
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
> = InferInput<InferStringSchemas<F>[Type]>;

const stringSchemasNew = <F extends FieldState<"string">>(f: F) => {
  const base = v.string(f);
};
