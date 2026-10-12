// S3 step 4: a failed apply leaves a durable `failed` ledger event (written
// in its own transaction after the rollback, the control tables existing).
// 1.1.0 defines the kind but never writes it: the attempt's `started` event
// rolls back with the group, so the failure leaves no trace at all.
import Database from "better-sqlite3";
import { s, sql } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "S3-failed-event",
  title: "A failed transactional apply writes a `failed` ledger event",
  plan: "phase-1/lane-O/S3",
  needs: [],
  source:
    "completion-plan-2026-10/code-check-probes/migrations-sqlite/probes/recovery-probe.mjs (case A); src/migrations/v1-types.ts:201; control.ts:802",
};

const invoice = s.model({
  id: s.string().id(),
  number: s.string().unique(),
  customerEmail: s.string(),
  status: s.enum(["draft", "sent", "paid", "void"]).default("draft"),
  amountCents: s.int(),
  balanceCents: s.int(),
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
            up: [
              sql.raw(`UPDATE "invoice" SET "notes" = 'migrated'`),
              sql.raw(`INSERT INTO "backfill_audit" ("id") VALUES ('x')`),
            ],
            rollback: { kind: "irreversible", reason: "probe" },
          },
        ],
      },
    });
    let failure = "none";
    try {
      await migrations.apply();
    } catch (error) {
      failure = `${error.code}`;
    }
    if (failure === "none") {
      return {
        status: "fail",
        evidence: "apply succeeded; expected a failure",
      };
    }
    const log = await migrations.log();
    const failed = log.find(
      (event) => event.kind === "failed" && event.toState === failing.stateId
    );
    const kinds = log.map((event) => event.kind).join(",");
    if (failed === undefined) {
      return {
        status: "fail",
        evidence: `apply threw ${failure}; ledger kinds after the failure: [${kinds}] (no failed event)`,
      };
    }
    const recorded =
      typeof failed.failure === "string" && failed.failure !== "";
    return {
      status: recorded ? "pass" : "fail",
      evidence: recorded
        ? `failed event for ${failing.stateId.slice(0, 12)} with failure "${failed.failure.slice(0, 80)}"`
        : `failed event written without a failure text: ${JSON.stringify(failed.failure)}`,
    };
  } finally {
    await client.$disconnect();
    db.close();
  }
}
