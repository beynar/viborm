import { defineContract } from "@tests/contracts/contract";
import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { s } from "@schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { windowUserPostSchema } from "@tests/fixtures/user-post-schema";

// Enum-carrying model for in/notIn parity checks (the shared user/post
// fixture has no enum column).
const roleAccount = s
  .model({
    id: s.string().id(),
    role: s.enum(["admin", "member", "guest"]).nullable(),
  })
  .map("window_role_accounts");

const schema = { ...windowUserPostSchema, roleAccount };

/** Refusal messages these checks match on, hoisted so no test rebuilds them. */
const EMPTY_SELECT_REFUSAL = /needs at least one truthy value/;
const UNGROUPED_COLUMN_REFUSAL = /must be included in 'by'/;

type ParityClientConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};

type ParityClient = VibORMClient<ParityClientConfig>;

export interface PrismaParityBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

/**
 * Execution-backed Prisma-parity checks:
 * - mode: "insensitive" applies to equals/not/in/notIn (not just contains)
 * - mode: "insensitive" applies to startsWith/endsWith with escaping intact
 * - NOT/OR combinators follow Prisma's SQL null semantics
 * - enum in/notIn behave like their string counterparts
 * - empty select throws instead of silently selecting all scalars
 * - groupBy orderBy is restricted to `by` fields and supports aggregates
 * - groupBy having handles in: [] and equals/not null correctly
 * - groupBy supports where, take/skip with orderBy, and multi-field `by`
 */
export function runPrismaParityBehavior({
  driverName,
  createDriver,
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
            { id: "accent", name: "Éclair", email: "e@example.com" },
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

      test("insensitive equality and set filters fold ASCII only", async () => {
        expect(
          await findIds({ name: { equals: "ÉCLAIR", mode: "insensitive" } })
        ).toEqual(["accent"]);
        expect(
          await findIds({ name: { equals: "éCLAIR", mode: "insensitive" } })
        ).toEqual([]);
        expect(
          await findIds({ name: { in: ["ÉCLAIR"], mode: "insensitive" } })
        ).toEqual(["accent"]);
        expect(
          await findIds({ name: { not: "ÉCLAIR", mode: "insensitive" } })
        ).toEqual(["alice", "bob", "decoy", "percent"]);
        expect(
          await findIds({ name: { notIn: ["ÉCLAIR"], mode: "insensitive" } })
        ).toEqual(["alice", "bob", "decoy", "percent"]);
      });

      test("equals stays case-sensitive without mode", async () => {
        expect(await findIds({ name: { equals: "ALICE" } })).toEqual([]);
      });

      test("not stays case-sensitive without mode", async () => {
        expect(await findIds({ name: { not: "ALICE" } })).toEqual([
          "accent",
          "alice",
          "bob",
          "decoy",
          "percent",
        ]);
      });

      test("in stays case-sensitive without mode", async () => {
        expect(await findIds({ name: { in: ["ALICE", "Bob"] } })).toEqual([
          "bob",
        ]);
      });

      test("notIn stays case-sensitive without mode", async () => {
        expect(await findIds({ name: { notIn: ["ALICE", "Bob"] } })).toEqual([
          "accent",
          "alice",
          "decoy",
          "percent",
        ]);
      });

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
        ).toEqual(["accent", "bob", "decoy", "percent"]);
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
        ).toEqual(["accent", "decoy", "percent"]);
      });
    });

    describe("string substring filters", () => {
      beforeEach(async () => {
        await requireClient(client).user.createMany({
          data: [
            { id: "alice", name: "Alice", email: "a@example.com" },
            { id: "bob", name: "Bob", email: "b@example.com" },
            { id: "percent", name: "100% Organic", email: "p@example.com" },
            { id: "decoy", name: "100x Organic", email: "d@example.com" },
            { id: "underscore", name: "under_score", email: "u@example.com" },
            {
              id: "underscore-decoy",
              name: "underXscore",
              email: "ux@example.com",
            },
            { id: "backslash", name: "path\\leaf", email: "s@example.com" },
            { id: "accent", name: "Éclair", email: "e@example.com" },
          ],
        });
      });

      async function findIds(where: Record<string, unknown>) {
        const users = await requireClient(client).user.findMany({ where });
        return users.map((u) => u.id).sort();
      }

      test("contains stays case-sensitive without mode", async () => {
        expect(await findIds({ name: { contains: "LI" } })).toEqual([]);
        expect(await findIds({ name: { contains: "li" } })).toEqual(["alice"]);
      });

      test("startsWith stays case-sensitive without mode", async () => {
        expect(await findIds({ name: { startsWith: "aL" } })).toEqual([]);
        expect(await findIds({ name: { startsWith: "Al" } })).toEqual([
          "alice",
        ]);
      });

      test("endsWith stays case-sensitive without mode", async () => {
        expect(await findIds({ name: { endsWith: "ICE" } })).toEqual([]);
        expect(await findIds({ name: { endsWith: "ice" } })).toEqual(["alice"]);
      });

      test("default substring filters treat wildcard characters literally", async () => {
        expect(await findIds({ name: { contains: "%" } })).toEqual(["percent"]);
        expect(await findIds({ name: { startsWith: "100%" } })).toEqual([
          "percent",
        ]);
        expect(await findIds({ name: { endsWith: "% Organic" } })).toEqual([
          "percent",
        ]);
        expect(await findIds({ name: { contains: "_" } })).toEqual([
          "underscore",
        ]);
        expect(await findIds({ name: { contains: "\\" } })).toEqual([
          "backslash",
        ]);
      });

      test("default substring filters handle empty and non-ASCII values exactly", async () => {
        expect(await findIds({ name: { contains: "Éc" } })).toEqual(["accent"]);
        expect(await findIds({ name: { contains: "éc" } })).toEqual([]);
        expect(await findIds({ name: { startsWith: "É" } })).toEqual([
          "accent",
        ]);
        expect(await findIds({ name: { endsWith: "air" } })).toEqual([
          "accent",
        ]);
        const allIds = [
          "accent",
          "alice",
          "backslash",
          "bob",
          "decoy",
          "percent",
          "underscore",
          "underscore-decoy",
        ];
        expect(await findIds({ name: { contains: "" } })).toEqual(allIds);
        expect(await findIds({ name: { startsWith: "" } })).toEqual(allIds);
        expect(await findIds({ name: { endsWith: "" } })).toEqual(allIds);
      });

      test("startsWith matches case-insensitively", async () => {
        expect(
          await findIds({ name: { startsWith: "aL", mode: "insensitive" } })
        ).toEqual(["alice"]);
      });

      test("endsWith matches case-insensitively", async () => {
        expect(
          await findIds({ name: { endsWith: "ICE", mode: "insensitive" } })
        ).toEqual(["alice"]);
      });

      test("insensitive endsWith matches every case variant", async () => {
        expect(
          await findIds({ name: { endsWith: "organic", mode: "insensitive" } })
        ).toEqual(["decoy", "percent"]);
      });

      test("insensitive substring filters fold ASCII only", async () => {
        expect(
          await findIds({ name: { contains: "ÉCL", mode: "insensitive" } })
        ).toEqual(["accent"]);
        expect(
          await findIds({ name: { startsWith: "ÉCL", mode: "insensitive" } })
        ).toEqual(["accent"]);
        expect(
          await findIds({ name: { endsWith: "LAIR", mode: "insensitive" } })
        ).toEqual(["accent"]);
        expect(
          await findIds({ name: { contains: "écl", mode: "insensitive" } })
        ).toEqual([]);
      });

      test("insensitive startsWith does not treat % as a wildcard", async () => {
        // Unescaped, '100%' would also match '100x Organic'
        expect(
          await findIds({ name: { startsWith: "100%", mode: "insensitive" } })
        ).toEqual(["percent"]);
      });

      test("insensitive endsWith does not treat % as a wildcard", async () => {
        // Unescaped, '%% ORGANIC' would also match '100x Organic'
        expect(
          await findIds({
            name: { endsWith: "% ORGANIC", mode: "insensitive" },
          })
        ).toEqual(["percent"]);
      });
    });

    describe("NOT and OR combinators", () => {
      beforeEach(async () => {
        await requireClient(client).user.createMany({
          data: [
            { id: "n1", name: "Alice", email: "n1@test.com", age: 25 },
            { id: "n2", name: "Bob", email: "n2@test.com", age: 30 },
            { id: "n3", name: null, email: "n3@test.com", age: null },
            { id: "n4", name: "Dave", email: "n4@test.com", age: 40 },
          ],
        });
      });

      async function findIds(where: Record<string, unknown>) {
        const users = await requireClient(client).user.findMany({ where });
        return users.map((u) => u.id).sort();
      }

      test("top-level NOT excludes matching rows", async () => {
        expect(await findIds({ NOT: { name: { contains: "li" } } })).toEqual([
          "n2",
          "n4",
        ]);
      });

      test("NOT {contains} does not match NULL rows (Prisma parity)", async () => {
        // 'zzz' matches nothing, yet the NULL-name row stays excluded:
        // NOT (name LIKE '%zzz%') is NULL, not TRUE, for NULL names.
        expect(await findIds({ NOT: { name: { contains: "zzz" } } })).toEqual([
          "n1",
          "n2",
          "n4",
        ]);
      });

      test("NOT with equality also skips NULL rows", async () => {
        expect(await findIds({ NOT: { name: "Alice" } })).toEqual(["n2", "n4"]);
      });

      test("NOT combines with AND", async () => {
        expect(
          await findIds({
            AND: [{ age: { gte: 25 } }],
            NOT: { name: { contains: "ob" } },
          })
        ).toEqual(["n1", "n4"]);
      });

      test("NOT combines with OR", async () => {
        expect(
          await findIds({
            OR: [{ age: { gte: 30 } }, { name: { startsWith: "A" } }],
            NOT: { name: { equals: "Dave" } },
          })
        ).toEqual(["n1", "n2"]);
      });

      test("nested NOT double-negates but still skips NULL rows", async () => {
        expect(await findIds({ NOT: { NOT: { name: "Alice" } } })).toEqual([
          "n1",
        ]);
      });

      // Prisma negates each NOT-array item individually and ANDs the
      // negations (prisma-engines sql-query-builder filter/visitor.rs:
      // Filter::Not(filters) -> AND of per-filter .not()), i.e.
      // NOT c1 AND NOT c2 — "all conditions must return false", not
      // NOT (c1 AND c2). buildLogicalNot negates per item and ANDs them.
      test("NOT array negates each condition and ANDs them (Prisma parity)", async () => {
        // Prisma: NOT [c1, c2] means "all conditions must return false",
        // i.e. NOT c1 AND NOT c2 — not NOT (c1 AND c2).
        expect(
          await findIds({
            NOT: [{ name: { contains: "li" } }, { age: { gte: 40 } }],
          })
        ).toEqual(["n2"]);
      });

      test("OR of two scalar predicates", async () => {
        expect(
          await findIds({ OR: [{ name: "Alice" }, { age: { gte: 40 } }] })
        ).toEqual(["n1", "n4"]);
      });

      test("OR with a null check matches NULL rows via IS NULL", async () => {
        expect(
          await findIds({ OR: [{ name: null }, { age: { gte: 40 } }] })
        ).toEqual(["n3", "n4"]);
      });
    });

    describe("enum in/notIn filters", () => {
      beforeEach(async () => {
        await requireClient(client).roleAccount.createMany({
          data: [
            { id: "e1", role: "admin" },
            { id: "e2", role: "member" },
            { id: "e3", role: null },
            { id: "e4", role: "guest" },
          ],
        });
      });

      async function findIds(where: Record<string, unknown>) {
        const accounts = await requireClient(client).roleAccount.findMany({
          where,
        });
        return accounts.map((a) => a.id).sort();
      }

      test("enum equals matches a single value", async () => {
        expect(await findIds({ role: "admin" })).toEqual(["e1"]);
      });

      test("enum in matches listed values and skips NULL rows", async () => {
        expect(await findIds({ role: { in: ["admin", "guest"] } })).toEqual([
          "e1",
          "e4",
        ]);
      });

      test("enum in with empty list matches nothing", async () => {
        expect(await findIds({ role: { in: [] } })).toEqual([]);
      });

      test("enum notIn excludes listed values and NULL rows", async () => {
        expect(await findIds({ role: { notIn: ["admin"] } })).toEqual([
          "e2",
          "e4",
        ]);
      });

      test("enum notIn with empty list matches every row", async () => {
        expect(await findIds({ role: { notIn: [] } })).toEqual([
          "e1",
          "e2",
          "e3",
          "e4",
        ]);
      });
    });

    describe("empty select rejection", () => {
      test("empty select object throws", async () => {
        await expect(
          requireClient(client).user.findMany({ select: {} })
        ).rejects.toThrow(EMPTY_SELECT_REFUSAL);
      });

      test("all-false select throws", async () => {
        await expect(
          requireClient(client).user.findMany({ select: { id: false } })
        ).rejects.toThrow(EMPTY_SELECT_REFUSAL);
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
        ).rejects.toThrow(UNGROUPED_COLUMN_REFUSAL);
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

      test("where filters rows before grouping", async () => {
        const groups = await requireClient(client).post.groupBy({
          by: ["authorId"],
          where: { published: true },
          _sum: { views: true },
          orderBy: { authorId: "asc" },
        });
        // p2 (unpublished, 50 views) is filtered out before grouping
        expect(groups).toEqual([
          { authorId: "u1", _sum: { views: 100 } },
          { authorId: "u2", _sum: { views: 200 } },
        ]);
      });

      test("take with orderBy limits groups", async () => {
        const groups = await requireClient(client).post.groupBy({
          by: ["authorId"],
          orderBy: { authorId: "asc" },
          take: 1,
        });
        expect(groups.map((g) => g.authorId)).toEqual(["u1"]);
      });

      test("take and skip with orderBy window the groups", async () => {
        const groups = await requireClient(client).post.groupBy({
          by: ["authorId"],
          orderBy: { authorId: "asc" },
          take: 1,
          skip: 1,
        });
        expect(groups.map((g) => g.authorId)).toEqual(["u2"]);
      });

      test("take and skip with aggregate orderBy window the groups", async () => {
        const groups = await requireClient(client).post.groupBy({
          by: ["authorId"],
          _sum: { views: true },
          orderBy: { _sum: { views: "desc" } },
          take: 1,
          skip: 1,
        });
        // Order by summed views: u2 (200) then u1 (150) — skip u2, keep u1
        expect(groups).toEqual([{ authorId: "u1", _sum: { views: 150 } }]);
      });

      test("multi-field by groups on the field combination", async () => {
        const groups = await requireClient(client).post.groupBy({
          by: ["authorId", "published"],
          _count: true,
          orderBy: [{ authorId: "asc" }, { published: "asc" }],
        });
        expect(groups).toEqual([
          { authorId: "u1", published: false, _count: 1 },
          { authorId: "u1", published: true, _count: 1 },
          { authorId: "u2", published: true, _count: 1 },
        ]);
      });

      test("multi-field by supports having on aggregates", async () => {
        const groups = await requireClient(client).post.groupBy({
          by: ["authorId", "published"],
          _sum: { views: true },
          having: { views: { _sum: { gte: 100 } } },
          orderBy: [{ authorId: "asc" }, { published: "asc" }],
        });
        expect(groups).toEqual([
          { authorId: "u1", published: true, _sum: { views: 100 } },
          { authorId: "u2", published: true, _sum: { views: 200 } },
        ]);
      });

      // Grouped by authorId the seed yields exactly two groups, computed by
      // hand: u1 = {p1 (100 views), p2 (50)} -> _count 2, _sum 150;
      // u2 = {p3 (200)} -> _count 1, _sum 200. Every combinator below is
      // asserted against those two groups, and each arm is chosen to match
      // exactly ONE of them so AND/OR/NOT cannot be confused with each other.
      describe("having boolean combinators", () => {
        // matches u1 only
        const countIsTwo = { id: { _count: { equals: 2 } } };
        // matches u2 only
        const sumIsTwoHundred = { views: { _sum: { equals: 200 } } };

        test("OR of two single-group conditions matches both groups", async () => {
          const groups = await requireClient(client).post.groupBy({
            by: ["authorId"],
            _count: true,
            _sum: { views: true },
            having: { OR: [countIsTwo, sumIsTwoHundred] },
            orderBy: { authorId: "asc" },
          });
          expect(groups).toEqual([
            { authorId: "u1", _count: 2, _sum: { views: 150 } },
            { authorId: "u2", _count: 1, _sum: { views: 200 } },
          ]);
        });

        test("OR with a single unmatchable arm keeps only the other", async () => {
          const groups = await requireClient(client).post.groupBy({
            by: ["authorId"],
            having: { OR: [countIsTwo, { views: { _sum: { equals: 9999 } } }] },
            orderBy: { authorId: "asc" },
          });
          expect(groups.map((g) => g.authorId)).toEqual(["u1"]);
        });

        test("AND of the same two conditions matches nothing", async () => {
          const groups = await requireClient(client).post.groupBy({
            by: ["authorId"],
            having: { AND: [countIsTwo, sumIsTwoHundred] },
            orderBy: { authorId: "asc" },
          });
          expect(groups).toEqual([]);
        });

        test("AND accepts a bare object as well as an array", async () => {
          const groups = await requireClient(client).post.groupBy({
            by: ["authorId"],
            _count: true,
            having: { AND: countIsTwo },
            orderBy: { authorId: "asc" },
          });
          expect(groups).toEqual([{ authorId: "u1", _count: 2 }]);
        });

        test("AND nested inside OR evaluates the inner conjunction", async () => {
          const groups = await requireClient(client).post.groupBy({
            by: ["authorId"],
            _sum: { views: true },
            having: {
              OR: [
                // u1: _count 2 AND _sum 150 -> true
                { AND: [countIsTwo, { views: { _sum: { equals: 150 } } }] },
                // u2: _sum 200 -> true
                sumIsTwoHundred,
              ],
            },
            orderBy: { authorId: "asc" },
          });
          expect(groups).toEqual([
            { authorId: "u1", _sum: { views: 150 } },
            { authorId: "u2", _sum: { views: 200 } },
          ]);
        });

        test("AND nested inside OR fails the arm when one conjunct misses", async () => {
          const groups = await requireClient(client).post.groupBy({
            by: ["authorId"],
            // u1 satisfies _count 2 but not _sum 200; u2 the reverse
            having: { OR: [{ AND: [countIsTwo, sumIsTwoHundred] }] },
            orderBy: { authorId: "asc" },
          });
          expect(groups).toEqual([]);
        });

        test("NOT of an aggregate condition selects the complement", async () => {
          const groups = await requireClient(client).post.groupBy({
            by: ["authorId"],
            _count: true,
            having: { NOT: countIsTwo },
            orderBy: { authorId: "asc" },
          });
          expect(groups).toEqual([{ authorId: "u2", _count: 1 }]);
        });

        // Prisma negates each NOT-array item individually and ANDs the
        // negations (NOT c1 AND NOT c2 — "all conditions must return false"),
        // never NOT (c1 AND c2). This is the same rule `where` follows; see
        // the "NOT array negates each condition and ANDs them" case above and
        // buildLogicalNot in src/query-engine/builders/where-builder.ts.
        //
        // Both arms below are DISCRIMINATING on purpose: each matches exactly
        // one of the two groups, so the conjunction c1 AND c2 is empty and the
        // wrong reading NOT (c1 AND c2) would widen to EVERY group — the exact
        // opposite of the empty set Prisma returns. An array whose arms can be
        // true together (e.g. two conditions both matching u1) agrees under
        // both readings and pins nothing.
        test("NOT array negates each arm and ANDs the negations (Prisma parity)", async () => {
          const groups = await requireClient(client).post.groupBy({
            by: ["authorId"],
            _count: true,
            // NOT c1 AND NOT c2: u1 fails NOT c1, u2 fails NOT c2 -> {}.
            // NOT (c1 AND c2) would be NOT(false) -> both groups.
            having: { NOT: [countIsTwo, sumIsTwoHundred] },
            orderBy: { authorId: "asc" },
          });
          expect(groups).toEqual([]);
        });

        test("NOT array with one unmatchable arm keeps the other complement", async () => {
          const groups = await requireClient(client).post.groupBy({
            by: ["authorId"],
            _count: true,
            // NOT c1 AND NOT (unmatchable): only u2 survives.
            // NOT (c1 AND unmatchable) would again be NOT(false) -> both.
            having: {
              NOT: [countIsTwo, { views: { _sum: { equals: 9999 } } }],
            },
            orderBy: { authorId: "asc" },
          });
          expect(groups).toEqual([{ authorId: "u2", _count: 1 }]);
        });

        test("NOT array on a `by` field agrees with the same NOT array in where", async () => {
          const c = requireClient(client);
          const notArray = [{ authorId: "u1" }, { authorId: "u2" }];
          // `having` and `where` must resolve the identical payload the same
          // way — this is the cross-builder drift guard. Both exclude every
          // author, so both come back empty; under NOT (c1 AND c2) `having`
          // would return both groups while `where` returned nothing.
          const groups = await c.post.groupBy({
            by: ["authorId"],
            having: { NOT: notArray },
            orderBy: { authorId: "asc" },
          });
          const rows = await c.post.findMany({
            where: { NOT: notArray },
            select: { authorId: true },
          });
          expect(groups.map((g) => g.authorId)).toEqual(
            rows.map((r) => r.authorId)
          );
          expect(groups).toEqual([]);
        });

        test("NOT array of a single item matches the object form", async () => {
          const c = requireClient(client);
          const asArray = await c.post.groupBy({
            by: ["authorId"],
            _count: true,
            having: { NOT: [countIsTwo] },
            orderBy: { authorId: "asc" },
          });
          const asObject = await c.post.groupBy({
            by: ["authorId"],
            _count: true,
            having: { NOT: countIsTwo },
            orderBy: { authorId: "asc" },
          });
          expect(asArray).toEqual(asObject);
          expect(asArray).toEqual([{ authorId: "u2", _count: 1 }]);
        });

        test("NOT of a multi-key object negates that object's conjunction", async () => {
          const groups = await requireClient(client).post.groupBy({
            by: ["authorId"],
            _count: true,
            // The OBJECT form is one item, so its own implicit AND is negated:
            // NOT(_count = 2 AND _sum = 150) -> u1 out, u2 in. Per-arm
            // negation applies to ARRAY items, not to keys within one item.
            having: {
              NOT: {
                id: { _count: { equals: 2 } },
                views: { _sum: { equals: 150 } },
              },
            },
            orderBy: { authorId: "asc" },
          });
          expect(groups).toEqual([{ authorId: "u2", _count: 1 }]);
        });

        test("NOT inside OR restores the excluded group", async () => {
          const groups = await requireClient(client).post.groupBy({
            by: ["authorId"],
            having: { OR: [{ NOT: countIsTwo }, countIsTwo] },
            orderBy: { authorId: "asc" },
          });
          expect(groups.map((g) => g.authorId)).toEqual(["u1", "u2"]);
        });

        test("a combinator conjoins with sibling field-keyed conditions", async () => {
          const groups = await requireClient(client).post.groupBy({
            by: ["authorId"],
            // authorId is in `by`, so it filters directly; ANDed with the OR
            having: {
              authorId: "u2",
              OR: [countIsTwo, sumIsTwoHundred],
            },
            orderBy: { authorId: "asc" },
          });
          expect(groups.map((g) => g.authorId)).toEqual(["u2"]);
        });

        test("a field-keyed condition inside an OR arm still requires `by`", async () => {
          await expect(
            requireClient(client).post.groupBy({
              by: ["authorId"],
              having: { OR: [{ title: "Post 1" }] },
            })
          ).rejects.toThrow(UNGROUPED_COLUMN_REFUSAL);
        });

        // Empty-combinator identities. OR of nothing is FALSE, AND/NOT of
        // nothing are TRUE — the same truth table `where` already compiles
        // (where-builder.ts `buildLogicalOr` emits the dialect FALSE literal).
        // These are asserted through real SQL rather than generated text
        // because the failure mode being pinned is an accept-and-ignore: a
        // dropped `OR` key produces a syntactically valid query with the
        // wrong extension.
        test("empty OR matches no group, exactly like empty OR in where", async () => {
          const groups = await requireClient(client).post.groupBy({
            by: ["authorId"],
            having: { OR: [] },
            orderBy: { authorId: "asc" },
          });
          expect(groups).toEqual([]);

          // The parity claim, asserted side by side so the two builders
          // cannot drift: `where: { OR: [] }` is already FALSE today.
          const rows = await requireClient(client).post.findMany({
            where: { OR: [] },
          });
          expect(rows).toEqual([]);
        });

        test("empty OR is false, not absent, when conjoined with a sibling", async () => {
          const groups = await requireClient(client).post.groupBy({
            by: ["authorId"],
            // If the empty OR were dropped, this would degrade to the
            // sibling alone and return u2.
            having: { authorId: "u2", OR: [] },
            orderBy: { authorId: "asc" },
          });
          expect(groups).toEqual([]);
        });

        test("empty OR nested in AND poisons the conjunction", async () => {
          const groups = await requireClient(client).post.groupBy({
            by: ["authorId"],
            having: { AND: [{ OR: [] }, countIsTwo] },
            orderBy: { authorId: "asc" },
          });
          expect(groups).toEqual([]);
        });

        test("empty OR nested in OR contributes nothing but is not vacuous", async () => {
          const groups = await requireClient(client).post.groupBy({
            by: ["authorId"],
            _count: true,
            having: { OR: [{ OR: [] }, countIsTwo] },
            orderBy: { authorId: "asc" },
          });
          // FALSE OR (_count = 2) -> u1 only. An outer OR that swallowed the
          // inner empty arm as "no condition" would also give u1 here, so the
          // AND case above is the one that separates the two behaviors.
          expect(groups).toEqual([{ authorId: "u1", _count: 2 }]);
        });

        test("empty OR under NOT is true and keeps every group", async () => {
          const groups = await requireClient(client).post.groupBy({
            by: ["authorId"],
            having: { NOT: { OR: [] } },
            orderBy: { authorId: "asc" },
          });
          expect(groups.map((g) => g.authorId)).toEqual(["u1", "u2"]);
        });

        test("empty AND and empty NOT stay true and keep every group", async () => {
          const emptyAnd = await requireClient(client).post.groupBy({
            by: ["authorId"],
            having: { AND: [] },
            orderBy: { authorId: "asc" },
          });
          expect(emptyAnd.map((g) => g.authorId)).toEqual(["u1", "u2"]);

          const emptyNot = await requireClient(client).post.groupBy({
            by: ["authorId"],
            having: { NOT: [] },
            orderBy: { authorId: "asc" },
          });
          expect(emptyNot.map((g) => g.authorId)).toEqual(["u1", "u2"]);
        });

        test("empty AND still conjoins its sibling rather than erasing it", async () => {
          const groups = await requireClient(client).post.groupBy({
            by: ["authorId"],
            _count: true,
            having: { AND: [], ...countIsTwo },
            orderBy: { authorId: "asc" },
          });
          expect(groups).toEqual([{ authorId: "u1", _count: 2 }]);
        });
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

export const prismaParityContract = defineContract({
  id: "drivers.prisma-parity",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runPrismaParityBehavior,
});
