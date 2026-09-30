/**
 * MySQL2 Driver Tests - rows bound to the call (extension-capabilities plan
 * v4 §2.1, §6 "Bound rows") on MySQL: the same behaviour SQLite3, batch-only
 * SQLite3, SQLite3 without RETURNING and PGlite run.
 *
 * NOTE: These tests require a running MySQL database.
 */

import { runBoundRowsBehavior } from "@tests/contracts/engine/query/bound-rows-behavior";
import {
  createMySQL2Driver,
  dropEveryLiveTable,
  TEST_CONNECTION_STRING,
} from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("MySQL2 Driver", () => {
  beforeEach(dropEveryLiveTable);

  runBoundRowsBehavior({ name: "MySQL2", createDriver: createMySQL2Driver });
});
