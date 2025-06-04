import {
  BaseField,
  BigIntField,
  BooleanField,
  DateTimeField,
  EnumField,
  JsonField,
  Model,
  NumberField,
  Relation,
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
  union,
  any,
  bigint,
  lazy,
  input,
  json,
  transform,
  pipe,
  ZodMiniObject,
} from "zod/v4-mini";
import {
  ExtractRelationModel,
  FieldNames,
} from "../foundation/model-extraction";
import { ModelFields } from "../foundation/model-extraction";
import { ModelRelations } from "../foundation/model-extraction";
import { RelationNames } from "../foundation/model-extraction";
import { CreateInput } from "./create-input";
import { WhereInput, WhereUniqueInput } from "./where-input";
import type { UpdateManyInput } from "./update-many-input";

export const rawTransformer = (schema: ZodMiniType) =>
  pipe(
    schema,
    transform((value) => ({
      set: value,
    }))
  );
// Type inference helper
type InferFilter<T> = input<T>;

// ============================================================================
// BASE UPDATE OPERATIONS
// ============================================================================

// Base set operation (all fields support this)
const baseSetOperation = <T extends ZodMiniType>(
  schema: T,
  extendedObject?: ZodMiniObject
) =>
  union([
    object({ set: optional(schema), ...(extendedObject?.def.shape || {}) }),
    rawTransformer(schema),
  ]);

const baseNullableSetOperation = <T extends ZodMiniType>(
  schema: T,
  extendedObject?: ZodMiniObject
) =>
  nullable(
    union([
      object({
        set: optional(nullable(schema)),
        ...(extendedObject?.def.shape || {}),
      }),
      rawTransformer(schema),
    ])
  );

// Base array update operations
const baseArrayUpdateOperations = <T extends ZodMiniType>(schema: T) =>
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

const baseNullableArrayUpdateOperations = <T extends ZodMiniType>(schema: T) =>
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

// Base arithmetic operations (for numbers and bigints)
const baseArithmeticOperations = <T extends ZodMiniType>(schema: T) =>
  baseSetOperation(
    schema,
    object({
      increment: optional(schema),
      decrement: optional(schema),
      multiply: optional(schema),
      divide: optional(schema),
    })
  );

const baseNullableArithmeticOperations = <T extends ZodMiniType>(schema: T) =>
  baseSetOperation(
    schema,
    object({
      increment: optional(schema),
      decrement: optional(schema),
      multiply: optional(schema),
      divide: optional(schema),
    })
  );

export const numberFieldUpdateOperationsInput = lazy(() =>
  baseArithmeticOperations(number())
);

export const nullableNumberFieldUpdateOperationsInput = lazy(() =>
  baseNullableArithmeticOperations(number())
);

export const numberArrayFieldUpdateOperationsInput = lazy(() =>
  baseArrayUpdateOperations(number())
);

export const nullableNumberArrayFieldUpdateOperationsInput = lazy(() =>
  baseNullableArrayUpdateOperations(number())
);

// Generic number type aliases
export type NumberFieldUpdateOperationsInput = InferFilter<
  typeof numberFieldUpdateOperationsInput
>;
export type NullableNumberFieldUpdateOperationsInput = InferFilter<
  typeof nullableNumberFieldUpdateOperationsInput
>;
export type NumberArrayFieldUpdateOperationsInput = InferFilter<
  typeof numberArrayFieldUpdateOperationsInput
>;
export type NullableNumberArrayFieldUpdateOperationsInput = InferFilter<
  typeof nullableNumberArrayFieldUpdateOperationsInput
>;

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
  baseSetOperation(
    json(),
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

export const nullableJsonFieldUpdateOperationsInput = lazy(() =>
  baseNullableSetOperation(
    json(),
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

/**
 * Relation update input - differentiates between single and multiple relations
 */
export type RelationUpdateInput<TRelation extends Relation<any, any>> =
  TRelation extends Relation<any, infer TRelationType>
    ? TRelationType extends "oneToOne" | "manyToOne"
      ? SingleRelationUpdateInput<ExtractRelationModel<TRelation>>
      : TRelationType extends "oneToMany" | "manyToMany"
      ? MultiRelationUpdateInput<ExtractRelationModel<TRelation>>
      : never
    : never;

// ===== SINGLE RELATION OPERATIONS =====

/**
 * Update operations for single relations (oneToOne, manyToOne)
 */
export type SingleRelationUpdateInput<TRelatedModel extends Model<any>> = {
  create?: CreateInput<TRelatedModel>;
  connect?: WhereUniqueInput<TRelatedModel>;
  disconnect?: boolean;
  delete?: boolean;
  update?: UpdateInput<TRelatedModel>;
  upsert?: {
    create: CreateInput<TRelatedModel>;
    update: UpdateInput<TRelatedModel>;
  };
  connectOrCreate?: {
    where: WhereUniqueInput<TRelatedModel>;
    create: CreateInput<TRelatedModel>;
  };
};
// Enhanced update type with field-specific operations
export type ScalarUpdateInput<TModel extends Model<any>> =
  FieldNames<TModel> extends never
    ? {}
    : {
        [K in FieldNames<TModel>]?: K extends keyof ModelFields<TModel>
          ? ModelFields<TModel>[K] extends BaseField<any>
            ? FieldUpdateOperations<ModelFields<TModel>[K]>
            : never
          : never;
      };

/**
 * Input for updating a record
 */
export type UpdateInput<
  TModel extends Model<any>,
  Deep extends boolean = true
> = ScalarUpdateInput<TModel> &
  (Deep extends true
    ? {
        // Relation update operations
        [K in RelationNames<TModel>]?: K extends keyof ModelRelations<TModel>
          ? ModelRelations<TModel>[K] extends Relation<any, any>
            ? RelationUpdateInput<ModelRelations<TModel>[K]>
            : never
          : never;
      }
    : {});
/**
 * Nested update input for relations
 */
export type NestedUpdateInput<TRelation extends Relation<any, any>> = {
  create?: CreateInput<ExtractRelationModel<TRelation>>;
  connect?: WhereUniqueInput<ExtractRelationModel<TRelation>>;
  disconnect?: boolean;
  delete?: boolean;
  update?: UpdateInput<ExtractRelationModel<TRelation>>;
  upsert?: {
    create: CreateInput<ExtractRelationModel<TRelation>>;
    update: UpdateInput<ExtractRelationModel<TRelation>>;
  };
  connectOrCreate?: {
    where: WhereUniqueInput<ExtractRelationModel<TRelation>>;
    create: CreateInput<ExtractRelationModel<TRelation>>;
  };
};
/**
 * Update operations for multi relations (oneToMany, manyToMany)
 */
export type MultiRelationUpdateInput<TRelatedModel extends Model<any>> = {
  create?: CreateInput<TRelatedModel> | CreateInput<TRelatedModel>[];
  connect?: WhereUniqueInput<TRelatedModel> | WhereUniqueInput<TRelatedModel>[];
  disconnect?:
    | WhereUniqueInput<TRelatedModel>
    | WhereUniqueInput<TRelatedModel>[];
  delete?: WhereUniqueInput<TRelatedModel> | WhereUniqueInput<TRelatedModel>[];
  update?:
    | {
        where: WhereUniqueInput<TRelatedModel>;
        data: UpdateInput<TRelatedModel>;
      }
    | Array<{
        where: WhereUniqueInput<TRelatedModel>;
        data: UpdateInput<TRelatedModel>;
      }>;
  updateMany?:
    | {
        where: WhereInput<TRelatedModel>;
        data: UpdateManyInput<TRelatedModel>;
      }
    | Array<{
        where: WhereInput<TRelatedModel>;
        data: UpdateManyInput<TRelatedModel>;
      }>;
  deleteMany?: WhereInput<TRelatedModel> | WhereInput<TRelatedModel>[];
  upsert?:
    | {
        where: WhereUniqueInput<TRelatedModel>;
        create: CreateInput<TRelatedModel>;
        update: UpdateInput<TRelatedModel>;
      }
    | Array<{
        where: WhereUniqueInput<TRelatedModel>;
        create: CreateInput<TRelatedModel>;
        update: UpdateInput<TRelatedModel>;
      }>;
  connectOrCreate?:
    | {
        where: WhereUniqueInput<TRelatedModel>;
        create: CreateInput<TRelatedModel>;
      }
    | Array<{
        where: WhereUniqueInput<TRelatedModel>;
        create: CreateInput<TRelatedModel>;
      }>;
  set?: WhereUniqueInput<TRelatedModel> | WhereUniqueInput<TRelatedModel>[];
};

export const dataInputValidators = {
  string: {
    base: stringFieldUpdateOperationsInput,
    nullable: nullableStringFieldUpdateOperationsInput,
    array: stringArrayFieldUpdateOperationsInput,
    nullableArray: nullableStringArrayFieldUpdateOperationsInput,
  },
  int: {
    base: numberFieldUpdateOperationsInput,
    nullable: nullableNumberFieldUpdateOperationsInput,
    array: numberArrayFieldUpdateOperationsInput,
    nullableArray: nullableNumberArrayFieldUpdateOperationsInput,
  },
  float: {
    base: numberFieldUpdateOperationsInput,
    nullable: nullableNumberFieldUpdateOperationsInput,
    array: numberArrayFieldUpdateOperationsInput,
    nullableArray: nullableNumberArrayFieldUpdateOperationsInput,
  },
  decimal: {
    base: numberFieldUpdateOperationsInput,
    nullable: nullableNumberFieldUpdateOperationsInput,
    array: numberArrayFieldUpdateOperationsInput,
    nullableArray: nullableNumberArrayFieldUpdateOperationsInput,
  },
  boolean: {
    base: boolFieldUpdateOperationsInput,
    nullable: nullableBoolFieldUpdateOperationsInput,
    array: boolArrayFieldUpdateOperationsInput,
    nullableArray: nullableBoolArrayFieldUpdateOperationsInput,
  },
  dateTime: {
    base: dateTimeFieldUpdateOperationsInput,
    nullable: nullableDateTimeFieldUpdateOperationsInput,
    array: dateTimeArrayFieldUpdateOperationsInput,
    nullableArray: nullableDateTimeArrayFieldUpdateOperationsInput,
  },
  bigInt: {
    base: bigIntFieldUpdateOperationsInput,
    nullable: nullableBigIntFieldUpdateOperationsInput,
    array: bigIntArrayFieldUpdateOperationsInput,
    nullableArray: nullableBigIntArrayFieldUpdateOperationsInput,
  },
  json: {
    base: jsonFieldUpdateOperationsInput,
    nullable: nullableJsonFieldUpdateOperationsInput,
  },
  enum: <T extends string[]>(values: T) => {
    return {
      base: enumFieldUpdateOperationsInput(values),
      nullable: nullableEnumFieldUpdateOperationsInput(values),
      array: enumArrayFieldUpdateOperationsInput(values),
      nullableArray: nullableEnumArrayFieldUpdateOperationsInput(values),
    };
  },
};
