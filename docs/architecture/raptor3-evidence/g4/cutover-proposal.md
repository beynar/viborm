# C-01 cutover — proposal for Arnaud

**What this asks for: nothing yet.** It is the measured cost and consequence of
making the Raptor 3 route the only operation owner, so that the decision is
made against numbers rather than against a forecast. Nothing is pushed, the main
tree still contains and still uses the legacy engine, and no database was
changed.

Unit `g4-cutover-measurement`, stage 2b. Measured against the **second** frozen
identity, `g4/freeze/identity.json`
(`production fce8ec0cd32c839c5517a383d92f003e090e72cb8110b8ec0e08e1f7664d6904`);
the first freeze was superseded after a regression repair and its numbers are
retained only as receipts of that identity.

Full working record: [`g4/cutover/note.md`](cutover/note.md) (§§B0–B9 are this
stage). Protocol, written before the runs: [`g4/cutover/protocol.md`](cutover/protocol.md).

---

## 1. The recommendation in one paragraph

The **size** case is proven and is better than the targets: the comparable
engine bundle is **23.8 %** of the frozen baseline (target ≤ 75 %) and every
public PostgreSQL client fixture is **69.8 %** (target ≤ 100 %). The
**performance** case fails the plan §7 hard gate as the candidate stands:
of 20 frozen cells, **3 pass, 15 block adoption, 2 cannot be measured
comparably**. The regression is concentrated and legible — steady-state
**preparation** costs 1.4×–2.2× the shipped engine's CPU, on every workload,
with sub-1 % measurement noise and two independent series agreeing — while
**execution** is indistinguishable (0.96–1.03) and **peak memory** is equal or
much better (down to 0.76× on nested writes). One cell, `relation-series-2`,
is not a timing question at all: the candidate persists different primary keys,
which is a required contract divergence and blocks adoption on its own.
So: **do not cut over yet.** The cutover diff itself is clean and small; what it
is waiting on is a preparation-path optimisation pass and one contract repair,
both of which the measurements localise precisely.

---

## 2. The exact diff

Patch: [`g4/cutover/receipts-stage2b/cutover-identity2.patch`](cutover/receipts-stage2b/cutover-identity2.patch)
(`git diff cacb2827 0f09f7b6`, 4.4 MB, 239 files, **+106 / −115,495**).
It touches exactly the same 239 files as the stage-1 patch
[`cutover.patch`](cutover/cutover.patch), and the hunks for `client.ts`,
`query-engine.ts`, `pending-operation.ts` and the added
`routed-operations.ts` are byte-identical to it.

### 2.1 Nine production files change

| File | +/− | What |
| --- | ---: | --- |
| `src/client/client.ts` | +9 / −21 | the constructor calls `createCandidateRoute(...)` unconditionally; `VibORM.create` and the constructor lose their optional `route` parameter |
| `src/query-engine/pending-operation.ts` | +38 / −201 | every legacy arm deleted; only the route arm remains |
| `src/query-engine/query-engine.ts` | +4 / −14 | `operationExecutor` / `cacheOperationExecutor` and their imports deleted |
| `src/query-engine/raptor3/route/client-route.ts` | +3 / −17 | loses `createCandidateClient` and the `VibORM` value import |
| `src/query-engine/routed-operations.ts` | **+48 / −0** | the only file **added**: `READ_OPERATIONS`, `ROUTED_OPERATIONS`, `isReadOperation`, `isWriteOperation`, verbatim from the deleted `write-engine/routing.ts` |
| `src/extensions/definition.ts`, `methods.ts`, `query.ts`, `src/query-engine/cache-flow.ts` | +1 / −1 each | import re-pointed to `routed-operations` |

**The public surface does not change.** The parameter `VibORM.create` loses is
the non-public route selection (G4-03): it is absent from `createClient`, from
the package entry and from the docs, and only `createCandidateClient` ever
passed it. Nothing a user can write changes meaning.

### 2.2 What is deleted

**33 production owners, 28,740 lines** — full list with per-file counts in
[`deleted-src-owners-identity2.txt`](cutover/receipts-stage2b/deleted-src-owners-identity2.txt):

| Area | Files | Lines |
| --- | ---: | ---: |
| `src/query-engine/write-engine/` | 25 | 26,123 |
| `src/query-engine/` root owners (`OwnWriteSteps`, `OwnWriteAnalyzer`, `OwnWriteRelation`, `OwnWriteLedger`, `RelationMembership`, `relation-key-legality`, `validator`) | 7 | 2,485 |
| `src/query-engine/builders/to-one-composition.ts` | 1 | 132 |

Five largest: `RecordUpdateCompiler.ts` 5,803, `CreateOperation.ts` 4,315,
`RelationJunctionPart.ts` 3,464, `RelationWritePart.ts` 1,650,
`UpsertOperation.ts` 1,550. `src/**/*.ts` goes from 581 files to 549.
What replaces all of it is the 15 files and 11,631 lines under
`src/query-engine/raptor3/`.

**197 test files, 86,498 lines** are deleted with them
([`deleted-tests-identity2.txt`](cutover/receipts-stage2b/deleted-tests-identity2.txt)):
134 under `tests/contracts/` (130 of them `tests/contracts/engine/`), 26
`tests/raptor3/`, 19 `tests/pattern/`, 15 `tests/providers/`, 2 `tests/types/`,
1 `tests/unit/`. **No test body was edited.** A parity test that builds a shipped
client and a candidate client and compares them cannot be repaired once the
shipped side is gone without turning it into a candidate-versus-candidate
tautology; deleting and listing it is the honest disposition.

After all of that, `node scripts/run-typecheck.mjs` reports **exactly** the two
historical `pattern/pack.ts` TS2345 diagnostics and nothing else, and
`pnpm package:build` produces `dist/index.mjs`
([`typecheck-identity2-cutover.txt`](cutover/receipts-stage2b/typecheck-identity2-cutover.txt),
[`package-build-identity2.txt`](cutover/receipts-stage2b/package-build-identity2.txt)).

---

## 3. What the cutover costs the harness

### 3.1 Seven registered modes stop existing — and cannot be repaired

Of the 103 registered `run-raptor3` modes, **95 stay intact** and **7 break**,
all at the cutover seam, none at a legacy-engine import
([`registered-mode-impact-identity2.txt`](cutover/receipts-stage2b/registered-mode-impact-identity2.txt)):

| Mode | File | Why it breaks |
| --- | --- | --- |
| `g4-route-lifecycle` | `tests/raptor3/g4/route-lifecycle.test.ts` | uses `createCandidateClient` via `route-contract.ts:14` |
| `g4-route-admission` | `route-admission.test.ts` | builds a **shipped** client and a **candidate** client side by side (`VibORM.create(config, route)` at `:101`, `:414`) and compares them |
| `g4-route-cache` | `route-cache.test.ts` | `createCandidateClient` at `:25` |
| `g4-route-transactions` | `route-transactions.test.ts` | the same two-sided shape at `:110` |
| `g4-lifecycle-events` | `lifecycle-events.test.ts` | imports `./route-contract` at `:23` |
| `g4-lifecycle-admission` | `lifecycle-admission.test.ts` | imports `./route-contract` at `:18` |
| `g4-unit02-author` | `unit02/packaged-array.test.ts` | `createCandidateRoute` + `VibORM.create(config, route)` at `:23`, `:83` |

**These seven are pre-cutover instruments by construction.** Their entire value
is running one oracle twice — once against the shipped route as the control,
once against the candidate. After C-01 there is no control left to run. They
should be **retired**, not re-pointed at `createClient`: re-pointing them
produces a suite that compares the candidate with itself and reports green
forever. The honest replacements already exist and stay intact — `g4-read-*`
(9 modes), `g2-*`, `g3-*`, the generation campaigns — because they assert
against fixtures and oracles rather than against the other engine.

**Transitively**, the 111 deleted test files that import a deleted legacy owner
belong to **no** registered raptor3 mode: they are the shipped write-engine's own
contract suites (`tests/contracts/engine/**`, `tests/providers/**`,
`tests/pattern/**`), run by other vitest projects. Deleting the engine deletes
its suites; nothing re-points. A further 61 files are orphaned by those two
groups (they imported a deleted helper) and 25 use the removed cutover seam.

Three modes were **run** on the cutover build and all pass, with the counts the
pre-freeze stage recorded: `g4-read-contracts` (8 files / 62 tests),
`g3-execution-review` (1 / 6), `g2-contracts` (16 / 216).

### 3.2 One caveat on that count

Four `tests/raptor3/g4/unit02/` files are absent from the measurement worktree
for a reason that has nothing to do with the cutover — they were added to the
main tree after the measurement harness was copied. `g4-unit02-mysql-contracts`
is therefore **not** a cutover casualty even though it cannot run there. This is
recorded rather than folded into the 7.

---

## 4. Two things the cutover does not remove, and one it adds

### 4.1 `pattern/` keeps 25 owners alive, including three `write-engine/` files

The `pattern/` experiment is retained by instruction (the two permitted
typecheck diagnostics are pinned inside it). It is the sole remaining importer
of **25 production files, 7,855 lines** that the engine deletion would otherwise
orphan — 22 under `builders/` and `operations/`, plus
`write-engine/link-target-groups.ts`, `write-engine/series-result-read.ts` and
`write-engine/target-projection.ts`. In addition `src/query-engine/types.ts`
declares `PreparedBatchGuard.failure` as
`import("./write-engine/OperationFragment").Failure`, so the
`OperationFragment → record-series → OperationExecutor` chain must still
**resolve** for the typecheck. 18 `write-engine/` files and 7,961 lines survive
on disk.

**None of that ships.** The measured bundles are the authority, and they were
re-checked against this identity's `bundles.json`: the `engine` fixture renders
**no** `write-engine/` and **no** `operations/` or `pattern/` module at all, and
each public PostgreSQL fixture renders exactly two — `parse-boundary.ts` and
`OperationFragment.ts`. The reachability analysis behind the 25 owners is
[`pattern-retained-owners.json`](cutover/receipts-stage2/pattern-retained-owners.json);
the cutover's file set is identical at both identities and nothing under
`pattern/` changed in the freeze, so it carries over unchanged. Retiring `pattern/` (whenever
that is decided on its own merits) would delete those 25 owners as well; it is
not a cutover question.

### 4.2 The adapter contract gains one member: `expressions.integerDivide`

This is part of the **candidate**, not of C-01 — it is already in the frozen
production and would ship with the route whether or not the legacy engine is
deleted. It is called out here because it is the one place where the rewrite
changes a contract a third party implements.

`DatabaseAdapter.expressions` gains
`integerDivide: (left: Sql, right: Sql) => Sql`, implemented in all three
shipped adapters:

- **MySQL** `TRUNCATE(left / right, 0)` — `/` yields a DECIMAL quotient even for
  two integers;
- **PostgreSQL** `(left / right)` — integer division already truncates toward
  zero; casting either side would narrow a `bigint` operand to `int4`;
- **SQLite** `(left / CAST(right AS INTEGER))` — drivers bind JS numbers as REAL,
  so `x / ?` would otherwise run real division.

It is the **expression** form of a fact the contract already carried as an
**assignment**: `set.divide`'s `target.integer` flag. `Queries.updateValue` is
the single interpreter of admitted scalar update operators, and it needs the
same value in both places, so the alternative is JavaScript arithmetic beside
SQL — which the architecture rules forbid, and which would be wrong anyway
(MySQL and PostgreSQL ROUND on cast; only SQLite truncates).

**The decision this asks of you:** it is a minor, additive, three-dialect
adapter-contract addition, and a third-party `DatabaseAdapter` implementation
would fail to typecheck until it supplies the member. That is a public contract
change, small but real.

### 4.3 One localized type escape hatch in the cutover itself

§F says "`route` becomes required" on `QueryEngine`. The constructor parameter
was left optional and `PendingOperation` takes the route with **one** non-null
assertion (`engine.route as ClientOperationRoute`) plus a comment naming the
invariant: every client lineage installs the route in `VibORM`'s constructor and
`bind()` forwards it. Reason: `new QueryEngine(` appears 196 times in the estate,
194 of them in tests passing two arguments; typing the parameter as required
turns those into ~194 diagnostics unrelated to the cutover and would force ~194
further test deletions. There is no routeless path left for anything to take —
the escape hatch is the type, not a fallback. If you want the parameter made
genuinely required, that is a mechanical follow-up, and it costs those test
updates.

---

## 5. Bundles — every target met, with margin

`node scripts/measure-raptor3-baseline.mjs --bundle` in the measurement
worktree, against the frozen fixtures in
[`raptor3-evidence/baseline.json`](../baseline.json). Report
[`cutover/bundles.json`](cutover/bundles.json), ratios
[`cutover/bundle-ratios.json`](cutover/bundle-ratios.json).

| Fixture | baseline min+gzip | candidate min+gzip | **ratio** | §7 target | modules |
| --- | ---: | ---: | ---: | ---: | --- |
| comparable `engine` | 156,771 | 37,260 | **0.2377** | ≤ 0.75 | 241 → 93 |
| `pg-simple` (full public client) | 262,658 | 183,366 | **0.6981** | ≤ 1.00 | 427 → 311 |
| `pg-relations` (full public client) | 262,788 | 183,508 | **0.6983** | ≤ 1.00 | 427 → 311 |

Same bundler, minifier, target, gzip level, schema, query use and
externalization list on both sides; `bundleProtocol` is identical to the frozen
baseline's. The only tool difference is the Node patch version driving rolldown
(v24.20.0 frozen, v24.21.0 here — the pinned measurement runtime); V8,
TypeScript, tsdown, rolldown and biome versions are identical. Gzip sizes are
per fixture and are **not** additive.

---

## 6. Performance — the gate fails, and where

Protocol: the frozen 20-cell matrix, sqlite3, five alternating fresh-process
samples per side, `E = 2 × max(MAD)`, `(N − B) + E ≤ 0.05 × B` for time and
`≤ 0.10 × B` for peak RSS, no outlier removal. Because the candidate publishes a
prepared **package** and the shipped engine a single **statement**, preparation
is bracketed at the common enclosing boundary both own (`prepareBatch()`), via a
test-only phase adapter that is the same bytes on both checkouts and changes no
production file — the protocol document explains and falsifies it
([`protocol.md`](cutover/protocol.md) §§1–3). **Two full series** were run, the
second because three cells were inconclusive on the first; they agree cell for
cell. Per-cell `B`, `N`, both MADs, `E`, budget, every raw sample, the
preparation seam and the prepared SQL each side published are in
[`cutover/performance.json`](cutover/performance.json); raw evidence reports in
[`cutover/receipts-stage2b/cells/`](cutover/receipts-stage2b/cells/).

| Verdict | Cells |
| --- | ---: |
| pass | **3** |
| blocks adoption (resolved, over budget) | **11** |
| inconclusive after the one permitted repeat — blocks adoption | **3** |
| not measurable comparably — end-to-end evidence retained | **2** |
| blocks adoption — required contract divergence | **1** |

### 6.1 The shape of the result

**Preparation is the regression, and it is everywhere.** Both sides bracket the
identical seam (`package`, one statement) on each of these:

| Cell | CPU N/B (pass 1 / pass 2) | wall N/B |
| --- | ---: | ---: |
| `scalar-find-unique/prepare` | **2.154 / 2.152** | 2.638 / 2.672 |
| `fixed-collection-rowref-20/prepare` | **1.400 / 1.403** | 1.874 / 1.890 |
| `fixed-collection-rowref-1000/prepare` | **1.592 / 1.616** | 1.529 / 1.545 |
| `bulk-update-returning-100/prepare` | **1.656 / 1.607** | 1.586 / 1.530 |
| `scalar-find-unique/cold-prepare` | 1.084 / 1.100 | 1.138 / 1.143 |

MADs are under 1 % of the medians and the two series reproduce to three decimal
places; this is not noise. In absolute terms the smallest read's preparation
goes from **13.1 µs to 28.3 µs** of CPU.

**Execution is indistinguishable.** The three cells that pass are all `execute`
— `driver._executeRaw` on the statement the plan contains: 0.963–1.025 CPU
across both series. That is the control saying the harness measures the engines
and not itself.

**Peak memory passes everywhere it can be measured, and often wins big.**
`nested-conditional-found/full`, `nested-conditional-missing/full` and
`key-transition-cascade/full` run at **0.76–0.80** of the baseline's whole-worker
peak RSS — 25 to 32 MiB less — far beyond `E`. The only cell using more is
`scalar-find-unique/prepare` at 1.05, still inside the 10 % budget.

**Three nested/conditional writes are faster in CPU and slower in wall.**
`nested-conditional-*` and `key-transition-cascade` come in at 0.874–0.903 CPU
(a real improvement, beyond `E`) but 1.145–1.211 wall. CPU below with wall above
means time not spent computing — more await points or more round trips per
operation. The per-sample physical statement counts are retained in the receipts
and would settle which; this unit did not count them, so it is flagged as an
inference, not a finding.

### 6.2 The two cells that cannot be compared, and why that is honest

`flat-scalar-update/prepare` and `/execute` are recorded **"not measurable
comparably — end-to-end evidence retained"**, never as passed. The physical
reason (probed on the frozen build, and unchanged since the first freeze): the
shipped engine's package seam **refuses** this workload — *"Step 'user.update'
carries a postcondition that is not yet enforced in batch mode"* — and falls back
to one built statement, while the candidate's package holds **two**: a
`SELECT CASE WHEN EXISTS (…)` premise probe followed by the `UPDATE`. There is no
single-statement bracket on the candidate to time. The workload's end-to-end
`full` cell **was** measured, on both series, and it is a wall-time regression
(1.311 / 1.323) with CPU essentially equal (1.010 / 1.012) — consistent with the
extra round trip.

### 6.3 `relation-series-2` is not a performance problem

The candidate fails this workload's independent contract observation before any
timing is taken. On a fresh fixture,
`generatedParent.updateMany({ where: { id: { in: [5000, 6000] } }, data: { children: { create: { label: "series-child" } } } })`:

| | statements | `generatedChild.id` defaults evaluated | persisted child ids |
| --- | ---: | ---: | --- |
| shipped | 7 | **5** | **`series_child_3`** (5000), **`series_child_5`** (6000) |
| candidate | 3 \* | **3** | **`series_child_2`** (5000), **`series_child_3`** (6000) |

Both answer `{ count: 2 }`. The **persisted primary keys differ**. Under plan §7
"required contract divergences … 0" is a hard adoption requirement, so this
blocks adoption on its own, independently of every number above. It is also the
clearest single illustration of what the semantic comparison is for: a
statement-count improvement that changes what ends up in the database is not an
improvement.

Re-measured on this identity, through the public client with the frozen
assertion bypassed — the defaults and the persisted rows in the table above are
first-hand for both sides at identity 2
([`relation-series-2-identity2.json`](cutover/receipts-stage2b/relation-series-2-identity2.json)).
\* The candidate's physical statement count is the one figure carried forward
from the identity-1 receipt
([`relation-series-2-divergence.json`](cutover/receipts-stage2/relation-series-2-divergence.json)),
which also holds the full SQL of both sides: the candidate cannot be observed
through the harness at all, because the contract assertion throws before the
witness is read.

### 6.4 One thing worth fixing regardless of the cutover

The candidate's prepared SQL carries a **per-client monotonically increasing
table alias** — `q0`, `q1`, … `q10` — so the prepared text of the same
`findUnique` grows by six characters each time the alias gains a digit. The
shipped engine emits a stable `t0` and a constant 148-character statement. Any
driver or server prepared-statement cache keys on statement text, so this
defeats it. Receipt:
[`prepared-sql-alias-drift.json`](cutover/receipts-stage2/prepared-sql-alias-drift.json).

---

### 6.5 One SQL difference the semantic comparison allows, recorded anyway

On the most common read the two engines emit:

```sql
-- shipped
SELECT "t0"."id" …, "t0"."age" FROM "bench_users" AS "t0" WHERE "t0"."id" = ? LIMIT 1
-- candidate
SELECT "q0"."id" …, "q0"."age" FROM "bench_users" AS "q0" WHERE "q0"."id" = ?
```

The candidate drops `LIMIT 1` on a `findUnique`. The predicate is a unique key,
so the row count cannot differ and the semantic comparison accepts it — the cell
passes its contract observation on every sample. It is recorded because it is a
visible plan-shape change on the hottest path and only the unique constraint
makes it safe; both statements are retained per sample in
[`performance.json`](cutover/performance.json).

## 7. What is NOT done

- **Nothing is pushed.** Branches `g4-perf-measurement` (candidate, tip
  `9086ad81`) and `g4-perf-baseline-overlay` (baseline, tip `e67b511b`) are local
  and throwaway, in `/private/tmp/viborm-g4-perf-candidate` and
  `/private/tmp/viborm-g4-perf-baseline`. Both worktrees are left in place for
  the integrator.
- **The main tree is untouched apart from evidence.** `/Users/arnaud/code/viborm`
  keeps the legacy engine, keeps the optional `route` parameter, keeps all 197
  test files and all 103 modes. Nothing there was committed, staged, reset,
  stashed or deleted; the only writes were under
  `docs/architecture/raptor3-evidence/g4/cutover/` and this file.
- **No database was changed**, created or migrated. Every measurement is
  better-sqlite3 against the benchmark's own temporary fixtures.
- **SQLite only.** Nothing ran against native PostgreSQL or MySQL; the `g4.md`
  environment blocker stands, and the bundle fixtures are a build measurement,
  not a run.
- **95 of the 103 "intact" modes were not executed** — intact means every test
  file the mode names still exists. Three modes were actually run.
- **The adapter's falsifiers were not re-run for this identity.** The
  old-versus-old calibration, the changed-SQL / wrong-result specimens and the
  unchanged benchmark suites were established against the baseline overlay,
  which has not changed since. The comparator plumbing *was* re-validated
  against this exact commit pair with a `--smoke` run.
- **No production change was made to make anything measurable.** The phase
  adapter lives in `benchmarks/` only and is identical on both sides.

---

## 8. If you want to proceed, the order that follows from the evidence

1. **Fix `relation-series-2`.** It is a hard gate and it is a correctness
   question, not a budget question.
2. **Optimise preparation.** It is one path, it is 1.4×–2.2×, and it is
   measured with sub-1 % noise on five different workloads — including the
   `cold-prepare` cell, so it is not only steady-state caching. Re-run the same
   20 cells afterwards; the protocol and the harness are already in place.
3. **Then decide the round trips.** The wall-above-CPU signature on the three
   nested writes and on `flat-scalar-update/full` points at extra round trips
   per operation; the per-sample statement counts in the receipts will say.
4. **Fix the alias drift** (§6.4) whenever convenient — it is independent.
5. **Retire the seven two-sided modes at the cutover**, and say so in the
   commit rather than re-pointing them.
6. The **size** result does not need to be revisited: it is already well past
   its targets and the deletion it comes from is exactly the diff in §2.


## Integrator addendum (04:20, 2026-09-16)

Two read-only diagnostics ran after this proposal was written:

- `perf-diagnosis.md`: the preparation regression is eager `Error`
  construction on the success path (sentinel Errors in `OperationContext`,
  plan-time `NestedWriteError`s), each capturing a stack twice; removing it
  takes the worst cell from 2.03× to 1.34× CPU and the nested writes' wall to
  parity, and the candidate's planning, SQL, schema work and heap are all
  cheaper than the shipped engine's underneath. A bounded optimisation plan
  with owners and falsifiers is in the diagnosis; the §7 verdict stands until
  the cells are re-measured on a new freeze.
- `relation-series-2-classification.md`: the persisted-row divergence is the
  adjudicated default-evaluation difference (plan §2.3, 2026-09-08), not an
  engine defect; it is a frozen-contract blocker (the benchmark pins one
  ledger for both engines) recorded as decision D-8 in `g4.md`.
