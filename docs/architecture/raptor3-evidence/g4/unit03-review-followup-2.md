# G4-03 "client route / types" — independent review, second follow-up

Reviewer: the same independent reviewer who wrote
[`unit03-review.md`](unit03-review.md) (REVISE) and
[`unit03-review-followup.md`](unit03-review-followup.md) (REVISE). I did not
author the unit or either of its two repairs.
Reviewed source: main tree `/Users/arnaud/code/viborm`, branch `pattern-engine`,
base commit `0cc61e61`, working tree containing the unit's repair 2
(note revision **r4** / handoff revision **r3**). Nothing applied, nothing
repaired by this review. Date 2026-09-15.

Source identity, verified before and after every probe I ran:

```
77df5c0944bf12f47cc8d14b7afc2ffdcad88ece048883ff77a5c6b3054bf881  src/query-engine/raptor3/route/client-route.ts
bc3e1191b9467968b091fdff7d8cbff131cb102a75be7d67ca03c64fab6e795a  src/query-engine/pending-operation.ts
8ec68253f71da757d8c00a8d1f4f213248b205b93a8b7a85abd59d202b63958c  src/client/client.ts
bb07f7a0e52e61c086eb85d811361b2621cae950d1d396ee4908236680d5b612  src/query-engine/query-engine.ts
```

The first two are the exact hashes my previous follow-up recorded, so the
"records-only repair, `src/` byte-identical" claim is true by identity, not by
assertion.

Inputs read: `g4/briefs/common.md`, `g4/briefs/review.md`,
`g4/briefs/unit02-physical-provider.md` (item 11 — the integrator's decision the
repair leans on), my own two reviews, the author's repair-2 summary,
`g4/unit03/note.md` (§5, §D, §E, §G, §R.1, §R.7, §R.10–§R.13),
`g4/unit03/handoff.md` §1/§5, both patches, and the current source of
`src/query-engine/raptor3/route/client-route.ts` and `src/drivers/driver.ts`.

Receipts for this review: `g4/unit03-review-receipts/followup2/`.
New probes (kept):
`tests/raptor3/g4/review/unit03/route-region-mechanism.review.test.ts`,
`tests/raptor3/g4/review/unit03/route-uncaught-failure.review.test.ts`.

---

## Outcome: **ACCEPT**

Both open findings are resolved. Finding 9 is resolved in the strongest form
available to this unit: the state/outcome half of divergence D-1 is now recorded
with its mechanism in four places, pinned by a test that asserts **both** routes'
outcomes side by side, and the LX-02 row is qualified exactly as LX-04 and LX-14
were. The one place the repair departs from my prescribed remedy — (d) "mark it
as a C-01 decision for Arnaud" — is not the author's own call: the integrator
decided the resolution path after my follow-up and recorded it in the file they
own (`briefs/unit02-physical-provider.md` item 11), which names "G4-03 follow-up
finding 9, divergence D-1" explicitly and prescribes the two shapes that mirror
the shipped route. I verified that brief item exists and says what the note says
it says, and I verified the mirror claim from an independent direction: on the
**shipped** route, the same failing write wrapped in one nested `$transaction`
reproduces the candidate's recorded outcome exactly, so both branches of item 11
are shapes the shipped engine already implements. That makes "resolved by design,
not a decision" a sound disposition rather than a dodge, and the one half that
cannot be witnessed here is labeled unverified (§G claim 6).

Three note-level observations below are for the integrator and the G4-02 owner.
None of them is a defect in this unit, and none needs a further repair round.

---

## Per-finding status

| # | Severity (when raised) | Status | Evidence |
| --- | --- | --- | --- |
| 1–8 | round 1 (3 must-fix, 5 note) | **Resolved, unchanged** — `src/` is byte-identical to the tree where I verified them; re-verified by the 29/29 suite run and the probe re-run below | `followup2/route-suites.log`, `followup2/review-probes.log` |
| 9 | must-fix (follow-up) | **RESOLVED** — records extended (§5, §D, §R.1, handoff §1), pin added and independently falsified by me through a different mutation than the author's, LX-02 qualified, disposition verified against the integrator's brief item | `followup2/falsify-d1-state-pin-binding-arm.log`, `followup2/mechanism-probe.log`, `briefs/unit02-physical-provider.md:117–138` |
| 10 | note (follow-up) | **RESOLVED** — `G4_ROUTE_TRANSACTION_COUNTS` sits at `scripts/raptor3-manifest.mjs:527–529` and still reads `8`; §R.7, §E and handoff §5 now request **11** (unit total **29**) and cite `:527–529`; the manifest is correctly untouched | verified in source; `followup2/route-suites.log` (29 tests) |
| 11 | note (new) | The "mirrors shipped on both branches" argument assumes the two engines agree on *which* operations are statement-atomic; that agreement is itself unwitnessed | see below |
| 12 | note (new) | Revision labels disagree between `note.md` (r4) and `handoff.md` (r3) | see below |
| 13 | note (new) | Two evidence figures in §R.12 are loose: the tests-patch growth (+86 vs +60 measured) and "production.patch regenerated" (its mtime predates repair 2; content is verified correct) | see below |

---

## Finding 9 — what I verified, point by point

**(a) The records carry the state/outcome half.** `note.md` §5 (the borrowed
transaction row plus a new "Extended in repair 2" paragraph with the mechanism
and a shipped-vs-candidate outcome table), §D (the LX-14 row now says
OBSERVABILITY half; a new LX-02 row carries the state/outcome half), §R.1
("Extended in repair 2", two-shape mechanism table, row-status change), §R.10 in
full, and `handoff.md` §1 (mechanism, outcome table, falsifier pointer,
resolution). Every source line the records cite is correct on this tree:
`markCurrentScopeRollbackOnly` at `driver.ts:564–566`, the unconditional poison at
`:649`, the observation branch at `:642–648`, `_execute`'s
`trackTransactionOperation(…, true)` at `:665–667`, and the nested
`withTransaction`'s `trackTransactionOperation(…, false)` at `:797–799`.

**(b) The pin is real and sensitive.** `tests/raptor3/g4/route-transactions.test.ts:504`
asserts, per route: the failing member's error identity (equal on both), the
caller's *next* operation, whether `$transaction` resolves or rejects, and the
exact committed rows. Either column moving turns it red.

I falsified it **by a different mutation than the author's**: instead of deleting
the region, I made the write arm take the read arm's plain borrowed binding
(`client-route.ts:188`, `if (!execution.isWrite)` → `if (!execution.isWrite || true)`),
which is exactly the shape item 11 prescribes for a single-statement borrowed
write. Result: **3 failed | 8 passed**, the new pin failing on
`candidate afterWrite: expected 'ok', actual 'UniqueConstraintError'` — the same
three tests and the same message as the author's own falsification. File restored
from a scratchpad copy and SHA-256 re-verified identical.
Receipt: `followup2/falsify-d1-state-pin-binding-arm.log`.

**(c) LX-02 is qualified.** §D's covered row and a matching pending row say the
per-operation-rollback half holds for a multi-statement member and diverges for a
statement-atomic one; handoff §5 lists LX-02 beside LX-04 and LX-14 as PARTIAL.

**(d) The disposition — "resolved by design", not a decision for Arnaud — is
sound, and I checked it rather than took it.**

1. The integrator's file says so. `briefs/unit02-physical-provider.md` item 11
   (lines 117–138) makes the candidate's `OperationContext` the single owner of
   the physical envelope, names "G4-03 follow-up finding 9, divergence D-1",
   prescribes *single-statement borrowed write → run directly on the borrowed
   driver (poisons the caller exactly as the shipped route does)* and
   *multi-statement → the `memberRollback` region*, requires the route to pass
   `memberRollback` as a capability, requires pinning both D-1 outcomes against
   the shipped engine, and repeats the brief's law: "if a case cannot be
   mirrored, record it as a decision for Arnaud instead of choosing." The unit
   recorded the pointer; it did not invent the decision.
2. The mirror claim survives an independent probe. My new
   `route-region-mechanism.review.test.ts` never touches the candidate: it runs
   the identical failing write on the **shipped** route twice, once directly
   inside `$transaction(callback)` and once wrapped in one nested
   `$transaction`. Direct → the caller is poisoned, `$transaction` rejects, one
   row committed. Wrapped → the caller survives, `$transaction` resolves, three
   rows committed. **2 passed** (`followup2/mechanism-probe.log`). So the
   candidate's recorded outcome is not a novel semantics: it is the shipped
   engine's own semantics for the shape the route currently opens, and item 11's
   two branches are both shipped-reproducible. That is what makes "no new
   observable compatibility choice" a checkable statement instead of an opinion.
3. The unverified half is labeled. §G claim 6 records that nobody has compared
   the multi-statement branch's observed *units* between the routes, and points
   at item 11's pin requirement as the owner. That is the correct treatment under
   the brief's evidence rule.

**Adversarial probe the author did not run.** Every D-1 state witness so far
catches the failing member inside the callback. I probed the two uncaught shapes —
the failure propagating out of `$transaction(callback)`, and a caller that
catches and then throws its own error — on both routes:
`tests/raptor3/g4/review/unit03/route-uncaught-failure.review.test.ts`,
**2 passed** (`followup2/uncaught-shape-probe.log`). Both routes reject with the
same identity and commit nothing. The recorded divergence is therefore exactly as
wide as the records say it is: it needs a *caught* failure followed by continued
use of the caller's transaction. Nothing wider is hiding behind it.

---

## New note-level observations

### 11. note — the mirror argument assumes the two engines classify statement-atomicity identically, and that agreement is unwitnessed

§R.10.5 concludes "there is no case where the candidate would deliberately
differ". The word doing the work is *deliberately*: item 11 routes a borrowed
write by the **candidate's** rule ("lowers to exactly one physical statement"),
while today's shipped outcome is decided by the **shipped** compiler
(`compileSingleStatementCandidate` + `canExecuteDirectly`,
`src/query-engine/write-engine/OperationExecutor.ts:226–249`). Those are two
different compilers reading two different compiled shapes. Wherever they classify
one operation differently, the failing-member outcome diverges again — not by
choice, by disagreement. Nothing in this unit or in item 11 pins *classification
agreement*; item 11 pins "both D-1 outcomes" for chosen workloads, which is not
the same statement. Owner: G4-02 / the integrator. One sentence in §G claim 6 or
one extra bullet in item 11 ("pin that the candidate's single-statement predicate
agrees with `canExecuteDirectly` for the qualified verb set") would carry it. No
action for this unit.

### 12. note — the two documents disagree about which revision this is

`note.md` calls this repair **r4** ("Repair 2 — revision r4"); `handoff.md` calls
it **r3** and calls the previous repair r2. So handoff §5's cross-references —
"(r3) LX-02", "Charged cost after r2" — point a reader at the note's *previous*
repair section. Cosmetic, but the handoff is what the integrator and the C-01
cutover read. No action required before landing; worth one pass if the handoff is
edited again.

### 13. note — two loose evidence figures in §R.12 (neither load-bearing)

- "`tests.patch` grew by the one pin (**+86 lines**)". The block repair 2 added is
  `tests/raptor3/g4/route-transactions.test.ts:503–562` = **60 lines**, and the
  file is now 627 lines (so 567 before the pin). `tests.patch` is a set of
  full-file diffs (1754 content lines + 30 header lines = 1784), so its growth is
  the block's 60 lines unless the r3 patch was generated with different options.
  The figure is in the tests category, which is counted separately from charged
  cost; the charged figures are exact (below).
- "`production.patch` (regenerated, byte-identical)". Its mtime (00:16) predates
  repair 2, so the file was not rewritten — which is fine if the author generated
  to a temporary file and compared. Nothing is unverified either way: I
  reconstructed all nine files from both patches against `0cc61e61` and every
  hash matches the tree (below).

---

## What I re-ran and verified

| Check | Result | Receipt |
| --- | --- | --- |
| The unit's four route suites | **29/29 passed** (7 + 11 + 6 + 5; 4.39 s wall, 712.6 MiB peak) | `followup2/route-suites.log` |
| My six kept probes (15 cases) | **10 passed \| 5 failed** — identical to the author's claim; all five failures are cases asserting the two routes AGREE: D-2 ×2, D-1 observability ×2 (one of them one savepoint deeper, where the committed state still agrees), D-1 state/outcome ×1, all three pinned | `followup2/review-probes.log` |
| **Independent falsification of the new pin, by a different mutation** (binding arm flipped to the plain borrowed binding; restored from a scratchpad copy; SHA-256 re-verified `77df5c09…54bf881`) | **3 failed \| 8 passed** — the new pin, the r3 D-1 unit pin and LX-02 member rollback, nothing else | `followup2/falsify-d1-state-pin-binding-arm.log` |
| **New mechanism probe, shipped route only, no mutation** — direct failing write vs the same write in one nested `$transaction` | **2 passed**: direct poisons the caller (1 row), nested does not (3 rows) — the recorded `poisonOnFailure` mechanism, witnessed without the candidate | `followup2/mechanism-probe.log` |
| **New adversarial probe** — uncaught failure, and caught-then-rethrown failure, both routes | **2 passed** — both routes reject with the same identity and commit nothing; the divergence is confined to the caught-and-continue shape | `followup2/uncaught-shape-probe.log` |
| Whole-estate typecheck (`node scripts/run-typecheck.mjs`), with my two new probe files on disk | **only** the two permitted `pattern/pack.ts` TS2345 diagnostics (`:1443`, `:2633`); 6.83 s wall, 5,622.7 MiB peak | `followup2/typecheck.log` |
| Both patches vs the tree | all **nine** files (4 production, 5 test) reconstruct **byte-identically** from `production.patch` + `tests.patch` applied to `0cc61e61` | `followup2/` (hashes in this document) |
| Cost | **+13,532 bytes / +357 physical lines**, per-file identical to `receipts/unit-cost.json` (route +8,534/+222, pending-operation +4,053/+103, client +515/+22, query-engine +430/+10). Token-lines **+236** inherited: I recomputed them exactly last round against byte-identical sources, so recomputation is provably unnecessary | `followup2/cost-bytes-lines.log` |
| Manifest claim | `G4_ROUTE_TRANSACTION_COUNTS` at `scripts/raptor3-manifest.mjs:527–529` reads `8`; the campaign enforces it at `scripts/run-raptor3.mjs:911` (`g4-route-transactions`), so the bump to **11** must land before the next campaign run. Manifest correctly not edited by this unit | verified in source |
| Author's repair-2 receipts vs their claims | counts match in all five logs (1\|2, 11/11, 3\|8, 29/29, 5\|10) and in the typecheck log; timings are coherent (repro 01:21:51 → edit 01:23:12 → pin run 01:23:18 → falsification 01:23:40 → restore 01:23:54 → final suites 01:31:16 → typecheck 01:31); the r3 "optimistic label" nit does not recur | `receipts/repair2/*` |
| Shipped owners of the one deleted `parseResult` branch | **not re-run, and none needed**: `src/` is byte-identical to the tree where my previous follow-up ran them 104/104, and repair 2 changed one test file only | `unit03-review-receipts/followup/shipped-array-owners.log` (previous round) |
| Biome | clean on `route-transactions.test.ts`, `client-route.ts` and both of my new probes | — |
| My probes stay out of the registered estate | `scripts/credential-free-test-manifest.mjs:237` excludes `tests/raptor3/g4/review/` | — |

The workspace lock was held twice by another stream (`scripts/raptor3-cli.test.mjs`,
PID 6507) during this review. Every run above waited and retried through the
bounded runner; nothing was bypassed and no two commands ran concurrently from
this session.

## Claims I still cannot verify

1. **Native providers** (§G.4) and **B-2's MySQL-only refusal** (§G.5) — nothing
   here ran PostgreSQL or MySQL. Unchanged, and correctly labeled.
2. **Performance** (§G.1) — still unmeasured by anyone.
3. **Commit-ambiguity publication on the interactive standalone route** (§G.2).
4. **Benchmark reachability protocol** (§8) — written, not executed.
5. **PGlite shard receipts** (shards 3/7/9, 840 tests) — accepted as labeled; I
   re-ran only SQLite-lane suites.
6. **D-1's savepoint-less-driver consequence** (§R.1) — unwitnessed; nesting is
   implemented once at `driver.ts:688`.
7. **The multi-statement branch's observed UNITS** (§G claim 6) — the author's own
   unverified label, and it is the correct one; its state half passes today.
8. **Classification agreement between the two compilers** (finding 11) — new, and
   unwitnessed by anyone.
