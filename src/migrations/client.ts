/**
 * Migration Client
 *
 * Provides a unified API for all migration operations with shared configuration.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import { type DownOptions, type DownResult, down } from "./apply/down";
import { type ApplyResult, apply, pending, status } from "./apply/index";
import { MigrationContext } from "./context";
import { generate, preview } from "./generate";
import {
  type MigrationClient,
  type PushOptions,
  type PushResult,
  pushWithDeclaredTrackingTable,
} from "./push";
import { type ResetOptions, type ResetResult, reset } from "./reset";
import { type SquashOptions, type SquashResult, squash } from "./squash";
import type { MigrationStorageDriver } from "./storage/driver";
import type {
  ApplyOptions,
  GenerateOptions,
  GenerateResult,
  MigrationEntry,
  MigrationJournal,
  MigrationStatus,
  SchemaSnapshot,
} from "./types";
import { DEFAULT_TABLE_NAME, validateTableName } from "./utils";

// =============================================================================
// TYPES
// =============================================================================

export interface MigrationClientOptions {
  /**
   * Storage driver for migration files.
   * Required for file-based migration operations (generate, apply, down, etc.).
   * Not required for push() which works directly with the database.
   *
   * @example
   * ```typescript
   * import { createFsStorageDriver } from "viborm/migrations/storage/fs";
   *
   * const migrations = createMigrationClient(client, {
   *   storageDriver: createFsStorageDriver("./migrations"),
   * });
   * ```
   */
  storageDriver?: MigrationStorageDriver;
  /** Migration tracking table name (default: _viborm_migrations) */
  tableName?: string;
}

/**
 * Migration client instance with all migration operations.
 */
export interface Migrations {
  /** The storage driver used by this client */
  readonly storage: MigrationStorageDriver;

  // ===========================================================================
  // READ OPERATIONS
  // ===========================================================================

  /**
   * List all migrations from this estate's journal.
   * Useful for displaying available migrations (e.g., before squash).
   */
  list(): Promise<readonly MigrationEntry[]>;

  /**
   * Get the migration journal.
   * Returns null if no journal exists yet.
   */
  journal(): Promise<MigrationJournal | null>;

  /**
   * Get the current schema snapshot.
   * Returns null if no snapshot exists yet.
   */
  snapshot(): Promise<SchemaSnapshot | null>;

  /**
   * Read a migration's SQL content.
   * Returns null if migration file doesn't exist.
   */
  read(entry: MigrationEntry): Promise<string | null>;

  /**
   * Get the status of all migrations (journal + applied state).
   */
  status(): Promise<MigrationStatus[]>;

  /**
   * Get pending migrations that haven't been applied.
   */
  pending(): Promise<MigrationEntry[]>;

  // ===========================================================================
  // WRITE OPERATIONS
  // ===========================================================================

  /**
   * Generate a new migration by comparing schema with previous snapshot.
   */
  generate(
    options?: Omit<GenerateOptions, "dir" | "storageDriver">
  ): Promise<GenerateResult>;

  /**
   * Preview what migration would be generated without writing files.
   */
  preview(
    options?: Omit<GenerateOptions, "dir" | "storageDriver" | "dryRun">
  ): Promise<GenerateResult>;

  /**
   * Apply pending migrations to the database.
   */
  apply(options?: ApplyOptions): Promise<ApplyResult>;

  /**
   * Roll back migrations by executing their down artifacts.
   *
   * This is the ONLY rollback verb. There is no tracking-only variant: an
   * entry's persisted rollback policy (`manual`, `irreversible`) cannot be
   * bypassed by deleting tracking rows while the schema stays live.
   */
  down(
    options?: Omit<DownOptions, "dir" | "tableName" | "storageDriver">
  ): Promise<DownResult>;

  /**
   * Reset the database (drop all tables and re-apply migrations).
   */
  reset(
    options?: Omit<ResetOptions, "dir" | "tableName" | "storageDriver">
  ): Promise<ResetResult>;

  /**
   * Squash multiple migrations into one.
   */
  squash(
    options?: Omit<SquashOptions, "dir" | "tableName" | "storageDriver">
  ): Promise<SquashResult>;

  /**
   * Push schema changes directly to the database without creating migration files.
   * Useful for development and rapid prototyping.
   */
  push(options?: PushOptions): Promise<PushResult>;
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Creates a migration client with shared configuration.
 *
 * @example
 * ```typescript
 * // For push-only usage (e.g., Cloudflare Workers)
 * const migrations = createMigrationClient(client);
 * await migrations.push();
 * ```
 *
 * @example
 * ```typescript
 * // For file-based migrations
 * import { createFsStorageDriver } from "viborm/migrations/storage/fs";
 *
 * const migrations = createMigrationClient(client, {
 *   storageDriver: createFsStorageDriver("./migrations"),
 * });
 *
 * await migrations.generate({ name: "add-users" });
 * await migrations.apply();
 * ```
 */
export function createMigrationClient(
  client: MigrationClient,
  options: MigrationClientOptions = {}
): Migrations {
  const { storageDriver, tableName } = options;

  // Helper to get storage or throw helpful error
  const requireStorage = (operation: string): MigrationStorageDriver => {
    if (!storageDriver) {
      throw new MigrationError(
        `Storage driver required for ${operation}(). ` +
          "File-based migration operations require a storage driver.\n\n" +
          "Example:\n" +
          '  import { createFsStorageDriver } from "viborm/migrations/storage/fs";\n' +
          "  const migrations = createMigrationClient(client, {\n" +
          '    storageDriver: createFsStorageDriver("./migrations"),\n' +
          "  });\n\n" +
          "For push-only usage (no migration files), use migrations.push() directly.",
        VibORMErrorCode.MIGRATION_STORAGE_REQUIRED
      );
    }
    return storageDriver;
  };

  // Shared options for commands that use MigrationContext
  const getContextOptions = () => ({
    tableName,
    storageDriver: requireStorage("context"),
  });

  // Every NAMED accessor is estate-bound: it reaches storage through the one
  // context gate, so a client configured for one estate cannot list, read or
  // report another's history. Only `migrations.storage` stays unbound, and it
  // cannot execute database effects.
  const boundContext = (operation: string) =>
    new MigrationContext(client, {
      tableName,
      storageDriver: requireStorage(operation),
    });

  return {
    get storage() {
      return requireStorage("storage");
    },

    // =========================================================================
    // READ OPERATIONS
    // =========================================================================

    list: async () => {
      const journal = await boundContext("list").readEstateJournal();
      return journal?.entries ?? [];
    },

    journal: () => boundContext("journal").readEstateJournal(),

    snapshot: async () => {
      // The gate first — §3.2's state table refuses a snapshot with no journal
      // and another estate's journal — then exactly what storage holds. `null`
      // means "no snapshot document", which is what the accessor documents; an
      // empty snapshot is a diff input generation synthesizes, never something
      // this accessor may fabricate on storage's behalf.
      const { snapshot } = await boundContext("snapshot").readEstateBaseline();
      return snapshot;
    },

    read: async (entry: MigrationEntry) => {
      const ctx = boundContext("read");
      const journal = await ctx.readEstateJournal();
      const member = journal?.entries.find(
        (candidate) =>
          candidate.idx === entry.idx &&
          candidate.name === entry.name &&
          candidate.checksum === entry.checksum
      );
      if (!member) {
        throw new MigrationError(
          `Migration "${entry.name}" (idx ${entry.idx}) is not a member of this estate's journal, so its artifact cannot be read through the migration client. ` +
            "A caller-fabricated entry or a fresh estate cannot turn `read()` into an unbound storage reader; use `migrations.storage` for raw access.",
          VibORMErrorCode.MIGRATION_NOT_FOUND,
          { meta: { migrationName: entry.name } }
        );
      }
      return ctx.storage.readMigration(member);
    },

    status: () => status(client, getContextOptions()),

    pending: () => pending(client, getContextOptions()),

    // =========================================================================
    // WRITE OPERATIONS
    // =========================================================================

    generate: (opts = {}) =>
      generate(client, { ...opts, storageDriver: requireStorage("generate") }),

    preview: (opts = {}) =>
      preview(client, { ...opts, storageDriver: requireStorage("preview") }),

    apply: (opts = {}) => apply(client, { ...getContextOptions(), ...opts }),

    down: (opts = {}) => down(client, { ...getContextOptions(), ...opts }),

    reset: (opts = {}) => reset(client, { ...getContextOptions(), ...opts }),

    squash: (opts = {}) => squash(client, { ...getContextOptions(), ...opts }),

    // Push works without storage driver — and is given none. A push that could
    // reach migration storage could rewrite the estate's history while
    // synchronizing a schema. The ONE thing that travels is the normalized
    // tracking-table NAME, so a force-reset clears the rows of the table this
    // client declared instead of guessing which inventoried table is special
    // (§6.2). It grants no storage access and no journal claim.
    push: (opts = {}) =>
      pushWithDeclaredTrackingTable(
        client,
        opts,
        validateTableName(tableName ?? DEFAULT_TABLE_NAME)
      ),
  };
}
