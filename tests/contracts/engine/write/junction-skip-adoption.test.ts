import { PGliteDriver } from "@drivers/pglite";
import { runJunctionSkipAdoptBehavior } from "@tests/contracts/engine/write/junction-skip-adoption-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { openTestPGlite as openBorrowedPGlite } from "@tests/fixtures/pglite-lifecycle";
import { describe } from "vitest";

describe("E6.8 — junction skipDuplicates adopt-equivalence (PGlite)", () => {
  runJunctionSkipAdoptBehavior({
    name: "PGlite transaction",
    createDriver: () => new PGliteDriver({ client: openBorrowedPGlite() }),
  });
  // The batch leg proves both exact adopt-and-link publication and isolated-root
  // suppression while the strong committed-callback capability remains absent.
  runJunctionSkipAdoptBehavior({
    name: "PGlite atomic batch",
    substrate: "batch",
    createDriver: () =>
      new BatchOnlyPGliteDriver({ client: openBorrowedPGlite() }),
  });
});
