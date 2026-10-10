// T1 / decision 8: a reorder-only tenant document is a `noop` and publishes
// nothing. 1.1.0 already plans 0 operations for it, but generate still
// publishes an empty state (outcome "published"). SQLite and PGlite.
import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient as createPgliteClient } from "viborm/pglite";
import { parseSchema } from "viborm/schema/json";
import { createClient as createSqliteClient } from "viborm/sqlite3";

export const meta = {
  id: "T1-reorder-noop",
  title: "A reorder-only document generates noop and publishes no state",
  plan: "phase-2/D4 step 8 (T1, decision 8)",
  needs: [],
  source:
    "completion-plan-2026-10/code-check-probes/tenant-api/probes/t1-reorder.mjs; src/migrations/generate-v1.ts:241-262",
};

const ROWS = 2000;

const fields = {
  id: { type: "string", id: true },
  number: { type: "string", unique: true },
  customerEmail: { type: "string" },
  status: { type: "enum", enum: "invoiceStatus", default: "draft" },
  currency: { type: "string", default: "EUR" },
  amountCents: { type: "int" },
  taxCents: { type: "int", default: 0 },
  balanceCents: { type: "int" },
  notes: { type: "string", nullable: true },
  metadata: { type: "json", nullable: true },
  dueAt: { type: "datetime", nullable: true },
  paidAt: { type: "datetime", nullable: true },
  createdAt: { type: "datetime", generate: { kind: "now" } },
  updatedAt: { type: "datetime", generate: { kind: "updatedAt" } },
};
const enums = { invoiceStatus: { values: ["draft", "sent", "paid", "void"] } };
const docA = { version: 1, enums, models: { invoice: { fields } } };
const shuffledKeys = [
  "updatedAt",
  "metadata",
  "id",
  "dueAt",
  "status",
  "number",
  "taxCents",
  "createdAt",
  "customerEmail",
  "paidAt",
  "amountCents",
  "currency",
  "notes",
  "balanceCents",
];
const docB = {
  version: 1,
  enums,
  models: {
    invoice: {
      fields: Object.fromEntries(shuffledKeys.map((key) => [key, fields[key]])),
    },
  },
};
const text = (doc) => JSON.stringify(doc);

async function check(dialect, openClient) {
  const storage = new MemoryEstateStorage();
  const a = openClient(docA);
  const ma = createMigrationClient(a, { storage });
  await ma.generate({ name: "init" });
  await ma.apply();
  for (let start = 0; start < ROWS; start += 500) {
    await a.invoice.createMany({
      data: Array.from({ length: 500 }, (_, i) => ({
        id: `inv-${start + i}`,
        number: `N-${start + i}`,
        customerEmail: `c${start + i}@example.test`,
        amountCents: 1000,
        balanceCents: 1000,
      })),
    });
  }
  await a.$disconnect();
  const b = openClient(docB);
  const mb = createMigrationClient(b, { storage });
  const before = (await mb.list()).length;
  const generated = await mb.generate({ name: "reorder" });
  const published = (await mb.list()).length - before;
  await b.$disconnect();
  return {
    ok: generated.outcome === "noop" && published === 0,
    line: `${dialect}: generate -> ${generated.outcome}, ${generated.operations.length} operation(s), ${published} state(s) published`,
  };
}

export default async function probe() {
  const db = new Database(":memory:");
  const pg = new PGlite();
  try {
    const results = [
      await check("sqlite", (doc) =>
        createSqliteClient({ client: db, schema: parseSchema(text(doc)) })
      ),
      await check("pglite", (doc) =>
        createPgliteClient({ client: pg, schema: parseSchema(text(doc)) })
      ),
    ];
    return {
      status: results.every((result) => result.ok) ? "pass" : "fail",
      evidence: results.map((result) => result.line).join("; "),
    };
  } finally {
    db.close();
    await pg.close();
  }
}
