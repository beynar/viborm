/** Trimmed projection SQL (no same-name aliases, no COALESCE on counts, no WHERE TRUE) answers as before on PostgreSQL. */

import { runProjectionTrimsBehavior } from "@tests/contracts/public-client/projection-trims-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

runProjectionTrimsBehavior({
  name: "PGlite",
  createDriver: createInMemoryPGliteDriver,
});
