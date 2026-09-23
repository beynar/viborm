# Release unit "n3" — independent round-4 re-check

Reviewer: independent (Opus), main tree `/Users/arnaud/code/viborm` on
`pattern-engine` @ `eca417a4e`, unit still uncommitted. Read
`review-round3.md` first, then the live files: the plan's "3 as landed"
paragraph and its whole uncommitted hunk, `note.md` §2, `g4.md`'s N3 entry,
`src/drivers/d1/index.ts`, `src/drivers/neon-http/index.ts`,
`src/query-engine/raptor3/shared/operation-context.ts`,
`src/query-engine/batch-error-attribution.ts`,
`src/query-engine/raptor3/commands/relation-body.ts`,
`src/drivers/error-mapping.ts`, `src/query-engine/raptor3/AGENTS.md`.

No test was run (round 3 asked for no code change and none was made; the
three files edited since are documents). I wrote nothing but this file:
nothing under `src/`, `tests/`, `scripts/` or any other document was edited,
staged, committed, reverted or stashed, and no other worktree was touched.

## Verdict: ACCEPT

R7 landed exactly as asked, R8 landed, the observation is closed, and the
unit's code is byte-for-byte what round 3 reviewed.

## 1. R7 — the false clause is gone (closed)

`docs/architecture/raptor3-nesting-and-refusals-plan.md:187-194` now reads:

> (3b) attribution comes first, and where the provider reports no index the
> re-probe's answer is a sentence: the claim "nothing but premises ahead of
> the rejection" is bounded by the LAST premise in the batch; and the premise
> about a captured member is asserted where the observation is taken —
> `retained` on the deletion lookup for the LAX form (the strict form keeps
> its identity sentence, D-34), per-member presence at the series capture —
> never at the consuming deletion or removal …

Against round 3's §2 quote the single difference is that ", and not made at
all where an ordinary statement could arrive as the assertion class;" has
become ";". The integrator took R7's first option (delete) rather than the
restatement; either was accepted. The plan no longer asserts the declined R6
refusal, and `grep` for "not made at all" over the plan, `note.md` and
`AGENTS.md` returns nothing.

The whole uncommitted hunk (`git diff -- …plan.md`) is still the one
16-line addition of this paragraph and nothing else; its other sentences —
(3a)'s floor, the weak-batch parenthesis, "the deletion command asserts
nothing", the unchanged update-member premise — are as round 2 and round 3
left them, and each is true of the landed code (`relation-body.ts:258-260`
still assigns `retained` under `if (lax)` alone, with the D-32/D-34 comment).
Line 190 is short; that is the re-wrap, not a second edit.

## 2. R8 and the ladder's shape (closed), and the D1 claim is right

`note.md` §2 now reads as a ladder bullet plus a following paragraph. The
bullet's ordered list is whole again — "… so the claim is bounded by the LAST
premise in the batch (…); then the uncertainty; then, for a raceable premise,
the recovery mark; and, when nothing is attributed, the typed floor
(`NestedWriteError`, code V7006 …)" (lines 47-66). The R6 declination is its
own paragraph after it (lines 68-80).

- The LIKE half is gone: "so a division in ordinary SQL (the adapter's
  arithmetic) would forfeit the recovery on Neon HTTP". Only the true case
  remains, and the conclusion is unchanged.
- The predicate is named "today the sole guard's gate only". True across the
  estate, not just this file: its two call sites are
  `operation-context.ts:1236` (the `soleGuard` disjunct) and the retired
  `batch-error-attribution.ts:107` (the sole candidate's `attributable`).
  Neither gates a position claim.
- **The new D1 sentence checks out.** `positionBound` /
  `rejectedBeforeAnyWrite` (`operation-context.ts:1264-1278`) have exactly
  one consumer, the uncertainty branch at `:1280-1287`, whose condition
  includes `!this.driver.supportsOrderedCommittedSegments`; `d1/index.ts:158`
  sets that flag `true` and `neon-http/index.ts:140` deliberately keeps the
  inherited `false`. `mayHaveCommittedSegment` is assigned in exactly one
  place (`:1286`), and the recovery mark at `:1296-1318` consults
  `committedProgress`, which reads that flag. So on D1 the bound's only
  reachable effect is gated off, and "Neon HTTP is the transport where the
  bound decides anything" is exact. Round 3 offered this as a note and left
  it unmeasured; it is now established by reading, statically and completely.

## 3. Observation 1 — the falsification's claim (closed)

`note.md` §2 lines 56-59: "bounded, the rejection keeps its uncertainty in one
batch; unbounded, the recovery is granted — the cell dies at its expected
rejection when the bound is removed, `receipts/round2/falsify-unbounded.log`."
The batch count is gone; what remains is what the receipt's
`AssertionError: Missing expected rejection.` proves. "converges in two
batches" appears nowhere in the unit's documents.

## 4. The ledger, and nothing else moved

`g4.md`'s N3 entry (lines 2852-2906, the file's last) records round 3's
outcome — REVISE, the plan clause deleted (R7), the LIKE half dropped (R8),
the falsification's claim narrowed — and ends "Re-check pending." That
sentence is this round's to close: **round 4 ACCEPTs**, R7 and R8 confirmed
applied, no defect found, no resolution asked. Updating that line is the
integrator's bookkeeping, not a change to the unit.

`git status --untracked-files=all --porcelain -- src tests scripts` is
precisely round 3's list (the 9 modified files, plus untracked
`batch-only-drivers.ts` and `series-member-premise.test.ts`), and
`git diff --numstat -- src tests scripts` is byte-identical to
`receipts/numstat.txt` (`diff` of the two: empty). Every file in those three
trees has an mtime at or before 03:24:41, while `review-round3.md` is
03:38:53 and the three edited documents (plan, `note.md`, `g4.md`) are all
03:40:35 — so no source moved since round 3, which is why no run was needed.
The unrelated dirty and untracked files (`CONTEXT.md`, `memory.md`,
`exa-results/`, the root `transport-*-corpus.json`, the pre-G4 evidence
archives) are untouched by me.

## 5. Observations (no resolution asked)

- `AGENTS.md`'s ladder paragraph and the `operation-context.ts:1254-1263`
  comment still carry the wider sentence without the D1 refinement. Neither
  is wrong — only broader than the shipped fact — and round 3 declined to ask
  for it. Leave them; the precise statement belongs in the note.
- "the uncertainty is **besides** gated by" (`note.md` §2) is an odd adverb
  placement. Cosmetic; not worth an edit to a document this round otherwise
  closes.

## 6. Unverified

- Everything round 3 listed as unverified stays so: the Docker provider lanes,
  the estate comparison, the core and coverage lanes, `coverage:policy`, the
  falsification re-run, and the collision residual's missing transport
  (D-53's owed witness). Round 3's receipts are unchanged and the source they
  measure has not moved, which is the basis for not re-running them.
- The D1 finding in §2 is static (call-site enumeration plus two flag reads),
  not measured against a live D1.
- I re-derived none of round 3's measurements (27 / 27, 796 / 796, 0
  diagnostics, Biome's six); no source changed, so they carry over by mtime,
  not by re-measurement.
