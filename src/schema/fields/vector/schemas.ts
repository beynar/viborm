// Vector Field Schemas
// Factory pattern for vector field variants (no array support, like blob)

import {
  array,
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

export const vectorBase = array(number());
export const vectorNullable = nullable(vectorBase);

// =============================================================================
// FILTER SCHEMAS
// =============================================================================

const vectorFilterBase = partial(
  object({
    equals: vectorBase,
  })
);

const vectorNullableFilterBase = partial(
  object({
    equals: vectorNullable,
  })
);

const vectorFilter = union([
  shorthandFilter(vectorBase),
  extend(vectorFilterBase, {
    not: optional(union([shorthandFilter(vectorBase), vectorFilterBase])),
  }),
]);

const vectorNullableFilter = union([
  shorthandFilter(vectorNullable),
  extend(vectorNullableFilterBase, {
    not: optional(
      union([shorthandFilter(vectorNullable), vectorNullableFilterBase])
    ),
  }),
]);

// =============================================================================
// UPDATE FACTORIES
// =============================================================================

const vectorUpdateFactory = <S extends AnySchema>(base: S) => {
  return union([shorthandUpdate(base), object({ set: base })]);
};

const vectorNullableUpdateFactory = <S extends AnySchema>(base: S) => {
  return union([
    shorthandUpdate(nullable(base)),
    object({ set: nullable(base) }),
  ]);
};

// =============================================================================
// SCHEMA BUILDERS (single FieldState generic)
// =============================================================================

export const vectorSchemas = <const F extends FieldState<"vector">>(f: F) => {
  return {
    base: f.base,
    filter: vectorFilter,
    create: createWithDefault(f, f.base),
    update: vectorUpdateFactory(f.base),
  } as unknown as VectorSchemas<F>;
};

type VectorSchemas<F extends FieldState<"vector">> = {
  base: F["base"];
  filter: typeof vectorFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof vectorUpdateFactory<F["base"]>>;
};

export const vectorNullableSchemas = <F extends FieldState<"vector">>(f: F) => {
  return {
    base: nullable(f.base),
    filter: vectorNullableFilter,
    create: createWithDefault(f, nullable(f.base)),
    update: vectorNullableUpdateFactory(f.base),
  } as unknown as VectorNullableSchemas<F>;
};

type VectorNullableSchemas<F extends FieldState<"vector">> = {
  base: NullableSchema<F["base"], undefined>;
  filter: typeof vectorNullableFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof vectorNullableUpdateFactory<F["base"]>>;
};

// =============================================================================
// TYPE INFERENCE
// =============================================================================

export type InferVectorSchemas<F extends FieldState<"vector">> =
  F["nullable"] extends true ? VectorNullableSchemas<F> : VectorSchemas<F>;

export const getFieldVectorSchemas = <F extends FieldState<"vector">>(f: F) => {
  return (
    f.nullable ? vectorNullableSchemas(f) : vectorSchemas(f)
  ) as InferVectorSchemas<F>;
};

export type InferVectorInput<
  F extends FieldState<"vector">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<InferVectorSchemas<F>[Type]>;
