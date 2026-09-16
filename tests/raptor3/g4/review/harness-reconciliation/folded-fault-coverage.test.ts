/**
 * Review probe — G4 harness reconciliation, transport fault coverage of the
 * FOLDED shape.
 *
 * `ordinaryRecurrenceReplies` now scripts one statement for `depth === 0`.
 * The unit argues no fault family was thinned because the fault attaches to the
 * reply, not to a statement. That is true of the driver — but the FIXED
 * representative matrix in `generated-transport-smoke.test.ts` contains exactly
 * one depth-0 C11 recipe (seed 8027) and its `fault` is `none`, so the fold ×
 * fault intersection is exercised only by seeded campaign cells (measured:
 * 8091 inside `g3-transport-seed-batch 8000`, 100031 inside
 * `g4-write-transport-seed-batch 100000`).
 *
 * These cells pin that intersection as a fixed witness, on both transport
 * profiles: the injected failure still fires on a one-statement reply, the
 * faulted operation fails, and the healthy suffix still succeeds.
 */
import { describe, it } from "vitest";
import {
  g3RecipeFromPublicInput,
  type G3GeneratedRecipe,
} from "../../../g3/generation/recipe";
import { verifyG3TransportCell } from "../../../g3/generation/transport-campaign";
import { TRANSPORT_PROFILES } from "../../../profiles";

const admit = (recipe: unknown): G3GeneratedRecipe =>
  g3RecipeFromPublicInput({ recipe });

const FOLDED_FAULTED = [
  admit({
    seed: 8611,
    contract: "C11",
    actors: 1,
    operations: 2,
    fault: "legal-provider-failure",
    depth: 0,
    fanout: 0,
    shape: "ordinary",
  }),
  admit({
    seed: 8091,
    contract: "C11",
    actors: 1,
    operations: 3,
    fault: "legal-provider-failure",
    depth: 0,
    fanout: 3,
    shape: "repeated",
  }),
  admit({
    seed: 8651,
    contract: "C11",
    actors: 2,
    operations: 2,
    fault: "none",
    depth: 0,
    fanout: 1,
    shape: "ordinary",
  }),
] as const;

describe("review probe: folded depth-0 root create under fault and overlap", () => {
  for (const recipe of FOLDED_FAULTED)
    for (const profile of TRANSPORT_PROFILES)
      it(`seed ${recipe.seed} (${recipe.contract} ${"shape" in recipe ? recipe.shape : ""}, fault=${recipe.fault}, actors=${recipe.actors}) on ${profile}`, async () => {
        // `verifyG3TransportCell` asserts, among other things, that the number
        // of injected failures matches the recipe and that every scripted reply
        // was consumed in the exact scripted order.
        await verifyG3TransportCell(recipe, profile);
      });
});
