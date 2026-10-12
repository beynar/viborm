/**
 * SQLite3 Driver Tests — which class a refusal is: caller-input mistakes are
 * V4001 at their operator path, an over-budget recursive projection is a V8003
 * naming the operation that ran. The same behaviour PGlite runs.
 */

import { runRefusalClassificationBehavior } from "@tests/contracts/engine/query/refusal-classification-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

describe("SQLite3 Driver", () => {
  runRefusalClassificationBehavior({
    name: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
});
