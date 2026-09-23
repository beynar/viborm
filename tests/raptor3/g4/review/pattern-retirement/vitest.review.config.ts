/**
 * Config for the pattern-retirement INDEPENDENT review probes only.
 *
 * The probes are deliberately NOT registered in `scripts/raptor3-manifest.mjs`
 * or `vitest.workspace.ts` — a reviewer does not edit the author's shared
 * manifests. This config extends the repository's own `vitest.config.ts` so the
 * probes run under the same aliases, pool and ceilings as every other suite.
 */
import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../../../../vitest.config";

export default mergeConfig(
  base,
  defineConfig({
    test: {
      name: "g4-review-pattern-retirement",
      include: [
        "tests/raptor3/g4/review/pattern-retirement/**/*.review.test.ts",
      ],
    },
  })
);
