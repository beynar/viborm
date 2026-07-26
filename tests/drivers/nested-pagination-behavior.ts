import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { s } from "@schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

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
    posts: s.oneToMany(() => post),
    tags: s.manyToMany(() => tag),
  })
  .map("nested_page_authors");

const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    topic: s.string(),
    authorId: s.string().nullable(),
    author: s
      .manyToOne(() => author)
      .fields("authorId")
      .references("id")
      .optional(),
  })
  .map("nested_page_posts");

const tag = s
  .model({
    id: s.string().id(),
    label: s.string(),
    authors: s.manyToMany(() => author),
  })
  .map("nested_page_tags");

const shelf = s
  .model({
    id: s.string().id(),
    name: s.string(),
    chapters: s.oneToMany(() => chapter),
  })
  .map("nested_page_shelves");

const chapter = s
  .model({
    id: s.string().id(),
    volume: s.int(),
    page: s.int(),
    shelfId: s.string().nullable(),
    shelf: s
      .manyToOne(() => shelf)
      .fields("shelfId")
      .references("id")
      .optional(),
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
      await push(client, { force: true });

      await client.author.create({
        data: {
          id: "a1",
          name: "Ada",
          tags: {
            create: [
              { id: "t1", label: "one" },
              { id: "t2", label: "two" },
              { id: "t3", label: "three" },
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
  });
}
