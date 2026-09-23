import { createCommandEngine } from "@query-engine/raptor3/commands";
import { afterAll, describe, it } from "vitest";
import { assertEquivalentRunObservations } from "../../../benchmarks/operation-pipeline-semantics.mjs";
import {
  occupancyProvider,
  occupancyRaceId,
  runOccupancyScenario,
  saveOccupancyEvidence,
} from "./occupancy-live";

afterAll(saveOccupancyEvidence);
describe(`G2 live ${occupancyProvider} singular occupancy: commands`, () => {
  it(occupancyRaceId, async () => {
    const baseline = await runOccupancyScenario();
    const candidate = await runOccupancyScenario(createCommandEngine);
    assertEquivalentRunObservations(
      occupancyRaceId,
      baseline.semanticObservation,
      candidate.semanticObservation
    );
  }, 30_000);
});
