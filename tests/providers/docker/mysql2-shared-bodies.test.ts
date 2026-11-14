/**
 * MySQL2 Driver Tests - shared relation bodies on MySQL 8: no MySQL driver
 * declares `capabilities.sharesRelationBodies`, so the fact is set on the
 * driver's adapter here, as `shared-bodies-behavior.ts` does on SQLite3 and
 * PGlite. Each repeated body is a `WITH` member read through backtick-quoted
 * aliases (`extension-shared-bodies.core.test.ts` pins the spelling); this
 * runs it and compares the rows with the inline form.
 *
 * NOTE: These tests require a running MySQL database.
 */

import { runSharedBodiesBehavior } from "@tests/contracts/public-client/shared-bodies-behavior";
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

  runSharedBodiesBehavior({
    name: "MySQL2",
    createDriver: createMySQL2Driver,
  });
});
