import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { G1_CASE_IDS } from "../contracts";
import { runSQLiteWorld } from "../harness/sqlite-world";
import { G0_PROFILES } from "../profiles";
import { expandedScenarios } from "./index";

assert.deepEqual(
  expandedScenarios.map((scenario) => scenario.id),
  G1_CASE_IDS
);

describe("G1 expanded independent legacy admission and raw-state answers", () => {
  describe.each(G0_PROFILES)("%s", (profile) => {
    for (const scenario of expandedScenarios) {
      it(scenario.id, async () => {
        const world = await runSQLiteWorld(scenario, profile, 0);
        world.fixture.assert(world.observation);
      });
    }
  });
});
