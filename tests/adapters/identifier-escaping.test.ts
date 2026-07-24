/**
 * Unit tests for identifier escaping — quote-containing mapped names must not
 * break out of the quoted identifier (SQL injection).
 */

import { mysqlAdapter } from "../../src/adapters/databases/mysql/mysql-adapter";
import { postgresAdapter } from "../../src/adapters/databases/postgres/postgres-adapter";
import { sqliteAdapter } from "../../src/adapters/databases/sqlite/sqlite-adapter";

describe("identifier escaping", () => {
  const malicious = 'users"; DROP TABLE users; --';

  for (const [name, adapter] of [
    ["postgres", postgresAdapter],
    ["sqlite", sqliteAdapter],
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
        expect(adapter.identifiers.table('t"1', "alias").toStatement()).toBe(
          '"t""1" AS "alias"'
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
      expect(mysqlAdapter.identifiers.table("t`1", "alias").toStatement()).toBe(
        "`t``1` AS `alias`"
      );
    });
  });
});
