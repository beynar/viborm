// S3 step 5: status() reports the last failure (read from the ledger's
// `failed` events). 1.1.0's status() is {control, marker, pending, unfinished}.
import Database from "better-sqlite3";
import { s, sql } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "S3-status-last-failure",
  title: "status().lastFailure names the failed attempt",
  plan: "phase-1/lane-O/S3",
  needs: [],
  source:
    "completion-plan-2026-10/code-check-probes/migrations-sqlite/probes/recovery-probe.mjs (case A); src/migrations/operators.ts:66-71",
};

const invoice = s.model({
  id: s.string().id(),
  number: s.string().unique(),
  status: s.enum(["draft", "sent", "paid", "void"]).default("draft"),
  amountCents: s.int(),
  notes: s.string().nullable(),
  metadata: s.json().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});

export default async function probe() {
  const db = new Database(":memory:");
  const client = createClient({ client: db, schema: { invoice } });
  try {
    const migrations = createMigrationClient(client, {
      storage: new MemoryEstateStorage(),
    });
    await migrations.generate({ name: "init" });
    await migrations.apply();
    const init = (await migrations.show({ name: "init" })).stateId;
    const failing = await migrations.generate({
      name: "backfill",
      manualMigration: {
        transitions: [
          {
            from: init,
            execution: "transactional",
            up: [sql.raw(`INSERT INTO "backfill_audit" ("id") VALUES ('x')`)],
            rollback: { kind: "irreversible", reason: "probe" },
          },
        ],
      },
    });
    try {
      await migrations.apply();
      return {
        status: "fail",
        evidence: "apply succeeded; expected a failure",
      };
    } catch {
      // The failure is the setup; status() must now report it.
    }
    const status = await migrations.status();
    const keys = Object.keys(status).sort().join(",");
    const lastFailure = status.lastFailure;
    if (lastFailure === undefined || lastFailure === null) {
      return {
        status: "fail",
        evidence: `status() keys [${keys}]; no lastFailure after a failed apply`,
      };
    }
    const names = JSON.stringify(lastFailure).includes(failing.stateId);
    return {
      status: names ? "pass" : "fail",
      evidence: names
        ? `lastFailure names ${failing.stateId.slice(0, 12)}: ${JSON.stringify(lastFailure).slice(0, 160)}`
        : `lastFailure does not name the failed state: ${JSON.stringify(lastFailure).slice(0, 200)}`,
    };
  } finally {
    await client.$disconnect();
    db.close();
  }
}
