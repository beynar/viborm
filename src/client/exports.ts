/**
 * Client Type Exports
 *
 * Advanced client types for library authors.
 * Import from "viborm/client"
 */

export {
  type ClientExtension,
  defineExtension,
} from "../extensions";
// Pending operation
export {
  isPendingOperation,
  PendingOperation,
  type UnwrapPendingOperation,
  type UnwrapPendingOperations,
} from "../query-engine/pending-operation";
export { defaultOmit } from "./default-omit-extension";
export type { RawOperation } from "./raw";

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
} from "./types";
