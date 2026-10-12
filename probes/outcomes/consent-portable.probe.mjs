// New defect 3 (T2 in D4): a push consent previewed by one client instance
// is accepted by another createClient over the same database: the tenant
// flow previews in one request and confirms in another, after the object
// may have been evicted. 1.1.0 binds the consent to a random per-driver
// bindingId (push-fingerprint.ts:25-33), so the second client gets V11018.
// Checked on PGlite and on a SQLite file.
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { createMigrationClient } from "viborm/migrations";
import { createClient as createPgliteClient } from "viborm/pglite";
import { parseSchema } from "viborm/schema/json";
import { createClient as createSqliteClient } from "viborm/sqlite3";

export const meta = {
  id: "D4-consent-portable",
  title:
    "A push consent from one client instance is accepted by another on the same database",
  plan: "phase-2/D4 (T2, new defect 3)",
  needs: [],
  source:
    "completion-plan-2026-10/code-check-probes/tenant-api/probes/t2-consent-binding.mjs; src/migrations/push-fingerprint.ts:25-33; push-consent.ts:163-175",
};

const base = {
  version: 1,
  enums: { plan: { values: ["free", "team", "business"] } },
  models: {
    member: {
      fields: {
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
      },
    },
  },
};
const { legacyRef: _dropped, ...remaining } = base.models.member.fields;
const next = { ...base, models: { member: { fields: remaining } } };

async function crossClient(openClient) {
  const seed = openClient(base);
  const seeding = createMigrationClient(seed);
  await seeding.push({
    consent: (await seeding.push({ dryRun: true })).consent,
  });
  await seed.$disconnect();

  const requestOne = openClient(next);
  const preview = await createMigrationClient(requestOne).push({
    dryRun: true,
  });
  const stored = JSON.stringify(preview.consent);
  await requestOne.$disconnect();

  const requestTwo = openClient(next);
  try {
    const result = await createMigrationClient(requestTwo).push({
      consent: JSON.parse(stored),
    });
    return `${result.outcome}`;
  } catch (error) {
    return `${error.code} ${String(error.message).split("\n")[0].slice(0, 100)}`;
  } finally {
    await requestTwo.$disconnect();
  }
}

export default async function probe(ctx) {
  const pg = new PGlite();
  const file = new Database(join(ctx.tmpDir, "tenant.sqlite"));
  try {
    const pglite = await crossClient((doc) =>
      createPgliteClient({
        client: pg,
        schema: parseSchema(JSON.stringify(doc)),
      })
    );
    const sqlite = await crossClient((doc) =>
      createSqliteClient({
        client: file,
        schema: parseSchema(JSON.stringify(doc)),
      })
    );
    const ok = pglite === "applied" && sqlite === "applied";
    return {
      status: ok ? "pass" : "fail",
      evidence: `consent from client 1 replayed by client 2: pglite ${pglite}; sqlite ${sqlite}`,
    };
  } finally {
    file.close();
    await pg.close();
  }
}
