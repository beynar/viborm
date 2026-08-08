/**
 * SQL compilation scope and model helpers.
 *
 * Exports context creation and utilities.
 */

export {
  createChildScope,
  createQueryScope,
  getColumnName,
  getCompoundIdConstraint,
  getDefaultScalarFieldNames,
  getPrimaryKeyFields,
  getPolymorphicRelationInfo,
  getRelationInfo,
  getRelationNames,
  getScalarFieldNames,
  getTableName,
  isNullableScalarField,
  isPolymorphicRelation,
  isRelation,
  isScalarField,
} from "./query-scope";
