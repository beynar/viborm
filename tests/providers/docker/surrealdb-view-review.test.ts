/**
 * Views on SurrealDB, the cases a review of them found, against a server. A
 * view's column copied from its source's foreign key holds a record of the
 * table that key targets: towards that table it compares as the record, and
 * towards a key no record holds, by the key it names; a view's row is its
 * source record under its own table, which a link names by its key. A
 * link unset names no row, and a compound key's integer part is looked up
 * as the key holds it, and a key that is an
 * instant or a decimal, which a record holds as text, by its value. A
 * filtered column made
 * nullable replaces the view reading it, whose filter then admits a row
 * without a value, and the rename of the table a filtered foreign key
 * targets replaces it too, since the links it compares are rewritten. A
 * filter's bytes given as a Node `Buffer` are written as bytes, and text
 * holding control characters as escapes the database reads back. And the
 * body one view is written as, which its identity does not hold. Gated on
 * SURREAL_TEST_URL.
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { createMigrationClient } from "@migrations/dialects/surrealql";
import type { ResolveCallback } from "@migrations/types";
import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import { Decimal } from "@src/index";
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

/** A value as data to compare: a `Decimal` has no own property. */
function plain(value: unknown): unknown {
  if (value instanceof Decimal) return `decimal:${value.toString()}`;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, plain(member)])
    );
  return value;
}

/**
 * `writerId` is the entry's foreign key, so it holds a record of
 * `svr_writers`, and the views of entries copy it. `badge` names a writer by
 * a number of its own, so a relation to it compares by the key the record
 * names. `goodWriter` keys its rows under its own table: the entries' links
 * name the writers' table.
 */
function writers() {
  const writer = s
    .model({
      id: s.int().id(),
      name: s.string(),
      entries: s.toMany(() => entry),
    })
    .map("svr_writers");
  const badge = s
    .model({
      id: s.string().id(),
      writerNo: s.int().unique(),
      entries: s.toMany(() => entry).name("badge"),
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
      badge: s
        .toOne(() => badge)
        .name("badge")
        .fields("writerId")
        .references("writerNo"),
    })
    .map("svr_entries");
  const goodWriter = s
    .view(() => writer, { where: { name: { startsWith: "A" } } })
    .map("svr_good_writers");
  const liveEntry = s
    .view(() => entry, { select: { id: true, title: true, writerId: true } })
    .map("svr_live_entries");
  // A view of a view, carrying the column.
  const digest = s
    .view(() => liveEntry, { select: { id: true, writerId: true } })
    .map("svr_digests");
  return { writer, badge, entry, goodWriter, liveEntry, digest };
}

/** A compound key with an integer part, read from views of both ends. */
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
  const livePair = s
    .view(() => pair, { where: { b: { gt: 0 } } })
    .map("svr_live_pairs");
  const liveTag = s
    .view(() => tag, { select: { id: true, pairA: true, pairB: true } })
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

/**
 * Keys that are an instant and a decimal, which a record holds as its text:
 * a view's copies of the entries' links to them, and views of their tables
 * keyed under their own.
 */
function texts() {
  const stamp = s
    .model({ at: s.dateTime().id(), entries: s.toMany(() => entry) })
    .map("svr_stamps");
  const price = s
    .model({
      amount: s.decimal({ precision: 6, scale: 2 }).id(),
      entries: s.toMany(() => entry),
    })
    .map("svr_prices");
  const entry = s
    .model({
      id: s.int().id(),
      stampAt: s.dateTime(),
      priceAmount: s.decimal({ precision: 6, scale: 2 }).nullable(),
      stamp: s
        .toOne(() => stamp)
        .fields("stampAt")
        .references("at"),
      price: s
        .toOne(() => price)
        .fields("priceAmount")
        .references("amount"),
    })
    .map("svr_text_entries");
  const liveText = s
    .view(() => entry, {
      select: { id: true, stampAt: true, priceAmount: true },
    })
    .map("svr_live_texts");
  const stampCard = s.view(() => stamp, {}).map("svr_stamp_cards");
  const priceCard = s.view(() => price, {}).map("svr_price_cards");
  return { stamp, price, entry, liveText, stampCard, priceCard };
}

/**
 * The filter of the view whose body is pinned below: a string function, a
 * number comparison, a nullable column and an `in` list.
 */
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

/** Titles a body writes with an escape: U+0000, U+0001, U+001F among other text. */
const CONTROLLED = ["a\u0001b", "x\u0000y", "\u001f"];

/**
 * Views filtered by bytes given as a Node `Buffer`, which the SDK sends as it
 * sends a `Uint8Array`, and by titles holding control characters, which the
 * body spells as escapes.
 */
function literals() {
  const sheet = s
    .model({
      id: s.int().id(),
      title: s.string(),
      cover: s.blob().nullable(),
    })
    .map("svr_sheets");
  const covered = s
    .view(() => sheet, { where: { cover: Buffer.from([1, 2]) } })
    .map("svr_covered");
  const controlled = s
    .view(() => sheet, { where: { title: { in: CONTROLLED } } })
    .map("svr_controlled");
  return { sheet, covered, controlled };
}

describe.skipIf(!surrealUrl)("views on SurrealDB, after review", () => {
  it("a view's copied foreign key names a record of its target's table, and a view's row its source's key", async () => {
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
      await client.badge.createMany({
        data: [
          { id: "gold", writerNo: 1 },
          { id: "tin", writerNo: 2 },
          { id: "iron", writerNo: 3 },
        ],
      });
      await client.entry.createMany({
        data: [
          { id: 1, title: "e1", writerId: 1 },
          { id: 2, title: "e2", writerId: 2 },
          { id: 3, title: "e3", writerId: null },
        ],
      });
      const ordered = { orderBy: { id: "asc" } } as const;
      const linked = {
        ...ordered,
        select: {
          id: true,
          writerId: true,
          writer: { select: { name: true } },
          badge: { select: { id: true } },
        },
      } as const;
      // Read as the table reads them, an unset link naming no row.
      expect(await client.liveEntry.findMany(linked)).toEqual(
        await client.entry.findMany(linked)
      );
      expect(await client.digest.findMany(linked)).toEqual(
        await client.entry.findMany(linked)
      );
      for (const where of [
        { writer: { name: "Bob" } },
        { writer: null },
        { writer: { isNot: null } },
        { badge: { id: "gold" } },
      ])
        expect(
          ids(
            await client.liveEntry.findMany({
              ...ordered,
              where,
              select: { id: true },
            })
          )
        ).toEqual(
          ids(
            await client.entry.findMany({
              ...ordered,
              where,
              select: { id: true },
            })
          )
        );
      // From a view's key: the rows whose link names its source record.
      const good = {
        ...ordered,
        select: {
          id: true,
          entries: { select: { id: true } },
          _count: { select: { entries: true } },
        },
      } as const;
      expect(await client.goodWriter.findMany(good)).toEqual(
        await client.writer.findMany({
          ...good,
          where: { name: { startsWith: "A" } },
        })
      );
      expect(
        ids(
          await client.goodWriter.findMany({
            where: { entries: { none: {} } },
            select: { id: true },
          })
        )
      ).toEqual([3]);
    });
  });

  it("a compound key names a row by record, an integer part as the key holds it, from views of either end", async () => {
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
      const tagged = {
        orderBy: { id: "asc" },
        select: { id: true, pair: { select: { label: true } } },
      } as const;
      expect(await client.liveTag.findMany(tagged)).toEqual(
        await client.tag.findMany(tagged)
      );
      expect(
        ids(
          await client.liveTag.findMany({
            where: { pair: { label: "x0" } },
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

  it("a key that is an instant or a decimal, which a record holds as text, names a row by its value from a view", async () => {
    const driver = await freshDriver();
    const client = clientOf(texts(), driver);
    await using(client, async () => {
      await push(client);
      const at = new Date("2026-01-02T03:04:05.000Z");
      await client.stamp.create({ data: { at } });
      await client.price.createMany({
        data: [{ amount: "2.50" }, { amount: "1.25" }],
      });
      await client.entry.createMany({
        data: [
          { id: 1, stampAt: at, priceAmount: "2.50" },
          { id: 2, stampAt: at, priceAmount: null },
        ],
      });
      const linked = {
        orderBy: { id: "asc" },
        select: {
          id: true,
          stamp: { select: { at: true } },
          price: { select: { amount: true } },
        },
      } as const;
      expect(plain(await client.liveText.findMany(linked))).toEqual(
        plain(await client.entry.findMany(linked))
      );
      // From a view's key, held as the text of its source record's key.
      const members = {
        select: { entries: { select: { id: true }, orderBy: { id: "asc" } } },
      } as const;
      expect(await client.stampCard.findMany(members)).toEqual(
        await client.stamp.findMany(members)
      );
      expect(
        plain(
          await client.priceCard.findMany({
            ...members,
            orderBy: { amount: "asc" },
          })
        )
      ).toEqual(
        plain(
          await client.price.findMany({
            ...members,
            orderBy: { amount: "asc" },
          })
        )
      );
      expect(
        ids(
          await client.liveText.findMany({
            where: { price: { amount: "2.50" } },
            select: { id: true },
          })
        )
      ).toEqual([1]);
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

  it("a view filtered by a Buffer, or by text holding control characters, reads the rows its source reads", async () => {
    const driver = await freshDriver();
    const client = clientOf(literals(), driver);
    await using(client, async () => {
      const { statements } = await push(client);
      expect(statements).toContainEqual(
        expect.stringContaining('(cover != NONE AND cover = b"0102")')
      );
      expect(statements).toContainEqual(
        expect.stringContaining('[s"a\\u0001b", s"x\\u0000y", s"\\u001f"]')
      );
      await client.sheet.createMany({
        data: [
          { id: 1, title: "a\u0001b", cover: new Uint8Array([1, 2]) },
          { id: 2, title: "a\u0002b", cover: new Uint8Array([1, 3]) },
          { id: 3, title: "x\u0000y", cover: null },
          { id: 4, title: "xy", cover: Buffer.from([1, 2]) },
          { id: 5, title: "\u001f", cover: new Uint8Array([2]) },
          { id: 6, title: "\\u0001", cover: null },
        ],
      });
      const sourceIds = async (where: object) =>
        ids(
          await client.sheet.findMany({
            where,
            select: { id: true },
            orderBy: { id: "asc" },
          })
        );
      expect(await sourceIds({ cover: Buffer.from([1, 2]) })).toEqual([1, 4]);
      expect(
        ids(await client.covered.findMany({ orderBy: { id: "asc" } }))
      ).toEqual([1, 4]);
      expect(await sourceIds({ title: { in: CONTROLLED } })).toEqual([1, 3, 5]);
      expect(
        ids(await client.controlled.findMany({ orderBy: { id: "asc" } }))
      ).toEqual([1, 3, 5]);
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
