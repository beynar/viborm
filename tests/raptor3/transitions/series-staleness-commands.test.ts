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
import { seriesStalenessScenarios } from "./series-staleness";

const records: G0ReplayRecord[] = [];
afterAll(async () => {
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  if (!directory) return;
  await writeFile(
    join(directory, "g2-series-staleness-corpus.json"),
    JSON.stringify({
      formatVersion: 1,
      identity: captureRaptor3Identity(),
      records: encodeReplayRecords(records),
    })
  );
});

describe("G2 admitted nested series staleness: atomic SQLite commands", () => {
  for (const scenario of seriesStalenessScenarios) {
    it(scenario.id, async () => {
      const baseline = await runSQLiteWorld(scenario, "sqlite-atomic-batch", 0);
      records.push(baseline.record);
      baseline.fixture.assert(baseline.observation);
      const candidate = await runSQLiteWorld(
        scenario,
        "sqlite-atomic-batch",
        0,
        {
          candidateFactory: createCommandEngine,
          candidateName: "commands",
        }
      );
      records.push(candidate.record);
      verifyG0Pair(baseline, candidate);
      for (let replay = 0; replay < 3; replay++)
        await replayG0Run(candidate.record);
    });
  }
});
