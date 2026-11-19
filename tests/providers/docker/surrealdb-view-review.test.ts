/**
 * Views on SurrealDB, the cases a review of them found, against a server. A
 * view's column copied from its source's foreign key holds a record of the
 * table that key targets: towards that table it compares as the record, and
 * towards any other model, another view among them, by the key it names. A
 * column holding the key itself, unset, names no row, and a compound key's
 * integer part is looked up as the key holds it. A filtered column made
 * nullable replaces the view reading it, whose filter then admits a row
 * without a value, and the rename of the table a filtered foreign key
 * targets replaces it too, since the links it compares are rewritten. And
 * the body one view is written as, which its identity does not hold. Gated
 * on SURREAL_TEST_URL.
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { createMigrationClient } from "@migrations/dialects/surrealql";
import type { ResolveCallback } from "@migrations/types";
import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import {
  createSurrealTestDriver,
  surrealUrl,
} from "@tests/fixtures/drivers/surrealdb";
import { describe, expect, it } from "vitest";

type Client = any;

/** A driver on a database of its own. */
async function freshDriver(): Promise<AnyDriver> {
  const driver = createSurrealTestDriver();
  await (driver as unknown as { fresh(): Promise<void> }).fresh();
  return driver as never;
}

const clientOf = (schema: object, driver: AnyDriver): Client =>
  createClient({ schema: schema as never, driver: driver as never });

/** A destructive change proceeds, and a table that left for one that came is a rename. */
const resolve: ResolveCallback = (change) => {
  if (change.type === "destructive") return change.proceed();
  if (change.type === "ambiguous") return change.rename();
  return;
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

async function using(client: Client, body: () => Promise<void>) {
  try {
    await body();
  } finally {
    await client.$disconnect();
  }
}

const ids = (rows: readonly { readonly id: unknown }[]) =>
  rows.map(({ id }) => id);

/**
 * `writerId` is the entry's foreign key, so it holds a record of
 * `svr_writers`, and the views of entries copy it. `goodWriter` keys its rows
 * under its own table, and `badge` names a writer by a number of its own: a
 * relation to either compares by the key the record names.
 */
function writers() {
  const writer = s
    .model({
      id: s.int().id(),
      name: s.string(),
      entries: s.toMany(() => entry),
      liveEntries: s.toMany(() => liveEntry),
    })
    .map("svr_writers");
  const badge = s
    .model({
      id: s.string().id(),
      writerNo: s.int().unique(),
      liveEntries: s.toMany((): AnyModel => liveEntry),
    })
    .map("svr_badges");
  const entry = s
    .model({
      id: s.int().id(),
      title: s.string(),
      writerId: s.int().nullable(),
      writer: s
        .toOne(() => writer)
        .fields("writerId")
        .references("id"),
      // The foreign key's column, naming a view's key as well.
      goodWriter: s
        .toOne((): AnyModel => goodWriter)
        .fields("writerId")
        .references("id"),
    })
    .map("svr_entries");
  const goodWriter: AnyModel = s
    .view(() => writer, { where: { name: { startsWith: "A" } } })
    .extends({
      liveEntries: s.toMany((): AnyModel => liveEntry),
      entries: s.toMany(() => entry),
      digests: s.toMany((): AnyModel => digest),
    })
    .map("svr_good_writers");
  const liveEntry: AnyModel = s
    .view(() => entry, {
      select: { id: true, title: true, writerId: true },
    })
    .extends({
      writer: s
        .toOne(() => goodWriter)
        .fields("writerId")
        .references("id"),
      anyWriter: s
        .toOne(() => writer)
        .fields("writerId")
        .references("id"),
      badge: s
        .toOne(() => badge)
        .fields("writerId")
        .references("writerNo"),
    })
    .map("svr_live_entries");
  // A view of a view, carrying the column.
  const digest: AnyModel = s
    .view(() => liveEntry, { select: { id: true, writerId: true } })
    .extends({
      writer: s
        .toOne(() => goodWriter)
        .fields("writerId")
        .references("id"),
    })
    .map("svr_digests");
  return { writer, badge, entry, goodWriter, liveEntry, digest };
}

/**
 * Columns holding a key itself, unset on a row: a view's naming a table's
 * key, and a table's naming a view's.
 */
function unsetKeys() {
  const author = s
    .model({
      id: s.int().id(),
      name: s.string(),
      liveDrafts: s.toMany((): AnyModel => liveDraft),
    })
    .map("svr_authors");
  const draft = s
    .model({ id: s.int().id(), editorId: s.int().nullable() })
    .map("svr_drafts");
  const goodAuthor: AnyModel = s
    .view(() => author, { where: { name: { startsWith: "A" } } })
    .extends({ reviews: s.toMany((): AnyModel => review) })
    .map("svr_good_authors");
  const liveDraft: AnyModel = s
    .view(() => draft, { select: { id: true, editorId: true } })
    .extends({
      editor: s
        .toOne(() => author)
        .fields("editorId")
        .references("id"),
    })
    .map("svr_live_drafts");
  const review = s
    .model({
      id: s.int().id(),
      authorId: s.int().nullable(),
      author: s
        .toOne(() => goodAuthor)
        .fields("authorId")
        .references("id"),
    })
    .map("svr_reviews");
  return { author, draft, goodAuthor, liveDraft, review };
}

/** A compound key with an integer part, named from a table and from a view. */
function pairs() {
  const pair = s
    .model({
      a: s.string(),
      b: s.int(),
      label: s.string(),
      tags: s.toMany(() => tag),
    })
    .id(["a", "b"])
    .map("svr_pairs");
  const tag = s
    .model({
      id: s.int().id(),
      pairA: s.string(),
      pairB: s.int(),
      pair: s
        .toOne(() => pair)
        .fields("pairA", "pairB")
        .references("a", "b"),
    })
    .map("svr_tags");
  const livePair: AnyModel = s
    .view(() => pair, { where: { b: { gt: 0 } } })
    .extends({ tags: s.toMany((): AnyModel => liveTag) })
    .map("svr_live_pairs");
  const liveTag: AnyModel = s
    .view(() => tag, { select: { id: true, pairA: true, pairB: true } })
    .extends({
      pair: s
        .toOne(() => livePair)
        .fields("pairA", "pairB")
        .references("a", "b"),
    })
    .map("svr_live_tags");
  return { pair, tag, livePair, liveTag };
}

/** `title` required, or nullable, under a view that filters on it. */
function titles(nullable: boolean) {
  const post: AnyModel = s
    .model({
      id: s.string().id(),
      title: nullable ? s.string().nullable() : s.string(),
      score: s.int(),
    })
    .map("svr_posts");
  const feed = s
    .view(() => post, {
      where: { title: { startsWith: "t" } },
      select: { id: true, score: true },
    } as never)
    .map("svr_feed");
  return { post, feed };
}

/**
 * The filter of the view whose body is pinned below: a string function, a
 * number comparison, a nullable column and an `in` list.
 */
/**
 * A view filtered by its source's foreign key, whose value is a record of the
 * authors' table: `authors` names that table.
 */
function firsts(authors: string) {
  const author = s
    .model({
      id: s.int().id(),
      name: s.string(),
      posts: s.toMany(() => post),
    })
    .map(authors);
  const post = s
    .model({
      id: s.int().id(),
      title: s.string(),
      authorId: s.int(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
    })
    .map("svr_posts");
  const first = s
    .view(() => post, {
      select: { id: true, title: true },
      where: { authorId: 1 },
    })
    .map("svr_firsts");
  return { author, post, first };
}

const SHELF_WHERE = {
  name: { startsWith: "a" },
  rank: { gte: 2 },
  note: { not: "hidden" },
  kind: { in: ["book", "map"] },
};

/** The view whose body is pinned below. */
function pinned() {
  const item = s
    .model({
      id: s.string().id(),
      name: s.string(),
      rank: s.int(),
      note: s.string().nullable(),
      kind: s.string(),
      secret: s.string(),
    })
    .map("svr_items");
  const shelf = s
    .view(() => item, { where: SHELF_WHERE, omit: { secret: true } })
    .map("svr_shelf");
  return { item, shelf };
}

/**
 * The text SurrealDB is asked to define the pinned view with, its identity
 * left out. A view's identity does not hold its body, so a release that
 * lowers the filter otherwise plans no migration, and every view already
 * defined keeps the body it was defined with for ever. A failure here asks
 * which: if every view already defined still reads the same rows, update
 * the text; if not, raise `VIEW_REVISION` (`src/migrations/view-definition.ts`),
 * so that every view is defined again, then update the text.
 */
const SHELF_BODY =
  'DEFINE TABLE svr_shelf AS SELECT id, name, rank, note, kind FROM svr_items WHERE id != NONE AND ((string::starts_with(name, s"a") AND rank >= 2 AND (note != NONE AND !(note = s"hidden")) AND kind IN [s"book", s"map"])) COMMENT "viborm_view_<identity>";';

const IDENTITY = /viborm_view_[0-9a-f]{40}/;

describe.skipIf(!surrealUrl)("views on SurrealDB, after review", () => {
  it("a view's copied foreign key names a record of its target's table, and a view's row by the key it holds", async () => {
    const driver = await freshDriver();
    const client = clientOf(writers(), driver);
    await using(client, async () => {
      await push(client);
      await client.writer.createMany({
        data: [
          { id: 1, name: "Ann" },
          { id: 2, name: "Bob" },
          { id: 3, name: "Abe" },
        ],
      });
      await client.entry.createMany({
        data: [
          { id: 1, title: "e1", writerId: 1 },
          { id: 2, title: "e2", writerId: 2 },
          { id: 3, title: "e3", writerId: null },
        ],
      });
      await client.badge.createMany({
        data: [
          { id: "gold", writerNo: 1 },
          { id: "iron", writerNo: 3 },
        ],
      });
      const ann = { id: 1, name: "Ann" };
      const bob = { id: 2, name: "Bob" };
      // Bob is no good writer: e2's `writer` is empty, its `anyWriter` Bob.
      expect(
        await client.liveEntry.findMany({
          include: { writer: true, anyWriter: true },
          orderBy: { id: "asc" },
        })
      ).toEqual([
        { id: 1, title: "e1", writerId: 1, writer: ann, anyWriter: ann },
        { id: 2, title: "e2", writerId: 2, writer: null, anyWriter: bob },
        { id: 3, title: "e3", writerId: null, writer: null, anyWriter: null },
      ]);
      const live = async (where: object) =>
        ids(
          await client.liveEntry.findMany({
            where,
            select: { id: true },
            orderBy: { id: "asc" },
          })
        );
      expect(await live({ writer: { name: "Bob" } })).toEqual([]);
      expect(await live({ writer: { name: "Ann" } })).toEqual([1]);
      expect(await live({ writer: null })).toEqual([2, 3]);
      expect(await live({ writer: { isNot: null } })).toEqual([1]);
      expect(await live({ anyWriter: { name: "Bob" } })).toEqual([2]);
      expect(await live({ anyWriter: null })).toEqual([3]);
      // From the view's key: the rows whose copied link names it.
      expect(
        await client.goodWriter.findMany({
          select: {
            id: true,
            liveEntries: { select: { id: true } },
            entries: { select: { id: true } },
            digests: { select: { id: true } },
            _count: { select: { liveEntries: true, digests: true } },
          },
          orderBy: { id: "asc" },
        })
      ).toEqual([
        {
          id: 1,
          liveEntries: [{ id: 1 }],
          entries: [{ id: 1 }],
          digests: [{ id: 1 }],
          _count: { liveEntries: 1, digests: 1 },
        },
        {
          id: 3,
          liveEntries: [],
          entries: [],
          digests: [],
          _count: { liveEntries: 0, digests: 0 },
        },
      ]);
      expect(
        ids(
          await client.goodWriter.findMany({
            where: { liveEntries: { some: { title: "e1" } } },
            select: { id: true },
          })
        )
      ).toEqual([1]);
      expect(
        ids(
          await client.goodWriter.findMany({
            where: { entries: { none: {} } },
            select: { id: true },
          })
        )
      ).toEqual([3]);
      // A table's foreign key column naming the view's key, and the table
      // the copied link targets, read from both ends.
      expect(
        await client.entry.findMany({
          select: { id: true, goodWriter: { select: { name: true } } },
          orderBy: { id: "asc" },
        })
      ).toEqual([
        { id: 1, goodWriter: { name: "Ann" } },
        { id: 2, goodWriter: null },
        { id: 3, goodWriter: null },
      ]);
      expect(
        ids(
          await client.entry.findMany({
            where: { goodWriter: { name: "Bob" } },
            select: { id: true },
          })
        )
      ).toEqual([]);
      expect(
        await client.writer.findMany({
          select: { id: true, liveEntries: { select: { id: true } } },
          orderBy: { id: "asc" },
        })
      ).toEqual([
        { id: 1, liveEntries: [{ id: 1 }] },
        { id: 2, liveEntries: [{ id: 2 }] },
        { id: 3, liveEntries: [] },
      ]);
      // A view of the view holds the same record, and names a good writer the same way.
      expect(
        await client.digest.findMany({
          include: { writer: { select: { name: true } } },
          orderBy: { id: "asc" },
        })
      ).toEqual([
        { id: 1, writerId: 1, writer: { name: "Ann" } },
        { id: 2, writerId: 2, writer: null },
        { id: 3, writerId: null, writer: null },
      ]);
      expect(
        ids(
          await client.digest.findMany({
            where: { writer: { name: "Bob" } },
            select: { id: true },
          })
        )
      ).toEqual([]);
      // Towards a key that is no record, the copied link compares by the key
      // it names, and an unset one names nothing.
      expect(
        await client.liveEntry.findMany({
          select: { id: true, badge: { select: { id: true } } },
          orderBy: { id: "asc" },
        })
      ).toEqual([
        { id: 1, badge: { id: "gold" } },
        { id: 2, badge: null },
        { id: 3, badge: null },
      ]);
      expect(await live({ badge: { id: "gold" } })).toEqual([1]);
      expect(
        await client.badge.findMany({
          select: { id: true, liveEntries: { select: { id: true } } },
          orderBy: { id: "asc" },
        })
      ).toEqual([
        { id: "gold", liveEntries: [{ id: 1 }] },
        { id: "iron", liveEntries: [] },
      ]);
    });
  });

  it("a column holding a key itself, unset, names no row between a view and a table", async () => {
    const driver = await freshDriver();
    const client = clientOf(unsetKeys(), driver);
    await using(client, async () => {
      await push(client);
      await client.author.create({ data: { id: 1, name: "Ann" } });
      await client.draft.createMany({
        data: [
          { id: 1, editorId: 1 },
          { id: 2, editorId: null },
        ],
      });
      await client.review.createMany({
        data: [
          { id: 1, authorId: 1 },
          { id: 2, authorId: null },
        ],
      });
      const ann = { id: 1, name: "Ann" };
      expect(
        await client.liveDraft.findMany({
          include: { editor: true },
          orderBy: { id: "asc" },
        })
      ).toEqual([
        { id: 1, editorId: 1, editor: ann },
        { id: 2, editorId: null, editor: null },
      ]);
      expect(
        ids(
          await client.liveDraft.findMany({
            where: { editor: null },
            select: { id: true },
          })
        )
      ).toEqual([2]);
      expect(
        await client.review.findMany({
          include: { author: true },
          orderBy: { id: "asc" },
        })
      ).toEqual([
        { id: 1, authorId: 1, author: ann },
        { id: 2, authorId: null, author: null },
      ]);
      expect(
        ids(
          await client.review.findMany({
            where: { author: null },
            select: { id: true },
          })
        )
      ).toEqual([2]);
    });
  });

  it("a compound key names a row by record, an integer part as the key holds it, between tables and between views", async () => {
    const driver = await freshDriver();
    const client = clientOf(pairs(), driver);
    await using(client, async () => {
      await push(client);
      await client.pair.createMany({
        data: [
          { a: "x", b: 1, label: "x1" },
          { a: "x", b: 0, label: "x0" },
        ],
      });
      await client.tag.createMany({
        data: [
          { id: 1, pairA: "x", pairB: 1 },
          { id: 2, pairA: "x", pairB: 0 },
        ],
      });
      // `pairB` is stored as a narrower integer than the key's.
      expect(
        await client.tag.findMany({
          include: { pair: { select: { label: true } } },
          orderBy: { id: "asc" },
        })
      ).toEqual([
        { id: 1, pairA: "x", pairB: 1, pair: { label: "x1" } },
        { id: 2, pairA: "x", pairB: 0, pair: { label: "x0" } },
      ]);
      expect(
        await client.liveTag.findMany({
          include: { pair: { select: { label: true } } },
          orderBy: { id: "asc" },
        })
      ).toEqual([
        { id: 1, pairA: "x", pairB: 1, pair: { label: "x1" } },
        { id: 2, pairA: "x", pairB: 0, pair: null },
      ]);
      expect(
        ids(
          await client.liveTag.findMany({
            where: { pair: null },
            select: { id: true },
          })
        )
      ).toEqual([2]);
      expect(
        await client.livePair.findMany({
          select: { label: true, tags: { select: { id: true } } },
        })
      ).toEqual([{ label: "x1", tags: [{ id: 1 }] }]);
    });
  });

  it("a filtered column made nullable replaces the view, whose filter then admits a row without a value", async () => {
    const driver = await freshDriver();
    const required = clientOf(titles(false), driver);
    const nullable = clientOf(titles(true), driver);
    await using(nullable, async () => {
      await push(required);
      await required.post.createMany({
        data: [
          { id: "p1", title: "t1", score: 1 },
          { id: "p2", title: "u2", score: 2 },
        ],
      });
      await required.$disconnect();
      const { labels } = await push(nullable);
      expect(labels.at(0)).toBe('- Drop view "svr_feed"');
      expect(labels.at(-1)).toBe('+ Create view "svr_feed"');
      // The view's filter was written for a title that is always there: kept,
      // the database refuses both writes ("Expected string but found NONE").
      await nullable.post.create({
        data: { id: "p3", title: null, score: 3 },
      });
      await nullable.post.update({
        where: { id: "p1" },
        data: { title: null },
      });
      await nullable.post.create({
        data: { id: "p4", title: "t4", score: 4 },
      });
      expect(await nullable.feed.findMany({ orderBy: { id: "asc" } })).toEqual([
        { id: "p4", score: 4 },
      ]);
      expect(await createMigrationClient(nullable).push()).toMatchObject({
        outcome: "noop",
      });
    });
  });

  it("a view filtered by a foreign key follows the rename of the table that key targets", async () => {
    const driver = await freshDriver();
    const before = clientOf(firsts("svr_authors"), driver);
    const after = clientOf(firsts("svr_scribes"), driver);
    await using(after, async () => {
      await push(before);
      await before.author.createMany({
        data: [
          { id: 1, name: "a" },
          { id: 2, name: "b" },
        ],
      });
      await before.post.createMany({
        data: [
          { id: 1, title: "p1", authorId: 1 },
          { id: 2, title: "p2", authorId: 2 },
        ],
      });
      expect(ids(await before.first.findMany())).toEqual([1]);
      await before.$disconnect();
      const { labels } = await push(after);
      expect(labels).toContain('- Drop view "svr_firsts"');
      expect(labels.at(-1)).toBe('+ Create view "svr_firsts"');
      // The rename rewrites each post's record of its author: the view's
      // filter, written for the old table's record, would match none.
      await after.post.create({ data: { id: 3, title: "p3", authorId: 1 } });
      expect(
        ids(await after.first.findMany({ orderBy: { id: "asc" } }))
      ).toEqual([1, 3]);
      expect(await createMigrationClient(after).push()).toMatchObject({
        outcome: "noop",
      });
    });
  });

  it("the body a view is defined with, which its identity does not hold", async () => {
    const driver = await freshDriver();
    const client = clientOf(pinned(), driver);
    await using(client, async () => {
      const { statements } = await push(client);
      const body = statements.find((statement: string) =>
        statement.startsWith("DEFINE TABLE svr_shelf ")
      );
      expect(body?.replace(IDENTITY, "viborm_view_<identity>")).toBe(
        SHELF_BODY
      );
      // The body defined reads the rows the query reads on its source: an
      // unset note is not one that differs from "hidden".
      await client.item.createMany({
        data: [
          { id: "i1", name: "atlas", rank: 3, note: null, kind: "map" },
          { id: "i2", name: "almanac", rank: 2, note: "ok", kind: "book" },
          { id: "i3", name: "abacus", rank: 5, note: "hidden", kind: "book" },
          { id: "i4", name: "arc", rank: 1, note: "ok", kind: "book" },
          { id: "i5", name: "bell", rank: 4, note: "ok", kind: "book" },
          { id: "i6", name: "anvil", rank: 4, note: "ok", kind: "tool" },
        ].map((row) => ({ ...row, secret: "s" })),
      });
      expect(
        ids(
          await client.item.findMany({
            where: SHELF_WHERE,
            select: { id: true },
          })
        )
      ).toEqual(["i2"]);
      expect(ids(await client.shelf.findMany())).toEqual(["i2"]);
    });
  });
});
