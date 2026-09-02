/**
 * pg Driver Tests - nested writes and races
 *
 * Nested-write contracts plus the legs only a real multi-connection database can
 * run: concurrent upserts, the write-race retry, and the filtered-M2M
 * deleteMany staleness guards, with raw SQL over the client alongside them.
 *
 * One program per file has to fit the 1280 MB TypeScript shard heap, and the
 * type inference a behavior module's schemas force is what that heap holds, so
 * this suite is split by schema across `pg*.test.ts`. Every piece keeps the
 * `pg Driver` describe and its drop-everything `beforeEach`, so test names and
 * per-test lifecycle are unchanged.
 *
 * NOTE: These tests require a running PostgreSQL database.
 * Skip in CI unless PostgreSQL is available.
 */

import { PgDriver } from "@drivers/pg";
import { clientRawContract } from "@tests/contracts/drivers/behaviors/client-raw-behavior";
import { m2mDeleteManyStalenessContract } from "@tests/contracts/drivers/behaviors/m2m-deletemany-staleness-behavior";
import { nestedWriteAdvancedContract } from "@tests/contracts/drivers/behaviors/nested-write-advanced-behavior";
import { nestedWriteContract } from "@tests/contracts/drivers/behaviors/nested-write-behavior";
import { nestedWriteConcurrencyContract } from "@tests/contracts/drivers/behaviors/nested-write-concurrency-behavior";
import { rawArrayTransactionContract } from "@tests/contracts/drivers/behaviors/raw-array-transaction-behavior";
import { upsertAtomicityContract } from "@tests/contracts/drivers/behaviors/upsert-atomicity-behavior";
import {
  PgBatchForcedDriver,
  PgBeforeFirstBatchDriver,
  PgBeforeFirstWriteBatchDriver,
  PgRacePlantingBatchDriver,
} from "@tests/fixtures/drivers/batch-forced-pg";
import { dropEveryLiveTable, TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("pg Driver", () => {
  // The shared behavior suites and client-integration tests assume a fresh
  // database. PostgreSQL persists between tests, so drop everything first:
  // pushing an empty schema diffs to dropTable for every existing table.
  // (Same pattern as mysql2.test.ts.)
  beforeEach(dropEveryLiveTable);

  // Real multi-connection driver: the concurrent upsert tests in this suite
  // genuinely race two transactions, unlike single-session PGlite.
  upsertAtomicityContract.register({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  // M8 (§7.4, D7): the write-race retry unified above selectMode. Two real
  // connections genuinely race; the batch-forced sibling exercises the PlannedMode
  // converge-on-rerun that batch-only drivers lacked. Only runnable with a real
  // multi-connection database, hence its home here.
  nestedWriteConcurrencyContract.register({
    driverName: "pg",
    createTxDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
    createBatchDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
    createRacePlantingBatchDriver: ({ plant, onBatchError }) =>
      new PgRacePlantingBatchDriver(plant, onBatchError, {
        databaseUrl: TEST_CONNECTION_STRING,
      }),
    // §9.4/§13.4: the singular polymorphic slot transfer's two-adopter
    // arbitration. The hook has to sit at the ATOMIC WRITE UNIT's boundary, not
    // the first batch's: this plan's independent planning reads are dispatched
    // as a batch of their own, so the earlier boundary would fire before the
    // owner capture instead of after it.
    createCapturedPlanBatchDriver: ({ beforeFirstWriteBatch, onBatchError }) =>
      new PgBeforeFirstWriteBatchDriver(beforeFirstWriteBatch, onBatchError, {
        databaseUrl: TEST_CONNECTION_STRING,
      }),
  });

  // M9 (§9, §5.5 Rule 3): the filtered-M2M-deleteMany staleness guards close the
  // plan-time→execution window fail-closed. A member added on a real second
  // connection after the plan-time read aborts the guard (raceable); the retry
  // re-plans and converges. Docker-gated for the same reason as M8.
  m2mDeleteManyStalenessContract.register({
    driverName: "pg",
    createTxDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
    createStalePlanBatchDriver: ({ beforeFirstBatch, onBatchError }) =>
      new PgBeforeFirstBatchDriver(beforeFirstBatch, onBatchError, {
        databaseUrl: TEST_CONNECTION_STRING,
      }),
  });

  // Nested writes over real pooled connections (transactions span checkouts)
  nestedWriteContract.register({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  nestedWriteAdvancedContract.register({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  // Raw-string $queryRaw params and sql`` rendering go through the real pg
  // wire protocol here ($n placeholders), unlike the PGlite in-memory run.
  clientRawContract.register({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  rawArrayTransactionContract.register({
    name: "Docker PostgreSQL",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
});
