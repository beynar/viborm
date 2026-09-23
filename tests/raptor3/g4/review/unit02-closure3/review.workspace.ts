/**
 * Runner for the G4-02 closure-repair ROUND 3 review probe suite.
 *
 *   VIBORM_RAPTOR3_PROVIDER=mysql VIBORM_RAPTOR3_PROVIDER_PORT=<port> \
 *   node scripts/run-vitest-safe.mjs run \
 *     --workspace=tests/raptor3/g4/review/unit02-closure3/review.workspace.ts \
 *     tests/raptor3/g4/review/unit02-closure3/
 */
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    extends: "../../../../../vitest.config.ts",
    test: {
      name: "g4-review-unit02-closure3",
      include: ["tests/raptor3/g4/review/unit02-closure3/*.test.ts"],
    },
  },
]);
