// Model exports
export { Model, model, type AnyModel } from "./model";
export type {
  // State types
  ModelState,
  // Index types
  IndexType,
  IndexOptions,
  IndexDefinition,
} from "./model";

// Helper type exports
export type {
  FieldRecord,
  ScalarFieldKeys,
  RelationKeys,
  UniqueFieldKeys,
  ScalarFields,
  RelationFields,
  UniqueFields,
  AnyCompoundConstraint,
  CompoundConstraint,
  NameFromKeys,
} from "./helper";

// Schema exports
export { getModelSchemas } from "./schemas";
