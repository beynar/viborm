/**
 * Driver Base Exports
 *
 * Base driver class and types for custom driver implementations.
 * Import from "viborm/driver"
 */

// Errors (commonly needed with drivers)
export {
  ConnectionError,
  FeatureNotSupportedError,
  ForeignKeyError,
  isRetryableError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
} from "../errors";

// Types
export type {
  AnyDriver,
  DriverResultParser,
  QueryExecutionContext,
} from "./driver";
// Base driver for custom implementations
export { Driver, TransactionBoundDriver } from "./driver";
export type {
  Dialect,
  IsolationLevel,
  LogFunction,
  QueryResult,
  TransactionOptions,
} from "./types";
