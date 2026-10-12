// T2 (in D4): intent as data. `createPredefinedResolver` is public; it is
// built from a JSON-serializable decisions value and drives generate. The
// rename entry uses the shape the internal resolver already has
// ({ type, tableName, from, to, resolution }, src/migrations/resolver.ts:412);
// the checks that do not depend on the entry shape are: a destructive change
// that no entry allows is refused, an enum value removal that no entry maps
// is refused, and an unknown entry is refused. 1.1.0 does not export it.
import Database from "better-sqlite3";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { parseSchema } from "viborm/schema/json";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "T2-predefined-resolver",
  title:
    "createPredefinedResolver is public, serializable, and refuses what it does not name",
  plan: "phase-2/D4 step 9 (T2)",
  needs: [],
  source:
    "completion-plan-2026-10/code-check-probes/tenant-api/probes/t2-decisions.mjs; src/migrations/resolver.ts:412-447",
};

const base = {
  version: 1,
  enums: { tier: { values: ["free", "pro", "legacy"] } },
  models: {
    account: {
      fields: {
        id: { type: "string", id: true },
        email: { type: "string", unique: true },
        name: { type: "string" },
        tier: { type: "enum", enum: "tier", default: "free" },
        balance: { type: "int", default: 0 },
        legacyCode: { type: "string", nullable: true },
        settings: { type: "json", nullable: true },
        createdAt: { type: "datetime", generate: { kind: "now" } },
        updatedAt: { type: "datetime", generate: { kind: "updatedAt" } },
      },
    },
  },
};
const renamed = (() => {
  const doc = structuredClone(base);
  const { name, ...rest } = doc.models.account.fields;
  doc.models.account.fields = { ...rest, displayName: name };
  return doc;
})();
const renamedAndDropped = (() => {
  const doc = structuredClone(renamed);
  const { legacyCode: _dropped, ...rest } = doc.models.account.fields;
  doc.models.account.fields = rest;
  return doc;
})();
const renamedAndEnumShrunk = (() => {
  const doc = structuredClone(renamed);
  doc.enums.tier.values = ["free", "pro"];
  return doc;
})();
const renameDecision = [
  {
    type: "column",
    tableName: "account",
    from: "name",
    to: "displayName",
    resolution: "rename",
  },
];

// An unknown entry is invalid input (V4002) or a rejected change (V11010).
const INVALID_OR_REJECTED = /^refused V(4002|11010)$/;

async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    return `refused ${error.code ?? error.name}`;
  }
}

export default async function probe() {
  const { createPredefinedResolver } = await import("viborm/migrations");
  if (typeof createPredefinedResolver !== "function") {
    return {
      status: "fail",
      evidence: "viborm/migrations has no export createPredefinedResolver",
    };
  }
  const db = new Database(":memory:");
  const storage = new MemoryEstateStorage();
  const open = (doc) =>
    createClient({ client: db, schema: parseSchema(JSON.stringify(doc)) });
  const clients = [];
  const migrationsFor = (doc) => {
    const client = open(doc);
    clients.push(client);
    return createMigrationClient(client, { storage });
  };
  try {
    const m0 = migrationsFor(base);
    await m0.generate({ name: "base" });
    await m0.apply();
    const fromJson = () =>
      createPredefinedResolver(JSON.parse(JSON.stringify(renameDecision)));
    const rename = await attempt(async () => {
      const r = await migrationsFor(renamed).generate({
        name: "rename",
        dryRun: true,
        resolve: fromJson(),
      });
      return r.operations.map((op) => op.type).join(",");
    });
    const drop = await attempt(async () => {
      const r = await migrationsFor(renamedAndDropped).generate({
        name: "drop",
        dryRun: true,
        resolve: fromJson(),
      });
      return `${r.outcome} [${r.operations.map((op) => op.type).join(",")}]`;
    });
    const enumShrink = await attempt(async () => {
      const r = await migrationsFor(renamedAndEnumShrunk).generate({
        name: "enum",
        dryRun: true,
        resolve: fromJson(),
      });
      return `${r.outcome} [${r.operations.map((op) => op.type).join(",")}]`;
    });
    const unknown = await attempt(async () => {
      const resolver = createPredefinedResolver([
        { type: "bogus", tableName: "account", from: "x", to: "y" },
      ]);
      const r = await migrationsFor(renamed).generate({
        name: "unknown",
        dryRun: true,
        resolve: resolver,
      });
      return `${r.outcome}`;
    });
    const ok =
      rename === "renameColumn" &&
      drop === "refused V11010" &&
      enumShrink === "refused V11010" &&
      INVALID_OR_REJECTED.test(unknown);
    return {
      status: ok ? "pass" : "fail",
      evidence: `rename decision -> ${rename}; unlisted drop -> ${drop}; unmapped enum removal -> ${enumShrink}; unknown entry -> ${unknown}`,
    };
  } finally {
    for (const client of clients) await client.$disconnect();
    db.close();
  }
}
