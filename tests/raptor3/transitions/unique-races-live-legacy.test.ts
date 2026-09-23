import { afterAll, describe, it } from "vitest";
import {
  runUniqueRaceScenario,
  saveUniqueRaceEvidence,
  uniqueRaceIds,
  uniqueRaceProvider,
} from "./unique-races-live";

afterAll(saveUniqueRaceEvidence);
describe(`G2 live ${uniqueRaceProvider} atomic-batch unique races: legacy`, () => {
  for (const id of uniqueRaceIds) {
    it(id, async () => {
      await runUniqueRaceScenario(id);
    }, 30_000);
  }
});
