/**
 * Migration Storage Driver
 *
 * Abstract base class for migration file storage.
 * Concrete implementations handle filesystem, S3, database, etc.
 */

import { createHash } from "node:crypto";
import { MigrationError, VibORMErrorCode } from "../../errors";
import type {
  Dialect,
  MigrationEntry,
  MigrationJournal,
  MigrationMode,
  MigrationRollback,
  SchemaSnapshot,
} from "../types";

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Journal format version. Bumped "1" → "2" when migration entries gained their
 * required `mode`/`rollback` policy. There is deliberately no legacy reader and
 * no dual serializer: a version-"1" journal is refused, not upgraded.
 */
const JOURNAL_VERSION = "2";
const JOURNAL_PATH = "meta/_journal.json";
const SNAPSHOT_PATH = "meta/_snapshot.json";
const BACKUP_PREFIX = "meta/_backup/";

// =============================================================================
// ABSTRACT STORAGE DRIVER
// =============================================================================

/**
 * Abstract base class for migration storage drivers.
 * Provides high-level operations for managing migration files.
 *
 * Concrete drivers must implement:
 * - `get(path)`: Read file content
 * - `put(path, content)`: Write file content
 * - `delete(path)`: Delete file
 */
export abstract class MigrationStorageDriver {
  readonly driverName: string;

  constructor(driverName: string) {
    this.driverName = driverName;
  }

  // ===========================================================================
  // ABSTRACT METHODS - Concrete drivers implement these
  // ===========================================================================

  /**
   * Read file content.
   * @param path - Relative path (e.g., "0000_initial.sql", "meta/_journal.json")
   * @returns File content as string, or null if file doesn't exist
   */
  abstract get(path: string): Promise<string | null>;

  /**
   * Write file content. Creates directories as needed.
   * @param path - Relative path
   * @param content - Content to write
   */
  abstract put(path: string, content: string): Promise<void>;

  /**
   * Delete a file. No-op if file doesn't exist.
   * @param path - Relative path
   */
  abstract delete(path: string): Promise<void>;

  // ===========================================================================
  // JOURNAL
  // ===========================================================================

  /**
   * Read the migration journal.
   * Returns null if no journal exists.
   *
   * This is the SINGLE journal-reading funnel: every verb (apply, down, squash,
   * reset, status, the client accessors) reaches the journal through here, so
   * the format/policy invariant is checked exactly once. After this call
   * `entry.mode` and `entry.rollback` are total — no caller re-checks them.
   */
  async readJournal(): Promise<MigrationJournal | null> {
    const content = await this.get(JOURNAL_PATH);
    if (!content) {
      return null;
    }
    const parsed: unknown = JSON.parse(content);
    assertValidJournal(parsed);
    return parsed;
  }

  /**
   * Write the migration journal.
   */
  async writeJournal(journal: MigrationJournal): Promise<void> {
    await this.put(JOURNAL_PATH, JSON.stringify(journal, null, 2));
  }

  /**
   * Get or create a journal for the given dialect.
   */
  async getOrCreateJournal(dialect: Dialect): Promise<MigrationJournal> {
    const existing = await this.readJournal();
    if (existing) {
      if (existing.dialect !== dialect) {
        throw new Error(
          `Journal dialect mismatch: expected "${dialect}", found "${existing.dialect}". ` +
            "Cannot mix migrations from different database dialects."
        );
      }
      return existing;
    }
    return createEmptyJournal(dialect);
  }

  // ===========================================================================
  // SNAPSHOT
  // ===========================================================================

  /**
   * Read the schema snapshot.
   * Returns null if no snapshot exists.
   */
  async readSnapshot(): Promise<SchemaSnapshot | null> {
    const content = await this.get(SNAPSHOT_PATH);
    if (!content) {
      return null;
    }
    return JSON.parse(content) as SchemaSnapshot;
  }

  /**
   * Write the schema snapshot.
   */
  async writeSnapshot(snapshot: SchemaSnapshot): Promise<void> {
    await this.put(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  }

  /**
   * Get the snapshot or return an empty one.
   */
  async getSnapshotOrEmpty(): Promise<SchemaSnapshot> {
    return (await this.readSnapshot()) ?? createEmptySnapshot();
  }

  // ===========================================================================
  // MIGRATION FILES
  // ===========================================================================

  /**
   * Read a migration file content.
   */
  async readMigration(entry: MigrationEntry): Promise<string | null> {
    const path = formatMigrationPath(entry);
    return this.get(path);
  }

  /**
   * Write a migration file.
   */
  async writeMigration(entry: MigrationEntry, content: string): Promise<void> {
    const path = formatMigrationPath(entry);
    await this.put(path, content);
  }

  /**
   * Delete a migration file.
   */
  async deleteMigration(entry: MigrationEntry): Promise<void> {
    const path = formatMigrationPath(entry);
    await this.delete(path);
  }

  /**
   * Check if a migration file exists.
   */
  async migrationExists(entry: MigrationEntry): Promise<boolean> {
    const content = await this.readMigration(entry);
    return content !== null;
  }

  // ===========================================================================
  // DOWN MIGRATIONS
  // ===========================================================================

  /**
   * Read a down migration file if it exists.
   */
  async readDownMigration(entry: MigrationEntry): Promise<string | null> {
    const path = `meta/_down/${formatMigrationFilename(entry)}`;
    return this.get(path);
  }

  /**
   * Write a down migration file.
   */
  async writeDownMigration(
    entry: MigrationEntry,
    content: string
  ): Promise<void> {
    const path = `meta/_down/${formatMigrationFilename(entry)}`;
    await this.put(path, content);
  }

  // ===========================================================================
  // BACKUP
  // ===========================================================================

  /**
   * Backup a migration file to the backup directory.
   * Returns the backup path, or null if the file doesn't exist.
   */
  async backupMigration(entry: MigrationEntry): Promise<string | null> {
    const content = await this.readMigration(entry);
    if (!content) {
      return null;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${BACKUP_PREFIX}${timestamp}_${formatMigrationFilename(entry)}`;
    await this.put(backupPath, content);
    return backupPath;
  }

  /**
   * Archive a migration (backup and delete).
   * Returns the backup path, or null if the file doesn't exist.
   */
  async archiveMigration(entry: MigrationEntry): Promise<string | null> {
    const backupPath = await this.backupMigration(entry);
    if (backupPath) {
      await this.deleteMigration(entry);
    }
    return backupPath;
  }
}

// =============================================================================
// JOURNAL VALIDATION (one invariant, one throw site)
// =============================================================================

function refuseJournal(description: string): never {
  throw new MigrationError(
    `Migration journal cannot be read: ${description}. VibORM is unreleased and ships no journal migrator or legacy reader — regenerate the migration estate against the current format instead.`,
    VibORMErrorCode.MIGRATION_INVALID_STATE
  );
}

/**
 * The single journal invariant: the journal this process reads is a complete,
 * policy-bearing journal of the CURRENT format. Version drift and a
 * policy-less or malformed entry are the same failure — an unreadable journal.
 *
 * The input is untrusted JSON, so every field is reached reflectively; the
 * assertion signature is what lets `readJournal` return the parsed value
 * without a type assertion.
 */
function assertValidJournal(
  parsed: unknown
): asserts parsed is MigrationJournal {
  if (typeof parsed !== "object" || parsed === null) {
    refuseJournal("the journal file does not contain a JSON object");
  }
  const version: unknown = Reflect.get(parsed, "version");
  if (version !== JOURNAL_VERSION) {
    refuseJournal(
      `it declares format version ${JSON.stringify(version)} but this build reads version ${JSON.stringify(JOURNAL_VERSION)} (entries carry a required mode and rollback policy)`
    );
  }
  const entries: unknown = Reflect.get(parsed, "entries");
  if (!Array.isArray(entries)) {
    refuseJournal("its `entries` field is not an array");
  }
  for (const entry of entries) {
    assertEntryPolicy(entry);
  }
}

function assertEntryPolicy(entry: unknown): void {
  if (typeof entry !== "object" || entry === null) {
    refuseJournal("one of its entries is not a JSON object");
  }
  const label = `entry ${JSON.stringify(Reflect.get(entry, "name"))} (idx ${JSON.stringify(Reflect.get(entry, "idx"))})`;

  const mode: unknown = Reflect.get(entry, "mode");
  if (mode !== "generated" && mode !== "manual") {
    refuseJournal(
      `${label} declares no valid mode (found ${JSON.stringify(mode)})`
    );
  }

  const rollback: unknown = Reflect.get(entry, "rollback");
  if (typeof rollback !== "object" || rollback === null) {
    refuseJournal(`${label} carries no rollback policy`);
  }
  const kind: unknown = Reflect.get(rollback, "kind");
  if (kind === "automatic" || kind === "manual") {
    return;
  }
  if (kind === "irreversible") {
    const reason: unknown = Reflect.get(rollback, "reason");
    if (typeof reason !== "string" || reason.trim().length === 0) {
      refuseJournal(
        `${label} is marked irreversible but states no reason, so a rollback could not explain itself`
      );
    }
    return;
  }
  refuseJournal(
    `${label} declares an unknown rollback kind ${JSON.stringify(kind)}`
  );
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Format migration filename from entry.
 */
export function formatMigrationFilename(entry: MigrationEntry): string {
  const paddedIdx = String(entry.idx).padStart(4, "0");
  return `${paddedIdx}_${entry.name}.sql`;
}

/**
 * Format migration path from entry.
 */
export function formatMigrationPath(entry: MigrationEntry): string {
  return formatMigrationFilename(entry);
}

/**
 * Create an empty journal.
 */
export function createEmptyJournal(dialect: Dialect): MigrationJournal {
  return {
    version: JOURNAL_VERSION,
    dialect,
    entries: [],
  };
}

/**
 * Create an empty snapshot.
 */
export function createEmptySnapshot(): SchemaSnapshot {
  return {
    tables: [],
    enums: [],
  };
}

/**
 * Get the next migration index.
 */
export function getNextMigrationIndex(
  journal: MigrationJournal | null
): number {
  if (!journal || journal.entries.length === 0) {
    return 0;
  }
  const lastEntry = journal.entries[journal.entries.length - 1];
  return lastEntry ? lastEntry.idx + 1 : 0;
}

/**
 * Generate a timestamp version string (YYYYMMDDHHmmss).
 */
export function generateVersion(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

/**
 * Calculate SHA256 checksum.
 */
export function calculateChecksum(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Convert a name to kebab-case.
 */
export function toKebabCase(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Create a migration entry.
 *
 * The policy is a required argument, not an option with a default: an entry
 * whose rollback policy defaulted would be exactly the bypass the journal
 * validator exists to close (an irreversible migration silently rolling back
 * as automatic). Every construction site must state its policy.
 */
export function createMigrationEntry(
  idx: number,
  name: string,
  sqlContent: string,
  policy: {
    mode: MigrationMode;
    rollback: MigrationRollback;
    tag?: string;
  }
): MigrationEntry {
  const kebabName = toKebabCase(name);
  const version = generateVersion();
  const checksum = calculateChecksum(sqlContent);

  return {
    idx,
    version,
    name: kebabName,
    when: Date.now(),
    checksum,
    mode: policy.mode,
    rollback: policy.rollback,
    ...(policy.tag ? { tag: policy.tag } : {}),
  };
}

/**
 * Add an entry to the journal.
 */
export function addJournalEntry(
  journal: MigrationJournal,
  entry: MigrationEntry
): MigrationJournal {
  return {
    ...journal,
    entries: [...journal.entries, entry],
  };
}

/**
 * Validate journal dialect.
 */
export function validateJournalDialect(
  journal: MigrationJournal,
  expectedDialect: Dialect
): void {
  if (journal.dialect !== expectedDialect) {
    throw new Error(
      `Journal dialect mismatch: expected "${expectedDialect}", found "${journal.dialect}". ` +
        "Cannot apply migrations from a different database dialect."
    );
  }
}
