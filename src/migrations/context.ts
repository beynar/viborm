/**
 * Migration Context
 *
 * Encapsulates all migration configuration and provides shared operations
 * like locking, tracking, and query execution.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import type { AnyDriver } from "../drivers/driver";
import { getMigrationDriver, type MigrationDriver } from "./drivers";
import type { MigrationClient } from "./push";
import { MigrationStorageDriver } from "./storage";
import type { AppliedMigration, Dialect, MigrationEntry } from "./types";
import {
  createQueryExecutor,
  DEFAULT_MIGRATIONS_DIR,
  DEFAULT_TABLE_NAME,
  normalizeDialect,
  validateMigrationsDir,
  validateTableName,
  type QueryExecutor,
} from "./utils";

// =============================================================================
// TYPES
// =============================================================================

export interface MigrationContextOptions {
  /** Migrations directory (default: ./migrations) */
  dir?: string;
  /** Migration tracking table name (default: _viborm_migrations) */
  tableName?: string;
  /** Storage driver for migration files (required) */
  storageDriver: MigrationStorageDriver;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Lock ID for PostgreSQL advisory locks.
 * Hash of "viborm_migrations" to avoid collisions.
 */
const MIGRATION_LOCK_ID = 0x7669626f726d; // "viborm" in hex, truncated

// =============================================================================
// MIGRATION CONTEXT
// =============================================================================

/**
 * Migration context that encapsulates configuration and provides
 * shared operations for migration commands.
 */
export class MigrationContext {
  readonly driver: AnyDriver;
  readonly dialect: Dialect;
  readonly migrationsDir: string;
  readonly tableName: string;
  readonly executor: QueryExecutor;
  readonly migrationDriver: MigrationDriver;
  readonly storage: MigrationStorageDriver;

  private _hasLock = false;

  constructor(client: MigrationClient, options: MigrationContextOptions) {
    const {
      dir = DEFAULT_MIGRATIONS_DIR,
      tableName = DEFAULT_TABLE_NAME,
      storageDriver,
    } = options;

    this.driver = client.$driver;
    this.dialect = normalizeDialect(this.driver.dialect);
    this.migrationsDir = validateMigrationsDir(dir);
    this.tableName = validateTableName(tableName);
    this.executor = createQueryExecutor(this.driver);
    this.migrationDriver = getMigrationDriver(this.driver.driverName, this.dialect);
    this.storage = storageDriver;
  }

  // ===========================================================================
  // MIGRATION TRACKING TABLE
  // ===========================================================================

  /**
   * Ensures the migrations tracking table exists.
   */
  async ensureTrackingTable(): Promise<void> {
    const ddl = this.migrationDriver.generateCreateTrackingTable(this.tableName);
    await this.driver._executeRaw(ddl);
  }

  // ===========================================================================
  // APPLIED MIGRATIONS
  // ===========================================================================

  /**
   * Get all applied migrations from the database.
   */
  async getAppliedMigrations(): Promise<AppliedMigration[]> {
    await this.ensureTrackingTable();

    const sqlStr = this.migrationDriver.generateSelectAppliedMigrations(this.tableName);

    const rows = (await this.executor(sqlStr)) as Array<{
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
  async markMigrationApplied(entry: MigrationEntry): Promise<void> {
    const { sql } = this.migrationDriver.generateInsertMigration(this.tableName);
    await this.executor(sql, [entry.name, entry.checksum]);
  }

  /**
   * Mark a migration as rolled back (remove from tracking table).
   */
  async markMigrationRolledBack(name: string): Promise<void> {
    const { sql } = this.migrationDriver.generateDeleteMigration(this.tableName);
    await this.executor(sql, [name]);
  }

  /**
   * Delete a migration from the tracking table by name.
   * Alias for markMigrationRolledBack, used by squash.
   */
  async deleteMigration(name: string): Promise<void> {
    await this.markMigrationRolledBack(name);
  }

  // ===========================================================================
  // LOCKING (Concurrent Protection)
  // ===========================================================================

  /**
   * Acquires a migration lock to prevent concurrent migrations.
   * Uses PostgreSQL advisory locks or SQLite exclusive transactions.
   */
  async acquireLock(): Promise<void> {
    if (this._hasLock) {
      return; // Already have the lock
    }

    const lockSql = this.migrationDriver.generateAcquireLock(MIGRATION_LOCK_ID);
    if (lockSql) {
      try {
        await this.driver._executeRaw(lockSql);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new MigrationError(
          `Failed to acquire migration lock: ${message}`,
          VibORMErrorCode.MIGRATION_LOCK_FAILED,
          { cause: err instanceof Error ? err : undefined }
        );
      }
    }
    // Only set after successful execution (or if no lock needed for SQLite)
    this._hasLock = true;
  }

  /**
   * Releases the migration lock.
   */
  async releaseLock(): Promise<void> {
    if (!this._hasLock) {
      return; // Don't have the lock
    }

    // Clear the flag first to avoid retrying on error
    this._hasLock = false;

    const unlockSql = this.migrationDriver.generateReleaseLock(MIGRATION_LOCK_ID);
    if (unlockSql) {
      try {
        await this.driver._executeRaw(unlockSql);
      } catch {
        // Ignore errors when releasing lock - it will be released when connection closes
      }
    }
  }

  /**
   * Execute a function while holding the migration lock.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireLock();
    try {
      return await fn();
    } finally {
      await this.releaseLock();
    }
  }

  // ===========================================================================
  // UTILITIES
  // ===========================================================================

  /**
   * Execute a function within a transaction.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.driver._transaction(fn);
  }

  /**
   * Execute raw SQL.
   */
  async executeRaw(sqlStr: string, params?: unknown[]): Promise<void> {
    await this.driver._executeRaw(sqlStr, params);
  }

  // ===========================================================================
  // STATEMENT EXECUTION
  // ===========================================================================

  /**
   * Executes parsed SQL statements from a migration file.
   * Filters out empty lines and comments, ensures semicolons.
   *
   * @param statements - Array of SQL statements to execute
   */
  async executeMigrationStatements(statements: string[]): Promise<void> {
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed || trimmed.startsWith("--")) {
        continue;
      }
      const sql = trimmed.endsWith(";") ? trimmed : `${trimmed};`;
      await this.executeRaw(sql);
    }
  }
}
