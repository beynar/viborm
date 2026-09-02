/**
 * mysql2 Driver Tests - upsert family, reads and bulk writes
 *
 * Engine write behaviors for the to-one update-where form, the upsert family,
 * absent optional binds, and the read / bulk-write / createMany families.
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

import { runBulkWriteBehavior } from "@tests/contracts/engine/write/bulk-write-behavior";
import { runCreateManyBehavior } from "@tests/contracts/engine/write/create-many-behavior";
import { runOptionalAbsentBindBehavior } from "@tests/contracts/engine/write/optional-absent-bind-behavior";
import { runReadBehavior } from "@tests/contracts/engine/write/read-behavior";
import { runToOneUpdateWhereBehavior } from "@tests/contracts/engine/write/to-one-update-where-behavior";
import { runUpsertFamilyBehavior } from "@tests/contracts/engine/write/upsert-family-behavior";
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
});
