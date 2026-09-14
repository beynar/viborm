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
const candidates: Record<"commands" | "program", CandidateEngineFactory> = {
  commands: createCommandEngine,
  program: (config) => {
    const engine = createProgramEngine(config);
    return {
      execute: (...args) => engine.execute(...args),
      prepareBatch: async () => undefined,
    };
  },
};

for (const [name, factory] of Object.entries(candidates)) {
  describe(`Raptor 3 grouped pagination: ${name}`, () => {
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
          candidateFactory: factory,
        });
        verifyG0Pair(baseline, candidate);
      });
    }
  });
}
