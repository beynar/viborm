# Independent review (follow-up) — G4-02 "cache-invalidation signals come from the context, not from published meta"

Reviewer: independent (did not author the unit; same reviewer as
[`g4/regression-review.md`](regression-review.md)). Brief:
[`g4/briefs/invalidation-seam.md`](briefs/invalidation-seam.md) with
[`briefs/common.md`](briefs/common.md) and [`briefs/review.md`](briefs/review.md).
Author note: [`g4/regression/note.md`](regression/note.md) "Seam round"
(§S.1–S.7). Source read and run in the main tree `/Users/arnaud/code/viborm` at
`HEAD 0cc61e61` with the unit's uncommitted diff in place.

Reviewed identity — the candidate production fingerprint measured by
`captureRaptor3Identity` is **`467baa794b561f558254dae9bbfa138e12ab7116643cedb70c302a8f07597da9`**,
byte-for-byte the author's recorded
[`receipts/seam/identity-after.json`](regression/receipts/seam/identity-after.json),
so what I ran is what the author recorded. Every falsification below was
restored from a scratchpad copy, never with `git checkout`, and the fingerprint
above is the value AFTER the restore. The harness fingerprint differs from the
author's (`5fd763bc…` against `9768511a…`) for one reason, verified by mtime:
the only files under `tests/raptor3`, `scripts` or `benchmarks` changed since the
author's capture are this review's own two probe files.

| File | sha256 |
| --- | --- |
| `src/query-engine/raptor3/shared/operation-context.ts` | `46060d8cb2838d3ce6c83d76ae0be91f37e811718c42be417a7fc9946c6736e0` |
| `src/query-engine/raptor3/route/client-route.ts` | `976bbf85f9bf8248813a56d9b101b9c5ffb03d772877b6efcbb2dd1b09527af1` |
| `src/query-engine/raptor3/AGENTS.md` | `ce991d0bfdb0ed2d993ca181be5a66b1227a3fe1ccd645a1c1533c2c2888cc4c` |
| `tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` | `9aa470f751cc9ef1ae8ffd83b995c58dd6ef164491fa025d596e85b5316ee68c` |
| `tests/raptor3/g4/unit02/statement-index-blocker.red.test.ts` | `b002634f8b7f1135127320e9e979c754b6f44c5f6a7ad66c4cdbc86751948533` |

Receipts: [`g4/regression-review-followup-receipts/`](regression-review-followup-receipts/).
Probes (19 cells, all green, whole-estate typecheck clean, not in any registered
mode):

- `tests/raptor3/g4/review/regression/uncertain-outcome-neighbours.review.test.ts`
  (`0c9254eb…`, 11 cells — round 1's probes, with **P7 inverted** to the
  repaired expectation and its docblock saying so);
- `tests/raptor3/g4/review/regression/seam-followup.review.test.ts`
  (`3d279779…`, 8 new cells S1–S8).

Both run with
`node scripts/run-vitest-safe.mjs run --config docs/architecture/raptor3-evidence/g4/regression-review-followup-receipts/vitest.review-regression.config.ts`.

Three receipts are kept as they fell and are not results:
`probes-pass1.log` (S6 red before I pinned the measured divergence it found),
`probes-pass2.log`/`probes-pass3.log` (intermediate passes as probes were added),
and `falsification-standalone-rail-dropped.log` (a misfired invocation — the
review config's `include` does not cover the author's cell file; superseded by
the two `…-author-cells.log` / `…-probes.log` receipts named in item 6).

---

## Outcome: **ACCEPT**

Round 1's blocking finding is repaired at its root, not patched: the two
cache-invalidation facts are now stated by the only two sites that learn them,
the route reads nothing back out of published error meta, and there is no second
signal path. I measured the repaired number the brief asks for (shipped 1 /
candidate 1 on the uncertain root create), falsified the seam a third way the
author did not, and found parity on every neighbour I could reach — a rolled-back
write, a transaction-capable driver's success and failure, a multi-segment
batch, a `$transaction(callback)` write, and a guard-aborted atomic batch.
Round 1's must-fix (finding 3) is discharged in all three places, and the cells
are now one green falsifiable pin plus one clearly labelled, unregistered red
reproducer.

Nothing I found changes a public answer, committed state or invalidation
behaviour, so nothing below is blocking or must-fix. The one measured divergence
(finding 2) is a pre-existing property of the candidate's failure composition
that this round makes reachable on one more path; it is a note with a named
resolution, and it deserves a recorded decision line rather than an "unverified"
bullet.

---

## Verified (no finding)

1. **One fact, one owner — the route consumes no record-series concept.**
   `publishFailedWriteOutcome` is gone, and so are the route's
   `getTrustedRecordSeriesProgress` / `isVibORMError` imports. A grep of
   `getTrustedRecordSeriesProgress|committedWriteSegment|writeMayBeVisible|isVibORMError`
   over `src/query-engine/raptor3` returns only: the two fields on
   `RoutedOperationExecution` (`client-route.ts:65-66`), the two wrappers inside
   `routeWriteOutcome` (`:118-130`), the one success-arm call (`:203`), and two
   comment lines in `operation-context.ts`. The publishing sites are
   `shared/operation-context.ts:695` (inside `acknowledged()`, the only
   `committedSegments++` site, `:693`) and `:739` (the only
   `mayHaveCommittedSegment = true` site, `:734`).
2. **The shipped ordering holds.** `committedSegment()` runs immediately after
   the increment and after the members are added to `committedMembers`;
   `mayBeVisible()` runs immediately after the flag is set and **before** the
   error is attributed, re-read for fresh-state diagnostics, wrapped by
   `failure()` or rethrown. Both mirror `OperationExecutor.ts:974-990` and
   `:1048-1058`, which I read and confirmed line-for-line (including that
   shipped's `dispatched` flag is already set when the harness's before-dispatch
   fault fires — P7 measures shipped at 1).
3. **The route's remaining publication is the complement, not a second path.**
   `if (execution.isWrite && !outcome?.published)` is exactly the shipped rail's
   `publishedDirectUnits === 0` (`src/extensions/query.ts:281-294`), because
   shipped's `publish()` increments that counter for **both** certainties — so
   `outcome.published` being set by either seam call is the same sentence.
   Author cell 4 fails at candidate 2 if the gate is removed (author receipt),
   and my S2/S4/S5 measure the complement itself.
4. **A real record series is unchanged.** Author cell 2 green; `g29-result-progress`
   2/2 (the G2.9 atomic-batch pin, `phase:"result"`, `committedSegments:1`,
   `committedWriteMembers:1`); probe **P8** still green, i.e. the committed set
   window still publishes exactly as before; `g2-contracts` 216/216;
   `g3-bulk-series` 6/6; `g3-suppression-retry` 2/2; `g2-transport` 16/16.
5. **The repaired number, measured.** Probe **P7**, rewritten to the repaired
   expectation: on a batch-only driver with the harness before-dispatch fault, a
   root `create` under `cache: { autoInvalidate: true }` now yields **shipped 1 /
   candidate 1** (round 1: shipped 1 / candidate 0). Author cell 3 measures the
   same thing independently.
6. **Third, independent falsification.** The author falsified the two calls; I
   falsified the route's *carriage* of the rail instead — replacing
   `writeOutcome ? { kind: "standalone", writeOutcome } : undefined` at
   `client-route.ts:369-373` with `undefined` (the pre-round expression).
   Result: author cell **3 red at candidate 0 against shipped 1**
   ([`falsification-standalone-rail-dropped-author-cells.log`](regression-review-followup-receipts/falsification-standalone-rail-dropped-author-cells.log)),
   probes **P7 and S6 red**
   ([`falsification-standalone-rail-dropped-probes.log`](regression-review-followup-receipts/falsification-standalone-rail-dropped-probes.log)),
   cells 1, 2 and 4 still green — cell 4 because the route's success arm covers
   the committed half by itself. The file was restored from a scratchpad copy
   and is byte-identical (`976bbf85…`).
7. **The narrowed sentence says what the code enforces, in all three places.**
   `shared/operation-context.ts:383-397` (the `failure()` comment), note §2's
   block quote plus its explicit correction paragraph, and
   `raptor3/AGENTS.md:406-419` all now say: an UNCERTAIN outcome alone is not a
   record series, and a window that DID commit still reports (the G2.9 pin).
   AGENTS.md also states where the internal fact goes
   (`ExecutionBinding.writeOutcome`) and "A root operation is `standalone`"
   (`:457-467`). Probe P8 is the falsifier for the second half of the sentence
   and is green.
8. **The cells are split as the brief asks.** `uncertain-outcome-meta.test.ts` is
   4 green cells (re-run here: 4/4), cell 1 falsifiable by colour;
   `statement-index-blocker.red.test.ts` is 1 cell, red on purpose, first line of
   its docblock says so, diff exactly `+ statementIndex: 0`
   ([`blocker-d7-reproducer.log`](regression-review-followup-receipts/blocker-d7-reproducer.log)).
   Neither file appears in `scripts/raptor3-manifest.mjs`, so neither is in a
   registered mode; `g4-unit02-author` is unchanged at 17 files / 110 tests.
9. **Frozen fast-path counts did not move**: `physical-envelope` 10,
   `packaged-array` 5, `prepared-operation` 5, inside `g4-unit02-author` 110/110.
10. **Estate discipline.** `HEAD` is still `0cc61e61`, nothing is staged, and the
    only files under `src/` modified in the round's window are the three the note
    names. `write-engine/OperationExecutor.ts` (Aug 30) and `extensions/query.ts`
    (Sep 2) are untouched; `pending-operation.ts` (18:02) and `client.ts` (10:32)
    predate the round. No manifest edit.
11. **Patches reproduce.** All three sha256s match the note, and each one
    round-trips ([`patch-verification.log`](regression-review-followup-receipts/patch-verification.log)):
    `unit03/production.patch` applies onto a clean `0cc61e61` and reconstructs all
    4 files byte-identically (including the route with the seam);
    `unit02/production-closure.patch` reverse-applies to a base whose identities
    are exactly the recorded `query.ts 5143b7b3…` / `operation-context.ts
    8b25f6fe…` and forward-applies to 7/7 byte-identical files;
    `unit02/tests-closure.patch` round-trips 10/10.
12. **Cost reproduces exactly.** `operation-context.ts` 2,022 physical / 73,982
    bytes; `client-route.ts` 400 / 16,173; core (12 files, `commands/` +
    `shared/`) 10,403 / 367,632; whole `src/query-engine/raptor3` (15 files)
    11,439 / 404,537 — every figure the note states
    ([`cost.log`](regression-review-followup-receipts/cost.log)). The +63
    physical / +3,511 byte increment follows from the note's own pre-round
    figures, which I could not re-measure independently (the pre-seam route bytes
    are not preserved anywhere) — see unverified claims.
13. **§7 gate, against this diff.** No second public-syntax walker, per-verb
    codec, duplicated result-shape preparation, recreated lifecycle, projection
    rebuilt for a decoder, JavaScript arithmetic beside SQL, policy-boolean bag,
    per-feature interpreter, fixture-named flag, legacy import, fallback or
    public-contract change. The new `standalone` member removes a decision
    (`undefined` meant it) rather than adding one, `this.driver` now reads the
    borrowed member by name, and `routeWriteOutcome` allocates nothing when the
    client supplied no notifications (`client-route.ts:119`).

---

## Findings

### 1. note (carried, untouched, correctly recorded) — D-7 `statementIndex: 0`

* **Where:** `src/drivers/driver-diagnostics.ts:35-36` →
  `src/drivers/driver-transaction-base.ts:854-872`, reached because the candidate
  submits a lone set-oriented statement through `_executeBatch`.
* **Reproduction:** `node scripts/run-raptor3.mjs g2-generated` → **1 failed /
  51 passed (52)**; I confirmed the single failure is seed 2122
  `sqlite-atomic-batch` and that the **only** diff is `+ "statementIndex": 0`
  ([`g2-generated.log`](regression-review-followup-receipts/g2-generated.log)).
  The `sqlite-interactive` profile is entirely green.
* **Status:** Arnaud's decision, not attempted, as the brief instructs. §4 now
  records the full reach the review established (the folded root `create` AND
  every relation-free bulk verb), and S.7 repeats it. Nothing to resolve in this
  unit.

### 2. note (measured; pre-existing family, one more path now reachable) — when a cache-invalidation listener throws, the candidate loses the operation's own failure

* **Where:** `shared/operation-context.ts:739`
  (`await this.writeOutcome?.mayBeVisible?.()`) and `:695`
  (`await this.writeOutcome?.committedSegment?.()`), against
  `write-engine/OperationExecutor.ts:983-990` and `:1057-1069`, which catch the
  listener's failure and keep the operation's own error primary
  (`attachProgress(new AggregateError([error, invalidationError], …))`), and
  `extensions/query.ts:859-871` (`retainWriteOutcomeFailure`).
* **Probe:** `tests/raptor3/g4/review/regression/seam-followup.review.test.ts`
  cell **S6** (and **S7** for the control), receipt
  [`probes-final.log`](regression-review-followup-receipts/probes-final.log).
* **Measured**, uncertain root create under `autoInvalidate` with a cache driver
  whose `clear` throws:

  | route | invalidation attempts | published failure |
  | --- | --- | --- |
  | shipped | 1 | `AggregateError` "Query execution and write-outcome publication both failed." (the `QueryError` is its cause) |
  | candidate | 1 | `CacheConfigurationError` — the query failure is gone |

  The **seam itself is at parity** (one attempt each); the divergence is in
  failure composition. **S7** shows both engines answer identically when the
  operation itself succeeded and only the listener failed, so the divergence is
  confined to "the operation failed AND the listener failed".
* **Why only a note:** the candidate never composed the two failures — before
  this round the same replacement happened in the route's own `catch` (and, for
  this exact shape, the listener was not called at all, which was round 1's
  blocking finding). This round strictly improves the primary behaviour and
  merely makes the older gap reachable again on this path. No answer of a
  succeeding operation changes.
* **Also unmeasured (same site):** on a driver with
  `supportsOrderedCommittedSegments` — `src/drivers/d1/index.ts:158` is the only
  one — `acknowledged()` runs *inside* the driver's own acknowledgement callback,
  so a throwing listener now propagates into the driver mid-batch, where shipped
  defers it (`invalidationFailed`, `OperationExecutor.ts:983-990`). Not
  reachable in the credential-free estate; I could not measure it.
* **Resolution:** either retain the primary failure at the two seam call sites
  (wrap the notification in its own try/catch and let `failure()`/the rethrow
  keep the operation's error, which is what shipped does), or record it as a
  named candidate divergence for the freeze so the decision is taken explicitly.
  Today it lives only as an "unverified" bullet in §S.7; it is now measured.

### 3. note (statement accuracy) — "before anything else in that catch" over-states by one block

* **Where:** note §S.2 item 5 and the repairs list ("immediately after
  `mayHaveCommittedSegment = true` … and before anything else in that catch").
  The pre-existing `UniqueConstraintError` retryable-attribution block
  (`shared/operation-context.ts:711-726`) runs earlier in the same `catch`.
* **Why it does not matter:** that block only records an attempt-local fact
  (`attempt.rejectedInsert`) and publishes nothing, so the load-bearing claim —
  invalidate **before the failure is published** — holds exactly.
* **Resolution:** word it as "immediately after the flag is set, before the
  failure is attributed or published".

### 4. note — the candidate's uncertain-outcome condition is not the shipped sentence, and only one of its shapes is measured

* **Where:** `shared/operation-context.ts:728-740` excludes only
  `error instanceof UniqueConstraintError`, where shipped excludes every class it
  can prove rolled back — `UniqueConstraintError`, `SkippedRecordSeriesMember`
  and `isRetryableRace` (`OperationExecutor.ts:1029-1053`,
  `write-engine/race-retry.ts:55-66`). A raceable failure could therefore make the
  candidate publish `mayBeVisible` where shipped publishes nothing.
* **Probe:** cell **S8** takes the reachable shape — a guard-aborted atomic batch
  (nested `connect` to a missing parent) — and measures **the same invalidation
  count and the same published failure on both engines**, so no divergence is
  demonstrated. The condition predates this round (the brief keeps "nothing
  changes *when* `mayHaveCommittedSegment` is set"), and this round only changes
  who hears about it.
* **Resolution:** none required for this unit; worth one line in §S.7's
  unverified list, since the two conditions are not the same sentence and only
  one shape of the difference has been measured.

### 5. note (integration, already recorded by the author) — the unregistered red file and the stale route patch

* `tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` (**4** cells) is not in
  `scripts/raptor3-manifest.mjs`; registering it is the integrator's step, as the
  brief instructs.
* `EXTENDED_LOCAL_TESTS` is a directory walk minus registered modes and
  `tests/raptor3/g4/review/`
  (`scripts/credential-free-test-manifest.mjs:230-263` — verified), so
  `statement-index-blocker.red.test.ts` is adopted by the `extended-local` lane
  and keeps it red exactly as `uncertain-outcome-meta.test.ts` cell 1 did before
  this round. The author's requested exclusion is accurate and correctly left
  unmade (another stream's file).
* `g4/unit03/production-followup.patch` is now stale for `client-route.ts`; the
  author's note says so and preserves the superseded r1 bytes at
  `regression/receipts/seam/unit03-production-r1-superseded.patch` rather than
  destroying them. Integrator decision.

---

## Suites re-run (bounded runner, serial, one mode per invocation, after the last edit)

| Mode / file | Result | Receipt |
| --- | --- | --- |
| `g4-route-cache` | 7 passed (7) | [`g4-route-cache.log`](regression-review-followup-receipts/g4-route-cache.log) |
| `g4-route-transactions` | 13 passed (13) | [`g4-route-transactions.log`](regression-review-followup-receipts/g4-route-transactions.log) |
| `g4-route-lifecycle` | 8 passed (8) | [`g4-route-lifecycle.log`](regression-review-followup-receipts/g4-route-lifecycle.log) |
| `g4-lifecycle-admission` | 4 passed (4) | [`g4-lifecycle-admission.log`](regression-review-followup-receipts/g4-lifecycle-admission.log) |
| `g4-unit02-author` | 110 passed (110), 17 files | [`g4-unit02-author.log`](regression-review-followup-receipts/g4-unit02-author.log) |
| `g29-result-progress` | 2 passed (2) | [`g29-result-progress.log`](regression-review-followup-receipts/g29-result-progress.log) |
| `g3-transaction-array` | 4 passed (4) | [`g3-transaction-array.log`](regression-review-followup-receipts/g3-transaction-array.log) |
| `g2-contracts` | 216 passed (216), 16 files | [`g2-contracts.log`](regression-review-followup-receipts/g2-contracts.log) |
| `g2-generated` | **1 failed / 51 passed (52)** — D-7 only, seed 2122 `sqlite-atomic-batch`, diff exactly `+ statementIndex: 0` | [`g2-generated.log`](regression-review-followup-receipts/g2-generated.log) |
| `g2-mysql-contracts` (port 65515) | 13 passed (13), 4 files | [`g2-mysql-contracts.log`](regression-review-followup-receipts/g2-mysql-contracts.log) |
| `g2-pg-contracts` (port 65504) | 18 passed (18), 6 files | [`g2-pg-contracts.log`](regression-review-followup-receipts/g2-pg-contracts.log) |
| `g3-suppression-retry` (extra) | 2 passed (2) | [`g3-suppression-retry.log`](regression-review-followup-receipts/g3-suppression-retry.log) |
| `g3-bulk-series` (extra) | 6 passed (6) | [`g3-bulk-series.log`](regression-review-followup-receipts/g3-bulk-series.log) |
| `g2-transport` (extra) | 16 passed (16) | [`g2-transport.log`](regression-review-followup-receipts/g2-transport.log) |
| author cells (unregistered) | 4 passed (4) | [`author-cells.log`](regression-review-followup-receipts/author-cells.log) |
| D-7 reproducer (unregistered, red on purpose) | 1 failed (1) | [`blocker-d7-reproducer.log`](regression-review-followup-receipts/blocker-d7-reproducer.log) |
| review probes (unregistered, 19 cells) | 19 passed (19) | [`probes-final.log`](regression-review-followup-receipts/probes-final.log) |
| whole-estate typecheck (with probes) | only the two permitted `pattern/pack.ts` TS2345 (`:1443`, `:2633`) | [`typecheck.log`](regression-review-followup-receipts/typecheck.log) |

Provider ports confirmed this round with `docker port viborm-raptor3-g3-mysql-20260914 3306`
→ `127.0.0.1:65515` and `docker port viborm-raptor3-g3-pg-20260914 5432` →
`127.0.0.1:65504`, matching the author's receipts.

**Count to register if the probes are kept:** the two files under
`tests/raptor3/g4/review/regression/` hold **19** cells (11 + 8), all green on
this tree; 3 of them (P7, S6, and author cell 3) go red when the seam is
disabled. No manifest was edited by this review.

## Unverified author claims

1. The round's **increment** figures (+63 physical / +3,511 bytes / +21
   token-lines) rest on pre-round sizes for `client-route.ts` (378 / 14,880) that
   no preserved artefact carries; the post-round figures and every total
   reproduce exactly.
2. "No unlisted suite depends on the route's old meta-derived publication" —
   still an argument from the call graph plus fourteen modes (I added three more;
   the G4 seed campaigns remain unrun, as unit work forbids them).
3. **Multi-segment publication counts** are no longer unverified: my **S4**
   measures a multi-segment write on the batch transport and finds the same count
   on both engines. **S5** does the same for `$transaction(callback)`.
4. The listener-throws behaviour is no longer unverified either — see finding 2,
   which measures it and names the one part still unmeasured (an ordered-commit
   D1 driver).
