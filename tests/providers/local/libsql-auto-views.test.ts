/**
 * Views kept by triggers on LibSQL, which refuses live migration commands:
 * the statements a push plans run by hand (each one statement, a trigger's
 * `BEGIN … END` included), then every write moves the views
 * (`exerciseAutoViews`).
 */

import { createClient } from "@client/client";
import { createMigrationClient } from "@migrations/dialects/all";
import {
  autoViewsSchema,
  exerciseAutoViews,
} from "@tests/contracts/public-client/schema-auto-views-behavior";
import { createInMemoryLibSQLDriver } from "@tests/fixtures/drivers/libsql";
import { expect, test } from "vitest";

test("LibSQL: views kept by triggers follow every write", async () => {
  const driver = createInMemoryLibSQLDriver();
  const client = createClient({ driver, schema: autoViewsSchema() });
  const preview = await createMigrationClient(client).push({ dryRun: true });
  expect(
    preview.statements.some(({ sql }) => sql.startsWith("CREATE TRIGGER"))
  ).toBe(true);
  for (const statement of preview.statements)
    await driver._executeRaw(statement.sql);
  await exerciseAutoViews(client as never, (name) => `"${name}"`);
});
