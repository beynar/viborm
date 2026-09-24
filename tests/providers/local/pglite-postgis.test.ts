/**
 * PGlite + PostGIS provider suite — the GeoPoint full tier, in process.
 *
 * `@electric-sql/pglite-postgis` is a real PostGIS (3.6 on PostgreSQL 18)
 * compiled for PGlite, so the same PostGIS behavior contracts the docker `pg`
 * and `postgres.js` suites register run here without a server: the logical
 * value, the fixed-radius metric, polygons, the generated migration estate, and
 * the GiST index the planner must pick.
 *
 * ONE database for the file, loaded with the extension once. VibORM never
 * installs PostGIS, so the suite runs `CREATE EXTENSION` itself, exactly as a
 * caller must; every test then starts from the drop-everything reset the docker
 * suites use. A driver built over the supplied database borrows it, so a
 * contract's `$disconnect()` leaves it open for the next test.
 */

import { createClient, PGliteDriver } from "@drivers/pglite";
import { postgis } from "@electric-sql/pglite-postgis";
import {
  geoPointBatchContract,
  geoPointContract,
} from "@tests/contracts/drivers/behaviors/geopoint-behavior";
import { geoPointMigrationLifecycleContract } from "@tests/contracts/drivers/behaviors/geopoint-migration-lifecycle-behavior";
import { geoPointPostgresIndexContract } from "@tests/contracts/drivers/behaviors/geopoint-postgres-index-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

const database = openTestPGlite({ extensions: { postgis } });

const createPostgisDriver = (): PGliteDriver =>
  new PGliteDriver({ client: database, postgis: true });

describe("PGlite + PostGIS Driver", () => {
  beforeAll(async () => {
    await database.exec("CREATE EXTENSION IF NOT EXISTS postgis");
  });

  // Pushing an empty schema diffs to dropTable for every managed table, which
  // leaves the extension-owned `spatial_ref_sys` where PostGIS put it.
  beforeEach(async () => {
    const cleanup = createClient({
      schema: {},
      client: database,
      postgis: true,
    });
    try {
      await syncLiveSchema(cleanup);
    } finally {
      await cleanup.$disconnect();
    }
  });

  geoPointContract.register({
    driverName: "PGlite",
    createDriver: createPostgisDriver,
    tier: "full",
    rawSelectSql:
      'SELECT "location" FROM "geopoint_behavior_places" WHERE "id" = \'raw\'',
  });

  geoPointBatchContract.register({
    driverName: "PGlite atomic batch",
    createDriver: () =>
      new BatchOnlyPGliteDriver({ client: database, postgis: true }),
    setup: async (client) => {
      await syncLiveSchema(client);
    },
  });

  geoPointMigrationLifecycleContract.register({
    driverName: "PGlite",
    createDriver: createPostgisDriver,
    physicalType: "geography(Point,4326)",
    physicalIndexType: "gist",
  });

  geoPointPostgresIndexContract.register({
    driverName: "PGlite",
    createDriver: createPostgisDriver,
  });
});
