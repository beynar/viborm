/**
 * The migration session's time limits on a real PostgreSQL backend (plan S1).
 *
 * PGlite is one physical session, so a `SHOW` sent from a protocol tap right
 * before a statement is forwarded reads the settings that statement runs
 * under. Each locked command — `apply`, `push`, `down`, `verify`, `reset` and
 * `baseline` here; `resolve` shares the same owner and is pinned with the
 * others in `pinned-session-limits.core.test.ts` — must run its lock statement
 * and its DDL under `lock_timeout` and `statement_timeout`, and hand the
 * session back with both as they were.
 *
 * The estate is realistic: a fifteen-field model holding 10,000 rows.
 */

import { createServer, type Socket } from "node:net";
import { PgDriver } from "@drivers/pg";
import { createClient } from "@drivers/pglite";
import { PostgresDriver } from "@drivers/postgres";
import type { PGlite } from "@electric-sql/pglite";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations";
import { getMigrationDriver } from "@migrations/drivers";
import {
  resolveMigrationTimeLimits,
  withLockedMigrationProducer,
} from "@migrations/pinned-session";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { s } from "@schema";
import { sql } from "@sql";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROWS = 10_000;
const LOCK = /pg_try_advisory_lock/i;
const DDL = /^(ALTER TABLE|CREATE (UNIQUE )?INDEX|CREATE TABLE|DROP )/i;
const CONCURRENTLY = /^CREATE INDEX CONCURRENTLY/i;
const SETTINGS = ["lock_timeout", "statement_timeout"] as const;
type Settings = Record<(typeof SETTINGS)[number], string>;

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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Seen {
  lock?: Settings;
  ddl?: Settings;
  concurrently?: Settings;
}

/** Both settings, read with one simple Query sent straight to the session. */
async function show(
  send: PGlite["execProtocolStream"],
  database: PGlite
): Promise<Settings> {
  const text = encoder.encode(SETTINGS.map((name) => `SHOW ${name}`).join(";"));
  const message = new Uint8Array(text.length + 6);
  message[0] = 0x51;
  new DataView(message.buffer).setInt32(1, text.length + 5);
  message.set(text, 5);
  const replies = await send.call(database, message, {});
  const rows = replies.filter((reply) => reply.name === "dataRow");
  const value = (index: number) => {
    const row: unknown = rows[index];
    const fields: unknown =
      typeof row === "object" && row !== null
        ? Reflect.get(row, "fields")
        : undefined;
    return Array.isArray(fields) ? String(fields[0]) : "unobserved";
  };
  return { lock_timeout: value(0), statement_timeout: value(1) };
}

/** Runs `command`, reading the settings at its lock, first DDL and first CONCURRENTLY. */
async function observe(
  database: PGlite,
  command: () => Promise<unknown>
): Promise<Seen & { after: Settings }> {
  const send = database.execProtocolStream;
  const seen: Seen = {};
  database.execProtocolStream = async (message, options) => {
    if (message[0] === 0x50 || message[0] === 0x51) {
      const start = message[0] === 0x50 ? message.indexOf(0, 5) + 1 : 5;
      const text = decoder
        .decode(message.subarray(start, message.indexOf(0, start)))
        .trim();
      if (!seen.lock && LOCK.test(text)) seen.lock = await show(send, database);
      if (!seen.ddl && DDL.test(text)) seen.ddl = await show(send, database);
      if (!seen.concurrently && CONCURRENTLY.test(text)) {
        seen.concurrently = await show(send, database);
      }
    }
    return send.call(database, message, options);
  };
  try {
    await command();
  } finally {
    database.execProtocolStream = send;
  }
  return { ...seen, after: await show(send, database) };
}

const LIMITED: Settings = { lock_timeout: "4s", statement_timeout: "10min" };

const database = openTestPGlite();
let baseline: Settings;

beforeAll(async () => {
  await database.waitReady;
  baseline = await show(database.execProtocolStream, database);
});

describe("every locked command runs under the session's time limits", () => {
  const storage = new MemoryEstateStorage();
  const client = (schema: typeof v1 | typeof v2 | typeof v3) =>
    createMigrationClient(createClient({ client: database, schema }), {
      storage,
    });

  it("apply: the lock and the DDL under the limits, the session handed back unchanged", async () => {
    const first = client(v1);
    await first.generate({ name: "v1" });
    await first.apply();
    await database.query(
      `INSERT INTO "accounts" ("id", "email", "name", "settings", "updatedAt")
       SELECT 'acct-' || g, 'user' || g || '@example.com', 'name-' || g, '{"plan":"pro"}'::jsonb, now()
       FROM generate_series(1, ${ROWS}) g`
    );
    const second = client(v2);
    await second.generate({ name: "v2" });

    const seen = await observe(database, () => second.apply());

    expect(seen).toEqual({
      lock: LIMITED,
      ddl: LIMITED,
      after: baseline,
    });
    const { rows } = await database.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "accounts" WHERE "nickname" IS NULL`
    );
    expect(rows[0]?.n).toBe(ROWS);
  });

  it("verify: the lock under the limits, the session handed back unchanged", async () => {
    const seen = await observe(database, () => client(v2).verify());
    expect(seen).toEqual({
      lock: LIMITED,
      after: baseline,
    });
  });

  it("a CONCURRENTLY build runs with no limits inside the limited session", async () => {
    const second = client(v2);
    const third = client(v3);
    const origin = (await second.status()).marker?.stateId;
    if (origin === undefined) throw new Error("v2 is not applied");
    const indexCheck = (exists: boolean) => ({
      kind: "trusted-read" as const,
      query: sql.raw(
        `SELECT ${exists ? "" : "NOT "}EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relname = 'accounts_name_idx') AS ok`
      ),
      equals: true,
    });
    await third.generate({
      name: "v3",
      manualMigration: {
        transitions: [
          {
            from: origin,
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

    const seen = await observe(database, () => third.apply());

    expect(seen.concurrently).toEqual({
      lock_timeout: "0",
      statement_timeout: "0",
    });
    expect(seen.after).toEqual(baseline);
  });

  it("down: the rollback runs under the same limits", async () => {
    const seen = await observe(database, () => client(v3).down({ steps: 1 }));
    expect(seen.lock).toEqual(LIMITED);
    expect(seen.after).toEqual(baseline);
  });

  it("reset: the rebuild's DDL under the limits", async () => {
    const seen = await observe(database, () => client(v2).reset());
    expect(seen).toMatchObject({
      lock: LIMITED,
      ddl: LIMITED,
      after: baseline,
    });
  });

  it("push and baseline: the same owner, the same limits", async () => {
    await database.query('CREATE SCHEMA "push_estate"');
    const push = createMigrationClient(
      createClient({ client: database, schema: v1, namespace: "push_estate" })
    );
    const pushed = await observe(database, () => push.push());
    expect(pushed).toEqual({
      lock: LIMITED,
      ddl: LIMITED,
      after: baseline,
    });

    const adopting = createMigrationClient(
      createClient({ client: database, schema: v1, namespace: "push_estate" }),
      { storage: new MemoryEstateStorage() }
    );
    await adopting.generate({ name: "adopt" });
    const adopted = await observe(database, () =>
      adopting.baseline({ to: { name: "adopt" } })
    );
    expect(adopted.lock).toEqual(LIMITED);
    expect(adopted.after).toEqual(baseline);
  });

  it("the client's timeLimits option is the limits its commands run under", async () => {
    await database.query('CREATE SCHEMA "limits_estate"');
    const limited = createMigrationClient(
      createClient({
        client: database,
        schema: v1,
        namespace: "limits_estate",
      }),
      { timeLimits: { lockTimeout: 1500, statementTimeout: 90_000 } }
    );
    const own: Settings = { lock_timeout: "1500ms", statement_timeout: "90s" };
    expect(await observe(database, () => limited.push())).toEqual({
      lock: own,
      ddl: own,
      after: baseline,
    });
  });
});

describe("the wait for the migration connection is bounded", () => {
  const sockets = new Set<Socket>();
  // Accepts the socket and never answers the startup: a dead pooler, a
  // half-open load balancer.
  const mute = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
  });
  let url = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => mute.listen(0, "127.0.0.1", resolve));
    const address = mute.address();
    const port = typeof address === "object" && address ? address.port : 0;
    url = `postgres://app:secret@127.0.0.1:${port}/app`;
  });
  afterAll(() => {
    for (const socket of sockets) socket.destroy();
    mute.close();
  });

  it.each([
    ["pg", () => new PgDriver({ databaseUrl: url })],
    ["postgres.js", () => new PostgresDriver({ databaseUrl: url })],
  ])("%s: a server that never answers ends in a retryable V1002 within connectionWait", async (_name, build) => {
    const driver = build();
    const command = getMigrationDriver(
      driver,
      undefined,
      resolveMigrationTimeLimits({ connectionWait: 300 })
    );
    const started = Date.now();

    const failure = await withLockedMigrationProducer(
      driver,
      command,
      async () => "ran"
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: VibORMErrorCode.CONNECTION_TIMEOUT,
    });
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
