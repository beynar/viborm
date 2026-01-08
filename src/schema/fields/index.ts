// Field Exports
// Re-exports all field types and utilities

// Field type (union of all field classes) and type guard
export type { AnyField, Field } from "./base";
export { BigIntField, bigInt } from "./bigint/field";
export * from "./bigint/schemas";
export { BlobField, blob } from "./blob/field";
export * from "./blob/schemas";
export { BooleanField, boolean } from "./boolean/field";
export * from "./boolean/schemas";
// Base types and utilities from common
export {
  type AutoGenerateType,
  createDefaultState,
  type DefaultValue,
  type FieldState,
  type InferBaseType,
  type InferCreateType,
  type MaybeArray,
  type MaybeNullable,
  type ScalarFieldType,
  type SchemaNames,
  type UpdateState,
} from "./common";
export { DateField, date } from "./datetime/date-field";
export { DateTimeField, dateTime } from "./datetime/field";
export * from "./datetime/schemas";
export { TimeField, time } from "./datetime/time-field";
export { DecimalField, decimal } from "./decimal/field";
export * from "./decimal/schemas";
export { EnumField, enumField } from "./enum/field";
export * from "./enum/schemas";
export { FloatField, float } from "./float/field";
export * from "./float/schemas";
export { IntField, int } from "./int/field";
export * from "./int/schemas";
export { JsonField, json } from "./json/field";
export * from "./json/schemas";
// Native database types
export { MYSQL, type NativeType, PG, SQLITE } from "./native-types";
export { PointField, point } from "./point/field";
export * from "./point/schemas";
// Field classes and factory functions
export { StringField, string } from "./string/field";
// Schema exports (explicit ArkType schemas)
export * from "./string/schemas";
export { VectorField, vector } from "./vector/field";
export * from "./vector/schemas";

// Union type alias for any number field
import type { FieldState } from "./common";
import type { DecimalField } from "./decimal/field";
import type { FloatField } from "./float/field";
import type { IntField } from "./int/field";

export type NumberField =
  | IntField<FieldState<"int">>
  | FloatField<FieldState<"float">>
  | DecimalField<FieldState<"decimal">>;
