import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { describe, it } from "vitest";
import { G1_PROVIDER_CASE_IDS } from "../contracts";
import { producedSchema, runProducedOutput } from "./produced";

const getFamily = usePGliteSchemaFamily(producedSchema);

describe("G1 PGlite interactive produced-output legacy answers", () => {
  for (const id of G1_PROVIDER_CASE_IDS) {
    it(id, async () => {
      await runProducedOutput(getFamily(), id);
    }, 60_000);
  }
});
