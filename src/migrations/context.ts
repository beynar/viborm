/**
 * Migration Context
 *
 * Encapsulates all migration configuration and provides shared operations
 * like the estate gate, locking, tracking, and query execution.
 *
 * This class is INTERNAL. It is deliberately absent from `viborm/migrations`:
 * its raw, tracking, lock and statement methods would otherwise be a public
 * route around the one estate gate and the one live-capability admission
 * decision. Its options type is likewise internal — the concrete public command
 * option types inline their own fields.
 */

import type { AnyDriver } from "../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../errors";
import {
  admitLiveMigrationCapability,
  type MigrationLiveRequirement,
} from "./admission";
import { type BoundMigrationDriver, getMigrationDriver } from "./drivers";
import {
  resolveCommandDriver,
  runSequentialProgram,
  selectMigrationTarget,
  withLockedMigrationSession,
} from "./pinned-session";
import type { MigrationClient } from "./push";
import type { MigrationStorageDriver } from "./storage";
import { formatMigrationTarget } from "./target";
import type {
  AppliedMigration,
  MigrationEntry,
  MigrationJournal,
  MigrationTarget,
  SchemaSnapshot,
} from "./types";
import {
  createQueryExecutor,
  DEFAULT_MIGRATIONS_DIR,
  DEFAULT_TABLE_NAME,
  type QueryExecutor,
  validateMigrationsDir,
  validateTableName,
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

/**
 * The estate baseline: the validated journal (or none for a fresh estate) and
 * the STORED schema snapshot (or none).
 *
 * `snapshot` is exactly what storage holds. It is deliberately not widened to
 * an empty snapshot here: an absent document and a stored empty one are
 * different facts, and the accessor that reports the snapshot to a caller has
 * to be able to tell them apart. The one consumer that needs a diff INPUT —
 * generation — substitutes the empty baseline itself.
 */
export interface EstateBaseline {
  readonly journal: MigrationJournal | null;
  readonly snapshot: SchemaSnapshot | null;
}

// =============================================================================
// MIGRATION CONTEXT
// =============================================================================

/**
 * Migration context that encapsulates configuration and provides
 * shared operations for migration commands.
 */
export class MigrationContext {
  readonly driver: AnyDriver;
  readonly target: MigrationTarget;
  readonly migrationsDir: string;
  readonly tableName: string;
  readonly executor: QueryExecutor;
  readonly migrationDriver: BoundMigrationDriver;
  readonly storage: MigrationStorageDriver;
  /**
   * Whether this context's producer is the pinned migration session.
   *
   * Only the pinned view sets it. It is the one fact that distinguishes a
   * context that may set session state (target selection) from one that may
   * not, and it cannot be forged from a command's options.
   *
   * The pinned view is BUILT from what the command-driver owner answered, in
   * the same step that reserves the producer (`pinned-session.ts`), so this one
   * fact also records that `migrationDriver` is that answer. They are one
   * event, not two facts to keep in step.
   */
  readonly isPinned: boolean = false;

  constructor(client: MigrationClient, options: MigrationContextOptions) {
    const {
      dir = DEFAULT_MIGRATIONS_DIR,
      tableName = DEFAULT_TABLE_NAME,
      storageDriver,
    } = options;

    this.driver = client.$driver;
    this.migrationsDir = validateMigrationsDir(dir);
    this.tableName = validateTableName(tableName);
    this.executor = createQueryExecutor(this.driver);
    // ONE resolver, reached through the registry binding: the context never
    // constructs a second estate target and never re-decides the dialect.
    this.migrationDriver = getMigrationDriver(this.driver);
    this.target = this.migrationDriver.target;
    this.storage = storageDriver;
  }

  // ===========================================================================
  // ESTATE GATE
  // ===========================================================================

  /**
   * The SINGLE exact-estate-target gate: reads the journal and returns only a
   * journal whose target is this client's estate.
   *
   * `null` means there is no journal — the documented storage-only arms, which
   * connect to nothing. A journal that exists but names another estate is
   * refused HERE, before the caller reads a snapshot or artifact, creates or
   * queries a tracking table, writes storage, or executes any SQL.
   *
   * A dialect difference is `MIGRATION_DIALECT_MISMATCH`. A PostgreSQL schema
   * difference is `MIGRATION_INVALID_STATE`: same dialect, different estate.
   * Changing a MySQL client's database is deliberately NOT a mismatch —
   * database-relative artifacts are the portability contract.
   */
  async readEstateJournal(): Promise<MigrationJournal | null> {
    const journal = await this.storage.readJournal();
    if (!journal) {
      return null;
    }

    if (journal.target.dialect !== this.target.dialect) {
      throw new MigrationError(
        `This migration estate was generated for ${formatMigrationTarget(journal.target)} but the configured client is ${formatMigrationTarget(this.target)}. ` +
          "Migrations cannot be mixed across dialects; point the client at the matching database or regenerate the estate.",
        VibORMErrorCode.MIGRATION_DIALECT_MISMATCH,
        {
          meta: {
            journalTarget: formatMigrationTarget(journal.target),
            clientTarget: formatMigrationTarget(this.target),
          },
        }
      );
    }

    // After the dialect agrees, both namespaces are present or both absent, so
    // one comparison covers the PostgreSQL schema without re-testing the arm.
    const journalNamespace =
      journal.target.dialect === "postgresql"
        ? journal.target.namespace
        : undefined;
    const clientNamespace =
      this.target.dialect === "postgresql" ? this.target.namespace : undefined;
    if (journalNamespace !== clientNamespace) {
      throw new MigrationError(
        `This migration estate was generated for ${formatMigrationTarget(journal.target)} but the configured client is ${formatMigrationTarget(this.target)}. ` +
          "Generated PostgreSQL migration SQL contains its schema, so one estate cannot be applied to another schema; use that schema's own migration storage root.",
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        {
          meta: {
            journalTarget: formatMigrationTarget(journal.target),
            clientTarget: formatMigrationTarget(this.target),
          },
        }
      );
    }

    return journal;
  }

  /**
   * The journal/snapshot consistency table, for the one caller that needs a
   * baseline to diff against (generation).
   *
   * | journal | snapshot | verdict |
   * | --- | --- | --- |
   * | absent | absent | fresh estate; no stored baseline |
   * | absent | present | refuse; the snapshot has no target proof |
   * | matching, empty | absent | valid target-bound empty estate |
   * | matching, any | present | valid |
   * | matching, non-empty | absent | refuse; history lost its baseline |
   * | mismatched/invalid | either | refused by the gate, before deserialization |
   *
   * The snapshot is deserialized only after the gate passes, so a mismatched
   * estate never parses another estate's snapshot.
   */
  async readEstateBaseline(): Promise<EstateBaseline> {
    const journal = await this.readEstateJournal();
    const snapshot = await this.storage.readSnapshot();

    if (!journal) {
      if (snapshot) {
        throw new MigrationError(
          "This migration storage holds a schema snapshot but no journal, so nothing proves which estate the snapshot describes. " +
            "Restore the journal, or remove the snapshot to start a fresh estate.",
          VibORMErrorCode.MIGRATION_INVALID_STATE,
          { meta: { clientTarget: formatMigrationTarget(this.target) } }
        );
      }
      return { journal: null, snapshot: null };
    }

    if (!snapshot && journal.entries.length > 0) {
      throw new MigrationError(
        `This migration estate has ${journal.entries.length} migration(s) in its journal but no schema snapshot, so the baseline every generated migration was diffed against is gone. ` +
          "Restore the snapshot; generating against an empty baseline would re-emit the whole schema.",
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        { meta: { clientTarget: formatMigrationTarget(this.target) } }
      );
    }

    return { journal, snapshot };
  }

  // ===========================================================================
  // LIVE-CAPABILITY ADMISSION
  // ===========================================================================

  /**
   * Admits this command to live state through the one shared owner. The
   * context does not decide anything here; it hands the owner the bound
   * migration driver, which retains the exact execution driver.
   */
  admitLive(requirement: MigrationLiveRequirement, command: string): void {
    admitLiveMigrationCapability(this.migrationDriver, requirement, command);
  }

  // ===========================================================================
  // MIGRATION TRACKING TABLE
  // ===========================================================================

  /**
   * Creates the migrations tracking table.
   *
   * This is a WRITE, and the only one that creates tracking. It belongs to
   * admitted effectful owners; no read path reaches it, which is what makes
   * `readAppliedMigrations()` honestly read-only.
   *
   * The command view comes FIRST because this statement is DDL, and §10's
   * letter is that a configured-but-absent namespace "fails after only its
   * read-only catalog proof and before DDL, tracking mutation, or storage
   * write" — obtaining the view IS that proof. Without it, a PostgreSQL estate
   * configured for a schema nobody created reported
   * `CREATE TABLE "ghost"."_viborm_migrations"`'s raw provider failure instead
   * of the designed refusal.
   */
  async ensureTrackingTable(): Promise<void> {
    const command = await this.commandDriver();
    const ddl = command.generateCreateTrackingTable(this.tableName);
    await this.driver._executeRaw(ddl);
  }

  /**
   * The migration driver THIS context's live statements render from.
   *
   * One owner answers it for every context: `pinned-session.ts`'s
   * {@link resolveCommandDriver}, whose act of answering is the namespace
   * proof. A locked context already holds what that owner returned — the pinned
   * view is BUILT from it, which is exactly what `isPinned` records — so asking
   * again would be a second catalog round trip for an answer this context
   * already has, and a second namespace source is precisely what §5.2 forbids.
   * An unlocked read-only command has no such answer yet and asks here, on its
   * own producer.
   *
   * SQLite reserves no session and proves nothing, so both arms hand back the
   * same driver and neither issues a statement.
   */
  private commandDriver(): Promise<BoundMigrationDriver> {
    return this.isPinned
      ? Promise.resolve(this.migrationDriver)
      : resolveCommandDriver(this.driver, this.migrationDriver);
  }

  // ===========================================================================
  // APPLIED MIGRATIONS
  // ===========================================================================

  /**
   * Reads applied migrations. NEVER creates the tracking table.
   *
   * The order is exact: obtain the command view — which is where the configured
   * namespace is proven — then read THROUGH it. The proof cannot be skipped,
   * because PostgreSQL reports a missing schema and a missing table with the
   * same SQLSTATE, so translating the failure first would report an absent
   * estate as "zero migrations applied". Rendering through it cannot be skipped
   * either: MySQL's proof accepts one case-folded candidate, so the tracking
   * table has to be named with the spelling the server answered with, not the
   * configured one that proof admitted.
   *
   * Absence of the tracking table is established either positively (SQLite's
   * exact `sqlite_schema` lookup) or by the dialect's exact missing-table
   * translation. Every other failure — permissions, transport, a different
   * missing relation — surfaces.
   *
   * Callers admit their own live requirement at their command boundary before
   * reaching here; this is the shared applied-state reader, not an admission
   * point.
   */
  async readAppliedMigrations(): Promise<AppliedMigration[]> {
    const command = await this.commandDriver();

    const probe = command.generateTrackingTableProbe(this.tableName);
    if (probe) {
      const found = await this.executor(probe.sql, probe.params);
      if (found.length === 0) {
        return [];
      }
    }

    const sqlStr = command.generateSelectAppliedMigrations(this.tableName);

    let rows: unknown[];
    try {
      rows = await this.executor(sqlStr);
    } catch (error) {
      if (command.isMissingTrackingTable(error, this.tableName)) {
        return [];
      }
      throw error;
    }

    return rows.map((row) => readAppliedMigrationRow(row));
  }

  /**
   * Mark a migration as applied in the database.
   */
  async markMigrationApplied(entry: MigrationEntry): Promise<void> {
    const { sql } = this.migrationDriver.generateInsertMigration(
      this.tableName
    );
    await this.executor(sql, [entry.name, entry.checksum]);
  }

  /**
   * Mark a migration as rolled back (remove from tracking table).
   */
  async markMigrationRolledBack(name: string): Promise<void> {
    const { sql } = this.migrationDriver.generateDeleteMigration(
      this.tableName
    );
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
   * Runs `fn` under this estate's migration lock, on ONE pinned session.
   *
   * The callback receives a context whose producer IS the connection holding
   * the lock, so its authoritative reads, its DDL, its tracking writes and any
   * transaction it opens all run there. It replaced a `withLock` that acquired,
   * worked and released through whichever pooled connections happened to be
   * free — which protected nothing.
   *
   * The lock owner is `pinned-session.ts`; this method exists so no command
   * reaches the driver primitive itself.
   */
  withLockedSession<T>(
    fn: (locked: MigrationContext) => Promise<T>
  ): Promise<T> {
    return withLockedMigrationSession(this, fn);
  }

  /**
   * Selects the live migration target on the pinned session, if this dialect
   * has one to select.
   *
   * Called once when the lock is taken and again immediately before every
   * relative artifact — never only once for the session, because a manual
   * artifact is allowed to issue its own `USE` and the next artifact must still
   * land on the configured target (§10). A no-op on every dialect whose
   * statements are qualified.
   */
  async reassertMigrationTarget(): Promise<void> {
    if (this.migrationDriver.generateSelectTarget() === null) {
      return;
    }
    if (!this.isPinned) {
      throw new MigrationError(
        "Refusing to select a live migration target outside a pinned session. " +
          "Session state set on a pooled connection outlives the statement that set it and leaks into unrelated queries, which is exactly what the pinned session exists to prevent.",
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        { meta: { target: formatMigrationTarget(this.target) } }
      );
    }
    await selectMigrationTarget(this.driver, this.migrationDriver);
  }

  // ===========================================================================
  // UTILITIES
  // ===========================================================================

  /**
   * Execute a function within a transaction.
   * The callback receives a transaction-bound context.
   */
  async transaction<T>(
    fn: (txCtx: MigrationContext) => Promise<T>
  ): Promise<T> {
    return this.driver.withTransaction((txDriver) => fn(this.on(txDriver)));
  }

  /**
   * Runs `fn` as ONE MySQL sequential program: no transaction, and a failure
   * reports the last statement that completed rather than claiming a rollback
   * MySQL cannot perform.
   *
   * The sibling of {@link transaction}, and the reason the two sit together:
   * they are the two commit models this layer has, and every command that
   * changes live state picks one of them explicitly rather than letting a
   * generic dispatch open a transaction on a dialect that would commit out from
   * under it. The owner is `pinned-session.ts`; this method exists so no
   * command reaches the driver primitive itself.
   */
  sequentialProgram<T>(fn: (ctx: MigrationContext) => Promise<T>): Promise<T> {
    return runSequentialProgram(
      this.driver,
      this.migrationDriver,
      (recording) => fn(this.on(recording))
    );
  }

  /**
   * This context on another producer: same estate, same command driver, same
   * pinned status.
   *
   * Defined rather than assigned because the two facts it replaces are
   * readonly. Both commit models build their view here, so neither can forget
   * to rebuild the executor over the producer it actually runs on.
   */
  private on(producer: AnyDriver): MigrationContext {
    const view: MigrationContext = Object.create(this);
    Object.defineProperties(view, {
      driver: { value: producer },
      executor: { value: createQueryExecutor(producer) },
    });
    return view;
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
   * Uses the following priority for atomicity:
   * 1. Native batch (if driver.supportsBatch) - D1 bindings, Neon HTTP
   * 2. Transaction wrapper (if driver.supportsTransactions) - most drivers
   * 3. Sequential execution with warning (no atomicity)
   *
   * @param statements - Array of SQL statements to execute
   */
  async executeMigrationStatements(statements: string[]): Promise<void> {
    // Filter and normalize statements
    const queries = statements
      .map((stmt) => stmt.trim())
      .filter((stmt) => stmt && !stmt.startsWith("--"))
      .map((stmt) => ({
        sql: stmt.endsWith(";") ? stmt : `${stmt};`,
        params: [],
      }));

    if (queries.length === 0) {
      return;
    }

    // A generated MySQL artifact is database-RELATIVE, so the target is
    // selected on the producer immediately before it runs — every artifact,
    // never once for the session, because the previous one may have been a
    // manual artifact carrying its own `USE`.
    await this.reassertMigrationTarget();

    if (this.target.dialect === "mysql") {
      // MySQL commits DDL implicitly, so a transaction around these statements
      // would manufacture an atomicity that does not exist, and the generic
      // batch dispatch would open one. Sequential execution on the producer is
      // the honest form: each statement's own commit boundary is real, and no
      // caller claims a rollback MySQL cannot perform (§6.2). The boundary this
      // loop reaches is recorded by the producer — every caller runs it inside
      // {@link sequentialProgram} — so the loop itself stays bookkeeping-free.
      for (const query of queries) {
        await this.driver._executeRaw(query.sql, query.params);
      }
      return;
    }

    // Use driver's _executeBatch which handles priority automatically:
    // 1. Native batch if supportsBatch
    // 2. Transaction wrapper if supportsTransactions
    // 3. Sequential execution (with warning in _executeBatch)
    await this.driver._executeBatch(queries);
  }
}

/**
 * Reads one tracking row. The row is provider-shaped data, so its three fields
 * are reached as untyped keys rather than asserted into a declared shape.
 */
function readAppliedMigrationRow(row: unknown): AppliedMigration {
  const source: Record<string, unknown> =
    typeof row === "object" && row !== null ? { ...row } : {};
  return {
    name: String(source.name),
    checksum: String(source.checksum),
    appliedAt: readAppliedAt(source.applied_at),
  };
}

/**
 * Providers hand back a timestamp as a driver-parsed `Date`, an epoch number,
 * or the text the column holds; each construction is different, so the value
 * is classified rather than stringified.
 */
function readAppliedAt(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "number") {
    return new Date(value);
  }
  return new Date(String(value));
}
