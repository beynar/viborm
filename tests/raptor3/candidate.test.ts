import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { createProgramEngine } from "@query-engine/raptor3/program";
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
import { verifyProgramEnginePair } from "./scenarios/contracts/instances";

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
            name === "commands" &&
            (scenario.id === "s2-distinct-defaults" ||
              scenario.id === "s2-changed-dependency")
          )
            records.push(baseline.record, compared.record);
          if (name === "program") verifyProgramEnginePair(baseline, compared);
          else verifyG0Pair(baseline, compared);

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
