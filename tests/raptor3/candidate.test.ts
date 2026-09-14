import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { createProgramEngine } from "@query-engine/raptor3/program";
import { isRecord } from "@validation/value-guards";
import { afterAll, describe, it } from "vitest";
import { captureRaptor3Identity } from "../../scripts/raptor3-manifest.mjs";
import type {
  CandidateEngineFactory,
  G0ReplayRecord,
} from "./harness/protocol";
import {
  assertFixedInventory,
  encodeReplayRecords,
  verifyG0Pair,
} from "./harness/replay";
import { runSQLiteWorld } from "./harness/sqlite-world";
import { G0_PROFILES } from "./profiles";
import { fixedScenarios } from "./scenarios/contracts";
import {
  verifyChangedDependencyCommandsProgress,
  verifyInstanceAdmissionPair,
} from "./scenarios/contracts/instances";

const records: G0ReplayRecord[] = [];
afterAll(async () => {
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  if (directory)
    await writeFile(
      join(directory, "adjudicated-instance-admission-corpus.json"),
      JSON.stringify({
        formatVersion: 1,
        identity: captureRaptor3Identity(),
        records: encodeReplayRecords(records),
      })
    );
});

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

assertFixedInventory(fixedScenarios, G0_PROFILES);

for (const [name, factory] of Object.entries(candidates)) {
  describe(`Raptor 3 G1-01: ${name}`, () => {
    describe.each(G0_PROFILES)("%s", (profile) => {
      for (const scenario of fixedScenarios) {
        it(scenario.id, async () => {
          const baseline = await runSQLiteWorld(scenario, profile, 0);
          const compared = await runSQLiteWorld(scenario, profile, 0, {
            candidateFactory: factory,
            ...(name === "commands"
              ? { candidateName: "commands" as const }
              : {}),
          });
          if (
            scenario.id === "s2-distinct-defaults" ||
            scenario.id === "s2-changed-dependency"
          ) {
            if (name === "commands")
              records.push(baseline.record, compared.record);
            verifyInstanceAdmissionPair(baseline, compared);
            if (
              name === "commands" &&
              scenario.id === "s2-changed-dependency" &&
              profile === "sqlite-atomic-batch"
            ) {
              const baselineOutcome = baseline.observation.outcome;
              const comparedOutcome = compared.observation.outcome;
              assert.equal(baselineOutcome.kind, "failure");
              assert.equal(comparedOutcome.kind, "failure");
              const comparedMeta = comparedOutcome.failure.meta;
              assert(isRecord(comparedMeta));
              const comparedProgress = comparedMeta.recordSeriesProgress;
              assert(isRecord(comparedProgress));
              const {
                memberPath: _memberPath,
                totalMembers: _totalMembers,
                ...incompleteProgress
              } = comparedProgress;
              assert.throws(() =>
                verifyChangedDependencyCommandsProgress(baselineOutcome, {
                  ...comparedOutcome,
                  failure: {
                    ...comparedOutcome.failure,
                    meta: {
                      ...comparedMeta,
                      recordSeriesProgress: incompleteProgress,
                    },
                  },
                })
              );
            }
            assert.throws(() =>
              compared.fixture.assert({
                ...compared.observation,
                defaults: baseline.observation.defaults,
              })
            );
          } else verifyG0Pair(baseline, compared);

          for (let replay = 0; replay < 3; replay += 1) {
            const replayed = await runSQLiteWorld(scenario, profile, 0, {
              candidateFactory: factory,
              ...(name === "commands"
                ? { candidateName: "commands" as const }
                : {}),
              replay: compared.record.tape,
            });
            replayed.fixture.assert(replayed.observation);
            assert.deepEqual(
              encodeReplayRecords([replayed.record]),
              encodeReplayRecords([compared.record])
            );
          }
        });
      }
    });
  });
}
