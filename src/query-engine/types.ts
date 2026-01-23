/**
 * Query Engine Types
 *
 * Shared types used across the query engine.
 */

import type { DatabaseAdapter } from "@adapters";
import type { AnyDriver } from "@drivers/driver";
import type { Model } from "@schema/model";
import type { AnyRelation } from "@schema/relation";

// Re-export errors from unified error hierarchy
export {
  NestedWriteError,
  QueryEngineError,
  ValidationError,
} from "@errors";
// Re-export Sql for convenience
export { Sql } from "@sql";

// ============================================================
// BATCH EXECUTION TYPES
// ============================================================

/**
 * Raw result from database execution
 * - For regular queries: array of rows
 * - For batch operations (createMany, etc.): object with rowCount
 */
export type RawQueryResult = unknown[] | { rowCount: number };

/**
 * Result parser function type
 * Transforms raw database result into typed application objects
 */
export type ResultParser<T> = (raw: RawQueryResult) => T;

/**
 * Prepared query ready for batch execution
 */
export interface PreparedQuery {
  /** SQL string */
  sql: string;
  /** Query parameters */
  params: unknown[];
}

/**
 * Query metadata for lazy execution
 *
 * Validation and SQL building are deferred to execution time.
 * This enables proper span ordering and prepares for future prepared statement support.
 */
export interface QueryMetadata<T> {
  /** Unique identifier for the client that created this operation */
  clientId: symbol;
  /** Raw arguments (not yet validated) */
  args: Record<string, unknown>;
  /** The operation type */
  operation: Operation;
  /** Model name */
  model: string;
  /** Function to execute the operation (validates, builds SQL, executes, parses) */
  execute: (driverOverride?: AnyDriver) => Promise<T>;
  /**
   * Function to prepare the query (validate, build SQL) without executing.
   * Returns the SQL string and parameters for batch execution.
   * Only available for operations that can be batched (no nested writes).
   */
  prepare?: (driverOverride?: AnyDriver) => PreparedQuery;
  /**
   * Function to parse raw query result into typed result.
   * Used after batch execution to transform the raw result.
   */
  parseResult?: (raw: { rows: unknown[]; rowCount: number }) => T;
  /** Whether this is a batch operation (returns rowCount instead of rows) */
  isBatchOperation: boolean;
  /** Whether this operation has nested writes (can't be batched) */
  hasNestedWrites: boolean;
}

/**
 * Options for engine.prepare()
 */
export interface PrepareOptions {
  /** Throw NotFoundError if result is null (for OrThrow variants) */
  throwIfNotFound?: boolean;
  /** Original operation name for error messages */
  originalOperation?: string;
  /** Skip SPAN_OPERATION wrapper (when caller provides its own, e.g., cache driver) */
  skipSpan?: boolean;
}

/**
 * All supported operations
 */
export type Operation =
  | "findFirst"
  | "findMany"
  | "findUnique"
  | "create"
  | "createMany"
  | "update"
  | "updateMany"
  | "delete"
  | "deleteMany"
  | "upsert"
  | "count"
  | "aggregate"
  | "groupBy"
  | "exist";

/** Operations that return BatchPayload { count: number } */
export const BATCH_OPERATIONS = [
  "createMany",
  "updateMany",
  "deleteMany",
] as const;
export type BatchOperation = (typeof BATCH_OPERATIONS)[number];

/** Check if operation is a batch operation */
export function isBatchOperation(op: Operation): op is BatchOperation {
  return (BATCH_OPERATIONS as readonly string[]).includes(op);
}

/**
 * Model registry for accessing related models
 */
export interface ModelRegistry {
  get(name: string): Model<any> | undefined;
  getByTableName(tableName: string): Model<any> | undefined;
}

/**
 * Query context passed to all builders
 */
export interface QueryContext {
  /** Database driver (optional, for result parsing) */
  driver?: AnyDriver;
  /** Database adapter for SQL generation */
  adapter: DatabaseAdapter;
  /** Current model being queried */
  model: Model<any>;
  /** Model registry for relation lookups */
  registry: ModelRegistry;
  /** Alias generator for table aliases */
  nextAlias: () => string;
  /** Get root alias (t0) */
  rootAlias: string;
  /** Cached parse result chain (lazily initialized) */
  _parseResultChain?: (value: unknown, op: Operation) => unknown;
  /** Cached parse field chains by field type (lazily initialized) */
  _parseFieldChains?: Map<string, (value: unknown) => unknown>;
  /** Cached parse relation chains by relation name (lazily initialized) */
  _parseRelationChains?: Map<string, (value: unknown) => unknown>;
}

/**
 * Relation info extracted from model for query building
 */
export interface RelationInfo {
  name: string;
  relation: AnyRelation;
  targetModel: Model<any>;
  /** Relation type: oneToOne, oneToMany, manyToOne, manyToMany */
  type: "oneToOne" | "oneToMany" | "manyToOne" | "manyToMany";
  isToMany: boolean;
  isToOne: boolean;
  isOptional: boolean;
  /** Foreign key fields on current model */
  fields: string[] | undefined;
  /** Referenced fields on target model */
  references: string[] | undefined;
}

// ============================================================
// NARROWER TYPE DEFINITIONS
// These provide better autocomplete and error messages
// ============================================================

/**
 * Scalar filter operators for where clauses
 */
export interface ScalarFilter<T = unknown> {
  equals?: T | null;
  not?: T | ScalarFilter<T> | null;
  in?: T[];
  notIn?: T[];
  lt?: T;
  lte?: T;
  gt?: T;
  gte?: T;
}

/**
 * String-specific filter operators
 */
export interface StringFilter extends ScalarFilter<string> {
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  mode?: "default" | "insensitive";
}

/**
 * Array/list filter operators
 */
export interface ArrayFilter<T = unknown> {
  has?: T;
  hasEvery?: T[];
  hasSome?: T[];
  isEmpty?: boolean;
}

/**
 * Relation filter for to-one relations
 */
export interface ToOneRelationFilter {
  is?: WhereInput | null;
  isNot?: WhereInput | null;
}

/**
 * Relation filter for to-many relations
 */
export interface ToManyRelationFilter {
  some?: WhereInput;
  every?: WhereInput;
  none?: WhereInput;
}

/**
 * Where input for filtering records
 */
export interface WhereInput {
  AND?: WhereInput | WhereInput[];
  OR?: WhereInput[];
  NOT?: WhereInput | WhereInput[];
  [field: string]:
    | unknown
    | ScalarFilter
    | StringFilter
    | ArrayFilter
    | ToOneRelationFilter
    | ToManyRelationFilter
    | WhereInput
    | WhereInput[]
    | undefined;
}

/**
 * Order by direction
 */
export type SortOrder = "asc" | "desc";

/**
 * Order by input for sorting
 */
export interface OrderByInput {
  [field: string]: SortOrder | OrderByInput;
}

/**
 * Select input for field selection
 */
export interface SelectInput {
  [field: string]: boolean | SelectInput | IncludeInput;
}

/**
 * Include input for relation inclusion
 */
export interface IncludeInput {
  [relation: string]:
    | boolean
    | {
        select?: SelectInput;
        include?: IncludeInput;
        where?: WhereInput;
        orderBy?: OrderByInput | OrderByInput[];
        take?: number;
        skip?: number;
      };
}

/**
 * Numeric update operations
 */
export interface NumericUpdateOperations<T = number> {
  set?: T;
  increment?: T;
  decrement?: T;
  multiply?: T;
  divide?: T;
}

/**
 * Array update operations
 */
export interface ArrayUpdateOperations<T = unknown> {
  set?: T[];
  push?: T | T[];
}

/**
 * Update data input
 */
export interface UpdateInput {
  [field: string]: unknown | NumericUpdateOperations | ArrayUpdateOperations;
}

/**
 * Create data input
 */
export interface CreateInput {
  [field: string]: unknown;
}

/**
 * Aggregate filter for HAVING clause
 */
export interface AggregateFilter {
  equals?: number;
  not?: number | null;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  in?: number[];
  notIn?: number[];
}

/**
 * Having input for groupBy
 */
export interface HavingInput {
  _count?: Record<string, AggregateFilter>;
  _avg?: Record<string, AggregateFilter>;
  _sum?: Record<string, AggregateFilter>;
  _min?: Record<string, AggregateFilter>;
  _max?: Record<string, AggregateFilter>;
  [field: string]:
    | unknown
    | AggregateFilter
    | Record<string, AggregateFilter>
    | undefined;
}
