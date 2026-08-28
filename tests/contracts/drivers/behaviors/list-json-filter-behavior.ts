import { defineContract } from "@tests/contracts/contract";
import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";

import { DbNull, s } from "@schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

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
      await syncLiveSchema(client);
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
                literal: "100%_\\done",
                accent: "Éclair",
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
            { id: "j5", name: "missing", metadata: DbNull },
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

      test("non-portable JSON path segments reject before execution", async () => {
        await seedJsonDocs();
        await expect(
          findNames({
            metadata: { path: ['pet".name'], equals: "Fido" },
          })
        ).rejects.toThrow("portable JSON path");
        await expect(
          findNames({
            metadata: { path: ["pet\\name"], equals: "Fido" },
          })
        ).rejects.toThrow("portable JSON path");
        expect(await requireClient(client).entry.count()).toBe(5);
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

      test("JSON string ops are exact across case, wildcards, and Unicode", async () => {
        await seedJsonDocs();
        expect(
          await findNames({
            metadata: { path: ["theme"], string_contains: "ARK" },
          })
        ).toEqual([]);
        expect(
          await findNames({
            metadata: { path: ["literal"], string_contains: "%_\\" },
          })
        ).toEqual(["dark"]);
        expect(
          await findNames({
            metadata: { path: ["accent"], string_starts_with: "Écl" },
          })
        ).toEqual(["dark"]);
        expect(
          await findNames({
            metadata: { path: ["accent"], string_starts_with: "écl" },
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

      describe("mode: insensitive", () => {
        test("folds ASCII A-Z on all three string operators", async () => {
          await seedJsonDocs();
          expect(
            await findNames({
              metadata: {
                path: ["theme"],
                string_contains: "ARK",
                mode: "insensitive",
              },
            })
          ).toEqual(["dark"]);
          expect(
            await findNames({
              metadata: {
                path: ["theme"],
                string_starts_with: "LIGHT",
                mode: "insensitive",
              },
            })
          ).toEqual(["light"]);
          expect(
            await findNames({
              metadata: {
                path: ["theme"],
                string_ends_with: "ISH",
                mode: "insensitive",
              },
            })
          ).toEqual(["light"]);
        });

        test("mode: default keeps the exact-text contract", async () => {
          await seedJsonDocs();
          expect(
            await findNames({
              metadata: {
                path: ["theme"],
                string_contains: "ARK",
                mode: "default",
              },
            })
          ).toEqual([]);
        });

        test("folds ASCII only — accents are never case-folded", async () => {
          await seedJsonDocs();
          // 'Écl' folds to 'Écl' (É is outside A-Z), so it still matches
          expect(
            await findNames({
              metadata: {
                path: ["accent"],
                string_starts_with: "ÉCL",
                mode: "insensitive",
              },
            })
          ).toEqual(["dark"]);
          // 'écl' does NOT fold to 'Écl' — same ASCII-only contract the
          // scalar insensitive filters pin in prisma-parity-behavior
          expect(
            await findNames({
              metadata: {
                path: ["accent"],
                string_starts_with: "écl",
                mode: "insensitive",
              },
            })
          ).toEqual([]);
        });

        test("wildcards stay literal under the fold", async () => {
          await seedJsonDocs();
          expect(
            await findNames({
              metadata: {
                path: ["literal"],
                string_contains: "%_\\DONE",
                mode: "insensitive",
              },
            })
          ).toEqual(["dark"]);
        });

        test("a nested not inherits the mode", async () => {
          await seedJsonDocs();
          // Only rows that HAVE $.theme and do not contain 'ark' survive
          expect(
            await findNames({
              metadata: {
                path: ["theme"],
                mode: "insensitive",
                not: { string_contains: "ARK" },
              },
            })
          ).toEqual(["light"]);
        });

        test("a nested not may override the inherited mode", async () => {
          await seedJsonDocs();
          // The inner arm is case-sensitive, so 'ARK' matches nothing and
          // NOT(false) keeps every row that has $.theme
          expect(
            await findNames({
              metadata: {
                path: ["theme"],
                mode: "insensitive",
                string_contains: "",
                not: { string_contains: "ARK", mode: "default" },
              },
            })
          ).toEqual(["dark", "light"]);
        });

        test("string paths carry the mode too", async () => {
          await seedJsonDocs();
          expect(
            await findNames({
              metadata: {
                path: "$.theme",
                string_contains: "ARK",
                mode: "insensitive",
              },
            })
          ).toEqual(["dark"]);
        });

        test("an inert mode is refused, not ignored", async () => {
          await seedJsonDocs();
          await expect(
            findNames({
              metadata: {
                path: ["theme"],
                equals: "dark",
                mode: "insensitive",
              },
            })
          ).rejects.toThrow("mode: 'insensitive'");
          expect(await requireClient(client).entry.count()).toBe(5);
        });
      });
    });

    describe("json string paths ('$.a.b')", () => {
      // Same corpus as the array-form path tests, so every assertion here
      // can be read as "the string form is the array form"
      async function seedStringPathDocs(): Promise<void> {
        await requireClient(client).entry.createMany({
          data: [
            {
              id: "p1",
              name: "dark",
              metadata: {
                theme: "dark",
                level: 2,
                pet: { name: "Fido", toys: ["ball", "rope"] },
                "weird.key": "gotcha",
              },
            },
            { id: "p2", name: "string-root", metadata: "just a string" },
            { id: "p3", name: "array-root", metadata: ["alpha", "beta"] },
          ],
        });
      }

      test("dot paths equal their array form", async () => {
        await seedStringPathDocs();
        expect(
          await findNames({ metadata: { path: "$.theme", equals: "dark" } })
        ).toEqual(
          await findNames({ metadata: { path: ["theme"], equals: "dark" } })
        );
        expect(
          await findNames({ metadata: { path: "$.pet.name", equals: "Fido" } })
        ).toEqual(["dark"]);
      });

      test("bracket segments address array elements", async () => {
        await seedStringPathDocs();
        expect(
          await findNames({
            metadata: { path: "$.pet.toys[0]", equals: "ball" },
          })
        ).toEqual(["dark"]);
        expect(
          await findNames({ metadata: { path: "$[1]", equals: "beta" } })
        ).toEqual(["array-root"]);
      });

      test("'$' alone is the document root", async () => {
        await seedStringPathDocs();
        expect(
          await findNames({ metadata: { path: "$", string_contains: "just" } })
        ).toEqual(["string-root"]);
      });

      test("every operator accepts the string form", async () => {
        await seedStringPathDocs();
        expect(
          await findNames({ metadata: { path: "$.level", gte: 2 } })
        ).toEqual(["dark"]);
        expect(
          await findNames({
            metadata: { path: "$.pet.toys", array_contains: "rope" },
          })
        ).toEqual(["dark"]);
        expect(
          await findNames({
            metadata: { path: "$.theme", not: { equals: "dark" } },
          })
        ).toEqual([]);
      });

      test("a dot is always a separator — literal dots need the array form", async () => {
        await seedStringPathDocs();
        // '$.weird.key' walks two steps and finds nothing; the array form is
        // the only way to address a key that contains a dot
        expect(
          await findNames({
            metadata: { path: "$.weird.key", equals: "gotcha" },
          })
        ).toEqual([]);
        expect(
          await findNames({
            metadata: { path: ["weird.key"], equals: "gotcha" },
          })
        ).toEqual(["dark"]);
      });

      test("unsupported path grammar rejects before execution", async () => {
        await seedStringPathDocs();
        for (const path of [
          "theme",
          "$.",
          "$.a.",
          "$theme",
          "$.a[",
          "$.a[]",
          "$.a[last]",
          "$.a[-1]",
          "$.a[*]",
          "$.*",
        ]) {
          await expect(
            findNames({ metadata: { path, equals: "dark" } })
          ).rejects.toThrow("unsupported path string");
        }
        expect(await requireClient(client).entry.count()).toBe(3);
      });

      test("quoted labels keep the portable-path refusal", async () => {
        await seedStringPathDocs();
        // The parsed segment carries a '"', which no dialect can address
        await expect(
          findNames({ metadata: { path: '$."a b"', equals: "x" } })
        ).rejects.toThrow("portable JSON path");
        await expect(
          findNames({ metadata: { path: "$.a\\b", equals: "x" } })
        ).rejects.toThrow("portable JSON path");
      });
    });

    describe("json comparison filters (lt/lte/gt/gte)", () => {
      // Every JSON value shape sits at the SAME path ($.score) so one filter
      // sweeps them all: the operand's JS class decides which rows can match
      // and every other shape must drop out silently on every dialect.
      async function seedComparisonDocs(): Promise<void> {
        await requireClient(client).entry.createMany({
          data: [
            { id: "c1", name: "num-1", metadata: { score: 1 } },
            { id: "c2", name: "num-2.5", metadata: { score: 2.5 } },
            { id: "c3", name: "num-10", metadata: { score: 10 } },
            { id: "c4", name: "numeric-string", metadata: { score: "10" } },
            { id: "c5", name: "str-apple", metadata: { score: "apple" } },
            { id: "c6", name: "str-Banana", metadata: { score: "Banana" } },
            { id: "c7", name: "str-accent", metadata: { score: "Éclair" } },
            { id: "c8", name: "bool", metadata: { score: true } },
            { id: "c9", name: "json-null", metadata: { score: null } },
            { id: "c10", name: "absent", metadata: { other: 1 } },
            { id: "c11", name: "null-column", metadata: DbNull },
            {
              id: "c12",
              name: "nested",
              metadata: { deep: { score: 7 }, list: [3, 8] },
            },
            { id: "c13", name: "num-root", metadata: 42 },
            { id: "c14", name: "str-root", metadata: "zebra" },
          ],
        });
      }

      test("numeric operands compare numbers only", async () => {
        await seedComparisonDocs();
        expect(
          await findNames({ metadata: { path: ["score"], gt: 2 } })
        ).toEqual(["num-10", "num-2.5"]);
        expect(
          await findNames({ metadata: { path: ["score"], gte: 2.5 } })
        ).toEqual(["num-10", "num-2.5"]);
        expect(
          await findNames({ metadata: { path: ["score"], lt: 2.5 } })
        ).toEqual(["num-1"]);
        expect(
          await findNames({ metadata: { path: ["score"], lte: 2.5 } })
        ).toEqual(["num-1", "num-2.5"]);
      });

      test("numeric operands never match a numeric string or other types", async () => {
        await seedComparisonDocs();
        // gt: 0 would sweep every row if strings/bools/null/absent leaked
        // into the numeric comparison class
        expect(
          await findNames({ metadata: { path: ["score"], gt: 0 } })
        ).toEqual(["num-1", "num-10", "num-2.5"]);
        // "10" is a JSON string: it is not a number, on any dialect
        expect(
          await findNames({ metadata: { path: ["score"], gte: 10 } })
        ).toEqual(["num-10"]);
      });

      test("string operands compare strings only, by code point", async () => {
        await seedComparisonDocs();
        expect(
          await findNames({ metadata: { path: ["score"], gt: "" } })
        ).toEqual(["numeric-string", "str-Banana", "str-accent", "str-apple"]);
        expect(
          await findNames({ metadata: { path: ["score"], lt: "apple" } })
        ).toEqual(["numeric-string", "str-Banana"]);
        expect(
          await findNames({ metadata: { path: ["score"], gte: "apple" } })
        ).toEqual(["str-accent", "str-apple"]);
      });

      test("string ordering is byte order, not the database's locale collation", async () => {
        await seedComparisonDocs();
        // Locale collations (en_US and friends) sort 'Banana' AFTER 'a';
        // code-point order puts every uppercase ASCII letter before 'a'
        expect(
          await findNames({ metadata: { path: ["score"], gt: "a" } })
        ).toEqual(["str-accent", "str-apple"]);
        // Non-ASCII UTF-8 bytes (0xC3…) outrank every ASCII byte
        expect(
          await findNames({ metadata: { path: ["score"], gt: "zzz" } })
        ).toEqual(["str-accent"]);
      });

      test("mixed operand classes never cross", async () => {
        await seedComparisonDocs();
        // The number 10 is not > the string "9"; the string "10" is not < 11
        expect(
          await findNames({ metadata: { path: ["score"], gt: "9" } })
        ).toEqual(["str-Banana", "str-accent", "str-apple"]);
        expect(
          await findNames({ metadata: { path: ["score"], lt: 11 } })
        ).toEqual(["num-1", "num-10", "num-2.5"]);
      });

      test("absent paths and NULL columns never match and never error", async () => {
        await seedComparisonDocs();
        expect(
          await findNames({ metadata: { path: ["nope"], gt: 0 } })
        ).toEqual([]);
        expect(
          await findNames({ metadata: { path: ["nope"], gt: "" } })
        ).toEqual([]);
        expect(
          await findNames({ metadata: { path: ["deep", "missing"], lt: 100 } })
        ).toEqual([]);
        expect(await requireClient(client).entry.count()).toBe(14);
      });

      test("comparisons combine as AND inside one filter object", async () => {
        await seedComparisonDocs();
        expect(
          await findNames({ metadata: { path: ["score"], gt: 1, lt: 10 } })
        ).toEqual(["num-2.5"]);
        expect(
          await findNames({
            metadata: { path: ["score"], gte: 1, lte: 2.5 },
          })
        ).toEqual(["num-1", "num-2.5"]);
      });

      test("comparisons reach nested objects and array indices", async () => {
        await seedComparisonDocs();
        expect(
          await findNames({ metadata: { path: ["deep", "score"], gte: 7 } })
        ).toEqual(["nested"]);
        expect(
          await findNames({ metadata: { path: ["list", "1"], gt: 5 } })
        ).toEqual(["nested"]);
        expect(
          await findNames({ metadata: { path: ["list", "0"], gt: 5 } })
        ).toEqual([]);
      });

      test("comparisons without a path apply to the document root", async () => {
        await seedComparisonDocs();
        expect(await findNames({ metadata: { gt: 40 } })).toEqual(["num-root"]);
        expect(await findNames({ metadata: { lt: "zzz" } })).toEqual([
          "str-root",
        ]);
      });

      test("not inherits the path and drops non-comparable rows", async () => {
        await seedComparisonDocs();
        // NOT(NULL) is NULL, so only rows that ARE numbers and fail the
        // comparison survive — the same shape as `not` on equals
        expect(
          await findNames({ metadata: { path: ["score"], not: { gt: 2 } } })
        ).toEqual(["num-1"]);
      });

      test("non-number, non-string operands reject before execution", async () => {
        await seedComparisonDocs();
        await expect(
          findNames({ metadata: { path: ["score"], gt: true } })
        ).rejects.toThrow();
        expect(await requireClient(client).entry.count()).toBe(14);
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

export const listJsonFilterContract = defineContract({
  id: "drivers.list-json-filter",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runListJsonFilterBehavior,
});
