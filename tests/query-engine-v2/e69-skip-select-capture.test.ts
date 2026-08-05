import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { describe } from "vitest";
import { runSkipSelectCaptureBehavior } from "./e69-skip-select-capture-behavior";

/**
 * E6.9's RETURNING control, runnable without Docker.
 *
 * PGlite answers this shape in ONE `INSERT … ON CONFLICT DO NOTHING RETURNING …`, so none
 * of the capture runs here. It is in the estate because the six answers must be the same
 * whichever mechanism produced them: the absorption is only honest if the driver that
 * always could do this still does it the fast way, and still says exactly what MySQL now
 * says. The load-bearing leg is `e69-skip-select-capture-docker.test.ts` (MySQL).
 */
describe("E6.9 — createMany select + skipDuplicates (PGlite control)", () => {
  runSkipSelectCaptureBehavior({
    name: "PGlite",
    createDriver: () => new PGliteDriver({ client: new PGlite() }),
    supportsReturning: true,
  });
});
