/**
 * Runner for the G4-04 ROOT REVIEW — Area C (contracts and decisions) probes.
 *
 *   node scripts/run-vitest-safe.mjs run \
 *     --workspace=docs/architecture/raptor3-evidence/g4/root-review-probes/C/review.workspace.ts \
 *     docs/architecture/raptor3-evidence/g4/root-review-probes/C
 *
 * The probes live OUTSIDE `tests/` on purpose: the tree is frozen at the
 * qualification identity and `captureRaptor3Identity` hashes `tests/raptor3`,
 * `scripts` and `benchmarks`. Files under `docs/` change neither fingerprint.
 */
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    extends: "../../../../../../vitest.config.ts",
    test: {
      name: "g4-root-review-C",
      include: [
        "docs/architecture/raptor3-evidence/g4/root-review-probes/C/*.test.ts",
      ],
    },
  },
]);
