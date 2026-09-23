import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { G2_SERIES_STALENESS_CASE_IDS } from "../contracts";
import { runSQLiteWorld } from "../harness/sqlite-world";
import { seriesStalenessScenarios } from "./series-staleness";

assert.deepEqual(
  seriesStalenessScenarios.map((scenario) => scenario.id),
  G2_SERIES_STALENESS_CASE_IDS
);

describe("G2 admitted nested series staleness: atomic SQLite legacy", () => {
  for (const scenario of seriesStalenessScenarios) {
    it(scenario.id, async () => {
      const world = await runSQLiteWorld(scenario, "sqlite-atomic-batch", 0);
      world.fixture.assert(world.observation);
    });
  }
});
