/**
 * Client Types
 *
 * Provides the typed Client interface for ORM operations.
 * All input types are inferred from schema validation.
 * All result types are inferred from result-types.ts.
 */

import type { PendingOperation } from "@query-engine/pending-operation";
import type { Model, ModelState } from "@schema/model";
import type { ModelShape } from "@schema/model/helper";
import type { Prettify } from "@validation";
import type { ModelCoreInput, ModelOperationInput } from "@validation/model";
import type { CacheDriver } from "../cache/driver";
import type { VibORMConfig } from "./client";
import type {
  AggregateResultType,
  BatchPayload,
  CountResultType,
  GroupByResultType,
  InferSelectInclude,
} from "./result-types";

export type { WaitUntilFn } from "../cache/cache-contract";

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
 * Extract shape from a Model - works with Model<any>
 */
type ExtractFields<M> =
  M extends Model<infer S>
    ? S extends { shape: infer F }
      ? F extends ModelShape
        ? F
        : ModelShape
      : ModelShape
    : ModelShape;

/**
 * Operation payload type - passes Model directly to args types
 * Each args type extracts what it needs internally from schema inference
 */
export type OperationPayload<
  O extends Operations,
  M extends Model<any>,
> = O extends "findMany"
  ? ModelOperationInput<M, "findMany">
  : O extends "findUnique"
    ? ModelOperationInput<M, "findUnique">
    : O extends "findFirst"
      ? ModelOperationInput<M, "findFirst">
      : O extends "create"
        ? ModelOperationInput<M, "create">
        : O extends "update"
          ? ModelOperationInput<M, "update">
          : O extends "delete"
            ? ModelOperationInput<M, "delete">
            : O extends "deleteMany"
              ? ModelOperationInput<M, "deleteMany">
              : O extends "upsert"
                ? ModelOperationInput<M, "upsert">
                : O extends "findUniqueOrThrow"
                  ? ModelOperationInput<M, "findUnique">
                  : O extends "findFirstOrThrow"
                    ? ModelOperationInput<M, "findFirst">
                    : O extends "count"
                      ? ModelOperationInput<M, "count">
                      : O extends "aggregate"
                        ? ModelOperationInput<M, "aggregate">
                        : O extends "groupBy"
                          ? ModelOperationInput<M, "groupBy">
                          : O extends "createMany"
                            ? ModelOperationInput<M, "createMany">
                            : O extends "updateMany"
                              ? ModelOperationInput<M, "updateMany">
                              : O extends "exist"
                                ? // Optional like the runtime (count
                                  // schema): exist() with no filter
                                  // reports whether any row exists.
                                    | {
                                        where?: ModelCoreInput<M, "where">;
                                      }
                                    | undefined
                                : never;

/**
 * IMPLICIT RETURNING (maintainer decision D-1: `createManyAndReturn` /
 * `updateManyAndReturn` are removed, not aliased). A bulk write returns
 * `{ count }` — UNLESS the call carries a `select`, in which case it returns the
 * affected rows projected by that select. The discriminant is the *presence* of
 * the key on the inferred argument type, so the conditional stays zero-codegen:
 * `Args` is inferred from the call-site literal, and a call without `select`
 * simply has no such member.
 *
 * `select: undefined` (an explicitly-absent select) deliberately lands on
 * `BatchPayload`, matching the runtime's `args.select !== undefined` routing.
 */
type BulkWriteResult<S extends ModelState, Args> = Args extends {
  select: Record<string, unknown>;
}
  ? Prettify<InferSelectInclude<S, Args>>[]
  : BatchPayload;

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
          : O extends "createMany" | "updateMany"
            ? BulkWriteResult<S, Args>
            : O extends "deleteMany"
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

type NoExtraOperationKeys<Arg, Payload> = Arg &
  Record<Exclude<keyof Arg, keyof Payload>, never>;

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
      args?: NoExtraOperationKeys<
        Exclude<Arg, undefined>,
        Exclude<RemoveCacheKey<C, Payload>, undefined>
      >
    ) => PendingOperation<OperationResult<O, M, Arg>>
  : <Arg extends RemoveCacheKey<C, Payload>>(
      args: NoExtraOperationKeys<Arg, RemoveCacheKey<C, Payload>>
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
      args?: NoExtraOperationKeys<
        Exclude<Arg, undefined>,
        Exclude<Payload, undefined>
      >
    ) => Promise<OperationResult<O, M, Arg>>
  : <Arg extends Payload>(
      args: NoExtraOperationKeys<Arg, Payload>
    ) => Promise<OperationResult<O, M, Arg>>;

/**
 * Cached client type - provides typed access to only cacheable (read) operations
 * Returns Promises directly (not PendingOperation) - cache operations are not batchable
 */
export type CachedClient<S extends Schema> = {
  [K in keyof S]: {
    [O in CacheableOperations]: CachedOperation<O, S[K]>;
  };
};
