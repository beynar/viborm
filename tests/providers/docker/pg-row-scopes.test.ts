/**
 * pg Driver Tests - the `rows` capability (extension-capabilities plan v3.1
 * §2.2, §5.3) on a real PostgreSQL server: the same behaviour SQLite3,
 * batch-only SQLite3 and PGlite run, over the pg driver's own transport.
 *
 * NOTE: These tests require a running PostgreSQL database.
 */

import { PgDriver } from "@drivers/pg";
import { runRowScopeBehavior } from "@tests/contracts/engine/query/row-scope-behavior";
import { dropEveryLiveTable, TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("pg Driver", () => {
  beforeEach(dropEveryLiveTable);

  runRowScopeBehavior({
    name: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
});
