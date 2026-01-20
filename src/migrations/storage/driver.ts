/**
 * Migration Storage Driver
 *
 * Abstract base class for migration file storage.
 * Concrete implementations handle filesystem, S3, database, etc.
 */

import { createHash } from "node:crypto";
import type {
  Dialect,
  MigrationEntry,
  MigrationJournal,
  SchemaSnapshot,
} from "../types";

// =============================================================================
// CONSTANTS
// =============================================================================

const JOURNAL_VERSION = "1";
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
   */
  async readJournal(): Promise<MigrationJournal | null> {
    const content = await this.get(JOURNAL_PATH);
    if (!content) {
      return null;
    }
    return JSON.parse(content) as MigrationJournal;
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
  async writeDownMigration(entry: MigrationEntry, content: string): Promise<void> {
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
export function getNextMigrationIndex(journal: MigrationJournal | null): number {
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
 */
export function createMigrationEntry(
  idx: number,
  name: string,
  sqlContent: string,
  tag?: string
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
    ...(tag ? { tag } : {}),
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
