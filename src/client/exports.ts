/**
 * Client Type Exports
 *
 * Advanced client types for library authors.
 * Import from "viborm/client"
 */

// Pending operation
export {
  isPendingOperation,
  PendingOperation,
  type UnwrapPendingOperation,
  type UnwrapPendingOperations,
} from "./pending-operation";

// Result types
export type {
  AggregateResultType,
  BatchPayload,
  CountResultType,
  GroupByResultType,
  InferSelectInclude,
} from "./result-types";
// Client types
export type {
  CacheableOperations,
  CachedClient,
  Client,
  MutationOperations,
  OperationPayload,
  OperationResult,
  Operations,
  Schema,
  WaitUntilFn,
} from "./types";
