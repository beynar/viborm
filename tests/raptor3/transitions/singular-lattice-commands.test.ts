import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { afterAll, describe, it } from "vitest";
import { captureRaptor3Identity } from "../../../scripts/raptor3-manifest.mjs";
import type { G0ReplayRecord } from "../harness/protocol";
import {
  encodeReplayRecords,
  replayG0Run,
  verifyG0Pair,
} from "../harness/replay";
import { runSQLiteWorld } from "../harness/sqlite-world";
import { G0_PROFILES } from "../profiles";
import {
  singularLatticeScenarios,
  assertLatticeDispatch,
} from "./singular-lattice";

const records: G0ReplayRecord[] = [];
afterAll(async () => {
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  if (directory)
    await writeFile(
      join(directory, "g2-lattice-corpus.json"),
      JSON.stringify({
        formatVersion: 1,
        identity: captureRaptor3Identity(),
        records: encodeReplayRecords(records),
      })
    );
});

describe.each(
  G0_PROFILES
)("G2 complete child-held lattice: commands %s", (profile) => {
  for (const scenario of singularLatticeScenarios)
    it(scenario.id, async () => {
      const baseline = await runSQLiteWorld(scenario, profile, 0);
      records.push(baseline.record);
      baseline.fixture.assert(baseline.observation);
      assertLatticeDispatch(baseline.record);
      const candidate = await runSQLiteWorld(scenario, profile, 0, {
        candidateFactory: createCommandEngine,
        candidateName: "commands",
      });
      records.push(candidate.record);
      verifyG0Pair(baseline, candidate);
      assertLatticeDispatch(candidate.record);
      for (let replay = 0; replay < 3; replay++)
        await replayG0Run(candidate.record);
    });
});
