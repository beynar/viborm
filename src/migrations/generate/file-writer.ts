import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Dialect, MigrationEntry } from "../types";
import { ensureMigrationsDirs, getMetaDir } from "./journal";

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

/**
 * Format a migration filename from index and name
 * Example: 0000_initial.sql, 0001_add-users.sql
 */
export function formatMigrationFilename(idx: number, name: string): string {
  const paddedIdx = String(idx).padStart(4, "0");
  return `${paddedIdx}_${name}.sql`;
}

/**
 * Get the full path to a migration file
 */
export function getMigrationFilePath(
  migrationsDir: string,
  entry: MigrationEntry
): string {
  const filename = formatMigrationFilename(entry.idx, entry.name);
  return join(migrationsDir, filename);
}

/**
 * Add statement breakpoints between SQL statements
 * This helps with parsing and applying migrations statement by statement
 */
export function addStatementBreakpoints(
  statements: string[],
  _dialect: Dialect
): string {
  if (statements.length === 0) {
    return "";
  }

  // Join statements with breakpoint markers
  return statements
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0)
    .join(`\n${STATEMENT_BREAKPOINT}\n`);
}

/**
 * Parse a migration file content back into individual statements.
 * Removes header comments (lines starting with --) and empty lines.
 */
export function parseStatements(content: string): string[] {
  if (!content.trim()) {
    return [];
  }

  // First split by breakpoint marker
  const segments = content.split(STATEMENT_BREAKPOINT);

  const statements: string[] = [];

  for (const segment of segments) {
    // Remove comment lines from each segment
    const lines = segment.split("\n");
    const filteredLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      // Skip comment-only lines
      if (trimmed.startsWith("--")) continue;
      // Keep the line (even if empty, to preserve formatting within statements)
      filteredLines.push(line);
    }

    const stmt = filteredLines.join("\n").trim();
    if (stmt.length > 0) {
      statements.push(stmt);
    }
  }

  return statements;
}

/**
 * Write a migration file to disk
 */
export function writeMigrationFile(
  migrationsDir: string,
  entry: MigrationEntry,
  content: string
): string {
  ensureMigrationsDirs(migrationsDir);
  const filePath = getMigrationFilePath(migrationsDir, entry);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/**
 * Read a migration file from disk
 */
export function readMigrationFile(
  migrationsDir: string,
  entry: MigrationEntry
): string | null {
  const filePath = getMigrationFilePath(migrationsDir, entry);

  if (!existsSync(filePath)) {
    return null;
  }

  return readFileSync(filePath, "utf-8");
}

/**
 * Check if a migration file exists
 */
export function migrationFileExists(
  migrationsDir: string,
  entry: MigrationEntry
): boolean {
  const filePath = getMigrationFilePath(migrationsDir, entry);
  return existsSync(filePath);
}

/**
 * Generate a header comment for the migration file
 */
export function generateMigrationHeader(entry: MigrationEntry): string {
  const date = new Date(entry.when).toISOString();
  return `-- Migration: ${entry.name}
-- Generated: ${date}
-- Checksum: ${entry.checksum}
`;
}

/**
 * Format complete migration file content with header and statements
 */
export function formatMigrationContent(
  entry: MigrationEntry,
  statements: string[],
  dialect: Dialect
): string {
  const header = generateMigrationHeader(entry);
  const body = addStatementBreakpoints(statements, dialect);
  return `${header}\n${body}\n`;
}

// =============================================================================
// BACKUP & CLEANUP
// =============================================================================

const BACKUP_DIR = "_backup";

/**
 * Get the path to the backup directory
 */
export function getBackupDir(migrationsDir: string): string {
  return join(getMetaDir(migrationsDir), BACKUP_DIR);
}

/**
 * Ensure the backup directory exists
 */
export function ensureBackupDir(migrationsDir: string): void {
  const backupDir = getBackupDir(migrationsDir);
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }
}

/**
 * Backup a migration file before modification or deletion.
 * Creates a timestamped copy in meta/_backup/
 *
 * @param migrationsDir - The migrations directory
 * @param entry - The migration entry to backup
 * @returns The backup file path, or null if the original file doesn't exist
 */
export function backupMigrationFile(
  migrationsDir: string,
  entry: MigrationEntry
): string | null {
  const sourcePath = getMigrationFilePath(migrationsDir, entry);

  if (!existsSync(sourcePath)) {
    return null;
  }

  ensureBackupDir(migrationsDir);
  const backupDir = getBackupDir(migrationsDir);

  // Create timestamped backup filename
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const originalFilename = formatMigrationFilename(entry.idx, entry.name);
  const backupFilename = `${timestamp}_${originalFilename}`;
  const backupPath = join(backupDir, backupFilename);

  // Copy the file to backup
  const content = readFileSync(sourcePath, "utf-8");
  writeFileSync(backupPath, content, "utf-8");

  return backupPath;
}

/**
 * Delete a migration file from disk.
 *
 * @param migrationsDir - The migrations directory
 * @param entry - The migration entry to delete
 * @param backup - Whether to backup before deletion (default: true)
 * @returns Object with deleted flag and optional backup path
 */
export function deleteMigrationFile(
  migrationsDir: string,
  entry: MigrationEntry,
  backup = true
): { deleted: boolean; backupPath: string | null } {
  const filePath = getMigrationFilePath(migrationsDir, entry);

  if (!existsSync(filePath)) {
    return { deleted: false, backupPath: null };
  }

  let backupPath: string | null = null;
  if (backup) {
    backupPath = backupMigrationFile(migrationsDir, entry);
  }

  unlinkSync(filePath);
  return { deleted: true, backupPath };
}

/**
 * Move a migration file to the backup directory.
 * Useful for squash cleanup where we want to preserve but not keep in main dir.
 *
 * @param migrationsDir - The migrations directory
 * @param entry - The migration entry to move
 * @returns The new backup path, or null if the original file doesn't exist
 */
export function archiveMigrationFile(
  migrationsDir: string,
  entry: MigrationEntry
): string | null {
  const sourcePath = getMigrationFilePath(migrationsDir, entry);

  if (!existsSync(sourcePath)) {
    return null;
  }

  ensureBackupDir(migrationsDir);
  const backupDir = getBackupDir(migrationsDir);

  // Create timestamped archive filename
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const originalFilename = formatMigrationFilename(entry.idx, entry.name);
  const archiveFilename = `${timestamp}_${originalFilename}`;
  const archivePath = join(backupDir, archiveFilename);

  // Move the file
  renameSync(sourcePath, archivePath);

  return archivePath;
}
