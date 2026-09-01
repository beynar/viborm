/**
 * SQLite3 write-engine conformance over the linearization schemas: own-write linearization, boolean no-op arms, post-transition adoption, junction createMany, and extended whereUnique.
 *
 * One file of the SQLite3 provider suite, which is split across sibling
 * `sqlite3-*.test.ts` files. Every registered contract instantiates the
 * client's generic surface over its own multi-model schema, and the 1280 MB
 * TypeScript shard heap holds only a handful of those instantiations per
 * program, so the suite is partitioned by schema group rather than by size.
 * The forced-batch driver the batch contracts need lives in
 * `./sqlite3-fixtures`, which Vitest does not collect.
 */

import { runBooleanNoOpArmBehavior } from "@tests/contracts/engine/write/boolean-noop-arm-behavior";
import { runExtendedWhereUniqueBehavior } from "@tests/contracts/engine/write/extended-where-unique-behavior";
import { runJunctionCreateManyBehavior } from "@tests/contracts/engine/write/junction-create-many-behavior";
import { runOwnWriteLinearizationBehavior } from "@tests/contracts/engine/write/own-write-linearization-behavior";
import { runPostTransitionAdoptBehavior } from "@tests/contracts/engine/write/post-transition-adopt-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { createBatchOnlySQLite3Driver } from "./sqlite3-fixtures";

describe("SQLite3 Driver", () => {
  runOwnWriteLinearizationBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runOwnWriteLinearizationBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });
  runBooleanNoOpArmBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runBooleanNoOpArmBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });
  runPostTransitionAdoptBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runPostTransitionAdoptBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });
  runJunctionCreateManyBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runJunctionCreateManyBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });
  runExtendedWhereUniqueBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runExtendedWhereUniqueBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });
});
