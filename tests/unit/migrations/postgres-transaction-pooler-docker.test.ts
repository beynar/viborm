/**
 * Migrations through a transaction-mode pooler (plan D1), on a real
 * PostgreSQL 16 server.
 *
 * A transaction pooler (PgBouncer `pool_mode=transaction`, Neon `-pooler`,
 * Hyperdrive) hands each transaction, and each statement outside one, to
 * whichever server session is free, and leaves session state - advisory locks
 * included - on that session. The pool below is that pooler, in process: real
 * server sessions, handed out LIFO, FIFO or at random, optionally reset with
 * `DISCARD ALL` when they come back, with a Hyperdrive-style read cache that
 * answers repeated autocommit reads without asking the server.
 *
 * 1.1.0 took a session lock on one backend and released it on another:
 * V11005, and the lock leaked. The transaction-scoped protocol must apply and
 * push cleanly through it, leave no advisory lock behind, and - in the replica
 * of the review's 140 pooled-and-cached rounds - two runners racing one credit
 * must credit it exactly once every round.
 *
 * Run with:
 *   PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/viborm
 */

import { createClient } from "@drivers/pg";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { s } from "@schema";
import { sql } from "@sql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CONNECTION_STRING = process.env.PG_TEST_CONNECTION_STRING ?? "";
const describeIfDocker = CONNECTION_STRING ? describe : describe.skip;

const SERVER_SESSIONS = 4;
const BEGINS = /^\s*(BEGIN|START\s+TRANSACTION)\b/i;
const ENDS = /^\s*(COMMIT|ROLLBACK|END|ABORT)\b/i;
const READ = /^\s*(SELECT|WITH)\b/i;
/** What Hyperdrive does not cache: volatile functions and anything that writes. */
const UNCACHEABLE =
  /\b(now|clock_timestamp|random|nextval|set_config|pg_sleep|pg_try_advisory\w*|pg_advisory\w*|txid_current)\s*\(|\b(INSERT|UPDATE|DELETE)\b/i;

type Policy = "lifo" | "fifo" | "random";

interface PoolerOptions {
  readonly policy: Policy;
  readonly reset: boolean;
  readonly cache: boolean;
}

interface Pooler {
  readonly pool: pg.Pool;
  readonly cacheHits: () => number;
}

type QueryInput = string | pg.QueryConfig;

const textOf = (config: QueryInput): string =>
  typeof config === "string" ? config : config.text;

/** A transaction-mode pooler over `servers`, shaped like the pg Pool viborm/pg accepts. */
function transactionPooler(
  servers: readonly pg.Client[],
  options: PoolerOptions
): Pooler {
  const idle = [...servers];
  const waiting: ((server: pg.Client) => void)[] = [];
  const cache = new Map<string, pg.QueryResult>();
  let hits = 0;
  const take = (): Promise<pg.Client> => {
    if (idle.length === 0) {
      return new Promise((resolve) => waiting.push(resolve));
    }
    const index =
      options.policy === "lifo"
        ? idle.length - 1
        : options.policy === "fifo"
          ? 0
          : Math.floor(Math.random() * idle.length);
    const [server] = idle.splice(index, 1);
    if (server === undefined) throw new Error("no idle server session");
    return Promise.resolve(server);
  };
  const give = async (server: pg.Client) => {
    if (options.reset) await server.query("DISCARD ALL");
    const next = waiting.shift();
    if (next) next(server);
    else idle.push(server);
  };
  /** One statement outside a transaction: any free server, or the cache. */
  const autocommit = async (config: QueryInput, values?: unknown[]) => {
    const text = textOf(config);
    const key = JSON.stringify([text, values ?? null]);
    const cacheable =
      options.cache && READ.test(text) && !UNCACHEABLE.test(text);
    const cached = cacheable ? cache.get(key) : undefined;
    if (cached) {
      hits += 1;
      return cached;
    }
    const server = await take();
    try {
      const result = await server.query(config, values);
      if (cacheable) cache.set(key, result);
      return result;
    } finally {
      await give(server);
    }
  };
  const ignore = () => undefined;
  const connect = () => {
    let bound: pg.Client | null = null;
    return Promise.resolve({
      async query(config: QueryInput, values?: unknown[]) {
        const text = textOf(config);
        if (bound === null && !BEGINS.test(text)) {
          return autocommit(config, values);
        }
        bound ??= await take();
        const server = bound;
        try {
          return await server.query(config, values);
        } finally {
          if (ENDS.test(text) && bound === server) {
            bound = null;
            await give(server);
          }
        }
      },
      release() {
        // A client leaving mid-transaction: the pooler rolls its server back.
        if (bound !== null) {
          const server = bound;
          bound = null;
          server.query("ROLLBACK").finally(() => give(server));
        }
      },
      on: ignore,
      off: ignore,
      removeListener: ignore,
    });
  };
  // A pg Pool to viborm/pg, as the supplied-pool contract tests build one:
  // the pooler answers every member the driver reaches.
  const pool: pg.Pool = Object.create(pg.Pool.prototype);
  Object.defineProperties(pool, {
    connect: { value: connect },
    query: { value: autocommit },
    on: { value: ignore },
    off: { value: ignore },
    removeListener: { value: ignore },
    end: { value: () => Promise.resolve() },
    options: { value: {} },
  });
  return { pool, cacheHits: () => hits };
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

describeIfDocker("migrations through a transaction-mode pooler (D1)", () => {
  const admin = new pg.Client({ connectionString: CONNECTION_STRING });
  const servers: pg.Client[] = [];
  const schemas: string[] = [];

  beforeAll(async () => {
    await admin.connect();
    for (let i = 0; i < SERVER_SESSIONS; i += 1) {
      const server = new pg.Client({ connectionString: CONNECTION_STRING });
      server.on("error", () => undefined);
      await server.connect();
      servers.push(server);
    }
  });

  afterAll(async () => {
    await Promise.all(servers.map((server) => server.end()));
    for (const name of schemas) {
      await admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    }
    await admin.end();
  });

  async function freshSchema(): Promise<string> {
    const name = `d1_pool_${process.pid}_${schemas.length + 1}`;
    schemas.push(name);
    await admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${name}"`);
    return name;
  }

  /** Advisory locks any server session still holds, in this database. */
  async function advisoryLocks(): Promise<number> {
    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_catalog.pg_locks l
       JOIN pg_catalog.pg_database d ON d.oid = l.database
       WHERE l.locktype = 'advisory' AND d.datname = current_database()`
    );
    return rows[0]?.n ?? -1;
  }

  it("apply and push run clean and leave no advisory lock on any server session", async () => {
    const pooler = transactionPooler(servers, {
      policy: "fifo",
      reset: false,
      cache: false,
    });
    const namespace = await freshSchema();
    const storage = new MemoryEstateStorage();
    const first = createMigrationClient(
      createClient({ pool: pooler.pool, schema: v1, namespace }),
      { storage }
    );
    const { stateId: root } = await first.generate({ name: "v1" });
    if (root === null) throw new Error("v1 published no state");
    const second = createMigrationClient(
      createClient({ pool: pooler.pool, schema: v2, namespace }),
      { storage }
    );
    await second.generate({ name: "v2" });

    await expect(first.apply({ to: { id: root } })).resolves.toMatchObject({
      outcome: "applied",
    });
    expect(await advisoryLocks()).toBe(0);
    await expect(second.apply()).resolves.toMatchObject({ outcome: "applied" });
    expect(await advisoryLocks()).toBe(0);
    await expect(second.verify()).resolves.toEqual({ ok: true });
    expect(await advisoryLocks()).toBe(0);

    const pushed = await freshSchema();
    await expect(
      createMigrationClient(
        createClient({ pool: pooler.pool, schema: v2, namespace: pushed })
      ).push()
    ).resolves.toMatchObject({ outcome: "applied" });
    expect(await advisoryLocks()).toBe(0);
  });

  it("140 pooled and cached rounds: two racing runners credit exactly once every round", async () => {
    // The review's E12 split: LIFO 40, random 40, FIFO with DISCARD ALL 20,
    // random 40; the read cache on throughout.
    const legs: readonly (PoolerOptions & { rounds: number })[] = [
      { policy: "lifo", reset: false, cache: true, rounds: 40 },
      { policy: "random", reset: false, cache: true, rounds: 40 },
      { policy: "fifo", reset: true, cache: true, rounds: 20 },
      { policy: "random", reset: false, cache: true, rounds: 40 },
    ];
    const problems: string[] = [];
    let total = 0;
    for (const leg of legs) {
      const pooler = transactionPooler(servers, leg);
      const namespace = await freshSchema();
      const storage = new MemoryEstateStorage();
      const runner = () =>
        createMigrationClient(
          createClient({ pool: pooler.pool, schema: v1, namespace }),
          { storage }
        );
      let head = (await runner().generate({ name: "v1" })).stateId;
      await runner().apply();
      await admin.query(
        `INSERT INTO "${namespace}"."accounts" ("id", "email", "name", "balance", "updatedAt")
         SELECT 'acct-' || g, 'user' || g || '@example.com', 'User ' || g, 0, now()
         FROM generate_series(1, 100) g`
      );
      for (let round = 1; round <= leg.rounds; round += 1) {
        total += 1;
        head = (
          await runner().generate({
            name: `credit-${round}`,
            manualMigration: {
              transitions: [
                {
                  from: head,
                  execution: "transactional",
                  up: [
                    sql.raw(
                      `UPDATE "${namespace}"."accounts" SET "balance" = "balance" + 100`
                    ),
                  ],
                  rollback: { kind: "irreversible", reason: "test credit" },
                },
              ],
            },
          })
        ).stateId;
        const outcomes = await Promise.all(
          [runner(), runner()].map((migrations) =>
            migrations.apply().then(
              (result) => result.outcome,
              (error: unknown) =>
                error instanceof Error
                  ? String(Reflect.get(error, "code"))
                  : String(error)
            )
          )
        );
        const { rows } = await admin.query<{ low: number; high: number }>(
          `SELECT min("balance")::int AS low, max("balance")::int AS high FROM "${namespace}"."accounts"`
        );
        const locks = await advisoryLocks();
        const losers = outcomes.filter((outcome) => outcome !== "applied");
        const fine =
          rows[0]?.low === round * 100 &&
          rows[0]?.high === round * 100 &&
          locks === 0 &&
          losers.length === 1 &&
          losers.every(
            (loser) =>
              loser === "noop" ||
              loser === VibORMErrorCode.MIGRATION_MARKER_CONFLICT
          );
        if (!fine) {
          problems.push(
            `${leg.policy}${leg.reset ? "+discard" : ""} round ${round}: balance ${rows[0]?.low}..${rows[0]?.high} (want ${round * 100}), ${locks} lock(s), ${outcomes.join("+")}`
          );
        }
      }
    }
    expect(total).toBe(140);
    expect(problems).toEqual([]);
  }, 600_000);
});
