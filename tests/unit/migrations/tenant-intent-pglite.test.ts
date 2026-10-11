/**
 * T1 on PostgreSQL (PGlite): the same document gives the same ids, and a
 * document that only reorders models and fields is a `noop` that publishes
 * nothing (decision 8). The down preview refuses where `down` refuses: a
 * loss of rows without consent, and drift. SQLite runs the same facts in
 * `tenant-intent.core.test.ts`.
 */

import { createClient } from "@drivers/pglite";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations/client";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import type { ResolveCallback } from "@migrations/types";
import { s } from "@schema";
import { parseSchema } from "@schema/json";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import {
  documentOrderFacts,
  INVOICE_ROWS,
} from "@tests/unit/migrations/_tenant-documents";
import { beforeEach, expect, test } from "vitest";

// One Wasm database for the file: a second instance would push it past the
// process-group RSS ceiling. Each test starts from an empty `public` schema.
const database = openTestPGlite();
beforeEach(async () => {
  await database.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
});

test("same document gives the same ids, and reordered fields give 0 operations (PGlite)", async () => {
  const facts = await documentOrderFacts(
    (documentText) =>
      createClient({ client: database, schema: parseSchema(documentText) }),
    (sqlText) => database.exec(sqlText)
  );
  expect(facts.second).toMatchObject({
    stateId: facts.first.stateId,
    snapshotHash: facts.first.snapshotHash,
    sqlHash: facts.first.sqlHash,
  });
  expect(facts.reorder).toMatchObject({
    outcome: "noop",
    stateId: null,
    operations: [],
  });
  expect(facts.published).toBe(0);
  expect(facts.pending).toEqual([]);
  expect(facts.verified).toBe(true);
  const counted = await database.query<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM "invoice"'
  );
  expect(counted.rows).toEqual([{ n: INVOICE_ROWS }]);
});

test("the down preview refuses where down refuses (PGlite)", async () => {
  const storage = new MemoryEstateStorage();
  const invoice = s.model({ id: s.string().id(), number: s.string() });
  const lineItem = s.model({ id: s.string().id(), sku: s.string() });
  for (const [name, schema] of [
    ["invoices", { invoice }],
    ["line-items", { invoice, lineItem }],
  ] as const) {
    const step = createMigrationClient(
      createClient({ client: database, schema }),
      { storage }
    );
    await step.generate({ name });
    await step.apply();
  }
  await database.exec(`INSERT INTO "lineItem" ("id", "sku")
SELECT 'li-' || i, 'sku-' || i FROM generate_series(1, ${INVOICE_ROWS}) AS i`);
  const migrations = createMigrationClient(
    createClient({ client: database, schema: { invoice, lineItem } }),
    { storage }
  );
  const proceed: ResolveCallback = (change) =>
    change.type === "destructive" ? change.proceed() : undefined;
  const refusals = async (resolve?: ResolveCallback) => {
    const preview = await migrations.down({ dryRun: true, resolve });
    const real = await migrations.down({ resolve }).then(
      () => null,
      (error: Error & { code: string }) => error
    );
    return { preview: preview.preview && preview.refusal, real };
  };

  const consent = await refusals();
  expect(consent.real).toMatchObject({
    code: VibORMErrorCode.MIGRATION_CONSENT_REQUIRED,
  });
  expect(consent.preview).toEqual({
    code: consent.real?.code,
    message: consent.real?.message,
  });

  await database.exec('ALTER TABLE "invoice" ADD COLUMN "stray" text');
  const drift = await refusals(proceed);
  expect(drift.real).toMatchObject({ code: VibORMErrorCode.MIGRATION_DRIFT });
  expect(drift.preview).toEqual({
    code: drift.real?.code,
    message: drift.real?.message,
  });
  const counted = await database.query<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM "lineItem"'
  );
  expect(counted.rows).toEqual([{ n: INVOICE_ROWS }]);
});
