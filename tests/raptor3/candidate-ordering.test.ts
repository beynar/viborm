// biome-ignore-all lint/suspicious/noMisplacedAssertion: The replay/scenario assertion helpers run from registered test cases.
import assert from "node:assert/strict";
import { createTestCommandEngine } from "@tests/raptor3/harness/command-engine";
import { isRecord } from "@validation/value-guards";
import { describe, it } from "vitest";
import type { ScenarioDefinition } from "./harness/protocol";
import { verifyG0Pair } from "./harness/replay";
import { runSQLiteWorld } from "./harness/sqlite-world";
import { G0_PROFILES } from "./profiles";
import { fixedScenarios } from "./scenarios/contracts";

const changedDependency = fixedScenarios.find(
  (scenario) => scenario.id === "s2-changed-dependency"
);
if (!changedDependency) throw new Error("Missing changed-dependency fixture.");

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
    return {
      ...fixture,
      requiredCuts: ["s2-selected-members-captured"],
      assert(observation) {
        assert.equal(observation.outcome.kind, "failure");
        if (observation.outcome.kind !== "failure") return;
        assert.equal(observation.outcome.failure.name, "UniqueConstraintError");
        assert.equal(observation.outcome.failure.code, "V3001");
        assert(isRecord(observation.outcome.failure.meta));
        assert.equal(observation.outcome.failure.meta.table, "s2_targets");
        assert.deepEqual(observation.outcome.failure.meta.columns, ["id"]);
        assert.deepEqual(
          observation.final,
          controls.profile === "sqlite-interactive"
            ? observation.initial
            : {
                shelves: [
                  { id: 1, label: "before-series" },
                  { id: 2, label: "untouched" },
                ],
                bins: [
                  { id: 10, shelfId: 1 },
                  { id: 11, shelfId: 1 },
                  { id: 12, shelfId: 2 },
                ],
                targets: [{ id: 1 }, { id: 2 }, { id: 8 }],
                memberships: [
                  { binId: 10, targetId: 1 },
                  { binId: 10, targetId: 2 },
                  { binId: 12, targetId: 8 },
                ],
              }
        );
      },
    };
  },
};

// The `program/` comparison specimen ran this cell too, until it was deleted;
// key order is a property of the SHIPPED engine's admission, so the cell that
// remains is the one that was always the witness.
describe("Raptor 3 relation key order: commands", () => {
  it.each(G0_PROFILES)("%s", async (profile) => {
    const original = await runSQLiteWorld(changedDependency, profile, 0);
    const reordered = await runSQLiteWorld(reorderedDependency, profile, 0);
    original.fixture.assert(original.observation);
    reordered.fixture.assert(reordered.observation);

    const candidate = await runSQLiteWorld(reorderedDependency, profile, 0, {
      candidateFactory: createTestCommandEngine,
      candidateName: "commands",
    });
    verifyG0Pair(reordered, candidate);
  });
});
