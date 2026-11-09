/**
 * Runner for the witness-follow-up review's probe suites.
 *
 * `scripts/credential-free-test-manifest.mjs` excludes `tests/raptor3/g4/review/`
 * from `extended-local`, so these files belong to no registered project. This
 * workspace exists only so the probes can be run through the ordinary bounded
 * runner and the workspace lock:
 *
 *   node scripts/run-vitest-safe.mjs run \
 *     --config=tests/raptor3/g4/review/witness-followup/review.workspace.ts \
 *     tests/raptor3/g4/review/witness-followup/
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: "./vitest.config.ts",
        test: {
          name: "g4-review-witness-followup",
          include: ["tests/raptor3/g4/review/witness-followup/*.test.ts"],
        },
      },
    ],
  },
});
