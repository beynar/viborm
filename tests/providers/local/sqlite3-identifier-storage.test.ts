/**
 * SQLite3 Driver Tests — compact identifier storage.
 *
 * The SQLite leg: `BLOB` in `PRAGMA table_info`, the payload bytes in the
 * column, and the byte order that has to equal canonical text order for
 * `orderBy` and cursor pagination to keep meaning what they meant.
 */

import { runIdentifierStorageBehavior } from "@tests/contracts/engine/query/identifier-storage-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

describe("SQLite3 Driver", () => {
  runIdentifierStorageBehavior({
    name: "SQLite3",
    dialect: "sqlite",
    createDriver: createInMemorySQLite3Driver,
  });
});
