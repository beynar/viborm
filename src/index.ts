/**
 * VibORM - Main Entry Point
 *
 * TypeScript ORM for PostgreSQL, MySQL, and SQLite.
 *
 * Import paths:
 * - "viborm" - Client creation, schema builder `s`, and errors (this file)
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
} from "./query-engine/pending-operation.js";
// Field references (`client.$fields.<model>.<field>`) — column-to-column filters
export {
  type AnyFieldRef,
  type FieldRef,
  isFieldRef,
  type ModelFieldRefs,
  type SchemaFieldRefs,
} from "./schema/field-ref.js";
// Schema builder — every doc example teaches `import { s } from "viborm"`
export { s } from "./schema/index.js";
// JSON null sentinels (Prisma `DbNull` / `JsonNull` / `AnyNull` parity) — the
// two nulls of a nullable JSON column, told apart by name
export {
  type AnyJsonNullSentinel,
  AnyNull,
  DbNull,
  isJsonNullSentinel,
  JsonNull,
  type JsonNullKind,
  JsonNullSentinel,
} from "./schema/json-null.js";
// The JSON write-position value type (no bare top-level `null` — use a sentinel)
export type { InputJsonValue, JsonValue } from "./validation/index.js";

// =============================================================================
// RAW SQL
// =============================================================================

// Tagged-template SQL and the composition helpers `$queryRaw`/`$executeRaw`
// interpolations are built from. Also available as `viborm/sql`.
export {
  empty,
  isSql,
  join,
  type RawValue,
  raw,
  Sql,
  sql,
  type Value,
} from "./sql/sql.js";

// =============================================================================
// ERRORS
// =============================================================================

export {
  // Specific errors
  CheckConstraintError,
  ConnectionError,
  type DiagnosticDisclosure,
  FeatureNotSupportedError,
  ForeignKeyError,
  // Utilities
  isRetryableError,
  isVibORMError,
  NestedWriteError,
  NotFoundError,
  NotNullConstraintError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
  UnsupportedOperationError,
  ValidationError,
  // Base error
  VibORMError,
  VibORMErrorCode,
  wrapError,
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

// Schema introspection
export { getSchemas } from "./schema/schemas.js";

export type {
  Severity,
  ValidationError as SchemaValidationError,
  ValidationResult,
  ValidationRule,
} from "./schema/validation/index.js";
// Schema validation
export {
  validateSchema,
  validateSchemaOrThrow,
} from "./schema/validation/index.js";
