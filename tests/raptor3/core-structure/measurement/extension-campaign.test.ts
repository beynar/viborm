import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "vitest";
import { captureRaptor3Identity } from "../../../../scripts/raptor3-manifest.mjs";
import { encodeReplayRecords } from "../../harness/replay";
import { runExtensionCampaign } from "./extension-campaign";
import type { ExtensionSlice } from "./extension-recipes";

function requestedSlice(): ExtensionSlice {
  const slice = process.env.VIBORM_RAPTOR3_EXTENSION_SLICE ?? "a";
  assert(
    slice === "a" || slice === "b" || slice === "composition",
    `Unknown CS-03 extension campaign slice ${slice}`
  );
  return slice;
}

it("completes one exact admitted CS-03 extension seed batch", async () => {
  const campaign = await runExtensionCampaign(requestedSlice());
  for (const profile of campaign.profiles)
    assert.equal(
      campaign.completed.filter((cell) => cell.profile === profile).length,
      100
    );
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  if (!directory) return;
  const identity = captureRaptor3Identity();
  await writeFile(
    join(directory, "corpus.json"),
    JSON.stringify({
      formatVersion: 1,
      identity,
      records: encodeReplayRecords(campaign.records),
    })
  );
  const { records, ...receipt } = campaign;
  await writeFile(
    join(directory, "extension-campaign.json"),
    JSON.stringify({ identity, ...receipt }, null, 2)
  );
}, 120_000);
