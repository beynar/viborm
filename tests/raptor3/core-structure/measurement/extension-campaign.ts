import assert from "node:assert/strict";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { replayG0Run } from "../../harness/replay";
import type { G0ReplayRecord } from "../../harness/protocol";
import { runSQLiteWorld } from "../../harness/sqlite-world";
import { G0_PROFILES, type ProfileId } from "../../profiles";
import {
  extensionCampaigns,
  extensionRecipes,
  type ExtensionRecipe,
  type ExtensionSlice,
} from "./extension-recipes";
import { extensionScenario } from "./extension-scenarios";

export async function verifyExtensionCell(
  recipe: ExtensionRecipe,
  profile: ProfileId
): Promise<G0ReplayRecord> {
  const scenario = extensionScenario(recipe);
  const world = await runSQLiteWorld(scenario, profile, recipe.seed, {
    candidateFactory: createCommandEngine,
    candidateName: "commands",
  });
  world.fixture.assert(world.observation);
  for (let replay = 0; replay < 3; replay += 1) await replayG0Run(world.record);
  return world.record;
}

export async function runExtensionCampaign(slice: ExtensionSlice) {
  const campaign = extensionCampaigns[slice];
  const recipes = extensionRecipes(slice);
  assert.equal(recipes.length, campaign.seedCount);
  const records: G0ReplayRecord[] = [];
  const completed: Array<{
    seed: number;
    profile: ProfileId;
    recipe: ExtensionRecipe;
    schedule: readonly string[];
    observation: G0ReplayRecord["observation"];
  }> = [];
  for (const recipe of recipes) {
    for (const profile of G0_PROFILES) {
      let record: G0ReplayRecord;
      try {
        record = await verifyExtensionCell(recipe, profile);
      } catch (failure) {
        throw new Error(
          `CS-03 ${slice} seed ${recipe.seed}, ${profile} failed`,
          { cause: failure }
        );
      }
      records.push(record);
      completed.push({
        seed: recipe.seed,
        profile,
        recipe,
        schedule: recipe.schedule,
        observation: record.observation,
      });
    }
  }
  assert.equal(
    completed.length,
    campaign.seedCount * G0_PROFILES.length,
    `CS-03 ${slice} campaign is missing required cells`
  );
  return {
    slice,
    firstSeed: campaign.firstSeed,
    seedCount: campaign.seedCount,
    profiles: G0_PROFILES,
    completed,
    records,
    replays: completed.length * 3,
    skipped: 0,
  };
}
