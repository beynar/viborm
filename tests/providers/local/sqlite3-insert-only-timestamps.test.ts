/**
 * SQLite3 — a `.now()` creation timestamp survives an attempted update (#47).
 *
 * In-memory better-sqlite3, one fresh database per cell, schema pushed through
 * the ordinary consent path. The cells are shared with the PGlite suite:
 * `tests/fixtures/insert-only-timestamps.ts`.
 */

import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import {
  insertOnlyTimestampCells,
  insertOnlyTimestampSchema,
} from "@tests/fixtures/insert-only-timestamps";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, beforeEach, describe } from "vitest";

type InsertOnlyClient = VibORMClient<
  VibORMConfig<typeof insertOnlyTimestampSchema>
>;

describe("SQLite3 insert-only creation timestamps", () => {
  let client: InsertOnlyClient | undefined;

  beforeEach(async () => {
    client = createClient({
      schema: insertOnlyTimestampSchema,
      driver: createInMemorySQLite3Driver(),
    });
    await syncLiveSchema(client);
  });

  afterEach(async () => {
    await client?.$disconnect();
    client = undefined;
  });

  insertOnlyTimestampCells(() => {
    if (!client) throw new Error("SQLite3 client was not provisioned");
    return client;
  });
});
