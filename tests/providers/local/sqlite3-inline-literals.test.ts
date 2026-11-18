/**
 * SQLite3 Driver Tests — a read's bound values written as SQLite literals
 * (the body of a view) read the rows the bound statement reads.
 */

import { runInlineLiteralsBehavior } from "@tests/contracts/adapters/inline-literals-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

runInlineLiteralsBehavior({
  name: "SQLite3",
  dialect: "sqlite",
  createDriver: createInMemorySQLite3Driver,
});
