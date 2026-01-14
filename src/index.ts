// VibORM - Main Entry Point
// TypeScript ORM for Postgres and MySQL

export type { VibORMClient, VibORMConfig } from "./client/client.js";
export { createClient } from "./client/client.js";

// Errors
export {
  VibORMError,
  VibORMErrorCode,
  NotFoundError,
  ConnectionError,
  QueryError,
  ValidationError,
  UniqueConstraintError,
  ForeignKeyError,
  TransactionError,
  NestedWriteError,
  FeatureNotSupportedError,
  isVibORMError,
  isRetryableError,
  wrapError,
} from "./errors.js";

// Instrumentation
export type {
  InstrumentationConfig,
  TracingConfig,
  LoggingConfig,
  LogLevel,
  LogEvent,
  LogCallback,
} from "./instrumentation/index.js";

// Main exports - Schema Builder
export { s } from "./schema/index.js";
