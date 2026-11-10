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
// Named so an exported extended client's declaration can write them.
export type {
  DefinitionControls,
  PlacedControl,
  RowsVerbs,
  StampedFields,
} from "../extensions/controls";
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
export type {
  ClientTypeState,
  ExtendedClient,
  ProjectedContribution,
} from "./client";
export { defaultOmit } from "./default-omit-extension";
// Result types
export type { ProjectedModelOperations } from "./projected-types";
export type { RawOperation, RowsFragment } from "./raw";
export type {
  AggregateResultType,
  BatchPayload,
  ClientHiddenContext,
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
