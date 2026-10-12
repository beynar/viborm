// types-08 (tenant blocker): Postgres DDL follows the scalar's own generator
// rule (src/schema/scalars/string/scalar.ts:325-327). A non-key `.uuid()`
// (a format: the caller supplies it) and `.id({ generate: false }).uuid()`
// get NO column default; 1.1.0 gives both `gen_random_uuid()`, so a raw
// insert that omits them invents a UUID the typed client would refuse.
// Positive control: the generated key `.id().uuid()` and a non-key
// `.uuid({ generate: true })` keep their gen_random_uuid() default.
// Generated and applied through the migration history on PGlite.
import { PGlite } from "@electric-sql/pglite";
import { s } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient } from "viborm/pglite";

export const meta = {
  id: "types-08-uuid-default",
  title:
    "Postgres DDL gives no gen_random_uuid() default to a non-generated uuid",
  plan: "phase-1/lane-O/tenant-blockers (types-08)",
  needs: [],
  source:
    "adversarial-review-2026-10-09 types-08 (p06b-pg-uuid-default.ts); completion-plan-2026-10/code-check/track-a.md (types-08); src/migrations/drivers/base.ts:687-688; postgres/index.ts:745-757",
};

const account = s.model({
  id: s.string().id().uuid(),
  email: s.string().unique(),
  externalRef: s.string().uuid(),
  partnerRef: s.string().uuid().nullable(),
  trackingId: s.string().uuid({ generate: true }),
  status: s.enum(["active", "suspended", "closed"]).default("active"),
  balanceCents: s.int().default(0),
  settings: s.json().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});
const importedOrder = s.model({
  id: s.string().id({ generate: false }).uuid(),
  number: s.string().unique(),
  totalCents: s.int(),
  payload: s.json().nullable(),
  importedAt: s.dateTime().now(),
});

const GENERATED = /gen_random_uuid/;

export default async function probe() {
  const pg = new PGlite();
  const client = createClient({
    client: pg,
    schema: { account, importedOrder },
  });
  try {
    const migrations = createMigrationClient(client, {
      storage: new MemoryEstateStorage(),
    });
    await migrations.generate({ name: "init" });
    await migrations.apply();
    const { rows } = await pg.query(
      `SELECT table_name, column_name, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name IN ('id','externalRef','partnerRef','trackingId')
       ORDER BY table_name, column_name`
    );
    const defaults = Object.fromEntries(
      rows.map((row) => [
        `${row.table_name}.${row.column_name}`,
        row.column_default,
      ])
    );
    const wrong = [
      "account.externalRef",
      "account.partnerRef",
      "importedOrder.id",
    ].filter((column) => defaults[column] !== null);
    const lost = ["account.id", "account.trackingId"].filter(
      (column) => !GENERATED.test(defaults[column] ?? "")
    );
    const shown = Object.entries(defaults)
      .map(([column, value]) => `${column}=${value ?? "none"}`)
      .join(", ");
    return {
      status: wrong.length === 0 && lost.length === 0 ? "pass" : "fail",
      evidence: `caller-supplied uuids with a database default: [${wrong.join(", ")}]; generated uuids without one: [${lost.join(", ")}] (${shown})`,
    };
  } finally {
    await client.$disconnect();
    await pg.close();
  }
}
