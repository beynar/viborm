import { describe, it } from "vitest";
import { runSQLiteWorld } from "../harness/sqlite-world";
import { G0_PROFILES } from "../profiles";
import { variantIdentityScenarios } from "./variant-identity";

describe.each(G0_PROFILES)("G1 variants and identity: legacy %s", (profile) => {
  for (const scenario of variantIdentityScenarios) {
    it(scenario.id, async () => {
      const world = await runSQLiteWorld(scenario, profile, 0);
      world.fixture.assert(world.observation);
    });
  }
});
