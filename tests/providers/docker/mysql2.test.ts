/**
 * mysql2 Driver Tests
 *
 * Provider-boundary sentinels: driver construction, result aliases, GeoPoint
 * geometry and its spatial index, referential-action and composite-key DDL,
 * the compound-key, junction and polymorphic contracts that share that DDL
 * shape, the MySQL collation probes, and the namespace-containment estate.
 *
 * One program per file has to fit the 1280 MB TypeScript shard heap, and the
 * type inference a behavior module's schemas force is what that heap holds, so
 * this suite is split by schema across `mysql2*.test.ts`. Every piece keeps the
 * `MySQL2 Driver` describe and its drop-everything `beforeEach`, so test names
 * and per-test lifecycle are unchanged.
 *
 * NOTE: These tests require a running MySQL database (e.g. docker).
 * Set MYSQL_TEST_CONNECTION_STRING to enable, e.g.:
 *   docker run -d --name viborm-mysql -p 3307:3306 \
 *     -e MYSQL_ROOT_PASSWORD=password -e MYSQL_DATABASE=viborm mysql:8
 *   MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm
 */

import { COUNT_RESULT_KEY } from "@adapters/shared/result-parsing";
import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { instrumentation } from "@instrumentation/extension";
import { createMigrationClient, MemoryEstateStorage } from "@migrations";
import { introspect } from "@migrations/push";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import {
  DISTANCE_RESULT_KEY,
  EMPTY_ROW_RESULT_KEY,
  getAggregateResultKey,
  RELATION_COUNTS_RESULT_KEY,
} from "@query-engine/result-aliases";
import { s } from "@schema";
import { sql } from "@sql";
import { compoundJunctionContract } from "@tests/contracts/drivers/behaviors/compound-junction-behavior";
import { compoundKeyContract } from "@tests/contracts/drivers/behaviors/compound-key-behavior";
import { geoPointContract } from "@tests/contracts/drivers/behaviors/geopoint-behavior";
import { geoPointMigrationLifecycleContract } from "@tests/contracts/drivers/behaviors/geopoint-migration-lifecycle-behavior";
import { polymorphicCollectionReadContract } from "@tests/contracts/drivers/behaviors/polymorphic-collection-read-behavior";
import { polymorphicCollectionWriteContract } from "@tests/contracts/drivers/behaviors/polymorphic-collection-write-behavior";
import { polymorphicMemberJunctionContract } from "@tests/contracts/drivers/behaviors/polymorphic-member-junction-behavior";
import { polymorphicRelationContract } from "@tests/contracts/drivers/behaviors/polymorphic-relation-behavior";
import { MySQL2BatchForcedDriver } from "@tests/fixtures/drivers/batch-forced-mysql2";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { createSchemaRegistry } from "@validation";
import { validateGeoPolygon } from "@validation/primitives/geo-area-codec";
import type { Pool as MySQLPool } from "mysql2/promise";
import {
  createMySQL2Driver,
  dropEveryLiveTable,
  TEST_CONNECTION_STRING,
} from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

/**
 * An indexed string column on a table `syncLiveSchema()` creates, so the collation is
 * `utf8mb4_0900_bin` — the one every viborm table lives in. Plan §10.2.
 */
const planProbe = s
  .model({ id: s.string().id(), name: s.string() })
  .index(["name"])
  .map("l102_plan_probes");

const planProbeSchema = { planProbe };

const geoPointPlanPlace = s
  .model({
    id: s.string().id(),
    location: s.point(),
  })
  .index(["location"], { type: "spatial" })
  .map("geopoint_plan_places");
const geoPointPlanSchema = { place: geoPointPlanPlace };

type PlanProbeClient = {
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<unknown>;
  $queryRawUnsafe: <T>(sql: string, ...values: unknown[]) => Promise<T[]>;
  $disconnect: () => Promise<void>;
};

describeIf("MySQL2 Driver", () => {
  // The shared behavior suites assume a fresh database (the local drivers are
  // in-memory). MySQL persists between tests, so drop everything first:
  // pushing an empty schema diffs to dropTable for every existing table.
  beforeEach(dropEveryLiveTable);

  geoPointContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
    tier: "full",
    rawSelectSql:
      "SELECT `location` FROM `geopoint_behavior_places` WHERE `id` = 'raw'",
  });

  geoPointMigrationLifecycleContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
    physicalType: "POINT SRID 4326",
    physicalIndexType: "spatial",
  });

  test("creates driver with connection string", async () => {
    const driver = createMySQL2Driver();
    expect(driver.dialect).toBe("mysql");
    expect(driver.adapter).toBeDefined();
    await driver.disconnect();
  });

  test("preserves every private result alias exactly", async () => {
    const driver = createMySQL2Driver();
    const aliases = [
      COUNT_RESULT_KEY,
      DISTANCE_RESULT_KEY,
      RELATION_COUNTS_RESULT_KEY,
      EMPTY_ROW_RESULT_KEY,
      getAggregateResultKey("_count"),
      getAggregateResultKey("_avg"),
      getAggregateResultKey("_sum"),
      getAggregateResultKey("_min"),
      getAggregateResultKey("_max"),
    ];
    const projections = aliases.map((alias, index) =>
      driver.adapter.identifiers.aliased(sql.raw`${index + 1}`, alias)
    );

    try {
      const result = await driver._execute<Record<string, unknown>>(
        sql`SELECT ${sql.join(projections, ", ")}`
      );
      expect(Object.keys(result.rows[0] ?? {})).toEqual(aliases);
    } finally {
      await driver.disconnect();
    }
  });

  test("includes antimeridian polygon boundaries and excludes its hole", async () => {
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
    if (polygon.issues) throw new Error("Expected a valid polygon fixture");

    const driver = createMySQL2Driver();
    const geoPoint = driver.adapter.geoPoint;
    if (!geoPoint?.withinPolygon) {
      throw new Error("Expected MySQL GeoPoint polygon support");
    }
    const cases: readonly (readonly [number, number, number])[] = [
      [179, 5, 1],
      [0, 0, 0],
      [179, 0, 0],
      [170, 0, 1],
      [175, 0, 1],
    ];

    try {
      for (const [longitude, latitude, expected] of cases) {
        const storedPoint = geoPoint.value(sql`${longitude}`, sql`${latitude}`);
        const membership = geoPoint.withinPolygon(storedPoint, polygon.value);
        const result = await driver._execute<{ inside: number }>(
          sql`SELECT ${membership} AS inside`
        );
        expect(result.rows[0]?.inside).toBe(expected);
      }

      for (const [longitude, expected] of [
        [175, 1],
        [-175, 1],
        [0, 0],
      ] as const) {
        const storedPoint = geoPoint.value(sql`${longitude}`, sql`${0}`);
        const membership = geoPoint.withinBounds(storedPoint, {
          south: -10,
          west: 170,
          north: 10,
          east: -170,
        });
        const result = await driver._execute<{ inside: number }>(
          sql`SELECT ${membership} AS inside`
        );
        expect(result.rows[0]?.inside).toBe(expected);
      }
    } finally {
      await driver.disconnect();
    }
  });

  test("uses the GeoPoint spatial index only for positive indexable predicates", async () => {
    const driver = createMySQL2Driver();
    const client = createClient({ schema: geoPointPlanSchema, driver });
    try {
      await syncLiveSchema(client);
      await client.place.createMany({
        data: Array.from({ length: 5000 }, (_, index) => ({
          id: `place-${index}`,
          location: {
            longitude: (index % 358) - 179,
            latitude: ((index * 7) % 178) - 89,
          },
        })),
      });

      const registry = createModelRegistry(
        geoPointPlanSchema,
        createSchemaRegistry(geoPointPlanSchema)
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

      const explain = async (where: unknown) => {
        const statement = engine.build(geoPointPlanPlace, "findMany", {
          where,
          select: { id: true },
        });
        const result = await driver._execute<{ EXPLAIN: string }>(
          sql`EXPLAIN FORMAT=JSON ${statement}`
        );
        const document = JSON.parse(result.rows[0]?.EXPLAIN ?? "null");
        return document.query_block?.table;
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
        await expect(explain(where)).resolves.toMatchObject({
          access_type: "range",
          key: "geopoint_plan_places_location_idx",
        });
      }

      for (const where of [
        { location: { distance: { to: paris, gte: 100_000 } } },
        { NOT: { location: { distance: { to: paris, lte: 100_000 } } } },
      ]) {
        const table = await explain(where);
        expect(table?.key).not.toBe("geopoint_plan_places_location_idx");
      }
    } finally {
      await client.$disconnect();
    }
  });

  test("self-referencing tree deleteMany succeeds with default referential actions", async () => {
    const category = s
      .model({
        id: s.string().id(),
        name: s.string(),
        parentId: s.string().nullable(),
        parent: s
          .toOne(() => category)
          .fields("parentId")
          .references("id"),
        children: s.toMany(() => category),
      })
      .map("self_tree_categories");

    const client = createClient({
      schema: { category },
      driver: createMySQL2Driver(),
    });
    try {
      await syncLiveSchema(client);

      await client.category.create({
        data: { id: "root", name: "Root", parentId: null },
      });
      await client.category.create({
        data: { id: "child", name: "Child", parentId: "root" },
      });
      await client.category.create({
        data: { id: "grandchild", name: "Grandchild", parentId: "child" },
      });

      // InnoDB checks self-referencing FKs row-by-row, so this only works
      // because the nullable parent FK defaults to ON DELETE SET NULL
      // (Prisma parity) — with NO ACTION it throws ForeignKeyError here
      // while PG/SQLite (statement-end validation) succeed.
      const result = await client.category.deleteMany({});
      expect(result.count).toBe(3);
      expect(await client.category.findMany()).toHaveLength(0);
    } finally {
      await client.$disconnect();
    }
  });

  test("applies and converges a permuted composite foreign key", async () => {
    const account = s
      .model({
        id: s.string(),
        tenantId: s.string(),
        members: s.toMany(() => member),
      })
      .id(["tenantId", "id"])
      .map("composite_fk_accounts");
    const member = s
      .model({
        id: s.string().id(),
        accountId: s.string(),
        accountTenantId: s.string(),
        account: s
          .toOne(() => account)
          .fields("accountId", "accountTenantId")
          .references("id", "tenantId"),
      })
      .map("composite_fk_members");
    const client = createClient({
      schema: { account, member },
      driver: createMySQL2Driver(),
    });

    try {
      const applied = await syncLiveSchema(client);
      expect(applied.applied).toBe(true);

      await client.account.create({
        data: {
          tenantId: "tenant",
          id: "account",
          members: { create: { id: "member" } },
        },
      });
      await expect(
        client.member.findUnique({ where: { id: "member" } })
      ).resolves.toMatchObject({
        accountTenantId: "tenant",
        accountId: "account",
      });

      const converged = await syncLiveSchema(client);
      expect(converged.operations).toEqual([]);
    } finally {
      await client.$disconnect();
    }
  });

  describe("$transaction portable option boundary", () => {
    const entry = s
      .model({
        id: s.string().id(),
        note: s.string(),
      })
      .map("isolation_entries");

    test("rejects removed isolation before the callback", async () => {
      const client = createClient({
        schema: { entry },
        driver: createMySQL2Driver(),
      });
      let callbackCalled = false;
      try {
        const transaction = client.$transaction;
        await expect(
          Reflect.apply(transaction, client, [
            async () => {
              callbackCalled = true;
            },
            { isolationLevel: "serializable" },
          ])
        ).rejects.toMatchObject({ name: "TransactionError", code: "V5005" });
        expect(callbackCalled).toBe(false);
      } finally {
        await client.$disconnect();
      }
    });
  });

  compoundKeyContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  compoundJunctionContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  polymorphicMemberJunctionContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  polymorphicRelationContract.register({
    name: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  polymorphicCollectionReadContract.register({
    name: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  // MySQL is the one dialect whose conflict grammar cannot TARGET, so the
  // singular-slot rows here are the only place the per-dialect half of §1.7 is
  // measured against a real server rather than reasoned about.
  polymorphicCollectionWriteContract.register({
    name: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  test("rejects artificial batch-only non-returning writes before provider access", async () => {
    const entry = s
      .model({
        id: s.string().id(),
        email: s.string().unique(),
      })
      .map("batch_only_nonreturn_entries");
    const client = createClient({
      schema: { entry },
      driver: new MySQL2BatchForcedDriver({
        databaseUrl: "mysql://invalid.invalid/viborm",
      }),
    });
    try {
      await expect(
        client.entry.upsert({
          where: { email: "entry@test.com" },
          create: { id: "entry", email: "entry@test.com" },
          update: { email: "entry@test.com" },
        })
      ).rejects.toThrow(
        "cannot execute non-returning upsert writes atomically because public result parsing cannot be rolled back after an atomic batch commits"
      );
    } finally {
      await client.$disconnect();
    }
  });

  /**
   * What the `BINARY` conjunct in `startsWithPrefix` is for (plan §7.3).
   *
   * MySQL's prefix predicate is two conjuncts: a collation-native `LIKE` that
   * the index can range on, and a `BINARY` comparison that carries the
   * case-sensitivity contract. On a table `syncLiveSchema()` created the second looks
   * redundant — viborm's DDL declares `COLLATE=utf8mb4_0900_bin`
   * (`src/migrations/drivers/mysql/index.ts:298`), so `LIKE` is already
   * byte-exact there and the conjunct changes no answer.
   *
   * Its coverage is the table viborm did NOT create. The adapter's header
   * promises "portable string filters override the database collation
   * explicitly", and a column carrying MySQL's own default
   * `utf8mb4_0900_ai_ci` is where that promise is either kept or broken. This
   * builds exactly that column and runs both spellings against it.
   */
  describe("prefix predicate on a collation viborm did not choose", () => {
    const TABLE = "l73_ai_ci_probe";
    const NEEDLE = "Alpha";

    const withClient = async (
      fn: (client: {
        $executeRawUnsafe: (
          sql: string,
          ...values: unknown[]
        ) => Promise<unknown>;
        $queryRawUnsafe: <T>(sql: string, ...values: unknown[]) => Promise<T[]>;
      }) => Promise<void>
    ) => {
      const client = createClient({ schema: {}, driver: createMySQL2Driver() });
      try {
        await fn(client);
      } finally {
        await client.$disconnect();
      }
    };

    beforeEach(async () => {
      await withClient(async (client) => {
        await client.$executeRawUnsafe(`DROP TABLE IF EXISTS ${TABLE}`);
        await client.$executeRawUnsafe(
          `CREATE TABLE ${TABLE} (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(191) NOT NULL)
           ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
        );
        await client.$executeRawUnsafe(
          `INSERT INTO ${TABLE} (name) VALUES ('Alpha one'), ('alpha two'), ('ALPHA three'), ('Beta')`
        );
      });
    });

    afterEach(async () => {
      await withClient(async (client) => {
        await client.$executeRawUnsafe(`DROP TABLE IF EXISTS ${TABLE}`);
      });
    });

    test("the accelerator alone would answer case-insensitively", async () => {
      await withClient(async (client) => {
        const rows = await client.$queryRawUnsafe<{ name: string }>(
          `SELECT name FROM ${TABLE} WHERE name LIKE ? ESCAPE '\\\\' ORDER BY name`,
          `${NEEDLE}%`
        );
        // All three 'alpha' spellings — this is the answer the shipped
        // predicate must NOT give.
        expect(rows).toHaveLength(3);
      });
    });

    test("the shipped conjunction keeps the case-sensitivity contract", async () => {
      await withClient(async (client) => {
        const rows = await client.$queryRawUnsafe<{ name: string }>(
          `SELECT name FROM ${TABLE}
             WHERE (name LIKE ? ESCAPE '\\\\'
                    AND LEFT(BINARY name, OCTET_LENGTH(?)) = BINARY ?)
             ORDER BY name`,
          `${NEEDLE}%`,
          NEEDLE,
          NEEDLE
        );
        expect(rows.map((row) => row.name)).toEqual(["Alpha one"]);
      });
    });
  });

  /**
   * `startsWithPrefix`'s twin, one section up, for `equals` and `in` (§10.2).
   *
   * `BINARY col` is a FUNCTION of the column, so MySQL cannot range on it: the
   * wrap that carries the case-sensitivity contract cost every exact lookup its
   * index. The shipped predicate is two conjuncts — a collation-native one the
   * planner ranges on, and the `BINARY` one that decides the answer — and the
   * first is implied by the second, so it adds no row and removes none.
   *
   * The claims split the same way 7.3's do. On the tables `syncLiveSchema()` creates
   * (`COLLATE=utf8mb4_0900_bin`) both conjuncts say the same thing, so the
   * contract is witnessed where it can be broken: MySQL's own default
   * `utf8mb4_0900_ai_ci`, built here by hand. The plan is witnessed where a
   * plan exists at all — enough rows for the optimizer to prefer the index.
   */
  describe("exact equality on a collation viborm did not choose", () => {
    const TABLE = "l102_ai_ci_probe";
    const NEEDLE = "Alpha";

    const withClient = async (
      fn: (client: {
        $executeRawUnsafe: (
          sql: string,
          ...values: unknown[]
        ) => Promise<unknown>;
        $queryRawUnsafe: <T>(sql: string, ...values: unknown[]) => Promise<T[]>;
      }) => Promise<void>
    ) => {
      const client = createClient({ schema: {}, driver: createMySQL2Driver() });
      try {
        await fn(client);
      } finally {
        await client.$disconnect();
      }
    };

    beforeEach(async () => {
      await withClient(async (client) => {
        await client.$executeRawUnsafe(`DROP TABLE IF EXISTS ${TABLE}`);
        await client.$executeRawUnsafe(
          `CREATE TABLE ${TABLE} (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(191) NOT NULL, KEY name_idx (name))
           ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
        );
        await client.$executeRawUnsafe(
          `INSERT INTO ${TABLE} (name) VALUES ('Alpha'), ('alpha'), ('ALPHA'), ('Beta')`
        );
      });
    });

    afterEach(async () => {
      await withClient(async (client) => {
        await client.$executeRawUnsafe(`DROP TABLE IF EXISTS ${TABLE}`);
      });
    });

    test("the accelerator alone would answer equality case-insensitively", async () => {
      await withClient(async (client) => {
        const rows = await client.$queryRawUnsafe<{ name: string }>(
          `SELECT name FROM ${TABLE} WHERE name = ?`,
          NEEDLE
        );
        // All three spellings — the answer the shipped predicate must NOT give.
        expect(rows).toHaveLength(3);
      });
    });

    test("the shipped equality conjunction keeps the case-sensitivity contract", async () => {
      await withClient(async (client) => {
        const rows = await client.$queryRawUnsafe<{ name: string }>(
          `SELECT name FROM ${TABLE} WHERE (name = ? AND BINARY name = ?) ORDER BY name`,
          NEEDLE,
          NEEDLE
        );
        expect(rows.map((row) => row.name)).toEqual(["Alpha"]);
      });
    });

    test("the accelerator alone would answer membership case-insensitively", async () => {
      await withClient(async (client) => {
        const rows = await client.$queryRawUnsafe<{ name: string }>(
          `SELECT name FROM ${TABLE} WHERE name IN (?, ?)`,
          NEEDLE,
          "Beta"
        );
        expect(rows).toHaveLength(4);
      });
    });

    test("the shipped membership conjunction keeps the case-sensitivity contract", async () => {
      await withClient(async (client) => {
        const rows = await client.$queryRawUnsafe<{ name: string }>(
          `SELECT name FROM ${TABLE}
             WHERE (name IN (?, ?) AND BINARY name IN (?, ?))
             ORDER BY name`,
          NEEDLE,
          "Beta",
          NEEDLE,
          "Beta"
        );
        expect(rows.map((row) => row.name)).toEqual(["Alpha", "Beta"]);
      });
    });
  });

  /**
   * The measurement §10.2 turned on, re-taken here so it cannot rot — and taken
   * on the statement the CLIENT emitted, not on a spelling copied into the
   * test. The table is one `syncLiveSchema()` created, so the collation is the one every
   * viborm table lives in.
   */
  describe("exact equality keeps the index it used to lose", () => {
    const ROWS = 2000;
    let client: PlanProbeClient | undefined;
    let statements: Array<{ sql: string; params: unknown[] }> = [];

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    const connect = async () => {
      statements = [];
      client = createClient({
        schema: planProbeSchema as never,
        driver: createMySQL2Driver(),
      }).$extends(
        instrumentation({
          logging: {
            query: (event) => {
              statements.push({
                sql: event.sql ?? "",
                params: event.params ?? [],
              });
            },
            includeSql: true,
            includeParams: true,
          },
        })
      ) as never;
      const c = client as unknown as Record<string, any>;
      await syncLiveSchema(client as never);
      await c.planProbe.deleteMany({});
      await c.planProbe.createMany({
        data: Array.from({ length: ROWS }, (_, i) => ({
          id: `r${String(i).padStart(5, "0")}`,
          name: `name${i}`,
        })),
      });
      // Plan on real statistics, not on the empty-table defaults.
      await (client as PlanProbeClient).$executeRawUnsafe(
        "ANALYZE TABLE l102_plan_probes"
      );
      statements = [];
      return c;
    };

    /** MySQL's own verdict on the LAST statement the client emitted. */
    const accessTypeOfLastStatement = async (): Promise<string> => {
      const emitted = statements.at(-1);
      if (!emitted) throw new Error("the client emitted no statement");
      const rows = await (client as PlanProbeClient).$queryRawUnsafe<{
        type: string;
      }>(`EXPLAIN ${emitted.sql}`, ...emitted.params);
      return rows[0]?.type ?? "";
    };

    // REGRESSION (§10.2): `BINARY name = ?` was the whole predicate the
    // where-builder emitted, and this is what MySQL did with it. Stated on the
    // spelling itself because it is the one thing the emitter no longer says.
    test("the BINARY wrap alone forecloses the index", async () => {
      await connect();
      const rows = await (client as PlanProbeClient).$queryRawUnsafe<{
        type: string;
      }>(
        "EXPLAIN SELECT id FROM l102_plan_probes WHERE BINARY name = ?",
        "name123"
      );
      expect(rows[0]?.type).toBe("index");
    });

    test("the emitted equality plans a lookup", async () => {
      const c = await connect();
      await c.planProbe.findMany({ where: { name: { equals: "name123" } } });

      expect(await accessTypeOfLastStatement()).toBe("ref");
    });

    test("the emitted membership plans a range", async () => {
      const c = await connect();
      await c.planProbe.findMany({
        where: { name: { in: ["name1", "name2"] } },
      });

      expect(await accessTypeOfLastStatement()).toBe("range");
    });
  });

  /**
   * The contract half, on the predicate the CLIENT emitted rather than on a
   * spelling copied into the test.
   *
   * `syncLiveSchema()` only ever writes `utf8mb4_0900_bin`, where the two conjuncts say
   * the same thing — so the column is pushed and then ALTERed to MySQL's own
   * default `utf8mb4_0900_ai_ci`, which is what a table viborm did not create
   * looks like. Without this, dropping the `BINARY` conjunct from the adapter
   * failed only a SQL pin and no live test: measured.
   */
  describe("emitted equality on a collation viborm did not choose", () => {
    let client: PlanProbeClient | undefined;

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    const connect = async () => {
      client = createClient({
        schema: planProbeSchema as never,
        driver: createMySQL2Driver(),
      }) as never;
      const c = client as unknown as Record<string, any>;
      await syncLiveSchema(client as never);
      await (client as PlanProbeClient).$executeRawUnsafe(
        "ALTER TABLE l102_plan_probes MODIFY name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL"
      );
      await c.planProbe.createMany({
        data: [
          { id: "p1", name: "Alpha" },
          { id: "p2", name: "alpha" },
          { id: "p3", name: "ALPHA" },
          { id: "p4", name: "Beta" },
        ],
      });
      return c;
    };

    test("equals answers exactly, not case-insensitively", async () => {
      const c = await connect();

      const rows = await c.planProbe.findMany({
        where: { name: { equals: "Alpha" } },
      });

      expect(rows.map((row: { id: string }) => row.id)).toEqual(["p1"]);
    });

    test("in answers exactly, not case-insensitively", async () => {
      const c = await connect();

      const rows = await c.planProbe.findMany({
        where: { name: { in: ["Alpha", "Beta"] } },
        orderBy: { id: "asc" },
      });

      expect(rows.map((row: { id: string }) => row.id)).toEqual(["p1", "p4"]);
    });
  });

  // The batch-only suites (batch-primary-key-dataflow, batch-ref-smoke) are
  // not wired here: they need a batch-only driver subclass and MySQL2
  // exercises the transaction-based nested-write path instead.
});

// =============================================================================
// NAMESPACE CONTAINMENT (plan §5)
// =============================================================================

/**
 * The live half of §5, against a real server.
 *
 * The containment claim is one sentence: an attested connection whose OWN
 * default database is `beta`, told to target `alpha`, touches only `alpha`.
 * Nothing here leans on session state — no `USE`, no search-path equivalent —
 * so every effect lands because the emitted SQL named its database, or it lands
 * beside the beta sentinel and these tests say so.
 */
const ALPHA_DB = "viborm_ns_alpha";
const BETA_DB = "viborm_ns_beta";

function urlForDatabase(database: string): string {
  const url = new URL(TEST_CONNECTION_STRING ?? "mysql://127.0.0.1/viborm");
  url.pathname = `/${database}`;
  return url.toString();
}

const note = s
  .model({ id: s.string().id(), title: s.string() })
  .map("ns_notes");
const noteSchema = { note };

const applied = s.model({ id: s.string().id() }).map("ns_applied");
const appliedSchema = { applied };

const CONTROL_STATE = "_viborm_migration_state";
const CONTROL_LOG = "_viborm_migration_log";

/** The caller-owned pool whose OWN default database is `beta`. */
let betaPool: MySQLPool | null = null;

function requireBetaPool(): MySQLPool {
  if (!betaPool) {
    throw new Error("the beta pool is created in beforeAll");
  }
  return betaPool;
}

describeIf("MySQL namespace containment", () => {
  /** A client on the default database, used only to build and inspect fixtures. */
  function adminClient(): PlanProbeClient {
    const client = createClient({
      schema: {},
      driver: new MySQL2Driver({
        databaseUrl: TEST_CONNECTION_STRING,
        migrationNamespaceAttestation: "non-redirecting",
      }),
    });
    return client as unknown as PlanProbeClient;
  }

  /**
   * The §10 control itself: a CALLER-OWNED pool whose own default database is
   * `beta`, with the explicit `namespace` selecting `alpha`.
   *
   * A supplied pool is opaque — VibORM never derives a target from it and never
   * changes its connection state — so this is the only construction where the
   * connection's default and the ORM's target genuinely differ. That divergence
   * is what makes the sentinel assertions meaningful: any statement that forgot
   * its qualifier lands in `beta`.
   */
  function crossTargetDriver(namespace = ALPHA_DB): MySQL2Driver {
    return new MySQL2Driver({
      pool: requireBetaPool(),
      namespace,
      migrationNamespaceAttestation: "non-redirecting",
    });
  }

  async function withAdmin(
    run: (client: PlanProbeClient) => Promise<void>
  ): Promise<void> {
    const admin = adminClient();
    try {
      await run(admin);
    } finally {
      await admin.$disconnect();
    }
  }

  async function tableNamesIn(database: string): Promise<string[]> {
    let names: string[] = [];
    await withAdmin(async (admin) => {
      const rows = await admin.$queryRawUnsafe<{ TABLE_NAME: string }>(
        "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
        database
      );
      names = rows.map((row) => row.TABLE_NAME);
    });
    return names;
  }

  /** How many V1 ledger events one database's control log holds. */
  async function controlEventCount(database: string): Promise<number> {
    let count = 0;
    await withAdmin(async (admin) => {
      const rows = await admin.$queryRawUnsafe<{ n: number | string }>(
        `SELECT COUNT(*) AS n FROM \`${database}\`.\`${CONTROL_LOG}\``
      );
      count = Number(rows[0]?.n ?? 0);
    });
    return count;
  }

  /**
   * `beta` is dropped first because the cross-database control puts the
   * referencing table there: MySQL refuses to drop a parent database while a
   * foreign key in another one still points at it.
   */
  async function dropFixtureDatabases(admin: PlanProbeClient): Promise<void> {
    for (const database of [BETA_DB, ALPHA_DB]) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  }

  beforeAll(async () => {
    await withAdmin(async (admin) => {
      await dropFixtureDatabases(admin);
      for (const database of [ALPHA_DB, BETA_DB]) {
        await admin.$executeRawUnsafe(`CREATE DATABASE \`${database}\``);
      }
      // A sentinel the ORM never manages, in the database the CONNECTION
      // defaults to. Anything that forgot its qualifier lands beside it.
      await admin.$executeRawUnsafe(
        `CREATE TABLE \`${BETA_DB}\`.\`ns_sentinel\` (id INT PRIMARY KEY)`
      );
    });

    const mysql = await import("mysql2/promise");
    betaPool = mysql.createPool({
      uri: urlForDatabase(BETA_DB),
      timezone: "Z",
      supportBigNumbers: true,
      dateStrings: ["DATE"],
    });
  });

  afterAll(async () => {
    // VibORM never ends a pool it did not create, so the caller does.
    await betaPool?.end();
    betaPool = null;
    await withAdmin(dropFixtureDatabases);
  });

  // `push` deliberately carries no storage owner and never touches tracking
  // (`src/migrations/push/planner.ts`), so this leg proves DDL and runtime
  // writes only. The tracking half is the separate `apply` leg below.
  test("pushes and writes into the target, not the connection's database", async () => {
    const client = createClient({
      schema: noteSchema,
      driver: crossTargetDriver(),
    });
    // These clients are NOT disconnected: `MySQL2Driver.closeClient` ends
    // whatever pool it holds, including a supplied one, so the fixture that
    // created the pool owns its lifetime and closes it once in `afterAll`.
    await syncLiveSchema(client);
    await client.note.create({ data: { id: "n1", title: "alpha only" } });
    const found = await client.note.findMany({});
    expect(found.map((row: { id: string }) => row.id)).toEqual(["n1"]);

    expect(await tableNamesIn(ALPHA_DB)).toContain("ns_notes");
    expect(await tableNamesIn(BETA_DB)).toEqual(["ns_sentinel"]);
  });

  test("introspects only the target and converges on a second push", async () => {
    const client = createClient({
      schema: noteSchema,
      driver: crossTargetDriver(),
    });
    const snapshot = await introspect(client);
    const names = snapshot.tables.map((table) => table.name);
    expect(names).toContain("ns_notes");
    expect(names).not.toContain("ns_sentinel");

    const second = await syncLiveSchema(client);
    expect(second.operations).toEqual([]);
  });

  test("applies into the TARGET's control tables, over a connection pointing elsewhere", async () => {
    const storage = new MemoryEstateStorage();
    const client = createClient({
      schema: appliedSchema,
      driver: crossTargetDriver(),
    });
    const migrations = createMigrationClient(client, { storage });
    await migrations.generate({ name: "init" });

    // A DECOY control pair in the database the CONNECTION defaults to. Every
    // control statement `apply` runs — the CREATE, the marker SELECT, the
    // ledger INSERT — must name the target. With the decoy present, "alpha
    // holds the ledger and beta's stays empty" is a claim only correctly
    // qualified statements can satisfy.
    await withAdmin(async (admin) => {
      await admin.$executeRawUnsafe(
        `CREATE TABLE \`${BETA_DB}\`.\`${CONTROL_STATE}\` (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), payload TEXT NOT NULL)`
      );
      await admin.$executeRawUnsafe(
        `CREATE TABLE \`${BETA_DB}\`.\`${CONTROL_LOG}\` (event_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL)`
      );
    });

    try {
      // Alpha has no control tables yet, so the read-only reader has to report
      // "nothing applied" — the one live exercise of MySQL's missing-table
      // translation (errno 1146 / SQLSTATE 42S02).
      expect(await tableNamesIn(ALPHA_DB)).not.toContain(CONTROL_STATE);
      const before = await migrations.status();
      expect(before.control).toBe("absent");
      expect(before.pending.length).toBeGreaterThan(0);

      const result = await migrations.apply();
      expect(result.outcome).toBe("applied");

      // The ledger was created and written in the TARGET…
      expect(await tableNamesIn(ALPHA_DB)).toContain(CONTROL_STATE);
      expect(await tableNamesIn(ALPHA_DB)).toContain(CONTROL_LOG);
      expect(await controlEventCount(ALPHA_DB)).toBeGreaterThan(0);
      // …and so did the generated artifact's own DDL, which names no database
      // at all: the pinned session selected `alpha` before executing it (§5.3).
      expect(await tableNamesIn(ALPHA_DB)).toContain("ns_applied");
      // …and the connection's own database gained nothing but the decoy, which
      // is still empty: no control statement and no artifact statement landed
      // there.
      expect(await tableNamesIn(BETA_DB)).toEqual([
        CONTROL_LOG,
        CONTROL_STATE,
        "ns_sentinel",
      ]);
      expect(await controlEventCount(BETA_DB)).toBe(0);

      // …and the same reader now reads it back from alpha, not from the decoy.
      const after = await migrations.status();
      expect(after.control).toBe("present");
      expect(after.pending).toEqual([]);
    } finally {
      await withAdmin(async (admin) => {
        for (const database of [ALPHA_DB, BETA_DB]) {
          await admin.$executeRawUnsafe(
            `DROP TABLE IF EXISTS \`${database}\`.\`${CONTROL_STATE}\``
          );
          await admin.$executeRawUnsafe(
            `DROP TABLE IF EXISTS \`${database}\`.\`${CONTROL_LOG}\``
          );
          await admin.$executeRawUnsafe(
            `DROP TABLE IF EXISTS \`${database}\`.\`ns_applied\``
          );
        }
      });
    }

    expect(await tableNamesIn(BETA_DB)).toEqual(["ns_sentinel"]);
  });

  test("refuses a configured database the server does not have, before any DDL", async () => {
    const client = createClient({
      schema: noteSchema,
      driver: crossTargetDriver("viborm_ns_absent"),
    });
    await expect(syncLiveSchema(client)).rejects.toMatchObject({
      code: "V11009",
    });

    expect(await tableNamesIn(BETA_DB)).toEqual(["ns_sentinel"]);
  });

  test("refuses the same attested pool when no namespace resolves it", async () => {
    // §5.3: a supplied pool is opaque, so the attestation alone selects nothing.
    const client = createClient({
      schema: noteSchema,
      driver: new MySQL2Driver({
        pool: requireBetaPool(),
        migrationNamespaceAttestation: "non-redirecting",
      }),
    });
    await expect(syncLiveSchema(client)).rejects.toMatchObject({
      code: "V11009",
    });

    expect(await tableNamesIn(BETA_DB)).toEqual(["ns_sentinel"]);
  });

  test("refuses an inbound cross-database foreign key before planning", async () => {
    await withAdmin(async (admin) => {
      await admin.$executeRawUnsafe(
        `CREATE TABLE \`${ALPHA_DB}\`.\`ns_target\` (id INT PRIMARY KEY)`
      );
      await admin.$executeRawUnsafe(
        `CREATE TABLE \`${BETA_DB}\`.\`ns_outbound\` (id INT PRIMARY KEY, target_id INT, CONSTRAINT ns_cross_fk FOREIGN KEY (target_id) REFERENCES \`${ALPHA_DB}\`.\`ns_target\` (id))`
      );
    });

    const client = createClient({
      schema: noteSchema,
      driver: crossTargetDriver(),
    });
    await expect(introspect(client)).rejects.toMatchObject({
      code: "V11009",
      meta: {
        type: "cross-database-foreign-key",
        table: `${BETA_DB}.ns_outbound`,
        referencedTable: `${ALPHA_DB}.ns_target`,
      },
    });

    await withAdmin(async (admin) => {
      await admin.$executeRawUnsafe(
        `DROP TABLE \`${BETA_DB}\`.\`ns_outbound\``
      );
      await admin.$executeRawUnsafe(`DROP TABLE \`${ALPHA_DB}\`.\`ns_target\``);
    });
  });

  test("applies the same portable estate to a second database", async () => {
    const second = createClient({
      schema: noteSchema,
      driver: crossTargetDriver(BETA_DB),
    });
    await syncLiveSchema(second);
    await second.note.create({ data: { id: "b1", title: "beta copy" } });
    expect(
      (await second.note.findMany({})).map((row: { id: string }) => row.id)
    ).toEqual(["b1"]);

    // ONE portable estate, two live databases, independent rows — over the very
    // same connection pool.
    const first = createClient({
      schema: noteSchema,
      driver: crossTargetDriver(),
    });
    expect(
      (await first.note.findMany({})).map((row: { id: string }) => row.id)
    ).toEqual(["n1"]);
  });
});
