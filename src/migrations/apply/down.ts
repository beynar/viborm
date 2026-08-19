/**
 * Migration Down (Rollback)
 *
 * Rolls back applied migrations by executing down SQL if available,
 * or just removing from tracking table.
 */

import { MigrationError, VibORMErrorCode } from "../../errors";
import { MigrationContext, type MigrationContextOptions } from "../context";
import {
  assertForeignKeysIntact,
  type ForeignKeyBracket,
  liftForeignKeyPragmas,
  withForeignKeysLifted,
} from "../foreign-keys";
import { parseStatements } from "../generate/file-writer";
import type { MigrationClient } from "../push";
import { formatMigrationFilename } from "../storage";
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
 * Everything the decision depends on is read INSIDE the migration lock, in one
 * order:
 * 1. Read the journal (format- and policy-validated by the storage driver)
 * 2. Read applied state and recompute the exact group from both
 * 3. Verify checksums for every group entry
 * 4. Refuse the whole group if any entry is irreversible — before any artifact
 *    read, so the two refusals cannot mask each other
 * 5. Refuse the whole group if any entry's down artifact is missing or parses
 *    empty — before the transaction, so no earlier reversible entry has run
 * 6. Execute the down scripts and untrack, in one transaction
 *
 * The preflight runs before the dry-run return as well: the CLI confirms
 * against the dry run, so a preview that cannot report a refusal is not a
 * preview.
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

  return ctx.withLock(async () => {
    // 1. Read journal
    const journal = await ctx.storage.readJournal();
    if (!journal) {
      return { rolledBack: [] };
    }

    // 2. Get applied migrations
    const appliedMigrations = await ctx.getAppliedMigrations();
    if (appliedMigrations.length === 0) {
      return { rolledBack: [] };
    }

    // Build map for checksum verification
    const appliedMap = new Map(appliedMigrations.map((m) => [m.name, m]));

    // 3. Determine which migrations to roll back, from the state just read
    // under the lock — never from a snapshot taken before acquiring it.
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

    // 4. Verify checksums before proceeding
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

    // 5. Group-wide policy check, before ANY artifact read: an irreversible
    // entry anywhere in the group refuses the whole group, and the refusal
    // quotes the reason the entry committed to when it was generated.
    for (const entry of toRollback) {
      if (entry.rollback.kind === "irreversible") {
        throw new MigrationError(
          `Migration "${entry.name}" was generated as irreversible and cannot be rolled back: ${entry.rollback.reason}. ` +
            `The rollback of all ${toRollback.length} migration(s) in this group is refused; no migration was rolled back and no tracking row was removed.`,
          VibORMErrorCode.MIGRATION_INVALID_STATE,
          { meta: { migrationName: entry.name } }
        );
      }
    }

    // 6. Group-wide artifact check. Remaining policies are `automatic` and
    // `manual`, and both promise executable down SQL: a missing, empty or
    // comment-only artifact is the SAME pre-effect failure, never a silent
    // "untrack it anyway".
    const scripts: Array<{ entry: MigrationEntry; statements: string[] }> = [];
    for (const entry of toRollback) {
      const content = await ctx.storage.readDownMigration(entry);
      if (content === null) {
        throw new MigrationError(
          `Migration "${entry.name}" has no down artifact at meta/_down/${formatMigrationFilename(entry)}, so rolling it back would remove its tracking row while leaving its schema changes live. ` +
            `The rollback of all ${toRollback.length} migration(s) in this group is refused.`,
          VibORMErrorCode.MIGRATION_INVALID_STATE,
          { meta: { migrationName: entry.name } }
        );
      }
      const statements = parseStatements(content);
      if (statements.length === 0) {
        throw new MigrationError(
          `Migration "${entry.name}" has an empty down artifact at meta/_down/${formatMigrationFilename(entry)} (no statements survive parsing; it is blank or comments only), so rolling it back would remove its tracking row while leaving its schema changes live. ` +
            `The rollback of all ${toRollback.length} migration(s) in this group is refused.`,
          VibORMErrorCode.MIGRATION_INVALID_STATE,
          { meta: { migrationName: entry.name } }
        );
      }
      scripts.push({ entry, statements });
    }

    // 7. Dry run reports the group that WOULD execute — after every refusal.
    if (dryRun) {
      return { rolledBack: toRollback };
    }

    // 8. A rollback that undoes a SQLite table recreation carries
    // `PRAGMA foreign_keys`, which a transaction discards, so the pragma has to
    // bracket the one transaction they all share; the artifact reads above
    // already happened outside it. See `src/migrations/foreign-keys.ts`.
    const liftedScripts: Array<{
      entry: MigrationEntry;
      statements: string[];
    }> = [];
    let bracket: ForeignKeyBracket | null = null;

    for (const script of scripts) {
      const lifted = liftForeignKeyPragmas(ctx.driver, script.statements);
      bracket ??= lifted.bracket;
      liftedScripts.push({
        entry: script.entry,
        statements: lifted.statements,
      });
    }

    return withForeignKeysLifted(ctx.driver, bracket, () =>
      ctx.transaction(async (txCtx) => {
        const rolledBack: MigrationEntry[] = [];

        for (const script of liftedScripts) {
          // Step 6 proved every script non-empty, so execution is
          // unconditional: tracking is never advanced past SQL that did not run.
          await txCtx.executeMigrationStatements(script.statements);
          // Remove from tracking
          await txCtx.markMigrationRolledBack(script.entry.name);
          rolledBack.push(script.entry);
        }

        await assertForeignKeysIntact(txCtx.driver, bracket);
        return { rolledBack };
      })
    );
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
