// S1 ("Done when": on PG 14+, a stranded session is gone within about 1 s).
// The migration runner's client vanishes half-open while it holds the
// migration lock: a TCP proxy forwards the marker read, then drops the client
// and keeps the server side open and silent, so the backend never learns its
// client is gone. With the session limits S1 sets (idle_session_timeout,
// client_connection_check_interval, ...; a D1-shaped runner stranded inside
// its transaction needs idle_in_transaction_session_timeout, see the unit's
// open question) the server ends that backend and its lock within ~1 s; 1.1.0
// sets none, so the backend stays idle holding the advisory lock and the next
// runner times out after 10 s (review M5).
import net from "node:net";
import pg from "pg";
import { s } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient } from "viborm/pg";

export const meta = {
  id: "s1-stranded-session",
  title:
    "A half-open migration session holding the lock is ended by the server within ~1 s (PG 14+)",
  plan: "phase-1/P/S1",
  needs: ["pg"],
  source:
    "pg-migrations-from-durable-objects-2026-10-10/evidence/faults/vb/m5-idle-lock.mjs (+ out/m5-idle-lock.json), lib/proxy.mjs 'blackhole'; code-check/postgres-transports.md#S1",
};

const GONE_WITHIN_MS = 3000;
const OBSERVE_MS = 8000;
const APP = "probe-s1-stranded";
const LOCK = /pg_(try_)?advisory(_xact)?_lock\(/i;
const STATE_TABLE = /_viborm_migration_state/i;
const STATE_WRITE =
  /^\s*(CREATE|ALTER|DROP)\b|\b(UPDATE|INSERT INTO|DELETE FROM)\s+[^\s(]*_viborm_migration_state/i;

/**
 * Fires on the first read of the state table, however it is spelled (D5 may
 * fold it into one WITH query), sent once the runner took the advisory lock
 * (session- or transaction-scoped, possibly in the same statement).
 */
function markerReadUnderLock() {
  let locked = false;
  return (text) => {
    locked ||= LOCK.test(text);
    return locked && STATE_TABLE.test(text) && !STATE_WRITE.test(text);
  };
}

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

/** The SQL text of a frontend Query ('Q') or Parse ('P') message, else null. */
function sqlOf(message) {
  const type = String.fromCharCode(message[0]);
  if (type === "Q")
    return message.subarray(5, message.length - 1).toString("utf8");
  if (type !== "P") return null;
  const body = message.subarray(5);
  const nameEnd = body.indexOf(0);
  return body
    .subarray(nameEnd + 1, body.indexOf(0, nameEnd + 1))
    .toString("utf8");
}

/** Forwards traffic; on the first statement for which `fires(sql)` is true, forwards it, then drops the client and holds the server open. */
async function startBlackholeProxy(target, fires) {
  const sockets = new Set();
  const state = { firedAt: null };
  const server = net.createServer((client) => {
    const upstream = net.connect(target);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => undefined);
    }
    let held = false;
    let buffer = Buffer.alloc(0);
    let startup = true;
    client.on("close", () => {
      if (!held) upstream.end();
    });
    upstream.on("close", () => client.destroy());
    upstream.on("data", (chunk) => {
      if (!held) client.write(chunk);
    });
    client.on("data", (chunk) => {
      if (held) return;
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const length = startup
          ? buffer.length >= 4
            ? buffer.readInt32BE(0)
            : Number.POSITIVE_INFINITY
          : buffer.length >= 5
            ? buffer.readInt32BE(1) + 1
            : Number.POSITIVE_INFINITY;
        if (buffer.length < length) return;
        const message = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        upstream.write(message);
        const text = startup ? null : sqlOf(message);
        startup = false;
        if (state.firedAt === null && text !== null && fires(text)) {
          upstream.write(buffer); // the rest of this extended-protocol burst (Bind/Execute/Sync)
          state.firedAt = Date.now();
          held = true;
          client.destroy();
          return;
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    state,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

const urlFor = (base, name, port, app) => {
  const url = new URL(base);
  url.pathname = `/${name}`;
  if (port) {
    url.hostname = "127.0.0.1";
    url.port = String(port);
  }
  url.searchParams.set("sslmode", "disable");
  if (app) url.searchParams.set("application_name", app);
  return url.toString();
};

const settle = (promise, ms) =>
  Promise.race([
    promise.then(
      (value) => `ok ${value?.outcome}`,
      (error) => `${error?.code ?? error?.name}`
    ),
    new Promise((resolve) =>
      setTimeout(() => resolve(`pending after ${ms} ms`), ms).unref()
    ),
  ]);

export default async function probe(ctx) {
  const admin = new pg.Client({
    connectionString: ctx.pgUrl,
    connectionTimeoutMillis: 5000,
    statement_timeout: 20_000,
  });
  await admin.connect();
  const name = `probe_s1_stranded_${Date.now().toString(36)}`;
  let proxy;
  try {
    const version = Number(
      (await admin.query("SHOW server_version_num")).rows[0].server_version_num
    );
    if (version < 140_000)
      return {
        status: "pass",
        evidence: `not applicable: server_version_num ${version} < 140000`,
      };
    await admin.query(`CREATE DATABASE "${name}"`);
    const storage = new MemoryEstateStorage();
    const setup = createClient({
      databaseUrl: urlFor(ctx.pgUrl, name),
      schema: v1,
    });
    await createMigrationClient(setup, { storage }).generate({ name: "v1" });
    await createMigrationClient(setup, { storage }).apply();
    await setup.$disconnect();

    const target = {
      host: new URL(ctx.pgUrl).hostname,
      port: Number(new URL(ctx.pgUrl).port || 5432),
    };
    proxy = await startBlackholeProxy(target, markerReadUnderLock());
    const runner = createClient({
      databaseUrl: urlFor(ctx.pgUrl, name, proxy.port, APP),
      schema: v2,
    });
    const runnerMigrations = createMigrationClient(runner, { storage });
    await runnerMigrations.generate({ name: "v2" });
    const stranded = settle(runnerMigrations.apply(), 15_000);
    const fireDeadline = Date.now() + 10_000;
    while (proxy.state.firedAt === null && Date.now() < fireDeadline)
      await new Promise((r) => setTimeout(r, 20));
    if (proxy.state.firedAt === null)
      throw new Error("no marker read under the lock reached the proxy");

    let goneAfter = null;
    let last = "";
    while (Date.now() - proxy.state.firedAt < OBSERVE_MS) {
      const { rows } = await admin.query(
        `SELECT (SELECT count(*)::int FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_database d ON d.oid = l.database
                  WHERE l.locktype = 'advisory' AND d.datname = $1) AS advisory,
                (SELECT string_agg(state, ',') FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND application_name = $2) AS sessions`,
        [name, APP]
      );
      last = `advisory locks ${rows[0].advisory}, stranded backend ${rows[0].sessions ?? "none"}`;
      if (rows[0].advisory === 0 && rows[0].sessions === null) {
        goneAfter = Date.now() - proxy.state.firedAt;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const rival = createClient({
      databaseUrl: urlFor(ctx.pgUrl, name),
      schema: v2,
    });
    const rivalOutcome = await settle(
      createMigrationClient(rival, { storage }).apply(),
      15_000
    );
    await settle(rival.$disconnect(), 2000);
    await settle(runner.$disconnect(), 2000);
    const evidence = `${goneAfter === null ? `still there ${OBSERVE_MS} ms after the client vanished (${last})` : `gone ${goneAfter} ms after the client vanished`}; stranded apply: ${await stranded}; next runner: ${rivalOutcome}`;
    return {
      status:
        goneAfter !== null && goneAfter <= GONE_WITHIN_MS ? "pass" : "fail",
      evidence,
    };
  } finally {
    proxy?.close();
    await admin
      .query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      .catch(() => undefined);
    await admin.end();
  }
}
