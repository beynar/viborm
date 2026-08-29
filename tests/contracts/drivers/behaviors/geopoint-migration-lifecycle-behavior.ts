import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { createMigrationClient } from "@migrations/client";
import {
  controlTableNames,
  DEFAULT_CONTROL_BASE,
  qualifyControl,
} from "@migrations/control";
import { getMigrationDriver } from "@migrations/drivers";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { s } from "@schema";
import { defineContract } from "@tests/contracts/contract";
import { describe, expect, test } from "vitest";

const migrationPlace = s
  .model({
    id: s.string().id(),
    location: s.point(),
  })
  .map("geopoint_migration_places")
  .index(["location"], {
    name: "geopoint_migration_places_location_spatial",
    type: "spatial",
  });

const migrationSchema = { migrationPlace };

export interface GeoPointMigrationLifecycleOptions {
  readonly driverName: string;
  readonly createDriver: () => AnyDriver;
  readonly physicalType: string;
  readonly physicalIndexType: "gist" | "spatial";
}

/** Generated-estate proof shared by the two full physical provider families. */
export function runGeoPointMigrationLifecycleBehavior({
  driverName,
  createDriver,
  physicalType,
  physicalIndexType,
}: GeoPointMigrationLifecycleOptions): void {
  describe(`${driverName} GeoPoint migration lifecycle`, () => {
    test("converges through generated apply, verify, down, and reset", async () => {
      const storage = new MemoryEstateStorage();
      const driver = createDriver();
      const client = createClient({ schema: migrationSchema, driver });
      const migrations = createMigrationClient(client, { storage });

      try {
        await migrations.generate({ name: "geopoint-init" });
        await expect(migrations.apply()).resolves.toMatchObject({
          outcome: "applied",
        });
        await expect(migrations.verify()).resolves.toEqual({ ok: true });

        const command = getMigrationDriver(driver);
        const live = await command.introspect((statement, parameters) =>
          driver._executeRaw(statement, parameters)
        );
        const table = live.tables.find(
          ({ name }) => name === "geopoint_migration_places"
        );
        expect(
          table?.columns.find(({ name }) => name === "location")?.type
        ).toBe(physicalType);
        expect(
          table?.indexes.find(
            ({ name }) => name === "geopoint_migration_places_location_spatial"
          )?.type
        ).toBe(physicalIndexType);
        await expect(migrations.push()).resolves.toMatchObject({
          outcome: "noop",
          operations: [],
        });

        await expect(migrations.down({ steps: 1 })).resolves.toMatchObject({
          preview: false,
        });
        await expect(migrations.reset()).resolves.toMatchObject({
          preview: false,
        });
        await expect(migrations.verify()).resolves.toEqual({ ok: true });
        if (driver.dialect === "postgresql") {
          await expect(
            driver._executeRaw<{ present: boolean }>(
              "SELECT pg_catalog.to_regclass('public.spatial_ref_sys') IS NOT NULL AS present"
            )
          ).resolves.toMatchObject({ rows: [{ present: true }] });
        }
        await expect(migrations.push()).resolves.toMatchObject({
          outcome: "noop",
          operations: [],
        });

        await expect(
          client.migrationPlace.create({
            data: {
              id: "after-reset",
              location: { longitude: 180, latitude: 90 },
            },
            select: { location: true },
          })
        ).resolves.toEqual({ location: { longitude: 180, latitude: 90 } });
        await expect(migrations.down({ steps: 1 })).resolves.toMatchObject({
          preview: false,
        });
      } finally {
        const command = getMigrationDriver(driver);
        const control = controlTableNames(DEFAULT_CONTROL_BASE);
        await driver._executeRaw(
          `DROP TABLE IF EXISTS ${qualifyControl(command, control.log)}`
        );
        await driver._executeRaw(
          `DROP TABLE IF EXISTS ${qualifyControl(command, control.state)}`
        );
        await client.$disconnect();
      }
    });
  });
}

export const geoPointMigrationLifecycleContract = defineContract({
  id: "drivers.geopoint-migration-lifecycle",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution", "ddl"],
  register: runGeoPointMigrationLifecycleBehavior,
});
