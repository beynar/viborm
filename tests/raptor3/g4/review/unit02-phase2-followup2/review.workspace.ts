/**
 * Runner for the G4-02 phase-2 REVIEW FOLLOW-UP 2 probe suite (repair round 4).
 *
 *   node scripts/run-vitest-safe.mjs run \
 *     --workspace=tests/raptor3/g4/review/unit02-phase2-followup2/review.workspace.ts \
 *     tests/raptor3/g4/review/unit02-phase2-followup2/
 */
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    extends: "../../../../../vitest.config.ts",
    test: {
      name: "g4-review-unit02-phase2-followup2",
      include: ["tests/raptor3/g4/review/unit02-phase2-followup2/*.test.ts"],
    },
  },
]);
