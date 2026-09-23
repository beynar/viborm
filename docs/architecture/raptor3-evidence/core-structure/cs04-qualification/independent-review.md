# CS-04 independent qualification review

Status: **accepted as complete qualification evidence for global review.** This
does not authorize a public route change, G3 work, a commit, or release.

## Outcome

The selected occurrence-structure candidate qualifies on production identity
`36103eff320ac096af2453b600fe2fcb8dded8c4ef9243c11b208be16ee24377`,
harness identity
`87bc63c2a57e7e7b1b542606ce9d2f4e894745dbf1f75eb4e2c8bb3c0929083e`,
and Node 24.21.0. I found no remaining correctness, ownership, evidence, or
archive defect in the bounded CS-04 unit.

The decision remains an ownership trade-off, not compression. The candidate
ends at 6,598 core lines / 41,111 parser tokens / 218,915 bytes and 10,672
broader lines / 65,735 tokens / 451,962 bytes. It is 426 lines, 1,893 tokens,
and 12,908 bytes larger than the flat reference in both counted scopes. Its
standalone A and B costs are measured from the repaired foundation, and the
combined A+B increment is +109 lines / +695 tokens / +3,747 bytes.

The architectural benefit is narrower and real: one placement-owned occurrence
tree replaces the flat-history publication graph, range and suffix
synchronization, mirrored branch observations, sibling history copies, and the
membership-owner scan. The final repeated-placement repair keeps source-child
correspondence local to one materialized parent. It adds no cache, scheduler,
public identifier, or second topology.

## Validation

- The source chain applies and reverses from the accepted scope baseline both
  directly and through foundation plus A, B, or A+B. All 28 accounted source
  hashes match the selected worktree and reviewed MAIN integration. The final
  production census is internally consistent with `source/cost.json` and
  `source/source-accounting.json`.
- The final repaired source passes 31 fixed modes / 1,095 tests, the 55-file
  credential-free aggregate / 717 tests, five isolated PGlite files / 11
  tests, nine PostgreSQL modes / 56 tests, and eight MySQL modes / 45 tests.
  Raw receipts bind these results to the final identity. Native directory names
  match `verified.mode`, provider teardown is recorded, and no credential is
  archived.
- The seven source-bound campaigns contain 105 successful executions and total
  21,000 completed cells, 63,000 exact same-build replays, and zero skips. Five
  saved corpora replay on the final identity; two historical corpora refuse at
  the identity boundary before semantic decoding. Their archived hashes match
  the replay inputs.
- Exact repaired-foundation standalone snapshots pass candidate A 6/6 at
  `821f40dbfd6d5753f741cfe14a58609b94094bb48c9d1bdf47c7bf973586827f`
  and candidate B 4/4 at
  `c05956648b7295d9198a44d615f288108e29937ec139ce69ab78f8a4541f786a`.
  The composed source, not those focused receipts, owns full seeded-campaign
  qualification.
- Structural receipt `UUKxtm` passes 28 cases and 60 replays with zero skips.
  The archived candidate and reference raw receipts have identical recipes,
  schedules, semantic inventories, outcomes, counter contract, and replay
  tapes. Independent reduction reproduces 1,657 pair checks on each side. The
  candidate records 5,146 comparison atoms, 5,180 prefix reads including 1,028
  navigation reads, 638 semantic-publication copies, and zero owner scans; the
  reference records 6,239 atoms, 2,319 prefix reads, 1,887 copies, and 12,743
  owner-scan reads. These unlike work units are not a runtime claim.
- The new reused-enclosing-command case failed before the local materialization
  repair while the existing four ownership cases passed; all five pass after
  repair. The superseded `limit` refusal was narrowed only for admitted A/B
  behavior. The distinct incomplete selected-series batch refusal remains
  covered at its preparation owner.
- Receipt-owner 15/15 and CLI-owner 7/7 evidence is present. The isolated
  candidate typecheck has only the two historical Pattern TS2345 diagnostics
  and the excluded snapshot-only program-dump TS2532; reviewed MAIN has only
  the two historical production diagnostics. No task-owned type error remains.
- All archive JSON parses. The top `SHA256SUMS` is the final payload authority;
  independent verification after this review record was added reports no
  mismatch.

The selected integration excludes unrelated `CONTEXT.md`, `memory.md`, the
user's `tests/pattern/pack/program-dump.ts` correction, Pattern M3's
`tests/pattern/match/decode-malformed.core.test.ts`, and stale test-tree
measurement patches. Historical and pre-final evidence remains archived under
its own identity and is not relabeled as final proof.

## Risks

- The candidate retains a 426-line endpoint premium and more explicit
  construction/navigation work. Qualification provides no bundle-size or
  runtime-speed result.
- The old engine remains the public route. G3 composition, cutover, performance
  adoption budgets, commit, push, and release remain separate decisions.
- The two historical Pattern production type errors remain visible; they are
  not caused or repaired by this unit.
