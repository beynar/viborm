/**
 * Runner for the G4-03b independent review probes.
 *
 * `scripts/credential-free-test-manifest.mjs` excludes `tests/raptor3/g4/review/`
 * from `extended-local`, so these files belong to no registered project. This
 * workspace exists only so the probes run through the ordinary bounded runner
 * and the workspace lock:
 *
 *   node scripts/run-vitest-safe.mjs run \
 *     --workspace=tests/raptor3/g4/review/unit03b/review.workspace.ts \
 *     tests/raptor3/g4/review/unit03b/<file>
 */
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    extends: "../../../../../vitest.config.ts",
    test: {
      name: "g4-review-unit03b",
      include: ["tests/raptor3/g4/review/unit03b/*.test.ts"],
    },
  },
]);
