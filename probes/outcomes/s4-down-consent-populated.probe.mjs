// S4 step 2 (FI-08): down asks consent before a stored destructive rollback
// drops a POPULATED table (the "absent-and-empty-table" probe decides);
// the same rollback on an EMPTY table still runs without consent. The
// absolute form down({ to }) is used so that S4 step 1's expectRevision
// cannot be what refuses. 1.1.0 drops 10,000 rows silently.
import Database from "better-sqlite3";
import { s } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "S4-down-consent-populated",
  title:
    "down refuses to drop a populated table without consent; an empty one still rolls back",
  plan: "phase-1/lane-O/S4",
  needs: [],
  source:
    "migrations-durable-objects-review-2026-10-09/lanes/fault-injection.md (FI-08); src/migrations/catalog-probes.ts:243-266; operators.ts:291-500",
};

const ROWS = 10_000;
// V11017 consent required, or V11010 destructive change rejected.
const CONSENT_REFUSAL = /^refused V110(17|10)$/;

const invoice = s.model({
  id: s.string().id(),
  number: s.string().unique(),
  customerEmail: s.string(),
  status: s.enum(["draft", "sent", "paid", "void"]).default("draft"),
  amountCents: s.int(),
  createdAt: s.dateTime().now(),
});
const lineItem = s.model({
  id: s.string().id(),
  invoiceId: s.string(),
  sku: s.string(),
  description: s.string(),
  kind: s.enum(["product", "service", "fee", "discount"]).default("product"),
  quantity: s.int(),
  unitCents: s.int(),
  taxRate: s.int().default(0),
  currency: s.string().default("EUR"),
  attributes: s.json().nullable(),
  note: s.string().nullable(),
  shippedAt: s.dateTime().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});

const count = (db) =>
  db.prepare(`SELECT name FROM sqlite_master WHERE name = 'lineItem'`).get()
    ? db.prepare(`SELECT count(*) AS n FROM "lineItem"`).get().n
    : "table dropped";

export default async function probe() {
  const db = new Database(":memory:");
  const storage = new MemoryEstateStorage();
  const v1 = createClient({ client: db, schema: { invoice } });
  const v2 = createClient({ client: db, schema: { invoice, lineItem } });
  try {
    const m1 = createMigrationClient(v1, { storage });
    await m1.generate({ name: "invoices" });
    await m1.apply();
    const m2 = createMigrationClient(v2, { storage });
    await m2.generate({ name: "line-items" });
    await m2.apply();
    for (let start = 0; start < ROWS; start += 1000) {
      await v2.lineItem.createMany({
        data: Array.from({ length: 1000 }, (_, i) => ({
          id: `li-${start + i}`,
          invoiceId: `inv-${(start + i) % 97}`,
          sku: `SKU-${(start + i) % 311}`,
          description: "consulting",
          quantity: 1 + ((start + i) % 5),
          unitCents: 1250,
          attributes: { lot: (start + i) % 13 },
        })),
      });
    }
    const back = { to: { name: "invoices" } };
    let populated = "accepted";
    try {
      await m2.down(back);
    } catch (error) {
      populated = `refused ${error.code}`;
    }
    const rowsAfter = count(db);
    if (!CONSENT_REFUSAL.test(populated) || rowsAfter !== ROWS) {
      return {
        status: "fail",
        evidence: `down({ to: "invoices" }) over ${ROWS} rows without consent: ${populated}; lineItem rows after: ${rowsAfter}`,
      };
    }
    db.exec(`DELETE FROM "lineItem"`);
    let empty = "accepted";
    try {
      await m2.down(back);
    } catch (error) {
      empty = `refused ${error.code} ${String(error.message).split("\n")[0].slice(0, 100)}`;
    }
    const ok = empty === "accepted" && count(db) === "table dropped";
    return {
      status: ok ? "pass" : "fail",
      evidence: `populated: ${populated}, ${rowsAfter} rows kept; empty table rollback: ${empty}`,
    };
  } finally {
    await v1.$disconnect();
    await v2.$disconnect();
    db.close();
  }
}
