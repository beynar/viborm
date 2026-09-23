/**
 * The G4 generated read recipe: the only source of variation in the campaign.
 *
 * A recipe holds primitive CHOICES. `buildRequest` turns those choices into a
 * public request; `tests/raptor3/g4/generation/oracle.ts` turns the same
 * choices into an expected value by evaluating the seeded rows in JavaScript.
 * Two independent implementations of one meaning, from one authority.
 */
import assert from "node:assert/strict";
import { z } from "zod";
import { G4_FAMILIES, type G4Family, picker } from "./world";

export const G4_READ_CONTRACTS = ["Q-W", "Q-O", "Q-P", "Q-S", "Q-A"] as const;
export type G4ReadContract = (typeof G4_READ_CONTRACTS)[number];

export const CODEC_PREDICATES = [
  "count-gte",
  "count-in",
  "count-notIn",
  "label-contains",
  "label-startsWith",
  "label-insensitive",
  "status-in",
  "labels-has",
  "counts-isEmpty",
  "note-null",
  "big-gt",
  "moment-lt",
  "and-count-status",
  "or-label-count",
  "not-status",
] as const;

export const RELATION_PREDICATES = [
  "weight-gte",
  "name-startsWith",
  "items-some",
  "items-none",
  "items-every",
  "parent-null",
] as const;

export const COMPOUND_PREDICATES = [
  "region-equals",
  "code-startsWith",
  "score-gte",
  "and-region-score",
  "or-region-code",
] as const;

const pageRecipe = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("window"),
    skip: z.number().int().min(0).max(3),
    take: z.number().int().min(-4).max(4),
  }),
  z.strictObject({ kind: z.literal("distinct") }),
  z.strictObject({
    kind: z.literal("cursor"),
    index: z.number().int().min(0).max(7),
    take: z.number().int().min(1).max(4),
  }),
  z.strictObject({ kind: z.literal("none") }),
]);

const recipeSchema = z.strictObject({
  seed: z.number().int().min(0),
  family: z.enum(G4_FAMILIES),
  contract: z.enum(G4_READ_CONTRACTS),
  rowCount: z.number().int().min(3).max(8),
  predicate: z
    .enum([...CODEC_PREDICATES, ...RELATION_PREDICATES, ...COMPOUND_PREDICATES])
    .optional(),
  operand: z.number().int().min(-20).max(40),
  word: z.string().min(1).max(10),
  direction: z.enum(["asc", "desc"]),
  nulls: z.enum(["first", "last"]),
  orderField: z.string().min(1).max(12),
  page: pageRecipe,
  nestedTake: z.number().int().min(0).max(3),
  nestedSize: z.number().int().min(0).max(30),
  withCount: z.boolean(),
  having: z.boolean(),
});

export type G4ReadRecipe = z.infer<typeof recipeSchema>;

const WORDS = ["alpha", "beta", "gamma", "delta", "omega"] as const;

function familyFor(contract: G4ReadContract, pick: (n: number) => number): G4Family {
  if (contract === "Q-S") return "relation";
  if (contract === "Q-A") return "codec";
  return G4_FAMILIES[pick(G4_FAMILIES.length)] ?? "codec";
}

function predicateFor(
  family: G4Family,
  pick: (n: number) => number
): G4ReadRecipe["predicate"] {
  if (family === "codec")
    return CODEC_PREDICATES[pick(CODEC_PREDICATES.length)];
  if (family === "relation")
    return RELATION_PREDICATES[pick(RELATION_PREDICATES.length)];
  return COMPOUND_PREDICATES[pick(COMPOUND_PREDICATES.length)];
}

function orderFieldFor(family: G4Family, pick: (n: number) => number): string {
  if (family === "codec") return ["count", "label", "note"][pick(3)] ?? "count";
  if (family === "relation") return ["weight", "name"][pick(2)] ?? "weight";
  return ["score", "label"][pick(2)] ?? "score";
}

function pageFor(
  contract: G4ReadContract,
  pick: (n: number) => number
): G4ReadRecipe["page"] {
  if (contract !== "Q-P") return { kind: "none" };
  const choice = pick(3);
  if (choice === 0)
    return { kind: "window", skip: pick(4), take: pick(9) - 4 };
  if (choice === 1) return { kind: "distinct" };
  return { kind: "cursor", index: pick(8), take: 1 + pick(4) };
}

/** Public-input choices only; nothing here knows the candidate exists. */
export function generateG4Recipe(seed: number, firstSeed: number): G4ReadRecipe {
  assert(Number.isInteger(seed) && seed >= firstSeed, "seed below the campaign");
  const pick = picker(seed);
  const contract =
    G4_READ_CONTRACTS[(seed - firstSeed) % G4_READ_CONTRACTS.length] ?? "Q-W";
  const family = familyFor(contract, pick);
  return recipeSchema.parse({
    seed,
    family,
    contract,
    rowCount: 3 + pick(6),
    predicate: contract === "Q-W" ? predicateFor(family, pick) : undefined,
    operand: pick(40) - 10,
    word: WORDS[pick(WORDS.length)] ?? "alpha",
    direction: pick(2) === 0 ? "asc" : "desc",
    nulls: pick(2) === 0 ? "first" : "last",
    orderField: orderFieldFor(family, pick),
    page: pageFor(contract, pick),
    nestedTake: pick(4),
    nestedSize: pick(31),
    withCount: pick(2) === 0,
    having: pick(2) === 0,
  });
}

export function g4RecipeFromPublicInput(input: unknown): G4ReadRecipe {
  return z.strictObject({ recipe: recipeSchema }).parse(input).recipe;
}

export const FAMILY_MODEL: Record<G4Family, string> = {
  codec: "specimen",
  relation: "owner",
  compound: "entry",
};

export function codecPredicate(recipe: G4ReadRecipe): Record<string, unknown> {
  const { operand, word } = recipe;
  switch (recipe.predicate) {
    case "count-gte":
      return { count: { gte: operand } };
    case "count-in":
      return { count: { in: [operand, operand + 1, operand + 2] } };
    case "count-notIn":
      return { count: { notIn: [operand, operand + 1] } };
    case "label-contains":
      return { label: { contains: word } };
    case "label-startsWith":
      return { label: { startsWith: word } };
    case "label-insensitive":
      return { label: { contains: word.toUpperCase(), mode: "insensitive" } };
    case "status-in":
      return { status: { in: ["ACTIVE", "DONE"] } };
    case "labels-has":
      return { labels: { has: word } };
    case "counts-isEmpty":
      return { counts: { isEmpty: true } };
    case "note-null":
      return { note: null };
    case "big-gt":
      return { big: { gt: 9_007_199_254_740_992n } };
    case "moment-lt":
      return { moment: { lt: new Date(Date.UTC(2024, 6, 1)) } };
    case "and-count-status":
      return {
        AND: [{ count: { gte: operand } }, { status: { not: "DONE" } }],
      };
    case "or-label-count":
      return {
        OR: [{ label: { startsWith: word } }, { count: { lt: operand } }],
      };
    default:
      return { NOT: { status: "PAUSED" } };
  }
}

export function relationPredicate(recipe: G4ReadRecipe): Record<string, unknown> {
  const { operand, word, nestedSize } = recipe;
  switch (recipe.predicate) {
    case "weight-gte":
      return { weight: { gte: Math.max(0, operand) } };
    case "name-startsWith":
      return { name: { startsWith: word } };
    case "items-some":
      return { items: { some: { size: { gt: nestedSize } } } };
    case "items-none":
      return { items: { none: { size: { gt: nestedSize } } } };
    case "items-every":
      return { items: { every: { size: { lte: nestedSize } } } };
    default:
      return { parent: { is: null } };
  }
}

export function compoundPredicate(recipe: G4ReadRecipe): Record<string, unknown> {
  const { operand, word } = recipe;
  switch (recipe.predicate) {
    case "region-equals":
      return { region: "eu" };
    case "code-startsWith":
      return { code: { startsWith: "c" } };
    case "score-gte":
      return { score: { gte: Math.max(0, operand) } };
    case "and-region-score":
      return {
        AND: [{ region: { in: ["eu", "us"] } }, { score: { lt: 25 } }],
      };
    default:
      return { OR: [{ region: "ap" }, { label: { contains: word } }] };
  }
}

export function predicateFor_(recipe: G4ReadRecipe): Record<string, unknown> {
  if (recipe.family === "codec") return codecPredicate(recipe);
  if (recipe.family === "relation") return relationPredicate(recipe);
  return compoundPredicate(recipe);
}

export function orderTerms(recipe: G4ReadRecipe): Record<string, unknown>[] {
  const { direction, nulls, orderField, family } = recipe;
  const term =
    orderField === "note"
      ? { note: { sort: direction, nulls } }
      : { [orderField]: direction };
  return family === "compound"
    ? [term, { region: "asc" }, { code: "asc" }]
    : [term, { id: "asc" }];
}

export function totalOrder(recipe: G4ReadRecipe): Record<string, unknown>[] {
  return recipe.family === "compound"
    ? [{ region: "asc" }, { code: "asc" }]
    : [{ id: "asc" }];
}

export const SELECTED_FIELDS: Record<G4Family, Record<string, true>> = {
  codec: { id: true, label: true, count: true, status: true, note: true },
  relation: { id: true, name: true, weight: true },
  compound: { region: true, code: true, label: true, score: true },
};

export const DISTINCT_FIELDS: Record<G4Family, string[]> = {
  codec: ["status"],
  relation: ["weight"],
  compound: ["region"],
};

export interface GeneratedRequest {
  readonly model: string;
  readonly operation: string;
  readonly args: Record<string, unknown>;
}

/** The public request a recipe names. It never inspects an engine. */
export function buildRequest(
  recipe: G4ReadRecipe,
  cursorKey?: Record<string, unknown>
): GeneratedRequest {
  const model = FAMILY_MODEL[recipe.family];
  const select = SELECTED_FIELDS[recipe.family];
  if (recipe.contract === "Q-W") {
    return {
      model,
      operation: "findMany",
      args: {
        where: predicateFor_(recipe),
        orderBy: totalOrder(recipe),
        select,
      },
    };
  }
  if (recipe.contract === "Q-O") {
    return {
      model,
      operation: "findMany",
      args: { orderBy: orderTerms(recipe), select },
    };
  }
  if (recipe.contract === "Q-P") {
    const page = recipe.page;
    const base = { orderBy: totalOrder(recipe), select };
    if (page.kind === "window") {
      return {
        model,
        operation: "findMany",
        args: {
          ...base,
          ...(page.skip === 0 ? {} : { skip: page.skip }),
          ...(page.take === 0 ? {} : { take: page.take }),
        },
      };
    }
    if (page.kind === "distinct") {
      return {
        model,
        operation: "findMany",
        args: { ...base, distinct: DISTINCT_FIELDS[recipe.family] },
      };
    }
    if (page.kind === "cursor" && cursorKey) {
      return {
        model,
        operation: "findMany",
        args: { ...base, cursor: cursorKey, take: page.take },
      };
    }
    return { model, operation: "findMany", args: base };
  }
  if (recipe.contract === "Q-S") {
    return {
      model: "owner",
      operation: "findMany",
      args: {
        orderBy: [{ id: "asc" }],
        select: {
          id: true,
          name: true,
          items: {
            where: { size: { gt: recipe.nestedSize } },
            orderBy: [{ id: "asc" }],
            ...(recipe.nestedTake === 0 ? {} : { take: recipe.nestedTake }),
            select: { id: true, size: true },
          },
          ...(recipe.withCount
            ? { _count: { select: { items: true } } }
            : {}),
        },
      },
    };
  }
  return {
    model: "specimen",
    operation: "groupBy",
    args: {
      by: ["status"],
      _count: { _all: true },
      _sum: { count: true },
      _min: { count: true },
      _max: { count: true },
      ...(recipe.having
        ? { having: { count: { _sum: { gt: recipe.operand } } } }
        : {}),
      orderBy: { status: recipe.direction },
    },
  };
}
