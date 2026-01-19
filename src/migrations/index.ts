/**
 * VibORM Migrations
 *
 * Database schema migration utilities for VibORM.
 */

// Apply
export { apply, pending, rollback, status, type ApplyFullOptions,type ApplyResult } from "./apply/index";


// Apply - Down
export { down } from "./apply/down";
export type { DownOptions, DownResult } from "./apply/down";

// Context
export { MigrationContext } from "./context";
export type { MigrationContextOptions } from "./context";

// Differ
export {
  diff,
  getDestructiveOperationDescriptions,
  hasDestructiveOperations,
} from "./differ";

// Storage (base only - import fs driver from "viborm/migrations/storage/fs")
export { MigrationStorageDriver } from "./storage";

// Generate
export { generate, preview } from "./generate";

// Push
export type { PushOptions, MigrationClient } from "./push";
export {
  formatOperation,
  formatOperations,
  generateDDL,
  introspect,
  push,
} from "./push";

// Reset
export { reset } from "./reset";
export type { ResetOptions, ResetResult } from "./reset";

// Resolver
export {
  // Legacy resolvers (for ambiguous changes only)
  alwaysAddDropResolver,
  alwaysRenameResolver,
  applyResolutions,
  createPredefinedResolver,
  createResolver,
  formatAmbiguousChange,
  formatAmbiguousChanges,
  resolveAmbiguousChanges,
  strictResolver,
  // Unified resolvers (for destructive, ambiguous, and enum changes)
  addDropResolver,
  createUnifiedResolver,
  lenientResolver,
  rejectAllResolver,
} from "./resolver";

// Serializer
export type { SerializeOptions } from "./serializer";
export { getColumnName, getTableName, serializeModels } from "./serializer";

// Squash
export { squash } from "./squash";
export type { SquashOptions, SquashResult } from "./squash";

// Types
export type {
  AmbiguousChange,
  AmbiguousChangeRequest,
  AmbiguousChangeResolution,
  AmbiguousColumnChange,
  AmbiguousResolveChange,
  AmbiguousTableChange,
  ApplyOptions,
  AppliedMigration,
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

// Client
export { createMigrationClient } from "./client";
export type { MigrationClientOptions, Migrations } from "./client";

// Errors
export { MigrationError, isMigrationError } from "../errors";
