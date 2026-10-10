// S13 (new defect 2): generate passes drops and type changes through the
// resolve callback, exactly as push does; with rejectAllResolver it refuses
// and publishes nothing. 1.1.0 publishes (and apply then runs) a dropColumn,
// a dropTable and an INTEGER -> TEXT change without ever calling the
// callback, even with rejectAllResolver. Checked on SQLite and PGlite.
import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import {
  createMigrationClient,
  MemoryEstateStorage,
  rejectAllResolver,
} from "viborm/migrations";
import { createClient as createPgliteClient } from "viborm/pglite";
import { parseSchema } from "viborm/schema/json";
import { createClient as createSqliteClient } from "viborm/sqlite3";

export const meta = {
  id: "S13-generate-asks",
  title:
    "generate asks the resolver before drops and type changes; rejectAllResolver refuses",
  plan: "phase-1/lane-O/S13",
  needs: [],
  source:
    "completion-plan-2026-10/code-check-probes/tenant-api/probes/t2-decisions.mjs; src/migrations/differ.ts:991-1054",
};

const base = {
  version: 1,
  enums: { tier: { values: ["free", "pro", "enterprise"] } },
  models: {
    account: {
      fields: {
        id: { type: "string", id: true },
        email: { type: "string", unique: true },
        name: { type: "string" },
        tier: { type: "enum", enum: "tier", default: "free" },
        score: { type: "int" },
        balance: { type: "int", default: 0 },
        legacyCode: { type: "string", nullable: true },
        settings: { type: "json", nullable: true },
        createdAt: { type: "datetime", generate: { kind: "now" } },
        updatedAt: { type: "datetime", generate: { kind: "updatedAt" } },
      },
    },
    audit: {
      fields: {
        id: { type: "string", id: true },
        note: { type: "string" },
        createdAt: { type: "datetime", generate: { kind: "now" } },
      },
    },
  },
};
const { legacyCode: _dropped, ...accountFields } = base.models.account.fields;
const destructive = {
  ...base,
  models: {
    account: { fields: { ...accountFields, score: { type: "string" } } },
  },
};

const dialects = {
  sqlite: () => {
    const handle = new Database(":memory:");
    return {
      client: (doc) =>
        createSqliteClient({
          client: handle,
          schema: parseSchema(JSON.stringify(doc)),
        }),
      close: async () => handle.close(),
    };
  },
  pglite: () => {
    const handle = new PGlite();
    return {
      client: (doc) =>
        createPgliteClient({
          client: handle,
          schema: parseSchema(JSON.stringify(doc)),
        }),
      close: async () => handle.close(),
    };
  },
};

async function run(dialect) {
  const db = dialects[dialect]();
  const storage = new MemoryEstateStorage();
  const first = db.client(base);
  const next = db.client(destructive);
  try {
    const m1 = createMigrationClient(first, { storage });
    await m1.generate({ name: "base" });
    await m1.apply();
    const m2 = createMigrationClient(next, { storage });
    const statesBefore = (await m2.list()).length;
    let rejected;
    try {
      const result = await m2.generate({
        name: "drop",
        resolve: rejectAllResolver,
      });
      rejected = `${result.outcome} [${result.operations.map((op) => op.type).join(",")}]`;
    } catch (error) {
      rejected = `refused ${error.code}`;
    }
    const publishedUnderReject = (await m2.list()).length - statesBefore;
    const asked = [];
    await m2.generate({
      name: "drop-preview",
      dryRun: true,
      resolve: (change) => {
        asked.push(`${change.type}:${change.operation ?? change.enumName}`);
        return change.type === "destructive" ? change.proceed() : undefined;
      },
    });
    const askedDrops =
      asked.includes("destructive:dropColumn") &&
      asked.includes("destructive:dropTable") &&
      asked.includes("destructive:alterColumn");
    return {
      ok:
        rejected === "refused V11010" &&
        publishedUnderReject === 0 &&
        askedDrops,
      line: `${dialect}: rejectAll -> ${rejected}, ${publishedUnderReject} state(s) published; callback asked [${asked.join(",")}]`,
    };
  } finally {
    await first.$disconnect();
    await next.$disconnect();
    await db.close();
  }
}

export default async function probe() {
  const results = [await run("sqlite"), await run("pglite")];
  return {
    status: results.every((result) => result.ok) ? "pass" : "fail",
    evidence: results.map((result) => result.line).join("; "),
  };
}
