// S1 + new defect 5: getting the migration connection has a time limit. A
// server (or pooler) that accepts the TCP connection but never answers the
// startup leaves pg's `pool.connect()` and postgres.js `reserve()` waiting;
// 1.1.0 passes no bound (pg acquirePooledClient without maxWaitMs), so apply()
// never settles on pg, and on postgres.js only the driver's own 30 s
// connect_timeout ends it. Target: apply() settles with a typed error within
// BOUND_MS on both.
import net from "node:net";
import { s } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient as pgClient } from "viborm/pg";
import { createClient as postgresClient } from "viborm/postgres";

export const meta = {
  id: "s1-connection-wait-bounded",
  title:
    "apply() gives up on an unanswered migration connection within a bound, with a typed error",
  plan: "phase-1/P/S1",
  needs: [],
  source:
    "completion-plan-2026-10.md §2.3 new defect 5; code-check/postgres-transports.md#S1 ('Acquiring the pinned connection is unbounded'); src/drivers/pg/index.ts:290-330, 550-563; src/drivers/postgres/index.ts:375-384",
};

// The plan bounds the wait without naming a default; the lock loop's own
// deadline is 10 s, so 20 s is a generous ceiling.
const BOUND_MS = 20_000;
const TYPED = /^V\d+$/;

const schema = {
  account: s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      name: s.string(),
      status: s.enum(["trial", "active", "churned"]).default("trial"),
      balance: s.int().default(0),
      settings: s.json().nullable(),
      country: s.string().default("FR"),
      verified: s.boolean().default(false),
      notes: s.string().nullable(),
      deletedAt: s.dateTime().nullable(),
      createdAt: s.dateTime().now(),
      updatedAt: s.dateTime().updatedAt(),
    })
    .map("accounts"),
};

async function settleWithin(promise, ms) {
  const started = Date.now();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), ms);
  });
  const outcome = await Promise.race([
    promise.then(
      (value) => ({ settled: true, ok: true, value }),
      (error) => ({
        settled: true,
        ok: false,
        code: error?.code ?? error?.name,
      })
    ),
    deadline,
  ]);
  clearTimeout(timer);
  return { ...outcome, ms: Date.now() - started };
}

export default async function probe() {
  const sockets = new Set();
  const mute = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
  });
  await new Promise((resolve) => mute.listen(0, "127.0.0.1", resolve));
  const url = `postgres://app:secret@127.0.0.1:${mute.address().port}/app`;
  try {
    const storage = new MemoryEstateStorage();
    const pgMigrations = createMigrationClient(
      pgClient({ databaseUrl: url, schema }),
      { storage }
    );
    await pgMigrations.generate({ name: "v1" });
    const postgresMigrations = createMigrationClient(
      postgresClient({ databaseUrl: url, schema }),
      { storage }
    );
    const [onPg, onPostgres] = await Promise.all([
      settleWithin(pgMigrations.apply(), BOUND_MS),
      settleWithin(postgresMigrations.apply(), BOUND_MS),
    ]);
    const describe = (label, r) =>
      r.settled
        ? `${label}: ${r.ok ? "resolved" : `rejected ${r.code}`} after ${r.ms} ms`
        : `${label}: still pending after ${r.ms} ms`;
    const good = (r) => r.settled && !r.ok && TYPED.test(r.code);
    return {
      status: good(onPg) && good(onPostgres) ? "pass" : "fail",
      evidence: `${describe("pg apply()", onPg)}; ${describe("postgres.js apply()", onPostgres)} (server accepted ${sockets.size} connection(s), never answered)`,
    };
  } finally {
    for (const socket of sockets) socket.destroy();
    mute.close();
  }
}
