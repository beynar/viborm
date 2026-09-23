import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "vitest";
import { captureRaptor3Identity } from "../../scripts/raptor3-manifest.mjs";
import { runGeneratedBatch } from "./generation/campaign";
import { encodeReplayRecords } from "./harness/replay";

it("completes the exact admitted SQLite transition seed batch", async () => {
  const firstSeed = Number(
    process.env.VIBORM_RAPTOR3_GENERATED_FIRST_SEED ?? 2000
  );
  const isG2Boundary =
    firstSeed >= 2000 && firstSeed < 7000 && (firstSeed - 2000) % 100 === 0;
  assert(
    Number.isInteger(firstSeed) && (isG2Boundary || firstSeed === 7000),
    "Transition batches use the frozen 100-seed boundaries"
  );
  const campaign = await runGeneratedBatch(firstSeed);
  for (const profile of campaign.profiles) {
    const cells = campaign.completed.filter((cell) => cell.profile === profile);
    assert.equal(cells.length, 100);
    assert(
      cells.filter((cell) => cell.actorOverlap === true).length >= 20,
      "Overlap quota counts actual admission/completion evidence"
    );
    assert(
      cells.filter((cell) => cell.faults > 0).length >= 20,
      "Fault quota counts actual injections"
    );
    assert(
      cells.every(
        (cell) =>
          cell.operations !== undefined &&
          cell.operations >= 1 &&
          cell.operations <= 16
      )
    );
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
