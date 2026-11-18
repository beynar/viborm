/**
 * Views through push, generate, apply, down and reset on PostgreSQL, whose
 * DROP VIEW and DROP TABLE are RESTRICT and whose ALTER COLUMN TYPE refuses a
 * column a view reads. The definitions are the test's (see view-definitions).
 */

import { PgDriver } from "@drivers/pg";
import { runViewMigrationBehavior } from "@tests/providers/view-migrations-behavior";
import { beforeEach, describe, vi } from "vitest";
import { dropEveryLiveTable, TEST_CONNECTION_STRING } from "./pg-fixtures";

vi.mock("@migrations/view-definition", async () => {
  const { testViewDefinition } = await import(
    "@tests/providers/view-definitions"
  );
  return { viewDefinition: testViewDefinition };
});

describe.skipIf(!TEST_CONNECTION_STRING)("pg", () => {
  beforeEach(dropEveryLiveTable);

  runViewMigrationBehavior({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
});
