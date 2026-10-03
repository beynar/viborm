/**
 * PGlite Driver Tests — `viborm/soft-delete` (extension-capabilities plan
 * v3.1 §1.1) on embedded PostgreSQL: the plan's use block end to end.
 */

import { runSoftDeleteBehavior } from "@tests/contracts/public-client/soft-delete-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

describe("PGlite Driver", () => {
  runSoftDeleteBehavior({
    name: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
});
