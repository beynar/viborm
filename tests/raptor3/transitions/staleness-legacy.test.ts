import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { G2_CAPTURED_KEY_CASE_IDS } from "../contracts";
import { runSQLiteWorld } from "../harness/sqlite-world";
import { capturedKeyScenarios } from "./staleness";

assert.deepEqual(
  capturedKeyScenarios.map((scenario) => scenario.id),
  G2_CAPTURED_KEY_CASE_IDS
);

describe("G2 captured-key staleness: restricted atomic SQLite legacy", () => {
  for (const scenario of capturedKeyScenarios) {
    it(scenario.id, async () => {
      const world = await runSQLiteWorld(scenario, "sqlite-atomic-batch", 0);
      world.fixture.assert(world.observation);
    });
  }
});
