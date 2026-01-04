/**
 * Query Engine Types
 *
 * Shared types used across the query engine.
 */

import type { DatabaseAdapter } from "@adapters";
import type { Model } from "@schema/model";
import type { AnyRelation } from "@schema/relation";

// Re-export Sql for convenience
export { Sql } from "@sql";

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

/**
 * Validation error thrown when input doesn't match schema
 */
export class ValidationError extends Error {
  constructor(
    public readonly operation: Operation,
    public readonly details: string
  ) {
    super(`Validation failed for ${operation}: ${details}`);
    this.name = "ValidationError";
  }
}

/**
 * Query engine error for runtime issues
 */
export class QueryEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryEngineError";
  }
}

/**
 * Error thrown during nested write operations
 * Provides context about which relation failed
 */
export class NestedWriteError extends QueryEngineError {
  constructor(
    message: string,
    public readonly relation: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "NestedWriteError";
    // Preserve the original stack trace if available
    if (cause?.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
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
