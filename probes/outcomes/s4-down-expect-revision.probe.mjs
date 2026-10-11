// S4 step 1 (FI-08): the relative form of down takes `expectRevision`, a
// compare-and-swap on marker.revision, so a retried down({ steps: 1 }) after
// a lost acknowledgement refuses instead of rolling back one more state.
// Both rollbacks drop EMPTY tables (the invoices stay populated and
// untouched), so S4's populated-table consent never applies: only
// expectRevision can stop the retry. 1.1.0 refuses the option as an unknown
// key (V4002).
import Database from "better-sqlite3";
import { s } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "S4-down-expect-revision",
  title: "A retried relative down with a stale expectRevision is refused",
  plan: "phase-1/lane-O/S4",
  needs: [],
  source:
    "migrations-durable-objects-review-2026-10-09/lanes/fault-injection.md (FI-08); src/migrations/down-input.ts:13-43",
};

const ROWS = 1000;

const invoiceFields = {
  id: s.string().id(),
  number: s.string().unique(),
  customerEmail: s.string(),
  status: s.enum(["draft", "sent", "paid", "void"]).default("draft"),
  currency: s.string().default("EUR"),
  amountCents: s.int(),
  balanceCents: s.int(),
  notes: s.string().nullable(),
  metadata: s.json().nullable(),
  dueAt: s.dateTime().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
};
const tag = s.model({ id: s.string().id(), label: s.string() });
const reminder = s.model({
  id: s.string().id(),
  invoiceId: s.string(),
  sendAt: s.dateTime(),
});

const tables = (db) =>
  db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('invoice','tag','reminder') ORDER BY name`
    )
    .all()
    .map((row) => row.name)
    .join(",");

export default async function probe() {
  const db = new Database(":memory:");
  const storage = new MemoryEstateStorage();
  const schemas = [
    { invoice: s.model(invoiceFields) },
    { invoice: s.model(invoiceFields), tag },
    { invoice: s.model(invoiceFields), tag, reminder },
  ];
  const clients = schemas.map((schema) => createClient({ client: db, schema }));
  try {
    for (const [index, client] of clients.entries()) {
      const migrations = createMigrationClient(client, { storage });
      await migrations.generate({ name: `s${index + 1}` });
      await migrations.apply();
    }
    await clients[2].invoice.createMany({
      data: Array.from({ length: ROWS }, (_, i) => ({
        id: `inv-${i}`,
        number: `N-${i}`,
        customerEmail: `c${i}@example.test`,
        amountCents: 1000,
        balanceCents: 1000,
      })),
    });
    const migrations = createMigrationClient(clients[2], { storage });
    const revision = (await migrations.status()).marker.revision;
    try {
      await migrations.down({ steps: 1, expectRevision: revision });
    } catch (error) {
      return {
        status: "fail",
        evidence: `first down({ steps: 1, expectRevision: ${revision} }) refused: ${error.code} ${String(error.message).split("\n")[0].slice(0, 120)}`,
      };
    }
    const afterFirst = tables(db);
    let retry = "accepted";
    try {
      await migrations.down({ steps: 1, expectRevision: revision });
    } catch (error) {
      retry = `refused ${error.code}`;
    }
    const afterRetry = tables(db);
    // V11015 is the marker compare-and-swap refusal (MIGRATION_MARKER_CONFLICT).
    const held = retry === "refused V11015" && afterRetry === "invoice,tag";
    return {
      status: held ? "pass" : "fail",
      evidence: `retry with stale expectRevision ${revision}: ${retry}; tables after first down [${afterFirst}], after retry [${afterRetry}]`,
    };
  } finally {
    for (const client of clients) await client.$disconnect();
    db.close();
  }
}
