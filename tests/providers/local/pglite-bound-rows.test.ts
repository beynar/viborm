/**
 * PGlite Driver Tests — rows bound to the call (extension-capabilities plan
 * v4 §2.1, §6 "Bound rows") on embedded PostgreSQL: the guide's tenancy
 * recipe at every root and related scope, nested and root writes, array
 * transactions and the cache key.
 */

import { runBoundRowsBehavior } from "@tests/contracts/engine/query/bound-rows-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

describe("PGlite Driver", () => {
  runBoundRowsBehavior({
    name: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
});
