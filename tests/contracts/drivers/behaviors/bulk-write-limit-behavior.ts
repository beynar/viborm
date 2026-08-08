import { defineContract } from "@tests/contracts/contract";
import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { ValidationError } from "@errors";
import { push } from "@migrations";
import { s } from "@schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const crate = s
  .model({
    id: s.string().id(),
    tag: s.string(),
    qty: s.int().default(0),
    depotId: s.string().nullable(),
    depot: s
      .manyToOne(() => depot)
      .fields("depotId")
      .references("id")
      .optional(),
  })
  .map("limit_crates");

const depot = s
  .model({
    id: s.string().id(),
    region: s.string(),
    crates: s.oneToMany(() => crate),
  })
  .map("limit_depots");

/**
 * A compound primary key, which is the shape that decides whether the
 * PK-subquery form of `limit` is portable at all: PostgreSQL and SQLite have to
 * accept the row-value spelling `(a, b) IN (SELECT a, b …)`.
 */
const shipment = s
  .model({
    tenantId: s.string(),
    code: s.string(),
    tag: s.string(),
  })
  .id(["tenantId", "code"])
  .map("limit_shipments");

const schema = { crate, depot, shipment };

type LimitClientConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};

type LimitClient = VibORMClient<LimitClientConfig>;

export interface BulkWriteLimitBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

/**
 * `updateMany` / `deleteMany` `limit` (Prisma 6.x), per driver.
 *
 * THE CONTRACT IS "HOW MANY", NOT "WHICH". `limit` caps the number of affected
 * rows at `min(matching, limit)`; it does not say which of the matching rows get
 * picked, because a bulk write takes no `orderBy` — Prisma's own `limit` has the
 * same hole. Every assertion below is therefore written against the CARDINALITY
 * and against membership in the matching set. Nothing asserts identity, and
 * nothing may start to: the dialects reach the cap by different means (MySQL's
 * native `UPDATE … LIMIT n`, a primary-key subquery everywhere else), so a test
 * that pinned "the first two by id" would pass on PostgreSQL/SQLite and fail on
 * MySQL for a reason that is not a defect.
 *
 * What IS portable and is pinned here:
 *  - the count is `min(matching, limit)` in all three orderings of the pair;
 *  - `limit: 0` affects nothing and returns `{ count: 0 }` / `[]`;
 *  - rows outside the `where` are never touched, at any limit;
 *  - a relation filter composes with the cap (this is the MySQL ERROR 1093 case:
 *    the derived-table wrapper and the native LIMIT have to coexist);
 *  - the `select` arm returns EXACTLY the affected rows, so its length is the
 *    same `min(matching, limit)` and its rows are the ones that actually changed;
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
      await push(client, { force: true });
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    /** Five "keep" rows and two "other" rows that no `where` below matches. */
    const seedCrates = async () => {
      await client!.crate.createMany({
        data: [
          { id: "c1", tag: "keep", qty: 1 },
          { id: "c2", tag: "keep", qty: 2 },
          { id: "c3", tag: "keep", qty: 3 },
          { id: "c4", tag: "keep", qty: 4 },
          { id: "c5", tag: "keep", qty: 5 },
          { id: "o1", tag: "other", qty: 6 },
          { id: "o2", tag: "other", qty: 7 },
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

    test("deleteMany limit below the matching count removes exactly limit rows", async () => {
      await seedCrates();

      const result = await client!.crate.deleteMany({
        where: { tag: "keep" },
        limit: 2,
      });
      expect(result).toEqual({ count: 2 });

      // Three of the five survive — WHICH three is not part of the contract.
      const survivors = await crateIds({ tag: "keep" });
      expect(survivors).toHaveLength(3);
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
      expect(await client!.crate.count({})).toBe(4);
    });

    // -----------------------------------------------------------------------
    // updateMany
    // -----------------------------------------------------------------------

    test("updateMany limit below the matching count updates exactly limit rows", async () => {
      await seedCrates();

      const result = await client!.crate.updateMany({
        where: { tag: "keep" },
        data: { tag: "moved" },
        limit: 2,
      });
      expect(result).toEqual({ count: 2 });

      const moved = await crateIds({ tag: "moved" });
      expect(moved).toHaveLength(2);
      // Every row the cap picked came from the matching set.
      for (const id of moved) {
        expect(["c1", "c2", "c3", "c4", "c5"]).toContain(id);
      }
      expect(await crateIds({ tag: "keep" })).toHaveLength(3);
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

      const bumped = await client!.crate.findMany({
        where: { qty: { gte: 100 } },
        select: { id: true, qty: true },
      });
      expect(bumped).toHaveLength(2);
      // The increment applied once, not once per candidate row.
      for (const row of bumped) {
        expect(row.qty).toBeLessThan(200);
      }
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
          { id: "n1", tag: "keep", qty: 1, depotId: "d1" },
          { id: "n2", tag: "keep", qty: 2, depotId: "d1" },
          { id: "n3", tag: "keep", qty: 3, depotId: "d1" },
          { id: "s1", tag: "keep", qty: 4, depotId: "d2" },
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

      const picked = await crateIds({ tag: "picked" });
      expect(picked).toHaveLength(2);
      for (const id of picked) {
        expect(["n1", "n2", "n3"]).toContain(id);
      }
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

      expect(await crateIds({ depotId: "d1" })).toHaveLength(2);
      expect(await crateIds({ depotId: "d2" })).toEqual(["s1"]);
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

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.tag).toBe("returned");
        expect(["c1", "c2", "c3", "c4", "c5"]).toContain(row.id);
      }
      // The returned rows ARE the changed rows: no more, no fewer.
      const changed = await crateIds({ tag: "returned" });
      expect(changed.sort()).toEqual(rows.map((row) => row.id).sort());
    });

    test("deleteMany with select returns exactly the capped rows", async () => {
      await seedCrates();

      const rows = await client!.crate.deleteMany({
        where: { tag: "keep" },
        limit: 3,
        select: { id: true, qty: true },
      });

      expect(rows).toHaveLength(3);
      const removed = new Set(rows.map((row) => row.id));
      const survivors = await crateIds({ tag: "keep" });
      expect(survivors).toHaveLength(2);
      for (const id of survivors) {
        expect(removed.has(id)).toBe(false);
      }
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

    test("limit works on a model with a compound primary key", async () => {
      await client!.shipment.createMany({
        data: [
          { tenantId: "t1", code: "a", tag: "keep" },
          { tenantId: "t1", code: "b", tag: "keep" },
          { tenantId: "t1", code: "c", tag: "keep" },
          { tenantId: "t2", code: "a", tag: "other" },
        ],
      });

      expect(
        await client!.shipment.updateMany({
          where: { tag: "keep" },
          data: { tag: "compound" },
          limit: 2,
        })
      ).toEqual({ count: 2 });
      expect(await client!.shipment.count({ where: { tag: "compound" } })).toBe(
        2
      );

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

      expect(await crateIds({ tag: "keep" })).toHaveLength(3);
      expect(await crateIds({ tag: "capped" })).toHaveLength(2);
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
