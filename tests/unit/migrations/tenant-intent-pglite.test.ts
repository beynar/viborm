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
import { createTenantMigrator } from "@migrations/tenant";
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

/** A one-model document: `id` and the fields given. */
const tenantDoc = (
  table: string,
  fields: Record<string, object>,
  indexes: object[] = []
) => ({
  version: 1,
  models: {
    [table]: {
      fields: { id: { type: "string", id: true }, ...fields },
      indexes,
    },
  },
});

const renameColumn = (tableName: string, from: string, to: string) => ({
  type: "column" as const,
  tableName,
  from,
  to,
  resolution: "rename" as const,
});

/** The names PostgreSQL holds for the tenant's indexes, constraints and types. */
async function physicalNames(): Promise<string[]> {
  const { rows } = await database.query<{ name: string }>(
    `SELECT name FROM (
       SELECT relname AS name FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'i'
       UNION SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype <> 'n'
       UNION SELECT typname FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typtype = 'e'
     ) AS names WHERE name NOT LIKE '\\_viborm\\_%' ORDER BY 1`
  );
  return rows.map(({ name }) => name);
}

test.each([
  [
    "a column with a derived unique index and a unique field",
    tenantDoc(
      "b",
      { v: { type: "string" }, u: { type: "string", unique: true } },
      [{ fields: ["v"], unique: true }]
    ),
    tenantDoc(
      "b",
      { w: { type: "string" }, u2: { type: "string", unique: true } },
      [{ fields: ["w"], unique: true }]
    ),
    [renameColumn("b", "v", "w"), renameColumn("b", "u", "u2")],
    `INSERT INTO "b" ("id", "v", "u") VALUES ('r1', 'one', 'uno')`,
    `SELECT "id", "w", "u2" FROM "b"`,
    { id: "r1", w: "one", u2: "uno" },
    ["b_pkey", "b_u2_key", "b_w_idx"],
  ],
  [
    "a column of an unnamed enum",
    tenantDoc("b", { st: { type: "enum", enum: ["a", "b"] } }),
    tenantDoc("b", { st2: { type: "enum", enum: ["a", "b"] } }),
    [renameColumn("b", "st", "st2")],
    `INSERT INTO "b" ("id", "st") VALUES ('r1', 'b')`,
    `SELECT "id", "st2"::text FROM "b"`,
    { id: "r1", st2: "b" },
    ["b_pkey", "b_st2_enum"],
  ],
  [
    "a table with an unnamed enum column and a derived index",
    tenantDoc("b", { st: { type: "enum", enum: ["a", "b"] } }, [
      { fields: ["st"] },
    ]),
    tenantDoc("c", { st: { type: "enum", enum: ["a", "b"] } }, [
      { fields: ["st"] },
    ]),
    [
      {
        type: "table" as const,
        from: "b",
        to: "c",
        resolution: "rename" as const,
      },
    ],
    `INSERT INTO "b" ("id", "st") VALUES ('r1', 'a')`,
    `SELECT "id", "st"::text FROM "c"`,
    { id: "r1", st: "a" },
    ["c_pkey", "c_st_enum", "c_st_idx"],
  ],
])("a tenant renames %s: the derived names follow, the rows stay, and down restores them (PGlite)", async (_label, before, after, decisions, seed, read, row, renamed) => {
  const migrator = createTenantMigrator({
    client: createClient({ client: database, schema: {} }),
    history: new MemoryEstateStorage(),
  });
  expect(await migrator.change(parseSchema(before))).toMatchObject({
    kind: "applied",
  });
  const original = await physicalNames();
  await database.exec(seed);

  const result = await migrator.change(parseSchema(after), { decisions });

  expect(result).toMatchObject({ kind: "applied" });
  expect(await physicalNames()).toEqual(renamed);
  expect((await database.query(read)).rows).toEqual([row]);
  await expect(
    createMigrationClient(
      createClient({ client: database, schema: parseSchema(after) }),
      { storage: new MemoryEstateStorage() }
    ).push({ dryRun: true })
  ).resolves.toMatchObject({ operations: [] });
  await migrator.down();
  expect(await physicalNames()).toEqual(original);
});

test("a tenant renames a column with a derived unique index and drops it, beside a dropped column (PGlite)", async () => {
  const migrator = createTenantMigrator({
    client: createClient({ client: database, schema: {} }),
    history: new MemoryEstateStorage(),
  });
  const before = tenantDoc(
    "b",
    { v: { type: "string" }, gone: { type: "string", nullable: true } },
    [{ fields: ["v"], unique: true }]
  );
  expect(await migrator.change(parseSchema(before))).toMatchObject({
    kind: "applied",
  });
  await database.exec(`INSERT INTO "b" ("id", "v") VALUES ('r1', 'one')`);
  const result = await migrator.change(
    parseSchema(tenantDoc("b", { w: { type: "string" } })),
    {
      decisions: [
        renameColumn("b", "v", "w"),
        {
          type: "destructive",
          operation: "dropColumn",
          table: "b",
          column: "gone",
        },
      ],
    }
  );
  expect(result).toMatchObject({ kind: "applied" });
  expect(await physicalNames()).toEqual(["b_pkey"]);
  expect((await database.query(`SELECT "w" FROM "b"`)).rows).toEqual([
    { w: "one" },
  ]);
});

test("a failed tenant change carries its cause's code and the server's SQLSTATE, not the statement (PGlite)", async () => {
  const migrator = createTenantMigrator({
    client: createClient({ client: database, schema: {} }),
    history: new MemoryEstateStorage(),
  });
  const before = tenantDoc("b", { v: { type: "string" } });
  expect(await migrator.change(parseSchema(before))).toMatchObject({
    kind: "applied",
  });
  await database.exec(
    `INSERT INTO "b" ("id", "v") SELECT 'r' || i, 'same' FROM generate_series(1, ${INVOICE_ROWS}) AS i`
  );

  const result = await migrator.change(
    parseSchema(
      tenantDoc("b", { v: { type: "string" } }, [
        { fields: ["v"], unique: true },
      ])
    )
  );

  expect(result).toMatchObject({
    kind: "failed",
    error: {
      code: VibORMErrorCode.MIGRATION_FAILED,
      causeCode: VibORMErrorCode.UNIQUE_CONSTRAINT,
      providerSqlState: "23505",
    },
  });
  expect(JSON.stringify(result)).not.toContain("same");
});
