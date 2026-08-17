import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { runJunctionSkipAdoptBehavior } from "@tests/contracts/engine/write/junction-skip-adoption-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { describe } from "vitest";

describe("E6.8 — junction skipDuplicates adopt-equivalence (PGlite)", () => {
  runJunctionSkipAdoptBehavior({
    name: "PGlite transaction",
    createDriver: () => new PGliteDriver({ client: new PGlite() }),
  });
  // The batch leg proves both exact adopt-and-link publication and isolated-root
  // suppression while the strong committed-callback capability remains absent.
  runJunctionSkipAdoptBehavior({
    name: "PGlite atomic batch",
    substrate: "batch",
    createDriver: () => new BatchOnlyPGliteDriver({ client: new PGlite() }),
  });
});
