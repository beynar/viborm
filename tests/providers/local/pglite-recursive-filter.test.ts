/**
 * PGlite Driver Tests — recursive relation filters (`recurse` in `where`) on
 * embedded PostgreSQL: the closure matrix against its oracle, every verb, and
 * the Pyxel acceptance cases.
 */

import { runRecursiveRelationFilterBehavior } from "@tests/contracts/engine/query/recursive-relation-filter-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

describe("PGlite Driver", () => {
  runRecursiveRelationFilterBehavior({
    name: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
});
