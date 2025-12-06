// Schema Validation Module

export type {
  ValidationError,
  ValidationResult,
  ValidationRule,
  Schema,
  Severity,
} from "./types";

export {
  SchemaValidator,
  validateSchema,
  validateSchemaOrThrow,
} from "./validator";

export {
  // Model rules (consolidated into single-pass validation)
  modelHasFields,
  modelUniqueName,
  modelNameValid,
  modelNameNotReserved,
  // Single-pass field validation (M001 + F001-F008)
  validateFieldsSinglePass,
  // Index rules (I001-I003)
  indexFieldsExist,
  indexNameUnique,
  compoundFieldsExist,
  modelRules,
  // Relation rules (R001-R007)
  relationTargetExists,
  relationHasInverse,
  relationNameUnique,
  relationRules,
  // Junction table rules (JT001-JT005)
  junctionTableUnique,
  junctionFieldsValid,
  junctionFieldsDistinct,
  selfRefJunctionOrder,
  throughOnlyManyToMany,
  // Self-ref rules (SR001-SR002)
  selfRefValidInverse,
  selfRefDistinctNames,
  // Cross-model rules (CM001-CM004)
  noOrphanFkFields,
  relationPairFkSingleSide,
  polymorphicRelationWarning,
  noCircularRequiredChain,
  // FK rules (FK001-FK007)
  fkFieldExists,
  fkReferenceExists,
  fkTypeMatch,
  fkRequiredForOwning,
  fkReferencesUnique,
  fkFieldNotRelation,
  fkCardinalityMatch,
  fkRules,
  // Referential action rules (RA001-RA004)
  onDeleteValid,
  onUpdateValid,
  cascadeOnRequiredWarning,
  setNullRequiresNullable,
  // Database rules (DB001-DB002)
  mysqlNoArrayFields,
  sqliteNoEnum,
  enumValueValid,
  createDatabaseRules,
  databaseRules,
  // All rules
  allRules,
} from "./rules";

export type { DatabaseType } from "./rules/database";
