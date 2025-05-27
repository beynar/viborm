// Filter Type Definitions
// For where clauses and field filtering

import type { QueryMode, SortOrder } from "./queries.js";

// Base filter operations
export interface BaseFilter<T> {
  equals?: T;
  not?: T | BaseFilter<T>;
  in?: T[];
  notIn?: T[];
}

// String-specific filters
export interface StringFilter extends BaseFilter<string> {
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  mode?: QueryMode;
  lt?: string;
  lte?: string;
  gt?: string;
  gte?: string;
}

export interface StringNullableFilter
  extends Omit<StringFilter, "equals" | "not"> {
  equals?: string | null;
  not?: string | null | StringNullableFilter;
}

// Number-specific filters
export interface NumberFilter extends BaseFilter<number> {
  lt?: number;
  lte?: number;
  gt?: number;
  gte?: number;
}

export interface NumberNullableFilter
  extends Omit<NumberFilter, "equals" | "not"> {
  equals?: number | null;
  not?: number | null | NumberNullableFilter;
}

// Integer filters
export type IntFilter = NumberFilter;
export type IntNullableFilter = NumberNullableFilter;

// Float filters
export type FloatFilter = NumberFilter;
export type FloatNullableFilter = NumberNullableFilter;

// BigInt filters
export interface BigIntFilter extends BaseFilter<bigint> {
  lt?: bigint;
  lte?: bigint;
  gt?: bigint;
  gte?: bigint;
}

export interface BigIntNullableFilter
  extends Omit<BigIntFilter, "equals" | "not"> {
  equals?: bigint | null;
  not?: bigint | null | BigIntNullableFilter;
}

// Boolean filters
export interface BoolFilter extends BaseFilter<boolean> {}

export interface BoolNullableFilter extends Omit<BoolFilter, "equals" | "not"> {
  equals?: boolean | null;
  not?: boolean | null | BoolNullableFilter;
}

// DateTime filters
export interface DateTimeFilter extends BaseFilter<Date> {
  lt?: Date;
  lte?: Date;
  gt?: Date;
  gte?: Date;
}

export interface DateTimeNullableFilter
  extends Omit<DateTimeFilter, "equals" | "not"> {
  equals?: Date | null;
  not?: Date | null | DateTimeNullableFilter;
}

// JSON filters
export interface JsonFilter {
  equals?: any;
  not?: any;
  path?: string[];
  string_contains?: string;
  string_starts_with?: string;
  string_ends_with?: string;
  array_contains?: any;
  array_starts_with?: any;
  array_ends_with?: any;
}

export interface JsonNullableFilter extends JsonFilter {
  equals?: any | null;
  not?: any | null | JsonNullableFilter;
}

// Enum filters
export interface EnumFilter<T extends string | number> extends BaseFilter<T> {}

export interface EnumNullableFilter<T extends string | number>
  extends Omit<EnumFilter<T>, "equals" | "not"> {
  equals?: T | null;
  not?: T | null | EnumNullableFilter<T>;
}

// List/Array filters
export interface ListFilter<T> {
  equals?: T[];
  has?: T;
  hasEvery?: T[];
  hasSome?: T[];
  isEmpty?: boolean;
}

// Composite filters for complex queries
export interface WhereInputBase<TModel> {
  AND?: TModel | TModel[];
  OR?: TModel[];
  NOT?: TModel | TModel[];
}

// Field update operations
export interface StringFieldUpdateOperationsInput {
  set?: string;
}

export interface NullableStringFieldUpdateOperationsInput {
  set?: string | null;
}

export interface IntFieldUpdateOperationsInput {
  set?: number;
  increment?: number;
  decrement?: number;
  multiply?: number;
  divide?: number;
}

export interface NullableIntFieldUpdateOperationsInput {
  set?: number | null;
  increment?: number;
  decrement?: number;
  multiply?: number;
  divide?: number;
}

export interface FloatFieldUpdateOperationsInput {
  set?: number;
  increment?: number;
  decrement?: number;
  multiply?: number;
  divide?: number;
}

export interface NullableFloatFieldUpdateOperationsInput {
  set?: number | null;
  increment?: number;
  decrement?: number;
  multiply?: number;
  divide?: number;
}

export interface BigIntFieldUpdateOperationsInput {
  set?: bigint;
  increment?: bigint;
  decrement?: bigint;
  multiply?: bigint;
  divide?: bigint;
}

export interface NullableBigIntFieldUpdateOperationsInput {
  set?: bigint | null;
  increment?: bigint;
  decrement?: bigint;
  multiply?: bigint;
  divide?: bigint;
}

export interface BoolFieldUpdateOperationsInput {
  set?: boolean;
}

export interface NullableBoolFieldUpdateOperationsInput {
  set?: boolean | null;
}

export interface DateTimeFieldUpdateOperationsInput {
  set?: Date;
}

export interface NullableDateTimeFieldUpdateOperationsInput {
  set?: Date | null;
}

export interface JsonFieldUpdateOperationsInput {
  set?: any;
}

export interface NullableJsonFieldUpdateOperationsInput {
  set?: any | null;
}

export interface EnumFieldUpdateOperationsInput<T extends string | number> {
  set?: T;
}

export interface NullableEnumFieldUpdateOperationsInput<
  T extends string | number
> {
  set?: T | null;
}

// Aggregate filters
export interface NestedIntFilter {
  equals?: number;
  in?: number[];
  notIn?: number[];
  lt?: number;
  lte?: number;
  gt?: number;
  gte?: number;
  not?: NestedIntFilter;
}

export interface NestedFloatFilter {
  equals?: number;
  in?: number[];
  notIn?: number[];
  lt?: number;
  lte?: number;
  gt?: number;
  gte?: number;
  not?: NestedFloatFilter;
}

export interface NestedBoolFilter {
  equals?: boolean;
  not?: NestedBoolFilter;
}

export interface NestedStringFilter {
  equals?: string;
  in?: string[];
  notIn?: string[];
  lt?: string;
  lte?: string;
  gt?: string;
  gte?: string;
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  not?: NestedStringFilter;
}

export interface NestedDateTimeFilter {
  equals?: Date;
  in?: Date[];
  notIn?: Date[];
  lt?: Date;
  lte?: Date;
  gt?: Date;
  gte?: Date;
  not?: NestedDateTimeFilter;
}

// Utility type for field filters
export type FieldFilter<T> = T extends string
  ? StringFilter | string
  : T extends string | null
  ? StringNullableFilter | string | null
  : T extends number
  ? NumberFilter | number
  : T extends number | null
  ? NumberNullableFilter | number | null
  : T extends bigint
  ? BigIntFilter | bigint
  : T extends bigint | null
  ? BigIntNullableFilter | bigint | null
  : T extends boolean
  ? BoolFilter | boolean
  : T extends boolean | null
  ? BoolNullableFilter | boolean | null
  : T extends Date
  ? DateTimeFilter | Date
  : T extends Date | null
  ? DateTimeNullableFilter | Date | null
  : T extends Array<infer U>
  ? ListFilter<U>
  : T extends any
  ? JsonFilter | T
  : never;
