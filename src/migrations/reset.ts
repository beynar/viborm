/**
 * Migration Reset
 *
 * Drops all tables and re-applies all migrations from scratch.
 * WARNING: This is destructive and should only be used in development.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import { MigrationContext, type MigrationContextOptions } from "./context";
import { parseStatements } from "./generate/file-writer";
import type { MigrationClient } from "./push";
import type { MigrationEntry } from "./types";

// =============================================================================
// TYPES
// =============================================================================

export interface ResetOptions extends MigrationContextOptions {
  /** Skip confirmation (dangerous!) */
  force?: boolean;
  /** Preview without executing */
  dryRun?: boolean;
}

/**
 * Result of resetting the database.
 * Throws MigrationError on failure instead of returning error object.
 */
export interface ResetResult {
  /** Tables that were dropped */
  dropped: string[];
  /** Migrations that were re-applied */
  applied: MigrationEntry[];
}

// =============================================================================
// RESET FUNCTION
// =============================================================================

/**
 * Resets the database by dropping all tables and re-applying migrations.
 * Throws MigrationError on failure.
 *
 * WARNING: This is destructive! All data will be lost.
 *
 * The entire operation is wrapped in a transaction for atomicity.
 * If any step fails, the database is rolled back to its previous state.
 *
 * @param client - VibORM client with driver
 * @param options - Reset options
 * @returns Result with dropped tables and applied migrations
 * @throws MigrationError if reset fails
 */
export async function reset(
  client: MigrationClient,
  options: ResetOptions
): Promise<ResetResult> {
  const { dryRun = false } = options;

  const ctx = new MigrationContext(client, options);

  // Read journal
  const journal = await ctx.storage.readJournal();
  if (!journal) {
    return {
      dropped: [],
      applied: [],
    };
  }

  if (dryRun) {
    // Preview mode - just show what would happen
    const tables = await getTableNames(ctx);
    return {
      dropped: tables,
      applied: journal.entries,
    };
  }

  return ctx.withLock(async () => {
    // Wrap entire reset in transaction for atomicity
    return ctx.transaction(async () => {
      const dropped: string[] = [];
      const applied: MigrationEntry[] = [];

      // 1. Drop all tables (except system tables)
      const tables = await getTableNames(ctx);

      // Drop in reverse order to handle foreign key dependencies
      for (const table of tables.reverse()) {
        if (table === ctx.tableName) {
          continue; // Skip migration table, will handle last
        }

        const dropSql = ctx.migrationDriver.generateDropTableSQL(table, true);
        await ctx.executeRaw(dropSql);
        dropped.push(table);
      }

      // 2. Drop enums (if supported by database)
      const enums = await getEnumNames(ctx);
      for (const enumName of enums) {
        const dropEnumSql = ctx.migrationDriver.generateDropEnumSQL(enumName);
        if (dropEnumSql) {
          await ctx.executeRaw(dropEnumSql);
        }
      }

      // 3. Clear migration tracking table (don't drop, just clear)
      const clearSql = ctx.migrationDriver.generateClearMigrations(
        ctx.tableName
      );
      await ctx.executeRaw(clearSql);

      // 4. Re-apply all migrations
      for (const entry of journal.entries) {
        const content = await ctx.storage.readMigration(entry);
        if (!content) {
          throw new MigrationError(
            `Migration file not found: ${entry.name}`,
            VibORMErrorCode.MIGRATION_FILE_NOT_FOUND,
            { meta: { migrationName: entry.name } }
          );
        }

        const statements = parseStatements(content);
        await ctx.executeMigrationStatements(statements);
        await ctx.markMigrationApplied(entry);
        applied.push(entry);
      }

      return {
        dropped,
        applied,
      };
    });
  });
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Get all user table names in the database.
 */
async function getTableNames(ctx: MigrationContext): Promise<string[]> {
  const sql = ctx.migrationDriver.generateListTables();
  const rows = (await ctx.executor(sql)) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
 * Get all enum type names (PostgreSQL only).
 */
async function getEnumNames(ctx: MigrationContext): Promise<string[]> {
  const sql = ctx.migrationDriver.generateListEnums();
  if (!sql) {
    return [];
  }

  const rows = (await ctx.executor(sql)) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}
