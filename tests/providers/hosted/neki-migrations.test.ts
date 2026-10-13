/**
 * Migration conformance on PlanetScale's Neki itself, which plans a statement
 * against the schema committed before its transaction
 * (`.probes/hosted/neki-boundaries-1.2.2.md`): a state that adds a column and
 * fills it applies as two committed parts, a failure between them leaves the
 * attempt open and the next apply runs only the rest, a history of schema,
 * data and mixed states applies in one run, a dispatch that no commit can
 * divide is refused before effects, and (1.2.3) a command holds the session
 * lock alone, Neki refusing to mix it with a transaction lock (`NK013`): a
 * transactional then a stepwise state apply in one run, every command hands
 * its connection back with its limits reset, a client pause between two
 * parts of a split state is within the default idle limit, and `down` lets
 * the lock and the idle limit go while its resolver answers.
 *
 * Runs only with NEKI_DEV_CONNECTION_STRING (a Neki development branch); each
 * run creates its own `viborm_neki_<random>` schemas and drops them.
 */

import { randomBytes } from "node:crypto";
import { createClient } from "@drivers/pg";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient, MemoryEstateStorage } from "@migrations";
import { s } from "@schema";
import { sql } from "@sql";
import {
  generateReportStates,
  REPORT_ROWS,
  reportSchema,
  seedReportRows,
} from "@tests/fixtures/neki-report-states";
import { commitsIn, recordingPgPool } from "@tests/fixtures/recording-pg-pool";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const NEKI_URL = process.env.NEKI_DEV_CONNECTION_STRING;
const TIMEOUT = 300_000;
const ROWS = 2000;

/** node-postgres reads `sslrootcert=system` as a file: verify against the system store instead. */
function poolConfig(url: string): pg.PoolConfig {
  const parsed = new URL(url);
  parsed.searchParams.delete("sslrootcert");
  parsed.searchParams.delete("sslmode");
  return {
    connectionString: parsed.toString(),
    ssl: { rejectUnauthorized: true },
    max: 4,
  };
}

const accounts = (nickname: boolean) => ({
  account: s
    .model({
      id: s.string().id(),
      email: s.string(),
      ...(nickname ? { nickname: s.string().nullable() } : {}),
    })
    .map("accounts"),
});

describe.skipIf(!NEKI_URL)("migrations on PlanetScale's Neki", () => {
  const prefix = `viborm_neki_${randomBytes(5).toString("hex")}`;
  const schemas: string[] = [];
  const config = NEKI_URL ? poolConfig(NEKI_URL) : {};
  const admin = new pg.Client(config);
  const recording = recordingPgPool(config);
  const clients: { $disconnect(): Promise<void> }[] = [];

  beforeAll(async () => {
    await admin.connect();
  });

  afterAll(async () => {
    await Promise.allSettled(clients.map((client) => client.$disconnect()));
    await recording.pool.end().catch(() => undefined);
    for (const namespace of schemas) {
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    const { rows } = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_catalog.pg_namespace WHERE nspname LIKE $1",
      [`${prefix}%`]
    );
    await admin.end();
    if (rows[0]?.n !== 0) {
      throw new Error(`${rows[0]?.n} scratch schemas of ${prefix} were left`);
    }
  }, TIMEOUT);

  async function schema(name: string): Promise<string> {
    const namespace = `${prefix}_${name}`;
    schemas.push(namespace);
    await admin.query(`CREATE SCHEMA "${namespace}"`);
    return namespace;
  }

  function migrationsFor(
    namespace: string,
    storage: MemoryEstateStorage,
    models: ReturnType<typeof accounts> | ReturnType<typeof reportSchema>,
    limits?: { readonly idleTimeout: number }
  ) {
    const client = createClient({
      pool: recording.pool,
      namespace,
      schema: models,
    });
    clients.push(client);
    return createMigrationClient(client, { storage, limits });
  }

  const forwardKinds = async (
    migrations: ReturnType<typeof migrationsFor>,
    states: readonly (string | null)[]
  ) =>
    (await migrations.log())
      .filter(
        (event) =>
          event.direction === "forward" && states.includes(event.toState)
      )
      .map((event) => event.kind);

  it(
    "applies a column and its backfill as two parts, and resumes only the backfill after a failure between them",
    async () => {
      const namespace = await schema("resume");
      const storage = new MemoryEstateStorage();
      const at = (nickname: boolean) =>
        migrationsFor(namespace, storage, accounts(nickname));
      const v1 = await at(false).generate({ name: "accounts" });
      await at(false).apply();
      await admin.query(
        `INSERT INTO "${namespace}"."accounts" ("id", "email") SELECT 'a' || g, 'a' || g || '@example.com' FROM generate_series(1, ${ROWS}) g`
      );
      const add = `ALTER TABLE "${namespace}"."accounts" ADD COLUMN "nickname" text`;
      const backfill = `UPDATE "${namespace}"."accounts" SET "nickname" = "email" WHERE "nickname" IS NULL`;
      const v2 = await at(true).generate({
        name: "nickname-and-backfill",
        manualMigration: {
          transitions: [
            {
              from: v1.stateId,
              execution: "transactional",
              up: [sql.raw(add), sql.raw(backfill)],
              rollback: { kind: "irreversible", reason: "test" },
            },
          ],
          destinationChecks: [
            {
              kind: "trusted-read",
              query: sql.raw(
                `SELECT NOT EXISTS (SELECT 1 FROM "${namespace}"."accounts" WHERE "nickname" IS NULL) AS ok`
              ),
              equals: true,
            },
          ],
        },
      });

      recording.fail = backfill;
      await expect(at(true).apply()).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_FAILED,
      });
      const failed = await at(true).status();
      expect(failed.marker?.stateId).toBe(v1.stateId);
      expect(failed.unfinished).toBe(true);
      expect(await forwardKinds(at(true), [v2.stateId])).toEqual([
        "started",
        "step-confirmed",
      ]);
      const { rows: columns } = await admin.query<{ name: string }>(
        "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'accounts'",
        [namespace]
      );
      expect(columns.map((row) => row.name)).toContain("nickname");

      recording.log.length = 0;
      await expect(at(true).apply()).resolves.toMatchObject({
        outcome: "applied",
        path: [v2.stateId],
        statements: [backfill],
      });
      expect(recording.log).not.toContain(add);
      expect(commitsIn(recording.log)).toBe(1);
      const { rows } = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${namespace}"."accounts" WHERE "nickname" = "email"`
      );
      expect(rows[0]?.n).toBe(ROWS);
      const done = await at(true).status();
      expect(done.marker?.stateId).toBe(v2.stateId);
      expect(done.unfinished).toBe(false);
      await expect(at(true).verify()).resolves.toEqual({ ok: true });
      expect(await forwardKinds(at(true), [v2.stateId])).toEqual([
        "started",
        "step-confirmed",
        "step-confirmed",
        "applied",
      ]);
    },
    TIMEOUT
  );

  /** The session settings the migration limits touch, on every pooled connection. */
  const pooledSettings = async () => {
    const held = await Promise.all(
      Array.from({ length: 4 }, () => recording.pool.connect())
    );
    try {
      return await Promise.all(
        held.map(async (client) => {
          const { rows } = await client.query<Record<string, string>>(
            "SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction, current_setting('idle_session_timeout') AS idle_session"
          );
          return rows[0];
        })
      );
    } finally {
      for (const client of held) client.release();
    }
  };

  it(
    "applies a transactional state then a stepwise one in one apply, and hands every connection back clean",
    async () => {
      const namespace = await schema("stepwise");
      const storage = new MemoryEstateStorage();
      const at = (nickname: boolean) =>
        migrationsFor(namespace, storage, accounts(nickname));
      await at(false).generate({ name: "accounts" });
      await at(false).apply();
      await admin.query(
        `INSERT INTO "${namespace}"."accounts" ("id", "email") SELECT 'a' || g, 'a' || g || '@example.com' FROM generate_series(1, ${ROWS}) g`
      );
      const clean = await pooledSettings();
      const v2 = await at(true).generate({ name: "nickname" });
      const filled = (all: boolean) => ({
        kind: "trusted-read" as const,
        query: sql.raw(
          `SELECT NOT EXISTS (SELECT 1 FROM "${namespace}"."accounts" WHERE "nickname" IS ${all ? "" : "NOT "}NULL) AS ok`
        ),
        equals: true,
      });
      const v3 = await at(true).generate({
        name: "stepwise-backfill",
        manualMigration: {
          transitions: [
            {
              from: v2.stateId,
              execution: "stepwise",
              originChecks: [filled(false)],
              up: [
                sql.raw(
                  `UPDATE "${namespace}"."accounts" SET "nickname" = "email" WHERE "nickname" IS NULL`
                ),
              ],
              rollback: { kind: "irreversible", reason: "test" },
            },
          ],
          destinationChecks: [filled(true)],
        },
      });

      recording.log.length = 0;
      await expect(at(true).apply()).resolves.toMatchObject({
        outcome: "applied",
        path: [v2.stateId, v3.stateId],
      });
      // The session lock alone, once; never the transaction lock.
      expect(
        recording.log.filter((text) => text.includes("pg_try_advisory_lock("))
      ).toHaveLength(1);
      expect(
        recording.log.some((text) => text.includes("pg_try_advisory_xact_lock"))
      ).toBe(false);
      expect(recording.log).toContain("RESET idle_session_timeout");
      await expect(at(true).status()).resolves.toMatchObject({
        unfinished: false,
      });
      await expect(at(true).verify()).resolves.toEqual({ ok: true });
      // Every pooled connection is back as it was: no migration limit left.
      expect(await pooledSettings()).toEqual(clean);
      const { rows } = await admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_catalog.pg_locks WHERE locktype = 'advisory'"
      );
      expect(rows[0]?.n).toBe(0);
    },
    TIMEOUT
  );

  it(
    "finishes a split state whose client pauses 2 s between its parts, within the default idle limit",
    async () => {
      const namespace = await schema("pause");
      const storage = new MemoryEstateStorage();
      const at = (nickname: boolean) =>
        migrationsFor(namespace, storage, accounts(nickname));
      const v1 = await at(false).generate({ name: "accounts" });
      await at(false).apply();
      const add = `ALTER TABLE "${namespace}"."accounts" ADD COLUMN "nickname" text`;
      const backfill = `UPDATE "${namespace}"."accounts" SET "nickname" = "email" WHERE "nickname" IS NULL`;
      const v2 = await at(true).generate({
        name: "nickname-and-backfill",
        manualMigration: {
          transitions: [
            {
              from: v1.stateId,
              execution: "transactional",
              up: [sql.raw(add), sql.raw(backfill)],
              rollback: { kind: "irreversible", reason: "test" },
            },
          ],
        },
      });
      recording.log.length = 0;
      // The second part's BEGIN: the session idles, holding the lock.
      recording.pause = { text: "BEGIN", skip: 1, ms: 2000 };
      await expect(at(true).apply()).resolves.toMatchObject({
        outcome: "applied",
        path: [v2.stateId],
      });
      expect(recording.pause).toBeUndefined();
      expect(commitsIn(recording.log)).toBe(2);
    },
    TIMEOUT
  );

  it(
    "rolls back after down's resolver answers past the idle limit, the lock and limits let go meanwhile",
    async () => {
      const namespace = await schema("resolver");
      const storage = new MemoryEstateStorage();
      const idle = { idleTimeout: 1000 };
      const at = (nickname: boolean) =>
        migrationsFor(namespace, storage, accounts(nickname), idle);
      const v1 = await at(false).generate({ name: "accounts" });
      await at(false).apply();
      await admin.query(
        `INSERT INTO "${namespace}"."accounts" ("id", "email") SELECT 'a' || g, 'a' || g || '@example.com' FROM generate_series(1, ${ROWS}) g`
      );
      await at(true).generate({ name: "nickname" });
      await at(true).apply();
      const locks: unknown[] = [];
      await expect(
        at(false).down({
          resolve: async (change) => {
            // An operator reading the prompt for three idle limits.
            await new Promise((resolve) => setTimeout(resolve, 3000));
            const { rows } = await admin.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM pg_catalog.pg_locks WHERE locktype = 'advisory'"
            );
            locks.push(rows[0]?.n);
            return change.type === "destructive" ? change.proceed() : undefined;
          },
        })
      ).resolves.toMatchObject({ preview: false });
      expect(locks).toEqual([0]);
      const status = await at(false).status();
      expect(status.marker?.stateId).toBe(v1.stateId);
      expect(status.unfinished).toBe(false);
    },
    TIMEOUT
  );

  it(
    "applies a pending history of schema, data and mixed states in one apply",
    async () => {
      const namespace = await schema("report");
      const storage = new MemoryEstateStorage();
      const at = (stage: number) =>
        migrationsFor(namespace, storage, reportSchema(stage));
      const v0 = await at(0).generate({ name: "people" });
      await at(0).apply();
      await admin.query(seedReportRows(namespace));
      const path = await generateReportStates(at, namespace, v0.stateId!);

      recording.log.length = 0;
      await expect(at(3).apply()).resolves.toMatchObject({
        outcome: "applied",
        path,
      });
      // The names' columns, then their backfill; the team schema; the
      // cleanup; the index; the last data state, which a literal naming the
      // index would otherwise plan without it.
      expect(commitsIn(recording.log)).toBe(5);
      expect(
        (await forwardKinds(at(3), path)).filter((kind) => kind === "applied")
      ).toHaveLength(path.length);
      const status = await at(3).status();
      expect(status.marker?.stateId).toBe(path.at(-1));
      expect(status.unfinished).toBe(false);
      await expect(at(3).verify()).resolves.toEqual({ ok: true });
      const { rows } = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${namespace}"."people" WHERE "firstName" || ' ' || "lastName" = "name"`
      );
      expect(rows[0]?.n).toBe(REPORT_ROWS);
    },
    TIMEOUT
  );

  it(
    "commits an index before a check that names it by a literal",
    async () => {
      const namespace = await schema("regclass");
      const storage = new MemoryEstateStorage();
      const at = (stage: number) =>
        migrationsFor(namespace, storage, reportSchema(stage));
      const v2 = await at(2).generate({ name: "notes" });
      await at(2).apply();
      const index = await at(3).generate({
        name: "notes-author-index",
        manualMigration: {
          transitions: [
            {
              from: v2.stateId,
              execution: "transactional",
              up: [
                sql.raw(
                  `CREATE INDEX "notes_author" ON "${namespace}"."notes" ("authorId")`
                ),
              ],
              rollback: { kind: "irreversible", reason: "test" },
            },
          ],
          destinationChecks: [
            {
              kind: "trusted-read",
              // Neki answers `to_regclass` for the committed schema: null for
              // an index its own transaction created.
              query: sql.raw(
                `SELECT pg_catalog.to_regclass('"${namespace}"."notes_author"') IS NOT NULL AS ok`
              ),
              equals: true,
            },
          ],
        },
      });
      recording.log.length = 0;
      await expect(at(3).apply()).resolves.toMatchObject({
        outcome: "applied",
        path: [index.stateId],
      });
      expect(commitsIn(recording.log)).toBe(2);
      await expect(at(3).verify()).resolves.toEqual({ ok: true });
    },
    TIMEOUT
  );

  it(
    "refuses before effects a dispatch whose statements need a commit between them",
    async () => {
      const namespace = await schema("dispatch");
      const storage = new MemoryEstateStorage();
      const at = (nickname: boolean) =>
        migrationsFor(namespace, storage, accounts(nickname));
      const v1 = await at(false).generate({ name: "accounts" });
      await at(false).apply();
      await at(true).generate({
        name: "nickname-in-one-dispatch",
        manualMigration: {
          transitions: [
            {
              from: v1.stateId,
              execution: "transactional",
              up: [
                sql.raw(
                  `ALTER TABLE "${namespace}"."accounts" ADD COLUMN "nickname" text; UPDATE "${namespace}"."accounts" SET "nickname" = "email"`
                ),
              ],
              rollback: { kind: "irreversible", reason: "test" },
            },
          ],
        },
      });
      await expect(at(true).apply()).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
        meta: { feature: "dependent statements in one dispatch" },
      });
      const status = await at(true).status();
      expect(status.marker?.stateId).toBe(v1.stateId);
      expect(status.unfinished).toBe(false);
    },
    TIMEOUT
  );
});
