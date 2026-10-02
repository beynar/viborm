import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { ValidationError } from "@errors";
import { s } from "@schema";
import { defineContract } from "@tests/contracts/contract";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const crate = s
  .model({
    id: s.string().id(),
    tag: s.string(),
    qty: s.int().default(0),
    depotId: s.string().nullable(),
    depot: s
      .toOne(() => depot)
      .fields("depotId")
      .references("id"),
  })
  .map("limit_crates");

const depot = s
  .model({
    id: s.string().id(),
    region: s.string(),
    crates: s.toMany(() => crate),
    shipments: s.toMany(() => shipment),
  })
  .map("limit_depots");

/**
 * A compound primary key, which is the shape that decides whether the
 * PK-subquery form of `limit` is portable at all: PostgreSQL and SQLite have to
 * accept the row-value spelling `(a, b) IN (SELECT a, b … ORDER BY a, b)`. The
 * constraint lists `code` first; key order is the declaration order,
 * `tenantId` then `code`, as `findMany`'s `take` completes with.
 */
const shipment = s
  .model({
    tenantId: s.string(),
    code: s.string(),
    tag: s.string(),
    depotId: s.string().nullable(),
    depot: s
      .toOne(() => depot)
      .fields("depotId")
      .references("id"),
  })
  .id(["code", "tenantId"])
  .map("limit_shipments");

const schema = { crate, depot, shipment };

type LimitClientConfig = VibORMConfig<typeof schema>;

type LimitClient = VibORMClient<LimitClientConfig>;

export interface BulkWriteLimitBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

/**
 * `updateMany` / `deleteMany` `limit` (Prisma 6.x), per driver.
 *
 * `limit` takes the first `limit` matching rows ordered by primary key,
 * ascending (a compound key in declaration order), as `findMany`'s `take`
 * does without an `orderBy` (owner ruling, 2026-10-02). Every dialect states
 * the order: an ordered primary-key subquery on PostgreSQL and SQLite, and
 * `UPDATE/DELETE … ORDER BY <key> LIMIT n` on MySQL, which refuses a `LIMIT`
 * inside `IN`. The seeds below insert rows OUT of key order, so a limit that
 * read the table in storage order would pick other rows.
 *
 * Pinned here:
 *  - the count is `min(matching, limit)`, and the rows taken are the first
 *    ones by key;
 *  - `limit: 0` affects nothing and returns `{ count: 0 }` / `[]`;
 *  - rows outside the `where` are never touched, at any limit;
 *  - a relation filter composes with the cap (this is the MySQL ERROR 1093 case:
 *    the derived-table wrapper and the ordered native LIMIT have to coexist);
 *  - the `select` arm returns EXACTLY the affected rows;
 *  - a compound primary key works, which is what the row-value `IN` is for.
 */
export function runBulkWriteLimitBehavior({
  driverName,
  createDriver,
}: BulkWriteLimitBehaviorOptions) {
  describe(`${driverName} bulk-write limit`, () => {
    let client: LimitClient | undefined;

    beforeEach(async () => {
      const driver = createDriver();
      client = createClient({ schema, driver });
      await syncLiveSchema(client);
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    /**
     * Five "keep" rows and two "other" rows that no `where` below matches,
     * inserted out of key order.
     */
    const seedCrates = async () => {
      await client!.crate.createMany({
        data: [
          { id: "o2", tag: "other", qty: 7 },
          { id: "c5", tag: "keep", qty: 5 },
          { id: "c3", tag: "keep", qty: 3 },
          { id: "c1", tag: "keep", qty: 1 },
          { id: "o1", tag: "other", qty: 6 },
          { id: "c4", tag: "keep", qty: 4 },
          { id: "c2", tag: "keep", qty: 2 },
        ],
      });
    };

    const crateIds = async (where: Record<string, unknown>) =>
      (
        await client!.crate.findMany({
          where: where as never,
          select: { id: true },
          orderBy: { id: "asc" },
        })
      ).map((row) => row.id);

    // -----------------------------------------------------------------------
    // deleteMany
    // -----------------------------------------------------------------------

    test("deleteMany limit below the matching count removes the first limit rows by key", async () => {
      await seedCrates();

      const result = await client!.crate.deleteMany({
        where: { tag: "keep" },
        limit: 2,
      });
      expect(result).toEqual({ count: 2 });

      expect(await crateIds({ tag: "keep" })).toEqual(["c3", "c4", "c5"]);
      // …and the cap never reached outside the filter.
      expect(await crateIds({ tag: "other" })).toEqual(["o1", "o2"]);
    });

    test("deleteMany limit equal to the matching count removes all of them", async () => {
      await seedCrates();

      expect(
        await client!.crate.deleteMany({ where: { tag: "keep" }, limit: 5 })
      ).toEqual({ count: 5 });
      expect(await crateIds({ tag: "keep" })).toEqual([]);
      expect(await crateIds({ tag: "other" })).toEqual(["o1", "o2"]);
    });

    test("deleteMany limit above the matching count is the uncapped delete", async () => {
      await seedCrates();

      expect(
        await client!.crate.deleteMany({ where: { tag: "keep" }, limit: 99 })
      ).toEqual({ count: 5 });
      expect(await crateIds({ tag: "keep" })).toEqual([]);
    });

    test("deleteMany limit 0 removes nothing and reports count 0", async () => {
      await seedCrates();

      expect(
        await client!.crate.deleteMany({ where: { tag: "keep" }, limit: 0 })
      ).toEqual({ count: 0 });
      expect(await crateIds({ tag: "keep" })).toEqual([
        "c1",
        "c2",
        "c3",
        "c4",
        "c5",
      ]);
    });

    test("deleteMany limit without a where caps a whole-table delete", async () => {
      await seedCrates();

      expect(await client!.crate.deleteMany({ limit: 3 })).toEqual({
        count: 3,
      });
      expect(await crateIds({})).toEqual(["c4", "c5", "o1", "o2"]);
    });

    // -----------------------------------------------------------------------
    // updateMany
    // -----------------------------------------------------------------------

    test("updateMany limit below the matching count updates the first limit rows by key", async () => {
      await seedCrates();

      const result = await client!.crate.updateMany({
        where: { tag: "keep" },
        data: { tag: "moved" },
        limit: 2,
      });
      expect(result).toEqual({ count: 2 });

      expect(await crateIds({ tag: "moved" })).toEqual(["c1", "c2"]);
      expect(await crateIds({ tag: "keep" })).toEqual(["c3", "c4", "c5"]);
      expect(await crateIds({ tag: "other" })).toEqual(["o1", "o2"]);
    });

    test("updateMany limit at or above the matching count updates all of them", async () => {
      await seedCrates();

      expect(
        await client!.crate.updateMany({
          where: { tag: "keep" },
          data: { tag: "exact" },
          limit: 5,
        })
      ).toEqual({ count: 5 });
      expect(await crateIds({ tag: "exact" })).toHaveLength(5);

      expect(
        await client!.crate.updateMany({
          where: { tag: "exact" },
          data: { tag: "over" },
          limit: 500,
        })
      ).toEqual({ count: 5 });
      expect(await crateIds({ tag: "over" })).toHaveLength(5);
      expect(await crateIds({ tag: "other" })).toEqual(["o1", "o2"]);
    });

    test("updateMany limit 0 changes nothing and reports count 0", async () => {
      await seedCrates();

      expect(
        await client!.crate.updateMany({
          where: { tag: "keep" },
          data: { tag: "never" },
          limit: 0,
        })
      ).toEqual({ count: 0 });
      expect(await crateIds({ tag: "never" })).toEqual([]);
      expect(await crateIds({ tag: "keep" })).toHaveLength(5);
    });

    test("updateMany limit composes with an arithmetic update", async () => {
      await seedCrates();

      expect(
        await client!.crate.updateMany({
          where: { tag: "keep" },
          data: { qty: { increment: 100 } },
          limit: 2,
        })
      ).toEqual({ count: 2 });

      // The first two by key, incremented once each.
      expect(
        await client!.crate.findMany({
          where: { qty: { gte: 100 } },
          select: { id: true, qty: true },
          orderBy: { id: "asc" },
        })
      ).toEqual([
        { id: "c1", qty: 101 },
        { id: "c2", qty: 102 },
      ]);
    });

    // -----------------------------------------------------------------------
    // Relation filters — the MySQL ERROR 1093 composition case
    // -----------------------------------------------------------------------

    const seedDepots = async () => {
      await client!.depot.createMany({
        data: [
          { id: "d1", region: "north" },
          { id: "d2", region: "south" },
        ],
      });
      await client!.crate.createMany({
        data: [
          { id: "n3", tag: "keep", qty: 3, depotId: "d1" },
          { id: "s1", tag: "keep", qty: 4, depotId: "d2" },
          { id: "n2", tag: "keep", qty: 2, depotId: "d1" },
          { id: "n1", tag: "keep", qty: 1, depotId: "d1" },
        ],
      });
    };

    test("updateMany limit composes with a relation filter", async () => {
      await seedDepots();

      // On MySQL this is the interesting one: the relation filter is wrapped in
      // a derived table (ERROR 1093) AND the statement carries a native LIMIT.
      expect(
        await client!.crate.updateMany({
          where: { depot: { is: { region: "north" } } },
          data: { tag: "picked" },
          limit: 2,
        })
      ).toEqual({ count: 2 });

      expect(await crateIds({ tag: "picked" })).toEqual(["n1", "n2"]);
      // The southern crate was never a candidate.
      expect(await crateIds({ depotId: "d2" })).toEqual(["s1"]);
    });

    test("deleteMany limit composes with a relation filter", async () => {
      await seedDepots();

      expect(
        await client!.crate.deleteMany({
          where: { depot: { is: { region: "north" } } },
          limit: 1,
        })
      ).toEqual({ count: 1 });

      expect(await crateIds({ depotId: "d1" })).toEqual(["n2", "n3"]);
      expect(await crateIds({ depotId: "d2" })).toEqual(["s1"]);
    });

    test("a relation-bearing updateMany limit takes the same first rows by key as the scalar form", async () => {
      await client!.depot.create({ data: { id: "d1", region: "north" } });
      await seedCrates();

      // Captured row by row, in key order.
      expect(
        await client!.crate.updateMany({
          where: { tag: "keep" },
          data: { tag: "linked", depot: { connect: { id: "d1" } } },
          limit: 2,
        })
      ).toEqual({ count: 2 });
      expect(await crateIds({ depotId: "d1" })).toEqual(["c1", "c2"]);

      // A compound key whose constraint lists `code` first: both forms take
      // (t1, a) and (t1, b), the declaration order.
      await client!.shipment.createMany({
        data: [
          { tenantId: "t2", code: "a", tag: "new" },
          { tenantId: "t1", code: "c", tag: "new" },
          { tenantId: "t1", code: "a", tag: "new" },
          { tenantId: "t1", code: "b", tag: "new" },
        ],
      });
      const shipments = async (where: Record<string, unknown>) =>
        (
          await client!.shipment.findMany({
            where: where as never,
            select: { tenantId: true, code: true },
            orderBy: [{ tenantId: "asc" }, { code: "asc" }],
          })
        ).map((row) => `${row.tenantId}${row.code}`);
      expect(
        await client!.shipment.updateMany({
          data: { depot: { connect: { id: "d1" } } },
          limit: 2,
        })
      ).toEqual({ count: 2 });
      expect(await shipments({ depotId: "d1" })).toEqual(["t1a", "t1b"]);
      expect(
        await client!.shipment.updateMany({
          data: { tag: "scalar" },
          limit: 2,
        })
      ).toEqual({ count: 2 });
      expect(await shipments({ tag: "scalar" })).toEqual(["t1a", "t1b"]);
    });

    // -----------------------------------------------------------------------
    // Implicit returning: the rows back are exactly the rows affected
    // -----------------------------------------------------------------------

    test("updateMany with select returns exactly the capped rows", async () => {
      await seedCrates();

      const rows = await client!.crate.updateMany({
        where: { tag: "keep" },
        data: { tag: "returned" },
        limit: 2,
        select: { id: true, tag: true },
      });

      // The returned rows ARE the changed rows, the first two by key.
      expect(rows.map((row) => `${row.id} ${row.tag}`).sort()).toEqual([
        "c1 returned",
        "c2 returned",
      ]);
      expect(await crateIds({ tag: "returned" })).toEqual(["c1", "c2"]);
    });

    test("deleteMany with select returns exactly the capped rows", async () => {
      await seedCrates();

      const rows = await client!.crate.deleteMany({
        where: { tag: "keep" },
        limit: 3,
        select: { id: true, qty: true },
      });

      expect(rows.map((row) => row.id).sort()).toEqual(["c1", "c2", "c3"]);
      expect(await crateIds({ tag: "keep" })).toEqual(["c4", "c5"]);
    });

    test("a select-carrying bulk write with limit 0 returns an empty row set", async () => {
      await seedCrates();

      expect(
        await client!.crate.updateMany({
          where: { tag: "keep" },
          data: { tag: "never" },
          limit: 0,
          select: { id: true },
        })
      ).toEqual([]);
      expect(
        await client!.crate.deleteMany({
          where: { tag: "keep" },
          limit: 0,
          select: { id: true },
        })
      ).toEqual([]);
      expect(await crateIds({ tag: "keep" })).toHaveLength(5);
    });

    // -----------------------------------------------------------------------
    // Compound primary key — the row-value IN
    // -----------------------------------------------------------------------

    test("limit works on a model with a compound primary key, in key order", async () => {
      await client!.shipment.createMany({
        data: [
          { tenantId: "t2", code: "a", tag: "other" },
          { tenantId: "t1", code: "c", tag: "keep" },
          { tenantId: "t1", code: "a", tag: "keep" },
          { tenantId: "t1", code: "b", tag: "keep" },
        ],
      });

      expect(
        await client!.shipment.updateMany({
          where: { tag: "keep" },
          data: { tag: "compound" },
          limit: 2,
        })
      ).toEqual({ count: 2 });
      expect(
        await client!.shipment.findMany({
          where: { tag: "compound" },
          select: { code: true },
          orderBy: { code: "asc" },
        })
      ).toEqual([{ code: "a" }, { code: "b" }]);

      expect(
        await client!.shipment.deleteMany({ where: { tag: "keep" }, limit: 5 })
      ).toEqual({ count: 1 });
      expect(await client!.shipment.count({ where: { tag: "other" } })).toBe(1);
    });

    // -----------------------------------------------------------------------
    // Inside $transaction([...])
    // -----------------------------------------------------------------------

    /**
     * `limit: 0` compiles to NO statement, so inside `$transaction([...])` it
     * contributes nothing to the batch. On a batch-only driver that used to make
     * a batch of nothing but such writes "un-batchable" — a refusal the direct
     * path never issued, and which a single statement-emitting sibling lifted.
     * The documented `{ count: 0 }` / `[]` holds on every driver, in both
     * transaction and batch mode, alone or in company.
     */
    test("limit 0 is the same no-op inside $transaction([...])", async () => {
      await seedCrates();

      expect(
        await client!.$transaction([
          client!.crate.deleteMany({ where: { tag: "keep" }, limit: 0 }),
        ])
      ).toEqual([{ count: 0 }]);

      expect(
        await client!.$transaction([
          client!.crate.updateMany({
            where: { tag: "keep" },
            data: { tag: "nope" },
            limit: 0,
          }),
          client!.crate.deleteMany({
            where: { tag: "keep" },
            limit: 0,
            select: { id: true },
          }),
        ])
      ).toEqual([{ count: 0 }, []]);

      // With a statement-emitting sibling the whole batch still commits as one.
      expect(
        await client!.$transaction([
          client!.crate.deleteMany({ where: { tag: "keep" }, limit: 0 }),
          client!.crate.updateMany({
            where: { tag: "keep" },
            data: { tag: "capped" },
            limit: 2,
          }),
        ])
      ).toEqual([{ count: 0 }, { count: 2 }]);

      expect(await crateIds({ tag: "keep" })).toEqual(["c3", "c4", "c5"]);
      expect(await crateIds({ tag: "capped" })).toEqual(["c1", "c2"]);
    });

    // -----------------------------------------------------------------------
    // Parse boundary
    // -----------------------------------------------------------------------

    test("a negative or fractional limit is rejected before any write", async () => {
      await seedCrates();
      const untyped = client! as unknown as Record<
        string,
        Record<string, (args: unknown) => Promise<unknown>>
      >;

      for (const bad of [-1, 1.5, "2"]) {
        await expect(
          untyped.crate?.deleteMany?.({ where: { tag: "keep" }, limit: bad })
        ).rejects.toBeInstanceOf(ValidationError);
        await expect(
          untyped.crate?.updateMany?.({
            where: { tag: "keep" },
            data: { tag: "nope" },
            limit: bad,
          })
        ).rejects.toBeInstanceOf(ValidationError);
      }

      // Rejected means rejected: the seed is untouched.
      expect(await crateIds({ tag: "keep" })).toHaveLength(5);
    });
  });
}

export const bulkWriteLimitContract = defineContract({
  id: "drivers.bulk-write-limit",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runBulkWriteLimitBehavior,
});
