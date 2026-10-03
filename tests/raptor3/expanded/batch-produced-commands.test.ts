import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { createTestCommandEngine } from "@tests/raptor3/harness/command-engine";
import { describe, it } from "vitest";
import { assertEquivalentRunObservations } from "../../../benchmarks/operation-pipeline-semantics.mjs";
import {
  batchProducedCases,
  batchProducedSchema,
  runBatchProducedOutput,
} from "./batch-produced";

const getFamily = usePGliteSchemaFamily(batchProducedSchema);

describe("G1 forced-batch PGlite generated-output continuity: commands", () => {
  for (const id of batchProducedCases) {
    it(id, async () => {
      const baseline = await runBatchProducedOutput(getFamily(), id);
      const candidate = await runBatchProducedOutput(
        getFamily(),
        id,
        createTestCommandEngine
      );
      assertEquivalentRunObservations(id, baseline, candidate);
    }, 60_000);
  }
});
