/**
 * Self-tests for the G4 generated read campaign.
 *
 * A campaign is only evidence if its generator is deterministic and covering,
 * its oracle can actually fail, its cells replay exactly, and its receipt
 * refuses anything short of a complete child at the frozen identity.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  assertG4GeneratedBatchReceipt,
  assertG4OracleValidationReceipt,
  captureRaptor3Identity,
  G4_GENERATED_CAMPAIGN,
  G4_GENERATED_TRANSPORT_CAMPAIGN,
  G4_TRANSPORT_MODELS,
} from "../../../../scripts/raptor3-manifest.mjs";
import { verifyG4Cell } from "./campaign";
import { cursorKeyFor, evaluateRecipe } from "./oracle";
import {
  CODEC_PREDICATES,
  COMPOUND_PREDICATES,
  G4_READ_CONTRACTS,
  RELATION_PREDICATES,
  buildRequest,
  g4RecipeFromPublicInput,
  generateG4Recipe,
} from "./recipe";
import {
  createGeneratedWorld,
  G4_FAMILIES,
  G4_GENERATION_PROFILES,
  G4_GENERATION_TRANSPORT_PROFILES,
  generateRows,
  type G4GenerationProfile,
} from "./world";

const FIRST = G4_GENERATED_CAMPAIGN.firstSeed;

function sampleSeeds(count: number): number[] {
  return Array.from({ length: count }, (_, offset) => FIRST + offset);
}

function unitReceipt(
  firstSeed: number,
  seedCount: number,
  campaign: typeof G4_GENERATED_CAMPAIGN,
  subject: "candidate" | "shipped",
  identity: unknown
) {
  const completed = campaign.profiles.flatMap((profile) =>
    Array.from({ length: seedCount }, (_, offset) => {
      const seed = firstSeed + offset;
      const recipe = generateG4Recipe(seed, campaign.firstSeed);
      const transport = G4_TRANSPORT_MODELS[profile] as string;
      return {
        seed,
        profile,
        family: recipe.family,
        contract: recipe.contract,
        actors: 1 as const,
        faults: 0 as const,
        rows: 1,
        statements: transport === "atomic-submission" ? 3 : 1,
        transport,
      };
    })
  );
  return {
    formatVersion: 1,
    qualifying: subject === "candidate",
    status: subject === "shipped" ? "oracle-validation" : "complete",
    subject,
    identity,
    firstSeed,
    seedCount,
    profiles: [...campaign.profiles],
    completed,
    replays: completed.length * campaign.replayCount,
    skipped: 0,
  };
}

describe("G4 generated read campaign harness", () => {
  it("generates deterministic, in-range recipes with a fixed contract rotation", () => {
    for (const seed of sampleSeeds(60)) {
      const recipe = generateG4Recipe(seed, FIRST);
      const again = generateG4Recipe(seed, FIRST);
      assert.deepEqual(recipe, again, "recipe generation is not deterministic");
      assert.deepEqual(
        g4RecipeFromPublicInput({ recipe }),
        recipe,
        "a recipe does not survive its own public schema"
      );
      assert.equal(
        recipe.contract,
        G4_READ_CONTRACTS[(seed - FIRST) % G4_READ_CONTRACTS.length]
      );
      assert.ok(G4_FAMILIES.includes(recipe.family));
      assert.ok(recipe.rowCount >= 3 && recipe.rowCount <= 8);
      if (recipe.contract === "Q-S") assert.equal(recipe.family, "relation");
      if (recipe.contract === "Q-A") assert.equal(recipe.family, "codec");
      if (recipe.contract !== "Q-P") assert.equal(recipe.page.kind, "none");
    }
  });

  it("covers every contract, family, predicate and page shape across the range", () => {
    const contracts = new Set<string>();
    const families = new Set<string>();
    const predicates = new Set<string>();
    const pages = new Set<string>();
    for (const seed of sampleSeeds(1500)) {
      const recipe = generateG4Recipe(seed, FIRST);
      contracts.add(recipe.contract);
      families.add(recipe.family);
      if (recipe.predicate) predicates.add(recipe.predicate);
      pages.add(recipe.page.kind);
    }
    assert.deepEqual([...contracts].sort(), [...G4_READ_CONTRACTS].sort());
    assert.deepEqual([...families].sort(), [...G4_FAMILIES].sort());
    assert.deepEqual([...pages].sort(), ["cursor", "distinct", "none", "window"]);
    const everyPredicate = [
      ...CODEC_PREDICATES,
      ...RELATION_PREDICATES,
      ...COMPOUND_PREDICATES,
    ];
    const missing = everyPredicate.filter((name) => !predicates.has(name));
    assert.deepEqual(missing, [], "uncovered predicate kinds");
  });

  it("replays one cell exactly and the oracle is falsifiable", async () => {
    const recipe = generateG4Recipe(FIRST, FIRST);
    const outcome = await verifyG4Cell(
      recipe,
      "sqlite-interactive",
      G4_GENERATED_CAMPAIGN,
      "shipped"
    );
    assert.equal(outcome.cell.seed, recipe.seed);
    assert.equal(outcome.cell.profile, "sqlite-interactive");
    assert.ok(outcome.cell.statements >= 1);
    assert.deepEqual(outcome.record.recipe, recipe);

    // The oracle must notice a changed world. A recipe whose answer is empty
    // cannot show that, so the falsifier picks the first seed in the range
    // whose answer is non-empty and then changes every projected value.
    let falsified = false;
    for (const seed of sampleSeeds(40)) {
      const candidateRecipe = generateG4Recipe(seed, FIRST);
      const rows = generateRows(candidateRecipe.seed, candidateRecipe.rowCount);
      const before = evaluateRecipe(candidateRecipe, rows);
      if (!Array.isArray(before) || before.length === 0) continue;
      const mutated = {
        specimens: rows.specimens.map((row) => ({
          ...row,
          label: `mutated-${row.label}`,
          count: row.count + 1000,
          status: row.status === "DONE" ? ("ACTIVE" as const) : ("DONE" as const),
          note: row.note === null ? "mutated" : null,
        })),
        owners: rows.owners.map((row) => ({
          ...row,
          name: `mutated-${row.name}`,
          weight: row.weight + 1000,
        })),
        items: rows.items.map((row) => ({ ...row, size: row.size + 1000 })),
        entries: rows.entries.map((row) => ({
          ...row,
          label: `mutated-${row.label}`,
          score: row.score + 1000,
        })),
      };
      assert.notDeepEqual(
        JSON.parse(JSON.stringify(evaluateRecipe(candidateRecipe, mutated), replacer)),
        JSON.parse(JSON.stringify(before, replacer)),
        `the oracle did not notice a changed world at seed ${seed}`
      );
      falsified = true;
      break;
    }
    assert.ok(falsified, "no seed in the sample produced a non-empty answer");
    assert.ok(buildRequest(recipe).model.length > 0);
  });

  it(
    "runs four distinguishable transport models that publish one answer",
    async () => {
      // A profile axis is only evidence if the profiles differ. This cell runs
      // one recipe through all four and requires: one published value, four
      // pairwise-distinct physical observations (SQL stream + returned
      // envelope), and a driver-reported model equal to the manifest's frozen
      // expectation for that profile.
      const recipe = generateG4Recipe(FIRST + 3, FIRST);
      const profiles: G4GenerationProfile[] = [
        ...G4_GENERATION_PROFILES,
        ...G4_GENERATION_TRANSPORT_PROFILES,
      ];
      const values = new Set<string>();
      const observations = new Map<string, string>();
      for (const profile of profiles) {
        const world = await createGeneratedWorld(
          recipe.seed,
          recipe.rowCount,
          profile
        );
        try {
          const request = buildRequest(recipe, cursorKeyFor(recipe, world.rows));
          world.driver.statements.length = 0;
          world.driver.envelopes.length = 0;
          const model = world.client[request.model];
          assert.ok(model);
          const operation = model[request.operation];
          assert.ok(operation);
          const value = await operation(request.args);
          values.add(JSON.stringify(value, replacer));
          assert.equal(
            world.driver.observedTransport(),
            G4_TRANSPORT_MODELS[profile],
            `${profile} did not exhibit its registered transport model`
          );
          assert.ok(
            world.driver.envelopes.length >= 1,
            `${profile} returned no envelope`
          );
          observations.set(
            profile,
            JSON.stringify({
              statements: world.driver.statements,
              envelopes: world.driver.envelopes,
            })
          );
        } finally {
          await world.close();
        }
      }
      assert.equal(
        values.size,
        1,
        "the transport profiles published different public values"
      );
      assert.equal(
        new Set(observations.values()).size,
        profiles.length,
        `two transport profiles are observationally identical: ${JSON.stringify([
          ...observations,
        ])}`
      );
    },
    60_000
  );

  it("refuses a receipt with a stale identity, a shifted seed or a missing cell", () => {
    const identity = captureRaptor3Identity();
    const valid = unitReceipt(FIRST, 4, G4_GENERATED_CAMPAIGN, "candidate", identity);
    assert.doesNotThrow(() =>
      assertG4GeneratedBatchReceipt(valid, FIRST, G4_GENERATED_CAMPAIGN, identity)
    );
    assert.throws(
      () =>
        assertG4GeneratedBatchReceipt(
          { ...valid, identity: { ...identity, production: "stale" } },
          FIRST,
          G4_GENERATED_CAMPAIGN,
          identity
        ),
      /Stale Raptor 3 evidence/
    );
    assert.throws(
      () =>
        assertG4GeneratedBatchReceipt(
          valid,
          FIRST + 1,
          G4_GENERATED_CAMPAIGN,
          identity
        )
    );
    assert.throws(() =>
      assertG4GeneratedBatchReceipt(
        { ...valid, completed: valid.completed.slice(1) },
        FIRST,
        G4_GENERATED_CAMPAIGN,
        identity
      )
    );
    assert.throws(() =>
      assertG4GeneratedBatchReceipt(
        { ...valid, skipped: 1 },
        FIRST,
        G4_GENERATED_CAMPAIGN,
        identity
      )
    );
    // A profile that collapsed into another profile's transport model is a
    // receipt failure, not a silently doubled child.
    assert.throws(
      () =>
        assertG4GeneratedBatchReceipt(
          {
            ...valid,
            completed: valid.completed.map((cell) =>
              cell.profile === "sqlite-atomic-batch"
                ? { ...cell, transport: "interactive-session", statements: 1 }
                : cell
            ),
          },
          FIRST,
          G4_GENERATED_CAMPAIGN,
          identity
        ),
      /did not exhibit its transport model/
    );
    // An atomic submission that skipped its BEGIN/COMMIT wrapper is likewise
    // refused, even when it still reports the right model name.
    assert.throws(
      () =>
        assertG4GeneratedBatchReceipt(
          {
            ...valid,
            completed: valid.completed.map((cell) =>
              cell.profile === "sqlite-atomic-batch"
                ? { ...cell, statements: 1 }
                : cell
            ),
          },
          FIRST,
          G4_GENERATED_CAMPAIGN,
          identity
        ),
      /did not wrap every statement/
    );
    assert.throws(
      () =>
        assertG4GeneratedBatchReceipt(
          unitReceipt(FIRST, 4, G4_GENERATED_CAMPAIGN, "shipped", identity),
          FIRST,
          G4_GENERATED_CAMPAIGN,
          identity
        ),
      /candidate/
    );
    const outside = {
      ...valid,
      firstSeed: G4_GENERATED_CAMPAIGN.firstSeed +
        G4_GENERATED_CAMPAIGN.seedCount,
    };
    assert.throws(() =>
      assertG4GeneratedBatchReceipt(
        outside,
        outside.firstSeed,
        G4_GENERATED_CAMPAIGN,
        identity
      )
    );
  });

  it("keeps the two campaign lanes disjoint and their receipts distinct", () => {
    const identity = captureRaptor3Identity();
    const sqliteEnd =
      G4_GENERATED_CAMPAIGN.firstSeed + G4_GENERATED_CAMPAIGN.seedCount;
    assert.ok(
      sqliteEnd <= G4_GENERATED_TRANSPORT_CAMPAIGN.firstSeed,
      "the SQLite and transport seed ranges overlap"
    );
    assert.equal(G4_GENERATED_CAMPAIGN.seedCount, 25_000);
    assert.equal(G4_GENERATED_TRANSPORT_CAMPAIGN.seedCount, 25_000);
    assert.equal(G4_GENERATED_CAMPAIGN.batchSize, 100);
    assert.equal(G4_GENERATED_TRANSPORT_CAMPAIGN.batchSize, 100);
    const validation = unitReceipt(
      G4_GENERATED_TRANSPORT_CAMPAIGN.firstSeed,
      3,
      G4_GENERATED_TRANSPORT_CAMPAIGN,
      "shipped",
      identity
    );
    assert.doesNotThrow(() =>
      assertG4OracleValidationReceipt(
        validation,
        G4_GENERATED_TRANSPORT_CAMPAIGN.firstSeed,
        G4_GENERATED_TRANSPORT_CAMPAIGN,
        identity
      )
    );
    assert.throws(
      () =>
        assertG4OracleValidationReceipt(
          unitReceipt(
            G4_GENERATED_TRANSPORT_CAMPAIGN.firstSeed,
            3,
            G4_GENERATED_TRANSPORT_CAMPAIGN,
            "candidate",
            identity
          ),
          G4_GENERATED_TRANSPORT_CAMPAIGN.firstSeed,
          G4_GENERATED_TRANSPORT_CAMPAIGN,
          identity
        ),
      /shipped/
    );
  });
});

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}
