/**
 * Runner for the G3-02 specimen INDEPENDENT REVIEW probes.
 *
 * These probes belong to no registered mode (registering them would move a
 * manifest count the unit under review must not move), so this workspace
 * exists only so they run through the ordinary bounded runner and the
 * workspace lock:
 *
 *   node scripts/run-vitest-safe.mjs run \
 *     --workspace=tests/raptor3/g4/review/g3-02-specimen/g3-02-review.workspace.ts \
 *     tests/raptor3/g4/review/g3-02-specimen/
 */
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    extends: "../../../../../vitest.config.ts",
    test: {
      name: "g3-02-specimen-review",
      include: ["tests/raptor3/g4/review/g3-02-specimen/*.review.test.ts"],
    },
  },
]);
