import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { captureRaptor3Identity } from "../../../scripts/raptor3-manifest.mjs";
import type { G0ReplayRecord } from "../harness/protocol";
import {
  decodeReplayRecords,
  encodeReplayRecords,
  replayG0Run,
} from "../harness/replay";
import { runSQLiteWorld } from "../harness/sqlite-world";
import { conditionalUpsertScenarios } from "./conditional-upsert";

const records: G0ReplayRecord[] = [];
afterAll(async () => {
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  if (!directory) return;
  await writeFile(
    join(directory, "g2-conditional-upsert-legacy-corpus.json"),
    JSON.stringify({
      formatVersion: 1,
      identity: captureRaptor3Identity(),
      records: encodeReplayRecords(records),
    })
  );
});

describe("G2 captured conditional upserts: legacy SQLite", () => {
  for (const scenario of conditionalUpsertScenarios)
    for (const profile of scenario.profiles)
      it(`${scenario.id}: ${profile}`, async () => {
        const world = await runSQLiteWorld(scenario, profile, 0);
        records.push(world.record);
        world.fixture.assert(world.observation);
        const saved = decodeReplayRecords(
          encodeReplayRecords([world.record])
        )[0]!;
        for (let replay = 0; replay < 3; replay++) await replayG0Run(saved);
      });
});
