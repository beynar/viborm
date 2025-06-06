import {
  lazy,
  bigint,
  date,
  enum as enum_,
  json,
  number,
  boolean,
  string,
  array,
  any,
} from "zod/v4-mini";

import { Field } from "@schema";
import { wrapStandardSchema, Zod } from "./utils";

const baseValidators = {
  string: string,
  int: number,
  float: number,
  decimal: number,
  boolean: boolean,
  dateTime: date,
  bigInt: bigint,
  json: json,
  enum: <T extends string[]>(values: T) => enum_(values),
  vector: () => array(number()),
  blob: any,
};

type BaseValidator<F extends Field> = F["~fieldType"] extends "string"
  ? Zod._string
  : F["~fieldType"] extends "int"
  ? Zod._number
  : F["~fieldType"] extends "float"
  ? Zod._number
  : F["~fieldType"] extends "decimal"
  ? Zod._number
  : F["~fieldType"] extends "boolean"
  ? Zod._boolean
  : F["~fieldType"] extends "dateTime"
  ? Zod._date
  : F["~fieldType"] extends "bigInt"
  ? Zod._bigint
  : F["~fieldType"] extends "json"
  ? Zod._json
  : F["~fieldType"] extends "vector"
  ? Zod._vector
  : F["~fieldType"] extends "blob"
  ? Zod._blob
  : F["~fieldType"] extends "enum"
  ? Zod._enum<F>
  : never;

export const getBaseValidator = <F extends Field>(field: F) => {
  const schema = baseValidators[field["~fieldType"]];
  const baseSchema =
    field["~fieldType"] === "enum"
      ? schema(field["~getEnumValues"]())
      : (schema as any)();

  return wrapStandardSchema(
    baseSchema,
    field["~validator"]
  ) as BaseValidator<F>;
};
