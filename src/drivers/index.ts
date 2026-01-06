/**
 * Database Drivers
 *
 * Single Driver interface for all database adapters.
 */

export type { Driver } from "./driver";
// Main interface
export { isDriver } from "./driver";
// Errors
export {
  ConnectionError,
  DriverError,
  FeatureNotSupportedError,
  ForeignKeyError,
  isRetryableError,
  isUniqueConstraintError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
  unsupportedGeospatial,
  unsupportedVector,
} from "./errors";
export type { PGliteDriverOptions } from "./pglite";
// PGlite driver
export { PGliteDriver } from "./pglite";
// Types
export type {
  Dialect,
  IsolationLevel,
  LogFunction,
  QueryResult,
  TransactionOptions,
} from "./types";
