// S3 step 1 (new defect 1): a migration error keeps the metadata the
// migration code attaches. A failed opaque stepwise dispatch raises V11020
// with lastConfirmedStep / effectState / partial; 1.1.0's error-metadata
// allow-list strips them and the error arrives with `meta: {}`.
import Database from "better-sqlite3";
import { s, sql } from "viborm";
import {
  createMigrationClient,
  isMigrationError,
  MemoryEstateStorage,
} from "viborm/migrations";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "S3-error-meta",
  title: "A V11020 keeps lastConfirmedStep, effectState and partial in meta",
  plan: "phase-1/lane-O/S3",
  needs: [],
  source:
    "completion-plan-2026-10/code-check-probes/migrations-sqlite/probes/recovery-probe.mjs; src/migrations/execute-dispatch.ts:182-200; src/errors/diagnostics.ts:120-186",
};

const ROWS = 500;

const invoice = s.model({
  id: s.string().id(),
  number: s.string().unique(),
  customerEmail: s.string(),
  status: s.enum(["draft", "sent", "paid", "void"]).default("draft"),
  currency: s.string().default("EUR"),
  amountCents: s.int(),
  taxCents: s.int().default(0),
  balanceCents: s.int(),
  notes: s.string().nullable(),
  metadata: s.json().nullable(),
  dueAt: s.dateTime().nullable(),
  paidAt: s.dateTime().nullable(),
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
    await client.invoice.createMany({
      data: Array.from({ length: ROWS }, (_, i) => ({
        id: `inv-${i}`,
        number: `N-${i}`,
        customerEmail: `c${i}@example.test`,
        amountCents: 1000,
        balanceCents: 1000,
        metadata: { batch: i % 7 },
      })),
    });
    const init = (await migrations.show({ name: "init" })).stateId;
    const populated = {
      kind: "trusted-read",
      query: sql.raw(`SELECT EXISTS (SELECT 1 FROM "invoice") AS ok`),
      equals: true,
    };
    await migrations.generate({
      name: "late-fee",
      manualMigration: {
        transitions: [
          {
            from: init,
            execution: "stepwise",
            originChecks: [populated],
            up: [
              sql.raw(
                `UPDATE "invoice" SET "balanceCents" = "balanceCents" + 500`
              ),
              sql.raw(`INSERT INTO "fee_audit" ("id") VALUES ('late-fee')`),
            ],
            rollback: { kind: "irreversible", reason: "probe" },
          },
        ],
        destinationChecks: [populated],
      },
    });
    let error;
    try {
      await migrations.apply();
    } catch (caught) {
      error = caught;
    }
    if (error === undefined) {
      return { status: "fail", evidence: "apply succeeded; expected V11020" };
    }
    const observed = `${error.name} ${error.code} meta=${JSON.stringify(error.meta)}`;
    if (!isMigrationError(error) || error.code !== "V11020") {
      return {
        status: "fail",
        evidence: `expected MigrationError V11020, got ${observed}`,
      };
    }
    const m = error.meta ?? {};
    const kept =
      typeof m.lastConfirmedStep === "string" &&
      m.effectState === "may-have-committed" &&
      m.partial === true;
    return {
      status: kept ? "pass" : "fail",
      evidence: kept
        ? `V11020 keeps meta keys [${Object.keys(m).sort().join(",")}]`
        : `V11020 lost its migration metadata: ${observed}`,
    };
  } finally {
    await client.$disconnect();
    db.close();
  }
}
