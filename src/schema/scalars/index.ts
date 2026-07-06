// Scalar Exports
// Re-exports all scalar types and utilities

// Scalar type (union of all scalar classes) and type guard
export type { AnyScalar, Scalar } from "./base";
export { BigIntScalar, bigInt } from "./bigint/scalar";
export { BlobScalar, blob } from "./blob/scalar";
export { BooleanScalar, boolean } from "./boolean/scalar";
// Base types and utilities from common
export {
  type AutoGenerateType,
  createDefaultState,
  type DefaultValue,
  type InferBaseType,
  type InferCreateType,
  type MaybeArray,
  type MaybeNullable,
  type ScalarState,
  type ScalarType,
  type SchemaNames,
  type UpdateState,
} from "./common";
export { DateScalar, date } from "./datetime/date-scalar";
export { DateTimeScalar, dateTime } from "./datetime/scalar";
export { TimeScalar, time } from "./datetime/time-scalar";
export { DecimalScalar, decimal } from "./decimal/scalar";
export { EnumScalar, enumScalar } from "./enum/scalar";
export { FloatScalar, float } from "./float/scalar";
export { IntScalar, int } from "./int/scalar";
export { JsonScalar, json } from "./json/scalar";
// Native database types
export { MYSQL, type NativeType, PG, SQLITE } from "./native-types";
export { PointScalar, point } from "./point/scalar";
// Scalar classes and factory functions
export { StringScalar, string } from "./string/scalar";
export { VectorScalar, vector } from "./vector/scalar";

// Union type alias for any number scalar
import type { ScalarState } from "./common";
import type { DecimalScalar } from "./decimal/scalar";
import type { FloatScalar } from "./float/scalar";
import type { IntScalar } from "./int/scalar";

export type NumberScalar =
  | IntScalar<ScalarState<"int">>
  | FloatScalar<ScalarState<"float">>
  | DecimalScalar<ScalarState<"decimal">>;
