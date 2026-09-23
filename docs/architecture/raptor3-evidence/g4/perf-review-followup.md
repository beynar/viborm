# Independent re-review — G4 performance pass, round 2

Unit: `g4-perf-safe-fixes` (G4-02 author), round 2 after
[`perf-review.md`](perf-review.md) (REVISE, 11:47). Brief:
[`briefs/perf-safe-fixes.md`](briefs/perf-safe-fixes.md) "Round 2". Author's
record: [`perf/note.md`](perf/note.md) §12. Base `0f25637b`, source
`/Users/arnaud/code/viborm` (main tree, uncommitted). Reviewer receipts:
[`perf-review-receipts/round2/`](perf-review-receipts/round2/).

## Outcome

**ACCEPT.**

Both must-fixes are resolved, and both resolutions are falsified in my hands,
not only in the author's. No engine behaviour changed in round 2: the seven
production files of the pass are byte-identical to the tree I reviewed in round
1 except **one docblock clause** in `shared/query.ts` (`cmp` on each file
against my round-1 A/B `after` tree — six identical, `query.ts` differing only
in that comment). Nothing I ran moved: the five named modes, the 14-cell probe
workspace and the whole-estate typecheck all reproduce the author's round-2
numbers exactly, the cost census and both closure patches reproduce, and the
regenerated `perf-pass.patch` round-trips byte-identically for all 15 paths.

One thing the integrator must do before the mode is green again: register the
two new counts (below). That is the declared, intended state of
`g4-unit02-author`, not a defect.

---

## 1. What I re-ran

One mode per call, through the bounded runner; logs in
[`perf-review-receipts/round2/`](perf-review-receipts/round2/).

| Mode | Author (note §12.5) | Reviewer | Exit |
| --- | --- | --- | --- |
| `g4-unit02-author` | 128 passed (19 files), exit 1 on the count check | **128 passed (19 files)** | **1** — `Missing candidate/profile/scenario cell in tests/raptor3/g4/unit02/prepared-operation.test.ts / 6 !== 5`, and nothing else |
| `g2-contracts` | 216 (16 files) | **216 (16)** | 0 |
| `g2-generated` | 52 | **52** | 0 |
| `g4-route-cache` | 7 | **7** | 0 |
| `g4-route-transactions` | 13 | **13** | 0 |
| `tests/raptor3/g4/review/perf/` (my probes) | 14 (3 files) | **14 (3)** | 0 |
| `node scripts/run-typecheck.mjs` | the two Pattern TS2345 only | **the two only** (`pack.ts:1443`, `:2633`) | 1 (as always) |

Two additional checks the author did not run:

| Check | Result |
| --- | --- |
| `node --test benchmarks/operation-pipeline-report.test.mjs` — the only registered consumer of the edited workload file (it recomputes `protocolSha256` functionally; no literal hash is pinned anywhere in `tests/`, `scripts/`, `benchmarks/`) | **41/41 pass** |
| `tests/raptor3/g4/unit02/prepared-statement-stability.test.ts` (item 3's pin, still unregistered in any lane) | **3 passed** |

## 2. Per-finding status

### Finding 1 (must-fix) — the benchmark cut asserts the fact it names — **RESOLVED**

`benchmarks/operation-pipeline-contract-workloads.mjs:314-318` and `:355`.
The count is recorded once (`admissionsBeforeFirstEffect ??= defaults.length`)
at the first statement where a child is visible and adjudicated in `verify`
against the final ledger; the tautological comparison at the cut is gone and
`seriesLedger`'s own guard still carries the third-answer refusal. Neither
engine's constant appears in the source.

I verified it on the round-1 A/B `after` tree (the same instrument, my own copy,
`createWorkloadHarness("relation-series-2","full",2,"sqlite3")`), and I built
the late-admission mutation myself — a different spelling from the author's,
written against a scratch copy of the contract file; the repository's file was
never edited (sha256 `eb664786…` before and after).
Receipt [`series2-matrix.jsonl`](perf-review-receipts/round2/series2-matrix.jsonl),
mutations as diffs (`variant-*.diff`).

| Arm | shipped | candidate |
| --- | --- | --- |
| round-2 contract, unmutated | **green** — 5 defaults, 7 statements, `series_child_3`/`_5` | **green** — 3 defaults, 3 statements, `series_child_2`/`_3` |
| **A** round-2 contract + one member admitted after the first effect | **red** — `series effects started before every member was admitted 4 !== 5` | **red** — `… 2 !== 3` |
| **B** round-1 contract + the SAME mutation | green — the late admission is invisible | green — invisible |
| **C** round-2 contract with `??=` reverted to `=` + the SAME mutation | green | green |
| **D** candidate ledger row set to `admissionsPerMember: 4` | green (its own row still explains 5) | **red** — `seriesLedger`'s third-answer refusal, raised from the cut |

A is the fix working; B is the detection that was lost; **C is the part the
author did not measure and I did**: with the record-once memo removed the new
assertion goes blind again, so the force of the repair is in the once-only
recording, not in the ledger indirection. The author's own falsification
(`late-admission-{new,old}.mjs`, run in a different scratch tree) reports the
same four cells and the same two sentences; the receipts are honest.

### Finding 2 (must-fix) — the sentinel's invariant has a registered falsifier — **RESOLVED**

`tests/raptor3/g4/unit02/prepared-operation.test.ts`, sixth cell — my probe
cell 1 verbatim, in the file that already owns the `prepareBatch` boundary and
is already inside `g4-unit02-author`.

Falsified here, not read: I backed the file up to the session scratchpad,
replaced the `incompletePreparation` getter body at `:174-178` with a fresh
`new Error(...)` per read, and ran the file through the bounded runner — **the
five pre-existing cells stay green and only the new sixth cell goes red**, with
the control-flow sentence leaking to the caller through
`commands/index.ts:202`/`:231`. Restored from the backup: sha256
`53acb07c45ebd4efdd67435071a34d6335f697eb5026cd885cc8797149f12277` (the hash
recorded in round 1 and by the author), production identity
`2e92354b…` re-verified, `g4-unit02-author` 128/128.
Receipt [`sentinel-falsification.log`](perf-review-receipts/round2/sentinel-falsification.log).

The note's own statement of the invariant is now correct too: §0 item 1 and
§1.3 name the cell as the falsifier and say explicitly that the A/B measures
the cost claim, not the identity.

### Note 3 — the D-7.1 row — **RESOLVED**

[`unit02/note.md`](unit02/note.md) §P.0 (written at the end of that note, so
the unit that owns the pin owns the row): decision, "no code", the RF-15
classification, `lone-statement-transport.test.ts` row 7 as the unchanged
recorded difference, and a cross-reference to the guide paragraph and the
ledger row. `src/query-engine/raptor3/AGENTS.md` was not touched again in round
2 (mtime 10:47, and it is `cmp`-identical to the round-1 reviewed copy).

### Note 4 — the patch header — **RESOLVED, and my round-1 note was partly wrong**

`perf-pass.patch` now has **15 `diff --git` sections**; the new file carries
`new file mode 100644` and `index 00000000..d4657495`, and `d4657495…` is
exactly `git hash-object` of the file. sha256
`ad2ab9e5b3deba834ec51355e1e769ccefc3c3d9dfb18ab93269e21a87772c0a`, 1 043
lines. Applied to a fresh `git archive 0f25637b` it reproduces **all 15 paths
`cmp`-identical** to the working tree.

The author's correction of my note 4 is right and I confirmed the mechanism on
a synthetic patch: `git apply --stat` and `--numstat` **do** count a headerless
`--- a/… / +++ b/…` section. What under-counted was any consumer keying on
`diff --git`. The defect and the repair are unchanged; my round-1 wording about
`--stat` was wrong.

### Note 5 — the A/B instrument's reach — **RESOLVED**

`perf/note.md` §7 now states that the `VIBORM_BENCH_ENGINE` switch is applied at
the two `coreFixture` client constructions only, that all four reported cells
are `core`, and that a later reuse on a `wide-*`/`variant-*` cell would measure
the shipped engine in both arms. I re-read the instrument in my own tree: it is
those two constructions and nothing else.

### Note 6 — the `rootAlias` docblock — **RESOLVED**

`shared/query.ts:488-493`: "every statement starts at `q0`" → "a statement whose
first alias is minted by one of the six owners named below starts at `q0`". The
six owners are named three sentences later, so the clause is now exactly what the
mechanism enforces. Comment only: the census reproduces the author's figures
field for field — files 181, physical **86 728**, token-lines **68 628**,
functions 3 854, branch nodes 8 986, files over 300 lines 76 (identical to
`perf/receipts/round2/query-engine-structure-round2.json`; `+22` token-lines
over the pass's `before` receipt, unchanged by round 2).

### Note 7 — the two `execution.ts` observations — **RESOLVED**

`perf/note.md` §4 next candidates 4 (`:248`, the unconditional
`selection.retained()` on the batch route) and 5 (`:718`, `selection.required!`
now hiding a `TypeError` where it hid `throw undefined`), both attributed to the
round-1 review.

## 3. Evidence integrity

- **Diff.** `git diff 0f25637b --stat` = 21 files. Three are the pre-existing
  dirty files (`CONTEXT.md`, `memory.md`, `tests/pattern/pack/program-dump.ts`),
  14 are the pass's tracked files, and the four remaining are evidence:
  `g4.md` (ledger), `g4/unit02/note.md`, `g4/unit02/production-closure.patch`,
  `g4/unit02/tests-closure.patch`. The 15th pass file
  (`prepared-statement-stability.test.ts`) is untracked. Round 2's tracked
  delta over round 1 is exactly: the benchmark workload, `prepared-operation.test.ts`,
  `query.ts` (comment), `unit02/note.md`, `production-closure.patch` — plus the
  untracked `perf/note.md`, `perf/perf-pass.patch` and `perf/receipts/round2/`.
  No `src/` file outside `query.ts` moved, no `scripts/` file moved, no
  manifest edit.
- **Closure patches.** `production-closure.patch`
  `4f07351d…` (regenerated for the docblock) and `tests-closure.patch`
  `4b509c38…` (unchanged) both `git apply -R --check` cleanly against the
  working tree, so their `+` side IS the current tree. The note's reasoning for
  leaving the tests closure set alone — `prepared-operation.test.ts` was never
  in that set, and adding it would change the set — is sound and declared.
- **Identity.** Recomputed with `captureRaptor3Identity()`: production
  `2e92354bafaaccb7cab5f54041992b552664a7865fb69370be70ebccb63a1975`, harness
  `e8436e5e2aeb75b8d75ec6c251b310a6acb3ae375fb2bd0b61bef26a8cd991f7` — both
  match `perf/receipts/round2/identity-after-round2.json` exactly. The
  production hash moving from round 1's `4fe5bd3d…` is the docblock and nothing
  else.
- **Receipts.** Every round-2 receipt I checked reports what its file name
  claims; the failed arms stay labelled failed; nothing is relabelled.

## 4. Notes (nothing to repair)

1. **The ledger moved after my review, by another hand.**
   `docs/architecture/raptor3-evidence/g4.md` has mtime 11:55:44 — after the
   11:47 review, before the author's first round-2 edit (11:58) — and carries a
   new paragraph narrating the review outcome and the round-2 plan ("then
   freeze 4, qualification attempt 4, the stage-2c measurement"). That is the
   integrator's voice and the integrator's file, consistent with the author's
   "the ledger is untouched". Its factual claims (the A/B ratios, "+22 charged
   token-lines", the two must-fixes) are faithful to what I measured. The
   integrator should simply confirm it is theirs.
2. **The new assertion's right-hand side is definitionally `defaults.length`.**
   `seriesAdmissions(seriesLedger(x)) === x` by construction, so all of the
   assertion's power lives in the once-recorded left-hand side — which is what
   my resolution asked for (it keeps both engines' constants out of the source),
   and variant C above measures it. Worth knowing before this file is re-frozen
   into `protocolSha256`: a future edit that restores an unconditional
   assignment silently restores the blindness.
3. **Two counts for the integrator, not one.** `g4-unit02-author` exits 1 on
   `prepared-operation.test.ts / 6 !== 5` (`scripts/raptor3-manifest.mjs:601`,
   `5` → `6`, lane total 127 → 128). Separately,
   `tests/raptor3/g4/unit02/prepared-statement-stability.test.ts` (item 3's
   alias-stability pin, 3 cells, green) is **still absent from the manifest** and
   therefore runs in no lane — it was already so in round 1.
4. The registered cell's second loop asserts only that the packageable read
   still packages; the `undefined` answer is asserted in the first loop (four
   times). That is my own probe body, verbatim; no change requested.

## 5. Unverified claims after round 2

| Claim | Status |
| --- | --- |
| §11.1 the A/B is attribution, not a verdict | stands (unchanged in round 2; no new A/B was run and none is claimed — correct, since the only production edit is a comment) |
| §11.2 the candidate arm is `createCandidateClient`, not the cutover default route | still unverified — I used the same instrument again |
| §11.3 the item-5 review pin was edited but not executed | verified in round 1 (green) |
| §11.4 item 3's re-entry claim | measured in round 1 (18 shapes) |
| §11.5 item 3's statement-cache benefit on PG/MySQL/D1 | still unverified (reasoned, not measured) |
| §11.6 closure-patch lineage exact for six files, approximate for two | stands; the property that matters (the `+` side is the current tree) re-verified by reverse-apply |
| §11.7 `cs02-structure-measure`'s red is the pre-existing B-R1 defect | confirmed in round 1 by mechanism |
| §11.8 peak RSS is the measuring process's | stands |
| §12 "no engine behaviour changed in round 2" | **verified**: `cmp` against my round-1 `after` tree — six of seven production files byte-identical, `query.ts` differing only in the docblock clause |
