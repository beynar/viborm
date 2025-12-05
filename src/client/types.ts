import { Model } from "@schema/model";
import type {
  ModelFindManyArgs,
  ModelFindFirstArgs,
  ModelFindUniqueArgs,
  ModelCreateArgs,
  ModelUpdateArgs,
  ModelDeleteArgs,
  ModelDeleteManyArgs,
  ModelUpsertArgs,
  ModelCountArgs,
  ModelAggregateArgs,
  ModelGroupByArgs,
  CreateManyEnvelope,
  ModelUpdateManyArgs,
  ModelExistArgs,
  InferResult,
  BatchPayload,
  CountResultType,
  AggregateResultType,
  GroupByResultType,
  FieldRecord,
} from "@schema/model/types";

export type Schema = Record<string, Model<any>>;

export type Operations =
  | "findFirst"
  | "findMany"
  | "findUnique"
  | "create"
  | "createMany"
  | "update"
  | "updateMany"
  | "delete"
  | "deleteMany"
  | "findUniqueOrThrow"
  | "findFirstOrThrow"
  | "count"
  | "aggregate"
  | "groupBy"
  | "upsert"
  | "exist";

/**
 * Extracts the fields type from a Model
 */
type ModelFields<M extends Model<any>> = M extends Model<infer F> ? F : never;

/**
 * Operation payload type - uses manual types instead of ArkType inference
 * This dramatically improves IDE performance
 */
export type OperationPayload<
  O extends Operations,
  M extends Model<any>
> = O extends "findMany"
  ? ModelFindManyArgs<ModelFields<M>>
  : O extends "findUnique"
  ? ModelFindUniqueArgs<ModelFields<M>>
  : O extends "findFirst"
  ? ModelFindFirstArgs<ModelFields<M>>
  : O extends "create"
  ? ModelCreateArgs<ModelFields<M>>
  : O extends "update"
  ? ModelUpdateArgs<ModelFields<M>>
  : O extends "delete"
  ? ModelDeleteArgs<ModelFields<M>>
  : O extends "deleteMany"
  ? ModelDeleteManyArgs<ModelFields<M>>
  : O extends "upsert"
  ? ModelUpsertArgs<ModelFields<M>>
  : O extends "findUniqueOrThrow"
  ? ModelFindUniqueArgs<ModelFields<M>>
  : O extends "findFirstOrThrow"
  ? ModelFindFirstArgs<ModelFields<M>>
  : O extends "count"
  ? ModelCountArgs<ModelFields<M>>
  : O extends "aggregate"
  ? ModelAggregateArgs<ModelFields<M>>
  : O extends "groupBy"
  ? ModelGroupByArgs<ModelFields<M>>
  : O extends "createMany"
  ? CreateManyEnvelope<ModelFields<M>>
  : O extends "updateMany"
  ? ModelUpdateManyArgs<ModelFields<M>>
  : O extends "exist"
  ? ModelExistArgs<ModelFields<M>>
  : never;

/**
 * Operation result type - infers result shape based on select/include args
 * This provides full type safety for ORM operation results
 */
export type OperationResult<
  O extends Operations,
  M extends Model<any>,
  Args
> = O extends "findFirst" | "findUnique"
  ? InferResult<ModelFields<M>, Args> | null
  : O extends "findFirstOrThrow" | "findUniqueOrThrow"
  ? InferResult<ModelFields<M>, Args>
  : O extends "findMany"
  ? InferResult<ModelFields<M>, Args>[]
  : O extends "create" | "update" | "delete" | "upsert"
  ? InferResult<ModelFields<M>, Args>
  : O extends "createMany" | "updateMany" | "deleteMany"
  ? BatchPayload
  : O extends "count"
  ? CountResultType<Args>
  : O extends "exist"
  ? boolean
  : O extends "aggregate"
  ? AggregateResultType<ModelFields<M>, Args>
  : O extends "groupBy"
  ? GroupByResultType<ModelFields<M>, Args>[]
  : never;

/**
 * Client type - provides fully typed access to all model operations
 * Each operation returns a Promise with the properly inferred result type
 */
export type Client<S extends Schema> = {
  [K in keyof S]: {
    [O in Operations]: <P extends OperationPayload<O, S[K]>>(
      args: P
    ) => Promise<OperationResult<O, S[K], P>>;
  };
};
