import { defineContract } from "@tests/contracts/contract";
import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";

import { s } from "@schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

/**
 * Nested relation pagination (W3-A): `take` (including Prisma's negative "last
 * N"), `skip`, `cursor` and `distinct` INSIDE include/select relation args.
 *
 * The same suite runs on every dialect on purpose: PostgreSQL/MySQL build the
 * relation window as a LATERAL join, SQLite as a correlated subquery, and the
 * two strategies must return identical rows in identical order.
 */

const author = s
  .model({
    id: s.string().id(),
    name: s.string(),
    posts: s.toMany(() => post),
    tags: s.toMany(() => tag),
  })
  .map("nested_page_authors");

const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    topic: s.string(),
    authorId: s.string().nullable(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
  })
  .map("nested_page_posts");

const tag = s
  .model({
    id: s.string().id(),
    label: s.string(),
    authors: s.toMany(() => author),
  })
  .map("nested_page_tags");

const shelf = s
  .model({
    id: s.string().id(),
    name: s.string(),
    chapters: s.toMany(() => chapter),
  })
  .map("nested_page_shelves");

const chapter = s
  .model({
    id: s.string().id(),
    volume: s.int(),
    page: s.int(),
    shelfId: s.string().nullable(),
    shelf: s
      .toOne(() => shelf)
      .fields("shelfId")
      .references("id"),
  })
  .unique(["volume", "page"])
  .map("nested_page_chapters");

const schema = { author, post, tag, shelf, chapter };

type NestedPaginationConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};

type NestedPaginationClient = VibORMClient<NestedPaginationConfig>;

export interface NestedPaginationBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

const POSTS: { id: string; topic: string; authorId: string }[] = [
  { id: "a1-p1", topic: "alpha", authorId: "a1" },
  { id: "a1-p2", topic: "alpha", authorId: "a1" },
  { id: "a1-p3", topic: "beta", authorId: "a1" },
  { id: "a1-p4", topic: "beta", authorId: "a1" },
  { id: "a1-p5", topic: "gamma", authorId: "a1" },
  { id: "a2-p1", topic: "alpha", authorId: "a2" },
  { id: "a2-p2", topic: "delta", authorId: "a2" },
  { id: "a2-p3", topic: "delta", authorId: "a2" },
];

// `[volume, page]` is a global compound unique — every pair is distinct
const CHAPTERS: {
  id: string;
  volume: number;
  page: number;
  shelfId: string;
}[] = [
  { id: "s1-c1", volume: 1, page: 1, shelfId: "s1" },
  { id: "s1-c2", volume: 1, page: 2, shelfId: "s1" },
  { id: "s1-c3", volume: 1, page: 3, shelfId: "s1" },
  { id: "s2-c1", volume: 2, page: 1, shelfId: "s2" },
  { id: "s2-c2", volume: 2, page: 2, shelfId: "s2" },
];

function ids(rows: { id: string }[] | undefined): string[] {
  return (rows ?? []).map((row) => row.id);
}

export function runNestedPaginationBehavior({
  driverName,
  createDriver,
}: NestedPaginationBehaviorOptions) {
  describe(`${driverName} nested relation pagination behavior`, () => {
    let client: NestedPaginationClient;

    beforeEach(async () => {
      client = createClient({ schema, driver: createDriver() });
      await syncLiveSchema(client);

      await client.author.create({
        data: {
          id: "a1",
          name: "Ada",
          // t1 and t2 DELIBERATELY share a label: it is the only duplicate in
          // the m2m fixture, and without it the junction `distinct` test below
          // has nothing to falsify (three distinct labels keep three rows, which
          // is also what no distinct at all returns). The sibling m2m tests key
          // on `id`, never on `label`, so they are unaffected.
          tags: {
            create: [
              { id: "t1", label: "shared" },
              { id: "t2", label: "shared" },
              { id: "t3", label: "solo" },
            ],
          },
        },
      });
      await client.author.create({ data: { id: "a2", name: "Bob" } });
      for (const row of POSTS) {
        await client.post.create({
          data: { ...row, title: `title ${row.id}` },
        });
      }
      await client.shelf.create({ data: { id: "s1", name: "left" } });
      await client.shelf.create({ data: { id: "s2", name: "right" } });
      for (const row of CHAPTERS) {
        await client.chapter.create({ data: row });
      }
    });

    afterEach(async () => {
      await client.$disconnect();
    });

    describe("negative take", () => {
      test("returns the last N per parent in logical order", async () => {
        const authors = await client.author.findMany({
          orderBy: { id: "asc" },
          include: { posts: { orderBy: { id: "asc" }, take: -2 } },
        });

        expect(authors.map((row) => ids(row.posts))).toEqual([
          ["a1-p4", "a1-p5"],
          ["a2-p2", "a2-p3"],
        ]);
      });

      test("composes with a nested where", async () => {
        const found = await client.author.findUnique({
          where: { id: "a1" },
          include: {
            posts: {
              where: { topic: "beta" },
              orderBy: { id: "asc" },
              take: -1,
            },
          },
        });

        expect(ids(found?.posts)).toEqual(["a1-p4"]);
      });

      test("composes with skip (skip counts from the end)", async () => {
        const found = await client.author.findUnique({
          where: { id: "a1" },
          include: { posts: { orderBy: { id: "asc" }, take: -2, skip: 1 } },
        });

        expect(ids(found?.posts)).toEqual(["a1-p3", "a1-p4"]);
      });

      test("without an explicit orderBy pages the identity order", async () => {
        const found = await client.author.findUnique({
          where: { id: "a1" },
          include: { posts: { take: -2 } },
        });

        expect(ids(found?.posts)).toEqual(["a1-p4", "a1-p5"]);
      });

      test("honors a descending orderBy", async () => {
        const found = await client.author.findUnique({
          where: { id: "a1" },
          include: { posts: { orderBy: { id: "desc" }, take: -2 } },
        });

        expect(ids(found?.posts)).toEqual(["a1-p2", "a1-p1"]);
      });

      test("works in select position and through a to-one hop", async () => {
        const selected = await client.author.findUnique({
          where: { id: "a1" },
          select: {
            id: true,
            posts: { orderBy: { id: "asc" }, take: -1, select: { id: true } },
          },
        });
        expect(ids(selected?.posts)).toEqual(["a1-p5"]);

        const throughToOne = await client.post.findUnique({
          where: { id: "a1-p1" },
          include: {
            author: {
              include: { posts: { orderBy: { id: "asc" }, take: -2 } },
            },
          },
        });
        expect(ids(throughToOne?.author?.posts)).toEqual(["a1-p4", "a1-p5"]);
      });

      test("pages a many-to-many relation through its junction", async () => {
        const found = await client.author.findUnique({
          where: { id: "a1" },
          include: { tags: { orderBy: { id: "asc" }, take: -2 } },
        });

        expect(ids(found?.tags)).toEqual(["t2", "t3"]);
      });

      test("take 0 returns an empty relation window", async () => {
        const found = await client.author.findUnique({
          where: { id: "a1" },
          include: { posts: { orderBy: { id: "asc" }, take: 0 } },
        });

        expect(ids(found?.posts)).toEqual([]);
      });
    });

    describe("cursor", () => {
      test("pages a relation forward, three pages, cursor inclusive", async () => {
        const page = async (cursorId: string | undefined) =>
          ids(
            (
              await client.author.findUnique({
                where: { id: "a1" },
                include: {
                  posts: {
                    orderBy: { id: "asc" },
                    take: 2,
                    ...(cursorId
                      ? { cursor: { id: cursorId }, skip: 1 }
                      : undefined),
                  },
                },
              })
            )?.posts
          );

        const first = await page(undefined);
        expect(first).toEqual(["a1-p1", "a1-p2"]);

        const second = await page(first.at(-1));
        expect(second).toEqual(["a1-p3", "a1-p4"]);

        const third = await page(second.at(-1));
        expect(third).toEqual(["a1-p5"]);
      });

      test("cursor without skip includes the cursor row itself", async () => {
        const found = await client.author.findUnique({
          where: { id: "a1" },
          include: {
            posts: { orderBy: { id: "asc" }, cursor: { id: "a1-p3" } },
          },
        });

        expect(ids(found?.posts)).toEqual(["a1-p3", "a1-p4", "a1-p5"]);
      });

      test("pages each parent independently from one cursor", async () => {
        // The cursor row belongs to a2 and sorts after every a1 post, so a1's
        // window is empty while a2 pages from it — per-parent cursor semantics.
        const authors = await client.author.findMany({
          orderBy: { id: "asc" },
          include: {
            posts: { orderBy: { id: "asc" }, cursor: { id: "a2-p2" } },
          },
        });

        expect(authors.map((row) => ids(row.posts))).toEqual([
          [],
          ["a2-p2", "a2-p3"],
        ]);
      });

      test("a cursor row that does not exist yields an empty window", async () => {
        const authors = await client.author.findMany({
          orderBy: { id: "asc" },
          include: {
            posts: { orderBy: { id: "asc" }, cursor: { id: "nope" } },
          },
        });

        expect(authors.map((row) => ids(row.posts))).toEqual([[], []]);
      });

      test("combines with a negative take (pages backward from the cursor)", async () => {
        const found = await client.author.findUnique({
          where: { id: "a1" },
          include: {
            posts: {
              orderBy: { id: "asc" },
              cursor: { id: "a1-p4" },
              skip: 1,
              take: -2,
            },
          },
        });

        expect(ids(found?.posts)).toEqual(["a1-p2", "a1-p3"]);
      });

      test("combines with a nested where", async () => {
        const found = await client.author.findUnique({
          where: { id: "a1" },
          include: {
            posts: {
              where: { topic: "beta" },
              orderBy: { id: "asc" },
              cursor: { id: "a1-p3" },
              take: 1,
            },
          },
        });

        expect(ids(found?.posts)).toEqual(["a1-p3"]);
      });

      test("accepts a compound unique cursor", async () => {
        const found = await client.shelf.findUnique({
          where: { id: "s1" },
          include: {
            chapters: {
              orderBy: [{ volume: "asc" }, { page: "asc" }],
              cursor: { volume_page: { volume: 1, page: 2 } },
              take: 2,
            },
          },
        });

        expect(ids(found?.chapters)).toEqual(["s1-c2", "s1-c3"]);
      });

      test("pages a many-to-many relation through its junction", async () => {
        const found = await client.author.findUnique({
          where: { id: "a1" },
          include: {
            tags: { orderBy: { id: "asc" }, cursor: { id: "t2" }, take: 2 },
          },
        });

        expect(ids(found?.tags)).toEqual(["t2", "t3"]);
      });
    });

    describe("distinct", () => {
      test("keeps the first row of each group, per parent", async () => {
        const authors = await client.author.findMany({
          orderBy: { id: "asc" },
          include: {
            posts: { orderBy: { id: "asc" }, distinct: ["topic"] },
          },
        });

        expect(authors.map((row) => ids(row.posts))).toEqual([
          ["a1-p1", "a1-p3", "a1-p5"],
          ["a2-p1", "a2-p2"],
        ]);
        expect(authors.map((row) => row.posts.map((p) => p.topic))).toEqual([
          ["alpha", "beta", "gamma"],
          ["alpha", "delta"],
        ]);
      });

      test("honors the order when choosing the surviving row", async () => {
        const found = await client.author.findUnique({
          where: { id: "a1" },
          include: {
            posts: { orderBy: { id: "desc" }, distinct: ["topic"] },
          },
        });

        expect(ids(found?.posts)).toEqual(["a1-p5", "a1-p4", "a1-p2"]);
      });

      test("take windows the distinct set, not the raw rows", async () => {
        const found = await client.author.findUnique({
          where: { id: "a1" },
          include: {
            posts: { orderBy: { id: "asc" }, distinct: ["topic"], take: 2 },
          },
        });

        expect(ids(found?.posts)).toEqual(["a1-p1", "a1-p3"]);
      });

      test("skip windows the distinct set too", async () => {
        const found = await client.author.findUnique({
          where: { id: "a1" },
          include: {
            posts: {
              orderBy: { id: "asc" },
              distinct: ["topic"],
              take: 1,
              skip: 1,
            },
          },
        });

        expect(ids(found?.posts)).toEqual(["a1-p3"]);
      });

      test("composes with a negative take", async () => {
        const found = await client.author.findUnique({
          where: { id: "a1" },
          include: {
            posts: { orderBy: { id: "asc" }, distinct: ["topic"], take: -2 },
          },
        });

        // distinct over the reversed order keeps p5/p4/p2; the last two of that
        // set in logical order are p4 and p5
        expect(ids(found?.posts)).toEqual(["a1-p4", "a1-p5"]);
      });

      test("composes with a nested where", async () => {
        const found = await client.author.findUnique({
          where: { id: "a1" },
          include: {
            posts: {
              where: { topic: { in: ["alpha", "beta"] } },
              orderBy: { id: "asc" },
              distinct: ["topic"],
            },
          },
        });

        expect(ids(found?.posts)).toEqual(["a1-p1", "a1-p3"]);
      });

      test("without an orderBy still deduplicates the group", async () => {
        const found = await client.author.findUnique({
          where: { id: "a1" },
          include: { posts: { distinct: ["topic"] } },
        });

        expect(
          (found?.posts ?? [])
            .map((p) => p.topic)
            .sort((a, b) => (a < b ? -1 : 1))
        ).toEqual(["alpha", "beta", "gamma"]);
      });

      test("multi-field distinct groups by the combination", async () => {
        const found = await client.author.findUnique({
          where: { id: "a1" },
          include: {
            posts: { orderBy: { id: "asc" }, distinct: ["topic", "title"] },
          },
        });

        // every title is unique, so the combination keeps every row
        expect(ids(found?.posts)).toEqual([
          "a1-p1",
          "a1-p2",
          "a1-p3",
          "a1-p4",
          "a1-p5",
        ]);
      });

      test("deduplicates a many-to-many relation through its junction", async () => {
        // The control: without `distinct` the junction hands back all three.
        const all = await client.author.findUnique({
          where: { id: "a1" },
          include: { tags: { orderBy: { id: "asc" } } },
        });
        expect(ids(all?.tags)).toEqual(["t1", "t2", "t3"]);

        // t1 and t2 share a label, so distinct must drop one of them — and the
        // order decides WHICH one, exactly as on a non-junction relation.
        const found = await client.author.findUnique({
          where: { id: "a1" },
          include: { tags: { orderBy: { id: "asc" }, distinct: ["label"] } },
        });
        expect(ids(found?.tags)).toEqual(["t1", "t3"]);

        const reversed = await client.author.findUnique({
          where: { id: "a1" },
          include: { tags: { orderBy: { id: "desc" }, distinct: ["label"] } },
        });
        expect(ids(reversed?.tags)).toEqual(["t3", "t2"]);
      });

      test("an unknown distinct field fails closed", async () => {
        await expect(
          client.author.findUnique({
            where: { id: "a1" },
            include: {
              posts: { distinct: ["nope" as "topic"] },
            },
          })
        ).rejects.toThrow();
      });
    });
  });
}

export const nestedPaginationContract = defineContract({
  id: "drivers.nested-pagination",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runNestedPaginationBehavior,
});
