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

const author = s
  .model({
    id: s.string().id(),
    name: s.string(),
    rank: s.int().nullable(),
    tags: s.string().array().nullable(),
    scores: s.int().array().nullable(),
    books: s.toMany(() => book),
  })
  .map("ordering_array_authors");

const book = s
  .model({
    id: s.string().id(),
    title: s.string(),
    pages: s.int(),
    authorId: s.string(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
  })
  .map("ordering_array_books");

const counter = s
  .model({
    id: s.int().id().increment(),
    label: s.string().unique(),
  })
  .map("ordering_array_counters");

const schema = { author, book, counter };

type OrderingArrayCreateClientConfig = VibORMConfig<typeof schema>;

type OrderingArrayCreateClient = VibORMClient<OrderingArrayCreateClientConfig>;

export interface OrderingArrayCreateBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

/**
 * Cross-driver regressions surfaced on MySQL:
 * - ordered to-many includes (MySQL merges unlimited derived tables, dropping
 *   their ORDER BY before JSON_ARRAYAGG)
 * - orderBy nulls first/last (no native NULLS FIRST/LAST on MySQL/SQLite)
 * - array `has` filter (JSON_CONTAINS needs a JSON candidate, not a bare string)
 * - auto-increment create refetch (SELECT LAST_INSERT_ID() races on pools)
 */
export function runOrderingArrayCreateBehavior({
  driverName,
  createDriver,
}: OrderingArrayCreateBehaviorOptions) {
  describe(`${driverName} ordering/array/create behavior`, () => {
    let client: OrderingArrayCreateClient | undefined;

    beforeEach(async () => {
      client = createClient({ schema, driver: createDriver() });
      await syncLiveSchema(client);
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    async function seedBooks(): Promise<void> {
      // Physical insert order deliberately disagrees with both id order and
      // pages order, so an unordered aggregation is detectable.
      await requireClient(client).author.create({
        data: {
          id: "author-1",
          name: "Alice",
          books: {
            createMany: {
              data: [
                { id: "book-3", title: "Gamma", pages: 300 },
                { id: "book-1", title: "Alpha", pages: 100 },
                { id: "book-5", title: "Epsilon", pages: 500 },
                { id: "book-2", title: "Beta", pages: 200 },
                { id: "book-4", title: "Delta", pages: 400 },
              ],
            },
          },
        },
      });
    }

    test("to-many include honors ascending orderBy", async () => {
      await seedBooks();

      const result = await requireClient(client).author.findUnique({
        where: { id: "author-1" },
        include: { books: { orderBy: { pages: "asc" } } },
      });

      expect(result?.books.map((entry) => entry.title)).toEqual([
        "Alpha",
        "Beta",
        "Gamma",
        "Delta",
        "Epsilon",
      ]);
    });

    test("to-many include honors descending orderBy", async () => {
      await seedBooks();

      const result = await requireClient(client).author.findUnique({
        where: { id: "author-1" },
        include: { books: { orderBy: { pages: "desc" } } },
      });

      expect(result?.books.map((entry) => entry.title)).toEqual([
        "Epsilon",
        "Delta",
        "Gamma",
        "Beta",
        "Alpha",
      ]);
    });

    test("to-many include honors orderBy with skip and no take", async () => {
      await seedBooks();

      const result = await requireClient(client).author.findUnique({
        where: { id: "author-1" },
        include: { books: { orderBy: { pages: "asc" }, skip: 2 } },
      });

      expect(result?.books.map((entry) => entry.title)).toEqual([
        "Gamma",
        "Delta",
        "Epsilon",
      ]);
    });

    async function seedRanks(): Promise<void> {
      const seeded = requireClient(client);
      await seeded.author.create({
        data: { id: "author-1", name: "NoRank", rank: null },
      });
      await seeded.author.create({
        data: { id: "author-2", name: "Third", rank: 3 },
      });
      await seeded.author.create({
        data: { id: "author-3", name: "First", rank: 1 },
      });
    }

    test("orderBy asc with nulls last places null rows at the end", async () => {
      await seedRanks();

      const result = await requireClient(client).author.findMany({
        orderBy: { rank: { sort: "asc", nulls: "last" } },
      });

      expect(result.map((entry) => entry.name)).toEqual([
        "First",
        "Third",
        "NoRank",
      ]);
    });

    test("orderBy desc with nulls first places null rows at the start", async () => {
      await seedRanks();

      const result = await requireClient(client).author.findMany({
        orderBy: { rank: { sort: "desc", nulls: "first" } },
      });

      expect(result.map((entry) => entry.name)).toEqual([
        "NoRank",
        "Third",
        "First",
      ]);
    });

    test("orderBy asc with nulls first places null rows at the start", async () => {
      await seedRanks();

      const result = await requireClient(client).author.findMany({
        orderBy: { rank: { sort: "asc", nulls: "first" } },
      });

      expect(result.map((entry) => entry.name)).toEqual([
        "NoRank",
        "First",
        "Third",
      ]);
    });

    async function seedArrays(): Promise<void> {
      const seeded = requireClient(client);
      await seeded.author.create({
        data: {
          id: "author-1",
          name: "Tagged",
          tags: ["alpha", "beta"],
          scores: [1, 2, 3],
        },
      });
      await seeded.author.create({
        data: {
          id: "author-2",
          name: "Other",
          tags: ["gamma"],
          scores: [4, 5],
        },
      });
    }

    test("has filter matches string array elements", async () => {
      await seedArrays();

      const result = await requireClient(client).author.findMany({
        where: { tags: { has: "beta" } },
      });

      expect(result.map((entry) => entry.name)).toEqual(["Tagged"]);
    });

    test("has filter matches int array elements", async () => {
      await seedArrays();

      const result = await requireClient(client).author.findMany({
        where: { scores: { has: 5 } },
      });

      expect(result.map((entry) => entry.name)).toEqual(["Other"]);
    });

    test("has filter with no match returns empty", async () => {
      await seedArrays();

      const result = await requireClient(client).author.findMany({
        where: { tags: { has: "missing" } },
      });

      expect(result).toEqual([]);
    });

    test("create returns the auto-increment row", async () => {
      const created = await requireClient(client).counter.create({
        data: { label: "solo" },
      });

      expect(created.label).toBe("solo");
      expect(created.id).toBeGreaterThan(0);
    });

    test("concurrent creates each return their own row", async () => {
      const labels = Array.from({ length: 10 }, (_, i) => `label-${i}`);

      // Outside a transaction: each returned row must match the data it was
      // created with, even when refetching by generated id on a pool.
      const created = await Promise.all(
        labels.map((label) =>
          requireClient(client).counter.create({ data: { label } })
        )
      );

      const ids = new Set(created.map((entry) => entry.id));
      expect(ids.size).toBe(labels.length);

      for (const [index, label] of labels.entries()) {
        expect(created[index]?.label).toBe(label);
        const persisted = await requireClient(client).counter.findUnique({
          where: { id: created[index]!.id },
        });
        expect(persisted?.label).toBe(label);
      }
    });
  });
}

function requireClient(
  client: OrderingArrayCreateClient | undefined
): OrderingArrayCreateClient {
  if (!client) {
    throw new Error("Ordering/array/create test client was not initialized.");
  }
  return client;
}

export const orderingArrayCreateContract = defineContract({
  id: "drivers.ordering-array-create",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runOrderingArrayCreateBehavior,
});
