/**
 * SQLite3 relation filters, RETURNING folds, bulk-write limits, and JSON list and null-sentinel filtering.
 *
 * One file of the SQLite3 provider suite, which is split across sibling
 * `sqlite3-*.test.ts` files. Every registered contract instantiates the
 * client's generic surface over its own multi-model schema, and the 1280 MB
 * TypeScript shard heap holds only a handful of those instantiations per
 * program, so the suite is partitioned by schema group rather than by size.
 * The forced-batch driver the batch contracts need lives in
 * `./sqlite3-fixtures`, which Vitest does not collect.
 */

import { bulkWriteLimitContract } from "@tests/contracts/drivers/behaviors/bulk-write-limit-behavior";
import { createManyReturnFoldContract } from "@tests/contracts/drivers/behaviors/create-many-return-fold-behavior";
import { implicitReturningContract } from "@tests/contracts/drivers/behaviors/implicit-returning-behavior";
import { jsonNullSentinelContract } from "@tests/contracts/drivers/behaviors/json-null-sentinel-behavior";
import { listJsonFilterContract } from "@tests/contracts/drivers/behaviors/list-json-filter-behavior";
import { orderingArrayCreateContract } from "@tests/contracts/drivers/behaviors/ordering-array-create-behavior";
import { relationFilterMutationContract } from "@tests/contracts/drivers/behaviors/relation-filter-mutation-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

describe("SQLite3 Driver", () => {
  relationFilterMutationContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  orderingArrayCreateContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  implicitReturningContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  createManyReturnFoldContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  bulkWriteLimitContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  listJsonFilterContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  jsonNullSentinelContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
});
