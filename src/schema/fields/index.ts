// Field Exports
// Re-exports all field types and utilities

// Base types and utilities from common
export {
  type FieldState,
  type ScalarFieldType,
  type AutoGenerateType,
  type UpdateState,
  type MaybeNullable,
  type MaybeArray,
  type DefaultValue,
  type InferBaseType,
  type InferCreateType,
  type SchemaNames,
  createDefaultState,
} from "./common";

// Field type (union of all field classes) and type guard
export {
  type Field,
  type AnyField,
  type FieldLike, // deprecated
  type BaseField, // deprecated
  isField,
} from "./base";

// Native database types
export { PG, MYSQL, SQLITE, type NativeType } from "./native-types";

// Standard schema utilities
export * from "./standard-schema";

// Field classes and factory functions
export { StringField, string } from "./string/field";
export {
  IntField,
  FloatField,
  DecimalField,
  int,
  float,
  decimal,
} from "./number/field";
export type { NumberField } from "./number/index";
export { BooleanField, boolean } from "./boolean/field";
export { DateTimeField, dateTime } from "./datetime/field";
export { BigIntField, bigInt } from "./bigint/field";
export { JsonField, json } from "./json/field";
export { VectorField, vector } from "./vector/field";
export { BlobField, blob } from "./blob/field";
export { EnumField, enumField } from "./enum/field";

// Schema exports (explicit ArkType schemas)
export * from "./string/schemas";
export * from "./number/schemas";
export * from "./boolean/schemas";
export * from "./datetime/schemas";
export * from "./bigint/schemas";
export * from "./json/schemas";
export * from "./vector/schemas";
export * from "./blob/schemas";
export * from "./enum/schemas";
