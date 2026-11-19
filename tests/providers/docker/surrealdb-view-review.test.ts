/**
 * Views on SurrealDB, the cases a review of them found, against a server. A
 * view's column copied from its source's foreign key holds a record of the
 * table that key targets: towards that table it compares as the record, and
 * towards any other model, another view among them, by the key it names. A
 * column holding the key itself, unset, names no row, and a compound key's
 * integer part is looked up as the key holds it. Gated on SURREAL_TEST_URL.
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

/** A destructive change proceeds. */
const resolve: ResolveCallback = (change) =>
  change.type === "destructive" ? change.proceed() : undefined;

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
});
