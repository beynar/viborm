/** Real in-memory SQLite readback belongs to the extended migration estate. */
import {
  SQLITE_GEO_POINT_TYPE,
  sqliteGeoPointCheck,
} from "@adapters/databases/sqlite/storage/geo-point";
import { createClient } from "@client/client";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations/client";
import { sqlite3MigrationDriver } from "@migrations/drivers/sqlite";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { s } from "@schema";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, it } from "vitest";

function pointSchema() {
  return {
    place: s
      .model({
        id: s.string().id(),
        location: s.point(),
        optionalLocation: s.point().nullable().map("optional_location"),
      })
      .map("places"),
  };
}

function indexedPointSchema() {
  return {
    place: s
      .model({ id: s.string().id(), location: s.point() })
      .map("places")
      .index(["location"], {
        name: "places_location_spatial",
        type: "spatial",
      }),
  };
}

describe("SQLite GeoPoint convergence", () => {
  it("stores canonical numeric JSON, enforces its proof, and reaches an empty second push", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: pointSchema(), driver });
    try {
      const first = await syncLiveSchema(client);
      expect(
        first.operations.some((operation) => operation.type === "createTable")
      ).toBe(true);

      await client.place.create({
        data: {
          id: "integer",
          location: { longitude: 2, latitude: -0 },
          optionalLocation: null,
        },
      });
      await client.place.create({
        data: {
          id: "fraction",
          location: { longitude: 1e-7, latitude: -1e-7 },
          optionalLocation: { longitude: 180, latitude: 90 },
        },
      });

      const stored = await driver._executeRaw<{
        id: string;
        location: string;
      }>('SELECT "id", "location" FROM "places" ORDER BY "id"');
      expect(stored.rows.map((row) => JSON.parse(row.location))).toEqual([
        { longitude: 1e-7, latitude: -1e-7 },
        { longitude: 2, latitude: 0 },
      ]);
      expect((await syncLiveSchema(client)).operations).toEqual([]);

      for (const [id, value] of [
        ["west", '{"longitude":-180.0,"latitude":0.0}'],
        ["extra", '{"longitude":2.0,"latitude":0.0,"altitude":1.0}'],
        ["order", '{"latitude":0.0,"longitude":2.0}'],
        ["string", '{"longitude":"2","latitude":0.0}'],
      ] as const) {
        await expect(
          driver._executeRaw(
            'INSERT INTO "places" ("id", "location") VALUES (?, ?)',
            [id, value]
          )
        ).rejects.toThrow();
      }
    } finally {
      await client.$disconnect();
    }
  });

  it("recognizes only the reserved type paired with the exact writer CHECK", async () => {
    const valid = createInMemorySQLite3Driver();
    const check = sqliteGeoPointCheck(
      { name: "location", nullable: false },
      (name) => `"${name.replaceAll('"', '""')}"`
    );
    await valid._executeRaw(
      `CREATE TABLE "places" ("location" ${SQLITE_GEO_POINT_TYPE} NOT NULL ${check})`
    );
    const read = await sqlite3MigrationDriver.introspect((sql, params) =>
      valid._executeRaw(sql, params)
    );
    expect(read.tables[0]?.columns[0]?.type).toBe(SQLITE_GEO_POINT_TYPE);
    await valid.disconnect();

    const generic = createInMemorySQLite3Driver();
    await generic._executeRaw(
      'CREATE TABLE "places" ("location" JSON NOT NULL)'
    );
    const genericRead = await sqlite3MigrationDriver.introspect((sql, params) =>
      generic._executeRaw(sql, params)
    );
    expect(genericRead.tables[0]?.columns[0]?.type).toBe("JSON");
    await generic.disconnect();

    const hostile = createInMemorySQLite3Driver();
    await hostile._executeRaw(
      `CREATE TABLE "places" ("location" ${SQLITE_GEO_POINT_TYPE} NOT NULL)`
    );
    await expect(
      sqlite3MigrationDriver.introspect((sql, params) =>
        hostile._executeRaw(sql, params)
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
    await hostile.disconnect();
  });

  it("refuses a spatial index before a push can create its table", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: indexedPointSchema(), driver });
    try {
      await expect(syncLiveSchema(client)).rejects.toMatchObject({
        code: VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      });
      const tables = await driver._executeRaw<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'places'"
      );
      expect(tables.rows).toEqual([]);
    } finally {
      await client.$disconnect();
    }
  });

  it("carries the point snapshot through generated apply, down, and reset", async () => {
    const storage = new MemoryEstateStorage();
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: pointSchema(), driver });
    const migrations = createMigrationClient(client, { storage });
    try {
      await migrations.generate({ name: "geo-init" });
      await expect(migrations.apply()).resolves.toMatchObject({
        outcome: "applied",
      });
      await expect(migrations.verify()).resolves.toEqual({ ok: true });
      await expect(migrations.down({ steps: 1 })).resolves.toMatchObject({
        preview: false,
      });
      const afterDown = await driver._executeRaw<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'places'"
      );
      expect(afterDown.rows).toEqual([]);

      await expect(migrations.reset()).resolves.toMatchObject({
        preview: false,
      });
      await expect(migrations.verify()).resolves.toEqual({ ok: true });
      await expect(
        client.place.create({
          data: {
            id: "after-reset",
            location: { longitude: 180, latitude: -90 },
            optionalLocation: null,
          },
        })
      ).resolves.toMatchObject({
        location: { longitude: 180, latitude: -90 },
      });
    } finally {
      await client.$disconnect();
    }
  });
});
