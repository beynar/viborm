import {
  junctionSkipAdoptSchema,
  runJunctionSkipAdoptBehavior,
} from "@tests/contracts/engine/write/junction-skip-adoption-behavior";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { describe } from "vitest";

const getTransactionFamily = usePGliteSchemaFamily(
  junctionSkipAdoptSchema,
  "transaction"
);
const getBatchFamily = usePGliteSchemaFamily(
  junctionSkipAdoptSchema,
  "atomicBatch"
);

describe("E6.8 — junction skipDuplicates adopt-equivalence (PGlite)", () => {
  runJunctionSkipAdoptBehavior({
    name: "PGlite transaction",
    createDriver: () => getTransactionFamily().driver,
  });
  // The batch leg proves both exact adopt-and-link publication and isolated-root
  // suppression while the strong committed-callback capability remains absent.
  runJunctionSkipAdoptBehavior({
    name: "PGlite atomic batch",
    substrate: "batch",
    createDriver: () => getBatchFamily().driver,
  });
});
