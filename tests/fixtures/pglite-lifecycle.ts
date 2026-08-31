import { PGlite, type PGliteOptions } from "@electric-sql/pglite";

import { afterAll, afterEach, beforeEach } from "vitest";

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

/**
 * Releases a borrowed database as soon as its test is done with it, instead of
 * holding it until the file's `afterAll`. A harness that opens a FRESH database
 * per test must use this: PGlite is a Wasm Postgres, so keeping every instance
 * of a large scenario matrix alive at once is what pushes a single file past
 * the process-group RSS ceiling. De-registers first so the `afterAll` sweep
 * below cannot close the same database twice.
 */
export async function closeTestPGlite(database: PGlite): Promise<void> {
  borrowedDatabases.delete(database);
  await database.close();
}

let databasesHeldBeforeTest: readonly PGlite[] = [];

beforeEach(() => {
  databasesHeldBeforeTest = [...borrowedDatabases];
});

/**
 * Releases every database a TEST opened, as soon as that test ends.
 *
 * PGlite is a Wasm Postgres and a borrowed instance is not freed by
 * disconnecting the client that used it, so before this hook existed a file
 * held every database it had ever opened until `afterAll` - a 172-case matrix
 * that opens one per case per mode kept 344 of them resident at once, which is
 * what pushed single files past the process-group RSS ceiling.
 *
 * Only the DELTA is closed. A database opened in `beforeAll` or at describe
 * scope was already held when the test began, so it survives to `afterAll`
 * exactly as before.
 */
afterEach(async () => {
  const held = new Set(databasesHeldBeforeTest);
  databasesHeldBeforeTest = [];
  const failures: unknown[] = [];
  for (const database of [...borrowedDatabases]) {
    if (held.has(database)) continue;
    borrowedDatabases.delete(database);
    try {
      await database.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "PGlite test database release failed");
  }
});

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
