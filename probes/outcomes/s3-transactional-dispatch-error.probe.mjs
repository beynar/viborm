// S3 step 2: a failed statement inside a transactional migration group
// surfaces as a MigrationError carrying the failing statementIndex and the
// provider code, not as the raw QueryError V2004 1.1.0 throws. The index
// names the failing INSERT (the transition's second statement: 1 if 0-based,
// 2 if 1-based) and the meta names the failing state (stateId or toState).
import Database from "better-sqlite3";
import { s, sql } from "viborm";
import {
  createMigrationClient,
  isMigrationError,
  MemoryEstateStorage,
} from "viborm/migrations";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "S3-transactional-dispatch-error",
  title:
    "A transactional dispatch failure is a MigrationError with statementIndex and provider code",
  plan: "phase-1/lane-O/S3",
  needs: [],
  source:
    "completion-plan-2026-10/code-check-probes/migrations-sqlite/probes/recovery-probe.mjs (case A); src/migrations/execute-dispatch.ts:210-214",
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
      })),
    });
    const init = (await migrations.show({ name: "init" })).stateId;
    const lateFee = await migrations.generate({
      name: "late-fee",
      manualMigration: {
        transitions: [
          {
            from: init,
            execution: "transactional",
            up: [
              sql.raw(
                `UPDATE "invoice" SET "balanceCents" = "balanceCents" + 500`
              ),
              sql.raw(`INSERT INTO "fee_audit" ("id") VALUES ('late-fee')`),
            ],
            rollback: { kind: "irreversible", reason: "probe" },
          },
        ],
      },
    });
    let error;
    try {
      await migrations.apply();
    } catch (caught) {
      error = caught;
    }
    const total = db
      .prepare(`SELECT sum("balanceCents") AS total FROM "invoice"`)
      .get().total;
    if (error === undefined) {
      return {
        status: "fail",
        evidence: "apply succeeded; expected a failure",
      };
    }
    const observed = `${error.name} ${error.code} meta=${JSON.stringify(error.meta)}`;
    if (total !== ROWS * 1000) {
      return {
        status: "fail",
        evidence: `group did not roll back: balance total ${total}; ${observed}`,
      };
    }
    const m = error.meta ?? {};
    const wrapped =
      isMigrationError(error) &&
      (m.statementIndex === 1 || m.statementIndex === 2) &&
      typeof m.providerCode === "string" &&
      (m.stateId ?? m.toState) === lateFee.stateId;
    return {
      status: wrapped ? "pass" : "fail",
      evidence: wrapped
        ? `MigrationError ${error.code} statementIndex=${m.statementIndex} providerCode=${m.providerCode} state=${lateFee.stateId.slice(0, 12)}`
        : `transactional failure surfaced as ${observed}`,
    };
  } finally {
    await client.$disconnect();
    db.close();
  }
}
