/**
 * Client Type Exports
 *
 * Advanced client types for library authors.
 * Import from "viborm/client"
 */

export {
  type ClientExtension,
  defineExtension,
  type ObservationCompletion,
  type ObservationUnit,
  type ObserveHandler,
  type StatementContext,
  type StatementHandler,
} from "../extensions";
export type { PlacedControl } from "../extensions/controls";
export type {
  ExtensionCacheState,
  ExtensionResultConsumerState,
} from "../extensions/methods";
// Pending operation
export {
  isPendingOperation,
  PendingOperation,
  type UnwrapPendingOperation,
  type UnwrapPendingOperations,
} from "../query-engine/pending-operation";
export type { IndexDefinition, IndexOptions } from "../schema/model";
export type { ObjectSchema, VibSchema } from "../validation";
export type { ExtendedClient } from "./client";
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
export {
  getOperationPayloadSchema,
  renderOperationResultType,
  renderSchemaType,
  validateOperationPayload,
} from "./schema-introspection";
export type {
  ClientSchema,
  FlatSchema,
  Linked,
  LinkedClientConfig,
  Links,
  RelationLinks,
} from "./schema-links";
// Client types
export type {
  CacheableOperations,
  CachedClient,
  Client,
  InferDatabase,
  MutationOperations,
  OperationPayload,
  OperationPayloadSchema,
  OperationResult,
  Operations,
  Schema,
  ValidatedOperationPayload,
} from "./types";
