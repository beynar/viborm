/** Runner for the repair-round-2 review probe (see witness-followup/review.workspace.ts). */
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    extends: "../../../../../vitest.config.ts",
    test: {
      name: "g4-review-witness-followup2",
      include: ["tests/raptor3/g4/review/witness-followup2/*.test.ts"],
    },
  },
]);
