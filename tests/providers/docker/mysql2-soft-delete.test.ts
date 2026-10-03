/**
 * MySQL2 Driver Tests - `viborm/soft-delete` (extension-capabilities plan
 * v3.1 §1.1) on MySQL: the plan's use block end to end. MySQL has no partial
 * index, so the slug index is plain and the partial-unique recipe (a
 * generated column there, v2 plan §4.5) is not witnessed.
 *
 * NOTE: These tests require a running MySQL database.
 */

import { runSoftDeleteBehavior } from "@tests/contracts/public-client/soft-delete-behavior";
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

  runSoftDeleteBehavior({
    name: "MySQL2",
    createDriver: createMySQL2Driver,
    partialUnique: false,
  });
});
