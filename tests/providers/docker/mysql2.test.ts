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
import { instrumentation } from "@instrumentation/extension";
import {
  apply,
  introspect,
  type MigrationEntry,
  MigrationStorageDriver,
  push,
  status,
} from "@migrations";
import {
  EMPTY_ROW_RESULT_KEY,
  getAggregateResultKey,
  RELATION_COUNTS_RESULT_KEY,
  VECTOR_DISTANCE_RESULT_KEY,
} from "@query-engine/result-aliases";
import { s } from "@schema";
import { sql } from "@sql";
import { blobFilterContract } from "@tests/contracts/drivers/behaviors/blob-filter-behavior";
import { bulkWriteLimitContract } from "@tests/contracts/drivers/behaviors/bulk-write-limit-behavior";
import { clientRawContract } from "@tests/contracts/drivers/behaviors/client-raw-behavior";
import { compoundJunctionContract } from "@tests/contracts/drivers/behaviors/compound-junction-behavior";
import { compoundKeyContract } from "@tests/contracts/drivers/behaviors/compound-key-behavior";
import { countAggregateWindowContract } from "@tests/contracts/drivers/behaviors/count-aggregate-window-behavior";
import { createManyReturnFoldContract } from "@tests/contracts/drivers/behaviors/create-many-return-fold-behavior";
import { cursorPaginationContract } from "@tests/contracts/drivers/behaviors/cursor-pagination-behavior";
import { decimalExactnessContract } from "@tests/contracts/drivers/behaviors/decimal-exactness-behavior";
import { distinctSkipWindowContract } from "@tests/contracts/drivers/behaviors/distinct-skip-window-behavior";
import { fieldReferenceContract } from "@tests/contracts/drivers/behaviors/field-reference-behavior";
import { fkIndexContract } from "@tests/contracts/drivers/behaviors/fk-index-behavior";
import { forwardFkOrderingContract } from "@tests/contracts/drivers/behaviors/forward-fk-ordering-behavior";
import { implicitReturningContract } from "@tests/contracts/drivers/behaviors/implicit-returning-behavior";
import {
  mappedIndexContract,
  partialIndexRefusalContract,
} from "@tests/contracts/drivers/behaviors/index-ddl-behavior";
import { jsonNullSentinelContract } from "@tests/contracts/drivers/behaviors/json-null-sentinel-behavior";
import { likeEscapeContract } from "@tests/contracts/drivers/behaviors/like-escape-behavior";
import { listJsonFilterContract } from "@tests/contracts/drivers/behaviors/list-json-filter-behavior";
import { manyToManyContract } from "@tests/contracts/drivers/behaviors/many-to-many-behavior";
import { nestedOrderByContract } from "@tests/contracts/drivers/behaviors/nested-orderby-behavior";
import { nestedWriteAdvancedContract } from "@tests/contracts/drivers/behaviors/nested-write-advanced-behavior";
import { nestedWriteContract } from "@tests/contracts/drivers/behaviors/nested-write-behavior";
import { nestedWriteConcurrencyContract } from "@tests/contracts/drivers/behaviors/nested-write-concurrency-behavior";
import { nonReturningMutationAtomicityContract } from "@tests/contracts/drivers/behaviors/non-returning-mutation-atomicity-behavior";
import { omitContract } from "@tests/contracts/drivers/behaviors/omit-behavior";
import { optionalRelationParityContract } from "@tests/contracts/drivers/behaviors/optional-relation-parity-behavior";
import { orderingArrayCreateContract } from "@tests/contracts/drivers/behaviors/ordering-array-create-behavior";
import { polymorphicCollectionReadContract } from "@tests/contracts/drivers/behaviors/polymorphic-collection-read-behavior";
import { polymorphicCollectionWriteContract } from "@tests/contracts/drivers/behaviors/polymorphic-collection-write-behavior";
import { polymorphicMemberJunctionContract } from "@tests/contracts/drivers/behaviors/polymorphic-member-junction-behavior";
import { polymorphicRelationContract } from "@tests/contracts/drivers/behaviors/polymorphic-relation-behavior";
import { prismaParityContract } from "@tests/contracts/drivers/behaviors/prisma-parity-behavior";
import { rawArrayTransactionContract } from "@tests/contracts/drivers/behaviors/raw-array-transaction-behavior";
import { readPathRegressionContract } from "@tests/contracts/drivers/behaviors/read-path-regression-behavior";
import { relationFilterMutationContract } from "@tests/contracts/drivers/behaviors/relation-filter-mutation-behavior";
import { relationReadAggregateContract } from "@tests/contracts/drivers/behaviors/relation-read-aggregate-behavior";
import {
  fullScalarRoundtripContract,
  scalarRoundtripContract,
} from "@tests/contracts/drivers/behaviors/scalar-roundtrip-behavior";
import { upsertAtomicityContract } from "@tests/contracts/drivers/behaviors/upsert-atomicity-behavior";
import { runBooleanNoOpArmBehavior } from "@tests/contracts/engine/write/boolean-noop-arm-behavior";
import { runBulkWriteBehavior } from "@tests/contracts/engine/write/bulk-write-behavior";
import { runCreateManyBehavior } from "@tests/contracts/engine/write/create-many-behavior";
import { runCreateNestedUpsertBehavior } from "@tests/contracts/engine/write/create-nested-upsert-behavior";
import { runDepthSeamBehavior } from "@tests/contracts/engine/write/depth-seam-behavior";
import { runExtendedWhereUniqueBehavior } from "@tests/contracts/engine/write/extended-where-unique-behavior";
import { runInverseToOneCreateBehavior } from "@tests/contracts/engine/write/inverse-to-one-create-behavior";
import { runJunctionCreateManyBehavior } from "@tests/contracts/engine/write/junction-create-many-behavior";
import { runLocatedParentRefBehavior } from "@tests/contracts/engine/write/located-parent-ref-behavior";
import { runNestedMutationBehavior } from "@tests/contracts/engine/write/nested-mutation-behavior";
import { runOptionalAbsentBindBehavior } from "@tests/contracts/engine/write/optional-absent-bind-behavior";
import { runOwnWriteLinearizationBehavior } from "@tests/contracts/engine/write/own-write-linearization-behavior";
import {
  runBeforeRootSubtreeBehavior,
  runNonPkReferenceBehavior,
  runParentHeldLookupBehavior,
  runUpsertArmRelationBehavior,
} from "@tests/contracts/engine/write/parent-held-lookup-behavior";
import { runPostTransitionAdoptBehavior } from "@tests/contracts/engine/write/post-transition-adopt-behavior";
import { runProducedIdentityBehavior } from "@tests/contracts/engine/write/produced-identity-depth-behavior";
import { runReadBehavior } from "@tests/contracts/engine/write/read-behavior";
import { runToOneUpdateWhereBehavior } from "@tests/contracts/engine/write/to-one-update-where-behavior";
import { runUpdateFamilyBehavior } from "@tests/contracts/engine/write/update-family-behavior";
import { runUpdateNestedUpsertBehavior } from "@tests/contracts/engine/write/update-nested-upsert-behavior";
import { runUpsertFamilyBehavior } from "@tests/contracts/engine/write/upsert-family-behavior";
import { MySQL2BatchForcedDriver } from "@tests/fixtures/drivers/batch-forced-mysql2";
import type { Pool as MySQLPool } from "mysql2/promise";

const TEST_CONNECTION_STRING = process.env.MYSQL_TEST_CONNECTION_STRING;
const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

/**
 * The connection string carries the database, so this driver is namespace-bound
 * from its URL path. The attestation is the SECOND, independent fact effectful
 * live migration work requires (plan §5.3): it asserts that nothing between the
 * client and the server reinterprets a qualified `database.table`. It is true
 * here by construction — a docker `mysql:8` reached directly on 3307 is not
 * behind VTGate or a rewriting proxy — and stating it is what admits `push()`.
 */
function createMySQL2Driver(): MySQL2Driver {
  return new MySQL2Driver({
    databaseUrl: TEST_CONNECTION_STRING,
    migrationNamespaceAttestation: "non-redirecting",
  });
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

  orderingArrayCreateContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  implicitReturningContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });
  createManyReturnFoldContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  bulkWriteLimitContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  listJsonFilterContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  jsonNullSentinelContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  // MySQL's default collation is case- and accent-INSENSITIVE, so it is the
  // only leg where the collation wrappers on a referenced operand can be
  // observed to matter at all.
  fieldReferenceContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  nestedWriteContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  nestedWriteAdvancedContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
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

  readPathRegressionContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  relationReadAggregateContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });
  nestedOrderByContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  omitContract.register({
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

  clientRawContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });
  rawArrayTransactionContract.register({
    name: "Docker MySQL",
    createDriver: createMySQL2Driver,
  });

  fkIndexContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  mappedIndexContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });
  partialIndexRefusalContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  forwardFkOrderingContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  manyToManyContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  relationFilterMutationContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  // E1 U1/U2 — the to-one lookup fold. MySQL is the leg that decides the
  // self-relation shape: `SET parentId = (SELECT … FROM the mutated table)` is
  // ERROR 1093 here unless the lookup hides behind a derived table (rule 11).
  runParentHeldLookupBehavior({
    name: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runBeforeRootSubtreeBehavior({
    name: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runUpsertArmRelationBehavior({
    name: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runNonPkReferenceBehavior({
    name: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  countAggregateWindowContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  distinctSkipWindowContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  cursorPaginationContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  scalarRoundtripContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  decimalExactnessContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
    // SQLite-legal intersection: `precision + scale <= 18` (plan 3.1).
    descriptor: { precision: 16, scale: 2 },
  });

  fullScalarRoundtripContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  prismaParityContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  optionalRelationParityContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  likeEscapeContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  blobFilterContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  // Non-returning upserts use the locked interpreter branch path so branch
  // identity and result refetch stay on one transaction connection.
  upsertAtomicityContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  nonReturningMutationAtomicityContract.register(
    TEST_CONNECTION_STRING ?? "mysql://unconfigured.invalid/viborm"
  );

  // M8 (§7.4, D7): two real transaction-capable connections race. PlannedMode
  // real-race coverage stays on PostgreSQL because MySQL's public adapter is
  // non-returning and cannot roll public parsing back after a batch commits.
  nestedWriteConcurrencyContract.register({
    driverName: "mysql2",
    createTxDriver: createMySQL2Driver,
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
  // `assertRoutedAtomicResolution`), so `batchPrimaryKeyDataflowContract`'s
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

  // M5 — mysql2's binder REJECTS an undefined parameter ("Bind parameters must
  // not contain undefined"), where every other leg coerces it to NULL. This is
  // the leg the engine's absent-optional normalization exists for: without it,
  // the untaken update arm of an absent-target upsert errors here and nowhere
  // else.
  runOptionalAbsentBindBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });
  runOptionalAbsentBindBehavior({
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

/** In-memory migration storage: this leg is about the database, not the disk. */
class MemoryStorage extends MigrationStorageDriver {
  private readonly files = new Map<string, string>();

  constructor() {
    super("memory");
  }

  get(path: string): Promise<string | null> {
    return Promise.resolve(this.files.get(path) ?? null);
  }

  put(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    return Promise.resolve();
  }

  delete(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }
}

/**
 * The applied estate, carrying NO DDL of its own.
 *
 * A generated MySQL artifact is database-relative by design (§13), so its
 * statements would execute wherever the connection points — that selection is
 * the pinned migration session's job and does not exist yet. What this entry
 * isolates is the half that IS landed: the tracking statements VibORM itself
 * builds, every one of which qualifies the target.
 */
const TRACKING_ENTRY: MigrationEntry = {
  idx: 0,
  version: "20260827000000",
  name: "ns_tracking",
  when: 1,
  checksum: "checksum-ns-tracking",
  mode: "manual",
  rollback: { kind: "manual" },
};

const TRACKING_MIGRATION =
  "-- Deliberately empty: this estate exists to be TRACKED, not to emit DDL.\n";

/**
 * A DATABASE-RELATIVE artifact, exactly as MySQL generation emits one (§13).
 *
 * It carries no qualifier, so executing it verbatim on a connection whose
 * default database is `beta` lands the table in `beta`. §5.3's "validated
 * target selection for relative artifact execution" is what makes it land in
 * the configured `alpha` instead, and the pinned session is where that
 * selection happens — on the one connection that runs the artifact, immediately
 * before it.
 */
const RELATIVE_ENTRY: MigrationEntry = {
  idx: 1,
  version: "20260827000001",
  name: "ns_relative_ddl",
  when: 2,
  checksum: "checksum-ns-relative",
  mode: "manual",
  rollback: { kind: "manual" },
};

const RELATIVE_MIGRATION =
  "CREATE TABLE `ns_relative` (`id` VARCHAR(64) NOT NULL PRIMARY KEY);\n";

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

  /** The migration names one database's tracking ledger holds. */
  async function trackedNamesIn(database: string): Promise<string[]> {
    let names: string[] = [];
    await withAdmin(async (admin) => {
      const rows = await admin.$queryRawUnsafe<{ name: string }>(
        `SELECT name FROM \`${database}\`.\`_viborm_migrations\` ORDER BY name`
      );
      names = rows.map((row) => row.name);
    });
    return names;
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
    await push(client, { force: true });
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

    const second = await push(client, { force: true });
    expect(second.operations).toEqual([]);
  });

  test("applies into the TARGET's tracking table, over a connection pointing elsewhere", async () => {
    const storage = new MemoryStorage();
    await storage.writeJournal({
      version: "3",
      target: { dialect: "mysql" },
      entries: [TRACKING_ENTRY, RELATIVE_ENTRY],
    });
    await storage.writeMigration(TRACKING_ENTRY, TRACKING_MIGRATION);
    await storage.writeMigration(RELATIVE_ENTRY, RELATIVE_MIGRATION);

    const client = createClient({
      schema: noteSchema,
      driver: crossTargetDriver(),
    });

    // A DECOY tracking table in the database the CONNECTION defaults to. Every
    // tracking statement `apply` runs — the CREATE, the applied-state SELECT,
    // the INSERT — was unqualified at baseline; any one that still forgot its
    // qualifier would find this table and succeed silently. With the decoy
    // present, "alpha holds the ledger and beta's stays empty" is a claim only
    // correctly qualified statements can satisfy.
    await withAdmin(async (admin) => {
      await admin.$executeRawUnsafe(
        `CREATE TABLE \`${BETA_DB}\`.\`_viborm_migrations\` (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, checksum VARCHAR(64) NOT NULL, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`
      );
    });

    try {
      // Alpha has no tracking table yet, so the read-only reader has to report
      // "nothing applied" — the one live exercise of MySQL's missing-table
      // translation (errno 1146 / SQLSTATE 42S02). Before the translation read
      // the channels VibORM actually preserves, this surfaced the raw failure.
      expect(await tableNamesIn(ALPHA_DB)).not.toContain("_viborm_migrations");
      const before = await status(client, { storageDriver: storage });
      expect(before.map((row) => row.applied)).toEqual([false, false]);

      const result = await apply(client, { storageDriver: storage });
      expect(result.applied.map((entry) => entry.name)).toEqual([
        TRACKING_ENTRY.name,
        RELATIVE_ENTRY.name,
      ]);

      // The ledger was created and written in the TARGET…
      expect(await tableNamesIn(ALPHA_DB)).toContain("_viborm_migrations");
      expect((await trackedNamesIn(ALPHA_DB)).sort()).toEqual(
        [TRACKING_ENTRY.name, RELATIVE_ENTRY.name].sort()
      );
      // …and so did the RELATIVE artifact's own DDL, which names no database at
      // all: the pinned session selected `alpha` before executing it (§5.3).
      expect(await tableNamesIn(ALPHA_DB)).toContain("ns_relative");
      // …and the connection's own database gained nothing but the decoy, which
      // is still empty: no tracking statement and no artifact statement landed
      // there.
      expect(await tableNamesIn(BETA_DB)).toEqual([
        "_viborm_migrations",
        "ns_sentinel",
      ]);
      expect(await trackedNamesIn(BETA_DB)).toEqual([]);

      // …and the same reader now reads it back from alpha, not from the decoy.
      const after = await status(client, { storageDriver: storage });
      expect(after.map((row) => row.applied)).toEqual([true, true]);
    } finally {
      await withAdmin(async (admin) => {
        for (const database of [ALPHA_DB, BETA_DB]) {
          await admin.$executeRawUnsafe(
            `DROP TABLE IF EXISTS \`${database}\`.\`_viborm_migrations\``
          );
          await admin.$executeRawUnsafe(
            `DROP TABLE IF EXISTS \`${database}\`.\`ns_relative\``
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
    await expect(push(client, { force: true })).rejects.toMatchObject({
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
    await expect(push(client, { force: true })).rejects.toMatchObject({
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
    await push(second, { force: true });
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
