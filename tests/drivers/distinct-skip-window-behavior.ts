import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { windowUserPostSchema } from "../fixtures/user-post-schema";
import { seedWindowUserPosts } from "../fixtures/user-post-seed";

const schema = windowUserPostSchema;

type WindowClientConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};

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
      await push(client, { force: true });
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
