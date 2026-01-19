/**
 * Migration Tracker
 *
 * Tracks applied migrations in the database using a migrations table.
 * This allows the apply command to know which migrations have been run.
 */

import { sql, type Sql } from "../../sql/sql";
import type { AppliedMigration, Dialect, MigrationEntry } from "../types";
import { DEFAULT_TABLE_NAME, validateTableName } from "../utils";

export interface TrackerOptions {
  /** Name of the migrations tracking table */
  tableName?: string;
}

export type QueryExecutor = (
  sqlStr: string,
  params?: unknown[]
) => Promise<unknown[]>;

/**
 * Helper to execute a Sql object with the appropriate placeholder style.
 */
async function execSql(
  executor: QueryExecutor,
  dialect: Dialect,
  query: Sql
): Promise<unknown[]> {
  const placeholder = dialect === "postgresql" ? "$n" : "?";
  return executor(query.toStatement(placeholder), query.values);
}

/**
 * Get the SQL for creating the migrations tracking table.
 * Note: Table name is validated before being used in raw SQL.
 */
export function getCreateTableSQL(
  dialect: Dialect,
  tableName: string = DEFAULT_TABLE_NAME
): string {
  // Validate table name to prevent SQL injection
  const validatedName = validateTableName(tableName);

  if (dialect === "postgresql") {
    return `
CREATE TABLE IF NOT EXISTS "${validatedName}" (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  checksum VARCHAR(64) NOT NULL,
  applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
`.trim();
  }

  // SQLite
  return `
CREATE TABLE IF NOT EXISTS "${validatedName}" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT DEFAULT (datetime('now'))
);
`.trim();
}

/**
 * Ensures the migrations tracking table exists.
 */
export async function ensureMigrationTable(
  executor: QueryExecutor,
  dialect: Dialect,
  tableName: string = DEFAULT_TABLE_NAME
): Promise<void> {
  const sql = getCreateTableSQL(dialect, tableName);
  await executor(sql);
}

/**
 * Get all applied migrations from the database.
 */
export async function getAppliedMigrations(
  executor: QueryExecutor,
  dialect: Dialect,
  tableName: string = DEFAULT_TABLE_NAME
): Promise<AppliedMigration[]> {
  // First ensure the table exists
  await ensureMigrationTable(executor, dialect, tableName);

  // Validate table name (already validated in ensureMigrationTable, but be safe)
  const validatedName = validateTableName(tableName);
  const query = `SELECT name, checksum, applied_at FROM "${validatedName}" ORDER BY id ASC`;
  const rows = (await executor(query)) as Array<{
    name: string;
    checksum: string;
    applied_at: string | Date;
  }>;

  return rows.map((row) => ({
    name: row.name,
    checksum: row.checksum,
    appliedAt:
      row.applied_at instanceof Date
        ? row.applied_at
        : new Date(row.applied_at),
  }));
}

/**
 * Mark a migration as applied in the database.
 */
export async function markMigrationApplied(
  executor: QueryExecutor,
  dialect: Dialect,
  entry: MigrationEntry,
  tableName: string = DEFAULT_TABLE_NAME
): Promise<void> {
  const validatedName = validateTableName(tableName);
  const query = sql`INSERT INTO ${sql.raw`"${validatedName}"`} (name, checksum) VALUES (${entry.name}, ${entry.checksum})`;
  await execSql(executor, dialect, query);
}

/**
 * Mark a migration as rolled back (remove from tracking table).
 */
export async function markMigrationRolledBack(
  executor: QueryExecutor,
  dialect: Dialect,
  name: string,
  tableName: string = DEFAULT_TABLE_NAME
): Promise<void> {
  const validatedName = validateTableName(tableName);
  const query = sql`DELETE FROM ${sql.raw`"${validatedName}"`} WHERE name = ${name}`;
  await execSql(executor, dialect, query);
}

/**
 * Check if a specific migration has been applied.
 */
export async function isMigrationApplied(
  executor: QueryExecutor,
  dialect: Dialect,
  name: string,
  tableName: string = DEFAULT_TABLE_NAME
): Promise<boolean> {
  const validatedName = validateTableName(tableName);
  const query = sql`SELECT 1 FROM ${sql.raw`"${validatedName}"`} WHERE name = ${name} LIMIT 1`;
  const rows = (await execSql(executor, dialect, query)) as unknown[];
  return rows.length > 0;
}

/**
 * Get the checksum of an applied migration.
 * Returns null if the migration hasn't been applied.
 */
export async function getAppliedChecksum(
  executor: QueryExecutor,
  dialect: Dialect,
  name: string,
  tableName: string = DEFAULT_TABLE_NAME
): Promise<string | null> {
  const validatedName = validateTableName(tableName);
  const query = sql`SELECT checksum FROM ${sql.raw`"${validatedName}"`} WHERE name = ${name} LIMIT 1`;
  const rows = (await execSql(executor, dialect, query)) as Array<{ checksum: string }>;
  const firstRow = rows[0];
  return firstRow ? firstRow.checksum : null;
}

/**
 * Verify that an applied migration's checksum matches.
 * Returns true if checksums match, false if they don't.
 * Returns null if the migration hasn't been applied.
 */
export async function verifyMigrationChecksum(
  executor: QueryExecutor,
  dialect: Dialect,
  entry: MigrationEntry,
  tableName: string = DEFAULT_TABLE_NAME
): Promise<boolean | null> {
  const appliedChecksum = await getAppliedChecksum(
    executor,
    dialect,
    entry.name,
    tableName
  );

  if (appliedChecksum === null) {
    return null;
  }

  return appliedChecksum === entry.checksum;
}
