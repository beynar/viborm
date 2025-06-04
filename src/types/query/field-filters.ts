import {
  BigIntField,
  BooleanField,
  DateTimeField,
  EnumField,
  JsonField,
  NumberField,
  StringField,
} from "@schema";
import { IsFieldArray, IsFieldNullable } from "../foundation/field-mapping";
import {
  string,
  number,
  boolean,
  date,
  enum as enumType,
  optional,
  array,
  object,
  nullable,
  type ZodMiniType,
  lazy,
  union,
  bigint,
  json,
} from "zod/v4-mini";

// Import base filter schemas from the main filters-input file
import {
  baseFilter,
  baseNullableFilter,
  baseListFilter,
  baseNullableListFilter,
  type InferFilter,
} from "./filters-input";

// ============================================================================
// STRING FILTERS
// ============================================================================
const baseStringFilter = () =>
  union([
    string(),
    object({
      contains: optional(string()),
      startsWith: optional(string()),
      endsWith: optional(string()),
      mode: optional(enumType(["default", "insensitive"])),
      lt: optional(string()),
      lte: optional(string()),
      gt: optional(string()),
      gte: optional(string()),
    }),
  ]);

export const stringFilter = lazy(() =>
  union([baseStringFilter(), baseFilter(string())])
);
export const nullableStringFilter = lazy(() =>
  union([nullable(baseStringFilter()), baseNullableFilter(string())])
);
export const stringArrayFilter = lazy(() =>
  union([baseListFilter(string()), array(string())])
);
export const nullableStringArrayFilter = lazy(() =>
  baseNullableListFilter(string())
);

export type StringFilter = InferFilter<typeof stringFilter>;
export type StringNullableFilter = InferFilter<typeof nullableStringFilter>;
export type StringArrayFilter = InferFilter<typeof stringArrayFilter>;
export type StringNullableArrayFilter = InferFilter<
  typeof nullableStringArrayFilter
>;

export type StringFilters<T extends StringField<any>> =
  IsFieldArray<T> extends true
    ? IsFieldNullable<T> extends true
      ? StringNullableArrayFilter
      : StringArrayFilter
    : IsFieldNullable<T> extends true
    ? StringNullableFilter
    : StringFilter;

// ============================================================================
// NUMBER FILTERS
// ============================================================================
const baseNumberFilter = () =>
  union([
    number(),
    object({
      lt: optional(number()),
      lte: optional(number()),
      gt: optional(number()),
      gte: optional(number()),
    }),
  ]);

export const numberFilter = lazy(() =>
  union([baseNumberFilter(), baseFilter(number())])
);
export const nullableNumberFilter = lazy(() =>
  union([nullable(baseNumberFilter()), baseNullableFilter(number())])
);
export const numberArrayFilter = lazy(() =>
  union([baseListFilter(number()), array(number())])
);
export const nullableNumberArrayFilter = lazy(() =>
  baseNullableListFilter(number())
);

export type NumberFilter = InferFilter<typeof numberFilter>;
export type NumberNullableFilter = InferFilter<typeof nullableNumberFilter>;
export type NumberArrayFilter = InferFilter<typeof numberArrayFilter>;
export type NumberNullableArrayFilter = InferFilter<
  typeof nullableNumberArrayFilter
>;
export type IntFilter = NumberFilter;
export type IntNullableFilter = NumberNullableFilter;
export type IntArrayFilter = NumberArrayFilter;
export type IntNullableArrayFilter = NumberNullableArrayFilter;
export type FloatFilter = NumberFilter;
export type FloatNullableFilter = NumberNullableFilter;
export type FloatArrayFilter = NumberArrayFilter;
export type FloatNullableArrayFilter = NumberNullableArrayFilter;

export type NumberFilters<T extends NumberField<any>> =
  IsFieldArray<T> extends true
    ? IsFieldNullable<T> extends true
      ? NumberNullableArrayFilter
      : NumberArrayFilter
    : IsFieldNullable<T> extends true
    ? NumberNullableFilter
    : NumberFilter;

// ============================================================================
// BOOLEAN FILTERS
// ============================================================================
const baseBooleanFilter = () => boolean();

export const booleanFilter = lazy(() =>
  union([baseBooleanFilter(), baseFilter(boolean())])
);
export const nullableBooleanFilter = lazy(() =>
  union([nullable(baseBooleanFilter()), baseNullableFilter(boolean())])
);
export const booleanArrayFilter = lazy(() =>
  union([baseListFilter(boolean()), array(boolean())])
);
export const nullableBooleanArrayFilter = lazy(() =>
  baseNullableListFilter(boolean())
);

export type BoolFilter = InferFilter<typeof booleanFilter>;
export type BoolNullableFilter = InferFilter<typeof nullableBooleanFilter>;
export type BoolArrayFilter = InferFilter<typeof booleanArrayFilter>;
export type BoolNullableArrayFilter = InferFilter<
  typeof nullableBooleanArrayFilter
>;

export type BooleanFilters<T extends BooleanField<any>> =
  IsFieldArray<T> extends true
    ? IsFieldNullable<T> extends true
      ? BoolNullableArrayFilter
      : BoolArrayFilter
    : IsFieldNullable<T> extends true
    ? BoolNullableFilter
    : BoolFilter;

// ============================================================================
// DATETIME FILTERS
// ============================================================================
const baseDateTimeFilter = () =>
  union([
    date(),
    object({
      lt: optional(date()),
      lte: optional(date()),
      gt: optional(date()),
      gte: optional(date()),
    }),
  ]);

export const dateTimeFilter = lazy(() =>
  union([baseDateTimeFilter(), baseFilter(date())])
);
export const nullableDateTimeFilter = lazy(() =>
  union([nullable(baseDateTimeFilter()), baseNullableFilter(date())])
);
export const dateTimeArrayFilter = lazy(() =>
  union([baseListFilter(date()), array(date())])
);
export const nullableDateTimeArrayFilter = lazy(() =>
  baseNullableListFilter(date())
);

export type DateTimeFilter = InferFilter<typeof dateTimeFilter>;
export type DateTimeNullableFilter = InferFilter<typeof nullableDateTimeFilter>;
export type DateTimeArrayFilter = InferFilter<typeof dateTimeArrayFilter>;
export type DateTimeNullableArrayFilter = InferFilter<
  typeof nullableDateTimeArrayFilter
>;

export type DateTimeFilters<T extends DateTimeField<any>> =
  IsFieldArray<T> extends true
    ? IsFieldNullable<T> extends true
      ? DateTimeNullableArrayFilter
      : DateTimeArrayFilter
    : IsFieldNullable<T> extends true
    ? DateTimeNullableFilter
    : DateTimeFilter;

// ============================================================================
// BIGINT FILTERS
// ============================================================================
const baseBigIntFilter = () =>
  union([
    bigint(),
    object({
      lt: optional(bigint()),
      lte: optional(bigint()),
      gt: optional(bigint()),
      gte: optional(bigint()),
    }),
  ]);

export const bigIntFilter = lazy(() =>
  union([baseBigIntFilter(), baseFilter(bigint())])
);
export const nullableBigIntFilter = lazy(() =>
  union([nullable(baseBigIntFilter()), baseNullableFilter(bigint())])
);
export const bigIntArrayFilter = lazy(() =>
  union([baseListFilter(bigint()), array(bigint())])
);
export const nullableBigIntArrayFilter = lazy(() =>
  baseNullableListFilter(bigint())
);

export type BigIntFilter = InferFilter<typeof bigIntFilter>;
export type BigIntNullableFilter = InferFilter<typeof nullableBigIntFilter>;
export type BigIntArrayFilter = InferFilter<typeof bigIntArrayFilter>;
export type BigIntNullableArrayFilter = InferFilter<
  typeof nullableBigIntArrayFilter
>;

export type BigIntFilters<T extends BigIntField<any>> =
  IsFieldArray<T> extends true
    ? IsFieldNullable<T> extends true
      ? BigIntNullableArrayFilter
      : BigIntArrayFilter
    : IsFieldNullable<T> extends true
    ? BigIntNullableFilter
    : BigIntFilter;

// ============================================================================
// JSON FILTERS
// ============================================================================
const baseJsonFilter = lazy(() =>
  object({
    path: optional(array(string())),
    equals: optional(json()),
    not: optional(json()),
    string_contains: optional(json()),
    string_starts_with: optional(json()),
    string_ends_with: optional(json()),
    array_contains: optional(json()),
    array_starts_with: optional(json()),
    array_ends_with: optional(json()),
  })
);

export const jsonFilter = lazy(() =>
  union([baseJsonFilter, baseFilter(json())])
);
export const nullableJsonFilter = lazy(() =>
  union([nullable(baseJsonFilter), baseNullableFilter(json())])
);

export type JsonFilter = InferFilter<typeof jsonFilter>;
export type JsonNullableFilter = InferFilter<typeof nullableJsonFilter>;

export type JsonFilters<T extends JsonField<any, any>> =
  IsFieldNullable<T> extends true ? JsonNullableFilter : JsonFilter;

// ============================================================================
// ENUM FILTERS
// ============================================================================
const enumFilter = <T extends string[]>(values: T) =>
  union([enumType(values), baseFilter(enumType(values))]);

const nullableEnumFilter = <T extends string[]>(values: T) =>
  union([nullable(enumType(values)), baseNullableFilter(enumType(values))]);

const enumArrayFilter = <T extends string[]>(values: T) =>
  union([baseListFilter(enumType(values)), array(enumType(values))]);

const nullableEnumArrayFilter = <T extends string[]>(values: T) =>
  baseNullableListFilter(enumType(values));

export type EnumFilter<T extends string[]> = InferFilter<
  ReturnType<typeof enumFilter<T>>
>;
export type EnumNullableFilter<T extends string[]> = InferFilter<
  ReturnType<typeof nullableEnumFilter<T>>
>;
export type EnumArrayFilter<T extends string[]> = InferFilter<
  ReturnType<typeof enumArrayFilter<T>>
>;
export type EnumNullableArrayFilter<T extends string[]> = InferFilter<
  ReturnType<typeof nullableEnumArrayFilter<T>>
>;

export type EnumFilters<T extends EnumField<any, any>> = T extends EnumField<
  infer E,
  any
>
  ? E extends string[]
    ? IsFieldArray<T> extends true
      ? IsFieldNullable<T> extends true
        ? EnumNullableArrayFilter<E>
        : EnumArrayFilter<E>
      : IsFieldNullable<T> extends true
      ? EnumNullableFilter<E>
      : EnumFilter<E>
    : never
  : never;

export const filterValidators = {
  string: {
    base: stringFilter,
    nullable: nullableStringFilter,
    array: stringArrayFilter,
    nullableArray: nullableStringArrayFilter,
  },
  number: {
    base: numberFilter,
    nullable: nullableNumberFilter,
    array: numberArrayFilter,
    nullableArray: nullableNumberArrayFilter,
  },
  boolean: {
    base: booleanFilter,
    nullable: nullableBooleanFilter,
    array: booleanArrayFilter,
    nullableArray: nullableBooleanArrayFilter,
  },
  dateTime: {
    base: dateTimeFilter,
    nullable: nullableDateTimeFilter,
    array: dateTimeArrayFilter,
    nullableArray: nullableDateTimeArrayFilter,
  },
  bigInt: {
    base: bigIntFilter,
    nullable: nullableBigIntFilter,
    array: bigIntArrayFilter,
    nullableArray: nullableBigIntArrayFilter,
  },
  json: {
    base: jsonFilter,
    nullable: nullableJsonFilter,
  },
  enum<T extends string[]>(values: T) {
    return {
      base: enumFilter(values),
      nullable: nullableEnumFilter(values),
      array: enumArrayFilter(values),
      nullableArray: nullableEnumArrayFilter(values),
    };
  },
};
