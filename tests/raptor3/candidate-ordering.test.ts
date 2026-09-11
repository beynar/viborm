import assert from "node:assert/strict";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { createProgramEngine } from "@query-engine/raptor3/program";
import { describe, it } from "vitest";
import type {
  CandidateEngineFactory,
  ScenarioDefinition,
} from "./harness/protocol";
import { verifyG0Pair } from "./harness/replay";
import { runSQLiteWorld } from "./harness/sqlite-world";
import { G0_PROFILES } from "./profiles";
import { fixedScenarios } from "./scenarios/contracts";
import { verifyInstanceAdmissionPair } from "./scenarios/contracts/instances";

const changedDependency = fixedScenarios.find(
  (scenario) => scenario.id === "s2-changed-dependency"
);
assert.ok(changedDependency);

const reorderedDependency: ScenarioDefinition = {
  ...changedDependency,
  prepare(controls) {
    const fixture = changedDependency.prepare(controls);
    // This exact fixture publishes the same args object captured by invoke.
    const publicInput = fixture.publicInput as {
      args: {
        data: {
          bins: {
            updateMany: {
              data: {
                targets: { connectOrCreate: unknown; set: unknown };
              };
            };
          };
        };
      };
    };
    const memberData = publicInput.args.data.bins.updateMany.data;
    const { connectOrCreate, set } = memberData.targets;
    memberData.targets = { set, connectOrCreate };
    return fixture;
  },
};

const candidates: Record<"commands" | "program", CandidateEngineFactory> = {
  commands: createCommandEngine,
  program: createProgramEngine,
};

for (const [name, factory] of Object.entries(candidates)) {
  describe(`Raptor 3 relation key order: ${name}`, () => {
    it.each(G0_PROFILES)("%s", async (profile) => {
      const original = await runSQLiteWorld(changedDependency, profile, 0);
      const reordered = await runSQLiteWorld(reorderedDependency, profile, 0);
      verifyG0Pair(original, reordered);

      const candidate = await runSQLiteWorld(reorderedDependency, profile, 0, {
        candidateFactory: factory,
      });
      verifyInstanceAdmissionPair(reordered, candidate);
    });
  });
}
