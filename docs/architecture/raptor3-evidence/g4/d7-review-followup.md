# Independent review follow-up — G4-02 D-7 round 2

Reviewer: independent, the same reviewer as
[`g4/d7-review.md`](d7-review.md), [`g4/regression-review.md`](regression-review.md)
and [`g4/regression-review-followup.md`](regression-review-followup.md). Brief:
[`g4/briefs/d7-lone-statement.md`](briefs/d7-lone-statement.md) "Round 2" with
[`briefs/common.md`](briefs/common.md) and [`briefs/review.md`](briefs/review.md).
Author note: [`g4/regression/note.md`](regression/note.md) "D-7 round 2"
(§R2.1–R2.9). Source read and run in the main tree `/Users/arnaud/code/viborm`
at `HEAD 0cc61e61` (unchanged, nothing staged) with the unit's uncommitted diff
in place.

Reviewed identity — `captureRaptor3Identity` production
**`ad918c0e71af347885bbbec11ed04aac1516bfcf32b0434e58755e4465a31f2f`**, harness
**`a339c70ad453d3afc0444c0fe3433bde956a2c8b745f56509311b9d50f0ac7ed`**,
byte-for-byte the author's
[`receipts/d7-round2/identity-after.json`](regression/receipts/d7-round2/identity-after.json)
([`identity-reviewed.json`](d7-review-followup-receipts/identity-reviewed.json)),
captured after my own two falsifications were restored — so what I ran is what
the author recorded, and the restore was byte-exact.

| File | sha256 | matches §R2.7 |
| --- | --- | --- |
| `src/query-engine/raptor3/shared/operation-context.ts` | `aec115a3a817572c6edd0dab9d6400ed953eee28d44298bd73f73ad513fee1b1` | yes |
| `src/query-engine/raptor3/AGENTS.md` | `739397f348136cb9730319f686e7156e063c61155dfcb462437d14070c5e4ce2` | yes |
| `tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` | `cc0b6dea3eb79e318588c4ac3022f0713c714de235e058c515d8309b7bfb5e61` | yes |
| `tests/raptor3/g4/unit02/lone-statement-transport.test.ts` | `8b849837…` | unchanged this round |
| `tests/raptor3/post-prep/g29-result-progress*.test.ts` | `8518e406…` / `08557353…` | unchanged this round |
| `src/query-engine/raptor3/route/client-route.ts` | `976bbf85…` | unchanged — no route edit |
| `tests/raptor3/g3/generation/transport-plans.ts` | `5232c398ee8a0b3f5abb38f771e185ec36af61f15f0d898bdfdfee8af1324cac` | the integrator's applied diff, untouched |

Only three files changed inside the round-2 window (`find -newermt "2026-09-16
00:05"`): `operation-context.ts`, `raptor3/AGENTS.md`,
`uncertain-outcome-meta.test.ts`. Both manifests predate the round
(`raptor3-manifest.mjs` 20:00, `credential-free-test-manifest.mjs` 17:13), so no
manifest edit; no shipped-engine edit; nothing committed, staged, reset, stashed
or deleted.

Receipts: [`g4/d7-review-followup-receipts/`](d7-review-followup-receipts/).
My three probe files are unchanged from round 1 (`02f4b225…`, `fcd23eb6…`,
`aa46ff16…`) and were re-run against the round-2 source without editing a cell.

---

## Outcome: **ACCEPT**

All three resolutions the review asked for are in the source, each is the
smallest change that produces the effect, and each is falsifiable by colour:

* **finding 1 (must-fix) is closed.** `dispatchSetMutations` translates the
  decode failure once, where `decoded` is built (`:1210`), and that single value
  is both `stateWriteOutcome`'s primary and the thrown value. My **D9** is green
  — the candidate now publishes `AggregateError([QueryEngineError V9001,
  CacheConfigurationError])` with the same `cause`, the same committed rows and
  the same one invalidation as the shipped engine. I falsified it (restore
  `decoded = { failure: error }`): author cell 8 goes red with exactly the
  round-1 defect (`TypeError: "Invalid provider integer"` primary) and the other
  sixteen cells stay green.
* **note 2 was repaired, not merely recorded.** `acknowledged()` captures the
  listener's failure into `heldOutcomeFailure` (`:714-726`) and
  `settleSubmitted` releases it at every submit-decode site (`:847-861`), which
  is the shipped `runAtomicBatch` order I re-read at
  `OperationExecutor.ts:1277-1289`, `:1306-1309`, `:1332-1343` — capture in
  `committed()`, release at the head of the catch, compose after `operation.parse`
  and publish the listener's alone beside a successful answer. I falsified it
  (restore `await this.stateWriteOutcome(this.writeOutcome?.committedSegment)`
  in `acknowledged()`): author cell 9 goes red with the candidate publishing
  `CacheConfigurationError` **alone** — my round-1 D12 measurement exactly — and
  the other sixteen cells stay green.
* **note 3 is closed.** D11 is author cell 10; the `owned` gate (`:1184`) is now
  falsifiable by colour.
* **notes 4, 5, 6** are applied as statements and each one checks out against
  the code and the tests it names (§ per-item table below).

There is no second mechanism. `retainOutcomeFailure` (`:1260`) is the only
`AggregateError` construction in `src/query-engine/raptor3`; `heldOutcomeFailure`
has exactly one producer (`acknowledged`) and two release points
(`settleSubmitted`, `submit`'s catch); every one of the four `this.submit(...)`
call sites (`:648`, `:1052`, `:1150`, `:1764`) is immediately followed by
`settleSubmitted`, so a hold cannot leak into a later decode; `premiseFailures`
is gone (`grep` over `src/` and `tests/raptor3/g4`: no hit) and
`answeredFailures` generalises it in `failure()`'s existing early return
(`:391`), not beside it.

My D12 is still red, by **exactly one field and nothing else**, which I verified
from the full diff: `meta.recordSeriesProgress` on the V9001 (in `errors[0]` and
in `cause`, the same object). Kind, message, `errors` order, codes, the rest of
the meta, the invalidation count and the committed rows are identical. That is
the accepted divergence of `regression-review.md` finding 3 (my probe P8, which
the brief deliberately keeps), and author cell 9 excludes that field and only it
— `withoutProgress` strips `meta.recordSeriesProgress` and nothing else — and
then pins its value, so the exclusion cannot hide a change. Nothing else in the
31 probes moved: 30 pass, the same set as round 1 plus D9.

Everything I found this round is a note. None changes a public answer, an error
identity, committed state, an invalidation count, a fast-path count, or a
registered refusal, and none leaves a second authority.

---

## Per-finding status against `d7-review.md`

| # | Finding (round 1) | Status | Evidence |
| --- | --- | --- | --- |
| 1 | must-fix — plain path publishes the untranslated decoding failure | **resolved** | `:1204-1210`; D9 green; author cell 8; falsification A |
| 2 | note — the batch committed arm lets the listener replace the operation's failure | **resolved (repaired)** | `:714-726`, `:745-750`, `:847-861`; author cell 9; falsification B; D12 red on the one accepted field only |
| 3 | note — the `owned` gate has no cell | **resolved** | author cell 10 = D11 (`:1184`); author falsification 3; my round-1 `falsification-2-owned-gate-dropped-d11.log` |
| 4 | note — "the shipped condition, exactly" is true by reachability | **resolved** | note §D.1 "The condition is exact by REACHABILITY, not by spelling"; §D.9 answer 2 |
| 5 | note — the G2.9 sqlite specimen no longer covers the rolled-back form | **resolved** | note §D.3 addition; verified: `g4/unit02/malformed-result-cuts.test.ts` cell 1 asserts `SELECT id … === []`, and it is registered (in `g4-unit02-author`) |
| 6 | note — the guide's stale "G2.9 atomic-batch pin" witness, and the 102-char line | **resolved in the guide; see note N1** | `AGENTS.md:425-429` now names cell 1b and row 6 and says the specimen publishes none; the only line over 84 chars left is the pre-existing 133-char `:687` (`awk` over the file) |
| 7 | note — the requested harness patch needed a path fixup | **moot** | the integrator applied it; `transport-plans.ts` is `5232c398…` and `g3-generated-transport-smoke` is **1 passed, gate verified** |
| 8 | note — counts to register | **updated** | `uncertain-outcome-meta.test.ts` = **10** cells (was 7), `lone-statement-transport.test.ts` = **7**; both green, both still unregistered, manifest untouched; `g29-result-progress` 2, PGlite twin 1 |

Blocker **D-7.1** is untouched and still Arnaud's, as §R2.9 says; author cell 7
still pins it and my P1 still reproduces it independently.

---

## Verified by reading (the two claims the brief asked me to confirm)

1. **The decode failure is translated exactly once on the plain path.**
   `dispatchSetMutations` builds `decoded = { failure: this.failure(error,
   "result") }` (`:1210`) and then uses that one value twice — as
   `stateWriteOutcome`'s primary (`:1212-1216`) and as the throw (`:1217`).
   `failure()` is idempotent here in the strong sense: the value it returns is
   no longer an `InvalidScalarResult`, so `run()`'s catch (`:529-540`) cannot
   translate it a second time, and for a `lone` statement the second disjunct of
   that catch (`usesBatch && (continuations.length || committedSegments > 0)`)
   is structurally false — `lone` requires `continuations.length === 0`, and
   `committedSegments` is incremented only by `acknowledged()`, i.e. only by a
   member-bearing `submit`, after which either a continuation was pushed
   (`:1781`) or statements stay queued (`pending.length > 0`), both of which
   make a later `setMutations` non-`lone`. So on this path the translation site
   is reached once and the throw is what the caller receives.
2. **The batch arm holds across acknowledgement, with no second mechanism.**
   `acknowledged()` (`:714-726`) captures; `submit()`'s catch releases first
   (`:745-750`) with the batch's own failure primary and skips the uncertain
   arm below it — which is safe because `acknowledged()` has already
   incremented `committedSegments`, making the `mayHaveCommittedSegment` and
   `rejectedInsert` arms unreachable anyway; `settleSubmitted` (`:847-861`)
   releases at the decode. One composition (`retainOutcomeFailure`), one hold,
   one marking helper (`answered`, four call sites: `:748`, `:857`, `:860`, and
   the pre-existing `published` premise at `:905`).
3. **The `answeredFailures` generalisation cannot open a retry.** The only
   consumers of committed progress as a gate are
   `write-engine/routing.ts:197` and `pattern/execute/retry.ts:27`, both of
   which require `isRetryableRace(error)` first; a `CacheConfigurationError` and
   an `AggregateError` are neither, and the composition was never a
   `VibORMError` in either round. Marking changes the failure's identity path,
   not the retry decision.
4. **The frozen fast-path counts did not move**: `physical-envelope` 10,
   `packaged-array` 5, `prepared-operation` 5, with the `g4-unit02-author` gate
   verifying each registered file's exact cell count (110 passed over 17 files).
5. **Patches round-trip.** Both sha256s match §R2.7 (`1560808b…`, `f8001d1e…`).
   Reverse-applying both onto a copy of the 19 touched files reproduces the
   recorded closure base exactly —
   `query.ts 5143b7b36f6711dc0605ee534b8ef28d351f278ebebbed2354e1955c22352715`,
   `operation-context.ts 8b25f6fea73cfe2a1a50ac2558aeb01c3b2bd7563217e5266a89c22ee10451b6`
   — and forward-applying reconstructs **19/19 files byte-identically**
   ([`patch-roundtrip-and-cost.log`](d7-review-followup-receipts/patch-roundtrip-and-cost.log)).
6. **Cost reproduces exactly**, recomputed with the census's own
   `countTokenLines` walk (JSDoc and EOF excluded): `operation-context.ts`
   84,011 bytes / 2,228 physical / 1,892 token-lines; core (12 files) 377,661 /
   10,609 / 9,518; whole `src/query-engine/raptor3` (15 files) 414,566 / 11,645
   / 10,400 — every figure of §R2.7, and the +4,958 / +101 / +43 increment
   follows from the round-1 figures I verified last round.
7. **Evidence integrity.** The three author falsification receipts show exactly
   the claimed single red cell each (8, 9, 10) with nine green; the intermediate
   [`probe-review-after-production.log`](regression/receipts/d7-round2/probe-review-after-production.log)
   is kept as it fell and is labelled "not a result" in §R2.6 — and it does show
   what §R2.2 item 5 says: before `answeredFailures`, the candidate published a
   bare `QueryEngineError` with `phase: "member"` progress and no `errors`,
   i.e. `attachRecordSeriesProgress` had replaced the composition. `biome check`
   (never `--write`) on the two edited files reports only the pre-existing
   categories (`organizeImports`, 4 × `noParameterProperties`, the file-wide
   trailing-comma `format` divergence; 4 × `noMisplacedAssertion` on the test
   helpers), reproducing §R2.6.

---

## Notes (new this round)

### N1 — note (statement) — the stale "G2.9 atomic-batch pin" sentence survives in the source comment

`src/query-engine/raptor3/shared/operation-context.ts:415-418` still says a
committed set window "keeps publishing its progress, which is the G2.9
atomic-batch pin (`tests/raptor3/post-prep/g29-result-progress.test.ts`)" — the
sentence round-1 note 6 flagged, corrected in `AGENTS.md` but not in its twin in
`failure()`'s own comment. After D-7 that specimen publishes no progress; the
witnesses are `malformed-result-cuts.test.ts` cell 1b and
`lone-statement-transport.test.ts` row 6, exactly as the guide now says. The
line is part of this unit's own uncommitted diff (`git diff` shows it as an
added line), so it is the unit's sentence to keep true. Behaviour unaffected.
**Resolution:** the guide's wording, transplanted.

### N2 — note (reasoned, unmeasured) — the composition is marked at two of its four escape routes

`answered()` marks the composition where `settleSubmitted` (`:857`, `:860`) and
`submit`'s catch (`:748`) release it, which is what stops `run()`'s catch from
calling `failure()` on it and letting `attachRecordSeriesProgress` replace it
with a fresh `QueryEngineError` (§R2.2 item 5, measured by the intermediate
receipt). The two `stateWriteOutcome` compositions — `:1244`, reached from the
plain path (`:1196`, `:1213`) and from `submit`'s `mayBeVisible` arm (`:783`) —
are **not** marked. For the plain path that is provably harmless (verified 1:
`lone` forces both `continuations.length === 0` and `committedSegments === 0`).
For `submit`'s `mayBeVisible` arm it is not: that arm can run with
`continuations.length > 0` (a generated-output nested create's second submit),
and then `run()`'s catch re-enters `failure()` on the AggregateError and
`attachRecordSeriesProgress` wraps it — the same loss the round repaired
elsewhere. I could not measure it: reaching it needs a schema with an
auto-increment **parent** id and a nested child create (so the record route
takes its RETURNING branch and pushes a continuation), which neither probe
file's fixture has, and both engines have wrapping behaviour of their own in
record-series contexts (`OperationExecutor.ts:1398`, `:1407` call the same
`attachRecordSeriesProgress`), so the divergence direction is unknown. It is
structurally pre-existing — the arm is the seam round's, unchanged here — and
round 2 strictly reduces the number of unmarked escape routes.
**Resolution:** mark the composition at `:1244` as well (`throw
this.answered(this.retainOutcomeFailure(primary, outcomeFailure))`, one word, no
new mechanism), or record the bound with the shape named, as §R2.9 does for the
ordered-commit arm.

### N3 — note (cell hygiene) — cell 9's exclusion is two-sided

`uncertain-outcome-meta.test.ts:658-660` compares `withoutProgress(candidate)`
against `withoutProgress(shipped)`, so the exclusion also hides the shipped
side; the second assertion pins only the **candidate's** value. If the shipped
engine ever began publishing progress for a committed set window — which is
precisely the open statement of `regression-review.md` finding 3 — the cell
would stay green while the divergence it documents had disappeared. One more
line (`assert.equal((shipped.failure as …).cause?.meta?.recordSeriesProgress,
undefined)`) makes the cell say the whole of what it means. My D12, which
excludes nothing, is the other half of this and stays red by that field alone.

---

## Suites re-run (bounded runner, serial, one mode per invocation, after the last edit)

| Mode / file | Result | Wall / peak RSS | Receipt |
| --- | --- | --- | --- |
| review probes (31 cells, unregistered) | **30 passed / 1 failed** — D9 repaired; D12 red on `recordSeriesProgress` only | 3.54 s / 566.7 MiB | [`probes-round2.log`](d7-review-followup-receipts/probes-round2.log) |
| author cells (2 unregistered files) | **17 passed (17)** — 10 + 7 | 5.12 s / 576.4 MiB | [`author-cells.log`](d7-review-followup-receipts/author-cells.log) |
| `g2-generated` | **52 passed (52)** — D-7 stays closed | 5.83 s / 766.9 MiB | [`g2-generated.log`](d7-review-followup-receipts/g2-generated.log) |
| `g29-result-progress` | 2 passed (2), gate verified | 4.47 s / 521.4 MiB | [`g29-result-progress.log`](d7-review-followup-receipts/g29-result-progress.log) |
| G2.9 PGlite twin | 1 passed (1); runner flagged 1,588.7 MiB over the 1,536 MiB ordinary ceiling, as in both previous rounds (PGlite, environment, not a candidate failure) | 4.87 s / 1,588.7 MiB | [`g29-pglite.log`](d7-review-followup-receipts/g29-pglite.log) |
| `g4-unit02-author` | 110 passed (110), 17 files, gate verified | 6.71 s / 760.3 MiB | [`g4-unit02-author.log`](d7-review-followup-receipts/g4-unit02-author.log) |
| `g4-route-cache` | 7 passed (7) | 4.78 s / 537.3 MiB | [`g4-route-cache.log`](d7-review-followup-receipts/g4-route-cache.log) |
| `g4-route-transactions` | 13 passed (13) | 5.43 s / 551.6 MiB | [`g4-route-transactions.log`](d7-review-followup-receipts/g4-route-transactions.log) |
| `g3-transaction-array` | 4 passed (4) | 4.91 s / 512.2 MiB | [`g3-transaction-array.log`](d7-review-followup-receipts/g3-transaction-array.log) |
| `g3-suppression-retry` | 2 passed (2) | 4.69 s / 543.6 MiB | [`g3-suppression-retry.log`](d7-review-followup-receipts/g3-suppression-retry.log) |
| `g3-bulk-series` | 6 passed (6) | 4.97 s / 527.8 MiB | [`g3-bulk-series.log`](d7-review-followup-receipts/g3-bulk-series.log) |
| `g2-contracts` | 216 passed (216), 16 files | 8.62 s / 770.7 MiB | [`g2-contracts.log`](d7-review-followup-receipts/g2-contracts.log) |
| `g1-transport` | 44 passed (44) | 5.88 s / 675.1 MiB | [`g1-transport.log`](d7-review-followup-receipts/g1-transport.log) |
| `g2-transport` | 16 passed (16) | 4.64 s / 760.1 MiB | [`g2-transport.log`](d7-review-followup-receipts/g2-transport.log) |
| `g3-generated-transport-smoke` | **1 passed (1)**, gate verified — green with the integrator's harness diff | 4.25 s / 531.4 MiB | [`g3-generated-transport-smoke.log`](d7-review-followup-receipts/g3-generated-transport-smoke.log) |
| `g2-mysql-contracts` (port 65515) | **13 passed (13)**, 4 files — RF-12 holds on the live container | 5.53 s / 689.0 MiB | [`g2-mysql-contracts.log`](d7-review-followup-receipts/g2-mysql-contracts.log) |
| `g2-mysql-baseline` (port 65515) | 13 passed (13), 4 files | 4.92 s / 660.6 MiB | [`g2-mysql-baseline.log`](d7-review-followup-receipts/g2-mysql-baseline.log) |
| `g2-pg-contracts` (port 65504) | 18 passed (18), 6 files | 5.57 s / 697.8 MiB | [`g2-pg-contracts.log`](d7-review-followup-receipts/g2-pg-contracts.log) |
| whole-estate typecheck (with the probes) | only the two permitted `pattern/pack.ts` TS2345 (`:1443`, `:2633`) | 7.43 s / 5,786.9 MiB | [`typecheck.log`](d7-review-followup-receipts/typecheck.log) |

Provider ports confirmed this round: `docker port viborm-raptor3-g3-mysql-20260914
3306` → `127.0.0.1:65515`, `docker port viborm-raptor3-g3-pg-20260914 5432` →
`127.0.0.1:65504` — the author's values.

## Falsifications (mine, independent)

Each mutation was applied to the working file and restored from a scratchpad
copy (never `git checkout`); `operation-context.ts` is
`aec115a3a817572c6edd0dab9d6400ed953eee28d44298bd73f73ad513fee1b1` before and
after both, and the recaptured production identity is unchanged.

| Mutation | Result | Receipt |
| --- | --- | --- |
| A — `decoded = { failure: error }` (drop the plain-path translation) | **cell 8 red**, candidate primary `TypeError: "Invalid provider integer"` against shipped `QueryEngineError` V9001; cells 1-7, 9, 10 and all 7 transport rows green | [`falsification-A-plain-translation-dropped.log`](d7-review-followup-receipts/falsification-A-plain-translation-dropped.log) |
| B — `await this.stateWriteOutcome(this.writeOutcome?.committedSegment)` in `acknowledged()` (drop the hold) | **cell 9 red**, candidate publishes `CacheConfigurationError` alone (my round-1 D12 measurement); cells 1-8, 10 and all 7 transport rows green | [`falsification-B-acknowledged-hold-dropped.log`](d7-review-followup-receipts/falsification-B-acknowledged-hold-dropped.log) |

The third gate (`owned`) I falsified in round 1
([`falsification-2-owned-gate-dropped-d11.log`](d7-review-receipts/falsification-2-owned-gate-dropped-d11.log));
the author's `falsification-3-owned-gate-dropped.log` reproduces it as cell 10.

## Unverified author claims

1. **Discharged by this review:** the plain path's single translation site
   (verified 1 + D9 + falsification A); the hold and its release order against
   shipped `runAtomicBatch` (verified 2 + cell 9 + falsification B); that D12's
   residual red is exactly one field (measured, full diff in
   [`probes-round2.log`](d7-review-followup-receipts/probes-round2.log)); the
   `malformed-result-cuts` cell 1 claim of §D.3; the guide's line-length claim;
   the patch round-trip; the cost; the identity; the manifest and route
   untouched.
2. **Still unverified, correctly labelled by §R2.9:** `submit()`'s catch
   releasing the hold, reachable only on a `supportsOrderedCommittedSegments`
   driver, which the credential-free estate has none of. I can sharpen it: on
   the non-ordered transport a hold and a failing batch cannot co-occur at all
   (`acknowledged()` runs only after `_executeBatch` resolves), so that arm is
   unreachable here by construction — and with it the consequence that the arm
   skips the rest of `submit`'s catch, including the
   `NestedWriteAssertionError` attribution, which would otherwise have refined
   the published failure. Both belong to the same unmeasured driver.
3. **Still unverified, correctly labelled:** a held failure released at the
   three submit-decode sites other than `setMutations`' batch arm; every
   generated seed beyond `g2-generated`'s 52; the phase notifications on a
   SUCCESSFUL own-region write; the uncertain-outcome class test's narrower
   sentence (the followup review's finding 4).
4. **Newly labelled by this review:** N2 — the two `stateWriteOutcome`
   compositions are unmarked, which is harmless on the plain path (proved) and
   unmeasured on `submit`'s `mayBeVisible` arm; and N3 — cell 9's exclusion
   hides the shipped side as well as the candidate's.
