/**
 * PGlite Driver Tests — the `deletion` capability (extension-capabilities plan
 * v3.1 §2.3) on embedded PostgreSQL: tombstones at every site core deletes,
 * the referential requirement, one instant per call, and `mode: "hard"`.
 */

import { runDeletionCapabilityBehavior } from "@tests/contracts/engine/write/deletion-capability-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

describe("PGlite Driver", () => {
  runDeletionCapabilityBehavior({
    name: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
});
