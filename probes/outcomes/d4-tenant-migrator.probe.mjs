// D4 (with T1's noop, T6's beforeDestructive): the tenant migrator helper
// over createMigrationClient. The plan's sketch (completion-plan-2026-10.md
// D4, "names not final") is pinned as:
//   createTenantMigrator({ client, history, limits? })
//     .change(parseSchema(doc, { validate: true }), { decisions, signal, beforeDestructive })
//   -> { kind: 'applied' | 'noop' | 'refused' | 'failed' | 'ambiguous' }
// from `viborm/migrations/tenant`. `client` is any client on the tenant's
// database (here PGlite with an empty schema); `history` is the
// ObjectStoreConditionalPut seam D3 binds to a Durable Object's ctx.storage,
// in memory here; the deadline is an AbortSignal. Checked: first document ->
// applied; same document -> noop; reorder-only document -> noop with no new
// state (decision 8); a destructive document without decisions -> refused,
// beforeDestructive not called, data kept; status/log/resolve exposed. The
// Miniflare Durable Object suite is D4's own gate.
import { PGlite } from "@electric-sql/pglite";
import {
  MemoryConditionalObjectStore,
  ObjectStoreEstateStorage,
} from "viborm/migrations";
import { createClient } from "viborm/pglite";
import { parseSchema } from "viborm/schema/json";

export const meta = {
  id: "D4-tenant-migrator",
  title:
    "createTenantMigrator().change() returns applied/noop/refused outcomes",
  plan: "phase-2/D4 (T1, T6)",
  needs: [],
  source:
    "completion-plan-2026-10/code-check/tenant-api.md (D4, T6); migrations-durable-objects-review-2026-10-09 (WK-02/05)",
};

const fields = {
  id: { type: "string", id: true },
  email: { type: "string", unique: true },
  displayName: { type: "string" },
  plan: { type: "enum", enum: "plan", default: "free" },
  seats: { type: "int", default: 1 },
  legacyRef: { type: "string", nullable: true },
  profile: { type: "json", nullable: true },
  lastSeenAt: { type: "datetime", nullable: true },
  createdAt: { type: "datetime", generate: { kind: "now" } },
  updatedAt: { type: "datetime", generate: { kind: "updatedAt" } },
};
const enums = { plan: { values: ["free", "team", "business"] } };
const docA = { version: 1, enums, models: { member: { fields } } };
const docReordered = {
  version: 1,
  enums,
  models: {
    member: { fields: Object.fromEntries(Object.entries(fields).reverse()) },
  },
};
const { legacyRef: _dropped, ...remaining } = fields;
const docDrop = {
  version: 1,
  enums,
  models: { member: { fields: remaining } },
};

const bounded = (promise, ms, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} exceeded ${ms} ms`)),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

export default async function probe() {
  let createTenantMigrator;
  try {
    ({ createTenantMigrator } = await import("viborm/migrations/tenant"));
  } catch {
    return {
      status: "fail",
      evidence: "viborm has no viborm/migrations/tenant createTenantMigrator",
    };
  }
  const pg = new PGlite();
  try {
    const history = new ObjectStoreEstateStorage(
      new MemoryConditionalObjectStore()
    );
    const migrator = createTenantMigrator({
      client: createClient({ client: pg, schema: {} }),
      history,
    });
    const change = (doc, options = {}) =>
      bounded(
        migrator.change(parseSchema(doc, { validate: true }), {
          signal: AbortSignal.timeout(20_000),
          ...options,
        }),
        30_000,
        "change"
      );
    const steps = [];
    const first = await change(docA);
    steps.push(`first ${first.kind}`);
    await pg.query(
      `INSERT INTO "member" ("id","email","displayName","legacyRef","createdAt","updatedAt") VALUES ('m1','a@example.test','A','L-1',now(),now())`
    );
    const same = await change(docA);
    steps.push(`same ${same.kind}`);
    const statesBefore = (await history.listStates()).length;
    const reorder = await change(docReordered);
    const reorderStates = (await history.listStates()).length - statesBefore;
    steps.push(`reorder ${reorder.kind} (+${reorderStates} state)`);
    let called = 0;
    const refused = await change(docDrop, {
      beforeDestructive: () => {
        called += 1;
      },
    });
    const kept = (await pg.query(`SELECT "legacyRef" FROM "member"`)).rows[0]
      ?.legacyRef;
    steps.push(
      `drop without decisions ${refused.kind}, beforeDestructive x${called}, legacyRef ${kept}`
    );
    const rpc = ["status", "log", "resolve"].filter(
      (name) => typeof migrator[name] !== "function"
    );
    steps.push(
      rpc.length === 0
        ? "status/log/resolve exposed"
        : `missing ${rpc.join(",")}`
    );
    const ok =
      first.kind === "applied" &&
      same.kind === "noop" &&
      reorder.kind === "noop" &&
      reorderStates === 0 &&
      refused.kind === "refused" &&
      called === 0 &&
      kept === "L-1" &&
      rpc.length === 0;
    return { status: ok ? "pass" : "fail", evidence: steps.join("; ") };
  } finally {
    await pg.close();
  }
}
