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
import { lifetimeScenarios } from "./lifetimes";

const adjudicated: G0ReplayRecord[] = [];
afterAll(async () => {
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  if (directory)
    await writeFile(
      join(directory, "adjudicated-upsert-admission-corpus.json"),
      JSON.stringify({
        formatVersion: 1,
        identity: captureRaptor3Identity(),
        records: encodeReplayRecords(adjudicated),
      })
    );
});

describe.each(
  G0_PROFILES
)("G1 legality and engine lifetimes: commands %s", (profile) => {
  for (const scenario of lifetimeScenarios) {
    it(scenario.id, async () => {
      const baseline = await runSQLiteWorld(scenario, profile, 0);
      baseline.fixture.assert(baseline.observation);
      const candidate = await runSQLiteWorld(scenario, profile, 0, {
        candidateFactory: createCommandEngine,
        candidateName: "commands",
      });
      if (scenario.id === "g1-upsert-nested-admission-publication") {
        adjudicated.push(baseline.record, candidate.record);
        // Since C-01 the client route and the command engine admit the same
        // input once each: the discarded second parse the deleted engine
        // published has no arm left, so the two ledgers agree exactly.
        verifyG0Pair(baseline, candidate);
        for (const record of [baseline.record, candidate.record])
          for (let replay = 0; replay < 3; replay++) await replayG0Run(record);
      } else verifyG0Pair(baseline, candidate);
    });
  }
});
