/**
 * Runner for the G4-02 review probe suites.
 *
 * `scripts/credential-free-test-manifest.mjs` deliberately excludes
 * `tests/raptor3/g4/review/` from `extended-local`, so these files belong to no
 * registered project. This workspace exists only so the probes can run through
 * the ordinary bounded runner and the workspace lock:
 *
 *   node scripts/run-vitest-safe.mjs run \
 *     --workspace=tests/raptor3/g4/review/unit02/review.workspace.ts \
 *     tests/raptor3/g4/review/unit02/<file>
 */
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    extends: "../../../../../vitest.config.ts",
    test: {
      name: "g4-review-unit02",
      include: ["tests/raptor3/g4/review/unit02/*.test.ts"],
    },
  },
]);
