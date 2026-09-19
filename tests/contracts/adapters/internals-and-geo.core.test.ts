import {
  assembleAdapterSelect,
  getAdapterInternals,
  installAdapterInternals,
} from "@adapters/adapter-internals";
import { installGeoPointSql } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createOnConflictBatchRefs } from "@adapters/shared/batch-refs";
import {
  geoBoundsIndexPolygons,
  geoPolygonJson,
} from "@adapters/shared/geo-point";
import { Sql, sql } from "@sql";

function expectComposable(fragment: Sql): void {
  // biome-ignore lint/suspicious/noMisplacedAssertion: This shared helper is invoked only from registered tests.
  expect(fragment).toBeInstanceOf(Sql);
  // biome-ignore lint/suspicious/noMisplacedAssertion: This shared helper is invoked only from registered tests.
  expect(fragment.toStatement().length).toBeGreaterThan(0);
  // biome-ignore lint/suspicious/noMisplacedAssertion: This shared helper is invoked only from registered tests.
  expect(Array.isArray(fragment.values)).toBe(true);
}

describe("adapter SELECT assembly", () => {
  test("plain SELECTs retain every optional clause and dialect locking rule", () => {
    const adapters = [
      { name: "postgres", adapter: new PostgresAdapter() },
      { name: "mysql", adapter: new MySQLAdapter() },
      { name: "sqlite", adapter: new SQLiteAdapter() },
    ];

    for (const { name, adapter } of adapters) {
      const statement = assembleAdapterSelect(adapter, {
        columns: sql.raw`u.id`,
        from: sql.raw`users AS u`,
        joins: [sql.raw`LEFT JOIN posts AS p ON p.user_id = u.id`],
        where: sql`u.id = ${1}`,
        groupBy: sql.raw`u.id`,
        having: sql`COUNT(p.id) > ${0}`,
        orderBy: sql.raw`u.id DESC`,
        limit: sql`${10}`,
        offset: sql`${2}`,
        forUpdate: true,
      });
      const text = statement.toStatement();

      expect(text).toContain("SELECT u.id FROM users AS u");
      expect(text).toContain("LEFT JOIN posts AS p");
      expect(text).toContain("WHERE u.id =");
      expect(text).toContain("GROUP BY u.id");
      expect(text).toContain("HAVING COUNT(p.id) >");
      expect(text).toContain("ORDER BY u.id DESC");
      expect(text).toContain("LIMIT");
      expect(text).toContain("OFFSET");
      expect(text.includes("FOR UPDATE")).toBe(name !== "sqlite");
      expect(statement.values).toEqual(
        name === "mysql" ? [1, 0] : [1, 0, 10, 2]
      );
    }
  });

  test("offset-only SELECTs use only the dialects' required no-limit sentinel", () => {
    const postgres = assembleAdapterSelect(new PostgresAdapter(), {
      columns: sql.raw`id`,
      from: sql.raw`users`,
      offset: sql`${2}`,
    });
    const mysql = assembleAdapterSelect(new MySQLAdapter(), {
      columns: sql.raw`id`,
      from: sql.raw`users`,
      offset: sql`${2}`,
    });
    const sqlite = assembleAdapterSelect(new SQLiteAdapter(), {
      columns: sql.raw`id`,
      from: sql.raw`users`,
      offset: sql`${2}`,
    });

    expect(postgres.toStatement()).toBe("SELECT id FROM users OFFSET ?");
    expect(postgres.values).toEqual([2]);
    expect(mysql.toStatement()).toBe(
      "SELECT id FROM users LIMIT 18446744073709551615 OFFSET 2"
    );
    expect(mysql.values).toEqual([]);
    expect(sqlite.toStatement()).toBe("SELECT id FROM users LIMIT -1 OFFSET ?");
    expect(sqlite.values).toEqual([2]);
  });

  test("MySQL inlines only a single integer LIMIT or OFFSET parameter", () => {
    const adapter = new MySQLAdapter();
    expect(adapter.clauses.limit(sql`${5}`).toStatement()).toBe("LIMIT 5");
    expect(adapter.clauses.offset(sql`${3}`).toStatement()).toBe("OFFSET 3");
    expect(adapter.clauses.limit(sql`${1.5}`).toStatement()).toBe("LIMIT ?");
    expect(adapter.clauses.limit(sql`${"5"}`).toStatement()).toBe("LIMIT ?");
    expect(adapter.clauses.limit(sql`COALESCE(${5}, ${6})`).toStatement()).toBe(
      "LIMIT COALESCE(?, ?)"
    );
  });

  test("native PostgreSQL DISTINCT ON is used only without user ordering", () => {
    const adapter = new PostgresAdapter();
    const native = assembleAdapterSelect(adapter, {
      columns: sql.raw`id, name`,
      from: sql.raw`users`,
      distinct: sql.raw`name`,
    });
    const emulated = assembleAdapterSelect(adapter, {
      columns: sql.raw`id, name`,
      from: sql.raw`users`,
      distinct: sql.raw`name`,
      distinctColumnAliases: ["id", "name"],
      orderBy: sql.raw`id DESC`,
    });

    expect(native.toStatement()).toBe(
      "SELECT DISTINCT ON (name) id, name FROM users"
    );
    expect(emulated.toStatement()).toContain("ROW_NUMBER() OVER");
    expect(emulated.toStatement()).toContain('SELECT "id", "name" FROM');
    expect(emulated.toStatement()).toContain('ORDER BY "_ord"');
  });

  test("MySQL and SQLite emulate DISTINCT with both explicit and fallback projections", () => {
    const mysql = assembleAdapterSelect(new MySQLAdapter(), {
      columns: sql.raw`id, name`,
      from: sql.raw`users`,
      joins: [sql.raw`LEFT JOIN posts ON posts.user_id = users.id`],
      where: sql`active = ${true}`,
      groupBy: sql.raw`id, name`,
      having: sql`COUNT(*) > ${0}`,
      distinct: sql.raw`name`,
      distinctColumnAliases: ["id", "name"],
      orderBy: sql.raw`id DESC`,
      offset: sql`${2}`,
    });
    const sqlite = assembleAdapterSelect(new SQLiteAdapter(), {
      columns: sql.raw`id, name`,
      from: sql.raw`users`,
      distinct: sql.raw`name`,
      limit: sql`${5}`,
    });

    expect(mysql.toStatement()).toContain("ROW_NUMBER() OVER");
    expect(mysql.toStatement()).toContain("SELECT `id`, `name` FROM");
    expect(mysql.toStatement()).toContain(
      "LIMIT 18446744073709551615 OFFSET 2"
    );
    expect(mysql.values).toEqual([true, 0]);
    expect(sqlite.toStatement()).toContain("SELECT * FROM");
    expect(sqlite.toStatement()).toContain('WHERE "_rn" = 1 LIMIT ?');
    expect(sqlite.values).toEqual([5]);
  });

  test("empty and absent joins do not add empty SQL", () => {
    const adapter = new SQLiteAdapter();
    const absent = assembleAdapterSelect(adapter, {
      columns: sql.raw`id`,
      from: sql.raw`users`,
    });
    const empty = assembleAdapterSelect(adapter, {
      columns: sql.raw`id`,
      from: sql.raw`users`,
      joins: [],
    });
    expect(absent.toStatement()).toBe("SELECT id FROM users");
    expect(empty.toStatement()).toBe("SELECT id FROM users");
  });
});

describe("private adapter seam", () => {
  test("owns exact provider constraint names without a public property", () => {
    const postgres = new PostgresAdapter();
    const mysql = new MySQLAdapter();
    const sqlite = new SQLiteAdapter();

    expect(
      getAdapterInternals(postgres).constraints.primaryKey("account", ["id"])
    ).toEqual({
      name: "account_pkey",
      normalizedError: { table: "account", constraint: "account_pkey" },
    });
    expect(
      getAdapterInternals(mysql).constraints.primaryKey("account", ["id"])
    ).toEqual({
      name: "PRIMARY",
      normalizedError: { table: "account", constraint: "PRIMARY" },
    });
    expect(
      getAdapterInternals(sqlite).constraints.unique("account", "email", [
        "email_address",
      ])
    ).toEqual({
      name: "account_email_key",
      normalizedError: { columns: ["account.email_address"] },
    });
    // The other half of the same matrix: a named dialect identifies a unique
    // key by CONSTRAINT, and SQLite identifies a primary key by qualified
    // COLUMNS, because that is the only evidence each provider's error gives.
    for (const named of [postgres, mysql]) {
      expect(
        getAdapterInternals(named).constraints.unique("account", "email", [
          "email_address",
        ])
      ).toEqual({
        name: "account_email_key",
        normalizedError: { table: "account", constraint: "account_email_key" },
      });
    }
    expect(
      getAdapterInternals(sqlite).constraints.primaryKey("account", [
        "id",
        "tenant",
      ])
    ).toEqual({
      name: "account_pkey",
      normalizedError: { columns: ["account.id", "account.tenant"] },
    });
    for (const adapter of [postgres, mysql, sqlite]) {
      expect("constraints" in adapter).toBe(false);
    }
  });

  test("stock adapters expose batch-reference SQL without a public property", () => {
    for (const adapter of [
      new PostgresAdapter(),
      new MySQLAdapter(),
      new SQLiteAdapter(),
    ]) {
      const batchRefs = getAdapterInternals(adapter).batchRefs;
      const setup = batchRefs.setup("batch-1");
      expect(setup).toHaveLength(1);
      const [setupStatement] = setup;
      if (!setupStatement) throw new Error("Batch setup statement is absent");
      expectComposable(setupStatement);
      expectComposable(batchRefs.clear("batch-1"));
      expectComposable(batchRefs.cleanup("batch-1"));
      expectComposable(batchRefs.store("batch-1", "user", sql`SELECT ${1}`));
      expectComposable(batchRefs.read("batch-1", "user"));
      if (batchRefs.storeLastInsertId) {
        expectComposable(batchRefs.storeLastInsertId("batch-1", "user"));
      }
      if (batchRefs.storeReturning) {
        expectComposable(
          batchRefs.storeReturning(
            "batch-1",
            "user",
            sql`INSERT INTO ${sql.raw`"users"`} DEFAULT VALUES`,
            sql.raw`"id"`
          )
        );
      }
      expect("batchRefs" in adapter).toBe(false);
    }
  });

  test("the PostgreSQL batch store carries an INSERT's own RETURNING through a data-modifying CTE (D-50)", () => {
    const postgres = getAdapterInternals(new PostgresAdapter()).batchRefs;
    expect(
      getAdapterInternals(new MySQLAdapter()).batchRefs.storeReturning
    ).toBeUndefined();
    expect(
      getAdapterInternals(new SQLiteAdapter()).batchRefs.storeReturning
    ).toBeUndefined();
    const stored = postgres.storeReturning!(
      "batch-1",
      "7",
      sql`INSERT INTO ${sql.raw`"users"`} (${sql.raw`"name"`}) VALUES (${"Ada"})`,
      sql.raw`"id"`
    );
    const statement = stored.toStatement();
    expect(
      statement.startsWith(
        'WITH "__viborm_inserted" AS (INSERT INTO "users" ("name") VALUES ('
      )
    ).toBe(true);
    expect(statement).toContain(
      'RETURNING "id") INSERT INTO "__viborm_batch_refs" ("batch_id", "ref_key", "ref_value") SELECT '
    );
    expect(
      statement.endsWith('CAST("id" AS TEXT) FROM "__viborm_inserted"')
    ).toBe(true);
    expect(stored.values).toEqual(["Ada", "batch-1", "7"]);
  });

  test("the dialect states how a generated increment key is stored, in order (D-50)", () => {
    const insert = sql`INSERT INTO ${sql.raw`"users"`} DEFAULT VALUES`;
    const column = sql.raw`"id"`;
    const shapes = (adapter: PostgresAdapter | MySQLAdapter | SQLiteAdapter) =>
      getAdapterInternals(adapter)
        .batchRefs.storeInsertedKey?.("batch-1", "7", insert, column)
        .map((statement) => statement.toStatement().split(" ")[0]);
    // PostgreSQL: the CTE store is the INSERT itself, one statement.
    expect(shapes(new PostgresAdapter())).toEqual(["WITH"]);
    // SQLite and MySQL: the INSERT, then the last insert id store.
    expect(shapes(new SQLiteAdapter())).toEqual(["INSERT", "INSERT"]);
    expect(shapes(new MySQLAdapter())).toEqual(["INSERT", "INSERT"]);
    // A PostgreSQL that cannot mutate inside a CTE offers no exact key store
    // at all: lastval() is session-global, and the capability is read live.
    const adapter = new PostgresAdapter();
    adapter.capabilities.supportsCteWithMutations = false;
    const refs = getAdapterInternals(adapter).batchRefs;
    expect(refs.storeReturning).toBeUndefined();
    expect(refs.storeInsertedKey).toBeUndefined();
    adapter.capabilities.supportsCteWithMutations = true;
    expect(refs.storeInsertedKey).toBeDefined();
    // A dialect with neither exact mechanism states no key store: the engine
    // then refuses or segments RETURNING, never guesses a session value.
    const neither = createOnConflictBatchRefs({
      table: sql.raw`"refs"`,
      batchIdColumn: sql.raw`"batch_id"`,
      keyColumn: sql.raw`"ref_key"`,
      valueColumn: sql.raw`"ref_value"`,
      createTable: sql.raw`CREATE TEMP TABLE IF NOT EXISTS "refs" ("batch_id" TEXT, "ref_key" TEXT, "ref_value" TEXT)`,
      castValue: (value) => sql`CAST((${value}) AS TEXT)`,
    });
    expect(neither.storeLastInsertId).toBeUndefined();
    expect(neither.storeReturning).toBeUndefined();
    expect(neither.storeInsertedKey).toBeUndefined();
  });

  test("the PostgreSQL batch store omits unsafe session-global identity", () => {
    expect(
      getAdapterInternals(new PostgresAdapter()).batchRefs.storeLastInsertId
    ).toBeUndefined();
    expect(
      getAdapterInternals(new MySQLAdapter()).batchRefs.storeLastInsertId
    ).toBeDefined();
    expect(
      getAdapterInternals(new SQLiteAdapter()).batchRefs.storeLastInsertId
    ).toBeDefined();
  });

  test("a detached public adapter surface has no internal seam", () => {
    const detached = { ...new PostgresAdapter() };
    expect(() => getAdapterInternals(detached)).toThrow(
      "must extend a VibORM dialect adapter"
    );
  });

  test("the installed seam cannot be replaced", () => {
    const adapter = new SQLiteAdapter();
    const internals = getAdapterInternals(adapter);
    expect(() => installAdapterInternals(adapter, { ...internals })).toThrow(
      TypeError
    );
  });
});

describe("GeoPoint protocol", () => {
  test("installation snapshots the protocol and omits absent optional members", () => {
    const target = {};
    const value = (longitude: Sql, latitude: Sql): Sql =>
      sql`point(${longitude}, ${latitude})`;
    const longitude = (point: Sql): Sql => sql`longitude(${point})`;
    const latitude = (point: Sql): Sql => sql`latitude(${point})`;
    const equals = (point: Sql): Sql => sql`${point} = point_value`;
    const withinBounds = (point: Sql): Sql => sql`${point} IN bounds_value`;

    installGeoPointSql(target, {
      value,
      longitude,
      latitude,
      equals,
      withinBounds,
    });
    const installed = Reflect.get(target, "geoPoint");
    expect(installed).toEqual({
      value,
      longitude,
      latitude,
      equals,
      withinBounds,
    });
    expect(Object.isFrozen(installed)).toBe(true);
    expect(Reflect.set(target, "geoPoint", undefined)).toBe(false);

    const absent = {};
    installGeoPointSql(absent, undefined);
    expect(Reflect.get(absent, "geoPoint")).toBeUndefined();
  });

  test("full protocols retain polygon and distance capabilities", () => {
    const target = {};
    const identity = (value: Sql): Sql => value;
    const withinPolygon = (point: Sql): Sql => sql`${point} IN polygon_value`;
    const distance = (left: Sql, right: Sql): Sql => sql`${left} - ${right}`;
    installGeoPointSql(target, {
      value: (longitude, latitude) => sql`${longitude}, ${latitude}`,
      longitude: identity,
      latitude: identity,
      equals: (point) => point,
      withinBounds: (point) => point,
      withinPolygon,
      distance,
    });
    expect(Reflect.get(target, "geoPoint")).toMatchObject({
      withinPolygon,
      distance,
    });
  });

  test("bounds polygon prefilters exclude every unsafe rectangle shape", () => {
    const ordinary = {
      west: -10,
      east: 10,
      south: -20,
      north: 20,
    };
    expect(geoBoundsIndexPolygons(ordinary)).toHaveLength(1);
    const [polygonJson] = geoBoundsIndexPolygons(ordinary);
    if (!polygonJson) throw new Error("Index polygon is absent");
    expect(JSON.parse(polygonJson)).toEqual({
      type: "Polygon",
      coordinates: [
        [
          [-10, -20],
          [10, -20],
          [10, 20],
          [-10, 20],
          [-10, -20],
        ],
      ],
    });

    for (const bounds of [
      { ...ordinary, south: -90 },
      { ...ordinary, north: 90 },
      { ...ordinary, north: -20 },
      { ...ordinary, east: -10 },
      { ...ordinary, west: 20 },
      { ...ordinary, west: -180 },
      { ...ordinary, east: 180 },
    ]) {
      expect(geoBoundsIndexPolygons(bounds)).toEqual([]);
    }
  });

  test("polygon JSON closes outer and hole rings", () => {
    const withoutHoles = geoPolygonJson({
      outer: [
        { longitude: 0, latitude: 0 },
        { longitude: 2, latitude: 0 },
        { longitude: 0, latitude: 2 },
      ],
    });
    const withHoles = geoPolygonJson({
      outer: [
        { longitude: 0, latitude: 0 },
        { longitude: 4, latitude: 0 },
        { longitude: 0, latitude: 4 },
      ],
      holes: [
        [
          { longitude: 1, latitude: 1 },
          { longitude: 2, latitude: 1 },
          { longitude: 1, latitude: 2 },
        ],
      ],
    });

    expect(JSON.parse(withoutHoles).coordinates).toHaveLength(1);
    expect(JSON.parse(withHoles).coordinates).toHaveLength(2);
    expect(JSON.parse(withHoles).coordinates[1][0]).toEqual([1, 1]);
    expect(JSON.parse(withHoles).coordinates[1][3]).toEqual([1, 1]);
  });

  test("coordinate predicates preserve canonical meridians and bounds", () => {
    const postgis = new PostgresAdapter("public", true);
    const postgres = postgis.geoPoint;
    if (!postgres) throw new Error("PostGIS protocol was not installed");
    const mysql = new MySQLAdapter().geoPoint;
    const sqlite = new SQLiteAdapter().geoPoint;

    for (const geoPoint of [postgres, mysql, sqlite]) {
      expectComposable(geoPoint.value(sql`${2}`, sql`${3}`));
      expectComposable(geoPoint.longitude(sql.raw`location`));
      expectComposable(geoPoint.latitude(sql.raw`location`));
      expectComposable(
        geoPoint.equals(sql.raw`location`, { longitude: 20, latitude: 10 })
      );
      expectComposable(
        geoPoint.equals(sql.raw`location`, { longitude: 180, latitude: 10 })
      );
      expectComposable(
        geoPoint.withinBounds(sql.raw`location`, {
          west: -180,
          east: 180,
          south: -90,
          north: 90,
        })
      );
      expectComposable(
        geoPoint.withinBounds(sql.raw`location`, {
          west: 170,
          east: -170,
          south: -20,
          north: 20,
        })
      );
      expectComposable(
        geoPoint.withinBounds(sql.raw`location`, {
          west: -180,
          east: 10,
          south: -20,
          north: 20,
        })
      );
      expectComposable(
        geoPoint.withinBounds(sql.raw`location`, {
          west: -10,
          east: 180,
          south: -20,
          north: 20,
        })
      );
      expectComposable(
        geoPoint.withinBounds(sql.raw`location`, {
          west: -10,
          east: 10,
          south: -20,
          north: 20,
        })
      );
    }
  });

  test("full providers bind polygon and distance operands", () => {
    const postgis = new PostgresAdapter("public", true).geoPoint;
    if (!(postgis?.withinPolygon && postgis.distance)) {
      throw new Error("PostGIS full protocol was not installed");
    }
    const mysql = new MySQLAdapter().geoPoint;
    if (!(mysql.withinPolygon && mysql.distance)) {
      throw new Error("MySQL full protocol was not installed");
    }
    const polygon = {
      outer: [
        { longitude: 0, latitude: 0 },
        { longitude: 2, latitude: 0 },
        { longitude: 0, latitude: 2 },
      ],
    };

    expectComposable(postgis.withinPolygon(sql.raw`location`, polygon));
    expectComposable(
      postgis.distance(sql.raw`left_point`, sql.raw`right_point`)
    );
    expectComposable(mysql.withinPolygon(sql.raw`location`, polygon));
    expectComposable(mysql.distance(sql.raw`left_point`, sql.raw`right_point`));
  });
});

describe("adapter result hooks", () => {
  const passthrough = Symbol("passthrough");
  const next = (value?: unknown): unknown =>
    value === undefined ? passthrough : value;

  test("PostgreSQL passes every result through", () => {
    // Until D-40 the first line answered 5: the leg offered
    // `convertBigIntToNumber(raw)` for every verb. `Queries.decodeResult` hands
    // this leg the operation's ROW ARRAY, so the bigint it tested for could not
    // arrive — measured `undefined` on all 40 live asks, `pg` and `postgres.js`
    // — and an integer's width is a VALUE's fact the engine's `int` codec owns.
    const result = new PostgresAdapter().result;
    expect(result.parseResult(5n, "count", next)).toBe(passthrough);
    expect(result.parseResult([{ _count: "5" }], "count", next)).toBe(
      passthrough
    );
    expect(result.parseResult(5, "count", next)).toBe(passthrough);
    expect(result.parseRelation({}, next)).toBe(passthrough);
    expect(result.parseField("value", "string", next)).toBe(passthrough);
  });

  test("MySQL normalizes booleans and naive UTC datetimes, and passes results through", () => {
    // Until D-40 the first two lines answered `[{ "0viborm_count_result": … }]`:
    // the leg offered `normalizeCountResult(raw)` for `count`/`exist`. This
    // engine names the column `_count` and mysql2 preserves that alias, so the
    // leg was asked about `[{ _count: 2 }]` and decided nothing on all 20 live
    // asks — its `count`/`exist` arm was entered on 10 of them and answered
    // `undefined` every time; the key it produced is one the decoder cannot
    // read either.
    const result = new MySQLAdapter().result;
    expect(result.parseResult([{ "COUNT(*)": 2 }], "count", next)).toBe(
      passthrough
    );
    expect(result.parseResult({ "COUNT(*)": 1 }, "exist", next)).toBe(
      passthrough
    );
    expect(result.parseResult([{ _count: 2 }], "count", next)).toBe(
      passthrough
    );
    expect(result.parseResult([{ id: 1 }], "count", next)).toBe(passthrough);
    expect(result.parseResult([{ "COUNT(*)": 2 }], "findMany", next)).toBe(
      passthrough
    );
    expect(result.parseRelation("{}", next)).toBe(passthrough);
    expect(result.parseField(1, "boolean", next)).toBe(true);
    expect(result.parseField(0n, "boolean", next)).toBe(false);
    expect(result.parseField(2, "boolean", next)).toBe(passthrough);
    expect(result.parseField("2024-01-02 03:04:05", "datetime", next)).toBe(
      "2024-01-02T03:04:05.000Z"
    );
    expect(result.parseField("2024-01-02T03:04:05.1", "datetime", next)).toBe(
      "2024-01-02T03:04:05.100Z"
    );
    expect(result.parseField("not-a-date", "datetime", next)).toBe(passthrough);
    expect(result.parseField(5, "datetime", next)).toBe(passthrough);
    expect(result.parseField("value", "string", next)).toBe(passthrough);
  });

  test("SQLite publishes physical promises and otherwise passes through", () => {
    // The dialect whose result leg was ALWAYS the contract's pass-through, and
    // after D-40 the shape all three share.
    const result = new SQLiteAdapter().result;
    expect(result.decimalRepresentation).toBe("coefficient");
    expect(result.decimalListRepresentation).toBe("coefficient");
    expect(result.dateTimeRepresentation).toBeDefined();
    expect(result.parseResult({}, "findMany", next)).toBe(passthrough);
    expect(result.parseRelation({}, next)).toBe(passthrough);
    expect(result.parseField(1, "int", next)).toBe(passthrough);
  });
});
