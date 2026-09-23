import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "vitest";
import { captureRaptor3Identity } from "../../scripts/raptor3-manifest.mjs";
import { G0_PROFILES } from "./profiles";
import {
  decodeReplayRecords,
  encodeReplayRecords,
  replayG0Run,
  verifyG0Pair,
} from "./harness/replay";
import { runSQLiteWorld } from "./harness/sqlite-world";
import { verifyGeneratedCell } from "./generation/campaign";
import {
  generatedRelations,
  shrinkRecipe,
  type GeneratedRecipe,
} from "./generation/relations";

const padded: GeneratedRecipe = {
  seed: 1000,
  verb: "create",
  members: [
    { found: false, label: 500 },
    { found: false, label: 600 },
    { found: false, label: 700 },
  ],
  decoys: 3,
  actors: 2,
  fault: "none",
};

it("shrinks a real wrong-parent world while preserving the named failure and exact replay", async () => {
  const originalCopy = structuredClone(padded);
  const fail = async (recipe: GeneratedRecipe) => {
    const world = await runSQLiteWorld(
      generatedRelations(recipe, true),
      "sqlite-interactive",
      recipe.seed
    );
    try {
      verifyG0Pair(world, world);
    } catch (failure) {
      if (
        failure instanceof Error &&
        failure.message.includes("generated:membership")
      )
        return world;
      throw failure;
    }
    return undefined;
  };
  const original = await fail(padded);
  assert(original, "Original padded specimen must fail the named property");
  const shrink = await shrinkRecipe(padded, async (recipe) =>
    Boolean(await fail(recipe))
  );
  assert.deepEqual(padded, originalCopy);
  assert.equal(shrink.reduced.members.length, 1);
  assert.equal(shrink.reduced.members[0]!.label, 0);
  assert.equal(shrink.reduced.decoys, 0);
  assert.equal(shrink.reduced.actors, 1);
  const reduced = await fail(shrink.reduced);
  assert(reduced);
  const savedRecords = decodeReplayRecords(
    encodeReplayRecords([original.record, reduced.record])
  );
  for (const record of savedRecords)
    for (let replay = 0; replay < 3; replay++)
      await assert.rejects(() => replayG0Run(record), /generated:membership/);
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  if (directory) {
    await writeFile(
      join(directory, "shrink-corpus.json"),
      JSON.stringify({
        formatVersion: 1,
        identity: captureRaptor3Identity(),
        records: encodeReplayRecords(savedRecords),
      })
    );
    await writeFile(
      join(directory, "shrink-evidence.json"),
      JSON.stringify({
        identity: captureRaptor3Identity(),
        specimen: "wrong-parent-world",
        property: "generated:membership",
        ...shrink,
        records: encodeReplayRecords([original.record, reduced.record]),
      })
    );
  }
});

for (const profile of G0_PROFILES) {
  it(`preserves two failed actors then a successful healthy suffix: ${profile}`, async () => {
    const records = await verifyGeneratedCell(
      { ...padded, fault: "two-before-dispatch" },
      profile
    );
    assert.equal(
      records[1]!.tape.events.filter(
        (event) => event.kind === "injected-failure"
      ).length,
      2
    );
  });
}
