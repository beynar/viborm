/**
 * Views through push, generate, apply, down and reset on PGlite: one
 * database for the file, a schema of its own per test. The definitions are
 * the test's (see view-definitions).
 */

import { PGliteDriver } from "@drivers/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { runViewMigrationBehavior } from "@tests/providers/view-migrations-behavior";
import { beforeAll, vi } from "vitest";

vi.mock("@migrations/view-definition", async () => {
  const { testViewDefinition } = await import(
    "@tests/providers/view-definitions"
  );
  return { viewDefinition: testViewDefinition };
});

let database: PGlite;
let schemas = 0;

beforeAll(() => {
  database = openTestPGlite();
});

runViewMigrationBehavior({
  driverName: "PGlite",
  createDriver: async () => {
    schemas += 1;
    const namespace = `views_${schemas}`;
    await database.query(`CREATE SCHEMA "${namespace}"`);
    return new PGliteDriver({ client: database, namespace });
  },
});
