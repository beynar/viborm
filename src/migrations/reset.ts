/**
 * Migration Reset
 *
 * Drops all tables and re-applies all migrations from scratch.
 * WARNING: This is destructive and should only be used in development.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import { MigrationContext } from "./context";
import { parseStatements } from "./generate/file-writer";
import {
  executeLiveNamespaceReset,
  type LiveNamespaceResetPlan,
  planLiveNamespaceReset,
} from "./live-reset";
import type { MigrationClient } from "./push";
import {
  assertArtifactExecutionSafe,
  needsEnumAdditionCommitBoundary,
} from "./statement-safety";
import type { MigrationStorageDriver } from "./storage";
import type { MigrationEntry } from "./types";

// =============================================================================
// TYPES
// =============================================================================

/**
 * The fields are inlined rather than inherited: the internal context options
 * type is not part of the public surface.
 */
export interface ResetOptions {
  /** Migrations directory (default: ./migrations) */
  dir?: string;
  /** Migration tracking table name (default: _viborm_migrations) */
  tableName?: string;
  /** Storage driver for migration files (required) */
  storageDriver: MigrationStorageDriver;
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
 * Atomicity is the DIALECT's, not this function's, and the difference is the
 * whole reason it is stated here rather than promised:
 *
 * - PostgreSQL clears and replays inside ONE transaction on the locked session,
 *   so a failure leaves the original schema and the original tracking rows
 *   exactly as they were.
 * - MySQL commits DDL implicitly (§3.5), so there is no transaction to open and
 *   none is faked. The clear and the replay are one sequential program, so a
 *   failure anywhere in it leaves a partially rebuilt database and the error
 *   says so: it names the last statement that COMPLETED, makes no rollback
 *   claim, and leaves the portable journal/snapshot/artifact estate untouched
 *   (§6.2, `pinned-session.ts`).
 *
 * Everything that can refuse — the estate gate, every artifact read, parse and
 * execution-safety classification, PostgreSQL's enum commit-boundary check, and
 * the clear's own namespace proof, live inventory and containment refusals —
 * happens before the first destructive statement on both, and therefore
 * OUTSIDE the reporter that speaks for what was already committed.
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

  // Read and validate the journal against this estate. No journal is the
  // documented storage-only return: nothing connects, nothing locks.
  const journal = await ctx.readEstateJournal();
  if (!journal) {
    return {
      dropped: [],
      applied: [],
    };
  }

  // A present journal means live work. The dry run takes the same gate as the
  // effectful path because it reports live inventory the caller confirms
  // against — a preview that reads live state is a live-state decision.
  ctx.admitLive("effectful", "reset()");

  return ctx.withLockedSession(async (locked) => {
    // Reread the journal under the lock — the authoritative input to the
    // destructive program. A journal that changed while the lock was being
    // acquired refuses here, having executed only the non-durable lock.
    const lockedJournal = await locked.readEstateJournal();
    if (!lockedJournal) {
      return { dropped: [], applied: [] };
    }

    // The COMPLETE preflight, before the first effect: every artifact is read,
    // parsed and classified, PostgreSQL additionally refuses a history that
    // needs a commit boundary mid-replay, and the clear itself is decided and
    // rendered — which is where the namespace proof, the live inventory and
    // both containment refusals happen. A dry run stops here — which is the
    // whole reason the preflight precedes it: a preview that cannot report a
    // refusal is not a preview.
    const replay = await readReplay(locked, lockedJournal.entries);
    const plan = await planLiveNamespaceReset(
      locked.driver,
      locked.migrationDriver,
      { trackingTable: "preserve", trackingTableName: locked.tableName }
    );

    if (dryRun) {
      // The preview publishes the exact estate the effectful path just proved,
      // not a second reading of it. It used to read a bare table list with no
      // proof, so a configured schema that does not exist previewed as "nothing
      // to drop" instead of refusing.
      return { dropped: plan.tables, applied: [...lockedJournal.entries] };
    }

    if (locked.target.dialect === "postgresql") {
      // ONE transaction: clear, replay and tracking restore either all happen
      // or none do, so an artifact, DDL or tracking failure leaves the original
      // schema and the original tracking rows exactly as they were.
      return locked.transaction((txCtx) => runReset(txCtx, plan, replay));
    }

    if (locked.target.dialect === "mysql") {
      // MySQL commits DDL implicitly (see the linked reference in §3.5), so
      // there is no transaction to open and none is faked. The clear and the
      // replay are ONE sequential program: the teardown's own failures were
      // already reported, and the replay's were not, so a reset that dropped
      // the estate and then failed to rebuild it said only that a `CREATE
      // TABLE` failed. Tracking rows are cleared and committed FIRST, so a
      // teardown failure reports every history entry pending rather than
      // claiming that now-missing objects are applied. The program is the
      // EFFECTS only: the plan above already refused everything refusable, and
      // a refusal reported as "failed partway through / NOTHING was rolled
      // back" describes a database this command never touched.
      return locked.sequentialProgram((seqCtx) =>
        runReset(seqCtx, plan, replay)
      );
    }

    // SQLite reserves no session, takes no lock and needs no containment: its
    // estates have no namespace, and this arm is exactly what it ran before.
    return runReset(locked, plan, replay);
  });
}

// =============================================================================
// HELPERS
// =============================================================================

/** One journal entry's artifact, read and validated before any effect. */
interface ReplayEntry {
  readonly entry: MigrationEntry;
  readonly statements: string[];
}

/**
 * Reads, parses and classifies every artifact the replay needs.
 *
 * Runs BEFORE the first destructive statement (§6.2): a missing artifact
 * discovered halfway through a MySQL teardown cannot be undone, and on
 * PostgreSQL discovering it inside the transaction only to roll back is work
 * nobody needed to do.
 */
async function readReplay(
  ctx: MigrationContext,
  entries: readonly MigrationEntry[]
): Promise<ReplayEntry[]> {
  const replay: ReplayEntry[] = [];
  for (const entry of entries) {
    const content = await ctx.storage.readMigration(entry);
    if (!content) {
      throw new MigrationError(
        `Migration file not found: ${entry.name}`,
        VibORMErrorCode.MIGRATION_FILE_NOT_FOUND,
        { meta: { migrationName: entry.name } }
      );
    }
    const statements = parseStatements(content);
    assertArtifactExecutionSafe(statements, ctx.target.dialect, entry.name);
    if (
      ctx.target.dialect === "postgresql" &&
      needsEnumAdditionCommitBoundary(statements)
    ) {
      throw new MigrationError(
        `Migration "${entry.name}" adds a PostgreSQL enum value, which cannot be used by a later statement in the same transaction. ` +
          "Migration reset replays the whole history inside ONE transaction so a failure restores the original schema, and that guarantee is incompatible with a history needing a commit boundary mid-replay. Rebuild with `apply()`, which commits once per entry under the same lock.",
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        { meta: { migrationName: entry.name } }
      );
    }
    replay.push({ entry, statements });
  }
  return replay;
}

/**
 * Executes the planned clear and replays the validated history.
 *
 * EVERY statement it issues changes the estate, which is what makes it the
 * exact scope MySQL's sequential-program reporter answers for.
 *
 * The tracking table's STRUCTURE is preserved (`trackingTable: "preserve"`) —
 * only its rows are cleared — because this same command is about to restore
 * them. Each row is restored only AFTER its artifact completes, so a MySQL
 * teardown that fails partway reports the entries it could not prove as
 * pending rather than claiming them applied.
 */
async function runReset(
  ctx: MigrationContext,
  plan: LiveNamespaceResetPlan,
  replay: readonly ReplayEntry[]
): Promise<ResetResult> {
  const { dropped } = await executeLiveNamespaceReset(ctx.driver, plan);

  const applied: MigrationEntry[] = [];
  for (const { entry, statements } of replay) {
    await ctx.executeMigrationStatements(statements);
    await ctx.markMigrationApplied(entry);
    applied.push(entry);
  }

  return { dropped, applied };
}
