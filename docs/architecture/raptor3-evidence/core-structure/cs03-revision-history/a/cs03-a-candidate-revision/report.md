# CS-03 candidate extension A — repaired checkpoint

Status: **candidate A checkpoint complete on the accepted peer-scope baseline.**

## Outcome

The candidate implements relation-bearing root `updateMany` terminal selection
through the existing selected-series execution and shared series-completion
owner. Final primary keys are read only after every admitted member finishes;
injected identity fields stay private. A missing update row is an
operation-specific `TransactionError`, while the existing `createMany`
underflow remains a `QueryEngineError`. Atomic-batch failures retain
result-phase progress for all three completed outer and nested members.

The first candidate-A checkpoint is preserved as historical evidence. Its
parallel type-driven capture/execution paths and universal underflow error
translation were reviewed out. The repaired delta has one broad selected-series
flow and one documented narrowing at the select-bearing `updateMany` boundary.

The exact production delta from the accepted candidate scope baseline is
[`cs03-candidate-a-revised.patch`](../cs03-candidate-a-revised.patch), SHA-256
`a29980faab5992ac2172f881f22d3e5c789751afafc290c491c8be6fdf31897e`.

## Validation

- `zWlGy8`: final extension-A contract **6/6**, zero skips.
- `BEHfNf`: accepted member-scope contract **8/8**, zero skips. The trusted
  type narrowing that followed this run changes no scope behavior.
- Whole-estate typecheck after `zWlGy8` has no candidate-A or shared-contract
  error. It retains only the two historical Pattern TS2345 diagnostics and the
  isolated task-worktree `tests/pattern/pack/program-dump.ts:131` TS2532.
- Final runs use Node 24.21.0 and production identity
  `b2681717f443c420b65e01586e5e494c281915fa918ab49b7d6ce27b1a5ab168`.
- The revised patch applies cleanly to the exact accepted scope baseline. The
  shared A6 witness SHA-256 is
  `d2ae31a4c99043130fee3a05519d928005dd338ec3a3d28f843caeac98a6e233`.
- Independent targeted review accepted both repairs; its artifact is
  `/tmp/viborm-cs03-reference.dRRksW/reviews/candidate-a-independent-review.md`,
  SHA-256
  `0f9b9f945c99e5248105e88b38f07429bbb07447d5fb9bb39990c5bc03244e56`.

The [cost receipt](./cost.json) charges **+57 code-bearing lines, +286 parser
tokens, and +1,921 source bytes** in both owner scopes. No extension-B code or
saving is included.

## Risks

This checkpoint qualifies candidate A only. Extension B remains a separate
saved delta until the two patches are composed and revalidated together.
