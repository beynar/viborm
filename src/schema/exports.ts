/**
 * Schema Builder Exports
 *
 * Main API for defining models, scalars, and relations.
 * Import from "viborm/schema"
 */

// Schema Builder API
export { s } from "./index";
// Model and scalar types for advanced usage
export type { AnyModel, Model } from "./model";
export type {
  AnyRelation,
  Getter,
  ReferentialAction,
  RelationCardinality,
  RelationSlot,
} from "./relation";
export type { GeoPoint, NumberScalar, NumericScalar, Scalar } from "./scalars";
// Native database types (PG, MYSQL, SQLITE)
export { MYSQL, type NativeType, PG, SQLITE } from "./scalars/native-types";
