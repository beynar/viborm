import { s } from "@schema";
import { beforeEach, describe, expect, test } from "vitest";

/**
 * PACKAGE J — root `createMany` whose rows carry relations, as BEHAVIOR.
 *
 * Every claim here is one of plan §5.1's sentences, run against a real database on
 * whatever substrate the caller supplies:
 *
 *   · ordinary create calls executed LEFT TO RIGHT in one transaction;
 *   · later inputs may observe earlier effects (first-create-wins falls out of that,
 *     and is measured in BOTH directions — the reversed order must fail);
 *   · `count` is the number of successfully inserted ROOT rows, never descendants;
 *   · a returning selection is read AFTER every member finishes, so a later row's
 *     relation effect cannot leave an earlier row's projection stale;
 *   · input order is execution order is result order;
 *   · a failure in any row rolls back every row.
 *
 * The one boundary the lift leaves is here too: `skipDuplicates` beside a general
 * nested effect is refused, typed, before anything runs.
 *
 * Deliberately NOT here: which SQL any of this compiles to. The plan shapes,
 * step ids and bytes are `parity-j-create-many.test.ts`'s (for the two arms J keeps
 * byte-identical) and `create-many-relation-series.test.ts`'s (for the series' own
 * routing and its PGlite-only injections).
 */
export const createManySeriesSchema = (() => {
  const author = s
    .model({
      // PRODUCED identity: every member that creates an author has to publish a key
      // it did not know at construction, which is the shape F's machinery answers.
      id: s.int().id().increment(),
      name: s.string().unique(),
      posts: s.oneToMany(() => post),
    })
    .map("jseries_authors");

  const post = s
    .model({
      // Caller-supplied so a LATER row can name an EARLIER row's root by literal id —
      // the only way to write the read-after-all-members staleness witness.
      id: s.int().id(),
      title: s.string(),
      authorId: s.int(),
      author: s
        .manyToOne(() => author)
        .fields("authorId")
        .references("id"),
      // The junction is named explicitly: the generated name is derived from the two
      // MODEL KEYS (`post_tag`), which the shared Docker database would hand to every
      // other suite whose models are also called `post` and `tag`.
      tags: s.manyToMany(() => tag).through("jseries_post_tag"),
      attachments: s.oneToMany(() => attachment),
    })
    .map("jseries_posts");

  const tag = s
    .model({
      id: s.int().id(),
      name: s.string().unique(),
      posts: s.manyToMany(() => post).through("jseries_post_tag"),
    })
    .map("jseries_tags");

  const image = s
    .model({ id: s.int().id(), url: s.string() })
    .map("jseries_images");
  const clip = s
    .model({ id: s.int().id(), url: s.string() })
    .map("jseries_clips");

  const attachment = s
    .model({
      id: s.int().id(),
      caption: s.string(),
      postId: s.int(),
      post: s
        .manyToOne(() => post)
        .fields("postId")
        .references("id"),
      media: s.polymorphic(
        { image: () => image, clip: () => clip },
        { values: { image: "jseries.image.v1", clip: "jseries.clip.v1" } }
      ),
    })
    .map("jseries_attachments");

  return { author, post, tag, image, clip, attachment };
})();

interface StoredAttachment {
  readonly id: number;
  readonly media_type: string;
  readonly media_id: number;
}

export function registerCreateManySeriesBehavior(
  name: string,
  getClient: () => Promise<any>,
  describeFn: (name: string, body: () => void) => void = describe
): void {
  describeFn(`Package J relation-bearing createMany (${name})`, () => {
    let client: any;

    beforeEach(async () => {
      client = await getClient();
      // Children before parents: every suite shares one migrated database and each
      // test starts from an empty one.
      for (const model of [
        "attachment",
        "tag",
        "post",
        "author",
        "image",
        "clip",
      ]) {
        await client[model].deleteMany({});
      }
    });

    test("a row may connect and a row may create, and count is the ROOT count", async () => {
      await client.author.create({ data: { name: "resident" } });

      const result = await client.post.createMany({
        data: [
          {
            id: 1,
            title: "connected",
            author: { connect: { name: "resident" } },
          },
          { id: 2, title: "fresh", author: { create: { name: "arrival" } } },
        ],
      });

      expect(result).toEqual({ count: 2 });
      const posts = await client.post.findMany({
        orderBy: { id: "asc" },
        select: { id: true, title: true, author: { select: { name: true } } },
      });
      expect(posts).toEqual([
        { id: 1, title: "connected", author: { name: "resident" } },
        { id: 2, title: "fresh", author: { name: "arrival" } },
      ]);
    });

    test("a SCALAR-ONLY row inside a series writes what the grouped INSERT would", async () => {
      // One relation-bearing row pulls the WHOLE payload onto the series, scalar
      // siblings included — so a row spelling its edge as a plain FK column stops
      // being part of a grouped multi-row INSERT and becomes an ordinary `create`.
      // The claim that this changes nothing about the row it writes is asserted here
      // rather than left to the routing test, on every substrate, in both arms.
      const host = await client.author.create({ data: { name: "host" } });

      await expect(
        client.post.createMany({
          data: [
            { id: 1, title: "scalar row", authorId: host.id },
            {
              id: 2,
              title: "relation row",
              author: { create: { name: "new" } },
            },
          ],
        })
      ).resolves.toEqual({ count: 2 });

      const rows = await client.post.createMany({
        data: [
          { id: 3, title: "scalar row too", authorId: host.id },
          {
            id: 4,
            title: "relation row too",
            author: { connect: { name: "host" } },
          },
        ],
        select: { id: true, title: true, authorId: true },
      });
      expect(rows).toEqual([
        { id: 3, title: "scalar row too", authorId: host.id },
        { id: 4, title: "relation row too", authorId: host.id },
      ]);

      await expect(
        client.post.findMany({
          orderBy: { id: "asc" },
          select: { id: true, authorId: true },
        })
      ).resolves.toEqual([
        { id: 1, authorId: host.id },
        { id: 2, authorId: expect.any(Number) },
        { id: 3, authorId: host.id },
        { id: 4, authorId: host.id },
      ]);
    });

    test("count is the ROOT row count — descendants are not counted", async () => {
      // ONE input row; three posts exist afterwards. The two extra ones are the
      // grandchildren of a nested `createMany` under a PRODUCED author id — the
      // same shape `nested-create-context-grandchild` covers under a single create,
      // now reached through the bulk route.
      const result = await client.post.createMany({
        data: [
          {
            id: 10,
            title: "root",
            author: {
              create: {
                name: "grandparent",
                posts: {
                  createMany: {
                    data: [
                      { id: 11, title: "grandchild one" },
                      { id: 12, title: "grandchild two" },
                    ],
                  },
                },
              },
            },
          },
        ],
      });

      expect(result).toEqual({ count: 1 });
      const posts = await client.post.findMany({
        orderBy: { id: "asc" },
        select: { id: true, authorId: true },
      });
      expect(posts.map((row: any) => row.id)).toEqual([10, 11, 12]);
      // All three hang off the ONE produced author key the member published.
      expect(new Set(posts.map((row: any) => row.authorId)).size).toBe(1);
    });

    test("row N observes row N-1: connectOrCreate adopts what an earlier row made", async () => {
      const result = await client.post.createMany({
        data: [
          { id: 1, title: "first", author: { create: { name: "shared" } } },
          {
            id: 2,
            title: "second",
            author: {
              connectOrCreate: {
                where: { name: "shared" },
                create: { name: "shared" },
              },
            },
          },
        ],
      });

      expect(result).toEqual({ count: 2 });
      const authors = await client.author.findMany({
        where: { name: "shared" },
      });
      expect(authors).toHaveLength(1);
      const posts = await client.post.findMany({
        orderBy: { id: "asc" },
        select: { id: true, authorId: true },
      });
      expect(posts[0].authorId).toBe(authors[0].id);
      expect(posts[1].authorId).toBe(authors[0].id);
    });

    test("the SAME two rows reversed fail — the effect follows input order", async () => {
      // The falsifier for the test above. If the series planned every row before any
      // row wrote (or if it deduplicated across rows from a ledger), this would
      // succeed exactly as the forward order did. It must not: the `connectOrCreate`
      // now runs FIRST, finds nothing, creates `shared`, and the plain `create` that
      // follows collides with it.
      await expect(
        client.post.createMany({
          data: [
            {
              id: 1,
              title: "first",
              author: {
                connectOrCreate: {
                  where: { name: "shared" },
                  create: { name: "shared" },
                },
              },
            },
            { id: 2, title: "second", author: { create: { name: "shared" } } },
          ],
        })
      ).rejects.toThrow();
      // …and it rolled everything back, including the row that had succeeded.
      await expect(client.post.findMany()).resolves.toEqual([]);
      await expect(client.author.findMany()).resolves.toEqual([]);
    });

    test("duplicate connectOrCreate in TWO rows leaves one target and links both", async () => {
      const result = await client.post.createMany({
        data: [
          {
            id: 1,
            title: "one",
            author: {
              connectOrCreate: {
                where: { name: "shared" },
                create: { name: "shared" },
              },
            },
          },
          {
            id: 2,
            title: "two",
            author: {
              connectOrCreate: {
                where: { name: "shared" },
                create: { name: "shared" },
              },
            },
          },
        ],
      });

      expect(result).toEqual({ count: 2 });
      const authors = await client.author.findMany();
      expect(authors).toHaveLength(1);
      const posts = await client.post.findMany({
        orderBy: { id: "asc" },
        select: { authorId: true },
      });
      expect(posts).toEqual([
        { authorId: authors[0].id },
        { authorId: authors[0].id },
      ]);
    });

    test("a junction row: m2m create in one row, adopted by the next", async () => {
      const result = await client.post.createMany({
        data: [
          {
            id: 1,
            title: "one",
            author: { create: { name: "a1" } },
            tags: {
              create: [
                { id: 1, name: "alpha" },
                { id: 2, name: "beta" },
              ],
            },
          },
          {
            id: 2,
            title: "two",
            author: { create: { name: "a2" } },
            tags: {
              connectOrCreate: {
                where: { name: "alpha" },
                create: { id: 3, name: "alpha" },
              },
            },
          },
        ],
      });

      expect(result).toEqual({ count: 2 });
      // The second row ADOPTED tag 1 rather than creating tag 3: the probe ran after
      // the first row's join and child writes landed in this transaction.
      const tags = await client.tag.findMany({ orderBy: { id: "asc" } });
      expect(tags).toEqual([
        { id: 1, name: "alpha" },
        { id: 2, name: "beta" },
      ]);
      const posts = await client.post.findMany({
        orderBy: { id: "asc" },
        select: { id: true, tags: { select: { id: true } } },
      });
      expect(posts).toEqual([
        { id: 1, tags: [{ id: 1 }, { id: 2 }] },
        { id: 2, tags: [{ id: 1 }] },
      ]);
    });

    test("a returning selection is read AFTER every member, in input order", async () => {
      await client.author.create({ data: { name: "original" } });

      const rows = await client.post.createMany({
        data: [
          { id: 1, title: "first", author: { connect: { name: "original" } } },
          {
            id: 2,
            title: "second",
            author: {
              // This nested create REPARENTS post 1 — the row the previous member
              // just inserted. If the returning projection were read as each member
              // finished, row 1 would answer with `original`'s key.
              create: { name: "thief", posts: { connect: { id: 1 } } },
            },
          },
        ],
        select: { id: true, title: true, authorId: true },
      });

      const thief = await client.author.findFirst({ where: { name: "thief" } });
      expect(rows).toEqual([
        { id: 1, title: "first", authorId: thief.id },
        { id: 2, title: "second", authorId: thief.id },
      ]);
    });

    test("omit and scalar casts survive the series' own read", async () => {
      const rows = await client.post.createMany({
        data: [
          { id: 5, title: "kept", author: { create: { name: "o1" } } },
          { id: 4, title: "also kept", author: { create: { name: "o2" } } },
        ],
        omit: { authorId: true },
      });
      // INPUT order, not key order — 5 before 4.
      expect(rows).toEqual([
        { id: 5, title: "kept" },
        { id: 4, title: "also kept" },
      ]);
    });

    test("a mid-row failure rolls back every row", async () => {
      await client.author.create({ data: { name: "taken" } });

      await expect(
        client.post.createMany({
          data: [
            { id: 1, title: "ok", author: { create: { name: "free" } } },
            { id: 2, title: "doomed", author: { create: { name: "taken" } } },
          ],
        })
      ).rejects.toThrow();

      await expect(client.post.findMany()).resolves.toEqual([]);
      await expect(
        client.author.findMany({ where: { name: "free" } })
      ).resolves.toEqual([]);
    });

    test("inside an interactive transaction, a failed series takes back ONLY its own rows", async () => {
      // The series always opens a scope of its OWN — a SAVEPOINT when the caller
      // already holds one (Package I). This is the half a fake operation cannot show:
      // the caller's work on BOTH sides of the failed bulk write survives, the bulk
      // write's own members do not, and the enclosing transaction is still usable
      // afterwards rather than poisoned by the member's constraint violation.
      await client.author.create({ data: { name: "taken" } });

      let refusal: unknown;
      await client.$transaction(async (tx: any) => {
        await tx.author.create({ data: { name: "before" } });
        try {
          await tx.post.createMany({
            data: [
              { id: 1, title: "ok", author: { create: { name: "free" } } },
              { id: 2, title: "doomed", author: { create: { name: "taken" } } },
            ],
          });
        } catch (error) {
          refusal = error;
        }
        await tx.author.create({ data: { name: "after" } });
      });

      expect(refusal).toBeInstanceOf(Error);
      await expect(client.post.findMany()).resolves.toEqual([]);
      const authors = await client.author.findMany({
        orderBy: { name: "asc" },
        select: { name: true },
      });
      expect(authors).toEqual([
        { name: "after" },
        { name: "before" },
        { name: "taken" },
      ]);
    });

    test("inside an interactive transaction, a series that SUCCEEDS still rolls back with the caller", async () => {
      // The other direction: the series' own scope must not COMMIT independently of
      // the transaction it is nested in. If its `withTransaction` were a fresh
      // top-level envelope rather than a savepoint, these rows would survive the
      // caller's rollback.
      await expect(
        client.$transaction(async (tx: any) => {
          await tx.post.createMany({
            data: [
              { id: 1, title: "ok", author: { create: { name: "free" } } },
            ],
          });
          throw new Error("caller aborts");
        })
      ).rejects.toThrow("caller aborts");

      await expect(client.post.findMany()).resolves.toEqual([]);
      await expect(client.author.findMany()).resolves.toEqual([]);
    });

    test("a mixed row keeps the polymorphic membership the bulk route would store", async () => {
      await client.image.create({ data: { id: 1, url: "one" } });
      await client.post.createMany({
        data: [{ id: 1, title: "host", author: { create: { name: "host" } } }],
      });

      // The BULK route: a poly-connect-only row, grouped probe, grouped INSERT.
      await client.attachment.createMany({
        data: [
          {
            id: 1,
            caption: "bulk",
            postId: 1,
            media: { connect: { type: "image", where: { id: 1 } } },
          },
        ],
      });
      // The SERIES route: the same membership, beside an ordinary relation.
      await client.attachment.createMany({
        data: [
          {
            id: 2,
            caption: "series",
            media: { connect: { type: "image", where: { id: 1 } } },
            post: { connect: { id: 1 } },
          },
        ],
      });

      const stored: StoredAttachment[] = await client.$queryRawUnsafe(
        "SELECT id, media_type, media_id FROM jseries_attachments ORDER BY id"
      );
      // Byte-identical private columns: the route changed, the stored pair did not.
      expect(stored.map((row) => [row.media_type, row.media_id])).toEqual([
        ["jseries.image.v1", 1],
        ["jseries.image.v1", 1],
      ]);
    });

    test("empty data is the same zero-I/O no-op it always was", async () => {
      await expect(client.post.createMany({ data: [] })).resolves.toEqual({
        count: 0,
      });
    });

    test("skipDuplicates beside a nested relation write is refused, typed", async () => {
      await expect(
        client.post.createMany({
          data: [{ id: 1, title: "one", author: { create: { name: "a" } } }],
          skipDuplicates: true,
        })
      ).rejects.toThrow(
        "createMany cannot combine 'skipDuplicates' with nested relation writes"
      );
      // Refused BEFORE anything ran.
      await expect(client.author.findMany()).resolves.toEqual([]);
    });

    test("skipDuplicates on scalar-only rows is untouched", async () => {
      const author = await client.author.create({ data: { name: "scalar" } });
      const first = await client.post.createMany({
        data: [
          { id: 1, title: "one", authorId: author.id },
          { id: 2, title: "two", authorId: author.id },
        ],
        skipDuplicates: true,
      });
      expect(first).toEqual({ count: 2 });
      const second = await client.post.createMany({
        data: [
          { id: 2, title: "dup", authorId: author.id },
          { id: 3, title: "three", authorId: author.id },
        ],
        skipDuplicates: true,
      });
      expect(second).toEqual({ count: 1 });
    });
  });
}
