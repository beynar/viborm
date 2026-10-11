/**
 * Driver Base Exports
 *
 * Base driver class and types for custom driver implementations.
 * Import from "viborm/driver"
 */

// Errors (commonly needed with drivers)
export {
  CheckConstraintError,
  ConnectionError,
  FeatureNotSupportedError,
  ForeignKeyError,
  isRetryableError,
  NotNullConstraintError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
} from "../errors";
// Types
export type {
  AnyDriver,
  DriverResultParser,
  QueryExecutionContext,
  SqliteMigrationCapability,
} from "./driver";
// Base driver for custom implementations, and the SQLite migration
// declaration a custom SQLite driver binds to migrations with.
export { Driver, SQLITE_MIGRATION_CAPABILITY } from "./driver";
// SQLite provider decoding for custom drivers.
export { sqliteResultParser } from "./shared/sqlite-utils";
export type {
  BatchQuery,
  Dialect,
  QueryResult,
} from "./types";
