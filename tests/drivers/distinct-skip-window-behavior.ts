import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { s } from "@schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { windowUserPostSchema } from "../fixtures/user-post-schema";
import { seedWindowUserPosts } from "../fixtures/user-post-seed";

// Compound-unique model so compound-key cursor pagination runs on every
// dialect (mirrors the membership model in tests/client/operations.test.ts).
// Kept in its OWN schema/client rather than folded into `schema`: combining it
// with the relational user/post models pushes the inferred client arg types
// past TypeScript's instantiation-depth limit for the array-form orderBy
// queries below (TS2589).
const membershipSchema = {
  membership: s
    .model({
      orgId: s.string(),
      memberId: s.string(),
      email: s.string(),
      tenantId: s.string(),
      role: s.string(),
    })
    .id(["orgId", "memberId"])
    .unique(["email", "tenantId"])
    .map("window_memberships"),
};

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
 * Also covers multi-key orderBy, multi-column distinct, and findMany cursor
 * pagination (including compound-unique cursors) on every dialect.
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

        // u2 first (p3), then u1 by ascending views (p2: 50, p1: 100)
        expect(posts.map((p) => p.id)).toEqual(["p3", "p2", "p1"]);
      });

      test("later keys break ties left by earlier keys", async () => {
        const posts = await requireClient(client).post.findMany({
          orderBy: [{ published: "asc" }, { id: "desc" }],
        });

        // unpublished first (p2), then published tie broken by id desc
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
        // Duplicate the (u1, published) pair so distinct has work to do:
        // pairs are now (u1,true) x2, (u1,false), (u2,true)
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

        // views desc: p3 (u2,true), p4 (u1,true), p1 (u1,true — dup), p2 (u1,false)
        expect(posts.map((p) => p.id)).toEqual(["p3", "p4", "p2"]);
      });

      test("ascending order keeps the other duplicate", async () => {
        const posts = await requireClient(client).post.findMany({
          distinct: ["authorId", "published"],
          orderBy: { views: "asc" },
        });

        // views asc: p2 (u1,false), p1 (u1,true), p4 (u1,true — dup), p3 (u2,true)
        expect(posts.map((p) => p.id)).toEqual(["p2", "p1", "p3"]);
      });
    });

    describe("cursor pagination", () => {
      test("cursor includes cursor row by default", async () => {
        const users = await requireClient(client).user.findMany({
          cursor: { id: "u2" },
          orderBy: { id: "asc" },
          take: 2,
        });

        expect(users.map((u) => u.id)).toEqual(["u2", "u3"]);
      });

      test("skip 1 excludes cursor row", async () => {
        const users = await requireClient(client).user.findMany({
          cursor: { id: "u2" },
          orderBy: { id: "asc" },
          skip: 1,
          take: 1,
        });

        expect(users.map((u) => u.id)).toEqual(["u3"]);
      });

      test("cursor without orderBy uses deterministic default ordering", async () => {
        const users = await requireClient(client).user.findMany({
          cursor: { id: "u2" },
          take: 2,
        });

        expect(users.map((u) => u.id)).toEqual(["u2", "u3"]);
      });

      test("negative take pages backward in logical order", async () => {
        const users = await requireClient(client).user.findMany({
          cursor: { id: "u3" },
          orderBy: { id: "asc" },
          skip: 1,
          take: -2,
        });

        expect(users.map((u) => u.id)).toEqual(["u1", "u2"]);
      });

      test("negative take honors explicit orderBy without cursor", async () => {
        const users = await requireClient(client).user.findMany({
          orderBy: { name: "desc" },
          take: -2,
        });

        // name desc is Charlie, Bob, Alice — the last two in logical order
        expect(users.map((u) => u.name)).toEqual(["Bob", "Alice"]);
      });

      // KNOWN BUG: Prisma supports cursor pagination with an arbitrary
      // orderBy (prisma-engines builds row comparisons against the cursor
      // row's order values in cursor_condition.rs). VibORM fails closed:
      // find-pagination.ts throws "Cursor pagination orderBy must use
      // exactly the cursor field(s)." — expected ["p2", "p3"], actual:
      // QueryEngineError before any rows are returned.
      // biome-ignore lint/suspicious/noSkippedTests: deliberately pinned known bug, unskip when cursor supports non-cursor orderBy
      test.skip("KNOWN BUG: cursor combined with multi-key orderBy fails closed", async () => {
        const posts = await requireClient(client).post.findMany({
          cursor: { id: "p2" },
          orderBy: [{ authorId: "asc" }, { views: "desc" }],
          take: 2,
        });

        // full order: p1 (u1, 100), p2 (u1, 50), p3 (u2, 200)
        expect(posts.map((p) => p.id)).toEqual(["p2", "p3"]);
      });

      test("compound unique cursor paginates by compound fields", async () => {
        const c = createClient({
          schema: membershipSchema,
          driver: createDriver(),
        });
        await push(c, { force: true });
        try {
          await c.membership.createMany({
            data: [
              {
                orgId: "org-1",
                memberId: "member-1",
                email: "a@example.com",
                tenantId: "tenant-1",
                role: "owner",
              },
              {
                orgId: "org-1",
                memberId: "member-2",
                email: "b@example.com",
                tenantId: "tenant-1",
                role: "admin",
              },
              {
                orgId: "org-2",
                memberId: "member-1",
                email: "c@example.com",
                tenantId: "tenant-1",
                role: "viewer",
              },
            ],
          });

          const result = await c.membership.findMany({
            cursor: {
              email_tenantId: { email: "b@example.com", tenantId: "tenant-1" },
            },
            skip: 1,
            take: 1,
          });

          expect(result).toHaveLength(1);
          expect(result[0]).toMatchObject({
            orgId: "org-2",
            memberId: "member-1",
          });
        } finally {
          await c.$disconnect();
        }
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
