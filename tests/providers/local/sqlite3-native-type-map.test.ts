/**
 * SQLite3 — one schema, a native type per dialect (#45).
 *
 * In-memory better-sqlite3, one database for the file, schema pushed through
 * the ordinary consent path. SQLite selects the maps' SQLite entries — an
 * epoch-millisecond INTEGER DateTime — and its automatic column wherever a map
 * has none. The cells are shared with the PGlite, PostgreSQL and MySQL suites:
 * `tests/fixtures/native-type-map.ts`.
 */

import { createClient } from "@client/client";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import {
  nativeTypeMapCells,
  nativeTypeMapSchema,
} from "@tests/fixtures/native-type-map";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, describe } from "vitest";

describe("SQLite3 native type per dialect", () => {
  const driver = createInMemorySQLite3Driver();
  const client = createClient({ schema: nativeTypeMapSchema, driver });

  beforeAll(async () => {
    await syncLiveSchema(client);
  });

  afterAll(async () => {
    await client.$disconnect();
  });

  nativeTypeMapCells({
    dialect: "sqlite",
    client: () => client,
    clientFor: (schema) => createClient({ schema, driver }),
    reset: async () => {
      await client.pet.deleteMany({});
      await client.owner.deleteMany({});
    },
    expectedCatalog: {
      owners: {
        id: "blob",
        handle: "text",
        score: "integer",
        ratio: "real",
        seenAt: "integer",
        tags: "json",
      },
      pets: { id: "text", name: "text", ownerId: "blob" },
    },
    raw: { id: "bytes", seenAt: "epochMillis" },
  });
});
