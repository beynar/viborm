/**
 * Runner for the independent review probes of the G4 performance pass.
 *
 * `scripts/credential-free-test-manifest.mjs` excludes `tests/raptor3/g4/review/**`
 * from every registered lane, so these probes belong to no project. This
 * workspace exists only so they run through the ordinary bounded runner and the
 * workspace lock:
 *
 *   node scripts/run-vitest-safe.mjs run \
 *     --workspace=tests/raptor3/g4/review/perf/perf-review.workspace.ts \
 *     tests/raptor3/g4/review/perf/
 */
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    extends: "../../../../../vitest.config.ts",
    test: {
      name: "g4-perf-review",
      include: ["tests/raptor3/g4/review/perf/*.test.ts"],
    },
  },
]);
