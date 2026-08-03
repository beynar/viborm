/**
 * mysql2 Driver Tests
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
import { push } from "@migrations";
import {
  EMPTY_ROW_RESULT_KEY,
  getAggregateResultKey,
  RELATION_COUNTS_RESULT_KEY,
  VECTOR_DISTANCE_RESULT_KEY,
} from "@query-engine/result-aliases";
import { s } from "@schema";
import { sql } from "@sql";
import { runBooleanNoOpArmBehavior } from "../query-engine-v2/boolean-noop-arm-behavior";
import { runBulkWriteBehavior } from "../query-engine-v2/bulk-write-behavior";
import { runCreateManyBehavior } from "../query-engine-v2/create-many-behavior";
import { runCreateNestedUpsertBehavior } from "../query-engine-v2/create-nested-upsert-behavior";
import { runDepthSeamBehavior } from "../query-engine-v2/depth-seam-behavior";
import { runExtendedWhereUniqueBehavior } from "../query-engine-v2/extended-where-unique-behavior";
import { runInverseToOneCreateBehavior } from "../query-engine-v2/inverse-to-one-create-behavior";
import { runJunctionCreateManyBehavior } from "../query-engine-v2/junction-create-many-behavior";
import { runLocatedParentRefBehavior } from "../query-engine-v2/located-parent-ref-behavior";
import { runNestedMutationBehavior } from "../query-engine-v2/nested-mutation-behavior";
import { runOwnWriteLinearizationBehavior } from "../query-engine-v2/own-write-linearization-behavior";
import { runPostTransitionAdoptBehavior } from "../query-engine-v2/post-transition-adopt-behavior";
import { runProducedIdentityBehavior } from "../query-engine-v2/produced-identity-depth-behavior";
import { runReadBehavior } from "../query-engine-v2/read-behavior";
import { runToOneUpdateWhereBehavior } from "../query-engine-v2/to-one-update-where-behavior";
import { runUpdateFamilyBehavior } from "../query-engine-v2/update-family-behavior";
import { runUpdateNestedUpsertBehavior } from "../query-engine-v2/update-nested-upsert-behavior";
import { runUpsertFamilyBehavior } from "../query-engine-v2/upsert-family-behavior";
import { MySQL2BatchForcedDriver } from "./batch-forced-mysql2";
import { runBlobFilterBehavior } from "./blob-filter-behavior";
import { runBulkWriteLimitBehavior } from "./bulk-write-limit-behavior";
import { runClientRawBehavior } from "./client-raw-behavior";
import { runCompoundKeyBehavior } from "./compound-key-behavior";
import { runCountAggregateWindowBehavior } from "./count-aggregate-window-behavior";
import { runCreateManyReturnFoldBehavior } from "./create-many-return-fold-behavior";
import { runCursorPaginationBehavior } from "./cursor-pagination-behavior";
import { runDecimalExactnessBehavior } from "./decimal-exactness-behavior";
import { runDistinctSkipWindowBehavior } from "./distinct-skip-window-behavior";
import { runFieldReferenceBehavior } from "./field-reference-behavior";
import { runFkIndexBehavior } from "./fk-index-behavior";
import { runForwardFkOrderingBehavior } from "./forward-fk-ordering-behavior";
import { runImplicitReturningBehavior } from "./implicit-returning-behavior";
import {
  runMappedIndexBehavior,
  runPartialIndexRefusalBehavior,
} from "./index-ddl-behavior";
import { runJsonNullSentinelBehavior } from "./json-null-sentinel-behavior";
import { runLikeEscapeBehavior } from "./like-escape-behavior";
import { runListJsonFilterBehavior } from "./list-json-filter-behavior";
import { runManyToManyBehavior } from "./many-to-many-behavior";
import { runNestedOrderByBehavior } from "./nested-orderby-behavior";
import { runNestedWriteAdvancedBehavior } from "./nested-write-advanced-behavior";
import { runNestedWriteBehavior } from "./nested-write-behavior";
import { runNestedWriteConcurrencyBehavior } from "./nested-write-concurrency-behavior";
import { runNonReturningMutationAtomicityBehavior } from "./non-returning-mutation-atomicity-behavior";
import { runOmitBehavior } from "./omit-behavior";
import { runOptionalRelationParityBehavior } from "./optional-relation-parity-behavior";
import { runOrderingArrayCreateBehavior } from "./ordering-array-create-behavior";
import { runPrismaParityBehavior } from "./prisma-parity-behavior";
import { runReadPathRegressionBehavior } from "./read-path-regression-behavior";
import { runRelationFilterMutationBehavior } from "./relation-filter-mutation-behavior";
import { runRelationReadAggregateBehavior } from "./relation-read-aggregate-behavior";
import {
  runFullScalarRoundtripBehavior,
  runScalarRoundtripBehavior,
} from "./scalar-roundtrip-behavior";
import { runUpsertAtomicityBehavior } from "./upsert-atomicity-behavior";

const TEST_CONNECTION_STRING = process.env.MYSQL_TEST_CONNECTION_STRING;
const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

function createMySQL2Driver(): MySQL2Driver {
  return new MySQL2Driver({ databaseUrl: TEST_CONNECTION_STRING });
}

/**
 * An indexed string column on a table `push()` creates, so the collation is
 * `utf8mb4_0900_bin` — the one every viborm table lives in. Plan §10.2.
 */
const planProbe = s
  .model({ id: s.string().id(), name: s.string() })
  .index(["name"])
  .map("l102_plan_probes");

const planProbeSchema = { planProbe };

type PlanProbeClient = {
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<unknown>;
  $queryRawUnsafe: <T>(sql: string, ...values: unknown[]) => Promise<T[]>;
  $disconnect: () => Promise<void>;
};

describeIf("MySQL2 Driver", () => {
  // The shared behavior suites assume a fresh database (the local drivers are
  // in-memory). MySQL persists between tests, so drop everything first:
  // pushing an empty schema diffs to dropTable for every existing table.
  beforeEach(async () => {
    const client = createClient({ schema: {}, driver: createMySQL2Driver() });
    await push(client, { force: true });
    await client.$disconnect();
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
      VECTOR_DISTANCE_RESULT_KEY,
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

  test("self-referencing tree deleteMany succeeds with default referential actions", async () => {
    const category = s
      .model({
        id: s.string().id(),
        name: s.string(),
        parentId: s.string().nullable(),
        parent: s
          .manyToOne(() => category)
          .fields("parentId")
          .references("id")
          .optional(),
        children: s.oneToMany(() => category),
      })
      .map("self_tree_categories");

    const client = createClient({
      schema: { category },
      driver: createMySQL2Driver(),
    });
    try {
      await push(client, { force: true });

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

  runOrderingArrayCreateBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runImplicitReturningBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });
  runCreateManyReturnFoldBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runBulkWriteLimitBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runListJsonFilterBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runJsonNullSentinelBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  // MySQL's default collation is case- and accent-INSENSITIVE, so it is the
  // only leg where the collation wrappers on a referenced operand can be
  // observed to matter at all.
  runFieldReferenceBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runNestedWriteBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runNestedWriteAdvancedBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runCompoundKeyBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runReadPathRegressionBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runRelationReadAggregateBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });
  runNestedOrderByBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runOmitBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runClientRawBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runFkIndexBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runMappedIndexBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });
  runPartialIndexRefusalBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runForwardFkOrderingBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runManyToManyBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runRelationFilterMutationBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runCountAggregateWindowBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runDistinctSkipWindowBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runCursorPaginationBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runScalarRoundtripBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runDecimalExactnessBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
    exactDecimal: true,
  });

  runFullScalarRoundtripBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runPrismaParityBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runOptionalRelationParityBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runLikeEscapeBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runBlobFilterBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  // Non-returning upserts use the locked interpreter branch path so branch
  // identity and result refetch stay on one transaction connection.
  runUpsertAtomicityBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runNonReturningMutationAtomicityBehavior(
    TEST_CONNECTION_STRING ?? "mysql://unconfigured.invalid/viborm"
  );

  // M8 (§7.4, D7): two real transaction-capable connections race. PlannedMode
  // real-race coverage stays on PostgreSQL because MySQL's public adapter is
  // non-returning and cannot roll public parsing back after a batch commits.
  runNestedWriteConcurrencyBehavior({
    driverName: "mysql2",
    createTxDriver: () =>
      new MySQL2Driver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runCreateNestedUpsertBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });
  runCreateNestedUpsertBehavior({
    name: "MySQL2 atomic batch",
    createDriver: () =>
      new MySQL2BatchForcedDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      }),
    createStateDriver: createMySQL2Driver,
  });
  // T4b CLASS III boundary-stop — MySQL has no RETURNING, so a batch-only MySQL is a
  // non-returning atomic driver: V1 AND V2 refuse the single-row update/delete/upsert
  // refetch family before I/O (byte-identical `TransactionError`, routing.ts
  // `assertRoutedAtomicResolution`), so `runBatchPrimaryKeyDataflowBehavior`'s
  // updated-PK cases are not runnable here (the family is refused, not the CLASS III
  // dataflow specifically). MySQL certifies these mutations in TRANSACTION mode (the
  // MySQL2 transaction blocks above and the full estate). The RETURNING-capable
  // batch-only drivers (SQLite3, LibSQL, PGlite, Postgres) carry the batch dataflow.

  runUpdateNestedUpsertBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });
  runUpdateNestedUpsertBehavior({
    name: "MySQL2 atomic batch",
    createDriver: () =>
      new MySQL2BatchForcedDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      }),
    createStateDriver: createMySQL2Driver,
  });

  runUpdateFamilyBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });

  runUpdateFamilyBehavior({
    name: "MySQL2 atomic batch",
    createDriver: () =>
      new MySQL2BatchForcedDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      }),
    createStateDriver: createMySQL2Driver,
  });

  runLocatedParentRefBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });

  runLocatedParentRefBehavior({
    name: "MySQL2 atomic batch",
    createDriver: () =>
      new MySQL2BatchForcedDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      }),
    createStateDriver: createMySQL2Driver,
    // MySQL's skipDuplicates has no portable SQL leaf, so the skip is the
    // savepoint-wrapped executor effect — which a single atomic batch cannot carry.
    skipDuplicatesInBatchIsInexpressible: true,
  });

  runPostTransitionAdoptBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });

  runPostTransitionAdoptBehavior({
    name: "MySQL2 atomic batch",
    createDriver: () =>
      new MySQL2BatchForcedDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      }),
    createStateDriver: createMySQL2Driver,
  });

  runInverseToOneCreateBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });

  runInverseToOneCreateBehavior({
    name: "MySQL2 atomic batch",
    createDriver: () =>
      new MySQL2BatchForcedDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      }),
    createStateDriver: createMySQL2Driver,
  });

  runDepthSeamBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });
  runDepthSeamBehavior({
    name: "MySQL2 atomic batch",
    createDriver: () =>
      new MySQL2BatchForcedDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      }),
    createStateDriver: createMySQL2Driver,
    // Same reason as the located-parent Ref leg above: the nested `createMany`'s
    // `skipDuplicates` is the savepoint-wrapped executor effect on this dialect, and
    // a savepoint has no lowering into a single atomic batch.
    skipDuplicatesInBatchIsInexpressible: true,
  });

  runProducedIdentityBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });
  runProducedIdentityBehavior({
    name: "MySQL2 atomic batch",
    createDriver: () =>
      new MySQL2BatchForcedDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      }),
    createStateDriver: createMySQL2Driver,
  });

  runOwnWriteLinearizationBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });
  runOwnWriteLinearizationBehavior({
    name: "MySQL2 atomic batch",
    createDriver: () =>
      new MySQL2BatchForcedDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      }),
    createStateDriver: createMySQL2Driver,
  });

  runBooleanNoOpArmBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });
  runBooleanNoOpArmBehavior({
    name: "MySQL2 atomic batch",
    createDriver: () =>
      new MySQL2BatchForcedDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      }),
    createStateDriver: createMySQL2Driver,
  });

  runJunctionCreateManyBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });
  runJunctionCreateManyBehavior({
    name: "MySQL2 atomic batch",
    createDriver: () =>
      new MySQL2BatchForcedDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      }),
    createStateDriver: createMySQL2Driver,
    // Same reason as the located-parent Ref leg above: the junction's per-row
    // `skipDuplicates` INSERT is the savepoint-wrapped executor effect here.
    skipDuplicatesInBatchIsInexpressible: true,
  });

  // TRANSACTION mode only. This suite drives the CLIENT, and a batch-only MySQL
  // is non-returning: `assertRoutedAtomicResolution` refuses update / delete /
  // upsert before any I/O there (the same boundary noted for CLASS III below).
  // The batch-substrate leg of extended whereUnique is carried by the
  // RETURNING-capable batch-only drivers (PGlite, SQLite3, LibSQL, pg).
  runExtendedWhereUniqueBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });

  // Same reason: MySQL is non-returning, so the batch-substrate leg of the to-one
  // `update { where, data }` form is carried by the RETURNING-capable batch-only
  // drivers (PGlite, SQLite3, LibSQL, pg).
  runToOneUpdateWhereBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });

  runUpsertFamilyBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });
  runUpsertFamilyBehavior({
    name: "MySQL2 atomic batch",
    createDriver: () =>
      new MySQL2BatchForcedDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      }),
    createStateDriver: createMySQL2Driver,
  });

  runNestedMutationBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });
  runNestedMutationBehavior({
    name: "MySQL2 atomic batch",
    createDriver: () =>
      new MySQL2BatchForcedDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      }),
    createStateDriver: createMySQL2Driver,
  });

  // createMany on MySQL only in transaction mode: skipDuplicates uses the
  // savepoint effect (recoverableUniqueError strategy), which has no atomic-batch
  // lowering (the recorded batch disposition). MySQL always runs transactions in
  // production; the sql-strategy batch path is proven on PGlite/SQLite/LibSQL.
  runReadBehavior({
    name: "MySQL2",
    createDriver: createMySQL2Driver,
  });
  runBulkWriteBehavior({
    name: "MySQL2",
    createDriver: createMySQL2Driver,
  });
  runCreateManyBehavior({
    name: "MySQL2 transaction",
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
   * case-sensitivity contract. On a table `push()` created the second looks
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
   * The claims split the same way 7.3's do. On the tables `push()` creates
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
   * test. The table is one `push()` created, so the collation is the one every
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
        instrumentation: {
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
        },
      }) as never;
      const c = client as unknown as Record<string, any>;
      await push(client as never, { force: true });
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
   * `push()` only ever writes `utf8mb4_0900_bin`, where the two conjuncts say
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
      await push(client as never, { force: true });
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
