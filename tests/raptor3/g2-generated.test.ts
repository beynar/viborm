import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { afterAll, it } from "vitest";
import { captureRaptor3Identity } from "../../scripts/raptor3-manifest.mjs";
import { G0_PROFILES } from "./profiles";
import type { G0ReplayRecord } from "./harness/protocol";
import {
  decodeReplayRecords,
  encodeReplayRecords,
  replayG0Run,
} from "./harness/replay";
import { runSQLiteWorld } from "./harness/sqlite-world";
import { verifyGeneratedCell } from "./generation/campaign";
import {
  generatedTransitions,
  generateTransitionRecipe,
  shrinkTransitionRecipe,
  TRANSITION_MODES,
  type TransitionRecipe,
} from "./generation/transitions";

const records: G0ReplayRecord[] = [];
const reductions: unknown[] = [];
const padded: TransitionRecipe = {
  seed: 2000,
  mode: "key-move",
  offset: 900,
  value: 700,
  delta: 9,
  decoys: 3,
  actors: 2,
  following: 15,
  fault: "none",
};

afterAll(async () => {
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  if (!directory) return;
  const identity = captureRaptor3Identity();
  await writeFile(
    join(directory, "g2-generated-corpus.json"),
    JSON.stringify({
      formatVersion: 1,
      identity,
      records: encodeReplayRecords(records),
    })
  );
  await writeFile(
    join(directory, "g2-generated-shrinks.json"),
    JSON.stringify({ identity, reductions }, null, 2)
  );
});

for (const profile of G0_PROFILES) {
  it(`pins the approved single-admission ledger against duplicate and missing entries: ${profile}`, async () => {
    const recipe = { ...padded, actors: 1 as const, following: 1 };
    const world = await runSQLiteWorld(
      generatedTransitions(recipe),
      profile,
      recipe.seed,
      { candidateFactory: createCommandEngine, candidateName: "commands" }
    );
    world.fixture.assert(world.observation);
    const [primary, ...following] = world.observation.defaults;
    assert.throws(
      () =>
        world.fixture.assert({
          ...world.observation,
          defaults: [primary!, primary!, ...following],
        }),
      /transition:admission-ledger/
    );
    assert.throws(
      () =>
        world.fixture.assert({
          ...world.observation,
          defaults: following,
        }),
      /transition:admission-ledger/
    );
    records.push(world.record);
    for (let replay = 0; replay < 3; replay++) await replayG0Run(world.record);
  });

  for (const [index, mode] of TRANSITION_MODES.entries()) {
    it(`G2 generated fixed ${mode}: ${profile}`, async () => {
      const refused =
        mode === "required-depart" ||
        mode === "coc-set-same" ||
        mode === "delete-update";
      records.push(
        ...(await verifyGeneratedCell(
          { ...padded, seed: 2100 + index, mode, actors: refused ? 1 : 2 },
          profile
        ))
      );
    });
  }

  for (const [index, fault] of (
    ["before-dispatch", "after-key-write", "two-before-dispatch"] as const
  ).entries()) {
    it(`G2 generated ${fault} followed by healthy calls: ${profile}`, async () => {
      const pair = await verifyGeneratedCell(
        {
          ...padded,
          seed: 2120 + index,
          fault,
          actors: fault === "two-before-dispatch" ? 2 : 1,
        },
        profile
      );
      records.push(...pair);
      assert.equal(
        pair[1]!.tape.events.filter(
          (event) => event.kind === "injected-failure"
        ).length,
        fault === "two-before-dispatch" ? 2 : 1
      );
      assert.equal(
        pair[1]!.observation.subsequentOutcomes?.at(-1)?.kind,
        "success"
      );
    });
  }

  for (let seed = 2000; seed < 2008; seed++) {
    it(`G2 generated seed ${seed}: ${profile}`, async () => {
      const recipe = generateTransitionRecipe(seed);
      const pair = await verifyGeneratedCell(recipe, profile);
      records.push(...pair);
      const events = pair[1]!.tape.events;
      assert.equal(
        events.some(
          (event) =>
            event.kind === "cut" &&
            event.name === "transition-actors-overlapped"
        ),
        recipe.actors === 2
      );
      assert.equal(
        events.filter((event) => event.kind === "injected-failure").length,
        recipe.fault === "none" ? 0 : 1
      );
    });
  }

  it(`G2 shrinks actual wrong-parent publication and exactly replays the same property: ${profile}`, async () => {
    const originalCopy = structuredClone(padded);
    const fail = async (recipe: TransitionRecipe) => {
      const world = await runSQLiteWorld(
        generatedTransitions(recipe, true),
        profile,
        recipe.seed
      );
      try {
        world.fixture.assert(world.observation);
      } catch (failure) {
        if (
          failure instanceof Error &&
          failure.message.includes("transition:membership")
        )
          return world;
        throw failure;
      }
      return undefined;
    };
    const original = await fail(padded);
    assert(
      original,
      "The padded specimen must violate the independent membership property"
    );
    const shrink = await shrinkTransitionRecipe(padded, async (recipe) =>
      Boolean(await fail(recipe))
    );
    assert.deepEqual(padded, originalCopy);
    assert.deepEqual(shrink.reduced, {
      ...padded,
      offset: 0,
      value: 0,
      delta: 1,
      decoys: 0,
      actors: 1,
      following: 0,
    });
    const reduced = await fail(shrink.reduced);
    assert(reduced);
    const saved = decodeReplayRecords(
      encodeReplayRecords([original.record, reduced.record])
    );
    for (const record of saved) {
      for (let replay = 0; replay < 3; replay++)
        await assert.rejects(
          () => replayG0Run(record),
          /transition:membership/
        );
    }
    records.push(original.record, reduced.record);
    reductions.push({
      profile,
      property: "transition:membership",
      specimen: "wrong-parent-world",
      ...shrink,
    });
  });
}
