/**
 * VibORM - Main Entry Point
 *
 * TypeScript ORM for PostgreSQL, MySQL, and SQLite.
 *
 * Import paths:
 * - "viborm" - Client creation and errors (this file)
 * - "viborm/schema" - Schema builder (s, PG, MYSQL, SQLITE)
 * - "viborm/pg" - PostgreSQL driver (node-postgres)
 * - "viborm/postgres" - PostgreSQL driver (postgres.js)
 * - "viborm/pglite" - PGlite driver
 * - "viborm/mysql2" - MySQL driver
 * - "viborm/sqlite3" - SQLite driver (better-sqlite3)
 * - "viborm/cache" - Cache types and utilities
 * - "viborm/cache/memory" - In-memory cache driver
 * - "viborm/cache/cloudflare-kv" - Cloudflare KV cache driver
 * - "viborm/migrations" - Migration utilities
 * - "viborm/client" - Advanced client types
 * - "viborm/validation" - Validation library
 * - "viborm/instrumentation" - OpenTelemetry integration
 */

// =============================================================================
// CLIENT
// =============================================================================

export type { VibORMClient, VibORMConfig } from "./client/client.js";
export { createClient } from "./client/client.js";

// Pending operations (for transaction batching)
export {
  isPendingOperation,
  PendingOperation,
  type UnwrapPendingOperation,
  type UnwrapPendingOperations,
} from "./client/pending-operation.js";

// =============================================================================
// ERRORS
// =============================================================================

export {
  // Base error
  VibORMError,
  VibORMErrorCode,
  isVibORMError,
  wrapError,
  // Specific errors
  ConnectionError,
  FeatureNotSupportedError,
  ForeignKeyError,
  NestedWriteError,
  NotFoundError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
  ValidationError,
  // Utilities
  isRetryableError,
} from "./errors.js";

// =============================================================================
// QUERY ENGINE TYPES (for advanced usage)
// =============================================================================

export type {
  QueryMetadata,
  RawQueryResult,
  ResultParser,
} from "./query-engine/types.js";

// =============================================================================
// SCHEMA UTILITIES
// =============================================================================

// Schema validation
export { validateSchema, validateSchemaOrThrow } from "./schema/validation/index.js";

export type {
  ValidationResult,
  ValidationError as SchemaValidationError,
  ValidationRule,
  Severity,
} from "./schema/validation/index.js";

// Schema introspection
export { getSchemas } from "./schema/schemas.js";
