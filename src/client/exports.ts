/**
 * Client Type Exports
 *
 * Advanced client types for library authors.
 * Import from "viborm/client"
 */

// Named so an exported extended client's declaration can write them.
export type { PlacedArgument, StampedFields } from "../extensions/contract";
export type { ExtensionResultConsumerState } from "../extensions/methods";
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
  AddedProjectedState,
  CachedClientOf,
  ClientTypeState,
  ExtendedClient,
} from "./client";
export { defaultOmit } from "./default-omit-extension";
// The fields a client may leave out, per model, and that map held exactly
// (no model or field the schema lacks, in every member of a union): what an
// extension configured by such a map types its configuration with.
export type { ClientOmitConfig, ExactClientOmitConfig } from "./omit";
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
  NoExtraOperationKeys,
  OperationPayload,
  OperationPayloadSchema,
  OperationResult,
  Operations,
  Schema,
  ValidatedOperationPayload,
} from "./types";
