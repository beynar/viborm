// T1 (pin, already true in 1.1.0): the same schema document generates the
// same stateId, snapshotHash and sqlHash on fresh estates, and a document
// that only reorders an existing table's `fields` keys (and the model keys)
// generates 0 operations. SQLite and PGlite.
import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient as createPgliteClient } from "viborm/pglite";
import { parseSchema } from "viborm/schema/json";
import { createClient as createSqliteClient } from "viborm/sqlite3";

export const meta = {
  id: "T1-same-document-same-ids",
  title: "Same document -> same ids; reordered fields -> 0 operations",
  plan: "phase-2/D4 step 8 (T1)",
  needs: [],
  source:
    "completion-plan-2026-10/code-check-probes/tenant-api/probes/t1-reorder.mjs; src/migrations/differ.ts:467-468; push-fingerprint.ts:158",
};

const itemFields = {
  id: { type: "string", id: true, generate: { kind: "ulid" } },
  sku: { type: "string", unique: true },
  name: { type: "string" },
  description: { type: "string", nullable: true },
  price: { type: "decimal", precision: 10, scale: 2 },
  qty: { type: "int", default: 0 },
  weightGrams: { type: "int", nullable: true },
  status: { type: "enum", enum: "status", default: "draft" },
  featured: { type: "boolean", default: false },
  meta: { type: "json", nullable: true },
  publishedAt: { type: "datetime", nullable: true },
  createdAt: { type: "datetime", generate: { kind: "now" } },
  updatedAt: { type: "datetime", generate: { kind: "updatedAt" } },
  ownerId: { type: "string" },
  owner: {
    type: "toOne",
    target: "owner",
    name: "ItemOwner",
    fields: ["ownerId"],
    references: ["id"],
    onDelete: "cascade",
  },
};
const owner = {
  fields: {
    id: { type: "string", id: true, generate: { kind: "ulid" } },
    email: { type: "string", unique: true },
    items: { type: "toMany", target: "item", name: "ItemOwner" },
  },
};
const enums = { status: { values: ["draft", "live", "archived"] } };
const docA = {
  version: 1,
  enums,
  models: {
    item: { fields: itemFields, indexes: [{ fields: ["name", "qty"] }] },
    owner,
  },
};
const reversed = Object.fromEntries(Object.entries(itemFields).reverse());
const docReordered = {
  version: 1,
  enums,
  models: {
    owner,
    item: { fields: reversed, indexes: [{ fields: ["name", "qty"] }] },
  },
};
const text = (doc) => JSON.stringify(doc);

async function check(dialect, openClient) {
  const ids = [];
  for (let run = 0; run < 2; run++) {
    const client = openClient(docA);
    const m = createMigrationClient(client, {
      storage: new MemoryEstateStorage(),
    });
    const r = await m.generate({ name: "init", dryRun: true });
    ids.push(`${r.stateId}/${r.snapshotHash}/${r.sqlHash}`);
    await client.$disconnect();
  }
  const storage = new MemoryEstateStorage();
  const a = openClient(docA);
  const ma = createMigrationClient(a, { storage });
  await ma.generate({ name: "init" });
  await ma.apply();
  await a.$disconnect();
  const b = openClient(docReordered);
  const reorder = await createMigrationClient(b, { storage }).generate({
    name: "reorder",
    dryRun: true,
  });
  await b.$disconnect();
  const same = ids[0] === ids[1];
  return {
    ok: same && reorder.operations.length === 0,
    line: `${dialect}: ids ${same ? "identical" : `differ (${ids.join(" vs ")})`}; reorder -> ${reorder.operations.length} operation(s)`,
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
