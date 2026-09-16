/**
 * Review probe (independent reviewer, unit "Independent witnesses C01/C12/C13").
 *
 * Claim under attack: the G4 generated read campaign runs "the same recipe on
 * four transport profiles and requires one answer" (witness note §1 question 3,
 * §4), and each child is reported as 200 cells over two profiles.
 *
 * This probe measures the DISTINGUISHING POWER of the profile axis: for a
 * sample of campaign seeds it runs one recipe through every profile and
 * compares both the published public value and the exact physical statement
 * stream. A profile that never produces a different observation adds no cell
 * of evidence, only cost.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { buildRequest, generateG4Recipe } from "../../generation/recipe";
import { cursorKeyFor } from "../../generation/oracle";
import {
  createGeneratedWorld,
  type G4GenerationProfile,
} from "../../generation/world";

const FIRST = 20_000;
const PROFILES: G4GenerationProfile[] = [
  "sqlite-interactive",
  "sqlite-atomic-batch",
  "scripted-returning-weak",
  "scripted-returning-ack",
];

interface Observation {
  readonly value: string;
  readonly statements: string;
}

async function observe(
  seed: number,
  profile: G4GenerationProfile
): Promise<Observation> {
  const recipe = generateG4Recipe(seed, FIRST);
  const world = await createGeneratedWorld(recipe.seed, recipe.rowCount, profile);
  try {
    const request = buildRequest(recipe, cursorKeyFor(recipe, world.rows));
    world.driver.statements.length = 0;
    const model = world.client[request.model];
    assert.ok(model);
    const operation = model[request.operation];
    assert.ok(operation);
    const value = await operation(request.args);
    return {
      value: JSON.stringify(value, (_key, item) =>
        typeof item === "bigint" ? item.toString() : item
      ),
      statements: JSON.stringify(world.driver.statements),
    };
  } finally {
    await world.close();
  }
}

describe("review probe: G4 campaign profile axis", () => {
  it(
    "every profile produces an identical value AND an identical statement stream",
    async () => {
      const differing: string[] = [];
      for (let offset = 0; offset < 20; offset++) {
        const seed = FIRST + offset;
        const base = await observe(seed, "sqlite-interactive");
        for (const profile of PROFILES.slice(1)) {
          const other = await observe(seed, profile);
          if (other.value !== base.value || other.statements !== base.statements)
            differing.push(`${profile}:${seed}`);
        }
      }
      assert.deepEqual(
        differing,
        [],
        "at least one profile is observationally distinct — the probe's premise is wrong"
      );
    },
    120_000
  );
});
