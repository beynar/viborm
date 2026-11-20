/**
 * Schema-declared views against a real database
 * (`docs/architecture/schema-views-plan.md`): each view of the corpus is
 * created by a push of the schema that declares it, a second push plans
 * nothing, and a read of the view answers what its declared query answers on
 * its source,
 * scalars and JSON columns alike, decoded by the read's own decoder. Then the
 * ordinary read verbs run on the views unchanged, and a write is refused
 * before any statement.
 *
 * A materialized view (plan §2.6) reads what its last refresh computed where
 * the database stores it (PostgreSQL), and its source's rows elsewhere.
 */

import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { ForbiddenError, UnsupportedOperationError } from "@errors";
import type { ResolveCallback } from "@migrations/types";
import { s } from "@schema";
import { DbNull, Decimal } from "@src/index";
import { on } from "@src/on";
import { ordering } from "@src/ordering";
import { permissions } from "@src/permissions";
import { softDelete } from "@src/soft-delete";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const author = s
  .model({
    id: s.int().id(),
    name: s.string(),
    big: s.bigInt(),
    balance: s.decimal({ precision: 12, scale: 2 }),
    bornAt: s.dateTime(),
    data: s.json(),
    avatar: s.blob(),
    active: s.boolean(),
    role: s.enum(["admin", "editor"]),
    posts: s.toMany(() => post),
  })
  .map("vw_authors");

const post = s
  .model({
    id: s.int().id(),
    uid: s.string().uuid().unique(),
    title: s.string(),
    views: s.bigInt(),
    score: s.decimal({ precision: 10, scale: 3 }),
    publishedAt: s.dateTime().nullable(),
    published: s.boolean(),
    meta: s.json().nullable(),
    cover: s.blob().nullable(),
    kind: s.enum(["note", "essay"]),
    authorId: s.int().map("author_ref"),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
    comments: s.toMany(() => comment),
  })
  .map("vw_posts");

const comment = s
  .model({
    id: s.int().id(),
    body: s.string(),
    likes: s.int(),
    postId: s.int(),
    post: s
      .toOne(() => post)
      .fields("postId")
      .references("id"),
  })
  .map("vw_comments");

const publishedQuery = {
  where: { published: true },
  select: {
    id: true,
    uid: true,
    title: true,
    views: true,
    score: true,
    publishedAt: true,
    meta: true,
    cover: true,
    kind: true,
    authorId: true,
    author: {
      select: {
        name: true,
        big: true,
        balance: true,
        bornAt: true,
        data: true,
        avatar: true,
        active: true,
        role: true,
      },
    },
    comments: {
      where: { likes: { gte: 1 } },
      orderBy: { likes: "desc" },
      take: 2,
      select: { id: true, body: true, likes: true },
    },
    _count: { select: { comments: true } },
  },
} as const;
const publishedPost = s
  .view(() => post, publishedQuery)
  .map("vw_published_posts");

const digestQuery = {
  omit: { avatar: true },
  include: {
    posts: {
      orderBy: { id: "asc" },
      take: 2,
      select: { id: true, views: true },
    },
    _count: true,
  },
} as const;
const authorDigest = s.view(() => author, digestQuery).map("vw_author_digest");

const statsQuery = {
  select: {
    id: true,
    name: true,
    _aggregate: {
      posts: {
        where: { published: true },
        _count: true,
        _sum: { views: true },
        _max: { score: true },
      },
    },
  },
} as const;
const authorStats = s.view(() => author, statsQuery).map("vw_author_stats");

const popularQuery = {
  where: { views: { gte: 10n } },
  select: { id: true, title: true, views: true, author: true, _count: true },
} as const;
const popular = s
  .view(() => publishedPost, popularQuery)
  .map("vw_popular_posts");

/** No key projected: no `findUnique`, and no order the read can give. */
const kindsQuery = {
  where: { published: true },
  select: { kind: true, views: true, score: true },
} as const;
const kinds = s.view(() => post, kindsQuery).map("vw_post_kinds");

/** A window: the one root order a view keeps. */
const latestQuery = {
  orderBy: { id: "desc" },
  take: 3,
  select: { id: true, title: true },
} as const;
const latest = s.view(() => post, latestQuery).map("vw_latest_posts");

/**
 * Values a migration's statement must carry as written: a line break, and
 * the word MySQL's client reads as a command when it opens a line.
 */
const NOTED: string[] = [
  "set the delimiter here",
  "line\r\nbreak",
  "back\\slash",
];
const notedQuery = {
  where: { title: { notIn: NOTED } },
  select: { id: true, title: true },
} as const;
const noted = s.view(() => post, notedQuery).map("vw_noted_posts");

/**
 * `omit` beside `select`, as a read takes them: what `omit` names is no
 * column of the view, a scalar or a JSON column of a source view alike.
 */
const trimmedQuery = {
  select: { id: true, title: true, kind: true },
  omit: { kind: true },
} as const;
const trimmed = s.view(() => post, trimmedQuery).map("vw_trimmed_posts");
const trimmedOverQuery = {
  select: { id: true, title: true, author: true, comments: true },
  omit: { title: true, comments: true },
} as const;
const trimmedOver = s
  .view(() => publishedPost, trimmedOverQuery)
  .map("vw_trimmed_over");
/** No key of its source: it inherits no to-many, so `_count: true` over it counts none. */
const noIdQuery = { select: { title: true, authorId: true } } as const;
const noIdPost = s.view(() => post, noIdQuery).map("vw_no_id_posts");
const countOver = s
  .view(() => noIdPost, { include: { _count: true } })
  .map("vw_count_over");
/** `_count: false` beside an `omit`: no change to the stored `_count` it keeps. */
const unflaggedQuery = {
  omit: { title: true },
  include: { _count: false },
} as const;
const unflagged = s
  .view(() => publishedPost, unflaggedQuery)
  .map("vw_unflagged_posts");

/**
 * Foreign keys that inherit an identifier format from the key they
 * reference: a ULID stored as bytes, a UUID as the database's own type. A
 * view's column is its source's, so it is read and filtered the same way.
 */
const reader = s
  .model({
    id: s.string().ulid().id(),
    uid: s.string().uuid().unique(),
    bookmarks: s.toMany(() => bookmark),
    bookmarksByUid: s.toMany(() => bookmark).name("byUid"),
  })
  .map("vw_readers");
const bookmark = s
  .model({
    id: s.int().id(),
    readerId: s.string(),
    readerUid: s.string(),
    reader: s
      .toOne(() => reader)
      .fields("readerId")
      .references("id"),
    readerByUid: s
      .toOne(() => reader)
      .name("byUid")
      .fields("readerUid")
      .references("uid"),
  })
  .map("vw_bookmarks");
const bookmarkRefQuery = {
  select: { id: true, readerId: true, readerUid: true },
} as const;
const bookmarkRef = s
  .view(() => bookmark, bookmarkRefQuery)
  .map("vw_bookmark_refs");
const bookmarkRefOver = s
  .view(() => bookmarkRef, { select: { id: true, readerId: true } })
  .map("vw_bookmark_refs_over");

/**
 * Published posts, with the columns `author` and `comments` join on: the view
 * inherits both relations of its source, read by joins when it is read.
 */
const livePostQuery = {
  where: { published: true },
  select: { id: true, title: true, authorId: true },
} as const;
const livePost = s.view(() => post, livePostQuery).map("vw_live_posts");
/** A view over it whose query selects a relation it inherits: a JSON column. */
const liveBylineQuery = {
  select: { id: true, author: { select: { name: true } } },
} as const;
const liveByline = s
  .view(() => livePost, liveBylineQuery)
  .map("vw_live_bylines");

const storedQuery = {
  where: { published: true },
  select: {
    id: true,
    uid: true,
    title: true,
    views: true,
    author: { select: { name: true } },
  },
} as const;
/** Stored where the database stores a view's rows: keyed by `id` and `uid`, indexed by `views`. */
const storedPost = s
  .view(() => post, storedQuery)
  .materialized()
  .index(["views"])
  .map("vw_stored_posts");

const TABLE_NAMES = [
  "vw_authors",
  "vw_posts",
  "vw_comments",
  "vw_readers",
  "vw_bookmarks",
];
const tables = { author, post, comment, reader, bookmark };
const views = {
  publishedPost,
  authorDigest,
  authorStats,
  popular,
  kinds,
  latest,
  noted,
  trimmed,
  trimmedOver,
  bookmarkRef,
  bookmarkRefOver,
  livePost,
  liveByline,
  noIdPost,
  countOver,
  unflagged,
  storedPost,
};
const schema = { ...tables, ...views };

/** Views in the order they are created: a view after the view it reads. */
const CREATED = [
  "publishedPost",
  "authorDigest",
  "authorStats",
  "popular",
  "kinds",
  "latest",
  "noted",
  "trimmed",
  "trimmedOver",
  "bookmarkRef",
  "bookmarkRefOver",
  "livePost",
  "liveByline",
  "noIdPost",
  "countOver",
  "unflagged",
  "storedPost",
] as const;

const NAMES: Record<(typeof CREATED)[number], string> = {
  publishedPost: "vw_published_posts",
  authorDigest: "vw_author_digest",
  authorStats: "vw_author_stats",
  popular: "vw_popular_posts",
  kinds: "vw_post_kinds",
  latest: "vw_latest_posts",
  noted: "vw_noted_posts",
  trimmed: "vw_trimmed_posts",
  trimmedOver: "vw_trimmed_over",
  bookmarkRef: "vw_bookmark_refs",
  bookmarkRefOver: "vw_bookmark_refs_over",
  livePost: "vw_live_posts",
  liveByline: "vw_live_bylines",
  noIdPost: "vw_no_id_posts",
  countOver: "vw_count_over",
  unflagged: "vw_unflagged_posts",
  storedPost: "vw_stored_posts",
};

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * A value as data to compare: a `Decimal` carries no own property, so a deep
 * equality would compare nothing of it; bytes compare by their content.
 */
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

/** One text per value, whatever the order of its keys. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, member: unknown) =>
    member !== null && typeof member === "object" && !Array.isArray(member)
      ? Object.fromEntries(
          Object.entries(member).sort(([left], [right]) =>
            left < right ? -1 : 1
          )
        )
      : member
  );

/** Rows compared whatever their order: a view without a key has none. */
const unordered = (rows: readonly unknown[]) =>
  rows.map((row) => canonical(plain(row))).sort();

export interface SchemaViewsBehaviorOptions {
  readonly name: string;
  readonly dialect: "postgresql" | "mysql" | "sqlite";
  readonly createDriver: () => AnyDriver;
}

export function runSchemaViewsBehavior({
  name,
  dialect,
  createDriver,
}: SchemaViewsBehaviorOptions): void {
  runAggregatedViewsBehavior({ name, dialect, createDriver });
  describe(`${name}: schema views`, () => {
    const driver = createDriver();
    const setup = createClient({ schema: tables, driver });
    const client = createClient({ schema, driver });
    const quote = (identifier: string) =>
      dialect === "mysql" ? `\`${identifier}\`` : `"${identifier}"`;
    const SCOPE = [...TABLE_NAMES, ...Object.values(NAMES)];
    const dropViews = async () => {
      for (const view of [...CREATED].reverse()) {
        // PostgreSQL drops a materialized view with its own statement.
        const kind =
          view === "storedPost" && dialect === "postgresql"
            ? "MATERIALIZED VIEW"
            : "VIEW";
        await driver._executeRaw(
          `DROP ${kind} IF EXISTS ${quote(NAMES[view])}`
        );
      }
    };

    beforeAll(async () => {
      await dropViews();
      // Only this corpus's tables: a shared database holds other suites'.
      await syncLiveSchema(setup, { tables: TABLE_NAMES });
      await setup.bookmark.deleteMany({});
      await setup.reader.deleteMany({});
      await setup.comment.deleteMany({});
      await setup.post.deleteMany({});
      await setup.author.deleteMany({});
      const authors = [
        [
          1,
          "Ann",
          9_007_199_254_740_993n,
          "1234.50",
          "1990-05-17T08:30:00.000Z",
          { tags: ["a", "it's"], n: 1 },
          [0, 1, 255],
          true,
          "admin",
        ],
        [
          2,
          "Bob",
          -42n,
          "-0.01",
          "1985-01-01T00:00:00.000Z",
          { tags: [], n: null },
          [39, 92, 0],
          false,
          "editor",
        ],
        [
          3,
          "Cy",
          0n,
          "0.00",
          "2001-09-09T01:46:40.123Z",
          [1, 2, 3],
          [],
          true,
          "editor",
        ],
      ] as const;
      for (const [
        id,
        label,
        big,
        balance,
        bornAt,
        data,
        avatar,
        active,
        role,
      ] of authors)
        await setup.author.create({
          data: {
            id,
            name: label,
            big,
            balance,
            bornAt: new Date(bornAt),
            data,
            avatar: new Uint8Array(avatar),
            active,
            role,
          },
        });
      const posts = [
        [
          1,
          "first 'post'",
          12n,
          "1.500",
          "2024-02-29T12:34:56.789Z",
          true,
          { a: 1 },
          [1, 2],
          "note",
          1,
        ],
        [2, "draft", 3n, "0.001", null, false, null, null, "essay", 1],
        [
          3,
          "100% done",
          9_007_199_254_740_995n,
          "-2.250",
          "2023-01-01T00:00:00.000Z",
          true,
          null,
          [255],
          "essay",
          2,
        ],
        [
          4,
          "back\\slash",
          10n,
          "9999999.999",
          "2022-06-01T10:00:00.000Z",
          true,
          [true, "x"],
          null,
          "note",
          2,
        ],
        [
          5,
          "quiet",
          0n,
          "0.000",
          "2021-01-01T00:00:00.000Z",
          true,
          { nested: { k: "v" } },
          [],
          "note",
          3,
        ],
      ] as const;
      for (const [
        id,
        title,
        views,
        score,
        publishedAt,
        published,
        meta,
        cover,
        kind,
        authorId,
      ] of posts)
        await setup.post.create({
          data: {
            id,
            uid: `0b7a3c9e-5f1d-4e2a-9c8b-1d2e3f4a5b6${id}`,
            title,
            views,
            score,
            publishedAt: publishedAt === null ? null : new Date(publishedAt),
            published,
            meta: meta ?? DbNull,
            cover: cover === null ? null : new Uint8Array(cover),
            kind,
            authorId,
          },
        });
      const comments = [
        [1, "great", 3, 1],
        [2, "meh", 0, 1],
        [3, "wow", 7, 1],
        [4, "ok", 1, 3],
        [5, "it's fine", 2, 4],
        [6, "hidden", 9, 2],
      ] as const;
      for (const [id, body, likes, postId] of comments)
        await setup.comment.create({ data: { id, body, likes, postId } });
      for (const [id, uid] of [
        [1, "7c9e6679-7425-40de-944b-e07fc1f90ae7"],
        [2, "9b2c1f0a-3d4e-4f5a-8b6c-7d8e9f0a1b2c"],
      ] as const) {
        const made = await setup.reader.create({ data: { uid } });
        await setup.bookmark.create({
          data: { id, readerId: made.id, readerUid: uid },
        });
      }
      // The views are created by the migrations, from their declarations.
      await syncLiveSchema(client, { tables: SCOPE });
    });

    afterAll(async () => {
      await dropViews();
      await client.$disconnect();
    });

    test("a view reads what its query reads on its source", async () => {
      expect(plain(await client.publishedPost.findMany())).toEqual(
        plain(await client.post.findMany(publishedQuery))
      );
      expect(plain(await client.authorDigest.findMany())).toEqual(
        plain(await client.author.findMany(digestQuery))
      );
      expect(plain(await client.authorStats.findMany())).toEqual(
        plain(await client.author.findMany(statsQuery))
      );
      expect(unordered(await client.kinds.findMany())).toEqual(
        unordered(await client.post.findMany(kindsQuery))
      );
      expect(plain(await client.latest.findMany())).toEqual(
        plain(
          [...(await client.post.findMany(latestQuery))].sort(
            (left, right) => left.id - right.id
          )
        )
      );
    });

    test("a materialized view reads what its last refresh computed, by its key too, where the database stores it", async () => {
      const ordered = { orderBy: { id: "asc" } } as const;
      await client.storedPost.$refresh();
      const rows = await client.storedPost.findMany(ordered);
      expect(plain(rows)).toEqual(
        plain(await client.post.findMany({ ...storedQuery, ...ordered }))
      );
      const [first] = rows;
      expect(
        await client.storedPost.findUnique({ where: { uid: first!.uid } })
      ).toEqual(first);
      // A write since: kept out of a stored view until its refresh, read at
      // once where the view is an ordinary one.
      await client.post.update({
        where: { id: first!.id },
        data: { published: false },
      });
      try {
        expect(await client.storedPost.count()).toBe(
          dialect === "postgresql" ? rows.length : rows.length - 1
        );
        await client.storedPost.$refresh({ concurrently: true });
        expect(await client.storedPost.count()).toBe(rows.length - 1);
      } finally {
        await client.post.update({
          where: { id: first!.id },
          data: { published: true },
        });
        await client.storedPost.$refresh();
      }
    });

    test("a value with a line break or the word DELIMITER is written into the view as it is", async () => {
      const rows = await client.noted.findMany();
      expect(plain(rows)).toEqual(
        plain(await client.post.findMany(notedQuery))
      );
      // "back\\slash" is a seeded title: the view leaves it out.
      expect(rows.map(({ title }) => title)).not.toContain("back\\slash");
      expect(rows.length).toBeGreaterThan(0);
    });

    test("omit beside select: what omit names is no column of the view", async () => {
      const rows = await client.trimmed.findMany();
      expect(plain(rows)).toEqual(
        plain(await client.post.findMany(trimmedQuery))
      );
      expect(Object.keys(rows[0]!)).toEqual(["id", "title"]);
      const over = await client.trimmedOver.findMany();
      expect(plain(over)).toEqual(
        plain(await client.publishedPost.findMany(trimmedOverQuery))
      );
      expect(Object.keys(over[0]!)).toEqual(["id", "author"]);
    });

    test("a foreign key keeps its inherited identifier format in a view, read and filtered", async () => {
      const marks = await client.bookmark.findMany(bookmarkRefQuery);
      expect(marks).toHaveLength(2);
      const rows = await client.bookmarkRef.findMany();
      expect(plain(rows)).toEqual(plain(marks));
      const [first] = marks;
      // The public values, as a caller writes them.
      expect(
        await client.bookmarkRef.findMany({
          where: { readerId: first!.readerId },
        })
      ).toEqual([first]);
      expect(
        await client.bookmarkRef.findMany({
          where: { readerUid: { in: [first!.readerUid] } },
        })
      ).toEqual([first]);
      // Through a view between: the same column still.
      expect(
        await client.bookmarkRefOver.findMany({
          where: { readerId: first!.readerId },
        })
      ).toEqual([{ id: first!.id, readerId: first!.readerId }]);
    });

    test("a second push plans nothing: a view's identity is read back from the database", async () => {
      const again = await syncLiveSchema(client, {
        tables: SCOPE,
        dryRun: true,
      });
      expect(again.operations).toEqual([]);
    });

    test("the read verbs run on a view as on a table", async () => {
      const { select } = publishedQuery;
      const source = (where: object) => ({
        where: { AND: [publishedQuery.where, where] },
        select,
      });
      const filtered = await client.publishedPost.findMany({
        where: { views: { gte: 1n }, kind: "note" },
        orderBy: [{ score: "desc" }],
        take: 2,
      });
      expect(filtered.length).toBe(2);
      expect(plain(filtered)).toEqual(
        plain(
          await client.post.findMany({
            ...source({ views: { gte: 1n }, kind: "note" }),
            orderBy: [{ score: "desc" }],
            take: 2,
          })
        )
      );
      expect(
        plain(
          await client.publishedPost.findMany({
            cursor: { id: 3 },
            orderBy: { id: "asc" },
            take: 2,
            skip: 1,
          })
        )
      ).toEqual(
        plain(
          await client.post.findMany({
            ...source({}),
            cursor: { id: 3 },
            orderBy: { id: "asc" },
            take: 2,
            skip: 1,
          })
        )
      );
      const one = await client.publishedPost.findUnique({ where: { id: 1 } });
      expect(one?.comments.length).toBe(2);
      expect(plain(one)).toEqual(
        plain(await client.post.findFirst(source({ id: 1 })))
      );
      expect(
        plain(
          await client.publishedPost.findUniqueOrThrow({
            where: { uid: "0b7a3c9e-5f1d-4e2a-9c8b-1d2e3f4a5b64" },
          })
        )
      ).toEqual(plain(await client.post.findFirst(source({ id: 4 }))));
      expect(
        await client.publishedPost.findUnique({ where: { id: 2 } })
      ).toBeNull();
      expect(
        plain(
          await client.publishedPost.findFirst({
            where: { title: { contains: "%" } },
          })
        )
      ).toEqual(plain(await client.post.findFirst(source({ id: 3 }))));
      expect(
        await client.publishedPost.count({ where: { kind: "note" } })
      ).toBe(3);
      expect(await client.publishedPost.exist({ where: { id: 2 } })).toBe(
        false
      );
      expect(
        plain(
          await client.publishedPost.aggregate({
            where: { views: { gt: 0n } },
            _count: true,
            _sum: { views: true },
            _max: { score: true },
            _min: { publishedAt: true },
          })
        )
      ).toEqual(
        plain(
          await client.post.aggregate({
            where: { published: true, views: { gt: 0n } },
            _count: true,
            _sum: { views: true },
            _max: { score: true },
            _min: { publishedAt: true },
          })
        )
      );
      expect(
        plain(
          await client.publishedPost.groupBy({
            by: ["kind"],
            _sum: { views: true },
            _count: { _all: true },
            orderBy: { kind: "asc" },
          })
        )
      ).toEqual(
        plain(
          await client.post.groupBy({
            by: ["kind"],
            where: { published: true },
            _sum: { views: true },
            _count: { _all: true },
            orderBy: { kind: "asc" },
          })
        )
      );
    });

    test("select and omit take a view's JSON columns whole", async () => {
      const selected = await client.publishedPost.findMany({
        select: { id: true, author: true, _count: true },
        orderBy: { id: "asc" },
      });
      expect(plain(selected)).toEqual(
        plain(
          await client.post.findMany({
            where: publishedQuery.where,
            select: {
              id: true,
              author: publishedQuery.select.author,
              _count: publishedQuery.select._count,
            },
            orderBy: { id: "asc" },
          })
        )
      );
      expect(Object.keys(selected[0]!).sort()).toEqual([
        "_count",
        "author",
        "id",
      ]);
      // A stored `_count` or `_aggregate` counts nothing at read time: read
      // whole by a boolean, it takes no arguments under `include` either.
      expect(
        plain(
          await client.publishedPost.findMany({
            include: { _count: true },
            orderBy: { id: "asc" },
          })
        )
      ).toEqual(
        plain(await client.publishedPost.findMany({ orderBy: { id: "asc" } }))
      );
      await expect(
        client.publishedPost.findMany({
          include: {
            _count: { select: { comments: { where: { body: "none" } } } },
          },
        } as never)
      ).rejects.toThrow("_count");
      await expect(
        client.authorStats.findMany({
          include: { _aggregate: { posts: { _count: true } } },
        } as never)
      ).rejects.toThrow("_aggregate");
      const omitted = await client.publishedPost.findMany({
        omit: { author: true, comments: true, cover: true },
        orderBy: { id: "asc" },
      });
      const {
        author: _a,
        comments: _c,
        cover: _v,
        ...kept
      } = publishedQuery.select;
      expect(plain(omitted)).toEqual(
        plain(
          await client.post.findMany({
            where: publishedQuery.where,
            select: kept,
            orderBy: { id: "asc" },
          })
        )
      );
      expect(
        plain(
          await client.authorDigest.findMany({
            select: { name: true, posts: true },
            where: { active: true },
          })
        )
      ).toEqual(
        plain(
          await client.author.findMany({
            select: { name: true, posts: digestQuery.include.posts },
            where: { active: true },
          })
        )
      );
    });

    test("a write to a view is refused before any statement", async () => {
      const before = await client.post.count();
      await expect(
        // @ts-expect-error - a view is never written
        client.publishedPost.create({ data: { id: 9 } })
      ).rejects.toThrow(UnsupportedOperationError);
      await expect(
        client.$transaction([
          client.post.create({
            data: {
              id: 9,
              uid: "0b7a3c9e-5f1d-4e2a-9c8b-1d2e3f4a5b69",
              title: "never",
              views: 0n,
              score: "0.000",
              published: true,
              meta: DbNull,
              kind: "note",
              authorId: 1,
            },
          }),
          // @ts-expect-error - nor in a batch beside a table's write
          client.authorDigest.deleteMany({}),
        ])
      ).rejects.toThrow(
        "'authorDigest' is a view: it is read, never written (deleteMany)."
      );
      expect(await client.post.count()).toBe(before);
    });

    test("a cached read of a view is invalidated by a write to its source", async () => {
      const cached = client.$extends(cache({ driver: new MemoryCache() }));
      const count = () => cached.$withCache().publishedPost.count();
      const seen = await count();
      // A write that tells no cache: the entry still answers.
      await setup.post.update({ where: { id: 2 }, data: { published: true } });
      expect(await count()).toBe(seen);
      // A write through the cached client invalidates its scope.
      await cached.post.update({ where: { id: 2 }, data: { title: "draft" } });
      expect(await count()).toBe(seen + 1);
      await setup.post.update({ where: { id: 2 }, data: { published: false } });
    });

    test("the official extensions read a view as its own model", async () => {
      const all = await client.publishedPost.count();
      // Soft delete over the source: the view's body is the schema's read.
      const tombs = client.$extends(
        softDelete({ models: { post: { deletedAt: "publishedAt" } } })
      );
      expect(await tombs.publishedPost.count()).toBe(all);
    });

    test("soft delete over a view itself", async () => {
      // Soft delete over the view itself: it reads the view's own column.
      const hidden = client.$extends(
        softDelete({ models: { publishedPost: { deletedAt: "publishedAt" } } })
      );
      expect(
        plain(await hidden.publishedPost.findMany({ select: { id: true } }))
      ).toEqual([]);
      await expect(
        // @ts-expect-error - its delete is a write, refused
        hidden.publishedPost.delete({ where: { id: 1 } })
      ).rejects.toThrow("never written (delete)");
    });

    test("permissions over a view", async () => {
      const all = await client.publishedPost.count();
      // Permissions: a view no policy lists is refused, whatever its source's.
      const governed = client.$extends(
        permissions({
          actor: v.object({ userId: v.number() }),
          models: { post: { read: true } },
        })
      );
      await expect(
        governed.$as({ userId: 1 }).publishedPost.findMany()
      ).rejects.toThrow(ForbiddenError);
      expect(await governed.$as({ userId: 1 }).post.count()).toBeGreaterThan(0);
      const granted = client.$extends(
        permissions({
          actor: v.object({ userId: v.number() }),
          models: { publishedPost: { read: true } },
        })
      );
      expect(await granted.$as({ userId: 1 }).publishedPost.count()).toBe(all);
    });

    test("on, ordering, $rows over a view", async () => {
      const all = await client.publishedPost.count();
      // Hooks on the source's writes leave the view's reads as they are.
      const hooked = client.$extends(on({ post: { create: () => undefined } }));
      expect(await hooked.publishedPost.count()).toBe(all);
      // An order the extension gives the view's reads.
      const ordered = client.$extends(
        ordering({ models: { latest: { key: "title" } } })
      );
      expect((await ordered.latest.findMany()).map((row) => row.title)).toEqual(
        (await client.latest.findMany())
          .map((row) => row.title)
          .sort((left, right) => (left < right ? -1 : 1))
      );
      // `$rows` reads the view as a FROM item; `$sql` names it.
      const rows = await client.$queryRaw<{
        n: unknown;
      }>`SELECT COUNT(*) AS n FROM ${client.publishedPost.$rows("p")}`;
      expect(Number(rows[0]!.n)).toBe(all);
      expect(client.publishedPost.$sql.table().toStatement("?")).toContain(
        "vw_published_posts"
      );
    });

    test("a view reads its source's relations where it keeps their key columns", async () => {
      const where = {
        author: { role: "editor" },
        comments: { some: { likes: { gte: 1 } } },
      } as const;
      const orderBy = [
        { author: { name: "desc" as const } },
        { id: "asc" as const },
      ];
      const select = {
        id: true,
        title: true,
        authorId: true,
        author: { select: { name: true, role: true } },
        comments: { orderBy: { id: "asc" }, select: { body: true } },
        _count: { select: { comments: true } },
      } as const;
      const read = await client.livePost.findMany({ where, orderBy, select });
      expect(read.map(({ id }) => id)).toEqual([3, 4]);
      expect(plain(read)).toEqual(
        plain(
          await client.post.findMany({
            where: { AND: [livePostQuery.where, where] },
            orderBy,
            select,
          })
        )
      );
      // A filter on each form, a count through one, and a unique read.
      expect(
        (
          await client.livePost.findMany({
            where: { comments: { every: { likes: { gte: 1 } } } },
            orderBy: { id: "asc" },
            select: { id: true },
          })
        ).map(({ id }) => id)
      ).toEqual([3, 4, 5]);
      expect(
        await client.livePost.count({
          where: { comments: { none: {} }, author: { name: "Cy" } },
        })
      ).toBe(1);
      expect(
        plain(
          await client.livePost.findUnique({
            where: { id: 1 },
            include: { author: { select: { name: true } }, _count: true },
          })
        )
      ).toEqual({
        id: 1,
        title: "first 'post'",
        authorId: 1,
        author: { name: "Ann" },
        _count: { comments: 3 },
      });
      // A view whose query selects one: the document is the relation's read.
      expect(plain(await client.liveByline.findMany())).toEqual(
        plain(await client.livePost.findMany(liveBylineQuery))
      );
      // A view of a view: what its source inherits and it keeps.
      const reader = {
        select: { id: true, reader: { select: { uid: true } } },
      };
      expect(plain(await client.bookmarkRefOver.findMany(reader))).toEqual(
        plain(await client.bookmark.findMany(reader))
      );
    });

    test("a relation whose key columns the view does not keep is refused, its missing column named", async () => {
      await expect(
        client.kinds.findMany({ include: { comments: true } } as never)
      ).rejects.toThrow(
        "The view 'kinds' does not read 'comments': it does not keep 'id', which the relation joins on"
      );
      await expect(
        client.latest.findMany({ where: { author: { name: "Ann" } } } as never)
      ).rejects.toThrow(
        "The view 'latest' does not read 'author': it does not keep 'authorId', which the relation joins on"
      );
    });

    test("a view over a view reads what its query reads on its source view", async () => {
      const rows = await client.popular.findMany();
      expect(plain(rows)).toEqual(
        plain(await client.publishedPost.findMany(popularQuery))
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    test("a `_count: true` over a view that inherits no to-many is no column", async () => {
      const rows = await client.countOver.findMany();
      expect(unordered(rows)).toEqual(
        unordered(await client.noIdPost.findMany())
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).not.toHaveProperty("_count");
    });

    test("an include's `false` beside an omit keeps a stored column the view reads", async () => {
      const rows = await client.unflagged.findMany();
      expect(unordered(rows)).toEqual(
        unordered(await client.publishedPost.findMany(unflaggedQuery))
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).toHaveProperty("_count");
    });
  });
}

// =============================================================================
// AGGREGATED VIEWS
// =============================================================================

/**
 * Aggregated views (`by`, what `groupBy` takes): each is created by a push,
 * a second push plans nothing, and its rows are what `groupBy` answers on
 * its source for the same selection, each aggregate a flat column. Then the
 * read verbs on its columns, its key, no relation, views over and under it, a time step (PostgreSQL only) and its replacement.
 */
const aggStore = s
  .model({
    id: s.int().id(),
    name: s.string(),
    sales: s.toMany(() => aggSale),
  })
  .map("va_stores");
const aggSale = s
  .model({
    id: s.string().ulid().id(),
    uid: s.string().uuid(),
    storeId: s.int(),
    currency: s.enum(["EUR", "USD"]),
    region: s.string().nullable(),
    units: s.int(),
    big: s.bigInt(),
    ratio: s.number(),
    amount: s.decimal({ precision: 10, scale: 2 }),
    rate: s.decimal({ precision: 12, scale: 4 }),
    label: s.string().map("sale_label"),
    soldAt: s.dateTime(),
    store: s
      .toOne(() => aggStore)
      .fields("storeId")
      .references("id"),
  })
  .map("va_sales");

/** Every aggregate of every field type, grouped by two fields: keyed by both. */
const totalsQuery = {
  by: ["storeId", "currency"],
  where: { units: { gte: 0 } },
  _count: { _all: true, region: true },
  _sum: { units: true, big: true, ratio: true, amount: true, rate: true },
  _avg: { units: true, big: true, ratio: true, amount: true, rate: true },
  _min: {
    id: true,
    uid: true,
    label: true,
    soldAt: true,
    currency: true,
    amount: true,
  },
  _max: { id: true, uid: true, label: true, soldAt: true, rate: true },
} as const;
const aggTotals = s.view(() => aggSale, totalsQuery).map("va_totals");
/** One grouped field: the view's key alone. */
const byStoreQuery = {
  by: ["storeId"],
  having: { units: { _sum: { gte: 7 } } },
  _sum: { amount: true, units: true },
} as const;
const aggByStore = s.view(() => aggSale, byStoreQuery).map("va_by_store");
/** A nullable grouped field: no key. */
const byRegionQuery = { by: "region", _count: true } as const;
const aggByRegion = s.view(() => aggSale, byRegionQuery).map("va_by_region");
/** Grouped by its source's key: a to-many of the source is no relation of it. */
const aggStoreCounts = s
  .view(() => aggStore, { by: ["id"], _count: true })
  .map("va_store_counts");
/** A view of rows over an aggregated view. */
const busyQuery = {
  where: { count: { gt: 1 } },
  select: { storeId: true, currency: true, count: true, sumAmount: true },
} as const;
const aggBusy = s.view(() => aggTotals, busyQuery).map("va_busy");
/** An aggregated view over a view of rows. */
const bigSalesQuery = {
  where: { units: { gte: 2 } },
  select: { id: true, storeId: true, units: true, amount: true },
} as const;
const aggBigSales = s.view(() => aggSale, bigSalesQuery).map("va_big_sales");
const bigByStoreQuery = {
  by: ["storeId"],
  _count: true,
  _sum: { units: true, amount: true },
} as const;
const aggBigByStore = s
  .view(() => aggBigSales, bigByStoreQuery)
  .map("va_big_by_store");
/** A time step: PostgreSQL only, as in `groupBy`. */
const dailyQuery = {
  by: [{ soldAt: "day" }, "currency"],
  timeZone: "Europe/Paris",
  _count: true,
  _sum: { amount: true },
} as const;
const aggDaily = s.view(() => aggSale, dailyQuery).map("va_daily");
/** A bigint column whose sum passes 2^63. */
const aggHuge = s
  .model({ id: s.int().id(), part: s.string(), big: s.bigInt() })
  .map("va_huge");
const aggHugeTotals = s
  .view(() => aggHuge, { by: ["part"], _sum: { big: true } })
  .map("va_huge_totals");

const AGG_TABLES = ["va_stores", "va_sales", "va_huge"];
const AGG_VIEWS = [
  "va_totals",
  "va_by_store",
  "va_by_region",
  "va_busy",
  "va_big_sales",
  "va_big_by_store",
  "va_daily",
  "va_huge_totals",
  "va_store_counts",
];

const KEY_INDEX_ON_BIN = /^CREATE UNIQUE INDEX .*\(bin\)$/;
const INDEX_ON_TOTAL = /^CREATE INDEX .*\("sumUnits"\)$/;

/** A `groupBy` row as an aggregated view holds it: each aggregate a column. */
function flattened(row: object): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith("_")) columns[key] = value;
    else if (typeof value !== "object" || value === null)
      columns[key.slice(1)] = value;
    else
      for (const [field, member] of Object.entries(value))
        columns[
          field === "_all"
            ? key.slice(1)
            : `${key.slice(1)}${field.charAt(0).toUpperCase()}${field.slice(1)}`
        ] = member;
  }
  return columns;
}

/** `by` as `groupBy` takes it: a mutable list. */
const grouping = <Q extends { readonly by: readonly unknown[] }>(query: Q) => ({
  ...query,
  by: [...query.by] as Q["by"][number][],
});

function runAggregatedViewsBehavior({
  name,
  dialect,
  createDriver,
}: SchemaViewsBehaviorOptions): void {
  describe(`${name}: aggregated views`, () => {
    const driver = createDriver();
    const periods = dialect === "postgresql";
    const schema = {
      aggStore,
      aggSale,
      aggTotals,
      aggByStore,
      aggByRegion,
      aggBusy,
      aggBigSales,
      aggBigByStore,
      aggHuge,
      aggHugeTotals,
      aggStoreCounts,
      ...(periods ? { aggDaily } : {}),
    };
    const client = createClient({ schema, driver });
    const quote = (identifier: string) =>
      dialect === "mysql" ? `\`${identifier}\`` : `"${identifier}"`;
    const SCOPE = [...AGG_TABLES, ...AGG_VIEWS];
    const dropViews = async () => {
      for (const view of [...AGG_VIEWS].reverse())
        await driver._executeRaw(`DROP VIEW IF EXISTS ${quote(view)}`);
    };

    beforeAll(async () => {
      await dropViews();
      await syncLiveSchema(client, { tables: SCOPE });
      await client.aggSale.deleteMany({});
      await client.aggStore.deleteMany({});
      await client.aggHuge.deleteMany({});
      for (const id of [1, 2])
        await client.aggHuge.create({
          data: { id, part: "a", big: 9_000_000_000_000_000_000n },
        });
      for (const [id, label] of [
        [1, "North"],
        [2, "South"],
        [3, "Empty"],
      ] as const)
        await client.aggStore.create({ data: { id, name: label } });
      // Two sales on each side of midnight in Paris; a half-way average of
      // decimals (7.625 rounds to 7.62); a bigint past the double range.
      const sales = [
        [
          1,
          "EUR",
          "eu",
          3,
          9_007_199_254_740_993n,
          0.5,
          "10.25",
          "1.1234",
          "b",
          "2024-03-01T23:30:00.000Z",
        ],
        [
          1,
          "EUR",
          null,
          2,
          7n,
          0.25,
          "5.00",
          "0.0001",
          "a",
          "2024-03-01T10:00:00.000Z",
        ],
        [
          1,
          "USD",
          "us",
          1,
          -3n,
          1.5,
          "99.99",
          "2.5000",
          "c",
          "2024-03-02T12:00:00.000Z",
        ],
        [
          2,
          "EUR",
          "eu",
          5,
          0n,
          -2.75,
          "-1.00",
          "3.3333",
          "d",
          "2024-03-02T22:59:59.000Z",
        ],
        [
          2,
          "EUR",
          null,
          4,
          100n,
          0.125,
          "0.01",
          "1.0000",
          "e",
          "2024-03-02T23:00:00.000Z",
        ],
        [
          2,
          "USD",
          "us",
          0,
          1n,
          3,
          "1234.56",
          "0.5000",
          "f",
          "2024-03-03T00:00:00.000Z",
        ],
      ] as const;
      for (const [
        storeId,
        currency,
        region,
        units,
        big,
        ratio,
        amount,
        rate,
        label,
        soldAt,
      ] of sales)
        await client.aggSale.create({
          data: {
            uid: crypto.randomUUID(),
            storeId,
            currency,
            region,
            units,
            big,
            ratio,
            amount,
            rate,
            label,
            soldAt: new Date(soldAt),
          },
        });
    });

    afterAll(async () => {
      await dropViews();
      await client.$disconnect();
    });

    test("a row of an aggregated view is what groupBy answers, each aggregate a column of its scalar", async () => {
      const grouped = await client.aggSale.groupBy(grouping(totalsQuery));
      const rows = await client.aggTotals.findMany();
      expect(unordered(rows)).toEqual(unordered(grouped.map(flattened)));
      expect(rows).toHaveLength(4);
      const north = rows.find(
        (row) => row.storeId === 1 && row.currency === "EUR"
      )!;
      // A decimal average is quantized half to even, as groupBy's is.
      expect(plain(north.avgAmount)).toBe("decimal:7.62");
      expect(north.sumBig).toBe(9_007_199_254_741_000n);
      expect(north.countRegion).toBe(1);
      expect(Object.keys(north)).toEqual([
        "storeId",
        "currency",
        "count",
        "countRegion",
        "avgUnits",
        "avgBig",
        "avgRatio",
        "avgAmount",
        "avgRate",
        "sumUnits",
        "sumBig",
        "sumRatio",
        "sumAmount",
        "sumRate",
        "minId",
        "minUid",
        "minLabel",
        "minSoldAt",
        "minCurrency",
        "minAmount",
        "maxId",
        "maxUid",
        "maxLabel",
        "maxSoldAt",
        "maxRate",
      ]);
      expect(unordered(await client.aggByRegion.findMany())).toEqual(
        unordered(
          (await client.aggSale.groupBy({ by: ["region"], _count: true })).map(
            flattened
          )
        )
      );
    });

    test("a second push plans nothing", async () => {
      const again = await syncLiveSchema(client, {
        tables: SCOPE,
        dryRun: true,
      });
      expect(again.operations).toEqual([]);
    });

    test("a filter, an order and an aggregate on an aggregate's column read it as its scalar", async () => {
      const grouped = (await client.aggSale.groupBy(grouping(totalsQuery))).map(
        flattened
      ) as { sumAmount: Decimal | null; sumUnits: number | null }[];
      const over = await client.aggTotals.findMany({
        where: { sumAmount: { gt: "10" }, count: { gte: 1 } },
        orderBy: { sumUnits: "desc" },
        select: { storeId: true, currency: true, sumUnits: true },
      });
      expect(over.map(({ sumUnits }) => sumUnits)).toEqual(
        grouped
          .filter(({ sumAmount }) => sumAmount?.gt("10"))
          .map(({ sumUnits }) => sumUnits)
          .sort((left, right) => right! - left!)
      );
      const aggregate = await client.aggTotals.aggregate({
        _max: { sumAmount: true },
        _sum: { count: true },
        _min: { minSoldAt: true },
      });
      expect(plain(aggregate)).toEqual(
        plain({
          _max: { sumAmount: new Decimal("1234.56") },
          _sum: { count: 6 },
          _min: { minSoldAt: new Date("2024-03-01T10:00:00.000Z") },
        })
      );
      expect(
        unordered(
          await client.aggTotals.groupBy({
            by: ["currency"],
            _sum: { count: true },
          })
        )
      ).toEqual(
        unordered([
          { currency: "EUR", _sum: { count: 4 } },
          { currency: "USD", _sum: { count: 2 } },
        ])
      );
      // A compact identifier picked by `_min` is filtered as its column holds it.
      const [first] = await client.aggTotals.findMany({ take: 1 });
      expect(
        await client.aggTotals.count({ where: { minId: first!.minId } })
      ).toBe(1);
    });

    test("its key is its by list: findUnique by the compound key, or by the one field", async () => {
      const north = await client.aggTotals.findUnique({
        where: { storeId_currency: { storeId: 1, currency: "EUR" } },
        select: { count: true, sumUnits: true },
      });
      expect(north).toEqual({ count: 2, sumUnits: 5 });
      expect(
        plain(await client.aggByStore.findUnique({ where: { storeId: 2 } }))
      ).toEqual(
        plain({ storeId: 2, sumAmount: new Decimal("1233.57"), sumUnits: 9 })
      );
      // `having` keeps the groups groupBy keeps.
      expect(unordered(await client.aggByStore.findMany())).toEqual(
        unordered(
          (await client.aggSale.groupBy(grouping(byStoreQuery))).map(flattened)
        )
      );
    });

    test("a to-one whose foreign key it groups by reads as the source reads it, and no other relation", async () => {
      const read = {
        where: { store: { name: { not: "Nowhere" } } },
        orderBy: { store: { name: "desc" } },
        select: {
          storeId: true,
          sumUnits: true,
          store: { select: { name: true } },
        },
      } as const;
      const rows = await client.aggTotals.findMany(read);
      expect(rows.length).toBeGreaterThan(0);
      // Each group's store is the row its foreign key names.
      for (const row of rows)
        expect(row.store).toEqual(
          await client.aggStore.findUnique({
            where: { id: row.storeId },
            select: { name: true },
          })
        );
      expect(rows.map(({ store }) => store.name)).toEqual(
        [...rows.map(({ store }) => store.name)].sort().reverse()
      );
      expect(
        (
          await client.aggByStore.findMany({
            where: { store: { name: "South" } },
            include: { store: { select: { name: true } } },
          })
        ).map(({ store }) => store)
      ).toEqual([{ name: "South" }]);
      // A to-many of its source is no relation of a group.
      await expect(
        client.aggStoreCounts.findMany({ include: { sales: true } } as never)
      ).rejects.toThrow(
        "The view 'aggStoreCounts' does not read 'sales': an aggregated view reads no relation of its source but a to-one whose fields are all in its `by`"
      );
    });

    test("a view over an aggregated view, and an aggregated view over a view", async () => {
      expect(unordered(await client.aggBusy.findMany())).toEqual(
        unordered(await client.aggTotals.findMany(busyQuery))
      );
      const over = unordered(await client.aggBigByStore.findMany());
      expect(over).toEqual(
        unordered(
          (await client.aggBigSales.groupBy(grouping(bigByStoreQuery))).map(
            flattened
          )
        )
      );
      expect(over).toEqual(
        unordered(
          (
            await client.aggSale.groupBy({
              ...grouping(bigByStoreQuery),
              where: bigSalesQuery.where,
            })
          ).map(flattened)
        )
      );
    });

    test("a bigint sum past 2^63: MySQL reads it as groupBy does, PostgreSQL and SQLite refuse the read, never a wrong number", async () => {
      const grouped = await client.aggHuge.groupBy({
        by: ["part"],
        _sum: { big: true },
      });
      expect(grouped).toEqual([
        { part: "a", _sum: { big: 18_000_000_000_000_000_000n } },
      ]);
      if (dialect === "mysql")
        expect(await client.aggHugeTotals.findMany()).toEqual(
          grouped.map(flattened)
        );
      else await expect(client.aggHugeTotals.findMany()).rejects.toThrow();
    });

    test("a time step: the day groupBy answers in the view's time zone, on PostgreSQL alone", async () => {
      if (periods) {
        const daily = client as unknown as {
          aggDaily: { findMany(args?: object): Promise<object[]> };
        };
        const grouped = await client.aggSale.groupBy(grouping(dailyQuery));
        const rows = await daily.aggDaily.findMany();
        expect(unordered(rows)).toEqual(unordered(grouped.map(flattened)));
        expect(
          unordered(
            await daily.aggDaily.findMany({
              where: { soldAt: { gte: "2024-03-02" }, currency: "EUR" },
              select: { soldAt: true, count: true },
            })
          )
        ).toEqual(
          unordered([
            { soldAt: "2024-03-02", count: 2 },
            { soldAt: "2024-03-03", count: 1 },
          ])
        );
        return;
      }
      // Elsewhere the read compiler's refusal, with the view named.
      const stepped = createClient({ schema: { ...schema, aggDaily }, driver });
      await expect(
        syncLiveSchema(stepped, {
          tables: [...AGG_TABLES, "va_daily"],
          dryRun: true,
        })
      ).rejects.toThrow(
        "View 'aggDaily' cannot be created from a query that this database cannot read"
      );
    });

    test("is replaced when its query changes, and when a table it reads changes under it", async () => {
      const changed = s
        .view(() => aggSale, { ...byRegionQuery, _sum: { units: true } })
        .map("va_by_region");
      const next = createClient({
        schema: { ...schema, aggByRegion: changed },
        driver,
      });
      const replaced = await syncLiveSchema(next, { tables: SCOPE });
      expect(replaced.operations.map(({ type }) => type)).toEqual([
        "dropView",
        "createView",
      ]);
      expect(unordered(await next.aggByRegion.findMany())).toEqual(
        unordered(
          (
            await next.aggSale.groupBy({
              by: ["region"],
              _count: true,
              _sum: { units: true },
            })
          ).map(flattened)
        )
      );
      // A column the view groups by is renamed under it.
      const plainOf = (column: string) => {
        const aggPlain = s
          .model({
            id: s.int().id(),
            units: s.int(),
            label: s.string().map(column),
          })
          .map("va_plain");
        const aggPlainTotals = s
          .view(() => aggPlain, { by: ["label"], _sum: { units: true } })
          .map("va_plain_totals");
        return createClient({
          schema: { aggPlain, aggPlainTotals },
          driver,
        });
      };
      const plainScope = ["va_plain", "va_plain_totals"];
      // A database a run left behind holds the column under its new name.
      const renames: ResolveCallback = (change) =>
        change.type === "ambiguous" ? change.rename() : undefined;
      const before = plainOf("plain_label");
      await syncLiveSchema(before, { tables: plainScope, resolve: renames });
      await before.aggPlain.deleteMany({});
      for (const [id, units, label] of [
        [1, 2, "x"],
        [2, 3, "x"],
        [3, 4, "y"],
      ] as const)
        await before.aggPlain.create({ data: { id, units, label } });
      const after = plainOf("plain_note");
      const moved = await syncLiveSchema(after, {
        tables: plainScope,
        resolve: renames,
      });
      const types = moved.operations.map(({ type }) => type);
      expect(types[0]).toBe("dropView");
      expect(types.at(-1)).toBe("createView");
      expect(unordered(await after.aggPlainTotals.findMany())).toEqual(
        unordered([
          { label: "x", sumUnits: 5 },
          { label: "y", sumUnits: 4 },
        ])
      );
      await driver._executeRaw(
        `DROP VIEW IF EXISTS ${quote("va_plain_totals")}`
      );
    });

    // SQLite stores no decimal of 20 digits: a field at its limit has no
    // room above its own range, which is the coefficient's.
    if (dialect !== "sqlite")
      test("a sum past its field's own range is held: the column is as wide as the database stores a decimal of that scale", async () => {
        const aggLedger = s
          .model({
            id: s.int().id(),
            book: s.string(),
            amount: s.decimal({ precision: 20, scale: 2 }),
          })
          .map("va_ledger");
        const aggLedgerTotals = s
          .view(() => aggLedger, { by: ["book"], _sum: { amount: true } })
          .map("va_ledger_totals");
        const ledger = createClient({
          schema: { aggLedger, aggLedgerTotals },
          driver,
        });
        const dropTotals = () =>
          driver._executeRaw(
            `DROP VIEW IF EXISTS ${quote("va_ledger_totals")}`
          );
        await dropTotals();
        await syncLiveSchema(ledger, {
          tables: ["va_ledger", "va_ledger_totals"],
        });
        await ledger.aggLedger.deleteMany({});
        for (const id of [1, 2])
          await ledger.aggLedger.create({
            data: { id, book: "a", amount: "999999999999999999.99" },
          });
        const groups = await ledger.aggLedger.groupBy({
          by: ["book"],
          _sum: { amount: true },
        });
        const rows = await ledger.aggLedgerTotals.findMany();
        expect(rows).toEqual(groups.map(flattened));
        expect(String(rows[0]?.sumAmount)).toBe("1999999999999999999.98");
        await dropTotals();
      });

    test("a materialized aggregated view is keyed by its by list in the database, indexed on a total, and follows a refresh", async () => {
      const stored = dialect === "postgresql";
      const aggStock = s
        .model({ id: s.int().id(), bin: s.string(), units: s.int() })
        .map("va_stock");
      const aggStockTotals = s
        .view(() => aggStock, {
          by: ["bin"],
          _sum: { units: true },
          _count: true,
        })
        .materialized()
        .index(["sumUnits"])
        .map("va_stock_totals");
      const stock = createClient({
        schema: { aggStock, aggStockTotals },
        driver,
      });
      const dropStored = () =>
        driver._executeRaw(
          `DROP ${stored ? "MATERIALIZED " : ""}VIEW IF EXISTS ${quote("va_stock_totals")}`
        );
      await dropStored();
      await syncLiveSchema(stock, { tables: ["va_stock", "va_stock_totals"] });
      // A database a run left behind holds its rows: start from none.
      await stock.aggStock.deleteMany({});
      await stock.aggStockTotals.$refresh();
      for (const [id, bin, units] of [
        [1, "a", 2],
        [2, "a", 3],
        [3, "b", 4],
      ] as const)
        await stock.aggStock.create({ data: { id, bin, units } });
      // Stored rows are those of the last refresh: none where the database
      // stores them. A concurrent refresh matches rows by a unique index,
      // which the view has on its `by` list without declaring one.
      if (stored) expect(await stock.aggStockTotals.count()).toBe(0);
      await stock.aggStockTotals.$refresh({ concurrently: true });
      expect(
        await stock.aggStockTotals.findMany({ orderBy: { bin: "asc" } })
      ).toEqual([
        { bin: "a", sumUnits: 5, count: 2 },
        { bin: "b", sumUnits: 4, count: 1 },
      ]);
      expect(
        await stock.aggStockTotals.findUnique({ where: { bin: "b" } })
      ).toEqual({ bin: "b", sumUnits: 4, count: 1 });
      expect(
        await stock.aggStockTotals.findMany({
          where: { sumUnits: { gt: 4 } },
        })
      ).toEqual([{ bin: "a", sumUnits: 5, count: 2 }]);
      if (stored) {
        const { rows } = await driver._executeRaw<{ indexdef: string }>(
          "SELECT indexdef FROM pg_indexes WHERE tablename = 'va_stock_totals' ORDER BY indexname"
        );
        expect(rows.map((row) => row.indexdef)).toEqual([
          expect.stringMatching(KEY_INDEX_ON_BIN),
          expect.stringMatching(INDEX_ON_TOTAL),
        ]);
      }
      // A second push finds the view, its key and its index as declared.
      const again = await syncLiveSchema(stock, {
        tables: ["va_stock", "va_stock_totals"],
      });
      expect(again.operations).toEqual([]);
      await dropStored();
    });
  });
}
