// Support file: the pattern-retirement review probes are not in any registered
// project (the reviewer ran them under an ad-hoc `g4-review-pattern-retirement`
// project — see `g4/pattern-retirement-review-receipts/review-probes.log`).
// This workspace reproduces that project so the follow-up lane can re-run them
// after F-2/F-6 changed what they measure. It registers nothing in the repo.
//
// `extends` is an absolute path on purpose: vitest resolves it through esbuild
// before `import.meta.dirname` is available, so a computed root fails to build.
// The path is this lane's worktree.
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    extends: "/private/tmp/viborm-followups/vitest.config.ts",
    test: {
      name: "g4-review-pattern-retirement",
      include: ["tests/raptor3/g4/review/pattern-retirement/*.review.test.ts"],
    },
  },
]);
