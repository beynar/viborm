/**
 * PGlite Driver Tests — recursive relation filters (`recurse` in `where`) on
 * embedded PostgreSQL: the closure matrix against its oracle, every verb, and
 * the Pyxel acceptance cases. Run twice: as the driver states them, every
 * walk in place, and with `relationsPerStatement: 1`, so
 * every walk a statement repeats is a reaching set and every key set a row
 * tests more than a join costs is joined, as a statement past Neki's 256
 * relations takes them.
 */

import { PGliteDriver } from "@drivers/pglite";
import { runRecursiveRelationFilterBehavior } from "@tests/contracts/engine/query/recursive-relation-filter-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

describe("PGlite Driver", () => {
  runRecursiveRelationFilterBehavior({
    name: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  runRecursiveRelationFilterBehavior({
    name: "PGlite, past its relation budget",
    createDriver: () => new PGliteDriver({ relationsPerStatement: 1 }),
  });
});
