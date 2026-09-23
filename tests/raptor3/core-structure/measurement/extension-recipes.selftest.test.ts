import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  extensionCampaigns,
  extensionRecipeFromPublicInput,
  extensionRecipes,
  extensionSlices,
  generateExtensionRecipe,
} from "./extension-recipes";

function scheduleEdge(earlier: string, later: string): string {
  return `before:${earlier}<${later}`;
}

describe("CS-03 extension recipe contract", () => {
  it("freezes 100 distinct recipes in each disjoint seed range", () => {
    const allSeeds = new Set<number>();
    for (const slice of extensionSlices) {
      const campaign = extensionCampaigns[slice];
      const recipes = extensionRecipes(slice);
      assert.equal(recipes.length, 100);
      assert.equal(recipes[0]?.seed, campaign.firstSeed);
      assert.equal(recipes.at(-1)?.seed, campaign.firstSeed + 99);
      assert.equal(new Set(recipes.map(({ seed }) => seed)).size, 100);
      assert.equal(
        new Set(recipes.map(({ schedule }) => schedule.join("\0"))).size > 1,
        true
      );
      for (const recipe of recipes) {
        assert.equal(allSeeds.has(recipe.seed), false);
        allSeeds.add(recipe.seed);
        assert.deepEqual(extensionRecipeFromPublicInput({ recipe }), recipe);
      }
    }
    assert.equal(allSeeds.size, 300);
  });

  it("pins A variation and terminal-row fault coverage", () => {
    const recipes = extensionRecipes("a");
    assert.deepEqual(
      [...new Set(recipes.map(({ rootCount }) => rootCount))].sort(),
      [1, 2, 3, 4]
    );
    assert.deepEqual(
      [...new Set(recipes.map(({ keyShape }) => keyShape))].sort(),
      ["compound-kept", "compound-omitted", "single-kept", "single-omitted"]
    );
    assert.deepEqual(
      [...new Set(recipes.map(({ nestedShape }) => nestedShape))].sort(),
      ["create", "deleteMany", "updateMany", "upsert-found", "upsert-missing"]
    );
    assert.equal(
      recipes.filter(({ missingTerminalRow }) => missingTerminalRow).length,
      10
    );
    for (const recipe of recipes) {
      assert.equal(
        recipe.outcome,
        recipe.missingTerminalRow ? "missing-terminal-row" : "success"
      );
      const lastAdmission = `admit:root-member/${recipe.rootCount - 1}`;
      assert.equal(
        recipe.schedule.includes(
          scheduleEdge(`capture:roots/${recipe.rootCount}`, lastAdmission)
        ),
        true
      );
      assert.equal(
        recipe.schedule.includes(scheduleEdge(lastAdmission, "effect:root/0")),
        true
      );
      assert.equal(
        recipe.schedule.includes(
          scheduleEdge(
            `effect:${recipe.nestedShape}/root-member/${recipe.rootCount - 1}`,
            "result:terminal-roots"
          )
        ),
        true
      );
      if (recipe.missingTerminalRow)
        assert.equal(recipe.nestedShape, "deleteMany");
    }
  });

  it("pins B admission, zero, positive, and all mutation families", () => {
    const recipes = extensionRecipes("b");
    assert.deepEqual(
      [...new Set(recipes.map(({ mutation }) => mutation))].sort(),
      ["relation-updateMany", "scalar-deleteMany", "scalar-updateMany"]
    );
    assert.equal(recipes.filter(({ limit }) => limit === -1).length, 10);
    assert.equal(recipes.filter(({ limit }) => limit === 1.5).length, 10);
    assert.equal(recipes.filter(({ limit }) => limit === 0).length, 10);
    assert.equal(
      recipes.filter(({ limit }) => Number.isInteger(limit) && limit > 0)
        .length,
      70
    );
    for (const recipe of recipes) {
      const invalid = !Number.isInteger(recipe.limit) || recipe.limit < 0;
      assert.equal(recipe.outcome, invalid ? "invalid-limit" : "success");
      if (invalid) {
        assert.deepEqual(recipe.schedule, [
          scheduleEdge("admit:operation-template", "refuse:limit"),
        ]);
        continue;
      }
      if (recipe.limit === 0) {
        assert.deepEqual(recipe.schedule, [
          scheduleEdge("admit:operation-template", "stop:limit-zero"),
        ]);
        continue;
      }
      if (recipe.mutation === "relation-updateMany") {
        const selected = Math.min(recipe.limit, recipe.rowCount);
        const lastAdmission = `admit:root-member/${selected - 1}`;
        assert.equal(
          recipe.schedule.includes(
            scheduleEdge(`capture:roots/${selected}`, lastAdmission)
          ),
          true
        );
        assert.equal(
          recipe.schedule.includes(
            scheduleEdge(
              lastAdmission,
              "effect:relation-updateMany/root-member/0"
            )
          ),
          true
        );
      }
    }
  });

  it("pins successful composition controls, zero, both choices, and prepare-all order", () => {
    const recipes = extensionRecipes("composition");
    assert.equal(recipes.filter(({ limit }) => limit === 0).length, 10);
    assert.equal(
      recipes.some(({ rootCount, limit }) => rootCount > 1 && limit === 1),
      true
    );
    assert.equal(
      recipes.every(({ outcome }) => outcome === "success"),
      true
    );
    assert.equal(
      recipes.every(({ schedule }) =>
        schedule.every((edge) => !edge.includes("<refuse:"))
      ),
      true
    );
    assert.deepEqual([...new Set(recipes.map(({ choice }) => choice))].sort(), [
      "found",
      "missing",
    ]);
    assert.deepEqual(
      [...new Set(recipes.map(({ keyShape }) => keyShape))].sort(),
      ["compound-omitted", "single-omitted"]
    );
    for (const recipe of recipes) {
      if (recipe.limit === 0) {
        assert.deepEqual(
          recipe.schedule,
          [
            "admit:bin-template/operation",
            "admit:holder-template/operation",
            "admit:choice-template/operation/0",
            "admit:choice-template/operation/1",
          ].map((admission) =>
            scheduleEdge(admission, "stop:limit-zero")
          )
        );
        continue;
      }
      const selected = Math.min(recipe.limit, recipe.rootCount);
      for (let root = 0; root < selected; root += 1) {
        for (const admission of [
          `admit:bin-template/root-member/${root}`,
          `admit:holder-template/root-member/${root}`,
          `admit:choice-template/root-member/${root}/0`,
          `admit:choice-template/root-member/${root}/1`,
        ]) {
          assert.equal(
            recipe.schedule.includes(
              scheduleEdge(`capture:roots/${selected}`, admission)
            ),
            true
          );
          assert.equal(
            recipe.schedule.includes(
              scheduleEdge(admission, "effect:bin-member/0/0")
            ),
            true
          );
        }
        const lastBinAdmission = `admit:bin-member/${root}/${recipe.seriesWidth - 1}`;
        assert.equal(
          recipe.schedule.includes(
            scheduleEdge(
              `capture:bins/root-member/${root}/${recipe.seriesWidth}`,
              lastBinAdmission
            )
          ),
          true
        );
        assert.equal(
          recipe.schedule.includes(
            scheduleEdge(lastBinAdmission, `effect:bin-member/${root}/0`)
          ),
          true
        );
      }
      assert.equal(
        recipe.schedule.includes(
          scheduleEdge(
            `effect:choice-${recipe.choice}/root-member/${selected - 1}`,
            "result:terminal-roots"
          )
        ),
        true
      );
    }
  });

  it("refuses seeds and public inputs outside the frozen contract", () => {
    assert.throws(() => generateExtensionRecipe("a", 7099));
    assert.throws(() => generateExtensionRecipe("b", 7300));
    assert.throws(() =>
      extensionRecipeFromPublicInput({
        recipe: {
          ...generateExtensionRecipe("composition", 7300),
          extra: true,
        },
      })
    );
  });
});
