/**
 * SQL Server: text and JSON compared as PostgreSQL compares them. SQL Server
 * pads `=` and `<` with trailing spaces under every collation, escapes `/`
 * in `STRING_ESCAPE`, truncates `JSON_VALUE` at 4,000 characters and widens
 * `VARCHAR(n) + N'.'` to `NVARCHAR(4000)` only: each test below failed
 * before its form was exact. Set MSSQL_TEST_CONNECTION_STRING to run.
 */

import { createClient } from "@client/client";
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
const NAMESPACE = "viborm_exact_values";

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

describeIf("SQL Server compares values exactly", () => {
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
    const row = (id: string, name: string, tags: string[]) => ({
      id,
      name,
      tags,
      long: "short",
      // A JSON string beside the column, for the path filters.
      doc: { s: name },
    });
    await client.word.createMany({
      data: [
        row("1-ab", "ab", ["x"]),
        row("2-ab-space", "ab ", ["x "]),
        row("3-AB", "AB", []),
        row("4-abc", "abc", []),
        // A tab sorts below the space a shorter operand is padded with.
        row("6-ab-tab", "ab\t", []),
      ],
    });
    await client.word.create({
      data: {
        id: "5-doc",
        name: "doc",
        tags: ["a/b"],
        doc: { url: "https://x.io/p", long: LONG_JSON, arr: ["a ", null, 1] },
        long: LONG_TEXT,
      },
    });
  });
  afterAll(async () => {
    await client.$disconnect();
    await dropSchema(NAMESPACE);
  });

  test("trailing spaces count in in, notIn, ranges and insensitive equality", async () => {
    expect(await ids({ name: { in: ["ab"] } })).toEqual(["1-ab"]);
    expect(await ids({ name: { in: ["ab "] } })).toEqual(["2-ab-space"]);
    expect(await ids({ name: { notIn: ["ab", "doc"] } })).toEqual([
      "2-ab-space",
      "3-AB",
      "4-abc",
      "6-ab-tab",
    ]);
    expect(await ids({ name: { gt: "ab", lt: "b" } })).toEqual([
      "2-ab-space",
      "4-abc",
      "6-ab-tab",
    ]);
    expect(await ids({ name: { lte: "ab" } })).toEqual(["1-ab", "3-AB"]);
    // A bound value holding a tab: compared by keys alone.
    expect(await ids({ name: { lt: "ab\t" } })).toEqual(["1-ab", "3-AB"]);
    expect(await ids({ name: { gte: "ab\t", lt: "b" } })).toEqual([
      "2-ab-space",
      "4-abc",
      "6-ab-tab",
    ]);
    expect(await ids({ name: { equals: "AB", mode: "insensitive" } })).toEqual([
      "1-ab",
      "3-AB",
    ]);
    expect(await ids({ name: { in: ["AB"], mode: "insensitive" } })).toEqual([
      "1-ab",
      "3-AB",
    ]);
  });

  test("a JSON string at a path keeps its trailing spaces in ranges", async () => {
    const at = (filter: object) =>
      ids({ doc: { path: ["s"], ...filter }, name: { not: "doc" } });
    expect(await at({ gt: "ab", lt: "b" })).toEqual([
      "2-ab-space",
      "4-abc",
      "6-ab-tab",
    ]);
    // A tab is below the space: "ab\t" < "ab ".
    expect(await at({ lt: "ab " })).toEqual(["1-ab", "3-AB", "6-ab-tab"]);
    expect(await at({ gte: "ab ", lte: "ab " })).toEqual(["2-ab-space"]);
  });

  test("a list member keeps its trailing spaces", async () => {
    expect(await ids({ tags: { has: "x" } })).toEqual(["1-ab"]);
    expect(await ids({ tags: { hasSome: ["x "] } })).toEqual(["2-ab-space"]);
    expect(await ids({ tags: { hasEvery: ["x"] } })).toEqual(["1-ab"]);
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

  test("array containment keeps null members and trailing spaces", async () => {
    const at = (value: unknown[]) =>
      ids({ doc: { path: ["arr"], array_contains: value } });
    expect(await at([null])).toEqual(["5-doc"]);
    expect(await at(["a ", null, 1])).toEqual(["5-doc"]);
    expect(await at(["a "])).toEqual(["5-doc"]);
    expect(await at(["a"])).toEqual([]);
    expect(await at([2])).toEqual([]);
  });

  test("a JSON string past 4,000 characters is read by every string filter", async () => {
    const at = (filter: object) => ids({ doc: { path: ["long"], ...filter } });
    expect(await at({ string_contains: "needle" })).toEqual(["5-doc"]);
    expect(await at({ string_ends_with: "needle" })).toEqual(["5-doc"]);
    expect(await at({ string_starts_with: "yyy" })).toEqual(["5-doc"]);
    expect(await at({ gt: "x" })).toEqual(["5-doc"]);
  });

  test("contains takes a needle past 4,000 characters, on a column and in a JSON string", async () => {
    expect(await ids({ long: { contains: "x".repeat(4100) } })).toEqual([
      "5-doc",
    ]);
    expect(
      await ids({ long: { contains: "X".repeat(4100), mode: "insensitive" } })
    ).toEqual(["5-doc"]);
    expect(await ids({ long: { contains: `${"x".repeat(4100)}y` } })).toEqual(
      []
    );
    expect(
      await ids({
        doc: { path: ["long"], string_contains: `${"y".repeat(4100)}needle` },
      })
    ).toEqual(["5-doc"]);
  });

  test("a VARCHAR(8000) column's value past 4,000 characters compares whole", async () => {
    expect(await ids({ long: LONG_TEXT })).toEqual(["5-doc"]);
    expect(await ids({ long: { startsWith: "x".repeat(4100) } })).toEqual([
      "5-doc",
    ]);
    expect(await ids({ long: { endsWith: "x".repeat(4100) } })).toEqual([
      "5-doc",
    ]);
  });
});
