// Schema Validation Module

export {
  // All rules
  allRules,
  cascadeOnRequiredWarning,
  compoundFieldsExist,
  createDatabaseRules,
  databaseRules,
  enumValueValid,
  fkCardinalityMatch,
  // FK rules (FK001-FK007)
  fkFieldExists,
  fkFieldNotRelation,
  fkReferenceExists,
  fkReferencesUnique,
  fkRequiredForOwning,
  fkRules,
  fkTypeMatch,
  // Index rules (I001-I003)
  indexFieldsExist,
  indexNameUnique,
  junctionFieldsDistinct,
  junctionFieldsValid,
  // Junction table rules (JT001-JT005)
  junctionTableUnique,
  // Model rules (consolidated into single-pass validation)
  modelHasFields,
  modelNameNotReserved,
  modelNameValid,
  modelRules,
  modelUniqueName,
  // Database rules (DB001-DB002)
  mysqlNoArrayFields,
  noCircularRequiredChain,
  // Cross-model rules (CM001-CM004)
  noOrphanFkFields,
  // Referential action rules (RA001-RA004)
  onDeleteValid,
  onUpdateValid,
  polymorphicRelationWarning,
  relationHasInverse,
  relationNameUnique,
  relationPairFkSingleSide,
  relationRules,
  // Relation rules (R001-R007)
  relationTargetExists,
  selfRefDistinctNames,
  selfRefJunctionOrder,
  // Self-ref rules (SR001-SR002)
  selfRefValidInverse,
  setNullRequiresNullable,
  sqliteNoEnum,
  throughOnlyManyToMany,
  // Single-pass field validation (M001 + F001-F008)
  validateFieldsSinglePass,
} from "./rules";
export type { DatabaseType } from "./rules/database";
export type {
  Schema,
  Severity,
  ValidationError,
  ValidationResult,
  ValidationRule,
} from "./types";
export {
  SchemaValidator,
  validateSchema,
  validateSchemaOrThrow,
} from "./validator";
