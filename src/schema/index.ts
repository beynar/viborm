// Schema Builder Entry Point
// Based on specification: readme/1_schema_builder.md

import { Model } from "./model.js";
import {
  BaseField,
  StringField,
  NumberField,
  BooleanField,
  BigIntField,
  DateTimeField,
  JsonField,
  BlobField,
  EnumField,
  type Field,
} from "./fields/index.js";
import { string } from "./fields/string.js";
import { int, float, decimal } from "./fields/number.js";
import { boolean } from "./fields/boolean.js";
import { bigint } from "./fields/bigint.js";
import { datetime } from "./fields/datetime.js";
import { json } from "./fields/json.js";
import { blob } from "./fields/blob.js";
import { enumField } from "./fields/enum.js";
import {
  Getter,
  relation,
  Relation,
  lazy,
  type LazyFactory,
} from "./relation.js";
export class SchemaBuilder {
  // Create a new model
  model<
    TName extends string,
    TFields extends Record<string, Field | Relation<any, any>>
  >(name: TName, fields: TFields): Model<TFields> {
    return new Model(name, fields);
  }

  // Create specific field types
  string() {
    return string();
  }

  boolean() {
    return boolean();
  }

  int() {
    return int();
  }

  bigInt() {
    return bigint();
  }

  float() {
    return float();
  }

  decimal() {
    return decimal();
  }

  dateTime() {
    return datetime();
  }

  json(): ReturnType<typeof json>;
  json<
    TSchema extends import("../types/standardSchema.js").StandardSchemaV1<
      any,
      any
    >
  >(schema: TSchema): ReturnType<typeof json<TSchema>>;
  json<
    TSchema extends import("../types/standardSchema.js").StandardSchemaV1<
      any,
      any
    >
  >(schema?: TSchema) {
    return schema ? json(schema) : json();
  }

  blob() {
    return blob();
  }

  enum<TEnum extends readonly (string | number)[]>(values: TEnum) {
    return enumField(values);
  }

  // Relation factory - expose the relation function
  relation = relation;

  // Lazy relation factory for recursive schemas - expose the lazy object with .many property
  get lazy(): LazyFactory {
    return lazy;
  }
}

// Export the main schema builder instance
export const s = new SchemaBuilder();

// Re-export classes for advanced usage
export {
  Model,
  BaseField,
  StringField,
  NumberField,
  BooleanField,
  BigIntField,
  DateTimeField,
  JsonField,
  BlobField,
  EnumField,
  Relation,
  relation,
  lazy,
};
export type { Field, Getter };
