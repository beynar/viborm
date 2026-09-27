/**
 * PGlite Driver Tests — asymmetric junction referential actions (#46).
 *
 * The embedded PostgreSQL leg: `NO ACTION` is checked at the end of the
 * statement and `RESTRICT` at once, and both refuse here while the other
 * junction key cascades.
 */

import { runJunctionSideActionsBehavior } from "@tests/contracts/engine/write/junction-side-actions-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

describe("PGlite Driver", () => {
  runJunctionSideActionsBehavior({
    name: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
});
