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
  buildConnectSubquery,
  buildCorrelation,
  buildDisconnectFkNulls,
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
  canUseSubqueryOnly,
  getFkDirection,
  getPrimaryKeyField,
  getPrimaryKeyFields,
  getSubqueryConnects,
  needsTransaction,
  // Relation data builders
  separateData,
} from "./builders";
// Context utilities
export {
  AliasGenerator,
  createAliasGenerator,
  createChildContext,
  createQueryContext,
  getRelationInfo,
  getRelationNames,
  getScalarFieldNames,
  getTableName,
  isRelation,
  isScalarField,
} from "./context";

// Error utilities
export {
  createInvalidRelationError,
  createMissingFieldError,
  createNestedWriteError,
  createQueryError,
} from "./errors";
export type {
  AggregateArgs,
  FindArgs,
  FindFirstArgs,
  FindManyArgs,
  FindOptions,
  GroupByArgs,
  NestedCreateResult,
  TransactionContext,
  TransactionStep,
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
  buildFindFirst,
  buildFindMany,
  buildFindUnique,
  buildGroupBy,
  buildUpdate,
  buildUpdateMany,
  buildUpsert,
  executeNestedCreate,
} from "./operations";
// Main exports
export {
  createModelRegistry,
  createQueryEngine,
  QueryEngine,
} from "./query-engine";
// Result parsing
export { parseCountResult, parseMutationCount, parseResult } from "./result";
// Types
export type {
  ModelRegistry,
  Operation,
  QueryContext,
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
