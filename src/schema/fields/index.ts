// Field Exports
// Re-exports all field types and utilities

// Field type (union of all field classes) and type guard
export type { AnyField, Field } from "./base";
export { BigIntField, bigInt } from "./bigint/field";
export { BlobField, blob } from "./blob/field";
export { BooleanField, boolean } from "./boolean/field";
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
export { TimeField, time } from "./datetime/time-field";
export { DecimalField, decimal } from "./decimal/field";
export { EnumField, enumField } from "./enum/field";
export { FloatField, float } from "./float/field";
export { IntField, int } from "./int/field";
export { JsonField, json } from "./json/field";
// Native database types
export { MYSQL, type NativeType, PG, SQLITE } from "./native-types";
export { PointField, point } from "./point/field";
// Field classes and factory functions
export { StringField, string } from "./string/field";
export { VectorField, vector } from "./vector/field";

// Union type alias for any number field
import type { FieldState } from "./common";
import type { DecimalField } from "./decimal/field";
import type { FloatField } from "./float/field";
import type { IntField } from "./int/field";

export type NumberField =
  | IntField<FieldState<"int">>
  | FloatField<FieldState<"float">>
  | DecimalField<FieldState<"decimal">>;
