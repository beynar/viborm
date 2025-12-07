// Number Field Schemas (int, float, decimal)
// Explicit ArkType schemas for all number field variants

import { type } from "arktype";

// =============================================================================
// BASE TYPES
// =============================================================================

// Integer types
// Integer type - use number with narrow constraint
export const intBase = type.number.narrow((n, ctx) => {
  if (Number.isInteger(n)) return true;
  return ctx.mustBe("an integer");
});
export const intNullable = intBase.or("null");
export const intArray = intBase.array();
export const intNullableArray = intArray.or("null");

// Float/Decimal types (use number for both)
export const floatBase = type.number;
export const floatNullable = floatBase.or("null");
export const floatArray = floatBase.array();
export const floatNullableArray = floatArray.or("null");

// =============================================================================
// FILTER SCHEMAS
// =============================================================================

// Base filter objects without `not` (used for recursive `not` definition)
const intFilterBase = type({
  equals: intBase,
  in: intBase.array(),
  notIn: intBase.array(),
  lt: intBase,
  lte: intBase,
  gt: intBase,
  gte: intBase,
}).partial();

const intNullableFilterBase = type({
  equals: intNullable,
  in: intBase.array(),
  notIn: intBase.array(),
  lt: intNullable,
  lte: intNullable,
  gt: intNullable,
  gte: intNullable,
}).partial();

// Integer filters - shorthand normalized to { equals: value } via pipe
// `not` accepts both direct value AND nested filter object
export const intFilter = intFilterBase
  .merge(type({ "not?": intFilterBase.or(intNullable) }))
  .or(intBase.pipe((v) => ({ equals: v })));

export const intNullableFilter = intNullableFilterBase
  .merge(type({ "not?": intNullableFilterBase.or(intNullable) }))
  .or(intNullable.pipe((v) => ({ equals: v })));

export const intListFilter = type({
  equals: intBase.array(),
  has: intBase,
  hasEvery: intBase.array(),
  hasSome: intBase.array(),
  isEmpty: "boolean",
}).partial();

export const intNullableListFilter = type({
  equals: intNullableArray,
  has: intBase,
  hasEvery: intArray,
  hasSome: intArray,
  isEmpty: "boolean",
}).partial();

// Base filter objects for float without `not`
const floatFilterBase = type({
  equals: floatBase,
  in: floatBase.array(),
  notIn: floatBase.array(),
  lt: floatBase,
  lte: floatBase,
  gt: floatBase,
  gte: floatBase,
}).partial();

const floatNullableFilterBase = type({
  equals: floatNullable,
  in: floatBase.array(),
  notIn: floatBase.array(),
  lt: floatNullable,
  lte: floatNullable,
  gt: floatNullable,
  gte: floatNullable,
}).partial();

// Float filters - shorthand normalized to { equals: value } via pipe
// `not` accepts both direct value AND nested filter object
export const floatFilter = floatFilterBase
  .merge(type({ "not?": floatFilterBase.or(floatNullable) }))
  .or(floatBase.pipe((v) => ({ equals: v })));

export const floatNullableFilter = floatNullableFilterBase
  .merge(type({ "not?": floatNullableFilterBase.or(floatNullable) }))
  .or(floatNullable.pipe((v) => ({ equals: v })));

export const floatListFilter = type({
  equals: floatBase.array(),
  has: floatBase,
  hasEvery: floatBase.array(),
  hasSome: floatBase.array(),
  isEmpty: "boolean",
}).partial();

export const floatNullableListFilter = type({
  equals: floatNullableArray,
  has: floatBase,
  hasEvery: floatArray,
  hasSome: floatArray,
  isEmpty: "boolean",
}).partial();

// =============================================================================
// CREATE SCHEMAS
// =============================================================================

// Integer creates
export const intCreate = intBase;
export const intNullableCreate = intNullable;
export const intOptionalCreate = intBase.or("undefined");
export const intOptionalNullableCreate = intNullable.or("undefined");
export const intArrayCreate = intArray;
export const intNullableArrayCreate = intNullableArray;
export const intOptionalArrayCreate = intArray.or("undefined");
export const intOptionalNullableArrayCreate = intNullableArray.or("undefined");

// Float creates
export const floatCreate = floatBase;
export const floatNullableCreate = floatNullable;
export const floatOptionalCreate = floatBase.or("undefined");
export const floatOptionalNullableCreate = floatNullable.or("undefined");
export const floatArrayCreate = floatArray;
export const floatNullableArrayCreate = floatNullableArray;
export const floatOptionalArrayCreate = floatArray.or("undefined");
export const floatOptionalNullableArrayCreate = floatNullableArray.or("undefined");

// =============================================================================
// UPDATE SCHEMAS
// =============================================================================

// Integer updates with numeric operations - shorthand normalized to { set: value } via pipe
export const intUpdate = type({
  set: intBase,
  increment: intBase,
  decrement: intBase,
  multiply: intBase,
  divide: intBase,
})
  .partial()
  .or(intBase.pipe((v) => ({ set: v })));

export const intNullableUpdate = type({
  set: intNullable,
  increment: intBase,
  decrement: intBase,
  multiply: intBase,
  divide: intBase,
})
  .partial()
  .or(intNullable.pipe((v) => ({ set: v })));

export const intArrayUpdate = type({
  set: intBase.array(),
  push: intBase.or(intBase.array()),
  unshift: intBase.or(intBase.array()),
}).partial();

export const intNullableArrayUpdate = type({
  set: intNullableArray,
  push: intBase.or(intArray),
  unshift: intBase.or(intArray),
}).partial();

// Float updates with numeric operations - shorthand normalized to { set: value } via pipe
export const floatUpdate = type({
  set: floatBase,
  increment: floatBase,
  decrement: floatBase,
  multiply: floatBase,
  divide: floatBase,
})
  .partial()
  .or(floatBase.pipe((v) => ({ set: v })));

export const floatNullableUpdate = type({
  set: floatNullable,
  increment: floatBase,
  decrement: floatBase,
  multiply: floatBase,
  divide: floatBase,
})
  .partial()
  .or(floatNullable.pipe((v) => ({ set: v })));

export const floatArrayUpdate = type({
  set: floatBase.array(),
  push: floatBase.or(floatBase.array()),
  unshift: floatBase.or(floatBase.array()),
}).partial();

export const floatNullableArrayUpdate = type({
  set: floatNullableArray,
  push: floatBase.or(floatArray),
  unshift: floatBase.or(floatArray),
}).partial();

// =============================================================================
// TYPE EXPORTS
// Use inferIn for types with pipes (filters/updates) to get INPUT type
// =============================================================================

export type IntBase = typeof intBase.infer;
export type IntNullable = typeof intNullable.infer;
export type IntFilter = typeof intFilter.inferIn;
export type IntNullableFilter = typeof intNullableFilter.inferIn;
export type IntListFilter = typeof intListFilter.infer;
export type IntUpdate = typeof intUpdate.inferIn;
export type IntNullableUpdate = typeof intNullableUpdate.inferIn;

export type FloatBase = typeof floatBase.infer;
export type FloatNullable = typeof floatNullable.infer;
export type FloatFilter = typeof floatFilter.inferIn;
export type FloatNullableFilter = typeof floatNullableFilter.inferIn;
export type FloatListFilter = typeof floatListFilter.infer;
export type FloatUpdate = typeof floatUpdate.inferIn;
export type FloatNullableUpdate = typeof floatNullableUpdate.inferIn;
