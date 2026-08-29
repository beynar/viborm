/**
 * Migration Apply
 *
 * Applies pending migrations to the database.
 * Similar to `drizzle-kit push` or `prisma migrate deploy`.
 */

import { MigrationError, VibORMErrorCode } from "../../errors";
import { MigrationContext } from "../context";
import { sqliteTableBearsRelations } from "../drivers/sqlite";
import { generatedSqliteDecimalRebuilds } from "../drivers/sqlite/artifact-admission";
import {
  assertForeignKeysIntact,
  foreignKeyPragmasCannotBeLifted,
  liftForeignKeyPragmas,
  withForeignKeysLifted,
} from "../foreign-keys";
import { parseStatements } from "../generate/file-writer";
import type { MigrationClient } from "../push";
import { assertArtifactExecutionSafe } from "../statement-safety";
import type { MigrationStorageDriver } from "../storage";
import type {
  AppliedMigration,
  ApplyOptions,
  MigrationEntry,
  MigrationJournal,
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
 * The order is exact and the reason is durability: the estate gate runs before
 * the tracking table is created, so a journal belonging to another estate
 * cannot leave a table behind on this one. It runs TWICE for that reason — once
 * before the connection, and once more under the lock, because the wait for the
 * lock is exactly the window in which the first answer goes stale. The
 * absent-journal arm returns before any connection at all; the absent-under-
 * lock arm returns having executed only the non-durable lock and namespace
 * proof.
 *
 * The same rule decides where the rest of this command's inputs are read.
 * Creating the tracking table is DDL, and on MySQL it COMMITS — so everything
 * answerable without an effect is answered before it ({@link preflightApply}),
 * and everything from it onward is one durable program
 * ({@link runApplyProgram}). It used to create the table and then discover the
 * applied state, the artifact and its classification, so any of those failing
 * changed the schema and reported an ordinary error about a file or a `SELECT`.
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

  // 1. Read and validate the journal against this estate, before any effect.
  const journal = await ctx.readEstateJournal();

  if (!journal) {
    return {
      applied: [],
      pending: [],
    };
  }

  // 2. A dry run is storage-only: it connects to nothing, so it reports every
  // journal entry as pending rather than pretending to know applied state.
  if (dryRun) {
    return { applied: [], pending: selectPending(journal.entries, [], to) };
  }

  // 3. A present journal establishes that live work follows, so the effectful
  // path is admitted here — before the lock, the tracking write, the
  // applied-state read, and every artifact read.
  ctx.admitLive("effectful", "apply()");

  return ctx.withLockedSession(async (locked) => {
    // 4. The AUTHORITATIVE journal, reread and revalidated under the lock
    // BEFORE this command's first durable effect. The probe at step 1 is
    // advisory: apply may have waited on the lock for as long as another
    // migration held it, and the estate it probed can be gone or be another
    // estate's by the time it holds that lock. Creating the tracking table
    // first — which is DDL, and used to be the first statement inside the lock
    // — left a table behind on a database the caller was then told nothing had
    // happened to.
    const current = await locked.readEstateJournal();
    if (!current) {
      return { applied: [], pending: [] };
    }

    // 5. Every input this command can obtain WITHOUT changing the estate,
    // obtained before the estate changes: the applied state (which tolerates an
    // absent tracking table by construction), the checksum agreement, and every
    // pending artifact read, parsed and classified. Each of these can refuse,
    // and a refusal that cost the estate nothing must say so.
    const preflight = await preflightApply(locked, current.entries, to);

    // 6. The durable program: the tracking table and everything after it.
    return runApplyProgram(locked, current, preflight, to);
  });
}

/**
 * Everything `apply()` can answer before its first durable statement.
 *
 * The applied state is read HERE rather than inside the loop's first pass
 * because the only thing between the two is `CREATE TABLE IF NOT EXISTS`, which
 * cannot change which migrations are recorded — so reading it twice would be a
 * second round trip for an answer this command already holds, and reading it
 * only after the CREATE means an unreadable estate has already been changed.
 */
async function preflightApply(
  ctx: MigrationContext,
  entries: readonly MigrationEntry[],
  to: number | undefined
): Promise<ApplyPreflight> {
  const appliedMigrations = await readValidatedAppliedState(ctx, entries);
  const artifacts = new Map<string, string[]>();
  for (const entry of selectPending(entries, appliedMigrations, to)) {
    const statements = await readArtifact(ctx, entry);
    artifacts.set(artifactIdentity(entry), statements);
  }
  return { appliedMigrations, artifacts };
}

/**
 * Refuse a generated SQLite decimal rebuild transplanted onto D1's batch-only
 * substrate when a live foreign key touches the rebuilt table.
 *
 * The renderer owns the same decision for live DDL. Apply owns this second
 * entrance because a durable SQLite artifact is already SQL: it is never
 * rendered again, and its journal intentionally carries no provider marker.
 */
async function assertGeneratedSqliteDecimalArtifactAdmitted(
  ctx: MigrationContext,
  entry: MigrationEntry,
  statements: readonly string[]
): Promise<void> {
  if (
    ctx.target.dialect !== "sqlite" ||
    entry.mode !== "generated" ||
    !foreignKeyPragmasCannotBeLifted(ctx.driver)
  ) {
    return;
  }

  const rebuilds = generatedSqliteDecimalRebuilds(statements);
  if (rebuilds.length === 0) return;

  const liveSchema = await ctx.migrationDriver.introspect(
    async <T>(sql, params) => ({ rows: await ctx.executor<T>(sql, params) })
  );
  for (const rebuild of rebuilds) {
    if (
      !sqliteTableBearsRelations(
        rebuild.table,
        liveSchema.tables,
        undefined,
        rebuild.precedingOperations
      )
    ) {
      continue;
    }
    throw new MigrationError(
      `The generated fixed-decimal migration "${entry.name}" rebuilds table "${rebuild.table}", and the driver "${ctx.driver.driverName}" executes migrations as one native batch. ` +
        "SQLite treats `PRAGMA foreign_keys=OFF` as a no-op inside that batch, so dropping a table with inbound or outbound foreign keys could either fail after earlier effects or silently apply referential actions to its rows. " +
        "The migration is refused before any statement from it runs, so neither this artifact nor its tracking row changed the estate. Generate this descriptor change for a relation-free table, or apply it through a SQLite driver that can lift the pragma outside its transaction.",
      VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      {
        meta: {
          driver: ctx.driver.driverName,
          migrationName: entry.name,
          table: rebuild.table,
          feature: "decimal descriptor conversion",
        },
      }
    );
  }
}

/**
 * The entry facts that decide BOTH which artifact is executed and which history
 * this command writes: the artifact path is `(idx, name)` and the tracking row
 * is `(name, checksum)`.
 *
 * A preflight answer keyed by the name alone is an answer for a different
 * entry whenever the journal is republished between two of this command's
 * commits — the loop rereads the authoritative journal after every commit, so a
 * name it already holds an answer for can by then belong to another version of
 * that migration. Keyed by these facts, such an entry simply misses and is read
 * as the new entry it is.
 */
function artifactIdentity(entry: MigrationEntry): string {
  return JSON.stringify([entry.idx, entry.name, entry.checksum]);
}

/** The inputs a preflight proved, handed to the program that spends them. */
interface ApplyPreflight {
  readonly appliedMigrations: readonly AppliedMigration[];
  /** Each pending entry's validated statements, by {@link artifactIdentity}. */
  readonly artifacts: ReadonlyMap<string, string[]>;
}

/**
 * Creates the tracking table and applies entries until none are pending.
 *
 * EVERY statement the program issues changes the estate, which is what makes it
 * the exact scope MySQL's sequential-program reporter answers for: there, the
 * tracking `CREATE TABLE` commits the moment it runs and so does everything
 * after it, so one report speaks for the whole thing and names the boundary it
 * reached (§6.2). Every other dialect keeps the per-entry transaction its own
 * commit model provides and needs no such report.
 *
 * The loop deliberately does NOT hold a single transaction across every entry:
 * a history where migration A adds an enum value and migration B uses it is
 * only replayable when A's `ALTER TYPE ... ADD VALUE` has committed first. The
 * lock is what makes that safe — no other VibORM migration command can
 * interleave between two commits — and rereading is what makes it correct,
 * because the authoritative journal and tracking state are exactly the inputs
 * the next entry is chosen from.
 */
async function runApplyProgram(
  ctx: MigrationContext,
  journal: MigrationJournal,
  preflight: ApplyPreflight,
  to: number | undefined
): Promise<ApplyResult> {
  /**
   * The entry whose effects are running RIGHT NOW, and nothing else.
   *
   * One thrown value reaches the caller and it has to carry two facts: what the
   * program did (MySQL's boundary report, which is dialect-level and knows
   * nothing about entries) and WHICH migration was being applied. VibORM
   * redacts a cause's own message and metadata when it sanitizes it, so the
   * identity cannot ride underneath the report — it has to be worn by the error
   * itself, which is why the naming below is the OUTERMOST wrapper on every
   * dialect. It is cleared between entries so a failure in the reads that
   * choose the next entry is not blamed on the last one that succeeded.
   */
  let inFlight: MigrationEntry | undefined;

  const program = async (durable: MigrationContext): Promise<ApplyResult> => {
    await durable.ensureTrackingTable();

    let current = journal;
    let appliedMigrations = preflight.appliedMigrations;
    const applied: MigrationEntry[] = [];
    const committed = new Set<string>();

    for (;;) {
      const entry = selectPending(current.entries, appliedMigrations, to)[0];
      if (!entry) {
        break;
      }
      if (committed.has(entry.name)) {
        // The previous iteration committed this entry's tracking row — inside
        // the same transaction as its DDL where the dialect has one — so seeing
        // it pending again means the tracking write did not stick. Applying it
        // a second time would loop forever and replay its DDL on every pass.
        throw new MigrationError(
          `Migration "${entry.name}" was applied and committed but still reads as pending, so the migration tracking table is not recording this estate's history.`,
          VibORMErrorCode.MIGRATION_FAILED,
          { meta: { migrationName: entry.name } }
        );
      }

      // A journal reread after a commit produced an entry the preflight holds
      // no answer for — either a migration it never saw, or one whose facts
      // changed under a name it did see. Its artifact is read here, through the
      // same validated read, so the statements that run are the ones THIS entry
      // names: still before ITS effects, and still with its own refusal,
      // because a file this command cannot read is not a migration this command
      // failed to apply.
      const statements =
        preflight.artifacts.get(artifactIdentity(entry)) ??
        (await readArtifact(durable, entry));

      inFlight = entry;
      await applyEntry(durable, entry, statements);
      inFlight = undefined;

      committed.add(entry.name);
      applied.push(entry);

      // Reread AFTER the commit, for the same reason the preflight read them
      // before the first one: the next entry is chosen from the journal and the
      // tracking state as they are now, not as they were when this command
      // started.
      const next = await durable.readEstateJournal();
      if (!next) {
        break;
      }
      current = next;
      appliedMigrations = await readValidatedAppliedState(
        durable,
        current.entries
      );
    }

    return { applied, pending: [] };
  };

  try {
    return await (ctx.target.dialect === "mysql"
      ? ctx.sequentialProgram(program)
      : program(ctx));
  } catch (failure) {
    if (inFlight === undefined) {
      throw failure;
    }
    const message =
      failure instanceof Error ? failure.message : String(failure);
    throw new MigrationError(
      `Failed to apply migration "${inFlight.name}": ${message}`,
      VibORMErrorCode.MIGRATION_FAILED,
      {
        cause: failure instanceof Error ? failure : undefined,
        meta: { migrationName: inFlight.name },
      }
    );
  }
}

/**
 * The authoritative applied state, read and agreed with the journal.
 *
 * One owner, so the checksum agreement is proven wherever this state is read —
 * the preflight and every post-commit reread alike — rather than at one of
 * them.
 */
async function readValidatedAppliedState(
  ctx: MigrationContext,
  entries: readonly MigrationEntry[]
): Promise<AppliedMigration[]> {
  const appliedMigrations = await ctx.readAppliedMigrations();
  assertAppliedChecksums(entries, appliedMigrations);
  return appliedMigrations;
}

/**
 * One entry's artifact, read, parsed and classified.
 *
 * Reads storage, decides about text, and performs the read-only live admission
 * that generated SQLite decimal artifacts need. The preflight calls it for
 * every initially pending entry before the first effect. The loop calls the
 * same boundary only on a cache miss after a journal reread, so a newly
 * published entry cannot bypass admission and a preflight-cached entry is not
 * admitted twice.
 */
async function readArtifact(
  ctx: MigrationContext,
  entry: MigrationEntry
): Promise<string[]> {
  const content = await ctx.storage.readMigration(entry);
  if (!content) {
    throw new MigrationError(
      `Migration file not found for "${entry.name}"`,
      VibORMErrorCode.MIGRATION_FILE_NOT_FOUND,
      { meta: { migrationName: entry.name } }
    );
  }

  const statements = parseStatements(content);
  assertArtifactExecutionSafe(statements, ctx.target.dialect, entry.name);
  await assertGeneratedSqliteDecimalArtifactAdmitted(ctx, entry, statements);
  return statements;
}

/**
 * The journal entries not yet applied, honoring an optional `to` bound.
 *
 * One selector for both the dry run and each locked iteration, so a dry run can
 * never disagree with the real thing about which entries are candidates.
 */
function selectPending(
  entries: readonly MigrationEntry[],
  appliedMigrations: readonly { name: string }[],
  to: number | undefined
): MigrationEntry[] {
  const appliedNames = new Set(appliedMigrations.map((m) => m.name));
  const pending = entries.filter((entry) => !appliedNames.has(entry.name));
  return to === undefined
    ? pending
    : pending.filter((entry) => entry.idx <= to);
}

/** Refuses an estate whose applied rows disagree with the journal's checksums. */
function assertAppliedChecksums(
  entries: readonly MigrationEntry[],
  appliedMigrations: readonly { name: string; checksum: string }[]
): void {
  for (const appliedMigration of appliedMigrations) {
    const journalEntry = entries.find((e) => e.name === appliedMigration.name);
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
}

/**
 * Executes one entry's artifact and marks it applied — in one transaction on
 * every dialect that has one to open.
 *
 * MySQL does not. Its DDL commits implicitly (§3.5, and the reference the
 * plan links), so wrapping the artifact and the tracking insert in a literal
 * `BEGIN`/`COMMIT` on the pinned producer manufactures an atomicity nothing
 * delivers: the observed stream was `BEGIN` → `USE` → `CREATE TABLE` (which
 * commits, and with it the `BEGIN`) → the tracking `INSERT`, now in autocommit
 * → a `COMMIT` with nothing left to commit. The plan's letter is "never wrap
 * MySQL DDL in a transaction to manufacture false atomicity", so MySQL runs the
 * same three steps in the same order on the producer it was handed, and the
 * tracking row still lands only after its artifact completed.
 *
 * That producer is ALREADY recording there: the entry is part of the one
 * sequential program its caller opened around the tracking table and everything
 * after it, so this function opens no second one. The boundary a MySQL failure
 * names therefore spans the whole durable command, including the case where the
 * artifact committed and the tracking write that records it did not.
 *
 * The failure is reported by the caller, which is the one place that knows
 * which entry was in flight on both commit models.
 */
async function applyEntry(
  ctx: MigrationContext,
  entry: MigrationEntry,
  statements: readonly string[]
): Promise<void> {
  // A migration file records the same DDL `push` executes, table recreations
  // included, and `PRAGMA foreign_keys` inside a transaction is a no-op — so
  // the pragma has to bracket the transaction, not sit inside it.
  // See `src/migrations/foreign-keys.ts`.
  const lifted = liftForeignKeyPragmas(ctx.driver, [...statements]);

  const runEntry = async (entryCtx: MigrationContext) => {
    await entryCtx.executeMigrationStatements(lifted.statements);
    await entryCtx.markMigrationApplied(entry);
    await assertForeignKeysIntact(entryCtx.driver, lifted.bracket);
  };

  await withForeignKeysLifted(ctx.driver, lifted.bracket, () =>
    ctx.target.dialect === "mysql" ? runEntry(ctx) : ctx.transaction(runEntry)
  );
}

/**
 * Get the status of all migrations (applied vs pending).
 *
 * Genuinely read-only: it proves the namespace, reads tracking with a SELECT,
 * and never creates the tracking table. There is no catch-all around the read —
 * only the exact missing-tracking-table condition means "nothing applied", and
 * permissions, transport and every other failure surface as themselves.
 */
export async function status(
  client: MigrationClient,
  options: {
    dir?: string;
    tableName?: string;
    storageDriver: MigrationStorageDriver;
  }
): Promise<MigrationStatus[]> {
  return readEstateStatus(client, options, "status()");
}

/**
 * Get pending migrations that haven't been applied yet.
 */
export async function pending(
  client: MigrationClient,
  options: {
    dir?: string;
    tableName?: string;
    storageDriver: MigrationStorageDriver;
  }
): Promise<MigrationEntry[]> {
  const statuses = await readEstateStatus(client, options, "pending()");
  return statuses.filter((s) => !s.applied).map((s) => s.entry);
}

/**
 * The shared applied-state report behind `status()` and `pending()`.
 *
 * The command name is a PARAMETER because a refusal has to name the verb the
 * caller actually invoked. `pending()` used to delegate to `status()`, so a
 * refused `migrations.pending()` reported itself as `status()` — a verb the
 * caller never called, in the message and in `meta.command` alike.
 */
async function readEstateStatus(
  client: MigrationClient,
  options: {
    dir?: string;
    tableName?: string;
    storageDriver: MigrationStorageDriver;
  },
  command: string
): Promise<MigrationStatus[]> {
  const { dir, tableName, storageDriver } = options;

  // Use MigrationContext for proper driver delegation
  const ctx = new MigrationContext(client, { dir, tableName, storageDriver });

  // Read journal — absent journal returns the empty result with no provider call
  const journal = await ctx.readEstateJournal();

  if (!journal) {
    return [];
  }

  ctx.admitLive("read-only", command);
  const appliedMigrations = await ctx.readAppliedMigrations();

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

// There is deliberately NO tracking-only rollback verb here. Deleting tracking
// rows while leaving the schema live is exactly the bypass a persisted
// `manual`/`irreversible` policy exists to prevent, and renaming it to another
// convenient public verb would not make it safe. `down()` is the only rollback:
// it executes the down artifact and untracks in one transaction.
