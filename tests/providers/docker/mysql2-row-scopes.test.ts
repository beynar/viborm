/**
 * MySQL2 Driver Tests - the `rows` capability (extension-capabilities plan
 * v3.1 §2.2, §5.3) on MySQL: the same behaviour SQLite3, batch-only SQLite3
 * and PGlite run, including a claimed polymorphic arm's existence test nested
 * in MySQL's JSON document.
 *
 * NOTE: These tests require a running MySQL database.
 */

import { runRowScopeBehavior } from "@tests/contracts/engine/query/row-scope-behavior";
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

  runRowScopeBehavior({ name: "MySQL2", createDriver: createMySQL2Driver });
});
