/**
 * T5b against a real PostgreSQL server, where "blocks no write" can be seen:
 * another session keeps writing while a `generate({ lowLock: true })` state
 * builds its index or validates its key, and a build whose session is killed
 * half-way leaves one unfinished attempt that `resolve` settles before `apply`
 * resumes.
 *
 * Realistic scale: an `accounts` table of fifteen fields holding 200,000 rows.
 * The waits are made deterministic by an application transaction left open
 * on the table: a plain `CREATE INDEX` queues behind it and every later write
 * queues behind the build; `CREATE INDEX CONCURRENTLY` waits for it too, but
 * takes no lock a write needs. `VALIDATE CONSTRAINT` is held the same way by a
 * session holding the lock a running VACUUM or ANALYZE holds.
 *
 * Requires the Docker test database:
 *   PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/<db>
 */

import type { Schema } from "@client/types";
import { createClient } from "@drivers/pg";
import { createMigrationClient } from "@migrations";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { s } from "@schema";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PG_CONNECTION = process.env.PG_TEST_CONNECTION_STRING;
const describeIfPg = PG_CONNECTION ? describe : describe.skip;

const NAMESPACES = [
  "viborm_t5b_blocking",
  "viborm_t5b_steps",
  "viborm_t5b_cut",
];
const ROWS = 200_000;
const INDEX_BUILD = /^CREATE INDEX/;
const VALIDATION = /VALIDATE CONSTRAINT/;

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
  orgId: s.string().nullable(),
  deletedAt: s.dateTime().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});

/**
 * `orgs` and `accounts`; `indexed` adds an index on `country`, `linked` the
 * account → org key. `.index` needs a model of one fixed shape, so each of
 * the three is spelled out.
 */
function schemaWith(options: { indexed?: boolean; linked?: boolean }): Schema {
  const org = s
    .model({
      id: s.string().id(),
      name: s.string(),
      ...(options.linked ? { accounts: s.toMany(() => account) } : {}),
    })
    .map("orgs");
  const relation = () =>
    s
      .toOne(() => org)
      .fields("orgId")
      .references("id");
  const account = (() => {
    if (!options.indexed) return s.model(fields());
    if (!options.linked) return s.model(fields()).index(["country"]);
    return s.model({ ...fields(), org: relation() }).index(["country"]);
  })().map("accounts");
  return { org, account };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The outcome of `promise`, settled. */
async function settled<T>(
  promise: Promise<T>
): Promise<{ value?: T; failure?: unknown }> {
  try {
    return { value: await promise };
  } catch (failure) {
    return { failure };
  }
}

describeIfPg("low-lock steps on a real server, 200,000 rows", () => {
  const admin = new pg.Client({ connectionString: PG_CONNECTION });
  const clients: { $disconnect(): Promise<void> }[] = [];

  beforeAll(async () => {
    await admin.connect();
    for (const namespace of NAMESPACES) {
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.query(`CREATE SCHEMA "${namespace}"`);
    }
  });

  afterAll(async () => {
    await Promise.allSettled(clients.map((client) => client.$disconnect()));
    for (const namespace of NAMESPACES) {
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    await admin.end();
  });

  /** A seeded namespace, its v2 generated, and two application sessions. */
  async function seeded(
    namespace: string,
    target: Parameters<typeof schemaWith>[0],
    lowLock: boolean
  ) {
    const storage = new MemoryEstateStorage();
    const migrationsFor = (shape: Parameters<typeof schemaWith>[0]) => {
      const client = createClient({
        databaseUrl: PG_CONNECTION,
        namespace,
        schema: schemaWith(shape),
      });
      clients.push(client);
      return createMigrationClient(client, { storage });
    };
    const first = migrationsFor({});
    await first.generate({ name: "v1" });
    await first.apply();
    await admin.query(
      `INSERT INTO "${namespace}"."orgs" ("id", "name") SELECT 'org-' || g, 'Org ' || g FROM generate_series(1, 50) g;
       INSERT INTO "${namespace}"."accounts" ("id", "email", "name", "settings", "orgId", "updatedAt")
       SELECT 'acct-' || g, 'user' || g || '@example.com', 'name-' || g, '{"plan":"pro"}'::jsonb, 'org-' || (1 + g % 50), now()
       FROM generate_series(1, ${ROWS}) g;
       ANALYZE "${namespace}"."accounts";`
    );
    const migrations = migrationsFor(target);
    await migrations.generate({ name: "v2", lowLock });
    const open = new pg.Client({ connectionString: PG_CONNECTION });
    const next = new pg.Client({ connectionString: PG_CONNECTION });
    await Promise.all([open.connect(), next.connect()]);
    /** One account written by `session`, which may wait at most a second. */
    const write = (session: pg.Client, id: string) =>
      session.query(
        `SET lock_timeout = '1s'; INSERT INTO "${namespace}"."accounts" ("id", "email", "name", "updatedAt") VALUES ('${id}', '${id}@example.com', '${id}', now())`
      );
    /** The pid of this namespace's `statement` once it waits for a lock. */
    const waiting = async (statement: RegExp): Promise<number | undefined> => {
      const by = Date.now() + 10_000;
      while (Date.now() < by) {
        const { rows } = await admin.query<{ pid: number; query: string }>(
          `SELECT pid, query FROM pg_catalog.pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%"${namespace}"."accounts"%'`
        );
        const found = rows.find((row) => statement.test(row.query.trim()));
        if (found) return found.pid;
        await sleep(25);
      }
      return;
    };
    const end = () => Promise.allSettled([open.end(), next.end()]);
    return { migrations, open, next, write, waiting, end, namespace };
  }

  const invalidIndexes = async (namespace: string) =>
    (
      await admin.query<{ name: string }>(
        `SELECT i.relname AS name FROM pg_catalog.pg_index x
           JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
          WHERE i.relnamespace = '"${namespace}"'::regnamespace AND NOT x.indisvalid`
      )
    ).rows.map(({ name }) => name);

  it("without lowLock, an index build behind an open write blocks the next write", async () => {
    const { migrations, open, next, write, waiting, end } = await seeded(
      NAMESPACES[0]!,
      { indexed: true },
      false
    );
    try {
      await open.query("BEGIN");
      await write(open, "open-1");
      const applying = settled(migrations.apply());
      expect(await waiting(INDEX_BUILD)).toBeDefined();
      // The write queues behind the build's SHARE lock and gives up.
      await expect(write(next, "next-1")).rejects.toMatchObject({
        code: "55P03",
      });
      await open.query("COMMIT");
      expect((await applying).value).toMatchObject({ outcome: "applied" });
    } finally {
      await end();
    }
  }, 60_000);

  it("with lowLock, writes keep flowing while the index builds and the key validates", async () => {
    const { migrations, open, next, write, waiting, end, namespace } =
      await seeded(NAMESPACES[1]!, { indexed: true, linked: true }, true);
    try {
      // Up to the state that adds the key NOT VALID: the last step.
      const steps = (await migrations.list())
        .filter(({ name }) => name.startsWith("v2 (step"))
        .sort((a, b) => a.name.localeCompare(b.name));
      await open.query("BEGIN");
      await write(open, "open-1");
      let applying = settled(
        migrations.apply({ to: { id: steps.at(-1)!.stateId } })
      );
      expect(await waiting(INDEX_BUILD)).toBeDefined();
      // The build waits for the open write, yet takes no lock the next needs.
      await expect(write(next, "next-1")).resolves.toBeDefined();
      await open.query("COMMIT");
      expect((await applying).value).toMatchObject({ outcome: "applied" });
      // The validation waits behind a VACUUM-strength lock; writes do not.
      await open.query("BEGIN");
      await open.query(
        `LOCK TABLE "${namespace}"."accounts" IN SHARE UPDATE EXCLUSIVE MODE`
      );
      applying = settled(migrations.apply());
      expect(await waiting(VALIDATION)).toBeDefined();
      await expect(write(next, "next-2")).resolves.toBeDefined();
      await open.query("COMMIT");
      expect((await applying).value).toMatchObject({ outcome: "applied" });
      expect(await invalidIndexes(namespace)).toEqual([]);
      const { rows } = await admin.query(
        `SELECT convalidated FROM pg_catalog.pg_constraint WHERE conname = 'accounts_orgId_fkey' AND connamespace = '"${namespace}"'::regnamespace`
      );
      expect(rows).toEqual([{ convalidated: true }]);
      await expect(migrations.verify()).resolves.toMatchObject({ ok: true });
    } finally {
      await end();
    }
  }, 60_000);

  it("an index build whose session is killed resolves either way, and apply resumes", async () => {
    const { migrations, open, write, waiting, end, namespace } = await seeded(
      NAMESPACES[2]!,
      { indexed: true },
      true
    );
    try {
      await open.query("BEGIN");
      await write(open, "open-1");
      const applying = settled(migrations.apply());
      const pid = await waiting(INDEX_BUILD);
      expect(pid).toBeDefined();
      await admin.query("SELECT pg_catalog.pg_terminate_backend($1)", [pid]);
      expect((await applying).failure).toBeDefined();
      await open.query("COMMIT");
      // The build left its index INVALID and one unfinished attempt.
      expect(await invalidIndexes(namespace)).toEqual(["accounts_country_idx"]);
      expect(await migrations.status()).toMatchObject({
        unfinished: true,
        invalidIndexes: [{ table: "accounts", index: "accounts_country_idx" }],
      });
      await expect(
        migrations.resolve({ outcome: "rolled-back" })
      ).resolves.toEqual({ outcome: "rolled-back" });
      expect(await invalidIndexes(namespace)).toEqual([]);
      expect(await migrations.status()).toMatchObject({ unfinished: false });
      await expect(migrations.apply()).resolves.toMatchObject({
        outcome: "applied",
      });
      await expect(migrations.verify()).resolves.toMatchObject({ ok: true });
    } finally {
      await end();
    }
  }, 60_000);
});
