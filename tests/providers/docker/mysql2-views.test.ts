/**
 * Views through push, generate, apply, down and reset on MySQL, whose view
 * breaks on a column rename and whose DDL commits statement by statement.
 * The definitions are the test's (see view-definitions).
 */

import { runViewMigrationBehavior } from "@tests/providers/view-migrations-behavior";
import { beforeEach, describe, vi } from "vitest";
import {
  createMySQL2Driver,
  dropEveryLiveTable,
  TEST_CONNECTION_STRING,
} from "./mysql2-fixtures";

vi.mock("@migrations/view-definition", async () => {
  const { testViewDefinition } = await import(
    "@tests/providers/view-definitions"
  );
  return { viewDefinition: testViewDefinition };
});

describe.skipIf(!TEST_CONNECTION_STRING)("MySQL2", () => {
  beforeEach(dropEveryLiveTable);

  runViewMigrationBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });
});
