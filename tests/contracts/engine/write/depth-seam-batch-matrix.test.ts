import { runDepthSeamBehavior } from "@tests/contracts/engine/write/depth-seam-behavior";
import { describe } from "vitest";

/**
 * The N4 depth-seam behavior matrix on the PGlite ATOMIC BATCH substrate.
 *
 * One `usePGliteSchemaFamily` database serves the whole suite — the fixture pushes the
 * schema once and truncates between tests — so every arm here shares a single PGlite
 * instance. The transaction leg is a DIFFERENT substrate and therefore a different
 * family, which is why it runs from `depth-seam-transaction-matrix.test.ts`: keeping the
 * two in one process meant two live databases plus the injection harnesses that used to
 * sit beside them.
 */
describe("N4 — depth-seam boundaries (PGlite)", () => {
  runDepthSeamBehavior({
    name: "PGlite atomic batch",
    pgliteMode: "atomicBatch",
  });
});
