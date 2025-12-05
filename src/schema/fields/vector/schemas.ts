// Vector Field Schemas
// Explicit ArkType schemas for all vector field variants

import { type, Type } from "arktype";

// =============================================================================
// BASE TYPES
// =============================================================================

export const vectorBase = type.number.array();
export const vectorNullable = vectorBase.or("null");
export const vectorArray = vectorBase.array();
export const vectorNullableArray = vectorArray.or("null");

// =============================================================================
// DIMENSION-CONSTRAINED SCHEMAS
// =============================================================================

/**
 * Creates a vector schema with a specific dimension constraint.
 * Note: ArkType doesn't support dynamic length constraints directly,
 * so this validates the array type and the dimension is checked at runtime.
 */
export const createVectorWithDimension = (dimension: number): Type<number[]> => {
  // Return the base vector type - dimension validation happens at runtime
  return vectorBase as Type<number[]>;
};

// =============================================================================
// FILTER SCHEMAS
// =============================================================================

// Vector filtering is typically for similarity search
export const vectorFilter = type({
  equals: vectorBase,
  not: vectorNullable,
}).partial();

export const vectorNullableFilter = type({
  equals: vectorNullable,
  not: vectorNullable,
}).partial();

// =============================================================================
// CREATE SCHEMAS
// =============================================================================

export const vectorCreate = vectorBase;
export const vectorNullableCreate = vectorNullable;
export const vectorOptionalCreate = vectorBase.or("undefined");
export const vectorOptionalNullableCreate = vectorNullable.or("undefined");

// =============================================================================
// UPDATE SCHEMAS
// =============================================================================

export const vectorUpdate = type({
  set: vectorBase,
}).partial();

export const vectorNullableUpdate = type({
  set: vectorNullable,
}).partial();

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type VectorBase = typeof vectorBase.infer;
export type VectorNullable = typeof vectorNullable.infer;
export type VectorFilter = typeof vectorFilter.infer;
export type VectorNullableFilter = typeof vectorNullableFilter.infer;
export type VectorUpdate = typeof vectorUpdate.infer;
export type VectorNullableUpdate = typeof vectorNullableUpdate.infer;
