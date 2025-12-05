// Blob Field Schemas
// Explicit ArkType schemas for all blob field variants

import { type } from "arktype";

// =============================================================================
// BASE TYPES
// =============================================================================

export const blobBase = type.instanceOf(Uint8Array);
export const blobNullable = blobBase.or("null");

// Also accept Buffer for Node.js compatibility
export const blobInput = type.instanceOf(Uint8Array).or(type.instanceOf(Buffer));
export const blobNullableInput = blobInput.or("null");

// =============================================================================
// FILTER SCHEMAS
// =============================================================================

// Blob filtering is limited - mostly equality
export const blobFilter = type({
  equals: blobInput,
  not: blobNullableInput,
}).partial();

export const blobNullableFilter = type({
  equals: blobNullableInput,
  not: blobNullableInput,
}).partial();

// =============================================================================
// CREATE SCHEMAS
// =============================================================================

export const blobCreate = blobInput;
export const blobNullableCreate = blobNullableInput;
export const blobOptionalCreate = blobInput.or("undefined");
export const blobOptionalNullableCreate = blobNullableInput.or("undefined");

// =============================================================================
// UPDATE SCHEMAS
// =============================================================================

export const blobUpdate = type({
  set: blobInput,
}).partial();

export const blobNullableUpdate = type({
  set: blobNullableInput,
}).partial();

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type BlobBase = typeof blobBase.infer;
export type BlobNullable = typeof blobNullable.infer;
export type BlobInput = typeof blobInput.infer;
export type BlobFilter = typeof blobFilter.infer;
export type BlobNullableFilter = typeof blobNullableFilter.infer;
export type BlobUpdate = typeof blobUpdate.infer;
export type BlobNullableUpdate = typeof blobNullableUpdate.infer;
