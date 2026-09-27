// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared assertion helpers are invoked only from registered tests.
/**
 * Live cells for the integration of issues #42, #45, #46 and #47 on one schema
 * (`./issue-combination.ts`), shared by the SQLite3 and PGlite suites in
 * `tests/providers/local/`:
 *
 *   · Combined falsifier 2 (live half) — the creation timestamp refuses an
 *     update and keeps its stored value on a schema whose keys, junction keys
 *     and timestamp use native-type maps; the junction's two keys behave by
 *     their own actions over that storage.
 *   · Combined falsifier 3 — the populated junction, protected on its topic
 *     side, goes with both endpoint tables in one consented push. On SQLite
 *     that works only if #42 orders the drops from the constraints #46 wrote:
 *     catalog order drops `aaa_topic` first, which the `noAction` key refuses.
 *   · Combined falsifier 4 (live half) — changing only the junction policy, or
 *     only this dialect's native entry, applies that change and keeps the rows;
 *     a second push is then a no-op, and neither a respelling nor another
 *     dialect's entry plans anything.
 *
 * Each cell opens its own database (`openDatabase`), so a cell that drops or
 * alters tables never leaks into the next.
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { ForeignKeyError, ValidationError } from "@errors";
import { createMigrationClient } from "@migrations";
import type { ResolveCallback } from "@migrations/types";
import type { Schema } from "@schema/hydration";
import { MYSQL, PG, SQLITE } from "@schema/scalars/native-types";
import { sql } from "@sql";
import {
  type CombinationVariant,
  combinationSchema,
  JUNCTION_TABLE,
  TITLE_STORAGE,
} from "@tests/fixtures/issue-combination";
import { expect, test } from "vitest";

export type CombinationDialect = "sqlite" | "pg";

export interface CombinationDatabase {
  readonly driver: AnyDriver;
  /** Every table this database holds for the cell, sorted. */
  readonly tables: () => Promise<string[]>;
  readonly dispose: () => Promise<void>;
}

export interface CombinationCellOptions {
  readonly dialect: CombinationDialect;
  readonly openDatabase: () => Promise<CombinationDatabase>;
}

const POST_1 = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const POST_2 = "b1ffcd88-8d1a-4ef8-bb6d-6bb9bd380a22";
const CREATED = new Date("2026-01-01T00:00:00.123Z");
const LATER = new Date("2026-02-01T00:00:00.000Z");
const DROP_TABLE = /^DROP TABLE "([^"]+)"$/;

const proceed: ResolveCallback = (change) =>
  change.type === "destructive" ? change.proceed() : change.reject();

/** This dialect's active native entry moved, and one no dialect here reads. */
const ENTRY_CHANGE = {
  sqlite: {
    own: { created: { sqlite: SQLITE.DATETIME.REAL } },
    other: { title: { ...TITLE_STORAGE, pg: PG.STRING.VARCHAR(120) } },
    column: "createdAt",
  },
  pg: {
    own: { title: { ...TITLE_STORAGE, pg: PG.STRING.VARCHAR(120) } },
    other: { title: { ...TITLE_STORAGE, mysql: MYSQL.STRING.VARCHAR(120) } },
    column: "title",
  },
} as const;

function clientOn(driver: AnyDriver, variant: CombinationVariant = {}) {
  return createClient({ schema: combinationSchema(variant), driver });
}

/** Preview with the exact destructive consent, then apply that consent. */
async function pushConsented(driver: AnyDriver, schema: Schema) {
  const migrations = createMigrationClient(createClient({ schema, driver }));
  const preview = await migrations.push({ dryRun: true, resolve: proceed });
  const applied = await migrations.push({ consent: preview.consent });
  return { preview, applied };
}

async function planned(driver: AnyDriver, variant: CombinationVariant) {
  const plan = await createMigrationClient(clientOn(driver, variant)).push({
    dryRun: true,
    resolve: proceed,
  });
  return plan.operations.map((operation) => operation.label);
}

async function seeded(driver: AnyDriver) {
  const client = clientOn(driver);
  await createMigrationClient(client).push();
  await client.topic.createMany({
    data: [
      { id: "t1", name: "one" },
      { id: "t2", name: "two" },
    ],
  });
  await client.post.create({
    data: {
      id: POST_1,
      title: "first",
      createdAt: CREATED,
      topics: { connect: [{ id: "t1" }, { id: "t2" }] },
    },
  });
  await client.post.create({
    data: { id: POST_2, title: "second", topics: { connect: [{ id: "t1" }] } },
  });
  return client;
}

type CombinationClient = Awaited<ReturnType<typeof seeded>>;

const topicsOf = async (client: CombinationClient, id: string) =>
  (
    await client.post.findUniqueOrThrow({
      where: { id },
      include: { topics: { orderBy: { id: "asc" } } },
    })
  ).topics.map((topic) => topic.id);

async function withDatabase(
  options: CombinationCellOptions,
  run: (database: CombinationDatabase) => Promise<void>
) {
  const database = await options.openDatabase();
  try {
    await run(database);
  } finally {
    await database.dispose();
  }
}

export function issueCombinationCells(options: CombinationCellOptions): void {
  test("the creation timestamp and both junction keys keep their contracts over mapped storage", async () => {
    await withDatabase(options, async ({ driver }) => {
      const client = await seeded(driver);

      await expect(
        client.post.update({
          where: { id: POST_1 },
          // @ts-expect-error a `.now()` field is not a legal update key (#47).
          data: { title: "renamed", createdAt: LATER },
        })
      ).rejects.toBeInstanceOf(ValidationError);
      const stored = await client.post.findUniqueOrThrow({
        where: { id: POST_1 },
      });
      expect(stored).toMatchObject({ title: "first", createdAt: CREATED });

      // The topic side's key protects an assigned topic; the post side's
      // cascades only that post's memberships.
      await expect(
        client.topic.delete({ where: { id: "t1" } })
      ).rejects.toBeInstanceOf(ForeignKeyError);
      await client.post.delete({ where: { id: POST_1 } });
      expect(await topicsOf(client, POST_2)).toEqual(["t1"]);
      await client.topic.delete({ where: { id: "t2" } });
      expect(await client.topic.count()).toBe(1);
    });
  });

  test("a populated protected junction goes with both endpoint tables in one consented push", async () => {
    await withDatabase(options, async ({ driver, tables }) => {
      await seeded(driver);
      expect(await tables()).toEqual(["aaa_topic", "bbb_post", JUNCTION_TABLE]);

      const { preview, applied } = await pushConsented(driver, {});

      if (options.dialect === "sqlite") {
        const dropped = preview.statements.flatMap(({ sql: statement }) => {
          const match = DROP_TABLE.exec(statement);
          return match?.[1] ? [match[1]] : [];
        });
        // The junction references both endpoints, so it goes first; the
        // endpoints then keep their given order.
        expect(dropped[0]).toBe(JUNCTION_TABLE);
        expect([...dropped].sort()).toEqual([
          "aaa_topic",
          "bbb_post",
          JUNCTION_TABLE,
        ]);
      }
      expect(applied.outcome).toBe("applied");
      expect(applied.planHash).toBe(preview.planHash);
      expect(applied.statements).toEqual(preview.statements);
      expect(await tables()).toEqual([]);
    });
  });

  test("a policy change and this dialect's native entry each migrate alone, then settle", async () => {
    await withDatabase(options, async ({ driver }) => {
      const client = await seeded(driver);
      const change = ENTRY_CHANGE[options.dialect];

      expect(await planned(driver, {})).toEqual([]);
      expect(await planned(driver, { respelled: true })).toEqual([]);
      expect(await planned(driver, change.other)).toEqual([]);

      // Only the topic side's key moves; SQLite rebuilds the junction to do
      // it, and the memberships survive.
      expect(await planned(driver, { topicDelete: "restrict" })).toEqual([
        "dropForeignKey",
        "addForeignKey",
      ]);
      await pushConsented(
        driver,
        combinationSchema({ topicDelete: "restrict" })
      );
      expect(await planned(driver, { topicDelete: "restrict" })).toEqual([]);
      expect(await topicsOf(client, POST_1)).toEqual(["t1", "t2"]);

      const moved = { topicDelete: "restrict", ...change.own } as const;
      expect(await planned(driver, moved)).toEqual(["alterColumn"]);
      const { applied } = await pushConsented(driver, combinationSchema(moved));
      expect(
        applied.statements.map(({ sql: text }) => text).join("\n")
      ).toContain(change.column);
      expect(await planned(driver, moved)).toEqual([]);

      const after = clientOn(driver, moved);
      await expect(
        after.post.findUniqueOrThrow({ where: { id: POST_1 } })
      ).resolves.toMatchObject({ title: "first", createdAt: CREATED });
      expect(await topicsOf(after, POST_1)).toEqual(["t1", "t2"]);
    });
  });
}

/** SQLite's own table list, without its internal tables. */
export async function sqliteTables(driver: AnyDriver): Promise<string[]> {
  const client = createClient({ schema: {}, driver });
  const rows = await client.$queryRaw<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  );
  return rows.map((row) => String(row.name));
}
