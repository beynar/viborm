/**
 * Review probe — G4 harness reconciliation, follow-up round.
 *
 * Review finding 2 asked for the fold x fault census that §18.8 #4 admitted it
 * had never extracted, and for one FIXED witness at that intersection. The
 * repair added seed 8611 to `representativeRecipes()` and published a census
 * receipt (`repair/folded-fault-census.json`).
 *
 * The first review round measured that census with a hand re-implementation of
 * the generator. This cell recomputes it from the REAL `generateG3Recipe`, so
 * the published table is checked against the generator the campaigns run, not
 * against a second copy of its arithmetic — and it keeps failing if either the
 * generator's seed mapping or the published receipt drifts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { generateG3Recipe } from "../../../g3/generation/recipe";

const CENSUS_RECEIPT =
  "/Users/arnaud/code/viborm/docs/architecture/raptor3-evidence/g4/witness/receipts/reconciliation/repair/folded-fault-census.json";

/** The fold is the depth-0 root `create`: one INSERT, no relation named. */
function census(firstSeed: number, seedCount: number) {
  let c11 = 0;
  let folded = 0;
  let foldedFault = 0;
  let foldedOverlap = 0;
  for (let seed = firstSeed; seed < firstSeed + seedCount; seed++) {
    const recipe = generateG3Recipe(seed);
    if (recipe.contract !== "C11") continue;
    c11++;
    if (recipe.depth !== 0) continue;
    if (recipe.shape !== "ordinary" && recipe.shape !== "repeated") continue;
    folded++;
    if (recipe.fault !== "none") foldedFault++;
    if (recipe.actors === 2) foldedOverlap++;
  }
  return { c11, folded, foldedFault, foldedOverlap };
}

describe("review probe: the folded x faulted census, from the real generator", () => {
  it("seed 8611 is a folded, faulted C11 in the generator itself", () => {
    const generated = generateG3Recipe(8611);
    assert.equal(generated.contract, "C11");
    assert.equal(generated.fault, "legal-provider-failure");
    assert.equal(generated.actors, 1);
    assert.ok(generated.contract === "C11");
    assert.equal(generated.depth, 0, "a depth-0 root create is the fold");
    assert.equal(generated.shape, "ordinary");
  });

  it("reproduces every published range count", () => {
    const published = JSON.parse(readFileSync(CENSUS_RECEIPT, "utf8")) as {
      campaigns: Record<
        string,
        {
          firstSeed: number;
          seedCount: number;
          c11: number;
          folded: number;
          foldedFault: number;
          foldedOverlap: number;
        }
      >;
    };
    for (const [label, row] of Object.entries(published.campaigns)) {
      const measured = census(row.firstSeed, row.seedCount);
      assert.deepEqual(
        measured,
        {
          c11: row.c11,
          folded: row.folded,
          foldedFault: row.foldedFault,
          foldedOverlap: row.foldedOverlap,
        },
        `${label} does not reproduce from the real generator`
      );
    }
    // The two numbers the first review round measured by hand, pinned.
    assert.deepEqual(census(8000, 10000), {
      c11: 2500,
      folded: 233,
      foldedFault: 44,
      foldedOverlap: 52,
    });
    assert.deepEqual(census(100000, 25000), {
      c11: 6250,
      folded: 624,
      foldedFault: 108,
      foldedOverlap: 130,
    });
  });
});
