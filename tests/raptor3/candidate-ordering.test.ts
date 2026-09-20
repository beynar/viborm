import assert from "node:assert/strict";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { describe, it } from "vitest";
import type { ScenarioDefinition } from "./harness/protocol";
import { verifyG0Pair } from "./harness/replay";
import { runSQLiteWorld } from "./harness/sqlite-world";
import { G0_PROFILES } from "./profiles";
import { fixedScenarios } from "./scenarios/contracts";

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

// The `program/` comparison specimen ran this cell too, until it was deleted;
// key order is a property of the SHIPPED engine's admission, so the cell that
// remains is the one that was always the witness.
describe("Raptor 3 relation key order: commands", () => {
  it.each(G0_PROFILES)("%s", async (profile) => {
    const original = await runSQLiteWorld(changedDependency, profile, 0);
    const reordered = await runSQLiteWorld(reorderedDependency, profile, 0);
    verifyG0Pair(original, reordered);

    const candidate = await runSQLiteWorld(reorderedDependency, profile, 0, {
      candidateFactory: createCommandEngine,
      candidateName: "commands",
    });
    verifyG0Pair(reordered, candidate);
  });
});
