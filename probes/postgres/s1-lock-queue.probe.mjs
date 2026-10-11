// S1 ("Done when": the lock-queue probe shows production reads never wait longer
// than the lock limit). A long transaction holds ACCESS SHARE on `accounts`; a
// migration that needs ACCESS EXCLUSIVE queues behind it, and every ordinary
// read queues behind the migration. With S1's SET LOCAL lock_timeout (3-5 s)
// the migration gives up with a typed, retryable error, the queued reads go
// through, and a retry after the long transaction ends applies. 1.1.0 sets no
// lock_timeout: the migration waits for as long as the long transaction lives
// and production reads stall with it.
import pg from "pg";
import { s } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient } from "viborm/pg";

export const meta = {
  id: "s1-lock-queue",
  title:
    "Production reads queued behind a blocked migration wait no longer than the migration lock limit",
  plan: "phase-1/P/S1",
  needs: ["pg"],
  source:
    "pg-migrations-from-durable-objects-2026-10-10/verify/lock-queue.mjs; lanes/faults.md PGF-01/02; code-check/postgres-transports.md#S1",
};

const ROWS = 10_000;
const HOLD_MS = 12_000;
const LOCK_LIMIT_MS = 5000; // the top of S1's 3-5 s default
const READ_LIMIT_MS = LOCK_LIMIT_MS + 1000; // plus scheduling slack
const GIVE_UP_MS = LOCK_LIMIT_MS + 2000; // plus the ROLLBACK and the typed error

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

const urlFor = (base, name) => {
  const url = new URL(base);
  url.pathname = `/${name}`;
  url.searchParams.set("sslmode", "disable");
  return url.toString();
};
const settle = (promise, ms) =>
  Promise.race([
    promise.then(
      (value) => ({ ok: true, text: `ok ${value?.outcome}`, at: Date.now() }),
      (error) => ({
        ok: false,
        code: error?.code ?? error?.name,
        text: `${error?.code ?? error?.name}`,
        at: Date.now(),
      })
    ),
    new Promise((resolve) =>
      setTimeout(
        () =>
          resolve({
            ok: false,
            text: `pending after ${ms} ms`,
            at: Date.now(),
          }),
        ms
      ).unref()
    ),
  ]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function probe(ctx) {
  const admin = new pg.Client({
    connectionString: ctx.pgUrl,
    connectionTimeoutMillis: 5000,
    statement_timeout: 20_000,
  });
  await admin.connect();
  const name = `probe_s1_lockq_${Date.now().toString(36)}`;
  const opened = [];
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = urlFor(ctx.pgUrl, name);
    const storage = new MemoryEstateStorage();
    const first = createClient({ databaseUrl: url, schema: v1 });
    opened.push(first);
    await createMigrationClient(first, { storage }).generate({ name: "v1" });
    await createMigrationClient(first, { storage }).apply();
    const second = createClient({ databaseUrl: url, schema: v2 });
    opened.push(second);
    const migrations = createMigrationClient(second, { storage });
    await migrations.generate({ name: "v2" });

    const reader = new pg.Client({
      connectionString: url,
      statement_timeout: 30_000,
    });
    const app = new pg.Client({
      connectionString: url,
      statement_timeout: 30_000,
    });
    await Promise.all([reader.connect(), app.connect()]);
    await app.query(
      `INSERT INTO "accounts" ("id", "email", "name", "settings", "updatedAt")
       SELECT 'acct-' || g, 'user' || g || '@example.com', 'name-' || g, '{"plan":"pro"}'::jsonb, now() FROM generate_series(1, ${ROWS}) g`
    );
    await reader.query("BEGIN");
    await reader.query(`SELECT count(*) FROM "accounts"`);
    const heldAt = Date.now();

    const applying = settle(migrations.apply(), HOLD_MS + 15_000);
    // Wait until the migration's DDL is queued on the table lock.
    let queued = false;
    while (!queued && Date.now() - heldAt < 8000) {
      const { rows } = await admin.query(
        `SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`,
        [name]
      );
      queued = rows[0].n > 0;
      if (!queued) await sleep(50);
    }
    const queuedAt = Date.now();
    const read = await settle(
      app.query(`SELECT count(*) FROM "accounts"`),
      HOLD_MS + 15_000
    );
    const readMs = read.at - queuedAt;
    await sleep(Math.max(0, HOLD_MS - (Date.now() - heldAt)));
    await reader.query("COMMIT");
    const applied = await applying;
    const appliedMs = applied.at - queuedAt;
    const retry = applied.ok
      ? { ok: true, text: "not needed" }
      : await settle(migrations.apply(), 15_000);
    await Promise.all([reader.end(), app.end()]);

    const problems = [];
    if (!queued) problems.push("the migration's DDL never queued on the lock");
    if (readMs > READ_LIMIT_MS)
      problems.push(
        `production read waited ${readMs} ms (limit ${READ_LIMIT_MS})`
      );
    if (applied.ok || appliedMs > GIVE_UP_MS)
      problems.push(
        `migration did not give up within the lock limit (${applied.text} ${appliedMs} ms after its DDL queued, limit ${GIVE_UP_MS})`
      );
    if (!retry.ok)
      problems.push(`retry after the long transaction: ${retry.text}`);
    const evidence = `DDL queued: ${queued}; production read ${read.ok ? "ok" : read.text} after ${readMs} ms; migration ${applied.text} ${appliedMs} ms after its DDL queued (long transaction held ${HOLD_MS} ms); retry ${retry.text}`;
    return {
      status: problems.length === 0 ? "pass" : "fail",
      evidence:
        problems.length === 0
          ? evidence
          : `${problems.join("; ")} | ${evidence}`,
    };
  } finally {
    for (const client of opened) await settle(client.$disconnect(), 2000);
    await admin
      .query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      .catch(() => undefined);
    await admin.end();
  }
}
