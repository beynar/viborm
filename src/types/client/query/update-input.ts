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
  union,
  any,
  bigint,
  lazy,
  json,
  input,
} from "zod/v4-mini";

// Type inference helper
type InferFilter<T> = input<T>;

// ============================================================================
// BASE UPDATE OPERATIONS
// ============================================================================

// Base set operation (all fields support this)
const baseSetOperation = <T extends ZodMiniType>(schema: T) =>
  union([schema, object({ set: optional(schema) })]);

const baseNullableSetOperation = <T extends ZodMiniType>(schema: T) =>
  nullable(
    union([
      schema,
      object({
        set: optional(nullable(schema)),
      }),
    ])
  );

// Base arithmetic operations (for numbers and bigints)
const baseArithmeticOperations = <T extends ZodMiniType>(schema: T) =>
  union([
    schema,
    object({
      set: optional(schema),
      increment: optional(schema),
      decrement: optional(schema),
      multiply: optional(schema),
      divide: optional(schema),
    }),
  ]);

const baseNullableArithmeticOperations = <T extends ZodMiniType>(schema: T) =>
  nullable(
    union([
      schema,
      object({
        set: optional(nullable(schema)),
        increment: optional(schema),
        decrement: optional(schema),
        multiply: optional(schema),
        divide: optional(schema),
      }),
    ])
  );

// Base array update operations
const baseArrayUpdateOperations = <T extends ZodMiniType>(schema: T) =>
  union([
    array(schema),
    object({
      set: optional(array(schema)),
      push: optional(union([schema, array(schema)])),
      unshift: optional(union([schema, array(schema)])),
      pop: optional(boolean()),
      shift: optional(boolean()),
      splice: optional(
        object({
          start: number(),
          deleteCount: optional(number()),
          items: optional(array(schema)),
        })
      ),
    }),
  ]);

const baseNullableArrayUpdateOperations = <T extends ZodMiniType>(schema: T) =>
  nullable(
    union([
      schema,
      object({
        set: optional(nullable(array(schema))),
        push: optional(union([schema, array(schema)])),
        unshift: optional(union([schema, array(schema)])),
        pop: optional(boolean()),
        shift: optional(boolean()),
        splice: optional(
          object({
            start: number(),
            deleteCount: optional(number()),
            items: optional(array(schema)),
          })
        ),
      }),
    ])
  );

// ============================================================================
// STRING UPDATE OPERATIONS
// ============================================================================

export const stringFieldUpdateOperationsInput = lazy(() =>
  baseSetOperation(string())
);

export const nullableStringFieldUpdateOperationsInput = lazy(() =>
  baseNullableSetOperation(string())
);

export const stringArrayFieldUpdateOperationsInput = lazy(() =>
  baseArrayUpdateOperations(string())
);

export const nullableStringArrayFieldUpdateOperationsInput = lazy(() =>
  baseNullableArrayUpdateOperations(string())
);

export type StringFieldUpdateOperationsInput = InferFilter<
  typeof stringFieldUpdateOperationsInput
>;
export type NullableStringFieldUpdateOperationsInput = InferFilter<
  typeof nullableStringFieldUpdateOperationsInput
>;
export type StringArrayFieldUpdateOperationsInput = InferFilter<
  typeof stringArrayFieldUpdateOperationsInput
>;
export type NullableStringArrayFieldUpdateOperationsInput = InferFilter<
  typeof nullableStringArrayFieldUpdateOperationsInput
>;

type StringUpdateOperations<T extends StringField<any>> =
  IsFieldArray<T> extends true
    ? IsFieldNullable<T> extends true
      ? NullableStringArrayFieldUpdateOperationsInput
      : StringArrayFieldUpdateOperationsInput
    : IsFieldNullable<T> extends true
    ? NullableStringFieldUpdateOperationsInput
    : StringFieldUpdateOperationsInput;

// ============================================================================
// NUMBER UPDATE OPERATIONS
// ============================================================================

export const intFieldUpdateOperationsInput = lazy(() =>
  baseArithmeticOperations(number())
);

export const nullableIntFieldUpdateOperationsInput = lazy(() =>
  baseNullableArithmeticOperations(number())
);

export const intArrayFieldUpdateOperationsInput = lazy(() =>
  baseArrayUpdateOperations(number())
);

export const nullableIntArrayFieldUpdateOperationsInput = lazy(() =>
  baseNullableArrayUpdateOperations(number())
);

export const floatFieldUpdateOperationsInput = lazy(() =>
  baseArithmeticOperations(number())
);

export const nullableFloatFieldUpdateOperationsInput = lazy(() =>
  baseNullableArithmeticOperations(number())
);

export const floatArrayFieldUpdateOperationsInput = lazy(() =>
  baseArrayUpdateOperations(number())
);

export const nullableFloatArrayFieldUpdateOperationsInput = lazy(() =>
  baseNullableArrayUpdateOperations(number())
);

export type IntFieldUpdateOperationsInput = InferFilter<
  typeof intFieldUpdateOperationsInput
>;
export type NullableIntFieldUpdateOperationsInput = InferFilter<
  typeof nullableIntFieldUpdateOperationsInput
>;
export type IntArrayFieldUpdateOperationsInput = InferFilter<
  typeof intArrayFieldUpdateOperationsInput
>;
export type NullableIntArrayFieldUpdateOperationsInput = InferFilter<
  typeof nullableIntArrayFieldUpdateOperationsInput
>;
export type FloatFieldUpdateOperationsInput = InferFilter<
  typeof floatFieldUpdateOperationsInput
>;
export type NullableFloatFieldUpdateOperationsInput = InferFilter<
  typeof nullableFloatFieldUpdateOperationsInput
>;
export type FloatArrayFieldUpdateOperationsInput = InferFilter<
  typeof floatArrayFieldUpdateOperationsInput
>;
export type NullableFloatArrayFieldUpdateOperationsInput = InferFilter<
  typeof nullableFloatArrayFieldUpdateOperationsInput
>;

// Generic number type aliases
export type NumberFieldUpdateOperationsInput = IntFieldUpdateOperationsInput;
export type NullableNumberFieldUpdateOperationsInput =
  NullableIntFieldUpdateOperationsInput;
export type NumberArrayFieldUpdateOperationsInput =
  IntArrayFieldUpdateOperationsInput;
export type NullableNumberArrayFieldUpdateOperationsInput =
  NullableIntArrayFieldUpdateOperationsInput;

type NumberUpdateOperations<T extends NumberField<any>> =
  IsFieldArray<T> extends true
    ? IsFieldNullable<T> extends true
      ? NullableNumberArrayFieldUpdateOperationsInput
      : NumberArrayFieldUpdateOperationsInput
    : IsFieldNullable<T> extends true
    ? NullableNumberFieldUpdateOperationsInput
    : NumberFieldUpdateOperationsInput;

// ============================================================================
// BOOLEAN UPDATE OPERATIONS
// ============================================================================

export const boolFieldUpdateOperationsInput = lazy(() =>
  baseSetOperation(boolean())
);

export const nullableBoolFieldUpdateOperationsInput = lazy(() =>
  baseNullableSetOperation(boolean())
);

export const boolArrayFieldUpdateOperationsInput = lazy(() =>
  baseArrayUpdateOperations(boolean())
);

export const nullableBoolArrayFieldUpdateOperationsInput = lazy(() =>
  baseNullableArrayUpdateOperations(boolean())
);

export type BoolFieldUpdateOperationsInput = InferFilter<
  typeof boolFieldUpdateOperationsInput
>;
export type NullableBoolFieldUpdateOperationsInput = InferFilter<
  typeof nullableBoolFieldUpdateOperationsInput
>;
export type BoolArrayFieldUpdateOperationsInput = InferFilter<
  typeof boolArrayFieldUpdateOperationsInput
>;
export type NullableBoolArrayFieldUpdateOperationsInput = InferFilter<
  typeof nullableBoolArrayFieldUpdateOperationsInput
>;

type BooleanUpdateOperations<T extends BooleanField<any>> =
  IsFieldArray<T> extends true
    ? IsFieldNullable<T> extends true
      ? NullableBoolArrayFieldUpdateOperationsInput
      : BoolArrayFieldUpdateOperationsInput
    : IsFieldNullable<T> extends true
    ? NullableBoolFieldUpdateOperationsInput
    : BoolFieldUpdateOperationsInput;

// ============================================================================
// DATETIME UPDATE OPERATIONS
// ============================================================================

export const dateTimeFieldUpdateOperationsInput = lazy(() =>
  baseSetOperation(date())
);

export const nullableDateTimeFieldUpdateOperationsInput = lazy(() =>
  baseNullableSetOperation(date())
);

export const dateTimeArrayFieldUpdateOperationsInput = lazy(() =>
  baseArrayUpdateOperations(date())
);

export const nullableDateTimeArrayFieldUpdateOperationsInput = lazy(() =>
  baseNullableArrayUpdateOperations(date())
);

export type DateTimeFieldUpdateOperationsInput = InferFilter<
  typeof dateTimeFieldUpdateOperationsInput
>;
export type NullableDateTimeFieldUpdateOperationsInput = InferFilter<
  typeof nullableDateTimeFieldUpdateOperationsInput
>;
export type DateTimeArrayFieldUpdateOperationsInput = InferFilter<
  typeof dateTimeArrayFieldUpdateOperationsInput
>;
export type NullableDateTimeArrayFieldUpdateOperationsInput = InferFilter<
  typeof nullableDateTimeArrayFieldUpdateOperationsInput
>;

type DateTimeUpdateOperations<T extends DateTimeField<any>> =
  IsFieldArray<T> extends true
    ? IsFieldNullable<T> extends true
      ? NullableDateTimeArrayFieldUpdateOperationsInput
      : DateTimeArrayFieldUpdateOperationsInput
    : IsFieldNullable<T> extends true
    ? NullableDateTimeFieldUpdateOperationsInput
    : DateTimeFieldUpdateOperationsInput;

// ============================================================================
// BIGINT UPDATE OPERATIONS
// ============================================================================

export const bigIntFieldUpdateOperationsInput = lazy(() =>
  baseArithmeticOperations(bigint())
);

export const nullableBigIntFieldUpdateOperationsInput = lazy(() =>
  baseNullableArithmeticOperations(bigint())
);

export const bigIntArrayFieldUpdateOperationsInput = lazy(() =>
  baseArrayUpdateOperations(bigint())
);

export const nullableBigIntArrayFieldUpdateOperationsInput = lazy(() =>
  baseNullableArrayUpdateOperations(bigint())
);

export type BigIntFieldUpdateOperationsInput = InferFilter<
  typeof bigIntFieldUpdateOperationsInput
>;
export type NullableBigIntFieldUpdateOperationsInput = InferFilter<
  typeof nullableBigIntFieldUpdateOperationsInput
>;
export type BigIntArrayFieldUpdateOperationsInput = InferFilter<
  typeof bigIntArrayFieldUpdateOperationsInput
>;
export type NullableBigIntArrayFieldUpdateOperationsInput = InferFilter<
  typeof nullableBigIntArrayFieldUpdateOperationsInput
>;

type BigIntUpdateOperations<T extends BigIntField<any>> =
  IsFieldArray<T> extends true
    ? IsFieldNullable<T> extends true
      ? NullableBigIntArrayFieldUpdateOperationsInput
      : BigIntArrayFieldUpdateOperationsInput
    : IsFieldNullable<T> extends true
    ? NullableBigIntFieldUpdateOperationsInput
    : BigIntFieldUpdateOperationsInput;

// ============================================================================
// JSON UPDATE OPERATIONS
// ============================================================================

export const jsonFieldUpdateOperationsInput = lazy(() =>
  object({
    set: optional(json()),
    merge: optional(json()),
    path: optional(
      object({
        path: array(string()),
        value: json(),
      })
    ),
  })
);

export const nullableJsonFieldUpdateOperationsInput = lazy(() =>
  object({
    set: optional(nullable(json())),
    merge: optional(json()),
    path: optional(
      object({
        path: array(string()),
        value: json(),
      })
    ),
  })
);

export type JsonFieldUpdateOperationsInput = InferFilter<
  typeof jsonFieldUpdateOperationsInput
>;
export type NullableJsonFieldUpdateOperationsInput = InferFilter<
  typeof nullableJsonFieldUpdateOperationsInput
>;

type JsonUpdateOperations<T extends JsonField<any, any>> =
  IsFieldNullable<T> extends true
    ? NullableJsonFieldUpdateOperationsInput
    : JsonFieldUpdateOperationsInput;

// ============================================================================
// ENUM UPDATE OPERATIONS
// ============================================================================

const enumFieldUpdateOperationsInput = <T extends string[]>(values: T) =>
  lazy(() => baseSetOperation(enumType(values)));

const nullableEnumFieldUpdateOperationsInput = <T extends string[]>(
  values: T
) => lazy(() => baseNullableSetOperation(enumType(values)));

const enumArrayFieldUpdateOperationsInput = <T extends string[]>(values: T) =>
  lazy(() => baseArrayUpdateOperations(enumType(values)));

const nullableEnumArrayFieldUpdateOperationsInput = <const T extends string[]>(
  values: T
) => lazy(() => baseNullableArrayUpdateOperations(enumType(values)));

export type EnumFieldUpdateOperationsInput<T extends string[]> = InferFilter<
  ReturnType<typeof enumFieldUpdateOperationsInput<T>>
>;
export type NullableEnumFieldUpdateOperationsInput<T extends string[]> =
  InferFilter<ReturnType<typeof nullableEnumFieldUpdateOperationsInput<T>>>;

export type EnumArrayFieldUpdateOperationsInput<T extends string[]> =
  InferFilter<ReturnType<typeof enumArrayFieldUpdateOperationsInput<T>>>;
export type NullableEnumArrayFieldUpdateOperationsInput<T extends string[]> =
  InferFilter<
    ReturnType<typeof nullableEnumArrayFieldUpdateOperationsInput<T>>
  >;

type EnumUpdateOperations<T extends EnumField<any, any>> = T extends EnumField<
  infer E,
  any
>
  ? E extends string[]
    ? IsFieldArray<T> extends true
      ? IsFieldNullable<T> extends true
        ? NullableEnumArrayFieldUpdateOperationsInput<E>
        : EnumArrayFieldUpdateOperationsInput<E>
      : IsFieldNullable<T> extends true
      ? NullableEnumFieldUpdateOperationsInput<E>
      : EnumFieldUpdateOperationsInput<E>
    : never
  : never;

// ============================================================================
// FIELD UPDATE MAPPING
// ============================================================================
export type FieldUpdateOperations<F extends BaseField<any>> =
  F extends DateTimeField<any>
    ? DateTimeUpdateOperations<F>
    : F extends StringField<any>
    ? StringUpdateOperations<F>
    : F extends NumberField<any>
    ? NumberUpdateOperations<F>
    : F extends BooleanField<any>
    ? BooleanUpdateOperations<F>
    : F extends BigIntField<any>
    ? BigIntUpdateOperations<F>
    : F extends JsonField<any, any>
    ? JsonUpdateOperations<F>
    : F extends EnumField<any, any>
    ? EnumUpdateOperations<F>
    : never;
