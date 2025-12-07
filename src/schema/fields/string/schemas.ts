// String Field Schemas
// Explicit ArkType schemas for all string field variants

import { type } from "arktype";

// =============================================================================
// BASE TYPES
// =============================================================================

export const stringBase = type.string;
export const stringNullable = stringBase.or("null");
export const stringArray = stringBase.array();
export const stringNullableArray = stringArray.or("null");

// =============================================================================
// FILTER SCHEMAS
// =============================================================================

// Base filter object without `not` (used for recursive `not` definition)
const stringFilterBase = type({
  equals: stringBase,
  in: stringBase.array(),
  notIn: stringBase.array(),
  // String-specific filters
  contains: stringBase,
  startsWith: stringBase,
  endsWith: stringBase,
  mode: "'default' | 'insensitive'",
  // Comparable filters
  lt: stringBase,
  lte: stringBase,
  gt: stringBase,
  gte: stringBase,
}).partial();

const stringNullableFilterBase = type({
  equals: stringNullable,
  in: stringBase.array(),
  notIn: stringBase.array(),
  // String-specific filters
  contains: stringBase,
  startsWith: stringBase,
  endsWith: stringBase,
  mode: "'default' | 'insensitive'",
  // Comparable filters
  lt: stringNullable,
  lte: stringNullable,
  gt: stringNullable,
  gte: stringNullable,
}).partial();

/**
 * String filter with shorthand support: { equals: "foo" } OR just "foo"
 * `not` accepts both direct value AND nested filter object
 * Shorthand is normalized to { equals: value } via pipe
 */
export const stringFilter = stringFilterBase
  .merge(type({ "not?": stringFilterBase.or(stringNullable) }))
  .or(stringBase.pipe((v) => ({ equals: v })));

/**
 * Nullable string filter with shorthand support
 * `not` accepts both direct value AND nested filter object
 * Shorthand is normalized to { equals: value } via pipe
 */
export const stringNullableFilter = stringNullableFilterBase
  .merge(type({ "not?": stringNullableFilterBase.or(stringNullable) }))
  .or(stringNullable.pipe((v) => ({ equals: v })));

/**
 * String list filter (for array fields)
 */
export const stringListFilter = type({
  equals: stringBase.array(),
  has: stringBase,
  hasEvery: stringBase.array(),
  hasSome: stringBase.array(),
  isEmpty: "boolean",
}).partial();

/**
 * Nullable string list filter (for string[] | null fields)
 */
export const stringNullableListFilter = type({
  equals: stringNullableArray,
  has: stringBase,
  hasEvery: stringArray,
  hasSome: stringArray,
  isEmpty: "boolean",
}).partial();

// =============================================================================
// CREATE SCHEMAS
// =============================================================================

export const stringCreate = stringBase;
export const stringNullableCreate = stringNullable;
export const stringOptionalCreate = stringBase.or("undefined");
export const stringOptionalNullableCreate = stringNullable.or("undefined");

// Array creates
export const stringArrayCreate = stringArray;
export const stringNullableArrayCreate = stringNullableArray;
export const stringOptionalArrayCreate = stringArray.or("undefined");
export const stringOptionalNullableArrayCreate =
  stringNullableArray.or("undefined");

// =============================================================================
// UPDATE SCHEMAS
// =============================================================================

/**
 * String update with shorthand support: { set: "foo" } OR just "foo"
 * Shorthand is normalized to { set: value } via pipe
 */
export const stringUpdate = type({
  set: stringBase,
})
  .partial()
  .or(stringBase.pipe((v) => ({ set: v })));

/**
 * Nullable string update with shorthand support
 * Shorthand is normalized to { set: value } via pipe
 */
export const stringNullableUpdate = type({
  set: stringNullable,
})
  .partial()
  .or(stringNullable.pipe((v) => ({ set: v })));

/**
 * String array update (no shorthand for arrays)
 */
export const stringArrayUpdate = type({
  set: stringBase.array(),
  push: stringBase.or(stringBase.array()),
  unshift: stringBase.or(stringBase.array()),
}).partial();

/**
 * Nullable string array update (array can be null, elements are strings)
 */
export const stringNullableArrayUpdate = type({
  set: stringNullableArray,
  push: stringBase.or(stringArray),
  unshift: stringBase.or(stringArray),
}).partial();

// =============================================================================
// TYPE EXPORTS (derived from schemas)
// Use inferIn for types with pipes (filters/updates) to get INPUT type, not output
// =============================================================================

export type StringBase = typeof stringBase.infer;
export type StringNullable = typeof stringNullable.infer;
export type StringArray = typeof stringArray.infer;
export type StringNullableArray = typeof stringNullableArray.infer;

// Filters use inferIn because pipe transforms output but users input the shorthand
export type StringFilter = typeof stringFilter.inferIn;
export type StringNullableFilter = typeof stringNullableFilter.inferIn;
export type StringListFilter = typeof stringListFilter.infer;
export type StringNullableListFilter = typeof stringNullableListFilter.infer;

export type StringCreate = typeof stringCreate.infer;
export type StringNullableCreate = typeof stringNullableCreate.infer;
export type StringOptionalCreate = typeof stringOptionalCreate.infer;
export type StringOptionalNullableCreate =
  typeof stringOptionalNullableCreate.infer;

// Updates use inferIn because pipe transforms output but users input the shorthand
export type StringUpdate = typeof stringUpdate.inferIn;
export type StringNullableUpdate = typeof stringNullableUpdate.inferIn;
export type StringArrayUpdate = typeof stringArrayUpdate.infer;
export type StringNullableArrayUpdate = typeof stringNullableArrayUpdate.infer;
