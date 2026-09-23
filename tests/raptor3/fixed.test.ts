import { describe, it } from "vitest";
import { G0_PROFILES } from "./profiles";
import { runSQLiteWorld } from "./harness/sqlite-world";
import { fixedScenarios } from "./scenarios/contracts";

describe.each(G0_PROFILES)("Raptor 3 G0 fixed contracts: %s", (profile) => {
  for (const scenario of fixedScenarios) {
    it(scenario.id, async () => {
      const world = await runSQLiteWorld(scenario, profile);
      world.fixture.assert(world.observation);
    });
  }
});
