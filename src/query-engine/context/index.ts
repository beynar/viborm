/**
 * Context Module
 *
 * Exports context creation and utilities.
 */

export { AliasGenerator, createAliasGenerator } from "./alias-generator";
export {
  createChildContext,
  createQueryContext,
  getColumnName,
  getRelationInfo,
  getRelationNames,
  getScalarFieldNames,
  getTableName,
  isRelation,
  isScalarField,
} from "./query-context";
