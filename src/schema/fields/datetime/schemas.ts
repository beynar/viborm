// DateTime Field Schemas
// Explicit ArkType schemas for all datetime field variants

import { type } from "arktype";

// =============================================================================
// BASE TYPES
// =============================================================================

export const dateTimeBase = type.instanceOf(Date);
export const dateTimeNullable = dateTimeBase.or("null");
export const dateTimeArray = dateTimeBase.array();
export const dateTimeNullableArray = dateTimeArray.or("null");

// Also accept ISO strings and convert to Date
export const dateTimeInput = type.instanceOf(Date).or("string");
export const dateTimeNullableInput = dateTimeInput.or("null");
export const dateTimeInputArray = dateTimeInput.array();
export const dateTimeNullableInputArray = dateTimeInputArray.or("null");

// =============================================================================
// FILTER SCHEMAS - Shorthand normalized to { equals: value } via pipe
// Pattern: union first, then pipe to normalize shorthand values
// =============================================================================

// Helper to check if value is a shorthand (Date or string, not an object with filter keys)
const isDateTimeShorthand = (v: unknown): v is Date | string =>
  v instanceof Date || typeof v === "string";

export const dateTimeFilter = type({
  equals: dateTimeInput,
  not: dateTimeNullableInput,
  in: dateTimeInput.array(),
  notIn: dateTimeInput.array(),
  lt: dateTimeInput,
  lte: dateTimeInput,
  gt: dateTimeInput,
  gte: dateTimeInput,
})
  .partial()
  .or(dateTimeInput)
  .pipe((v) => (isDateTimeShorthand(v) ? { equals: v } : v));

export const dateTimeNullableFilter = type({
  equals: dateTimeNullableInput,
  not: dateTimeNullableInput,
  in: dateTimeInput.array(),
  notIn: dateTimeInput.array(),
  lt: dateTimeNullableInput,
  lte: dateTimeNullableInput,
  gt: dateTimeNullableInput,
  gte: dateTimeNullableInput,
})
  .partial()
  .or(dateTimeNullableInput)
  .pipe((v) => (isDateTimeShorthand(v) || v === null ? { equals: v } : v));

export const dateTimeListFilter = type({
  equals: dateTimeInput.array(),
  has: dateTimeInput,
  hasEvery: dateTimeInput.array(),
  hasSome: dateTimeInput.array(),
  isEmpty: "boolean",
}).partial();

export const dateTimeNullableListFilter = type({
  equals: dateTimeNullableInputArray,
  has: dateTimeInput,
  hasEvery: dateTimeInputArray,
  hasSome: dateTimeInputArray,
  isEmpty: "boolean",
}).partial();

// =============================================================================
// CREATE SCHEMAS
// =============================================================================

export const dateTimeCreate = dateTimeInput;
export const dateTimeNullableCreate = dateTimeNullableInput;
export const dateTimeOptionalCreate = dateTimeInput.or("undefined");
export const dateTimeOptionalNullableCreate = dateTimeNullableInput.or("undefined");
export const dateTimeArrayCreate = dateTimeInputArray;
export const dateTimeNullableArrayCreate = dateTimeNullableInputArray;
export const dateTimeOptionalArrayCreate = dateTimeInputArray.or("undefined");
export const dateTimeOptionalNullableArrayCreate = dateTimeNullableInputArray.or("undefined");

// =============================================================================
// UPDATE SCHEMAS - Shorthand normalized to { set: value } via pipe
// =============================================================================

export const dateTimeUpdate = type({
  set: dateTimeInput,
})
  .partial()
  .or(dateTimeInput)
  .pipe((v) => (isDateTimeShorthand(v) ? { set: v } : v));

export const dateTimeNullableUpdate = type({
  set: dateTimeNullableInput,
})
  .partial()
  .or(dateTimeNullableInput)
  .pipe((v) => (isDateTimeShorthand(v) || v === null ? { set: v } : v));

export const dateTimeArrayUpdate = type({
  set: dateTimeInputArray,
  push: dateTimeInput.or(dateTimeInputArray),
  unshift: dateTimeInput.or(dateTimeInputArray),
}).partial();

export const dateTimeNullableArrayUpdate = type({
  set: dateTimeNullableInputArray,
  push: dateTimeInput.or(dateTimeInputArray),
  unshift: dateTimeInput.or(dateTimeInputArray),
}).partial();

// =============================================================================
// TYPE EXPORTS
// Use inferIn for piped schemas to get INPUT type (includes shorthand)
// =============================================================================

export type DateTimeBase = typeof dateTimeBase.infer;
export type DateTimeNullable = typeof dateTimeNullable.infer;
export type DateTimeInput = typeof dateTimeInput.infer;
export type DateTimeFilter = typeof dateTimeFilter.inferIn;
export type DateTimeNullableFilter = typeof dateTimeNullableFilter.inferIn;
export type DateTimeListFilter = typeof dateTimeListFilter.infer;
export type DateTimeUpdate = typeof dateTimeUpdate.inferIn;
export type DateTimeNullableUpdate = typeof dateTimeNullableUpdate.inferIn;
