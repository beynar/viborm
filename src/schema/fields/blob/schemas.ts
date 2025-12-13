// Blob Field Schemas
// Follows FIELD_IMPLEMENTATION_GUIDE (limited ops, no arrays)

import {
  instanceof as zInstanceof,
  nullable,
  object,
  optional,
  partial,
  union,
  _default,
  extend,
  type input as Input,
} from "zod/v4-mini";
import {
  FieldState,
  isOptional,
  shorthandFilter,
  shorthandUpdate,
} from "../common";

// =============================================================================
// BASE TYPES (normalize to Uint8Array)
// =============================================================================

const blobRaw = union([zInstanceof(Uint8Array), zInstanceof(Buffer)]);
export const blobBase = blobRaw;
export const blobNullable = nullable(blobBase);

// =============================================================================
// FILTER SCHEMAS (equality-only, with shorthand)
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
  extend(blobFilterBase, {
    not: optional(union([blobFilterBase, shorthandFilter(blobBase)])),
  }),
  shorthandFilter(blobBase),
]);

const blobNullableFilter = union([
  extend(blobNullableFilterBase, {
    not: optional(union([blobNullableFilterBase, blobNullable])),
  }),
  shorthandFilter(blobNullable),
]);

// =============================================================================
// CREATE SCHEMAS
// =============================================================================

export const blobCreate = blobBase;
export const blobNullableCreate = _default(optional(blobNullable), null);
export const blobOptionalCreate = optional(blobBase);
export const blobOptionalNullableCreate = _default(
  optional(blobNullable),
  null
);

// =============================================================================
// UPDATE SCHEMAS
// =============================================================================

export const blobUpdate = union([
  partial(object({ set: blobBase })),
  shorthandUpdate(blobBase),
]);

export const blobNullableUpdate = union([
  partial(object({ set: blobNullable })),
  shorthandUpdate(blobNullable),
]);

// =============================================================================
// SCHEMA FACTORIES
// =============================================================================

export const blobSchemas = <Optional extends boolean>(o: Optional) => {
  return {
    base: blobBase,
    filter: blobFilter,
    create: (o === true
      ? blobOptionalCreate
      : blobCreate) as Optional extends true
      ? typeof blobOptionalCreate
      : typeof blobCreate,
    update: blobUpdate,
  };
};

export const blobNullableSchemas = <Optional extends boolean>(o: Optional) => {
  return {
    base: blobNullable,
    filter: blobNullableFilter,
    create: (o === true
      ? blobOptionalNullableCreate
      : blobNullableCreate) as Optional extends true
      ? typeof blobOptionalNullableCreate
      : typeof blobNullableCreate,
    update: blobNullableUpdate,
  };
};

// =============================================================================
// TYPE HELPERS
// =============================================================================

export type BlobNullableSchemas<Optional extends boolean = false> = ReturnType<
  typeof blobNullableSchemas<Optional>
>;
export type BlobSchemas<Optional extends boolean = false> = ReturnType<
  typeof blobSchemas<Optional>
>;

export type InferBlobSchemas<F extends FieldState<"blob">> =
  F["nullable"] extends true
    ? BlobNullableSchemas<isOptional<F>>
    : BlobSchemas<isOptional<F>>;

// =============================================================================
// MAIN SCHEMA GETTER
// =============================================================================

export const getFieldBlobSchemas = <F extends FieldState<"blob">>(f: F) => {
  const isOpt = f.hasDefault || f.nullable;
  return (
    f.nullable ? blobNullableSchemas(isOpt) : blobSchemas(isOpt)
  ) as InferBlobSchemas<F>;
};

// =============================================================================
// INPUT TYPE INFERENCE
// =============================================================================

export type InferBlobInput<
  F extends FieldState<"blob">,
  Type extends "create" | "update" | "filter"
> = Input<InferBlobSchemas<F>[Type]>;
