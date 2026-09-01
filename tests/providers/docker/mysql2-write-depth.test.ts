/**
 * mysql2 Driver Tests - depth seam and produced identity
 *
 * Engine write behaviors for the depth seam, produced identity, own-write
 * linearization, and junction createMany.
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

import { runDepthSeamBehavior } from "@tests/contracts/engine/write/depth-seam-behavior";
import { runJunctionCreateManyBehavior } from "@tests/contracts/engine/write/junction-create-many-behavior";
import { runOwnWriteLinearizationBehavior } from "@tests/contracts/engine/write/own-write-linearization-behavior";
import { runProducedIdentityBehavior } from "@tests/contracts/engine/write/produced-identity-depth-behavior";
import { MySQL2BatchForcedDriver } from "@tests/fixtures/drivers/batch-forced-mysql2";
import {
  createMySQL2Driver,
  dropEveryLiveTable,
  TEST_CONNECTION_STRING,
} from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("MySQL2 Driver", () => {
  // The shared behavior suites assume a fresh database (the local drivers are
  // in-memory). MySQL persists between tests, so drop everything first:
  // pushing an empty schema diffs to dropTable for every existing table.
  beforeEach(dropEveryLiveTable);

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
    // Same reason as the located-parent Ref leg in
    // `mysql2-write-parent-held.test.ts`: the nested `createMany`'s
    // `skipDuplicates` is the savepoint-wrapped executor effect on this dialect,
    // and a savepoint has no lowering into a single atomic batch.
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
    // Same reason as the located-parent Ref leg in
    // `mysql2-write-parent-held.test.ts`: the junction's per-row
    // `skipDuplicates` INSERT is the savepoint-wrapped executor effect here.
    skipDuplicatesInBatchIsInexpressible: true,
  });
});
