/**
 * mysql2 Driver Tests - read surface
 *
 * Read-path contracts: projection, relation aggregates, nested ordering,
 * windowed counts and distinct/skip, and cursor pagination.
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

import { countAggregateWindowContract } from "@tests/contracts/drivers/behaviors/count-aggregate-window-behavior";
import { cursorPaginationContract } from "@tests/contracts/drivers/behaviors/cursor-pagination-behavior";
import { distinctSkipWindowContract } from "@tests/contracts/drivers/behaviors/distinct-skip-window-behavior";
import { nestedOrderByContract } from "@tests/contracts/drivers/behaviors/nested-orderby-behavior";
import { omitContract } from "@tests/contracts/drivers/behaviors/omit-behavior";
import { readPathRegressionContract } from "@tests/contracts/drivers/behaviors/read-path-regression-behavior";
import { relationReadAggregateContract } from "@tests/contracts/drivers/behaviors/relation-read-aggregate-behavior";
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
});
