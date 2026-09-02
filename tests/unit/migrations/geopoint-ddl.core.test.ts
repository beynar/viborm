import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import type { Schema } from "@client/types";
import { VibORMErrorCode } from "@errors";
import { diff } from "@migrations/differ";
import type { MigrationDriver } from "@migrations/drivers";
import { getMigrationDriver } from "@migrations/drivers";
import { mysqlMigrationDriver } from "@migrations/drivers/mysql";
import { postgresMigrationDriver } from "@migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@migrations/drivers/sqlite";
import { SQLITE_GEO_POINT_TYPE } from "@migrations/drivers/sqlite/geo-point";
import { serializeModels } from "@migrations/serializer";
import type { SchemaSnapshot } from "@migrations/types";
import { s } from "@schema";
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
});
