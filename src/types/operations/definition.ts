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
} from "@schema/model/types";

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

export type OperationResult<
  O extends Operations,
  M extends Model<any>,
  I
> = any;
