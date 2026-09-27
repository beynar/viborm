/**
 * SQLite3 Driver Tests — asymmetric junction referential actions (#46).
 *
 * The in-memory SQLite leg: `PRAGMA foreign_keys` enforcement decides each
 * junction foreign key by its own `ON DELETE` / `ON UPDATE` clause.
 */

import { runJunctionSideActionsBehavior } from "@tests/contracts/engine/write/junction-side-actions-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

describe("SQLite3 Driver", () => {
  runJunctionSideActionsBehavior({
    name: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
});
