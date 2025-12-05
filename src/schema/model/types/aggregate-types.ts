// Aggregate Output Types & Full Having Clause
// Defines result types for aggregate operations and enhanced having filters

import type {
  FieldRecord,
  ScalarFieldKeys,
  NumericFieldKeys,
  InferFieldBase,
} from "./helpers";

// =============================================================================
// AGGREGATE RESULT TYPES
// =============================================================================

/**
 * Count aggregate result type
 * - true → number (count all)
 * - { field: true } → { field: number }
 */
export type CountAggregateResult<
  TInput,
  T extends FieldRecord
> = TInput extends true
  ? number
  : TInput extends Record<string, true>
  ? { [K in keyof TInput & (ScalarFieldKeys<T> | "_all")]: number }
  : never;

/**
 * Numeric aggregate result type (for _avg, _sum)
 * Results are nullable because they can be null if no rows match
 */
export type NumericAggregateResult<
  TInput,
  T extends FieldRecord
> = TInput extends Record<string, true>
  ? { [K in keyof TInput & NumericFieldKeys<T>]: number | null }
  : never;

/**
 * Min/Max aggregate result type
 * Returns the actual field types (not just numbers)
 */
export type MinMaxAggregateResult<
  TInput,
  T extends FieldRecord
> = TInput extends Record<string, true>
  ? { [K in keyof TInput & ScalarFieldKeys<T>]: InferFieldBase<T[K]> | null }
  : never;

/**
 * Full aggregate result type based on input args
 */
export type AggregateResult<TArgs, T extends FieldRecord> = {
  _count: TArgs extends { _count: infer C }
    ? CountAggregateResult<C, T>
    : never;
  _avg: TArgs extends { _avg: infer A } ? NumericAggregateResult<A, T> : never;
  _sum: TArgs extends { _sum: infer S } ? NumericAggregateResult<S, T> : never;
  _min: TArgs extends { _min: infer M } ? MinMaxAggregateResult<M, T> : never;
  _max: TArgs extends { _max: infer X } ? MinMaxAggregateResult<X, T> : never;
};

/**
 * Cleaned aggregate result - removes never fields
 */
export type CleanAggregateResult<TArgs, T extends FieldRecord> = {
  [K in keyof AggregateResult<TArgs, T> as AggregateResult<
    TArgs,
    T
  >[K] extends never
    ? never
    : K]: AggregateResult<TArgs, T>[K];
};

// =============================================================================
// HAVING CLAUSE TYPES (Full Implementation)
// =============================================================================

/**
 * Numeric filter for aggregate having clause
 * Allows filtering on aggregate values like { _count: { id: { gt: 5 } } }
 */
export interface HavingAggregateFilter {
  equals?: number;
  not?: number | HavingAggregateFilter;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  in?: number[];
  notIn?: number[];
}

/**
 * Count having input - filters on count results
 */
export type CountHavingInput<T extends FieldRecord> = {
  [K in ScalarFieldKeys<T> | "_all"]?: HavingAggregateFilter;
};

/**
 * Numeric having input (for _avg, _sum) - only numeric fields
 */
export type NumericHavingInput<T extends FieldRecord> = {
  [K in NumericFieldKeys<T>]?: HavingAggregateFilter;
};

/**
 * Min/Max having input - all comparable fields
 */
export type MinMaxHavingInput<T extends FieldRecord> = {
  [K in ScalarFieldKeys<T>]?: HavingAggregateFilter;
};

/**
 * Full having input type for groupBy
 * Combines scalar field filters with aggregate filters
 *
 * Example:
 * {
 *   name: { contains: "John" },
 *   _count: { id: { gt: 5 } },
 *   _avg: { age: { gte: 18 } }
 * }
 */
export type ModelHavingInput<
  T extends FieldRecord,
  TScalarWhere = unknown
> = TScalarWhere & {
  _count?: CountHavingInput<T>;
  _avg?: NumericHavingInput<T>;
  _sum?: NumericHavingInput<T>;
  _min?: MinMaxHavingInput<T>;
  _max?: MinMaxHavingInput<T>;
};

// =============================================================================
// GROUPBY RESULT TYPES
// =============================================================================

/**
 * Single group result from groupBy operation
 */
export type GroupByResult<
  T extends FieldRecord,
  TBy extends ScalarFieldKeys<T>,
  TArgs
> =
  // The grouped fields
  { [K in TBy]: InferFieldBase<T[K]> } & // Plus aggregate results
  CleanAggregateResult<TArgs, T>;

/**
 * Full groupBy result (array of groups)
 */
export type GroupByResults<
  T extends FieldRecord,
  TBy extends ScalarFieldKeys<T>,
  TArgs
> = GroupByResult<T, TBy, TArgs>[];
