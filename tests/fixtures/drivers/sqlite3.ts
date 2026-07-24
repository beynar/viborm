import { createClient } from "@client/client";
import {
  createClient as createSQLite3Client,
  SQLite3Driver,
} from "@drivers/sqlite3";
import { push } from "@migrations";
import { sqliteUserPostSchema } from "../user-post-schema";

export function createInMemorySQLite3Driver(): SQLite3Driver {
  return new SQLite3Driver({
    dataDir: ":memory:",
  });
}

export function createSQLite3UserPostClient() {
  return createSQLite3Client({
    schema: sqliteUserPostSchema,
    dataDir: ":memory:",
  });
}

export async function setupSQLite3UserPostDatabase(driver: SQLite3Driver) {
  const tempClient = createClient({
    schema: sqliteUserPostSchema,
    driver,
  });

  await push(tempClient, { force: true });
  await driver._executeRaw(`DELETE FROM "posts"`);
  await driver._executeRaw(`DELETE FROM "users"`);
}
