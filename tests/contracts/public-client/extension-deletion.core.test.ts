/**
 * The `deletion` capability's call facts (extension-capabilities plan v3.1
 * §2.2-2.3): how a chain's `rows` and `deletion` resolve to one call's
 * domains and tombstones, row predicates bound as written, one instant per
 * call across re-plans and array members, a domain bound to the call's
 * value resolved once across a re-plan, and a declaration without rows.
 * The provider behaviour (tombstones at every site, the referential
 * requirement, `mode: "hard"`) is `deletion-capability-behavior.ts`, run on
 * SQLite3, the batch-only substrate and PGlite.
 *
 * Runs on in-memory SQLite.
 */

import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import type {
  BatchQuery,
  QueryExecutionContext,
  QueryResult,
} from "@drivers/types";
import { ForeignKeyError, NotFoundError } from "@errors";
import { appendResolvedExtension } from "@extensions/chain";
import { callRows } from "@extensions/rows";
import { s } from "@schema";
import { openDeletionFixture } from "@tests/contracts/engine/write/deletion-capability-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { failure } from "@tests/fixtures/failure";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";

const UNKNOWN_MODEL_PATTERN = /unknown model/;

// Every call's row facts are resolved through this spy, a passthrough: it
// counts the resolutions one call makes across its attempts.
vi.mock("@extensions/rows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@extensions/rows")>();
  return { ...actual, callRows: vi.fn(actual.callRows) };
});

/**
 * Batch-only SQLite on which another writer commits one statement right before
 * a chosen batch: the race a plan-time read cannot see.
 */
class RacingSQLite3Driver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  inject: { readonly when: RegExp; readonly sql: string } | undefined;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const pending = this.inject;
    if (pending && queries.some((query) => pending.when.test(query.sql))) {
      this.inject = undefined;
      await this.executeRaw(client, pending.sql);
    }
    return this.transaction(client, async (tx) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries)
        results.push(await this.execute<T>(tx, query.sql, query.params ?? []));
      return results;
    });
  }
}

const TOMBSTONE_UPDATE = /^\s*UPDATE "post" SET .*"deletedAt"/i;
const POST_UPDATE = /^\s*UPDATE "post"/i;

const clients: { $disconnect(): Promise<void> }[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

async function fixture(driver = createInMemorySQLite3Driver()) {
  const opened = await openDeletionFixture(driver);
  clients.push(opened.base);
  return opened;
}

const tombstoneUpdates = (
  statements: readonly { sql: string; values: readonly unknown[] }[]
) => statements.filter((statement) => TOMBSTONE_UPDATE.test(statement.sql));

describe("one instant per call, admitted per occurrence per attempt", () => {
  test("a re-plan after a raced captured set re-admits every tombstone at the call's one instant", async () => {
    const driver = new RacingSQLite3Driver({ dataDir: ":memory:" });
    const { base, db, ledger, statements } = await fixture(driver);
    for (const id of [17, 18])
      await base.post.create({
        data: {
          id,
          title: `p${id}`,
          authorId: 2,
          tags: { connect: [{ id: 2 }] },
        },
      });
    ledger.length = 0;
    // A member joins tag 2 inside the batch that tombstones the captured set:
    // the raceable premise aborts it, and the operation re-plans once.
    driver.inject = {
      when: POST_UPDATE,
      sql: `INSERT INTO "post_tag" ("postId", "tagId") VALUES (14, 2)`,
    };
    await db.tag.update({
      where: { id: 2 },
      data: { posts: { deleteMany: {} } },
    });
    expect(driver.inject).toBeUndefined();
    // Attempt 1 admits the series' template and its two captured members;
    // the re-plan admits the template and the three members it captures now.
    expect(ledger).toEqual(Array.from({ length: 7 }, () => ACTOR));
    // Every tombstone UPDATE of both attempts — the first attempt's reached
    // member 17 before its batch was refused — binds the call's one instant
    // first (`updatedAt`, its own sample, is third).
    const updates = tombstoneUpdates(statements);
    expect(updates.map((update) => update.values.at(-1))).toEqual([
      17, 14, 17, 18,
    ]);
    expect(new Set(updates.map((update) => update.values[0])).size).toBe(1);
    const rows = await base.post.findMany({
      where: { id: { in: [14, 17, 18] } },
      orderBy: { id: "asc" },
    });
    expect(rows.map((row) => row.deletedById)).toEqual([ACTOR, ACTOR, ACTOR]);
    expect(new Set(rows.map((row) => row.deletedAt!.getTime())).size).toBe(1);
  });

  test("a re-plan under a domain bound to the call's value resolves it once: both attempts take the same author", async () => {
    const driver = new RacingSQLite3Driver({ dataDir: ":memory:" });
    const { base, db, ledger } = await fixture(driver);
    const own = db.$extends({
      name: "test.byAuthor",
      controls: { author: { oneOf: [1, 2, 3] } },
      rows: {
        control: "authors",
        default: "own",
        models: {
          post: {
            own: {
              root: { authorId: { control: "author" } },
              related: { authorId: { control: "author" } },
            },
            all: {},
          },
        },
      },
    });
    // Post 19 is another author's and sits on the same tag.
    for (const [id, authorId] of [
      [17, 1],
      [18, 1],
      [19, 3],
    ] as const)
      await base.post.create({
        data: { id, title: `p${id}`, authorId, tags: { connect: [{ id: 2 }] } },
      });
    ledger.length = 0;
    driver.inject = {
      when: POST_UPDATE,
      sql: `INSERT INTO "post_tag" ("postId", "tagId") VALUES (14, 2)`,
    };
    const resolutions = vi.mocked(callRows);
    resolutions.mockClear();
    await own.tag.update({
      where: { id: 2 },
      data: { posts: { deleteMany: {} } },
      author: 1,
    });
    expect(driver.inject).toBeUndefined();
    // Attempt 1 captures 17 and 18; the re-plan 14, 17 and 18: never 19.
    expect(ledger).toEqual(Array.from({ length: 7 }, () => ACTOR));
    expect(resolutions).toHaveBeenCalledTimes(1);
    const rows = await base.post.findMany({
      where: { id: { in: [14, 17, 18, 19] } },
      orderBy: { id: "asc" },
    });
    expect(rows.map((row) => row.deletedById)).toEqual([
      ACTOR,
      ACTOR,
      ACTOR,
      null,
    ]);
  });

  test("array members each get their own instant, and a refused member rolls the array back", async () => {
    const { base, db } = await fixture();
    const [first, second] = await db.$transaction([
      db.post.delete({
        where: { id: 11 },
        select: { id: true, deletedAt: true },
      }),
      db.post.deleteMany({ where: { id: 14 } }),
    ]);
    expect(first).toMatchObject({ id: 11, deletedAt: expect.any(Date) });
    expect(second).toEqual({ count: 1 });
    expect(
      await failure(
        db.$transaction([
          db.comment.delete({ where: { id: 100 } }),
          db.post.delete({ where: { id: 13 } }),
        ])
      )
    ).toBeInstanceOf(ForeignKeyError);
    expect(
      await base.comment.findUniqueOrThrow({ where: { id: 100 } })
    ).toMatchObject({ deletedAt: null });
  });
});

const ACTOR = "actor-1";

describe("a chain's rows and deletion resolve to one call's facts", () => {
  const item = s.model({
    id: s.int().id(),
    archivedAt: s.dateTime().nullable(),
    hidden: s.boolean(),
  });
  const schema = { item };

  test("every combination of two rows members, the default shared, a removeWhen match physical", () => {
    let chain = appendResolvedExtension(
      undefined,
      {
        name: "archive",
        controls: { purge: { oneOf: [true, false] } },
        rows: {
          control: "archived",
          default: "no",
          models: {
            item: {
              no: { root: { archivedAt: null } },
              yes: { root: { archivedAt: { not: null } } },
            },
          },
        },
        deletion: {
          removeWhen: { purge: true },
          models: { item: { at: "archivedAt" } },
        },
      },
      schema
    );
    chain = appendResolvedExtension(
      chain,
      {
        name: "visibility",
        rows: {
          control: "hidden",
          default: "exclude",
          models: {
            item: {
              exclude: { root: { hidden: false }, related: { hidden: false } },
              include: {},
            },
          },
        },
      },
      schema
    );
    const binding = chain.callRows!;
    const defaults = callRows(binding, "item", undefined);
    expect(defaults.domain).toBe(defaults.defaults);
    expect(defaults.domain.root.get("item")).toEqual([
      { archivedAt: null },
      { hidden: false },
    ]);
    expect(defaults.domain.related.get("item")).toEqual([{ hidden: false }]);
    expect(defaults.tombstones?.get("item")).toMatchObject({
      at: "archivedAt",
    });
    const archived = callRows(binding, "item", {
      archived: "yes",
      hidden: "include",
    });
    expect(archived.defaults).toBe(defaults.domain);
    expect(archived.domain.root.get("item")).toEqual([
      { archivedAt: { not: null } },
    ]);
    // Explicit defaults resolve to the very same facts as absent controls.
    expect(
      callRows(binding, "item", { archived: "no", hidden: "exclude" })
    ).toBe(defaults);
    const purge = callRows(binding, "item", { purge: true });
    expect(purge.tombstones).toBeUndefined();
    expect(purge.domain).toBe(defaults.domain);
    // `removeWhen` belongs to the managed model: another model never matches.
    expect(
      callRows(binding, "other", { purge: true }).tombstones
    ).toBeDefined();
  });

  test("a rows member with no model entry reads its default; a chain without deletion writes no tombstone", () => {
    const chain = appendResolvedExtension(
      undefined,
      { name: "empty", rows: { control: "scope", default: "all", models: {} } },
      schema
    );
    const facts = callRows(chain.callRows!, "item", { scope: "all" });
    expect(facts.domain.root.size).toBe(0);
    expect(facts.tombstones).toBeUndefined();
    // A chain that declares neither binds nothing.
    expect(
      appendResolvedExtension(undefined, { name: "plain" }, schema).callRows
    ).toBeUndefined();
  });

  test("raw shorthand filters rows end to end and an unknown policy model is refused", async () => {
    const base = createClient({
      schema,
      driver: createInMemorySQLite3Driver(),
    });
    clients.push(base);
    await syncLiveSchema(base);
    await base.item.createMany({
      data: [
        { id: 1, archivedAt: null, hidden: false },
        { id: 2, archivedAt: new Date(), hidden: false },
        { id: 3, archivedAt: null, hidden: true },
      ],
    });
    const db = base.$extends({
      name: "trusted",
      rows: {
        control: "archived",
        default: "no",
        models: {
          item: {
            no: { root: { archivedAt: null, hidden: false } },
            yes: { root: { NOT: { archivedAt: null } } },
          },
        },
      },
    });
    expect(() =>
      base.$extends({
        name: "invalid-model",
        rows: {
          control: "archived",
          default: "no",
          models: {
            // @ts-expect-error the whole model map is refused when any key is unknown
            item: { no: { root: { hidden: false } } },
            // @ts-expect-error runtime falsifier: unknown policy models fail admission
            ghost: { no: { root: { gone: 1 } } },
          },
        },
      })
    ).toThrow(UNKNOWN_MODEL_PATTERN);
    const ids = (rows: readonly { readonly id: number }[]) =>
      rows.map((row) => row.id);
    expect(ids(await db.item.findMany({ orderBy: { id: "asc" } }))).toEqual([
      1,
    ]);
    expect(
      ids(await db.item.findMany({ archived: "yes", orderBy: { id: "asc" } }))
    ).toEqual([2]);
    expect(await db.item.count({ archived: "no" })).toBe(1);
  });
});

describe("a deletion entry without rows", () => {
  test("makes every row a candidate, so a repeat delete re-stamps", async () => {
    const item = s.model({
      id: s.int().id(),
      removedAt: s.dateTime().nullable(),
      note: s.string().nullable(),
    });
    const base = createClient({
      schema: { item },
      driver: createInMemorySQLite3Driver(),
    });
    clients.push(base);
    await syncLiveSchema(base);
    await base.item.create({ data: { id: 1 } });
    const db = base.$extends({
      name: "stamp",
      deletion: {
        models: { item: { at: "removedAt", assign: { note: "gone" } } },
      },
    });
    const first = await db.item.delete({ where: { id: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await db.item.delete({ where: { id: 1 } });
    expect(first).toMatchObject({ note: "gone" });
    expect(second.removedAt!.getTime()).toBeGreaterThan(
      first.removedAt!.getTime()
    );
    expect(await failure(db.item.delete({ where: { id: 2 } }))).toBeInstanceOf(
      NotFoundError
    );
    expect(await db.item.deleteMany({})).toEqual({ count: 1 });
  });
});

const POST_READ = /^\s*SELECT\b[\s\S]*\bFROM "post"/i;

/** Runs one statement right after the first read of `post` once armed. */
class AfterLockSQLite3Driver extends SQLite3Driver {
  // Pin this fixture's budget; its keyed-versus-range oracles exercise999 binds.
  override readonly maxBindParametersPerStatement = 999;
  afterRead: string | undefined;

  protected override async execute<T>(
    client: Database.Database,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const result = await super.execute<T>(client, sql, params);
    const pending = this.afterRead;
    if (pending && context?.model !== "$schema" && POST_READ.test(sql)) {
      this.afterRead = undefined;
      await this.executeRaw(client, pending);
    }
    return result;
  }
}

describe("a limited soft delete takes exactly the rows it locked", () => {
  test("a row that becomes a candidate below the window after the lock is not taken", async () => {
    const driver = new AfterLockSQLite3Driver();
    const { base, db } = await fixture(driver);
    await base.post.create({
      data: { id: 50, authorId: 1, title: "p50", deletedAt: new Date(0) },
    });
    await base.post.create({ data: { id: 51, authorId: 1, title: "p51" } });
    // The locking read takes 51 (50 is a tombstone); another writer then
    // restores 50, which sorts below 51.
    driver.afterRead = 'UPDATE "post" SET "deletedAt" = NULL WHERE "id" = 50';
    expect(
      await db.post.deleteMany({ where: { id: { in: [50, 51] } }, limit: 1 })
    ).toEqual({ count: 1 });
    const rows = await base.post.findMany({
      where: { id: { in: [50, 51] } },
      select: { id: true, deletedAt: true },
      orderBy: { id: "asc" },
    });
    expect(rows.map((row) => [row.id, row.deletedAt === null])).toEqual([
      [50, true],
      [51, false],
    ]);
  });

  // A row read into the window can stop matching before the effect (SQLite
  // locks nothing): the effect still names the filter, and leaves it alone.
  test("a row that stops matching after the read is not taken", async () => {
    const driver = new AfterLockSQLite3Driver();
    const { base, db } = await fixture(driver);
    await base.post.createMany({
      data: [
        { id: 61, authorId: 1, title: "x" },
        { id: 62, authorId: 1, title: "x" },
      ],
    });
    driver.afterRead = 'UPDATE "post" SET "title" = \'y\' WHERE "id" = 61';
    expect(
      await db.post.deleteMany({ where: { title: "x" }, limit: 2 })
    ).toEqual({ count: 1 });
    const rows = await base.post.findMany({
      where: { id: { in: [61, 62] } },
      select: { id: true, deletedAt: true },
      orderBy: { id: "asc" },
    });
    expect(rows.map((row) => [row.id, row.deletedAt === null])).toEqual([
      [61, true],
      [62, false],
    ]);
  });

  // A row lock holds the row, not the related rows its filter reads: the
  // effect still names the filter, so a post whose author was renamed after
  // the lock is left alone.
  test("a row whose related filter stops matching after the read is not taken", async () => {
    const driver = new AfterLockSQLite3Driver();
    const { base, db } = await fixture(driver);
    await base.post.createMany({
      data: [
        { id: 61, authorId: 1, title: "x" },
        { id: 62, authorId: 2, title: "x" },
      ],
    });
    driver.afterRead = 'UPDATE "author" SET "name" = \'z\' WHERE "id" = 1';
    expect(
      await db.post.deleteMany({
        where: {
          id: { in: [61, 62] },
          author: { is: { name: { in: ["a1", "a2"] } } },
        },
        limit: 2,
      })
    ).toEqual({ count: 1 });
    const rows = await base.post.findMany({
      where: { id: { in: [61, 62] } },
      select: { id: true, deletedAt: true },
      orderBy: { id: "asc" },
    });
    expect(rows.map((row) => [row.id, row.deletedAt === null])).toEqual([
      [61, true],
      [62, false],
    ]);
  });

  // Within half the budget, and with what else both statements bind, the
  // window stays exact: a row restored below it after the lock is not taken.
  test("a window within the bind budget takes exactly its locked keys", async () => {
    const driver = new AfterLockSQLite3Driver();
    const { base, db } = await fixture(driver);
    await base.post.create({
      data: { id: 5000, authorId: 1, title: "p5000", deletedAt: new Date(0) },
    });
    await base.post.createMany({
      data: Array.from({ length: 400 }, (_, index) => ({
        id: 5001 + index,
        authorId: 1,
        title: `p${5001 + index}`,
      })),
    });
    driver.afterRead = 'UPDATE "post" SET "deletedAt" = NULL WHERE "id" = 5000';
    expect(
      await db.post.deleteMany({ where: { id: { gte: 5000 } }, limit: 400 })
    ).toEqual({ count: 400 });
    expect(
      await base.post.findMany({
        where: { id: { gte: 5000 }, deletedAt: null },
        select: { id: true },
      })
    ).toEqual([{ id: 5000 }]);
  });

  // Past the bind budget the window is the candidates up to the last locked
  // key, with the limit kept on the effect: a row that becomes a candidate
  // below that key after the lock can be taken, but never on top of `limit`.
  test("a window past the bind budget still takes at most `limit` rows", async () => {
    const driver = new AfterLockSQLite3Driver();
    const { base, db } = await fixture(driver);
    await base.post.create({
      data: { id: 5000, authorId: 1, title: "p5000", deletedAt: new Date(0) },
    });
    await base.post.createMany({
      data: Array.from({ length: 1000 }, (_, index) => ({
        id: 5001 + index,
        authorId: 1,
        title: `p${5001 + index}`,
      })),
    });
    // The lock takes 5001-6000 (1000 keys, past SQLite's 999); another
    // writer then restores 5000, which sorts below them all.
    driver.afterRead = 'UPDATE "post" SET "deletedAt" = NULL WHERE "id" = 5000';
    expect(
      await db.post.deleteMany({ where: { id: { gte: 5000 } }, limit: 1000 })
    ).toEqual({ count: 1000 });
    expect(
      await base.post.findMany({
        where: { id: { gte: 5000 }, deletedAt: null },
        select: { id: true },
      })
    ).toEqual([{ id: 6000 }]);
  });

  // A set of key equalities nests one level per key: 995 keys, a one-value
  // filter and the tombstone's three assignments fit SQLite's 999 bound
  // values exactly, but not its expression depth of 1000. The keys are
  // counted against half the budget before anything is compiled, so the
  // window takes the key range instead.
  test("a window of keys past half the budget is never compiled", async () => {
    const { base, db } = await fixture(new AfterLockSQLite3Driver());
    await base.author.create({ data: { id: 9, name: "a9" } });
    await base.post.createMany({
      data: Array.from({ length: 995 }, (_, index) => ({
        id: 7000 + index,
        authorId: 9,
        title: `d${index}`,
      })),
    });
    expect(
      await db.post.deleteMany({ where: { authorId: 9 }, limit: 995 })
    ).toEqual({ count: 995 });
  });
});
