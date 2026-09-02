/**
 * LibSQL index DDL and read planning: foreign-key and partial indexes, forward FK ordering, window aggregates, and cursor and nested pagination.
 *
 * One file of the LibSQL provider suite, which is split across sibling
 * `libsql-*.test.ts` files. Every registered contract instantiates the
 * client's generic surface over its own multi-model schema, and the 1280 MB
 * TypeScript shard heap holds only a handful of those instantiations per
 * program, so the suite is partitioned by schema group rather than by size.
 * The forced-batch driver the batch contracts need lives in
 * `./libsql-fixtures`, which Vitest does not collect.
 */

import { countAggregateWindowContract } from "@tests/contracts/drivers/behaviors/count-aggregate-window-behavior";
import { cursorPaginationContract } from "@tests/contracts/drivers/behaviors/cursor-pagination-behavior";
import { distinctSkipWindowContract } from "@tests/contracts/drivers/behaviors/distinct-skip-window-behavior";
import {
  fkIndexContract,
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
import { createInMemoryLibSQLDriver } from "@tests/fixtures/drivers/libsql";
import { describe } from "vitest";

// biome-ignore lint/suspicious/noSkippedTests: V1 effectful push is not supported by libSQL.
describe.skip("LibSQL contracts that need effectful live-schema setup (DRIVER_NOT_SUPPORTED)", () => {
  fkIndexContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  mappedIndexContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  partialIndexContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  partialIndexCoverageContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  fkIndexUpgradeContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  forwardFkOrderingContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
    fkNamesRoundTrip: false,
  });
  countAggregateWindowContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  distinctSkipWindowContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  cursorPaginationContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  nestedPaginationContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  omitContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
});
