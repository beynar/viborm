/**
 * Runner for the G4-02 DECISIONS-unit review probe suite.
 *
 *   node scripts/run-vitest-safe.mjs run \
 *     --config=tests/raptor3/g4/review/unit02-decisions/review.workspace.ts \
 *     tests/raptor3/g4/review/unit02-decisions/
 *
 * The live rows need `VIBORM_RAPTOR3_PROVIDER=mysql` and
 * `VIBORM_RAPTOR3_PROVIDER_PORT=<docker port …>`.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: "./vitest.config.ts",
        test: {
          name: "g4-review-unit02-decisions",
          include: ["tests/raptor3/g4/review/unit02-decisions/*.test.ts"],
        },
      },
    ],
  },
});
