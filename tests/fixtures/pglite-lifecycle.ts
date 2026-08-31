import { PGlite, type PGliteOptions } from "@electric-sql/pglite";

import { afterAll } from "vitest";

const borrowedDatabases = new Set<PGlite>();

/**
 * Opens a test-owned PGlite database and closes it after the importing test
 * file finishes. A PGliteDriver supplied with this database borrows it, so
 * disconnecting the VibORM client does not release the Wasm database.
 */
export function openTestPGlite(
  dataDir?: string,
  options?: PGliteOptions
): PGlite;
export function openTestPGlite(options?: PGliteOptions): PGlite;
export function openTestPGlite(
  dataDirOrOptions?: string | PGliteOptions,
  options?: PGliteOptions
): PGlite {
  const database =
    typeof dataDirOrOptions === "string"
      ? new PGlite(dataDirOrOptions, options)
      : new PGlite(dataDirOrOptions);
  borrowedDatabases.add(database);
  return database;
}

afterAll(async () => {
  const databases = [...borrowedDatabases];
  borrowedDatabases.clear();
  const failures: unknown[] = [];
  // Imported hooks unwind after file-local teardown. Close sequentially so a
  // large scenario matrix cannot create a second Wasm-memory peak at cleanup.
  for (const database of databases) {
    try {
      await database.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "PGlite test database cleanup failed");
  }
});
