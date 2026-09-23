import assert from "node:assert/strict";
import { it } from "vitest";
import type { ProfileId } from "../../profiles";
import { verifyExtensionCell } from "./extension-campaign";
import { generateExtensionRecipe } from "./extension-recipes";

const representativeASeeds = [
  7103, 7112, 7117, 7128, 7133, 7144, 7149, 7160, 7109, 7119,
] as const;
const profiles: readonly ProfileId[] = [
  "sqlite-interactive",
  "sqlite-atomic-batch",
];
const representativeACells = representativeASeeds.flatMap((seed) =>
  profiles.map((profile) => ({ seed, profile }))
);
const representativeBCells = [7200, 7201, 7202, 7203, 7204, 7205, 7214].flatMap(
  (seed) => profiles.map((profile) => ({ seed, profile }))
);
const representativeCompositionCells = [7300, 7305, 7310, 7313].flatMap(
  (seed) => profiles.map((profile) => ({ seed, profile }))
);

it.each(representativeACells)(
  "records and exactly replays CS-03 A seed $seed under $profile",
  async ({ seed, profile }) => {
    const recipe = generateExtensionRecipe("a", seed);
    const record = await verifyExtensionCell(recipe, profile);
    assert.equal(record.seed, seed);
    assert.equal(record.profile, profile);
    assert.deepEqual(record.publicInput, { recipe });
    assert.equal(
      record.observation.outcome.kind,
      recipe.outcome === "success" ? "success" : "failure"
    );
  }
);

it.each(representativeBCells)(
  "records and exactly replays CS-03 B seed $seed under $profile",
  async ({ seed, profile }) => {
    const recipe = generateExtensionRecipe("b", seed);
    const record = await verifyExtensionCell(recipe, profile);
    assert.deepEqual(record.publicInput, { recipe });
  }
);

it.each(representativeCompositionCells)(
  "records and exactly replays CS-03 composition seed $seed under $profile",
  async ({ seed, profile }) => {
    const recipe = generateExtensionRecipe("composition", seed);
    const record = await verifyExtensionCell(recipe, profile);
    assert.deepEqual(record.publicInput, { recipe });
  }
);
