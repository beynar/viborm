/**
 * Migration Squash
 *
 * Consolidates multiple migrations into a single migration.
 * Useful for cleaning up development migrations before deployment.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import { MigrationContext, type MigrationContextOptions } from "./context";
import { formatMigrationContent, parseStatements } from "./generate/file-writer";
import { createMigrationEntry, formatMigrationFilename } from "./storage";
import type { MigrationClient } from "./push";
import type { MigrationEntry, MigrationJournal } from "./types";

// =============================================================================
// TYPES
// =============================================================================

export interface SquashOptions extends MigrationContextOptions {
  /** Name for the squashed migration */
  name?: string;
  /** Start index (default: 0) */
  from?: number;
  /** End index (default: latest) */
  to?: number;
  /** Preview without executing */
  dryRun?: boolean;
  /** Remove old migration files after squashing (moves to meta/_backup) */
  cleanup?: boolean;
}

/**
 * Result of squashing migrations.
 * Throws MigrationError on failure instead of returning error object.
 */
export interface SquashResult {
  /** The new squashed migration entry */
  entry: MigrationEntry;
  /** Number of migrations that were squashed */
  squashedCount: number;
  /** Combined SQL statements */
  sql: string[];
  /** Paths to archived migration files (if cleanup was enabled) */
  archivedFiles?: string[];
}

// =============================================================================
// SQUASH FUNCTION
// =============================================================================

/**
 * Squashes multiple migrations into a single migration.
 * Throws MigrationError on failure.
 *
 * This will:
 * 1. Read all migrations in the range
 * 2. Combine their SQL into a single migration
 * 3. Update the journal with the new squashed entry
 * 4. Update the database tracking table (if migrations were applied)
 * 5. Optionally remove old migration files
 *
 * NOTE: Only squash migrations that haven't been applied to production!
 *
 * @param client - VibORM client with driver
 * @param options - Squash options
 * @returns Result with the new squashed migration
 * @throws MigrationError if squash fails
 */
export async function squash(
  client: MigrationClient,
  options: SquashOptions
): Promise<SquashResult> {
  const { name, from = 0, to, dryRun = false, cleanup = false } = options;

  const ctx = new MigrationContext(client, options);

  // Read journal
  const journal = await ctx.storage.readJournal();
  if (!journal) {
    throw new MigrationError(
      "No migrations found",
      VibORMErrorCode.MIGRATION_NOT_FOUND
    );
  }

  // Determine range to squash
  const maxIdx = to ?? Math.max(...journal.entries.map((e) => e.idx));
  const entriesToSquash = journal.entries.filter(
    (e) => e.idx >= from && e.idx <= maxIdx
  );

  if (entriesToSquash.length < 2) {
    throw new MigrationError(
      "Need at least 2 migrations to squash",
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }

  // Collect all SQL statements
  const allStatements: string[] = [];

  for (const entry of entriesToSquash) {
    const content = await ctx.storage.readMigration(entry);
    if (!content) {
      throw new MigrationError(
        `Migration file not found: ${formatMigrationFilename(entry)}`,
        VibORMErrorCode.MIGRATION_FILE_NOT_FOUND,
        { meta: { migrationName: entry.name } }
      );
    }

    const statements = parseStatements(content);
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (trimmed && !trimmed.startsWith("--")) {
        allStatements.push(trimmed.endsWith(";") ? trimmed : `${trimmed};`);
      }
    }
  }

  // Generate migration name
  const migrationName = name || `squash-${from}-to-${maxIdx}`;

  // Create the new entry
  const content = formatMigrationContent(
    { idx: 0, version: "", name: migrationName, when: Date.now(), checksum: "" },
    allStatements,
    ctx.dialect
  );
  const newEntry = createMigrationEntry(0, migrationName, content);

  // Re-format with actual checksum
  const finalContent = formatMigrationContent(newEntry, allStatements, ctx.dialect);

  if (dryRun) {
    return {
      entry: newEntry,
      squashedCount: entriesToSquash.length,
      sql: allStatements,
    };
  }

  // Use lock for database operations
  return ctx.withLock(async () => {
    // 1. Update database tracking table (if migrations were applied)
    const appliedMigrations = await ctx.getAppliedMigrations();
    const appliedNames = new Set(appliedMigrations.map((m) => m.name));

    const squashedAppliedEntries = entriesToSquash.filter((e) =>
      appliedNames.has(e.name)
    );

    if (squashedAppliedEntries.length > 0) {
      await ctx.transaction(async () => {
        // Delete old entries from tracking table
        for (const entry of squashedAppliedEntries) {
          await ctx.deleteMigration(entry.name);
        }
        // Insert new squashed entry
        await ctx.markMigrationApplied(newEntry);
      });
    }

    // 2. Update journal - replace squashed entries with new one
    const entriesBefore = journal.entries.filter((e) => e.idx < from);
    const entriesAfter = journal.entries.filter((e) => e.idx > maxIdx);

    // New entry takes the index of `from`
    const newEntryWithIdx = { ...newEntry, idx: from };

    // Entries after get re-indexed starting from from + 1
    const reindexedAfter = entriesAfter.map((e, i) => ({
      ...e,
      idx: from + 1 + i,
    }));

    const newJournal: MigrationJournal = {
      ...journal,
      entries: [...entriesBefore, newEntryWithIdx, ...reindexedAfter],
    };

    // 3. Write new migration file
    await ctx.storage.writeMigration(newEntryWithIdx, finalContent);

    // 4. Update journal
    await ctx.storage.writeJournal(newJournal);

    // 5. Update snapshot (keep current)
    const snapshot = await ctx.storage.readSnapshot();
    if (snapshot) {
      await ctx.storage.writeSnapshot(snapshot);
    }

    // 6. Cleanup old migration files if requested (archive to meta/_backup)
    let archivedFiles: string[] | undefined;
    if (cleanup) {
      archivedFiles = [];
      for (const entry of entriesToSquash) {
        const archivePath = await ctx.storage.archiveMigration(entry);
        if (archivePath) {
          archivedFiles.push(archivePath);
        }
      }
    }

    return {
      entry: newEntryWithIdx,
      squashedCount: entriesToSquash.length,
      sql: allStatements,
      ...(archivedFiles ? { archivedFiles } : {}),
    };
  });
}
