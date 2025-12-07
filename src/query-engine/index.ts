/**
 * Query Engine Module
 *
 * Exports the query engine and all related utilities.
 */

// Main exports
export {
  QueryEngine,
  createQueryEngine,
  createModelRegistry,
} from "./query-engine";

// Types
export type {
  Operation,
  QueryContext,
  ModelRegistry,
  RelationInfo,
} from "./types";
export { ValidationError, QueryEngineError, NestedWriteError, Sql } from "./types";

// Error utilities
export {
  createNestedWriteError,
  createQueryError,
  createMissingFieldError,
  createInvalidRelationError,
} from "./errors";

// Validator
export { validate, validateOptional } from "./validator";

// Context utilities
export {
  createQueryContext,
  createChildContext,
  getRelationInfo,
  getTableName,
  getScalarFieldNames,
  getRelationNames,
  isScalarField,
  isRelation,
  AliasGenerator,
  createAliasGenerator,
} from "./context";

// Builders (for advanced usage)
export {
  buildWhere,
  buildWhereUnique,
  buildRelationFilter,
  buildSelect,
  buildSelectAll,
  buildInclude,
  buildOrderBy,
  buildValues,
  buildInsert,
  buildInsertMany,
  buildSet,
  buildCorrelation,
  getPrimaryKeyField,
  getPrimaryKeyFields,
  // Relation data builders
  separateData,
  getFkDirection,
  buildConnectSubquery,
  buildConnectFkValues,
  buildDisconnectFkNulls,
  needsTransaction,
  canUseSubqueryOnly,
  getSubqueryConnects,
} from "./builders";
export type {
  BuildSelectOptions,
  SeparatedData,
  RelationMutation,
  ConnectOrCreateInput,
  FkDirection,
} from "./builders";

// Operations (for advanced usage)
export {
  buildFindFirst,
  buildFindMany,
  buildFindUnique,
  buildFind,
  buildCreate,
  buildCreateMany,
  buildUpdate,
  buildUpdateMany,
  buildDelete,
  buildDeleteMany,
  buildUpsert,
  buildCount,
  buildAggregate,
  buildGroupBy,
  executeNestedCreate,
} from "./operations";
export type {
  FindArgs,
  FindOptions,
  FindFirstArgs,
  FindManyArgs,
  AggregateArgs,
  GroupByArgs,
  NestedCreateResult,
  TransactionStep,
  TransactionContext,
} from "./operations";

// Result parsing
export { parseResult, parseCountResult, parseMutationCount } from "./result";
