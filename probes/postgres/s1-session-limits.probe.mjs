// S1: the migration session carries its own time limits. Right after BEGIN the
// transaction sets `SET LOCAL lock_timeout` (default 3-5 s) and
// `statement_timeout`; the lock statement runs under a statement_timeout; and
// nothing leaks into the session once the command is done (RESET before the
// connection goes back to the application pool). Checked for `apply` and for
// `push`, which share the same transaction owner. A CREATE INDEX CONCURRENTLY
// dispatch runs with statement_timeout = 0.
//
// PGlite is one physical session, so a `SHOW` issued from the protocol tap,
// just before the first DDL is forwarded, reads the settings that DDL runs
// under.
import { PGlite } from "@electric-sql/pglite";
import { s } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient } from "viborm/pglite";
import { sql } from "viborm/sql";

export const meta = {
  id: "s1-session-limits",
  title:
    "Migration transactions run under SET LOCAL lock_timeout (3-5 s) and statement_timeout, and leave the session clean",
  plan: "phase-1/P/S1",
  needs: [],
  source:
    "completion-plan-2026-10/code-check/postgres-transports.md#S1; pg-migrations-from-durable-objects-2026-10-10/lanes/faults.md PGF-01/02, lanes/pooling.md PL-07; src/migrations/pinned-session.ts:278-295 (runPinnedTransaction), src/migrations/drivers/postgres/index.ts:1297-1306 (lock loop)",
};

const DDL = /^(ALTER TABLE|CREATE (UNIQUE )?INDEX|CREATE TABLE|DROP )/i;
const LOCK = /pg_try_advisory(_xact)?_lock/i;
const CONCURRENTLY = /^CREATE INDEX CONCURRENTLY/i;
const SETTINGS = ["lock_timeout", "statement_timeout"];
const UNIT_MS = {
  us: 0.001,
  ms: 1,
  s: 1000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};
const SHOWN = /^(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?$/;

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
const v3 = {
  account: s
    .model({ ...fields(), nickname: s.string().nullable() })
    .index(["country"])
    .index(["name"])
    .map("accounts"),
};
const indexCheck = (exists) => ({
  kind: "trusted-read",
  query: sql.raw(
    `SELECT ${exists ? "" : "NOT "}EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relname = 'accounts_name_idx') AS ok`
  ),
  equals: true,
});

const toMs = (shown) => {
  const match = SHOWN.exec(String(shown).trim());
  return match ? Number(match[1]) * UNIT_MS[match[2] ?? "ms"] : Number.NaN;
};

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Reads both settings with one simple-Query ('Q') message sent straight to
 * the session through `send` (PGlite's execProtocolStream), so it also works
 * from inside the tap while a transaction is open.
 */
async function show(send, db) {
  const text = encoder.encode(SETTINGS.map((name) => `SHOW ${name}`).join(";"));
  const message = new Uint8Array(text.length + 6);
  message[0] = 0x51;
  new DataView(message.buffer).setInt32(1, text.length + 5);
  message.set(text, 5);
  const replies = await send.call(db, message, {});
  const rows = replies.filter((m) => m.name === "dataRow");
  return Object.fromEntries(
    SETTINGS.map((name, i) => [name, rows[i]?.fields[0]])
  );
}

/**
 * Runs `command` with a tap that reads the settings at the lock statement and
 * the first DDL. Every PGlite API (query, exec, transaction) reaches
 * execProtocolStream, where a Parse ('P') or Query ('Q') message carries the
 * SQL, so the tap sees statements whatever path sends them.
 */
async function observe(db, command) {
  const send = db.execProtocolStream;
  const seen = { lock: null, ddl: null, concurrently: null };
  db.execProtocolStream = async (message, options) => {
    if (message[0] === 0x50 || message[0] === 0x51) {
      const start = message[0] === 0x50 ? message.indexOf(0, 5) + 1 : 5;
      const text = decoder
        .decode(message.subarray(start, message.indexOf(0, start)))
        .trim();
      if (!seen.lock && LOCK.test(text)) seen.lock = await show(send, db);
      if (!seen.ddl && DDL.test(text)) seen.ddl = await show(send, db);
      if (!seen.concurrently && CONCURRENTLY.test(text))
        seen.concurrently = await show(send, db);
    }
    return send.call(db, message, options);
  };
  try {
    await command();
  } finally {
    db.execProtocolStream = send;
  }
  return { ...seen, after: await show(send, db) };
}

function judge(label, seen, baseline) {
  const problems = [];
  const lockTimeout = toMs(seen.ddl?.lock_timeout);
  if (seen.ddl) {
    if (!(lockTimeout >= 3000 && lockTimeout <= 5000)) {
      problems.push(
        `lock_timeout at first DDL=${seen.ddl.lock_timeout} (want 3-5 s)`
      );
    }
    if (!(toMs(seen.ddl.statement_timeout) > 0)) {
      problems.push(
        `statement_timeout at first DDL=${seen.ddl.statement_timeout} (want > 0)`
      );
    }
  } else problems.push("no DDL observed");
  if (!seen.lock) problems.push("no lock statement observed");
  else if (!(toMs(seen.lock.statement_timeout) > 0)) {
    problems.push(
      `statement_timeout at lock statement=${seen.lock.statement_timeout} (want > 0)`
    );
  }
  for (const name of SETTINGS) {
    if (seen.after[name] !== baseline[name]) {
      problems.push(
        `${name} after the command=${seen.after[name]}, session started at ${baseline[name]} (leaked)`
      );
    }
  }
  return {
    ok: problems.length === 0,
    line: `${label}: ${problems.length ? problems.join("; ") : `ok ${JSON.stringify(seen)}`}`,
  };
}

export default async function probe() {
  const db = new PGlite();
  try {
    await db.waitReady;
    const baseline = await show(db.execProtocolStream, db);
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
    const apply = judge(
      "apply",
      await observe(db, () => second.apply()),
      baseline
    );

    // push owns no history, so it gets its own namespace on the same session.
    await db.query('CREATE SCHEMA "push_estate"');
    const push = createMigrationClient(
      createClient({ client: db, schema: v1, namespace: "push_estate" })
    );
    const pushed = judge(
      "push",
      await observe(db, () => push.push()),
      baseline
    );

    const third = createMigrationClient(
      createClient({ client: db, schema: v3 }),
      { storage }
    );
    await third.generate({
      name: "v3",
      manualMigration: {
        transitions: [
          {
            from: (await second.status()).marker.stateId,
            execution: "stepwise",
            originChecks: [indexCheck(false)],
            up: [
              sql.raw(
                'CREATE INDEX CONCURRENTLY "accounts_name_idx" ON "public"."accounts" ("name")'
              ),
            ],
            rollback: {
              kind: "manual",
              execution: "stepwise",
              sql: [
                sql.raw('DROP INDEX CONCURRENTLY "public"."accounts_name_idx"'),
              ],
            },
          },
        ],
        destinationChecks: [indexCheck(true)],
      },
    });
    const build = await observe(db, () => third.apply());
    const buildTimeout = build.concurrently?.statement_timeout;
    const concurrent = {
      ok: buildTimeout !== undefined && toMs(buildTimeout) === 0,
      line: `CONCURRENTLY dispatch: statement_timeout=${buildTimeout ?? "not observed"} (want 0)`,
    };

    const ok = apply.ok && pushed.ok && concurrent.ok;
    return {
      status: ok ? "pass" : "fail",
      evidence: `${apply.line} | ${pushed.line} | ${concurrent.line}`,
    };
  } finally {
    await db.close();
  }
}
