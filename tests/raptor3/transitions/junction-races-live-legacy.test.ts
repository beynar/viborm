import { afterAll, describe, it } from "vitest";
import {
  junctionRaceIds,
  junctionRaceProvider,
  runJunctionRaceScenario,
  saveJunctionRaceEvidence,
} from "./junction-races-live";

afterAll(saveJunctionRaceEvidence);
describe(`G2 live ${junctionRaceProvider} singular-junction races: legacy`, () => {
  for (const id of junctionRaceIds)
    it(id, async () => {
      await runJunctionRaceScenario(id);
    }, 30_000);
});
