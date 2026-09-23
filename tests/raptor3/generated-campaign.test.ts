import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "vitest";
import { captureRaptor3Identity } from "../../scripts/raptor3-manifest.mjs";
import { runGeneratedBatch } from "./generation/campaign";
import { encodeReplayRecords } from "./harness/replay";

it("completes the exact admitted G1 generated seed batch", async () => {
  const firstSeed = Number(
    process.env.VIBORM_RAPTOR3_GENERATED_FIRST_SEED ?? 1000
  );
  assert(
    Number.isInteger(firstSeed) && (firstSeed - 1000) % 100 === 0,
    "G1 batches use the frozen 100-seed boundaries"
  );
  const campaign = await runGeneratedBatch(firstSeed);
  for (const profile of campaign.profiles) {
    const cells = campaign.completed.filter((cell) => cell.profile === profile);
    assert.equal(cells.length, 100);
    assert(cells.filter((cell) => cell.actors === 2).length >= 20);
    assert(cells.filter((cell) => cell.faults > 0).length >= 20);
  }
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  if (directory) {
    await writeFile(
      join(directory, "corpus.json"),
      JSON.stringify({
        formatVersion: 1,
        identity: captureRaptor3Identity(),
        records: encodeReplayRecords(campaign.records),
      })
    );
    const { records, ...receipt } = campaign;
    await writeFile(
      join(directory, "generated-campaign.json"),
      JSON.stringify(receipt, null, 2)
    );
  }
}, 120_000);
