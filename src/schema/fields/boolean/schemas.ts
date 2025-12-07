// Boolean Field Schemas
// Explicit ArkType schemas for all boolean field variants

import { type } from "arktype";

// =============================================================================
// BASE TYPES
// =============================================================================

export const booleanBase = type.boolean;
export const booleanNullable = booleanBase.or("null");
export const booleanArray = booleanBase.array();
export const booleanNullableArray = booleanArray.or("null");

// =============================================================================
// FILTER SCHEMAS - shorthand normalized to { equals: value } via pipe
// =============================================================================

// Base filter objects without `not` (used for recursive `not` definition)
const booleanFilterBase = type({
  equals: booleanBase,
}).partial();

const booleanNullableFilterBase = type({
  equals: booleanNullable,
}).partial();

// `not` accepts both direct value AND nested filter object
export const booleanFilter = booleanFilterBase
  .merge(type({ "not?": booleanFilterBase.or(booleanNullable) }))
  .or(booleanBase.pipe((v) => ({ equals: v })));

export const booleanNullableFilter = booleanNullableFilterBase
  .merge(type({ "not?": booleanNullableFilterBase.or(booleanNullable) }))
  .or(booleanNullable.pipe((v) => ({ equals: v })));

export const booleanListFilter = type({
  equals: booleanBase.array(),
  has: booleanBase,
  hasEvery: booleanBase.array(),
  hasSome: booleanBase.array(),
  isEmpty: "boolean",
}).partial();

export const booleanNullableListFilter = type({
  equals: booleanNullableArray,
  has: booleanBase,
  hasEvery: booleanArray,
  hasSome: booleanArray,
  isEmpty: "boolean",
}).partial();

// =============================================================================
// CREATE SCHEMAS
// =============================================================================

export const booleanCreate = booleanBase;
export const booleanNullableCreate = booleanNullable;
export const booleanOptionalCreate = booleanBase.or("undefined");
export const booleanOptionalNullableCreate = booleanNullable.or("undefined");
export const booleanArrayCreate = booleanArray;
export const booleanNullableArrayCreate = booleanNullableArray;
export const booleanOptionalArrayCreate = booleanArray.or("undefined");
export const booleanOptionalNullableArrayCreate = booleanNullableArray.or("undefined");

// =============================================================================
// UPDATE SCHEMAS - shorthand normalized to { set: value } via pipe
// =============================================================================

export const booleanUpdate = type({
  set: booleanBase,
})
  .partial()
  .or(booleanBase.pipe((v) => ({ set: v })));

export const booleanNullableUpdate = type({
  set: booleanNullable,
})
  .partial()
  .or(booleanNullable.pipe((v) => ({ set: v })));

export const booleanArrayUpdate = type({
  set: booleanBase.array(),
  push: booleanBase.or(booleanBase.array()),
  unshift: booleanBase.or(booleanBase.array()),
}).partial();

export const booleanNullableArrayUpdate = type({
  set: booleanNullableArray,
  push: booleanBase.or(booleanArray),
  unshift: booleanBase.or(booleanArray),
}).partial();

// =============================================================================
// TYPE EXPORTS
// Use inferIn for types with pipes (filters/updates) to get INPUT type
// =============================================================================

export type BooleanBase = typeof booleanBase.infer;
export type BooleanNullable = typeof booleanNullable.infer;
export type BooleanFilter = typeof booleanFilter.inferIn;
export type BooleanNullableFilter = typeof booleanNullableFilter.inferIn;
export type BooleanListFilter = typeof booleanListFilter.infer;
export type BooleanUpdate = typeof booleanUpdate.inferIn;
export type BooleanNullableUpdate = typeof booleanNullableUpdate.inferIn;
