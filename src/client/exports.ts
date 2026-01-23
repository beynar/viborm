/**
 * Client Type Exports
 *
 * Advanced client types for library authors.
 * Import from "viborm/client"
 */

// Client types
export type {
  Client,
  CachedClient,
  Schema,
  Operations,
  CacheableOperations,
  MutationOperations,
  OperationPayload,
  OperationResult,
  WaitUntilFn,
} from "./types";

// Result types
export type {
  InferSelectInclude,
  BatchPayload,
  CountResultType,
  AggregateResultType,
  GroupByResultType,
} from "./result-types";

// Pending operation
export {
  PendingOperation,
  isPendingOperation,
  type UnwrapPendingOperation,
  type UnwrapPendingOperations,
} from "./pending-operation";
