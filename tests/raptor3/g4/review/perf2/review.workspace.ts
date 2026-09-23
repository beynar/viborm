/**
 * Runner for the G4 performance pass 2 INDEPENDENT REVIEW probe suite.
 *
 *   node scripts/run-vitest-safe.mjs run \
 *     --workspace=tests/raptor3/g4/review/perf2/review.workspace.ts \
 *     tests/raptor3/g4/review/perf2/
 *
 * Not registered in `scripts/raptor3-manifest.mjs` — a review workspace only.
 */
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    extends: "../../../../../vitest.config.ts",
    test: {
      name: "g4-review-perf2",
      include: ["tests/raptor3/g4/review/perf2/*.test.ts"],
    },
  },
]);
