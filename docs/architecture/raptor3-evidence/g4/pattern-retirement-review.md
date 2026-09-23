# Pattern retirement (D-15) — independent review

**Unit.** `pattern-retirement` — retire the `pattern/` experiment and every
production owner it alone kept alive.
**Brief.** [`g4/briefs/pattern-retirement.md`](briefs/pattern-retirement.md)
(with [`common.md`](briefs/common.md) and [`review.md`](briefs/review.md)).
**Author note.** [`g4/pattern-retirement/note.md`](pattern-retirement/note.md).
**Patch.** [`g4/pattern-retirement/retirement.patch`](pattern-retirement/retirement.patch).
**Base.** `e8114ed9daa808b38234d80cf30547943b013e29` (commit 4, C-01), which is
the main tree's `HEAD`; the working tree carries the change.
**Reviewer receipts.** [`pattern-retirement-review-receipts/`](pattern-retirement-review-receipts/).
**Reviewer probes.** `tests/raptor3/g4/review/pattern-retirement/` (3 files, 29
cells, all green; run with
`node scripts/run-vitest-safe.mjs run --config tests/raptor3/g4/review/pattern-retirement/vitest.review.config.ts`).

---

## Outcome — **REVISE**

No blocking finding. The deletion itself is **correct and exactly reproduced**:
I re-derived the reachability from scratch with a different method (a real
`ts.Program` built from the 28 `tsdown` entry points, so TypeScript's own
resolver follows `import type` and `import("…")` type nodes), and the deleted
set is *exactly* the closure — not a file more, not a file less. Every
verification group I re-ran independently reproduces the author's counts, the
bundles are byte-identical, the cost census reproduces to the digit, and one of
the author's five self-declared unverified claims is now measured rather than
argued.

What needs fixing before the commit is **documentary**: the commit-message
draft misstates the insertion count, §0.3 misstates which production files
changed, and the retirement — 111 owners, 41,272 lines — ships with **no
registered falsifier**, only greps recorded in a note. Two must-fix items, eight
notes. None of them touches the code that ships.

---

## 1. What I verified, and how

### 1.1 Reachability, re-derived independently (brief item 1) — **CONFIRMED**

I did not re-run the author's `reachability.mjs`. I wrote
[`reach.mjs`](pattern-retirement-review-receipts/reach.mjs), which builds a real
`ts.Program` from the `tsdown.config.ts` entries against the repository's own
`tsconfig.json` and takes `program.getSourceFiles()` as the reachable set. That
is TypeScript's resolver, not a regex, so type-only edges and
`import("./x").T` type nodes are followed exactly as the compiler follows them.
It ran against a read-only `git archive` export of `e8114ed9`.

| | author | this review |
| --- | ---: | ---: |
| tsdown entry points | 28 | **28** |
| `src/**/*.ts` at the base | 549 | **549** |
| reachable from entries | 486 | **486** |
| reachable with `pattern/` seeded | 530 | **530** |
| `pattern/` files | 19 | **19** |
| retained ONLY via `pattern/` | 25 | **25** |

The 25 are the same 25 files as the stage-2 receipt
(`g4/cutover/receipts-stage2/pattern-retained-owners.json`) — I compared the
sorted lists programmatically: `identical to mine: true`, zero on both
differences. The author's three reconciliations of the stage-2 receipt's other
counts (29→28 entries, 11→19 `pattern/` files, 487→486 / 523→530) are correct.

**The closure is exact.** I rebuilt the post-change graph by taking the base
export, deleting `src/query-engine/pattern/`, and copying in the *current*
`types.ts` and `batch-error-attribution.ts` — i.e. the anchor cut, and nothing
else. Reachability on that tree gives 419 reachable of 530. Then:

```
19  pattern/**
25  only-via-pattern (already unreachable at the base)
67  freed by the type-anchor cut  (sim-unreachable minus base-unreachable)
───
111 expected deletions
111 actually deleted (base src files minus current src files)
EQUAL: true  ·  deleted-not-in-closure: []  ·  in-closure-but-kept: []
```

Receipts: [`base-noseed.json`](pattern-retirement-review-receipts/base-noseed.json),
[`base-seeded.json`](pattern-retirement-review-receipts/base-seeded.json),
[`sim.json`](pattern-retirement-review-receipts/sim.json),
[`deleted-src.json`](pattern-retirement-review-receipts/deleted-src.json),
[`expected-closure.json`](pattern-retirement-review-receipts/expected-closure.json),
[`freed-by-anchor.json`](pattern-retirement-review-receipts/freed-by-anchor.json).

**No surviving file imports a deleted one.** Two independent proofs: a
resolver-accurate scan of every first-party import specifier in every
`src/**/*.ts` (0 dangling, now a permanent probe cell — §3), and a whole-estate
typecheck at **zero** diagnostics with `tsconfig.json`'s `include` covering
`src/`, `tests/` and `benchmarks/`. **No BLOCK.**

The 19 pre-existing unreachable files (F-5) are untouched, and my run lists
exactly the same 19.

Per-directory line counts in note §3.1 reproduce to the line: 11/10,568 +
8/2,144 + 39/11,852 + 19/3,801 + 17/7,863 + 13/3,813 + 4/1,231 = **111 files /
41,272 lines**.

### 1.2 The type anchor (brief item 2) — **CONFIRMED**

- **Same shape.** `write-engine/OperationFragment.ts`'s `Failure` at `e8114ed9`
  and `types.ts`'s new `PreparedGuardFailure` are field-for-field identical
  (same four members, same optionality, same literal union). Pinned as a
  type-level cell (`expectTypeOf` both directions) in
  `retirement-closure.review.test.ts`.
- **One small owner, in the right place.** The interface sits at
  `src/query-engine/types.ts:70`, beside the five `PreparedBatchGuard` fields
  that file already declared (`:78`, with `failure` at `:82`); `types.ts` contains no `write-engine`
  string at all.
- **No re-created `OperationFragment`.** Nothing in `src/` declares
  `OperationFragment`, `PlanningFragment`, `StatementStep`, `GuardStep` or
  `RecordSeriesStep` (probe cell). No new file was created for the move
  (rule 12).
- **One construction.** `createFailureError` is declared in exactly one file,
  `batch-error-attribution.ts:20`, module-private, and its body is the base's
  verbatim. At the base its other callers were `pattern/execute/{batch,values}.ts`,
  `write-engine/OperationExecutor.ts` and `write-engine/series-result-read.ts`
  — all deleted (`git grep createFailureError e8114ed9`).
- **Every consumer reads the same type.** The only producer is
  `raptor3/shared/operation-context.ts#packagedPresence` (`:1032`) and the only
  consumer `batch-error-attribution.ts` (`sameAttribution` + three
  `createFailureError` calls). Both go through `PreparedBatchGuard.failure`.

**Behavioural parity, measured against an oracle.**
`type-anchor-parity.review.test.ts` re-implements the base's `createFailureError`
verbatim as an oracle and drives the shipped path
(`attributeOperationBatchError`) through all seven arms of the taxonomy ×
two attribution routes (statement-index and re-probe), comparing constructor,
message, `code`, `meta.raceable`, `meta.relation`, `meta.model`,
`meta.operation`. 14 cells, all equal. Arms the author's receipts do not
separate and I added: `kind: "query"` **with `raceable: true`** (the arm whose
explanatory comment was dropped in the move), `notFound` with a bogus declared
message (it must not reach the caller — it does not), and `nestedWrite` with
`relation` absent.

**Falsifier, exercised.** I removed the `raceable` mark from the `query` arm in
`batch-error-attribution.ts` (backup copied to the scratchpad first, per the
falsification protocol) and the probe went **2 cells red**, naming exactly that
arm. Restoring from the backup returned the file to
`sha256 252c1d1c289981c20406dd760e23036c4c3e08e5a058184f6c6eb5898bd405a3` and
`git diff --numstat` to `34 2`, and the probes to 29/29.

**Adversarial attribution cells** the author did not run, all green: two guards
differing ONLY in `raceable` → un-attributable (raw error stands); two differing
ONLY in `relation` → un-attributable; two identical guards with clean probes →
attributable to the shared failure; a guard-free batch → the shared
`NESTED_WRITE_ASSERTION_FLOOR_MESSAGE` floor with V7006 and a cause attached; a
non-assertion error → passed through by identity.

### 1.3 Survivors and wrapper-only shells (brief item 3) — **CONFIRMED**

I recomputed every survivor's importer set from the current tree. The result is
the note's §3.2 table, exactly, with no extra and no missing edge:

```
write-engine/parse-boundary.ts   <= raptor3/shared/schema.ts
operations/groupby-fields.ts     <= result/result-shape.ts
result/result-shape.ts           <= client/typescript-type-renderer.ts
result/result-column.ts          <= client/typescript-type-renderer.ts, result/cache-result-codec.ts
result/result-aggregate-leaf.ts  <= client/typescript-type-renderer.ts, result/cache-result-codec.ts
result/cache-result-codec.ts     <= query-engine/cache-flow.ts, query-engine/pending-operation.ts
result/cache-value-codecs.ts     <= raptor3/route/client-route.ts, result/cache-result-codec.ts
result/cache-json-codec.ts       <= result/cache-value-codecs.ts
result/cache-snapshot-structure.ts <= result/cache-json-codec.ts, result/cache-value-codecs.ts
builders/                        — directory gone
```

No survivor is a wrapper-only shell: `parse-boundary.ts` (98 lines) carries the
one validated-parse assertion and the upsert envelope schema;
`groupby-fields.ts` (17 lines) carries a duplicate-column refusal;
the seven `result/` survivors are 55–506 lines of cache and result-shape logic.
`write-engine/shared.ts`'s only cross-layer export **was** a one-line re-export
of `@errors` (`shared.ts:755` at `e8114ed9` — verified), and the unit correctly
re-pointed its one harness consumer at the real owner and deleted the file.
`skippable-write.ts`'s only consumers at the base were `pattern/execute/transaction.ts`,
`write-engine/OperationExecutor.ts` and the one pruned driver cell; `raptor3/`
owns `skipDuplicates` / `recoverableUniqueError` itself
(`commands/commands.ts:1119–1131`, `shared/operation-context.ts:1373`).

### 1.4 Commands I ran (brief item 4)

Serially, one per invocation, under the workspace lock; no lock removed, no
database created or dropped.

| group | result | receipt |
| --- | --- | --- |
| `node scripts/run-typecheck.mjs`, **with my three probes present** | **ZERO diagnostics** (5.0 s, 4,896 MiB peak) — the terminating condition | [`typecheck-with-probes.txt`](pattern-retirement-review-receipts/typecheck-with-probes.txt) |
| reviewer probes | **29 / 29 green**, 3 files | [`review-probes.log`](pattern-retirement-review-receipts/review-probes.log) |
| `pnpm package:build` | exit 0, "Build complete in 2040ms", **181 files** | [`package-build.log`](pattern-retirement-review-receipts/package-build.log) |
| bundle measurement (`measure-raptor3-baseline.mjs --bundle`) | `engine` / `pg-simple` / `pg-relations` **runtimeBytes, gzipBytes and sha256 all equal** to round 3 | [`bundles-after.json`](pattern-retirement-review-receipts/bundles-after.json) |
| `pnpm test:core` | **6 failed files / 11 failed tests of 395 / 8,211** — the same six files and the same eleven cells as note §4.2 and as the base commit records | [`test-core.log`](pattern-retirement-review-receipts/test-core.log) |
| `pnpm test:coverage:policy` | **11/11 + 16/16 + 6/6**, exit 0 | [`coverage-policy.log`](pattern-retirement-review-receipts/coverage-policy.log) |
| `core-taxonomy-census.core.test.ts` | **4 / 4** (inside the core lane) | `test-core.log` |
| `run-raptor3.mjs g4-read-contracts` | **8 files / 62 tests**, gate verified | [`g4-read-contracts.log`](pattern-retirement-review-receipts/g4-read-contracts.log) |
| `run-raptor3.mjs g2-contracts` | **16 files / 216 tests** | [`g2-contracts.log`](pattern-retirement-review-receipts/g2-contracts.log) |
| `run-raptor3.mjs g4-unit02-author` | **21 files / 130 tests** | [`g4-unit02-author.log`](pattern-retirement-review-receipts/g4-unit02-author.log) |
| native PostgreSQL, `g2-pg-contracts` (port 55729) | **6 files / 18 tests** — the author's and round 3's count | [`native-pg-g2-contracts.log`](pattern-retirement-review-receipts/native-pg-g2-contracts.log) |
| native MySQL, `g4-unit02-mysql-contracts` (port 55730) | **3 files / 17 tests** — same | [`native-mysql-unit02.log`](pattern-retirement-review-receipts/native-mysql-unit02.log) |
| G4 read first child `g4-seed-batch 20000 --subject=candidate` | corpus **byte-identical** to the attempt-6 archive; body sha `55949767…`, 152,703 bytes both sides | [`g4-seed-batch-20000.log`](pattern-retirement-review-receipts/g4-seed-batch-20000.log) |
| G4 read first child `g4-transport-seed-batch 50000 --subject=candidate` | corpus **byte-identical**; body sha `2db16d09…`, 148,987 bytes both sides | [`g4-transport-seed-batch-50000.log`](pattern-retirement-review-receipts/g4-transport-seed-batch-50000.log) |
| structure census | queryEngine **38 / 16,980 / 14,511 / 986 / 2,280**, one cycle component of 2 files; writeEngine **1 / 98 / 41 / 2 / 3**, 0 cycles | [`structure-after.json`](pattern-retirement-review-receipts/structure-after.json) |
| `retirement.patch` | `git apply --check --reverse` **exit 0** against the working tree; `git apply --numstat` sums to **3,260 files / 220 insertions / 292,373 deletions**, the author's figures | — |

**Bundles, every byte.** I diffed my measurement's module tables against round
3's per fixture. Exactly the four facts the note names, and nothing else:
`order-by.ts` 3,490→3,571 (+81), `operation-context.ts` 60,668→60,727 /
60,896→60,955 (+59), `batch-error-attribution.ts` 3,494→4,359 (+865), and
`write-engine/OperationFragment.ts` (renderedLength 837, renderedExports
`["createFailureError"]`) **removed** from both PostgreSQL fixtures — net +168
pre-minification, zero post-minification. `write-engine/` now renders one
module where the public fixtures rendered two.

**Author receipt integrity.** The fixed-mode receipt is 59 modes, every one
`exit=0`, **1,701 cells**; parsed against round 3's receipt, **zero** cell-count
differences and no mode present in one and absent in the other. Native
PostgreSQL 12 modes / 64 cells and MySQL 11 / 69 likewise match round 3 exactly.
`deleted-src-owners.txt` lists the same 111 files my closure computed (zero
symmetric difference). `identity-after.json`'s production fingerprint
`841ae5fb3b1ea31ad9bdad2c531e74935172338b86c58667360d455cea205645` is the
fingerprint my own campaign reruns embedded — so `captureRaptor3Identity` is
reproduced, not merely reported. (My harness fingerprint necessarily differs:
my probe files are in the tree.)

### 1.5 The census (brief item 5) — **CONFIRMED, and one unverified claim upgraded**

| perimeter | files | bytes | physical | token | token ratio |
| --- | ---: | ---: | ---: | ---: | ---: |
| frozen baseline | 161 | 2,292,906 | 64,980 | 49,887 | 1.0000 |
| before, WITH the special case (round 3) | 139 | 1,423,012 | 42,335 | 31,664 | 0.6347 |
| before, WITHOUT it — **measured, not arithmetic** | 159 | 1,909,766 | 56,883 | 43,764 | **0.8773** |
| **after** | **48** | **536,396** | **15,656** | **11,732** | **0.2352** |

§7 verdicts, recomputed: charged production **token-LOC 0.2352 ≤ 0.60 — MET**;
**physical 0.2409 ≤ 0.70 — MET**; bytes 0.2339 (reported). The `accounting.excluded`
field is **absent** from the report, which is the note's own falsifier for the
"nothing is excluded" decision. `privateCandidates.candidates.commands.total`
moved 14,590 → 14,060 token-LOC (−530), as F-1 states.

The "0.8773 without the special case" row was the author's unverified claim #5
(declared "arithmetic, not a second instrument run"). I turned it into a
measurement: I copied the *current*, special-case-free
`measure-raptor3-baseline.mjs` into a read-only export of `e8114ed9` and ran it
there. Result: 159 / 1,909,766 / 56,883 / 43,764 → **0.8773 / 0.8754 / 0.8329** —
the note's row to the digit.
[`base-nospecialcase.json`](pattern-retirement-review-receipts/base-nospecialcase.json).

The author's unverified claim #1 (the transport corpus body hash) is also
resolved in the unit's favour: I compared both G4 read children against the
retained attempt-6 archives directly and both bodies are byte-identical, with
`2db16d09…` reproducing on both sides.

### 1.6 The §7 gate, applied to the diff myself

1. *Necessary decision or representation repair?* **Representation repair.**
   `PreparedBatchGuard` declared five fields and borrowed the sixth across a
   layer boundary; the edge is gone and the fact has one owner. Everything else
   is deletion.
2. *Exact deletion and replacement obligation?* Yes, and I checked the replacing
   invariants hold on disk: `raptor3/` grew by nothing (its `language` and
   `shared` token-LOC are unchanged), `builders/` does not exist, `write-engine/`
   is one file, `result/` is the seven cache/shape files. The *falsifiers*,
   however, are greps in a note rather than registered cells — finding 3.
3. *One rule across uses?* Yes — both consumers of the guard failure exercise
   the same declaration, and the oracle probe pins all seven arms.
4. *What grew?* Nothing. No second public-syntax walker, per-verb codec,
   duplicated result-shape preparation, recreated lifecycle, projection rebuilt
   for a decoder, JavaScript arithmetic beside SQL, defensive re-validation,
   policy-boolean bag, per-feature interpreter, fixture-named flag, legacy
   import, fallback, cached absence or public-contract change appears in the
   diff. The production insertion is 48 lines in two files plus 12 comment lines
   in two more.

---

## 2. Findings

### 2.1 must-fix — the commit-message draft misstates the insertion count

**Location.** `g4/pattern-retirement/note.md` §7 (commit-message draft, "+47
production lines, -2"), §5.4 ("Production insertions: 47 lines (types.ts +10,
batch-error-attribution.ts +37) … offset by −2"), §0.3, and the ledger entry in
`g4.md` ("41,272 lines deleted against 47 inserted").

**Reproduction.**

```
$ git diff --numstat e8114ed9 -- src/query-engine/types.ts src/query-engine/batch-error-attribution.ts
34  2  src/query-engine/batch-error-attribution.ts
14  1  src/query-engine/types.ts
$ git diff --numstat e8114ed9 -- 'src/***.ts' | awk '{a+=$1;d+=$2} END {print a,d}'
60 41285
```

The two anchor files are **+48 / −3**, not +47 / −2, and neither per-file figure
(+10, +37) matches its file (+14, +34). Across all production `.ts` the diff is
**+60 / −41,285**.

**Resolution.** Replace "+47 production lines, -2" with "+48 production lines,
-3" in the commit message; correct §5.4's per-file split to `types.ts +14/−1`
and `batch-error-attribution.ts +34/−2`; correct the `g4.md` ledger line. If the
all-`src` figure is wanted instead, say "+60 / −41,285 across `src/**/*.ts`,
of which 12 insertions are the two comment-only restatements".

### 2.2 must-fix — the retirement ships with no registered falsifier

**Location.** `g4/pattern-retirement/note.md` §0.4 (the falsifier column) and
`tests/contracts/engine/write/dead-symbol-gate.core.test.ts:26–41`.

**Why it matters.** §0.4 gives the three largest deleted decisions these
falsifiers: `grep -rn "query-engine/pattern" src/ tests/ scripts/` returns
nothing; "`src/query-engine/builders/` no longer exists"; "`write-engine/` holds
exactly one file". They are true today and recorded in `plan7-greps.txt`, but
nothing executes them. The previous deletion round (P6 Stage 4) did not leave it
that way: it left `dead-symbol-gate.core.test.ts`, registered in
`WRITE_ENGINE_CORE_TESTS`, precisely so "its absence [is] permanent". That gate's
`DELETED_V1_SYMBOLS` list stops at the P6 names, and its docblock still calls
`OperationExecutor` a *"kept lookalike"* that "never trips it" — a sentence that
is now false and that would let a resurrected `OperationExecutor` pass.

**Reproduction.** `grep -n "OperationExecutor" tests/contracts/engine/write/dead-symbol-gate.core.test.ts`
shows it only in the "kept lookalike" list; `node scripts/run-vitest-safe.mjs run
--workspace vitest.workspace.ts --project='layer-*'` passes with 111 owners
deleted and no cell asserting any of them is gone.

**Resolution.** Extend `DELETED_V1_SYMBOLS` with the D-15 names
(`OperationFragment`, `OperationExecutor`, `RecordSeriesOperation`,
`FragmentValidator`, `ResultParser`, `JunctionStatements`, `TargetConstraint`,
`executeSkippableWrite`, `uniqueConflictTarget`, …), add one cell asserting
`src/query-engine/builders` and `src/query-engine/pattern` do not exist and that
`src/query-engine/write-engine` holds exactly `parse-boundary.ts`, and correct
the stale "kept lookalike" sentence. Roughly fifteen lines in a file already in
the core lane. A working version of every one of those cells is in my probe
`tests/raptor3/g4/review/pattern-retirement/retirement-closure.review.test.ts`
and may be copied.

### 2.3 note — §0.3 names only two of the four changed production files

**Location.** `note.md` §0.3 ("No surviving production file changes except
`types.ts` (+10 / −1) and `batch-error-attribution.ts` (+37 / −1)").

`src/validation/relations/order-by.ts` (+5 / −4) and
`src/query-engine/raptor3/shared/operation-context.ts` (+7 / −6) also changed.
Both are comment-only and both are disclosed elsewhere (§3.6 and §4.1, and they
are visible as `renderedLength` deltas in the bundle receipt), so this is a
stale pre-work sentence rather than a concealment. **Resolution.** Amend §0.3 to
name all four and mark the last two comment-only.

### 2.4 note — a gate was deleted whole though two of its five cells kept a live subject

**Location.** deleted `tests/contracts/engine/write/architecture-gates.core.test.ts`
(readable at `e8114ed9`); `note.md` §3.3.

Cells (a), (c), (d) read `OperationExecutor.ts` / `OperationFragment.ts` and
genuinely lost their subject — the note's "three of its five cells have no
subject left" is exact. Cells (b) ("forbids adapters from constructing a Step",
scanning `src/adapters`) and (e) ("keeps write-engine runtime imports acyclic",
reading `scripts/query-engine-structure.mjs`'s `writeEngine.runtimeImportCycles`)
still have subjects and still pass on the retired tree — measured, not argued,
in my probe
`tests/raptor3/g4/review/pattern-retirement/dropped-gate-cells.review.test.ts`
(2/2 green). Cell (b) is now vacuous, cell (e) is a live if cheap ratchet.

**Resolution.** Say so in §3.3 — "(b) is vacuous now that nothing declares the
step vocabulary and (e) is trivially true at one file, so the whole file went" —
or keep cell (e) somewhere (`dead-symbol-gate` would host it).

### 2.5 note — an orphan snapshot survives its deleted suite

**Location.** `tests/contracts/engine/write/__snapshots__/architecture-gates.core.test.ts.snap`
(2,596 bytes, tracked at the base, untouched by the patch).

It is the frozen `OperationFragment` exported-type surface — a snapshot of a
file this unit deleted, whose owning suite this unit deleted.
`git status --porcelain -- tests/contracts/engine | grep -i snap` is empty.
**Resolution.** Delete it with the suite.

### 2.6 note — 27 provenance citations in surviving `src/` now name files that do not exist

**Locations** (file → cited path), from
[`stale-citations.json`](pattern-retirement-review-receipts/stale-citations.json):

```
raptor3/shared/query.ts            218,261,297,297,333,334,581,844,1879,2421
raptor3/shared/operation-context.ts 65,183,218,491,838,933,1221,1259
raptor3/shared/schema.ts           120,313,340
raptor3/commands/selection.ts      82
adapters/database-adapter.ts       664   → builders/many-to-many-utils.ts
adapters/databases/mysql/mysql-adapter.ts 886 → builders/many-to-many-utils.ts
adapters/adapter-capabilities.ts   42    → operations/bulk-limit.ts
schema/field-ref.ts                31    → {@link file://…/builders/where-builder.ts}
validation/scalars/negatable-filter.ts 12 → builders/where-builder.ts
```

The unit restated exactly the two docblocks the brief named
(`operation-context.ts:330`, `order-by.ts:74`) and added a blanket header to
`raptor3/AGENTS.md` telling the reader to follow such references in git history
at `e8114ed9` — a good mitigation for the 22 under `raptor3/`. It does not reach
the five outside it, and `schema/field-ref.ts:31` is an editor `{@link file://…}`
link that now resolves to nothing. **Resolution.** Extend the same one-line
pointer to those five (or restate them), and record the rest as a follow-up.

### 2.7 note — the parse-boundary ratchet now scans a one-file directory

**Location.** `tests/contracts/engine/write/parse-boundary-gate.core.test.ts:39`
(`const ENGINE = join(SOURCE_ROOT, "query-engine/write-engine")`).

The gate enumerates `write-engine/*.ts`, which is now exactly
`parse-boundary.ts`, so it no longer covers the shipped engine's parse
discipline at all. The note flags this generically (unverified claim #4, F-3)
but does not name the gate or its scope. **Resolution.** Add to F-2/F-3: "and
re-point `parse-boundary-gate.core.test.ts`'s `ENGINE` at `raptor3/` when
`parse-boundary.ts` moves".

### 2.8 note — harness line and document counts in §3.3 disagree with the author's own receipt

**Location.** `note.md` §3.3 ("33 `.ts` … = 8,645 lines", "3,039 golden JSON
documents").

`wc -l` over the 33 deleted `tests/pattern/**/*.ts` gives **9,812**, which is
also the total printed at the bottom of the author's own
`receipts/deleted-tests-pattern.txt`. The 3,039 non-`.ts` files are 3,036
`.json` + 1 `.jsonc` + 2 `.md`. (The 3,072 file total and the 13 MB are right,
and so is the 3,128 harness total — I reproduced both from `git status`.)
**Resolution.** Correct 8,645 → 9,812 and describe the 3,039 accurately.

### 2.9 note — the ledger silently rewrites three previously recorded timestamps

**Location.** `docs/architecture/raptor3-evidence/g4.md`, working-tree diff
against `e8114ed9`: "Cutover round 4: author done (01:45)" → "(00:57)",
"re-check: REVISE, documentary (02:15)" → "(01:32)", "Integrator's documentary
corrections (02:20)" → "(01:42)".

No note in this unit or in the ledger explains the correction. For reference,
`cutover-execution-review-round4.md`'s mtime is 01:53 and commit 4 is
`2026-09-17 01:57:02 +0200`, so the old numbers were indeed inconsistent with a
01:57 commit — but the new ones do not match the artefacts either. Note that
`g4.md` and `final-report.md` are being edited concurrently by the integrator
(the final report's working-tree diff already describes "Commit 5 … pending its
independent re-check"), so this may not be the unit's own edit.
**Resolution.** State the correction and its basis in the ledger entry, or
restore the recorded times.

### 2.10 note — §0.4 attributes the census special cases to the wrong script

**Location.** `note.md` §0.4, last row: "`scripts/query-engine-structure.mjs:114`
(`pattern/` exclusion) and `:356` (the `/pattern/` filter)".

`scripts/query-engine-structure.mjs` at `e8114ed9` is 278 lines and contains no
occurrence of the string `pattern` — `:356` does not exist. The special cases the
unit actually removed live in `scripts/measure-raptor3-baseline.mjs` at
`:114` and `:356`, and that is the file the patch edits. The brief made the same
mis-attribution, so the unit did the right thing and merely repeated the
brief's wording. **Resolution.** Name `measure-raptor3-baseline.mjs` in §0.4.

---

## 3. Probes kept

`tests/raptor3/g4/review/pattern-retirement/`, 3 files, 29 cells, all green,
typed cleanly (whole-estate typecheck is at **zero** diagnostics with them
present). Not registered in `scripts/raptor3-manifest.mjs` or
`vitest.workspace.ts` — a reviewer does not edit the author's shared manifests —
so they run through their own config:

```sh
node scripts/run-vitest-safe.mjs run \
  --config tests/raptor3/g4/review/pattern-retirement/vitest.review.config.ts
```

| file | what it pins |
| --- | --- |
| `type-anchor-parity.review.test.ts` | 20 cells. The base's `createFailureError` as an oracle, all 7 taxonomy arms × 2 attribution routes; `notFound` never leaks its declared message; competing guards differing only in `raceable` or only in `relation` stay un-attributable; identical guards are attributable; the guard-free floor; pass-through of a non-assertion error. **Falsified and restored** (§1.2). |
| `retirement-closure.review.test.ts` | 7 cells. Every first-party import specifier in `src/**/*.ts` resolves; `pattern/`, `builders/` and `tests/pattern/` are gone; `write-engine/`, `operations/` and `result/` hold exactly the named survivors; `createFailureError` is declared once; `types.ts` declares `PreparedGuardFailure` and mentions no `write-engine`; nothing re-creates the fragment vocabulary; the relocated shape is mutually assignable with the deleted declaration. |
| `dropped-gate-cells.review.test.ts` | 2 cells. The two cells of the deleted `architecture-gates.core.test.ts` whose subject survived still pass (finding 2.4). |

---

## 4. Unverified author claims, after this review

| claim | status |
| --- | --- |
| #1 the transport corpus body hash is not comparable with round 3's | **Resolved in the unit's favour.** Both G4 read corpora are byte-identical to the attempt-6 archives; `2db16d09…` reproduces on both sides. |
| #2 `pnpm test:all` was not run; the KNOWN-RED provider lanes were not re-run | **Still unverified.** Outside this brief's list, and I did not run them either. The argument (nothing deleted is reachable from them) is supported by §1.1's closure but remains an argument. |
| #3 the two coverage reports were not run | **Still unverified.** `test:coverage:policy`, which is what the brief lists, is green in my run. F-3 correctly records the floors as re-measurement work. |
| #4 the two ratchets now scan a much smaller tree | **Still unverified, and sharpened** — see finding 2.7: `parse-boundary-gate` scans exactly one file. |
| #5 the "before, without the special case" figure is arithmetic | **Now measured** (§1.5): 0.8773 / 0.8754 / 0.8329, exact. |

## 5. Blockers

None.
