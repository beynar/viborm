import { createClient } from "@client/client";
import type { Schema } from "@client/types";
import { PGliteDriver } from "@drivers/pglite";
import { MigrationError, VibORMErrorCode } from "@errors";
import { getMigrationDriver, type MigrationDriver } from "@migrations/drivers";
import { postgresMigrationDriver } from "@migrations/drivers/postgres";
import { serializeModels } from "@migrations/serializer";
import type { SchemaSnapshot } from "@migrations/types";
import { s } from "@schema";
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
