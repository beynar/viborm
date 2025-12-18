// Model exports
export { Model, model, type AnyModel } from "./model";
export type {
  // State types
  ModelState,
  DefaultModelState,
  AnyModelState,
  // Extraction helpers
  ExtractFields,
  ExtractCompoundId,
  ExtractCompoundUniques,

  // Index types
  IndexType,
  IndexOptions,
  IndexDefinition,
  // Compound key types
  CompoundKeyName,
  CompoundConstraint,
  EffectiveKeyName,
} from "./model";

export type {
  ScalarFieldKeys,
  RelationKeys,
  UniqueFieldKeys,
  ScalarFields,
  RelationFields,
  UniqueFields,
} from "./helper";

// Re-export AnyCompoundConstraint from helpers
export type { AnyCompoundConstraint } from "./types/helpers";

// Re-export FieldRecord from helpers (canonical location)
export type { FieldRecord } from "./types/helpers";

// Types exports
export * from "./types";

// Schema exports
export { getModelSchemas } from "./schemas";
