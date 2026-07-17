/**
 * Query Engine Module
 *
 * Exports the query engine and all related utilities.
 */

export type {
  BuildSelectOptions,
  ConnectOrCreateInput,
  FkDirection,
  RelationMutation,
  SeparatedData,
} from "./builders";
// Builders (for advanced usage)
export {
  buildConnectFkValues,
  buildCorrelation,
  buildInclude,
  buildInsert,
  buildInsertMany,
  buildOrderBy,
  buildRelationFilter,
  buildSelect,
  buildSelectAll,
  buildSet,
  buildValues,
  buildWhere,
  buildWhereUnique,
  getFkDirection,
  getPrimaryKeyField,
  getPrimaryKeyFields,
  needsTransaction,
  // Relation data builders
  separateData,
} from "./builders";
// Context utilities
export {
  createChildScope,
  createQueryScope,
  getRelationInfo,
  getRelationNames,
  getScalarFieldNames,
  getTableName,
  isRelation,
  isScalarField,
} from "./context";

export type {
  AggregateArgs,
  FindArgs,
  FindFirstArgs,
  FindManyArgs,
  FindOptions,
  GroupByArgs,
} from "./operations";
// Operations (for advanced usage)
export {
  buildAggregate,
  buildCount,
  buildCreate,
  buildCreateMany,
  buildDelete,
  buildDeleteMany,
  buildFind,
  buildFindUnique,
  buildGroupBy,
  buildUpdate,
  buildUpdateMany,
  buildUpsert,
} from "./operations";
// Main exports
export {
  createModelRegistry,
  createQueryEngine,
  QueryEngine,
} from "./query-engine";
// Result parsing
export { parseMutationCount, parseResult, ResultParser } from "./result";
// Types
export type {
  ModelRegistry,
  Operation,
  PreparedQuery,
  QueryScope,
  RelationInfo,
} from "./types";
export {
  NestedWriteError,
  QueryEngineError,
  Sql,
  ValidationError,
} from "./types";
// Validator
export { validate, validateOptional } from "./validator";
