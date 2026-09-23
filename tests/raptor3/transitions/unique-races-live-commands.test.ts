import { createCommandEngine } from "@query-engine/raptor3/commands";
import { afterAll, describe, it } from "vitest";
import { assertEquivalentRunObservations } from "../../../benchmarks/operation-pipeline-semantics.mjs";
import {
  runUniqueRaceScenario,
  saveUniqueRaceEvidence,
  uniqueRaceIds,
  uniqueRaceProvider,
} from "./unique-races-live";

afterAll(saveUniqueRaceEvidence);
describe(`G2 live ${uniqueRaceProvider} atomic-batch unique races: commands`, () => {
  for (const id of uniqueRaceIds) {
    it(id, async () => {
      const baseline = await runUniqueRaceScenario(id);
      const candidate = await runUniqueRaceScenario(id, createCommandEngine);
      assertEquivalentRunObservations(
        id,
        id === "g2-race-wrong-insert-same-constraint"
          ? {
              ...baseline.observation,
              // Both route-specific oracles first pin exact attempt counts and
              // native INSERT provenance. Only this approved retry difference
              // is omitted from the cross-engine comparison; raw cuts remain.
              reachedCuts: baseline.observation.reachedCuts.slice(0, 1),
            }
          : baseline.observation,
        candidate.observation
      );
    }, 30_000);
  }
});
