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
import type { PGlite, Transaction } from "@electric-sql/pglite";
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
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { beforeAll, describe, expect, it } from "vitest";
import { softDeleteAccounts } from "./_catalog-digest-corpus";

const TEMPORARY = /\bTEMP(?:ORARY)?\s+(?:VIEW|TABLE)\b/i;
const NAME = String.raw`(?:"[^"]+"\.)?("[^"]+")`;
const CREATED = new RegExp(
  String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(TABLE|VIEW|TYPE|SEQUENCE|FUNCTION|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}`,
  "i"
);
const ALTERED = new RegExp(
  String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${NAME}\s+([\s\S]*)$`,
  "i"
);
const ADDED = /\bADD\s+(?:COLUMN\s+)?(?!CONSTRAINT\b)("[^"]+")/gi;
const RENAMED = /\bRENAME\s+(?:COLUMN\s+)?("[^"]+")\s+TO\s+("[^"]+")/gi;
const RENAMED_TO = /^RENAME\s+TO\s+("[^"]+")/i;
const RETYPED =
  /\bALTER\s+(?:COLUMN\s+)?("[^"]+")\s+(?:SET\s+DATA\s+)?TYPE\b/gi;
const DROPPED = /\bDROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?("[^"]+")/gi;
const ROWS = /^(?:INSERT|UPDATE|DELETE|MERGE|SELECT|WITH|DO)\b/i;
const SESSION_LOCK = /\bpg_try_advisory_lock\(/;
const XACT_LOCK = /\bpg_try_advisory_xact_lock\(/;
const UNLOCK = /\bpg_advisory_unlock\(/;
const UNLOCK_ALL = /\bpg_advisory_unlock_all\(/;
const COMPUTED_SETTING = /\bset_config\(\s*name\b/i;
const ROUTINE = /^\s*DO\b/i;
const VERB = /^\s*(\w+)/;

/** What one transaction changed that Neki's planner does not see. */
interface Unseen {
  /** Names it introduced, renamed, retyped or dropped. */
  readonly names: Set<string>;
  /** Relations whose columns it changed: their `*` is stale. */
  readonly columns: Set<string>;
  /** Relations it created or renamed: Neki has not registered them. */
  readonly fresh: Set<string>;
}

const nothingUnseen = (): Unseen => ({
  names: new Set(),
  columns: new Set(),
  fresh: new Set(),
});

/** Records what `text`, a schema statement, changed, or refuses it (NK316). */
function track(text: string, unseen: Unseen, refuse: (code: string) => never) {
  const created = CREATED.exec(text);
  if (created) {
    unseen.names.add(created[2]!);
    if (created[1]!.toUpperCase() === "TABLE") unseen.fresh.add(created[2]!);
    return;
  }
  const altered = ALTERED.exec(text);
  if (!altered) return;
  const [, table = "", clause = ""] = altered;
  const added = [...clause.matchAll(ADDED)].map((match) => match[1]!);
  const renamed = [...clause.matchAll(RENAMED)].flatMap((match) => [
    match[1]!,
    match[2]!,
  ]);
  const retyped = [...clause.matchAll(RETYPED)].map((match) => match[1]!);
  const dropped = [...clause.matchAll(DROPPED)].map((match) => match[1]!);
  if (
    unseen.fresh.has(table) &&
    [...renamed, ...retyped, ...dropped].length > 0
  ) {
    refuse("NK316");
  }
  const to = RENAMED_TO.exec(clause.trim())?.[1];
  if (to) {
    unseen.names.add(to);
    unseen.fresh.add(to);
  }
  for (const name of [...added, ...renamed, ...retyped, ...dropped]) {
    unseen.names.add(name);
  }
  if ([...added, ...renamed, ...dropped].length > 0) unseen.columns.add(table);
}

/**
 * Makes `database` refuse what Neki refuses while `enabled` is set, records
 * the refusals it made, and logs every statement it is sent. `fail` makes
 * the next statement that includes it, past `skip` of them, fail as a
 * provider would; `before.sql` runs once, before the session's statement
 * that is `before.text` past `before.skip` of them.
 */
function asNeki(database: PGlite): {
  enabled: boolean;
  refusals: string[];
  log: string[];
  fail?: string;
  /** A statement containing this text is never answered (once). */
  hang?: string;
  /** Every statement containing `text` answers only after `ms`. */
  slow?: { readonly text: string; readonly ms: number };
  skip: number;
  before?: { readonly text: string; skip: number; readonly sql: string };
} {
  const simulation = {
    enabled: false,
    refusals: [] as string[],
    log: [] as string[],
    fail: undefined as string | undefined,
    hang: undefined as string | undefined,
    slow: undefined as
      | { readonly text: string; readonly ms: number }
      | undefined,
    skip: 0,
    before: undefined as
      | { readonly text: string; skip: number; readonly sql: string }
      | undefined,
  };
  const { refusals, log } = simulation;
  let unseen = nothingUnseen();
  // The session's advisory locks: session ones held, and whether the open
  // transaction took a transaction one.
  let sessionLocks = 0;
  let transactionLock = false;
  const refuse = (code: string, message = code): never => {
    refusals.push(code);
    throw Object.assign(new Error(message), { code });
  };
  const check = (text: string, inTransaction: boolean) => {
    log.push(text);
    if (simulation.fail && text.includes(simulation.fail)) {
      if (simulation.skip === 0) {
        simulation.fail = undefined;
        throw Object.assign(new Error("injected failure"), { code: "XX000" });
      }
      simulation.skip -= 1;
    }
    const verb = VERB.exec(text)?.[1]?.toUpperCase();
    if (verb === "BEGIN" || verb === "COMMIT" || verb === "ROLLBACK") {
      transactionLock = false;
    }
    if (UNLOCK_ALL.test(text)) sessionLocks = 0;
    else if (UNLOCK.test(text)) sessionLocks = Math.max(0, sessionLocks - 1);
    if (!simulation.enabled) {
      if (SESSION_LOCK.test(text)) sessionLocks += 1;
      return;
    }
    if (TEMPORARY.test(text)) refuse("NK013", "temporary relations");
    if (COMPUTED_SETTING.test(text)) {
      if (ROUTINE.test(text)) {
        refuse(
          "42501",
          "set_config with a non-constant setting name is not allowed in a routine body"
        );
      }
      refuse("NK013", "not implemented: [101]");
    }
    const mixed =
      "not implemented: [61] Mixing session and transaction advisory locks is unavailable.";
    if (XACT_LOCK.test(text)) {
      if (sessionLocks > 0) refuse("NK013", mixed);
      if (inTransaction) transactionLock = true;
    }
    if (SESSION_LOCK.test(text)) {
      if (transactionLock) refuse("NK013", mixed);
      sessionLocks += 1;
    }
    if (verb === "BEGIN" || verb === "COMMIT" || verb === "ROLLBACK") {
      unseen = nothingUnseen();
      return;
    }
    if (!inTransaction) return;
    const statement = text.trim();
    if (ROWS.test(statement)) {
      const name = [...unseen.names].find((item) => statement.includes(item));
      if (name) refuse("42703", `relation or column ${name} does not exist`);
      const stale = [...unseen.columns].find((item) =>
        statement.includes(item)
      );
      if (stale && statement.includes("*")) refuse("42703", "stale *");
      return;
    }
    track(statement, unseen, refuse);
  };
  // Neki's version string; PGlite's own is kept everywhere else.
  const version = (text: string) =>
    simulation.enabled && text.includes("'%(Neki)%'")
      ? text.replace("pg_catalog.version()", "'PostgreSQL 18.6 (Neki)'")
      : text;
  let open = false;
  const query = database.query.bind(database);
  const transaction = database.transaction.bind(database);
  Object.defineProperty(database, "query", {
    value: async (text: string, params?: unknown[], options?: object) => {
      if (simulation.hang && text.includes(simulation.hang)) {
        simulation.hang = undefined;
        return new Promise(() => undefined);
      }
      if (simulation.slow && text.includes(simulation.slow.text)) {
        const { ms } = simulation.slow;
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
      const { before } = simulation;
      if (before && text === before.text && before.skip-- === 0) {
        simulation.before = undefined;
        await query(before.sql);
      }
      const verb = VERB.exec(text)?.[1]?.toUpperCase();
      if (verb === "BEGIN") open = true;
      if (verb === "COMMIT" || verb === "ROLLBACK") open = false;
      check(text, open);
      return query(version(text), params, options);
    },
  });
  Object.defineProperty(database, "transaction", {
    value: <T>(callback: (tx: Transaction) => Promise<T>) =>
      transaction((tx) => {
        unseen = nothingUnseen();
        const inner = tx.query.bind(tx);
        Object.defineProperty(tx, "query", {
          value: (text: string, params?: unknown[], options?: object) => {
            check(text, true);
            return inner(version(text), params, options);
          },
        });
        return callback(tx).finally(() => {
          unseen = nothingUnseen();
        });
      }),
  });
  return simulation;
}

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

  it("applies a state that adds a column and backfills it, committing between the two on Neki only", async () => {
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
    // Neki: the column commits first, then the backfill, its checks and the
    // marker, each step recorded in the transaction it ran in.
    expect(commits).toBe(neki ? 2 : 1);
    expect(await eventsOf(migrations, v2.stateId)).toEqual(
      neki
        ? ["started", "step-confirmed", "step-confirmed", "applied"]
        : ["applied"]
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
    // PostgreSQL: the whole path is one transaction, as before. Neki: the
    // first state commits its columns before its backfill; the schema state
    // starts a group the data cleanup cannot join, and so does the index
    // the last data state follows (a literal naming it would not see it).
    expect(commits).toBe(neki ? 5 : 1);
    const events = (await at(3).log()).filter(
      (event) => event.direction === "forward" && path.includes(event.toState!)
    );
    expect(events.map((event) => event.kind)).toEqual(
      neki
        ? [
            "started",
            "step-confirmed",
            "step-confirmed",
            "step-confirmed",
            "applied",
            "applied",
            "applied",
            "applied",
            "applied",
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
      expect(await eventsOf(migrations, v2.stateId)).toEqual([
        "started",
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
    expect(commitsIn(log)).toBe(1);
    expect(await backfilled(namespace)).toBe(ROW_COUNT);
    const done = await migrations(true).status();
    expect(done.marker?.stateId).toBe(v2.stateId);
    expect(done.unfinished).toBe(false);
    await expect(migrations(true).verify()).resolves.toEqual({ ok: true });
    expect(await eventsOf(migrations, v2.stateId)).toEqual(
      neki
        ? ["started", "step-confirmed", "step-confirmed", "applied"]
        : ["failed", "applied"]
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
    // Neki: the backfill's group starts after the column committed.
    expect(commitsIn(log)).toBe(neki ? 2 : 1);
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

describe("a state split in three parts on Neki", () => {
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
    ["the first part's COMMIT", "COMMIT", 0, 0],
    ["the second part's first step", 'SET "a" = "name"', 0, 1],
    ["the second part's second step", 'ADD COLUMN "b"', 0, 1],
    ["the second part's COMMIT", "COMMIT", 1, 1],
    ["the last part's step", 'SET "b" =', 0, 3],
    ["the destination check", '"b" IS NULL', 0, 3],
  ])("fails at %s: the marker stays, resolve refuses, and apply resumes", async (_label, fail, skip, committed) => {
    // Lower case: no statement may include `fail` by its namespace.
    const namespace = `neki_parts_${fail.replace(/\W/g, "").toLowerCase()}_${skip}`;
    const { at, v1, v2, filled } = await estate(namespace);
    simulation.fail = fail;
    simulation.skip = skip;
    await expect(at(1).apply()).rejects.toBeDefined();
    simulation.fail = undefined;
    simulation.skip = 0;
    const failed = await at(1).status();
    expect(failed.marker?.stateId).toBe(v1);
    expect(failed.unfinished).toBe(committed > 0);
    expect(await eventsOf(at(1), v2)).toEqual(
      committed > 0
        ? ["started", ...new Array(committed).fill("step-confirmed")]
        : ["failed"]
    );
    if (committed > 0) {
      // Neither outcome is proven: the committed manual steps are an effect,
      // and the destination does not hold.
      await expect(
        at(1).resolve({ outcome: "rolled-back" })
      ).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_PARTIAL_EFFECT,
      });
      await expect(
        at(1).resolve({ outcome: "complete" })
      ).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      });
      await expect(at(1).resolve({ outcome: "retry" })).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
      });
      expect((await at(1).status()).marker?.stateId).toBe(v1);
    }

    simulation.log.length = 0;
    await expect(at(1).apply()).resolves.toMatchObject({
      outcome: "applied",
      path: [v2],
    });
    // A committed part is never sent again.
    expect(simulation.log.some((text) => text.includes('ADD COLUMN "a"'))).toBe(
      committed === 0
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

  it("records no failure for a split state whose marker another command moved first", async () => {
    const namespace = "neki_parts_overtaken";
    await database.exec(`CREATE SCHEMA "${namespace}"`);
    const storage = new MemoryEstateStorage();
    const at = (nickname: boolean) =>
      createMigrationClient(
        createClient({
          client: database,
          schema: softDeleteAccounts(nickname),
          namespace,
        }),
        { storage }
      );
    await at(false).generate({ name: "v1" });
    await at(false).apply();
    const v2 = await at(true).generate({ name: "nickname" });
    const table = `"${namespace}"."accounts"`;
    const v3 = await at(true).generate({
      name: "flag-and-fill",
      manualMigration: {
        transitions: [
          {
            from: v2.stateId!,
            execution: "transactional",
            up: [
              sql.raw(`ALTER TABLE ${table} ADD COLUMN "flag" text`),
              sql.raw(`UPDATE ${table} SET "flag" = 'x'`),
            ],
            rollback: { kind: "irreversible", reason: "test" },
          },
        ],
      },
    });
    // v2 commits on its own; before v3's first part takes the lock again,
    // another command moves the marker (revision 2, v2's).
    simulation.before = {
      text: "BEGIN",
      skip: 1,
      sql: `UPDATE ${`"${namespace}"."_viborm_migration_state"`} SET payload = replace(payload::text, '"revision":2', '"revision":9')::json`,
    };
    await expect(at(true).apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_MARKER_CONFLICT,
    });
    simulation.before = undefined;
    // Nothing of v3 ran: no attempt of it is open, and none failed.
    const events = (await at(true).log()).filter(
      (event) => event.toState === v3.stateId
    );
    expect(events).toEqual([]);
    const { rows } = await database.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = '${namespace}' AND column_name = 'flag'`
    );
    expect(rows).toEqual([]);
    expect(simulation.refusals).toEqual([]);
  });
});
