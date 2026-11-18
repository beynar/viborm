/**
 * Views through push, generate, apply, down and reset on SQLite, which
 * rewrites a view on a rename and refuses to rebuild a table a view reads.
 * The definitions are the test's (see view-definitions).
 */

import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { runViewMigrationBehavior } from "@tests/providers/view-migrations-behavior";
import { vi } from "vitest";

vi.mock("@migrations/view-definition", async () => {
  const { testViewDefinition } = await import(
    "@tests/providers/view-definitions"
  );
  return { viewDefinition: testViewDefinition };
});

runViewMigrationBehavior({
  driverName: "SQLite3",
  createDriver: createInMemorySQLite3Driver,
});
