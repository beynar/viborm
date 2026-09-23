import { describe, it } from "vitest";
import { runSQLiteWorld } from "../harness/sqlite-world";
import { G0_PROFILES } from "../profiles";
import { occupiedKeyScenarios } from "./occupied-keys";

describe.each(G0_PROFILES)("G2 occupied nested keys: legacy %s", (profile) => {
  for (const scenario of occupiedKeyScenarios)
    it(scenario.id, async () => {
      const world = await runSQLiteWorld(scenario, profile, 0);
      world.fixture.assert(world.observation);
    });
});
