// BigInt Field Schemas
// Explicit ArkType schemas for all bigint field variants

import { type } from "arktype";

// =============================================================================
// BASE TYPES
// =============================================================================

export const bigIntBase = type.bigint;
export const bigIntNullable = bigIntBase.or("null");
export const bigIntArray = bigIntBase.array();
export const bigIntNullableArray = bigIntArray.or("null");

// =============================================================================
// FILTER SCHEMAS - shorthand normalized to { equals: value } via pipe
// =============================================================================

export const bigIntFilter = type({
  equals: bigIntBase,
  not: bigIntNullable,
  in: bigIntBase.array(),
  notIn: bigIntBase.array(),
  lt: bigIntBase,
  lte: bigIntBase,
  gt: bigIntBase,
  gte: bigIntBase,
})
  .partial()
  .or(bigIntBase.pipe((v) => ({ equals: v })));

export const bigIntNullableFilter = type({
  equals: bigIntNullable,
  not: bigIntNullable,
  in: bigIntBase.array(),
  notIn: bigIntBase.array(),
  lt: bigIntNullable,
  lte: bigIntNullable,
  gt: bigIntNullable,
  gte: bigIntNullable,
})
  .partial()
  .or(bigIntNullable.pipe((v) => ({ equals: v })));

export const bigIntListFilter = type({
  equals: bigIntBase.array(),
  has: bigIntBase,
  hasEvery: bigIntBase.array(),
  hasSome: bigIntBase.array(),
  isEmpty: "boolean",
}).partial();

export const bigIntNullableListFilter = type({
  equals: bigIntNullableArray,
  has: bigIntBase,
  hasEvery: bigIntArray,
  hasSome: bigIntArray,
  isEmpty: "boolean",
}).partial();

// =============================================================================
// CREATE SCHEMAS
// =============================================================================

export const bigIntCreate = bigIntBase;
export const bigIntNullableCreate = bigIntNullable;
export const bigIntOptionalCreate = bigIntBase.or("undefined");
export const bigIntOptionalNullableCreate = bigIntNullable.or("undefined");
export const bigIntArrayCreate = bigIntArray;
export const bigIntNullableArrayCreate = bigIntNullableArray;
export const bigIntOptionalArrayCreate = bigIntArray.or("undefined");
export const bigIntOptionalNullableArrayCreate = bigIntNullableArray.or("undefined");

// =============================================================================
// UPDATE SCHEMAS - shorthand normalized to { set: value } via pipe
// =============================================================================

export const bigIntUpdate = type({
  set: bigIntBase,
  increment: bigIntBase,
  decrement: bigIntBase,
  multiply: bigIntBase,
  divide: bigIntBase,
})
  .partial()
  .or(bigIntBase.pipe((v) => ({ set: v })));

export const bigIntNullableUpdate = type({
  set: bigIntNullable,
  increment: bigIntBase,
  decrement: bigIntBase,
  multiply: bigIntBase,
  divide: bigIntBase,
})
  .partial()
  .or(bigIntNullable.pipe((v) => ({ set: v })));

export const bigIntArrayUpdate = type({
  set: bigIntBase.array(),
  push: bigIntBase.or(bigIntBase.array()),
  unshift: bigIntBase.or(bigIntBase.array()),
}).partial();

export const bigIntNullableArrayUpdate = type({
  set: bigIntNullableArray,
  push: bigIntBase.or(bigIntArray),
  unshift: bigIntBase.or(bigIntArray),
}).partial();

// =============================================================================
// TYPE EXPORTS
// Use inferIn for types with pipes (filters/updates) to get INPUT type
// =============================================================================

export type BigIntBase = typeof bigIntBase.infer;
export type BigIntNullable = typeof bigIntNullable.infer;
export type BigIntFilter = typeof bigIntFilter.inferIn;
export type BigIntNullableFilter = typeof bigIntNullableFilter.inferIn;
export type BigIntListFilter = typeof bigIntListFilter.infer;
export type BigIntUpdate = typeof bigIntUpdate.inferIn;
export type BigIntNullableUpdate = typeof bigIntNullableUpdate.inferIn;
