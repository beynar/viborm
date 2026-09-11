import { createCommandEngine } from "@query-engine/raptor3/commands";
import { describe, it } from "vitest";
import { verifyG0Pair } from "../harness/replay";
import { runSQLiteWorld } from "../harness/sqlite-world";
import { G0_PROFILES } from "../profiles";
import { expandedScenarios } from "./index";

describe("G1 expanded commands versus independently checked legacy", () => {
  describe.each(G0_PROFILES)("%s", (profile) => {
    for (const scenario of expandedScenarios) {
      it(scenario.id, async () => {
        const baseline = await runSQLiteWorld(scenario, profile, 0);
        baseline.fixture.assert(baseline.observation);
        const candidate = await runSQLiteWorld(scenario, profile, 0, {
          candidateFactory: createCommandEngine,
        });
        verifyG0Pair(baseline, candidate);
      });
    }
  });
});
