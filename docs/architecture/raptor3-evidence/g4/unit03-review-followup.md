# G4-03 "client route / types" — independent review, follow-up after REVISE

Reviewer: the same independent reviewer who returned **REVISE** on
[`unit03-review.md`](unit03-review.md); did not author the unit or its repair.
Reviewed source: main tree `/Users/arnaud/code/viborm`, branch `pattern-engine`,
base commit `0cc61e61`, working tree already containing revision **r3**
(nothing applied, nothing repaired by this review).
Date 2026-09-15.

Inputs read: `g4/briefs/common.md`, `g4/briefs/review.md`, my own
`unit03-review.md`, the author's r3 repair summary, `g4/unit03/note.md`
(r1 + r2 + the new §R), `g4/unit03/handoff.md` (r2), `production.patch`,
`tests.patch`, `receipts/unit-cost.json`, every receipt under
`receipts/repair/`, and the current source of
`src/query-engine/raptor3/route/client-route.ts`,
`src/query-engine/pending-operation.ts`,
`src/query-engine/write-engine/OperationExecutor.ts` and `src/drivers/driver.ts`.

Follow-up receipts: `docs/architecture/raptor3-evidence/g4/unit03-review-receipts/followup/`.
New probe (kept): `tests/raptor3/g4/review/unit03/route-region-followup.review.test.ts`.

---

## Outcome: **REVISE** (one new must-fix; all eight round-1 findings are resolved)

Everything I asked for in round 1 is done, and done honestly. I re-ran the unit,
the reviewer probes, the shipped owners that consume the one deleted branch, the
whole-estate typecheck and the cost census, and I **independently falsified both
new pins** — one of them through a different mechanism than the author used. The
single production change (deleting the unreachable `parseResult` guard) is
confined to a route-only branch, and the charged cost drop it claims is exact.

I am returning REVISE only for **one newly discovered fact about the very
divergence this repair names**: divergence **D-1** is recorded and pinned as an
*observability* difference (extra `savepoint`/`statement` units) plus one
*unverified* substrate consequence. It is more than that. On the default
better-sqlite3 substrate the two routes commit **different database state** and
return **different caller-visible outcomes** for the same program when a
statement-atomic write fails inside `$transaction(callback)`. That is an
observable compatibility choice, which the common brief says is a decision for
Arnaud and must be recorded as such. The remedy is the same cheap one the r3
repair already applied twice: extend D-1's record, add one pin, and qualify the
LX-02 row. No production change is implied.

---

## Round-1 findings — status after r3

| # | Round-1 severity | Status | Evidence |
| --- | --- | --- | --- |
| 1 | must-fix — unconditional transaction region, observer sees it | **Resolved as recorded**, but the recorded divergence is incomplete → new finding 9 | §R.1, §5 rows, §D, handoff §1; pin at `route-transactions.test.ts:443`; my falsification `falsify-d1-region-removed.log` |
| 2 | must-fix — LX-04 read half refused on a batch-only driver | **Resolved** | pin at `route-transactions.test.ts:388`; row demoted to PARTIAL; my independent falsification `falsify-d2-read-package.log` |
| 3 | must-fix — note/handoff describe a binding rule the code does not implement | **Resolved** | handoff §1 states the condition; §5 sentence + all three table rows corrected with the originals quoted in §R.1; edit count corrected to five in §A |
| 4 | note — unreachable `parseResult` guard | **Resolved (deleted)** | `pending-operation.ts:384` now carries the invariant as a comment, no throw; 104 shipped tests green; −5 charged token-lines confirmed |
| 5 | note — `prepareBatch` drops the supplied driver | **Resolved as recorded** (D-3 + requested change to G4-01) | §D, §R.5, handoff §2 |
| 6 | note — `buildStatement()` answers `undefined` | **Resolved as recorded** (D-4) | §D, §R.5 |
| 7 | note — stale `unit-cost.json` | **Resolved** | recomputed exactly, see Cost below |
| 8 | note — B-2 unreachable on every substrate here | **Resolved as recorded** | §G.5, §R.7 MySQL-lane request, handoff §4 |

### On findings 1 and 2 taking the second branch

My round-1 text offered two ways to close each: mirror the shipped condition, or
name the divergence, pin it, and demote the row. The author took the second and
argued the first is unavailable. **I checked that argument and it is sound.**
`compileSingleStatementCandidate` (`OperationExecutor.ts:226–239`) calls
`operation.planning()` and `operation.compile({})`: the shipped decision is a
property of a *compiled* shipped operation, and `canExecuteDirectly` (`:241–249`)
reads the compiled step. The candidate boundary compiles inside `execute`, so the
route holds nothing to test when it picks the binding, and manufacturing a
predicate would be the second planning authority §7 forbids. The claim is
attributed to B-1, which is where it belongs.

The two pins are real pins, not decoration: each asserts today's exact shape on
**both** routes, so either side moving turns them red.

---

## New finding

### 9. must-fix — divergence D-1 is recorded as observability only; on the default substrate it also changes committed state and the caller-visible outcome

**Location.** `src/query-engine/raptor3/route/client-route.ts:197–207`
(the region), against `src/drivers/driver.ts:659–668` and `:797–799`.
Records that are incomplete: `note.md` §5 (row 2 and the paragraph below the
table), §D (the LX-14 (r3) row and the LX-02 row), §R.1 ("Substrate consequence,
recorded"), and `handoff.md` §1.

**What r3 records.** D-1 = one extra `savepoint` unit and two extra `statement`
units visible to an observer, plus one *unverified* consequence (a
transaction-capable driver without savepoint support would fail). Both true.

**What it omits.** The region is a nested `withTransaction`, and the driver
tracks a nested transaction's failure with `poisonOnFailure = false`
(`driver.ts:797–799`), while a direct statement on a transaction-scoped driver is
tracked with `poisonOnFailure = true` (`driver.ts:665–667`), which marks the
caller's scope rollback-only. So for a **statement-atomic write that fails inside
`$transaction(callback)`**:

- **shipped**: the failure poisons the caller's transaction — the *next*
  operation in the same callback rejects with the same `UniqueConstraintError`,
  `$transaction` rejects, and **nothing commits**;
- **candidate**: the region rolls back only that member — the next operation
  succeeds, `$transaction` resolves, and **two rows commit**.

This is not the multi-statement case the unit's LX-02 oracle covers (there the
shipped route opens its own `runTransactionScope` savepoint and the two routes
agree — which is exactly why that oracle passes).

**Probe** (new, kept):
`tests/raptor3/g4/review/unit03/route-region-followup.review.test.ts`
→ *"a FAILING statement-atomic write inside $transaction(callback) keeps the same
error identity and the same caller-transaction outcome"*.

```
node scripts/run-vitest-safe.mjs run \
  --workspace=tests/raptor3/g4/review/unit03/review.workspace.ts \
  tests/raptor3/g4/review/unit03/route-region-followup.review.test.ts
```

```
candidate = {inner:"UniqueConstraintError:Unique constraint violation",
             afterWrite:"ok", outer:undefined,
             stored:[taken@…, kept@…, after@…]}
shipped   = {inner:"UniqueConstraintError:Unique constraint violation",
             afterWrite:"UniqueConstraintError:Unique constraint violation",
             outer:"UniqueConstraintError:Unique constraint violation",
             stored:[taken@…]}
```

Receipt: `unit03-review-receipts/followup/region-followup-probes.log`
(1 passed | 2 failed; the third case is D-1's unit sequence reappearing one
savepoint deeper in a nested transaction, which is the same named divergence and
is **not** a separate finding).

The same file's first case **passes**: a READ inside `$transaction(callback)`
produces identical units and rows on both routes, confirming the record's claim
that the region is write-only.

**Causality is already in the author's own falsifier, read the other way.** When
I removed the region (`followup/falsify-d1-region-removed.log`), LX-02 "a failed
operation inside a callback transaction rolls back only itself" did not fail on
an assertion — it failed with `UniqueConstraintError` escaping the callback,
i.e. the region-less candidate poisons the caller's transaction exactly as the
shipped route does. The region is therefore not decoration around the same
semantics; it *is* the different semantics, for every write it wraps.

**Why it matters.** `handoff.md` §1 and §5 are what the integrator and the C-01
cutover read. As written they say the candidate's transaction behavior mirrors
the shipped route except for extra observed units and an unmeasured
SAVEPOINT/RELEASE cost. A reader cannot learn from them that switching the
default route changes whether a caught failure inside a user's transaction
aborts that transaction. Per `briefs/common.md` ("a new observable compatibility
choice is a decision for Arnaud: record it as a blocker in your note, do not copy
or 'fix' legacy behavior"), this belongs in the note as a decision, not as a
performance footnote.

**Resolution.** No production change. (a) Extend D-1 in §5/§D/§R.1 and
`handoff.md` §1 with the state/outcome half and its mechanism
(`poisonOnFailure` true for a direct statement, false for a nested transaction);
(b) add one self-falsifying pin in `route-transactions.test.ts` asserting today's
two outcomes side by side, exactly like the two r3 pins; (c) qualify the **LX-02**
row in §D the way LX-04 and LX-14 were qualified — its "per-operation rollback
inside a callback transaction" coverage holds for multi-statement members and
diverges for statement-atomic ones; (d) mark it as a C-01 decision for Arnaud.

---

## Note-level observation

### 10. note — the registered count for `route-transactions.test.ts` is now stale (8 vs 10)

`scripts/raptor3-manifest.mjs:527–529` still reads `8`; the file holds 10 tests
after r3. The unit correctly did **not** edit the manifest (it is the witness
author's file) and records the exact request in §R.7 and handoff §5, which is the
prescribed protocol — but the registered estate is inconsistent until the owner
acts, and §R.7/handoff cite `:526–528` where the constant now sits at `:527–529`.
No action for this unit beyond the line reference; the integrator must land the
bump before the next campaign run.

*Evidence-timing nit, already closed:* `receipts/repair/route-suites-after.log`
is labeled "final run, after every edit" but started 00:16:44 while
`route-transactions.test.ts` has mtime 00:17:40. The file on disk reconstructs
byte-identically from `tests.patch`, and my own run at 00:21:56 on that exact
file is green, so nothing is unverified — the label is just optimistic.

---

## What I re-ran and verified

| Check | Result | Receipt |
| --- | --- | --- |
| The unit's four route suites on the current tree | **28/28 passed** (4.55 s wall, 655.0 MiB peak) | `followup/route-suites.log` |
| My five round-1 probes (12 cases) | 9 passed \| 3 failed — the three failures are exactly the cases asserting the two routes agree, i.e. the claim r3 withdraws and pins | `followup/review-probes-after-r3.log` |
| **Independent falsification of the D-1 pin** — region deleted from `runCandidate`, file restored from a scratchpad copy, SHA-256 re-verified | **2 failed \| 8 passed**: the D-1 pin and LX-02 "rolls back only itself", nothing else — reproducing the author's claim exactly and confirming the region is load-bearing | `followup/falsify-d1-region-removed.log` |
| **Independent falsification of the D-2 pin, by a different mechanism than the author's** — the route branch of `prepareBatch` made to fall back to `prepareSharedBatch` when the candidate packages nothing (simulating a prepared read shape), file restored, SHA-256 re-verified | **1 failed \| 9 passed**: the D-2 pin is the only case that flips | `followup/falsify-d2-read-package.log` |
| Shipped owners that consume the deleted `parseResult` branch: `pending-operation-contracts.core`, `array-transaction-closure.core`, `array-transaction-legacy-batch-boundaries.core`, `array-transaction-observed-legacy-coverage.core`, `nested-transaction-contract.core` (10 project-files) | **104/104 passed** | `followup/shipped-array-owners.log` |
| Whole-estate typecheck on the current tree | **only** the two permitted `pattern/pack.ts` TS2345 diagnostics (6.33 s, 5,769.8 MiB) | `followup/typecheck.log` |
| Cost recomputation with the census's verbatim `countTokenLines` against `git show 0cc61e61:<file>` | **+13,532 B / +357 physical / +236 token-lines**, per-file identical to `receipts/unit-cost.json` (route +8,534/+222/+143, pending-operation +4,053/+103/**+68**, client +515/+22/+20, query-engine +430/+10/+5) | `followup/cost-recheck.log` |
| `production.patch` vs `git diff` | the three seam files are **byte-identical** hunks; the `client-route.ts` new-file body reconstructs byte-identically to the file on disk | — |
| `tests.patch` vs disk | all five files reconstruct **byte-identically** | — |
| Author's r3 receipts vs their claims | counts match in all ten logs (677 / 176 / 257 / 213 / 370, 28/28, 3 failed \| 9 passed, 2 failed \| 8 passed, 1 failed \| 9 passed); failed attempts stay labeled failed; the superseded r2 §A table is kept and marked superseded rather than rewritten | `receipts/repair/*` |
| Source integrity after my two falsifications | `client-route.ts` `77df5c09…54bf881`, `pending-operation.ts` `bc3e1191…fab6e795a` — identical before and after; the second hash also matches the one the author recorded in §R.2 | — |

One attempt is recorded as **refused, not run**: a third mutation run
(`followup/region-causality-no-region.log`) was rejected by the workspace lock —
another agent held it. I did not retry it; the causal mechanism is established
from source (`driver.ts:665–667` vs `:797–799`) and from the D-1 falsification
above. Note for the environment: another stream was editing
`tests/raptor3/g4/lifecycle-admission.test.ts` and `tests/raptor3/g4/generation/`
while this review ran.

## Claims I still cannot verify

1. **Native providers** (`note.md` §G.4) — nothing here ran PostgreSQL or MySQL.
   B-2 (§G.5) stays native-only and unverified, as r3 now says.
2. **Performance** (§G.1) — still unmeasured by anyone. Finding 9 adds that the
   extra region is not only a cost but a semantic difference.
3. **Commit-ambiguity publication on the interactive standalone route** (§G.2) —
   no witness; rides on the B-4 seam.
4. **Benchmark reachability protocol** (§8) — written, not executed.
5. **PGlite shard receipts** (shards 3/7/9, 840 tests) — I accept the author's
   logs as labeled; I re-ran only the SQLite-lane shipped owners above.
6. **D-1's savepoint-less-driver consequence** (§R.1) — still unwitnessed, as the
   note says; every driver in this repository nests through `driver.ts:688`.
