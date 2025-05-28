import type { Model } from "../../../schema/model";
import type {
  CreateArgs,
  CreateManyArgs,
  UpdateArgs,
  UpdateManyArgs,
  UpsertArgs,
  DeleteArgs,
  DeleteManyArgs,
  BatchPayload,
} from "../operations/mutation-args";
import type {
  SelectInput,
  IncludeInput,
  InferSelectResult,
  InferIncludeResult,
} from "../query/select-input";
import type { ModelFields } from "../foundation";

// ===== BASIC MUTATION RESULT TYPES =====

/**
 * Default result for a model without selection or inclusion
 */
export type DefaultMutationResult<TModel extends Model<any>> = {
  [K in keyof ModelFields<TModel>]: ModelFields<TModel>[K];
};

/**
 * Result type for create operations
 */
export type CreateResult<
  TModel extends Model<any>,
  TArgs extends CreateArgs<TModel>
> = TArgs extends { select: infer TSelect }
  ? TSelect extends SelectInput<TModel>
    ? InferSelectResult<TModel, TSelect>
    : never
  : TArgs extends { include: infer TInclude }
  ? TInclude extends IncludeInput<TModel>
    ? InferIncludeResult<TModel, TInclude>
    : never
  : DefaultMutationResult<TModel>;

/**
 * Result type for createMany operations
 */
export type CreateManyResult<
  TModel extends Model<any>,
  TArgs extends CreateManyArgs<TModel>
> = BatchPayload;

/**
 * Result type for update operations
 */
export type UpdateResult<
  TModel extends Model<any>,
  TArgs extends UpdateArgs<TModel>
> = TArgs extends { select: infer TSelect }
  ? TSelect extends SelectInput<TModel>
    ? InferSelectResult<TModel, TSelect>
    : never
  : TArgs extends { include: infer TInclude }
  ? TInclude extends IncludeInput<TModel>
    ? InferIncludeResult<TModel, TInclude>
    : never
  : DefaultMutationResult<TModel>;

/**
 * Result type for updateMany operations
 */
export type UpdateManyResult<
  TModel extends Model<any>,
  TArgs extends UpdateManyArgs<TModel>
> = BatchPayload;

/**
 * Result type for upsert operations
 */
export type UpsertResult<
  TModel extends Model<any>,
  TArgs extends UpsertArgs<TModel>
> = TArgs extends { select: infer TSelect }
  ? TSelect extends SelectInput<TModel>
    ? InferSelectResult<TModel, TSelect>
    : never
  : TArgs extends { include: infer TInclude }
  ? TInclude extends IncludeInput<TModel>
    ? InferIncludeResult<TModel, TInclude>
    : never
  : DefaultMutationResult<TModel>;

/**
 * Result type for delete operations
 */
export type DeleteResult<
  TModel extends Model<any>,
  TArgs extends DeleteArgs<TModel>
> = TArgs extends { select: infer TSelect }
  ? TSelect extends SelectInput<TModel>
    ? InferSelectResult<TModel, TSelect>
    : never
  : TArgs extends { include: infer TInclude }
  ? TInclude extends IncludeInput<TModel>
    ? InferIncludeResult<TModel, TInclude>
    : never
  : DefaultMutationResult<TModel>;

/**
 * Result type for deleteMany operations
 */
export type DeleteManyResult<
  TModel extends Model<any>,
  TArgs extends DeleteManyArgs<TModel>
> = BatchPayload;

// ===== RELATION MUTATION RESULTS =====

/**
 * Result for relation connect operations
 */
export type ConnectResult<TRelatedModel extends Model<any>> = {
  id: string; // Assumes all models have an id field for connection
};

/**
 * Result for relation disconnect operations
 */
export type DisconnectResult = {
  count: number;
};

/**
 * Result for nested relation operations
 */
export type NestedMutationResult<
  TRelatedModel extends Model<any>,
  TOperation extends "create" | "update" | "upsert" | "delete"
> = TOperation extends "create"
  ? DefaultMutationResult<TRelatedModel>
  : TOperation extends "update"
  ? DefaultMutationResult<TRelatedModel>
  : TOperation extends "upsert"
  ? DefaultMutationResult<TRelatedModel>
  : TOperation extends "delete"
  ? DefaultMutationResult<TRelatedModel>
  : never;

// ===== UTILITY MUTATION RESULT TYPES =====

/**
 * Extract result type from any mutation operation
 */
export type ExtractMutationResult<TOperation> = TOperation extends {
  create: infer TArgs;
}
  ? TArgs extends CreateArgs<infer TModel>
    ? CreateResult<TModel, TArgs>
    : never
  : TOperation extends {
      createMany: infer TArgs;
    }
  ? TArgs extends CreateManyArgs<infer TModel>
    ? CreateManyResult<TModel, TArgs>
    : never
  : TOperation extends {
      update: infer TArgs;
    }
  ? TArgs extends UpdateArgs<infer TModel>
    ? UpdateResult<TModel, TArgs>
    : never
  : TOperation extends {
      updateMany: infer TArgs;
    }
  ? TArgs extends UpdateManyArgs<infer TModel>
    ? UpdateManyResult<TModel, TArgs>
    : never
  : TOperation extends {
      upsert: infer TArgs;
    }
  ? TArgs extends UpsertArgs<infer TModel>
    ? UpsertResult<TModel, TArgs>
    : never
  : TOperation extends {
      delete: infer TArgs;
    }
  ? TArgs extends DeleteArgs<infer TModel>
    ? DeleteResult<TModel, TArgs>
    : never
  : TOperation extends {
      deleteMany: infer TArgs;
    }
  ? TArgs extends DeleteManyArgs<infer TModel>
    ? DeleteManyResult<TModel, TArgs>
    : never
  : never;

/**
 * Union of all possible mutation results
 */
export type AnyMutationResult<TModel extends Model<any>> =
  | DefaultMutationResult<TModel>
  | BatchPayload;

/**
 * Check if mutation result is a batch operation
 */
export type IsBatchMutationResult<TResult> = TResult extends BatchPayload
  ? true
  : false;

/**
 * Extract single record result from batch or single mutation
 */
export type ExtractSingleResult<TResult> = TResult extends BatchPayload
  ? never
  : TResult;

/**
 * Success/failure wrapper for mutations that might fail
 */
export type MutationResultWrapper<TResult> =
  | { success: true; data: TResult }
  | { success: false; error: string };

/**
 * Optimistic mutation result for real-time updates
 */
export type OptimisticMutationResult<TResult> = {
  optimistic: TResult;
  confirmed?: TResult;
  error?: string;
};
