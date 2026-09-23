import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { G2_KEY_CASE_IDS } from "../contracts";
import { runSQLiteWorld } from "../harness/sqlite-world";
import { G0_PROFILES } from "../profiles";
import { keyTransitionScenarios } from "./keys";

assert.deepEqual(
  keyTransitionScenarios.map((scenario) => scenario.id),
  G2_KEY_CASE_IDS
);

describe.each(
  G0_PROFILES
)("G2 key transitions: independent legacy %s", (profile) => {
  for (const scenario of keyTransitionScenarios) {
    it(scenario.id, async () => {
      const world = await runSQLiteWorld(scenario, profile, 0);
      world.fixture.assert(world.observation);
    });
  }
});
