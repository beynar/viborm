import { Field, s, ScalarFieldType } from "@schema";
import {
  string,
  number,
  boolean,
  enum as enumType,
  optional,
  array,
  object,
  nullable,
  type ZodMiniType,
  union,
  lazy,
  json,
  transform,
  pipe,
  ZodMiniObject,
  extend,
} from "zod/v4-mini";
import { GetValidatorType, Zod, ZodConditionalMerge } from "./utils";

const rawTransformer = <Z extends ZodMiniType>(schema: Z) =>
  // @ts-ignore
  pipe(
    schema,
    transform((value) => ({
      set: value,
    }))
  ) as Z;
// ============================================================================
// BASE UPDATE OPERATIONS
// ============================================================================

// Base set operation (all fields support this)
const baseSetOperation = <
  Z extends ZodMiniType,
  O extends ZodMiniObject | undefined = undefined
>(
  schema: Z,
  extendedObject?: O
) => {
  const baseSetOperationObject = object({
    set: optional(schema),
  });

  const extendedSetOperationObject = extendedObject
    ? extend(baseSetOperationObject, extendedObject.def.shape)
    : baseSetOperationObject;
  return union([
    extendedSetOperationObject as ZodConditionalMerge<
      typeof baseSetOperationObject,
      O
    >,
    rawTransformer(schema),
  ]);
};

const baseNullableSetOperation = <
  Z extends ZodMiniType,
  O extends ZodMiniObject | undefined = undefined
>(
  schema: Z,
  extendedObject?: O
) => {
  const baseNullableSetOperationObject = object({
    set: optional(nullable(schema)),
  });

  const extendedNullableSetOperationObject = extendedObject
    ? extend(baseNullableSetOperationObject, extendedObject.def.shape)
    : baseNullableSetOperationObject;
  return union([
    extendedNullableSetOperationObject as ZodConditionalMerge<
      typeof baseNullableSetOperationObject,
      O
    >,
    rawTransformer(nullable(schema)),
  ]);
};

// Base array update operations
const baseArrayUpdateOperations = <Z extends ZodMiniType>(schema: Z) =>
  union([
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
    rawTransformer(array(schema)),
  ]);

const baseNullableArrayUpdateOperations = <Z extends ZodMiniType>(schema: Z) =>
  union([
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
    rawTransformer(nullable(array(schema))),
  ]);

// ============================================================================
// STRING UPDATE OPERATIONS
// ============================================================================

export const stringFieldUpdate = (schema: Zod._string) => {
  return lazy(() => baseSetOperation(schema));
};

export const nullableStringFieldUpdate = (schema: Zod._string) => {
  return lazy(() => baseNullableSetOperation(schema));
};

export const stringArrayFieldUpdate = (schema: Zod._string) => {
  return lazy(() => baseArrayUpdateOperations(schema));
};

export const nullableStringArrayFieldUpdate = (schema: Zod._string) => {
  return lazy(() => baseNullableArrayUpdateOperations(schema));
};

// ============================================================================
// NUMBER UPDATE OPERATIONS
// ============================================================================

// Base arithmetic operations (for numbers and bigints)
const baseArithmeticOperations = <T extends Zod._number>(schema: T) =>
  baseSetOperation(
    schema,
    object({
      increment: optional(schema),
      decrement: optional(schema),
      multiply: optional(schema),
      divide: optional(schema),
    })
  );

const baseNullableArithmeticOperations = <T extends Zod._number>(schema: T) =>
  baseSetOperation(
    schema,
    object({
      increment: optional(schema),
      decrement: optional(schema),
      multiply: optional(schema),
      divide: optional(schema),
    })
  );

export const numberFieldUpdate = (schema: Zod._number) => {
  return lazy(() => baseArithmeticOperations(schema));
};

export const nullableNumberFieldUpdate = (schema: Zod._number) => {
  return lazy(() => baseNullableArithmeticOperations(schema));
};

export const numberArrayFieldUpdate = (schema: Zod._number) => {
  return lazy(() => baseArrayUpdateOperations(schema));
};

export const nullableNumberArrayFieldUpdate = (schema: Zod._number) => {
  return lazy(() => baseNullableArrayUpdateOperations(schema));
};

// ============================================================================
// BOOLEAN UPDATE OPERATIONS
// ============================================================================

export const boolFieldUpdate = (schema: Zod._boolean) => {
  return lazy(() => baseSetOperation(schema));
};

export const nullableBoolFieldUpdate = (schema: Zod._boolean) => {
  return lazy(() => baseNullableSetOperation(schema));
};

export const boolArrayFieldUpdate = (schema: Zod._boolean) => {
  return lazy(() => baseArrayUpdateOperations(schema));
};

export const nullableBoolArrayFieldUpdate = (schema: Zod._boolean) => {
  return lazy(() => baseNullableArrayUpdateOperations(schema));
};

// ============================================================================
// DATETIME UPDATE OPERATIONS
// ============================================================================

export const dateTimeFieldUpdate = (schema: Zod._date) => {
  return lazy(() => baseSetOperation(schema));
};

export const nullableDateTimeFieldUpdate = (schema: Zod._date) => {
  return lazy(() => baseNullableSetOperation(schema));
};

export const dateTimeArrayFieldUpdate = (schema: Zod._date) => {
  return lazy(() => baseArrayUpdateOperations(schema));
};

export const nullableDateTimeArrayFieldUpdate = (schema: Zod._date) => {
  return lazy(() => baseNullableArrayUpdateOperations(schema));
};

// ============================================================================
// BIGINT UPDATE OPERATIONS
// ============================================================================

const baseArithmeticBigIntOperations = <T extends Zod._bigint>(schema: T) =>
  baseSetOperation(
    schema,
    object({
      increment: optional(schema),
      decrement: optional(schema),
      multiply: optional(schema),
      divide: optional(schema),
    })
  );

const baseNullableArithmeticBigIntOperations = <T extends Zod._bigint>(
  schema: T
) =>
  baseSetOperation(
    schema,
    object({
      increment: optional(schema),
      decrement: optional(schema),
      multiply: optional(schema),
      divide: optional(schema),
    })
  );

export const bigIntFieldUpdate = (schema: Zod._bigint) => {
  return lazy(() => baseArithmeticBigIntOperations(schema));
};

export const nullableBigIntFieldUpdate = (schema: Zod._bigint) => {
  return lazy(() => baseNullableArithmeticBigIntOperations(schema));
};

export const bigIntArrayFieldUpdate = (schema: Zod._bigint) => {
  return lazy(() => baseArrayUpdateOperations(schema));
};

export const nullableBigIntArrayFieldUpdate = (schema: Zod._bigint) => {
  return lazy(() => baseNullableArrayUpdateOperations(schema));
};

// ============================================================================
// JSON UPDATE OPERATIONS
// ============================================================================

export const jsonFieldUpdate = (schema: Zod._json) => {
  return lazy(() =>
    baseSetOperation(
      schema,
      object({
        merge: optional(json()),
        path: optional(
          object({
            path: array(string()),
            value: json(),
          })
        ),
      })
    )
  );
};

export const nullableJsonFieldUpdate = (schema: Zod._json) => {
  return lazy(() =>
    baseNullableSetOperation(
      schema,
      object({
        merge: optional(json()),
        path: optional(
          object({
            path: array(string()),
            value: json(),
          })
        ),
      })
    )
  );
};

// ============================================================================
// ENUM UPDATE OPERATIONS
// ============================================================================

const enumFieldUpdate = (schema: Zod._enum) =>
  lazy(() => baseSetOperation(schema));

const nullableEnumFieldUpdate = (schema: Zod._enum) => {
  return lazy(() => baseNullableSetOperation(schema));
};

const enumArrayFieldUpdate = (schema: Zod._enum) => {
  return lazy(() => baseArrayUpdateOperations(schema));
};

const nullableEnumArrayFieldUpdate = (schema: Zod._enum) => {
  return lazy(() => baseNullableArrayUpdateOperations(schema));
};

// ============================================================================
// VECTOR UPDATE OPERATIONS
// ============================================================================

const vectorFieldUpdate = (schema: Zod._vector) => {
  return lazy(() => baseSetOperation(schema));
};

const nullableVectorFieldUpdate = (schema: Zod._vector) => {
  return lazy(() => baseNullableSetOperation(schema));
};

// ============================================================================
// BLOB UPDATE OPERATIONS
// ============================================================================

const blobFieldUpdate = (schema: Zod._blob) => {
  return lazy(() => baseSetOperation(schema));
};

const nullableBlobFieldUpdate = (schema: Zod._blob) => {
  return lazy(() => baseNullableSetOperation(schema));
};

export const inputValidators = {
  string: {
    base: stringFieldUpdate,
    nullable: nullableStringFieldUpdate,
    array: stringArrayFieldUpdate,
    nullableArray: nullableStringArrayFieldUpdate,
  },
  int: {
    base: numberFieldUpdate,
    nullable: nullableNumberFieldUpdate,
    array: numberArrayFieldUpdate,
    nullableArray: nullableNumberArrayFieldUpdate,
  },
  float: {
    base: numberFieldUpdate,
    nullable: nullableNumberFieldUpdate,
    array: numberArrayFieldUpdate,
    nullableArray: nullableNumberArrayFieldUpdate,
  },
  decimal: {
    base: numberFieldUpdate,
    nullable: nullableNumberFieldUpdate,
    array: numberArrayFieldUpdate,
    nullableArray: nullableNumberArrayFieldUpdate,
  },
  boolean: {
    base: boolFieldUpdate,
    nullable: nullableBoolFieldUpdate,
    array: boolArrayFieldUpdate,
    nullableArray: nullableBoolArrayFieldUpdate,
  },
  dateTime: {
    base: dateTimeFieldUpdate,
    nullable: nullableDateTimeFieldUpdate,
    array: dateTimeArrayFieldUpdate,
    nullableArray: nullableDateTimeArrayFieldUpdate,
  },
  bigInt: {
    base: bigIntFieldUpdate,
    nullable: nullableBigIntFieldUpdate,
    array: bigIntArrayFieldUpdate,
    nullableArray: nullableBigIntArrayFieldUpdate,
  },
  json: {
    base: jsonFieldUpdate,
    nullable: nullableJsonFieldUpdate,
    array: () => {
      throw new Error("JSON can not be represented as an array");
    },
    nullableArray: () => {
      throw new Error("JSON can not be represented as an array");
    },
  },
  enum: {
    base: enumFieldUpdate,
    nullable: nullableEnumFieldUpdate,
    array: enumArrayFieldUpdate,
    nullableArray: nullableEnumArrayFieldUpdate,
  },
  blob: {
    base: blobFieldUpdate,
    nullable: nullableBlobFieldUpdate,
    array: () => {
      throw new Error("Blob can not be represented as an array");
    },
    nullableArray: () => {
      throw new Error("Blob can not be represented as an array");
    },
  },
  vector: {
    base: vectorFieldUpdate,
    nullable: nullableVectorFieldUpdate,
    array: () => {
      throw new Error("Vector can not be represented as an array");
    },
    nullableArray: () => {
      throw new Error("Vector can not be represented as an array");
    },
  },
} satisfies Record<
  ScalarFieldType,
  Record<string, (...args: any[]) => ZodMiniType>
>;

export type UpdateValidator<F extends Field> = ReturnType<
  (typeof inputValidators)[F["~fieldType"]][GetValidatorType<F>]
>;

export const getUpdateValidator = <F extends Field>(field: F) => {
  const fieldType = field["~fieldType"];
  const isArray = field["~isArray"];
  const isNullable = field["~isOptional"];
  const baseValidator = field["~baseValidator"];
  const validatorGroup = inputValidators[fieldType];
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
  return validatorFactory(baseValidator as any) as UpdateValidator<F>;
};
