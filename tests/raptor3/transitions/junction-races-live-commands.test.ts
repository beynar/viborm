import { createTestCommandEngine } from "@tests/raptor3/harness/command-engine";
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
      await runJunctionRaceScenario(id, createTestCommandEngine);
    }, 30_000);
});
