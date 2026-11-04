/** PGlite Driver Tests — extensions over a declared junction, and the batch route. */

import { runThroughModelGovernedBehavior } from "@tests/contracts/engine/query/through-model-governed-behavior";
import { runThroughModelBehavior } from "@tests/contracts/engine/write/through-model-behavior";
import {
  BatchOnlyPGliteDriver,
  createInMemoryPGliteDriver,
} from "@tests/fixtures/drivers/pglite";

describe("PGlite Driver", () => {
  runThroughModelGovernedBehavior({
    name: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  runThroughModelBehavior({
    name: "PGlite batch route",
    createDriver: () => new BatchOnlyPGliteDriver(),
  });
});
