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

// Helper to check if value is blob shorthand (Uint8Array or Buffer, not a filter object)
const isBlobShorthand = (v: unknown): v is Uint8Array | Buffer =>
  v instanceof Uint8Array || v instanceof Buffer;

// Blob filtering is limited - mostly equality
// Shorthand blob value is normalized to { equals: value } via pipe
export const blobFilter = type({
  equals: blobInput,
  not: blobNullableInput,
})
  .partial()
  .or(blobInput)
  .pipe((v) => (isBlobShorthand(v) ? { equals: v } : v));

// Nullable blob filter - accepts null shorthand
export const blobNullableFilter = type({
  equals: blobNullableInput,
  not: blobNullableInput,
})
  .partial()
  .or(blobNullableInput)
  .pipe((v) =>
    isBlobShorthand(v) || v === null ? { equals: v } : v
  );

// =============================================================================
// CREATE SCHEMAS
// =============================================================================

export const blobCreate = blobInput;
export const blobNullableCreate = blobNullableInput;
export const blobOptionalCreate = blobInput.or("undefined");
export const blobOptionalNullableCreate = blobNullableInput.or("undefined");

// =============================================================================
// UPDATE SCHEMAS - shorthand normalized to { set: value } via pipe
// =============================================================================

export const blobUpdate = type({
  set: blobInput,
})
  .partial()
  .or(blobInput)
  .pipe((v) => (isBlobShorthand(v) ? { set: v } : v));

export const blobNullableUpdate = type({
  set: blobNullableInput,
})
  .partial()
  .or(blobNullableInput)
  .pipe((v) => (isBlobShorthand(v) || v === null ? { set: v } : v));

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
