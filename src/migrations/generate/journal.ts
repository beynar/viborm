/**
 * Migrations directory layout helpers.
 *
 * This file deliberately holds NO journal reader, writer, or entry factory. It
 * once carried an fs-backed twin of the storage driver's journal API — with its
 * own format version and its own unvalidated `JSON.parse` — which was live on
 * the generate barrel and let a caller bypass the driver's format/policy
 * validation entirely. There is one journal funnel:
 * `MigrationStorageDriver.readJournal()`.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const META_DIR = "meta";

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
