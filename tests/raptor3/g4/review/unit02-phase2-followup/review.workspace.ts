/**
 * Runner for the G4-02 phase-2 REVIEW FOLLOW-UP probe suite (repair round 3).
 *
 *   node scripts/run-vitest-safe.mjs run \
 *     --config=tests/raptor3/g4/review/unit02-phase2-followup/review.workspace.ts \
 *     tests/raptor3/g4/review/unit02-phase2-followup/
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: "./vitest.config.ts",
        test: {
          name: "g4-review-unit02-phase2-followup",
          include: ["tests/raptor3/g4/review/unit02-phase2-followup/*.test.ts"],
        },
      },
    ],
  },
});
