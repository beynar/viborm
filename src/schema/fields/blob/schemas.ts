// Blob Field Schemas
// Factory pattern for blob field variants (no array support)

import {
  instance,
  nullable,
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
// BASE TYPES (accepts both Uint8Array and Buffer for Prisma Bytes compatibility)
// =============================================================================

export const blobBase = union([instance(Uint8Array), instance(Buffer)]);
export const blobNullable = nullable(blobBase);

// =============================================================================
// FILTER SCHEMAS (equality-only, like Prisma Bytes)
// =============================================================================

const blobFilterBase = partial(
  object({
    equals: blobBase,
  })
);

const blobNullableFilterBase = partial(
  object({
    equals: blobNullable,
  })
);

const blobFilter = union([
  shorthandFilter(blobBase),
  extend(blobFilterBase, {
    not: optional(union([shorthandFilter(blobBase), blobFilterBase])),
  }),
]);

const blobNullableFilter = union([
  shorthandFilter(blobNullable),
  extend(blobNullableFilterBase, {
    not: optional(
      union([shorthandFilter(blobNullable), blobNullableFilterBase])
    ),
  }),
]);

// =============================================================================
// UPDATE FACTORIES
// =============================================================================

const blobUpdateFactory = <S extends AnySchema>(base: S) => {
  return union([shorthandUpdate(base), object({ set: base })]);
};

const blobNullableUpdateFactory = <S extends AnySchema>(base: S) => {
  return union([
    shorthandUpdate(nullable(base)),
    object({ set: nullable(base) }),
  ]);
};

// =============================================================================
// SCHEMA BUILDERS (single FieldState generic)
// =============================================================================

export const blobSchemas = <const F extends FieldState<"blob">>(f: F) => {
  return {
    base: f.base,
    filter: blobFilter,
    create: createWithDefault(f, f.base),
    update: blobUpdateFactory(f.base),
  } as unknown as BlobSchemas<F>;
};

type BlobSchemas<F extends FieldState<"blob">> = {
  base: F["base"];
  filter: typeof blobFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof blobUpdateFactory<F["base"]>>;
};

export const blobNullableSchemas = <F extends FieldState<"blob">>(f: F) => {
  return {
    base: nullable(f.base),
    filter: blobNullableFilter,
    create: createWithDefault(f, nullable(f.base)),
    update: blobNullableUpdateFactory(f.base),
  } as unknown as BlobNullableSchemas<F>;
};

type BlobNullableSchemas<F extends FieldState<"blob">> = {
  base: NullableSchema<F["base"], undefined>;
  filter: typeof blobNullableFilter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof blobNullableUpdateFactory<F["base"]>>;
};

// =============================================================================
// TYPE INFERENCE
// =============================================================================

export type InferBlobSchemas<F extends FieldState<"blob">> =
  F["nullable"] extends true ? BlobNullableSchemas<F> : BlobSchemas<F>;

export const getFieldBlobSchemas = <F extends FieldState<"blob">>(f: F) => {
  return (
    f.nullable ? blobNullableSchemas(f) : blobSchemas(f)
  ) as InferBlobSchemas<F>;
};

export type InferBlobInput<
  F extends FieldState<"blob">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<InferBlobSchemas<F>[Type]>;
