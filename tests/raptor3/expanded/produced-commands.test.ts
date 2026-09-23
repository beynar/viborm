import { createCommandEngine } from "@query-engine/raptor3/commands";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { describe, it } from "vitest";
import { assertEquivalentRunObservations } from "../../../benchmarks/operation-pipeline-semantics.mjs";
import { G1_PROVIDER_CASE_IDS } from "../contracts";
import { producedSchema, runProducedOutput } from "./produced";

const getFamily = usePGliteSchemaFamily(producedSchema);

describe("G1 PGlite interactive produced-output commands comparison", () => {
  for (const id of G1_PROVIDER_CASE_IDS) {
    it(id, async () => {
      const baseline = await runProducedOutput(getFamily(), id);
      const candidate = await runProducedOutput(
        getFamily(),
        id,
        createCommandEngine
      );
      assertEquivalentRunObservations(id, baseline, candidate);
    }, 60_000);
  }
});
