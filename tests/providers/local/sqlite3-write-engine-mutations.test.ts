/**
 * SQLite3 write-engine conformance over the mutation schemas: to-one update where, the upsert family, nested mutations, reads, bulk writes, and createMany.
 *
 * One file of the SQLite3 provider suite, which is split across sibling
 * `sqlite3-*.test.ts` files. Every registered contract instantiates the
 * client's generic surface over its own multi-model schema, and the 1280 MB
 * TypeScript shard heap holds only a handful of those instantiations per
 * program, so the suite is partitioned by schema group rather than by size.
 * The forced-batch driver the batch contracts need lives in
 * `./sqlite3-fixtures`, which Vitest does not collect.
 */

import { runBulkWriteBehavior } from "@tests/contracts/engine/write/bulk-write-behavior";
import { runCreateManyBehavior } from "@tests/contracts/engine/write/create-many-behavior";
import { runNestedMutationBehavior } from "@tests/contracts/engine/write/nested-mutation-behavior";
import { runReadBehavior } from "@tests/contracts/engine/write/read-behavior";
import { runToOneUpdateWhereBehavior } from "@tests/contracts/engine/write/to-one-update-where-behavior";
import { runUpsertFamilyBehavior } from "@tests/contracts/engine/write/upsert-family-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { createBatchOnlySQLite3Driver } from "./sqlite3-fixtures";

describe("SQLite3 Driver", () => {
  runToOneUpdateWhereBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runToOneUpdateWhereBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });
  runUpsertFamilyBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runUpsertFamilyBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });
  runNestedMutationBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runNestedMutationBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });
  runReadBehavior({
    name: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runBulkWriteBehavior({
    name: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runCreateManyBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runCreateManyBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });
});
