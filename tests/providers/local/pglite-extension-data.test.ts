/**
 * PGlite Driver Tests — fields an extension writes (extension-capabilities
 * plan v4 §2.2, §6 "Data") on embedded PostgreSQL: the stamp at every create
 * and update site, tombstones included, the refusal of a caller's same
 * field, two extensions on one model, and the optimistic lock.
 */

import { runExtensionDataBehavior } from "@tests/contracts/engine/write/extension-data-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

describe("PGlite Driver", () => {
  runExtensionDataBehavior({
    name: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
});
