/**
 * SQLite3 Driver Tests — recursive relation filters (`recurse` in `where`):
 * the same behaviour PGlite, pg and MySQL2 run, on SQLite's correlated
 * `WITH RECURSIVE` inside `EXISTS`.
 */

import { runRecursiveRelationFilterBehavior } from "@tests/contracts/engine/query/recursive-relation-filter-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

describe("SQLite3 Driver", () => {
  runRecursiveRelationFilterBehavior({
    name: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
});
