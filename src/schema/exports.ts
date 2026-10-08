/**
 * Schema Builder Exports
 *
 * Main API for defining models, scalars, and relations.
 * Import from "viborm/schema"
 */

export type { BigIntSchema } from "../validation/primitives/bigint";
export type { BlobSchema } from "../validation/primitives/blob";
export type { BooleanSchema } from "../validation/primitives/boolean";
export type { DecimalSchema } from "../validation/primitives/decimal";
export type { DecimalDescriptor } from "../validation/primitives/decimal-codec";
export type { EnumSchema } from "../validation/primitives/enum";
export type {
  IsoDateSchema,
  IsoTimeSchema,
  IsoTimestampSchema,
} from "../validation/primitives/iso";
export type { JsonSchema as JsonValueSchema } from "../validation/primitives/json";
export type {
  IntegerSchema,
  NumberSchema,
} from "../validation/primitives/number";
export type { PointSchema } from "../validation/primitives/point";
export type { StringSchema } from "../validation/primitives/string";
export type { VectorSchema } from "../validation/primitives/vector";
// Schema Builder API
export { s } from "./index";
// Model and scalar types for advanced usage
export type { AnyModel, Model, ModelShape, ModelState } from "./model";
export type {
  ModelInternal,
  UpdateState as ModelUpdateState,
} from "./model/model";
export type {
  AnyRelation,
  Getter,
  ReferentialAction,
  RelationCardinality,
  RelationSlot,
} from "./relation";
export type {
  AutoGenerate,
  BigIntScalar,
  BlobScalar,
  BooleanScalar,
  DateScalar,
  DateTimeScalar,
  DecimalScalar,
  EnumScalar,
  GeoPoint,
  IntScalar,
  JsonScalar,
  NumberScalar,
  NumericScalar,
  PointScalar,
  Scalar,
  ScalarState,
  StringScalar,
  TimeScalar,
  UpdateState as ScalarUpdateState,
  VectorScalar,
} from "./scalars";
export type { GeneratorDefaultBrand } from "./scalars/common";
// Native database types (PG, MYSQL, SQLITE)
export {
  MYSQL,
  type NativeType,
  type NativeTypeMap,
  PG,
  SQLITE,
} from "./scalars/native-types";
