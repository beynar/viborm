import { Field, s, ScalarFieldType, StringField } from "@schema";
import { IsFieldArray, IsFieldNullable } from "@types";
import {
  boolean,
  optional,
  array,
  object,
  nullable,
  type ZodMiniType,
  union,
  extend,
  transform,
  pipe,
  ZodMiniObject,
  string,
  number,
  date,
  enum as enumType,
  lazy,
  null as null_,
} from "zod/v4-mini";

import { GetValidatorType, Zod, ZodConditionalMerge } from "./utils";
import { any } from "zod/v4";

export type QueryMode = "default" | "insensitive";
export type NullsOrder = "first" | "last";

// ============================================================================
// GENERIC FILTERS
// ============================================================================

export const rawTransformer = <Z extends ZodMiniType>(schema: Z) =>
  // @ts-ignore
  pipe(
    schema,
    transform((value) => ({
      equals: value,
    }))
  ) as Z;

// Base filter schemas - exported for use in field-filters.ts
export const baseFilter = <
  Z extends ZodMiniType,
  O extends ZodMiniObject | undefined = undefined
>(
  schema: Z,
  extendedObject?: O
) => {
  const baseFilterObject = object({
    equals: optional(schema),
    not: optional(
      union([
        object({
          equals: optional(nullable(schema)),
          notIn: optional(array(schema)),
          in: optional(array(schema)),
        }),
        schema,
      ])
    ),
    in: optional(array(schema)),
    notIn: optional(array(schema)),
  });
  const extendedFilterObject = extendedObject
    ? extend(baseFilterObject, extendedObject.def.shape)
    : baseFilterObject;
  return union([
    extendedFilterObject as ZodConditionalMerge<typeof baseFilterObject, O>,
    rawTransformer(schema),
  ]);
};

export const baseNullableFilter = <
  Z extends ZodMiniType,
  O extends ZodMiniObject | undefined = undefined
>(
  schema: Z,
  extendedObject?: O
) => {
  const baseNullableFilterObject = object({
    equals: optional(nullable(schema)),
    not: optional(
      union([
        object({
          equals: optional(nullable(schema)),
          notIn: optional(array(schema)),
          in: optional(array(schema)),
        }),
        nullable(schema),
      ])
    ),
    in: optional(array(schema)),
    notIn: optional(array(schema)),
  });
  const extendedFilterObject = extendedObject
    ? extend(baseNullableFilterObject, extendedObject.def.shape)
    : baseNullableFilterObject;
  return union([
    extendedFilterObject as ZodConditionalMerge<
      typeof baseNullableFilterObject,
      O
    >,
    rawTransformer(nullable(schema)),
  ]);
};

// List/Array filters - exported for use in field-filters.ts
export const baseListFilter = <T extends ZodMiniType>(schema: T) =>
  union([
    object({
      equals: optional(array(schema)),
      has: optional(schema),
      hasEvery: optional(array(schema)),
      hasSome: optional(array(schema)),
      isEmpty: optional(boolean()),
    }),
    rawTransformer(array(schema)),
  ]);

export const baseNullableListFilter = <T extends ZodMiniType>(schema: T) =>
  union([
    object({
      equals: optional(nullable(array(schema))),
      has: optional(schema),
      hasEvery: optional(array(schema)),
      hasSome: optional(array(schema)),
      isEmpty: optional(boolean()),
    }),
    rawTransformer(array(schema)),
  ]);

// ============================================================================
// STRING FILTERS
// ============================================================================
const baseStringFilter = (schema: Zod._string) =>
  object({
    contains: optional(schema),
    startsWith: optional(schema),
    endsWith: optional(schema),
    mode: optional(enumType(["default", "insensitive"])),
    lt: optional(schema),
    lte: optional(schema),
    gt: optional(schema),
    gte: optional(schema),
  });

// ============================================================================
// NUMBER FILTERS
// ============================================================================
const baseNumberFilter = (schema: Zod._number) =>
  object({
    lt: optional(schema),
    lte: optional(schema),
    gt: optional(schema),
    gte: optional(schema),
  });

export const numberFilter = (schema: Zod._number) =>
  lazy(() => baseFilter(schema, baseNumberFilter(schema)));
export const nullableNumberFilter = (schema: Zod._number) =>
  lazy(() => baseNullableFilter(schema, baseNumberFilter(schema)));

export const numberArrayFilter = (schema: Zod._number) =>
  lazy(() => baseListFilter(schema));
export const nullableNumberArrayFilter = (schema: Zod._number) =>
  lazy(() => baseNullableListFilter(schema));

// ============================================================================
// BOOLEAN FILTERS
// ============================================================================

export const booleanFilter = (schema: Zod._boolean) =>
  lazy(() => baseFilter(schema));

export const nullableBooleanFilter = (schema: Zod._boolean) =>
  lazy(() => baseNullableFilter(schema));

export const booleanArrayFilter = (schema: Zod._boolean) =>
  lazy(() => baseListFilter(schema));

export const nullableBooleanArrayFilter = (schema: Zod._boolean) =>
  lazy(() => baseNullableListFilter(schema));

// ============================================================================
// DATETIME FILTERS
// ============================================================================
const baseDateTimeFilter = (schema: ZodMiniType = date()) =>
  object({
    lt: optional(schema),
    lte: optional(schema),
    gt: optional(schema),
    gte: optional(schema),
  });

export const dateTimeFilter = (schema: Zod._date) =>
  lazy(() => baseFilter(schema, baseDateTimeFilter(schema)));

export const nullableDateTimeFilter = (schema: Zod._date) =>
  lazy(() => baseNullableFilter(schema, baseDateTimeFilter(schema)));

export const dateTimeArrayFilter = (schema: Zod._date) =>
  lazy(() => baseListFilter(schema));

export const nullableDateTimeArrayFilter = (schema: Zod._date) =>
  lazy(() => baseNullableListFilter(schema));

// ============================================================================
// BIGINT FILTERS
// ============================================================================
const baseBigIntFilter = (schema: Zod._bigint) =>
  object({
    lt: optional(schema),
    lte: optional(schema),
    gt: optional(schema),
    gte: optional(schema),
  });

export const bigIntFilter = (schema: Zod._bigint) => {
  return lazy(() => baseFilter(schema, baseBigIntFilter(schema)));
};

export const nullableBigIntFilter = (schema: Zod._bigint) => {
  return lazy(() => baseNullableFilter(schema, baseBigIntFilter(schema)));
};

export const bigIntArrayFilter = (schema: Zod._bigint) => {
  return lazy(() => baseListFilter(schema));
};

export const nullableBigIntArrayFilter = (schema: Zod._bigint) => {
  return lazy(() => baseNullableListFilter(schema));
};

// ============================================================================
// JSON FILTERS
// ============================================================================
const baseJsonFilter = (schema: Zod._json) =>
  object({
    path: optional(array(string())),
    equals: optional(schema),
    not: optional(schema),
    string_contains: optional(schema),
    string_starts_with: optional(schema),
    string_ends_with: optional(schema),
    array_contains: optional(schema),
    array_starts_with: optional(schema),
    array_ends_with: optional(schema),
  });

export const jsonFilter = (schema: Zod._json) => {
  return lazy(() => baseFilter(schema, baseJsonFilter(schema)));
};

export const nullableJsonFilter = (schema: Zod._json) => {
  return lazy(() => baseNullableFilter(schema, baseJsonFilter(schema)));
};

// ============================================================================
// ENUM FILTERS
// ============================================================================
const enumFilter = (schema: Zod._enum) => union([schema, baseFilter(schema)]);

const nullableEnumFilter = (schema: Zod._enum) =>
  union([schema, baseNullableFilter(schema)]);

const enumArrayFilter = (schema: Zod._enum) => baseListFilter(schema);

const nullableEnumArrayFilter = (schema: Zod._enum) =>
  baseNullableListFilter(schema);

// ============================================================================
// VECTOR FILTERS
// ============================================================================

export const vectorFilter = (schema: Zod._vector) => {
  return lazy(() =>
    object({
      match: optional(schema),
      notMatch: optional(schema),
      threshold: optional(number()),
      similarity: optional(enumType(["cosine", "dot", "l2sq"] as const)),
    })
  );
};

export const nullableVectorFilter = (schema: Zod._vector) => {
  return lazy(() =>
    object({
      match: optional(schema),
      notMatch: optional(schema),
      threshold: optional(number()),
      not: optional(null_()),
      similarity: optional(enumType(["cosine", "dot", "l2sq"] as const)),
    })
  );
};

export const filterValidators = {
  string: {
    base: (schema: Zod._string) => {
      return baseFilter(schema, baseStringFilter(schema));
    },
    nullable: (schema: Zod._string) => {
      return lazy(() => baseNullableFilter(schema, baseStringFilter(schema)));
    },
    array: (schema: Zod._string) => {
      return lazy(() => baseListFilter(schema));
    },
    nullableArray: (schema: Zod._string) => {
      return lazy(() => baseNullableListFilter(schema));
    },
  },
  int: {
    base: numberFilter,
    nullable: nullableNumberFilter,
    array: numberArrayFilter,
    nullableArray: nullableNumberArrayFilter,
  },
  float: {
    base: numberFilter,
    nullable: nullableNumberFilter,
    array: numberArrayFilter,
    nullableArray: nullableNumberArrayFilter,
  },
  decimal: {
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
    array: () => {
      throw new Error("JSON can not be represented as an array");
    },
    nullableArray: () => {
      throw new Error("JSON can not be represented as an array");
    },
  },
  enum: {
    base: enumFilter,
    nullable: nullableEnumFilter,
    array: enumArrayFilter,
    nullableArray: nullableEnumArrayFilter,
  },
  vector: {
    base: vectorFilter,
    nullable: nullableVectorFilter,
    array: () => {
      throw new Error("Vector can not be represented as an array");
    },
    nullableArray: () => {
      throw new Error("Vector can not be represented as an array");
    },
  },
  blob: {
    base: () => {
      throw new Error("Blob can not be filtered");
    },
    nullable: () => {
      throw new Error("Blob can not be filtered");
    },
    array: () => {
      throw new Error("Blob can not be filtered");
    },
    nullableArray: () => {
      throw new Error("Blob can not be filtered");
    },
  },
} satisfies Record<
  ScalarFieldType,
  Record<string, (...args: any[]) => ZodMiniType>
>;

export type FilterValidator<F extends Field> = ReturnType<
  (typeof filterValidators)[F["~fieldType"]][GetValidatorType<F>]
>;

export const getFilterValidator = <F extends Field>(field: F) => {
  const fieldType = field["~fieldType"];
  const isArray = field["~isArray"];
  const isNullable = field["~isOptional"];
  const baseValidator = field["~baseValidator"];
  const validatorGroup = filterValidators[fieldType];
  const validatorFactory =
    validatorGroup[
      isArray
        ? isNullable
          ? "nullableArray"
          : "array"
        : isNullable
        ? "nullable"
        : "base"
    ];
  return validatorFactory(baseValidator as any) as FilterValidator<F>;
};
