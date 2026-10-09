/**
 * MySQL2 Driver Tests - recursive relation filters (`recurse` in `where`) on
 * MySQL: reads and changes to other models run, and an `updateMany` or
 * `deleteMany` whose closure walks the model it changes is refused before any
 * SQL is sent, with the database unchanged.
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
  beforeEach(dropEveryLiveTable);
  // The provider files share one database: leave it as empty as it was found.
  afterAll(dropEveryLiveTable);

  runRecursiveRelationFilterBehavior({
    name: "MySQL2",
    createDriver: createMySQL2Driver,
  });
});
