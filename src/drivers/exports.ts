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
} from "./driver";
// Base driver for custom implementations
export { Driver } from "./driver";
export type {
  BatchQuery,
  Dialect,
  QueryResult,
} from "./types";
