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
} from "./field.js";
import { Relation } from "./relation.js";

export class SchemaBuilder {
  // Create a new model
  model<
    TName extends string,
    TFields extends Record<string, Field | Relation<any>>
  >(name: TName, fields: TFields): Model<TFields> {
    return new Model(name, fields);
  }

  // Create specific field types
  string(): StringField {
    return new StringField();
  }

  boolean(): BooleanField {
    return new BooleanField();
  }

  int(): NumberField {
    return new NumberField("int");
  }

  bigInt(): BigIntField {
    return new BigIntField();
  }

  float(): NumberField {
    return new NumberField("float");
  }

  decimal(precision: number, scale: number): NumberField {
    return new NumberField("decimal");
  }

  dateTime(): DateTimeField {
    return new DateTimeField();
  }

  json<T = any>(): JsonField<T> {
    return new JsonField<T>();
  }

  blob(): BlobField {
    return new BlobField();
  }

  enum<TEnum extends readonly (string | number)[]>(
    values: TEnum
  ): EnumField<TEnum> {
    return new EnumField(values);
  }

  // Relation factory
  get relation() {
    return {
      one: <T>(target: () => T): Relation<T> => new Relation().one(target),
      many: <T>(target: () => T): Relation<T[]> => new Relation().many(target),
    };
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
};
export type { Field };
