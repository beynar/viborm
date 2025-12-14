// Boolean Field Schemas
// Factory pattern for boolean field variants following the string schema structure

import {
  array,
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

export const booleanBase = boolean();
export const booleanNullable = nullable(booleanBase);
export const booleanList = array(booleanBase);
export const booleanListNullable = nullable(booleanList);

// =============================================================================
// FILTER SCHEMAS
// =============================================================================

// Base filter object without `not` (used for recursive `not` definition)
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

const booleanArrayFilterBase = partial(
  object({
    equals: booleanList,
    has: booleanBase,
    hasEvery: booleanList,
    hasSome: booleanList,
    isEmpty: boolean(),
  })
);

const booleanNullableListFilterBase = partial(
  object({
    equals: booleanListNullable,
    has: booleanBase,
    hasEvery: booleanList,
    hasSome: booleanList,
    isEmpty: boolean(),
  })
);

const booleanFilter = union([
  shorthandFilter(booleanBase),
  extend(booleanFilterBase, {
    not: optional(union([shorthandFilter(booleanBase), booleanFilterBase])),
  }),
]);

const booleanNullableFilter = union([
  shorthandFilter(booleanNullable),
  extend(booleanNullableFilterBase, {
    not: optional(
      union([shorthandFilter(booleanNullable), booleanNullableFilterBase])
    ),
  }),
]);

const booleanListFilter = union([
  shorthandFilter(booleanList),
  extend(booleanArrayFilterBase, {
    not: optional(
      union([shorthandFilter(booleanList), booleanArrayFilterBase])
    ),
  }),
]);

const booleanListNullableFilter = union([
  shorthandFilter(booleanListNullable),
  extend(booleanNullableListFilterBase, {
    not: optional(
      union([
        shorthandFilter(booleanListNullable),
        booleanNullableListFilterBase,
      ])
    ),
  }),
]);

// =============================================================================
// UPDATE FACTORIES
// =============================================================================

const booleanUpdateFactory = <S extends AnySchema>(base: S) => {
  return union([shorthandUpdate(base), object({ set: base })]);
};

const booleanNullableUpdateFactory = <S extends AnySchema>(base: S) => {
  return union([
    shorthandUpdate(nullable(base)),
    object({ set: nullable(base) }),
  ]);
};

const booleanListUpdateFactory = <S extends AnySchema>(base: S) =>
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

const booleanListNullableUpdateFactory = <S extends AnySchema>(base: S) =>
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
// SCHEMA BUILDERS (single FieldState generic)
// =============================================================================

export const booleanSchemas = <const F extends FieldState<"boolean">>(f: F) => {
  return {
    base: f.base,
    filter: booleanFilter,
    create: createWithDefault(f, f.base),
    update: booleanUpdateFactory(f.base),
  } as unknown as BooleanSchemas<F>;
};

type BooleanSchemas<F extends FieldState<"boolean">> = {
  base: F["base"];
  filter: typeof booleanFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof booleanUpdateFactory<F["base"]>>;
};

export const booleanNullableSchemas = <F extends FieldState<"boolean">>(
  f: F
) => {
  return {
    base: nullable(f.base),
    filter: booleanNullableFilter,
    create: createWithDefault(f, nullable(f.base)),
    update: booleanNullableUpdateFactory(f.base),
  } as unknown as BooleanNullableSchemas<F>;
};

type BooleanNullableSchemas<F extends FieldState<"boolean">> = {
  base: NullableSchema<F["base"], undefined>;
  filter: typeof booleanNullableFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof booleanNullableUpdateFactory<F["base"]>>;
};

export const booleanListSchemas = <F extends FieldState<"boolean">>(f: F) => {
  return {
    base: array(f.base),
    filter: booleanListFilter,
    create: createWithDefault(f, array(f.base)),
    update: booleanListUpdateFactory(f.base),
  } as unknown as BooleanListSchemas<F>;
};

type BooleanListSchemas<F extends FieldState<"boolean">> = {
  base: ArraySchema<F["base"], undefined>;
  filter: typeof booleanListFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof booleanListUpdateFactory<F["base"]>>;
};

export const booleanListNullableSchemas = <F extends FieldState<"boolean">>(
  f: F
) => {
  return {
    base: nullable(array(f.base)),
    filter: booleanListNullableFilter,
    create: createWithDefault(f, nullable(array(f.base))),
    update: booleanListNullableUpdateFactory(f.base),
  } as unknown as BooleanListNullableSchemas<F>;
};

type BooleanListNullableSchemas<F extends FieldState<"boolean">> = {
  base: NullableSchema<ArraySchema<F["base"], undefined>, undefined>;
  filter: typeof booleanListNullableFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof booleanListNullableUpdateFactory<F["base"]>>;
};

export type InferBooleanSchemas<F extends FieldState<"boolean">> =
  F["array"] extends true
    ? F["nullable"] extends true
      ? BooleanListNullableSchemas<F>
      : BooleanListSchemas<F>
    : F["nullable"] extends true
    ? BooleanNullableSchemas<F>
    : BooleanSchemas<F>;

export const getFieldBooleanSchemas = <F extends FieldState<"boolean">>(
  f: F
) => {
  return (
    f.array
      ? f.nullable
        ? booleanListNullableSchemas(f)
        : booleanListSchemas(f)
      : f.nullable
      ? booleanNullableSchemas(f)
      : booleanSchemas(f)
  ) as InferBooleanSchemas<F>;
};

export type InferBooleanInput<
  F extends FieldState<"boolean">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<InferBooleanSchemas<F>[Type]>;
