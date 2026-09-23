import { createCommandEngine } from "@query-engine/raptor3/commands";
import { afterAll, describe, it } from "vitest";
import { assertEquivalentRunObservations } from "../../../benchmarks/operation-pipeline-semantics.mjs";
import {
  pgStalenessIds,
  runPgStalenessScenario,
  savePgStalenessEvidence,
} from "./staleness-live-pg";

afterAll(savePgStalenessEvidence);
describe("G2 PostgreSQL native staleness: commands", () => {
  for (const id of pgStalenessIds) {
    it(id, async () => {
      const baseline = await runPgStalenessScenario(id);
      const candidate = await runPgStalenessScenario(id, createCommandEngine);
      assertEquivalentRunObservations(
        id,
        baseline.observation,
        candidate.observation
      );
    }, 30_000);
  }
});
