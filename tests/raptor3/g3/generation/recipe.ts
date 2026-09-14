import assert from "node:assert/strict";
import { z } from "zod";

export const G3_GENERATED_CONTRACTS: readonly ["C08", "C09", "C10", "C11"] = [
  "C08",
  "C09",
  "C10",
  "C11",
];
const G3_BULK_VERBS: readonly ["createMany", "updateMany", "deleteMany"] = [
  "createMany",
  "updateMany",
  "deleteMany",
];
const G3_BULK_PRESENTATIONS: readonly ["count", "select", "omit"] = [
  "count",
  "select",
  "omit",
];

const commonRecipe = {
  seed: z.number().int().min(8000).max(17_999),
  actors: z.union([z.literal(1), z.literal(2)]),
  operations: z.number().int().min(1).max(32),
  fault: z.enum(["none", "legal-provider-failure"]),
};

const bulkRecipe = z.strictObject({
  ...commonRecipe,
  contract: z.literal("C08"),
  verb: z.enum(["createMany", "updateMany", "deleteMany"]),
  presentation: z.enum(["count", "select", "omit"]),
  rowCount: z.number().int().min(1).max(8),
  limit: z.number().int().min(0).max(8),
});

const suppressionRecipe = z.strictObject({
  ...commonRecipe,
  contract: z.literal("C09"),
  conflict: z.enum(["root", "descendant"]),
  healthySuffix: z.literal(true),
});

const transactionArrayRecipe = z.strictObject({
  ...commonRecipe,
  contract: z.literal("C10"),
  composition: z.enum(["borrowed", "atomic-array"]),
});

const depthRecipe = z.strictObject({
  ...commonRecipe,
  contract: z.literal("C11"),
  depth: z.number().int().min(0).max(4),
  fanout: z.number().int().min(0).max(3),
  shape: z.enum(["ordinary", "compound", "variant", "repeated"]),
});

function minimumOperations(recipe: {
  contract: string;
  actors: 1 | 2;
  fault: string;
}) {
  const actorPeer = recipe.actors === 2 ? 1 : 0;
  const faultRecovery = recipe.fault === "none" ? 0 : 1;
  return recipe.contract === "C09"
    ? 1 + Math.max(actorPeer, 1) + faultRecovery
    : 1 + actorPeer + faultRecovery;
}

const recipeSchema = z
  .discriminatedUnion("contract", [
    bulkRecipe,
    suppressionRecipe,
    transactionArrayRecipe,
    depthRecipe,
  ])
  .superRefine((recipe, context) => {
    const minimum = minimumOperations(recipe);
    if (recipe.operations < minimum)
      context.addIssue({
        code: "custom",
        message:
          "Actor overlap and fault recovery require distinct public operations",
      });
    if (
      recipe.contract === "C08" &&
      recipe.verb !== "createMany" &&
      recipe.limit === 0 &&
      (recipe.actors === 2 || recipe.fault !== "none")
    )
      context.addIssue({
        code: "custom",
        message:
          "C08 actor overlap and provider faults require a positive physical window",
      });
  });

export type G3GeneratedRecipe = z.infer<typeof recipeSchema>;

function randomPicker(seed: number) {
  let state = (seed ^ 0xa409_3822) >>> 0;
  return (limit: number) => {
    assert(Number.isInteger(limit) && limit > 0);
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % limit;
  };
}

/** Public-input choices are independent of candidate commands and lowering. */
export function generateG3Recipe(seed: number): G3GeneratedRecipe {
  assert(Number.isInteger(seed) && seed >= 8000 && seed < 18_000);
  const pick = randomPicker(seed);
  const contract = G3_GENERATED_CONTRACTS[(seed - 8000) % 4]!;
  const actors: 1 | 2 = seed % 5 === 0 ? 2 : 1;
  const fault: "none" | "legal-provider-failure" =
    seed % 5 === 1 ? "legal-provider-failure" : "none";
  const minimum = minimumOperations({ contract, actors, fault });
  const common = {
    seed,
    actors,
    operations: minimum + pick(33 - minimum),
    fault,
  };
  if (contract === "C08") {
    const selectedVerb = G3_BULK_VERBS[pick(G3_BULK_VERBS.length)]!;
    const presentation =
      G3_BULK_PRESENTATIONS[pick(G3_BULK_PRESENTATIONS.length)]!;
    const rowCount = 1 + pick(8);
    const selectedLimit = pick(9);
    const limit =
      selectedVerb !== "createMany" &&
      (actors === 2 || fault !== "none") &&
      selectedLimit === 0
        ? 1
        : selectedLimit;
    return recipeSchema.parse({
      ...common,
      contract,
      verb: selectedVerb,
      presentation,
      rowCount,
      limit,
    });
  }
  if (contract === "C09")
    return suppressionRecipe.parse({
      ...common,
      contract,
      conflict: pick(2) === 0 ? "root" : "descendant",
      healthySuffix: true,
    });
  if (contract === "C10")
    return transactionArrayRecipe.parse({
      ...common,
      contract,
      composition: pick(2) === 0 ? "borrowed" : "atomic-array",
    });
  return depthRecipe.parse({
    ...common,
    contract,
    depth: pick(5),
    fanout: pick(4),
    shape: ["ordinary", "compound", "variant", "repeated"][pick(4)],
  });
}

export function g3RecipeFromPublicInput(input: unknown): G3GeneratedRecipe {
  return z.strictObject({ recipe: recipeSchema }).parse(input).recipe;
}

function reductions(recipe: G3GeneratedRecipe): G3GeneratedRecipe[] {
  const common: G3GeneratedRecipe[] = [];
  const minimum = minimumOperations(recipe);
  if (recipe.operations > minimum)
    common.push(recipeSchema.parse({ ...recipe, operations: minimum }));
  if (recipe.actors === 2)
    common.push(recipeSchema.parse({ ...recipe, actors: 1 }));
  if (recipe.fault !== "none")
    common.push(recipeSchema.parse({ ...recipe, fault: "none" }));
  if (recipe.contract === "C08")
    return [
      ...common,
      ...(recipe.rowCount > 1
        ? [recipeSchema.parse({ ...recipe, rowCount: 1 })]
        : []),
      ...(recipe.limit > 0 && recipe.actors === 1 && recipe.fault === "none"
        ? [recipeSchema.parse({ ...recipe, limit: 0 })]
        : []),
    ];
  if (recipe.contract === "C11")
    return [
      ...common,
      ...(recipe.depth > 0 ? [depthRecipe.parse({ ...recipe, depth: 0 })] : []),
      ...(recipe.fanout > 0
        ? [depthRecipe.parse({ ...recipe, fanout: 0 })]
        : []),
      ...(recipe.shape !== "ordinary"
        ? [depthRecipe.parse({ ...recipe, shape: "ordinary" })]
        : []),
    ];
  return common;
}

/** Reductions change only admitted public recipes and retain the caller's property. */
export async function shrinkG3Recipe(
  original: G3GeneratedRecipe,
  reproduces: (recipe: G3GeneratedRecipe) => Promise<boolean>
) {
  let current = structuredClone(original);
  let attempts = 0;
  for (;;) {
    let reduced = false;
    for (const candidate of reductions(current)) {
      assert(++attempts <= 64, "G3 generated shrink budget exceeded");
      const admitted = recipeSchema.parse(candidate);
      if (await reproduces(admitted)) {
        current = admitted;
        reduced = true;
        break;
      }
    }
    if (!reduced) return { original, reduced: current, attempts };
  }
}
