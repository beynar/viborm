// S7 + new defect 4: an interrupted `CREATE INDEX CONCURRENTLY` leaves an
// INVALID index behind. Target: status() and log() keep working and status()
// names the invalid index; apply()/verify() refuse with a dedicated code that
// names it (not the generic V8001 "physical semantics" refusal); and resolve
// recovers the attempt by dropping exactly that index.
//
// The interruption is real, not a catalog edit: a stepwise manual transition
// builds a UNIQUE index CONCURRENTLY (then attaches it as a constraint, the
// usual low-lock recipe) over rows that hold duplicates, so the build fails
// and PostgreSQL leaves the index with indisvalid = false.
import { PGlite } from "@electric-sql/pglite";
import { s } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient } from "viborm/pglite";
import { sql } from "viborm/sql";

export const meta = {
  id: "s7-interrupted-concurrent-index",
  title:
    "An invalid index from an interrupted CONCURRENTLY build no longer breaks status/log/apply/verify/resolve, and resolve drops it",
  plan: "phase-1/P/S7",
  needs: [],
  source:
    "completion-plan-2026-10/code-check-probes/postgres-transports/scripts/probe-s7.mjs (+ probe-s7.out); code-check/postgres-transports.md#S7; pg-migrations-from-durable-objects-2026-10-10/lanes/faults.md PGF-04; src/migrations/drivers/postgres/introspect.ts:186-208, 826-840; src/migrations/control.ts:173-185",
};

const INDEX = "accounts_country_name_key";
const ROWS = 10_000;

const fields = () => ({
  id: s.string().id(),
  email: s.string().unique(),
  name: s.string(),
  status: s.enum(["trial", "active", "churned"]).default("trial"),
  balance: s.int().default(0),
  score: s.number().nullable(),
  settings: s.json().nullable(),
  country: s.string().default("FR"),
  age: s.int().nullable(),
  verified: s.boolean().default(false),
  notes: s.string().nullable(),
  lastSeenAt: s.dateTime().nullable(),
  deletedAt: s.dateTime().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});
const v1 = { account: s.model(fields()).map("accounts") };
const v2 = {
  account: s.model(fields()).unique(["country", "name"]).map("accounts"),
};

const check = (text) => ({
  kind: "trusted-read",
  query: sql.raw(text),
  equals: true,
});

async function outcome(run) {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return {
      ok: false,
      code: error?.code ?? error?.name,
      message: String(error?.message ?? error),
    };
  }
}
const brief = (r) =>
  r.ok
    ? `ok ${JSON.stringify(r.value).slice(0, 80)}`
    : `${r.code} ${r.message.slice(0, 90)}`;

export default async function probe() {
  const db = new PGlite();
  try {
    const storage = new MemoryEstateStorage();
    const first = createMigrationClient(
      createClient({ client: db, schema: v1 }),
      { storage }
    );
    const origin = await first.generate({ name: "v1" });
    await first.apply();
    // Every name appears twice, so the unique build over (country, name) fails.
    await db.query(
      `INSERT INTO "accounts" ("id", "email", "name", "settings", "updatedAt")
       SELECT 'acct-' || g, 'user' || g || '@example.com', 'name-' || (g % ${ROWS / 2}), '{"plan":"pro"}'::jsonb, now()
       FROM generate_series(1, ${ROWS}) g`
    );
    const second = createMigrationClient(
      createClient({ client: db, schema: v2 }),
      { storage }
    );
    await second.generate({
      name: "v2",
      manualMigration: {
        transitions: [
          {
            from: origin.stateId,
            execution: "stepwise",
            originChecks: [
              check(
                `SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relname = '${INDEX}') AS ok`
              ),
            ],
            up: [
              sql.raw(
                `CREATE UNIQUE INDEX CONCURRENTLY "${INDEX}" ON "public"."accounts" ("country", "name")`
              ),
              sql.raw(
                `ALTER TABLE "public"."accounts" ADD CONSTRAINT "${INDEX}" UNIQUE USING INDEX "${INDEX}"`
              ),
            ],
            rollback: {
              kind: "manual",
              execution: "stepwise",
              sql: [
                sql.raw(
                  `ALTER TABLE "public"."accounts" DROP CONSTRAINT "${INDEX}"`
                ),
              ],
            },
          },
        ],
        destinationChecks: [
          check(
            `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = '${INDEX}') AS ok`
          ),
        ],
      },
    });
    const interrupted = await outcome(() => second.apply());
    const invalid = await db.query(
      "SELECT c.relname FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid WHERE NOT i.indisvalid"
    );
    if (invalid.rows.length !== 1) {
      throw new Error(
        `setup: expected one invalid index after the failed build, found ${JSON.stringify(invalid.rows)} (apply: ${brief(interrupted)})`
      );
    }

    const status = await outcome(() => second.status());
    const log = await outcome(() => second.log());
    const apply = await outcome(() => second.apply());
    const verify = await outcome(() => second.verify());
    const resolve = await outcome(() =>
      second.resolve({ outcome: "rolled-back" })
    );
    const left = await db.query(
      "SELECT count(*)::int AS n FROM pg_catalog.pg_index WHERE NOT indisvalid"
    );
    const after = await outcome(() => second.status());

    const problems = [];
    if (!status.ok) problems.push(`status() threw ${status.code}`);
    else if (!JSON.stringify(status.value).includes(INDEX))
      problems.push("status() does not name the invalid index");
    if (!log.ok) problems.push(`log() threw ${log.code}`);
    // An unfinished attempt may still refuse apply/verify, but not as the
    // generic "physical semantics" refusal.
    for (const [label, r] of [
      ["apply()", apply],
      ["verify()", verify],
    ]) {
      if (!r.ok && r.code === "V8001")
        problems.push(`${label} threw ${r.code}`);
    }
    if (!resolve.ok)
      problems.push(
        `resolve({ outcome: 'rolled-back' }) threw ${resolve.code}`
      );
    if (left.rows[0].n !== 0)
      problems.push(`${left.rows[0].n} invalid index left after resolve`);
    if (!after.ok || after.value.unfinished) {
      problems.push(
        `status() after resolve: ${after.ok ? "still unfinished" : `threw ${after.code}`}`
      );
    }

    const evidence = `interrupted apply: ${brief(interrupted)}; status: ${brief(status)}; resolve(rolled-back): ${brief(resolve)}; invalid indexes left: ${left.rows[0].n}`;
    return {
      status: problems.length === 0 ? "pass" : "fail",
      evidence:
        problems.length === 0
          ? evidence
          : `${problems.join("; ")} | ${evidence}`,
    };
  } finally {
    await db.close();
  }
}
