/**
 * VibORM Migrations
 *
 * Database schema migration utilities for VibORM.
 */

// Errors
export { isMigrationError, MigrationError } from "../errors";
export type { DownOptions, DownResult } from "./apply/down";
// Apply - Down
export { down } from "./apply/down";
// Apply
export {
  type ApplyFullOptions,
  type ApplyResult,
  apply,
  pending,
  rollback,
  status,
} from "./apply/index";
export type { MigrationClientOptions, Migrations } from "./client";
// Client
export { createMigrationClient } from "./client";
export type { MigrationContextOptions } from "./context";
// Context
export { MigrationContext } from "./context";
// Differ
export {
  diff,
  getDestructiveOperationDescriptions,
  hasDestructiveOperations,
} from "./differ";
// Generate
export { generate, preview } from "./generate";
// Push
export type { MigrationClient, PushOptions } from "./push";
export {
  formatOperation,
  formatOperations,
  generateDDL,
  introspect,
  push,
} from "./push";
export type { ResetOptions, ResetResult } from "./reset";
// Reset
export { reset } from "./reset";
// Resolver
export {
  // Unified resolvers (for destructive, ambiguous, and enum changes)
  addDropResolver,
  // Legacy resolvers (for ambiguous changes only)
  alwaysAddDropResolver,
  alwaysRenameResolver,
  applyResolutions,
  createPredefinedResolver,
  createResolver,
  createUnifiedResolver,
  formatAmbiguousChange,
  formatAmbiguousChanges,
  lenientResolver,
  rejectAllResolver,
  resolveAmbiguousChanges,
  strictResolver,
} from "./resolver";
// Serializer
export type { SerializeOptions } from "./serializer";
export { getColumnName, getTableName, serializeModels } from "./serializer";
export type { SquashOptions, SquashResult } from "./squash";
// Squash
export { squash } from "./squash";
// Storage (base only - import fs driver from "viborm/migrations/storage/fs")
export { MigrationStorageDriver } from "./storage";
// Types
export type {
  AmbiguousChange,
  AmbiguousChangeRequest,
  AmbiguousChangeResolution,
  AmbiguousColumnChange,
  AmbiguousResolveChange,
  AmbiguousTableChange,
  AppliedMigration,
  ApplyOptions,
  ChangeResolution,
  ColumnDef,
  DestructiveResolveChange,
  Dialect,
  DiffOperation,
  DiffResult,
  EnumDef,
  EnumValueRemoval,
  EnumValueRemovalChange,
  EnumValueRemovalRequest,
  EnumValueRemovalResolution,
  EnumValueResolution,
  EnumValueResolver,
  ForeignKeyDef,
  GenerateOptions,
  GenerateResult,
  IndexDef,
  MigrationEntry,
  MigrationStatus,
  PrimaryKeyDef,
  PushResult,
  ReferentialAction,
  ResolutionRequest,
  ResolutionRequestType,
  ResolutionResult,
  ResolveCallback,
  ResolveChange,
  ResolveResult,
  Resolver,
  SchemaSnapshot,
  TableDef,
  UnifiedResolver,
  UniqueConstraintDef,
} from "./types";
// Type helpers
export {
  createAmbiguousChange,
  createAmbiguousChangeRequest,
  createDestructiveChange,
  createEnumValueRemovalChange,
  createEnumValueRemovalRequest,
} from "./types";
// Utils
export {
  DEFAULT_MIGRATIONS_DIR,
  DEFAULT_TABLE_NAME,
  formatMigrationFilename,
  generateMigrationName,
  normalizeDialect,
  sortOperations,
} from "./utils";
