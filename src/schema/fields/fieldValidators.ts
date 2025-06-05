import { StandardSchemaV1 } from "@standard-schema";
import {
  boolean,
  optional,
  array,
  nullable,
  type ZodMiniType,
  bigint,
  number,
  date,
  enum as enum_,
  string,
  json,
  uuid,
  ulid,
  nanoid,
  cuid,
  any,
  lazy,
  ZodMiniOptional,
  ZodMiniNullable,
  ZodMiniArray,
  ZodMiniString,
  ZodMiniNumber,
  ZodMiniAny,
  ZodMiniBigInt,
  ZodMiniBoolean,
  ZodMiniDate,
  ZodMiniEnum,
  ZodMiniJSONSchema,
} from "zod/v4-mini";
import {
  blob,
  EnumField,
  Field,
  s,
  ScalarFieldType,
  StringField,
  vector,
} from "..";
import {
  IsFieldArray,
  IsFieldNullable,
  IsFieldOptional,
} from "@types/foundation";

const wrapNullable = (schema: ZodMiniType, isNullable: boolean) => {
  if (isNullable) {
    return nullable(schema);
  }
  return schema;
};

const wrapArray = (schema: ZodMiniType, isArray: boolean) => {
  if (isArray) {
    return array(schema);
  }
  return schema;
};

const wrapOptional = (schema: ZodMiniType, isOptional: boolean) => {
  if (isOptional) {
    return optional(schema);
  }
  return schema;
};

const wrapStandardSchema = (
  schema: ZodMiniType,
  standardSchema?: StandardSchemaV1
) => {
  if (standardSchema) {
    return schema.check((ctx) => {
      const result = standardSchema["~standard"]["validate"](ctx.value);
      // Do not allow async custom validators in standard schema field validators
      if (result instanceof Promise) {
        ctx.issues.push({
          code: "custom",
          message: "Do not use async custom validators in JSON fields",
          input: ctx.value,
        });
      } else {
        if (result.issues) {
          result.issues.forEach((issue) => {
            ctx.issues.push({
              code: "custom",
              path: issue.path?.map((p) => p.toString()) || [],
              message: issue.message,
              input: ctx.value,
            });
          });
        } else {
          // Mutate the value to the validated value to respect the output type
          ctx.value = result.value;
        }
      }
    });
  }
  return schema;
};

type MakeZOptional<
  T extends ZodMiniType,
  F extends Field
> = IsFieldOptional<F> extends true ? ZodMiniOptional<T> : T;
type MakeZNullable<
  T extends ZodMiniType,
  F extends Field
> = IsFieldNullable<F> extends true ? ZodMiniNullable<T> : T;
type MakeZArray<
  T extends ZodMiniType,
  F extends Field
> = IsFieldArray<F> extends true ? ZodMiniArray<T> : T;
// type MakeZNullable<T extends ZodMiniType, F extends Field> =
// type MakeZArray<T extends ZodMiniType, F extends Field> =

type MakeRecordEnum<T extends string[]> = {
  readonly [x in T[number]]: T[number];
};

type InferBaseSchema<F extends Field> = F["~fieldType"] extends "string"
  ? ZodMiniString<string>
  : F["~fieldType"] extends "int"
  ? ZodMiniNumber<number>
  : F["~fieldType"] extends "float"
  ? ZodMiniNumber<number>
  : F["~fieldType"] extends "bigInt"
  ? ZodMiniBigInt<bigint>
  : F["~fieldType"] extends "decimal"
  ? ZodMiniNumber
  : F["~fieldType"] extends "vector"
  ? ZodMiniArray<ZodMiniNumber<number>>
  : F["~fieldType"] extends "blob"
  ? ZodMiniAny
  : F["~fieldType"] extends "boolean"
  ? ZodMiniBoolean<boolean>
  : F["~fieldType"] extends "dateTime"
  ? ZodMiniDate<Date>
  : F["~fieldType"] extends "enum"
  ? F extends EnumField<infer T, infer U>
    ? ZodMiniEnum<MakeRecordEnum<T>>
    : never
  : F["~fieldType"] extends "json"
  ? ZodMiniJSONSchema
  : never;

type InferCreateBaseSchema<F extends Field> = MakeZOptional<
  MakeZNullable<MakeZArray<InferBaseSchema<F>, F>, F>,
  F
>;

type InferUpdateBaseSchema<F extends Field> = MakeZOptional<
  MakeZNullable<MakeZArray<InferBaseSchema<F>, F>, F>,
  F
>;

type InferFieldCreateType<F extends Field> =
  InferCreateBaseSchema<F>["_zod"]["input"];
type InferFieldUpdateType<F extends Field> =
  InferUpdateBaseSchema<F>["_zod"]["input"];

export const getFieldSchema = <
  F extends Field,
  Mode extends "create" | "update"
>(
  field: F,
  mode: Mode
) => {
  const fieldSchema = baseFieldValidators[field["~fieldType"]];
  const baseSchema =
    field["~fieldType"] === "enum"
      ? fieldSchema(field["~getEnumValues"]())
      : fieldSchema();
  const isArray = field["~isArray"];
  const isNullable = field["~isOptional"];
  const defaultValue = field["~defaultValue"];
  const validator = field["~validator"];
  const hasDefault = defaultValue || field["~autoGenerate"];
  const isOptional = isNullable || hasDefault;

  return wrapOptional(
    wrapNullable(
      wrapStandardSchema(wrapArray(baseSchema, isArray), validator),
      isNullable
    ),
    mode === "create" ? isOptional : true
  ) as Mode extends "create"
    ? InferCreateBaseSchema<F>
    : InferUpdateBaseSchema<F>;
};

export const baseFieldValidators: Record<
  ScalarFieldType,
  (...args: any[]) => ZodMiniType
> = {
  string: string,
  int: number,
  float: number,
  bigInt: bigint,
  vector: number,
  blob: number,
  decimal: number,
  boolean: boolean,
  dateTime: date,
  enum: <T extends string>(values: T[]) => enum_(values),
  json: json,
} as const;
