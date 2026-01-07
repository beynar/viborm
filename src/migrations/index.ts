/**
 * VibORM Migrations
 *
 * Database schema migration utilities for VibORM.
 */

// Differ
export {
  diff,
  getDestructiveOperationDescriptions,
  hasDestructiveOperations,
} from "./differ";
// Push
export type { PushOptions } from "./push";
export {
  formatOperation,
  formatOperations,
  generateDDL,
  introspect,
  push,
} from "./push";
// Resolver
export {
  alwaysAddDropResolver,
  alwaysRenameResolver,
  applyResolutions,
  createPredefinedResolver,
  createResolver,
  formatAmbiguousChange,
  formatAmbiguousChanges,
  strictResolver,
} from "./resolver";
export type { SerializeOptions } from "./serializer";
// Serializer
export { getColumnName, getTableName, serializeModels } from "./serializer";
// Types
export type {
  AmbiguousChange,
  AmbiguousColumnChange,
  AmbiguousTableChange,
  ChangeResolution,
  ColumnDef,
  DiffOperation,
  DiffResult,
  EnumDef,
  EnumValueRemoval,
  EnumValueResolution,
  EnumValueResolver,
  ForeignKeyDef,
  IndexDef,
  PrimaryKeyDef,
  PushResult,
  ReferentialAction,
  Resolver,
  SchemaSnapshot,
  TableDef,
  UniqueConstraintDef,
} from "./types";
export { MigrationError } from "./types";
