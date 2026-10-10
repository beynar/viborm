// T5b: on a big table, generated changes that need their own commit run as
// recoverable steps instead of one long ACCESS EXCLUSIVE transaction:
//   - a new index is built with CREATE INDEX CONCURRENTLY, outside any
//     transaction, and ends valid;
//   - a new foreign key is added NOT VALID and validated by a separate
//     VALIDATE CONSTRAINT in its own commit (or, per T5a, refused in-request
//     with the constraint named).
// 1.1.0 generates plain CREATE INDEX and a validating ADD CONSTRAINT inside
// one transaction. The accounts table holds 10,000 rows with planner
// statistics set to 20 million (pg_class.reltuples).
import { PGlite } from "@electric-sql/pglite";
import { s } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient } from "viborm/pglite";

export const meta = {
  id: "t5b-recoverable-steps",
  title:
    "Big-table index builds run CONCURRENTLY outside a transaction; foreign keys go NOT VALID then VALIDATE in a separate commit",
  plan: "phase-4/T5b",
  needs: [],
  source:
    "completion-plan-2026-10.md Phase 4 T5b; code-check/postgres-transports.md#T5; pg-migrations-from-durable-objects-2026-10-10/lanes/faults.md PGF-06/PGF-10; src/migrations/drivers/postgres/index.ts:1170-1185, 1197-1216; src/migrations/compile.ts:53-82",
};

const ROWS = 10_000;
const ESTIMATED_ROWS = 20_000_000;
const CREATE_INDEX = /^CREATE (UNIQUE )?INDEX/i;
const CONCURRENTLY = /CONCURRENTLY/i;
const ADD_CONSTRAINT = /ADD CONSTRAINT/i;
const VALIDATE = /VALIDATE CONSTRAINT/i;
const NOT_VALID = /NOT VALID/i;
const FK_NAME = "accounts_orgId_fkey";

/** stage 1: plain table; 2: + index on country; 3: + relation to orgs (FK + its index). */
function schemaAt(stage) {
  const org = s
    .model({
      id: s.string().id(),
      name: s.string(),
      ...(stage >= 3 ? { accounts: s.toMany(() => account) } : {}),
    })
    .map("orgs");
  const base = s.model({
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
    orgId: s.string().nullable(),
    deletedAt: s.dateTime().nullable(),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
    ...(stage >= 3
      ? {
          org: s
            .toOne(() => org)
            .fields("orgId")
            .references("id"),
        }
      : {}),
  });
  const account = (stage >= 2 ? base.index(["country"]) : base).map("accounts");
  return { org, account };
}

const BEGIN = /^(BEGIN|START TRANSACTION)\b/i;
const END = /^(COMMIT|END|ROLLBACK)\b/i;
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

/** Index of the transaction each statement runs in (null in autocommit). */
function transactionOf(statements) {
  let current = null;
  let count = 0;
  return statements.map((q) => {
    if (BEGIN.test(q)) current = ++count;
    const tx = current;
    if (END.test(q)) current = null;
    return tx;
  });
}

async function applyRecorded(db, migrations, to) {
  const { statements, result, error } = await record(db, () =>
    migrations.apply({ to: { id: to } })
  );
  return error
    ? {
        ok: false,
        code: error?.code,
        message: String(error?.message),
        statements,
      }
    : { ok: true, outcome: result.outcome, statements };
}

function judgeIndexes(run) {
  const tx = transactionOf(run.statements);
  return run.statements
    .map((q, i) => ({ q, tx: tx[i] }))
    .filter(({ q }) => CREATE_INDEX.test(q))
    .filter(({ q, tx: inTx }) => !CONCURRENTLY.test(q) || inTx !== null)
    .map(
      ({ q, tx: inTx }) =>
        `${q.slice(0, 60)}${inTx === null ? "" : " (inside BEGIN)"}`
    );
}

function judgeForeignKey(run) {
  if (!run.ok) {
    return run.message.includes(FK_NAME) || run.message.includes("orgId")
      ? { ok: true, line: `refused in-request ${run.code}` }
      : { ok: false, line: `failed ${run.code}: ${run.message.slice(0, 80)}` };
  }
  const tx = transactionOf(run.statements);
  const add = run.statements.findIndex(
    (q) => q.includes(FK_NAME) && ADD_CONSTRAINT.test(q)
  );
  const validate = run.statements.findIndex((q) => VALIDATE.test(q));
  const notValid = add >= 0 && NOT_VALID.test(run.statements[add]);
  const separate =
    validate > add && (tx[validate] === null || tx[validate] !== tx[add]);
  return {
    ok: notValid && separate,
    line: `ADD CONSTRAINT ${notValid ? "NOT VALID" : "validating"}${validate < 0 ? ", no VALIDATE" : separate ? ", VALIDATE in its own commit" : ", VALIDATE in the same transaction"}`,
  };
}

export default async function probe() {
  const db = new PGlite();
  try {
    const storage = new MemoryEstateStorage();
    const clients = [1, 2, 3].map((stage) =>
      createMigrationClient(
        createClient({ client: db, schema: schemaAt(stage) }),
        { storage }
      )
    );
    const states = [];
    for (const [i, client] of clients.entries())
      states.push((await client.generate({ name: `v${i + 1}` })).stateId);
    await clients[0].apply({ to: { id: states[0] } });
    await db.query(
      `INSERT INTO "orgs" ("id", "name") SELECT 'org-' || g, 'Org ' || g FROM generate_series(1, 50) g`
    );
    await db.query(
      `INSERT INTO "accounts" ("id", "email", "name", "settings", "orgId", "updatedAt")
       SELECT 'acct-' || g, 'user' || g || '@example.com', 'name-' || g, jsonb_build_object('plan', 'pro'), 'org-' || (1 + g % 50), now()
       FROM generate_series(1, ${ROWS}) g`
    );
    await db.query(`ANALYZE "accounts"`);
    await db.query(
      `UPDATE pg_catalog.pg_class SET reltuples = ${ESTIMATED_ROWS} WHERE oid = '"public"."accounts"'::regclass`
    );

    const indexRun = await applyRecorded(db, clients[1], states[1]);
    const fkRun = await applyRecorded(db, clients[2], states[2]);
    const invalid = await db.query(
      "SELECT count(*)::int AS n FROM pg_catalog.pg_index WHERE NOT indisvalid"
    );

    const problems = [];
    if (!indexRun.ok) problems.push(`index change failed ${indexRun.code}`);
    const blocking = [...judgeIndexes(indexRun), ...judgeIndexes(fkRun)];
    if (blocking.length > 0)
      problems.push(`blocking index builds: ${blocking.join("; ")}`);
    const fk = judgeForeignKey(fkRun);
    if (!fk.ok) problems.push(`foreign key: ${fk.line}`);
    if (invalid.rows[0].n > 0)
      problems.push(`${invalid.rows[0].n} invalid index(es) left`);
    const evidence = `index change: ${indexRun.ok ? indexRun.outcome : indexRun.code}; foreign key change: ${fk.line}`;
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
