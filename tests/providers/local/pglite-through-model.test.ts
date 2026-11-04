/** PGlite Driver Tests — a declared model as the junction. */

import { runThroughModelBehavior } from "@tests/contracts/engine/write/through-model-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

describe("PGlite Driver", () => {
  runThroughModelBehavior({
    name: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
});
