import { describe, it } from "vitest";
import { G0_PROFILES } from "./profiles";
import { verifyGeneratedCell } from "./generation/campaign";
import { generateRecipe } from "./generation/relations";

describe.each(G0_PROFILES)("G1 independent generated smoke: %s", (profile) => {
  for (let seed = 1000; seed < 1016; seed++) {
    it(`seed ${seed}`, async () => {
      await verifyGeneratedCell(generateRecipe(seed), profile);
    });
  }
});
