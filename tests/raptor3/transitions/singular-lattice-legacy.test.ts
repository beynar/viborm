import { describe, it } from "vitest";
import { runSQLiteWorld } from "../harness/sqlite-world";
import { G0_PROFILES } from "../profiles";
import {
  singularLatticeScenarios,
  assertLatticeDispatch,
} from "./singular-lattice";

describe.each(
  G0_PROFILES
)("G2 complete child-held lattice: legacy %s", (profile) => {
  for (const scenario of singularLatticeScenarios)
    it(scenario.id, async () => {
      const world = await runSQLiteWorld(scenario, profile, 0);
      world.fixture.assert(world.observation);
      assertLatticeDispatch(world.record);
    });
});
