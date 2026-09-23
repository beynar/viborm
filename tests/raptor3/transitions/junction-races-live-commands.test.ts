import { createCommandEngine } from "@query-engine/raptor3/commands";
import { afterAll, describe, it } from "vitest";
import {
  junctionRaceIds,
  junctionRaceProvider,
  runJunctionRaceScenario,
  saveJunctionRaceEvidence,
} from "./junction-races-live";

afterAll(saveJunctionRaceEvidence);
describe(`G2 live ${junctionRaceProvider} singular-junction races: commands`, () => {
  // Native schedules may choose different successful owners. Each whole world
  // must satisfy the same independent outcome/ownership law; byte equality of
  // two different legal schedules is not a cross-engine semantic requirement.
  for (const id of junctionRaceIds)
    it(id, async () => {
      await runJunctionRaceScenario(id);
      await runJunctionRaceScenario(id, createCommandEngine);
    }, 30_000);
});
