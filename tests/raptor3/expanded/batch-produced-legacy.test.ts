import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { describe, it } from "vitest";
import {
  batchProducedCases,
  batchProducedSchema,
  runBatchProducedOutput,
} from "./batch-produced";

const getFamily = usePGliteSchemaFamily(batchProducedSchema);

describe("G1 forced-batch PGlite generated-output continuity: legacy", () => {
  for (const id of batchProducedCases) {
    it(id, async () => {
      await runBatchProducedOutput(getFamily(), id);
    }, 60_000);
  }
});
