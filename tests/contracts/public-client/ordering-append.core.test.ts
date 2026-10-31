/**
 * The append each dialect's INSERT computes (`src/ordering/append.ts`), and
 * MySQL's read-first path, against a stub of the engine's query facts: the
 * provider files run them for real (`tests/providers/**\/*-ordering.test.ts`).
 */

import type { InsertValueContext } from "@query-engine/raptor3/shared/insert-value";
import { type Sql, sql } from "@sql";
import { AppendKey } from "@src/ordering/append";
import { isKey } from "@src/ordering/keys";
import { describe, expect, test } from "vitest";

const text = (fragment: unknown) =>
  typeof fragment === "string" ? fragment : (fragment as Sql).toStatement();

function context(
  dialect: InsertValueContext["dialect"],
  rows: Record<string, unknown>[],
  read?: InsertValueContext["read"]
): InsertValueContext {
  const queries = {
    column: (_: unknown, field: string) => sql.raw(`"${field}"`),
    table: () => sql.raw(`"card"`),
    fieldValue: (_: unknown, __: string, value: unknown) => sql`${value}`,
  };
  return {
    model: { "~": { names: { ts: "card" } } } as never,
    rows,
    field: "rank",
    queries: queries as never,
    dialect,
    ...(read && { read }),
  };
}

describe("ordering appends", () => {
  test.each([
    "postgresql",
    "mysql",
    "sqlite",
  ] as const)("%s: one expression per row, numbered within its list", async (dialect) => {
    const append = new AppendKey(["columnId"]);
    const rows = [
      { columnId: "c1" },
      { columnId: "c2" },
      { columnId: "c1" },
      { columnId: null },
    ];
    const values = await append.compute(context(dialect, rows), [0, 1, 2, 3]);
    const texts = values.map(text);
    expect(texts[0]).toContain("MAX(");
    // The second row of c1 is its list's second append; c2's is its first.
    expect(texts[2]).toContain("+ 2");
    expect(texts[1]).toContain("+ 1");
    expect(texts[3]).toContain("IS NULL");
  });

  test("mysql with a read: the last key of each list read once, keys computed here", async () => {
    const statements: string[] = [];
    const append = new AppendKey(["columnId"]);
    const rows = [{ columnId: "c1" }, { columnId: "c2" }, { columnId: "c1" }];
    const values = await append.compute(
      context("mysql", rows, async (statement) => {
        statements.push(text(statement));
        return [{ g0: "15", g1: null }];
      }),
      [0, 1, 2]
    );
    expect(statements).toHaveLength(1);
    expect(values.every(isKey)).toBe(true);
    const [first, other, second] = values as string[];
    expect(first! > "15" && first! < second!).toBe(true);
    expect(other!.startsWith("10")).toBe(true);
  });

  test("mysql with a read: a last value that is no key gives its integer, else the start", async () => {
    const append = new AppendKey([]);
    const appended = async (last: string) =>
      (await append.compute(
        context("mysql", [{}], async () => [{ g0: last }]),
        [0]
      )) as string[];
    expect((await appended("250"))[0]!.startsWith("251")).toBe(true);
    expect((await appended("2a"))[0]!.startsWith("10")).toBe(true);
    expect((await appended("089"))[0]!.startsWith("10")).toBe(true);
    expect((await appended("2500"))[0]!.startsWith("251")).toBe(true);
  });

  test("a list named by values the engine produces as SQL is one list per value", async () => {
    const append = new AppendKey(["columnId"]);
    const produced = sql`(SELECT 1)`;
    const rows = [
      { columnId: produced },
      { columnId: produced },
      { columnId: 7n },
    ];
    const values = (
      await append.compute(context("sqlite", rows), [0, 1, 2])
    ).map(text);
    expect(values[1]).toContain("+ 2");
    expect(values[2]).toContain("+ 1");
  });
});
