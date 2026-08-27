/**
 * Unit tests for identifier escaping — quote-containing mapped names must not
 * break out of the quoted identifier (SQL injection).
 */

import { sql } from "@sql";
import { mysqlAdapter } from "@src/adapters/databases/mysql/mysql-adapter";
import { postgresAdapter } from "@src/adapters/databases/postgres/postgres-adapter";
import { sqliteAdapter } from "@src/adapters/databases/sqlite/sqlite-adapter";

describe("identifier escaping", () => {
  const malicious = 'users"; DROP TABLE users; --';
  // The stock `postgresAdapter` singleton is bound to the default `public`
  // schema, so its persistent-table renders carry that prefix; the unbound
  // MySQL and SQLite singletons carry none.
  const dialects = [
    ["postgres", postgresAdapter, '"', '"public".'],
    ["mysql", mysqlAdapter, "`", ""],
    ["sqlite", sqliteAdapter, '"', ""],
  ] as const;

  for (const [name, adapter, quote, qualifier] of dialects) {
    describe(`${name} shared identifier builders`, () => {
      test("ordinary and reserved identifiers remain raw and parameter-free", () => {
        const fragments = [
          adapter.raw("SELECT trusted_sql"),
          adapter.identifiers.escape("select"),
          adapter.identifiers.column("users", "email"),
          adapter.identifiers.table("users", "u"),
          adapter.identifiers.table("users"),
        ];

        expect(fragments.map((fragment) => fragment.toStatement())).toEqual([
          "SELECT trusted_sql",
          `${quote}select${quote}`,
          `${quote}users${quote}.${quote}email${quote}`,
          `${qualifier}${quote}users${quote} AS ${quote}u${quote}`,
          `${qualifier}${quote}users${quote}`,
        ]);
        expect(
          fragments.every((fragment) => fragment.values.length === 0)
        ).toBe(true);
      });

      test("quote-containing aliases preserve expression parameters", () => {
        const alias = quote === "`" ? "a`lias" : 'a"lias';
        const quotedAlias = quote === "`" ? "`a``lias`" : '"a""lias"';
        const fragment = adapter.identifiers.aliased(
          sql`COALESCE(${1}, ${2})`,
          alias
        );

        expect(fragment.toStatement("$n")).toBe(
          `COALESCE($1, $2) AS ${quotedAlias}`
        );
        expect(fragment.values).toEqual([1, 2]);
      });

      test("quote-containing CTE names preserve composition and parameters", () => {
        const cteName = quote === "`" ? "c`te" : 'c"te';
        const quotedName = quote === "`" ? "`c``te`" : '"c""te"';
        const ordinary = adapter.cte.with([
          { name: cteName, query: sql`SELECT ${1}` },
        ]);
        const recursive = adapter.cte.recursive(
          cteName,
          sql`SELECT ${1}`,
          sql`SELECT ${2}`
        );

        expect(ordinary.toStatement("$n")).toBe(
          `WITH ${quotedName} AS (SELECT $1)`
        );
        expect(ordinary.values).toEqual([1]);
        expect(recursive.toStatement("$n")).toBe(
          `WITH RECURSIVE ${quotedName} AS (\n        SELECT $1\n        UNION ALL\n        SELECT $2\n      )`
        );
        expect(recursive.values).toEqual([1, 2]);
      });
    });
  }

  for (const [name, adapter, qualifier] of [
    ["postgres", postgresAdapter, '"public".'],
    ["sqlite", sqliteAdapter, ""],
  ] as const) {
    describe(name, () => {
      test("escape doubles embedded double quotes", () => {
        expect(adapter.identifiers.escape(malicious).toStatement()).toBe(
          '"users""; DROP TABLE users; --"'
        );
      });

      test("column and table escape embedded quotes", () => {
        expect(adapter.identifiers.column('a"b', 'c"d').toStatement()).toBe(
          '"a""b"."c""d"'
        );
        expect(adapter.identifiers.table('t"1', 'a"lias').toStatement()).toBe(
          `${qualifier}"t""1" AS "a""lias"`
        );
      });
    });
  }

  describe("mysql", () => {
    test("escape doubles embedded backticks", () => {
      expect(mysqlAdapter.identifiers.escape("users` --").toStatement()).toBe(
        "`users`` --`"
      );
    });

    test("column and table escape embedded backticks", () => {
      expect(mysqlAdapter.identifiers.column("a`b", "c`d").toStatement()).toBe(
        "`a``b`.`c``d`"
      );
      expect(
        mysqlAdapter.identifiers.table("t`1", "a`lias").toStatement()
      ).toBe("`t``1` AS `a``lias`");
    });
  });
});
