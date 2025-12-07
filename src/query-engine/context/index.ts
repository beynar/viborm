/**
 * Context Module
 *
 * Exports context creation and utilities.
 */

export { AliasGenerator, createAliasGenerator } from "./alias-generator";
export {
  createQueryContext,
  createChildContext,
  getRelationInfo,
  getTableName,
  getScalarFieldNames,
  getRelationNames,
  isScalarField,
  isRelation,
  getColumnName,
} from "./query-context";

