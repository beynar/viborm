/**
 * Schema Builder Exports
 *
 * Main API for defining models, fields, and relations.
 * Import from "viborm/schema"
 */

export type { Field, NumberField } from "./fields";

// Native database types (PG, MYSQL, SQLITE)
export { MYSQL, type NativeType, PG, SQLITE } from "./fields/native-types";
// Hydration utilities (for library authors)
export {
  getFieldSqlName,
  getModelSqlName,
  hydrateSchemaNames,
  isSchemaHydrated,
} from "./hydration";
// Schema Builder API
export { s } from "./index";
// Model and field types for advanced usage
export type { AnyModel, Model, ModelState } from "./model";
export type {
  AnyRelation,
  Getter,
  ReferentialAction,
  RelationType,
} from "./relation";
