import { createClient } from "@client/client";
import type { Schema } from "@client/types";
import { PGliteDriver } from "@drivers/pglite";
import { MigrationError, VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations/client";
import { getMigrationDriver, type MigrationDriver } from "@migrations/drivers";
import { postgresMigrationDriver } from "@migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@migrations/drivers/sqlite";
import {
  SQLITE_GEO_POINT_TYPE,
  sqliteGeoPointCheck,
} from "@migrations/drivers/sqlite/geo-point";
import { serializeModels } from "@migrations/serializer";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import type { SchemaSnapshot } from "@migrations/types";
import { s } from "@schema";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, it } from "vitest";

const UNSUPPORTED_SPATIAL_INDEX = /unsupported index type "spatial"/i;

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

function unindexedPointSchema() {
  return {
    place: s.model({ id: s.string().id(), location: s.point() }).map("places"),
  };
}

function nullablePointSchema() {
  return {
    place: s
      .model({ id: s.string().id(), location: s.point().nullable() })
      .map("places"),
  };
}

function jsonLocationSchema() {
  return {
    place: s.model({ id: s.string().id(), location: s.json() }).map("places"),
  };
}

function partialIndexPointSchema() {
  return {
    place: s
      .model({
        id: s.string().id(),
        location: s.point(),
        active: s.boolean(),
      })
      .map("places")
      .index(["active"], {
        name: "places_active_partial",
        where: "active = true",
      }),
  };
}

function snapshot(
  migrationDriver: MigrationDriver,
  schema: Schema = indexedPointSchema()
): SchemaSnapshot {
  return serializeModels(schema, { migrationDriver });
}

function firstTable(value: SchemaSnapshot) {
  const table = value.tables[0];
  if (!table) throw new Error("the serialized schema omitted its table");
  return table;
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

describe("PostGIS live migration preflight", () => {
  const pointSnapshot = snapshot(postgresMigrationDriver, pointSchema());

  it("refuses visible shadow objects that do not belong to the PostGIS extension", async () => {
    const driver = new PGliteDriver({ postgis: true });
    try {
      for (const statement of [
        "UPDATE pg_catalog.pg_extension SET extname = 'postgis' WHERE extname = 'plpgsql'",
        "CREATE DOMAIN geometry AS text",
        "CREATE DOMAIN geography AS text",
        "CREATE DOMAIN spheroid AS text",
        "CREATE FUNCTION st_makepoint(double precision, double precision) RETURNS geometry LANGUAGE SQL IMMUTABLE AS $$ SELECT ''::geometry $$",
        "CREATE FUNCTION st_setsrid(geometry, integer) RETURNS geometry LANGUAGE SQL IMMUTABLE AS $$ SELECT $1 $$",
        "CREATE FUNCTION st_x(geometry) RETURNS double precision LANGUAGE SQL IMMUTABLE AS $$ SELECT 0::double precision $$",
        "CREATE FUNCTION st_y(geometry) RETURNS double precision LANGUAGE SQL IMMUTABLE AS $$ SELECT 0::double precision $$",
        "CREATE FUNCTION st_geomfromgeojson(text) RETURNS geometry LANGUAGE SQL IMMUTABLE AS $$ SELECT ''::geometry $$",
        "CREATE FUNCTION st_intersects(geography, geography) RETURNS boolean LANGUAGE SQL IMMUTABLE AS $$ SELECT true $$",
      ]) {
        await driver._executeRaw(statement);
      }

      const command = getMigrationDriver(driver);
      await expect(
        command.preflightSchemaRequirements([pointSnapshot], (sql, params) =>
          driver._executeRaw(sql, params)
        )
      ).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      });
    } finally {
      await driver.disconnect();
    }
  });

  it("refuses missing PostGIS before predicate canonicalization can create a temporary view", async () => {
    const driver = new PGliteDriver({ postgis: true });
    const client = createClient({ schema: partialIndexPointSchema(), driver });
    try {
      await expect(syncLiveSchema(client)).rejects.toBeInstanceOf(
        MigrationError
      );
      const scratch = await driver._executeRaw<{ relname: string }>(
        "SELECT relname FROM pg_catalog.pg_class WHERE relname LIKE 'viborm_index_predicate_%'"
      );
      expect(scratch.rows).toEqual([]);
    } finally {
      await client.$disconnect();
    }
  });
});
