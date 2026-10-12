/**
 * PGlite Driver Tests — which class a refusal is: caller-input mistakes are
 * V4001 at their operator path, an over-budget recursive projection is a V8003
 * naming the operation that ran. The same behaviour SQLite3 runs.
 */

import { runRefusalClassificationBehavior } from "@tests/contracts/engine/query/refusal-classification-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

describe("PGlite Driver", () => {
  runRefusalClassificationBehavior({
    name: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
});
