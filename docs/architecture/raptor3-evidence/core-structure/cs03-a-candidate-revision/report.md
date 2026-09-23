# CS-03 candidate extension A — repaired checkpoint

Status: **candidate A feature-only cost reconstruction complete; final behavior
is qualified on the composed source.**

## Outcome

The candidate implements relation-bearing root `updateMany` terminal selection
through the existing selected-series execution and shared series-completion
owner. Final primary keys are read only after every admitted member finishes;
injected identity fields stay private. A missing update row is an
operation-specific `TransactionError`, while the existing `createMany`
underflow remains a `QueryEngineError`. Atomic-batch failures retain
result-phase progress for all three completed outer and nested members.
The updateMany underflow error carries its model and operation at the existing
error-construction boundary; `createMany` remains unchanged.

The first candidate-A checkpoint is preserved as historical evidence. Its
parallel type-driven capture/execution paths and universal underflow error
translation were reviewed out. The repaired delta has one broad selected-series
flow and one documented narrowing at the select-bearing `updateMany` boundary.

The exact production delta from the post-review foundation baseline is
[`cs03-candidate-a-revised.patch`](../cs03-candidate-a-revised.patch), SHA-256
`4665e789e48cf6765fb51b7c0b338237b4c5a8370f3577206e8a7b3fcb77490e`.

## Validation

- `zWlGy8`: final extension-A contract **6/6**, zero skips.
- `BEHfNf`: accepted member-scope contract **8/8**, zero skips. The trusted
  type narrowing that followed this run changes no scope behavior.
- Whole-estate typecheck after `zWlGy8` has no candidate-A or shared-contract
  error. It retains only the two historical Pattern TS2345 diagnostics and the
  isolated task-worktree `tests/pattern/pack/program-dump.ts:131` TS2532.
- The final standalone feature reconstruction uses Node 24.21.0 and production identity
  `3fb5862f21e847ff30ff85aafc1b187df5b663306abdfdc3fc7dea3c0ee5afe4`,
  as recorded by the cost receipt. The earlier `zWlGy8` validation identity
  remains preserved in its receipt; final qualification uses the composed
  source and common registered harness.
- On the final composed source, A6 `4CjKYV` is **6/6**. Seeded campaign
  `VMW01B` completed 200 cases and 600 exact replays with zero skips; saved
  corpus replay `PUzMYt` passed. Strict reference comparison is exact.
- The revised patch applies cleanly after the separate foundation cleanup. The
  shared A6 witness SHA-256 is
  `d2ae31a4c99043130fee3a05519d928005dd338ec3a3d28f843caeac98a6e233`.
- Independent targeted review accepted both repairs; its artifact is
  `/tmp/viborm-cs03-reference.dRRksW/reviews/candidate-a-independent-review.md`,
  SHA-256
  `0f9b9f945c99e5248105e88b38f07429bbb07447d5fb9bb39990c5bc03244e56`.

The [cost receipt](./cost.json) charges **+63 code-bearing lines, +311 parser
tokens, and +2,111 source bytes** in both owner scopes. No foundation-cleanup
or extension-B code or saving is included.

## Risks

The standalone endpoint is exact cost and patch evidence, not a separately
executed final-source qualification. The selected composition and its final
closure own behavioral acceptance.
