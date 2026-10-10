// T5a: a change that rewrites or scans a big table is refused in-request, before
// any effect, with the operation named. Here: `age` int -> bigint (ALTER COLUMN
// ... TYPE, a full-table rewrite under ACCESS EXCLUSIVE) on a table the planner
// estimates at 20 million rows. 1.1.0 applies it.
//
// The table holds 10,000 real rows; its planner statistics are then set to
// 20M rows (pg_class.reltuples, which both reltuples readers and EXPLAIN
// estimates reflect) so the probe stays fast.
import { PGlite } from "@electric-sql/pglite";
import { s } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient } from "viborm/pglite";

export const meta = {
  id: "t5a-large-rewrite-refused",
  title:
    "A column type change on a 20M-row (estimated) table is refused in-request, naming the operation",
  plan: "phase-3/T5a",
  needs: [],
  source:
    "completion-plan-2026-10.md Phase 3 T5a ('Done when'); code-check/postgres-transports.md#T5; pg-migrations-from-durable-objects-2026-10-10/lanes/faults.md PGF-10; src/migrations/drivers/postgres/index.ts:1100-1127 (ALTER COLUMN TYPE)",
};

const ROWS = 10_000;
const ESTIMATED_ROWS = 20_000_000;
const DDL = /^(ALTER TABLE|CREATE (UNIQUE )?INDEX|DROP |LOCK TABLE)/i;
const ESTIMATE = /rows=(\d+)/;

const fields = (age) => ({
  id: s.string().id(),
  email: s.string().unique(),
  name: s.string(),
  status: s.enum(["trial", "active", "churned"]).default("trial"),
  balance: s.int().default(0),
  score: s.number().nullable(),
  settings: s.json().nullable(),
  country: s.string().default("FR"),
  age,
  verified: s.boolean().default(false),
  notes: s.string().nullable(),
  lastSeenAt: s.dateTime().nullable(),
  deletedAt: s.dateTime().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});
const v1 = { account: s.model(fields(s.int().nullable())).map("accounts") };
const v2 = { account: s.model(fields(s.bigInt().nullable())).map("accounts") };

const decoder = new TextDecoder();

/**
 * Runs `command` and records every statement PGlite runs meanwhile, whatever
 * API sent it (query, exec or transaction): all of them reach
 * execProtocolStream, where a Parse ('P') or simple Query ('Q') message
 * carries the SQL.
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
    return { statements, result: await command() };
  } catch (error) {
    return { statements, error };
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
       SELECT 'acct-' || g, 'user' || g || '@example.com', 'name-' || g, jsonb_build_object('plan', 'pro'), g % 90, now()
       FROM generate_series(1, ${ROWS}) g`
    );
    await db.query(`ANALYZE "accounts"`);
    await db.query(
      `UPDATE pg_catalog.pg_class SET reltuples = ${ESTIMATED_ROWS} WHERE oid = '"public"."accounts"'::regclass`
    );
    const plan = await db.query(`EXPLAIN SELECT * FROM "accounts"`);
    const estimate = ESTIMATE.exec(Object.values(plan.rows[0])[0])?.[1];

    const second = createMigrationClient(
      createClient({ client: db, schema: v2 }),
      { storage }
    );
    await second.generate({ name: "v2" });
    const run = await record(db, () => second.apply());
    const sent = run.statements.filter((q) => DDL.test(q));
    const result = run.error
      ? {
          refused: true,
          message: String(run.error?.message),
          line: `refused ${run.error?.code}: ${String(run.error?.message).slice(0, 160)}`,
        }
      : {
          refused: false,
          line: `applied (${run.result.outcome}): ${run.result.statements?.join("; ").slice(0, 120)}`,
        };
    const type = await db.query(
      `SELECT data_type FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'age'`
    );

    const problems = [];
    if (!result.refused) problems.push("not refused");
    else if (
      !(result.message.includes("accounts") && result.message.includes("age"))
    )
      problems.push("the refusal does not name the table and column");
    if (sent.length > 0) problems.push(`DDL sent: ${sent[0].slice(0, 80)}`);
    if (type.rows[0]?.data_type !== "integer")
      problems.push(`age is now ${type.rows[0]?.data_type}`);
    const evidence = `planner estimate ${estimate} rows; ${result.line}; age column: ${type.rows[0]?.data_type}`;
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
