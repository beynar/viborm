import assert from "node:assert/strict";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { describe, it } from "vitest";
import { encodeEvidenceValue } from "../../../../benchmarks/operation-pipeline-evidence.mjs";
import { G0_PROFILES } from "../../profiles";
import {
  decodeReplayRecords,
  replayG0Run,
} from "../../harness/replay";
import { runSQLiteWorld } from "../../harness/sqlite-world";
import { generatedBulkScenario } from "./bulk-scenario";
import {
  G3_GENERATED_CONTRACTS,
  g3RecipeFromPublicInput,
  generateG3Recipe,
  shrinkG3Recipe,
  type G3GeneratedRecipe,
} from "./recipe";
import { verifyG3SQLiteCell } from "./sqlite-campaign";

const bulkSmoke = g3RecipeFromPublicInput({
  recipe: {
    seed: 8000,
    contract: "C08",
    actors: 1,
    operations: 1,
    fault: "none",
    verb: "createMany",
    presentation: "omit",
    rowCount: 3,
    limit: 0,
  },
});
assert.equal(bulkSmoke.contract, "C08");
if (bulkSmoke.contract !== "C08") throw new Error("Unreachable G3 recipe");

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
      presentation: "select",
      rowCount: 2,
      limit: 0,
    }),
    admit({
      seed: 8020,
      contract: "C08",
      actors: 2,
      operations: 2,
      fault: "none",
      verb: "updateMany",
      presentation: "count",
      rowCount: 1,
      limit: 1,
    }),
    admit({
      seed: 8016,
      contract: "C08",
      actors: 1,
      operations: 2,
      fault: "legal-provider-failure",
      verb: "deleteMany",
      presentation: "omit",
      rowCount: 1,
      limit: 1,
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
  ];
}

function coverageAxis(recipe: G3GeneratedRecipe): string {
  if (recipe.actors === 2) return `${recipe.contract}:overlap`;
  if (recipe.fault !== "none") return `${recipe.contract}:fault-recovery`;
  return `${recipe.contract}:plain-success`;
}

it("maps every new G3 ID to the frozen family and quota schedule", () => {
  const ids = new Set<number>();
  for (let firstSeed = 8000; firstSeed < 18_000; firstSeed += 100) {
    const recipes = Array.from({ length: 100 }, (_, offset) =>
      generateG3Recipe(firstSeed + offset)
    );
    for (const recipe of recipes) {
      ids.add(recipe.seed);
      assert(recipe.operations >= 1 && recipe.operations <= 32);
      if (
        recipe.contract === "C08" &&
        recipe.verb !== "createMany" &&
        (recipe.actors === 2 || recipe.fault !== "none")
      )
        assert(recipe.limit > 0);
    }
    assert.equal(recipes.filter(({ actors }) => actors === 2).length, 20);
    assert.equal(
      recipes.filter(({ fault }) => fault !== "none").length,
      20
    );
    assert.deepEqual(
      G3_GENERATED_CONTRACTS.map(
        (contract) =>
          recipes.filter((recipe) => recipe.contract === contract).length
      ),
      [25, 25, 25, 25]
    );
  }
  assert.equal(ids.size, 10_000);
  assert.equal(Math.min(...ids), 8000);
  assert.equal(Math.max(...ids), 17_999);
});

it("rejects non-G3 public recipes and shrinks only through admitted inputs", async () => {
  assert.throws(() => generateG3Recipe(7999));
  assert.throws(() =>
    g3RecipeFromPublicInput({
      recipe: { ...bulkSmoke, unexpected: true },
    })
  );
  assert.throws(() =>
    g3RecipeFromPublicInput({
      recipe: {
        ...bulkSmoke,
        actors: 2,
        operations: 2,
        verb: "deleteMany",
        limit: 0,
      },
    })
  );
  assert.throws(() =>
    g3RecipeFromPublicInput({
      recipe: {
        ...bulkSmoke,
        operations: 2,
        fault: "legal-provider-failure",
        verb: "updateMany",
        limit: 0,
      },
    })
  );
  const padded = g3RecipeFromPublicInput({
    recipe: {
      ...bulkSmoke,
      actors: 2,
      operations: 32,
      fault: "legal-provider-failure",
      rowCount: 8,
      limit: 8,
    },
  });
  const original = structuredClone(padded);
  const shrink = await shrinkG3Recipe(padded, async () => true);
  assert.deepEqual(padded, original);
  assert.deepEqual(shrink.reduced, {
    ...bulkSmoke,
    rowCount: 1,
  });
  assert(shrink.attempts > 0 && shrink.attempts <= 64);
});

describe.each(G0_PROFILES)("G3 generated C08 smoke: %s", (profile) => {
  it("executes a source-bound public recipe and exactly replays it", async () => {
    const world = await runSQLiteWorld(
      generatedBulkScenario(bulkSmoke),
      profile,
      bulkSmoke.seed,
      { candidateFactory: createCommandEngine, candidateName: "commands" }
    );
    world.fixture.assert(world.observation);
    for (let replay = 0; replay < 3; replay++) await replayG0Run(world.record);
  });
});

it("executes and exactly replays the representative C08-C11 SQLite matrix", async () => {
  // The fixed G3 C08-C11 contracts remain the behavior oracles. This smoke
  // owns only representative public recipe/profile/replay coverage before the
  // 10,000-ID campaign required by plan §5.5.
  const recipes = representativeRecipes();
  const coveredAxes = new Set<string>();
  const recurrenceShapes = new Set<string>();
  for (const recipe of recipes) {
    coveredAxes.add(coverageAxis(recipe));
    if (recipe.contract === "C11") recurrenceShapes.add(recipe.shape);
    for (const profile of G0_PROFILES)
      await verifyG3SQLiteCell(recipe, profile);
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

it("fails closed for an unknown G3 recipe or lane", async () => {
  const world = await runSQLiteWorld(
    generatedBulkScenario(bulkSmoke),
    "sqlite-interactive",
    bulkSmoke.seed,
    { candidateFactory: createCommandEngine, candidateName: "commands" }
  );
  const corruptRecipe = structuredClone(world.record);
  corruptRecipe.publicInput = {
    recipe: { ...bulkSmoke, contract: "C99" },
  };
  await assert.rejects(() => replayG0Run(corruptRecipe));
  assert.throws(() =>
    decodeReplayRecords(
      encodeEvidenceValue([
        { ...world.record, profile: "sqlite-unknown-lane" },
      ])
    )
  );
});
