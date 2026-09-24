import type { DatabaseAdapter, GeoPointSql } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { MemoryCache } from "@cache/drivers/memory";
import { type CacheEntry, cache } from "@cache/exports";
import { createClient } from "@client/client";
import { type Dialect, Driver } from "@drivers";
import { FeatureNotSupportedError, TransactionError } from "@errors";
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
  readonly statements: { readonly sql: string; readonly params: unknown[] }[] =
    [];

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

  protected async execute<T>(
    _client: null,
    statement: string,
    params: unknown[]
  ): Promise<{ rows: T[]; rowCount: number }> {
    this.executeCalls += 1;
    this.statements.push({ sql: statement, params });
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
      constructorSql: "ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography",
      createManySql:
        'INSERT INTO "public"."places" ("id", "location", "optionalLocation") VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, NULL), ($4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, NULL)',
    },
    {
      name: "MySQL",
      adapter: new MySQLAdapter(),
      dialect: "mysql",
      constructorSql:
        "ST_GeomFromText(CONCAT('POINT(', ?, ' ', ?, ')'), 4326, 'axis-order=long-lat')",
      createManySql:
        "INSERT INTO `places` (`id`, `location`, `optionalLocation`) VALUES (?, ST_GeomFromText(CONCAT('POINT(', ?, ' ', ?, ')'), 4326, 'axis-order=long-lat'), NULL), (?, ST_GeomFromText(CONCAT('POINT(', ?, ' ', ?, ')'), 4326, 'axis-order=long-lat'), NULL)",
    },
    {
      name: "SQLite",
      adapter: new SQLiteAdapter(),
      dialect: "sqlite",
      constructorSql: "json_object('longitude', ?, 'latitude', ?)",
      createManySql:
        "INSERT INTO \"places\" (\"id\", \"location\", \"optionalLocation\") VALUES (?, json_object('longitude', ?, 'latitude', ?), NULL), (?, json_object('longitude', ?, 'latitude', ?), NULL)",
    },
  ] satisfies readonly (GeoPointProviderCase & {
    readonly constructorSql: string;
    readonly createManySql: string;
  })[])("lowers point values for writes on $name", async ({
    adapter,
    dialect,
    constructorSql,
    createManySql,
  }) => {
    // A write compiles to no single statement (build() refuses it), so the
    // witness is the INSERT the operation hands the driver. The mock inserts
    // nothing; only the emitted statement is witnessed, not the outcome.
    const driver = new MockDriver(adapter, dialect);
    const client = createClient({ schema: models, driver });
    const insertsOf = () =>
      driver.statements.filter(({ sql: text }) => text.startsWith("INSERT"));
    try {
      await client.place
        .create({ data: { id: "place-1", location: paris } })
        .catch((error: unknown) => {
          expect(error).toBeInstanceOf(TransactionError);
        });
      const [create] = insertsOf();
      expect(create?.sql).toContain(constructorSql);
      expect(create?.params.slice(0, 3)).toEqual([
        "place-1",
        paris.longitude,
        paris.latitude,
      ]);

      await expect(
        client.place.createMany({
          data: [
            { id: "place-2", location: paris },
            {
              id: "place-3",
              location: { longitude: -73.9857, latitude: 40.7484 },
            },
          ],
        })
      ).rejects.toBeInstanceOf(TransactionError);
      expect(insertsOf().slice(1)).toEqual([
        {
          sql: createManySql,
          params: [
            "place-2",
            paris.longitude,
            paris.latitude,
            "place-3",
            -73.9857,
            40.7484,
          ],
        },
      ]);
    } finally {
      await client.$disconnect();
    }
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

    // `every` lowers to NOT EXISTS (... AND NOT (predicate)): the predicate is
    // negated inside the correlated subquery that would scan the index, so
    // the positive-only prefilter is withheld there too.
    const every = engine.build(region, "findMany", {
      where: { venues: { every: { location: { distance } } } },
      select: { id: true },
    });
    expect(every.toStatement("$n")).not.toContain(" && ");

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
    expect(statement).toContain('AS "_distance"');
    expect(statement).toContain("DESC NULLS LAST");
  });

  /**
   * Each refused input below was refused by a VibORM geometry pre-check
   * before decision D2 or crosses itself on the sphere. PostGIS answers all
   * but one of them silently (only the 180-degree edge raises), wrongly,
   * differently from MySQL, or on an unstated reading, so they are refused
   * again at admission. The admitted ones are valid only on the great-circle
   * reading both databases share, and reach the adapter emission unchanged,
   * rings closed once. Holes are written clockwise and outers
   * counterclockwise, so the emitted order is the input order.
   */
  const g = (longitude: number, latitude: number) => ({ longitude, latitude });
  const square = [g(0, 0), g(4, 0), g(4, 4), g(0, 4)];
  const wide = [g(0, 0), g(10, 0), g(10, 10), g(0, 10)];
  // Its south edge bows north to about latitude 40.105 at longitude 5, its
  // north edge to about 50.10.
  const box = [g(0, 40), g(10, 40), g(10, 50), g(0, 50)];
  const turn = (longitude: number) =>
    longitude > 180 ? longitude - 360 : longitude;
  type Polygon = {
    readonly outer: readonly { longitude: number; latitude: number }[];
    readonly holes?: readonly (readonly {
      longitude: number;
      latitude: number;
    }[])[];
  };
  const refused: readonly {
    readonly name: string;
    readonly polygon: Polygon;
    readonly issue: { readonly message: string; readonly path: unknown[] };
  }[] = [
    {
      name: "a repeated vertex",
      polygon: { outer: [g(0, 0), g(1, 0), g(1, 1), g(1, 0)] },
      issue: {
        message: "A GeoPolygon ring cannot self-intersect",
        path: ["outer"],
      },
    },
    {
      name: "a bowtie",
      polygon: { outer: [g(0, 0), g(1, 1), g(0, 1), g(1, 0)] },
      issue: {
        message: "A GeoPolygon ring cannot self-intersect",
        path: ["outer"],
      },
    },
    {
      name: "a zero-area ring",
      polygon: { outer: [g(0, 0), g(1, 0), g(2, 0)] },
      issue: {
        message: "A GeoPolygon ring must have non-zero area",
        path: ["outer"],
      },
    },
    {
      name: "a 180-degree edge",
      polygon: { outer: [g(0, 0), g(180, 0), g(1, 1)] },
      issue: {
        message: "A GeoPolygon edge cannot span exactly 180 degrees",
        path: ["outer", 1],
      },
    },
    {
      name: "a north pole vertex",
      polygon: { outer: [g(10, 80), g(0, 90), g(-10, 80)] },
      issue: {
        message: "A GeoPolygon ring cannot contain a pole",
        path: ["outer", 1],
      },
    },
    {
      name: "a south pole vertex",
      polygon: { outer: [g(-10, -80), g(0, -90), g(10, -80)] },
      issue: {
        message: "A GeoPolygon ring cannot contain a pole",
        path: ["outer", 1],
      },
    },
    {
      name: "a ring winding around a pole",
      polygon: { outer: [g(-120, 80), g(0, 80), g(120, 80)] },
      issue: { message: "A GeoPolygon cannot contain a pole", path: ["outer"] },
    },
    {
      name: "the tropics band",
      polygon: {
        outer: [
          g(-170, -30),
          g(0, -30),
          g(170, -30),
          g(170, 30),
          g(0, 30),
          g(-170, 30),
        ],
      },
      issue: {
        message:
          "A GeoPolygon cannot reach across the equator and the 0/180 and 90/-90 meridians at once",
        path: ["outer"],
      },
    },
    {
      name: "a nearly antipodal edge",
      polygon: { outer: [g(0, 10), g(179.999_999, -10), g(90, 40)] },
      issue: {
        message: "A GeoPolygon edge must be shorter than 150 degrees",
        path: ["outer", 1],
      },
    },
    {
      name: "a square 1e-5 degrees across",
      polygon: {
        outer: [
          g(10, 60),
          g(10.000_01, 60),
          g(10.000_01, 60.000_01),
          g(10, 60.000_01),
        ],
      },
      issue: {
        message: "A GeoPolygon ring must be at least 2e-5 degrees across",
        path: ["outer"],
      },
    },
    {
      name: "a hole outside",
      polygon: { outer: square, holes: [[g(5, 5), g(6, 6), g(6, 5)]] },
      issue: {
        message: "A GeoPolygon hole must be strictly inside its outer ring",
        path: ["holes", 0],
      },
    },
    {
      name: "overlapping holes",
      polygon: {
        outer: [g(0, 0), g(6, 0), g(6, 6), g(0, 6)],
        holes: [
          [g(1, 1), g(1, 4), g(4, 4), g(4, 1)],
          [g(3, 3), g(3, 5), g(5, 5), g(5, 3)],
        ],
      },
      issue: {
        message: "GeoPolygon holes cannot touch or overlap",
        path: ["holes", 1],
      },
    },
    {
      name: "a hole nested in a hole",
      polygon: {
        outer: wide,
        holes: [
          [g(2, 2), g(2, 5), g(5, 5), g(5, 2)],
          [g(3, 3), g(3, 4), g(4, 4), g(4, 3)],
        ],
      },
      issue: {
        message: "GeoPolygon holes cannot touch or overlap",
        path: ["holes", 1],
      },
    },
    {
      name: "a hole enclosing a hole",
      polygon: {
        outer: wide,
        holes: [
          [g(3, 3), g(3, 4), g(4, 4), g(4, 3)],
          [g(2, 2), g(2, 5), g(5, 5), g(5, 2)],
        ],
      },
      issue: {
        message: "GeoPolygon holes cannot touch or overlap",
        path: ["holes", 1],
      },
    },
    {
      name: "a ring past a whole turn over itself",
      polygon: {
        outer: [
          g(0, 0),
          g(80, 0),
          g(160, 0),
          g(-120, 0),
          g(-40, 0),
          g(40, 0),
          g(40, 2),
          g(-40, 2),
          g(-120, 2),
          g(160, 2),
          g(80, 2),
          g(0, 2),
        ],
      },
      issue: {
        message: "A GeoPolygon ring cannot self-intersect",
        path: ["outer"],
      },
    },
    {
      name: "a hole touching",
      polygon: { outer: square, holes: [[g(0, 1), g(1, 2), g(1, 1)]] },
      issue: {
        message: "A GeoPolygon hole must be strictly inside its outer ring",
        path: ["holes", 0],
      },
    },
    {
      name: "a hole along an outer edge",
      polygon: {
        outer: square,
        holes: [[g(0, 1), g(0, 2), g(1, 2), g(1, 1)]],
      },
      issue: {
        message: "A GeoPolygon hole must be strictly inside its outer ring",
        path: ["holes", 0],
      },
    },
    {
      name: "a hole touching a parallel edge in the plane",
      polygon: { outer: box, holes: [[g(5, 40), g(4, 45), g(6, 45)]] },
      issue: {
        message: "A GeoPolygon hole must be strictly inside its outer ring",
        path: ["holes", 0],
      },
    },
    {
      name: "a hole inside the plane's edge but outside the great-circle arc",
      polygon: { outer: box, holes: [[g(5, 40.05), g(4, 45), g(6, 45)]] },
      issue: {
        message: "A GeoPolygon hole must be strictly inside its outer ring",
        path: ["holes", 0],
      },
    },
    {
      name: "holes touching at one point",
      polygon: {
        outer: wide,
        holes: [
          [g(1, 1), g(1, 3), g(3, 3), g(3, 1)],
          [g(3, 3), g(3, 5), g(5, 5), g(5, 3)],
        ],
      },
      issue: {
        message: "GeoPolygon holes cannot touch or overlap",
        path: ["holes", 1],
      },
    },
    {
      name: "a hole touching another's parallel edge in the plane",
      polygon: {
        outer: box,
        holes: [
          [g(2, 42), g(2, 44), g(8, 44), g(8, 42)],
          [g(5, 44), g(4, 46), g(6, 46)],
        ],
      },
      issue: {
        message: "GeoPolygon holes cannot touch or overlap",
        path: ["holes", 1],
      },
    },
  ];
  const admitted: readonly {
    readonly name: string;
    readonly polygon: Polygon;
  }[] = [
    {
      name: "a closed ring",
      polygon: { outer: [g(0, 0), g(1, 0), g(1, 1), g(0, 0)] },
    },
    {
      name: "a hole beyond the plane's north edge, inside its great-circle arc",
      polygon: { outer: box, holes: [[g(5, 50.05), g(6, 49), g(4, 49)]] },
    },
    {
      name: "a band past a whole turn beside itself",
      polygon: {
        outer: [
          ...Array.from({ length: 21 }, (_, step) =>
            g(turn(step * 20), 10 + step / 2)
          ),
          ...Array.from({ length: 21 }, (_, step) =>
            g(turn(400 - step * 20), 22 - step / 2)
          ),
        ],
      },
    },
  ];
  const emittedGeoJson = (polygon: Polygon) =>
    JSON.stringify({
      type: "Polygon",
      coordinates: [polygon.outer, ...(polygon.holes ?? [])].map((ring) =>
        [...ring, ...ring.slice(0, 1)].map(({ longitude, latitude }) => [
          longitude,
          latitude,
        ])
      ),
    });
  const withinPolygon = (engine: QueryEngine, polygon: Polygon) =>
    engine.build(place, "findMany", {
      where: { location: { within: { polygon } } },
      select: { id: true },
    });

  test.each(refused)("refuses $name before any SQL", ({ polygon, issue }) => {
    expect(validateGeoPolygon(polygon)).toEqual({ issues: [issue] });
    for (const engine of [
      createEngine(new PostgresAdapter("public", true), "postgresql"),
      createEngine(new MySQLAdapter(), "mysql"),
    ]) {
      expect(() => withinPolygon(engine, polygon)).toThrow(issue.message);
    }
  });

  test.each(admitted)("admits $name and emits it for PostgreSQL and MySQL", ({
    polygon,
  }) => {
    const postgres = withinPolygon(
      createEngine(new PostgresAdapter("public", true), "postgresql"),
      polygon
    );
    expect(postgres.toStatement("$n")).toContain(
      "ST_Intersects(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography, "
    );
    expect(postgres.values).toEqual([emittedGeoJson(polygon)]);

    const mysql = withinPolygon(
      createEngine(new MySQLAdapter(), "mysql"),
      polygon
    );
    expect(mysql.toStatement("$n")).toContain(
      "ST_Intersects(ST_GeomFromGeoJSON($1, 1, 4326), "
    );
    expect(mysql.values).toEqual([emittedGeoJson(polygon)]);

    // Admission passed: SQLite refuses the operation, not the value.
    expect(() =>
      withinPolygon(createEngine(new SQLiteAdapter(), "sqlite"), polygon)
    ).toThrow(FeatureNotSupportedError);
  });

  test("emits an empty hole list as no hole and a hole list in input order", () => {
    const engine = createEngine(
      new PostgresAdapter("public", true),
      "postgresql"
    );
    const holes = [
      [g(1, 1), g(1, 2), g(2, 2), g(2, 1)],
      [g(3, 3), g(3, 3.5), g(3.5, 3.5), g(3.5, 3)],
    ];
    expect(withinPolygon(engine, { outer: square, holes: [] }).values).toEqual([
      emittedGeoJson({ outer: square }),
    ]);
    expect(withinPolygon(engine, { outer: square, holes }).values).toEqual([
      emittedGeoJson({ outer: square, holes }),
    ]);
  });

  test("still refuses a ring shorter than three vertices before any SQL", () => {
    const engine = createEngine(
      new PostgresAdapter("public", true),
      "postgresql"
    );
    for (const [polygon, path] of [
      [{ outer: [] }, ["outer"]],
      [{ outer: [g(0, 0), g(1, 0)] }, ["outer"]],
      [{ outer: square, holes: [[g(1, 1), g(2, 1)]] }, ["holes", 0]],
    ] as const) {
      expect(() => withinPolygon(engine, polygon)).toThrow(
        "A GeoPolygon ring needs at least 3 vertices"
      );
      expect(validateGeoPolygon(polygon).issues).toEqual([
        { message: "A GeoPolygon ring needs at least 3 vertices", path },
      ]);
    }
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
