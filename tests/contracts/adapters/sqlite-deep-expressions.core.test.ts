import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { sql } from "@sql";
import { describe, expect, test } from "vitest";

const check = (adapter: SQLiteAdapter): string =>
  adapter.subqueries
    .existsCheck(sql.raw('"member" AS "q1"'), sql.raw('"q1"."id" = ?'))
    .toStatement();

describe("SQLite relation-filter subqueries", () => {
  // The adapter spells a relation filter from the transport's fact; which
  // driver states which fact is pinned in
  // tests/contracts/drivers/sqlite-temporary-objects.core.test.ts.
  test("a transport that compiles deep expressions keeps the subquery's WHERE in place", () => {
    expect(check(new SQLiteAdapter())).toBe(
      'SELECT 1 FROM "member" AS "q1" WHERE "q1"."id" = ?'
    );
  });

  test("a shallow one reads the rows from a derived table, whose WHERE the enclosing expression's depth does not count", () => {
    expect(check(new SQLiteAdapter({ deepExpressions: false }))).toBe(
      'SELECT 1 FROM (SELECT 1 FROM "member" AS "q1" WHERE "q1"."id" = ?)'
    );
  });
});
