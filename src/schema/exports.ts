/**
 * Schema Builder Exports
 *
 * Main API for defining models, scalars, and relations.
 * Import from "viborm/schema"
 */

// Hydration utilities (for library authors)
export {
  getFieldSqlName,
  getModelSqlName,
  hydrateSchemaNames,
  isSchemaHydrated,
} from "./hydration";
// Schema Builder API
export { s } from "./index";
// Model and scalar types for advanced usage
export type { AnyModel, Model, ModelState } from "./model";
export type {
  AnyRelation,
  Getter,
  ReferentialAction,
  RelationCardinality,
  RelationSlot,
  RelationState,
} from "./relation";
export type { NumberScalar, Scalar } from "./scalars";
// Native database types (PG, MYSQL, SQLITE)
export { MYSQL, type NativeType, PG, SQLITE } from "./scalars/native-types";
