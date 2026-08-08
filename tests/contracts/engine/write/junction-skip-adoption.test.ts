import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { describe } from "vitest";
import { runJunctionSkipAdoptBehavior } from "@tests/contracts/engine/write/junction-skip-adoption-behavior";

describe("E6.8 — junction skipDuplicates adopt-equivalence (PGlite)", () => {
  runJunctionSkipAdoptBehavior({
    name: "PGlite transaction",
    createDriver: () => new PGliteDriver({ client: new PGlite() }),
  });
  runJunctionSkipAdoptBehavior({
    name: "PGlite atomic batch",
    createDriver: () => new BatchOnlyPGliteDriver({ client: new PGlite() }),
  });
});
