// S13 / decision 3: an approval given at generate (an allowing resolver) is
// saved in the published migration state, show() displays it, and apply runs
// the approved state without asking again. The approval's field name is not
// pinned by the plan: any show() key matching /approv|consent|decision/i
// whose content names the dropped table and column counts. 1.1.0 records no
// approval at all.
import Database from "better-sqlite3";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { parseSchema } from "viborm/schema/json";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "S13-approval-shown",
  title:
    "A destructive approval is saved in the state, shown by show(), and apply runs it",
  plan: "phase-1/lane-O/S13",
  needs: [],
  source:
    "completion-plan-2026-10.md S13 + decision 3; src/migrations/public-view.ts:41-50",
};

const APPROVAL_KEY = /approv|consent|decision/i;

const base = {
  version: 1,
  enums: { tier: { values: ["free", "pro", "enterprise"] } },
  models: {
    account: {
      fields: {
        id: { type: "string", id: true },
        email: { type: "string", unique: true },
        tier: { type: "enum", enum: "tier", default: "free" },
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
  models: { account: { fields: accountFields } },
};

/** Every [path, value] whose key looks like an approval record. */
function approvalEntries(value, path = "show()") {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(APPROVAL_KEY.test(key) ? [[`${path}.${key}`, child]] : []),
    ...approvalEntries(child, `${path}.${key}`),
  ]);
}

export default async function probe() {
  const db = new Database(":memory:");
  const storage = new MemoryEstateStorage();
  const first = createClient({
    client: db,
    schema: parseSchema(JSON.stringify(base)),
  });
  const next = createClient({
    client: db,
    schema: parseSchema(JSON.stringify(destructive)),
  });
  try {
    const m1 = createMigrationClient(first, { storage });
    await m1.generate({ name: "base" });
    await m1.apply();
    const m2 = createMigrationClient(next, { storage });
    const generated = await m2.generate({
      name: "drop-legacy",
      resolve: (change) =>
        change.type === "destructive" ? change.proceed() : undefined,
    });
    if (generated.outcome !== "published") {
      return {
        status: "fail",
        evidence: `allowed generate returned ${generated.outcome}`,
      };
    }
    const shown = await m2.show({ id: generated.stateId });
    const approvals = approvalEntries(shown).filter(([, child]) => {
      const text = JSON.stringify(child) ?? "";
      return text.includes("audit") && text.includes("legacyCode");
    });
    let applied;
    try {
      applied = (await m2.apply()).outcome;
    } catch (error) {
      applied = `${error.code} ${String(error.message).split("\n")[0].slice(0, 100)}`;
    }
    if (approvals.length === 0) {
      return {
        status: "fail",
        evidence: `show() of the approved state has no approval naming audit/legacyCode; keys [${Object.keys(shown).sort().join(",")}]; apply ${applied}`,
      };
    }
    return {
      status: applied === "applied" ? "pass" : "fail",
      evidence: `${approvals[0][0]} = ${JSON.stringify(approvals[0][1]).slice(0, 160)}; apply ${applied}`,
    };
  } finally {
    await first.$disconnect();
    await next.$disconnect();
    db.close();
  }
}
