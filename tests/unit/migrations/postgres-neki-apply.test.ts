/**
 * The effectful migration commands on PlanetScale's Neki, on PGlite made to
 * refuse what Neki refuses (measured on Neki's PostgreSQL 18.6,
 * `.probes/hosted/neki-apply-1.2.0.md` and `neki-boundaries-1.2.2.md`):
 * - a temporary relation (`NK013`): the partial-index predicate canonicalizer
 *   used temporary views;
 * - a row statement (or a `DO` block) naming a relation, column, type or
 *   sequence created, renamed or retyped earlier in its own transaction
 *   (`42P01`, `42703`, `42704`), or reading `*` of a relation whose columns
 *   it changed: Neki plans it against the committed schema. Schema
 *   statements and catalog reads see the transaction's changes;
 * - a column type change, rename or drop of a relation created or renamed
 *   earlier in the same transaction (`NK316`);
 * - a session advisory lock and a transaction one in the same session
 *   (`NK013`, "Mixing session and transaction advisory locks is
 *   unavailable"): either kind while the other is held;
 * - `set_config` with a computed setting name: in a routine body (`42501`),
 *   or over `pg_settings` rows in a query (`NK013`).
 * The same flows run on plain PGlite, where apply keeps one transaction per
 * group and opens no attempt it leaves open.
 */

import { createClient } from "@drivers/pglite";
import { CLEANUP_BOUND_MS } from "@drivers/shared/pinned-session";
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
import {
  asNeki,
  COMPUTED_SETTING,
  SESSION_LOCK,
  XACT_LOCK,
} from "@tests/fixtures/neki-simulation";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { beforeAll, describe, expect, it } from "vitest";
import { softDeleteAccounts } from "./_catalog-digest-corpus";

const ADD_NICKNAME = (namespace: string) =>
  sql.raw(`ALTER TABLE "${namespace}"."accounts" ADD COLUMN "nickname" text`);
const BACKFILL = (namespace: string) =>
  sql.raw(
    `UPDATE "${namespace}"."accounts" SET "nickname" = "email" WHERE "nickname" IS NULL`
  );
const ROW_COUNT = 2000;
/** Whether every account's nickname is filled, or not one is. */
const filled = (namespace: string, all: boolean) => ({
  kind: "trusted-read" as const,
  query: sql.raw(
    all
      ? `SELECT NOT EXISTS (SELECT 1 FROM "${namespace}"."accounts" WHERE "nickname" IS NULL) AS ok`
      : `SELECT NOT EXISTS (SELECT 1 FROM "${namespace}"."accounts" WHERE "nickname" IS NOT NULL) AS ok`
  ),
  equals: true,
});
/** The transactions one command committed, as its log shows them. */
const commitsIn = (log: readonly string[]) =>
  log.filter((text) => text === "COMMIT").length;
/**
 * One forward attempt run stepwise, as every one is on Neki: an opaque step
 * is announced, then answered (two `step-confirmed`), a proven one answered.
 */
const stepwise = (confirmed: number) => [
  "started",
  ...new Array<string>(confirmed).fill("step-confirmed"),
  "applied",
];

const database = openTestPGlite();
const simulation = asNeki(database);

describe.each([
  ["PostgreSQL", false],
  ["Neki", true],
])("migration commands on %s", (_label, neki) => {
  const { refusals, log } = simulation;
  beforeAll(() => {
    simulation.enabled = neki;
  });
  const estate = async (namespace: string) => {
    await database.exec(`CREATE SCHEMA "${namespace}"`);
    const storage = new MemoryEstateStorage();
    const migrations = (nickname = false) =>
      createMigrationClient(
        createClient({
          client: database,
          schema: softDeleteAccounts(nickname),
          namespace,
        }),
        { storage }
      );
    return migrations;
  };
  const columns = async (namespace: string) =>
    (
      await database.query<{ name: string }>(
        "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'accounts' ORDER BY 1",
        [namespace]
      )
    ).rows.map((row) => row.name);
  const seedAccounts = (namespace: string) =>
    database.exec(
      `INSERT INTO "${namespace}"."accounts" ("id", "email") SELECT 'a' || g, 'a' || g || '@example.com' FROM generate_series(1, ${ROW_COUNT}) g`
    );
  const backfilled = async (namespace: string) =>
    (
      await database.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${namespace}"."accounts" WHERE "nickname" = "email"`
      )
    ).rows[0]?.n;
  const mixedState = async (
    migrations: Awaited<ReturnType<typeof estate>>,
    namespace: string,
    from: string
  ) =>
    migrations(true).generate({
      name: "nickname-and-backfill",
      manualMigration: {
        transitions: [
          {
            from,
            execution: "transactional",
            up: [ADD_NICKNAME(namespace), BACKFILL(namespace)],
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
  /** The kinds of one state's forward ledger events, in order. */
  const eventsOf = async (
    migrations: Awaited<ReturnType<typeof estate>>,
    toState: string | null
  ) =>
    (await migrations(true).log())
      .filter(
        (event) => event.toState === toState && event.direction === "forward"
      )
      .map((event) => event.kind);

  it("applies a first state with partial indexes, then verifies it and proves its no-op", async () => {
    const migrations = await estate(`neki_first_${neki}`);
    const v1 = await migrations().generate({ name: "v1" });

    await expect(migrations().apply()).resolves.toMatchObject({
      outcome: "applied",
    });
    expect((await migrations().status()).marker?.stateId).toBe(v1.stateId);
    await expect(migrations().verify()).resolves.toEqual({ ok: true });
    await expect(migrations().apply()).resolves.toMatchObject({
      outcome: "noop",
    });
    // No scratch view outlives its transaction.
    const { rows } = await database.query(
      "SELECT relname FROM pg_catalog.pg_class WHERE relname LIKE 'viborm_index_predicate_%'"
    );
    expect(rows).toEqual([]);
    expect(refusals).toEqual([]);
  });

  it("applies a transactional state then a stepwise one in one apply, under one session lock on Neki and transaction locks on PostgreSQL", async () => {
    const namespace = `neki_stepwise_${neki}`;
    const migrations = await estate(namespace);
    await migrations().generate({ name: "v1" });
    await migrations().apply();
    await seedAccounts(namespace);
    const v2 = await migrations(true).generate({ name: "nickname" });
    const v3 = await migrations(true).generate({
      name: "stepwise-backfill",
      manualMigration: {
        transitions: [
          {
            from: v2.stateId,
            execution: "stepwise",
            originChecks: [filled(namespace, false)],
            up: [BACKFILL(namespace)],
            rollback: { kind: "irreversible", reason: "test" },
          },
        ],
        destinationChecks: [filled(namespace, true)],
      },
    });

    log.length = 0;
    await expect(migrations(true).apply()).resolves.toMatchObject({
      outcome: "applied",
      path: [v2.stateId, v3.stateId],
    });
    expect(await backfilled(namespace)).toBe(ROW_COUNT);
    const xact = log.filter((text) => XACT_LOCK.test(text));
    const session = log.filter((text) => SESSION_LOCK.test(text));
    // One session lock either way: Neki holds it from the start and takes no
    // transaction lock; PostgreSQL escalates to it from a locked transaction.
    expect(session).toHaveLength(1);
    expect(xact.length === 0).toBe(neki);
    expect(refusals).toEqual([]);
    await expect(migrations(true).verify()).resolves.toEqual({ ok: true });
  });

  it("returns the session clean after a command that held the session lock and its limits", async () => {
    const namespace = `neki_limits_${neki}`;
    const migrations = await estate(namespace);
    await migrations().generate({ name: "v1" });
    const show = async () =>
      (
        await database.query<{ lock: string; statement: string }>(
          "SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement"
        )
      ).rows[0];
    const clean = await show();
    log.length = 0;
    await migrations().apply();
    await migrations().status();
    await migrations().verify();
    // Constant names only: the limits Neki refuses computed are never sent.
    expect(log.some((text) => COMPUTED_SETTING.test(text))).toBe(false);
    if (neki) expect(log).toContain("RESET lock_timeout");
    expect(await show()).toEqual(clean);
    expect(refusals).toEqual([]);
  });

  it("names the provider's SQLSTATE on a refused lock statement (V11005)", async () => {
    const migrations = await estate(`neki_lock_refused_${neki}`);
    await migrations().generate({ name: "v1" });
    simulation.fail = neki
      ? "pg_try_advisory_lock("
      : "pg_try_advisory_xact_lock(";
    simulation.skip = 0;
    try {
      await expect(migrations().apply()).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_LOCK_FAILED,
        meta: { providerSqlState: "XX000" },
      });
    } finally {
      simulation.fail = undefined;
    }
  });

  it("applies a state that adds a column and backfills it: one transaction on PostgreSQL, each statement committed alone on Neki", async () => {
    const namespace = `neki_combined_${neki}`;
    const migrations = await estate(namespace);
    const v1 = await migrations().generate({ name: "v1" });
    await migrations().apply();
    await seedAccounts(namespace);
    const v2 = await mixedState(migrations, namespace, v1.stateId!);

    log.length = 0;
    await expect(migrations(true).apply()).resolves.toMatchObject({
      outcome: "applied",
      path: [v2.stateId],
    });
    const commits = commitsIn(log);
    expect(await backfilled(namespace)).toBe(ROW_COUNT);
    const status = await migrations(true).status();
    expect(status.marker?.stateId).toBe(v2.stateId);
    expect(status.unfinished).toBe(false);
    await expect(migrations(true).verify()).resolves.toEqual({ ok: true });
    // PostgreSQL: one transaction, whose rollback is the proof of each step.
    // Neki: no transaction, which its router may refuse every statement
    // after a schema change in: each step commits alone, announced and
    // answered in its own, then the checks and the marker.
    expect(commits).toBe(neki ? 0 : 1);
    expect(await eventsOf(migrations, v2.stateId)).toEqual(
      neki ? stepwise(4) : ["applied"]
    );
    expect(refusals).toEqual([]);
  });

  it("applies pending schema, data and mixed states in one apply, grouped as Neki needs", async () => {
    const namespace = `neki_report_${neki}`;
    await database.exec(`CREATE SCHEMA "${namespace}"`);
    const storage = new MemoryEstateStorage();
    const at = (stage: number) =>
      createMigrationClient(
        createClient({
          client: database,
          schema: reportSchema(stage),
          namespace,
        }),
        { storage }
      );
    const v0 = await at(0).generate({ name: "people" });
    await at(0).apply();
    await database.exec(seedReportRows(namespace));
    const path = await generateReportStates(at, namespace, v0.stateId!);

    log.length = 0;
    await expect(at(3).apply()).resolves.toMatchObject({
      outcome: "applied",
      path,
    });
    const commits = commitsIn(log);
    const status = await at(3).status();
    expect(status.marker?.stateId).toBe(path.at(-1));
    expect(status.unfinished).toBe(false);
    await expect(at(3).verify()).resolves.toEqual({ ok: true });
    const count = async (text: string) =>
      (await database.query<{ n: number }>(text)).rows[0]?.n;
    expect(
      await count(
        `SELECT count(*)::int AS n FROM "${namespace}"."people" WHERE "firstName" || ' ' || "lastName" = "name"`
      )
    ).toBe(REPORT_ROWS);
    expect(
      await count(`SELECT count(*)::int AS n FROM "${namespace}"."notes"`)
    ).toBe(REPORT_ROWS - REPORT_ROWS / 10);
    // PostgreSQL: the whole path is one transaction, as before. Neki: every
    // state stepwise, each statement committed alone.
    expect(commits).toBe(neki ? 0 : 1);
    const events = (await at(3).log()).filter(
      (event) => event.direction === "forward" && path.includes(event.toState!)
    );
    expect(events.map((event) => event.kind)).toEqual(
      neki
        ? [
            ...stepwise(6),
            ...stepwise(2),
            ...stepwise(4),
            ...stepwise(1),
            ...stepwise(2),
          ]
        : ["applied", "applied", "applied", "applied", "applied"]
    );
    expect(refusals).toEqual([]);
  });

  it("leaves a split state unfinished after a failure between its parts, and the next apply runs only what is left", async () => {
    const namespace = `neki_resume_${neki}`;
    const migrations = await estate(namespace);
    const v1 = await migrations().generate({ name: "v1" });
    await migrations().apply();
    await seedAccounts(namespace);
    const v2 = await mixedState(migrations, namespace, v1.stateId!);

    simulation.fail = `SET "nickname" = "email"`;
    await expect(migrations(true).apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
    });
    const failed = await migrations(true).status();
    expect(failed.marker?.stateId).toBe(v1.stateId);
    expect(failed.pending).toEqual([v2.stateId]);
    if (neki) {
      // The column committed; the backfill did not.
      expect(failed.unfinished).toBe(true);
      expect(await columns(namespace)).toContain("nickname");
      expect(await backfilled(namespace)).toBe(0);
      // The column's step answered; the backfill's announced, then answered
      // as refused whole: nothing of it committed.
      expect(await eventsOf(migrations, v2.stateId)).toEqual([
        "started",
        "step-confirmed",
        "step-confirmed",
        "step-confirmed",
        "step-confirmed",
      ]);
      await expect(
        migrations(true).apply({ dryRun: true })
      ).resolves.toMatchObject({
        outcome: "preview",
        statements: [BACKFILL(namespace).toStatement()],
      });
      // Other commands still see an attempt they may not touch.
      await expect(migrations(true).down()).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT,
      });
    } else {
      // One transaction: nothing of the state is left, nothing is open.
      expect(failed.unfinished).toBe(false);
      expect(failed.lastFailure?.toState).toBe(v2.stateId);
      expect(await columns(namespace)).not.toContain("nickname");
    }

    log.length = 0;
    await expect(migrations(true).apply()).resolves.toMatchObject({
      outcome: "applied",
      path: [v2.stateId],
      ...(neki ? { statements: [BACKFILL(namespace).toStatement()] } : {}),
    });
    // The committed ALTER TABLE is not sent again.
    expect(log.some((text) => text.includes('ADD COLUMN "nickname"'))).toBe(
      !neki
    );
    expect(commitsIn(log)).toBe(neki ? 0 : 1);
    expect(await backfilled(namespace)).toBe(ROW_COUNT);
    const done = await migrations(true).status();
    expect(done.marker?.stateId).toBe(v2.stateId);
    expect(done.unfinished).toBe(false);
    await expect(migrations(true).verify()).resolves.toEqual({ ok: true });
    expect(await eventsOf(migrations, v2.stateId)).toEqual(
      neki ? stepwise(6) : ["failed", "applied"]
    );
    expect(refusals).toEqual([]);
  });

  it("refuses, on Neki only and before effects, one dispatch whose statements need a commit between them", async () => {
    const namespace = `neki_dispatch_${neki}`;
    const migrations = await estate(namespace);
    const v1 = await migrations().generate({ name: "v1" });
    await migrations().apply();
    await seedAccounts(namespace);
    const v2 = await migrations(true).generate({
      name: "nickname-in-one-dispatch",
      manualMigration: {
        transitions: [
          {
            from: v1.stateId,
            execution: "transactional",
            up: [
              sql.raw(
                `${ADD_NICKNAME(namespace).toStatement()}; ${BACKFILL(namespace).toStatement()}`
              ),
            ],
            rollback: { kind: "irreversible", reason: "test" },
          },
        ],
      },
    });

    const applying = migrations(true).apply();
    if (!neki) {
      // Not refused: PGlite's extended protocol then takes one statement per
      // query (42601), where node-postgres sends both.
      await expect(applying).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_FAILED,
        meta: { providerSqlState: "42601" },
      });
      return;
    }
    await expect(applying).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
      message: expect.stringContaining(
        "statement 1 of this migration runs UPDATE after ALTER TABLE in one dispatch"
      ),
      meta: { feature: "dependent statements in one dispatch" },
    });
    expect(await columns(namespace)).not.toContain("nickname");
    const status = await migrations(true).status();
    expect(status.marker?.stateId).toBe(v1.stateId);
    expect(status.pending).toEqual([v2.stateId]);
    expect(status.unfinished).toBe(false);
    expect(refusals).toEqual([]);
  });

  it("applies the schema change and its backfill as two states in one run, then rolls the backfill back", async () => {
    const namespace = `neki_split_${neki}`;
    const migrations = await estate(namespace);
    await migrations().generate({ name: "v1" });
    await migrations().apply();
    await seedAccounts(namespace);
    const schema = await migrations(true).generate({ name: "nickname" });
    const backfill = await migrations(true).generate({
      name: "backfill",
      manualMigration: {
        transitions: [
          {
            from: schema.stateId,
            execution: "transactional",
            up: [BACKFILL(namespace)],
            rollback: {
              kind: "manual",
              execution: "transactional",
              sql: [
                sql.raw(
                  `UPDATE "${namespace}"."accounts" SET "nickname" = NULL`
                ),
              ],
            },
          },
        ],
      },
    });

    log.length = 0;
    await expect(migrations(true).apply()).resolves.toMatchObject({
      outcome: "applied",
      path: [schema.stateId, backfill.stateId],
    });
    // Neki: no transaction; each statement commits alone.
    expect(commitsIn(log)).toBe(neki ? 0 : 1);
    expect(await backfilled(namespace)).toBe(ROW_COUNT);
    expect((await migrations(true).status()).marker?.stateId).toBe(
      backfill.stateId
    );
    await expect(migrations(true).verify()).resolves.toEqual({ ok: true });

    await migrations(true).down();
    expect(await backfilled(namespace)).toBe(0);
    expect((await migrations(true).status()).marker?.stateId).toBe(
      schema.stateId
    );
    expect(refusals).toEqual([]);
  });

  /** v1, 2,000 accounts, then v2's generated `nickname` column, applied. */
  const nicknameApplied = async (namespace: string) => {
    const migrations = await estate(namespace);
    const v1 = await migrations().generate({ name: "v1" });
    await migrations().apply();
    await seedAccounts(namespace);
    await migrations(true).generate({ name: "nickname" });
    await migrations(true).apply();
    return { migrations, v1: v1.stateId };
  };
  const advisoryLocks = async () =>
    (
      await database.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_catalog.pg_locks WHERE locktype = 'advisory'"
      )
    ).rows[0]?.n;
  const lockTimeout = async () =>
    (
      await database.query<{ value: string }>(
        "SELECT current_setting('lock_timeout') AS value"
      )
    ).rows[0]?.value;

  it("lets the lock and the session's limits go while down's resolver answers, then takes them again", async () => {
    const namespace = `neki_resolver_gap_${neki}`;
    const { migrations, v1 } = await nicknameApplied(namespace);
    const clean = await lockTimeout();
    const seen: unknown[] = [];
    await expect(
      migrations(false).down({
        resolve: async (change) => {
          // An operator reading the prompt: no lock held, no idle limit.
          seen.push({
            locks: await advisoryLocks(),
            lock: await lockTimeout(),
          });
          return change.type === "destructive" ? change.proceed() : undefined;
        },
      })
    ).resolves.toMatchObject({ preview: false });
    expect(seen).toEqual([{ locks: 0, lock: clean }]);
    expect(await columns(namespace)).not.toContain("nickname");
    expect((await migrations(false).status()).marker?.stateId).toBe(v1);
    expect(await advisoryLocks()).toBe(0);
    expect(await lockTimeout()).toBe(clean);
    expect(refusals).toEqual([]);
  });

  it("loses the session within the cleanup bound when the reset before down's resolver is never answered", async () => {
    const namespace = `neki_resolver_hang_${neki}`;
    const { migrations } = await nicknameApplied(namespace);
    let asked = false;
    simulation.hang = neki ? "RESET" : undefined;
    const started = performance.now();
    const outcome = migrations(false)
      .down({
        resolve: async (change) => {
          asked = true;
          return change.type === "destructive" ? change.proceed() : undefined;
        },
      })
      .then(
        () => "resolved",
        () => "rejected"
      );
    try {
      if (!neki) {
        await expect(outcome).resolves.toBe("resolved");
        return;
      }
      // Unbounded, the reset waits forever holding the lock (Devin, #100).
      await expect(outcome).resolves.toBe("rejected");
      expect(performance.now() - started).toBeLessThan(CLEANUP_BOUND_MS + 5000);
      expect(asked).toBe(false);
    } finally {
      simulation.hang = undefined;
      // One PGlite backend serves every session: free what the lost one held.
      await database.query("SELECT pg_catalog.pg_advisory_unlock_all()");
      await database.query("RESET ALL");
    }
  }, 30_000);

  it("bounds each reset before down's resolver on its own: slow but answered resets still reach it", async () => {
    const namespace = `neki_resolver_slow_${neki}`;
    const { migrations, v1 } = await nicknameApplied(namespace);
    let asked = false;
    // Each reset answers within the bound; together they would exceed it.
    simulation.slow = neki
      ? { text: "RESET", ms: CLEANUP_BOUND_MS * 0.6 }
      : undefined;
    try {
      await expect(
        migrations(false).down({
          resolve: async (change) => {
            asked = true;
            return change.type === "destructive" ? change.proceed() : undefined;
          },
        })
      ).resolves.toMatchObject({ preview: false });
    } finally {
      simulation.slow = undefined;
    }
    expect(asked).toBe(true);
    expect((await migrations(false).status()).marker?.stateId).toBe(v1);
  }, 60_000);

  it("refuses down when the marker moved while its resolver answered, and runs nothing", async () => {
    const namespace = `neki_resolver_moved_${neki}`;
    const { migrations } = await nicknameApplied(namespace);
    await expect(
      migrations(false).down({
        resolve: async (change) => {
          await database.query(
            `UPDATE "${namespace}"."_viborm_migration_state" SET payload = replace(payload::text, '"revision":2', '"revision":9')::json`
          );
          return change.type === "destructive" ? change.proceed() : undefined;
        },
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_MARKER_CONFLICT,
    });
    expect(await columns(namespace)).toContain("nickname");
    expect(await advisoryLocks()).toBe(0);
    expect(refusals).toEqual([]);
  });

  it("baselines a pushed schema with partial indexes in a fresh namespace", async () => {
    const namespace = `neki_baseline_${neki}`;
    const migrations = await estate(namespace);
    const v1 = await migrations().generate({ name: "v1" });
    await migrations().push();

    await expect(
      migrations().baseline({ to: { id: v1.stateId! } })
    ).resolves.toEqual({ stateId: v1.stateId });
    expect((await migrations().status()).marker?.stateId).toBe(v1.stateId);
    await expect(migrations().apply()).resolves.toMatchObject({
      outcome: "noop",
    });
    expect(refusals).toEqual([]);
  });
});

describe("a state of four statements on Neki, each committed alone", () => {
  beforeAll(() => {
    simulation.enabled = true;
  });
  /** v1, then a state that adds and fills two columns: three parts on Neki. */
  const estate = async (namespace: string) => {
    await database.exec(`CREATE SCHEMA "${namespace}"`);
    const storage = new MemoryEstateStorage();
    const items = (stage: number) => ({
      item: s
        .model({
          id: s.string().id(),
          name: s.string(),
          ...(stage >= 1
            ? { a: s.string().nullable(), b: s.string().nullable() }
            : {}),
        })
        .map("items"),
    });
    const at = (stage: number) =>
      createMigrationClient(
        createClient({ client: database, schema: items(stage), namespace }),
        { storage }
      );
    const v1 = await at(0).generate({ name: "v1" });
    await at(0).apply();
    await database.exec(
      `INSERT INTO "${namespace}"."items" ("id", "name") SELECT 'i' || g, 'n' || g FROM generate_series(1, 50) g`
    );
    const table = `"${namespace}"."items"`;
    const v2 = await at(1).generate({
      name: "two-columns-filled",
      manualMigration: {
        transitions: [
          {
            from: v1.stateId!,
            execution: "transactional",
            up: [
              sql.raw(`ALTER TABLE ${table} ADD COLUMN "a" text`),
              sql.raw(`UPDATE ${table} SET "a" = "name"`),
              sql.raw(`ALTER TABLE ${table} ADD COLUMN "b" text`),
              sql.raw(`UPDATE ${table} SET "b" = "a" || '!'`),
            ],
            rollback: { kind: "irreversible", reason: "test" },
          },
        ],
        destinationChecks: [
          {
            kind: "trusted-read",
            query: sql.raw(
              `SELECT NOT EXISTS (SELECT 1 FROM ${table} WHERE "a" IS NULL OR "b" IS NULL) AS ok`
            ),
            equals: true,
          },
        ],
      },
    });
    const filled = async () =>
      (
        await database.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} WHERE "a" = "name" AND "b" = "a" || '!'`
        )
      ).rows[0]?.n;
    return { at, v1: v1.stateId!, v2: v2.stateId!, filled };
  };
  const eventsOf = async (
    migrations: ReturnType<Awaited<ReturnType<typeof estate>>["at"]>,
    toState: string
  ) =>
    (await migrations.log())
      .filter(
        (event) => event.toState === toState && event.direction === "forward"
      )
      .map((event) => event.kind);

  it.each([
    ["its first statement", 'ADD COLUMN "a"', 2],
    ["its second statement", 'SET "a" = "name"', 4],
    ["its third statement", 'ADD COLUMN "b"', 6],
    ["its last statement", 'SET "b" =', 8],
  ])("fails at %s: the marker stays, resolve refuses, and apply resumes from it", async (_label, fail, confirmed) => {
    // Lower case: no statement may include `fail` by its namespace.
    const namespace = `neki_steps_${fail.replace(/\W/g, "").toLowerCase()}`;
    const { at, v1, v2, filled } = await estate(namespace);
    simulation.fail = fail;
    await expect(at(1).apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
    });
    simulation.fail = undefined;
    const failed = await at(1).status();
    expect(failed.marker?.stateId).toBe(v1);
    expect(failed.unfinished).toBe(true);
    // Each statement announced, then answered; the failed one as refused
    // whole, so nothing of it committed.
    expect(await eventsOf(at(1), v2)).toEqual([
      "started",
      ...new Array<string>(confirmed).fill("step-confirmed"),
    ]);
    // Neither outcome is proven: the committed steps are an effect (or, the
    // first refused, an attempt resolve does not close), and the destination
    // does not hold. Apply resumes it.
    await expect(
      at(1).resolve({ outcome: "rolled-back" })
    ).rejects.toMatchObject({
      code:
        confirmed === 2
          ? VibORMErrorCode.MIGRATION_INVALID_STATE
          : VibORMErrorCode.MIGRATION_PARTIAL_EFFECT,
    });
    await expect(at(1).resolve({ outcome: "complete" })).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
    await expect(at(1).resolve({ outcome: "retry" })).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
    });
    expect((await at(1).status()).marker?.stateId).toBe(v1);

    simulation.log.length = 0;
    await expect(at(1).apply()).resolves.toMatchObject({
      outcome: "applied",
      path: [v2],
    });
    // A committed statement is never sent again.
    expect(simulation.log.some((text) => text.includes('ADD COLUMN "a"'))).toBe(
      confirmed === 2
    );
    expect(await filled()).toBe(50);
    const done = await at(1).status();
    expect(done.marker?.stateId).toBe(v2);
    expect(done.unfinished).toBe(false);
    await expect(at(1).verify()).resolves.toEqual({ ok: true });
    expect(
      (await eventsOf(at(1), v2)).filter((kind) => kind === "applied")
    ).toHaveLength(1);
    expect(simulation.refusals).toEqual([]);
  });

  it("fails at its destination check after every statement committed: resolve proves the destination and completes", async () => {
    const namespace = "neki_steps_check";
    const { at, v1, v2, filled } = await estate(namespace);
    simulation.fail = '"b" IS NULL';
    await expect(at(1).apply()).rejects.toBeDefined();
    simulation.fail = undefined;
    const failed = await at(1).status();
    expect(failed.marker?.stateId).toBe(v1);
    expect(failed.unfinished).toBe(true);
    expect(await filled()).toBe(50);
    await expect(at(1).resolve({ outcome: "complete" })).resolves.toBeDefined();
    const done = await at(1).status();
    expect(done.marker?.stateId).toBe(v2);
    expect(done.unfinished).toBe(false);
    await expect(at(1).verify()).resolves.toEqual({ ok: true });
    expect(simulation.refusals).toEqual([]);
  });
});
