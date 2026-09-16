/**
 * Scaffold so this review's probes can run before the registration writer adds
 * them to `scripts/raptor3-manifest.mjs` (another stream's file this round).
 * Run with:
 *   node scripts/run-vitest-safe.mjs run \
 *     --workspace=tests/raptor3/g4/review/harness-reconciliation/review.workspace.ts
 *
 * The second project is not a probe: it is the §5.4 surrounding-cut evidence
 * the transport-plan fold rests on (`g4/unit02/note.md` §P.11.3), which is in
 * NO registered lane — neither the `raptor3` project nor `EXTENDED_LOCAL_TESTS`
 * — so no gate runs it. Finding 3 of the review.
 */
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    extends: "/Users/arnaud/code/viborm/vitest.config.ts",
    test: {
      name: "hr-review",
      root: "/Users/arnaud/code/viborm",
      include: ["tests/raptor3/g4/review/harness-reconciliation/*.test.ts"],
    },
  },
  {
    extends: "/Users/arnaud/code/viborm/vitest.config.ts",
    test: {
      name: "hr-review-unregistered-cut-evidence",
      root: "/Users/arnaud/code/viborm",
      include: [
        "tests/raptor3/g4/unit02/root-member-cut-trace.test.ts",
        "tests/raptor3/g4/unit02/malformed-result-cuts.test.ts",
      ],
    },
  },
]);
