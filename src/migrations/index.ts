/**
 * VibORM Migrations V1 public surface.
 *
 * No journal, squash, path-level storage, raw differ, or MigrationContext.
 */

export { isMigrationError, MigrationError } from "../errors";
export { applyV1 as apply } from "./apply-v1";
export type { CheckFinding, CheckResult } from "./check";
export { checkEstate } from "./check";
export type { MigrationClientOptions, Migrations } from "./client";
export { createMigrationClient } from "./client";
export { generateV1 as generate } from "./generate-v1";
export {
  baselineV1 as baseline,
  downV1 as down,
  logV1 as log,
  resetV1 as reset,
  resolveV1 as resolve,
  statusV1 as status,
  verifyV1 as verify,
} from "./operators";
export { previewPush, pushV1 as push } from "./push-v1";
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
  PushApplyResult,
  PushConsent,
  PushOptionsV1 as PushOptions,
  PushPreview,
  ResetV1Options as ResetOptions,
  ResolveV1Options as ResolveOptions,
  StateSelector,
} from "./v1-types";
