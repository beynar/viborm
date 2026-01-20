import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Dialect, MigrationEntry, MigrationJournal } from "../types";

const JOURNAL_VERSION = "1";
const JOURNAL_FILENAME = "_journal.json";
const META_DIR = "meta";

/**
 * Get the path to the journal file
 */
export function getJournalPath(migrationsDir: string): string {
  return join(migrationsDir, META_DIR, JOURNAL_FILENAME);
}

/**
 * Get the path to the meta directory
 */
export function getMetaDir(migrationsDir: string): string {
  return join(migrationsDir, META_DIR);
}

/**
 * Ensure the migrations directory and meta directory exist
 */
export function ensureMigrationsDirs(migrationsDir: string): void {
  const metaDir = getMetaDir(migrationsDir);
  if (!existsSync(metaDir)) {
    mkdirSync(metaDir, { recursive: true });
  }
}

/**
 * Read the migration journal from disk
 * Returns null if the journal doesn't exist (first migration)
 */
export function readJournal(migrationsDir: string): MigrationJournal | null {
  const journalPath = getJournalPath(migrationsDir);

  if (!existsSync(journalPath)) {
    return null;
  }

  const content = readFileSync(journalPath, "utf-8");
  return JSON.parse(content) as MigrationJournal;
}

/**
 * Write the migration journal to disk
 */
export function writeJournal(
  migrationsDir: string,
  journal: MigrationJournal
): void {
  ensureMigrationsDirs(migrationsDir);
  const journalPath = getJournalPath(migrationsDir);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2), "utf-8");
}

/**
 * Create a new empty journal for the given dialect
 */
export function createEmptyJournal(dialect: Dialect): MigrationJournal {
  return {
    version: JOURNAL_VERSION,
    dialect,
    entries: [],
  };
}

/**
 * Get the next migration index from the journal
 */
export function getNextMigrationIndex(
  journal: MigrationJournal | null
): number {
  if (!journal || journal.entries.length === 0) {
    return 0;
  }
  const lastEntry = journal.entries.at(-1);
  return lastEntry ? lastEntry.idx + 1 : 0;
}

/**
 * Generate a timestamp version string (YYYYMMDDHHmmss)
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
 * Calculate SHA256 checksum of SQL content
 */
export function calculateChecksum(sqlContent: string): string {
  return createHash("sha256").update(sqlContent, "utf-8").digest("hex");
}

/**
 * Convert a name to kebab-case
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
 * Create a migration entry
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
 * Add an entry to the journal and return the updated journal
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
 * Get the journal or create a new one for the dialect
 */
export function getOrCreateJournal(
  migrationsDir: string,
  dialect: Dialect
): MigrationJournal {
  const existing = readJournal(migrationsDir);
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

/**
 * Validate that the journal dialect matches the expected dialect
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
