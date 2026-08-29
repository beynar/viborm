import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { sqlite3MigrationDriver } from "@migrations/drivers/sqlite";
import { serializeModels } from "@migrations/serializer";
import { s } from "@schema";
import { defineContract } from "@tests/contracts/contract";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { GEO_POINT_EARTH_RADIUS_METERS } from "@validation/primitives/geo-area-codec";
import type { GeoPoint } from "@validation/primitives/geo-point-codec";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const place = s
  .model({
    id: s.string().id(),
    name: s.string(),
    location: s.point().map("location"),
    optionalLocation: s.point().nullable().map("optional_location"),
  })
  .map("geopoint_behavior_places");
const route = s
  .model({
    id: s.string().id(),
    location: s.point(),
    stops: s.toMany(() => stop),
  })
  .map("geopoint_behavior_routes");
const stop = s
  .model({
    id: s.string().id(),
    routeId: s.string(),
    location: s.point(),
    route: s
      .toOne(() => route)
      .fields("routeId")
      .references("id"),
  })
  .map("geopoint_behavior_stops");
const article = s
  .model({
    id: s.string().id(),
    location: s.point(),
    markers: s.toMany(() => marker).name("geopointTarget"),
  })
  .map("geopoint_behavior_articles");
const video = s
  .model({
    id: s.string().id(),
    location: s.point(),
    markers: s.toMany(() => marker).name("geopointTarget"),
  })
  .map("geopoint_behavior_videos");
const marker = s
  .model({
    id: s.string().id(),
    target: s
      .toOne({ article: () => article, video: () => video })
      .name("geopointTarget"),
  })
  .map("geopoint_behavior_markers");
const schema = { article, marker, place, route, stop, video };

type GeoPointClientConfig = VibORMConfig<typeof schema>;
export type GeoPointBehaviorClient = VibORMClient<GeoPointClientConfig>;

export interface GeoPointBehaviorOptions {
  readonly driverName: string;
  readonly createDriver: () => AnyDriver;
  readonly tier: "storage" | "full";
  readonly rawSelectSql: string;
  readonly setup?: (client: GeoPointBehaviorClient) => Promise<void>;
  readonly callbackTransactions?: boolean;
}

export interface GeoPointBatchBehaviorOptions {
  readonly driverName: string;
  readonly createDriver: () => AnyDriver;
  readonly setup?: (client: GeoPointBehaviorClient) => Promise<void>;
}

/** Provision the shared schema on SQLite transports whose migration API is read-only. */
export async function setupGeoPointBehaviorSQLite(
  client: GeoPointBehaviorClient
): Promise<void> {
  const snapshot = serializeModels(schema, {
    migrationDriver: sqlite3MigrationDriver,
  });
  for (const table of snapshot.tables) {
    const ddl = sqlite3MigrationDriver.generateDDL(
      { type: "createTable", table },
      { destination: "live" }
    );
    for (const statement of ddl.split(";\n")) {
      if (statement.trim().length > 0) {
        await client.$executeRawUnsafe(statement);
      }
    }
  }
}

/** GeoPoint proof for the native array-batch substrate used without callbacks. */
export function runGeoPointBatchBehavior({
  driverName,
  createDriver,
  setup = setupGeoPointBehaviorSQLite,
}: GeoPointBatchBehaviorOptions): void {
  describe(`${driverName} GeoPoint native batch`, () => {
    test("keeps point writes and reads typed in one array batch", async () => {
      const client = createClient({ schema, driver: createDriver() });
      try {
        await setup(client);
        await client.place.create({
          data: { id: "batch", name: "Batch", location: PARIS },
        });
        const [equal, bounded] = await client.$transaction([
          client.place.findMany({
            where: { location: { equals: PARIS } },
            select: { id: true, location: true },
          }),
          client.place.findMany({
            where: {
              location: {
                within: {
                  bounds: { south: 48, west: 1, north: 49, east: 3 },
                },
              },
            },
            select: { id: true, location: true },
          }),
        ]);
        expect(equal).toEqual([{ id: "batch", location: PARIS }]);
        expect(bounded).toEqual([{ id: "batch", location: PARIS }]);
      } finally {
        await client.$disconnect();
      }
    });
  });
}

const PARIS = { longitude: 2.3522, latitude: 48.8566 } as const;
const LONDON = { longitude: -0.1276, latitude: 51.5072 } as const;

/** Shared live proof for the logical GeoPoint value and each provider tier. */
export function runGeoPointBehavior({
  driverName,
  createDriver,
  tier,
  rawSelectSql,
  setup,
  callbackTransactions = true,
}: GeoPointBehaviorOptions): void {
  describe(`${driverName} GeoPoint behavior`, () => {
    let client: GeoPointBehaviorClient | undefined;

    beforeEach(async () => {
      client = createClient({ schema, driver: createDriver() });
      if (setup) await setup(client);
      else await syncLiveSchema(client);
    });

    afterEach(async () => {
      if (!client) return;
      await client.$disconnect();
      client = undefined;
    });

    const active = (): GeoPointBehaviorClient => {
      if (!client) throw new Error("GeoPoint test client was not initialized");
      return client;
    };

    test("round-trips point writes and returning projections", async () => {
      const created = await active().place.create({
        data: {
          id: "paris",
          name: "Paris",
          location: PARIS,
          optionalLocation: null,
        },
        select: { id: true, location: true, optionalLocation: true },
      });
      expect(created).toEqual({
        id: "paris",
        location: PARIS,
        optionalLocation: null,
      });

      const updated = await active().place.update({
        where: { id: "paris" },
        data: {
          location: { set: { longitude: -180, latitude: -0 } },
          optionalLocation: { set: LONDON },
        },
        select: { location: true, optionalLocation: true },
      });
      expect(updated).toEqual({
        location: { longitude: 180, latitude: 0 },
        optionalLocation: LONDON,
      });

      const bulk = await active().place.createMany({
        data: [
          { id: "london", name: "London", location: LONDON },
          {
            id: "new-york",
            name: "New York",
            location: { longitude: -74.006, latitude: 40.7128 },
          },
        ],
        select: { id: true, location: true },
      });
      expect(bulk).toEqual([
        { id: "london", location: LONDON },
        {
          id: "new-york",
          location: { longitude: -74.006, latitude: 40.7128 },
        },
      ]);
    });

    test("uses coordinate equality and inclusive ordinary and crossing bounds", async () => {
      await active().place.createMany({
        data: [
          { id: "paris", name: "Paris", location: PARIS },
          {
            id: "ordinary-boundary",
            name: "Boundary",
            location: { longitude: 3, latitude: 49 },
          },
          {
            id: "east-dateline",
            name: "East dateline",
            location: { longitude: 175, latitude: 0 },
          },
          {
            id: "west-dateline",
            name: "West dateline",
            location: { longitude: -175, latitude: 0 },
          },
          {
            id: "greenwich",
            name: "Greenwich",
            location: { longitude: 0, latitude: 0 },
          },
        ],
      });

      const equal = await active().place.findMany({
        where: { location: { equals: PARIS } },
        select: { id: true },
      });
      expect(equal).toEqual([{ id: "paris" }]);

      const ordinary = await active().place.findMany({
        where: {
          location: {
            within: {
              bounds: { south: 48, west: 1, north: 49, east: 3 },
            },
          },
        },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      expect(ordinary).toEqual([{ id: "ordinary-boundary" }, { id: "paris" }]);

      const crossing = await active().place.findMany({
        where: {
          location: {
            within: {
              bounds: { south: -10, west: 170, north: 10, east: -170 },
            },
          },
        },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      expect(crossing).toEqual([
        { id: "east-dateline" },
        { id: "west-dateline" },
      ]);
    });

    test("preserves point values through callback and array transactions", async () => {
      if (callbackTransactions) {
        const callback = await active().$transaction(async (tx) => {
          await tx.place.create({
            data: { id: "callback", name: "Callback", location: PARIS },
          });
          return tx.place.findUnique({ where: { id: "callback" } });
        });
        expect(callback?.location).toEqual(PARIS);
      } else {
        await active().place.create({
          data: { id: "callback", name: "Callback", location: PARIS },
        });
      }

      const [updated, selected] = await active().$transaction([
        active().place.update({
          where: { id: "callback" },
          data: { location: { set: LONDON } },
        }),
        active().place.findUnique({ where: { id: "callback" } }),
      ]);
      expect(updated.location).toEqual(LONDON);
      expect(selected?.location).toEqual(LONDON);
    });

    test("parses points in ordinary and variant relation graphs", async () => {
      const ordinary = await active().route.create({
        data: {
          id: "route",
          location: PARIS,
          stops: {
            create: { id: "stop", location: LONDON },
          },
        },
        include: { stops: true },
      });
      expect(ordinary.location).toEqual(PARIS);
      expect(ordinary.stops).toMatchObject([{ location: LONDON }]);

      const variant = await active().marker.create({
        data: {
          id: "marker",
          target: {
            create: {
              type: "article",
              data: { id: "article", location: PARIS },
            },
          },
        },
        include: { target: true },
      });
      expect(variant.target).toMatchObject({
        type: "article",
        data: { location: PARIS },
      });
    });

    test("keeps cached point results detached and fresh", async () => {
      await active().place.create({
        data: { id: "cached", name: "Cached", location: PARIS },
      });
      const cached = active().$extends(cache({ driver: new MemoryCache() }));
      const first = await cached.$withCache().place.findMany({
        where: { id: "cached" },
      });
      const firstLocation = first[0]?.location;
      if (!firstLocation) throw new Error("Expected the cached GeoPoint row");
      Reflect.set(firstLocation, "longitude", 99);

      const second = await cached.$withCache().place.findMany({
        where: { id: "cached" },
      });
      expect(second[0]?.location).toEqual(PARIS);
      expect(second[0]?.location).not.toBe(firstLocation);
    });

    test("preserves point semantics through request and statement extensions", async () => {
      await active().place.createMany({
        data: [
          { id: "paris", name: "Paris", location: PARIS },
          { id: "london", name: "London", location: LONDON },
        ],
      });
      let requestCalls = 0;
      let statementCalls = 0;
      const extended = active().$extends({
        name: "geopoint-provider-contract",
        request: {
          place: {
            findMany() {
              requestCalls += 1;
              return { where: { location: { equals: PARIS } } };
            },
          },
        },
        statement({ statement }) {
          statementCalls += 1;
          return statement;
        },
      });

      await expect(
        extended.place.findMany({ select: { id: true, location: true } })
      ).resolves.toEqual([{ id: "paris", location: PARIS }]);
      expect(requestCalls).toBe(1);
      expect(statementCalls).toBeGreaterThan(0);
    });

    test("leaves tagged and unsafe raw point results physical", async () => {
      await active().place.create({
        data: { id: "raw", name: "Raw", location: PARIS },
      });
      const tagged = await active().$queryRaw<{ location: unknown }>`
        SELECT location
        FROM geopoint_behavior_places
        WHERE id = ${"raw"}
      `;
      const unsafe = await active().$queryRawUnsafe<{ location: unknown }>(
        rawSelectSql
      );
      expect(tagged).toEqual(unsafe);
      expect(tagged).toHaveLength(1);
      expect(tagged[0]?.location).not.toEqual(PARIS);
    });

    if (tier === "full") {
      test("uses the fixed-radius metric for filtering, selection, and ordering", async () => {
        await active().place.createMany({
          data: [
            { id: "paris", name: "Paris", location: PARIS },
            { id: "london", name: "London", location: LONDON },
          ],
        });

        const expected = sphericalDistance(PARIS, LONDON);
        const rows = await active().place.findMany({
          where: {
            location: { distance: { to: LONDON, lte: expected + 1 } },
          },
          select: {
            id: true,
            location: { _distance: { to: LONDON } },
          },
          orderBy: {
            location: { _distance: { to: LONDON, sort: "asc" } },
          },
        });

        expect(rows.map((row) => row.id)).toEqual(["london", "paris"]);
        expect(rows[0]?._distance).toBeCloseTo(0, 6);
        expect(rows[1]?._distance).toBeCloseTo(expected, 3);
      });

      test("keeps every distance boundary exact across null, polar, and world-wide cases", async () => {
        const origin = { longitude: 0, latitude: 0 } as const;
        const east = { longitude: 1, latitude: 0 } as const;
        const northPole = { longitude: 0, latitude: 90 } as const;
        const antipode = { longitude: 180, latitude: 0 } as const;
        await active().place.createMany({
          data: [
            {
              id: "origin",
              name: "Origin",
              location: origin,
              optionalLocation: null,
            },
            {
              id: "east",
              name: "East",
              location: east,
              optionalLocation: origin,
            },
            {
              id: "pole",
              name: "Pole",
              location: northPole,
            },
            {
              id: "antipode",
              name: "Antipode",
              location: antipode,
            },
          ],
        });

        const zeroDistances = {
          lt: { to: origin, lt: 0 },
          lte: { to: origin, lte: 0 },
          gt: { to: origin, gt: 0 },
          gte: { to: origin, gte: 0 },
        };
        const idsAtZero = async (comparison: keyof typeof zeroDistances) =>
          active().place.findMany({
            where: {
              location: {
                distance: zeroDistances[comparison],
              },
            },
            select: { id: true },
            orderBy: { id: "asc" },
          });
        await expect(idsAtZero("lt")).resolves.toEqual([]);
        await expect(idsAtZero("lte")).resolves.toEqual([{ id: "origin" }]);
        await expect(idsAtZero("gt")).resolves.toEqual([
          { id: "antipode" },
          { id: "east" },
          { id: "pole" },
        ]);
        await expect(idsAtZero("gte")).resolves.toEqual([
          { id: "antipode" },
          { id: "east" },
          { id: "origin" },
          { id: "pole" },
        ]);

        const eastDistance = sphericalDistance(origin, east);
        await expect(
          active().place.findMany({
            where: {
              location: {
                distance: {
                  to: origin,
                  gte: eastDistance - 1,
                  lte: eastDistance + 1,
                },
              },
            },
            select: { id: true },
          })
        ).resolves.toEqual([{ id: "east" }]);

        const nullable = await active().place.findMany({
          where: {
            optionalLocation: { distance: { to: origin, lte: 0 } },
          },
          select: {
            id: true,
            optionalLocation: { _distance: { to: origin } },
          },
        });
        expect(nullable).toEqual([{ id: "east", _distance: 0 }]);
        await expect(
          active().place.findUnique({
            where: { id: "origin" },
            select: {
              id: true,
              optionalLocation: { _distance: { to: origin } },
            },
          })
        ).resolves.toEqual({ id: "origin", _distance: null });

        await expect(
          active().place.findMany({
            where: {
              location: {
                distance: {
                  to: { longitude: 0, latitude: 89 },
                  lte: 200_000,
                },
              },
            },
            select: { id: true },
          })
        ).resolves.toEqual([{ id: "pole" }]);

        await expect(
          active().place.findMany({
            where: {
              location: {
                distance: {
                  to: origin,
                  lte: Math.PI * GEO_POINT_EARTH_RADIUS_METERS + 1,
                },
              },
            },
            select: { id: true },
            orderBy: { id: "asc" },
          })
        ).resolves.toEqual([
          { id: "antipode" },
          { id: "east" },
          { id: "origin" },
          { id: "pole" },
        ]);
      });

      test("includes polygon boundaries and excludes holes", async () => {
        await active().place.createMany({
          data: [
            {
              id: "outer",
              name: "Outer",
              location: { longitude: 179, latitude: 5 },
            },
            {
              id: "hole",
              name: "Hole",
              location: { longitude: 179, latitude: 0 },
            },
            {
              id: "outer-boundary",
              name: "Outer boundary",
              location: { longitude: 170, latitude: 0 },
            },
            {
              id: "hole-boundary",
              name: "Hole boundary",
              location: { longitude: 175, latitude: 0 },
            },
            {
              id: "outside",
              name: "Outside",
              location: { longitude: 0, latitude: 0 },
            },
          ],
        });

        const outer = [
          { longitude: 170, latitude: -10 },
          { longitude: -170, latitude: -10 },
          { longitude: -170, latitude: 10 },
          { longitude: 170, latitude: 10 },
        ] as const;
        const hole = [
          { longitude: 175, latitude: -2 },
          { longitude: -175, latitude: -2 },
          { longitude: -175, latitude: 2 },
          { longitude: 175, latitude: 2 },
        ] as const;
        const findMembers = (
          polygonOuter: readonly GeoPoint[],
          polygonHole: readonly GeoPoint[]
        ) =>
          active().place.findMany({
            where: {
              location: {
                within: {
                  polygon: { outer: polygonOuter, holes: [polygonHole] },
                },
              },
            },
            select: { id: true },
            orderBy: { id: "asc" },
          });
        const expected = [
          { id: "hole-boundary" },
          { id: "outer" },
          { id: "outer-boundary" },
        ];
        await expect(findMembers(outer, hole)).resolves.toEqual(expected);
        await expect(
          findMembers(outer.slice().reverse(), hole.slice().reverse())
        ).resolves.toEqual(expected);
      });
    }
  });
}

function sphericalDistance(left: GeoPoint, right: GeoPoint): number {
  const radians = Math.PI / 180;
  const leftLatitude = left.latitude * radians;
  const rightLatitude = right.latitude * radians;
  const latitudeDelta = (right.latitude - left.latitude) * radians;
  const longitudeDelta = (right.longitude - left.longitude) * radians;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) *
      Math.cos(rightLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return (
    2 *
    GEO_POINT_EARTH_RADIUS_METERS *
    Math.asin(Math.min(1, Math.sqrt(haversine)))
  );
}

export const geoPointContract = defineContract({
  id: "drivers.geopoint",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runGeoPointBehavior,
});

export const geoPointBatchContract = defineContract({
  id: "drivers.geopoint-batch",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution", "atomic-batch"],
  register: runGeoPointBatchBehavior,
});
