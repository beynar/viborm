/**
 * PGlite Driver Tests — the `deletion` capability (extension-capabilities plan
 * v3.1 §2.3) on embedded PostgreSQL: tombstones at every site core deletes,
 * the referential requirement, one instant per call, and `mode: "hard"`.
 */

import { withRows } from "@extensions/rows-runtime";
import { runDeletionCapabilityBehavior } from "@tests/contracts/engine/write/deletion-capability-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

// These definitions are stated as plain objects: what reads their rows is brought here.
withRows();

describe("PGlite Driver", () => {
  runDeletionCapabilityBehavior({
    name: "PGlite",
    createDriver: createInMemoryPGliteDriver,
    restrictedDelete: 3,
  });
});
