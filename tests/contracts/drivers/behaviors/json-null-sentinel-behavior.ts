import { defineContract } from "@tests/contracts/contract";
import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";

import { AnyNull, DbNull, JsonNull, s } from "@schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

const entry = s
  .model({
    id: s.string().id(),
    name: s.string(),
    meta: s.json().nullable(),
    required: s.json(),
  })
  .map("json_null_sentinel_entries");

const schema = { entry };

const AMBIGUOUS_NULL = /null is ambiguous/;
const ANY_NULL_WRITE = /AnyNull is not supported/;
const DB_NULL_NOT_NULLABLE = /DbNull is not supported/;
const VALIDATION_FAILED = /Validation failed/;
const PATH_WITH_DB_NULL = /cannot combine 'path' with the DbNull sentinel/;
const PATH_WITH_JSON_NULL = /cannot combine 'path' with the JsonNull sentinel/;
const INERT_MODE = /mode: 'insensitive'/;

type SentinelClientConfig = VibORMConfig<typeof schema>;

type SentinelClient = VibORMClient<SentinelClientConfig>;

export interface JsonNullSentinelBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

/**
 * Execution-backed proof that the two nulls of a JSON column stay DIFFERENT
 * values on every dialect, and that the same six predicates separate them
 * everywhere:
 *
 *   equals: DbNull    ->  the column holds no document (SQL NULL)
 *   equals: JsonNull  ->  the column holds the JSON document `null`
 *   equals: AnyNull   ->  either
 *   not: <sentinel>   ->  the complement of each, under SQL NULL semantics
 *
 * The storage side is checked THROUGH those predicates rather than through raw
 * SQL, because the raw spelling is exactly what differs: PG stores
 * `'null'::jsonb`, MySQL a JSON null, SQLite the canonical text `null`. If a
 * dialect ever collapsed the two nulls into one, `equals: DbNull` and
 * `equals: JsonNull` would stop partitioning the table and these tests fail.
 *
 * It also pins what did NOT change: a bare `null` in FILTER position still
 * means what it meant before the sentinels existed (the SQL NULL at the root,
 * the JSON null under a `path`).
 */
export function runJsonNullSentinelBehavior({
  driverName,
  createDriver,
}: JsonNullSentinelBehaviorOptions) {
  describe(`${driverName} json null sentinel behavior`, () => {
    let client: SentinelClient | undefined;

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

    function requireClient(value: SentinelClient | undefined): SentinelClient {
      if (!value) throw new Error("client not initialized");
      return value;
    }

    async function seed(): Promise<void> {
      await requireClient(client).entry.createMany({
        data: [
          { id: "db", name: "db-null", meta: DbNull, required: { r: 1 } },
          { id: "js", name: "json-null", meta: JsonNull, required: { r: 1 } },
          { id: "doc", name: "doc", meta: { a: 1 }, required: { r: 1 } },
          {
            id: "nest",
            name: "nested-null",
            meta: { a: null },
            required: { r: 1 },
          },
          { id: "omit", name: "omitted", required: { r: 1 } },
        ],
      });
    }

    async function findIds(where: Record<string, unknown>): Promise<string[]> {
      const rows = await requireClient(client).entry.findMany({ where });
      return rows.map((row) => row.id).sort();
    }

    describe("the truth table", () => {
      test("equals DbNull matches the SQL NULLs only", async () => {
        await seed();
        expect(await findIds({ meta: { equals: DbNull } })).toEqual([
          "db",
          "omit",
        ]);
      });

      test("equals JsonNull matches the stored JSON null only", async () => {
        await seed();
        expect(await findIds({ meta: { equals: JsonNull } })).toEqual(["js"]);
      });

      test("equals AnyNull matches both", async () => {
        await seed();
        expect(await findIds({ meta: { equals: AnyNull } })).toEqual([
          "db",
          "js",
          "omit",
        ]);
      });

      test("not DbNull matches every row that holds a document", async () => {
        await seed();
        expect(await findIds({ meta: { not: DbNull } })).toEqual([
          "doc",
          "js",
          "nest",
        ]);
      });

      // A value comparison against a SQL NULL is UNKNOWN, so the SQL-NULL rows
      // drop out here exactly as they do for `not: { equals: <document> }`.
      // `not: DbNull` is the one complement that can be total, and is.
      test("not JsonNull excludes the JSON null and the SQL NULLs", async () => {
        await seed();
        expect(await findIds({ meta: { not: JsonNull } })).toEqual([
          "doc",
          "nest",
        ]);
      });

      test("not AnyNull matches only real documents", async () => {
        await seed();
        expect(await findIds({ meta: { not: AnyNull } })).toEqual([
          "doc",
          "nest",
        ]);
      });

      test("the three equals predicates partition the table", async () => {
        await seed();
        const db = await findIds({ meta: { equals: DbNull } });
        const js = await findIds({ meta: { equals: JsonNull } });
        const any = await findIds({ meta: { equals: AnyNull } });
        expect(db.filter((id) => js.includes(id))).toEqual([]);
        expect([...db, ...js].sort()).toEqual(any);
      });
    });

    describe("writes", () => {
      test("DbNull and JsonNull are different stored values", async () => {
        await seed();
        // Same JS value on read (both are `null` — as in Prisma), different
        // rows under the filters, which is the whole point of the sentinels
        const rows = await requireClient(client).entry.findMany({
          where: { id: { in: ["db", "js"] } },
        });
        expect(rows.map((row) => row.meta)).toEqual([null, null]);
        expect(await findIds({ meta: { equals: DbNull } })).toContain("db");
        expect(await findIds({ meta: { equals: JsonNull } })).toEqual(["js"]);
      });

      test("update moves a row between the two nulls", async () => {
        await seed();

        await requireClient(client).entry.update({
          where: { id: "doc" },
          data: { meta: JsonNull },
        });
        expect(await findIds({ meta: { equals: JsonNull } })).toEqual([
          "doc",
          "js",
        ]);

        await requireClient(client).entry.update({
          where: { id: "doc" },
          data: { meta: DbNull },
        });
        expect(await findIds({ meta: { equals: JsonNull } })).toEqual(["js"]);
        expect(await findIds({ meta: { equals: DbNull } })).toEqual([
          "db",
          "doc",
          "omit",
        ]);
      });

      test("upsert stores a sentinel on either arm", async () => {
        await seed();

        await requireClient(client).entry.upsert({
          where: { id: "fresh" },
          create: { id: "fresh", name: "fresh", meta: JsonNull, required: 1 },
          update: { meta: JsonNull },
        });
        expect(await findIds({ meta: { equals: JsonNull } })).toEqual([
          "fresh",
          "js",
        ]);

        await requireClient(client).entry.upsert({
          where: { id: "fresh" },
          create: { id: "fresh", name: "fresh", required: 1 },
          update: { meta: DbNull },
        });
        expect(await findIds({ meta: { equals: JsonNull } })).toEqual(["js"]);
      });

      test("JsonNull is storable in a NOT NULL json column", async () => {
        await requireClient(client).entry.create({
          data: { id: "req", name: "req", required: JsonNull },
        });
        expect(await findIds({ required: { equals: JsonNull } })).toEqual([
          "req",
        ]);
      });
    });

    describe("refusals", () => {
      test("a bare null in write position is refused, not guessed", async () => {
        await expect(
          requireClient(client).entry.create({
            data: {
              id: "x",
              name: "x",
              // `as any` on purpose: the refusal is the point, and the type layer
              // already forbids what this test hands the runtime.
              meta: null as any,
              required: { r: 1 },
            },
          })
        ).rejects.toThrow(AMBIGUOUS_NULL);
        expect(await requireClient(client).entry.count()).toBe(0);
      });

      test("AnyNull is filter-only", async () => {
        await expect(
          requireClient(client).entry.create({
            data: {
              id: "x",
              name: "x",
              // `as any` on purpose: the refusal is the point, and the type layer
              // already forbids what this test hands the runtime.
              meta: AnyNull as any,
              required: { r: 1 },
            },
          })
        ).rejects.toThrow(ANY_NULL_WRITE);
        expect(await requireClient(client).entry.count()).toBe(0);
      });

      test("DbNull is refused on a NOT NULL json column", async () => {
        await expect(
          requireClient(client).entry.create({
            data: {
              id: "x",
              name: "x",
              // `as any` on purpose: the refusal is the point, and the type layer
              // already forbids what this test hands the runtime.
              required: DbNull as any,
            },
          })
        ).rejects.toThrow(DB_NULL_NOT_NULLABLE);
        expect(await requireClient(client).entry.count()).toBe(0);
      });

      test("a sentinel nested inside a document is refused", async () => {
        await expect(
          requireClient(client).entry.create({
            data: {
              id: "x",
              name: "x",
              // `as any` on purpose: the refusal is the point, and the type layer
              // already forbids what this test hands the runtime.
              meta: { inner: DbNull } as any,
              required: { r: 1 },
            },
          })
        ).rejects.toThrow(VALIDATION_FAILED);
        expect(await requireClient(client).entry.count()).toBe(0);
      });

      test("a sentinel under a path is refused before execution", async () => {
        await seed();
        await expect(
          findIds({ meta: { path: ["a"], equals: DbNull } })
        ).rejects.toThrow(PATH_WITH_DB_NULL);
        await expect(
          findIds({ meta: { path: ["a"], not: JsonNull } })
        ).rejects.toThrow(PATH_WITH_JSON_NULL);
        expect(await requireClient(client).entry.count()).toBe(5);
      });

      // A sentinel `not` case-folds nothing, so a `mode` beside it governs
      // nothing — the same inert-mode refusal every other arm gets.
      test("an inert mode beside a sentinel not is refused", async () => {
        await seed();
        await expect(
          findIds({ meta: { mode: "insensitive", not: DbNull } })
        ).rejects.toThrow(INERT_MODE);
        expect(await requireClient(client).entry.count()).toBe(5);
      });
    });

    // Regression witnesses: these answers predate the sentinels and are pinned
    // BY these tests, not merely tolerated. A bare `null` in filter position
    // keeps meaning what it always meant.
    describe("bare null in filter position (unchanged)", () => {
      test("equals null still means the SQL NULL at the root", async () => {
        await seed();
        expect(await findIds({ meta: { equals: null } })).toEqual([
          "db",
          "omit",
        ]);
      });

      test("not { equals: null } still means IS NOT NULL", async () => {
        await seed();
        expect(await findIds({ meta: { not: { equals: null } } })).toEqual([
          "doc",
          "js",
          "nest",
        ]);
      });

      test("equals null under a path still means the JSON null there", async () => {
        await seed();
        expect(await findIds({ meta: { path: ["a"], equals: null } })).toEqual([
          "nest",
        ]);
      });
    });
  });
}

export const jsonNullSentinelContract = defineContract({
  id: "drivers.json-null-sentinel",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runJsonNullSentinelBehavior,
});
