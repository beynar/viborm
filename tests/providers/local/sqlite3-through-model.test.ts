/** SQLite3 Driver Tests — a declared model as the junction. */

import { runThroughModelBehavior } from "@tests/contracts/engine/write/through-model-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

describe("SQLite3 Driver", () => {
  runThroughModelBehavior({
    name: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
});
