// Schema Builder Entry Point
// Based on specification: readme/1_schema_builder.md

import { model, Model } from "./model.js";
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
import { Getter, relation, Relation } from "./relation.js";
export class SchemaBuilder {
  // Create a new model
  model = model;
  string = string;
  boolean = boolean;
  int = int;
  bigInt = bigint;
  float = float;
  decimal = decimal;
  dateTime = datetime;
  json = json;
  blob = blob;
  enum = enumField;

  // Relation factory - expose the relation function
  relation = relation;
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
};
export type { Field, Getter };
