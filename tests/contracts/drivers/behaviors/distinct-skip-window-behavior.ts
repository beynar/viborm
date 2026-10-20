import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { defineContract } from "@tests/contracts/contract";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { windowUserPostSchema } from "@tests/fixtures/user-post-schema";
import { seedWindowUserPosts } from "@tests/fixtures/user-post-seed";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const schema = windowUserPostSchema;

type WindowClientConfig = VibORMConfig<typeof schema>;

type WindowClient = VibORMClient<WindowClientConfig>;

export interface DistinctSkipWindowBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

/**
 * Executes real SQL for distinct+orderBy and skip-without-take — both used to
 * assemble invalid SQL (DISTINCT ON/ORDER BY mismatch, outer ORDER BY on inner
 * aliases, OFFSET without LIMIT) that text-only assertions cannot catch.
 * Also covers multi-key orderBy and multi-column distinct on every dialect.
 *
 * Seed data: posts p1 (u1, published, 100 views), p2 (u1, unpublished, 50),
 * p3 (u2, published, 200).
 */
export function runDistinctSkipWindowBehavior({
  driverName,
  createDriver,
}: DistinctSkipWindowBehaviorOptions) {
  describe(`${driverName} distinct/skip windows`, () => {
    let client: WindowClient | undefined;

    beforeEach(async () => {
      client = createClient({
        schema,
        driver: createDriver(),
      });
      await syncLiveSchema(client);
      await seedWindowUserPosts(client);
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    test("distinct with orderBy keeps first row per group in user order", async () => {
      const posts = await requireClient(client).post.findMany({
        distinct: ["published"],
        orderBy: { views: "desc" },
      });

      expect(posts.map((p) => p.id)).toEqual(["p3", "p2"]);
    });

    test("distinct with ascending orderBy", async () => {
      const posts = await requireClient(client).post.findMany({
        distinct: ["authorId"],
        orderBy: { views: "asc" },
      });

      expect(posts.map((p) => p.id)).toEqual(["p2", "p3"]);
    });

    test("distinct ordered by the distinct column descending", async () => {
      const posts = await requireClient(client).post.findMany({
        distinct: ["published"],
        orderBy: { published: "desc" },
      });

      expect(posts.map((p) => p.published)).toEqual([true, false]);
    });

    test("distinct with orderBy and skip without take", async () => {
      const posts = await requireClient(client).post.findMany({
        distinct: ["authorId"],
        orderBy: { views: "desc" },
        skip: 1,
      });

      expect(posts.map((p) => p.id)).toEqual(["p1"]);
    });

    test("top-level skip without take", async () => {
      const users = await requireClient(client).user.findMany({
        orderBy: { id: "asc" },
        skip: 1,
      });

      expect(users.map((u) => u.id)).toEqual(["u2", "u3"]);
    });

    test("nested include skip without take", async () => {
      const users = await requireClient(client).user.findMany({
        where: { id: "u1" },
        include: {
          posts: { orderBy: { id: "asc" }, skip: 1 },
        },
      });

      expect(users).toHaveLength(1);
      expect(users[0]?.posts.map((p) => p.id)).toEqual(["p2"]);
    });

    describe("multi-key orderBy", () => {
      test("array form orders by each key in turn", async () => {
        const posts = await requireClient(client).post.findMany({
          orderBy: [{ authorId: "desc" }, { views: "asc" }, { id: "asc" }],
        });

        expect(posts.map((p) => p.id)).toEqual(["p3", "p2", "p1"]);
      });

      test("later keys break ties left by earlier keys", async () => {
        const posts = await requireClient(client).post.findMany({
          orderBy: [{ published: "asc" }, { id: "desc" }],
        });

        expect(posts.map((p) => p.id)).toEqual(["p2", "p3", "p1"]);
      });

      test("multi-key orderBy with take windows the ordered rows", async () => {
        const posts = await requireClient(client).post.findMany({
          orderBy: [{ authorId: "desc" }, { views: "asc" }, { id: "asc" }],
          take: 2,
        });

        expect(posts.map((p) => p.id)).toEqual(["p3", "p2"]);
      });

      test("multi-key orderBy with take and skip", async () => {
        const posts = await requireClient(client).post.findMany({
          orderBy: [{ authorId: "desc" }, { views: "asc" }, { id: "asc" }],
          skip: 1,
          take: 1,
        });

        expect(posts.map((p) => p.id)).toEqual(["p2"]);
      });
    });

    // Prisma accepts `distinct` on findFirst and accepts a bare scalar name in
    // place of the array. findFirst compiles through the same
    // findMany-with-limit path (ReadOperation), so the contract asserted here is
    // exactly that: findFirst(args) === findMany(args)[0] ?? null, for every
    // distinct/take/skip combination — including the signed-unit-limit order
    // flip that a negative take triggers.
    describe("findFirst distinct + string shorthand", () => {
      test("findFirst distinct returns the first distinct row", async () => {
        const c = requireClient(client);
        const first = await c.post.findFirst({
          distinct: "authorId",
          orderBy: { views: "desc" },
        });
        const many = await c.post.findMany({
          distinct: ["authorId"],
          orderBy: { views: "desc" },
        });

        // p3 (u2, 200) then p1 (u1, 100) — p2 is u1's duplicate
        expect(many.map((p) => p.id)).toEqual(["p3", "p1"]);
        expect(first?.id).toBe("p3");
        expect(first).toEqual(many[0]);
      });

      test("string and array spellings agree on findFirst", async () => {
        const c = requireClient(client);
        const fromString = await c.post.findFirst({
          distinct: "published",
          orderBy: { views: "asc" },
        });
        const fromArray = await c.post.findFirst({
          distinct: ["published"],
          orderBy: { views: "asc" },
        });

        expect(fromString).toEqual(fromArray);
        expect(fromString?.id).toBe("p2");
      });

      test("string and array spellings agree on findMany", async () => {
        const c = requireClient(client);
        const fromString = await c.post.findMany({
          distinct: "authorId",
          orderBy: { views: "desc" },
        });
        const fromArray = await c.post.findMany({
          distinct: ["authorId"],
          orderBy: { views: "desc" },
        });

        expect(fromString).toEqual(fromArray);
        expect(fromString.map((p) => p.id)).toEqual(["p3", "p1"]);
      });

      test("negative take reverses the page while preserving each distinct representative", async () => {
        const c = requireClient(client);
        const first = await c.post.findFirst({
          distinct: "authorId",
          orderBy: { views: "desc" },
          take: -1,
        });
        const many = await c.post.findMany({
          distinct: ["authorId"],
          orderBy: { views: "desc" },
          take: -1,
        });

        // The forward representative of u1 remains p1 (100 views). Reversing
        // the page moves that same representative ahead of u2; it cannot adopt
        // p2 merely because direction changed. Both public methods agree.
        expect(many.map((p) => p.id)).toEqual(["p1"]);
        expect(first?.id).toBe("p1");
        expect(first).toEqual(many[0]);
      });

      test("positive take keeps the forward window", async () => {
        const first = await requireClient(client).post.findFirst({
          distinct: "authorId",
          orderBy: { views: "desc" },
          take: 1,
        });

        expect(first?.id).toBe("p3");
      });

      test("take 0 is an empty window even with distinct", async () => {
        const first = await requireClient(client).post.findFirst({
          distinct: "authorId",
          orderBy: { views: "desc" },
          take: 0,
        });

        expect(first).toBeNull();
      });

      test("skip pages within the distinct set", async () => {
        const c = requireClient(client);
        const first = await c.post.findFirst({
          distinct: "authorId",
          orderBy: { views: "desc" },
          skip: 1,
        });
        const many = await c.post.findMany({
          distinct: ["authorId"],
          orderBy: { views: "desc" },
          skip: 1,
        });

        expect(first?.id).toBe("p1");
        expect(first).toEqual(many[0]);
      });

      test("distinct composes with where on findFirst", async () => {
        const first = await requireClient(client).post.findFirst({
          where: { published: true },
          distinct: "authorId",
          orderBy: { views: "asc" },
        });

        // published rows are p1 (u1, 100) and p3 (u2, 200); asc keeps p1 first
        expect(first?.id).toBe("p1");
      });

      test("distinct on findFirst with no matching rows returns null", async () => {
        const first = await requireClient(client).post.findFirst({
          where: { views: { gt: 10_000 } },
          distinct: "authorId",
        });

        expect(first).toBeNull();
      });
    });

    describe("multi-column distinct", () => {
      beforeEach(async () => {
        await requireClient(client).post.create({
          data: {
            id: "p4",
            title: "Post 4",
            content: "Content 4",
            published: true,
            views: 150,
            authorId: "u1",
          },
        });
      });

      test("keeps the first row per column combination in user order", async () => {
        const posts = await requireClient(client).post.findMany({
          distinct: ["authorId", "published"],
          orderBy: { views: "desc" },
        });

        expect(posts.map((p) => p.id)).toEqual(["p3", "p4", "p2"]);
      });

      test("ascending order keeps the other duplicate", async () => {
        const posts = await requireClient(client).post.findMany({
          distinct: ["authorId", "published"],
          orderBy: { views: "asc" },
        });

        expect(posts.map((p) => p.id)).toEqual(["p2", "p1", "p3"]);
      });
    });

    // One window picks each group's representative; the page is ordered by
    // the order's own terms projected beside it (`_ordN`). The oracle is the
    // definition: order every row (the caller's terms, then the id; a
    // nullable term's NULLs last ascending and first descending unless
    // placed), keep the first row of each distinct tuple (NULLs equal), then
    // window the representatives — a negative take keeps the last ones.
    describe("distinct answers as its oracle over NULLs and duplicates", () => {
      interface Term {
        key: "views" | "content" | "authorName" | "published" | "id";
        dir: "asc" | "desc";
        nulls?: "first" | "last";
      }
      type Row = Record<Term["key"] | "authorId", unknown>;
      const names: Record<string, string | null> = {
        u1: "Alice",
        u2: "Bob",
        u3: "Charlie",
        u4: null,
        u5: "Dora",
      };
      const views = [7, 3, 7, 3, 9, 1, 7, 9];
      const rows: Row[] = [];

      beforeEach(async () => {
        const c = requireClient(client);
        await c.user.createMany({
          data: [
            { id: "u4", email: "u4@test.com", name: null, age: null },
            { id: "u5", email: "u5@test.com", name: "Dora", age: 40 },
          ],
        });
        const data = Array.from({ length: 24 }, (_, index) => ({
          id: `q${String(index).padStart(2, "0")}`,
          title: `Q ${index}`,
          content: index % 3 === 0 ? null : `c${index % 4}`,
          published: index % 2 === 0,
          views: views[index % views.length]!,
          authorId: `u${1 + (index % 5)}`,
        }));
        await c.post.createMany({ data });
        rows.length = 0;
        for (const post of await c.post.findMany({})) {
          rows.push({ ...post, authorName: names[post.authorId] ?? null });
        }
      });

      const compare = (left: Row, right: Row, terms: readonly Term[]) => {
        for (const { key, dir, nulls } of [
          ...terms,
          { key: "id", dir: "asc" } as const,
        ]) {
          const a = left[key];
          const b = right[key];
          if (a === b) continue;
          const placed = nulls ?? (dir === "asc" ? "last" : "first");
          if (a === null) return placed === "first" ? -1 : 1;
          if (b === null) return placed === "first" ? 1 : -1;
          const order = (a as never) < (b as never) ? -1 : 1;
          return dir === "asc" ? order : -order;
        }
        return 0;
      };
      const oracle = (
        source: readonly Row[],
        distinct: readonly (Term["key"] | "authorId")[],
        terms: readonly Term[],
        take?: number,
        skip = 0
      ): unknown[] => {
        const seen = new Set<string>();
        const kept = [...source]
          .sort((left, right) => compare(left, right, terms))
          .filter((row) => {
            const tuple = JSON.stringify(distinct.map((key) => row[key]));
            if (seen.has(tuple)) return false;
            seen.add(tuple);
            return true;
          })
          .map((row) => row.id);
        if (take !== undefined && take < 0)
          return kept
            .reverse()
            .slice(skip, skip - take)
            .reverse();
        return kept.slice(skip, take === undefined ? undefined : skip + take);
      };
      const orderBy = (terms: readonly Term[]) =>
        terms.map(({ key, dir, nulls }) => {
          const sort = nulls ? { sort: dir, nulls } : dir;
          return key === "authorName"
            ? { author: { name: sort } }
            : { [key]: sort };
        });

      const cases: [
        string,
        ("content" | "published" | "views" | "authorId")[],
        Term[],
        number | undefined,
        number | undefined,
      ][] = [
        [
          "a nullable distinct field",
          ["content"],
          [{ key: "views", dir: "desc" }],
          undefined,
          undefined,
        ],
        [
          "several fields, a page",
          ["authorId", "published"],
          [{ key: "views", dir: "asc" }],
          4,
          1,
        ],
        [
          "a negative take",
          ["content"],
          [{ key: "views", dir: "desc" }],
          -3,
          undefined,
        ],
        [
          "a negative take and skip over two fields",
          ["published", "views"],
          [{ key: "content", dir: "asc", nulls: "first" }],
          -2,
          1,
        ],
        [
          "a nullable order term",
          ["views"],
          [{ key: "content", dir: "desc" }],
          undefined,
          undefined,
        ],
        [
          "a relation order",
          ["published"],
          [{ key: "authorName", dir: "asc" }],
          undefined,
          undefined,
        ],
        [
          "a relation order, placed and backward",
          ["content"],
          [
            { key: "authorName", dir: "desc", nulls: "last" },
            { key: "views", dir: "asc" },
          ],
          -4,
          undefined,
        ],
      ];

      for (const [name, distinct, terms, take, skip] of cases) {
        test(name, async () => {
          const found = await requireClient(client).post.findMany({
            distinct,
            orderBy: orderBy(terms),
            ...(take === undefined ? {} : { take }),
            ...(skip === undefined ? {} : { skip }),
            select: { id: true },
          } as never);
          expect(found.map((post) => post.id)).toEqual(
            oracle(rows, distinct, terms, take, skip)
          );
        });
      }

      test("a nested page", async () => {
        const users = await requireClient(client).user.findMany({
          orderBy: { id: "asc" },
          select: {
            id: true,
            posts: {
              distinct: ["published"],
              orderBy: { content: "asc" },
              take: -1,
              select: { id: true },
            },
          },
        });
        expect(users.map((user) => user.posts.map((post) => post.id))).toEqual(
          users.map((user) =>
            oracle(
              rows.filter((row) => row.authorId === user.id),
              ["published"],
              [{ key: "content", dir: "asc" }],
              -1
            )
          )
        );
      });
    });
  });
}

function requireClient(client: WindowClient | undefined): WindowClient {
  if (!client) {
    throw new Error("Client not initialized");
  }
  return client;
}

export const distinctSkipWindowContract = defineContract({
  id: "drivers.distinct-skip-window",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runDistinctSkipWindowBehavior,
});
