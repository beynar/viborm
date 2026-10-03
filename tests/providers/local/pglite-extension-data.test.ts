/**
 * PGlite Driver Tests — fields an extension writes (extension-capabilities
 * plan v4 §2.2, §6 "Data") on embedded PostgreSQL: the stamp at every create
 * and update site, tombstones included, a caller's own value standing where
 * it writes the field or its relation, two extensions on one model, and the
 * optimistic lock; and a field
 * the schema requires that an extension writes, left out at every create
 * site (owner ruling 2).
 */

import { runExtensionDataBehavior } from "@tests/contracts/engine/write/extension-data-behavior";
import { runStampedRequiredBehavior } from "@tests/contracts/engine/write/stamped-required-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

describe("PGlite Driver", () => {
  runExtensionDataBehavior({
    name: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  runStampedRequiredBehavior({
    name: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
});
