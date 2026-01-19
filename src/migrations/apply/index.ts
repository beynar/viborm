/**
 * Migration Apply
 *
 * Applies pending migrations to the database.
 * Similar to `drizzle-kit push` or `prisma migrate deploy`.
 */

import { MigrationError, VibORMErrorCode } from "../../errors";
import { MigrationContext } from "../context";
import { parseStatements } from "../generate/file-writer";
import { MigrationStorageDriver, validateJournalDialect } from "../storage";
import type { MigrationClient } from "../push";
import type {
  ApplyOptions,
  AppliedMigration,
  MigrationEntry,
  MigrationStatus,
} from "../types";

export interface ApplyFullOptions extends ApplyOptions {
  /** Migrations directory */
  dir?: string;
  /** Name of the migrations tracking table */
  tableName?: string;
  /** Storage driver for migration files */
  storageDriver: MigrationStorageDriver;
}

/**
 * Result of applying migrations.
 * Throws MigrationError on failure instead of returning error object.
 */
export interface ApplyResult {
  /** Migrations that were applied */
  applied: MigrationEntry[];
  /** Migrations that are still pending */
  pending: MigrationEntry[];
}

/**
 * Applies pending migrations to the database.
 * Throws MigrationError on failure.
 *
 * @param client - VibORM client with driver
 * @param options - Apply options
 * @returns Apply result with applied and pending migrations
 * @throws MigrationError if migration fails
 */
export async function apply(
  client: MigrationClient,
  options: ApplyFullOptions
): Promise<ApplyResult> {
  const { to, dryRun = false, dir, tableName, storageDriver } = options;

  // Use MigrationContext for proper driver delegation
  const ctx = new MigrationContext(client, { dir, tableName, storageDriver });

  // 1. Ensure migrations tracking table exists
  if (!dryRun) {
    await ctx.ensureTrackingTable();
  }

  // 2. Read migration journal
  const journal = await ctx.storage.readJournal();

  if (!journal) {
    return {
      applied: [],
      pending: [],
    };
  }

  // Validate dialect matches
  validateJournalDialect(journal, ctx.dialect);

  // 3. Get applied migrations from database
  const appliedMigrations = dryRun ? [] : await ctx.getAppliedMigrations();

  const appliedNames = new Set(appliedMigrations.map((m) => m.name));

  // 4. Determine which migrations to apply
  let entriesToApply = journal.entries.filter(
    (entry) => !appliedNames.has(entry.name)
  );

  // If `to` is specified, limit to migrations up to that index
  if (to !== undefined) {
    entriesToApply = entriesToApply.filter((entry) => entry.idx <= to);
  }

  // 5. Verify checksums for already-applied migrations
  for (const appliedMigration of appliedMigrations) {
    const journalEntry = journal.entries.find(
      (e) => e.name === appliedMigration.name
    );
    if (journalEntry && journalEntry.checksum !== appliedMigration.checksum) {
      throw new MigrationError(
        `Migration "${appliedMigration.name}" has been modified after being applied. ` +
          `Database has checksum ${appliedMigration.checksum}, ` +
          `but file has checksum ${journalEntry.checksum}. ` +
          "Migrations should not be modified after being applied.",
        VibORMErrorCode.MIGRATION_CHECKSUM_MISMATCH,
        {
          meta: {
            migrationName: appliedMigration.name,
            expectedChecksum: appliedMigration.checksum,
            actualChecksum: journalEntry.checksum,
          },
        }
      );
    }
  }

  // 6. Apply pending migrations
  const applied: MigrationEntry[] = [];

  if (dryRun) {
    // For dry run, just return what would be applied
    return {
      applied: [],
      pending: entriesToApply,
    };
  }

  for (const entry of entriesToApply) {
    // Read migration file
    const content = await ctx.storage.readMigration(entry);
    if (!content) {
      throw new MigrationError(
        `Migration file not found for "${entry.name}"`,
        VibORMErrorCode.MIGRATION_FILE_NOT_FOUND,
        { meta: { migrationName: entry.name } }
      );
    }

    // Parse statements
    const statements = parseStatements(content);

    try {
      // Execute migration in a transaction
      await ctx.transaction(async () => {
        await ctx.executeMigrationStatements(statements);
        await ctx.markMigrationApplied(entry);
      });

      applied.push(entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new MigrationError(
        `Failed to apply migration "${entry.name}": ${message}`,
        VibORMErrorCode.MIGRATION_FAILED,
        {
          cause: err instanceof Error ? err : undefined,
          meta: { migrationName: entry.name },
        }
      );
    }
  }

  return {
    applied,
    pending: [],
  };
}

/**
 * Get the status of all migrations (applied vs pending).
 */
export async function status(
  client: MigrationClient,
  options: { dir?: string; tableName?: string; storageDriver: MigrationStorageDriver }
): Promise<MigrationStatus[]> {
  const { dir, tableName, storageDriver } = options;

  // Use MigrationContext for proper driver delegation
  const ctx = new MigrationContext(client, { dir, tableName, storageDriver });

  // Read journal
  const journal = await ctx.storage.readJournal();

  if (!journal) {
    return [];
  }

  // Get applied migrations
  let appliedMigrations: AppliedMigration[];
  try {
    appliedMigrations = await ctx.getAppliedMigrations();
  } catch {
    // Table doesn't exist yet, no migrations applied
    appliedMigrations = [];
  }

  const appliedMap = new Map(appliedMigrations.map((m) => [m.name, m]));

  // Build status list
  return journal.entries.map((entry) => {
    const appliedMigration = appliedMap.get(entry.name);
    return {
      entry,
      applied: !!appliedMigration,
      appliedAt: appliedMigration?.appliedAt,
    };
  });
}

/**
 * Get pending migrations that haven't been applied yet.
 */
export async function pending(
  client: MigrationClient,
  options: { dir?: string; tableName?: string; storageDriver: MigrationStorageDriver }
): Promise<MigrationEntry[]> {
  const statuses = await status(client, options);
  return statuses.filter((s) => !s.applied).map((s) => s.entry);
}

/**
 * Rollback the last N migrations (marks them as not applied).
 * Note: This does NOT run down migrations - it only removes from tracking table.
 */
export async function rollback(
  client: MigrationClient,
  options: { count?: number; dir?: string; tableName?: string; storageDriver: MigrationStorageDriver }
): Promise<MigrationEntry[]> {
  const { count = 1, dir, tableName, storageDriver } = options;

  // Use MigrationContext for proper driver delegation
  const ctx = new MigrationContext(client, { dir, tableName, storageDriver });

  // Read journal
  const journal = await ctx.storage.readJournal();

  if (!journal) {
    return [];
  }

  // Get applied migrations
  const appliedMigrations = await ctx.getAppliedMigrations();

  // Get the last N applied migrations
  const toRollback = appliedMigrations.slice(-count).reverse();

  // Remove from tracking table
  const rolledBack: MigrationEntry[] = [];

  for (const applied of toRollback) {
    const entry = journal.entries.find((e) => e.name === applied.name);
    if (!entry) continue;

    await ctx.markMigrationRolledBack(applied.name);
    rolledBack.push(entry);
  }

  return rolledBack;
}
