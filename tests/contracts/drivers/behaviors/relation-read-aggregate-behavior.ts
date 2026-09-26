import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { s } from "@schema";
import { defineContract } from "@tests/contracts/contract";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

// =============================================================================
// Schema: users with posts, nullable author FK so isNot can pin null-FK rows
// =============================================================================

const LONG_RELATION_NAME =
  "archivedItemRelationNameFortyOneCharsLongBoundaryTwentyTwoChars";

const user = s
  .model({
    id: s.string().id(),
    name: s.string(),
    posts: s.toMany(() => post),
    [LONG_RELATION_NAME]: s.toMany(() => archive),
  })
  .map("rel_agg_users");

const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    published: s.boolean().default(false),
    authorId: s.string().nullable(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  })
  .map("rel_agg_posts");

const archive = s
  .model({
    id: s.string().id(),
    userId: s.string(),
    user: s
      .toOne(() => user)
      .fields("userId")
      .references("id"),
  })
  .map("rel_agg_archives");

// `_count` is reserved as a member name (schema validation refuses it, F010);
// the COLUMN name is not. `ledger.tally` and the model-hidden `vault.sealed`
// both live in a column named `_count`, beside a to-many relation whose counts
// publish under the output key `_count`.
const ledger = s
  .model({
    id: s.string().id(),
    tally: s.int().map("_count"),
    entries: s.toMany(() => entry),
  })
  .map("rel_agg_ledgers");

const vault = s
  .model({
    id: s.string().id(),
    sealed: s.int().map("_count"),
    entries: s.toMany(() => entry),
  })
  .omit({ sealed: true })
  .map("rel_agg_vaults");

const entry = s
  .model({
    id: s.string().id(),
    ledgerId: s.string(),
    ledger: s
      .toOne(() => ledger)
      .fields("ledgerId")
      .references("id"),
    vaultId: s.string().nullable(),
    vault: s
      .toOne(() => vault)
      .fields("vaultId")
      .references("id"),
  })
  .map("rel_agg_entries");

const schema = { user, post, archive, ledger, vault, entry };

type RelationReadAggregateClientConfig = VibORMConfig<typeof schema>;

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
 * - a scalar mapped to a COLUMN named `_count` beside relation counts: the
 *   member name is reserved, the column name is not
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
      await syncLiveSchema(client);

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
      await client.archive.createMany({
        data: [
          { id: "a1", userId: "u1" },
          { id: "a2", userId: "u1" },
          { id: "a3", userId: "u3" },
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

      test("returns multiple counts with a long public relation name", async () => {
        const users = await client.user.findMany({
          orderBy: { id: "asc" },
          select: {
            id: true,
            _count: {
              select: { posts: true, [LONG_RELATION_NAME]: true },
            },
          },
        });

        expect(users).toEqual([
          {
            id: "u1",
            _count: { posts: 3, [LONG_RELATION_NAME]: 2 },
          },
          {
            id: "u2",
            _count: { posts: 1, [LONG_RELATION_NAME]: 0 },
          },
          {
            id: "u3",
            _count: { posts: 0, [LONG_RELATION_NAME]: 1 },
          },
          {
            id: "u4",
            _count: { posts: 1, [LONG_RELATION_NAME]: 0 },
          },
        ]);
      });

      test("includes a long relation under its exact public name", async () => {
        const alice = await client.user.findUnique({
          where: { id: "u1" },
          select: {
            id: true,
            [LONG_RELATION_NAME]: {
              select: { id: true },
              orderBy: { id: "asc" },
            },
          },
        });

        expect(alice).toEqual({
          id: "u1",
          [LONG_RELATION_NAME]: [{ id: "a1" }, { id: "a2" }],
        });
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

      // Prisma supports `include: { _count: { select: { posts: true } } }`
      // alongside included relations. getIncludeSchema now mirrors the select
      // schema's _count entry, and the SQL select-builder already handles
      // _count in include position.
      test("_count inside include returns counts alongside relations", async () => {
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

    // Prisma's `_count: true` is sugar for "count every LIST relation of this
    // model" — `<Model>CountOutputType` holds only to-many fields. `user` has
    // two (posts, the long-named archive relation) and no to-one relation;
    // `post` has only the to-one `author`, so it is the zero-list-relation case.
    describe("_count: true shorthand", () => {
      const expectedCounts = [
        { id: "u1", _count: { posts: 3, [LONG_RELATION_NAME]: 2 } },
        { id: "u2", _count: { posts: 1, [LONG_RELATION_NAME]: 0 } },
        { id: "u3", _count: { posts: 0, [LONG_RELATION_NAME]: 1 } },
        { id: "u4", _count: { posts: 1, [LONG_RELATION_NAME]: 0 } },
      ];

      test("select _count: true counts every to-many relation", async () => {
        const users = await client.user.findMany({
          orderBy: { id: "asc" },
          select: { id: true, _count: true },
        });

        expect(users).toEqual(expectedCounts);
      });

      test("select _count: true equals the explicit object form", async () => {
        const shorthand = await client.user.findMany({
          orderBy: { id: "asc" },
          select: { id: true, _count: true },
        });
        const explicit = await client.user.findMany({
          orderBy: { id: "asc" },
          select: {
            id: true,
            _count: { select: { posts: true, [LONG_RELATION_NAME]: true } },
          },
        });

        expect(shorthand).toEqual(explicit);
      });

      test("include _count: true counts every to-many relation", async () => {
        const users = await client.user.findMany({
          orderBy: { id: "asc" },
          include: { _count: true },
        });

        expect(users.map((u) => ({ id: u.id, _count: u._count }))).toEqual(
          expectedCounts
        );
      });

      test("include _count: true sits alongside included relations", async () => {
        const users = await client.user.findMany({
          orderBy: { id: "asc" },
          include: { posts: true, _count: true },
        });

        for (const user of users) {
          expect(user._count.posts).toBe(user.posts.length);
        }
        expect(users.map((u) => u._count[LONG_RELATION_NAME])).toEqual([
          2, 0, 1, 0,
        ]);
      });

      test("_count: true on findUnique counts for the single row", async () => {
        const cara = await client.user.findUnique({
          where: { id: "u3" },
          select: { id: true, _count: true },
        });

        expect(cara).toEqual({
          id: "u3",
          _count: { posts: 0, [LONG_RELATION_NAME]: 1 },
        });
      });

      test("_count: true skips to-one relations (no list relation, no key)", async () => {
        // `post.author` is manyToOne. Prisma generates no `_count` at all for
        // such a model; viborm pins the shorthand as EXACTLY the explicit empty
        // object form — accepted, expanding to nothing, so no _count key.
        const shorthand = await client.post.findMany({
          where: { id: "p1" },
          select: { id: true, _count: true },
        });
        const explicitEmpty = await client.post.findMany({
          where: { id: "p1" },
          select: { id: true, _count: { select: {} } },
        });

        expect(shorthand).toEqual([{ id: "p1" }]);
        expect(shorthand).toEqual(explicitEmpty);
      });

      test("_count: true inside a nested include", async () => {
        const archives = await client.archive.findMany({
          orderBy: { id: "asc" },
          include: { user: { include: { _count: true } } },
        });

        expect(
          archives.map((a) => ({ id: a.id, counts: a.user._count }))
        ).toEqual([
          { id: "a1", counts: { posts: 3, [LONG_RELATION_NAME]: 2 } },
          { id: "a2", counts: { posts: 3, [LONG_RELATION_NAME]: 2 } },
          { id: "a3", counts: { posts: 0, [LONG_RELATION_NAME]: 1 } },
        ]);
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

      test("findMany applies same-object is and isNot filters independent of key order", async () => {
        const posts = await client.post.findMany({
          where: {
            author: {
              is: { name: "Alice" },
              isNot: { name: "Alice" },
            },
          },
          orderBy: { id: "asc" },
          select: { id: true },
        });

        expect(posts).toEqual([]);

        const reorderedPosts = await client.post.findMany({
          where: {
            author: {
              isNot: { name: "Alice" },
              is: { name: "Alice" },
            },
          },
          orderBy: { id: "asc" },
          select: { id: true },
        });

        expect(reorderedPosts).toEqual([]);
      });

      test("findMany combines null and object to-one filters", async () => {
        const nullThenObject = await client.post.findMany({
          where: {
            author: {
              is: null,
              isNot: { name: "Alice" },
            },
          },
          orderBy: { id: "asc" },
          select: { id: true },
        });
        const objectThenNull = await client.post.findMany({
          where: {
            author: {
              is: { name: "Alice" },
              isNot: null,
            },
          },
          orderBy: { id: "asc" },
          select: { id: true },
        });

        expect(nullThenObject.map((matchedPost) => matchedPost.id)).toEqual([
          "p5",
        ]);
        expect(objectThenNull.map((matchedPost) => matchedPost.id)).toEqual([
          "p1",
          "p2",
          "p3",
        ]);
      });
    });

    describe("to-many relation filters on the read path", () => {
      test("findMany applies same-object some and none filters independent of key order", async () => {
        const users = await client.user.findMany({
          where: {
            posts: {
              some: { published: true },
              none: { published: false },
            },
          },
          orderBy: { id: "asc" },
          select: { id: true },
        });

        expect(users.map((matchedUser) => matchedUser.id)).toEqual(["u4"]);

        const reorderedUsers = await client.user.findMany({
          where: {
            posts: {
              none: { published: false },
              some: { published: true },
            },
          },
          orderBy: { id: "asc" },
          select: { id: true },
        });

        expect(reorderedUsers.map((matchedUser) => matchedUser.id)).toEqual([
          "u4",
        ]);
      });

      test("findMany applies same-object some and every filters independent of key order", async () => {
        const users = await client.user.findMany({
          where: {
            posts: {
              some: { published: true },
              every: { published: true },
            },
          },
          orderBy: { id: "asc" },
          select: { id: true },
        });

        expect(users.map((matchedUser) => matchedUser.id)).toEqual(["u4"]);

        const reorderedUsers = await client.user.findMany({
          where: {
            posts: {
              every: { published: true },
              some: { published: true },
            },
          },
          orderBy: { id: "asc" },
          select: { id: true },
        });

        expect(reorderedUsers.map((matchedUser) => matchedUser.id)).toEqual([
          "u4",
        ]);
      });

      test("every with an empty condition matches zero related rows", async () => {
        const users = await client.user.findMany({
          where: { id: "u3", posts: { every: {} } },
          select: { id: true },
        });

        expect(users.map((matchedUser) => matchedUser.id)).toEqual(["u3"]);
      });

      test("every with an empty condition matches one related row", async () => {
        const users = await client.user.findMany({
          where: { id: "u4", posts: { every: {} } },
          select: { id: true },
        });

        expect(users.map((matchedUser) => matchedUser.id)).toEqual(["u4"]);
      });

      test("every with an empty condition matches several related rows", async () => {
        const users = await client.user.findMany({
          where: { id: "u1", posts: { every: {} } },
          select: { id: true },
        });

        expect(users.map((matchedUser) => matchedUser.id)).toEqual(["u1"]);
      });

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

    describe("a scalar mapped to the column `_count`", () => {
      // L1: tally 7, one entry. L2: tally 3, two entries. L3: tally 3, no
      // entry, so a group's row count and a ledger's entry count disagree with
      // the column's order on purpose. V1 hides `sealed` (42), one entry.
      beforeEach(async () => {
        await client.ledger.createMany({
          data: [
            { id: "L1", tally: 7 },
            { id: "L2", tally: 3 },
            { id: "L3", tally: 3 },
          ],
        });
        await client.vault.create({ data: { id: "V1", sealed: 42 } });
        await client.entry.createMany({
          data: [
            { id: "e1", ledgerId: "L1", vaultId: "V1" },
            { id: "e2", ledgerId: "L2", vaultId: null },
            { id: "e3", ledgerId: "L2", vaultId: null },
          ],
        });
      });

      test("the column reads under its member name, and `_count` is the counts", async () => {
        await expect(
          client.ledger.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([
          { id: "L1", tally: 7 },
          { id: "L2", tally: 3 },
          { id: "L3", tally: 3 },
        ]);
        const selected = await client.ledger.findMany({
          orderBy: { id: "asc" },
          select: { id: true, tally: true, _count: true },
        });
        expect(selected).toEqual([
          { id: "L1", tally: 7, _count: { entries: 1 } },
          { id: "L2", tally: 3, _count: { entries: 2 } },
          { id: "L3", tally: 3, _count: { entries: 0 } },
        ]);
        await expect(
          client.ledger.findMany({
            orderBy: { id: "asc" },
            include: { _count: { select: { entries: true } } },
          })
        ).resolves.toEqual(selected);
      });

      test("an omitted member stays omitted when counts are included", async () => {
        await expect(
          client.ledger.findMany({
            orderBy: { id: "asc" },
            omit: { tally: true },
            include: { _count: true },
          })
        ).resolves.toEqual([
          { id: "L1", _count: { entries: 1 } },
          { id: "L2", _count: { entries: 2 } },
          { id: "L3", _count: { entries: 0 } },
        ]);
      });

      test("orders by the relation count and by the column independently", async () => {
        await expect(
          client.ledger.findMany({
            orderBy: { entries: { _count: "desc" } },
            select: { id: true },
          })
        ).resolves.toEqual([{ id: "L2" }, { id: "L1" }, { id: "L3" }]);
        await expect(
          client.ledger.findMany({
            orderBy: [{ tally: "desc" }, { id: "asc" }],
            select: { id: true },
          })
        ).resolves.toEqual([{ id: "L1" }, { id: "L2" }, { id: "L3" }]);
      });

      test("filters on the column and counts under a where", async () => {
        await expect(
          client.ledger.findMany({
            where: { tally: { gt: 5 } },
            select: {
              id: true,
              _count: { select: { entries: { where: { id: "e3" } } } },
            },
          })
        ).resolves.toEqual([{ id: "L1", _count: { entries: 0 } }]);
        await expect(
          client.ledger.groupBy({
            by: ["tally"],
            _count: true,
            orderBy: { tally: "asc" },
          })
        ).resolves.toEqual([
          { tally: 3, _count: 2 },
          { tally: 7, _count: 1 },
        ]);
      });

      test("a model-hidden member in the `_count` column never leaves", async () => {
        const counts = [{ id: "V1", _count: { entries: 1 } }];
        await expect(client.vault.findMany()).resolves.toEqual([{ id: "V1" }]);
        await expect(
          client.vault.findMany({ select: { id: true, _count: true } })
        ).resolves.toEqual(counts);
        await expect(
          client.vault.findMany({ include: { _count: true } })
        ).resolves.toEqual(counts);
        await expect(
          client.entry.findMany({
            where: { id: "e1" },
            select: { id: true, vault: { include: { _count: true } } },
          })
        ).resolves.toEqual([{ id: "e1", vault: counts[0] }]);
      });
    });
  });
}

export const relationReadAggregateContract = defineContract({
  id: "drivers.relation-read-aggregate",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runRelationReadAggregateBehavior,
});
