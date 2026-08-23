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
  getRelationNames,
  getScalarFieldNames,
  getTableName,
  isNullableScalarField,
  isRelation,
  isScalarField,
  isVariantCollectionRelation,
  isVariantRelation,
  lookupRelation,
  memberRef,
  refFromSlot,
  resolvedSlot,
  variantCarrier,
} from "./query-scope";
