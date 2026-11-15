/**
 * MySQL2 Driver Tests - recursive relation filters (`recurse` in `where`) on
 * MySQL: reads, and every change, which reads the matching keys before it
 * writes, so a closure over the model it changes matches the snapshot's rows.
 *
 * NOTE: These tests require a running MySQL database.
 */

import { runRecursiveRelationFilterBehavior } from "@tests/contracts/engine/query/recursive-relation-filter-behavior";
import {
  createMySQL2Driver,
  dropEveryLiveTable,
  TEST_CONNECTION_STRING,
} from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("MySQL2 Driver", () => {
  // The provider files share one database: leave it as empty as it was found.
  afterAll(dropEveryLiveTable);

  runRecursiveRelationFilterBehavior({
    name: "MySQL2",
    createDriver: createMySQL2Driver,
    reset: dropEveryLiveTable,
  });
});
