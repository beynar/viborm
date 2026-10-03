import { createTestCommandEngine } from "@tests/raptor3/harness/command-engine";
import { describe, it } from "vitest";
import { verifyG0Pair } from "../harness/replay";
import { runSQLiteWorld } from "../harness/sqlite-world";
import { G0_PROFILES } from "../profiles";
import { variantIdentityScenarios } from "./variant-identity";

describe.each(
  G0_PROFILES
)("G1 variants and identity: commands %s", (profile) => {
  for (const scenario of variantIdentityScenarios) {
    it(scenario.id, async () => {
      const baseline = await runSQLiteWorld(scenario, profile, 0);
      baseline.fixture.assert(baseline.observation);
      const candidate = await runSQLiteWorld(scenario, profile, 0, {
        candidateFactory: createTestCommandEngine,
        candidateName: "commands",
      });
      verifyG0Pair(baseline, candidate);
    });
  }
});
