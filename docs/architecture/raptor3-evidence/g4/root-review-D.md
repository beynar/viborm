# G4-04 root integrated review — area D (evidence and cost)

Independent reviewer, read-only on `src/`, `tests/`, `scripts/`, `benchmarks/`
and the root config files. Probes and receipts live under
[`g4/root-review-probes/D/`](root-review-probes/D/); the census is
[`g4/root-review-D-census.json`](root-review-D-census.json).

## Outcome

**ACCEPT.** Eight notes, no blocking and no must-fix finding.

The frozen identity is exact and was exact again at the close of the review. The
census method is byte-identical to the one the G3 accounting recorded, and
re-measuring the G3 charged file list at `0cc61e61` reproduces the published G3
closure figures to the byte — core 6,927 / complete 11,849 token-lines,
14,486 physical, 499,927 bytes — which makes every G4 delta below a measured
difference rather than a carried-forward claim. The per-unit cumulative chain
closes exactly on the measured total (+2,480 core token-lines, no residual).
Failed and superseded attempts are kept and labelled, and every one of the 974
relative evidence links under `g4/**` resolves, as do all 54 in the ledger.

None of the notes changes a public answer, an error identity, committed state,
or a stated invariant, and none shows a second authority for a fact.

## What this review ran

| Probe | What it establishes | Receipt |
| --- | --- | --- |
| [`capture-identity.mjs`](root-review-probes/D/capture-identity.mjs) | `captureRaptor3Identity` on the frozen tree, at review start and end | [`identity-at-review.json`](root-review-probes/D/receipts/identity-at-review.json), [`identity-at-review-end.json`](root-review-probes/D/receipts/identity-at-review-end.json) |
| [`census-fn.mjs`](root-review-probes/D/census-fn.mjs) | slices `countTokenLines` verbatim out of `scripts/query-engine-structure.mjs` (never modified) and refuses to run unless its SHA-256 equals `accounting.censusFunctionSha256` in the G3 receipt | asserted in the cell below |
| [`census.mjs`](root-review-probes/D/census.mjs) | the whole census: every group, at the freeze and at `0cc61e61`, plus deltas, ratios and the per-unit chain | [`root-review-D-census.json`](root-review-D-census.json) |
| [`bundle-reach.mjs`](root-review-probes/D/bundle-reach.mjs) | whether any candidate module enters the three frozen bundle fixtures' runtime module graphs | [`bundle-reach.json`](root-review-probes/D/receipts/bundle-reach.json) |
| [`reachability.mjs`](root-review-probes/D/reachability.mjs) | which shipped owners the candidate reaches by runtime import, with the three seam files as leaves | [`reachability.json`](root-review-probes/D/receipts/reachability.json) |
| [`link-check.mjs`](root-review-probes/D/link-check.mjs) | every relative markdown link under `g4/**` resolves | [`link-check.json`](root-review-probes/D/receipts/link-check.json), ledger: [`ledger-link-check.json`](root-review-probes/D/receipts/ledger-link-check.json) |
| [`census-reproduces.test.mjs`](root-review-probes/D/census-reproduces.test.mjs) | the falsifier for this report: re-runs every probe and fails if any number here was transcribed rather than measured | **7 passed**, 12.94 s wall / 570.5 MiB peak RSS — [`probe-suite.log`](root-review-probes/D/receipts/probe-suite.log) |

Run as
`node scripts/run-vitest-safe.mjs run --workspace=docs/architecture/raptor3-evidence/g4/root-review-probes/D/vitest.workspace.mjs docs/architecture/raptor3-evidence/g4/root-review-probes/D`.
The first attempt was refused while the integrator held the workspace lock; it
was retried, not bypassed. Nothing under `src/`, `tests/`, `scripts/`,
`benchmarks/` or the root config files was created, edited or deleted — the
probe directory is under `docs/`, which neither identity half fingerprints, and
the closing identity capture proves it.

The cell caught one real defect in this review's own arithmetic before
publication: the first per-unit chain double-counted the G4-01 r5 delta (+19)
and summed to 2,499 against a measured 2,480. The chain is now the tree-state
sequence the tree actually passed through, and it sums exactly.

## Checklist rows

### D-1 — "Identity captured after the last edit; every unit receipt names its identity; failed attempts kept as failed"

**Closed.** `captureRaptor3Identity` on the frozen tree returns, twice,

| Fact | Value |
| --- | --- |
| production | `e2d5bcb2201641372941c2c1fa6e648f52429fb3ca8ce948678baa80a31b589f` |
| harness | `838a1e1bb2080e863f5decb56ce90c5218da1e1a341532c21d5b0e04453bc6c5` |
| runtime | Node v24.21.0, darwin/arm64, better-sqlite3 12.6.0, Vitest 3.1.4 |

which is [`g4/freeze/identity.json`](freeze/identity.json) exactly, field for
field.

**Production has not moved since the last unit verification.** The freeze unit's
round-2 receipt ([`freeze/receipts/round2/identity-after.json`](freeze/receipts/round2/identity-after.json),
19:36) already carries production `e2d5bcb2…`, and that is the identity its
whole suite table (`freeze/note.md` §R2.6, eleven suite rows plus the whole-estate typecheck) ran
on. The 19:36 → 20:03 change is **harness-only**: four reviewer probe files
under `tests/raptor3/g4/review/freeze/` (19:52–19:55) and the integrator's
registration of `native-nested-key-refusal.test.ts: 3` in
`scripts/raptor3-manifest.mjs:613` (20:00:42). No file under `src/` was written
after 19:46, and the one that was — `commands/relation-body.ts`, a reviewer
falsification — was restored to the byte: its SHA-256 is
`61af50d82a5c3479b6484dd615ff211186f054b06916329bb0eb447679c2b5d9`, the value
`freeze/note.md` §R2.8 records for round 2. Five further per-file identities
from that table reproduce identically
([`file-identities.txt`](root-review-probes/D/receipts/file-identities.txt)).

**Receipts whose identity is older than the frozen one.** Every unit receipt in
`g4/**` is older, necessarily: later units edited shared files after each
earlier unit closed. What matters is whether the unit re-ran after *its own*
last edit, and whether the frozen tree is being re-qualified as a whole. Both
hold.

| Unit | Newest receipt identity | Older than frozen | Re-ran after its last edit | Re-run on the frozen identity |
| --- | --- | --- | --- | --- |
| G4-01 | `db3c07dac7ce…` ([`unit01/repair3/identity.json`](unit01/repair3/identity.json), 02:24) | yes | yes — `unit01/note.md` "Cost after Repair 3" + r5 suite table | `g4-read-contracts`, `g1`/`g2`/`g3` replays in the launched qualification |
| G4-02 | `751be3526ca5…` ([`unit02/receipts/closure3/identity-after.json`](unit02/receipts/closure3/identity-after.json), 16:39) | yes | yes — §R6.7 suites after the last edit | `g4-unit02-author` 17/110, the MySQL/PG groups, `g4-read-contracts` |
| G4-02 decisions round | `69dcfd215b36…` ([`unit02/receipts/decisions/identity-after.json`](unit02/receipts/decisions/identity-after.json), 17:36) | yes | yes — `g4/decisions-review.md` verification | same |
| G4-03 / G4-03b | per-file SHA-256 in `unit03/note.md` §R.6 and `unit03b-review-followup.md` | yes | yes | the four route modes 8 / 7 / 7 / 13 |
| Witness / harness | `bc26281df8dc…` ([`witness/receipts/reconciliation/repair/identity-final.json`](witness/receipts/reconciliation/repair/identity-final.json), 14:23) | yes | yes — harness-reconciliation follow-up ACCEPT 15:05 | the six campaign lanes and the G3 replays |
| Freeze | `e2d5bcb2…` / `b7f5a61bf19d…` (19:36) | production **equal**, harness older | yes | the whole launched qualification |
| Cutover (stage 2) | [`cutover/receipts-stage2/identity-after-resync.json`](cutover/receipts-stage2/identity-after-resync.json), 20:05 | isolated worktree, separate identity by design | in flight | not applicable |

The qualification launched at 20:03 writes receipts that carry exactly the
frozen identity — checked in
`qualified/fixed/g1-contracts.receipt/verified.json` and every other
`verified.json` produced so far — so the whole estate is being re-run
identity-matched. Its **outcome** is Areas B and E, not D; at 20:27 the fixed
lane had reached `post-g3-projection-preparation` with `exit=0` on every mode
logged so far.

**Failed attempts kept as failed.** Preserved, unedited, and labelled: the
`attempt1`/`attempt2`/`attempt3` receipt families in
`witness-followup-review-receipts/`, `witness-followup-review3-receipts/`,
`unit01-review-followup2/g29-pglite-attempt1-breached.log` (whose text says
"Attempt 2 (recorded as FAILED, not relabeled)"),
`freeze-review-receipts/round2/probe-arm-handoff-attempt{1,2}.log`, the whole
`unit02/receipts/withdrawn-operation-region/` directory, and
`witness/receipts/reconciliation/README.md`'s `cs03-all-seed-sweep-after.json`
row — "**SUPERSEDED — do not cite** … Kept unmodified rather than deleted."

### D-2 — "Census on the frozen tree … cumulative deltas per unit reconciled; growth explained"

**Closed.** Method: `countTokenLines` sliced verbatim from
`scripts/query-engine-structure.mjs`; its SHA-256 is
`15889231a22297fcf001ae22ca01e6e8c9cd7489dd635c60529dfdc0ac06461e`, byte-equal
to `accounting.censusFunctionSha256` in
`g3/structure-correction/qualified-final/support/source-cost.json`. Token-lines
are that function's; physical lines are the census script's own newline count;
bytes are UTF-8 length, cross-checked against `statSync` size for every file (0
mismatches). `scripts/measure-raptor3-baseline.mjs` extracts the same function
the same way, so this is the repository's own recipe, not a second definition.

**Reproduction of the G3 closure.** The same 30-file list measured at
`0cc61e61`:

| Scope | files | bytes | physical | token-lines | G3 recorded | match |
| --- | --- | --- | --- | --- | --- | --- |
| candidate core | 12 | 230,397 | 6,997 | **6,927** | 6,927 | exact |
| complete charged | 30 | 499,927 | 14,486 | **11,849** | 11,849 | exact |

Summing the per-file records inside `source-cost.json` reproduces its own group
totals too (language 3,197 / shared 3,730 / retained 4,922), so both the recipe
and the published figures are reproducible.

**The frozen tree.**

| Scope | files | bytes | physical | token-lines |
| --- | --- | --- | --- | --- |
| candidate **core** (`commands/` 7 + `shared/` 5) | 12 | 363,744 | 10,335 | **9,407** |
| language 7 | 7 | 127,060 | 3,664 | 3,417 |
| shared 5 | 5 | 236,684 | 6,671 | 5,990 |
| retained 18 | 18 | 270,439 | 7,506 | 4,927 |
| **G3 30-file complete charged perimeter, re-measured** | 30 | 634,183 | 17,841 | **14,334** |
| whole `raptor3` tree (`.ts`) | 15 | 399,356 | 11,349 | 10,280 |
| `route/client-route.ts` (whole, new in G4) | 1 | 14,880 | 378 | **247** |
| `program/` specimen (not in the commands perimeter) | 2 | 20,732 | 636 | 626 |

**G4 charged additions outside the G3 perimeter** — `git diff --numstat 0cc61e61`
for the added/deleted lines, and the same census run against `git show
0cc61e61:<file>` for the token-line/byte delta:

| File | numstat +/− | Δ bytes | Δ physical | Δ token-lines | in the G3 perimeter |
| --- | --- | --- | --- | --- | --- |
| `src/query-engine/pending-operation.ts` | +126 / −17 | +4,313 | +109 | **+70** | no — charged here |
| `src/client/client.ts` | +31 / −4 | +740 | +27 | **+23** | no — charged here |
| `src/query-engine/query-engine.ts` | +12 / −2 | +430 | +10 | **+5** | no — charged here |
| `src/adapters/database-adapter.ts` | +13 / −0 | +737 | +13 | **+1** | no — charged here |
| `src/adapters/databases/mysql/mysql-adapter.ts` | +5 / −0 | +251 | +5 | +2 | yes — counted whole above |
| `src/adapters/databases/postgres/postgres-adapter.ts` | +5 / −0 | +287 | +5 | +1 | yes |
| `src/adapters/databases/sqlite/sqlite-adapter.ts` | +7 / −0 | +371 | +7 | +2 | yes |

Charged deltas outside the perimeter: **+99** token-lines / +159 physical /
+6,220 bytes. The three dialect adapters are inside the perimeter and are
counted whole there; their +5 is reported but not added twice.

**The complete charged candidate at the freeze**

| | files | bytes | physical | token-lines |
| --- | --- | --- | --- | --- |
| G3 perimeter re-measured | 30 | 634,183 | 17,841 | 14,334 |
| + `route/client-route.ts` | 1 | 14,880 | 378 | 247 |
| + charged deltas outside it | — | 6,220 | 159 | 99 |
| **total** | **31** | **655,283** | **18,378** | **14,680** |

**Against the G3 closure and the shipped perimeter**

| Comparison | token-lines | physical | bytes |
| --- | --- | --- | --- |
| core, G3 closure → freeze | 6,927 → 9,407 (**+2,480**, +35.8 %) | 6,997 → 10,335 | 230,397 → 363,744 |
| 30-file perimeter, G3 closure → freeze | 11,849 → 14,334 (**+2,485**, +21.0 %) | 14,486 → 17,841 | 499,927 → 634,183 |
| complete charged incl. G4 additions | 11,849 → 14,680 (**+2,831**, +23.9 %) | 14,486 → 18,378 | 499,927 → 655,283 |
| candidate ÷ shipped charged perimeter (171 files / 53,787 / 70,983 / 2,511,682) | **27.3 %** (target ≤ 60 %) | **25.9 %** (target ≤ 70 %) | 26.1 % |

The +2,485 perimeter delta is the +2,480 core delta plus exactly the three
dialect adapters' +5; every other retained file is byte-identical to
`0cc61e61` (checked file by file).

**Growth explained** — per-file core delta, `0cc61e61` → freeze
([`core-per-file-delta.txt`](root-review-probes/D/receipts/core-per-file-delta.txt)):

| file | base | freeze | Δ |
| --- | --- | --- | --- |
| `shared/query.ts` | 1,635 | 3,568 | **+1,933** |
| `shared/operation-context.ts` | 1,591 | 1,781 | +190 |
| `shared/schema.ts` | 289 | 410 | +121 |
| `commands/commands.ts` | 1,124 | 1,225 | +101 |
| `commands/index.ts` | 100 | 176 | +76 |
| `commands/selection.ts` | 142 | 162 | +20 |
| `commands/relation-body.ts` | 848 | 867 | +19 |
| `shared/storage.ts` | 199 | 215 | +16 |
| `commands/execution.ts` | 745 | 754 | +9 |
| `commands/command-attempt.ts`, `shared/transport-attempt.ts` | 85, 16 | 85, 16 | 0 |
| `commands/assignments.ts` | 153 | 148 | **−5** |

78 % of the core growth is `shared/query.ts` — the read/filter/ordering/paging/
projection vocabulary G4-01 owed; the envelope rule, the admission views and
the read dispatch account for most of the rest. Nothing grew in the two attempt
files, and `assignments.ts` shrank.

**Per-unit cumulative deltas, reconciled.** Each row is one tree state in the
order the tree reached it, so the deltas sum to the measured total. Sources are
the units' own cost sections.

| Tree state | core token-lines | Δ | owner |
| --- | --- | --- | --- |
| `0cc61e61` | 6,927 | — | — |
| G4-01 r2 | 8,573 | +1,646 | G4-01 |
| G4-01 r3 | 8,626 | +53 | G4-01 |
| G4-01 r4 | 8,641 | +15 | G4-01 |
| G4-02 phase 1 (measured on the r4 tree) | 8,982 | +341 | G4-02 |
| G4-01 r5 merged into the phase-2 tree | 9,001 | +19 | G4-01 |
| G4-02 phase 2 | 9,227 | +226 | G4-02 |
| G4-02 phase-2 repairs | 9,277 | +50 | G4-02 |
| G4-02 closure | 9,337 | +60 | G4-02 |
| G4-02 closure r2 | 9,342 | +5 | G4-02 |
| G4-02 closure r3 | 9,357 | +15 | G4-02 |
| decisions unit | 9,398 | +41 | decisions |
| freeze r1 | 9,406 | +8 | freeze |
| freeze r2 | 9,407 | +1 | freeze |
| **measured at the freeze** | **9,407** | **+2,480** | — |

Per unit: **G4-01 +1,733**, **G4-02 +697**, decisions +41, freeze +9, G4-03 **0**
(by construction — it added no line to `commands/` or `shared/`), witness/harness
**0** (tests and scripts only). Sum 2,480 = measured 2,480, no residual.

Outside the core: `route/client-route.ts` 143 at the G4-03 close → 144 at
G4-03b → **247** at the freeze, the +103 being the G4-02 closure's work on the
transferred route (cache codec composition, prepared-read consumption);
`pending-operation.ts` +68 → +70, `client.ts` +20 → +23, `query-engine.ts` +5
unchanged. Two reconciliation residuals, both explained and both nits:
G4-02's own eight-file phase-1 increment reads +345 against a slightly
different eight-file base where the tree-state delta is +341; and unit01's
derived r5 perimeter of 13,582 is confirmed correct at its own state
(8,660 core + 4,922 retained), the freeze figure being 9,407 + 4,927 = 14,334.

**Test and harness lines, counted separately** (plan §7; not charged): 199 new
files — 31,867 token-lines / 38,124 physical / 1,306,678 bytes — of which the
registered estate is 64 files / 14,473 token-lines and the reviewers' kept probe
estate under `tests/raptor3/g4/review/` is 135 files / 17,394 token-lines; plus
1,715 added and 88 deleted lines across 18 tracked harness files.

### D-3 — "Bundle fixtures measured on the candidate-only package … against the frozen baseline"

**Recorded, not produced here.** `scripts/measure-raptor3-baseline.mjs --bundle`
needs: `rolldown` resolvable through tsdown's require (1.0.0-beta.58 in both
existing receipts); the three frozen fixtures it carries inline — `engine`
(`QueryEngine` + `createModelRegistry` + `PendingOperation`), `pg-simple` and
`pg-relations` (both through `src/index.ts` + `src/drivers/pg/index.ts`); the
protocol `target node22`, `format esm`, `minify`, `treeshake`,
`inlineDynamicImports`, gzip level 9, `externalByFixture`, Node built-ins and
`bun:*` external; and a warning-free build — its `onwarn` throws on any warning.
It does not refuse a dirty tree: it records `source.clean` and attests contents
through `sourceIdentity`.

The existing figures, read from the receipts rather than reproduced:

| Fixture | frozen baseline (`baseline.json`, commit `3a291a59`) | candidate-only package (`g4/cutover/bundles.json`, commit `981368f6`, clean) | ratio | target |
| --- | --- | --- | --- | --- |
| `engine` gzip | 156,771 | **37,260** | **0.238** | ≤ 0.75 |
| `pg-simple` gzip | 262,658 | **182,872** | **0.696** | ≤ 1.00 |
| `pg-relations` gzip | 262,788 | **183,018** | **0.696** | ≤ 1.00 |

`bundleProtocol` is byte-identical between the two receipts (`jq -cS` compare),
and the tool versions match except the Node runtime (see note 6).

What this review could **not** produce, and who owns it:

1. **The frozen tree's own bundle fixtures.** Not run: a rolldown build competing
   with six campaign lanes and the main-tree serial chain risks perturbing their
   wall and sampled-RSS ceilings. The question it would answer — does the
   additive candidate enlarge the public client bundle — is answered statically
   instead: **no candidate module enters any of the three fixtures' runtime
   module graphs** (345 / 396 / 396 modules reached, 0 from
   `src/query-engine/raptor3/`), because all three seams import the route
   **type-only** (`client.ts:72`, `query-engine.ts:18`,
   `pending-operation.ts:46–49` (the `import type` block closing at :49)). The residual effect is bounded by the +182 /
   −23 seam lines themselves, which is unmeasured.
2. **Runtime bytes and declaration bytes** (plan §7's reporting list) — produced
   by `measure-raptor3-baseline.mjs`, not run here.
3. **Parser-token counts** — the plan's accounting rule is token-lines and this
   census reports token-lines, physical lines and bytes only.
4. **The candidate-only package measurement** belongs to the cutover-measurement
   unit; its bundle receipt exists (the table above) and its stage-2 receipts
   were still landing during this review (`cutover/performance.json` at 20:25).

## Findings

All seven are **notes**. None meets the REVISE bar (a receipt whose identity
does not match the frozen one and whose unit did not re-run, a deleted evidence
directory, or a census that cannot be reproduced).

1. **note — the G3 cumulative complete-charged guidepost is crossed, and no G4
   guidepost was set.** Plan §7's size table carries "G3 cumulative complete
   charged production guidepost | 14,000 code-bearing LOC | Review trigger, not
   an automatic stop-loss verdict". The re-measured 30-file perimeter is
   **14,334** and the complete charged candidate is **14,680**. `unit01/note.md`
   "Cost after Repair 3" still states "The G3 complete-charged guidepost of
   14,000 code-bearing lines is still not crossed (13,582)" — correct at that
   state, superseded at the freeze. *Resolution:* the adoption report states the
   guidepost is exceeded, that it is a G3 guidepost with no G4 successor, and
   that both binding §7 targets are met with margin (27.3 % against ≤ 60 %,
   25.9 % against ≤ 70 %). No code change.

2. **note — three shipped-engine owners the candidate newly retains at runtime
   are outside the charged perimeter.** `route/client-route.ts` imports
   `../../result/cache-value-codecs` at runtime (B-1c, accepted), which reaches
   `result/cache-json-codec.ts` and `result/cache-snapshot-structure.ts`. All
   three are `charged-engine` files in the G3 classification. The G3
   retained-owner rule charged `write-engine/parse-boundary.ts` whole on exactly
   that basis, so consistency argues for charging these too: 3 files / 695
   token-lines / 758 physical / 22,613 bytes, giving 34 files / **15,375**
   token-lines — still 28.6 % of the shipped perimeter. Recorded in the census as
   `g4CompleteCharged.withNewlyRetainedCacheOwners`, an alternative, not a
   substitution for the frozen G3 file list. *Resolution:* the adoption report
   picks one reading and says which; either way the targets hold.
   (Do not read the converse from
   [`reachability.json`](root-review-probes/D/receipts/reachability.json): the
   G3 charged files my static walk does not reach — the adapters, the drivers,
   `JunctionStatements.ts`, `types.ts` — are reached by injection or by
   type-only import, and the G3 list is the frozen recipe. This review did not
   re-derive it.)

3. **note — two units' "complete charged perimeter UNVERIFIED" labels are now
   discharged, and the notes are frozen.** `unit02/note.md` §R.6, §P.10 and
   §R6.7 each say the perimeter "stays UNVERIFIED … its charged-file manifest
   was never saved"; `unit01/note.md` r5 calls its perimeter figure "derived,
   not re-measured". The manifest does exist — `privateCandidates.candidates.
   commands.files` in the G3 receipt — and this review measures the perimeter
   from it on the frozen tree. *Resolution:* the adoption report cites
   `root-review-D-census.json` as the perimeter measurement; the frozen unit
   notes stay as written.

4. **note — four round-1 reviewer receipt directories carry no captured
   identity:** `unit02-review-receipts/`, `unit03-review/`,
   `witness-review-receipts/`, `witness-review-followup-receipts/`. Their review
   texts pin file-level SHA-256 instead (and `witness-review.md` names
   production `8704dcea…` in prose). Every unit behind them re-ran through
   several later accepted rounds that do carry identities, and the frozen tree
   is being qualified as a whole, so nothing rests on them. All later reviewer
   directories (`unit02-phase2-*`, `unit02-closure-*`) carry
   `identities-review-start.txt` / `identities-review-end.txt`. *Resolution:*
   none required; note the convention in the closure report.

5. **note — one dangling evidence link, resolved during the review.** At 20:23
   `g4/cutover/protocol.md:257` linked `cutover/performance.json`, the
   cutover-measurement unit's stage-2 output, which did not exist yet; it was
   the only miss in 937 relative links. The file landed at 20:25 and the
   re-run is clean: **974 links checked, 0 missing**, plus all 54 links in the
   ledger `g4.md`
   ([`link-check.json`](root-review-probes/D/receipts/link-check.json),
   [`ledger-link-check.json`](root-review-probes/D/receipts/ledger-link-check.json)).
   Recorded because the transient is the evidence that the probe detects a
   missing receipt at all. *Resolution:* none; the probe cell now asserts zero
   missing links and will fail on any future deletion.

6. **note — the frozen bundle baseline was measured on a different Node patch.**
   `docs/architecture/raptor3-evidence/baseline.json` records Node v24.20.0;
   `g4/cutover/bundles.json` records v24.21.0, which is what
   `RAPTOR3_MEASUREMENT_NODE_VERSION` pins. Bundler, minifier, compressor,
   TypeScript, target, externalization and the fixture sources are identical, so
   §7's "same versions and settings on both sides" is satisfied for everything
   it lists. The baseline is also an untracked file recorded at commit
   `3a291a59` with `clean: false`. *Resolution:* state both facts where the
   bundle ratios are reported.

7. **note — numbers this review could not produce** are listed under D-3 above:
   the frozen tree's own bundle fixtures, runtime and declaration bytes, parser
   tokens, and the candidate-only package measurement (the cutover unit's).

8. **note — eight stale campaign corpora sit untracked at the repository root**
   (`transport-{lost-progress,multifault,overlap,wrong-publication}-scripted-returning-{ack,weak}-corpus.json`,
   all dated 2026-09-09, 529 KB in total). They are the known corpus-at-root
   harness leak from the G3 era, not output of this qualification. They are
   outside both identity halves (which fingerprint `src`, `tests/raptor3`,
   `scripts`, `benchmarks` and the six config files) and outside every charged
   perimeter, so no figure in this report moves either way. *Resolution:*
   packaging should not carry them; deleting them is the integrator's call, not
   this review's.

## Evidence-directory inventory at the review

Recorded so a later comparison can detect a deletion. Files per directory:
`briefs` 15, `cutover` 37, `decisions-review-receipts` 36, `environment` 14,
`freeze` 49, `freeze-review-receipts` 48,
`harness-reconciliation-review-receipts` 31,
`harness-reconciliation-review-followup-receipts` 43, `qualified` 138 and
growing, `unit01` 93, `unit01-review` 13, `unit01-review-followup` 20,
`unit01-review-followup2` 29, `unit01-review-followup3` 28, `unit02` 598,
`unit02-review-receipts` 20, `unit02-review-followup-receipts` 29,
`unit02-phase2-review-receipts` 43, `unit02-phase2-review-followup-receipts` 51,
`unit02-phase2-review-followup2-receipts` 16,
`unit02-closure-review-receipts` 33,
`unit02-closure-review-followup-receipts` 34,
`unit02-closure-review-followup-2-receipts` 39, `unit03` 85, `unit03-review` 6,
`unit03-review-receipts` 19, `unit03b-review-receipts` 9,
`unit03b-review-followup-receipts` 10, `witness` 358, `witness-review-receipts`
9, `witness-review-followup-receipts` 28, `witness-followup-review-receipts` 30,
`witness-followup-review2-receipts` 20, `witness-followup-review3-receipts` 42,
`witness-followup-review4-receipts` 41, `root-review-probes` 7.

Every one of the 28 review rounds named in the ledger resolves to a receipts
location. Three write into an earlier round's directory rather than their own:
`unit03-review-followup.md` → `unit03-review-receipts/followup/`,
`unit03-review-followup-2.md` → `unit03-review-receipts/followup2/`, and
`freeze-review-followup.md` → `freeze-review-receipts/round2/`. Nothing is
missing.
