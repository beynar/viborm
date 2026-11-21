/**
 * Views (`s.view`) on SurrealDB, against a server: `DEFINE TABLE <view> AS
 * SELECT … FROM <source> WHERE …`, which the database keeps current for every
 * write to its source. A push defines a view and reads it back by the marker
 * its comment holds (a second push plans nothing), replaces it when its query
 * changes or a change to its source would break it, removes it when it is no
 * longer declared, and reset removes views before tables. A view reads as a
 * table, its fields holding what its source's hold; its relations read both
 * ways; a query a view cannot hold here is refused with the view named, and so
 * is a name the database holds as something VibORM did not create. Gated on
 * SURREAL_TEST_URL.
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { UnsupportedOperationError } from "@errors";
import { createMigrationClient } from "@migrations/dialects/surrealql";
import { getMigrationDriver } from "@migrations/drivers";
import { surrealMigrationDriver } from "@migrations/drivers/surrealql";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import type { ResolveCallback } from "@migrations/types";
import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import { sql } from "@sql";
import { DbNull, Decimal } from "@src/index";
import {
  createSurrealRecordingDriver,
  createSurrealTestDriver,
  surrealUrl,
} from "@tests/fixtures/drivers/surrealdb";
import { describe, expect, it } from "vitest";

type Client = any;

/** Values a body must carry as written: a line break, a quote, a backslash. */
const NOTED = ['line\nbreak "quoted"', "back\\slash"];

/** What a body, a plan and a refusal are expected to say. */
const ID_FIELD_BODY =
  /^DEFINE TABLE sv_ids AS SELECT id, id_field, label FROM sv_things COMMENT "viborm_view_[0-9a-f]{40}";$/;
const FEED_BODY =
  /^DEFINE TABLE sv_feed AS SELECT id, title, score, views, price, at, cover, kind, tags, meta, author_ref FROM sv_posts WHERE id != NONE AND \(\(score > 0 AND title NOT IN \[s"line\\nbreak \\"quoted\\"", s"back\\\\slash"\]\)\) COMMENT "viborm_view_[0-9a-f]{40}";$/;
const DIGEST_BODY =
  /^DEFINE TABLE sv_digest AS SELECT id, title FROM sv_feed WHERE id != NONE AND \(string::starts_with\(title, s"t"\)\) COMMENT "viborm_view_[0-9a-f]{40}";$/;
const NO_KEY = /view that projects no key/;
const NEVER_WRITTEN = /is a view: it is read, never written/;
const REMOVE_DIGEST = /^REMOVE TABLE sv_digest;/;
const REMOVE_FEED = /^REMOVE TABLE sv_feed;/;
const REMOVE_POSTS = /^REMOVE TABLE IF EXISTS sv_posts;/;
const REMOVE_KINDS = /^REMOVE TABLE sv_kinds;/;
const INCLUDED_RELATION =
  /View 'bad' cannot be created from a query that selects 'author' through a relation: SurrealDB keeps a view current for writes to its source table only/;
const SELECTED_RELATION = /selects 'author' through a relation/;
const SELECTED_COUNT = /selects '_count' through a relation/;
const RELATION_FILTER =
  /View 'bad' cannot be created from a query that filters through a relation/;
const WINDOW =
  /takes a window: SurrealDB keeps no order and no window in a view/;
const ORDER = /orders its rows/;
const DISTINCT = /keeps one row per distinct value/;
const SQL_FRAGMENT = /filters with an SQL fragment/;
const NO_LITERAL = /has no SurrealQL literal: it holds a lone UTF-16 surrogate/;
const FOREIGN_VIEW_OVER_VIEW =
  /relation "sv_feed" is a view VibORM did not create, but this schema declares a view/;
const FOREIGN_VIEW_OVER_TABLE =
  /relation "sv_extra" is a view VibORM did not create, but this schema declares a table/;
const UNBOUND =
  /View 'feed' is written by the read backend of the SurrealDB driver it is migrated with, and this migration is bound to none/;

function models(options: { heading?: boolean; table?: string } = {}) {
  const author = s
    .model({
      id: s.int().id(),
      name: s.string(),
      posts: s.toMany(() => post),
    })
    .map("sv_authors");
  const post = s
    .model({
      id: s.string().id(),
      ...(options.heading ? { heading: s.string() } : { title: s.string() }),
      score: s.int(),
      views: s.bigInt(),
      price: s.decimal({ precision: 10, scale: 2 }),
      at: s.dateTime(),
      cover: s.blob().nullable(),
      kind: s.enum(["note", "essay"]),
      tags: s.string().array(),
      meta: s.json().nullable(),
      secret: s.string(),
      authorId: s.int().map("author_ref"),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
    })
    .map(options.table ?? "sv_posts");
  return { author, post };
}

const feedQuery = {
  where: { score: { gt: 0 }, title: { notIn: NOTED } },
  omit: { secret: true },
} as const;

/** A view of each kind: keyed, on a view, keyless. */
function schemaOf(feed: "first" | "second" | "none" = "first") {
  const { author, post } = models();
  if (feed === "none") return { author, post };
  const view = s
    .view(
      () => post,
      feed === "first"
        ? feedQuery
        : { where: { score: { gt: 1 } }, select: { id: true, title: true } }
    )
    .map("sv_feed");
  // Either version of the feed: its query's type is the union's, which no
  // query of both satisfies, so the view is read as any model.
  const digest = s
    .view((): AnyModel => view, {
      where: { title: { startsWith: "t" } },
      select: { id: true, title: true },
    })
    .map("sv_digest");
  const kinds = s
    .view(() => post, { select: { kind: true, score: true } })
    .map("sv_kinds");
  return { author, post, feed: view, digest, kinds };
}

/** A driver on a database of its own. */
async function freshDriver(): Promise<AnyDriver> {
  const driver = createSurrealTestDriver();
  await (driver as unknown as { fresh(): Promise<void> }).fresh();
  return driver as never;
}

const clientOf = (schema: object, driver: AnyDriver): Client =>
  createClient({ schema: schema as never, driver: driver as never });

/** Renames are renames, and a destructive change proceeds. */
const resolve: ResolveCallback = (change) => {
  if (change.type === "ambiguous") return change.rename();
  if (change.type === "destructive") return change.proceed();
  return undefined;
};

/** Push `client`'s schema through preview and consent: the labels it ran, and its statements. */
async function push(client: Client) {
  const migrations = createMigrationClient(client);
  const preview = await migrations.push({ dryRun: true, resolve });
  const result = await migrations.push({ consent: preview.consent, resolve });
  return {
    labels: result.operations.map(({ label }: { label: string }) => label),
    statements: preview.statements.map(({ sql }: { sql: string }) => sql),
  };
}

const pushAgain = (client: Client) => createMigrationClient(client).push();

async function liveViews(driver: AnyDriver) {
  const snapshot = await getMigrationDriver(driver).introspect(
    (statement, parameters) => driver._executeRaw(statement, parameters)
  );
  return {
    tables: snapshot.tables.map(({ name }) => name).sort(),
    views: (snapshot.views ?? []).map(({ name, hash, dependsOn }) => ({
      name,
      hash,
      dependsOn,
    })),
  };
}

const raw = async (client: Client, statement: string) =>
  (await client.$driver._executeRaw(statement)).rows;

async function using(client: Client, body: () => Promise<void>) {
  try {
    await body();
  } finally {
    await client.$disconnect();
  }
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** A value as data to compare: a `Decimal` has no own property, bytes compare by content. */
function plain(value: unknown): unknown {
  if (value instanceof Decimal) return `decimal:${value.toString()}`;
  if (value instanceof Uint8Array) return `bytes:${hex(value)}`;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (typeof value === "bigint") return `bigint:${value}`;
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, plain(member)])
    );
  return value;
}

/** Rows compared whatever their order and the order of their keys: a view without a key has none. */
const unordered = (rows: readonly unknown[]) =>
  rows
    .map((row) =>
      JSON.stringify(
        Object.entries(plain(row) as object).sort(([left], [right]) =>
          left < right ? -1 : 1
        )
      )
    )
    .sort();

async function seed(client: Client) {
  await client.author.createMany({
    data: [
      { id: 1, name: "Ann" },
      { id: 2, name: "Bob" },
    ],
  });
  const at = new Date("2026-01-02T03:04:05.678Z");
  const rows = [
    ["p0", "t0", 0, "note", 1],
    ["p1", "t1", 1, "essay", 1],
    ["p2", "t2", 2, "note", 2],
    ["p3", NOTED[0], 3, "essay", 2],
    ["p4", "u4", 4, "essay", 1],
  ] as const;
  for (const [id, title, score, kind, authorId] of rows)
    await client.post.create({
      data: {
        id,
        title,
        score,
        views: 10n ** 15n + BigInt(score),
        price: `${score}.25`,
        at: new Date(at.getTime() + score * 1000),
        cover: score % 2 === 0 ? new Uint8Array([score, 255]) : null,
        kind,
        tags: [`tag${score}`, "all"],
        meta: score === 1 ? { k: [1, "x"] } : DbNull,
        secret: `secret${score}`,
        authorId,
      },
    });
}

describe.skipIf(!surrealUrl)("views on SurrealDB", () => {
  it("a push defines each view as a table the database computes, and a second push plans nothing", async () => {
    const driver = await freshDriver();
    const client = clientOf(schemaOf(), driver);
    await using(client, async () => {
      const { labels, statements } = await push(client);
      expect(labels).toEqual([
        '+ Create table "sv_authors" with 2 columns',
        '+ Create table "sv_posts" with 12 columns',
        '+ Create view "sv_feed"',
        '+ Create view "sv_kinds"',
        '+ Create view "sv_digest"',
      ]);
      // Its fields by their stored names (the key is the record's id), its
      // filter as a read lowers it with each value a literal, its identity
      // the table's comment.
      expect(statements).toContainEqual(expect.stringMatching(FEED_BODY));
      expect(statements).toContainEqual(expect.stringMatching(DIGEST_BODY));
      expect(await pushAgain(client)).toMatchObject({
        outcome: "noop",
        operations: [],
      });
      const live = await liveViews(driver);
      expect(live.tables).toEqual(["sv_authors", "sv_posts"]);
      expect(
        live.views.map(({ name, dependsOn }) => [name, dependsOn])
      ).toEqual([
        ["sv_digest", ["sv_feed"]],
        ["sv_feed", ["sv_posts"]],
        ["sv_kinds", ["sv_posts"]],
      ]);
    });
  });

  it("a view reads what its query reads on its source, with every read verb", async () => {
    const driver = await freshDriver();
    const client = clientOf(schemaOf(), driver);
    await using(client, async () => {
      await push(client);
      await seed(client);
      const fromSource = await client.post.findMany({
        ...feedQuery,
        orderBy: { id: "asc" },
      });
      expect(fromSource.map(({ id }: { id: string }) => id)).toEqual([
        "p1",
        "p2",
        "p4",
      ]);
      expect(
        plain(await client.feed.findMany({ orderBy: { id: "asc" } }))
      ).toEqual(plain(fromSource));
      // A filter on each kind of field means on the view what it means on the table.
      const filters = [
        { views: { gte: 10n ** 15n + 2n } },
        { price: { lt: "2.5" } },
        { at: { gt: new Date("2026-01-02T03:04:06.000Z") } },
        { cover: { equals: new Uint8Array([2, 255]) } },
        { cover: null },
        { kind: "essay" },
        { tags: { has: "tag4" } },
        { meta: { path: ["k"], array_contains: "x" } },
        { authorId: 2 },
        { id: { in: ["p1", "p4"] } },
        { title: { contains: "1", mode: "insensitive" } },
      ];
      for (const where of filters)
        expect(
          plain(await client.feed.findMany({ where, orderBy: { id: "asc" } }))
        ).toEqual(
          plain(
            await client.post.findMany({
              where: { AND: [feedQuery.where, where] },
              omit: { secret: true },
              orderBy: { id: "asc" },
            })
          )
        );
      expect(
        plain(await client.feed.findUnique({ where: { id: "p2" } }))
      ).toEqual(
        plain(
          await client.post.findUnique({
            where: { id: "p2" },
            omit: { secret: true },
          })
        )
      );
      expect(await client.feed.findUnique({ where: { id: "p0" } })).toBeNull();
      expect(
        await client.feed.findFirst({
          where: { score: { gt: 1 } },
          orderBy: { score: "desc" },
          select: { id: true },
        })
      ).toEqual({ id: "p4" });
      // A cursor pages the view by its key, which is its source's.
      expect(
        await client.feed.findMany({
          cursor: { id: "p2" },
          skip: 1,
          take: 5,
          orderBy: { id: "asc" },
          select: { id: true },
        })
      ).toEqual([{ id: "p4" }]);
      expect(await client.feed.count()).toBe(3);
      expect(await client.feed.count({ where: { kind: "note" } })).toBe(1);
      expect(
        plain(
          await client.feed.aggregate({
            _sum: { score: true, views: true },
            _max: { price: true, at: true },
            _count: { _all: true },
          })
        )
      ).toEqual(
        plain(
          await client.post.aggregate({
            where: feedQuery.where,
            _sum: { score: true, views: true },
            _max: { price: true, at: true },
            _count: { _all: true },
          })
        )
      );
      expect(
        await client.feed.groupBy({
          by: ["kind"],
          _count: { _all: true },
          orderBy: { kind: "asc" },
        })
      ).toEqual([
        { kind: "essay", _count: { _all: 2 } },
        { kind: "note", _count: { _all: 1 } },
      ]);
      expect(
        await client.feed.exist({ where: { meta: { equals: DbNull } } })
      ).toBe(true);
      expect(
        await client.feed.findMany({
          select: { id: true, authorId: true },
          orderBy: { id: "asc" },
        })
      ).toEqual([
        { id: "p1", authorId: 1 },
        { id: "p2", authorId: 2 },
        { id: "p4", authorId: 1 },
      ]);
      // A view on the view, and a view that projects no key: no unique read.
      expect(await client.digest.findMany({ orderBy: { id: "asc" } })).toEqual([
        { id: "p1", title: "t1" },
        { id: "p2", title: "t2" },
      ]);
      expect(unordered(await client.kinds.findMany())).toEqual(
        unordered(
          await client.post.findMany({ select: { kind: true, score: true } })
        )
      );
      expect(
        await client.kinds.findMany({ orderBy: { score: "desc" }, take: 2 })
      ).toEqual([
        { kind: "essay", score: 4 },
        { kind: "essay", score: 3 },
      ]);
      await expect(
        client.kinds.findUnique({ where: { kind: "note" } })
      ).rejects.toThrow(NO_KEY);
      // A write is refused before any statement; the server would refuse it too.
      await expect(
        client.feed.create({ data: { id: "x" } } as never)
      ).rejects.toThrow(NEVER_WRITTEN);
      await expect(raw(client, "DELETE sv_feed:p1")).rejects.toThrow();
      expect(await client.feed.count()).toBe(3);
    });
  });

  it("a view follows every write to its source, and a view on it too", async () => {
    const driver = await freshDriver();
    const client = clientOf(schemaOf(), driver);
    await using(client, async () => {
      await push(client);
      await seed(client);
      await client.post.update({ where: { id: "p0" }, data: { score: 5 } });
      await client.post.update({
        where: { id: "p1" },
        data: { title: "renamed" },
      });
      await client.post.delete({ where: { id: "p2" } });
      await client.post.create({
        data: {
          id: "p5",
          title: "t5",
          score: 5,
          views: 1n,
          price: "1",
          at: new Date(),
          kind: "note",
          tags: [],
          secret: "s",
          authorId: 1,
        },
      });
      expect(
        await client.feed.findMany({
          select: { id: true, title: true },
          orderBy: { id: "asc" },
        })
      ).toEqual([
        { id: "p0", title: "t0" },
        { id: "p1", title: "renamed" },
        { id: "p4", title: "u4" },
        { id: "p5", title: "t5" },
      ]);
      expect(await client.digest.findMany({ orderBy: { id: "asc" } })).toEqual([
        { id: "p0", title: "t0" },
        { id: "p5", title: "t5" },
      ]);
    });
  });

  it("a changed query replaces the view, a change to its source replaces it around the change, and an undeclared view goes", async () => {
    const driver = await freshDriver();
    const client = clientOf(schemaOf(), driver);
    await using(client, async () => {
      await push(client);
      await seed(client);

      const second = clientOf(schemaOf("second"), driver);
      expect((await push(second)).labels).toEqual([
        '- Drop view "sv_digest"',
        '- Drop view "sv_feed"',
        '+ Create view "sv_feed"',
        '+ Create view "sv_digest"',
      ]);
      expect(await pushAgain(second)).toMatchObject({ outcome: "noop" });
      expect(await second.feed.findMany({ orderBy: { id: "asc" } })).toEqual([
        { id: "p2", title: "t2" },
        { id: "p3", title: NOTED[0] },
        { id: "p4", title: "u4" },
      ]);

      // A rename of a field the view reads, then of its table: SurrealDB
      // removes a table only once no view reads it, and a renamed field
      // would leave the view's copy stale.
      const { author, post } = models({ heading: true });
      const heading = clientOf(
        {
          author,
          post,
          kinds: s
            .view(() => post, { select: { kind: true, score: true } })
            .map("sv_kinds"),
        },
        driver
      );
      expect((await push(heading)).labels).toEqual([
        '- Drop view "sv_digest"',
        '- Drop view "sv_kinds"',
        '- Drop view "sv_feed"',
        '~ Rename column "title" → "heading" in "sv_posts"',
        '+ Create view "sv_kinds"',
      ]);
      const moved = models({ heading: true, table: "sv_articles" });
      const renamed = clientOf(
        {
          ...moved,
          kinds: s
            .view(() => moved.post, { select: { kind: true, score: true } })
            .map("sv_kinds"),
        },
        driver
      );
      expect((await push(renamed)).labels).toEqual([
        '- Drop view "sv_kinds"',
        '~ Rename table "sv_posts" → "sv_articles"',
        '+ Create view "sv_kinds"',
      ]);
      expect(await pushAgain(renamed)).toMatchObject({ outcome: "noop" });
      expect(await renamed.kinds.count()).toBe(5);
      await renamed.post.update({ where: { id: "p0" }, data: { score: 9 } });
      expect(await renamed.kinds.count({ where: { score: 9 } })).toBe(1);

      const none = clientOf(models(), driver);
      const undeclared = clientOf(
        { author: moved.author, post: moved.post },
        driver
      );
      expect((await push(undeclared)).labels).toEqual([
        '- Drop view "sv_kinds"',
      ]);
      expect((await liveViews(driver)).views).toEqual([]);
      await none.$disconnect();
      await heading.$disconnect();
      await second.$disconnect();
    });
  });

  it("a field named id beside another key, and a compound key, read in a view where their source's are", async () => {
    const thing = s
      .model({ slug: s.string().id(), id: s.string(), label: s.string() })
      .map("sv_things");
    const pair = s
      .model({ a: s.string(), b: s.int(), label: s.string() })
      .id(["a", "b"])
      .map("sv_pairs");
    // The source's key is not projected: the view keeps it in its record.
    const ids = s
      .view(() => thing, { select: { id: true, label: true } })
      .map("sv_ids");
    const pairs = s
      .view(() => pair, { where: { b: { gt: 0 } } })
      .map("sv_pair_view");
    const halves = s
      .view(() => pair, { select: { a: true, label: true } })
      .map("sv_halves");
    const driver = await freshDriver();
    const client = clientOf({ thing, pair, ids, pairs, halves }, driver);
    await using(client, async () => {
      const { statements } = await push(client);
      expect(statements).toContainEqual(expect.stringMatching(ID_FIELD_BODY));
      await client.thing.create({
        data: { slug: "s1", id: "own", label: "one" },
      });
      await client.pair.createMany({
        data: [
          { a: "x", b: 1, label: "x1" },
          { a: "x", b: 0, label: "x0" },
          { a: "y", b: 2, label: "y2" },
        ],
      });
      expect(await client.ids.findMany()).toEqual([
        { id: "own", label: "one" },
      ]);
      expect(await client.ids.count({ where: { id: "own" } })).toBe(1);
      expect(
        await client.pairs.findUnique({ where: { a_b: { a: "y", b: 2 } } })
      ).toEqual({ a: "y", b: 2, label: "y2" });
      expect(
        await client.pairs.findMany({
          where: { a: "x" },
          orderBy: { b: "asc" },
        })
      ).toEqual([{ a: "x", b: 1, label: "x1" }]);
      expect(
        await client.halves.findMany({
          where: { a: "x" },
          orderBy: { label: "asc" },
        })
      ).toEqual([
        { a: "x", label: "x0" },
        { a: "x", label: "x1" },
      ]);
    });
  });

  it("a foreign key added under a view replaces it: the column then holds record links, which its filter compares", async () => {
    const version = (linked: boolean) => {
      const author = s
        .model({
          id: s.int().id(),
          name: s.string(),
          ...(linked ? { posts: s.toMany(() => post) } : {}),
        })
        .map("sv_authors");
      const post: AnyModel = s
        .model({
          id: s.string().id(),
          title: s.string(),
          authorId: s.int(),
          ...(linked
            ? {
                author: s
                  .toOne(() => author)
                  .fields("authorId")
                  .references("id"),
              }
            : {}),
        })
        .map("sv_posts");
      const mine = s
        .view(() => post, {
          where: { authorId: 1 },
          select: { id: true, title: true },
        } as never)
        .map("sv_mine");
      return { author, post, mine };
    };
    const driver = await freshDriver();
    const unlinked = clientOf(version(false), driver);
    const linked = clientOf(version(true), driver);
    await using(linked, async () => {
      await push(unlinked);
      await unlinked.author.create({ data: { id: 1, name: "Ann" } });
      expect((await push(linked)).labels).toEqual([
        '- Drop view "sv_mine"',
        '+ Create index "sv_posts_authorId_idx" on "sv_posts"',
        '+ Add foreign key "sv_posts_authorId_fkey" to "sv_posts"',
        '+ Create view "sv_mine"',
      ]);
      await linked.post.create({
        data: { id: "p1", title: "t1", authorId: 1 },
      });
      expect(await linked.mine.findMany()).toEqual([{ id: "p1", title: "t1" }]);
      await unlinked.$disconnect();
    });
  });

  it("a force-reset push and a history reset remove the views before the tables", async () => {
    const driver = await freshDriver();
    const client = clientOf(schemaOf(), driver);
    await using(client, async () => {
      await push(client);
      await seed(client);
      const migrations = createMigrationClient(client);
      // A view VibORM did not create is no table of the estate: a reset
      // leaves it, as SQL's RESTRICT does.
      await raw(
        client,
        "DEFINE TABLE sv_foreign AS SELECT title FROM sv_authors"
      );
      const foreign = await migrations.push({ dryRun: true, forceReset: true });
      expect(
        foreign.statements.filter(({ sql }: { sql: string }) =>
          sql.includes("sv_foreign")
        )
      ).toEqual([]);
      await raw(client, "REMOVE TABLE sv_foreign");
      const plan = await migrations.push({ dryRun: true, forceReset: true });
      const at = (pattern: RegExp) =>
        plan.statements.findIndex(({ sql }: { sql: string }) =>
          pattern.test(sql)
        );
      expect(at(REMOVE_DIGEST)).toBe(0);
      expect(at(REMOVE_FEED)).toBeLessThan(at(REMOVE_POSTS));
      expect(at(REMOVE_KINDS)).toBeLessThan(at(REMOVE_POSTS));
      await migrations.push({ consent: plan.consent });
      expect(await client.feed.count()).toBe(0);
      expect(await pushAgain(client)).toMatchObject({ outcome: "noop" });

      // Through the history: generate, apply, down and reset converge.
      const history = await freshDriver();
      const storage = new MemoryEstateStorage();
      const step = async (name: string, schema: object) => {
        const stepped = clientOf(schema, history);
        const steps = createMigrationClient(stepped, { storage });
        await steps.generate({ name, resolve: resolve as never });
        await expect(steps.apply()).resolves.toMatchObject({
          outcome: "applied",
        });
        await expect(steps.verify()).resolves.toEqual({ ok: true });
        return { stepped, steps };
      };
      const first = await step("first", schemaOf("none"));
      const second = await step("views", schemaOf());
      const viewNames = async () =>
        (await liveViews(history)).views.map(({ name }) => name);
      const ALL = ["sv_digest", "sv_feed", "sv_kinds"];
      expect(await viewNames()).toEqual(ALL);
      // A reset clears the live views first, each proven gone, then applies
      // the history again.
      await expect(second.steps.reset()).resolves.toMatchObject({
        preview: false,
      });
      await expect(second.steps.verify()).resolves.toEqual({ ok: true });
      expect(await viewNames()).toEqual(ALL);
      await expect(second.steps.down({ steps: 1 })).resolves.toMatchObject({
        preview: false,
      });
      await expect(second.steps.verify()).resolves.toEqual({ ok: true });
      expect(await viewNames()).toEqual([]);
      await first.stepped.$disconnect();
      await second.stepped.$disconnect();
    });
  });

  it("a query a view cannot hold on SurrealDB is refused with the view named, before any effect", async () => {
    const { author, post } = models();
    const refused: readonly [Record<string, unknown>, RegExp][] = [
      [{ include: { author: true } }, INCLUDED_RELATION],
      [
        { select: { id: true, author: { select: { name: true } } } },
        SELECTED_RELATION,
      ],
      [
        { select: { id: true, _count: { select: { posts: true } } } },
        SELECTED_COUNT,
      ],
      [{ where: { author: { name: "Ann" } } }, RELATION_FILTER],
      [{ orderBy: { id: "asc" }, take: 2 }, WINDOW],
      [{ orderBy: { id: "asc" } }, ORDER],
      [{ distinct: ["kind"] }, DISTINCT],
      [{ where: { title: { equals: sql`"x"` } } }, SQL_FRAGMENT],
      // A value SurrealQL has no exact literal for is not written as a guess.
      [{ where: { title: "\ud800" } }, NO_LITERAL],
    ];
    for (const [query, message] of refused) {
      const userView =
        "_count" in ((query.select as object) ?? {})
          ? s.view(() => author, query as never).map("sv_bad")
          : s.view(() => post, query as never).map("sv_bad");
      const driver = await freshDriver();
      const client = clientOf({ author, post, bad: userView }, driver);
      await using(client, async () => {
        const failure = createMigrationClient(client).push({ dryRun: true });
        await expect(failure).rejects.toThrow(UnsupportedOperationError);
        await expect(failure).rejects.toThrow(message);
        expect((await liveViews(driver)).tables).toEqual([]);
      });
    }
  });

  it("a name the database holds as something VibORM did not create is refused before any effect", async () => {
    const driver = await freshDriver();
    const client = clientOf(schemaOf("none"), driver);
    await using(client, async () => {
      await push(client);
      await seed(client);
      // A view VibORM did not create under a declared view's name.
      await raw(client, "DEFINE TABLE sv_feed AS SELECT title FROM sv_posts");
      const declared = clientOf(schemaOf(), driver);
      await expect(push(declared)).rejects.toMatchObject({
        code: "V11009",
        message: expect.stringMatching(FOREIGN_VIEW_OVER_VIEW),
      });
      expect((await liveViews(driver)).views).toEqual([]);
      expect(await raw(client, "SELECT title FROM sv_feed:p0")).toEqual([
        { title: "t0" },
      ]);
      await raw(client, "REMOVE TABLE sv_feed");

      // A view VibORM did not create under a declared table's name.
      await raw(client, "DEFINE TABLE sv_extra AS SELECT title FROM sv_posts");
      const extra = clientOf(
        {
          ...schemaOf("none"),
          extra: s.model({ id: s.string().id() }).map("sv_extra"),
        },
        driver
      );
      await expect(push(extra)).rejects.toMatchObject({
        code: "V11009",
        message: expect.stringMatching(FOREIGN_VIEW_OVER_TABLE),
      });
      await raw(client, "REMOVE TABLE sv_extra");

      // A table under a declared view's name is an undeclared table: removed
      // with the consent a drop takes, never without it.
      await raw(
        client,
        "DEFINE TABLE sv_feed SCHEMALESS; CREATE sv_feed:kept SET n = 1"
      );
      await expect(pushAgain(declared)).rejects.toMatchObject({
        code: "V11017",
      });
      expect((await push(declared)).labels).toEqual([
        '- Drop table "sv_feed"',
        '+ Create view "sv_feed"',
        '+ Create view "sv_kinds"',
        '+ Create view "sv_digest"',
      ]);
      expect(await declared.feed.count()).toBe(3);
      await declared.$disconnect();
      await extra.$disconnect();
    });
  });

  it("a view reads the relations of its source whose key columns it keeps, as its source reads them", async () => {
    const writer = s
      .model({
        id: s.int().id(),
        name: s.string(),
        entries: s.toMany(() => entry),
      })
      .map("sv_writers");
    const entry = s
      .model({
        id: s.int().id(),
        title: s.string(),
        published: s.boolean(),
        writerId: s.int(),
        writer: s
          .toOne(() => writer)
          .fields("writerId")
          .references("id"),
        notes: s.toMany(() => note),
        tags: s.toMany(() => tag),
      })
      .map("sv_entries");
    const note = s
      .model({
        id: s.int().id(),
        body: s.string(),
        entryId: s.int(),
        entry: s
          .toOne(() => entry)
          .fields("entryId")
          .references("id"),
      })
      .map("sv_notes");
    const tag = s
      .model({
        id: s.int().id(),
        label: s.string(),
        entries: s.toMany(() => entry),
      })
      .map("sv_tags");
    // `writerId` holds a record of `sv_writers`, the entry's foreign key.
    const liveEntry = s
      .view(() => entry, {
        where: { published: true },
        select: { id: true, title: true, writerId: true },
      })
      .map("sv_live_entries");
    // A view row is its source record under the view's own table: the
    // entries' foreign keys name the writer's table, not this one.
    const writerCard = s
      .view(() => writer, { select: { id: true, name: true } })
      .materialized()
      .map("sv_writer_cards");
    const driver = await freshDriver();
    const client = clientOf(
      { writer, entry, note, tag, liveEntry, writerCard },
      driver
    );
    await using(client, async () => {
      await push(client);
      expect(await pushAgain(client)).toMatchObject({ outcome: "noop" });
      await client.writer.createMany({
        data: [
          { id: 1, name: "Ann" },
          { id: 2, name: "Bob" },
        ],
      });
      await client.tag.create({ data: { id: 1, label: "orm" } });
      await client.entry.create({
        data: {
          id: 1,
          title: "e1",
          published: true,
          writerId: 1,
          tags: { connect: { id: 1 } },
        },
      });
      await client.entry.createMany({
        data: [
          { id: 2, title: "e2", published: false, writerId: 1 },
          { id: 3, title: "e3", published: true, writerId: 2 },
        ],
      });
      await client.note.createMany({
        data: [
          { id: 1, body: "n1", entryId: 1 },
          { id: 2, body: "n2", entryId: 2 },
          { id: 3, body: "n3", entryId: 3 },
        ],
      });
      const select = {
        id: true,
        title: true,
        writer: { select: { name: true } },
        notes: { select: { body: true }, orderBy: { id: "asc" } },
        tags: { select: { label: true } },
        _count: { select: { notes: true } },
      } as const;
      // Every form against the source's own read.
      for (const where of [
        {},
        { writer: { name: "Bob" } },
        { notes: { some: { body: "n1" } } },
        { tags: { none: {} } },
      ])
        expect(
          await client.liveEntry.findMany({
            where,
            select,
            orderBy: { id: "asc" },
          })
        ).toEqual(
          await client.entry.findMany({
            where: { AND: [{ published: true }, where] },
            select,
            orderBy: { id: "asc" },
          })
        );
      expect(
        await client.liveEntry.findMany({
          orderBy: { writer: { name: "desc" } },
          select: { id: true },
        })
      ).toEqual([{ id: 3 }, { id: 1 }]);
      // A to-many, from the view's key to the entries' records of writers.
      const cards = {
        select: {
          id: true,
          entries: { select: { id: true }, orderBy: { id: "asc" } },
        },
        orderBy: { id: "asc" },
      } as const;
      expect(await client.writerCard.findMany(cards)).toEqual(
        await client.writer.findMany(cards)
      );
      expect(
        await client.writerCard.findMany({
          where: { entries: { some: { title: "e3" } } },
          select: { id: true },
        })
      ).toEqual([{ id: 2 }]);
    });
  });

  it("a view walks its source's junctions, declared or generated, and recurses from its rows through them", async () => {
    const seat = s
      .model({
        roomId: s.string(),
        guestId: s.string(),
        room: s
          .toOne(() => room)
          .fields("roomId")
          .references("id"),
        guest: s
          .toOne(() => guest)
          .fields("guestId")
          .references("id"),
      })
      .id(["roomId", "guestId"])
      .map("sv_seats");
    const room = s
      .model({
        id: s.string().id(),
        guests: s
          .toMany(() => guest)
          .through(() => seat)
          .source("room")
          .target("guest"),
      })
      .map("sv_rooms");
    const guest = s
      .model({
        id: s.string().id(),
        name: s.string(),
        rooms: s.toMany(() => room),
        links: s.toMany(() => guest).name("graph"),
        linkedFrom: s.toMany(() => guest).name("graph"),
      })
      .map("sv_guests");
    const liveRoom = s.view(() => room, {}).map("sv_live_rooms");
    const liveGuest = s
      .view(() => guest, { select: { id: true, name: true } })
      .map("sv_live_guests");
    const driver = await freshDriver();
    const client = clientOf({ seat, room, guest, liveRoom, liveGuest }, driver);
    await using(client, async () => {
      await push(client);
      await client.room.createMany({ data: [{ id: "r1" }, { id: "r2" }] });
      await client.guest.createMany({
        data: [
          { id: "a", name: "Ann" },
          { id: "b", name: "Bob" },
          { id: "c", name: "Cy" },
        ],
      });
      await client.seat.create({ data: { roomId: "r1", guestId: "a" } });
      await client.guest.update({
        where: { id: "a" },
        data: { links: { connect: { id: "b" } } },
      });
      await client.guest.update({
        where: { id: "b" },
        data: { links: { connect: { id: "c" } } },
      });
      // A declared junction: its links name the rooms' records.
      for (const args of [
        { select: { id: true, guests: { select: { id: true } } } },
        { where: { guests: { some: {} } }, select: { id: true } },
        { where: { guests: { none: {} } }, select: { id: true } },
        { select: { id: true, _count: { select: { guests: true } } } },
      ])
        expect(
          await client.liveRoom.findMany({ ...args, orderBy: { id: "asc" } })
        ).toEqual(
          await client.room.findMany({ ...args, orderBy: { id: "asc" } })
        );
      // A generated self junction, walked to a depth and exhaustively.
      for (const recurse of [{ depth: 1 }, { depth: false }] as const) {
        const walked = {
          where: { id: "a" },
          select: { id: true, links: { recurse, select: { id: true } } },
        };
        expect(await client.liveGuest.findMany(walked)).toEqual(
          await client.guest.findMany(walked)
        );
      }
      const reaching = {
        where: { links: { recurse: { depth: false }, some: { name: "Cy" } } },
        select: { id: true },
        orderBy: { id: "asc" },
      } as const;
      expect(await client.liveGuest.findMany(reaching)).toEqual(
        await client.guest.findMany(reaching)
      );
    });
  });

  it("a view declared materialized is the same view, and $refresh sends nothing", async () => {
    const { author, post } = models();
    const plainFeed = s.view(() => post, feedQuery).map("sv_feed");
    const materialized = s
      .view(() => post, feedQuery)
      .materialized()
      .map("sv_feed");
    const driver = createSurrealRecordingDriver();
    await (driver as unknown as { fresh(): Promise<void> }).fresh();
    const plainClient = clientOf({ author, post, feed: plainFeed }, driver);
    await push(plainClient);
    const client = clientOf({ author, post, feed: materialized }, driver);
    await using(client, async () => {
      expect(await pushAgain(client)).toMatchObject({ outcome: "noop" });
      const sent = driver.statements.length;
      await expect(client.feed.$refresh()).resolves.toBeUndefined();
      await expect(
        client.feed.$refresh({ concurrently: true })
      ).resolves.toBeUndefined();
      expect(driver.statements.length).toBe(sent);
    });
  });

  it("the migration driver unbound from a SurrealDB client writes no view body", () => {
    const { author, post } = models();
    const feed = s.view(() => post, feedQuery).map("sv_feed");
    // A body is the bound driver's read backend's: without one it is refused by name.
    expect(() =>
      surrealMigrationDriver
        .viewWriter()
        .write({ schema: { author, post, feed } }, feed as AnyModel)
    ).toThrow(UNBOUND);
  });
});
