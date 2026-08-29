/**
 * VibORM Migrations V1 public surface.
 *
 * No journal, squash, path-level storage, raw differ, or MigrationContext.
 */

export { isMigrationError, MigrationError } from "../errors";
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
  ResetResult,
  ResolveResult,
  StatusResult,
  VerifyResult,
  WritableMigrations,
} from "./client";
export { createMigrationClient } from "./client";
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
  lenientResolver,
  rejectAllResolver,
} from "./resolver";
export { createStorageConformanceSuite } from "./storage/conformance";
export type {
  MigrationStorageReader,
  MigrationStorageWriter,
  PublishResult,
} from "./storage/contract";
export { createFsStorageWriter } from "./storage/fs-estate";
export { MemoryEstateStorage } from "./storage/memory";
export type { ObjectStoreConditionalPut } from "./storage/object-store";
export {
  MemoryConditionalObjectStore,
  ObjectStoreEstateStorage,
  refuseWorkersKvWritable,
} from "./storage/object-store";
export type { MigrationTarget, SchemaSnapshot } from "./types";
export type {
  ApplyV1Options as ApplyOptions,
  BaselineOptions,
  DownV1Options as DownOptions,
  ExactPushOptions,
  GenerateV1Options as GenerateOptions,
  ManualMigrationInput,
  ManualTransitionInput,
  MigrationEstateDescriptorV1,
  MigrationStateManifestV1,
  PushConsent,
  PushOptionsV1 as PushOptions,
  ResetV1Options as ResetOptions,
  ResolveV1Options as ResolveOptions,
  StateSelector,
} from "./v1-types";
