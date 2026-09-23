import assert from "node:assert/strict";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { describe, it } from "vitest";
import type { ScenarioDefinition } from "./harness/protocol";
import { verifyG0Pair } from "./harness/replay";
import { runSQLiteWorld } from "./harness/sqlite-world";
import { G0_PROFILES } from "./profiles";
import { fixedScenarios } from "./scenarios/contracts";

const grouped = fixedScenarios.find((scenario) => scenario.id === "s3-grouped");
assert.ok(grouped);

const readings = [
  { id: 1, category: "alpha", amount: 100 },
  { id: 2, category: "alpha", amount: 50 },
  { id: 3, category: "beta", amount: 200 },
  { id: 4, category: "excluded", amount: 99 },
];
const pages = [
  {
    name: "take one",
    args: { take: 1 },
    rows: [{ category: "alpha", _count: 2, _sum: { amount: 150 } }],
  },
  {
    name: "skip one and take one",
    args: { take: 1, skip: 1 },
    rows: [{ category: "beta", _count: 1, _sum: { amount: 200 } }],
  },
];

// The `program/` comparison specimen ran the same two pages until it was
// deleted; grouped pagination is a fact about the shipped engine, and these
// cells still read it against the harness baseline.
describe("Raptor 3 grouped pagination: commands", () => {
  for (const page of pages) {
    const scenario: ScenarioDefinition = {
      ...grouped,
      prepare(controls) {
        const fixture = grouped.prepare(controls);
        // This exact fixture publishes the args object captured by invoke.
        const publicInput = fixture.publicInput as {
          args: { take?: number; skip?: number };
        };
        Object.assign(publicInput.args, page.args);
        return {
          ...fixture,
          assert(observation) {
            assert.deepEqual(observation.initial, { readings });
            assert.deepEqual(observation.final, { readings });
            assert.deepEqual(observation.defaults, []);
            assert.deepEqual(observation.reachedCuts, []);
            assert.deepEqual(observation.outcome, {
              kind: "success",
              value: page.rows,
            });
          },
        };
      },
    };

    it.each(G0_PROFILES)(`${page.name}: %s`, async (profile) => {
      const baseline = await runSQLiteWorld(scenario, profile, 0);
      baseline.fixture.assert(baseline.observation);
      const candidate = await runSQLiteWorld(scenario, profile, 0, {
        candidateFactory: createCommandEngine,
      });
      verifyG0Pair(baseline, candidate);
    });
  }
});
