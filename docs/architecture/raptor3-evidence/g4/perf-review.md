# Independent review — G4 performance pass, the safe fixes

Unit: `g4-perf-safe-fixes` (G4-02 author). Brief:
[`briefs/perf-safe-fixes.md`](briefs/perf-safe-fixes.md). Author's note:
[`perf/note.md`](perf/note.md). Diagnosis applied:
[`cutover/perf-diagnosis.md`](cutover/perf-diagnosis.md). Base: `0f25637b`.
Source reviewed: `/Users/arnaud/code/viborm` (main tree, the pass uncommitted).
Reviewer receipts: [`perf-review-receipts/`](perf-review-receipts/). Probes:
`tests/raptor3/g4/review/perf/` (3 files, 14 cells, all green, typecheck clean).

## Outcome

**REVISE** — two must-fix items, neither of them a behaviour change.

Everything the pass claims about the ENGINE holds. I could not find a single
observable difference: not a public answer, not a refusal sentence, not an error
class or `meta` (outside the decided R-D3 change), not a committed state, not a
statement or round-trip count, not an alias collision. The A/B reproduces
independently, closely, on three cells. The cost census, the production
identity, the harness identity and both closure patches all reproduce exactly.

What is wrong is on the *evidence* side of the §7 gate, and both parts are
small:

1. the benchmark assertion that replaces item 6's hard-coded `defaults.length
   === 5` cut is **tautological** — the fact it names ("series effects started
   before every member was admitted") is no longer asserted, and the note's §6
   claim that the engine's own constant is asserted at that cut is not what the
   code does (finding 1);
2. item 1's replacing invariant — the sentinel's memoised identity — has **no
   falsifier**: I broke it and every suite the brief names stayed green
   (finding 2).

Both are repaired by a handful of lines. No blocker, no stop rule, nothing that
should delay the re-qualification beyond those edits.

---

## 1. What I ran

One mode per call, through the bounded runner. Every count matches the author's
note §10 exactly.

| Mode | Author | Reviewer | Receipt |
| --- | --- | --- | --- |
| `g4-unit02-author` | 127 (19 files) | **127 (19)** | `g4-unit02-author.log` |
| `g4-unit02-mysql-contracts` (65515) | 17 | **17** | `g4-unit02-mysql-contracts.log` |
| `g4-unit02-pg-contracts` (65504) | 1 | **1** | `g4-unit02-pg-contracts.log` |
| `g4-read-contracts` | 62 | **62** | `g4-read-contracts.log` |
| `g4-route-lifecycle` | 8 | **8** | `g4-route-lifecycle.log` |
| `g4-route-admission` | 7 | **7** | `g4-route-admission.log` |
| `g4-route-cache` | 7 | **7** | `g4-route-cache.log` |
| `g4-route-transactions` | 13 | **13** | `g4-route-transactions.log` |
| `g4-lifecycle-events` | 3 | **3** | `g4-lifecycle-events.log` |
| `g4-lifecycle-admission` | 4 | **4** | `g4-lifecycle-admission.log` |
| `g3-execution-review` | 6 | **6** | `g3-execution-review.log` |
| `g3-bulk-series` | 6 | **6** | `g3-bulk-series.log` |
| `g3-transaction-array` | 4 | **4** | `g3-transaction-array.log` |
| `g3-suppression-retry` | 2 | **2** | `g3-suppression-retry.log` |
| `g2-contracts` | 216 (16 files) | **216 (16)** | `g2-contracts.log` |
| `g2-generated` | 52 | **52** | `g2-generated.log` |
| `g1-transport` | 44 | **44** | `g1-transport.log` |
| `g2-transport` | 16 | **16** | `g2-transport.log` |
| `g3-generated-transport-smoke` | 1 | **1** | `g3-generated-transport-smoke.log` |
| `g29-result-progress` | 2 | **2** | `g29-result-progress.log` |
| `g2-mysql-contracts` (65515) | 13 | **13** | `g2-mysql-contracts.log` |
| `g2-mysql-baseline` (65515) | 13 | **13** | `g2-mysql-baseline.log` |
| `g2-pg-contracts` (65504) | 18 | **18** | `g2-pg-contracts.log` |
| `node scripts/run-typecheck.mjs` | 2 permitted | **2 permitted** (`pack.ts:1443`, `:2633`) | `typecheck-final.log` |

Adjacent modes the pass could move, run in addition:

| Mode / file | Result |
| --- | --- |
| `post-g3-projection-preparation` (the `q0`/`q1` counter pins) | **4 passed** |
| `post-g3-selector-preparation` (the same) | **4 passed** |
| `cs01-structural-reference` | **10 passed** |
| `cs03-member-scope` (the CS-03 lookup recognizers) | **8 passed** |
| `g4-read-recursive-fit` (`Queries.recursive`, an alias owner) | **3 passed** |
| `g4-unit01-author` | **83 passed** |
| `tests/raptor3/g4/unit02/prepared-statement-stability.test.ts` (the new pin) | **3 passed** |
| `tests/raptor3/g4/review/unit02-decisions/` — **the item-5 pin the author could not execute** | **batch-publication-identity.review.test.ts 2 passed** (5 files, 5 passed / 1 skipped) |
| `cs02-structure-measure` | **red before it reaches a cell** — "Structural measurement requires its base identity file", the standing B-R1 registration defect; the author's edit to that file is validated by the typecheck, not by execution |

Author's unverified claim 3 (the item-5 review pin was edited but never run) is
now **verified**: it is green.

## 2. The diff, hunk by hunk

`git diff 0f25637b --stat` is 19 files / 1265 / 381. Three of them
(`CONTEXT.md`, `memory.md`, `tests/pattern/pack/program-dump.ts`) were dirty
before this pass and are untouched by it. `docs/.../g4.md` is the ledger.
The pass's own 14 files are exactly the ones the note names, and I verified
that independently: `git archive 0f25637b` into two scratch trees, overlay only
the pass's seven production files plus the contract workload, `diff -rq` →
**exactly eight differing files under `src/` + `benchmarks/`, no others**.

- **Item 1** (`shared/operation-context.ts:158-213`) — two `readonly` fields
  became `undefined` fields plus first-use getters. Every throw site and both
  identity comparisons are unchanged to the character (`:554`, `:579`, `:682`,
  `:1318`, `:1600`, `:525`, `:1089`). The `catch` survey in note §1.2 checks
  out: `execution.ts:382` is the one path that wraps a sentinel, and
  `attachRecordSeriesProgress` (`src/errors/record-series-progress.ts:26-28`)
  attaches `cause` only for an `Error` — so the lazy `Error` is the right
  choice over a branded object, and the note says so for the right reason.
- **Item 2** (`commands/selection.ts`, `commands.ts`, `relation-body.ts`,
  `execution.ts`) — `DeferredFailure = () => Error`. I checked every capture:
  `verb` and `edge` at `:219`/`:453`/`:463`/`:483`/`:566` are parameters of
  `RelationBody.relation(edge, verb, …)` and are never reassigned; `edge` at
  `:645` is a parameter of `setTargets`; `required` at `:685` is a `const` array
  built immediately above and never mutated. No closure captures a rebound
  variable. `execution.ts:270-281` preserves the `??` chain's semantics (a
  function is always truthy, and `new NotFoundError(…)` is still only built when
  both carriers are absent). `Condition.skip` — the one failure object that IS a
  `Map` key by identity (`commands/command-attempt.ts:23`,
  `execution.ts:173`/`:399`) and that is mutated after construction
  (`commands.ts:1178-1179`) — was correctly left eager. `Choose.conditions
  .missingRow` and `captureSeries`'s local `parentRequirement.failure` are also
  correctly left eager. I found no identity comparison, `WeakMap` key or
  post-construction mutation on any of the four thunked carriers.
- **Item 3** (`shared/query.ts:487-516`, six call sites) — `rootAlias()` resets
  and mints. See §3; this is the only item where a mistake would be silent, and
  it is the one I attacked hardest.
- **Item 4** (`shared/schema.ts:529-536`) — one loop, same keys, order, values,
  prototype. The three other `Object.fromEntries` in that file (`:182`, `:347`,
  `:464`) are different functions and are untouched, as the brief intended.
- **Item 5** (`shared/operation-context.ts:1868`) — class name only. Message and
  `meta { model, operation, field }` are byte-identical to `0f25637b` (I diffed
  the two raise sites). `UnsupportedOperationError extends QueryEngineError`, so
  `instanceof QueryEngineError` still holds; `code` moves V9001 → V8003 and
  `name` moves with the class. **`prismaCode` does not move**: neither
  `INTERNAL_ERROR` nor `UNSUPPORTED_OPERATION` is in
  `PRISMA_CODE_BY_VIBORM_CODE` (`src/errors/base.ts:161-177`), so both map to
  `undefined`. The note's "only `code` and `constructor.name` move" is exact.
- **Item 6** — `benchmarks/operation-pipeline-contract-workloads.mjs` only.
  `git diff 0f25637b --stat -- benchmarks/ scripts/` is that one file:
  **no `src/` file is touched by item 6**. `RAPTOR3_WORKLOAD_VERSION` is still
  `1` and the file is in `PROTOCOL_PATHS`
  (`benchmarks/operation-pipeline-protocol.mjs:16`), so the note's "the version
  need not change, the protocol hash changes mechanically" is right.
- **Item 7** — one sentence in `src/query-engine/raptor3/AGENTS.md`'s envelope
  paragraph, no code. See note 3 below about where the second half of item 7
  landed.

§7's four questions, answered against the diff myself: no second public-syntax
walker, no per-verb codec, no duplicated result-shape preparation, no recreated
lifecycle, no projection rebuilt for a decoder, no JavaScript arithmetic beside
SQL, no defensive re-validation, no policy-boolean bag, no per-feature
interpreter, no fixture-named flag, **no legacy import or fallback** (grepped
the seven changed files for `write-engine`/`operations/`/`result-engine`/
`query-builders` imports: none), no cached absence, no public contract change.
The claimed deletions did disappear: no `readonly incompletePreparation = new
Error` remains; all seven `new NestedWriteError(` in `relation-body.ts` sit
inside `() =>`; `Object.fromEntries` is gone from `EngineSchema.scalars`; the
hard-coded `=== 5` cut is gone from the workload.

## 3. Adversarial probes (`tests/raptor3/g4/review/perf/`, 14 cells)

### 3.1 `alias-scope.review.test.ts` — item 3's unproven sentence, measured

Item 3's safety rests on note §11 unverified claim 4: *"no statement owner is
entered while another statement is being built"*, established by reading
callers. If it is ever false, one statement declares `q0` twice and the SQL is
**silently wrong** — I confirmed the failure mode is silent, not a provider
error (§3.4). So I measured the claim instead of reading it:

- the six owners (`select`, `aggregated`, `grouped`, `selectSeries`,
  `recursive`, `junction`) are wrapped on `Queries.prototype` with a depth
  counter; a battery of **13 read shapes and 5 write shapes** on the G4 read
  world (compound mapped key, junction collection, variant collection,
  self-relation both directions, `_count`, nested pagination, cursor window,
  relation filter + relation order term, `count` with and without a selection,
  `aggregate`, `groupBy`, capped `updateMany`/`deleteMany`, nested junction
  `set`, nested to-many `update`, `createMany`) never re-enters an owner:
  `maxDepth === 1`, `entered === []`;
- **no published statement declares an alias twice**, across every shape;
- every shape publishes **byte-identical SQL over three passes**, with other
  operations minting aliases in between;
- on a batch-only (D1-shaped) driver a packaged root `update` queues its
  presence guard and its mutation on one `Queries` without a collision, three
  times identically.

I also dumped the write path's aliases directly: the capped `updateMany` /
`deleteMany` subquery, the junction `set` lookups and the nested to-many
`update` lookups each start their statement at `q0`, so the docblock's "every
statement starts at `q0`" holds for everything this battery reaches.

### 3.2 `deferred-failure-identity.review.test.ts` — item 2, six cells

Eight shapes reaching `relation-body.ts:219`, `:453` (both `connect` and
`update`, including a row owned by another parent), `:645`, `:685` and
`commands.ts:1285`, on a world with a REQUIRED foreign key so the absence
requirement is reachable. For each, the expected failure is **rebuilt in the
test from its own constructor** and compared field by field — `name`, `message`,
`code` and the whole `meta` — against what the engine raises. All eight match.
The same eight shapes raise the same `name`/`message` on the **shipped engine
over the same driver** (differential oracle, zero disagreements). Three of them
plus a succeeding `connectOrCreate` were re-run on a **batch-only driver**,
where `Selection.retained` lives: same sentences, and the `retained` thunk is
not raised when nothing is missing. Two raises of one plan produce **equal but
distinct** objects — which is safe exactly because nothing keys on identity.

### 3.3 `sentinel-and-scalars.review.test.ts` — items 1 and 4

- `prepareBatch` answers `undefined` for a dynamic nested write, four times,
  interleaved with a packageable read that still packages — the sentinel's throw
  and its identity comparison, exercised in both orders;
- a REAL refusal raised on the same preparation path still escapes
  `prepareBatch` and is never the sentinel's own sentence;
- the envelope sentinel's deferred re-entry still costs exactly one transaction
  and writes the child row;
- `EngineSchema.scalars` is compared against the verbatim
  `Object.fromEntries(names.filter(…).map(…))` expression it replaced on seven
  payload shapes (empty, partial, `0`/`""`/`null`, an explicit `undefined`, a
  relation key, a foreign key): same keys, same order, same value identity, same
  prototype;
- one precondition cell: `values[field] = value` and `Object.fromEntries`
  differ for exactly one key — `__proto__` hits the inherited setter instead of
  creating an own property. No model can declare that field today, so the trim
  is safe; the cell states the precondition so a schema change that allows it
  fails loudly instead of mutating a prototype. (Not a finding — a guard on the
  one real difference between the two expressions.)

### 3.4 Falsifications (each restored byte-identically from a scratch copy)

| Mutation | Effect | Restored |
| --- | --- | --- |
| `incompletePreparation` getter returns a fresh `Error` per read (drops `??=`) | `g4-unit02-author` 127/127, `g2-contracts` 216/216, `g2-generated` 52/52, `g4-route-cache` 7/7, `g4-route-transactions` 13/13, `g3-transaction-array` 4/4 — **all still green**; my probe cell 1 goes red. **Finding 2.** | `operation-context.ts` sha256 `53acb07c…`, production identity re-verified |
| `lowerRelationProjection`'s `childAlias` uses `rootAlias()` (a fragment opening a scope) | my duplicate-alias cell goes red with the collision printed: the nested subquery addresses the root's own `q0` and **the query still executes** — the failure mode is silent | `query.ts` sha256 `cf677d01…` |
| one word changed in my probe's expected `connect` sentence | probe cell 1 red (non-vacuity) | sha256 `831e2370…` |

## 4. The A/B, reproduced independently

Method: two fresh scratch trees of my own under the session scratchpad
(`review-ab/{before,after}`), each `git archive 0f25637b` of `src/ benchmarks/
scripts/ package.json tsconfig.json tsdown.config.ts vitest.*` plus the
committed `cutover/phase-adapter.patch`; AFTER carries only this pass's eight
files; the same two-line engine instrument in **both** trees (the package entry
re-exports `createCandidateClient`, the core fixture builds the measured client
with it under `VIBORM_BENCH_ENGINE=candidate`); `pnpm package:build` in each
(177 files each). 3 alternating fresh-process pairs per (cell, engine, arm),
medians, SQLite/better-sqlite3 12.6.0, node v24.21.0, darwin/arm64. Never run in
`/private/tmp/viborm-g4-perf-*`. Receipts:
`perf-review-receipts/review-ab-{samples.jsonl,summary.json,stage.mjs}`.

| Cell | Engine | CPU µs/op before → after | Author | wall before → after | Author |
| --- | --- | --- | --- | --- | --- |
| `scalar-find-unique/prepare` | shipped | 12.44 → 12.10 (−0.34) | −0.34 | 5.62 → 5.40 | −0.30 |
| | **candidate** | **25.37 → 15.82 (−9.55)** | −8.66 | **16.04 → 7.95 (−8.09)** | −7.21 |
| `fixed-collection-rowref-20/prepare` | shipped | 19.74 → 19.57 (−0.17) | +0.24 | 10.57 → 10.57 (0) | +0.19 |
| | **candidate** | **35.42 → 25.05 (−10.37)** | −9.83 | **20.87 → 12.77 (−8.10)** | −7.91 |
| `nested-conditional-found/full` | shipped | 196.91 → 193.45 (−3.46) | −3.05 | 127.72 → 125.16 | −1.80 |
| | **candidate** | **155.41 → 139.25 (−16.16)** | −16.53 | **125.01 → 98.61 (−26.40)** | −26.63 |

Ratios (candidate ÷ shipped), mine then the author's:

| Cell | CPU | author | wall | author |
| --- | --- | --- | --- | --- |
| `scalar-find-unique/prepare` | 2.04 → **1.31** | 2.015 → 1.370 | 2.85 → **1.47** | 2.723 → 1.565 |
| `fixed-collection-rowref-20/prepare` | 1.79 → **1.28** | 1.781 → 1.270 | 1.97 → **1.21** | 1.984 → 1.215 |
| `nested-conditional-found/full` | 0.79 → **0.72** | 0.800 → 0.727 | 0.98 → **0.79** | 0.998 → 0.800 |

**The claims reproduce.** Every arm agrees in sign and magnitude; the largest
disagreement is 0.9 µs/op on a 3-sample ambient-load measurement. Two direct
witnesses reproduce exactly, not approximately:

- **explicit stack captures per operation** on `nested-conditional-found/full`,
  candidate: **1.000 → 0.000** (item 2's plan-time errors, gone);
- **summed prepared-SQL length** over 20 000 `scalar-find-unique` preparations:
  **3 585 364 → 3 124 000** — the exact figures the note reports, i.e. the alias
  drift is gone and the text is constant at 156.2 chars.

Against the diagnosis's expectations: it predicted `scalar-find-unique/prepare`
CPU ≈ 1.35× (I measure **1.31×**), `fixed-collection-rowref-20/prepare` ≈ 1.20×
on its own instrument (I measure **1.28×** on this one), the nested write's wall
turning from a regression into an improvement (I measure **0.98 → 0.79**), and
an 8–11 µs/op fall on the preparation cell from item 1 alone (I measure **−9.55**
with items 1–4 together, of which the diagnosis attributes 8–11 to item 1).
**The gains are inside the diagnosis's expectations.** As the author says and I
repeat: attribution, not a verdict — no preparation cell is inside the §7 5 %
budget, and this is not the frozen 20-cell protocol.

I also reproduced item 6 end to end on the same trees:

| Arm | shipped | candidate |
| --- | --- | --- |
| **after** (this contract) | verified: 5 defaults, 7 statements, `series_child_3`/`_5` | verified: 3 defaults, 3 statements, `series_child_2`/`_3` |
| **before** (the frozen single-ledger contract) | verified | **fails** |

## 5. Evidence integrity

- `perf-pass.patch` sha256 `9c08bf5d…` — matches. It applies cleanly to a fresh
  `git archive 0f25637b` and reproduces **all 14 files byte-identically**
  (`cmp` on every path). Nothing in the working-tree diff is missing from it
  except the pre-existing dirty `tests/pattern/pack/program-dump.ts`, correctly
  excluded.
- `unit02/production-closure.patch` `c3df20e2…` and `unit02/tests-closure.patch`
  `4b509c38…` — both match, and both `git apply -R --check` cleanly against the
  working tree, so their `+` side IS the current tree.
- **Identity.** `captureRaptor3Identity().production` =
  `4fe5bd3dff280d2a498746733ed3f723872c0fb4c3dafb27bb817cf35f7457e4` — matches
  the note exactly (and re-verifies that every falsification above was restored
  byte-identically). `harness` recomputed with my four probe files excluded =
  `239c40dcd0f5fc1e7bf627841108296c1fc2b475f87b15d564da16c5cf37e24e` — matches.
- **Cost.** `node scripts/query-engine-structure.mjs` on the current tree:
  files 181, physical 86 727, token-lines **68 628**, functions 3 854, branch
  nodes 8 986, files over 300 lines 76 — identical to the author's `after`
  receipt, and `+22` token-lines over the `before` receipt (68 606). Confirmed.
- Failed attempts stay labelled failed; `cs02-structure-measure`'s red is
  recorded as pre-existing and I reproduced the failure mode (it aborts before
  any cell, on a missing base identity artifact, independent of the file's
  content).

## 6. Findings

### 1. must-fix — item 6's replacement for the `defaults.length === 5` cut is tautological, and the note claims otherwise

`benchmarks/operation-pipeline-contract-workloads.mjs:342-352` and `:311`.

`seriesLedger(x)` (`:62-74`) returns the ledger whose `seriesAdmissions(ledger)`
equals `x` — it asserts exactly one match and returns it. So at `:343-348`:

```js
const ledger = seriesLedger(defaults.length);
assert.equal(
  defaults.length,
  seriesAdmissions(ledger),          // === defaults.length, by construction
  "series effects started before every member was admitted"
);
```

compares `defaults.length` with itself. **That assertion can never fail**, and
its message names a fact nothing checks. Note §6 says the change asserts "the
engine's own constant at that cut" — it does not; it asserts membership of
`{3, 5}` (via `seriesLedger`'s own guard) and nothing more.

The engine-neutral replacement the note leads with,
`assert.equal(admissionsBeforeFirstEffect, defaults.length)` at `:311`, is also
near-vacuous, because `:349` **reassigns** `admissionsBeforeFirstEffect` on
every statement where a child is visible, not only the first. Traced on both
engines in my scratch trees (`perf-review-receipts/`, via a temporary
instrumentation of the scratch copy only):

```
shipped   assignments at statements 3,4,5,6,7 — defaults=5 each; final 5 → 5===5
candidate assignments at statements 2,3       — defaults=3 each; final 3 → 3===3
```

so the variable always ends up holding the final `defaults.length`. The
assertion can only fail if a default were evaluated *after the last statement*,
which is not the fact it claims to state.

Detection power is not lost outright — an ordering regression still turns the
cell red through `seriesLedger`'s "neither recorded engine ledger" guard or
through `assert.deepEqual(children[0], ledger.children[0])` — but it fails with
the wrong message, and the fact the brief asked to be asserted on both sides
("every member admitted before the first effect") is unasserted. This file is
about to be re-frozen into `protocolSha256`, so it is cheap to fix now and
expensive later.

*Reproduction:* `perf-review-receipts/` — read `:62-74` beside `:343-348`; the
assignment trace is reproduced by adding one `push` beside `:349` in a scratch
copy of the file and running `createWorkloadHarness("relation-series-2","full",…)`
on each engine.

*Resolution (2 lines):* assign once —
`admissionsBeforeFirstEffect ??= defaults.length;` at `:349` — and at `:311`
assert it against the FINAL ledger:
`assert.equal(admissionsBeforeFirstEffect, seriesAdmissions(seriesLedger(defaults.length)), "series effects started before every member was admitted")`.
Then drop the tautological `:344-348` (or keep only `seriesLedger`'s call,
whose own guard carries the real cut). That restores exactly the force the
hard-coded `=== 5` had, on both engines, without either engine's constant in
the source.

### 2. must-fix — item 1's replacing invariant has no falsifier

`src/query-engine/raptor3/shared/operation-context.ts:174-178`.

The §7 gate (common brief) requires the replacing invariant to have a falsifier
that fails when the invariant is broken. Item 1's invariant, as note §0/§1.2
states it, is *"the sentinel is materialised by the getter before any comparison
or throw can observe it, so identity is established at the first use in every
order"* — i.e. the `??=` memo is load-bearing. The falsifier the note offers is
the A/B measurement, which measures cost, not identity, plus "the estate is
byte-identical", which is a check that nothing broke, not a check that the
invariant holds.

Measured: dropping the memo (getter returns a fresh `Error` per read, nothing
else changed) leaves **`g4-unit02-author` 127/127, `g2-contracts` 216/216,
`g2-generated` 52/52, `g4-route-cache` 7/7, `g4-route-transactions` 13/13 and
`g3-transaction-array` 4/4 all green** — while `prepareBatch` stops answering
`undefined` for an unpackageable operation and instead throws its own
control-flow sentence, `Error: Raptor 3 operation requires dynamic execution`,
at the caller. No registered suite in the brief's list asserts that
`prepareBatch` answers `undefined`; I grepped `tests/`, `benchmarks/` and
`scripts/` for it and found only stubs.

*Reproduction:* replace the getter body at `:175-177` with
`return new Error("Raptor 3 operation requires dynamic execution");`, run any of
the modes above (green), then
`node scripts/run-vitest-safe.mjs run --workspace=tests/raptor3/g4/review/perf/perf-review.workspace.ts tests/raptor3/g4/review/perf/sentinel-and-scalars.review.test.ts`
— cell 1 red. Restore from a scratch copy (production identity re-verifies).

*Resolution:* register the cell. `tests/raptor3/g4/review/perf/sentinel-and-scalars.review.test.ts`
cell 1 is three assertions and has no reviewer-specific machinery — moving its
body into `tests/raptor3/g4/unit02/prepared-operation.test.ts` (which already
owns the `prepareBatch` boundary and is already inside `g4-unit02-author`) costs
one cell and closes the gate. The same file's item-4 cells are optional; the
sentinel cell is the one the gate needs.

### 3. note — brief item 7's "unit02 note row" was not written; the ledger was edited instead

Brief item 7 asks for "one sentence in the guide's envelope paragraph **and the
unit02 note row**". The guide sentence is there
(`src/query-engine/raptor3/AGENTS.md:411-423`, accurate and correctly scoped).
`docs/architecture/raptor3-evidence/g4/unit02/note.md` is **not modified** and
contains no `D-7.1`; the decision rows were written into
`docs/architecture/raptor3-evidence/g4.md` (the milestone ledger — D-7.1, D-8
and R-D3-class flipped to DECIDED, plus a new "Arnaud's morning decisions"
paragraph) instead. The ledger text is faithful to the brief and contradicts
nothing, so this is not a second authority — but the ledger is the integrator's
file and the row the brief named is still missing. *Resolution:* add the D-7.1
row to `g4/unit02/note.md`; leave the ledger edit for the integrator to confirm.

### 4. note — `perf-pass.patch`'s 14th file has no `diff --git` header

`docs/architecture/raptor3-evidence/g4/perf/perf-pass.patch:822`. The hunk for
the new `tests/raptor3/g4/unit02/prepared-statement-stability.test.ts` starts at
`--- a/… / +++ b/… / @@ -0,0 +1,157 @@` with no `diff --git` line and no
`new file mode`. `git apply` accepts it and it round-trips byte-identically (I
verified), but `git apply --stat`, `--numstat` and any consumer that keys on
`diff --git` will report **13** files where the note says 14. *Resolution:*
regenerate the patch so the new file carries a proper header.

### 5. note — the A/B instrument covers only the `core` fixture

`benchmarks/operation-pipeline-fixtures.mjs` in the scratch trees: the
`VIBORM_BENCH_ENGINE` switch is applied at the two `coreFixture` client
constructions and not at the `wide` / `variant` fixtures (`:507`, `:657` in the
archived file). All four cells the note reports are `core`
(`operation-pipeline-catalog.mjs:367`, `:386`, `:406`, `:449`), so no reported
number is affected — but the limit is not stated, and a later reuse of the same
instrument on a `wide-*` or `variant-*` cell would silently measure the shipped
engine in both arms. *Resolution:* one sentence in note §7.

### 6. note — `query.ts`'s `rootAlias` docblock is slightly stronger than the mechanism

`src/query-engine/raptor3/shared/query.ts:491-492` says "every statement starts
at `q0`". What the code enforces is narrower: *a statement whose first alias is
minted by one of the six owners* starts at `q0`. A statement whose first alias
comes from a `lower…` fragment (`lowerMutationLimit` at `:1040`, the two
`q.alias()` calls at `operation-context.ts:2031-2032`) starts wherever the
counter is. I could not construct a shape where that is observable — every
aliased statement in my 18-shape battery starts at `q0`, including the capped
mutation subquery — so this is wording, not behaviour. The rest of the docblock
already states the real rule. *Resolution:* soften the one clause.

### 7. note — recorded, not a defect

- `execution.ts:718` `failure: selection.required!` now stores a thunk behind a
  non-null assertion; if it were ever `undefined` the failure changes from
  `throw undefined` to a `TypeError`. It is unreachable — `child.requirement` is
  only set when a membership exists, and every series selection with a
  membership is built at `relation-body.ts:562` with a required thunk — but the
  `!` is now hiding a slightly different wrong answer than before.
- `execution.ts:248` calls `selection.retained()` unconditionally on the batch
  route, so `connectOrCreate` still pays one `NestedWriteError` construction per
  operation there. Same as before the pass, and outside the measured cell; worth
  knowing when the remaining residual is re-attributed.
- The cross-stream touch of `tests/raptor3/core-structure/{measurement/cs02-structure-measure,structural-reference}.test.ts`
  (three `new X(…)` → `() => new X(…)`) is declared, mechanical, and the
  alternative was a red whole-estate typecheck, which the brief also forbids. I
  agree with the choice; the integrator should still confirm it with that
  stream.

## 7. Unverified author claims, after review

| Claim | Status |
| --- | --- |
| §11.1 the A/B is attribution, not a verdict | **stands**, and I repeat it: 3 pairs, ambient load, SQLite only |
| §11.2 the candidate arm is `createCandidateClient`, not the cutover tree's default route | **still unverified** — I used the same instrument, so my reproduction inherits it |
| §11.3 the item-5 review pin was edited but not executed | **now verified**: 2 cells green |
| §11.4 item 3's "no statement owner is entered while another statement is being built" is read, not measured | **now measured**: 18 shapes, no re-entry, no duplicate alias, stable text (§3.1) |
| §11.5 item 3's statement-cache benefit on PG/MySQL/D1 is reasoned, not measured | **still unverified** — SQLite text stability is measured, the transport benefit is not |
| §11.6 the closure-patch lineage is exact for six files, approximate for two | **stands**; the property that matters — the `+` side is the current tree — I verified by reverse-apply |
| §11.7 `cs02-structure-measure`'s red is the pre-existing B-R1 defect | **confirmed by mechanism**: the mode aborts on "Structural measurement requires its base identity file" before reaching any cell, independent of the file's content |
| §11.8 peak RSS is the measuring process's, no claim made | **stands** |
| §6 "plus the engine's own constant at that cut" | **false** — see finding 1 |
| §0/§1.2 item 1's falsifier | **insufficient** — see finding 2 |
