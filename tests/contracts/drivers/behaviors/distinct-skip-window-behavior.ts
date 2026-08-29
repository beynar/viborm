import { defineContract } from "@tests/contracts/contract";
import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { windowUserPostSchema } from "@tests/fixtures/user-post-schema";
import { seedWindowUserPosts } from "@tests/fixtures/user-post-seed";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

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

      test("negative take flips the order before distinct, as on findMany", async () => {
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

        // The window is reversed (views asc: p2 50, p1 100, p3 200) and only
        // THEN deduplicated, so u1's surviving row is p2 — not p1, which is
        // what "dedupe forward, take the last" would give. findFirst must
        // compose exactly as findMany does.
        expect(many.map((p) => p.id)).toEqual(["p2"]);
        expect(first?.id).toBe("p2");
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
