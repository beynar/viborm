import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { s } from "@schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

// =============================================================================
// Schema: users with posts, nullable author FK so isNot can pin null-FK rows
// =============================================================================

const user = s
  .model({
    id: s.string().id(),
    name: s.string(),
    posts: s.oneToMany(() => post),
  })
  .map("rel_agg_users");

const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    published: s.boolean().default(false),
    authorId: s.string().nullable(),
    author: s
      .manyToOne(() => user)
      .fields("authorId")
      .references("id")
      .optional(),
  })
  .map("rel_agg_posts");

const schema = { user, post };

type RelationReadAggregateClientConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};

type RelationReadAggregateClient =
  VibORMClient<RelationReadAggregateClientConfig>;

export interface RelationReadAggregateBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

/**
 * Execution-backed coverage for the relation read/aggregate path:
 * - relation `_count` selection (plain, filtered, alongside include)
 * - orderBy on to-many `_count` and to-one relation scalars
 * - to-one `isNot` with real conditions (null-FK rows pinned as matching,
 *   Prisma parity: NOT EXISTS is vacuously true for a null FK)
 * - every/none to-many filters on findMany (vacuous truth for zero relations)
 *
 * Seed (in beforeEach):
 *   u1 Alice — p1 (published), p2 (published), p3 (unpublished)
 *   u2 Bob   — p4 (unpublished)
 *   u3 Cara  — no posts
 *   u4 Dana  — p6 (published)
 *   p5       — authorId null, published
 */
export function runRelationReadAggregateBehavior({
  driverName,
  createDriver,
}: RelationReadAggregateBehaviorOptions) {
  describe(`${driverName} relation read/aggregate behavior`, () => {
    let client: RelationReadAggregateClient;

    beforeEach(async () => {
      client = createClient({ schema, driver: createDriver() });
      await push(client, { force: true });

      await client.user.createMany({
        data: [
          { id: "u1", name: "Alice" },
          { id: "u2", name: "Bob" },
          { id: "u3", name: "Cara" },
          { id: "u4", name: "Dana" },
        ],
      });
      await client.post.createMany({
        data: [
          { id: "p1", title: "A1", published: true, authorId: "u1" },
          { id: "p2", title: "A2", published: true, authorId: "u1" },
          { id: "p3", title: "A3", published: false, authorId: "u1" },
          { id: "p4", title: "B1", published: false, authorId: "u2" },
          { id: "p5", title: "Orphan", published: true, authorId: null },
          { id: "p6", title: "D1", published: true, authorId: "u4" },
        ],
      });
    });

    afterEach(async () => {
      await client.$disconnect();
    });

    describe("relation _count selection", () => {
      test("select _count returns exact counts, including zero", async () => {
        const users = await client.user.findMany({
          orderBy: { id: "asc" },
          select: { id: true, _count: { select: { posts: true } } },
        });

        expect(users).toEqual([
          { id: "u1", _count: { posts: 3 } },
          { id: "u2", _count: { posts: 1 } },
          { id: "u3", _count: { posts: 0 } },
          { id: "u4", _count: { posts: 1 } },
        ]);
        // Exactly the selected keys, nothing else
        expect(Object.keys(users[0]!).sort()).toEqual(["_count", "id"]);
      });

      test("select _count on findUnique with zero relations", async () => {
        const cara = await client.user.findUnique({
          where: { id: "u3" },
          select: { id: true, _count: { select: { posts: true } } },
        });

        expect(cara).toEqual({ id: "u3", _count: { posts: 0 } });
      });

      test("filtered _count only counts rows matching the where", async () => {
        const users = await client.user.findMany({
          orderBy: { id: "asc" },
          select: {
            id: true,
            _count: { select: { posts: { where: { published: true } } } },
          },
        });

        expect(users).toEqual([
          { id: "u1", _count: { posts: 2 } },
          { id: "u2", _count: { posts: 0 } },
          { id: "u3", _count: { posts: 0 } },
          { id: "u4", _count: { posts: 1 } },
        ]);
      });

      test("_count alongside relation rows returns both", async () => {
        const users = await client.user.findMany({
          orderBy: { id: "asc" },
          select: {
            id: true,
            posts: { select: { id: true }, orderBy: { id: "asc" } },
            _count: { select: { posts: true } },
          },
        });

        expect(users.map((u) => u.id)).toEqual(["u1", "u2", "u3", "u4"]);
        for (const u of users) {
          expect(u._count.posts).toBe(u.posts.length);
        }
        expect(users.map((u) => u._count.posts)).toEqual([3, 1, 0, 1]);
        expect(users[0]?.posts.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
      });

      // KNOWN BUG: Prisma supports `include: { _count: { select: { posts:
      // true } } }` alongside included relations, and the SQL select-builder
      // even handles `_count` in include — but the validation include schema
      // (src/validation/model/core/select.ts getIncludeSchema) has no _count
      // entry, so the call is rejected at runtime with
      // "ValidationError: Validation failed for findMany: Unknown key: _count"
      // (the include result types don't model _count either).
      // Expected: rows with posts arrays plus _count.posts; actual: throws.
      // biome-ignore lint/suspicious/noSkippedTests: deliberately pinned known bug, unskip when include._count validation lands
      test.skip("KNOWN BUG: _count inside include is rejected by validation", async () => {
        const users = await client.user.findMany({
          orderBy: { id: "asc" },
          include: {
            posts: true,
            _count: { select: { posts: true } },
          } as never,
        });

        expect(
          users.map((u) => (u as { _count: { posts: number } })._count.posts)
        ).toEqual([3, 1, 0, 1]);
      });
    });

    describe("relation orderBy", () => {
      test("orderBy posts._count desc yields exact order", async () => {
        const users = await client.user.findMany({
          orderBy: [{ posts: { _count: "desc" } }, { id: "asc" }],
          select: { id: true },
        });

        // u1 (3), then u2/u4 (1 each, id tiebreak), then u3 (0)
        expect(users.map((u) => u.id)).toEqual(["u1", "u2", "u4", "u3"]);
      });

      test("orderBy posts._count asc yields exact order", async () => {
        const users = await client.user.findMany({
          orderBy: [{ posts: { _count: "asc" } }, { id: "asc" }],
          select: { id: true },
        });

        expect(users.map((u) => u.id)).toEqual(["u3", "u2", "u4", "u1"]);
      });

      test("orderBy to-one relation scalar asc/desc", async () => {
        // Exclude the null-FK row: NULL placement in ORDER BY differs per
        // dialect, and this test pins the join ordering, not NULL sorting.
        const asc = await client.post.findMany({
          where: { authorId: { not: null } },
          orderBy: [{ author: { name: "asc" } }, { id: "asc" }],
          select: { id: true },
        });
        expect(asc.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4", "p6"]);

        const desc = await client.post.findMany({
          where: { authorId: { not: null } },
          orderBy: [{ author: { name: "desc" } }, { id: "asc" }],
          select: { id: true },
        });
        expect(desc.map((p) => p.id)).toEqual(["p6", "p4", "p1", "p2", "p3"]);
      });
    });

    describe("to-one relation filters", () => {
      test("isNot with real conditions includes null-FK rows", async () => {
        // Prisma parity: isNot compiles to NOT EXISTS, which is vacuously
        // true for rows whose FK is NULL — the orphan post matches.
        const notByAlice = await client.post.findMany({
          where: { author: { isNot: { name: "Alice" } } },
          orderBy: { id: "asc" },
          select: { id: true },
        });
        expect(notByAlice.map((p) => p.id)).toEqual(["p4", "p5", "p6"]);

        // Complement: is with the same condition excludes null-FK rows
        const byAlice = await client.post.findMany({
          where: { author: { is: { name: "Alice" } } },
          orderBy: { id: "asc" },
          select: { id: true },
        });
        expect(byAlice.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
      });
    });

    describe("to-many relation filters on the read path", () => {
      test("every matches vacuously for zero relations", async () => {
        const users = await client.user.findMany({
          where: { posts: { every: { published: true } } },
          orderBy: { id: "asc" },
          select: { id: true },
        });

        // u3 has no posts (vacuous truth), u4's single post is published;
        // u1 and u2 each own an unpublished post.
        expect(users.map((u) => u.id)).toEqual(["u3", "u4"]);
      });

      test("none excludes any user with a matching relation", async () => {
        const users = await client.user.findMany({
          where: { posts: { none: { published: true } } },
          orderBy: { id: "asc" },
          select: { id: true },
        });

        expect(users.map((u) => u.id)).toEqual(["u2", "u3"]);
      });

      test("none with empty condition means zero relations", async () => {
        const users = await client.user.findMany({
          where: { posts: { none: {} } },
          orderBy: { id: "asc" },
          select: { id: true },
        });

        expect(users.map((u) => u.id)).toEqual(["u3"]);
      });
    });
  });
}
