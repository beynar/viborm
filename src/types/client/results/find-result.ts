import type { Model } from "../../../schema/model.js";
import type {
  FindManyArgs,
  FindUniqueArgs,
  FindFirstArgs,
  AggregateArgs,
  GroupByArgs,
  CountArgs,
} from "../operations/find-args.js";
import type {
  SelectInput,
  IncludeInput,
  InferSelectResult,
  InferIncludeResult,
} from "../query/select-input.js";
import type { ModelFields, FieldNames } from "../foundation/index.js";

// ===== BASIC FIND RESULT TYPES =====

/**
 * Default result for a model without selection or inclusion
 */
export type DefaultFindResult<TModel extends Model<any>> = {
  [K in keyof ModelFields<TModel>]: ModelFields<TModel>[K];
};

/**
 * Result type for findUnique operation
 */
export type FindUniqueResult<
  TModel extends Model<any>,
  TArgs extends FindUniqueArgs<TModel>
> = TArgs extends { select: infer TSelect }
  ? TSelect extends SelectInput<TModel>
    ? InferSelectResult<TModel, TSelect>
    : never
  : TArgs extends { include: infer TInclude }
  ? TInclude extends IncludeInput<TModel>
    ? InferIncludeResult<TModel, TInclude>
    : never
  : DefaultFindResult<TModel>;

/**
 * Result type for findFirst operation
 */
export type FindFirstResult<
  TModel extends Model<any>,
  TArgs extends FindFirstArgs<TModel>
> = TArgs extends { select: infer TSelect }
  ? TSelect extends SelectInput<TModel>
    ? InferSelectResult<TModel, TSelect> | null
    : never
  : TArgs extends { include: infer TInclude }
  ? TInclude extends IncludeInput<TModel>
    ? InferIncludeResult<TModel, TInclude> | null
    : never
  : DefaultFindResult<TModel> | null;

/**
 * Result type for findMany operation
 */
export type FindManyResult<
  TModel extends Model<any>,
  TArgs extends FindManyArgs<TModel>
> = TArgs extends { select: infer TSelect }
  ? TSelect extends SelectInput<TModel>
    ? Array<InferSelectResult<TModel, TSelect>>
    : never
  : TArgs extends { include: infer TInclude }
  ? TInclude extends IncludeInput<TModel>
    ? Array<InferIncludeResult<TModel, TInclude>>
    : never
  : Array<DefaultFindResult<TModel>>;

// ===== AGGREGATION RESULT TYPES =====

/**
 * Result for count operations
 */
export type CountResult<
  TModel extends Model<any>,
  TArgs extends CountArgs<TModel>
> = TArgs extends { select: infer TSelect }
  ? TSelect extends Record<string, any>
    ? {
        [K in keyof TSelect]: number;
      }
    : never
  : number;

/**
 * Base aggregation result structure
 */
export type BaseAggregateResult = {
  _count: Record<string, number> | number | null;
  _avg: Record<string, number> | null;
  _sum: Record<string, number> | null;
  _min: Record<string, any> | null;
  _max: Record<string, any> | null;
};

/**
 * Result for aggregate operations
 */
export type AggregateResult<
  TModel extends Model<any>,
  TArgs extends AggregateArgs<TModel>
> = {
  [K in keyof TArgs]: K extends "_count"
    ? TArgs[K] extends Record<string, any>
      ? { [F in keyof TArgs[K]]: number }
      : number
    : K extends "_avg" | "_sum"
    ? TArgs[K] extends Record<string, any>
      ? { [F in keyof TArgs[K]]: number | null }
      : never
    : K extends "_min" | "_max"
    ? TArgs[K] extends Record<string, any>
      ? {
          [F in keyof TArgs[K]]: F extends keyof ModelFields<TModel>
            ? ModelFields<TModel>[F] | null
            : never;
        }
      : never
    : never;
};

/**
 * Result for groupBy operations
 */
export type GroupByResult<
  TModel extends Model<any>,
  TArgs extends GroupByArgs<TModel>
> = Array<
  {
    [K in keyof TArgs]: K extends "by"
      ? TArgs[K] extends ReadonlyArray<infer TKey>
        ? TKey extends keyof ModelFields<TModel>
          ? { [F in TKey]: ModelFields<TModel>[F] }
          : never
        : TArgs[K] extends keyof ModelFields<TModel>
        ? { [F in TArgs[K]]: ModelFields<TModel>[F] }
        : never
      : K extends "_count" | "_avg" | "_sum" | "_min" | "_max"
      ? AggregateResult<TModel, Pick<TArgs, K>>[K]
      : never;
  }[keyof TArgs]
>;

// ===== UTILITY RESULT TYPES =====

/**
 * Extract result type from any find operation
 */
export type ExtractFindResult<TOperation> = TOperation extends {
  findUnique: infer TArgs;
}
  ? TArgs extends FindUniqueArgs<infer TModel>
    ? FindUniqueResult<TModel, TArgs>
    : never
  : TOperation extends {
      findFirst: infer TArgs;
    }
  ? TArgs extends FindFirstArgs<infer TModel>
    ? FindFirstResult<TModel, TArgs>
    : never
  : TOperation extends {
      findMany: infer TArgs;
    }
  ? TArgs extends FindManyArgs<infer TModel>
    ? FindManyResult<TModel, TArgs>
    : never
  : never;

/**
 * Batch result wrapper for operations that can be batched
 */
export type BatchResult<TResult> = TResult[];

/**
 * Paginated result wrapper
 */
export type PaginatedResult<TResult> = {
  data: TResult[];
  meta: {
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
};

/**
 * Check if result type allows null values
 */
export type IsNullableResult<TResult> = null extends TResult ? true : false;

/**
 * Make result type non-nullable
 */
export type NonNullableResult<TResult> = TResult extends null ? never : TResult;

/**
 * Extract array element type from result
 */
export type ExtractArrayElement<TResult> = TResult extends Array<infer TElement>
  ? TElement
  : never;
