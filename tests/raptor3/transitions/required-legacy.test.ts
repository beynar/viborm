import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { G2_REQUIRED_CASE_IDS } from "../contracts";
import { runSQLiteWorld } from "../harness/sqlite-world";
import { G0_PROFILES } from "../profiles";
import { requiredMembershipScenarios } from "./required";

assert.deepEqual(
  requiredMembershipScenarios.map((scenario) => scenario.id),
  G2_REQUIRED_CASE_IDS
);

describe.each(G0_PROFILES)("G2 required membership: legacy %s", (profile) => {
  for (const scenario of requiredMembershipScenarios)
    it(scenario.id, async () => {
      const world = await runSQLiteWorld(scenario, profile, 0);
      world.fixture.assert(world.observation);
    });
});
