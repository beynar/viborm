import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { captureRaptor3Identity } from "../../../scripts/raptor3-manifest.mjs";
import { G2_OWN_WRITE_CASE_IDS } from "../contracts";
import type { G0ReplayRecord } from "../harness/protocol";
import { encodeReplayRecords } from "../harness/replay";
import { runSQLiteWorld } from "../harness/sqlite-world";
import { G0_PROFILES } from "../profiles";
import { ownWriteScenarios } from "./own-write";

assert.deepEqual(
  ownWriteScenarios.map((scenario) => scenario.id),
  G2_OWN_WRITE_CASE_IDS
);

const records: G0ReplayRecord[] = [];
afterAll(async () => {
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  if (!directory) return;
  await writeFile(
    join(directory, "g2-own-write-legacy-corpus.json"),
    JSON.stringify({
      formatVersion: 1,
      identity: captureRaptor3Identity(),
      records: encodeReplayRecords(records),
    })
  );
});

describe.each(G0_PROFILES)("G2 OwnWrite: legacy %s", (profile) => {
  for (const scenario of ownWriteScenarios) {
    it(scenario.id, async () => {
      const world = await runSQLiteWorld(scenario, profile, 0);
      records.push(world.record);
      world.fixture.assert(world.observation);
    });
  }
});
