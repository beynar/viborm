import { sql } from "@sql";
import { NumberedSql } from "@src/sql/numbered";
import { describe, expect, test } from "vitest";

/**
 * A statement over its driver's bind budget, with equal values bound once and
 * referenced by number (RBAC plan K2(d)): what the driver sends instead of
 * the plain statement.
 */
describe("numbered statements", () => {
  test("equal values bind once, by number, in the order they first appear", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const bytes = new Uint8Array([1]);
    const statement = sql`SELECT ${1}, ${"1"}, ${1}, ${null}, ${null}, ${at}, ${new Date(at)}, ${bytes}, ${bytes}, ${new Uint8Array([1])}, ${true}`;
    const numbered = new NumberedSql(statement, "?");
    expect(numbered.values).toEqual([
      1,
      "1",
      null,
      at,
      bytes,
      new Uint8Array([1]),
      true,
    ]);
    expect(numbered.toStatement()).toBe(
      "SELECT ?1, ?2, ?1, ?3, ?3, ?4, ?4, ?5, ?5, ?6, ?7"
    );
    expect(
      new NumberedSql(sql`a = ${"x"} OR b = ${"x"}`, "$").toStatement()
    ).toBe("a = $1 OR b = $1");
  });
});
