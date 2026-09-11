import { describe, it } from "vitest";
import { runSQLiteWorld } from "../harness/sqlite-world";
import { G0_PROFILES } from "../profiles";
import { supplierContinuationScenarios } from "./supplier-continuations";

describe.each(
  G0_PROFILES
)("G2 supplier continuations: legacy %s", (profile) => {
  for (const scenario of supplierContinuationScenarios)
    it(scenario.id, async () => {
      const world = await runSQLiteWorld(scenario, profile, 0);
      world.fixture.assert(world.observation);
    });
});
