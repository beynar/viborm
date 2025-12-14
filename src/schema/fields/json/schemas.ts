// JSON Field Schemas
// Factory pattern for JSON field variants following the established schema structure

import {
  array,
  nullable,
  object,
  optional,
  partial,
  string,
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
// FILTER FACTORIES
// =============================================================================

// Note: JSON filters do NOT support shorthand because JSON values can be objects,
// making it impossible to distinguish between a filter operation and a JSON value.
// This matches Prisma's behavior where you always use { equals: value }.

const jsonFilterFactory = <S extends AnySchema>(base: S) => {
  const filterBase = partial(
    object({
      equals: base,
      path: array(string()),
      string_contains: string(),
      string_starts_with: string(),
      string_ends_with: string(),
      array_contains: base,
      array_starts_with: base,
      array_ends_with: base,
    })
  );
  return extend(filterBase, {
    not: optional(filterBase),
  });
};

const jsonNullableFilterFactory = <S extends AnySchema>(base: S) => {
  const nullableBase = nullable(base);
  const filterBase = partial(
    object({
      equals: nullableBase,
      path: array(string()),
      string_contains: string(),
      string_starts_with: string(),
      string_ends_with: string(),
      array_contains: base,
      array_starts_with: base,
      array_ends_with: base,
    })
  );
  return extend(filterBase, {
    not: optional(filterBase),
  });
};

// =============================================================================
// UPDATE FACTORIES
// =============================================================================

// Note: JSON updates do NOT support shorthand because JSON values can be objects,
// making it impossible to distinguish between an update operation and a JSON value.
// This matches Prisma's behavior where you always use { set: value }.

const jsonUpdateFactory = <S extends AnySchema>(base: S) =>
  partial(object({ set: base }));

const jsonNullableUpdateFactory = <S extends AnySchema>(base: S) =>
  partial(object({ set: nullable(base) }));

// =============================================================================
// SCHEMA BUILDERS
// =============================================================================

export const jsonSchemas = <const F extends FieldState<"json">>(f: F) => {
  return {
    base: f.base,
    filter: jsonFilterFactory(f.base),
    create: createWithDefault(f, f.base),
    update: jsonUpdateFactory(f.base),
  } as unknown as JsonSchemas<F>;
};

type JsonSchemas<F extends FieldState<"json">> = {
  base: F["base"];
  filter: ReturnType<typeof jsonFilterFactory<F["base"]>>;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof jsonUpdateFactory<F["base"]>>;
};

export const jsonNullableSchemas = <F extends FieldState<"json">>(f: F) => {
  return {
    base: nullable(f.base),
    filter: jsonNullableFilterFactory(f.base),
    create: createWithDefault(f, nullable(f.base)),
    update: jsonNullableUpdateFactory(f.base),
  } as unknown as JsonNullableSchemas<F>;
};

type JsonNullableSchemas<F extends FieldState<"json">> = {
  base: NullableSchema<F["base"], undefined>;
  filter: ReturnType<typeof jsonNullableFilterFactory<F["base"]>>;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof jsonNullableUpdateFactory<F["base"]>>;
};

// =============================================================================
// TYPE INFERENCE
// =============================================================================

export type InferJsonSchemas<F extends FieldState<"json">> =
  F["nullable"] extends true ? JsonNullableSchemas<F> : JsonSchemas<F>;

// =============================================================================
// MAIN SCHEMA GETTER
// =============================================================================

export const getFieldJsonSchemas = <F extends FieldState<"json">>(f: F) => {
  return (
    f.nullable ? jsonNullableSchemas(f) : jsonSchemas(f)
  ) as InferJsonSchemas<F>;
};

// =============================================================================
// INPUT TYPE INFERENCE
// =============================================================================

export type InferJsonInput<
  F extends FieldState<"json">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<InferJsonSchemas<F>[Type]>;
