/**
 * The append each dialect's INSERT computes (`src/ordering/append.ts`), and
 * MySQL's read-first path, against a stub of the engine's query facts: the
 * provider files run them for real (`tests/providers/**\/*-ordering.test.ts`).
 */

import { type Sql, sql } from "@sql";
import type { ComputedContext as InsertValueContext } from "@src/index";
import { appendKey } from "@src/ordering/append";
import { isKey } from "@src/ordering/keys";
import { describe, expect, test } from "vitest";

const text = (fragment: unknown) =>
  typeof fragment === "string" ? fragment : (fragment as Sql).toStatement();

function context(
  dialect: InsertValueContext["dialect"],
  rows: Record<string, unknown>[],
  read?: InsertValueContext["read"]
): InsertValueContext {
  const spelt = {
    dialect,
    column: (field: string) => sql.raw(`"${field}"`),
    table: () => sql.raw(`"card"`),
    value: (_: string, value: unknown) => sql`${value}`,
  };
  return {
    model: "card",
    rows,
    field: "rank",
    sql: spelt as never,
    dialect,
    ...(read && { read }),
  };
}

/** The append value, as the engine calls it. */
const appending = (within: string[]) =>
  appendKey(within) as unknown as {
    compute(
      context: InsertValueContext,
      indexes: readonly number[]
    ): Promise<readonly unknown[]>;
  };

describe("ordering appends", () => {
  test.each([
    "postgresql",
    "mysql",
    "sqlite",
  ] as const)("%s: one expression per row, numbered within its list", async (dialect) => {
    const append = appendKey(["columnId"]) as unknown as {
      compute(
        context: InsertValueContext,
        indexes: readonly number[]
      ): Promise<readonly unknown[]>;
    };
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
    const append = appendKey(["columnId"]) as unknown as {
      compute(
        context: InsertValueContext,
        indexes: readonly number[]
      ): Promise<readonly unknown[]>;
    };
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
    const append = appending([]);
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
    const append = appendKey(["columnId"]) as unknown as {
      compute(
        context: InsertValueContext,
        indexes: readonly number[]
      ): Promise<readonly unknown[]>;
    };
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
