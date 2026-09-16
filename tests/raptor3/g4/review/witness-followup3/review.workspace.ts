/**
 * Runner for the round-3 witness-follow-up review's probe suites.
 *
 * `scripts/credential-free-test-manifest.mjs` excludes `tests/raptor3/g4/review/`
 * from `extended-local`, so these files belong to no registered project. This
 * workspace exists only so the probes can be run through the ordinary bounded
 * runner and the workspace lock:
 *
 *   node scripts/run-vitest-safe.mjs run \
 *     --workspace=tests/raptor3/g4/review/witness-followup3/review.workspace.ts \
 *     tests/raptor3/g4/review/witness-followup3/
 */
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    extends: "../../../../../vitest.config.ts",
    test: {
      name: "g4-review-witness-followup3",
      include: ["tests/raptor3/g4/review/witness-followup3/*.test.ts"],
    },
  },
]);
