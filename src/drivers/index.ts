/**
 * Database Drivers
 *
 * Single Driver interface for all database adapters.
 */

// Errors
export {
  ConnectionError,
  FeatureNotSupportedError,
  ForeignKeyError,
  isRetryableError,
  isUniqueConstraintError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
  unsupportedGeospatial,
  unsupportedVector,
  VibORMError as DriverError,
} from "@errors";
// Bun SQL driver (PostgreSQL)
export type { BunSQLDriverOptions, BunSQLOptions } from "./bun-sql";
export { BunSQLDriver } from "./bun-sql";
// Bun SQLite driver
export type { BunSQLiteDriverOptions, BunSQLiteOptions } from "./bun-sqlite";
export { BunSQLiteDriver } from "./bun-sqlite";
// D1 driver (Cloudflare Workers bindings)
export type { D1DriverOptions } from "./d1";
export { D1Driver } from "./d1";
// D1 HTTP driver (Cloudflare REST API)
export type { D1HTTPDriverOptions } from "./d1-http";
export { D1HTTPDriver } from "./d1-http";
export type {
  AnyDriver,
  DriverResultParser,
  QueryExecutionContext,
} from "./driver";
// Base driver for custom implementations
export { Driver } from "./driver";
// LibSQL driver (Turso)
export type { LibSQLDriverOptions, LibSQLOptions } from "./libsql";
export { LibSQLDriver } from "./libsql";
// mysql2 driver
export type { MySQL2DriverOptions, MySQL2Options } from "./mysql2";
export { MySQL2Driver } from "./mysql2";
// Neon HTTP driver
export type { NeonHTTPDriverOptions } from "./neon-http";
export { NeonHTTPDriver } from "./neon-http";
// pg driver (node-postgres)
export type { PgDriverOptions, PgOptions } from "./pg";
export { PgDriver } from "./pg";
// PGlite driver
export type { PGliteDriverOptions, PGliteOptions } from "./pglite";
export { PGliteDriver } from "./pglite";
// PlanetScale driver
export type {
  PlanetScaleDriverOptions,
  PlanetScaleOptions,
} from "./planetscale";
export { PlanetScaleDriver } from "./planetscale";
// postgres.js driver
export type { PostgresDriverOptions, PostgresOptions } from "./postgres";
export { PostgresDriver } from "./postgres";
// SQLite3 driver
export type { SQLite3DriverOptions, SQLite3Options } from "./sqlite3";
export { SQLite3Driver } from "./sqlite3";
// Types
export type {
  Dialect,
  IsolationLevel,
  LogFunction,
  QueryResult,
  TransactionOptions,
} from "./types";
