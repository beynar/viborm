/**
 * The migration session's time limits against a real PostgreSQL server
 * (plan S1), where they are the difference between a migration that gives up
 * and an outage.
 *
 * - A migration whose DDL queues behind a long reader stalls every read that
 *   queues behind it. Under `lock_timeout` it gives up within the limit, the
 *   reads go through, and a retry applies. That holds for a stepwise program
 *   too, whose statements run bare on the session, outside any transaction.
 * - A runner that stops talking while it holds the migration lock (a frozen
 *   process, a half-open socket) is ended by the server within the idle limit,
 *   and the lock with it, instead of blocking every later command.
 *
 * Requires the Docker test database:
 *   PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/<db>
 */

import { createClient, PgDriver } from "@drivers/pg";
import { ConnectionError, VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations";
import { getMigrationDriver } from "@migrations/drivers";
import { withLockedMigrationProducer } from "@migrations/pinned-session";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { s } from "@schema";
import { sql } from "@sql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PG_CONNECTION = process.env.PG_TEST_CONNECTION_STRING;
const describeIfPg = PG_CONNECTION ? describe : describe.skip;

const NAMESPACE = "viborm_session_limits";
const STEPWISE_NAMESPACE = "viborm_session_limits_stepwise";
const ROWS = 10_000;
const LOCK_TIMEOUT_MS = 4000;
const IDLE_TIMEOUT_MS = 1000;

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
const v1Nickname = {
  account: s
    .model({ ...fields(), nickname: s.string().nullable() })
    .map("accounts"),
};
const v2 = {
  account: s
    .model({ ...fields(), nickname: s.string().nullable() })
    .index(["country"])
    .map("accounts"),
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The outcome of `promise` and when it settled. */
async function timed<T>(
  promise: Promise<T>
): Promise<{ value?: T; failure?: unknown; at: number }> {
  try {
    return { value: await promise, at: Date.now() };
  } catch (failure) {
    return { failure, at: Date.now() };
  }
}

describeIfPg("the migration session's limits on a real server", () => {
  const admin = new pg.Client({ connectionString: PG_CONNECTION });

  beforeAll(async () => {
    await admin.connect();
    for (const namespace of [NAMESPACE, STEPWISE_NAMESPACE]) {
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.query(`CREATE SCHEMA "${namespace}"`);
    }
  });

  afterAll(async () => {
    for (const namespace of [NAMESPACE, STEPWISE_NAMESPACE]) {
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    await admin.end();
  });

  /** Waits until a statement of this database is queued for a lock. */
  const queuedForLock = async (): Promise<boolean> => {
    const by = Date.now() + 5000;
    while (Date.now() < by) {
      const { rows } = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`
      );
      if ((rows[0]?.n ?? 0) > 0) return true;
      await sleep(25);
    }
    return false;
  };

  const advisoryLocks = async () => {
    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_catalog.pg_locks l
         JOIN pg_catalog.pg_database d ON d.oid = l.database
        WHERE l.locktype = 'advisory' AND d.datname = current_database()`
    );
    return rows[0]?.n ?? 0;
  };

  it("gives up on a blocked DDL within lock_timeout, so queued reads wait no longer, and a retry applies", async () => {
    const storage = new MemoryEstateStorage();
    const first = createClient({
      databaseUrl: PG_CONNECTION,
      namespace: NAMESPACE,
      schema: v1,
    });
    const second = createClient({
      databaseUrl: PG_CONNECTION,
      namespace: NAMESPACE,
      schema: v2,
    });
    const reader = new pg.Client({ connectionString: PG_CONNECTION });
    const app = new pg.Client({ connectionString: PG_CONNECTION });
    try {
      await createMigrationClient(first, { storage }).generate({ name: "v1" });
      await createMigrationClient(first, { storage }).apply();
      const migrations = createMigrationClient(second, { storage });
      await migrations.generate({ name: "v2" });
      await Promise.all([reader.connect(), app.connect()]);
      await app.query(
        `INSERT INTO "${NAMESPACE}"."accounts" ("id", "email", "name", "settings", "updatedAt")
         SELECT 'acct-' || g, 'user' || g || '@example.com', 'name-' || g, '{"plan":"pro"}'::jsonb, now()
         FROM generate_series(1, ${ROWS}) g`
      );
      await reader.query("BEGIN");
      await reader.query(`SELECT count(*) FROM "${NAMESPACE}"."accounts"`);

      const applying = timed(migrations.apply());
      // Wait until the migration's DDL is queued behind the reader.
      const queued = await queuedForLock();
      const queuedAt = Date.now();
      const read = await timed(
        app.query(`SELECT count(*)::int AS n FROM "${NAMESPACE}"."accounts"`)
      );
      const applied = await applying;
      await reader.query("COMMIT");

      expect(queued).toBe(true);
      expect(read.failure).toBeUndefined();
      expect(read.at - queuedAt).toBeLessThan(LOCK_TIMEOUT_MS + 1000);
      expect(applied.failure).toMatchObject({
        code: VibORMErrorCode.TRANSACTION_CONTENTION,
      });
      expect(applied.at - queuedAt).toBeLessThan(LOCK_TIMEOUT_MS + 2000);
      // Nothing of the attempt survived, and nothing holds the lock.
      expect(await advisoryLocks()).toBe(0);
      await expect(migrations.apply()).resolves.toMatchObject({
        outcome: "applied",
      });
      const { rows } = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${NAMESPACE}"."accounts" WHERE "nickname" IS NULL`
      );
      expect(rows[0]?.n).toBe(ROWS);
    } finally {
      await Promise.allSettled([reader.end(), app.end()]);
      await first.$disconnect();
      await second.$disconnect();
    }
  }, 30_000);

  it("gives up on a blocked stepwise statement within lock_timeout, with nothing applied", async () => {
    const storage = new MemoryEstateStorage();
    const client = (schema: typeof v1 | typeof v1Nickname) =>
      createClient({
        databaseUrl: PG_CONNECTION,
        namespace: STEPWISE_NAMESPACE,
        schema,
      });
    const first = client(v1);
    const second = client(v1Nickname);
    const reader = new pg.Client({ connectionString: PG_CONNECTION });
    const app = new pg.Client({ connectionString: PG_CONNECTION });
    const table = `"${STEPWISE_NAMESPACE}"."accounts"`;
    const nicknameCheck = (exists: boolean) => ({
      kind: "trusted-read" as const,
      query: sql.raw(
        `SELECT ${exists ? "" : "NOT "}EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${STEPWISE_NAMESPACE}' AND table_name = 'accounts' AND column_name = 'nickname') AS ok`
      ),
      equals: true,
    });
    try {
      await createMigrationClient(first, { storage }).generate({ name: "v1" });
      await createMigrationClient(first, { storage }).apply();
      const migrations = createMigrationClient(second, { storage });
      const origin = (await migrations.status()).marker?.stateId;
      if (origin === undefined) throw new Error("v1 is not applied");
      // A stepwise program: its ALTER runs on the session, in no transaction.
      await migrations.generate({
        name: "nickname",
        manualMigration: {
          transitions: [
            {
              from: origin,
              execution: "stepwise",
              originChecks: [nicknameCheck(false)],
              up: [sql.raw(`ALTER TABLE ${table} ADD COLUMN "nickname" text`)],
              rollback: {
                kind: "manual",
                execution: "stepwise",
                sql: [sql.raw(`ALTER TABLE ${table} DROP COLUMN "nickname"`)],
              },
            },
          ],
          destinationChecks: [nicknameCheck(true)],
        },
      });
      await Promise.all([reader.connect(), app.connect()]);
      await app.query(
        `INSERT INTO ${table} ("id", "email", "name", "settings", "updatedAt")
         SELECT 'acct-' || g, 'user' || g || '@example.com', 'name-' || g, '{"plan":"pro"}'::jsonb, now()
         FROM generate_series(1, ${ROWS}) g`
      );
      await reader.query("BEGIN");
      await reader.query(`SELECT count(*) FROM ${table}`);

      const applying = timed(migrations.apply());
      const queued = await queuedForLock();
      const queuedAt = Date.now();
      const read = await timed(
        app.query(`SELECT count(*)::int AS n FROM ${table}`)
      );
      const applied = await applying;
      await reader.query("COMMIT");

      expect(queued).toBe(true);
      expect(read.failure).toBeUndefined();
      expect(read.at - queuedAt).toBeLessThan(LOCK_TIMEOUT_MS + 1000);
      expect(applied.at - queuedAt).toBeLessThan(LOCK_TIMEOUT_MS + 2000);
      // A stepwise statement's outcome is reported as ambiguous by design;
      // what gave up is the lock wait.
      expect(applied.failure).toMatchObject({
        cause: { code: VibORMErrorCode.TRANSACTION_CONTENTION },
      });
      expect(await advisoryLocks()).toBe(0);
      const { rows } = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_schema = '${STEPWISE_NAMESPACE}' AND column_name = 'nickname'`
      );
      expect(rows[0]?.n).toBe(0);
    } finally {
      await Promise.allSettled([reader.end(), app.end()]);
      await first.$disconnect();
      await second.$disconnect();
    }
  }, 30_000);

  it.each([
    ["between statements", false],
    ["inside a transaction", true],
  ])(
    "ends a runner that stops talking %s, and the lock with it",
    async (_label, inTransaction) => {
      const driver = new PgDriver({
        databaseUrl: PG_CONNECTION,
        namespace: NAMESPACE,
      });
      try {
        let goneAfter: number | undefined;
        const silent = async () => {
          const since = Date.now();
          while (Date.now() - since < 4000) {
            if ((await advisoryLocks()) === 0) {
              goneAfter = Date.now() - since;
              return;
            }
            await sleep(50);
          }
        };
        const failure = await withLockedMigrationProducer(
          driver,
          getMigrationDriver(driver),
          async (pinned) => {
            expect(await advisoryLocks()).toBe(1);
            if (inTransaction) {
              await pinned.withTransaction(async (tx) => {
                await tx._executeRaw("SELECT 1");
                await silent();
                await tx._executeRaw("SELECT 1");
              });
            } else {
              await silent();
            }
            await pinned._executeRaw("SELECT 1");
          }
        ).catch((error: unknown) => error);

        // The server ended the silent session within about its idle limit, and
        // the runner got the retryable connection failure, nothing written to
        // the dead connection.
        expect(goneAfter).toBeDefined();
        expect(goneAfter).toBeLessThan(IDLE_TIMEOUT_MS + 1000);
        expect(failure).toBeInstanceOf(ConnectionError);
        expect(failure).toMatchObject({
          code: VibORMErrorCode.CONNECTION_FAILED,
        });
        // The next command is not blocked by it.
        await expect(
          withLockedMigrationProducer(
            driver,
            getMigrationDriver(driver),
            async () => "next"
          )
        ).resolves.toBe("next");
      } finally {
        await driver.disconnect();
      }
    },
    20_000
  );
});
