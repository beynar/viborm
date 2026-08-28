import { createClient } from "@client/client";
import {
  createClient as createSQLite3Client,
  SQLite3Driver,
} from "@drivers/sqlite3";

import { sqliteUserPostSchema } from "@tests/fixtures/user-post-schema";
import type { ProviderFixture } from "@tests/contracts/contract";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

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

  await syncLiveSchema(tempClient);
  await driver._executeRaw(`DELETE FROM "posts"`);
  await driver._executeRaw(`DELETE FROM "users"`);
}

export const sqlite3ProviderFixture: ProviderFixture<SQLite3Driver> = {
  id: "sqlite3",
  dialect: "sqlite",
  runtime: "node",
  capabilities: new Set(["sql-execution", "transactions", "returning", "ddl"]),
  availability: () => ({ available: true }),
  createDriver: createInMemorySQLite3Driver,
  dispose: (driver) => driver.disconnect(),
};
