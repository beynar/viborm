import { PGliteDriver } from "@drivers/pglite";
import { runSkipSelectCaptureBehavior } from "@tests/contracts/engine/write/skip-select-capture-behavior";
import { openTestPGlite as openBorrowedPGlite } from "@tests/fixtures/pglite-lifecycle";
import { describe } from "vitest";

/**
 * E6.9's RETURNING control, runnable without Docker.
 *
 * PGlite answers this shape in ONE `INSERT … ON CONFLICT DO NOTHING RETURNING …`, so none
 * of the capture runs here. It is in the estate because the six answers must be the same
 * whichever mechanism produced them: the absorption is only honest if the driver that
 * always could do this still does it the fast way, and still says exactly what MySQL now
 * says. The load-bearing leg is `skip-select-capture-docker.test.ts` (MySQL).
 */
describe("E6.9 — createMany select + skipDuplicates (PGlite control)", () => {
  runSkipSelectCaptureBehavior({
    name: "PGlite",
    createDriver: () => new PGliteDriver({ client: openBorrowedPGlite() }),
    supportsReturning: true,
  });
});
