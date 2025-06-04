import { StandardSchemaV1 } from "@standard-schema";
import {
  boolean,
  optional,
  array,
  object,
  nullable,
  type ZodMiniType,
  union,
  omit,
  extend,
  transform,
  pipe,
  core,
  bigint,
  number,
  ZodMiniObject,
  refine,
  date,
  enum as enum_,
  string,
  json,
} from "zod/v4-mini";

export const fieldValidators = {
  string: {
    base: string(),
    nullable: nullable(string()),
    array: array(string()),
    nullableArray: nullable(array(string())),
  },
  int: {
    base: number(),
    nullable: nullable(number()),
    array: array(number()),
    nullableArray: nullable(array(number())),
  },
  float: {
    base: number(),
    nullable: nullable(number()),
    array: array(number()),
    nullableArray: nullable(array(number())),
  },
  decimal: {
    base: number(),
    nullable: nullable(number()),
    array: array(number()),
    nullableArray: nullable(array(number())),
  },
  bigInt: {
    base: number(),
    nullable: nullable(number()),
    array: array(number()),
    nullableArray: nullable(array(number())),
  },
  boolean: {
    base: boolean(),
    nullable: nullable(boolean()),
    array: array(boolean()),
    nullableArray: nullable(array(boolean())),
  },
  dateTime: {
    base: date(),
    nullable: nullable(date()),
    array: array(date()),
    nullableArray: nullable(array(date())),
  },
  enum: <T extends string>(values: T[]) => {
    return {
      base: enum_(values),
      nullable: nullable(enum_(values)),
      array: array(enum_(values)),
      nullableArray: nullable(array(enum_(values))),
    };
  },
  json: <T extends StandardSchemaV1>(schema?: T) => {
    if (schema) {
      const ss = json().check((ctx) => {
        const result = schema["~standard"]["validate"](ctx.value);
        if (result instanceof Promise) {
          ctx.issues.push({
            code: "custom",
            expected: "",
            received: "",
            message: "Do not use async custom validators in JSON fields",
            input: ctx.value,
            continue: false,
          });
        } else {
          if (result.issues && result.issues.length > 0) {
            result.issues.forEach((issue) => {
              ctx.issues.push({
                code: "custom",
                message: issue.message,
                input: ctx.value,
                path: issue.path?.map((p) => p.toString()) || [],
                continue: false,
              });
            });
          } else if ("value" in result) {
            ctx.value = result.value as any;
          } else {
            ctx.issues.push({
              code: "custom",
              message: "Invalid JSON",
              input: ctx.value,
            });
          }
        }
      });
      return {
        base: ss,
        nullable: nullable(ss),
        array: array(ss),
        nullableArray: nullable(array(ss)),
      };
    } else {
      return {
        base: json(),
        nullable: nullable(json()),
        array: array(json()),
        nullableArray: nullable(array(json())),
      };
    }
  },
};
