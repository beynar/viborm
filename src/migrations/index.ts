/**
 * VibORM Migrations
 *
 * Database schema migration utilities for VibORM.
 */

// Types
export type {
  SchemaSnapshot,
  TableDef,
  ColumnDef,
  IndexDef,
  ForeignKeyDef,
  UniqueConstraintDef,
  PrimaryKeyDef,
  EnumDef,
  ReferentialAction,
  DiffOperation,
  AmbiguousChange,
  AmbiguousColumnChange,
  AmbiguousTableChange,
  ChangeResolution,
  DiffResult,
  Resolver,
  PushResult,
} from "./types";

export { MigrationError } from "./types";

// Serializer
export { serializeModels, mapFieldType, getColumnName, getTableName } from "./serializer";

// Differ
export {
  diff,
  hasDestructiveOperations,
  getDestructiveOperationDescriptions,
} from "./differ";

// Resolver
export {
  applyResolutions,
  alwaysRenameResolver,
  alwaysAddDropResolver,
  strictResolver,
  createResolver,
  createPredefinedResolver,
  formatAmbiguousChange,
  formatAmbiguousChanges,
} from "./resolver";

// Push
export type { PushOptions } from "./push";
export {
  push,
  introspect,
  generateDDL,
  formatOperation,
  formatOperations,
} from "./push";
