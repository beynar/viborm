// Model Schema Factories
// Main entry point - builds all model schemas by composing field-level schemas

export type { CoreSchemas } from "./core";

// Re-export args schemas
export * from "./args";
// Re-export core schemas
export * from "./core";
// Re-export the class
export { ModelSchemas } from "./model-schemas";
// Re-export utilities (if needed externally)
export { forEachRelation, forEachScalarField, isToOne } from "./utils";
