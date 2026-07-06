import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { s } from "@schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const entry = s
  .model({
    id: s.string().id(),
    name: s.string(),
    tags: s.string().array().nullable(),
    scores: s.int().array().nullable(),
    metadata: s.json().nullable(),
  })
  .map("list_json_entries");

const schema = { entry };

type ListJsonClientConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};

type ListJsonClient = VibORMClient<ListJsonClientConfig>;

export interface ListJsonFilterBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

/**
 * Execution-backed checks that list (array) and JSON values behave
 * identically on every dialect across the filter/update boundary:
 * - list equals/not compare whole lists (MySQL used to compare a JSON column
 *   against a stringified param as a JSON string scalar: always false)
 * - list writes work on JSON-backed dialects (SQLite used to throw binding
 *   TypeErrors on raw array params)
 * - push/unshift expand array values element-wise (MySQL JSON_ARRAY_APPEND
 *   used to append the whole array as one stringified element)
 * - has: null never matches on any dialect (Prisma/PG semantics)
 * - json equals/not compare JSON documents (MySQL always-false, SQLite threw)
 */
export function runListJsonFilterBehavior({
  driverName,
  createDriver,
}: ListJsonFilterBehaviorOptions) {
  describe(`${driverName} list/json filter and update behavior`, () => {
    let client: ListJsonClient | undefined;

    beforeEach(async () => {
      client = createClient({ schema, driver: createDriver() });
      await push(client, { force: true });
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    async function seed(): Promise<void> {
      await requireClient(client).entry.createMany({
        data: [
          {
            id: "e1",
            name: "both",
            tags: ["alpha", "beta"],
            scores: [1, 2, 3],
            metadata: { theme: "dark", level: 2 },
          },
          {
            id: "e2",
            name: "single",
            tags: ["gamma"],
            scores: [4, 5],
            metadata: { theme: "light" },
          },
          { id: "e3", name: "empty", tags: [], scores: [] },
          { id: "e4", name: "nulls", tags: null, scores: null },
        ],
      });
    }

    async function findNames(
      where: Record<string, unknown>
    ): Promise<string[]> {
      const rows = await requireClient(client).entry.findMany({ where });
      return rows.map((row) => row.name).sort();
    }

    describe("list round-trip", () => {
      test("create returns real arrays with typed elements", async () => {
        await seed();

        const row = await requireClient(client).entry.findUnique({
          where: { id: "e1" },
        });

        expect(row?.tags).toEqual(["alpha", "beta"]);
        expect(row?.scores).toEqual([1, 2, 3]);
      });

      test("empty and null lists round-trip", async () => {
        await seed();

        const empty = await requireClient(client).entry.findUnique({
          where: { id: "e3" },
        });
        const nulls = await requireClient(client).entry.findUnique({
          where: { id: "e4" },
        });

        expect(empty?.tags).toEqual([]);
        expect(empty?.scores).toEqual([]);
        expect(nulls?.tags).toBeNull();
        expect(nulls?.scores).toBeNull();
      });
    });

    describe("list filters", () => {
      test("equals matches the exact list", async () => {
        await seed();
        expect(
          await findNames({ tags: { equals: ["alpha", "beta"] } })
        ).toEqual(["both"]);
      });

      test("equals is order-sensitive", async () => {
        await seed();
        expect(
          await findNames({ tags: { equals: ["beta", "alpha"] } })
        ).toEqual([]);
      });

      test("equals matches empty lists", async () => {
        await seed();
        expect(await findNames({ tags: { equals: [] } })).toEqual(["empty"]);
      });

      test("equals matches int lists", async () => {
        await seed();
        expect(await findNames({ scores: { equals: [1, 2, 3] } })).toEqual([
          "both",
        ]);
      });

      test("equals null matches null lists only", async () => {
        await seed();
        expect(await findNames({ tags: { equals: null } })).toEqual(["nulls"]);
      });

      test("not excludes the matching list and null lists", async () => {
        await seed();
        // SQL <> semantics shared by all dialects: NULL lists are not
        // considered (Prisma documents the same for NOT on scalar lists)
        expect(await findNames({ tags: { not: ["gamma"] } })).toEqual([
          "both",
          "empty",
        ]);
      });

      test("has matches string elements", async () => {
        await seed();
        expect(await findNames({ tags: { has: "beta" } })).toEqual(["both"]);
      });

      test("has matches int elements", async () => {
        await seed();
        expect(await findNames({ scores: { has: 5 } })).toEqual(["single"]);
      });

      test("has with no match returns empty", async () => {
        await seed();
        expect(await findNames({ tags: { has: "missing" } })).toEqual([]);
      });

      test("has null is rejected consistently", async () => {
        await seed();
        // Validation rejects a null candidate on every dialect. If it ever
        // reaches SQL it must never match (Prisma/PG semantics) — the
        // where-builder short-circuits it to FALSE as defense in depth.
        await expect(
          requireClient(client).entry.findMany({
            // @ts-expect-error has: null is rejected at the type level too
            where: { tags: { has: null } },
          })
        ).rejects.toThrow(/Validation failed/);
      });

      test("hasEvery requires all elements", async () => {
        await seed();
        expect(
          await findNames({ tags: { hasEvery: ["beta", "alpha"] } })
        ).toEqual(["both"]);
        expect(
          await findNames({ tags: { hasEvery: ["alpha", "missing"] } })
        ).toEqual([]);
      });

      test("hasSome requires any element", async () => {
        await seed();
        expect(
          await findNames({ tags: { hasSome: ["beta", "missing"] } })
        ).toEqual(["both"]);
        expect(await findNames({ tags: { hasSome: ["missing"] } })).toEqual([]);
      });

      test("isEmpty treats null lists as empty on every dialect", async () => {
        await seed();
        // All three adapters deliberately fold NULL into isEmpty: true
        // (`... = 0 OR col IS NULL`); pinned so no dialect drifts
        expect(await findNames({ tags: { isEmpty: true } })).toEqual([
          "empty",
          "nulls",
        ]);
        expect(await findNames({ tags: { isEmpty: false } })).toEqual([
          "both",
          "single",
        ]);
      });
    });

    describe("list updates", () => {
      test("set replaces the whole list", async () => {
        await seed();

        const updated = await requireClient(client).entry.update({
          where: { id: "e1" },
          data: { tags: { set: ["x", "y"] } },
        });

        expect(updated?.tags).toEqual(["x", "y"]);
      });

      test("push appends a single value", async () => {
        await seed();

        const updated = await requireClient(client).entry.update({
          where: { id: "e1" },
          data: { tags: { push: "gamma" } },
        });

        expect(updated?.tags).toEqual(["alpha", "beta", "gamma"]);
      });

      test("push expands an array value element-wise", async () => {
        await seed();

        const updated = await requireClient(client).entry.update({
          where: { id: "e1" },
          data: { tags: { push: ["gamma", "delta"] } },
        });

        expect(updated?.tags).toEqual(["alpha", "beta", "gamma", "delta"]);
      });

      test("push appends int elements", async () => {
        await seed();

        const updated = await requireClient(client).entry.update({
          where: { id: "e1" },
          data: { scores: { push: [4, 5] } },
        });

        expect(updated?.scores).toEqual([1, 2, 3, 4, 5]);
      });

      test("push onto an empty list", async () => {
        await seed();

        const updated = await requireClient(client).entry.update({
          where: { id: "e3" },
          data: { tags: { push: "first" } },
        });

        expect(updated?.tags).toEqual(["first"]);
      });

      test("push onto a null list creates the list", async () => {
        await seed();

        const updated = await requireClient(client).entry.update({
          where: { id: "e4" },
          data: { tags: { push: ["a", "b"] } },
        });

        expect(updated?.tags).toEqual(["a", "b"]);
      });

      test("unshift prepends a single value", async () => {
        await seed();

        const updated = await requireClient(client).entry.update({
          where: { id: "e1" },
          data: { tags: { unshift: "zeta" } },
        });

        expect(updated?.tags).toEqual(["zeta", "alpha", "beta"]);
      });

      test("unshift expands an array value element-wise", async () => {
        await seed();

        const updated = await requireClient(client).entry.update({
          where: { id: "e1" },
          data: { tags: { unshift: ["y", "z"] } },
        });

        expect(updated?.tags).toEqual(["y", "z", "alpha", "beta"]);
      });
    });

    describe("json filters", () => {
      test("equals matches the exact document", async () => {
        await seed();
        expect(
          await findNames({
            metadata: { equals: { theme: "dark", level: 2 } },
          })
        ).toEqual(["both"]);
      });

      test("equals does not match a partial document", async () => {
        await seed();
        expect(
          await findNames({ metadata: { equals: { theme: "dark" } } })
        ).toEqual([]);
      });

      test("equals null matches null json only", async () => {
        await seed();
        expect(await findNames({ metadata: { equals: null } })).toEqual([
          "empty",
          "nulls",
        ]);
      });

      test("not equals excludes the matching document and nulls", async () => {
        await seed();
        expect(
          await findNames({
            metadata: { not: { equals: { theme: "light" } } },
          })
        ).toEqual(["both"]);
      });
    });

    describe("json path filters", () => {
      // Separate corpus: object docs, a string root, an array root, and a
      // NULL column, so every operator is checked against every value shape
      async function seedJsonDocs(): Promise<void> {
        await requireClient(client).entry.createMany({
          data: [
            {
              id: "j1",
              name: "dark",
              metadata: {
                theme: "dark",
                level: 2,
                pet: { name: "Fido", toys: ["ball", "rope"] },
                tags: ["admin", "beta"],
                "weird.key": { 'quote"key': "gotcha" },
              },
            },
            {
              id: "j2",
              name: "light",
              metadata: {
                theme: "lightish",
                level: 5,
                pet: { name: "Rex", toys: ["bone"] },
                tags: ["user"],
                nullable: null,
              },
            },
            { id: "j3", name: "string-root", metadata: "just a string" },
            { id: "j4", name: "array-root", metadata: ["alpha", "beta"] },
            { id: "j5", name: "missing", metadata: null },
          ],
        });
      }

      test("equals at a path matches the scoped value", async () => {
        await seedJsonDocs();
        expect(
          await findNames({ metadata: { path: ["theme"], equals: "dark" } })
        ).toEqual(["dark"]);
      });

      test("equals at a nested path", async () => {
        await seedJsonDocs();
        expect(
          await findNames({
            metadata: { path: ["pet", "name"], equals: "Fido" },
          })
        ).toEqual(["dark"]);
      });

      test("equals at a path matches numbers", async () => {
        await seedJsonDocs();
        expect(
          await findNames({ metadata: { path: ["level"], equals: 5 } })
        ).toEqual(["light"]);
      });

      test("equals at a path matches whole sub-documents", async () => {
        await seedJsonDocs();
        expect(
          await findNames({
            metadata: {
              path: ["pet"],
              equals: { name: "Fido", toys: ["ball", "rope"] },
            },
          })
        ).toEqual(["dark"]);
      });

      test("equals at a missing path matches nothing", async () => {
        await seedJsonDocs();
        expect(
          await findNames({ metadata: { path: ["nope"], equals: "dark" } })
        ).toEqual([]);
      });

      test("equals null at a path matches JSON null, not missing keys", async () => {
        await seedJsonDocs();
        expect(
          await findNames({ metadata: { path: ["nullable"], equals: null } })
        ).toEqual(["light"]);
      });

      test("integer path segments address array elements", async () => {
        await seedJsonDocs();
        expect(
          await findNames({
            metadata: { path: ["pet", "toys", "0"], equals: "ball" },
          })
        ).toEqual(["dark"]);
        expect(
          await findNames({ metadata: { path: ["0"], equals: "alpha" } })
        ).toEqual(["array-root"]);
      });

      test("path segments with dots stay literal", async () => {
        await seedJsonDocs();
        expect(
          await findNames({
            metadata: {
              path: ["weird.key"],
              equals: { 'quote"key': "gotcha" },
            },
          })
        ).toEqual(["dark"]);
      });

      test("path segments cannot splice extra path legs", async () => {
        await seedJsonDocs();
        // A segment with quotes/path syntax must be taken as one literal
        // key (or match nothing), never re-parsed into multiple legs
        expect(
          await findNames({
            metadata: { path: ['pet".name'], equals: "Fido" },
          })
        ).toEqual([]);
        expect(
          await findNames({
            metadata: { path: ["pet.name"], equals: "Fido" },
          })
        ).toEqual([]);
        expect(
          await findNames({
            metadata: { path: ["pet", 'toys"[0]'], equals: "ball" },
          })
        ).toEqual([]);
      });

      test("string_contains at a path", async () => {
        await seedJsonDocs();
        expect(
          await findNames({
            metadata: { path: ["theme"], string_contains: "ight" },
          })
        ).toEqual(["light"]);
      });

      test("string_starts_with and string_ends_with combine as AND", async () => {
        await seedJsonDocs();
        expect(
          await findNames({
            metadata: { path: ["theme"], string_starts_with: "light" },
          })
        ).toEqual(["light"]);
        expect(
          await findNames({
            metadata: { path: ["theme"], string_ends_with: "ish" },
          })
        ).toEqual(["light"]);
        expect(
          await findNames({
            metadata: {
              path: ["theme"],
              string_starts_with: "light",
              string_ends_with: "ish",
            },
          })
        ).toEqual(["light"]);
      });

      test("string ops treat LIKE wildcards as literals", async () => {
        await seedJsonDocs();
        expect(
          await findNames({
            metadata: { path: ["theme"], string_contains: "%" },
          })
        ).toEqual([]);
        expect(
          await findNames({
            metadata: { path: ["theme"], string_contains: "_ark" },
          })
        ).toEqual([]);
      });

      test("string_contains without a path matches string roots", async () => {
        await seedJsonDocs();
        expect(
          await findNames({ metadata: { string_contains: "just a" } })
        ).toEqual(["string-root"]);
      });

      test("array_contains requires every candidate element", async () => {
        await seedJsonDocs();
        expect(
          await findNames({
            metadata: { path: ["tags"], array_contains: ["admin"] },
          })
        ).toEqual(["dark"]);
        expect(
          await findNames({
            metadata: { path: ["tags"], array_contains: ["beta", "admin"] },
          })
        ).toEqual(["dark"]);
        expect(
          await findNames({
            metadata: { path: ["tags"], array_contains: ["admin", "nope"] },
          })
        ).toEqual([]);
      });

      test("array_contains accepts a scalar candidate", async () => {
        await seedJsonDocs();
        expect(
          await findNames({
            metadata: { path: ["tags"], array_contains: "user" },
          })
        ).toEqual(["light"]);
      });

      test("array_contains without a path matches array roots only", async () => {
        await seedJsonDocs();
        expect(
          await findNames({ metadata: { array_contains: ["beta"] } })
        ).toEqual(["array-root"]);
      });

      test("array_starts_with matches the first element", async () => {
        await seedJsonDocs();
        expect(
          await findNames({
            metadata: { path: ["tags"], array_starts_with: "admin" },
          })
        ).toEqual(["dark"]);
        expect(
          await findNames({ metadata: { array_starts_with: "alpha" } })
        ).toEqual(["array-root"]);
      });

      test("array_ends_with matches the last element", async () => {
        await seedJsonDocs();
        expect(
          await findNames({
            metadata: { path: ["tags"], array_ends_with: "beta" },
          })
        ).toEqual(["dark"]);
        expect(
          await findNames({ metadata: { array_ends_with: "beta" } })
        ).toEqual(["array-root"]);
      });

      test("not at a path inherits the path", async () => {
        await seedJsonDocs();
        // Rows without the path (string/array roots, NULL column) extract
        // to SQL NULL and are excluded, matching SQL NOT semantics
        expect(
          await findNames({
            metadata: { path: ["theme"], not: { equals: "dark" } },
          })
        ).toEqual(["light"]);
      });
    });
  });
}

function requireClient(client: ListJsonClient | undefined): ListJsonClient {
  if (!client) {
    throw new Error("List/json test client was not initialized.");
  }
  return client;
}
