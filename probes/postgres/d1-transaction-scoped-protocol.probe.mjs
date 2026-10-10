// D1: a transactional migration runs as one transaction-scoped protocol:
// BEGIN; (SET LOCAL limits;) a bounded pg_try_advisory_xact_lock; the marker /
// ledger / drift reads; effects; compare-and-swap + ledger; COMMIT. No session
// advisory lock and no pg_advisory_unlock, so nothing can outlive the
// transaction behind a transaction pooler. Checked on `apply` and `push`.
// (The pooler run itself is d1-transaction-pooler, which needs a real server.)
import { PGlite } from "@electric-sql/pglite";
import { s } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient } from "viborm/pglite";

export const meta = {
  id: "d1-transaction-scoped-protocol",
  title:
    "Transactional apply/push take pg_try_advisory_xact_lock and read the marker inside the transaction; no session lock",
  plan: "phase-2/D1",
  needs: [],
  source:
    "code-check-probes/postgres-transports/probe-d5.out (statement order on 1.1.0); code-check/postgres-transports.md#D1; pg-migrations-from-durable-objects-2026-10-10/lanes/pooling.md PL-01/02 + E12; src/migrations/pinned-session.ts:315-347; src/migrations/drivers/postgres/index.ts:1297-1310",
};

const SESSION_LOCK =
  /pg_try_advisory_lock\(|pg_advisory_lock\(|pg_advisory_unlock/i;
const BEGIN = /^(BEGIN|START TRANSACTION)\b/i;
const COMMIT = /^(COMMIT|END)\b/i;
const XACT_LOCK = /pg_(try_)?advisory_xact_lock\(/i;
// The deciding marker read is the last statement before the first DDL that
// reads the state table without writing it, however it is spelled (D5 may fold
// it into one WITH query, or keep an earlier read outside the transaction).
const STATE_TABLE = /_viborm_migration_state/i;
const STATE_WRITE =
  /^(CREATE|ALTER|DROP)\b|\b(UPDATE|INSERT INTO|DELETE FROM)\s+[^\s(]*_viborm_migration_state/i;
const isMarkerRead = (q) => STATE_TABLE.test(q) && !STATE_WRITE.test(q);
const DDL = /^(ALTER TABLE|CREATE (UNIQUE )?INDEX|CREATE TABLE)/i;

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
    await command();
  } finally {
    db.execProtocolStream = send;
  }
  return statements;
}

function judge(label, statements, readsMarker) {
  const at = (pattern) => statements.findIndex((q) => pattern.test(q));
  const begin = at(BEGIN);
  const commit = statements.findLastIndex((q) => COMMIT.test(q));
  const sessionLock = at(SESSION_LOCK);
  const xactLock = at(XACT_LOCK);
  const ddl = at(DDL);
  const marker = statements
    .slice(0, ddl < 0 ? undefined : ddl)
    .findLastIndex(isMarkerRead);
  const n = (i) => (i < 0 ? "-" : `#${i + 1}`);
  const where = `BEGIN ${n(begin)}, xact lock ${n(xactLock)}, session lock ${n(sessionLock)}, marker read ${n(marker)}, first DDL ${n(ddl)}, COMMIT ${n(commit)} of ${statements.length}`;
  const problems = [];
  if (sessionLock >= 0)
    problems.push(
      `session lock statement ${n(sessionLock)}: ${statements[sessionLock].slice(0, 60)}`
    );
  if (xactLock < 0) problems.push("no pg_try_advisory_xact_lock");
  else if (!(begin >= 0 && begin < xactLock && xactLock < ddl))
    problems.push("xact lock not inside the transaction before the effects");
  // push keeps no marker; its decision reads are its plan, made before.
  if (readsMarker && !(xactLock >= 0 && marker >= xactLock && begin < marker))
    problems.push("marker read is not inside the transaction after the lock");
  if (ddl < 0 || commit < ddl) problems.push("no committed DDL");
  return {
    ok: problems.length === 0,
    line: `${label}: ${problems.length ? `${problems.join("; ")} (${where})` : `ok (${where})`}`,
  };
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
    const second = createMigrationClient(
      createClient({ client: db, schema: v2 }),
      { storage }
    );
    await second.generate({ name: "v2" });
    const apply = judge("apply", await record(db, () => second.apply()), true);

    await db.query('CREATE SCHEMA "push_estate"');
    const push = createMigrationClient(
      createClient({ client: db, schema: v1, namespace: "push_estate" })
    );
    const pushed = judge("push", await record(db, () => push.push()), false);

    return {
      status: apply.ok && pushed.ok ? "pass" : "fail",
      evidence: `${apply.line} | ${pushed.line}`,
    };
  } finally {
    await db.close();
  }
}
