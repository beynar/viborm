import assert from "node:assert/strict";
import { it } from "vitest";
import { TRANSPORT_PROFILES } from "../../profiles";
import {
  G3_GENERATED_CONTRACTS,
  g3RecipeFromPublicInput,
  type G3GeneratedRecipe,
} from "./recipe";
import { verifyG3TransportCell } from "./transport-campaign";

function representativeRecipes(): G3GeneratedRecipe[] {
  const admit = (recipe: unknown) => g3RecipeFromPublicInput({ recipe });
  return [
    admit({
      seed: 8004,
      contract: "C08",
      actors: 1,
      operations: 1,
      fault: "none",
      verb: "updateMany",
      presentation: "count",
      rowCount: 2,
      limit: 0,
    }),
    admit({
      seed: 8020,
      contract: "C08",
      actors: 2,
      operations: 2,
      fault: "none",
      verb: "createMany",
      presentation: "count",
      rowCount: 1,
      limit: 0,
    }),
    admit({
      seed: 8016,
      contract: "C08",
      actors: 1,
      operations: 2,
      fault: "legal-provider-failure",
      verb: "createMany",
      presentation: "omit",
      rowCount: 1,
      limit: 0,
    }),
    admit({
      seed: 8009,
      contract: "C09",
      actors: 1,
      operations: 2,
      fault: "none",
      conflict: "root",
      healthySuffix: true,
    }),
    admit({
      seed: 8005,
      contract: "C09",
      actors: 2,
      operations: 2,
      fault: "none",
      conflict: "root",
      healthySuffix: true,
    }),
    admit({
      seed: 8021,
      contract: "C09",
      actors: 1,
      operations: 3,
      fault: "legal-provider-failure",
      conflict: "root",
      healthySuffix: true,
    }),
    admit({
      seed: 8014,
      contract: "C10",
      actors: 1,
      operations: 1,
      fault: "none",
      composition: "borrowed",
    }),
    admit({
      seed: 8010,
      contract: "C10",
      actors: 2,
      operations: 2,
      fault: "none",
      composition: "atomic-array",
    }),
    admit({
      seed: 8026,
      contract: "C10",
      actors: 1,
      operations: 2,
      fault: "legal-provider-failure",
      composition: "borrowed",
    }),
    admit({
      seed: 8019,
      contract: "C11",
      actors: 1,
      operations: 1,
      fault: "none",
      depth: 2,
      fanout: 2,
      shape: "ordinary",
    }),
    admit({
      seed: 8015,
      contract: "C11",
      actors: 2,
      operations: 2,
      fault: "none",
      depth: 2,
      fanout: 2,
      shape: "compound",
    }),
    admit({
      seed: 8011,
      contract: "C11",
      actors: 1,
      operations: 2,
      fault: "legal-provider-failure",
      depth: 2,
      fanout: 2,
      shape: "variant",
    }),
    admit({
      seed: 8023,
      contract: "C11",
      actors: 1,
      operations: 1,
      fault: "none",
      depth: 2,
      fanout: 2,
      shape: "repeated",
    }),
    admit({
      seed: 8027,
      contract: "C11",
      actors: 1,
      operations: 1,
      fault: "none",
      depth: 0,
      fanout: 3,
      shape: "repeated",
    }),
    admit({
      seed: 8031,
      contract: "C11",
      actors: 1,
      operations: 1,
      fault: "none",
      depth: 2,
      fanout: 0,
      shape: "repeated",
    }),
  ];
}

function coverageAxis(recipe: G3GeneratedRecipe): string {
  if (recipe.actors === 2) return `${recipe.contract}:overlap`;
  if (recipe.fault !== "none") return `${recipe.contract}:fault-recovery`;
  return `${recipe.contract}:plain-success`;
}

it("executes and exactly replays the representative C08-C11 transport matrix", async () => {
  // Transport plans derive expected replies from the fixed contract oracles;
  // this smoke only proves every admitted family/axis reaches both TW and TA.
  const recipes = representativeRecipes();
  const coveredAxes = new Set<string>();
  const recurrenceShapes = new Set<string>();
  for (const recipe of recipes) {
    coveredAxes.add(coverageAxis(recipe));
    if (recipe.contract === "C11") recurrenceShapes.add(recipe.shape);
    for (const profile of TRANSPORT_PROFILES)
      await verifyG3TransportCell(recipe, profile);
  }
  assert.deepEqual(
    [...coveredAxes].sort(),
    G3_GENERATED_CONTRACTS.flatMap((contract) => [
      `${contract}:fault-recovery`,
      `${contract}:overlap`,
      `${contract}:plain-success`,
    ]).sort()
  );
  assert.deepEqual([...recurrenceShapes].sort(), [
    "compound",
    "ordinary",
    "repeated",
    "variant",
  ]);
});
