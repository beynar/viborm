import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "vitest";
import { captureRaptor3Identity } from "../../../scripts/raptor3-manifest.mjs";
import type { G0ReplayRecord } from "../harness/protocol";
import { encodeReplayRecords } from "../harness/replay";
import { runSQLiteWorld } from "../harness/sqlite-world";
import { junctionIdentityScenarios } from "./junction-identity";

const records: G0ReplayRecord[] = [];
describe("G2 unique junction COC identity: legacy atomic SQLite", () => {
  for (const scenario of junctionIdentityScenarios) {
    it(scenario.id, async () => {
      const world = await runSQLiteWorld(scenario, "sqlite-atomic-batch", 0);
      records.push(world.record);
      const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
      if (directory)
        await writeFile(
          join(directory, "g2-junction-identity-legacy-corpus.json"),
          JSON.stringify({
            formatVersion: 1,
            identity: captureRaptor3Identity(),
            records: encodeReplayRecords(records),
          })
        );
      world.fixture.assert(world.observation);
    });
  }
});
