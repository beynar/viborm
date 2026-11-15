/**
 * SQL Server: text and JSON values that T-SQL reads in a form of its own.
 * `STRING_ESCAPE` writes `/` as `\/`, `JSON_VALUE` stops at 4,000
 * characters, `VARCHAR(n) + N'.'` widens to `NVARCHAR(4000)` only, and a
 * `LIKE` pattern holds at most 4,000 characters. Comparisons themselves are
 * the column's (`mssql-string-comparison.test.ts`). Set
 * MSSQL_TEST_CONNECTION_STRING to run.
 */

import { createClient } from "@client/client";
import { UnsupportedOperationError } from "@errors";
import { s } from "@schema";
import { sql } from "@sql";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createMssqlDriverIn,
  createSchema,
  dropSchema,
  TEST_CONNECTION_STRING,
} from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const NAMESPACE = "viborm_text_values";

const word = s
  .model({
    id: s.string().id(),
    name: s.string(),
    tags: s.string().array(),
    doc: s.json().nullable(),
    long: s.string(),
  })
  .map("words");

const LONG_TEXT = "x".repeat(4500);
const LONG_JSON = `${"y".repeat(5000)}needle`;

const client = createClient({
  schema: { word },
  driver: createMssqlDriverIn(NAMESPACE),
});

const ids = (where: object) =>
  client.word
    .findMany({ where, select: { id: true }, orderBy: { id: "asc" } })
    .then((rows) => rows.map((row) => row.id));

describeIf("SQL Server reads text and JSON values whole", () => {
  beforeAll(async () => {
    await createSchema(NAMESPACE);
    await syncLiveSchema(client);
    // An adopted column: VARCHAR(8000), case-insensitive, as many existing
    // databases declare text.
    await client.$executeRaw(
      sql.raw(
        `ALTER TABLE "${NAMESPACE}"."words" ALTER COLUMN "long" VARCHAR(8000) COLLATE SQL_Latin1_General_CP1_CI_AS NOT NULL`
      )
    );
    await client.word.createMany({
      data: [
        { id: "1-ab", name: "ab", tags: ["x"], long: "short", doc: { s: 1 } },
        { id: "3-AB", name: "AB", tags: [], long: "short", doc: { s: 1 } },
      ],
    });
    await client.word.create({
      data: {
        id: "5-doc",
        name: "doc",
        tags: ["a/b"],
        doc: { url: "https://x.io/p", long: LONG_JSON, arr: ["a", null, 1] },
        long: LONG_TEXT,
      },
    });
  });
  afterAll(async () => {
    await client.$disconnect();
    await dropSchema(NAMESPACE);
  });

  test("mode insensitive ignores case on a binary column", async () => {
    expect(await ids({ name: "ab" })).toEqual(["1-ab"]);
    expect(await ids({ name: { equals: "AB", mode: "insensitive" } })).toEqual([
      "1-ab",
      "3-AB",
    ]);
    expect(await ids({ name: { in: ["AB"], mode: "insensitive" } })).toEqual([
      "1-ab",
      "3-AB",
    ]);
    expect(
      await ids({ name: { startsWith: "A", mode: "insensitive" } })
    ).toEqual(["1-ab", "3-AB"]);
  });

  test("a JSON string holding `/` equals its value, and a pushed one is stored unescaped", async () => {
    expect(
      await ids({ doc: { path: ["url"], equals: "https://x.io/p" } })
    ).toEqual(["5-doc"]);
    expect(
      await ids({
        NOT: { doc: { path: ["url"], equals: "https://x.io/p" } },
        name: "doc",
      })
    ).toEqual([]);
    await client.word.update({
      where: { id: "5-doc" },
      data: { tags: { push: "c/d" } },
    });
    const [stored] = await client.$queryRaw<{ tags: string }>(
      sql`SELECT tags FROM ${sql.raw(`"${NAMESPACE}"."words"`)} WHERE id = ${"5-doc"}`
    );
    expect(stored!.tags).toBe('["a/b","c/d"]');
    expect(await ids({ tags: { equals: ["a/b", "c/d"] } })).toEqual(["5-doc"]);
  });

  test("array containment keeps null members", async () => {
    const at = (value: unknown[]) =>
      ids({ doc: { path: ["arr"], array_contains: value } });
    expect(await at([null])).toEqual(["5-doc"]);
    expect(await at(["a", null, 1])).toEqual(["5-doc"]);
    expect(await at([2])).toEqual([]);
  });

  test("a JSON string past 4,000 characters is read by every string filter", async () => {
    const at = (filter: object) => ids({ doc: { path: ["long"], ...filter } });
    expect(await at({ string_contains: "needle" })).toEqual(["5-doc"]);
    expect(await at({ string_ends_with: "needle" })).toEqual(["5-doc"]);
    expect(await at({ string_starts_with: "yyy" })).toEqual(["5-doc"]);
    expect(await at({ gt: "x" })).toEqual(["5-doc"]);
  });

  test("a VARCHAR(8000) value past 4,000 characters compares whole; a pattern past 4,000 is refused before it is sent", async () => {
    expect(await ids({ long: LONG_TEXT })).toEqual(["5-doc"]);
    expect(await ids({ long: { startsWith: "x".repeat(3999) } })).toEqual([
      "5-doc",
    ]);
    expect(await ids({ long: { contains: "X".repeat(3998) } })).toEqual([
      "5-doc",
    ]);
    await expect(
      ids({ long: { endsWith: "x".repeat(4100) } })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(
      ids({ doc: { path: ["long"], string_contains: "y".repeat(4100) } })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });
});
