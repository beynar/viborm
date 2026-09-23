# G4 cutover — where the candidate's preparation time goes

Read-only diagnosis of the plan §7 performance failure recorded in
[`performance.json`](performance.json) and [`note.md`](note.md) §B7. It answers
one question with measurements: **which work makes the candidate's preparation
1.40×–2.15× the shipped engine's, and why is the shipped engine cheaper.**

- Candidate worktree: `/private/tmp/viborm-g4-perf-candidate`, branch
  `g4-perf-measurement`, `HEAD = 9086ad814173f5babfca32ad9187f4ae4eab508d`.
  **Unchanged and clean before and after this unit** (`git status --porcelain`
  empty, `HEAD` unmoved, `dist/` untouched — mtimes still 03:32).
- Baseline worktree: `/private/tmp/viborm-g4-perf-baseline`, branch
  `g4-perf-baseline-overlay`, `HEAD = e67b511b2c1e9db738b23ed5f6b6f1f16cd449b0`.
  Read only; unchanged and clean.
- `/Users/arnaud/code/viborm` was not executed in and not modified outside this
  file.
- All instrumentation lives in the session scratchpad
  (`…/scratchpad/perf-diag/`); the one rebuilt tree is a **copy** of the
  candidate whose 74 runtime `dist/*.mjs` files were verified byte-identical to
  the worktree's before it was patched.
- SQLite (better-sqlite3) only, Node v24.21.0, darwin/arm64, the same machine
  and the same ambient desktop load as the frozen series.

**This unit produces no §7 verdict.** Its A/B numbers are 3–5 alternating
fresh-process pairs per arm, not the frozen 20-cell protocol, and they were
taken under ambient load; they reproduce the frozen series' *ratios* to within
3–13 % and are used only to attribute time, never to pass or fail a cell.

---

## 0. Answer in one paragraph

The candidate's preparation is not slow because it plans more, resolves the
schema repeatedly, or validates twice. **It is slow because it constructs
JavaScript `Error` objects on the success path of every operation, and each one
captures a stack trace.** Two per-instance sentinel `Error`s are built in
`OperationContext`'s class-field initializers on every single operation; nested
writes additionally build `NestedWriteError`s at plan time as the "failure to
raise if this lookup finds nothing", each of which captures the stack **twice**.
Disabling stack capture (`Error.stackTraceLimit = 0`) removes **8.3–11.4 µs
CPU/op** from every regressed preparation cell and **21 µs CPU / 23 µs wall** from
the nested write — and removes **nothing at all** from the shipped engine, which
constructs no `Error` on those paths. That single class of defect is 41–67 % of
each preparation cell's CPU regression and more than 100 % of the nested writes'
wall regression. Underneath it the candidate's actual planning work is
*cheaper* than the shipped engine's (39.8 µs/op vs 42.8 µs/op on the nested
write) and its allocation is far lower (58 MB committed heap vs 181 MB).

---

## 1. Method

Three independent instruments, agreeing.

1. **Stage-partitioned CPU profiles.** `node:inspector` `Profiler` started and
   stopped **around the measured loop only** (module loading and fixture setup
   excluded), 50 µs sampling, driving the checkout's **own** unmodified harness
   (`benchmarks/operation-pipeline-workloads.mjs` → `createWorkloadHarness` →
   `harness[stage]`) — i.e. exactly the function
   `benchmarks/operation-pipeline-worker.mjs:361` measures. Every sample is
   mapped through the emitted `dist/*.mjs.map` sourcemaps back to original
   TypeScript, then attributed to the **innermost matching stage** on its caller
   chain, so the stages partition the profile with no double counting. Reported
   figures are the mean of 3 fresh processes per arm.
2. **A two-sided falsifier that changes no source.** The same driver with
   `Error.stackTraceLimit = 0` set after warm-up and before the measured loop.
   It removes stack capture and nothing else, and it is applied to **both**
   engines. A cause that is stack capture must move the candidate and leave the
   baseline flat; anything else must move neither.
3. **A rebuilt candidate.** A scratch copy of the candidate worktree, whose
   74 runtime `dist/*.mjs` were byte-identical to the worktree's before the
   patch, with the two sentinel `Error`s made lazy and `tsdown` re-run. It
   reproduces the falsifier's delta from real source, and it exercises the
   harness's own `assertSemanticDigest` and `observeBenchmarkContract`
   assertions on every build.

Plus `--trace-gc` counts, a V8 `HeapProfiler` allocation sampling pass, a
post-`gc()` retention series, and a driver-method counter for round trips.

Reproduction is in §7.

---

## 2. Ranked stage breakdown — `scalar-find-unique` / `prepare`

On-thread wall µs per operation, mean of 3 fresh processes, 20 000 iterations
after 2 000 warm-up, profiler overhead listed but excluded from the totals.
The measured cell is `prepareOperationPlan(makeOperation(), driver)` →
`prepareBatch` — the package seam, identical on both sides
([`protocol.md`](protocol.md) §2.1).

| # | Stage | Shipped µs/op | Candidate µs/op | Δ | Δ share |
|--:|---|---:|---:|---:|---:|
| 1 | **`OperationContext` construction** (`raptor3/shared/operation-context.ts`) | — | **9.31** | **+9.31** | **71 %** |
| 2 | main-thread GC | 1.36 | 2.70 | +1.33 | 10 % |
| 3 | query construction — candidate `Queries`+`Commands`+route vs shipped write-engine+builders+result+operations | 2.09 | 3.24 | +1.15 | 9 % |
| 4 | driver / execution context (`src/drivers`, `query-engine/execution-context.ts`) | 0.70 | 0.90 | +0.20 | 2 % |
| 5 | admission (`EngineSchema.admit` + `src/validation`) | 0.38 | 0.59 | +0.22 | 2 % |
| 6 | node builtins (incl. `crypto.randomUUID`) | 0.17 | 0.23 | +0.06 | <1 % |
| 7 | pending-operation / query-engine glue | 0.30 | 0.41 | +0.11 | <1 % |
| 8 | client proxy | 0.11 | 0.16 | +0.05 | <1 % |
| 9 | adapter lowering | 0.08 | 0.09 | +0.02 | <1 % |
| 10 | schema model access | 0.13 | 0.07 | −0.06 | — |
| 11 | `Sql` fragments (`src/sql`) | 0.93 | 0.83 | **−0.10** | — |
| 12 | benchmark harness (both sides' own) | 0.06 | 0.07 | +0.01 | — |
| | **Total (excl. profiler)** | **6.31** | **18.62** | **+12.31** | |
| | *(profiler overhead, excluded)* | *1.08* | *1.31* | | |

Measured without the profiler attached, same command shape, 5 alternating pairs:

| Arm | CPU µs/op | wall µs/op |
|---|---:|---:|
| shipped | 13.00 | 5.52 |
| candidate | 26.39 | 16.29 |
| ratio | **2.03** | **2.95** |
| *frozen series (`performance.json`)* | *2.154* | *2.638* |

**Stage 1 is one thing, and it is not "building the package".** The profile's
single largest self-time node is the class **field-initializer block** at
`src/query-engine/raptor3/shared/operation-context.ts:112`, entered from the
constructor at `:186`, 9.31 µs/op — larger than the shipped engine's entire
preparation (6.31 µs/op). The block runs on every `new OperationContext(...)`,
and it contains two eager `new Error(...)` (§4.1).

---

## 3. Ranked stage breakdown — `nested-conditional-found` / `full`

Mean of 3 fresh processes, 3 000 iterations after 600 warm-up. This is the cell
whose CPU improves (0.900) while its wall regresses (1.171).

| # | Stage | Shipped µs/op | Candidate µs/op | Δ |
|--:|---|---:|---:|---:|
| 1 | main-thread GC | 48.60 | 48.24 | −0.36 |
| 2 | write planning — shipped write-engine 24.83 + builders 8.99 + result 7.67 + operations 1.31; candidate `Commands` 29.51 + `Queries` 9.84 + route 0.43 | **42.80** | **39.78** | **−3.02** |
| 3 | driver / execution context | 16.53 | 15.78 | −0.75 |
| 4 | **`OperationContext` construction** | — | **13.44** | **+13.44** |
| 5 | `Sql` fragments | 6.02 | 4.81 | −1.21 |
| 6 | admission | 2.84 | 4.10 | +1.26 |
| 7 | adapter lowering | 1.95 | 1.67 | −0.28 |
| 8 | schema model access | 1.68 | 0.52 | −1.16 |
| 9 | pending-operation glue | 0.88 | 0.92 | +0.04 |
| 10 | client proxy | 0.38 | 0.48 | +0.10 |
| 11 | node builtins | 0.25 | 0.41 | +0.16 |
| | **Total (excl. profiler)** | **121.91** | **130.17** | **+8.26** |

Inside row 2's candidate figure, **15.44 µs/op is `NestedWriteError`
construction**, not planning: the profile's second-largest self-time node is
`src/errors/base.ts:233` (the `VibORMError` constructor) reached as
`relation @ raptor3/commands/relation-body.ts:186` →
`NestedWriteError @ src/errors/query.ts:162`, 46.31 ms over 3 000 operations.
Net of it the candidate's write planning is **24.3 µs/op against the shipped
engine's 42.8 µs/op** — a 1.76× improvement that the eager errors hide
completely.

---

## 4. The three causes

### 4.1 Cause 1 — eager `Error` construction on the success path (dominant)

**What.** Two classes of eager `Error`, both built when nothing has failed.

*1a — per-instance control-flow sentinels, on every operation:*

```
src/query-engine/raptor3/shared/operation-context.ts:158-160
  private readonly incompletePreparation = new Error(
    "Raptor 3 operation requires dynamic execution"
  );
src/query-engine/raptor3/shared/operation-context.ts:183-185
  private readonly requiresEnvelope = new Error(
    "Raptor 3 operation requires its physical envelope"
  );
```

Both are used **only by identity** — `operation-context.ts:525`
(`if (error !== this.requiresEnvelope) throw error`), `:1064`
(`return error === this.incompletePreparation`), and the throw sites at `:554`,
`:579`, `:682`, `:1318`, `:1600`. Neither is ever surfaced to a caller, so
neither needs a stack. One `OperationContext` is constructed per operation
(`raptor3/commands/index.ts:180-189` for `execute`, `:192-200` for
`prepareBatch`), so both `Error`s — and two full V8 stack captures — are paid on
every read and every write, prepared or executed.

*1b — plan-time failure objects for lookups that have not run yet, on nested
writes:*

```
src/query-engine/raptor3/commands/relation-body.ts:218   new NestedWriteError(  // disconnect/delete
src/query-engine/raptor3/commands/relation-body.ts:451   new NestedWriteError(  // connect/update
src/query-engine/raptor3/commands/relation-body.ts:460   lookup.retained = new NestedWriteError(  // connectOrCreate
src/query-engine/raptor3/commands/relation-body.ts:479   failure: new NestedWriteError(  // upsert / foundRequirement
src/query-engine/raptor3/commands/relation-body.ts:561   new NestedWriteError(  // updateMany/delete members
src/query-engine/raptor3/commands/relation-body.ts:639   new NestedWriteError(  // set targets
src/query-engine/raptor3/commands/relation-body.ts:678   failure: new NestedWriteError(  // absence requirement
```

Each one runs the whole `VibORMError` constructor
(`src/errors/base.ts:232-269`), which captures the stack **twice** — once
implicitly in `super(message)` at `:245` and once explicitly at `:266-268`
(`Error.captureStackTrace(this, this.constructor)`) — and additionally does
`new Date()`, `sanitizeErrorMetadata(...)` at `:249`, and
`registerTrustedError(...)` at `:254`, which sanitizes the metadata **a second
time** (`src/errors/diagnostics.ts:292`) plus `freezeDiagnosticValue`,
`boundTrustedString`, `safeDateString` and `Object.freeze`. The benchmark's
`connectOrCreate` recipe reaches at least `:460` and `:479` on every call.

**Why the shipped engine is cheaper here: it builds none of them.** The shipped
preparation path constructs no `Error` at all; the falsifier moves it by zero.

**Measurement.** `Error.stackTraceLimit = 0`, applied to both engines, 3–5
alternating fresh-process pairs per arm, medians:

| Cell | shipped CPU | shipped +`stackTraceLimit=0` | candidate CPU | candidate +`stackTraceLimit=0` | Δ candidate | share of the cell's CPU regression |
|---|---:|---:|---:|---:|---:|---:|
| `scalar-find-unique/prepare` | 13.00 | 12.93 | 26.39 | 18.35 | **−8.04** | **60 %** |
| `fixed-collection-rowref-20/prepare` | 27.65 | 27.27 | 43.65 | 32.86 | **−10.79** | **67 %** |
| `bulk-update-returning-100/prepare` | 25.01 | 25.09 | 44.99 | 33.57 | **−11.42** | **57 %** |
| `fixed-collection-rowref-1000/prepare` | 41.89 | 40.23 | 65.72 | 56.10 | **−9.62** | **41 %** |
| `scalar-find-unique/cold-prepare` | 162.15 | — | 190.74 | 175.33 | **−15.41** | **≈ 45 %** |
| `nested-conditional-found/full` | 179.46 | 183.36 | 158.35 | 137.34 | **−21.01** | wall: **−22.6**, vs a +15.8 wall regression |

The shipped column moves by −0.68…+0.08 µs/op — i.e. by nothing — on every row.

**Independent confirmation from source.** The scratch rebuild that replaces the
two sentinel fields with lazy getters (nothing else changed, `tsdown` re-run):

| Cell | candidate | candidate + lazy sentinels | shipped | new ratio |
|---|---:|---:|---:|---:|
| `scalar-find-unique/prepare` CPU | 26.39 | **17.41** | 13.00 | 2.03 → **1.34** |
| `scalar-find-unique/prepare` wall | 16.29 | **8.36** | 5.52 | 2.95 → **1.51** |
| `nested-conditional-found/full` CPU | 158.35 | **150.98** | 179.46 | 0.88 → **0.84** |
| `nested-conditional-found/full` wall | 113.75 | **106.57** | 105.67 | 1.08 → **1.01** |

The lazy-sentinel build's stage table shows the `OperationContext` bucket
collapsing from 9.31 to 0.40 µs/op, which is what a correct attribution
predicts. The 8.0 µs the falsifier finds and the 9.0 µs the rebuild finds agree.

The nested write's two effects split cleanly: sentinels ≈ 11.2 µs CPU / 9.2 µs
wall, plan-time `NestedWriteError`s ≈ 10.2 µs CPU / 13.4 µs wall.

**A microbenchmark of the field block alone** (200 000 reps at a 12-frame
stack) isolates which field costs what:

```
new Error(msg) ×1                            3.19 µs cpu
new Error(msg) ×2                            6.44 µs cpu
crypto.randomUUID()                          0.13 µs cpu
Set + WeakMap + WeakSet + 2 arrays           0.07 µs cpu
full field block (2 Errors + uuid + colls)   6.89 µs cpu
field block WITHOUT the 2 Errors             0.17 µs cpu
```

#### Bounded optimisation plan

| | |
|---|---|
| **Owner** | `src/query-engine/raptor3/shared/operation-context.ts` (1a) and `src/query-engine/raptor3/commands/relation-body.ts` + `src/errors/base.ts` (1b) |
| **Change 1a** | Make the two sentinels lazy (`private get incompletePreparation() { return (this.#sentinel ??= new Error(…)); }`) or, better, stop making them `Error`s: they are compared by identity and never surfaced, so a frozen branded object or a `Symbol`-tagged sentinel carries the same meaning at zero stack cost. Identity semantics are unchanged either way — the throw site materialises the sentinel before any comparison can see it. |
| **Change 1b** | Pass the failure **as a thunk** (`() => new NestedWriteError(…)`) through `Commands.lookup`, `Choose.foundRequirement.failure`, `lookup.retained` and `AbsenceRequirement.failure`, and call it at the one place the lookup actually fails. The seven sites in `relation-body.ts` are the only constructors; the consumers are the places that currently `throw`/attribute those values. |
| **Change 1c (independent, benefits both engines)** | `src/errors/base.ts:245` + `:266-268` capture the stack twice for every `VibORMError`; `:249` and `src/errors/diagnostics.ts:292` sanitize the metadata twice. One capture and one sanitize are sufficient. |
| **Expected gain** | `scalar-find-unique/prepare` 2.15× → **≈ 1.35×** CPU (measured on the rebuilt tree). `fixed-collection-rowref-20/prepare` 1.40× → **≈ 1.20×**. `bulk-update-returning-100/prepare` 1.66× → **≈ 1.34×**. `fixed-collection-rowref-1000/prepare` 1.59× → **≈ 1.39×**. `scalar-find-unique/cold-prepare` 1.08× → **≈ 1.00×**. `nested-conditional-found/full` wall 1.17× → **≈ 0.86×** (from a wall regression to a wall improvement); `nested-conditional-missing` and `key-transition-cascade` are the same shape and should follow. None of this closes the 5 % gate on the preparation cells by itself. |
| **Falsifier** | Re-run the frozen §7 protocol's preparation cells with `Error.stackTraceLimit = 0` exported on **both** sides. If the candidate's preparation CPU does not fall by 8–11 µs/op while the shipped side stays within its own MAD, this cause is wrong and the attribution must be redone. A second, cheaper falsifier: count `OperationContext` constructions per operation — if it is not exactly 1, the per-operation claim is wrong. |

### 4.2 Cause 2 — the candidate's per-operation object graph costs ~3× the shipped engine's in main-thread GC, at nearly equal allocated bytes

**What.** On the read preparation cell, V8 collects the candidate's young
generation **less often and far more expensively**. `--trace-gc`, same command,
22 000 operations:

| Side | scavenges | scavenge ms | major | total GC | per op |
|---|---:|---:|---:|---:|---:|
| shipped | 59 | 10.7 | 1 (1.5 ms) | 12.3 ms | **0.56 µs/op** |
| candidate | 23 | 36.4 | 2 (3.5 ms) | 39.9 ms | **1.81 µs/op** |
| candidate + lazy sentinels | 23 | 53.3 | 2 (4.0 ms) | 57.3 ms | 2.60 µs/op |

Steady-state trace lines:

```
shipped    Scavenge 36.3 (53.8) -> 20.5 (53.8) MB, 0.17 / 0.00 ms
candidate  Scavenge 110.7 (210.2) -> 64.5 (210.2) MB, 2.62 / 0.00 ms
```

The shipped engine scavenges a 54 MB heap in 0.17 ms; the candidate scavenges a
210 MB heap in 2.3–4.3 ms. V8 has grown the semi-space because more of each
operation's graph is still live when a scavenge lands, so survivors have to be
evacuated.

**What it is not.** Sampled allocation is nearly equal (candidate 25 312 B/op,
shipped 24 633 B/op — V8 `HeapProfiler`, 128 B interval), and **there is no
retention**: after forced `gc()` at four checkpoints across 20 000 operations,
both heaps are flat (shipped 15.35 → 15.46 MB, candidate 14.23 → 14.31 MB). So
this is object *shape and lifetime within the operation*, not a leak and not
gross allocation volume.

The top candidate allocators on the read preparation cell are
`lowerProjection @ raptor3/shared/query.ts:3202` (2 052 B/op),
`prepareProjection @ raptor3/shared/query.ts:2978` (1 860 B/op),
`projectedColumn @ raptor3/shared/query.ts:624` (1 175 B/op) and
`OperationContext`'s own constructor (889 + 636 B/op). One avoidable churn site
is `EngineSchema.scalars` (`raptor3/shared/schema.ts:518-524`), which builds
three intermediate arrays and an object via
`Object.fromEntries(names.filter(…).map(…))` on every call (0.94 µs/op self on
the nested write).

On **write** workloads the sign flips and favours the candidate — see §5.

#### Bounded optimisation plan

| | |
|---|---|
| **Owner** | `src/query-engine/raptor3/shared/query.ts` (`prepareProjection`, `lowerProjection`, `projectedColumn`) and `src/query-engine/raptor3/shared/schema.ts:518` |
| **Change** | Reduce the number of short-lived pointer-dense objects the projection lowering creates per operation: build `scalars` with a plain loop instead of `fromEntries(filter(map()))`; avoid materialising intermediate arrays in `lowerProjection`/`projectedColumn` where a single pass writes straight into the `Sql` fragment list. This is bounded to the three named functions — no contract, no shape, no SQL text changes. |
| **Expected gain** | 0.5–1.3 µs/op on `scalar-find-unique/prepare` (the GC delta is 1.33 µs/op; a realistic partial reduction is half of it). It will not, on its own, resolve any cell. |
| **Falsifier** | Re-run `--trace-gc` on the read preparation cell. If scavenge count and per-scavenge duration do not move toward the shipped engine's profile while allocated bytes/op stays flat, the change did not address the cause. Secondarily: if the `HeapProfiler` allocated-bytes/op figure *falls* materially, the original diagnosis ("equal bytes, worse graph") was wrong and the cause should be restated as volume. |

### 4.3 Cause 3 — nothing is reused between two identical operations, and the statement text drifts

**What.** Every client call rebuilds the whole preparation from scratch:

- `src/query-engine/raptor3/route/client-route.ts:167` calls
  `engine.prepare(modelName, operation, args)` fresh for each operation;
- `src/query-engine/raptor3/commands/index.ts:146-151` memoises admission and
  the prepared read **within one operation only** (`admitted ??=`,
  `prepared ??=`), never across operations;
- so `Queries.read` → `select` → `prepareProjection` / `lowerProjection` /
  `prepareSelector` re-derive the projection, the decoder and the `Sql` for the
  same `user.findUnique({where:{id}})` 20 000 times.

That work is 2.55 µs/op on the scalar read (row 3 of §2) and rises with the
projection's width: at `fixed-collection-rowref-1000/prepare` the residual after
removing Cause 1 is still **15.9 µs/op** (56.10 candidate vs 40.23 shipped, both
with stack capture disabled).

The shipped engine also re-derives per operation, so this is not "shipped caches
and candidate does not" — it is that the candidate's derivation is the more
expensive of the two and nothing amortises it.

**The drift.** `Queries` mints table aliases from an engine-lifetime counter:

```
src/query-engine/raptor3/shared/query.ts:478-486
export class Queries {
  private nextAlias = 0;
  …
  alias(): string { return `q${this.nextAlias++}`; }
```

So the same logical query emits `q0`, then `q1`, … `q10000`, and its SQL text
changes on every call — already recorded as a benchmark obstacle in
[`protocol.md`](protocol.md) §7.2 and
[`receipts-stage2/prepared-sql-alias-drift.json`](receipts-stage2/prepared-sql-alias-drift.json).
The shipped engine emits a stable `t0` and a constant 148-character statement.
On better-sqlite3 this costs nothing extra — `SQLite3Driver.runStatement`
(`src/drivers/sqlite3/index.ts:172-176`) calls `db.prepare(sql)` unconditionally
and better-sqlite3 keeps no text-keyed cache — but any driver or server that
caches by statement text (PostgreSQL named prepared statements, `mysql2`'s
prepare cache, D1/PlanetScale/Neon) will miss **every time** and will grow an
unbounded per-connection cache keyed on a counter that never repeats.

#### Bounded optimisation plan

| | |
|---|---|
| **Owner** | `src/query-engine/raptor3/shared/query.ts` (alias minting and `Queries.read`), `src/query-engine/raptor3/commands/index.ts` (the `prepare` handle) |
| **Change A (required, correctness-adjacent, cheap)** | Scope the alias counter to the **query being built**, not to the engine, so the same logical query always emits the same text. This is a rename of where `nextAlias` lives; it restores statement-text stability and lets `verifyCrossStageSemantics` compare modes again (`protocol.md` §7.2's split command shape then becomes unnecessary). |
| **Change B (optional, larger)** | Key a bounded shape cache on (model, operation, the *structure* of `args` — selection/include/orderBy/where operator skeleton, not its values) and reuse the prepared projection, decoder and `Sql` template, binding only the parameter values per call. Change A is a precondition: a cache is worthless while the text is unique per call. |
| **Expected gain** | Change A: ~0 µs/op on SQLite, and it removes a measured protocol obstacle. Change B: up to the full row-3 delta and most of the residual on wide reads — 1.2 µs/op on `scalar-find-unique/prepare` and ~10–16 µs/op on `fixed-collection-rowref-1000/prepare` — but it is a real design commitment and should not be undertaken before Cause 1 is fixed and the cells are re-measured. |
| **Falsifier** | Change A: assert that two successive identical `findUnique` calls on one client publish byte-identical `prepareBatch()` SQL. If they do not, the change is incomplete. Change B: if the re-measured `fixed-collection-rowref-1000/prepare` does not fall by more than `E` after the cache lands, the derivation was not the residual and the residual must be re-attributed. |

---

## 5. The wall-versus-CPU gap on nested/conditional writes, counted

`performance.json` reports `nested-conditional-found/full`,
`nested-conditional-missing/full` and `bulk-update-returning-100/full` as
**faster in CPU (0.874–0.925) and slower in wall (1.040–1.211)**;
[`note.md`](note.md) §B9.4 records the "more await points or more round trips"
reading as an inference that nothing counted. It is counted here, and **the
inference is wrong**.

Driver instrumentation wrapped around the fixture's own driver object (no source
change), one operation of `nested-conditional-found` on each side:

| | shipped | candidate |
|---|---:|---:|
| `driver.execute` calls (provider round trips) | **4** | **4** |
| `driver.executeRaw` calls | 0 | 0 |
| `withTransaction` scopes opened | **1** | **1** |
| microtask turns while the operation runs | 76 | 86 |

Same round trips, same transaction count — consistent with
`performance.json`'s own retained `observedStatementCount` of 4/4 for both
sides. Ten extra microtask turns cannot account for 15.8 µs.

What actually happens:

| | shipped | candidate |
|---|---:|---:|
| process CPU, all threads (`process.cpuUsage`) | 179.5 µs/op | 158.4 µs/op |
| **main-thread** time (CPU profile total) | **121.9 µs/op** | **130.2 µs/op** |
| implied off-main-thread CPU (≥) | 57.6 µs/op | 28.2 µs/op |
| scavenges per 3 600 operations | 39 | 48 |
| heap at scavenge (steady state) | 112.6 → 54.8 MB, 177 MB committed | 41.0 → 25.6 MB, 58 MB committed |
| scavenge duration (steady state) | 2.58 / 0.58 ms | 0.50 / 0.25 ms |
| GC time on the main thread | 10.83 µs/op | 7.61 µs/op |

The candidate allocates **far less** on the write path — a 58 MB committed heap
against the shipped engine's 177 MB, which is the same fact as the series' peak
RSS improvement (0.76–0.80, −25 to −32 MiB). Less garbage means V8's concurrent
marking and scavenging helpers do much less work, and that work is what
`process.cpuUsage()` counts and wall time does not. So:

> **CPU down is real and is the candidate's memory win being counted on helper
> threads. Wall up is also real and is entirely on the main thread — and on the
> main thread the candidate's extra 8.3 µs/op is 25.7 µs/op of eager `Error`
> construction (§4.1) minus 17.4 µs/op of genuinely cheaper planning, SQL and
> schema work.**

Removing the eager `Error`s turns this cell's wall ratio from 1.17 to ≈ 0.86
(measured: candidate 91.0 µs/op wall with stack capture disabled against the
shipped engine's 105.7, which the same switch does not move).

---

## 6. Negative results — hypotheses this unit tested and rejected

Recorded because they were named in the brief and because a cause list is only
useful if the discarded candidates are visible.

1. **"Repeated schema resolution."** Rejected. `EngineSchema.physicalField`
   (`raptor3/shared/schema.ts:498-509`), `storedFields` (`:510-517`),
   `clearability` (`:488-497`) are all memoised in `Map`s keyed by model, and
   the `schema model access` stage is *cheaper* on the candidate on both
   measured workloads (0.07 vs 0.13 µs/op on the read; 0.52 vs 1.68 on the
   nested write).
2. **"Validation of already-admitted values."** Rejected as a regression.
   Admission is memoised per operation (`commands/index.ts:146-147`,
   `admitted ??=`), and the client's own payload validation
   (`src/validation/primitives/object.ts:528`) costs 0.28 µs/op on the candidate
   against 0.22 on the shipped engine — the +0.22 µs/op admission delta is real
   but is 2 % of the gap, not a cause.
3. **"Allocation-heavy `Sql` fragments."** Rejected. The `src/sql` stage is
   *cheaper* on the candidate on both workloads (0.83 vs 0.93 µs/op on the read;
   4.81 vs 6.02 on the nested write).
4. **"The per-client alias counter costs CPU."** Rejected **on SQLite**:
   `runStatement` re-prepares unconditionally, so a stable alias would save
   nothing here. It is retained as Cause 3 for its statement-cache and
   measurement-protocol consequences, not for its CPU.
5. **"JSON/codec work at prepare time."** Rejected for the preparation cells:
   `cacheCodec` / `shapeCodec` / `leafCodec` (`route/client-route.ts:223-331`)
   are lazy behind `cacheResultCodec()` and do not appear in any preparation
   profile.
6. **"A retention leak in the candidate's prepare path."** Rejected: post-`gc()`
   heap is flat over 20 000 operations on both sides (§4.2).
7. **"More await points / round trips on nested writes."** Rejected by direct
   count (§5).

---

## 7. Reproduction

Everything below reads the two worktrees and writes only to a scratch
directory. Neither worktree is modified; `dist/` is not rebuilt in either.

The driver (`prof-stage.mjs`) is 60 lines and does exactly what
`benchmarks/operation-pipeline-worker.mjs` does, minus the protocol machinery:

```js
const { createWorkloadHarness } = await import(
  pathToFileURL(resolve(worktree, "benchmarks/operation-pipeline-workloads.mjs")).href
);
const { fixture, semanticFixture, harness } = await createWorkloadHarness(
  workloadName, stage, iterations + warmup, "sqlite3", worktree, "unextended"
);
const runOne = harness[stage];
for (let i = 0; i < warmup; i++) checksum += await runOne(i);
if (process.env.NO_STACK === "1") Error.stackTraceLimit = 0;   // the falsifier
// inspector Profiler.start() here, when profiling
const cpuBefore = process.cpuUsage(); const wallBefore = performance.now();
for (let i = 0; i < iterations; i++) checksum += await runOne(i);
```

```sh
# one arm
cd /private/tmp/viborm-g4-perf-candidate
TMPDIR=/private/tmp/viborm-g4-cutover-tmp node --expose-gc \
  <scratch>/prof-stage.mjs /private/tmp/viborm-g4-perf-candidate \
  scalar-find-unique prepare 20000 2000 [<out>.cpuprofile]

# the two-sided falsifier: prepend NO_STACK=1, run BOTH worktrees
# GC accounting
… node --expose-gc --trace-gc <scratch>/prof-stage.mjs …
# round-trip counting (wraps the fixture driver from outside)
… node --expose-gc <scratch>/count-roundtrips.mjs <worktree> nested-conditional-found full 200
```

Profiles are attributed with a sourcemap-aware analyser that maps each sample's
`callFrame` through `dist/*.mjs.map` and assigns it to the innermost matching
stage on its caller chain. Scratch artefacts for this unit:
`…/scratchpad/perf-diag/{prof-stage,analyze-stages,analyze-prof,analyze-paths,analyze-alloc,count-roundtrips,retain-stage,micro-fields}.mjs`,
`prof/*.cpuprofile`, `gc-*.log`, and the rebuilt tree `scratch-treat/`.
They are session-local and are **not** receipts of the frozen protocol.

---

## 8. Unverified claims

1. **No §7 verdict is produced or revised here.** The A/B figures are 3–5
   alternating fresh-process pairs under ambient desktop load, not the frozen
   20-cell protocol with its MAD-based `E`. They reproduce the frozen series'
   ratios to within 3–13 % and are used only to attribute time.
2. **SQLite only.** Every number is better-sqlite3. Cause 3's
   statement-cache consequence is *reasoned from source*
   (`src/drivers/sqlite3/index.ts:172`) and is **not** measured on PostgreSQL,
   MySQL or D1; the `g4.md` environment blocker stands.
3. **The lazy-sentinel rebuild is a measurement instrument, not a reviewed
   change.** It was type-checked only by `tsdown`'s own build and exercised only
   by the benchmark harness's `assertSemanticDigest` and
   `observeBenchmarkContract` assertions on the two workloads measured. No test
   suite, no typecheck run, no review. The expected gains in §4.1 are what that
   instrument measured, not what a merged change will deliver.
4. **Cause 1b was quantified by the stack-capture falsifier and by profile
   self-time, not by a source change.** No build exists in which the plan-time
   `NestedWriteError`s are lazy. The split "sentinels ≈ 11.2 µs, plan-time
   errors ≈ 10.2 µs" is the difference between two measurements, not two
   independent measurements.
5. **The per-operation `OperationContext` count (exactly 1) is read from
   source** (`raptor3/commands/index.ts:180`, `:192`), not counted at runtime.
6. **Allocation figures are V8 `HeapProfiler` sampling at a 128 B interval**,
   i.e. extrapolations. The `--trace-gc` young-generation fill rates imply
   ~53 kB/op (candidate) and ~43 kB/op (shipped) against the sampler's
   25.3/24.6 kB/op; the two agree on the ordering, not on the magnitude. The
   §4.2 claim rests on the *ratio*, and on the direct scavenge counts.
7. **`relation-series-2`'s contract divergence, the two `flat-scalar-update`
   cells recorded as not measurable comparably, and peak RSS were not
   re-examined.** This unit changes nothing about them.
8. **The residual after Cause 1 is not fully attributed.** On
   `scalar-find-unique/prepare` the lazy-sentinel build is still 1.34× the
   shipped engine in CPU; §4.2 and §4.3 account for roughly 2.5 µs/op of the
   ≈ 4.4 µs/op residual, and the remainder (driver/execution-context,
   admission, glue, ~0.6 µs/op) is measured but not explained.
9. **No claim is made that fixing Causes 1–3 brings any cell inside the 5 %
   budget.** The largest measured effect takes `scalar-find-unique/prepare` from
   2.15× to ≈ 1.35×, which still blocks adoption under plan §7.
