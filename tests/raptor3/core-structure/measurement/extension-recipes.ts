import assert from "node:assert/strict";
import { z } from "zod";

export const extensionSlices = ["a", "b", "composition"] as const;
export type ExtensionSlice = (typeof extensionSlices)[number];

const schedule = z.array(z.string().min(1)).nonempty();

const extensionARecipeSchema = z.strictObject({
  formatVersion: z.literal(1),
  slice: z.literal("a"),
  seed: z.number().int().min(7100).max(7199),
  rootCount: z.number().int().min(1).max(4),
  keyShape: z.enum([
    "single-kept",
    "single-omitted",
    "compound-kept",
    "compound-omitted",
  ]),
  nestedShape: z.enum([
    "create",
    "updateMany",
    "deleteMany",
    "upsert-found",
    "upsert-missing",
  ]),
  missingTerminalRow: z.boolean(),
  outcome: z.enum(["success", "missing-terminal-row"]),
  schedule,
});

const extensionBRecipeSchema = z.strictObject({
  formatVersion: z.literal(1),
  slice: z.literal("b"),
  seed: z.number().int().min(7200).max(7299),
  mutation: z.enum([
    "scalar-updateMany",
    "scalar-deleteMany",
    "relation-updateMany",
  ]),
  rowCount: z.number().int().min(1).max(4),
  limit: z.number(),
  outcome: z.enum(["success", "invalid-limit"]),
  schedule,
});

const extensionCompositionRecipeSchema = z.strictObject({
  formatVersion: z.literal(1),
  slice: z.literal("composition"),
  seed: z.number().int().min(7300).max(7399),
  rootCount: z.number().int().min(1).max(4),
  limit: z.number().int().min(0).max(4),
  choice: z.enum(["found", "missing"]),
  seriesWidth: z.number().int().min(1).max(4),
  keyShape: z.enum(["single-omitted", "compound-omitted"]),
  outcome: z.literal("success"),
  schedule,
});

export const extensionRecipeSchema = z.discriminatedUnion("slice", [
  extensionARecipeSchema,
  extensionBRecipeSchema,
  extensionCompositionRecipeSchema,
]);
export type ExtensionRecipe = z.infer<typeof extensionRecipeSchema>;
export type ExtensionARecipe = Extract<ExtensionRecipe, { slice: "a" }>;
export type ExtensionBRecipe = Extract<ExtensionRecipe, { slice: "b" }>;
export type ExtensionCompositionRecipe = Extract<
  ExtensionRecipe,
  { slice: "composition" }
>;

export const extensionCampaigns = Object.freeze({
  a: Object.freeze({ firstSeed: 7100, seedCount: 100 }),
  b: Object.freeze({ firstSeed: 7200, seedCount: 100 }),
  composition: Object.freeze({ firstSeed: 7300, seedCount: 100 }),
});

function before(earlier: string, later: string): string {
  return `before:${earlier}<${later}`;
}

function extensionASchedule(input: {
  rootCount: number;
  nestedShape: ExtensionARecipe["nestedShape"];
  missingTerminalRow: boolean;
}): string[] {
  const capture = `capture:roots/${input.rootCount}`;
  const steps = [before("admit:root-template", capture)];
  const selectedNestedSeries =
    input.nestedShape === "updateMany" || input.nestedShape === "deleteMany";
  if (selectedNestedSeries)
    steps.push(
      before("admit:root-template", "admit:nested-template"),
      before("admit:nested-template", capture)
    );
  for (let member = 0; member < input.rootCount; member += 1) {
    const admission = `admit:root-member/${member}`;
    steps.push(before(capture, admission));
    steps.push(before(admission, "effect:root/0"));
    if (selectedNestedSeries) {
      const nestedTemplate = `admit:nested-template/root-member/${member}`;
      steps.push(
        before(admission, nestedTemplate),
        before(nestedTemplate, "effect:root/0")
      );
    }
  }
  for (let member = 0; member < input.rootCount; member += 1) {
    const rootEffect = `effect:root/${member}`;
    const nestedEffect = `effect:${input.nestedShape}/root-member/${member}`;
    let completed = nestedEffect;
    if (selectedNestedSeries) {
      const nestedCapture = `capture:nested/root-member/${member}`;
      if (input.nestedShape === "deleteMany" && member === 0)
        completed = nestedCapture;
      else if (input.nestedShape === "deleteMany")
        steps.push(
          before(nestedCapture, nestedEffect),
          before(rootEffect, nestedEffect)
        );
      else {
        const nestedAdmission = `admit:nested-member/${member}`;
        steps.push(
          before(nestedCapture, nestedAdmission),
          before(nestedAdmission, nestedEffect),
          before(rootEffect, nestedEffect)
        );
      }
    } else if (input.nestedShape.startsWith("upsert-"))
      steps.push(
        before(
          `choice:${input.nestedShape.slice("upsert-".length)}/root-member/${member}`,
          nestedEffect
        ),
        before(rootEffect, nestedEffect)
      );
    else steps.push(before(rootEffect, nestedEffect));
    if (member + 1 < input.rootCount)
      steps.push(before(completed, `effect:root/${member + 1}`));
  }
  const lastEffect = `effect:${input.nestedShape}/root-member/${input.rootCount - 1}`;
  steps.push(before(lastEffect, "result:terminal-roots"));
  return steps;
}

function extensionBSchedule(input: {
  mutation: ExtensionBRecipe["mutation"];
  rowCount: number;
  limit: number;
}): string[] {
  const template = "admit:operation-template";
  if (!Number.isInteger(input.limit) || input.limit < 0)
    return [before(template, "refuse:limit")];
  if (input.limit === 0) return [before(template, "stop:limit-zero")];
  const selected = Math.min(input.limit, input.rowCount);
  if (input.mutation !== "relation-updateMany")
    return [
      before(template, `effect:${input.mutation}/set-oriented/${selected}`),
    ];
  const capture = `capture:roots/${selected}`;
  const steps = [before(template, capture)];
  for (let member = 0; member < selected; member += 1) {
    const admission = `admit:root-member/${member}`;
    steps.push(before(capture, admission));
    steps.push(before(admission, "effect:relation-updateMany/root-member/0"));
  }
  for (let member = 0; member + 1 < selected; member += 1)
    steps.push(
      before(
        `effect:relation-updateMany/root-member/${member}`,
        `effect:relation-updateMany/root-member/${member + 1}`
      )
    );
  return steps;
}

function extensionCompositionSchedule(input: {
  rootCount: number;
  limit: number;
  choice: ExtensionCompositionRecipe["choice"];
  seriesWidth: number;
}): string[] {
  const operationPreparation = [
    "admit:bin-template/operation",
    "admit:holder-template/operation",
    "admit:choice-template/operation/0",
    "admit:choice-template/operation/1",
  ];
  if (input.limit === 0)
    return operationPreparation.map((admission) =>
      before(admission, "stop:limit-zero")
    );
  const selected = Math.min(input.limit, input.rootCount);
  const rootCapture = `capture:roots/${selected}`;
  const steps = operationPreparation.map((admission) =>
    before(admission, rootCapture)
  );
  for (let root = 0; root < selected; root += 1) {
    const rootPreparation = [
      `admit:bin-template/root-member/${root}`,
      `admit:holder-template/root-member/${root}`,
      `admit:choice-template/root-member/${root}/0`,
      `admit:choice-template/root-member/${root}/1`,
    ];
    for (const admission of rootPreparation)
      steps.push(
        before(rootCapture, admission),
        before(admission, "effect:bin-member/0/0")
      );
  }
  for (let root = 0; root < selected; root += 1) {
    const binCapture = `capture:bins/root-member/${root}/${input.seriesWidth}`;
    for (let bin = 0; bin < input.seriesWidth; bin += 1) {
      const binAdmission = `admit:bin-member/${root}/${bin}`;
      steps.push(before(binCapture, binAdmission));
      steps.push(before(binAdmission, `effect:bin-member/${root}/0`));
      if (bin + 1 < input.seriesWidth)
        steps.push(
          before(
            `effect:bin-member/${root}/${bin}`,
            `effect:bin-member/${root}/${bin + 1}`
          )
        );
    }
    const lastBinEffect = `effect:bin-member/${root}/${input.seriesWidth - 1}`;
    const choice = `choice:${input.choice}/root-member/${root}`;
    const choiceEffect = `effect:choice-${input.choice}/root-member/${root}`;
    steps.push(
      before(lastBinEffect, choiceEffect),
      before(choice, choiceEffect)
    );
    if (root + 1 < selected)
      steps.push(before(choiceEffect, `effect:bin-member/${root + 1}/0`));
    else steps.push(before(choiceEffect, "result:terminal-roots"));
  }
  return steps;
}

export function generateExtensionRecipe(
  slice: ExtensionSlice,
  seed: number
): ExtensionRecipe {
  const campaign = extensionCampaigns[slice];
  assert(
    Number.isSafeInteger(seed) &&
      seed >= campaign.firstSeed &&
      seed < campaign.firstSeed + campaign.seedCount,
    `Seed ${seed} is outside the frozen CS-03 ${slice} range`
  );
  const index = seed - campaign.firstSeed;
  if (slice === "a") {
    const rootCount = 1 + (index % 4);
    const generatedKeyShape = (
      [
        "single-kept",
        "single-omitted",
        "compound-kept",
        "compound-omitted",
      ] as const
    )[Math.floor(index / 4) % 4]!;
    const generatedNestedShape = (
      ["create", "updateMany", "upsert-found", "upsert-missing"] as const
    )[Math.floor(index / 16) % 4]!;
    const missingTerminalRow = index % 10 === 9;
    const keyShape = missingTerminalRow
      ? index % 20 === 9
        ? "single-kept"
        : "single-omitted"
      : generatedKeyShape;
    const nestedShape = missingTerminalRow
      ? "deleteMany"
      : generatedNestedShape;
    return extensionARecipeSchema.parse({
      formatVersion: 1,
      slice,
      seed,
      rootCount,
      keyShape,
      nestedShape,
      missingTerminalRow,
      outcome: missingTerminalRow ? "missing-terminal-row" : "success",
      schedule: extensionASchedule({
        rootCount,
        nestedShape,
        missingTerminalRow,
      }),
    });
  }
  if (slice === "b") {
    const mutation = (
      ["scalar-updateMany", "scalar-deleteMany", "relation-updateMany"] as const
    )[index % 3]!;
    const rowCount = 1 + (Math.floor(index / 3) % 4);
    const limit =
      index % 10 === 0
        ? -1
        : index % 10 === 1
          ? 1.5
          : index % 10 === 2
            ? 0
            : 1 + (Math.floor(index / 10) % (rowCount + 1));
    return extensionBRecipeSchema.parse({
      formatVersion: 1,
      slice,
      seed,
      mutation,
      rowCount,
      limit,
      outcome:
        !Number.isInteger(limit) || limit < 0 ? "invalid-limit" : "success",
      schedule: extensionBSchedule({ mutation, rowCount, limit }),
    });
  }
  const rootCount = 1 + (index % 4);
  const limit = index % 10 === 0 ? 0 : 1 + (Math.floor(index / 10) % rootCount);
  const choice = Math.floor(index / 4) % 2 === 0 ? "found" : "missing";
  const seriesWidth = 1 + (Math.floor(index / 8) % 4);
  const keyShape = index % 2 === 0 ? "single-omitted" : "compound-omitted";
  return extensionCompositionRecipeSchema.parse({
    formatVersion: 1,
    slice,
    seed,
    rootCount,
    limit,
    choice,
    seriesWidth,
    keyShape,
    outcome: "success",
    schedule: extensionCompositionSchedule({
      rootCount,
      limit,
      choice,
      seriesWidth,
    }),
  });
}

export function extensionRecipeFromPublicInput(
  input: unknown
): ExtensionRecipe {
  return z.strictObject({ recipe: extensionRecipeSchema }).parse(input).recipe;
}

export function extensionRecipes(
  slice: "a"
): readonly ExtensionARecipe[];
export function extensionRecipes(
  slice: "b"
): readonly ExtensionBRecipe[];
export function extensionRecipes(
  slice: "composition"
): readonly ExtensionCompositionRecipe[];
export function extensionRecipes(
  slice: ExtensionSlice
): readonly ExtensionRecipe[];
export function extensionRecipes(
  slice: ExtensionSlice
): readonly ExtensionRecipe[] {
  const campaign = extensionCampaigns[slice];
  return Array.from({ length: campaign.seedCount }, (_, offset) =>
    generateExtensionRecipe(slice, campaign.firstSeed + offset)
  );
}
