/**
 * PGlite Driver Tests — the `rows` capability (extension-capabilities plan
 * v3.1 §2.2) on embedded PostgreSQL: root and related domains at every set
 * scope, write lookups, and the unique-key consumers that need no second
 * connection.
 */

import { runRowScopeBehavior } from "@tests/contracts/engine/query/row-scope-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

describe("PGlite Driver", () => {
  runRowScopeBehavior({
    name: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
});
