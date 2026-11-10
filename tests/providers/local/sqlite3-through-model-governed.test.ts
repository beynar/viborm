/** SQLite3 Driver Tests — extensions over a declared junction. */

import { runThroughModelGovernedBehavior } from "@tests/contracts/engine/query/through-model-governed-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

describe("SQLite3 Driver", () => {
  runThroughModelGovernedBehavior({
    name: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
});
