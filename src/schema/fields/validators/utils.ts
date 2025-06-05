import { EnumField, Field } from "@schema";
import { StandardSchemaV1 } from "@standard-schema";
import { IsFieldArray, IsFieldNullable } from "@types";
import {
  array,
  extend,
  nullable,
  optional,
  pipe,
  transform,
  ZodMiniAny,
  ZodMiniArray,
  ZodMiniBigInt,
  ZodMiniBoolean,
  ZodMiniDate,
  ZodMiniEnum,
  ZodMiniJSONSchema,
  ZodMiniNumber,
  ZodMiniObject,
  ZodMiniString,
  ZodMiniType,
} from "zod/v4-mini";

export const rawToEquals = (schema: ZodMiniType) =>
  pipe(
    schema,
    transform((value) => ({
      equals: value,
    }))
  );

export const wrapNullable = (schema: ZodMiniType, isNullable: boolean) => {
  if (isNullable) {
    return nullable(schema);
  }
  return schema;
};

export const wrapArray = (schema: ZodMiniType, isArray: boolean) => {
  if (isArray) {
    return array(schema);
  }
  return schema;
};

export const wrapOptional = (schema: ZodMiniType, isOptional: boolean) => {
  if (isOptional) {
    return optional(schema);
  }
  return schema;
};

export const wrapStandardSchema = (
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

export type MakeEnumValues<T extends string[]> = {
  readonly [x in T[number]]: T[number];
};

export namespace Zod {
  export type _string = ZodMiniString<string>;
  export type _number = ZodMiniNumber<number>;
  export type _boolean = ZodMiniBoolean<boolean>;
  export type _date = ZodMiniDate<Date>;
  export type _bigint = ZodMiniBigInt<bigint>;
  export type _json = ZodMiniJSONSchema;
  export type _vector = ZodMiniArray<ZodMiniNumber<number>>;
  export type _blob = ZodMiniAny;
  export type _enum<F extends Field | undefined = undefined> =
    F extends EnumField<infer V, infer _>
      ? ZodMiniEnum<MakeEnumValues<V>>
      : ZodMiniEnum<MakeEnumValues<string[]>>;
}

export type ZodConditionalMerge<
  Left extends ZodMiniObject,
  Right extends ZodMiniObject | undefined = undefined
> = Right extends undefined
  ? Left
  : Right extends ZodMiniObject
  ? ReturnType<typeof extend<Left, Right["def"]["shape"]>>
  : never;

export type GetValidatorType<F extends Field> = IsFieldArray<F> extends true
  ? IsFieldNullable<F> extends true
    ? "nullableArray"
    : "array"
  : IsFieldNullable<F> extends true
  ? "nullable"
  : "base";
