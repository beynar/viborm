// Point Field Schemas
// Factory pattern for point field variants (no array support, like blob)

import {
  nullable,
  number,
  object,
  optional,
  partial,
  union,
  InferInput,
  NullableSchema,
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

export const pointBase = object({
  x: number(),
  y: number(),
});
export const pointNullable = nullable(pointBase);

// =============================================================================
// FILTER SCHEMAS (PostGIS spatial operations)
// =============================================================================

const pointFilterBase = partial(
  object({
    equals: pointBase,
    intersects: pointBase,
    contains: pointBase,
    within: pointBase,
    crosses: pointBase,
    overlaps: pointBase,
    touches: pointBase,
    covers: pointBase,
    dWithin: object({
      geometry: pointBase,
      distance: number(),
    }),
  })
);

const pointNullableFilterBase = partial(
  object({
    equals: pointNullable,
    intersects: pointNullable,
    contains: pointNullable,
    within: pointNullable,
    crosses: pointNullable,
    overlaps: pointNullable,
    touches: pointNullable,
    covers: pointNullable,
    dWithin: object({
      geometry: pointNullable,
      distance: number(),
    }),
  })
);

const pointFilter = union([
  shorthandFilter(pointBase),
  extend(pointFilterBase, {
    not: optional(union([shorthandFilter(pointBase), pointFilterBase])),
  }),
]);

const pointNullableFilter = union([
  shorthandFilter(pointNullable),
  extend(pointNullableFilterBase, {
    not: optional(
      union([shorthandFilter(pointNullable), pointNullableFilterBase])
    ),
  }),
]);

// =============================================================================
// UPDATE FACTORIES
// =============================================================================

const pointUpdateFactory = <S extends AnySchema>(base: S) => {
  return union([shorthandUpdate(base), object({ set: base })]);
};

const pointNullableUpdateFactory = <S extends AnySchema>(base: S) => {
  return union([
    shorthandUpdate(nullable(base)),
    object({ set: nullable(base) }),
  ]);
};

// =============================================================================
// SCHEMA BUILDERS (single FieldState generic)
// =============================================================================

export const pointSchemas = <const F extends FieldState<"point">>(f: F) => {
  return {
    base: f.base,
    filter: pointFilter,
    create: createWithDefault(f, f.base),
    update: pointUpdateFactory(f.base),
  } as unknown as PointSchemas<F>;
};

type PointSchemas<F extends FieldState<"point">> = {
  base: F["base"];
  filter: typeof pointFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof pointUpdateFactory<F["base"]>>;
};

export const pointNullableSchemas = <F extends FieldState<"point">>(f: F) => {
  return {
    base: nullable(f.base),
    filter: pointNullableFilter,
    create: createWithDefault(f, nullable(f.base)),
    update: pointNullableUpdateFactory(f.base),
  } as unknown as PointNullableSchemas<F>;
};

type PointNullableSchemas<F extends FieldState<"point">> = {
  base: NullableSchema<F["base"], undefined>;
  filter: typeof pointNullableFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof pointNullableUpdateFactory<F["base"]>>;
};

// =============================================================================
// TYPE INFERENCE
// =============================================================================

export type InferPointSchemas<F extends FieldState<"point">> =
  F["nullable"] extends true ? PointNullableSchemas<F> : PointSchemas<F>;

export const getFieldPointSchemas = <F extends FieldState<"point">>(f: F) => {
  return (
    f.nullable ? pointNullableSchemas(f) : pointSchemas(f)
  ) as InferPointSchemas<F>;
};

export type InferPointInput<
  F extends FieldState<"point">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<InferPointSchemas<F>[Type]>;

