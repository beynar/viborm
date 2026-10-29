/**
 * PGlite Driver Tests — `viborm/on` on embedded PostgreSQL: the interactive
 * driver, and a batch-only one (Neon HTTP's shape: every operation one
 * atomic batch, no interactive transaction).
 */

import { runOnBehavior } from "@tests/contracts/public-client/on-behavior";
import {
  BatchOnlyPGliteDriver,
  createInMemoryPGliteDriver,
} from "@tests/fixtures/drivers/pglite";

describe("PGlite Driver", () => {
  runOnBehavior({ name: "PGlite", createDriver: createInMemoryPGliteDriver });
  runOnBehavior({
    name: "PGlite batch-only",
    createDriver: () => new BatchOnlyPGliteDriver(),
  });
});
