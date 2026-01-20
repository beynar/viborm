/**
 * Migration Client
 *
 * Provides a unified API for all migration operations with shared configuration.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import { type DownOptions, type DownResult, down } from "./apply/down";
import {
  type ApplyResult,
  apply,
  pending,
  rollback,
  status,
} from "./apply/index";
import { generate, preview } from "./generate";
import {
  type MigrationClient,
  type PushOptions,
  type PushResult,
  push,
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
   * List all migrations from the journal.
   * Useful for displaying available migrations (e.g., before squash).
   */
  list(): Promise<MigrationEntry[]>;

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
   * Rollback migrations (remove from tracking table only).
   */
  rollback(options?: { count?: number }): Promise<MigrationEntry[]>;

  /**
   * Roll back migrations with down SQL execution.
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

  return {
    get storage() {
      return requireStorage("storage");
    },

    // =========================================================================
    // READ OPERATIONS
    // =========================================================================

    list: async () => {
      const storage = requireStorage("list");
      const journal = await storage.readJournal();
      return journal?.entries ?? [];
    },

    journal: () => requireStorage("journal").readJournal(),

    snapshot: () => requireStorage("snapshot").readSnapshot(),

    read: (entry: MigrationEntry) =>
      requireStorage("read").readMigration(entry),

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

    rollback: (opts = {}) =>
      rollback(client, { ...getContextOptions(), ...opts }),

    down: (opts = {}) => down(client, { ...getContextOptions(), ...opts }),

    reset: (opts = {}) => reset(client, { ...getContextOptions(), ...opts }),

    squash: (opts = {}) => squash(client, { ...getContextOptions(), ...opts }),

    // Push works without storage driver
    push: (opts = {}) =>
      push(client, { ...opts, _storageDriver: storageDriver }),
  };
}
