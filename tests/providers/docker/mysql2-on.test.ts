/**
 * MySQL2 Driver Tests - `viborm/on` on MySQL: no RETURNING, so a write a hook
 * concerns reads its rows back the way a write with a `select` does.
 *
 * NOTE: These tests require a running MySQL database.
 */

import { runOnBehavior } from "@tests/contracts/public-client/on-behavior";
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

  runOnBehavior({ name: "MySQL2", createDriver: createMySQL2Driver });
});
