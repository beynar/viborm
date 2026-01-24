/**
 * Client Types
 *
 * Provides the typed Client interface for ORM operations.
 * All input types are inferred from schema validation.
 * All result types are inferred from result-types.ts.
 */

import type { Model } from "@schema/model";
import type { FieldRecord } from "@schema/model/helper";
import type { Prettify } from "@validation";
import type { CacheDriver } from "../cache/driver";
import type { VibORMConfig } from "./client";
import type { PendingOperation } from "./pending-operation";
import type {
  AggregateResultType,
  BatchPayload,
  CountResultType,
  GroupByResultType,
  InferSelectInclude,
} from "./result-types";

/**
 * Callback to extend the lifetime of the request until the promise resolves.
 * Used in serverless environments (Cloudflare Workers, Vercel Edge) to keep
 * the runtime alive for background operations like SWR revalidation.
 */
export type WaitUntilFn = (promise: Promise<unknown>) => void;

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
 * Operations that can be cached (read-only operations)
 */
export type CacheableOperations =
  | "findFirst"
  | "findMany"
  | "findUnique"
  | "findUniqueOrThrow"
  | "findFirstOrThrow"
  | "count"
  | "aggregate"
  | "groupBy"
  | "exist";

/**
 * Operations that mutate data (not cacheable)
 */
export type MutationOperations =
  | "create"
  | "createMany"
  | "update"
  | "updateMany"
  | "delete"
  | "deleteMany"
  | "upsert";

/**
 * Extract fields from a Model - works with Model<any>
 */
type ExtractFields<M> =
  M extends Model<infer S>
    ? S extends { fields: infer F }
      ? F extends FieldRecord
        ? F
        : FieldRecord
      : FieldRecord
    : FieldRecord;

/**
 * Operation payload type - passes Model directly to args types
 * Each args type extracts what it needs internally from schema inference
 */
export type OperationPayload<
  O extends Operations,
  M extends Model<any>,
> = O extends "findMany"
  ? M["~"]["schemas"]["args"]["findMany"][" vibInferred"]["0"]
  : O extends "findUnique"
    ? M["~"]["schemas"]["args"]["findUnique"][" vibInferred"]["0"]
    : O extends "findFirst"
      ? M["~"]["schemas"]["args"]["findFirst"][" vibInferred"]["0"]
      : O extends "create"
        ? M["~"]["schemas"]["args"]["create"][" vibInferred"]["0"]
        : O extends "update"
          ? M["~"]["schemas"]["args"]["update"][" vibInferred"]["0"]
          : O extends "delete"
            ? M["~"]["schemas"]["args"]["delete"][" vibInferred"]["0"]
            : O extends "deleteMany"
              ? M["~"]["schemas"]["args"]["deleteMany"][" vibInferred"]["0"]
              : O extends "upsert"
                ? M["~"]["schemas"]["args"]["upsert"][" vibInferred"]["0"]
                : O extends "findUniqueOrThrow"
                  ? M["~"]["schemas"]["args"]["findUnique"][" vibInferred"]["0"]
                  : O extends "findFirstOrThrow"
                    ? M["~"]["schemas"]["args"]["findFirst"][" vibInferred"]["0"]
                    : O extends "count"
                      ? M["~"]["schemas"]["args"]["count"][" vibInferred"]["0"]
                      : O extends "aggregate"
                        ? M["~"]["schemas"]["args"]["aggregate"][" vibInferred"]["0"]
                        : O extends "groupBy"
                          ? M["~"]["schemas"]["args"]["groupBy"][" vibInferred"]["0"]
                          : O extends "createMany"
                            ? M["~"]["schemas"]["args"]["createMany"][" vibInferred"]["0"]
                            : O extends "updateMany"
                              ? M["~"]["schemas"]["args"]["updateMany"][" vibInferred"]["0"]
                              : O extends "exist"
                                ? {
                                    where: M["~"]["schemas"]["where"][" vibInferred"]["0"];
                                  }
                                : never;

/**
 * Operation result type - infers result shape based on select/include args
 * This provides full type safety for ORM operation results
 */
export type OperationResult<
  O extends Operations,
  M extends Model<any>,
  Args,
> = M extends Model<infer S>
  ? O extends "findFirst" | "findUnique"
    ? Prettify<InferSelectInclude<S, Args>> | null
    : O extends "findFirstOrThrow" | "findUniqueOrThrow"
      ? Prettify<InferSelectInclude<S, Args>>
      : O extends "findMany"
        ? Prettify<InferSelectInclude<S, Args>>[]
        : O extends "create" | "update" | "delete" | "upsert"
          ? Prettify<InferSelectInclude<S, Args>>
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
                    : never
  : never;

/**
 * Client type - provides fully typed access to all model operations
 * Each operation returns a Promise with the properly inferred result type
 */
export type Client<C extends VibORMConfig> = {
  [K in keyof C["schema"]]: {
    [O in Operations]: Operation<O, C["schema"][K], C>;
  };
};

type RemoveCacheKey<C extends VibORMConfig, T> = C["cache"] extends CacheDriver
  ? T
  : T extends { cache?: infer _ }
    ? Omit<T, "cache"> & {}
    : T;

/**
 * Operation type - returns PendingOperation which implements PromiseLike
 * This allows operations to be:
 * - Awaited directly: `await client.user.findMany()`
 * - Batched in transactions: `await client.$transaction([op1, op2])`
 */
type Operation<
  O extends Operations,
  M extends Model<any>,
  C extends VibORMConfig,
  Payload = OperationPayload<O, M>,
> = undefined extends Payload
  ? <Arg extends RemoveCacheKey<C, Payload>>(
      args?: Exclude<Arg, undefined>
    ) => PendingOperation<OperationResult<O, M, Arg>>
  : <Arg extends RemoveCacheKey<C, Payload>>(
      args: Arg
    ) => PendingOperation<OperationResult<O, M, Arg>>;

/**
 * Cached operation type - returns Promise directly (not batchable)
 */
type CachedOperation<
  O extends Operations,
  M extends Model<any>,
  Payload = OperationPayload<O, M>,
> = undefined extends Payload
  ? <Arg extends Payload>(
      args?: Exclude<Arg, undefined>
    ) => Promise<OperationResult<O, M, Arg>>
  : <Arg extends Payload>(args: Arg) => Promise<OperationResult<O, M, Arg>>;

/**
 * Cached client type - provides typed access to only cacheable (read) operations
 * Returns Promises directly (not PendingOperation) - cache operations are not batchable
 */
export type CachedClient<S extends Schema> = {
  [K in keyof S]: {
    [O in CacheableOperations]: CachedOperation<O, S[K]>;
  };
};
