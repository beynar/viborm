import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { G2_JUNCTION_CASE_IDS } from "../contracts";
import { runSQLiteWorld } from "../harness/sqlite-world";
import { G0_PROFILES } from "../profiles";
import { junctionTransitionScenarios } from "./junctions";

assert.deepEqual(
  junctionTransitionScenarios.map((scenario) => scenario.id),
  G2_JUNCTION_CASE_IDS
);

describe.each(G0_PROFILES)("G2 junction transitions: legacy %s", (profile) => {
  for (const scenario of junctionTransitionScenarios) {
    it(scenario.id, async () => {
      const world = await runSQLiteWorld(scenario, profile, 0);
      world.fixture.assert(world.observation);
    });
  }
});
