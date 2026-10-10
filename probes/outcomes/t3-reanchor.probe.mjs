// T3 (migrations-10): reanchor() after a restore where the history is OLDER
// than the database marker (the Durable Object history restored behind
// Postgres). The marker names a state the history lacks, so every command
// refuses (MIGRATION_CORRUPTION "Marker state is missing from the estate").
// reanchor() must refuse while no known state matches the live schema, and
// once the app regenerates that schema (here under another name, so another
// id) move the marker onto the matching state: verify ok, apply noop.
// 1.1.0 has no reanchor(). PGlite stands in for the tenant's Postgres.
import { PGlite } from "@electric-sql/pglite";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient } from "viborm/pglite";
import { parseSchema } from "viborm/schema/json";

export const meta = {
  id: "T3-reanchor",
  title:
    "reanchor() moves the marker to the matching known state after an older-history restore",
  plan: "phase-3/T3",
  needs: [],
  source:
    "completion-plan-2026-10/code-check/migrations-sqlite.md (T3); src/migrations/apply-v1.ts:444; control.ts:695-789",
};

const fields = {
  id: { type: "string", id: true },
  email: { type: "string", unique: true },
  displayName: { type: "string" },
  plan: { type: "enum", enum: "plan", default: "free" },
  seats: { type: "int", default: 1 },
  profile: { type: "json", nullable: true },
  createdAt: { type: "datetime", generate: { kind: "now" } },
  updatedAt: { type: "datetime", generate: { kind: "updatedAt" } },
};
const enums = { plan: { values: ["free", "team", "business"] } };
const docA = { version: 1, enums, models: { member: { fields } } };
const docB = structuredClone(docA);
docB.models.member.fields.lastSeenAt = { type: "datetime", nullable: true };
docB.models.member.fields.locale = { type: "string", default: "en" };

const code = async (fn) => {
  try {
    await fn();
    return "ok";
  } catch (error) {
    return `${error.code ?? error.name}`;
  }
};

export default async function probe() {
  const pg = new PGlite();
  const clients = [];
  const open = (doc, storage) => {
    const client = createClient({
      client: pg,
      schema: parseSchema(JSON.stringify(doc)),
    });
    clients.push(client);
    return createMigrationClient(client, { storage });
  };
  try {
    const live = new MemoryEstateStorage();
    const a = open(docA, live);
    const stateA = (await a.generate({ name: "a" })).stateId;
    await a.apply();
    const b = open(docB, live);
    const stateB = (await b.generate({ name: "b" })).stateId;
    await b.apply();

    const restored = new MemoryEstateStorage();
    const ra = open(docA, restored);
    const regeneratedA = (await ra.generate({ name: "a" })).stateId;
    const rb = open(docB, restored);
    const applyOnRestored = await code(() => rb.apply());
    if (typeof rb.reanchor !== "function") {
      return {
        status: "fail",
        evidence: `older history: apply ${applyOnRestored}; migration client has no reanchor() (same-name regeneration reproduces the id: ${regeneratedA === stateA})`,
      };
    }
    const noMatch = await code(() => rb.reanchor());
    const stateB2 = (await rb.generate({ name: "b-regenerated" })).stateId;
    const reanchored = await code(() => rb.reanchor());
    const marker = (await rb.status()).marker?.stateId;
    const verified = (await rb.verify()).ok;
    const again = (await rb.apply()).outcome;
    const ok =
      noMatch !== "ok" &&
      reanchored === "ok" &&
      marker === stateB2 &&
      stateB2 !== stateB &&
      verified === true &&
      again === "noop";
    return {
      status: ok ? "pass" : "fail",
      evidence: `older history: apply ${applyOnRestored}; reanchor with no matching state ${noMatch}; after regenerating b: reanchor ${reanchored}, marker at b-regenerated ${marker === stateB2}, verify ${verified}, apply ${again}`,
    };
  } finally {
    for (const client of clients) await client.$disconnect();
    await pg.close();
  }
}
