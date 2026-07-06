import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { windowUserPostSchema } from "../fixtures/user-post-schema";

const schema = windowUserPostSchema;

type ParityClientConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};

type ParityClient = VibORMClient<ParityClientConfig>;

export interface PrismaParityBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
  /**
   * EXPECTED DIVERGENCE: MySQL's default collations (e.g.
   * utf8mb4_0900_ai_ci) make default-mode `equals`/`not`/`in`/`notIn`
   * case-insensitive, where PG/SQLite compare case-sensitively. Setting this
   * pins that behavior instead of skipping the suite, so a change in either
   * direction fails loudly. See docs/content/docs/client/filtering/string.mdx.
   */
  caseInsensitiveDefaultEquals?: boolean;
}

/**
 * Execution-backed Prisma-parity checks:
 * - mode: "insensitive" applies to equals/not/in/notIn (not just contains)
 * - empty select throws instead of silently selecting all scalars
 * - groupBy orderBy is restricted to `by` fields and supports aggregates
 * - groupBy having handles in: [] and equals/not null correctly
 */
export function runPrismaParityBehavior({
  driverName,
  createDriver,
  caseInsensitiveDefaultEquals = false,
}: PrismaParityBehaviorOptions) {
  describe(`${driverName} Prisma parity`, () => {
    let client: ParityClient | undefined;

    beforeEach(async () => {
      client = createClient({
        schema,
        driver: createDriver(),
      });
      await push(client, { force: true });
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    describe("insensitive mode on equality filters", () => {
      beforeEach(async () => {
        await requireClient(client).user.createMany({
          data: [
            { id: "alice", name: "Alice", email: "a@example.com" },
            { id: "bob", name: "Bob", email: "b@example.com" },
            { id: "percent", name: "100% Organic", email: "p@example.com" },
            { id: "decoy", name: "100x Organic", email: "d@example.com" },
          ],
        });
      });

      async function findIds(where: Record<string, unknown>) {
        const users = await requireClient(client).user.findMany({ where });
        return users.map((u) => u.id).sort();
      }

      test("equals matches case-insensitively", async () => {
        expect(
          await findIds({ name: { equals: "ALICE", mode: "insensitive" } })
        ).toEqual(["alice"]);
      });

      if (caseInsensitiveDefaultEquals) {
        test("equals is case-insensitive without mode (pinned dialect divergence)", async () => {
          expect(await findIds({ name: { equals: "ALICE" } })).toEqual([
            "alice",
          ]);
        });
      } else {
        test("equals stays case-sensitive without mode", async () => {
          expect(await findIds({ name: { equals: "ALICE" } })).toEqual([]);
        });
      }

      test("insensitive equals does not treat % as a wildcard", async () => {
        // Unescaped, '100% ORGANIC' would also match '100x Organic'
        expect(
          await findIds({
            name: { equals: "100% ORGANIC", mode: "insensitive" },
          })
        ).toEqual(["percent"]);
      });

      test("not excludes case-insensitively", async () => {
        expect(
          await findIds({ name: { not: "ALICE", mode: "insensitive" } })
        ).toEqual(["bob", "decoy", "percent"]);
      });

      test("in matches case-insensitively", async () => {
        expect(
          await findIds({ name: { in: ["ALICE", "bOb"], mode: "insensitive" } })
        ).toEqual(["alice", "bob"]);
      });

      test("insensitive in does not treat % as a wildcard", async () => {
        expect(
          await findIds({ name: { in: ["100% ORGANIC"], mode: "insensitive" } })
        ).toEqual(["percent"]);
      });

      test("insensitive in with empty list matches nothing", async () => {
        expect(
          await findIds({ name: { in: [], mode: "insensitive" } })
        ).toEqual([]);
      });

      test("notIn excludes case-insensitively", async () => {
        expect(
          await findIds({
            name: { notIn: ["ALICE", "BOB"], mode: "insensitive" },
          })
        ).toEqual(["decoy", "percent"]);
      });
    });

    describe("empty select rejection", () => {
      test("empty select object throws", async () => {
        await expect(
          requireClient(client).user.findMany({ select: {} })
        ).rejects.toThrow(/needs at least one truthy value/);
      });

      test("all-false select throws", async () => {
        await expect(
          requireClient(client).user.findMany({ select: { id: false } })
        ).rejects.toThrow(/needs at least one truthy value/);
      });
    });

    describe("groupBy ordering and having", () => {
      beforeEach(async () => {
        const c = requireClient(client);
        await c.user.createMany({
          data: [
            { id: "u1", name: "Alice", email: "alice@test.com", age: 25 },
            { id: "u2", name: "Bob", email: "bob@test.com", age: 30 },
            { id: "u3", name: "Charlie", email: "charlie@test.com", age: null },
          ],
        });
        await c.post.createMany({
          data: [
            {
              id: "p1",
              title: "Post 1",
              published: true,
              views: 100,
              authorId: "u1",
            },
            {
              id: "p2",
              title: "Post 2",
              published: false,
              views: 50,
              authorId: "u1",
            },
            {
              id: "p3",
              title: "Post 3",
              published: true,
              views: 200,
              authorId: "u2",
            },
          ],
        });
      });

      test("orderBy a non-grouped column is rejected", async () => {
        await expect(
          requireClient(client).post.groupBy({
            by: ["authorId"],
            orderBy: { views: "asc" },
          })
        ).rejects.toThrow(/must be included in 'by'/);
      });

      test("orderBy a grouped column still works", async () => {
        const groups = await requireClient(client).post.groupBy({
          by: ["authorId"],
          orderBy: { authorId: "desc" },
        });
        expect(groups.map((g) => g.authorId)).toEqual(["u2", "u1"]);
      });

      test("orderBy _count on a field", async () => {
        const groups = await requireClient(client).post.groupBy({
          by: ["authorId"],
          _count: true,
          orderBy: { _count: { id: "desc" } },
        });
        expect(groups.map((g) => g.authorId)).toEqual(["u1", "u2"]);
        expect(groups.map((g) => g._count)).toEqual([2, 1]);
      });

      test("orderBy _count _all", async () => {
        const groups = await requireClient(client).post.groupBy({
          by: ["authorId"],
          orderBy: { _count: { _all: "asc" } },
        });
        expect(groups.map((g) => g.authorId)).toEqual(["u2", "u1"]);
      });

      test("orderBy _sum", async () => {
        const groups = await requireClient(client).post.groupBy({
          by: ["authorId"],
          _sum: { views: true },
          orderBy: { _sum: { views: "desc" } },
        });
        // u2 has 200 views total, u1 has 150
        expect(groups.map((g) => g.authorId)).toEqual(["u2", "u1"]);
      });

      test("having aggregate in filter", async () => {
        const groups = await requireClient(client).post.groupBy({
          by: ["authorId"],
          having: { id: { _count: { in: [2] } } },
        });
        expect(groups.map((g) => g.authorId)).toEqual(["u1"]);
      });

      test("having aggregate in with empty list matches nothing", async () => {
        const groups = await requireClient(client).post.groupBy({
          by: ["authorId"],
          having: { id: { _count: { in: [] } } },
        });
        expect(groups).toEqual([]);
      });

      test("having aggregate notIn with empty list matches everything", async () => {
        const groups = await requireClient(client).post.groupBy({
          by: ["authorId"],
          having: { id: { _count: { notIn: [] } } },
          orderBy: { authorId: "asc" },
        });
        expect(groups.map((g) => g.authorId)).toEqual(["u1", "u2"]);
      });

      test("having aggregate equals null uses IS NULL", async () => {
        const groups = await requireClient(client).user.groupBy({
          by: ["id"],
          having: { age: { _min: { equals: null } } },
        });
        expect(groups.map((g) => g.id)).toEqual(["u3"]);
      });

      test("having aggregate not null uses IS NOT NULL", async () => {
        const groups = await requireClient(client).user.groupBy({
          by: ["id"],
          having: { age: { _min: { not: null } } },
          orderBy: { id: "asc" },
        });
        expect(groups.map((g) => g.id)).toEqual(["u1", "u2"]);
      });
    });
  });
}

function requireClient(client: ParityClient | undefined): ParityClient {
  if (!client) {
    throw new Error("Client not initialized");
  }
  return client;
}
