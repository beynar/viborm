import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createClient } from "@client/client";
import type { Schema } from "@client/types";
import { PGliteDriver } from "@drivers/pglite";
import { MigrationError, VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations/client";
import { diff } from "@migrations/differ";
import type { MigrationDriver } from "@migrations/drivers";
import { getMigrationDriver } from "@migrations/drivers";
import { mysqlMigrationDriver } from "@migrations/drivers/mysql";
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
import { ddlContext, mysqlEstateDriver, RecordingDriver } from "./_estate";

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

describe("GeoPoint physical schema", () => {
  it("serializes one exact physical type and spatial index per dialect", () => {
    const postgres = firstTable(snapshot(postgresMigrationDriver));
    const mysql = firstTable(snapshot(mysqlMigrationDriver));
    const sqlite = firstTable(snapshot(sqlite3MigrationDriver));

    expect(postgres.columns[1]?.type).toBe("geography(Point,4326)");
    expect(postgres.indexes).toEqual([
      {
        columns: ["location"],
        name: "places_location_spatial",
        type: "gist",
        unique: false,
        where: undefined,
      },
    ]);
    expect(mysql.columns[1]?.type).toBe("POINT SRID 4326");
    expect(mysql.indexes[0]?.type).toBe("spatial");
    expect(sqlite.columns[1]?.type).toBe(SQLITE_GEO_POINT_TYPE);
    expect(SQLITE_GEO_POINT_TYPE).not.toContain("POINT");
  });

  it("renders qualified PostGIS GiST and grammar-correct MySQL SRID columns", () => {
    const postgresDriver = getMigrationDriver(
      new RecordingDriver("postgresql", "pg", new PostgresAdapter("geo", true))
    );
    const postgresTable = firstTable(snapshot(postgresMigrationDriver));
    const postgresDdl = postgresDriver.generateDDL(
      { type: "createTable", table: postgresTable },
      ddlContext("artifact")
    );
    expect(postgresDdl).toContain('"location" geography(Point,4326) NOT NULL');
    expect(postgresDdl).toContain(
      'CREATE INDEX "places_location_spatial" ON "geo"."places" USING gist ("location")'
    );

    const mysqlDriver = getMigrationDriver(
      mysqlEstateDriver({ namespace: "geo", attested: true })
    );
    const mysqlTable = firstTable(snapshot(mysqlMigrationDriver));
    const mysqlDdl = mysqlDriver.generateDDL(
      { type: "createTable", table: mysqlTable },
      ddlContext("live")
    );
    expect(mysqlDdl).toContain("`location` POINT NOT NULL SRID 4326");
    expect(mysqlDdl).toContain(
      "CREATE SPATIAL INDEX `places_location_spatial` ON `geo`.`places` (`location`)"
    );
  });

  it("refuses a SQLite spatial index while retaining the point column CHECK", () => {
    const table = firstTable(snapshot(sqlite3MigrationDriver));
    expect(() =>
      sqlite3MigrationDriver.generateDDL(
        { type: "createTable", table },
        ddlContext("artifact")
      )
    ).toThrow(UNSUPPORTED_SPATIAL_INDEX);

    const columnOnly = { ...table, indexes: [] };
    const ddl = sqlite3MigrationDriver.generateDDL(
      { type: "createTable", table: columnOnly },
      ddlContext("artifact")
    );
    expect(ddl).toContain(`"location" ${SQLITE_GEO_POINT_TYPE} NOT NULL`);
    expect(ddl).toContain('CONSTRAINT "viborm_geo" CHECK');
  });

  it("plans point nullability, spatial-index, and point-to-nonpoint transitions", async () => {
    const plain = snapshot(sqlite3MigrationDriver, unindexedPointSchema());
    const nullable = snapshot(sqlite3MigrationDriver, nullablePointSchema());
    const indexed = snapshot(postgresMigrationDriver, indexedPointSchema());
    const postgresPlain = snapshot(
      postgresMigrationDriver,
      unindexedPointSchema()
    );
    const json = snapshot(sqlite3MigrationDriver, jsonLocationSchema());

    expect(
      (await diff(plain, nullable)).operations.map(({ type }) => type)
    ).toEqual(["alterColumn"]);
    expect(
      (await diff(postgresPlain, indexed)).operations.map(({ type }) => type)
    ).toEqual(["createIndex"]);
    expect(
      (await diff(indexed, postgresPlain)).operations.map(({ type }) => type)
    ).toEqual(["dropIndex"]);
    expect(
      (await diff(plain, json)).operations.map(({ type }) => type)
    ).toEqual(["alterColumn"]);
  });
});

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

describe("PostGIS migration preflight", () => {
  const pointSnapshot = snapshot(postgresMigrationDriver, pointSchema());

  it("proves every exact function spelling once and skips non-point snapshots", async () => {
    const execution = new RecordingDriver(
      "postgresql",
      "pg",
      new PostgresAdapter("geo", true)
    );
    execution.respond = () => [{ ready: true }];
    const command = getMigrationDriver(execution);
    await command.preflightSchemaRequirements([pointSnapshot], (sql, params) =>
      execution._executeRaw(sql, params)
    );
    const calls = execution.statements.filter(
      (statement) => statement !== "<connect>"
    );
    expect(calls).toHaveLength(1);
    for (const signature of [
      "st_makepoint(double precision,double precision)",
      "st_setsrid(geometry,integer)",
      "st_x(geometry)",
      "st_y(geometry)",
      "st_geomfromgeojson(text)",
      "st_intersects(geography,geography)",
      "&&(geography,geography)",
    ]) {
      expect(calls[0]).toContain(signature);
    }

    await command.preflightSchemaRequirements([{ tables: [] }], () => {
      throw new Error("non-point snapshots must not query PostGIS");
    });
  });

  it.each([
    [[]],
    [[{ ready: false }]],
    [[{ ready: 1 }]],
    [[{ ready: true }, { ready: true }]],
  ])("fails closed on an unproven catalog answer %#", async (rows) => {
    const execution = new RecordingDriver(
      "postgresql",
      "pg",
      new PostgresAdapter("geo", true)
    );
    execution.respond = () => rows;
    const command = getMigrationDriver(execution);
    await expect(
      command.preflightSchemaRequirements([pointSnapshot], (sql, params) =>
        execution._executeRaw(sql, params)
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
  });

  it("refuses an adapter without the GeoPoint protocol before a provider call", async () => {
    const command = getMigrationDriver(
      new RecordingDriver("postgresql", "pg", new PostgresAdapter("geo", false))
    );
    let called = false;
    await expect(
      command.preflightSchemaRequirements([pointSnapshot], () => {
        called = true;
        return Promise.resolve({ rows: [] });
      })
    ).rejects.toMatchObject({ code: VibORMErrorCode.DRIVER_NOT_SUPPORTED });
    expect(called).toBe(false);
  });

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
