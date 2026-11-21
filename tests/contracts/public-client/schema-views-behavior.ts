/**
 * Schema-declared views against a real database
 * (`docs/architecture/schema-views-plan.md`): each view of the corpus is
 * created by a push of the schema that declares it, a second push plans
 * nothing, and a read of the view answers what its declared query answers on
 * its source,
 * scalars and JSON columns alike, decoded by the read's own decoder. Then the
 * ordinary read verbs run on the views unchanged, and a write is refused
 * before any statement.
 */

import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { ForbiddenError, UnsupportedOperationError } from "@errors";
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
  describe(`${name}: schema views`, () => {
    const driver = createDriver();
    const setup = createClient({ schema: tables, driver });
    const client = createClient({ schema, driver });
    const quote = (identifier: string) =>
      dialect === "mysql" ? `\`${identifier}\`` : `"${identifier}"`;
    const SCOPE = [...TABLE_NAMES, ...Object.values(NAMES)];
    const dropViews = async () => {
      for (const view of [...CREATED].reverse())
        await driver._executeRaw(`DROP VIEW IF EXISTS ${quote(NAMES[view])}`);
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
  });
}
