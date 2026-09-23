/**
 * Runner for the G4-02 CLOSURE-REPAIR review probe suite (round 5).
 *
 *   node scripts/run-vitest-safe.mjs run \
 *     --workspace=tests/raptor3/g4/review/unit02-closure/review.workspace.ts \
 *     tests/raptor3/g4/review/unit02-closure/
 *
 * The native rows add `VIBORM_RAPTOR3_PROVIDER=mysql` and
 * `VIBORM_RAPTOR3_PROVIDER_PORT=<port>`.
 */
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    extends: "../../../../../vitest.config.ts",
    test: {
      name: "g4-review-unit02-closure",
      include: ["tests/raptor3/g4/review/unit02-closure/*.test.ts"],
    },
  },
]);
