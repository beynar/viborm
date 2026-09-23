# Witness follow-up receipts

`witness-harness-vs-0cc61e61.patch` is the **cumulative** diff of this stream's
tracked harness files against the G4 starting commit `0cc61e61`: it contains
round 1's registration work *and* this follow-up, because those six files
(`scripts/raptor3-manifest.mjs`, `scripts/run-raptor3.mjs`,
`scripts/raptor3-campaign-receipts.test.mjs`, `scripts/raptor3-cli.test.mjs`,
`scripts/credential-free-test-manifest.mjs`, `vitest.workspace.ts`) were already
uncommitted when the follow-up started. The four files that were clean at
`0cc61e61` — `tests/raptor3/transitions/live-world.ts` and the three
`tests/raptor3/g3/generation/` files — carry this follow-up's changes only.

The G4 test tree (`tests/raptor3/g4/`) is untracked on this branch, so files
added there by this follow-up are not in the patch. They are:

- `tests/raptor3/g4/unit01/` (10 test files + `world.ts`), landed from
  `/private/tmp/viborm-g4-unit01`
- `tests/raptor3/g4/review/unit01/`, `unit01-followup/`, `unit01-followup2/`,
  `unit01-followup3/` (29 test files + their worlds), landed from the same
  worktree, with one byte change in
  `unit01-followup2/cursor-refusal.test.ts` (TS2638)
- `tests/raptor3/g4/generation/write-campaign.test.ts`
- `tests/raptor3/g4/generation/write-transport-campaign.test.ts`
- edits inside the existing `tests/raptor3/g4/native/read-envelope-native.test.ts`

Nothing here was committed or staged.
