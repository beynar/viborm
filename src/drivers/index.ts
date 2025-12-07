/**
 * Database Drivers
 *
 * Single Driver interface for all database adapters.
 */

// Main interface
export { isDriver } from "./driver";
export type { Driver } from "./driver";

// Types
export type {
  Dialect,
  QueryResult,
  IsolationLevel,
  TransactionOptions,
  LogFunction,
} from "./types";

// Errors
export {
  DriverError,
  ConnectionError,
  QueryError,
  UniqueConstraintError,
  ForeignKeyError,
  TransactionError,
  isRetryableError,
  isUniqueConstraintError,
} from "./errors";
