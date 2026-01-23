/**
 * Schema Builder Exports
 *
 * Main API for defining models, fields, and relations.
 * Import from "viborm/schema"
 */

// Schema Builder API
export { s } from "./index";

// Native database types (PG, MYSQL, SQLITE)
export { PG, MYSQL, SQLITE, type NativeType } from "./fields/native-types";

// Model and field types for advanced usage
export type { Model, ModelState, AnyModel } from "./model";
export type { Field, NumberField } from "./fields";
export type {
  AnyRelation,
  Getter,
  ReferentialAction,
  RelationType,
} from "./relation";

// Hydration utilities (for library authors)
export {
  hydrateSchemaNames,
  isSchemaHydrated,
  getModelSqlName,
  getFieldSqlName,
} from "./hydration";
