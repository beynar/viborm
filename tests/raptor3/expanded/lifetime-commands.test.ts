import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { afterAll, describe, it } from "vitest";
import { assertEquivalentRunObservations } from "../../../benchmarks/operation-pipeline-semantics.mjs";
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
        candidate.fixture.assert(candidate.observation);
        // Both raw ledgers have passed their exact oracles. Only the explicitly
        // retired, discarded second parse differs; stored values stay identical.
        assertEquivalentRunObservations(
          scenario.id,
          {
            ...baseline.observation,
            defaults: baseline.observation.defaults.slice(0, 1),
          },
          candidate.observation
        );
        assert.throws(() =>
          candidate.fixture.assert({
            ...candidate.observation,
            defaults: baseline.observation.defaults,
          })
        );
        for (const record of [baseline.record, candidate.record])
          for (let replay = 0; replay < 3; replay++) await replayG0Run(record);
      } else verifyG0Pair(baseline, candidate);
    });
  }
});
