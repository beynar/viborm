// D1 ("Done when": apply and push run clean through a transaction pooler). A
// transaction-mode pooler (PgBouncer pool_mode=transaction, Neon -pooler,
// Hyperdrive) hands each transaction, and each statement outside one, to
// whichever server session is free, and keeps session state (advisory locks
// included) on that server. This probe gives viborm/pg such a pool: three real
// server sessions, FIFO hand-out (PgBouncer server_round_robin=1), no reset.
// Target: apply and push succeed, leave no advisory lock on any server
// session, and two runners racing through the pooler apply a +100 credit
// exactly once per round. 1.1.0 takes a session lock and unlocks it from
// another session: V11005 after the commit, and the lock leaks (review E01).
import pg from "pg";
import { s } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient } from "viborm/pg";
import { sql } from "viborm/sql";

export const meta = {
  id: "d1-transaction-pooler",
  title:
    "apply and push run clean through a transaction-mode pooler; racing runners credit exactly once",
  plan: "phase-2/D1",
  needs: ["pg"],
  source:
    "pg-migrations-from-durable-objects-2026-10-10/evidence/pooling/proj/txpool.mjs, e01-single.mjs, e02-concurrent.mjs, e12-xact.mjs; lanes/pooling.md PL-01/02; code-check/postgres-transports.md#D1",
};

const SESSIONS = 3;
const ROUNDS = 4;
const BOUND_MS = 20_000;
const BEGINS = /^\s*(BEGIN|START\s+TRANSACTION)\b/i;
const ENDS = /^\s*(COMMIT|ROLLBACK|END|ABORT)\b/i;

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

// Pool and client events stay silent: the probe owns the server sessions.
const ignore = () => undefined;
const listeners = { on: ignore, off: ignore, removeListener: ignore };

/** A transaction-mode pooler over `servers`, shaped like the pg Pool viborm/pg accepts. */
function transactionPool(servers) {
  const idle = [...servers];
  const waiting = [];
  const take = () =>
    idle.length > 0
      ? Promise.resolve(idle.shift())
      : new Promise((resolve) => waiting.push(resolve));
  const give = (server) => {
    const next = waiting.shift();
    if (next) next(server);
    else idle.push(server);
  };
  const textOf = (config) =>
    typeof config === "string" ? config : config.text;
  /** One statement outside a transaction: any free server, returned right after. */
  const autocommit = async (config, values) => {
    const server = await take();
    try {
      return await server.query(config, values);
    } finally {
      give(server);
    }
  };
  const connect = async () => {
    let bound = null;
    return {
      async query(config, values) {
        const text = textOf(config);
        if (bound === null && !BEGINS.test(text))
          return autocommit(config, values);
        if (bound === null) bound = await take();
        const server = bound;
        try {
          return await server.query(config, values);
        } catch (error) {
          if (BEGINS.test(text)) {
            bound = null;
            give(server);
          }
          throw error;
        } finally {
          if (ENDS.test(text) && bound === server) {
            bound = null;
            give(server);
          }
        }
      },
      release() {
        // A client leaving mid-transaction: the pooler rolls the server back.
        if (bound !== null) {
          const server = bound;
          bound = null;
          server.query("ROLLBACK").finally(() => give(server));
        }
      },
      ...listeners,
    };
  };
  return {
    connect,
    query: autocommit,
    ...listeners,
    end: async () => undefined,
    options: {},
  };
}

const urlFor = (base, name) => {
  const url = new URL(base);
  url.pathname = `/${name}`;
  url.searchParams.set("sslmode", "disable");
  return url.toString();
};
const settle = (promise) =>
  Promise.race([
    promise.then(
      (value) => ({ ok: true, text: value?.outcome ?? "ok" }),
      (error) => ({ ok: false, text: `${error?.code ?? error?.name}` })
    ),
    new Promise((resolve) =>
      setTimeout(
        () => resolve({ ok: false, text: `pending after ${BOUND_MS} ms` }),
        BOUND_MS
      ).unref()
    ),
  ]);

export default async function probe(ctx) {
  const admin = new pg.Client({
    connectionString: ctx.pgUrl,
    connectionTimeoutMillis: 5000,
    statement_timeout: 20_000,
  });
  await admin.connect();
  const name = `probe_d1_txpool_${Date.now().toString(36)}`;
  const servers = [];
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = urlFor(ctx.pgUrl, name);
    for (let i = 0; i < SESSIONS; i++) {
      const server = new pg.Client({
        connectionString: url,
        statement_timeout: 15_000,
      });
      await server.connect();
      server.on("error", () => undefined);
      servers.push(server);
    }
    await servers[0].query('CREATE SCHEMA "push_estate"');
    const pool = transactionPool(servers);
    const leaks = async () =>
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_database d ON d.oid = l.database
           WHERE l.locktype = 'advisory' AND d.datname = $1`,
          [name]
        )
      ).rows[0].n;

    const storage = new MemoryEstateStorage();
    const states = [];
    const first = createMigrationClient(createClient({ pool, schema: v1 }), {
      storage,
    });
    states.push((await first.generate({ name: "v1" })).stateId);
    const second = createMigrationClient(createClient({ pool, schema: v2 }), {
      storage,
    });
    states.push((await second.generate({ name: "v2" })).stateId);
    const lines = [];
    const problems = [];
    for (const [label, migrations, to] of [
      ["apply v1", first, states[0]],
      ["apply v2", second, states[1]],
    ]) {
      const r = await settle(migrations.apply({ to: { id: to } }));
      const leaked = await leaks();
      lines.push(`${label}: ${r.text}, ${leaked} advisory lock(s) left`);
      if (!(r.ok && leaked === 0))
        problems.push(`${label} ${r.text} with ${leaked} lock(s) left`);
    }
    const pushed = await settle(
      createMigrationClient(
        createClient({ pool, schema: v2, namespace: "push_estate" })
      ).push()
    );
    const pushLeaks = await leaks();
    lines.push(`push: ${pushed.text}, ${pushLeaks} advisory lock(s) left`);
    if (!(pushed.ok && pushLeaks === 0))
      problems.push(`push ${pushed.text} with ${pushLeaks} lock(s) left`);

    if (problems.length === 0) {
      await pool.query(
        `INSERT INTO "accounts" ("id", "email", "name", "balance", "updatedAt") VALUES ('acct-1', 'a@example.com', 'A', 0, now())`
      );
      for (let round = 1; round <= ROUNDS; round++) {
        const credit = await second.generate({
          name: `credit-${round}`,
          manualMigration: {
            transitions: [
              {
                from: states.at(-1),
                execution: "transactional",
                up: [
                  sql.raw(
                    `UPDATE "public"."accounts" SET "balance" = "balance" + 100`
                  ),
                ],
                rollback: { kind: "irreversible", reason: "probe credit" },
              },
            ],
          },
        });
        states.push(credit.stateId);
        const runners = [0, 1].map(() =>
          createMigrationClient(createClient({ pool, schema: v2 }), { storage })
        );
        const results = await Promise.all(
          runners.map((m) => settle(m.apply({ to: { id: credit.stateId } })))
        );
        const balance = (
          await pool.query(
            `SELECT "balance" FROM "accounts" WHERE "id" = 'acct-1'`
          )
        ).rows[0].balance;
        const leaked = await leaks();
        lines.push(
          `round ${round}: ${results.map((r) => r.text).join("+")}, balance ${balance}, ${leaked} lock(s)`
        );
        if (
          balance !== round * 100 ||
          leaked > 0 ||
          results.some((r) => r.text.startsWith("pending"))
        ) {
          problems.push(
            `round ${round}: balance ${balance} (want ${round * 100}), ${leaked} lock(s), runners ${results.map((r) => r.text).join("+")}`
          );
        }
      }
    } else {
      lines.push("racing rounds skipped");
    }
    return {
      status: problems.length === 0 ? "pass" : "fail",
      evidence:
        problems.length === 0
          ? lines.join("; ")
          : `${problems.join("; ")} | ${lines.join("; ")}`,
    };
  } finally {
    await Promise.all(
      servers.map((server) => server.end().catch(() => undefined))
    );
    await admin
      .query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      .catch(() => undefined);
    await admin.end();
  }
}
