// DateTime Field Schemas
// Factory pattern for datetime field variants following the string/boolean schema structure

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
  pipe,
  string,
  isoTimestamp,
  date,
  InferOutput,
  transform,
  blob,
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

export const datetimeBase = union([
  pipe(
    date(),
    transform((v) => v.toISOString())
  ),
  pipe(string(), isoTimestamp()),
]);
export const datetimeNullable = nullable(datetimeBase);
export const datetimeList = array(datetimeBase);
export const datetimeListNullable = nullable(datetimeList);

// =============================================================================
// FILTER SCHEMAS
// =============================================================================

// Base filter object without `not` (used for recursive `not` definition)
const datetimeFilterBase = partial(
  object({
    equals: datetimeBase,
    in: datetimeList,
    notIn: datetimeList,
    lt: datetimeBase,
    lte: datetimeBase,
    gt: datetimeBase,
    gte: datetimeBase,
  })
);

const datetimeNullableFilterBase = partial(
  object({
    equals: datetimeNullable,
    in: datetimeList,
    notIn: datetimeList,
    lt: datetimeNullable,
    lte: datetimeNullable,
    gt: datetimeNullable,
    gte: datetimeNullable,
  })
);

const datetimeArrayFilterBase = partial(
  object({
    equals: datetimeList,
    has: datetimeBase,
    hasEvery: datetimeList,
    hasSome: datetimeList,
    isEmpty: boolean(),
  })
);

const datetimeNullableListFilterBase = partial(
  object({
    equals: datetimeListNullable,
    has: datetimeBase,
    hasEvery: datetimeList,
    hasSome: datetimeList,
    isEmpty: boolean(),
  })
);

const datetimeFilter = union([
  shorthandFilter(datetimeBase),
  extend(datetimeFilterBase, {
    not: optional(union([shorthandFilter(datetimeBase), datetimeFilterBase])),
  }),
]);

const datetimeNullableFilter = union([
  shorthandFilter(datetimeNullable),
  extend(datetimeNullableFilterBase, {
    not: optional(
      union([shorthandFilter(datetimeNullable), datetimeNullableFilterBase])
    ),
  }),
]);

const datetimeListFilter = union([
  shorthandFilter(datetimeList),
  extend(datetimeArrayFilterBase, {
    not: optional(
      union([shorthandFilter(datetimeList), datetimeArrayFilterBase])
    ),
  }),
]);

const datetimeListNullableFilter = union([
  shorthandFilter(datetimeListNullable),
  extend(datetimeNullableListFilterBase, {
    not: optional(
      union([
        shorthandFilter(datetimeListNullable),
        datetimeNullableListFilterBase,
      ])
    ),
  }),
]);

// =============================================================================
// UPDATE FACTORIES
// =============================================================================

const datetimeUpdateFactory = <S extends AnySchema>(base: S) => {
  return union([shorthandUpdate(base), object({ set: base })]);
};

const datetimeNullableUpdateFactory = <S extends AnySchema>(base: S) => {
  return union([
    shorthandUpdate(nullable(base)),
    object({ set: nullable(base) }),
  ]);
};

const datetimeListUpdateFactory = <S extends AnySchema>(base: S) =>
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

const datetimeListNullableUpdateFactory = <S extends AnySchema>(base: S) =>
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

export const datetimeSchemas = <const F extends FieldState<"datetime">>(
  f: F
) => {
  return {
    base: f.base,
    filter: datetimeFilter,
    create: createWithDefault(f, f.base),
    update: datetimeUpdateFactory(f.base),
  } as unknown as DateTimeSchemas<F>;
};

type DateTimeSchemas<F extends FieldState<"datetime">> = {
  base: F["base"];
  filter: typeof datetimeFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof datetimeUpdateFactory<F["base"]>>;
};

export const datetimeNullableSchemas = <F extends FieldState<"datetime">>(
  f: F
) => {
  return {
    base: nullable(f.base),
    filter: datetimeNullableFilter,
    create: createWithDefault(f, nullable(f.base)),
    update: datetimeNullableUpdateFactory(f.base),
  } as unknown as DateTimeNullableSchemas<F>;
};

type DateTimeNullableSchemas<F extends FieldState<"datetime">> = {
  base: NullableSchema<F["base"], undefined>;
  filter: typeof datetimeNullableFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof datetimeNullableUpdateFactory<F["base"]>>;
};

export const datetimeListSchemas = <F extends FieldState<"datetime">>(f: F) => {
  return {
    base: array(f.base),
    filter: datetimeListFilter,
    create: createWithDefault(f, array(f.base)),
    update: datetimeListUpdateFactory(f.base),
  } as unknown as DateTimeListSchemas<F>;
};

type DateTimeListSchemas<F extends FieldState<"datetime">> = {
  base: ArraySchema<F["base"], undefined>;
  filter: typeof datetimeListFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof datetimeListUpdateFactory<F["base"]>>;
};

export const datetimeListNullableSchemas = <F extends FieldState<"datetime">>(
  f: F
) => {
  return {
    base: nullable(array(f.base)),
    filter: datetimeListNullableFilter,
    create: createWithDefault(f, nullable(array(f.base))),
    update: datetimeListNullableUpdateFactory(f.base),
  } as unknown as DateTimeListNullableSchemas<F>;
};

type DateTimeListNullableSchemas<F extends FieldState<"datetime">> = {
  base: NullableSchema<ArraySchema<F["base"], undefined>, undefined>;
  filter: typeof datetimeListNullableFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof datetimeListNullableUpdateFactory<F["base"]>>;
};

export type InferDateTimeSchemas<F extends FieldState<"datetime">> =
  F["array"] extends true
    ? F["nullable"] extends true
      ? DateTimeListNullableSchemas<F>
      : DateTimeListSchemas<F>
    : F["nullable"] extends true
    ? DateTimeNullableSchemas<F>
    : DateTimeSchemas<F>;

export const getFieldDateTimeSchemas = <F extends FieldState<"datetime">>(
  f: F
) => {
  return (
    f.array
      ? f.nullable
        ? datetimeListNullableSchemas(f)
        : datetimeListSchemas(f)
      : f.nullable
      ? datetimeNullableSchemas(f)
      : datetimeSchemas(f)
  ) as InferDateTimeSchemas<F>;
};

export type InferDateTimeInput<
  F extends FieldState<"datetime">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<InferDateTimeSchemas<F>[Type]>;
