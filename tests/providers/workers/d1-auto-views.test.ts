/**
 * D1 Driver Tests — views kept by triggers. D1 refuses a live push, so the
 * tables, the views and their triggers are created by the statements a push
 * plans, each sent with `prepare().run()`; then every write moves the views
 * (`exerciseAutoViews`), a cascade from a parent included (D1 enforces
 * foreign keys, and a cascade fires the triggers of the rows it deletes).
 */

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { createClient } from "@src/client/client";
import { D1Driver } from "@src/drivers/d1";
import { createMigrationClient } from "@src/migrations/client";
import {
  autoViewsSchema,
  exerciseAutoViews,
} from "@tests/contracts/public-client/schema-auto-views-behavior";
import { expect, test } from "vitest";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
    }
  }
}

test("D1: views kept by triggers follow every write", async () => {
  const client = createClient({
    driver: new D1Driver({ database: env.DB }),
    schema: autoViewsSchema(),
  });
  const preview = await createMigrationClient(client).push({ dryRun: true });
  expect(
    preview.statements.some(({ sql }) => sql.startsWith("CREATE TRIGGER"))
  ).toBe(true);
  for (const statement of preview.statements)
    await env.DB.prepare(statement.sql).run();
  await exerciseAutoViews(client, (name) => `"${name}"`);
}, 120_000);
