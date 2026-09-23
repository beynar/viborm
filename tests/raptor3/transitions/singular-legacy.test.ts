import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { G2_SINGULAR_CASE_IDS } from "../contracts";
import { runSQLiteWorld } from "../harness/sqlite-world";
import { G0_PROFILES } from "../profiles";
import { singularTransitionScenarios } from "./singular";

assert.deepEqual(
  singularTransitionScenarios.map((scenario) => scenario.id),
  G2_SINGULAR_CASE_IDS
);

describe.each(
  G0_PROFILES
)("G2 ordinary singular transitions: legacy %s", (profile) => {
  for (const scenario of singularTransitionScenarios) {
    it(scenario.id, async () => {
      const world = await runSQLiteWorld(scenario, profile, 0);
      world.fixture.assert(world.observation);
    });
  }
});
