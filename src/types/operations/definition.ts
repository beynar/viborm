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
 * Operation payload type - passes Model directly to args types
 * Each args type extracts what it needs internally
 */
export type OperationPayload<O extends Operations, M extends Model<any>> =
  O extends "findMany"
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

export type OperationResult<
  O extends Operations,
  M extends Model<any>,
  I
> = any;
