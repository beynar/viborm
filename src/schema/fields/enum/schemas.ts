// Enum Field Schemas
// Explicit ArkType schemas for enum field variants
// Note: Enum schemas are created at runtime based on enum values using type.enumerated

import { type, Type } from "arktype";

// =============================================================================
// TYPE HELPERS FOR ENUM SCHEMAS
// =============================================================================

/** Base enum type */
export type EnumType<T extends readonly string[]> = Type<T[number], {}>;

/** Nullable enum type */
export type EnumNullableType<T extends readonly string[]> = Type<
  T[number] | null,
  {}
>;

/** Enum array type */
export type EnumArrayType<T extends readonly string[]> = Type<T[number][], {}>;

/** Nullable enum array type (the array itself is nullable, not elements) */
export type EnumNullableArrayType<T extends readonly string[]> = Type<
  T[number][] | null,
  {}
>;

/** Enum filter type */
export type EnumFilterType<T extends readonly string[]> = Type<
  | {
      equals?: T[number];
      not?: T[number] | null;
      in?: T[number][];
      notIn?: T[number][];
    }
  | T[number],
  {}
>;

/** Nullable enum filter type */
export type EnumNullableFilterType<T extends readonly string[]> = Type<
  | {
      equals?: T[number] | null;
      not?: T[number] | null;
      in?: T[number][];
      notIn?: T[number][];
    }
  | T[number]
  | null,
  {}
>;

/** Enum list filter type */
export type EnumListFilterType<T extends readonly string[]> = Type<
  {
    equals?: T[number][];
    has?: T[number];
    hasEvery?: T[number][];
    hasSome?: T[number][];
    isEmpty?: boolean;
  },
  {}
>;

/** Enum update type */
export type EnumUpdateType<T extends readonly string[]> = Type<
  { set?: T[number] } | T[number],
  {}
>;

/** Nullable enum update type */
export type EnumNullableUpdateType<T extends readonly string[]> = Type<
  { set?: T[number] | null } | T[number] | null,
  {}
>;

/** Enum array update type */
export type EnumArrayUpdateType<T extends readonly string[]> = Type<
  {
    set?: T[number][];
    push?: T[number] | T[number][];
    unshift?: T[number] | T[number][];
  },
  {}
>;

/** Optional enum create type */
export type EnumOptionalType<T extends readonly string[]> = Type<
  T[number] | undefined,
  {}
>;

/** Optional nullable enum create type */
export type EnumOptionalNullableType<T extends readonly string[]> = Type<
  T[number] | null | undefined,
  {}
>;

// =============================================================================
// SCHEMA BUILDERS
// =============================================================================

/**
 * Creates base enum schema from values using type.enumerated().
 */
export const createEnumBase = <T extends readonly string[]>(
  values: T
): EnumType<T> => {
  return type.enumerated(...values) as unknown as EnumType<T>;
};

/**
 * Creates nullable enum schema
 */
export const createEnumNullable = <T extends readonly string[]>(
  values: T
): EnumNullableType<T> => {
  return type
    .enumerated(...values)
    .or("null") as unknown as EnumNullableType<T>;
};

/**
 * Creates enum array schema
 */
export const createEnumArray = <T extends readonly string[]>(
  values: T
): EnumArrayType<T> => {
  return type.enumerated(...values).array() as unknown as EnumArrayType<T>;
};

/**
 * Creates nullable enum array schema (array itself is nullable)
 */
export const createEnumNullableArray = <T extends readonly string[]>(
  values: T
): EnumNullableArrayType<T> => {
  return type
    .enumerated(...values)
    .array()
    .or("null") as unknown as EnumNullableArrayType<T>;
};

/**
 * Creates enum filter schema with shorthand support.
 * Uses string for filter object fields and validates enum values via the shorthand union.
 * Shorthand is normalized to { equals: value } via pipe
 */
export const createEnumFilter = <T extends readonly string[]>(
  values: T
): EnumFilterType<T> => {
  const base = type.enumerated(...values);
  // Build filter object with string types (runtime will validate via base union)
  const filterObj = type({
    "equals?": "string",
    "not?": type("string").or("null"),
    "in?": "string[]",
    "notIn?": "string[]",
  });
  // Cast base to Type<string> and pipe to normalize shorthand
  return filterObj.or(
    (base as unknown as Type<string>).pipe((v) => ({ equals: v }))
  ) as unknown as EnumFilterType<T>;
};

/**
 * Creates nullable enum filter schema
 * Shorthand is normalized to { equals: value } via pipe
 */
export const createEnumNullableFilter = <T extends readonly string[]>(
  values: T
): EnumNullableFilterType<T> => {
  const nullable = type.enumerated(...values).or("null");
  const filterObj = type({
    "equals?": type("string").or("null"),
    "not?": type("string").or("null"),
    "in?": "string[]",
    "notIn?": "string[]",
  });
  // Cast to avoid type inference issues and pipe to normalize shorthand
  return filterObj.or(
    (nullable as unknown as Type<string | null>).pipe((v) => ({ equals: v }))
  ) as unknown as EnumNullableFilterType<T>;
};

/**
 * Creates enum list filter schema
 */
export const createEnumListFilter = <T extends readonly string[]>(
  _values: T
): EnumListFilterType<T> => {
  return type({
    "equals?": "string[]",
    "has?": "string",
    "hasEvery?": "string[]",
    "hasSome?": "string[]",
    "isEmpty?": "boolean",
  }) as unknown as EnumListFilterType<T>;
};

/**
 * Creates enum update schema with shorthand support
 * Shorthand is normalized to { set: value } via pipe
 */
export const createEnumUpdate = <T extends readonly string[]>(
  values: T
): EnumUpdateType<T> => {
  const base = type.enumerated(...values);
  const updateObj = type({
    "set?": "string",
  });
  // Cast base to Type<string> and pipe to normalize shorthand
  return updateObj.or(
    (base as unknown as Type<string>).pipe((v) => ({ set: v }))
  ) as unknown as EnumUpdateType<T>;
};

/**
 * Creates nullable enum update schema
 * Shorthand is normalized to { set: value } via pipe
 */
export const createEnumNullableUpdate = <T extends readonly string[]>(
  values: T
): EnumNullableUpdateType<T> => {
  const nullable = type.enumerated(...values).or("null");
  const updateObj = type({
    "set?": type("string").or("null"),
  });
  // Cast to avoid type inference issues and pipe to normalize shorthand
  return updateObj.or(
    (nullable as unknown as Type<string | null>).pipe((v) => ({ set: v }))
  ) as unknown as EnumNullableUpdateType<T>;
};

/**
 * Creates enum array update schema
 */
export const createEnumArrayUpdate = <T extends readonly string[]>(
  _values: T
): EnumArrayUpdateType<T> => {
  return type({
    "set?": "string[]",
    "push?": type("string").or("string[]"),
    "unshift?": type("string").or("string[]"),
  }) as unknown as EnumArrayUpdateType<T>;
};

/**
 * Creates optional enum create schema
 */
export const createEnumOptionalCreate = <T extends readonly string[]>(
  values: T
): EnumOptionalType<T> => {
  return type
    .enumerated(...values)
    .or("undefined") as unknown as EnumOptionalType<T>;
};

/**
 * Creates optional nullable enum create schema
 */
export const createEnumOptionalNullableCreate = <T extends readonly string[]>(
  values: T
): EnumOptionalNullableType<T> => {
  return type
    .enumerated(...values)
    .or("null")
    .or("undefined") as unknown as EnumOptionalNullableType<T>;
};
