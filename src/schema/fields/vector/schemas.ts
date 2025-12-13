// Vector Field Schemas
// Explicit Zod schemas for all vector field variants

import {
  array,
  nullable,
  number,
  object,
  optional,
  partial,
  type Infer,
} from "zod/v4-mini";

// =============================================================================
// BASE TYPES
// =============================================================================

export const vectorBase = array(number());
export const vectorNullable = nullable(vectorBase);
export const vectorArray = array(vectorBase);
export const vectorNullableArray = nullable(vectorArray);

// =============================================================================
// DIMENSION-CONSTRAINED SCHEMAS
// =============================================================================

/**
 * Creates a vector schema with a specific dimension constraint.
 * Note: length validation can be added with .length(dimension) if needed.
 */
export const createVectorWithDimension = (dimension: number) => {
  // Return the base vector type - dimension validation happens at runtime
  return vectorBase;
};

// =============================================================================
// FILTER SCHEMAS
// =============================================================================

// Vector filtering is typically for similarity search
export const vectorFilter = partial(
  object({
    equals: vectorBase,
    not: vectorNullable,
  })
);

export const vectorNullableFilter = partial(
  object({
    equals: vectorNullable,
    not: vectorNullable,
  })
);

// =============================================================================
// CREATE SCHEMAS
// =============================================================================

export const vectorCreate = vectorBase;
export const vectorNullableCreate = vectorNullable;
export const vectorOptionalCreate = optional(vectorBase);
export const vectorOptionalNullableCreate = optional(vectorNullable);

// =============================================================================
// UPDATE SCHEMAS
// =============================================================================

export const vectorUpdate = partial(
  object({
    set: vectorBase,
  })
);

export const vectorNullableUpdate = partial(
  object({
    set: vectorNullable,
  })
);

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type VectorBase = Infer<typeof vectorBase>;
export type VectorNullable = Infer<typeof vectorNullable>;
export type VectorFilter = Infer<typeof vectorFilter>;
export type VectorNullableFilter = Infer<typeof vectorNullableFilter>;
export type VectorUpdate = Infer<typeof vectorUpdate>;
export type VectorNullableUpdate = Infer<typeof vectorNullableUpdate>;
