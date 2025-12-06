import { Model, ExtractFields } from "@schema/model";
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
 * Operation payload type - passes Model directly to args types
 * Each args type extracts what it needs internally
 */
export type OperationPayload<
  O extends Operations,
  M extends Model<any>
> = O extends "findMany"
  ? ModelFindManyArgs<M>
  : O extends "findUnique"
  ? ModelFindUniqueArgs<M>
  : O extends "findFirst"
  ? ModelFindFirstArgs<M>
  : O extends "create"
  ? ModelCreateArgs<M>
  : O extends "update"
  ? ModelUpdateArgs<M>
  : O extends "delete"
  ? ModelDeleteArgs<M>
  : O extends "deleteMany"
  ? ModelDeleteManyArgs<M>
  : O extends "upsert"
  ? ModelUpsertArgs<M>
  : O extends "findUniqueOrThrow"
  ? ModelFindUniqueArgs<M>
  : O extends "findFirstOrThrow"
  ? ModelFindFirstArgs<M>
  : O extends "count"
  ? ModelCountArgs<M>
  : O extends "aggregate"
  ? ModelAggregateArgs<M>
  : O extends "groupBy"
  ? ModelGroupByArgs<M>
  : O extends "createMany"
  ? CreateManyEnvelope<ExtractFields<M>>
  : O extends "updateMany"
  ? ModelUpdateManyArgs<M>
  : O extends "exist"
  ? ModelExistArgs<M>
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
  ? InferResult<ExtractFields<M>, Args> | null
  : O extends "findFirstOrThrow" | "findUniqueOrThrow"
  ? InferResult<ExtractFields<M>, Args>
  : O extends "findMany"
  ? InferResult<ExtractFields<M>, Args>[]
  : O extends "create" | "update" | "delete" | "upsert"
  ? InferResult<ExtractFields<M>, Args>
  : O extends "createMany" | "updateMany" | "deleteMany"
  ? BatchPayload
  : O extends "count"
  ? CountResultType<Args>
  : O extends "exist"
  ? boolean
  : O extends "aggregate"
  ? AggregateResultType<ExtractFields<M>, Args>
  : O extends "groupBy"
  ? GroupByResultType<ExtractFields<M>, Args>[]
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
