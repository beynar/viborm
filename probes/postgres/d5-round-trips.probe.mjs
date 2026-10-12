// D5: fewer round trips. Target (plan "Done when"): a no-op apply sends at most
// 3 statements and still proves there is no drift (decision 7: one
// catalog-digest query); between the first DDL and COMMIT only the DDL plus at
// most 3 control statements are sent. 1.1.0 baseline: no-op 29 (28 + the enum preflight), status 16,
// 20 statements from the first DDL through COMMIT for a two-operation change.
// Counted on PGlite (one session, same statement order as pg/postgres.js) over
// a 15-field table holding 10,000 rows.
import { PGlite } from "@electric-sql/pglite";
import { s } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient } from "viborm/pglite";

export const meta = {
  id: "d5-round-trips",
  title:
    "No-op apply in <= 3 statements with its drift proof; only DDL + <= 3 control statements inside the DDL window",
  plan: "phase-2/D5",
  needs: [],
  source:
    "completion-plan-2026-10/code-check-probes/postgres-transports/scripts/probe-d5.mjs (+ probe-d5.out); code-check/postgres-transports.md#D5; pg-migrations-from-durable-objects-2026-10-10/lanes/faults.md PGF-09; src/migrations/execute-dispatch.ts:142-179; src/migrations/apply-v1.ts:138-145, 341-388",
};

const ROWS = 10_000;
const NOOP_MAX = 3;
const WINDOW_CONTROL_MAX = 3;
const COMMIT = /^(COMMIT|END)\b/i;
const DDL =
  /^(ALTER TABLE|CREATE (UNIQUE )?INDEX|CREATE TABLE|DROP (TABLE|INDEX))/i;

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
  account: s
    .model({ ...fields(), nickname: s.string().nullable() })
    .index(["country"])
    .map("accounts"),
};

const decoder = new TextDecoder();

/**
 * Records every statement PGlite runs, whatever API sent it (query, exec or
 * transaction): all of them reach execProtocolStream, where a Parse ('P') or
 * simple Query ('Q') message carries the SQL.
 */
async function record(db, command) {
  const send = db.execProtocolStream;
  const statements = [];
  db.execProtocolStream = (message, options) => {
    if (message[0] === 0x50 || message[0] === 0x51) {
      const start = message[0] === 0x50 ? message.indexOf(0, 5) + 1 : 5;
      const sql = decoder.decode(
        message.subarray(start, message.indexOf(0, start))
      );
      statements.push(sql.replace(/\s+/g, " ").trim());
    }
    return send.call(db, message, options);
  };
  try {
    const result = await command();
    return { result, statements };
  } finally {
    db.execProtocolStream = send;
  }
}

export default async function probe() {
  const db = new PGlite();
  try {
    const storage = new MemoryEstateStorage();
    const first = createMigrationClient(
      createClient({ client: db, schema: v1 }),
      { storage }
    );
    await first.generate({ name: "v1" });
    await first.apply();
    await db.query(
      `INSERT INTO "accounts" ("id", "email", "name", "settings", "age", "updatedAt")
       SELECT 'acct-' || g, 'user' || g || '@example.com', 'name-' || g, jsonb_build_object('plan', 'pro', 'seats', g % 50), g % 90, now()
       FROM generate_series(1, ${ROWS}) g`
    );
    await db.query(
      `UPDATE "accounts" SET "status" = 'active' WHERE "age" % 3 = 0`
    );
    const second = createMigrationClient(
      createClient({ client: db, schema: v2 }),
      { storage }
    );
    await second.generate({ name: "v2" });

    const change = await record(db, () => second.apply());
    const firstDdl = change.statements.findIndex((q) => DDL.test(q));
    const commit = change.statements.findLastIndex((q) => COMMIT.test(q));
    const window = change.statements.slice(firstDdl, commit);
    const ddl = window.filter((q) => DDL.test(q)).length;
    const control = window.length - ddl;

    const noop = await record(db, () => second.apply());
    const status = await record(db, () => second.status());

    // The no-op must still prove "no drift": add a column behind its back.
    await db.query(`ALTER TABLE "accounts" ADD COLUMN "drift_probe" integer`);
    let driftRefused;
    try {
      const r = await second.apply();
      driftRefused = `not refused (${r.outcome})`;
    } catch (error) {
      driftRefused = `refused ${error?.code}`;
    }

    const problems = [];
    if (change.result.outcome !== "applied" || firstDdl < 0)
      problems.push(
        `change outcome ${change.result.outcome}, first DDL #${firstDdl + 1}`
      );
    if (control > WINDOW_CONTROL_MAX)
      problems.push(
        `${control} control statements between the first DDL and COMMIT (max ${WINDOW_CONTROL_MAX})`
      );
    if (noop.result.outcome !== "noop")
      problems.push(`no-op outcome ${noop.result.outcome}`);
    if (noop.statements.length > NOOP_MAX)
      problems.push(
        `no-op apply sent ${noop.statements.length} statements (max ${NOOP_MAX})`
      );
    if (!driftRefused.startsWith("refused"))
      problems.push(`no-op over a drifted schema ${driftRefused}`);
    const evidence = `change: ${change.statements.length} statements, window ${window.length + 1} through COMMIT = ${ddl} DDL + ${control} control + COMMIT; no-op: ${noop.statements.length}; status: ${status.statements.length}; drifted no-op: ${driftRefused}`;
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
