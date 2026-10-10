// S4 step 3 (FI-03): resolve({ outcome: "rolled-back" }) refuses while the
// attempt's ledger holds a committed opaque step that no executed rollback
// undid. 1.1.0 accepts it, and the retry credits every account twice
// (100 -> 110 -> 120).
import Database from "better-sqlite3";
import { s, sql } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "S4-resolve-double-credit",
  title:
    "resolve('rolled-back') refuses an attempt with a committed opaque step (no double credit)",
  plan: "phase-1/lane-O/S4",
  needs: [],
  source:
    "migrations-durable-objects-review-2026-10-09/lanes/fault-injection.md (FI-03); completion-plan-2026-10/code-check-probes/migrations-sqlite/probes/recovery-probe.mjs (case C)",
};

const ACCOUNTS = 1000;

const account = s.model({
  id: s.string().id(),
  owner: s.string(),
  email: s.string().unique(),
  tier: s.enum(["free", "pro", "enterprise"]).default("free"),
  currency: s.string().default("EUR"),
  balance: s.int(),
  creditLimit: s.int().default(0),
  frozen: s.boolean().default(false),
  settings: s.json().nullable(),
  note: s.string().nullable(),
  lastInterestAt: s.dateTime().nullable(),
  closedAt: s.dateTime().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});

const total = (db) =>
  db.prepare(`SELECT sum("balance") AS total FROM "account"`).get().total;

// A migration-state refusal (invalid state, partial or ambiguous effect),
// not any error.
const STATE_REFUSAL = /^refused V110(09|19|20)$/;

export default async function probe() {
  const db = new Database(":memory:");
  const client = createClient({ client: db, schema: { account } });
  try {
    const migrations = createMigrationClient(client, {
      storage: new MemoryEstateStorage(),
      tables: ["account"],
    });
    await migrations.generate({ name: "init" });
    await migrations.apply();
    await client.account.createMany({
      data: Array.from({ length: ACCOUNTS }, (_, i) => ({
        id: `acc-${i}`,
        owner: `owner ${i}`,
        email: `a${i}@example.test`,
        balance: 100,
      })),
    });
    const init = (await migrations.show({ name: "init" })).stateId;
    const populated = {
      kind: "trusted-read",
      query: sql.raw(`SELECT EXISTS (SELECT 1 FROM "account") AS ok`),
      equals: true,
    };
    await migrations.generate({
      name: "credit-interest",
      manualMigration: {
        transitions: [
          {
            from: init,
            execution: "stepwise",
            originChecks: [populated],
            up: [
              sql.raw(`UPDATE "account" SET "balance" = "balance" + 10`),
              sql.raw(`INSERT INTO "interest_run" ("id") VALUES ('2026-10')`),
            ],
            rollback: { kind: "irreversible", reason: "probe" },
          },
        ],
        destinationChecks: [populated],
      },
    });
    try {
      await migrations.apply();
      return {
        status: "fail",
        evidence: "first apply succeeded; expected V11020",
      };
    } catch {
      // statement 1 committed (+10), statement 2 failed: the FI-03 setup.
    }
    const afterFirst = total(db);
    let resolve = "accepted";
    try {
      await migrations.resolve({ outcome: "rolled-back" });
    } catch (error) {
      resolve = `refused ${error.code}`;
    }
    db.exec(`CREATE TABLE "interest_run" ("id" TEXT PRIMARY KEY)`);
    let retry = "not run";
    if (resolve === "accepted") {
      try {
        retry = (await migrations.apply()).outcome;
      } catch (error) {
        retry = `${error.code}`;
      }
    }
    const final = total(db);
    const perAccount = (value) => value / ACCOUNTS;
    const held = STATE_REFUSAL.test(resolve) && final === afterFirst;
    return {
      status: held ? "pass" : "fail",
      evidence: `resolve('rolled-back') ${resolve}; retry ${retry}; balance per account 100 -> ${perAccount(afterFirst)} -> ${perAccount(final)}`,
    };
  } finally {
    await client.$disconnect();
    db.close();
  }
}
