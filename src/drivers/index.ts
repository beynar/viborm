/**
 * Database Drivers
 *
 * Single Driver interface for all database adapters.
 */

// Base driver for custom implementations
export { LazyDriver } from "./base-driver";
export type { Driver, DriverResultParser } from "./driver";
// Main interface
export { isDriver } from "./driver";
// Errors
export {
  ConnectionError,
  VibORMError as DriverError,
  FeatureNotSupportedError,
  ForeignKeyError,
  isRetryableError,
  isUniqueConstraintError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
  unsupportedGeospatial,
  unsupportedVector,
} from "../errors";
// pg driver (node-postgres)
export type { PgDriverOptions, PgOptions } from "./pg";
export { PgDriver } from "./pg";
// PGlite driver
export type { PGliteDriverOptions, PGliteOptions } from "./pglite";
export { PGliteDriver } from "./pglite";
// postgres.js driver
export type { PostgresDriverOptions, PostgresOptions } from "./postgres";
export { PostgresDriver } from "./postgres";
// SQLite3 driver
export type { SQLite3DriverOptions, SQLite3Options } from "./sqlite3";
export { SQLite3Driver } from "./sqlite3";
// Types
export type {
  Dialect,
  IsolationLevel,
  LogFunction,
  QueryResult,
  TransactionOptions,
} from "./types";
