/**
 * The effectful migration commands on PlanetScale's Neki, on PGlite made to
 * refuse what Neki refuses (measured 2026-10-12 on Neki's PostgreSQL 18.6,
 * `.probes/hosted/neki-apply-1.2.0.md`):
 * - a temporary relation (`NK013`): the partial-index predicate canonicalizer
 *   used temporary views;
 * - a row statement naming a relation or column created earlier in its own
 *   transaction (`42P01`, `42703`): Neki plans it against the committed
 *   schema. Schema statements and catalog reads see the transaction's changes.
 * The same flow runs on plain PGlite, where only the refusal of a data change
 * after a schema change in one transaction differs.
 */

import { createClient } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient, MemoryEstateStorage } from "@migrations";
import { sql } from "@sql";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { beforeAll, describe, expect, it } from "vitest";
import { softDeleteAccounts } from "./_catalog-digest-corpus";

const TEMPORARY = /\bTEMP(?:ORARY)?\s+(?:VIEW|TABLE)\b/i;
const CREATED =
  /^CREATE\s+(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"\.)?("[^"]+")/i;
const ADDED = /^ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN\s+("[^"]+")/i;
const ROWS = /^(?:INSERT|UPDATE|DELETE|MERGE|SELECT|WITH)\b/i;
const VERB = /^\s*(\w+)/;

/**
 * Makes `database` refuse what Neki refuses while `enabled` is set, and
 * records the refusals it made.
 */
function asNeki(database: PGlite): { enabled: boolean; refusals: string[] } {
  const simulation = { enabled: false, refusals: [] as string[] };
  const { refusals } = simulation;
  const created = new Set<string>();
  const refuse = (code: string, message: string) => {
    refusals.push(code);
    return Object.assign(new Error(message), { code });
  };
  const check = (text: string, inTransaction: boolean) => {
    if (!simulation.enabled) return;
    if (TEMPORARY.test(text)) {
      throw refuse("NK013", "temporary tables, views and sequences");
    }
    const verb = VERB.exec(text)?.[1]?.toUpperCase();
    if (verb === "BEGIN" || verb === "COMMIT" || verb === "ROLLBACK") {
      created.clear();
      return;
    }
    if (!inTransaction) return;
    const name = CREATED.exec(text.trim())?.[1] ?? ADDED.exec(text.trim())?.[1];
    if (name) created.add(name);
    const unseen = [...created].find((item) => text.includes(item));
    if (ROWS.test(text.trim()) && unseen) {
      throw refuse("42P01", `relation or column ${unseen} does not exist`);
    }
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
    value: (text: string, params?: unknown[], options?: object) => {
      const verb = VERB.exec(text)?.[1]?.toUpperCase();
      if (verb === "BEGIN") open = true;
      check(text, open);
      if (verb === "COMMIT" || verb === "ROLLBACK") open = false;
      return query(version(text), params, options);
    },
  });
  Object.defineProperty(database, "transaction", {
    value: <T>(callback: (tx: Transaction) => Promise<T>) =>
      transaction((tx) => {
        created.clear();
        const inner = tx.query.bind(tx);
        Object.defineProperty(tx, "query", {
          value: (text: string, params?: unknown[], options?: object) => {
            check(text, true);
            return inner(version(text), params, options);
          },
        });
        return callback(tx).finally(() => created.clear());
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

const database = openTestPGlite();
const simulation = asNeki(database);

describe.each([
  ["PostgreSQL", false],
  ["Neki", true],
])("migration commands on %s", (_label, neki) => {
  const { refusals } = simulation;
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

  it("refuses a data change after a schema change in one transaction on Neki only, before effects", async () => {
    const namespace = `neki_combined_${neki}`;
    const migrations = await estate(namespace);
    const v1 = await migrations().generate({ name: "v1" });
    await migrations().apply();
    await database.exec(
      `INSERT INTO "${namespace}"."accounts" ("id", "email") VALUES ('a', 'a@example.com')`
    );
    const v2 = await migrations(true).generate({
      name: "nickname-and-backfill",
      manualMigration: {
        transitions: [
          {
            from: v1.stateId,
            execution: "transactional",
            up: [ADD_NICKNAME(namespace), BACKFILL(namespace)],
            rollback: { kind: "irreversible", reason: "test" },
          },
        ],
      },
    });

    const applying = migrations(true).apply();
    if (!neki) {
      await expect(applying).resolves.toMatchObject({ outcome: "applied" });
      expect((await migrations(true).status()).marker?.stateId).toBe(
        v2.stateId
      );
      return;
    }
    await expect(applying).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
      message: expect.stringContaining(
        "runs statement 2 (UPDATE) after statement 1 (ALTER TABLE)"
      ),
    });
    expect(await columns(namespace)).not.toContain("nickname");
    const status = await migrations(true).status();
    expect(status.marker?.stateId).toBe(v1.stateId);
    expect(status.unfinished).toBe(false);
    expect(refusals).toEqual([]);
  });

  it("applies the schema change and its backfill as two states, then rolls the backfill back", async () => {
    const namespace = `neki_split_${neki}`;
    const migrations = await estate(namespace);
    await migrations().generate({ name: "v1" });
    await migrations().apply();
    await database.exec(
      `INSERT INTO "${namespace}"."accounts" ("id", "email") VALUES ('a', 'a@example.com')`
    );
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

    if (neki) {
      // One apply of both is one transaction: refused before effects.
      await expect(migrations(true).apply()).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
      });
      await expect(
        migrations(true).apply({ to: { id: schema.stateId! } })
      ).resolves.toMatchObject({ outcome: "applied" });
    }
    await expect(migrations(true).apply()).resolves.toMatchObject({
      outcome: "applied",
    });
    const nickname = async () =>
      (
        await database.query<{ nickname: string | null }>(
          `SELECT "nickname" FROM "${namespace}"."accounts"`
        )
      ).rows[0]?.nickname;
    expect(await nickname()).toBe("a@example.com");
    expect((await migrations(true).status()).marker?.stateId).toBe(
      backfill.stateId
    );
    await expect(migrations(true).verify()).resolves.toEqual({ ok: true });

    await migrations(true).down();
    expect(await nickname()).toBeNull();
    expect((await migrations(true).status()).marker?.stateId).toBe(
      schema.stateId
    );
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
