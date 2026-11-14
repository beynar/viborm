/**
 * Query Engine Types
 *
 * Shared types used across the query engine.
 */

import type { QueryExecutionContext } from "@drivers/driver";
import type { QueryResult } from "@drivers/types";
import type { Model } from "@schema/model";
import type { RelationCardinality } from "@schema/relation";
import type { Scalar } from "@schema/scalars";
import type { NormalizedRecurrence } from "@validation/relations/recurrence";

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
 * One logical operation expanded into driver-level batch queries.
 */
export interface PreparedBatchOperation<T = unknown> {
  queries: PreparedQuery[];
  guards?: PreparedBatchGuard[];
  parseResult: (results: QueryResult<unknown>[]) => T;
}

/**
 * What a prepared guard publishes when its premise does not hold: the typed
 * failure taxonomy plus the `raceable` bit fixed by the guard's premise class.
 * `batch-error-attribution.ts` is the one algorithm that reads it, and the one
 * place it becomes an `Error`.
 */
export interface PreparedGuardFailure {
  readonly kind:
    | "foreignKey"
    | "forbidden"
    | "nestedWrite"
    | "notFound"
    | "query";
  readonly message: string;
  readonly relation?: string;
  /** A `forbidden` refusal's cause, where the operation alone does not say it. */
  readonly reason?: string;
  readonly raceable: boolean;
}

/** Declarative ownership for one assertion query in a prepared operation. */
export interface PreparedBatchGuard {
  readonly queryIndex: number;
  readonly premise: "exists" | "notExists";
  readonly probe: import("@sql").Sql;
  readonly failure: PreparedGuardFailure;
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
  /**
   * The cache driver manages this execution: the operation completion closes
   * and hands over its cache outcome list.
   */
  skipSpan?: boolean;
  /**
   * The client's last step on this operation's value (its chain's computed
   * fields), applied once, after every extension and the cache have run.
   */
  finishResult?: (value: unknown) => unknown;
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
export const OPERATIONS = [
  "findFirst",
  "findMany",
  "findUnique",
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "delete",
  "deleteMany",
  "deleteManyAndReturn",
  "upsert",
  "count",
  "aggregate",
  "groupBy",
  "exist",
] as const;

export type Operation = (typeof OPERATIONS)[number];

/** Requested fields inside one aggregate JSON carrier. */
export interface ExpectedAggregateResultShape {
  /** Undefined only for the scalar `_count: true` result. */
  fields?: ReadonlySet<string>;
}

/**
 * One arm of a polymorphic projection that the selection reads
 * (`selectedArm`, result/result-shape.ts); an arm `only` excludes is absent.
 */
export interface ExpectedPolymorphicVariantShape {
  readonly model: Model<any>;
  readonly shape: ExpectedResultShape;
}

/** Exact target-specific result contracts for one polymorphic projection. */
export interface ExpectedPolymorphicResultShape {
  /** Which carrier the read emitted: the singular tagged CASE, or the collection document. */
  readonly cardinality: "one" | "many";
  readonly optional: boolean;
  readonly variants: ReadonlyMap<string, ExpectedPolymorphicVariantShape>;
}

/** Exact public result contract for one ordinary relation projection. */
export interface ExpectedRelationResultShape {
  readonly model: Model<any>;
  readonly shape: ExpectedResultShape;
  readonly cardinality: RelationCardinality;
  readonly optional: boolean;
  /**
   * The admitted recurrence of a recursive slot, the same normalized value
   * execution consumes. `shape` is then the ONE repeated node, and the slot's
   * own key recurs inside every occurrence: absent at a numeric cutoff,
   * present on every occurrence of an exhaustive traversal.
   */
  readonly recurrence?: NormalizedRecurrence;
}

/** Exact raw columns and nested projections expected for one returned row. */
export interface ExpectedResultShape {
  /** Raw statement carrier declared by the compiled operation result. */
  carrier: "rows" | "count" | "existence";
  rawKeys: readonly string[];
  /** Scalar whose selected `_distance` expression produced the private column. */
  readonly distanceScalar?: Scalar;
  relations: ReadonlyMap<string, ExpectedRelationResultShape>;
  polymorphic: ReadonlyMap<string, ExpectedPolymorphicResultShape>;
  aggregates: ReadonlyMap<string, ExpectedAggregateResultShape>;
  relationCounts: ReadonlySet<string>;
}
