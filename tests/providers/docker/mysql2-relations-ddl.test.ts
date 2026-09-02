/**
 * mysql2 Driver Tests - relations and DDL
 *
 * Relation traversal and schema-DDL contracts: many-to-many, relation filter
 * mutations, forward FK ordering, FK and mapped indexes, partial-index refusal,
 * ordering arrays on create, and implicit returning.
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

import { fkIndexContract } from "@tests/contracts/drivers/behaviors/fk-index-behavior";
import { forwardFkOrderingContract } from "@tests/contracts/drivers/behaviors/forward-fk-ordering-behavior";
import { implicitReturningContract } from "@tests/contracts/drivers/behaviors/implicit-returning-behavior";
import {
  mappedIndexContract,
  partialIndexRefusalContract,
} from "@tests/contracts/drivers/behaviors/index-ddl-behavior";
import { manyToManyContract } from "@tests/contracts/drivers/behaviors/many-to-many-behavior";
import { orderingArrayCreateContract } from "@tests/contracts/drivers/behaviors/ordering-array-create-behavior";
import { relationFilterMutationContract } from "@tests/contracts/drivers/behaviors/relation-filter-mutation-behavior";
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

  orderingArrayCreateContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  implicitReturningContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  fkIndexContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  mappedIndexContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  partialIndexRefusalContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  forwardFkOrderingContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  manyToManyContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  relationFilterMutationContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });
});
