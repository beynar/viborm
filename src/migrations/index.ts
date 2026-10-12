/**
 * VibORM Migrations V1 public surface.
 *
 * No journal, squash, path-level storage, raw differ, or MigrationContext.
 */

export {
  sqliteCanonicalDateTimeExpression,
  sqliteCanonicalTimeExpression,
} from "../adapters/databases/sqlite/storage/datetime";
export { isMigrationError, MigrationError } from "../errors";
export type { InvalidIndex } from "./catalog-probes";
export type { CheckFinding, CheckResult } from "./check";
export type {
  ApplyResult,
  BaselineResult,
  DownResult,
  GenerateResult,
  LiveMigrations,
  LogResult,
  MigrationClientOptions,
  ReadableMigrations,
  ReanchorResult,
  ResetResult,
  ResolveResult,
  StatusResult,
  VerifyResult,
  WritableMigrations,
} from "./client";
export { createMigrationClient } from "./client";
export type { IdentifierConversionRequest } from "./identifier-conversion";
export { identifierConversionChecks } from "./identifier-conversion";
export type { MigrationLimits } from "./limits";
export type { PruneOptions, PruneResult } from "./operators";
export type {
  GraphResult,
  ListResult,
  MigrationEdgeMetadata,
  MigrationRollbackMetadata,
  MigrationStateDetails,
  MigrationStateListItem,
  MigrationStateMetadata,
  ShowResult,
} from "./public-view";
export type { PushApplyResult, PushPreview } from "./push-v1";
export {
  addDropResolver,
  createPredefinedResolver,
  lenientResolver,
  rejectAllResolver,
} from "./resolver";
export { auditStorage, type StorageColumnAudit } from "./sqlite-storage-audit";
export { createStorageConformanceSuite } from "./storage/conformance";
export type {
  MigrationStorageReader,
  MigrationStorageWriter,
  PublishResult,
} from "./storage/contract";
export { MemoryEstateStorage } from "./storage/memory";
export type { ObjectStoreConditionalPut } from "./storage/object-store";
export {
  MemoryConditionalObjectStore,
  ObjectStoreEstateStorage,
  refuseWorkersKvWritable,
} from "./storage/object-store";
export type {
  MigrationTarget,
  ResolveCallback,
  ResolveChange,
  SchemaSnapshot,
} from "./types";
export type {
  ApplyV1Options as ApplyOptions,
  BaselineOptions,
  DownPreviewEdgeV1 as DownPreviewEdge,
  DownV1Options as DownOptions,
  ExactPushOptions,
  GenerateV1Options as GenerateOptions,
  ManualMigrationInput,
  ManualTransitionInput,
  MigrationApprovalV1 as MigrationApproval,
  MigrationCheckInput,
  MigrationDecisionV1 as MigrationDecision,
  MigrationEstateDescriptorV1,
  MigrationStateManifestV1,
  PushConsent,
  PushOptionsV1 as PushOptions,
  ReanchorOptions,
  ResetV1Options as ResetOptions,
  ResolveV1Options as ResolveOptions,
  StateSelector,
} from "./v1-types";
