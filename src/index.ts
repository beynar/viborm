// VibORM - Main Entry Point
// TypeScript ORM for Postgres and MySQL

export type { VibORMClient, VibORMConfig } from "@client/client.js";
export { createClient } from "@client/client.js";
export type { CachedClient, CacheableOperations, MutationOperations } from "@client/types.js";
// Cache
export {
  CacheDriver,
  CloudflareKVCache,
  MemoryCache,
  generateCacheKey,
  generateCachePrefix,
  parseTTL,
} from "@cache/index.js";
export type {
  CacheEntry,
  CacheSetOptions,
  WithCacheOptions,
  CacheInvalidationOptions,
} from "@cache/index.js";
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
