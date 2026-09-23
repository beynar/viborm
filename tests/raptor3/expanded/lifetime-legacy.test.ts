import { describe, it } from "vitest";
import { runSQLiteWorld } from "../harness/sqlite-world";
import { G0_PROFILES } from "../profiles";
import { lifetimeScenarios } from "./lifetimes";

describe.each(
  G0_PROFILES
)("G1 legality and engine lifetimes: legacy %s", (profile) => {
  for (const scenario of lifetimeScenarios) {
    it(scenario.id, async () => {
      const world = await runSQLiteWorld(scenario, profile, 0);
      world.fixture.assert(world.observation);
    });
  }
});
