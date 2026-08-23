// Schema Validation Module

export {
  allRules,
  compoundFieldsExist,
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
export { SchemaValidationError, isSchemaValidationError } from "./error";
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
export type {
  Schema,
  SchemaValidationIssue,
  SchemaValidationIssue as ValidationError,
  Severity,
  ValidationResult,
  ValidationRule,
} from "./types";
export {
  SchemaValidator,
  resolveSchemaOrThrow,
  validateClientSchemaOrThrow,
  validateSchema,
  validateSchemaOrThrow,
} from "./validator";
