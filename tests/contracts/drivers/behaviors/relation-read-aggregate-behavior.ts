import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { s } from "@schema";
import { MYSQL, PG, SQLITE } from "@schema/scalars/native-types";
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
// publish under the output key `_count`. `tally` also states a native type per
// dialect (#45): `smallint` on PostgreSQL and `SMALLINT` on MySQL instead of
// their automatic `integer` / `INT` (SQLite's catalog has one integer type), so
// a map the column ignored would be seen, and the reading beside the counts
// must not move for it.
const ledger = s
  .model({
    id: s.string().id(),
    tally: s
      .int({
        pg: PG.INT.SMALLINT,
        mysql: MYSQL.INT.SMALLINT,
        sqlite: SQLITE.INT.INTEGER,
      })
      .map("_count"),
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

// `_aggregate`: every aggregate of a field of a to-many relation's rows, beside
// `_count`. `big` holds a value past 2^53 so a sum that travelled as a double
// would be seen, and `price` a decimal whose sum and average stay exact.
const shop = s
  .model({
    id: s.string().id(),
    name: s.string(),
    orders: s.toMany(() => order),
  })
  .map("rel_agg_shops");

const order = s
  .model({
    id: s.string().id(),
    shopId: s.string(),
    shop: s
      .toOne(() => shop)
      .fields("shopId")
      .references("id"),
    quantity: s.int(),
    big: s.bigInt(),
    weight: s.number(),
    price: s.decimal({ precision: 10, scale: 2 }),
    placedAt: s.dateTime(),
    status: s.string(),
    note: s.string().nullable(),
  })
  .map("rel_agg_orders");

const schema = { user, post, archive, ledger, vault, entry, shop, order };

/** The `_count` column's definition `tally`'s map names, by dialect. */
const TALLY_COLUMN: Record<AnyDriver["dialect"], RegExp> = {
  postgresql: /"_count" smallint NOT NULL/,
  mysql: /`_count` SMALLINT NOT NULL/,
  sqlite: /"_count" INTEGER NOT NULL/,
  surrealql: /(?!)/,
  snowflake: /(?!)/,
};

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
    let dialect: AnyDriver["dialect"];
    let setupSql: readonly string[];

    beforeEach(async () => {
      const driver = createDriver();
      dialect = driver.dialect;
      client = createClient({ schema, driver });
      setupSql = (await syncLiveSchema(client)).sql;

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

    // Seed: s1 three orders, s2 one, s3 none.
    describe("relation _aggregate", () => {
      const refusing = () => dialect === "surrealql";

      beforeEach(async () => {
        await client.shop.createMany({
          data: [
            { id: "s1", name: "North" },
            { id: "s2", name: "South" },
            { id: "s3", name: "Empty" },
          ],
        });
        await client.order.createMany({
          data: [
            {
              id: "o1",
              shopId: "s1",
              quantity: 2,
              big: 9_007_199_254_740_993n,
              weight: 1.5,
              price: "10.25",
              placedAt: new Date("2026-01-01T00:00:00.000Z"),
              status: "paid",
              note: "gift",
            },
            {
              id: "o2",
              shopId: "s1",
              quantity: 3,
              big: 1n,
              weight: 2.25,
              price: "0.10",
              placedAt: new Date("2026-03-01T00:00:00.000Z"),
              status: "paid",
              note: null,
            },
            {
              id: "o3",
              shopId: "s1",
              quantity: 7,
              big: 2n,
              weight: 0.25,
              price: "5.00",
              placedAt: new Date("2026-02-01T00:00:00.000Z"),
              status: "open",
              note: null,
            },
            {
              id: "o4",
              shopId: "s2",
              quantity: 7,
              big: -4n,
              weight: 10,
              price: "1.00",
              placedAt: new Date("2025-12-31T00:00:00.000Z"),
              status: "open",
              note: "rush",
            },
          ],
        });
      });

      test("selects every aggregate of a relation's rows, NULL where it has none", async () => {
        const read = () =>
          client.shop.findMany({
            orderBy: { id: "asc" },
            select: {
              id: true,
              _aggregate: {
                orders: {
                  _count: { _all: true, note: true },
                  _sum: {
                    quantity: true,
                    big: true,
                    weight: true,
                    price: true,
                  },
                  _avg: { quantity: true, price: true },
                  _min: { placedAt: true, status: true },
                  _max: { placedAt: true },
                },
              },
            },
          });
        if (refusing()) {
          await expect(read()).rejects.toThrow("'_aggregate'");
          return;
        }
        const shops = await read();
        const [north, south, empty] = shops;
        expect(Object.keys(north!).sort()).toEqual(["_aggregate", "id"]);
        expect(north!._aggregate.orders._count).toEqual({ _all: 3, note: 1 });
        expect(north!._aggregate.orders._sum.quantity).toBe(12);
        expect(north!._aggregate.orders._sum.big).toBe(9_007_199_254_740_996n);
        expect(north!._aggregate.orders._sum.weight).toBe(4);
        expect(String(north!._aggregate.orders._sum.price)).toBe("15.35");
        expect(north!._aggregate.orders._avg.quantity).toBe(4);
        // 15.35 / 3, at the field's scale, half to even.
        expect(String(north!._aggregate.orders._avg.price)).toBe("5.12");
        expect(north!._aggregate.orders._min).toEqual({
          placedAt: new Date("2026-01-01T00:00:00.000Z"),
          status: "open",
        });
        expect(north!._aggregate.orders._max).toEqual({
          placedAt: new Date("2026-03-01T00:00:00.000Z"),
        });
        expect(south!._aggregate.orders._sum.big).toBe(-4n);
        expect(empty).toEqual({
          id: "s3",
          _aggregate: {
            orders: {
              _count: { _all: 0, note: 0 },
              _sum: { quantity: null, big: null, weight: null, price: null },
              _avg: { quantity: null, price: null },
              _min: { placedAt: null, status: null },
              _max: { placedAt: null },
            },
          },
        });
      });

      test("an entry's where narrows the rows it aggregates", async () => {
        const read = () =>
          client.shop.findMany({
            orderBy: { id: "asc" },
            select: {
              id: true,
              _aggregate: {
                orders: {
                  where: { status: "paid" },
                  _count: true,
                  _sum: { quantity: true },
                },
              },
            },
          });
        if (refusing()) {
          await expect(read()).rejects.toThrow("'_aggregate'");
          return;
        }
        expect(await read()).toEqual([
          {
            id: "s1",
            _aggregate: { orders: { _count: 2, _sum: { quantity: 5 } } },
          },
          {
            id: "s2",
            _aggregate: { orders: { _count: 0, _sum: { quantity: null } } },
          },
          {
            id: "s3",
            _aggregate: { orders: { _count: 0, _sum: { quantity: null } } },
          },
        ]);
      });

      test("sits beside _count, the relation's rows and include", async () => {
        if (refusing()) return;
        const shops = await client.shop.findMany({
          orderBy: { id: "asc" },
          include: {
            orders: { select: { id: true }, orderBy: { id: "asc" } },
            _count: { select: { orders: true } },
            _aggregate: { orders: { _max: { quantity: true } } },
          },
        });
        expect(
          shops.map(({ id, name, orders, _count, _aggregate }) => ({
            id,
            name,
            orders: orders.map((row) => row.id),
            _count,
            _aggregate,
          }))
        ).toEqual([
          {
            id: "s1",
            name: "North",
            orders: ["o1", "o2", "o3"],
            _count: { orders: 3 },
            _aggregate: { orders: { _max: { quantity: 7 } } },
          },
          {
            id: "s2",
            name: "South",
            orders: ["o4"],
            _count: { orders: 1 },
            _aggregate: { orders: { _max: { quantity: 7 } } },
          },
          {
            id: "s3",
            name: "Empty",
            orders: [],
            _count: { orders: 0 },
            _aggregate: { orders: { _max: { quantity: null } } },
          },
        ]);
      });

      test("inside a nested relation, correlated to each related row", async () => {
        if (refusing()) return;
        const orders = await client.order.findMany({
          where: { id: { in: ["o1", "o4"] } },
          orderBy: { id: "asc" },
          select: {
            id: true,
            shop: {
              select: {
                id: true,
                _aggregate: { orders: { _sum: { weight: true } } },
              },
            },
          },
        });
        expect(orders).toEqual([
          {
            id: "o1",
            shop: { id: "s1", _aggregate: { orders: { _sum: { weight: 4 } } } },
          },
          {
            id: "o4",
            shop: {
              id: "s2",
              _aggregate: { orders: { _sum: { weight: 10 } } },
            },
          },
        ]);
      });

      test("orders by an aggregate, NULL placed as PostgreSQL places it unless spelled", async () => {
        const ids = async (orderBy: unknown) =>
          (
            await client.shop.findMany({
              orderBy: orderBy as never,
              select: { id: true },
            })
          ).map((row) => row.id);
        if (refusing()) {
          await expect(
            ids({ orders: { _sum: { quantity: "desc" } } })
          ).rejects.toThrow("'_sum' of the relation 'orders'");
          return;
        }
        // An empty relation's sum is NULL: first in a descending order, last
        // in an ascending one, on every database.
        expect(await ids({ orders: { _sum: { quantity: "desc" } } })).toEqual([
          "s3",
          "s1",
          "s2",
        ]);
        expect(
          await ids({
            orders: { _sum: { quantity: { sort: "desc", nulls: "last" } } },
          })
        ).toEqual(["s1", "s2", "s3"]);
        expect(await ids({ orders: { _max: { placedAt: "asc" } } })).toEqual([
          "s2",
          "s1",
          "s3",
        ]);
        expect(
          await ids({
            orders: { _min: { placedAt: { sort: "asc", nulls: "first" } } },
          })
        ).toEqual(["s3", "s2", "s1"]);
        // A bigint sum past 2^53 and a decimal average order exactly.
        expect(
          await ids({
            orders: { _sum: { big: { sort: "desc", nulls: "last" } } },
          })
        ).toEqual(["s1", "s2", "s3"]);
        expect(
          await ids({
            orders: { _avg: { price: { sort: "asc", nulls: "last" } } },
          })
        ).toEqual(["s2", "s1", "s3"]);
        // `_count` is unchanged, and an aggregate sits in an orderBy array.
        expect(
          await ids([
            { orders: { _count: "desc" } },
            { orders: { _max: { weight: "desc" } } },
          ])
        ).toEqual(["s1", "s2", "s3"]);
      });

      test("refuses an aggregate a relation cannot answer, before any SQL", async () => {
        const refused = async (args: unknown, message: string) =>
          expect(client.shop.findMany(args as never)).rejects.toThrow(message);
        await refused(
          { select: { id: true, _aggregate: {} } },
          "'_aggregate' names at least one relation."
        );
        await refused(
          {
            select: {
              id: true,
              _aggregate: { orders: { where: { status: "paid" } } },
            },
          },
          "selects at least one field"
        );
        await refused(
          { select: { id: true, _aggregate: { orders: { _sum: {} } } } },
          "selects at least one field"
        );
        await refused(
          {
            select: {
              id: true,
              _aggregate: { orders: { _sum: { status: true } } },
            },
          },
          "status"
        );
        await refused(
          {
            orderBy: { orders: { _sum: { quantity: "desc" }, _count: "asc" } },
          },
          "orders by one aggregate"
        );
        await refused(
          {
            orderBy: { orders: { _max: { quantity: "desc", weight: "asc" } } },
          },
          "orders by one aggregate"
        );
        await expect(
          client.order.findMany({
            select: {
              id: true,
              _aggregate: { shop: { _count: true } },
            } as never,
          })
        ).rejects.toThrow("A to-one relation has no rows to aggregate");
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

      test("the column has the type `tally`'s map names on this dialect", () => {
        const created = setupSql.find(
          (sql) =>
            sql.startsWith("CREATE TABLE") && sql.includes("rel_agg_ledgers")
        );
        expect(created).toMatch(TALLY_COLUMN[dialect]);
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
