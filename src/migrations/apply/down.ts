/**
 * Migration Down (Rollback)
 *
 * Rolls back applied migrations by executing down SQL if available,
 * or just removing from tracking table.
 */

import { MigrationError, VibORMErrorCode } from "../../errors";
import { MigrationContext, type MigrationContextOptions } from "../context";
import type { MigrationClient } from "../push";
import type { MigrationEntry } from "../types";

// =============================================================================
// TYPES
// =============================================================================

export interface DownOptions extends MigrationContextOptions {
  /** Number of migrations to roll back (default: 1) */
  steps?: number;
  /** Roll back to a specific migration (by name or index) */
  to?: string | number;
  /** Preview without executing */
  dryRun?: boolean;
}

/**
 * Result of rolling back migrations.
 * Throws MigrationError on failure instead of returning error object.
 */
export interface DownResult {
  /** Migrations that were rolled back */
  rolledBack: MigrationEntry[];
}

// =============================================================================
// DOWN FUNCTION
// =============================================================================

/**
 * Rolls back applied migrations.
 * Throws MigrationError on failure.
 *
 * This will:
 * 1. Verify checksums before rolling back
 * 2. Check for down migration files (if available)
 * 3. Execute down SQL in reverse order (atomically in a transaction)
 * 4. Remove migrations from tracking table
 *
 * @param client - VibORM client with driver
 * @param options - Down options
 * @returns Result with rolled back migrations
 * @throws MigrationError if rollback fails
 */
export async function down(
  client: MigrationClient,
  options: DownOptions
): Promise<DownResult> {
  const { steps = 1, to, dryRun = false } = options;

  const ctx = new MigrationContext(client, options);

  // Read journal
  const journal = await ctx.storage.readJournal();
  if (!journal) {
    return { rolledBack: [] };
  }

  // Get applied migrations
  const appliedMigrations = await ctx.getAppliedMigrations();
  if (appliedMigrations.length === 0) {
    return { rolledBack: [] };
  }

  // Build map for checksum verification
  const appliedMap = new Map(appliedMigrations.map((m) => [m.name, m]));

  // Determine which migrations to roll back
  let toRollback: MigrationEntry[] = [];

  if (to !== undefined) {
    // Roll back to a specific migration
    const targetIdx =
      typeof to === "number" ? to : findMigrationIndex(journal.entries, to);
    if (targetIdx === -1) {
      throw new MigrationError(
        `Migration "${to}" not found`,
        VibORMErrorCode.MIGRATION_NOT_FOUND
      );
    }

    // Roll back all migrations after the target
    const appliedNames = new Set(appliedMigrations.map((m) => m.name));
    toRollback = journal.entries
      .filter((e) => e.idx > targetIdx && appliedNames.has(e.name))
      .reverse();
  } else {
    // Roll back last N migrations
    const appliedNames = new Set(appliedMigrations.map((m) => m.name));
    const appliedEntries = journal.entries.filter((e) =>
      appliedNames.has(e.name)
    );
    toRollback = appliedEntries.slice(-steps).reverse();
  }

  if (toRollback.length === 0) {
    return { rolledBack: [] };
  }

  // Verify checksums before proceeding
  for (const entry of toRollback) {
    const applied = appliedMap.get(entry.name);
    if (applied && applied.checksum !== entry.checksum) {
      throw new MigrationError(
        `Migration "${entry.name}" has been modified since it was applied. ` +
          `Applied checksum: ${applied.checksum}, current checksum: ${entry.checksum}. ` +
          "Rolling back a modified migration may cause data inconsistencies.",
        VibORMErrorCode.MIGRATION_CHECKSUM_MISMATCH,
        { meta: { migrationName: entry.name } }
      );
    }
  }

  if (dryRun) {
    return { rolledBack: toRollback };
  }

  // Execute rollback with lock, wrapped in a single transaction for atomicity
  return ctx.withLock(async () => {
    return ctx.transaction(async (txCtx) => {
      const rolledBack: MigrationEntry[] = [];

      for (const entry of toRollback) {
        // Try to execute down SQL if available
        const downSql = await readDownSql(txCtx, entry);
        if (downSql) {
          const statements = parseDownStatements(downSql);
          await txCtx.executeMigrationStatements(statements);
        }
        // Remove from tracking
        await txCtx.markMigrationRolledBack(entry.name);
        rolledBack.push(entry);
      }

      return { rolledBack };
    });
  });
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Find a migration index by name.
 */
function findMigrationIndex(entries: MigrationEntry[], name: string): number {
  const entry = entries.find((e) => e.name === name);
  return entry ? entry.idx : -1;
}

/**
 * Read down SQL for a migration if it exists.
 *
 * Looks for:
 * 1. migrations/meta/_down/0000_name.sql
 * 2. -- down marker in the main migration file
 */
async function readDownSql(
  ctx: MigrationContext,
  entry: MigrationEntry
): Promise<string | null> {
  // Try dedicated down file first
  const downContent = await ctx.storage.readDownMigration(entry);
  if (downContent) {
    return downContent;
  }

  // Try inline down section in migration file
  const content = await ctx.storage.readMigration(entry);
  if (content) {
    const downMarker = "-- down";
    const markerIndex = content.toLowerCase().indexOf(downMarker);

    if (markerIndex !== -1) {
      return content.slice(markerIndex + downMarker.length).trim();
    }
  }

  return null;
}

/**
 * Parse down SQL into individual statements.
 */
function parseDownStatements(sql: string): string[] {
  // Simple split by semicolon, handling basic cases
  const statements: string[] = [];
  let current = "";

  for (const line of sql.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("--")) {
      continue; // Skip comments
    }
    current += line + "\n";

    if (trimmed.endsWith(";")) {
      const stmt = current.trim();
      if (stmt && stmt !== ";") {
        statements.push(stmt);
      }
      current = "";
    }
  }

  // Handle any remaining content
  const remaining = current.trim();
  if (remaining && remaining !== ";") {
    statements.push(remaining.endsWith(";") ? remaining : `${remaining};`);
  }

  return statements;
}
