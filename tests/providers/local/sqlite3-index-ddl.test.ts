/**
 * SQLite3 index DDL and read planning: foreign-key and partial indexes, ordering plans, window aggregates, cursor and nested pagination, and omit.
 *
 * One file of the SQLite3 provider suite, which is split across sibling
 * `sqlite3-*.test.ts` files. Every registered contract instantiates the
 * client's generic surface over its own multi-model schema, and the 1280 MB
 * TypeScript shard heap holds only a handful of those instantiations per
 * program, so the suite is partitioned by schema group rather than by size.
 * The forced-batch driver the batch contracts need lives in
 * `./sqlite3-fixtures`, which Vitest does not collect.
 */

import { countAggregateWindowContract } from "@tests/contracts/drivers/behaviors/count-aggregate-window-behavior";
import { cursorPaginationContract } from "@tests/contracts/drivers/behaviors/cursor-pagination-behavior";
import { distinctSkipWindowContract } from "@tests/contracts/drivers/behaviors/distinct-skip-window-behavior";
import {
  fkIndexContract,
  fkIndexPlanContract,
  fkIndexUpgradeContract,
} from "@tests/contracts/drivers/behaviors/fk-index-behavior";
import { forwardFkOrderingContract } from "@tests/contracts/drivers/behaviors/forward-fk-ordering-behavior";
import {
  mappedIndexContract,
  partialIndexContract,
  partialIndexCoverageContract,
} from "@tests/contracts/drivers/behaviors/index-ddl-behavior";
import { nestedPaginationContract } from "@tests/contracts/drivers/behaviors/nested-pagination-behavior";
import { omitContract } from "@tests/contracts/drivers/behaviors/omit-behavior";
import { orderingPlanContract } from "@tests/contracts/drivers/behaviors/ordering-plan-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

describe("SQLite3 Driver", () => {
  fkIndexContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  mappedIndexContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  partialIndexContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  partialIndexCoverageContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  fkIndexUpgradeContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  fkIndexPlanContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  orderingPlanContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  forwardFkOrderingContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
    fkNamesRoundTrip: false,
  });
  countAggregateWindowContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  distinctSkipWindowContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  cursorPaginationContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  nestedPaginationContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  omitContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
});
