import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { captureRaptor3Identity } from "../../../scripts/raptor3-manifest.mjs";
import type { ProfileId } from "../profiles";
import type { G0ReplayRecord } from "../harness/protocol";
import {
  encodeReplayRecords,
  replayG0Run,
  verifyG0Pair,
} from "../harness/replay";
import { runSQLiteWorld } from "../harness/sqlite-world";
import {
  generatedFault,
  generatedRelations,
  generateRecipe,
  type GeneratedRecipe,
} from "./relations";
import {
  generatedTransitions,
  generateTransitionRecipe,
  transitionFault,
  type TransitionRecipe,
} from "./transitions";

export async function verifyGeneratedCell(
  recipe: GeneratedRecipe | TransitionRecipe,
  profile: ProfileId
) {
  const transition = "mode" in recipe;
  const scenario = transition
    ? generatedTransitions(recipe)
    : generatedRelations(recipe);
  const fault = transition ? transitionFault(recipe) : generatedFault(recipe);
  const records: G0ReplayRecord[] = [];
  let phase = "baseline";
  try {
    const baseline = await runSQLiteWorld(scenario, profile, recipe.seed, {
      fault,
    });
    records.push(baseline.record);
    baseline.fixture.assert(baseline.observation);
    phase = "commands";
    const compared = await runSQLiteWorld(scenario, profile, recipe.seed, {
      fault,
      candidateFactory: createCommandEngine,
      candidateName: "commands",
    });
    records.push(compared.record);
    // Both exact ledgers are independently pinned before this comparison of
    // the client route with the command engine; since C-01 they admit the same
    // input the same number of times, so nothing is adjudicated away.
    verifyG0Pair(baseline, compared);
    phase = "replay";
    for (let replay = 0; replay < 3; replay++)
      await replayG0Run(compared.record);
    return records;
  } catch (failure) {
    const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
    if (directory) {
      const identity = captureRaptor3Identity();
      const name = `failure-${recipe.seed}-${profile}${"mode" in recipe ? `-${recipe.mode}-${recipe.fault}-${recipe.actors}-${recipe.following}` : ""}`;
      await writeFile(
        join(directory, `${name}.json`),
        JSON.stringify(
          {
            identity,
            recipe,
            profile,
            phase,
            failure: failure instanceof Error ? failure.stack : String(failure),
          },
          null,
          2
        )
      );
      if (records.length)
        await writeFile(
          join(directory, `${name}-corpus.json`),
          JSON.stringify({
            formatVersion: 1,
            identity,
            records: encodeReplayRecords(records),
          })
        );
    }
    throw new Error(
      `${transition ? "G2" : "G1"} seed ${recipe.seed}, ${profile}, ${phase} failed`,
      {
        cause: failure,
      }
    );
  }
}

export async function runGeneratedBatch(firstSeed: number, seedCount = 100) {
  const transition = firstSeed >= 2000;
  const lastSeedExclusive = firstSeed + seedCount;
  const isG1Range = firstSeed >= 1000 && lastSeedExclusive <= 2000;
  const isG2Range = firstSeed >= 2000 && lastSeedExclusive <= 7000;
  const isG3P06Range = firstSeed === 7000 && seedCount === 100;
  assert(
    Number.isInteger(firstSeed) && (isG1Range || isG2Range || isG3P06Range),
    "Generated seeds must stay in their frozen disjoint G1, G2, or G3P-06 range"
  );
  assert(
    Number.isInteger(seedCount) && seedCount >= 1 && seedCount <= 100,
    "At most 100 distinct seeds per child"
  );
  const records: G0ReplayRecord[] = [];
  const profiles: ProfileId[] = ["sqlite-interactive", "sqlite-atomic-batch"];
  const completed: {
    seed: number;
    profile: ProfileId;
    actors: 1 | 2;
    faults: number;
    actorOverlap?: boolean;
    operations?: number;
    mode?: TransitionRecipe["mode"];
  }[] = [];
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  const identity = directory ? captureRaptor3Identity() : undefined;
  const persistProgress = async () => {
    if (!directory) return;
    const path = join(directory, "generated-campaign-progress.json");
    await writeFile(
      `${path}.tmp`,
      JSON.stringify(
        {
          formatVersion: 1,
          qualifying: false,
          status: "incomplete",
          identity,
          firstSeed,
          seedCount,
          profiles,
          completed,
          replays: completed.length * 3,
          skipped: 0,
        },
        null,
        2
      )
    );
    // A killed child leaves either the last complete receipt or its successor,
    // never a partially overwritten list of completed cells.
    await rename(`${path}.tmp`, path);
  };
  await persistProgress();
  for (let seed = firstSeed; seed < firstSeed + seedCount; seed++) {
    const recipe = transition
      ? generateTransitionRecipe(seed)
      : generateRecipe(seed);
    for (const profile of profiles) {
      const pair = await verifyGeneratedCell(recipe, profile);
      records.push(...pair);
      const actorOverlap = pair[1]!.tape.events.some(
        (event) =>
          event.kind === "cut" && event.name === "transition-actors-overlapped"
      );
      const faults = pair[1]!.tape.events.filter(
        (event) => event.kind === "injected-failure"
      ).length;
      if ("mode" in recipe) {
        assert.equal(
          actorOverlap,
          recipe.actors === 2,
          "Generated overlap quota needs the actual admission/completion witness"
        );
        assert.equal(
          faults,
          recipe.fault === "none" ? 0 : 1,
          "Generated fault quota needs an actual injected event"
        );
      }
      completed.push({
        seed,
        profile,
        actors: recipe.actors,
        faults,
        ...("mode" in recipe
          ? {
              actorOverlap,
              operations: 1 + recipe.following,
              mode: recipe.mode,
            }
          : {}),
      });
      await persistProgress();
    }
  }
  return {
    firstSeed,
    seedCount,
    profiles,
    completed,
    records,
    replays: completed.length * 3,
    skipped: 0,
  };
}
