import { Field, s, ScalarFieldType } from "@schema";
import { filterValidators } from "./filter-validators";
import { array, nullable, ZodMiniType } from "zod/v4-mini";
import { GetValidatorType, Zod } from "./utils";
import { lazy } from "zod/v4";

export const createValidators = {
  string: {
    base: (schema: Zod._string, field: Field) => {
      return lazy(() => schema);
    },
    nullable: (schema: Zod._string, field: Field) => {
      return lazy(() => nullable(schema));
    },
    array: (schema: Zod._string, field: Field) => {
      return lazy(() => array(schema));
    },
    nullableArray: (schema: Zod._string, field: Field) => {
      return lazy(() => nullable(array(schema)));
    },
  },
  int: {
    base: (schema: Zod._number, field: Field) => {
      return lazy(() => schema);
    },
    nullable: (schema: Zod._number, field: Field) => {
      return lazy(() => nullable(schema));
    },
    array: (schema: Zod._number, field: Field) => {
      return lazy(() => array(schema));
    },
    nullableArray: (schema: Zod._number, field: Field) => {
      return lazy(() => nullable(array(schema)));
    },
  },
  float: {
    base: (schema: Zod._number, field: Field) => {
      return lazy(() => schema);
    },
    nullable: (schema: Zod._number, field: Field) => {
      return lazy(() => nullable(schema));
    },
    array: (schema: Zod._number, field: Field) => {
      return lazy(() => array(schema));
    },
    nullableArray: (schema: Zod._number, field: Field) => {
      return lazy(() => nullable(array(schema)));
    },
  },
  decimal: {
    base: (schema: Zod._number, field: Field) => {
      return lazy(() => schema);
    },
    nullable: (schema: Zod._number, field: Field) => {
      return lazy(() => nullable(schema));
    },
    array: (schema: Zod._number, field: Field) => {
      return lazy(() => array(schema));
    },
    nullableArray: (schema: Zod._number, field: Field) => {
      return lazy(() => nullable(array(schema)));
    },
  },
  boolean: {
    base: (schema: Zod._boolean, field: Field) => {
      return lazy(() => schema);
    },
    nullable: (schema: Zod._boolean, field: Field) => {
      return lazy(() => nullable(schema));
    },
    array: (schema: Zod._boolean, field: Field) => {
      return lazy(() => array(schema));
    },
    nullableArray: (schema: Zod._boolean, field: Field) => {
      return lazy(() => nullable(array(schema)));
    },
  },
  dateTime: {
    base: (schema: Zod._date, field: Field) => {
      return lazy(() => schema);
    },
    nullable: (schema: Zod._date, field: Field) => {
      return lazy(() => nullable(schema));
    },
    array: (schema: Zod._date, field: Field) => {
      return lazy(() => array(schema));
    },
    nullableArray: (schema: Zod._date, field: Field) => {
      return lazy(() => nullable(array(schema)));
    },
  },
  bigInt: {
    base: (schema: Zod._bigint, field: Field) => {
      return lazy(() => schema);
    },
    nullable: (schema: Zod._bigint, field: Field) => {
      return lazy(() => nullable(schema));
    },
    array: (schema: Zod._bigint, field: Field) => {
      return lazy(() => array(schema));
    },
    nullableArray: (schema: Zod._bigint, field: Field) => {
      return lazy(() => nullable(array(schema)));
    },
  },
  json: {
    base: (schema: Zod._json, field: Field) => {
      return lazy(() => schema);
    },
    nullable: (schema: Zod._json, field: Field) => {
      return lazy(() => nullable(schema));
    },

    array: () => {
      throw new Error("JSON can not be represented as an array");
    },
    nullableArray: () => {
      throw new Error("JSON can not be represented as an array");
    },
  },
  enum: {
    base: (schema: Zod._enum, field: Field) => {
      return lazy(() => schema);
    },
    nullable: (schema: Zod._enum, field: Field) => {
      return lazy(() => nullable(schema));
    },
    array: (schema: Zod._enum, field: Field) => {
      return lazy(() => array(schema));
    },
    nullableArray: (schema: Zod._enum, field: Field) => {
      return lazy(() => nullable(array(schema)));
    },
  },
  vector: {
    base: (schema: Zod._vector, field: Field) => schema,
    nullable: (schema: Zod._vector, field: Field) => nullable(schema),
    array: () => {
      throw new Error("Vector can not be represented as an array");
    },
    nullableArray: () => {
      throw new Error("Vector can not be represented as an array");
    },
  },
  blob: {
    base: (schema: Zod._blob, field: Field) => {
      return schema;
    },
    nullable: (schema: Zod._blob, field: Field) => {
      return nullable(schema);
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

type CreateValidator<F extends Field> = ReturnType<
  (typeof createValidators)[F["~fieldType"]][GetValidatorType<F>]
>;

export const getCreateValidator = <F extends Field>(field: F) => {
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
  return validatorFactory(baseValidator as any) as CreateValidator<F>;
};
