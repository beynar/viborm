import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { introspect } from "@migrations/push";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import { sql } from "@sql";
import { defineContract } from "@tests/contracts/contract";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { createSchemaRegistry } from "@validation";
import { GEO_POINT_EARTH_RADIUS_METERS } from "@validation/primitives/geo-area-codec";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const place = s
  .model({
    id: s.string().id(),
    location: s.point(),
  })
  .index(["location"], { type: "spatial" })
  .map("geopoint_postgres_index_places");
const schema = { place };
const indexName = "geopoint_postgres_index_places_location_idx";

type IndexClientConfig = VibORMConfig<typeof schema>;
type IndexClient = VibORMClient<IndexClientConfig>;

export interface PostgresGeoPointIndexBehaviorOptions {
  readonly driverName: string;
  readonly createDriver: () => AnyDriver;
}

/** Live planner proof for every indexable GeoPoint predicate on PostgreSQL. */
export function runPostgresGeoPointIndexBehavior({
  driverName,
  createDriver,
}: PostgresGeoPointIndexBehaviorOptions): void {
  describe(`${driverName} GeoPoint spatial-index planning`, () => {
    let client: IndexClient | undefined;
    let driver: AnyDriver | undefined;

    beforeEach(async () => {
      driver = createDriver();
      client = createClient({ schema, driver });
      await syncLiveSchema(client);
    });

    afterEach(async () => {
      if (client) await client.$disconnect();
      client = undefined;
      driver = undefined;
    });

    test("plans indexed bounds, polygon, and positive upper-distance predicates", async () => {
      if (!(client && driver)) {
        throw new Error("GeoPoint index test client was not initialized");
      }
      const activeClient = client;
      const registry = createModelRegistry(
        schema,
        createSchemaRegistry(schema)
      );
      const engine = new QueryEngine(driver, registry);
      const paris = { longitude: 2.3522, latitude: 48.8566 };
      const polygon = {
        outer: [
          { longitude: 1, latitude: 47 },
          { longitude: 3, latitude: 47 },
          { longitude: 3, latitude: 49 },
          { longitude: 1, latitude: 49 },
        ],
      };

      const explain = async (where: unknown): Promise<string> => {
        const statement = engine.build(place, "findMany", {
          where,
          select: { id: true },
        });
        const rows = await activeClient.$transaction(async (tx) => {
          await tx.$executeRaw(sql`SET LOCAL enable_seqscan = off`);
          return tx.$queryRaw<Record<string, unknown>>(
            sql`EXPLAIN (FORMAT JSON) ${statement}`
          );
        });
        return JSON.stringify(rows);
      };

      for (const where of [
        {
          location: {
            within: {
              bounds: { south: 47, west: 1, north: 49, east: 3 },
            },
          },
        },
        { location: { within: { polygon } } },
        { location: { distance: { to: paris, lte: 100_000 } } },
      ]) {
        await expect(explain(where)).resolves.toContain(indexName);
      }

      for (const where of [
        { location: { distance: { to: paris, gte: 100_000 } } },
        { NOT: { location: { distance: { to: paris, lte: 100_000 } } } },
      ]) {
        await expect(explain(where)).resolves.not.toContain(indexName);
      }
    });

    test("keeps canonical dateline predicates exact for a physical -180 longitude", async () => {
      if (!client) {
        throw new Error("GeoPoint index test client was not initialized");
      }
      await client.$executeRaw(sql`
        INSERT INTO "geopoint_postgres_index_places" ("id", "location")
        VALUES (
          ${"physical-negative-dateline"},
          ST_SetSRID(ST_MakePoint(${-180}, ${0}), 4326)::geography
        )
      `);

      const equal = await client.place.findMany({
        where: {
          location: { equals: { longitude: 180, latitude: 0 } },
        },
        select: { id: true, location: true },
      });
      expect(equal).toEqual([
        {
          id: "physical-negative-dateline",
          location: { longitude: 180, latitude: 0 },
        },
      ]);

      for (const bounds of [
        { south: 0, west: 180, north: 0, east: 180 },
        { south: -1, west: 170, north: 1, east: 180 },
      ]) {
        await expect(
          client.place.findMany({
            where: { location: { within: { bounds } } },
            select: { id: true },
          })
        ).resolves.toEqual([{ id: "physical-negative-dateline" }]);
      }

      const physical = await client.$queryRaw<{ longitude: number }>`
        SELECT ST_X("location"::geometry) AS "longitude"
        FROM "geopoint_postgres_index_places"
        WHERE "id" = ${"physical-negative-dateline"}
      `;
      expect(Number(physical[0]?.longitude)).toBe(-180);
    });

    test("executes the bound fixed-radius ORM distance expression", async () => {
      if (!client) {
        throw new Error("GeoPoint index test client was not initialized");
      }
      await client.place.createMany({
        data: [
          {
            id: "paris-distance",
            location: { longitude: 2.3522, latitude: 48.8566 },
          },
          {
            id: "london-distance",
            location: { longitude: -0.1276, latitude: 51.5072 },
          },
        ],
      });
      const rows = await client.place.findMany({
        where: { id: "paris-distance" },
        select: {
          location: {
            _distance: {
              to: { longitude: -0.1276, latitude: 51.5072 },
            },
          },
        },
      });
      expect(rows[0]?._distance).toBeGreaterThan(300_000);
      expect(rows[0]?._distance).toBeLessThan(400_000);
      expect(rows[0]?._distance).toBeCloseTo(
        2 *
          GEO_POINT_EARTH_RADIUS_METERS *
          Math.asin(
            Math.sqrt(
              Math.sin(((51.5072 - 48.8566) * Math.PI) / 360) ** 2 +
                Math.cos((48.8566 * Math.PI) / 180) *
                  Math.cos((51.5072 * Math.PI) / 180) *
                  Math.sin(((-0.1276 - 2.3522) * Math.PI) / 360) ** 2
            )
          ),
        6
      );
    });

    test("keeps PostGIS extension relations outside the managed estate", async () => {
      if (!client) {
        throw new Error("GeoPoint index test client was not initialized");
      }
      const before = await client.$queryRaw<{ relation: string | null }>`
        SELECT to_regclass('public.spatial_ref_sys')::text AS "relation"
      `;
      expect(before[0]?.relation).toBe("spatial_ref_sys");

      const snapshot = await introspect(client);
      expect(
        snapshot.tables.some((table) => table.name === "spatial_ref_sys")
      ).toBe(false);

      await syncLiveSchema(client);
      const after = await client.$queryRaw<{ relation: string | null }>`
        SELECT to_regclass('public.spatial_ref_sys')::text AS "relation"
      `;
      expect(after[0]?.relation).toBe("spatial_ref_sys");
    });
  });
}

export const geoPointPostgresIndexContract = defineContract({
  id: "drivers.geopoint-postgres-index",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution", "ddl"],
  register: runPostgresGeoPointIndexBehavior,
});
