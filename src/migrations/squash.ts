/**
 * Migration Squash
 *
 * Consolidates multiple migrations into a single migration.
 * Useful for cleaning up development migrations before deployment.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import { MigrationContext, type MigrationContextOptions } from "./context";
import { formatDownMigrationContent } from "./generate/down";
import {
  formatMigrationContent,
  parseStatements,
} from "./generate/file-writer";
import type { MigrationClient } from "./push";
import { createMigrationEntry, formatMigrationFilename } from "./storage";
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
  /** Composed down statements, in reverse migration order */
  downSql: string[];
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
 * Everything happens inside the migration lock, in one order: read the journal,
 * select the range, refuse it (suffix, policy, uniform applied state), read and
 * validate every source artifact, then write. Every refusal is pre-effect — no
 * migration file, journal, snapshot, down artifact or tracking row is touched
 * before the last of them passes.
 *
 * V1 restrictions, each named in its own refusal:
 * - The range must be a SUFFIX of the journal. Squashing a prefix would
 *   re-index later entries without renaming their artifacts, orphaning every
 *   one of them.
 * - Every source must be `mode: "generated"` with `rollback: automatic`. A
 *   manual or irreversible source cannot be composed into a single reversible
 *   migration by concatenation.
 * - The range must be uniformly applied or uniformly pending. A mixed range has
 *   no single truthful tracking outcome.
 *
 * Writes go artifacts-first, tracking-last: neither order is atomic (blob
 * storage has no transaction and the DB transaction cannot span it), and this
 * one leaves the estate re-squashable when it fails instead of leaving the
 * database claiming a migration whose file does not exist.
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

  return ctx.withLock(async () => {
    // 1. Read journal (format- and policy-validated by the storage driver)
    const journal = await ctx.storage.readJournal();
    if (!journal) {
      throw new MigrationError(
        "No migrations found",
        VibORMErrorCode.MIGRATION_NOT_FOUND
      );
    }

    // 2. Determine range to squash
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

    // 3. Suffix restriction
    const entriesAfter = journal.entries.filter((e) => e.idx > maxIdx);
    if (entriesAfter.length > 0) {
      throw new MigrationError(
        `Squash range ${from}..${maxIdx} is not a suffix of the journal: ${entriesAfter.length} migration(s) follow it (${entriesAfter.map((e) => e.name).join(", ")}). ` +
          "Squashing a prefix would re-index those entries without renaming their migration and down artifacts, orphaning every one of them. Squash up to the latest migration instead.",
        VibORMErrorCode.MIGRATION_INVALID_STATE
      );
    }

    // 4. Policy refusal, before any artifact read or write
    for (const entry of entriesToSquash) {
      if (entry.mode !== "generated" || entry.rollback.kind !== "automatic") {
        throw new MigrationError(
          `Migration "${entry.name}" is ${entry.mode} with rollback policy "${entry.rollback.kind}" and cannot be squashed. ` +
            "Squash composes generated migrations with automatic rollback: a caller-authored or irreversible migration is not reproduced by concatenating SQL.",
          VibORMErrorCode.MIGRATION_INVALID_STATE,
          { meta: { migrationName: entry.name } }
        );
      }
    }

    // 5. Uniform applied-state premise. A mixed range has no truthful outcome:
    // marking it applied strands the pending DDL forever.
    const appliedMigrations = await ctx.getAppliedMigrations();
    const appliedNames = new Set(appliedMigrations.map((m) => m.name));
    const squashedAppliedEntries = entriesToSquash.filter((e) =>
      appliedNames.has(e.name)
    );
    const pendingEntries = entriesToSquash.filter(
      (e) => !appliedNames.has(e.name)
    );
    if (squashedAppliedEntries.length > 0 && pendingEntries.length > 0) {
      throw new MigrationError(
        `Squash range ${from}..${maxIdx} mixes applied and pending migrations: applied [${squashedAppliedEntries.map((e) => e.name).join(", ")}], pending [${pendingEntries.map((e) => e.name).join(", ")}]. ` +
          "Squash requires a uniformly applied or uniformly pending range — apply the pending migrations first, or roll back the applied ones.",
        VibORMErrorCode.MIGRATION_INVALID_STATE
      );
    }

    // 6. Compose the up artifact forward, preserving in-file statement order
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
      for (const stmt of parseStatements(content)) {
        allStatements.push(normalizeStatement(stmt));
      }
    }

    // 7. Compose the down artifact in REVERSE migration order, preserving
    // in-file statement order. The squashed migration is only as reversible as
    // its sources, so a missing or empty source down artifact refuses here
    // rather than producing a squashed entry that cannot be rolled back.
    const downStatements: string[] = [];
    for (const entry of [...entriesToSquash].reverse()) {
      const content = await ctx.storage.readDownMigration(entry);
      if (content === null) {
        throw new MigrationError(
          `Migration "${entry.name}" has no down artifact at meta/_down/${formatMigrationFilename(entry)}, so the squashed migration could not be rolled back.`,
          VibORMErrorCode.MIGRATION_INVALID_STATE,
          { meta: { migrationName: entry.name } }
        );
      }
      const statements = parseStatements(content);
      if (statements.length === 0) {
        throw new MigrationError(
          `Migration "${entry.name}" has an empty down artifact at meta/_down/${formatMigrationFilename(entry)} (no statements survive parsing), so the squashed migration could not be rolled back.`,
          VibORMErrorCode.MIGRATION_INVALID_STATE,
          { meta: { migrationName: entry.name } }
        );
      }
      for (const stmt of statements) {
        downStatements.push(normalizeStatement(stmt));
      }
    }

    // 8. Build the new entry at idx `from` directly
    const migrationName = name || `squash-${from}-to-${maxIdx}`;
    const policy = {
      mode: "generated",
      rollback: { kind: "automatic" },
    } as const;
    const placeholderEntry: MigrationEntry = {
      idx: from,
      version: "",
      name: migrationName,
      when: Date.now(),
      checksum: "",
      ...policy,
    };
    const content = formatMigrationContent(
      placeholderEntry,
      allStatements,
      ctx.dialect
    );
    const newEntry = createMigrationEntry(from, migrationName, content, policy);

    // Re-format with actual checksum
    const finalContent = formatMigrationContent(
      newEntry,
      allStatements,
      ctx.dialect
    );
    const downContent = formatDownMigrationContent(
      migrationName,
      downStatements,
      []
    );

    // 9. Dry run reports what would be written — after every refusal
    if (dryRun) {
      return {
        entry: newEntry,
        squashedCount: entriesToSquash.length,
        sql: allStatements,
        downSql: downStatements,
      };
    }

    // 10. Write artifacts, then the journal. The snapshot is deliberately left
    // verbatim: squash never changes the schema, and the next `generate` must
    // re-check its coherence against exactly the bytes already stored.
    await ctx.storage.writeMigration(newEntry, finalContent);
    await ctx.storage.writeDownMigration(newEntry, downContent);

    const newJournal: MigrationJournal = {
      ...journal,
      entries: [...journal.entries.filter((e) => e.idx < from), newEntry],
    };
    await ctx.storage.writeJournal(newJournal);

    // 11. Tracking. After the uniformity premise this is the all-applied case;
    // an all-pending range leaves tracking untouched by construction.
    if (squashedAppliedEntries.length > 0) {
      await ctx.transaction(async (txCtx) => {
        for (const entry of squashedAppliedEntries) {
          await txCtx.deleteMigration(entry.name);
        }
        await txCtx.markMigrationApplied(newEntry);
      });
    }

    // 12. Cleanup old migration files if requested (archive to meta/_backup)
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
      entry: newEntry,
      squashedCount: entriesToSquash.length,
      sql: allStatements,
      downSql: downStatements,
      ...(archivedFiles ? { archivedFiles } : {}),
    };
  });
}

/** Trim a parsed statement and guarantee its terminating semicolon. */
function normalizeStatement(statement: string): string {
  const trimmed = statement.trim();
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
}
