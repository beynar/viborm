/**
 * Runner for the G4 FREEZE-preparation review probe suite.
 *
 *   node scripts/run-vitest-safe.mjs run \
 *     --config=tests/raptor3/g4/review/freeze/review.workspace.ts \
 *     tests/raptor3/g4/review/freeze/
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: "./vitest.config.ts",
        test: {
          name: "g4-review-freeze",
          include: ["tests/raptor3/g4/review/freeze/*.test.ts"],
        },
      },
    ],
  },
});
