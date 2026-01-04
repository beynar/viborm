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
  ForeignKeyError,
  isRetryableError,
  isUniqueConstraintError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
} from "./errors";
// Types
export type {
  Dialect,
  IsolationLevel,
  LogFunction,
  QueryResult,
  TransactionOptions,
} from "./types";
