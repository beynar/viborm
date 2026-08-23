// Model exports

// Helper type exports
export type {
  AnyCompoundConstraint,
  CompoundConstraint,
  ModelShape,
  NameFromKeys,
  NumericScalarKeys,
  NumericScalarType,
  RelationKeys,
  RelationMap,
  ScalarKeys,
  ScalarMap,
  UniqueScalarKeys,
  UniqueScalarMap,
} from "./helper";
export {
  findAddressableKey,
  getModelKeyCatalog,
  type ModelKeyCatalog,
  type OrderedModelKey,
} from "./keys";
export type {
  IndexDefinition,
  IndexOptions,
  // Index types
  IndexType,
  // State types
  ModelState,
} from "./model";
export {
  type AnyModel,
  getColumnName,
  getTableName,
  isTotalIndex,
  Model,
  model,
  type NameRegistry,
} from "./model";
