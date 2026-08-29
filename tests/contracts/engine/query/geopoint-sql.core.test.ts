import type { DatabaseAdapter, GeoPointSql } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { MemoryCache } from "@cache/drivers/memory";
import { type CacheEntry, cache } from "@cache/exports";
import { createClient } from "@client/client";
import { type Dialect, Driver } from "@drivers";
import { FeatureNotSupportedError } from "@errors";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import { type Sql, sql } from "@sql";
import { prepareSchema } from "@tests/fixtures/query-scope";
import { createSchemaRegistry } from "@validation";
import {
  GEO_POINT_EARTH_RADIUS_METERS,
  type GeoBounds,
  geoBoundsForDistance,
  validateGeoPolygon,
} from "@validation/primitives/geo-area-codec";
import { describe, expect, test } from "vitest";

class MockDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;
  executeCalls = 0;

  constructor(adapter: DatabaseAdapter, dialect: Dialect) {
    super(dialect, `geopoint-${dialect}`);
    this.adapter = adapter;
  }

  protected async initClient() {
    return null;
  }

  protected async closeClient() {
    // The SQL contract owns no provider resource.
  }

  protected async execute<T>(): Promise<{ rows: T[]; rowCount: number }> {
    this.executeCalls += 1;
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: null,
    fn: (client: null) => Promise<T>
  ): Promise<T> {
    return fn(null);
  }
}

type GeoPointProviderCase = {
  readonly name: string;
  readonly adapter: DatabaseAdapter;
  readonly dialect: Dialect;
};

class LookupCache extends MemoryCache {
  getCalls = 0;

  protected override async get<T>(key: string): Promise<CacheEntry<T> | null> {
    this.getCalls += 1;
    return super.get<T>(key);
  }
}

const models = (() => {
  const place = s
    .model({
      id: s.string().id(),
      location: s.point(),
      optionalLocation: s.point().nullable(),
    })
    .map("places");
  const region = s
    .model({
      id: s.string().id(),
      location: s.point(),
      venues: s.toMany(() => venue),
    })
    .map("regions");
  const venue = s
    .model({
      id: s.string().id(),
      regionId: s.string(),
      location: s.point(),
      region: s
        .toOne(() => region)
        .fields("regionId")
        .references("id"),
    })
    .map("venues");
  return { place, region, venue };
})();
const { place, region, venue } = models;
prepareSchema(models);

function createEngine(adapter: DatabaseAdapter, dialect: Dialect): QueryEngine {
  const registry = createModelRegistry(models, createSchemaRegistry(models));
  return new QueryEngine(new MockDriver(adapter, dialect), registry);
}

function geoPointOf(adapter: DatabaseAdapter): GeoPointSql {
  if (!adapter.geoPoint) throw new Error("Expected a GeoPoint SQL protocol");
  return adapter.geoPoint;
}

function polygonSql(geoPoint: GeoPointSql): Sql {
  if (!geoPoint.withinPolygon) {
    throw new Error("Expected polygon support");
  }
  const polygon = validateGeoPolygon({
    outer: [
      { longitude: 170, latitude: -10 },
      { longitude: -170, latitude: -10 },
      { longitude: -170, latitude: 10 },
      { longitude: 170, latitude: 10 },
    ],
    holes: [
      [
        { longitude: 175, latitude: -2 },
        { longitude: -175, latitude: -2 },
        { longitude: -175, latitude: 2 },
        { longitude: 175, latitude: 2 },
      ],
    ],
  });
  if (polygon.issues) throw new Error("Expected a canonical polygon");
  return geoPoint.withinPolygon(sql.raw`stored_point`, polygon.value);
}

const paris = { longitude: 2.3522, latitude: 48.8566 };

describe("GeoPoint adapter SQL", () => {
  test("settles each adapter GeoPoint protocol as one immutable fact", () => {
    for (const adapter of [
      new PostgresAdapter("public", false),
      new PostgresAdapter("public", true),
      new MySQLAdapter(),
      new SQLiteAdapter(),
    ]) {
      expect(
        Object.getOwnPropertyDescriptor(adapter, "geoPoint")
      ).toMatchObject({
        configurable: false,
        enumerable: true,
        writable: false,
      });
      expect(Reflect.set(adapter, "geoPoint", undefined)).toBe(false);
      if (adapter.geoPoint) {
        expect(Object.isFrozen(adapter.geoPoint)).toBe(true);
        expect(
          Reflect.set(adapter.geoPoint, "equals", () => sql.raw`FALSE`)
        ).toBe(false);
        const hasFullTier =
          adapter instanceof MySQLAdapter ||
          (adapter instanceof PostgresAdapter &&
            adapter.geoPoint !== undefined);
        expect(Object.hasOwn(adapter.geoPoint, "distance")).toBe(hasFullTier);
        expect(Object.hasOwn(adapter.geoPoint, "withinPolygon")).toBe(
          hasFullTier
        );
      }
    }
  });

  test("binds longitude before latitude in every physical constructor", () => {
    const postgres = geoPointOf(new PostgresAdapter("public", true)).value(
      sql`${12}`,
      sql`${34}`
    );
    expect(postgres.toStatement("$n")).toBe(
      "ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography"
    );
    expect(postgres.values).toEqual([12, 34]);

    const mysql = geoPointOf(new MySQLAdapter()).value(sql`${12}`, sql`${34}`);
    expect(mysql.toStatement("$n")).toBe(
      "ST_GeomFromText(CONCAT('POINT(', $1, ' ', $2, ')'), 4326, 'axis-order=long-lat')"
    );
    expect(mysql.values).toEqual([12, 34]);

    const sqlite = geoPointOf(new SQLiteAdapter()).value(
      sql`${12}`,
      sql`${34}`
    );
    expect(sqlite.toStatement("$n")).toBe(
      "json_object('longitude', $1, 'latitude', $2)"
    );
    expect(sqlite.values).toEqual([12, 34]);
  });

  test("binds canonical polygons and never concatenates caller geometry", () => {
    const expectedPolygon = JSON.stringify({
      type: "Polygon",
      coordinates: [
        [
          [170, -10],
          [-170, -10],
          [-170, 10],
          [170, 10],
          [170, -10],
        ],
        [
          [175, 2],
          [-175, 2],
          [-175, -2],
          [175, -2],
          [175, 2],
        ],
      ],
    });

    const postgres = polygonSql(
      geoPointOf(new PostgresAdapter("public", true))
    );
    expect(postgres.toStatement("$n")).toBe(
      "ST_Intersects(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography, stored_point)"
    );
    expect(postgres.values).toEqual([expectedPolygon]);

    const mysql = polygonSql(geoPointOf(new MySQLAdapter()));
    expect(mysql.toStatement("$n")).toBe(
      "ST_Intersects(ST_GeomFromGeoJSON($1, 1, 4326), stored_point)"
    );
    expect(mysql.values).toEqual([expectedPolygon]);
    expect(mysql.toStatement("$n")).not.toContain("170");
  });

  test("spells the same fixed-radius distance on PostgreSQL and MySQL", () => {
    const postgres = geoPointOf(new PostgresAdapter("public", true)).distance;
    const mysql = geoPointOf(new MySQLAdapter()).distance;
    if (!(postgres && mysql)) throw new Error("Expected distance support");

    const postgresSql = postgres(sql.raw`left_point`, sql.raw`right_point`);
    expect(postgresSql.toStatement("$n")).toContain(
      "ASIN(SQRT(LEAST(1, GREATEST(0,"
    );
    expect(postgresSql.toStatement("$n")).toContain(
      "CASE WHEN left_point IS NULL OR right_point IS NULL THEN NULL"
    );
    expect(postgresSql.toStatement("$n")).toContain(
      "CAST($1 AS double precision)"
    );
    expect(postgresSql.toStatement("$n")).toContain(
      "RADIANS(ST_X(left_point::geometry))"
    );
    expect(postgresSql.toStatement("$n")).toContain(
      "RADIANS(ST_Y(right_point::geometry))"
    );
    expect(postgresSql.values).toEqual([GEO_POINT_EARTH_RADIUS_METERS]);

    const mysqlSql = mysql(sql.raw`left_point`, sql.raw`right_point`);
    expect(mysqlSql.toStatement("$n")).toBe(
      "ST_Distance_Sphere(left_point, right_point, $1)"
    );
    expect(mysqlSql.values).toEqual([GEO_POINT_EARTH_RADIUS_METERS]);
  });

  test.each([
    {
      name: "PostgreSQL",
      geoPoint: geoPointOf(new PostgresAdapter("public", true)),
      hasLongitude: (condition: Sql) =>
        condition.toStatement("$n").includes("ST_X"),
    },
    {
      name: "MySQL",
      geoPoint: geoPointOf(new MySQLAdapter()),
      hasLongitude: (condition: Sql) =>
        condition.toStatement("$n").includes("ST_Longitude"),
    },
    {
      name: "SQLite",
      geoPoint: geoPointOf(new SQLiteAdapter()),
      hasLongitude: (condition: Sql) =>
        condition.values.includes('$."longitude"'),
    },
  ])("lowers whole-world, polar, and degenerate bounds on $name", ({
    geoPoint,
    hasLongitude,
  }) => {
    const whole = geoPoint.withinBounds(sql.raw`stored_point`, {
      south: -90,
      west: -180,
      north: 90,
      east: 180,
    });
    expect(hasLongitude(whole)).toBe(false);

    const polar = geoPoint.withinBounds(sql.raw`stored_point`, {
      south: 80,
      west: -180,
      north: 90,
      east: 180,
    });
    expect(hasLongitude(polar)).toBe(false);

    const degenerate = geoPoint.withinBounds(sql.raw`stored_point`, {
      south: 7,
      west: 8,
      north: 7,
      east: 8,
    });
    expect(hasLongitude(degenerate)).toBe(true);
    expect(degenerate.toStatement("$n")).toContain(" >= ");
    expect(degenerate.toStatement("$n")).toContain(" <= ");
  });

  test.each([
    {
      name: "PostgreSQL",
      geoPoint: geoPointOf(new PostgresAdapter("public", true)),
      indexSql: " && ",
    },
    {
      name: "MySQL",
      geoPoint: geoPointOf(new MySQLAdapter()),
      indexSql: "MBRIntersects",
    },
  ])("adds an index-usable superset to ordinary bounds on $name", ({
    geoPoint,
    indexSql,
  }) => {
    const condition = geoPoint.withinBounds(sql.raw`stored_point`, {
      south: 40,
      west: -5,
      north: 55,
      east: 10,
    });
    expect(condition.toStatement("$n")).toContain(indexSql);
    expect(condition.values[0]).toBe(
      '{"type":"Polygon","coordinates":[[[-5,40],[10,40],[10,55],[-5,55],[-5,40]]]}'
    );
    expect(condition.toStatement("$n")).toContain(" >= ");
    expect(condition.toStatement("$n")).toContain(" <= ");

    for (const crossing of [
      { south: -10, west: 180, north: 10, east: -170 },
      { south: -10, west: 170, north: 10, east: -180 },
    ] satisfies readonly GeoBounds[]) {
      const crossingCondition = geoPoint.withinBounds(
        sql.raw`stored_point`,
        crossing
      );
      expect(crossingCondition.toStatement("$n")).not.toContain(indexSql);
      expect(crossingCondition.toStatement("$n")).toContain(" OR ");
    }
  });
});

describe("GeoPoint query lowering", () => {
  test.each([
    {
      name: "PostgreSQL",
      adapter: new PostgresAdapter("public", true),
      dialect: "postgresql",
      constructorSql: "ST_SetSRID(ST_MakePoint",
    },
    {
      name: "MySQL",
      adapter: new MySQLAdapter(),
      dialect: "mysql",
      constructorSql: "ST_GeomFromText",
    },
    {
      name: "SQLite",
      adapter: new SQLiteAdapter(),
      dialect: "sqlite",
      constructorSql: "json_object('longitude'",
    },
  ] satisfies readonly (GeoPointProviderCase & {
    readonly constructorSql: string;
  })[])("lowers point values for writes on $name", ({
    adapter,
    dialect,
    constructorSql,
  }) => {
    const engine = createEngine(adapter, dialect);
    if (dialect !== "mysql") {
      const create = engine.build(place, "create", {
        data: { id: "place-1", location: paris },
      });
      expect(create.toStatement("$n")).toContain(constructorSql);
      expect(create.values).toEqual(expect.arrayContaining([2.3522, 48.8566]));
    }

    const createMany = engine.build(place, "createMany", {
      data: [
        { id: "place-2", location: paris },
        {
          id: "place-3",
          location: { longitude: -73.9857, latitude: 40.7484 },
        },
      ],
    });
    expect(createMany.toStatement("$n")).toContain(constructorSql);
    expect(createMany.values).toEqual(
      expect.arrayContaining([2.3522, 48.8566, -73.9857, 40.7484])
    );
  });

  test.each([
    {
      name: "PostgreSQL",
      adapter: new PostgresAdapter("public", true),
      dialect: "postgresql",
      coordinateSql: "ST_X",
    },
    {
      name: "MySQL",
      adapter: new MySQLAdapter(),
      dialect: "mysql",
      coordinateSql: "ST_Longitude",
    },
    {
      name: "SQLite",
      adapter: new SQLiteAdapter(),
      dialect: "sqlite",
      coordinateSql: "json_type",
    },
  ] satisfies readonly (GeoPointProviderCase & {
    readonly coordinateSql: string;
  })[])("lowers exact equality and inclusive bounds on $name", ({
    adapter,
    dialect,
    coordinateSql,
  }) => {
    const engine = createEngine(adapter, dialect);
    const equality = engine.build(place, "findMany", {
      where: { location: { equals: paris } },
      select: { id: true },
    });
    expect(equality.toStatement("$n")).toContain(coordinateSql);
    expect(equality.values).toEqual(
      dialect === "sqlite"
        ? [
            '$."longitude"',
            '$."longitude"',
            paris.longitude,
            '$."latitude"',
            '$."latitude"',
            paris.latitude,
          ]
        : [paris.longitude, paris.latitude]
    );

    const bounds = engine.build(place, "findMany", {
      where: {
        location: {
          within: {
            bounds: { south: -10, west: 170, north: 10, east: -170 },
          },
        },
      },
      select: { id: true },
    });
    expect(bounds.toStatement("$n")).toContain(" OR ");
    expect(bounds.values).toEqual(
      dialect === "sqlite"
        ? [
            '$."latitude"',
            '$."latitude"',
            -10,
            '$."latitude"',
            '$."latitude"',
            10,
            '$."longitude"',
            '$."longitude"',
            170,
            '$."longitude"',
            '$."longitude"',
            -170,
          ]
        : [-10, 10, 170, -170]
    );
    if (dialect === "postgresql") {
      expect(bounds.toStatement("$n")).not.toContain(" && ");
    }
    if (dialect === "mysql") {
      expect(bounds.toStatement("$n")).not.toContain("MBRCovers");
    }
  });

  test("uses the smallest positive upper bound only in positive polarity", () => {
    const adapter = new PostgresAdapter("public", true);
    const engine = createEngine(adapter, "postgresql");
    const expectedBounds = geoBoundsForDistance(paris, 1000);
    const expectedIndexPolygon = JSON.stringify({
      type: "Polygon",
      coordinates: [
        [
          [expectedBounds.west, expectedBounds.south],
          [expectedBounds.east, expectedBounds.south],
          [expectedBounds.east, expectedBounds.north],
          [expectedBounds.west, expectedBounds.north],
          [expectedBounds.west, expectedBounds.south],
        ],
      ],
    });

    const positive = engine.build(place, "findMany", {
      where: {
        location: {
          distance: { to: paris, lt: 2000, lte: 1000, gte: 5 },
        },
      },
      select: { id: true },
    });
    expect(positive.toStatement("$n")).toContain(" && ");
    expect(positive.values).toContain(expectedIndexPolygon);

    for (const where of [
      { location: { not: { distance: { to: paris, lte: 1000 } } } },
      { NOT: { location: { distance: { to: paris, lte: 1000 } } } },
    ]) {
      const negative = engine.build(place, "findMany", {
        where,
        select: { id: true },
      });
      expect(negative.toStatement("$n")).not.toContain(" && ");
    }

    const doubleNegative = engine.build(place, "findMany", {
      where: {
        NOT: {
          NOT: { location: { distance: { to: paris, lte: 1000 } } },
        },
      },
      select: { id: true },
    });
    expect(doubleNegative.toStatement("$n")).toContain(" && ");
    expect(doubleNegative.values).toContain(expectedIndexPolygon);

    const zero = engine.build(place, "findMany", {
      where: { location: { distance: { to: paris, lte: 0 } } },
      select: { id: true },
    });
    expect(zero.toStatement("$n")).not.toContain(" && ");
  });

  test("threads distance-prefilter polarity through relation quantifiers", () => {
    const engine = createEngine(
      new PostgresAdapter("public", true),
      "postgresql"
    );
    const distance = { to: paris, lte: 1000 };

    const none = engine.build(region, "findMany", {
      where: { venues: { none: { location: { distance } } } },
      select: { id: true },
    });
    expect(none.toStatement("$n")).not.toContain(" && ");

    const every = engine.build(region, "findMany", {
      where: { venues: { every: { location: { distance } } } },
      select: { id: true },
    });
    expect(every.toStatement("$n")).toContain(" && ");

    const isNot = engine.build(venue, "findMany", {
      where: { region: { isNot: { location: { distance } } } },
      select: { id: true },
    });
    expect(isNot.toStatement("$n")).not.toContain(" && ");

    const is = engine.build(venue, "findMany", {
      where: { region: { is: { location: { distance } } } },
      select: { id: true },
    });
    expect(is.toStatement("$n")).toContain(" && ");
  });

  test("combines every distance comparator and uses null-last point ordering", () => {
    const query = createEngine(
      new PostgresAdapter("public", true),
      "postgresql"
    ).build(place, "findMany", {
      where: {
        location: {
          distance: {
            to: paris,
            lt: 20_000,
            lte: 19_000,
            gt: 10_000,
            gte: 11_000,
          },
        },
      },
      select: {
        id: true,
        optionalLocation: { _distance: { to: paris } },
      },
      orderBy: {
        optionalLocation: { _distance: { to: paris, sort: "desc" } },
      },
    });
    const statement = query.toStatement("$n");
    expect(statement).toContain(" < ");
    expect(statement).toContain(" <= ");
    expect(statement).toContain(" > ");
    expect(statement).toContain(" >= ");
    expect(statement).toContain('AS "0viborm_distance"');
    expect(statement).toContain("DESC NULLS LAST");
  });

  test("refuses unsupported SQLite work while keeping bounds portable", () => {
    const engine = createEngine(new SQLiteAdapter(), "sqlite");
    expect(() =>
      engine.build(place, "findMany", {
        where: { location: { distance: { to: paris, lte: 1000 } } },
      })
    ).toThrow(FeatureNotSupportedError);
    expect(() =>
      engine.build(place, "findMany", {
        where: {
          location: {
            within: {
              polygon: {
                outer: [
                  { longitude: 0, latitude: 0 },
                  { longitude: 1, latitude: 0 },
                  { longitude: 1, latitude: 1 },
                ],
              },
            },
          },
        },
      })
    ).toThrow(FeatureNotSupportedError);
    expect(() =>
      engine.build(place, "findMany", {
        select: { location: { _distance: { to: paris } } },
      })
    ).toThrow(FeatureNotSupportedError);
    expect(() =>
      engine.build(place, "findMany", {
        orderBy: { location: { _distance: { to: paris, sort: "asc" } } },
      })
    ).toThrow(FeatureNotSupportedError);

    expect(() =>
      engine.build(place, "findMany", {
        where: {
          location: {
            within: {
              bounds: { south: -1, west: -1, north: 1, east: 1 },
            },
          },
        },
      })
    ).not.toThrow();
  });

  test("refuses every unsupported SQLite point operation before cache lookup", async () => {
    const driver = new MockDriver(new SQLiteAdapter(), "sqlite");
    const cacheDriver = new LookupCache();
    const client = createClient({ schema: models, driver }).$extends(
      cache({ driver: cacheDriver })
    );

    try {
      const unsupported = [
        () =>
          client.$withCache().place.findMany({
            where: { location: { distance: { to: paris, lte: 1000 } } },
          }),
        () =>
          client.$withCache().place.findMany({
            where: {
              location: {
                within: {
                  polygon: {
                    outer: [
                      { longitude: 0, latitude: 0 },
                      { longitude: 1, latitude: 0 },
                      { longitude: 1, latitude: 1 },
                    ],
                  },
                },
              },
            },
          }),
        () =>
          client.$withCache().place.findMany({
            select: { location: { _distance: { to: paris } } },
          }),
        () =>
          client.$withCache().place.findMany({
            orderBy: {
              location: { _distance: { to: paris, sort: "asc" } },
            },
          }),
      ];

      for (const operation of unsupported) {
        await expect(operation()).rejects.toBeInstanceOf(
          FeatureNotSupportedError
        );
      }
      expect(cacheDriver.getCalls).toBe(0);
      expect(driver.executeCalls).toBe(0);

      await expect(
        client.$withCache().place.findMany({
          where: {
            location: {
              within: {
                bounds: { south: -1, west: -1, north: 1, east: 1 },
              },
            },
          },
        })
      ).resolves.toEqual([]);
      expect(cacheDriver.getCalls).toBe(1);
      expect(driver.executeCalls).toBe(1);
    } finally {
      await client.$disconnect();
    }
  });
});
