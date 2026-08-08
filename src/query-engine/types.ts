/**
 * Query Engine Types
 *
 * Shared types used across the query engine.
 */

import type { DatabaseAdapter } from "@adapters";
import type { QueryExecutionContext } from "@drivers/driver";
import type { QueryResult } from "@drivers/types";
import type { Model } from "@schema/model";
import type { AnyRelation } from "@schema/relation";
import type { SchemaRegistryLookup } from "@validation";

// Re-export errors from unified error hierarchy
export {
  NestedWriteError,
  NotFoundError,
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

/** Raw rows/count produced by one mutation result-emulation scope. */
export interface MutationQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

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
  /** Immutable attribution captured when the ORM operation was created. */
  context: QueryExecutionContext;
}

/**
 * @deprecated `PendingOperation` now owns this lifecycle directly. This
 * type-only alias remains through the next published compatibility release;
 * no metadata object is created at runtime.
 */
export type QueryMetadata<T> =
  import("./pending-operation").PendingOperation<T>;

/**
 * One logical operation expanded into driver-level batch queries.
 */
export interface PreparedBatchOperation<T = unknown> {
  queries: PreparedQuery[];
  setupQueries?: PreparedQuery[];
  cleanupQueries?: PreparedQuery[];
  guards?: PreparedBatchGuard[];
  parseResult: (results: QueryResult<unknown>[]) => T;
}

/** Declarative ownership for one assertion query in a prepared operation. */
export interface PreparedBatchGuard {
  readonly queryIndex: number;
  readonly premise: "exists" | "notExists";
  readonly probe: import("@sql").Sql;
  readonly failure: import("./write-engine/OperationFragment").Failure;
  readonly model: string;
  readonly operation: Operation;
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
 * All supported operations.
 *
 * NOTE — `createManyAndReturn` / `updateManyAndReturn` / `deleteManyAndReturn`
 * are INTERNAL names, not client operations. The public surface has ONE name per
 * bulk family (maintainer decision D-1): `createMany` / `updateMany` /
 * `deleteMany` take an optional `select`, and its presence routes the tree to the
 * row-returning arm. These three tokens name that arm inside the SQL-building
 * substrate (result shape, program lowering, identity helpers); the client never
 * spells them, and they share their family's arg schema.
 */
export type Operation =
  | "findFirst"
  | "findMany"
  | "findUnique"
  | "create"
  | "createMany"
  | "createManyAndReturn"
  | "update"
  | "updateMany"
  | "updateManyAndReturn"
  | "delete"
  | "deleteMany"
  | "deleteManyAndReturn"
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
  readonly schemas: SchemaRegistryLookup;
}

/** Requested fields inside one aggregate JSON carrier. */
export interface ExpectedAggregateResultShape {
  /** Undefined only for the scalar `_count: true` result. */
  fields?: ReadonlySet<string>;
}

/** Exact raw columns and nested projections expected for one returned row. */
export interface ExpectedResultShape {
  /** Raw statement carrier declared by the compiled operation result. */
  carrier: "rows" | "count" | "existence";
  rawKeys: readonly string[];
  relations: ReadonlyMap<string, ExpectedResultShape>;
  aggregates: ReadonlyMap<string, ExpectedAggregateResultShape>;
  relationCounts: ReadonlySet<string>;
  /**
   * This relation was paged with a negative `take`: the subquery ran the
   * reversed order with an absolute limit, so its rows arrive last-first and
   * the parser restores the logical order — the nested mirror of what
   * `ReadOperation.parse` does for a top-level negative `take`.
   */
  reversed?: boolean;
}

/** Minimal SQL-construction state shared by related model scopes. */
export interface QueryScope {
  readonly adapter: DatabaseAdapter;
  readonly model: Model<any>;
  readonly nextAlias: () => string;
  readonly rootAlias: string;
  readonly mutationTable?: string;
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
