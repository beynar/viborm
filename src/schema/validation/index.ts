// Schema Validation Module

export { isSchemaValidationError, SchemaValidationError } from "./error";
export type {
  RelationResolution,
  ResolvedRelationEdge,
  ResolvedRelationIndex,
  ResolvedSlot,
  ResolvedStoredReference,
  ResolvedVariantEdge,
  ResolvedVariantJunctionEdge,
  ResolvedVariantJunctionMember,
  ResolvedVariantRowEdge,
  ResolvedVariantRowMember,
  ResolvedVariantRowStorage,
} from "./relation-resolution";
export { resolvedEdges, resolveSchemaRelations } from "./relation-resolution";
export {
  allRules,
  compoundConstraintsNonEmpty,
  indexFieldsExist,
  indexNameUnique,
  modelHasFields,
  modelMappedNameValid,
  modelNameNotReserved,
  modelNameValid,
  modelRules,
  noOrphanFkFields,
  polymorphicRelationWarning,
  relationRules,
  validateFieldsSinglePass,
} from "./rules";
export type {
  Schema,
  SchemaValidationIssue,
  SchemaValidationIssue as ValidationError,
  Severity,
  ValidationResult,
  ValidationRule,
} from "./types";
export {
  resolveSchemaOrThrow,
  SchemaValidator,
  validateClientSchemaOrThrow,
  validateSchema,
  validateSchemaOrThrow,
} from "./validator";
