/**
 * SQLite3 Driver Tests — recursive relation filters (`recurse` in `where`):
 * the same behaviour PGlite, pg and MySQL2 run, on SQLite's correlated
 * `WITH RECURSIVE` inside `EXISTS`. Run again in D1's form (its adapter's
 * facts) with a relation budget of 1: every walk a statement repeats a
 * reaching set, key sets joined where a row tests them more than a join
 * costs, as D1 states a statement past 256 relations.
 */

import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { runRecursiveRelationFilterBehavior } from "@tests/contracts/engine/query/recursive-relation-filter-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

describe("SQLite3 Driver", () => {
  runRecursiveRelationFilterBehavior({
    name: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runRecursiveRelationFilterBehavior({
    name: "SQLite3 in D1's form, past its relation budget",
    createDriver: () => {
      const driver = createInMemorySQLite3Driver();
      const d1 = new SQLiteAdapter({
        deepExpressions: false,
        sharedRelationBodies: true,
        compoundSelectTerms: 5,
        relationsPerStatement: 1,
      });
      Object.assign(driver.adapter.subqueries, d1.subqueries);
      Object.assign(driver.adapter.capabilities, d1.capabilities);
      driver.adapter.operators.and = d1.operators.and;
      return driver;
    },
  });
});
