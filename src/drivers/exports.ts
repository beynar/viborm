/**
 * Driver Base Exports
 *
 * Base driver class and types for custom driver implementations.
 * Import from "viborm/driver"
 */

// Base driver for custom implementations
export { Driver, TransactionBoundDriver } from "./driver";

// Types
export type {
  AnyDriver,
  DriverResultParser,
  QueryExecutionContext,
} from "./driver";

export type {
  Dialect,
  IsolationLevel,
  LogFunction,
  QueryResult,
  TransactionOptions,
} from "./types";

// Errors (commonly needed with drivers)
export {
  ConnectionError,
  FeatureNotSupportedError,
  ForeignKeyError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
  isRetryableError,
} from "../errors";
