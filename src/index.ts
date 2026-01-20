// VibORM - Main Entry Point
// TypeScript ORM for Postgres and MySQL

export type {
  CacheEntry,
  CacheInvalidationOptions,
  CacheSetOptions,
  WithCacheOptions,
} from "@cache/index.js";
// Cache
export {
  CacheDriver,
  CloudflareKVCache,
  generateCacheKey,
  generateCachePrefix,
  MemoryCache,
  parseTTL,
} from "@cache/index.js";
export type { VibORMClient, VibORMConfig } from "@client/client.js";
export { createClient } from "@client/client.js";
export {
  isPendingOperation,
  PendingOperation,
  type QueryMetadata,
  type ResultParser,
  type UnwrapPendingOperation,
  type UnwrapPendingOperations,
} from "@client/pending-operation.js";
export type {
  CacheableOperations,
  CachedClient,
  MutationOperations,
  WaitUntilFn,
} from "@client/types.js";
// Instrumentation
export type {
  InstrumentationConfig,
  LogCallback,
  LogEvent,
  LoggingConfig,
  LogLevel,
  TracingConfig,
} from "@instrumentation";
// Errors
export {
  ConnectionError,
  FeatureNotSupportedError,
  ForeignKeyError,
  isRetryableError,
  isVibORMError,
  NestedWriteError,
  NotFoundError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
  ValidationError,
  VibORMError,
  VibORMErrorCode,
  wrapError,
} from "./errors.js";

// Main exports - Schema Builder
export { s } from "./schema/index.js";
