import {
  BaseField,
  BigIntField,
  BooleanField,
  DateTimeField,
  EnumField,
  JsonField,
  NumberField,
  StringField,
} from "../../../schema";
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
  literal,
  omit,
  any,
  bigint,
  json,
  extend,
} from "zod/v4-mini";

export type QueryMode = "default" | "insensitive";
export type NullsOrder = "first" | "last";

// Base filter schemas
const baseFilter = <Z extends ZodMiniType>(schema: Z) =>
  object({
    equals: optional(schema),
    not: optional(
      union([
        schema,
        object({
          equals: optional(schema),
          notIn: optional(array(schema)),
          in: optional(array(schema)),
        }),
      ])
    ),
    in: optional(array(schema)),
    notIn: optional(array(schema)),
  });

const baseNullableFilter = <Z extends ZodMiniType>(schema: Z) =>
  object({
    equals: optional(nullable(schema)),
    not: optional(
      union([
        nullable(schema),
        object({
          equals: optional(nullable(schema)),
          notIn: optional(array(schema)),
          in: optional(array(schema)),
        }),
      ])
    ),
    in: optional(array(schema)),
    notIn: optional(array(schema)),
  });

// List/Array filters
const baseListFilter = <T extends ZodMiniType>(schema: T) =>
  object({
    equals: optional(array(schema)),
    has: optional(schema),
    hasEvery: optional(array(schema)),
    hasSome: optional(array(schema)),
    isEmpty: optional(boolean()),
  });

const baseNullableListFilter = <T extends ZodMiniType>(schema: T) =>
  nullable(
    union([
      extend(omit(baseListFilter(schema), { equals: true }), {
        equals: optional(nullable(array(schema))),
      }),
      array(schema),
    ])
  );

// Type inference helper
type InferFilter<T> = T extends ZodMiniType ? T["_zod"]["input"] : never;

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

type StringFilters<T extends StringField<any>> = IsFieldArray<T> extends true
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

type NumberFilters<T extends NumberField<any>> = IsFieldArray<T> extends true
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

type BooleanFilters<T extends BooleanField<any>> = IsFieldArray<T> extends true
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

type DateTimeFilters<T extends DateTimeField<any>> =
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

type BigIntFilters<T extends BigIntField<any>> = IsFieldArray<T> extends true
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

type JsonFilters<T extends JsonField<any, any>> =
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

type EnumFilters<T extends EnumField<any, any>> = T extends EnumField<
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

// ============================================================================
// COMPOSITE FILTERS
// ============================================================================
const whereInputBase = <TModel extends ZodMiniType>(modelSchema: TModel) =>
  object({
    AND: optional(union([modelSchema, array(modelSchema)])),
    OR: optional(array(modelSchema)),
    NOT: optional(union([modelSchema, array(modelSchema)])),
  });

export type WhereInputBase<TModel extends ZodMiniType> = InferFilter<
  ReturnType<typeof whereInputBase<TModel>>
>;

// ============================================================================
// FIELD UPDATE OPERATIONS
// ============================================================================
const stringFieldUpdateOperationsInput = object({
  set: optional(string()),
});

const nullableStringFieldUpdateOperationsInput = object({
  set: optional(nullable(string())),
});

const intFieldUpdateOperationsInput = object({
  set: optional(number()),
  increment: optional(number()),
  decrement: optional(number()),
  multiply: optional(number()),
  divide: optional(number()),
});

const nullableIntFieldUpdateOperationsInput = object({
  set: optional(nullable(number())),
  increment: optional(number()),
  decrement: optional(number()),
  multiply: optional(number()),
  divide: optional(number()),
});

const floatFieldUpdateOperationsInput = object({
  set: optional(number()),
  increment: optional(number()),
  decrement: optional(number()),
  multiply: optional(number()),
  divide: optional(number()),
});

const nullableFloatFieldUpdateOperationsInput = object({
  set: optional(nullable(number())),
  increment: optional(number()),
  decrement: optional(number()),
  multiply: optional(number()),
  divide: optional(number()),
});

const bigIntFieldUpdateOperationsInput = object({
  set: optional(bigint()),
  increment: optional(bigint()),
  decrement: optional(bigint()),
  multiply: optional(bigint()),
  divide: optional(bigint()),
});

const nullableBigIntFieldUpdateOperationsInput = object({
  set: optional(nullable(bigint())),
  increment: optional(bigint()),
  decrement: optional(bigint()),
  multiply: optional(bigint()),
  divide: optional(bigint()),
});

const boolFieldUpdateOperationsInput = object({
  set: optional(boolean()),
});

const nullableBoolFieldUpdateOperationsInput = object({
  set: optional(nullable(boolean())),
});

const dateTimeFieldUpdateOperationsInput = object({
  set: optional(date()),
});

const nullableDateTimeFieldUpdateOperationsInput = object({
  set: optional(nullable(date())),
});

const jsonFieldUpdateOperationsInput = object({
  set: optional(any()),
});

const nullableJsonFieldUpdateOperationsInput = object({
  set: optional(nullable(any())),
});

const enumFieldUpdateOperationsInput = <T extends string[]>(values: T) =>
  union([
    enumType(values),
    object({
      set: optional(enumType(values)),
    }),
  ]);

const nullableEnumFieldUpdateOperationsInput = <T extends string[]>(
  values: T
) =>
  union([
    nullable(enumType(values)),
    object({
      set: optional(nullable(enumType(values))),
    }),
  ]);

// Field update operation types
export type StringFieldUpdateOperationsInput = InferFilter<
  typeof stringFieldUpdateOperationsInput
>;
export type NullableStringFieldUpdateOperationsInput = InferFilter<
  typeof nullableStringFieldUpdateOperationsInput
>;
export type IntFieldUpdateOperationsInput = InferFilter<
  typeof intFieldUpdateOperationsInput
>;
export type NullableIntFieldUpdateOperationsInput = InferFilter<
  typeof nullableIntFieldUpdateOperationsInput
>;
export type FloatFieldUpdateOperationsInput = InferFilter<
  typeof floatFieldUpdateOperationsInput
>;
export type NullableFloatFieldUpdateOperationsInput = InferFilter<
  typeof nullableFloatFieldUpdateOperationsInput
>;
export type BigIntFieldUpdateOperationsInput = InferFilter<
  typeof bigIntFieldUpdateOperationsInput
>;
export type NullableBigIntFieldUpdateOperationsInput = InferFilter<
  typeof nullableBigIntFieldUpdateOperationsInput
>;
export type BoolFieldUpdateOperationsInput = InferFilter<
  typeof boolFieldUpdateOperationsInput
>;
export type NullableBoolFieldUpdateOperationsInput = InferFilter<
  typeof nullableBoolFieldUpdateOperationsInput
>;
export type DateTimeFieldUpdateOperationsInput = InferFilter<
  typeof dateTimeFieldUpdateOperationsInput
>;
export type NullableDateTimeFieldUpdateOperationsInput = InferFilter<
  typeof nullableDateTimeFieldUpdateOperationsInput
>;
export type JsonFieldUpdateOperationsInput = InferFilter<
  typeof jsonFieldUpdateOperationsInput
>;
export type NullableJsonFieldUpdateOperationsInput = InferFilter<
  typeof nullableJsonFieldUpdateOperationsInput
>;

export type EnumFieldUpdateOperationsInput<T extends string | number> =
  InferFilter<ReturnType<typeof enumFieldUpdateOperationsInput<any>>>;
export type NullableEnumFieldUpdateOperationsInput<T extends string | number> =
  InferFilter<ReturnType<typeof nullableEnumFieldUpdateOperationsInput<any>>>;

// ============================================================================
// FIELD FILTER MAPPING
// ============================================================================
export type FieldFilter<F extends BaseField<any>> = F extends DateTimeField<any>
  ? DateTimeFilters<F>
  : F extends StringField<any>
  ? StringFilters<F>
  : F extends NumberField<any>
  ? NumberFilters<F>
  : F extends BooleanField<any>
  ? BooleanFilters<F>
  : F extends BigIntField<any>
  ? BigIntFilters<F>
  : F extends JsonField<any, any>
  ? JsonFilters<F>
  : F extends EnumField<infer E, infer TState>
  ? EnumFilters<F>
  : never;
