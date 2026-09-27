import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { updatedAtCells, updatedAtSchema } from "@tests/fixtures/updated-at";
import { afterEach, beforeEach, describe } from "vitest";

describe("SQLite3 `.updatedAt()`", () => {
  let client: VibORMClient<VibORMConfig<typeof updatedAtSchema>>;

  beforeEach(async () => {
    client = createClient({
      schema: updatedAtSchema,
      driver: createInMemorySQLite3Driver(),
    });
    await syncLiveSchema(client);
  });

  afterEach(async () => {
    await client.$disconnect();
  });

  updatedAtCells(() => client);
});
