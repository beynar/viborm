/**
 * pg Driver Tests - depth seam and produced identity
 *
 * Engine write behaviors for the depth seam, produced identity, own-write
 * linearization, and junction createMany.
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
import { runDepthSeamBehavior } from "@tests/contracts/engine/write/depth-seam-behavior";
import { runJunctionCreateManyBehavior } from "@tests/contracts/engine/write/junction-create-many-behavior";
import { runOwnWriteLinearizationBehavior } from "@tests/contracts/engine/write/own-write-linearization-behavior";
import { runProducedIdentityBehavior } from "@tests/contracts/engine/write/produced-identity-depth-behavior";
import { PgBatchForcedDriver } from "@tests/fixtures/drivers/batch-forced-pg";
import { dropEveryLiveTable, TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("pg Driver", () => {
  // The shared behavior suites and client-integration tests assume a fresh
  // database. PostgreSQL persists between tests, so drop everything first:
  // pushing an empty schema diffs to dropTable for every existing table.
  // (Same pattern as mysql2.test.ts.)
  beforeEach(dropEveryLiveTable);

  runDepthSeamBehavior({
    name: "pg transaction",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runDepthSeamBehavior({
    name: "pg atomic batch",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runProducedIdentityBehavior({
    name: "pg transaction",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runProducedIdentityBehavior({
    name: "pg atomic batch",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runOwnWriteLinearizationBehavior({
    name: "pg transaction",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runOwnWriteLinearizationBehavior({
    name: "pg atomic batch",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runJunctionCreateManyBehavior({
    name: "pg transaction",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runJunctionCreateManyBehavior({
    name: "pg atomic batch",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
});
