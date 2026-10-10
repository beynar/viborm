// S2: never talk to a dead connection. A TCP proxy between the migration runner
// and a real PostgreSQL cuts the connection at each phase of an apply (before
// the lock, before BEGIN, right after the first DDL ran, before the marker
// compare-and-swap, before COMMIT, before the unlock). Target ("Done when"):
// every cut ends in a typed VibORM error (or a truthful success: the server
// really holds the v2 marker and column) within a bound - no hang and no
// process crash - on pg and on postgres.js. 1.1.0: pg surfaces cuts inside the
// transaction as an untyped AggregateError (the ROLLBACK sent on the dead
// connection fails on top of the typed V2001); postgres.js
// sends ROLLBACK / pg_advisory_unlock_all on the dead reserved connection,
// which throws an uncaught TypeError (postgres connection.js:255) and leaves
// apply() pending (review PGF-03).
import net from "node:net";
import pg from "pg";
import { s } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient as pgClient } from "viborm/pg";
import { createClient as postgresClient } from "viborm/postgres";

export const meta = {
  id: "s2-connection-cut",
  title:
    "A connection cut at any apply phase gives a typed error, never a hang or a crash, on pg and postgres.js",
  plan: "phase-1/P/S2",
  needs: ["pg"],
  source:
    "pg-migrations-from-durable-objects-2026-10-10/evidence/faults/vb/faults.mjs + lib/proxy.mjs (E1), lanes/faults.md PGF-03; code-check/postgres-transports.md#S2; src/migrations/pinned-session.ts:278-295, 757-818; src/drivers/shared/pinned-session.ts:130-178",
};

const BOUND_MS = 12_000;
const STARTUP = 196_608;
const TYPED = /^V\d+$/;
const SCENARIOS = [
  ["cut before lock", /advisory/i, "cut-before"],
  ["cut before BEGIN", /^\s*BEGIN/i, "cut-before"],
  ["cut after first DDL ran", /ADD COLUMN "nickname"/, "cut-after-reply"],
  [
    "cut before marker CAS",
    /\b(UPDATE|INSERT INTO)\s+[^\s(]*_viborm_migration_state/i,
    "cut-before",
  ],
  ["cut before COMMIT", /^\s*COMMIT/i, "cut-before"],
  ["cut before unlock", /pg_advisory_unlock/i, "cut-before"],
];

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
const DRIVERS = {
  pg: (databaseUrl, schema) => pgClient({ databaseUrl, schema }),
  "postgres.js": (databaseUrl, schema) =>
    postgresClient({ databaseUrl, schema }),
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

/** Splits a typed-message stream; the first frontend message (startup) has no type byte. */
function framer(untypedFirst) {
  let buffer = Buffer.alloc(0);
  let untyped = untypedFirst;
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const messages = [];
    for (;;) {
      if (untyped) {
        if (buffer.length < 8) break;
        const length = buffer.readInt32BE(0);
        if (buffer.length < length) break;
        if (buffer.readInt32BE(4) === STARTUP) untyped = false;
        messages.push({ untyped: true, bytes: buffer.subarray(0, length) });
        buffer = buffer.subarray(length);
        continue;
      }
      if (buffer.length < 5) break;
      const length = buffer.readInt32BE(1);
      if (buffer.length < length + 1) break;
      messages.push({ untyped: false, bytes: buffer.subarray(0, length + 1) });
      buffer = buffer.subarray(length + 1);
    }
    return messages;
  };
}

/** A PostgreSQL TCP proxy that fires one cut on the first frontend statement matching `rule.match`. */
async function startCutProxy(target, rule) {
  const sockets = new Set();
  const server = net.createServer((client) => {
    const upstream = net.connect(target);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => undefined);
    }
    const cut = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("close", () => upstream.end());
    upstream.on("close", () => client.destroy());
    let cutOnReady = false;
    const fromClient = framer(true);
    const fromServer = framer(false);
    client.on("data", (chunk) => {
      for (const { untyped, bytes } of fromClient(chunk)) {
        const text = untyped ? null : sqlOf(bytes);
        if (text !== null && !rule.fired && rule.match.test(text)) {
          rule.fired = text.replace(/\s+/g, " ").slice(0, 60);
          if (rule.action === "cut-before") return cut();
          cutOnReady = true;
        }
        upstream.write(bytes);
      }
    });
    upstream.on("data", (chunk) => {
      for (const { bytes } of fromServer(chunk)) {
        if (cutOnReady && bytes[0] === 0x5a /* 'Z' ReadyForQuery */)
          return cut();
        client.write(bytes);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

async function settleWithin(promise, ms) {
  let timer;
  const pending = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), ms);
  });
  const result = await Promise.race([
    promise.then(
      (value) => ({ settled: true, ok: true, outcome: value?.outcome }),
      (error) => ({
        settled: true,
        ok: false,
        code: error?.code ?? error?.name,
      })
    ),
    pending,
  ]);
  clearTimeout(timer);
  return result;
}

/** Why a reported success is untrue ("" when the server holds the v2 marker and its column). */
async function untrue(url, storage, v2State) {
  const client = DRIVERS.pg(url, v2);
  const direct = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10_000,
  });
  try {
    const { marker } = await Promise.race([
      createMigrationClient(client, { storage }).status(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("status() pending")), 10_000).unref()
      ),
    ]);
    await direct.connect();
    const column = await direct.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'nickname'"
    );
    if (marker?.stateId !== v2State)
      return ` but the marker is ${marker?.stateId}`;
    return column.rowCount === 1 ? "" : " but the v2 column is missing";
  } catch (error) {
    return ` but checking it failed: ${error?.code ?? error?.message}`;
  } finally {
    await direct.end().catch(() => undefined);
    await settleWithin(client.$disconnect(), 2000);
  }
}

const databaseUrl = (base, name, port) => {
  const url = new URL(base);
  url.pathname = `/${name}`;
  if (port) {
    url.hostname = "127.0.0.1";
    url.port = String(port);
  }
  url.searchParams.set("sslmode", "disable");
  return url.toString();
};

export default async function probe(ctx) {
  const crashes = [];
  let current = "";
  const onCrash = (error) =>
    crashes.push({
      driver: current,
      message: String(error?.message ?? error).slice(0, 80),
    });
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);
  const admin = new pg.Client({
    connectionString: ctx.pgUrl,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30_000,
  });
  await admin.connect();
  const databases = [];
  const target = {
    host: new URL(ctx.pgUrl).hostname,
    port: Number(new URL(ctx.pgUrl).port || 5432),
  };
  try {
    const storage = new MemoryEstateStorage();
    await createMigrationClient(DRIVERS.pg(ctx.pgUrl, v1), {
      storage,
    }).generate({ name: "v1" });
    const { stateId: v2State } = await createMigrationClient(
      DRIVERS.pg(ctx.pgUrl, v2),
      { storage }
    ).generate({ name: "v2" });
    const lines = [];
    const problems = [];
    for (const [driver, make] of Object.entries(DRIVERS)) {
      current = driver;
      const runs = [];
      for (const [label, match, action] of SCENARIOS) {
        const name = `probe_s2_${databases.length}_${Date.now().toString(36)}`;
        await admin.query(`CREATE DATABASE "${name}"`);
        databases.push(name);
        const setup = make(databaseUrl(ctx.pgUrl, name), v1);
        await createMigrationClient(setup, { storage }).apply({
          to: { name: "v1" },
        });
        await setup.$disconnect();
        runs.push({ label, name, rule: { match, action, fired: null } });
      }
      await Promise.all(
        runs.map(async (run) => {
          const proxy = await startCutProxy(target, run.rule);
          const client = make(databaseUrl(ctx.pgUrl, run.name, proxy.port), v2);
          run.result = await settleWithin(
            createMigrationClient(client, { storage }).apply(),
            BOUND_MS
          );
          proxy.close();
          await settleWithin(client.$disconnect(), 2000);
          if (run.result.ok)
            run.result.untrue = await untrue(
              databaseUrl(ctx.pgUrl, run.name),
              storage,
              v2State
            );
        })
      );
      for (const run of runs) {
        const r = run.result;
        const verdict = r.settled
          ? r.ok
            ? `ok ${r.outcome}${r.untrue}`
            : r.code
          : "HANG";
        const truthful = r.ok ? r.untrue === "" : TYPED.test(r.code);
        if (!(r.settled && truthful)) {
          problems.push(`${driver} ${run.label}: ${verdict}`);
        }
        lines.push(
          `${driver} ${run.label}${run.rule.fired ? "" : " (cut point absent)"}: ${verdict}`
        );
      }
    }
    for (const crash of crashes)
      problems.push(`${crash.driver}: uncaught ${crash.message}`);
    return {
      status: problems.length === 0 ? "pass" : "fail",
      evidence:
        problems.length === 0
          ? lines.join("; ")
          : `${problems.join("; ")} | ${lines.join("; ")}`,
    };
  } finally {
    process.off("uncaughtException", onCrash);
    process.off("unhandledRejection", onCrash);
    for (const name of databases) {
      await admin
        .query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
        .catch(() => undefined);
    }
    await admin.end();
  }
}
