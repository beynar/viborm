/** PGlite Driver Tests — views kept by triggers. */

import { runAutoViewsBehavior } from "@tests/contracts/public-client/schema-auto-views-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

runAutoViewsBehavior({
  name: "PGlite",
  dialect: "postgresql",
  createDriver: createInMemoryPGliteDriver,
});
