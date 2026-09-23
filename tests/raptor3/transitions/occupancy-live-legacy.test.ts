import { afterAll, describe, it } from "vitest";
import {
  occupancyProvider,
  occupancyRaceId,
  runOccupancyScenario,
  saveOccupancyEvidence,
} from "./occupancy-live";

afterAll(saveOccupancyEvidence);
describe(`G2 live ${occupancyProvider} singular occupancy: legacy classification`, () => {
  it(occupancyRaceId, async () => {
    await runOccupancyScenario();
  }, 30_000);
});
