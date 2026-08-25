# Operation-pipeline allocation and CPU optimization plan

> **Architecture baseline:** `4cf5c7fe` (`feat: unify relation cardinality`). The
> public relation language is `s.toOne` / `s.toMany`; the argument names either
> one fixed target or a map of variant targets. Slot cardinality is declared,
> while pairing, foreign-key ownership, uniqueness, row-reference versus
> junction storage, and slot emptiness are derived once by
> `src/schema/validation/relation-resolution.ts`. Every operation consumer reads
> the resulting `ResolvedRelationIndex`; no optimization in this plan may create
> a second topology map, cache, inverse scan, or target-getter path. See
> [`./global-relation-cardinality-plan.md`](./global-relation-cardinality-plan.md).

## Status

This is the active post-unification revision of the write-path micro-
optimization plan. It incorporates a source audit of the live driver,
instrumentation, query-construction, write-engine, executor, result-parser,
relation-resolution, and benchmark paths at `4cf5c7fe`.

Measured units below use the exact accepted baseline and candidate commits
recorded in their `/tmp/viborm-unit-*.json` reports. `4cf5c7fe` is the topology
and ownership baseline, not a claim that every later candidate was measured
directly against that commit.

The previous plan had the right instinct—remove work that does not contribute
to the selected execution—but several units were either unprovable with the
current benchmark, placed at the wrong ownership boundary, or observably
incorrect. This revision keeps the good local opportunities, removes the
unsafe ones, and adds larger candidates found during the wider audit.

The method is deliberately narrow:

1. Name the allocation or CPU work visible on a concrete operation shape.
2. Identify the existing semantic owner of that work.
3. Prove when the work is unnecessary without weakening the owner’s invariant.
4. Measure construction, execution, parsing, and full-operation stages
   separately.
5. Keep a change only when the targeted improvement exceeds measurement noise
   and no relevant behavior or full-operation workload regresses.

This is not a second query-engine compression project. It adds no execution
path, query cache, mutation DSL, provider strategy, lifecycle protocol, or
public API. An optimization that needs a new architectural truth does not
belong here.

## Outcome sought

Reduce per-operation allocations and CPU time on:

- flat scalar reads;
- flat scalar creates and updates;
- nested writes;
- fixed-target and variant-target relation reads across singular/collection
  cardinality and row-reference/junction storage;
- transaction and native atomic-batch execution.

Preserve:

- public APIs and result types;
- validation and error contracts;
- SQL, parameters, statement IDs, statement order, statement count, and round
  trips;
- guards, expectations, race pins, retries, and attribution;
- diagnostic redaction and pre-provider parameter snapshots when disclosure is
  enabled;
- provider value-conversion semantics;
- current direct, `RETURNING`, `ON CONFLICT`, CTE, planning-batch, atomic-batch,
  and record-series paths.

No fixed allocation or latency reduction is an acceptance requirement until
the corrected harness reproduces a stable baseline. The earlier forecasts of
`46.3 KB -> 38-40 KB` and `26 us -> 23-24 us` are hypotheses, not facts.

## Corrections to the original evidence

The old evidence paragraph must not be used as a baseline:

- `benchmarks/drizzle-memory-cpu.mjs` samples heap allocations at 4,096 bytes,
  not 1,024 bytes.
- It measures aggregate CPU with `process.cpuUsage()`. It does not run a 20 us
  inspector CPU sampler.
- Its VibORM seed callback calls async `_executeRaw()` from a synchronous loop
  without awaiting the returned promises.
- Its raw relation workload returns a flat join while VibORM and Drizzle build
  nested relation values. That is not equivalent result work.
- All libraries and stages run sequentially in one process. JIT state, heap
  history, profiler state, and database growth can bias later cases.
- The claimed `46.3 - 6.5` overhead is 39.8 KB, not approximately 36 KB.
- The driver-only 6.5 KB figure came from a scratch profiler that is not
  reproducible from the checked-in benchmark.
- The parser fast paths, distinct-truth closure, projection composition, and
  unified relation resolver already present at `4cf5c7fe` are the baseline.
  Do not compare candidates against a pre-closure or pre-unification copy.

## Fixed semantic contracts

### Diagnostic parameters

`_execute`, `_executeRaw`, and batch preparation currently snapshot diagnostic
parameters before provider access. This is intentional. Existing contracts
require diagnostics to show the original values even when:

- the caller later mutates its array or a nested object;
- the provider mutates the execution-parameter array;
- the provider mutates a nested object;
- an error or log is emitted after those mutations.

Therefore diagnostic snapshotting may become conditional on disclosure demand,
but it may not become a post-provider lazy snapshot.

The shallow execution-parameter copy also remains. It protects execution from
caller array mutation and is not the same concern as diagnostic sanitization.

### Execution context

A correlation ID and a context snapshot must remain stable across operation,
driver, transaction, batch, trace, log, and error attribution. A lazy
correlation getter by itself is not an optimization because
`snapshotExecutionContext()` immediately reads it. Laziness and trusted
snapshot reuse must be prototyped as one unit.

Externally supplied context objects remain hostile input: getters can throw and
properties can mutate. Identity reuse is allowed only for internally produced,
branded snapshots.

### OwnWrite

A relation-free root mutation has no nested OwnWrite interaction and can bypass
tree analysis. A relation-free nested record cannot do so automatically: it can
still contribute an insert barrier, scalar target footprint, key transition, or
ledger fact to its enclosing tree.

The early return therefore belongs only in
`assertCreateOwnWriteSafety()`/`assertUpdateOwnWriteSafety()`, before the root
tree is constructed. It does not belong in nested `analyzeCreate()` or
`analyzeUpdate()` methods.

### Relation topology

`ResolvedRelationIndex` is the one schema-wide topology fact. Query scopes,
builders, mutation parsers, OwnWrite, result parsing, migrations, and client
projection receive views of that same index. A hot-path optimization may reuse
the index's map insertion order or a `ResolvedSlot`/resolved edge already in
hand. It may not cache a parallel relation order, split fixed-target and
variant-target declarations into companion collections, rescan raw getters for
an inverse, or reconstruct ownership/cardinality/storage from declaration
syntax.

The word *polymorphic* remains valid only for the private variant-target
envelope and `(type, id)` storage domains that still own behavior. It does not
name a second model field category or topology owner.

### Semantic keys

Do not replace a `JSON.stringify` key merely because stringification allocates.
Some keys are intentionally injective representations of a semantic identity:

- `canonicalTargetKey` distinguishes field name, JavaScript primitive type,
  and value;
- junction PK, stable-target, and adopt-dedup keys own correctness, not only
  grouping;
- exact target-constraint keys participate in conservative overlap analysis.

Only contiguous row-shape grouping may use elementwise comparison without a
semantic key. Other keys require a separate representation proof and profile.

### Read-only collections

`Object.freeze(new Map())` and `Object.freeze(new Set())` do not make entries
immutable. A shared empty collection is allowed only when it is module-private,
typed read-only, and never exposed to code that can mutate it.

### Result aliasing

Result parsing may reuse trusted row objects where the current contract permits
it. It may not return the provider’s outer row array directly: callers must not
gain an alias to provider-owned transport storage.

### Spread syntax and copy ownership

The live query-engine and driver tree contains 816 textual `...` occurrences,
including 119 explicit array-literal copies of the form `[...value]`. This is a
census, not an allocation count:

- rest parameters and rest destructuring express an API shape;
- argument expansion such as `and(...conditions)` or
  `steps.push(...childSteps)` consumes an existing array and is not equivalent
  to constructing `[...conditions]`;
- object and array spreads can establish a necessary ownership boundary;
- comments, examples, and cold error paths do not contribute to the ordinary
  operation budget;
- one spread inside a per-row or per-step loop can matter more than hundreds
  of cold sites.

Do not adopt a `no-spread` rule. Classify every dynamically reached copy as one
of four facts:

1. **Defensive boundary copy** — protects against caller/provider mutation;
   retain it unless ownership moves to a stronger boundary.
2. **Required value assembly** — constructs a genuinely new ordered record,
   statement, or result; retain it.
3. **Redundant private copy** — copies a fresh value already owned exclusively
   by the current operation; transfer or mutate that owned value instead.
4. **Argument/rest expansion** — profile separately and do not assume it
   allocates a user-visible intermediate collection.

The optimization target is category 3, not the syntax. Replacements must
preserve field, parameter, row, step, guard, and output order. Conditional
object assignment must also be measured: removing a spread can exchange one
allocation for unstable object shapes and become slower.

Aggregate impact matters. At 10,000 operations per second, avoiding 1 KB per
operation removes approximately 10 MB/s of short-lived allocation pressure;
avoiding 4 KB removes approximately 40 MB/s. This is garbage-collection and
tail-latency pressure, not retained-memory leakage. Phase 5 therefore includes
one cumulative ownership-copy audit after the individually attributable edits.

## Candidate disposition

| Candidate | Decision | Evidence or correction |
| --- | --- | --- |
| Lazy diagnostic sanitization | Prototype only | Make the pre-provider snapshot conditional on actual parameter-disclosure demand. Never sanitize after provider execution. |
| Lazy correlation ID | Prototype jointly | Combine with trusted context identity reuse; alone it is immediately forced. |
| Context snapshot reuse | Prototype jointly | A bound context and fallback operation are always supplied today, so the old short-circuit condition was unreachable. |
| Ordinary-operation observer gate | Rejected | `scalar-find-unique` full allocation improved by 1.20% but missed 2×MAD; the ordinary observer was restored exactly. |
| Transaction-batch observer gate | Kept | The isolated `atomic-batch-100` full-allocation target improved by 4.72% beyond 2×MAD without a companion regression. |
| SQLite-family value conversion | Deferred / unmeasured | SQLite3/Bun/D1 may return the input when unchanged; libSQL must still validate and narrow into `InValue[]`. No report authorizes the edit yet. |
| Ordinary insert shape/value grouping | Rejected | The declared 100-row prepare-allocation target improved only 0.73%, inside 2×MAD; the ordinary prototype was removed. |
| Variant row-storage value grouping | Kept, scaling corrected | The original one-carrier candidate improved full allocation by 6.37%. The corrected linear projection remeasured at 5.03% beyond 2×MAD, with no companion regression. |
| `TargetConstraint` Set/spread cleanup | Rejected | Allocation improved, but the singular variant full-operation wall control regressed beyond 2×MAD. |
| Create scalar copy | Rejected after split | The combined explicit/generated targets both stayed inside 2×MAD. The isolated generated-field copy then missed its CPU target and regressed full wall time beyond 2×MAD. |
| OwnWrite early return | Kept at root only | Flat-update prepare allocation improved by 30.35% beyond 2×MAD. Nested analysis remains unchanged. |
| Returning-clause scan | Rejected | The declared prepare-allocation target regressed by 0.64% beyond 2×MAD; the source was restored. |
| Find join-array reuse | Rejected | Prepare allocation stayed inside noise and the full-operation wall control exceeded the 10% ceiling. |
| Cursor-order array reuse | Kept | The declared cursor prepare-allocation target improved by 1.09% beyond 2×MAD. |
| Indexed normalized-batch validation | Kept | `atomic-batch-100` execution allocation improved by 3.81% beyond 2×MAD. |
| Downstream normalized-result rescans | Rejected after split | The combined client/executor target and the isolated executor target both stayed inside 2×MAD. The driver remains the generic provider-result boundary, but no consumer deletion was retained on performance grounds. |
| Shared-batch result reshaping | Kept | Direct trusted-result consumption removed 23.0 KB per 100-member atomic batch (0.91%, beyond 2×MAD), scaled down at 10 and 1 member, and caused no companion regression. |
| Aggregate ownership-copy audit | Complete; no direct production edit | The final retained cumulative tranche is `95e606da…` → `fc93a4a2…`. It excludes the rejected adapter JSON interleavers and includes the corrected linear variant grouping and sole full-batch result guard. Fresh profiles exposed two residual private copies; both isolated prototypes failed a control gate and were reverted. |
| `selectedEntries` in-place compaction | Rejected | Flat-update full allocation improved by 380.68 B/op (0.763%, beyond 2×MAD), but the fixed-collection 20-row wall control regressed 1.167% beyond 2×MAD. |
| Create demanded-set one-pass scan | Rejected | Fixed-row-reference create allocation improved by 954.80 B/op (0.573%, beyond 2×MAD), but the prescribed atomic-batch isolation regressed CPU by 25.174%, beyond 2×MAD and the 10% ceiling. |
| Reference-free SQL materialization | Kept | The zero-reference full-allocation target improved by 1.41% beyond 2×MAD using the canonical reference predicate. |
| Generic idiom sweep | Rejected | Each occurrence needs its own hot-path evidence and semantic proof. |
| Lazy `ResultParser` maps | Rejected | Scalar parse allocation improved, but the variant-collection parse CPU and wall controls regressed beyond 2×MAD. All four maps remain eager. |
| Reused scalar middleware continuations | Kept | Stable per-scalar continuations remove per-cell driver/adapter callback allocation without changing the middleware contract. SQLite 1,000-row full allocation fell 22.63%; the PGlite control stayed inside noise. |
| Executor-proven consumable result rows | Kept | Exact stock SQLite3 and PGlite reads may reuse same-key inner row objects only when the active producer survives an execute-time proof and the compiled parser says `reusable`. The public outer array stays fresh; every custom/cache/transaction/batch/raw/manual route remains borrowed. |
| Shared result-shape empties | Reprofile only | Compiled selection was rejected at its gate; the retained result-shape owner may be optimized only with fresh evidence and module-private read-only ownership. |
| Memoized `defaultSelect` | Reprofile only | Compiled selection was rejected. Any memo belongs to the retained projection owner and needs explicit immutable ownership. |
| Trim-free JSON carrier scan | Rejected | The declared 1,000-row parse-allocation target stayed inside noise and a full-operation wall control regressed. |
| JSON projection copy-on-write | Rejected | Its allocation target barely cleared 2×MAD, but prepare CPU and the 1,000-row full-allocation control regressed. |
| Allocation-free variant-envelope key check | Rejected | Allocation improved materially, but parse CPU and wall time regressed beyond 2×MAD after refinement. |
| Identifier construction | Kept | The corrected 100-column prepare-allocation target improved by 17.94% beyond 2×MAD without a companion regression. |
| Adapter JSON argument interleaving | Rejected | The exact-width target improved, but the 2-field/depth-2 prepare-CPU companion regressed beyond 2×MAD. |
| Shared INSERT pre-sizing | Rejected | The declared prepare-allocation target moved by only +0.24% inside noise; the longer candidate was removed. |
| Canonical standalone optional result | Rejected | Allocation improved, but prepare CPU and full-operation wall time regressed beyond 2×MAD. Standalone nullable remains deferred. |
| SQLite prepared-statement cache | Rejected here | It changes handle lifetime, retained heap, `safeIntegers` behavior, schema invalidation, and connection ownership. |

## Phase 0 — Repair and split the proof surface

No production optimization starts until this phase is complete.

### Unit 0.1 — Stabilize the baseline owner

1. Record the exact accepted baseline commit for each candidate, plus the
   branch, runtime versions, CPU, and operating system. Use `4cf5c7fe` only
   when it is the actual comparison baseline; it is not an implicit substitute
   for later accepted tranches.
2. Record dirty files and isolate them from measurement. Build the baseline and
   every candidate in explicit clean worktrees; unrelated user-owned changes
   are neither a baseline nor candidate input.
3. Build the baseline and candidate from explicit commits or worktrees. Never
   compare two states that share uncommitted production changes.
4. Run all benchmark processes sequentially. Repository tests and TypeScript
   checks must also remain sequential because the launchers own a workspace
   lock and memory cap.

### Unit 0.2 — Correct benchmark setup

Amend `benchmarks/drizzle-memory-cpu.mjs` and the matching benchmark fixtures:

1. Make seeding async-aware and await every VibORM seed statement.
2. Recreate or reset each mutation database for each measured replicate so
   table/index growth is equal.
3. Use VibORM’s prepared SQL and exact parameters for raw-driver floors.
4. Make raw relation comparisons execute the same nested-result SQL, not a flat
   join.
5. Move immutable 1,000-row parser fixtures outside timed iterations in
   `read-fastpath-parse.bench.ts`.
6. Rename the relation memory script’s current “cold” case to “first operation
   after initialized client.” Client construction, migration, and seeding have
   already happened.
7. Make every result checksum consume at least one returned scalar and, for a
   relation workload, one nested scalar. Counting rows alone does not prove
   equivalent parsing.

### Unit 0.3 — Isolate stages and processes

Support these stages as separate workloads:

- construction/prepare only;
- driver execution of an already prepared statement;
- parse only against an immutable raw fixture;
- raw execution plus parse;
- complete public client operation.

For each baseline/candidate pair:

1. Use five fresh child processes per workload and mode.
2. Alternate baseline-first and candidate-first order.
3. Run allocation and CPU modes in separate processes.
4. Keep the checked-in 4,096-byte heap sampling interval unless the script and
   documentation are deliberately changed together.
5. Use `process.cpuUsage()` for aggregate CPU. If call-site attribution is
   needed, add a separate inspector CPU-profile mode and state its sampling
   interval explicitly.
6. Report median and median absolute deviation (MAD), plus min/max.
7. Report gross allocation per operation and, for row-returning workloads,
   allocation per returned row.
8. Run retained-heap measurements in fresh processes. A same-process
   `heapUsed` delta can be negative or reflect heap resizing rather than a
   retained object graph.

### Unit 0.4 — Required workload matrix

| Workload | Required stages |
| --- | --- |
| driver-only `_executeRaw`, one statement | execution, full driver wrapper |
| scalar `findUnique`, one row | prepare, execute, parse, raw+parse, full |
| scalar `findMany`, 20 rows | same |
| scalar `findMany`, 1,000 rows | parse, raw+parse, full |
| scalar order and cursor/take | prepare, full |
| fixed-target singular row-reference read, 20 and 1,000 rows | prepare, execute, parse, raw+parse, full |
| fixed-target collection read, 20 and 1,000 rows | prepare, execute, parse, raw+parse, full |
| variant-target singular row-reference read, 20 and 1,000 rows | prepare, execute, parse, raw+parse, full |
| variant-target collection junction read, 20 and 1,000 rows | prepare, execute, parse, raw+parse, full |
| fixed-target junction read, singular and collection | prepare, parse, full |
| enum-heavy read, 20 and 1,000 rows | parse, full |
| flat create with explicit ID | prepare, execute, raw+parse, full |
| flat create with database-generated ID | same |
| flat scalar update | same |
| fixed-target relation-bearing create and update, row-reference and junction | full |
| variant-target relation-bearing create and update, singular and collection | full |
| atomic batch, 1/10/100 statements | prepare, execute, full |
| nested transaction with zero vs one inter-step reference | full |
| bulk create/update with implicit returning, 100 rows | prepare, parse, full |
| row-held variant-target `createMany`, 100 alternating targets | full |

Composed relation writes and generated inter-step references expose no honest
standalone plan through the built public lifecycle: `prepare()` declines them
and `prepareBatch()` enforces postconditions that make it a different workload.
Their evidence is therefore the complete operation only. A constant result,
private partial-plan call, or hand-built SQL is not an acceptable substitute.

### Unit 0.5 — Performance keep gate

A performance-specific implementation is retained only when:

- the comparison declares every intended target as an exact
  `workload/stage/mode/metric` contract before measurement; an undeclared or
  non-target improvement cannot make a report keep-eligible;
- its targeted median improves by more than twice the measured MAD;
- no targeted workload regresses by more than twice MAD;
- no corresponding full operation regresses materially;
- no end-to-end pair regresses by more than the repository-wide 10% ceiling;
- behavior tests and byte-level SQL/fragment witnesses remain green;
- the implementation does not add more conceptual machinery than the work it
  removes.

If a local rewrite is also plainly simpler and allocation-neutral, it may be
kept as a simplification, but it must not be reported as a performance win.

The Phase 0 falsifier compares two different commit IDs with byte-identical
source trees. Its report must remain valid measurement evidence but cannot be
keep-eligible without a declared target. This prevents ordinary noise in an
unrelated metric from silently becoming the reason to keep code.

## Execution order after Phase 0

Phase 0 remains the hard gate. The first local tranche has now been measured
one independently reversible unit at a time.

Retained production units are:

1. Unit 1.1's transaction-batch subunit, Unit 1.4 edit 3, and Unit 1.5;
2. Unit 2.2, Unit 2.4's variant row-storage subunit, and Unit 2.8;
3. Unit 5.2;
4. Unit 6.1.

Measured and removed units are Unit 1.1's ordinary-operation subunit, Unit 1.3,
Unit 1.4 edit 2, Unit 2.4's ordinary subunit, Unit 2.5,
Unit 2.3, Unit 2.9's `resolveOutputList` subunit, Units 3.1 and 3.3–3.5,
Unit 5.1, Units 5.4a–5.4b, Units 6.3–6.4, and Unit 6.6a's
standalone-optional subunit. Their reports remain evidence; they are not
authorization to retry the same implementation against a different metric.

Unit 5.4 is complete as the cumulative ownership-copy proof. It required no
direct production edit beyond the independently measured units it audited.

Units 1.2, 1.4 edit 1, 2.1, 2.6–2.7, the unmeasured arms of Unit 2.9,
Unit 3.2, every Phase 4 prototype, Units 5.3 and 5.5, Units 6.2, 6.5, the
standalone-null arm of 6.6a, 6.6b, 6.7–6.8, and 6.9b–6.9d remain deferred until
an honest workload reaches them. Unit 6.9a landed as supporting ownership for
the retained consumable-row unit. Diagnostic/context ownership, queue timing,
and public `PendingOperation` compatibility remain broad prototypes.

## Phase 1 — Universal fast-path candidates

These units are independent. The measured dispositions below are final for the
tested implementations; Unit 1.2 remains deferred pending a reaching workload.

### Unit 1.1 — Gate operation observation before allocation

Owner: `src/query-engine/execution-context.ts`.

**Measured disposition: split.** The ordinary-operation fast path reduced
`scalar-find-unique` full allocation by 420 bytes per operation (1.20%) but did
not clear 2×MAD, so that half was removed. The transaction-batch phase bypass
was isolated and kept: `atomic-batch-100` full allocation fell by 125 KB per
operation (4.72%, beyond 2×MAD), while CPU fell 4.94%; the one-operation
scaling control improved in the same direction and no companion regressed.

`observeOperationExecution()` remains byte-for-byte at its baseline. Do not
reapply the rejected ordinary-operation gate.

The retained `observeTransactionBatchPhase()` subunit:

- success without instrumentation bypasses span/log plumbing;
- failure must still pass through driver-error normalization even when no
  instrumentation is configured;
- logging-only execution keeps timing and error reporting without invoking the
  no-op tracer;
- configured tracing still invokes its tracer when provider state reports it
  disabled. Configuration, not tracer truthiness, owns the gate.

Proof:

- no instrumentation;
- logging only;
- tracing configured but disabled by provider state;
- active tracing;
- successful batch phase and thrown driver error;
- shared/native batch preparation and parsing.

### Unit 1.2 — Copy-on-write SQLite-family value conversion

Owners:

- `src/drivers/shared/sqlite-utils.ts`;
- `src/drivers/sqlite3/index.ts`;
- `src/drivers/bun-sqlite/index.ts`;
- `src/drivers/d1/index.ts`;
- `src/drivers/libsql/index.ts`.

Rules:

1. Fuse chained conversion maps.
2. Scan until the first value requiring conversion.
3. SQLite3, Bun SQLite, and D1 may return the original read-only input when no
   value changes.
4. libSQL still owns runtime narrowing from `unknown[]` to `InValue[]`; use one
   allocated typed array when needed rather than returning an unvalidated
   input through an assertion.
5. Preserve boolean, `undefined`, date, bigint, blob/binary, JSON, and unsupported
   value behavior exactly.

Measure string/number-only parameters separately from each converted type.

### Unit 1.3 — Scan returning clauses without materializing text

Owner: `src/query-engine/operations/create.ts::hasReturningClause`.

**Measured disposition: rejected.** The five-replicate
`flat-create-explicit-id` comparison declared prepare-stage allocated bytes as
its target. The candidate moved that target in the wrong direction by 0.64%
and beyond 2×MAD. Prepare CPU improved by 2.90%, but changing the declared
target after observing the report would be cherry-picking, and the longer
rewrite was not an independent simplification. The source remains unchanged.

The rejected implementation tested each `returning.strings` segment with one
module-local non-whitespace regular expression until a match was found. It did
not introduce a hand-maintained whitespace classifier. The answer remains a
property of the built SQL, not an inferred adapter capability, but this
particular scan must not be reapplied.

### Unit 1.4 — Remove small unconditional read-builder arrays

Implement as three separately measured edits:

1. In `builders/orderby-builder.ts::buildOrderByInternal`, allocate relation
   alias state only when the first relation order is encountered. Scalar-only
   order must allocate no relation map. Defer this edit until the catalog owns
   a scalar-order-without-window workload: the current cursor workload takes a
   different normalization path and cannot prove this allocation.
2. In `operations/find-common.ts::buildFind`, reuse the one non-empty joins
   array when either lateral joins or order joins is empty; concatenate only
   when both contain elements.
3. In `operations/cursor-order.ts::normalizeCursorOrder`, reuse the private
   fresh array returned by `parseRequestedScalarOrder()` and populate the
   ordered-field set in one loop instead of copying then mapping.

**Measured disposition for edit 2: rejected.** Its declared
`scalar-find-unique` prepare-allocation target was unchanged within noise
(+0.23%), while the full-operation wall median exceeded the 10% ceiling. The
branching replacement was longer than the original spread, so it was removed.
Edit 1 remains unimplemented for lack of a reaching workload.

**Measured disposition for edit 3: kept.** Reusing the private parsed cursor
order reduced the declared prepare allocation target by 511 bytes per operation
(1.09%, beyond 2×MAD). Full-operation allocation and CPU also improved, with no
measured regression.

Preserve relation alias insertion order, cursor tie-breaker order, null-order
semantics, and input immutability.

### Unit 1.5 — Indexed normalized-batch validation

Owner: `src/drivers/normalized-result.ts::assertNormalizedBatchResults`.

**Measured disposition: kept.** On `atomic-batch-100`, the declared execution
allocation target fell by 9.6 KB per operation (3.81%, beyond 2×MAD).
Full-operation allocation fell by 28.2 KB per operation; CPU remained within
noise and no control regressed.

Replace `for (const [index, result] of results.entries())` with an indexed loop.
Array holes must still reach the single-result validator as `undefined` and
fail at the exact index.

This is a small scalable win for 10/100/1,000 result batches. Do not weaken the
row predicate in this unit.

Validation for Phase 1:

```bash
pnpm test:layer:drivers
pnpm test:layer:instrumentation
pnpm test:layer:query-engine
pnpm test:layer:client
pnpm test:types
```

Run the affected SQLite-family provider contracts through their existing
memory-capped launchers. Do not run Vitest directly or concurrently.

## Phase 2 — Query construction and flat-write allocation

### Unit 2.1 — Demand-drive dormant fresh-record compiler state

Owner: `src/query-engine/write-engine/CreateOperation.ts`.

A flat scalar create currently constructs state used only by recursive or
published-field paths:

- `registeredParts`;
- `publishedFields`;
- `publishReads`;
- the bound `createFresh` closure;
- the `recordCompilers` seam object.

Make each collection optional and allocate it in the first method that writes
or reads a non-empty value. Replace the per-instance `createFresh` class-field
closure with a prototype method where possible. Create the bound compiler seam
once, lazily, on the first relation-bearing recursive use.

Do not create a second scalar-create compiler. A single `CreateOperation`
continues to own flat and nested fresh records.

Proof:

- flat create with explicit ID allocates none of the dormant state;
- flat create with generated identity allocates only publication state it
  actually uses;
- nested child creation obtains one stable seam identity;
- junction and recursive record compilation reuse the same seam;
- demand registration still occurs before insert compilation;
- post-insert publication still emits at most one read per record.

### Unit 2.2 — Root-only OwnWrite bypass

Owner: `src/query-engine/OwnWriteAnalyzer.ts`.

**Measured disposition: kept.** The declared flat-update prepare-allocation
target fell by 14.2 KB per operation (30.35%, beyond 2×MAD). The flat-create
control fell by 4.8 KB (13.25%). Their complete-operation allocation fell by
20.95% and 9.02% respectively, with no measured regression.

At `assertCreateOwnWriteSafety()` and `assertUpdateOwnWriteSafety()`:

1. Test that the root's one ordered `ParsedRelationMutation[]` is empty.
2. Return before constructing the analysis tree.
3. Leave `analyzeCreate()` and `analyzeUpdate()` unchanged for recursive calls.

Do not recover this fact by reading model declarations or `ResolvedRelationIndex`:
the mutation parser already published the exact ordered work list, and its
length is the owner of whether this payload contains relation work.

Add a falsifier showing that a nested relation-free insert/update still
contributes the existing barrier/target/transition fact to an enclosing
relation-bearing operation.

### Unit 2.3 — Avoid needless Create scalar copies

**Measured disposition: rejected after split.** The combined prototype's
explicit-ID prepare-allocation target improved by only 50 bytes per operation
(0.17%, inside 2×MAD), while the generated-ID allocation target moved upward
inside noise. A genuinely isolated generated-field prototype then restored
ordinary and shared-key copying and changed only copy-then-delete into a
copy-that-skips. Its declared prepare-CPU target moved 0.53% in the wrong
direction inside noise, and its complete-operation wall time regressed 3.16%
beyond 2×MAD. Both implementations and their implementation-only tests were
removed. Evidence: `/tmp/viborm-unit-2-3.json` and
`/tmp/viborm-unit-2-3-generated.json`.

Owner: `CreateOperation` record construction.

1. Reuse `parsedData.scalarData` when no generated field must be omitted and
   the shared-primary-key identity is empty.
2. When one generated field must be omitted, build one fresh object and skip
   that field during the copy; do not copy then `delete`.
3. Merge shared-key identity only when it has members.
4. Prove every downstream consumer treats the selected scalar object as
   read-only.

Measure explicit-ID and database-generated-ID creates separately; the explicit
ID benchmark cannot prove the generated-field branch.

### Unit 2.4 — Single-row shape and owned value groups

Owners:

- `builders/insert-row-shapes.ts`;
- `builders/values-builder.ts`;
- `builders/polymorphic-mutation.ts::polymorphicStorageMembers()` for the
  existing ordered projection from resolved slots into private row storage.

**Measured disposition: split.** The ordinary `insert-row-shapes` /
`buildValueGroups` prototype reduced the declared 100-row prepare-allocation
target by only 0.73%, inside 2×MAD, so those source changes were removed. The
variant row-storage half was then remeasured alone and kept: complete-operation
allocation fell by 101 KB per 100-row operation (6.37%, beyond 2×MAD), with CPU
inside noise and no regression. That workload assigned only one row-held carrier,
so it did not prove how the retained declaration-order projection scaled with
several assigned carriers on a wide model.

A later scaling audit found that the first post-unification projection compared
every assigned carrier with every resolved slot. The correction groups only the
current call's assignments by `RelationSlot` identity, then walks the canonical
resolved-slot map once. This is O(resolved slots + assigned values + emitted
members), preserves declaration order, and creates no model-owned topology fact.
The focused 64-slot / 12-assignment falsifier observes exactly 12 carrier reads;
the removed nested scan performed 768. A separate scrambled four-carrier witness
pins declaration order, atomic type-before-id order, linked values, and empty
storage.

The corrected implementation was then remeasured with the original Unit 2.4
protocol against clean baseline
`4b010ede2638dbae710eb4c555c192c8bb78d785`; the detached synthetic candidate
was `f5212c54860147e1bf0bc2c4ee6e6fea86805895`. Across five alternating fresh
processes per side, full allocation fell from 15,889.79808 to 15,090.3752 bytes
per row: 799.42288 bytes, or 5.031%, against a 57.48704-byte 2×MAD threshold.
Full CPU improved by 2.937% beyond 2×MAD; full wall time improved by 1.365%
inside noise. The keep gate is eligible, with no regression and the 10% ceiling
passed. Thus 6.37% remains the historical result for the removed nested-scan
candidate; the corrected retained code rests on the fresh 5.03% result. Evidence:
`/tmp/viborm-unit-2-4-linear.json`, SHA-256
`cfd7336d511b6b9e614516d096a2696f066aed33204f9215bbd852dce3f09e1c`, protocol
SHA-256 `7614adf062e8be1df9f5a0c6b678b028becddad82d7f1f3c95040ece09d679dd`.

The rejected ordinary prototype attempted to:

- compute active fields once;
- return one group without a grouping key.

For multiple ordinary rows it attempted to:

- preserve maximal contiguous runs;
- compare the new field list elementwise with the active group’s field list;
- never reorder rows or merge non-contiguous equal shapes.

Those bullets remain unimplemented. The retained variant row-storage path:

- build columns and row values with push loops;
- append private variant-target `(type, id)` storage values only when present;
- lower each private member's column and SQL value in one traversal;
- skip private lowering entirely for rows without private storage;
- groups contiguous column shapes with an indexed comparison.

`polymorphicStorageMembers()` may read declaration order only from the canonical
resolved-slot map and storage columns only from `ResolvedVariantRowStorage`
already carried by the value. It may not build or cache a model-owned storage
map, a parallel relation-order map, or a second slot descriptor. A call-local
map of assigned values by their existing carrier identity is permitted because
it stores no topology and disappears after the projection.

Pin heterogeneous rows, generated defaults, destination casts, polymorphic
private storage, skip-duplicate grouping, and returned-input order.
Use the full-only `variant-row-storage-create-many-100` workload to exercise
the multi-row private-storage grouping path. Its public operation exposes no
honest plan-only seam, so this is complete-operation evidence rather than a
fabricated prepare proxy.

### Unit 2.5 — `TargetConstraint` sort/compact prototype

**Measured disposition: rejected.** In the five-replicate
`variant-row-storage-create-many-100` full-operation comparison, sorting and
compacting one copied field-name array reduced allocation by 53.7 KB per
operation (3.74%, beyond 2×MAD). The same candidate regressed the singular
variant control's full wall time by 2.77%, also beyond 2×MAD. Because one
measured regression invalidates the candidate, the implementation and its
implementation-only tests were removed. The evidence is retained in
`/tmp/viborm-unit-2-5.json`.

Unit 2.2 had already landed when this candidate was measured, so the report
already describes the residual nested/variant cost after the root bypass. Do
not reapply the same representation.

The rejected implementation:

1. Copy the candidate field names once.
2. Sort the array in place.
3. Compact adjacent duplicates in place.
4. Iterate `fields.values()` directly for exactness checks.
5. Keep `exactTargetConstraintKey()` and semantic constraint serialization
   unchanged unless an isolated profile and injectivity proof justify a later
   representation change.

### Unit 2.6 — Demand-drive atomic scratch batch identity

Owner: `OperationExecutor.compileToEntries()`.

Today every atomic plan creates `operation_<uuid>` even when no output uses
`kind: "insertId"` scratch storage.

1. Keep `batchId` undefined initially.
2. Allocate it on the first insert-ID output.
3. Reuse the same ID for every scratch entry in that operation.
4. Let `batchId !== undefined` replace the parallel `usesScratch` truth when
   building setup/store/cleanup entries.

Proof compares an atomic nested write with no scratch against one whose
generated identity requires scratch. The scratch case must retain byte-identical
setup, clear, store, read, and cleanup SQL and IDs.

### Unit 2.7 — Trusted executor output loops

Owner: `OperationExecutor.ts`.

Replace `Object.values()`/`Object.entries()` arrays only in trusted internal
output records owned by:

- `stepUsesInsertIdScratch`;
- `compileToEntries`;
- `extractOutputs`;
- `mergeBatchOutputs`;
- `resolveFragmentOutputs`.

Use own-property iteration, preserve ordinary string-key insertion order, and
do not generalize into a utility. Pin optional outputs, first-row fields, row
lists, row counts, insert IDs, missing references, and heterogeneous list
failure.

### Unit 2.8 — Reference-free SQL materialization from the canonical fact

**Measured disposition: kept.** The declared zero-reference full-operation
allocation target fell by 2.2 KB per operation (1.41%, beyond 2×MAD). The
one-reference control also allocated slightly less because its reference-free
statements take the fast path; CPU remained within noise.

Distinct-truth Phase 9.5 has landed. `OperationFragment.ts` owns reference
discovery through `statementReferences()` and the allocation-light predicate
`statementHasReferences()`.

Use that existing fact to make `materializeLinearSql()` and
`materializeBatchSql()` return the original `Sql` when a statement contains no
`OperationValueReference`. Do not add a second reference scanner or cache.

Whenever a reference exists, preserve:

- reference resolution order;
- optional missing-reference-to-`NULL` behavior;
- batch-reference lowering;
- the original SQL strings and non-reference values.

### Unit 2.9 — Measured nested-only local candidates

**Measured disposition for `resolveOutputList`: rejected.** On the declared
`bulk-create-returning-100` parse-allocation target, the one-pass classifier
changed allocation by only +10 bytes per operation inside noise. The complete
create path regressed CPU by 2.37% and wall time by 1.21%, both beyond 2×MAD.
The candidate and its implementation-only tests were removed. Conditional-arm
planning and `foldableShapeKey` remain deferred because the catalog does not
exercise them at meaningful arity.

Profile these separately after the preceding units:

- direct loops in `conditionalArmPlanning` instead of
  `Object.fromEntries`/`Object.entries` churn;
- one-pass classification in `resolveOutputList` for 100-row implicit-returning
  bulk folds (`createMany` / `updateMany` with `select`);
- structural comparison for `foldableShapeKey` only if group-shape
  stringification remains visible.

Do not touch canonical target, junction stable, adopt-dedup, PK, or exact
constraint keys in this unit.

Validation for Phase 2:

```bash
pnpm test:layer:query-engine
pnpm test:types
pnpm package:build
```

The query-engine layer includes the architecture contracts. There is no
`pnpm test:gates` script in the current repository.

## Phase 3 — Result construction and parsing

### Cross-driver result-transport closure (SQLite3 and PGlite evidence)

The early program at `52eef9ebfc710407e1e5fe6042e2ed5a11adf19e`
correctly rejected positional transport and a broad provider-row ownership
claim. A later, narrower program retained executor-proven consumption without
publishing ownership. Its exact baseline is
`766e4e68d96a1ba8a50ce7072ba153a5a2f83b01`; the temporary measured candidate
is `b8a46c3ec01c1511d9b5182dd4c9de621b14fd95`. The final active tree
`0ce1997eaa5cd71f3ae6c521e513a5f67cc1f0a2` was confirmed as an exact match to
that candidate. All final comparisons used five alternating fresh-process
pairs on Node 24.19.

| Final exact confirmation | Allocation bytes/op | Allocation | CPU | Wall |
|---|---:|---:|---:|---:|
| SQLite3 `scalar-find-many-1000/full` | 1,531,699.288 -> 1,436,882.040 | -94,817.248 (-6.1903%) | -1.8124% | -2.1588% |
| PGlite `provider-mixed-scalar-1000/full` | 7,123,755.04 -> 6,876,296.48 | -247,458.56 (-3.4737%) | -1.1859%, inside noise | -1.2904%, inside noise |
| PGlite `provider-identity-1000/full`, 128-byte diagnostic | 1,121,435.28 -> 1,121,100.56 | -334.72 (-0.02985%), neutral | not rerun | not rerun |

The governing user-plan disposition is **KEEP**. Both declared allocation
families improved beyond 2xMAD, CPU and wall time did not regress, identity and
complete-operation controls stayed below the 10% ceiling, and semantic digests
and SQL witnesses were exact. The authoritative reports are:

- `/tmp/viborm-final-exact-sqlite-512.json`, SHA-256
  `221d0c71f87beab981e147b4018a758e74b9df20d273dcf29cccff158405d9c2`;
- `/tmp/viborm-final-exact-pglite-mixed-512.json`, SHA-256
  `0a9e019b33af76942fcf5d2a0c3f1f04d0214d649fac17f5501e7a8122f36055`;
- `/tmp/viborm-final-exact-pglite-identity-128.json`, SHA-256
  `62752aeedd7d1e71beee08f7e513284b9ba7099a91b663adc07ce398389c218e`.

Keep the extra-strict 512-byte PGlite identity result visible, but label it
correctly. It reported +261 B/op (+0.186%) just beyond 2xMAD in the combined
predecessor matrix, while the independent A/B HeapProfiler sampling standard
error was about 3.39 KB. Two 128-byte diagnostics reversed its sign, and the
exact-runtime final diagnostic above was neutral. This is a useful false-red
diagnostic, not the governing plan target. Its retained artifacts are
`/tmp/viborm-final2-all-baseline.ndjson` (SHA-256
`379cd0b90146a0a72d542107b5e56afc8c700e24e6f656a520240aa0d41c722a`),
`/tmp/viborm-final2-all-candidate.ndjson` (SHA-256
`9c51b204963c20697cc4029a2bfbd69f7676c1a33c39724daec16d50dd237ca5`),
and `/tmp/viborm-final2-all-order.tsv` (SHA-256
`84f3fe1aea6e8f86aede7a30c9cdf3ef1614c868575e6cb427cb5cb9e1bd5f37`);
that candidate was `3f2d3568...` under protocol `99ef6884...`.

The earlier full matrix measured the exact predecessor tree and found SQLite
identity -9.24%, SQLite mixed -6.03%, and PGlite mixed -3.47%, with every RSS
movement below 1%. The only final runtime change was the allocation-free
substitution of a concrete-operation check with the operation shell's cohesive
prepared-row capability. The exact-final confirmation did not rerun RSS, so the
predecessor RSS controls remain historical evidence and are not relabeled as
exact-final measurements.

The retained architecture has one proof and one policy owner:

- SQLite3 and PGlite register a candidate only for their exact stock driver,
  internally created active client, and unchanged typed execution and parser
  surfaces. Supplied clients, subclasses, overrides, and middleware fail closed.
- `QueryEngine` resolves that candidate once. `OperationExecutor` keeps the
  exact execute → active-producer proof → synchronous parse sequence lexical;
  no marker, token, result property, operation field, or public API carries it.
- The operation shell exposes one optional prepared-row capability. Parser,
  expected shape, and compiled program remain executor-local; the generic
  executor imports no concrete operation and ordinary shells allocate nothing.
- The compiled parser alone chooses `identity`, `reusable`, or `copy`. The
  public outer array is always fresh. Only same-key inner rows under a valid
  proof can be mutated and reused; shape-changing rows copy.
- Custom or supplied drivers, middleware, cache, transaction, array-batch, raw,
  and manual-parser paths remain borrowed. Borrowed native nested rows that need
  decoding copy; a nested graph created by `JSON.parse` may reuse safe same-key
  rows only after complete structural validation. Borrowed nested graphs are
  never mutated.

That last ordering is deliberate: fixed and variant carrier validation is
complete before the first parser-owned nested row changes. The variant path
validates every arm, orphan fact, envelope, discriminator, and target shape
before parsing visible rows.

The historical claim that a profile showed a direct approximately 666 KB
`parseResultRows` "second copy" was false. That value was inclusive stack
attribution, not the function's self allocation. `parseResultRows` directly
allocates the fresh outer array; rebuilding rows separately allocates object
shells and property storage while copying references to existing scalar values.
It does not reproduce all provider allocation. The retained six-column in-place
probe predicted about 73.9 KB/op, and the faithful final SQLite workload saved
about 94.8 KB/op. Neither result supports a 50% allocation claim.

| Unit | Disposition | Production outcome |
|---|---|---|
| Typed fallback batches | Kept for correctness | Typed model and safe `Sql` statements use typed execution; only marked verbatim raw statements use raw execution. Exact large SQLite integers survive fallback batches. |
| Positional transport | Rejected | SQLite3 full allocation regressed 11.11% and CPU 2.17%; PGlite allocation regressed 1.33%. All positional production paths were removed. |
| Broad provider-owned named-row mutation | Rejected | The reduced historical prototype still regressed SQLite mixed-provider wall time 1.976% (+51.06 us), beyond 2xMAD. No durable provider-row ownership claim remains. |
| Executor-proven consumable rows | Kept | The proof is stock-producer-specific and lexical; the compiled parser decides whether inner rows are reusable, while the public outer array remains fresh. |
| Reused scalar middleware continuations | Kept | `ResultParser` compiles one adapter continuation per scalar chain and passes the adapter decoder directly as the driver continuation. SQLite 1,000-row full allocation fell 22.63%, CPU 3.65%, and wall 2.92%; PGlite controls stayed inside noise. |
| Relation JSON ownership | Kept | The carrier parser is the sole JSON decoder. Graphs it creates are fully prevalidated before safe same-key nested rows can be decoded in place; borrowed shape-changing provider graphs copy. |
| Diagnostic parameter demand | Kept pending final closure validation | Deep sanitization occurs once only when instrumentation or errors can disclose parameters; execution keeps its shallow parameter copy. |
| Lazy correlation identity | Kept pending final closure validation | Correlation identity is created on first observation and is reused only through trusted equivalent context. |

Historical rejection reports remain at
`/tmp/viborm-cross-provider.p4rgFL/reports/sqlite-pglite-owned-row-final.json`
(SHA-256 `fb8cecf22dafbd1a70f25ab9627b6d8eae91b66185534a0427b8e21b59bb1a49`)
and `sqlite-pglite-owned-row-trusted.json`
(SHA-256 `7dc51ceb1ff188018b3c1a06eadfb8ef602cb693aeeb9a399f3feb88d3775d47`).
They establish rejection of the broader predecessor, not the retained lexical
proof. The relation-JSON percentages come from earlier exact controls, not a
final cumulative keep report.

The D1 benchmark runner is unavailable. The PlanetScale fixture begins at a
decoded SDK result and cannot prove wire transport or response-byte savings.
No performance claim is made for either provider.

### Unit 3.0 — Landed ResultParser baseline — no implementation work

The `4cf5c7fe` baseline already implements:

- nested row-parser reuse;
- zero-copy row-array validation;
- pre-sized parsed-row output;
- allocation-free expected-key counting;
- reuse of compiled nested parsers in fixed-target and variant-target relation
  reads.

The retained consumable-row work extends that owner: every compiled row parser
now publishes its one `identity` / `reusable` / `copy` policy, and no executor,
driver, or relation parser independently reclassifies the row. Do not
reimplement these changes or compare against their pre-change state.

### Unit 3.1 — Lazily allocate all four ResultParser caches

Owner: `result/ResultParser.ts`.

**Measured disposition: rejected.** The declared scalar-parse allocation
target improved by 374 bytes per operation (3.90%, beyond 2×MAD), but
`variant-collection-junction-20` parse CPU regressed 1.49% and wall time 0.89%,
both beyond 2×MAD. Complete-operation controls stayed within noise, but the
hot-stage regression blocks the keep gate. All four caches remain eager.

The rejected prototype made these caches optional and initialized them in
their owning getters:

- `fieldChains`;
- `relationChains`;
- `polymorphicChains`;
- `nestedRowParsers`.

Expected allocation shape:

- count-only result: none of the four;
- scalar row: field cache only;
- fixed-target include: field, relation, and nested-row caches as demanded;
- variant-target include: polymorphic cache only when its private envelope is
  encountered.

The relation caches remain contextual slot caches keyed by `(source model,
field)` and read emptiness/storage from the supplied `ResolvedRelationIndex`.
Never key them only by a reusable terminal relation object.

### Unit 3.2 — Reuse compiled field continuations

**Measured disposition: retained.** The existing `ResultParser` remains the one
middleware-chain owner. It now creates the adapter `next()` continuation once
per scalar chain and passes the adapter decoder itself as the driver's stable
continuation. The active adapter input is saved and restored around each
synchronous middleware call, preserving `next()` fallback semantics under
reentrant custom middleware without allocating a stack or a callback per cell.

The final five-pair alternating SQLite `scalar-find-many-1000/full` report:

| Metric | Baseline | Candidate | Delta |
|---|---:|---:|---:|
| Allocation | 1,472,366.80 B/op | 1,139,139.84 B/op | -22.6321% |
| Framework CPU | 901.23 us/op | 868.31 us/op | -3.6528% |
| Wall time | 752.96 us/op | 731.01 us/op | -2.9162% |
| Retained heap | 1,137.20 B/op | 1,159.20 B/op | +1.9346% |
| Peak RSS | 95,502,336 B | 93,945,856 B | -1.6298% |

Allocation, CPU, and wall cleared 2xMAD; retained heap and peak RSS cleared the
10% ceiling. A PGlite mixed-scalar 1,000-row control stayed within noise on all
three timed metrics. The callback protocol, scalar semantics, error translation,
and driver -> adapter -> strict-parser order did not change. The enum set remains
owned by the already-cached scalar field chain; no second cache was added.

### Unit 3.3 — Avoid trimmed JSON relation copies

Owner: `src/adapters/shared/result-parsing.ts::tryParseJsonString`.

**Measured disposition: rejected.** On the declared
`fixed-singular-rowref-1000` parse-allocation target, the manual whitespace
scan increased allocation by 2.3 KB per operation (0.24%) and remained inside
noise. A 20-row full-operation control also showed a small significant wall
regression. Because the replacement was materially longer without a proved
gain, it was removed.

The rejected prototype scanned from both ends for JSON whitespace (`space`,
tab, carriage return, line feed), inspected the first and last meaningful
characters, and passed the original string to `JSON.parse`. Any materially
different future candidate must preserve current behavior for:

- whitespace-only strings;
- non-JSON strings;
- malformed arrays/objects;
- valid JSON surrounded by whitespace.

Measure SQLite/MySQL relation carriers at 20 and 1,000 rows.

### Unit 3.4 — Copy-on-write JSON scalar projection pairs

Owner: `builders/select-builder.ts::castNumericPairsForJson`.

**Measured disposition: rejected.** The declared
`fixed-singular-rowref-20` prepare-allocation target improved by 292 bytes per
operation (1.11%, barely beyond 2×MAD), but prepare CPU regressed by 2.15%
beyond 2×MAD and the 1,000-row full-operation allocation control regressed by
8.4 KB per operation beyond 2×MAD. The candidate also needed a longer branchy
loop, so it was removed.

The rejected prototype returned the input pairs when no selected scalar was
bigint, decimal, or blob. On the first affected field, it allocated one output
array, copied the prefix once, and appended transformed or original pairs from
that point.

Prove callers treat the input pair array and tuples as immutable after the
call.

### Unit 3.5 — Allocation-free variant-envelope key checks

`polymorphic-result-parser.ts::hasExactKeys` still builds `Object.keys()` per
carrier. The rejected prototype moved an exact-own-enumerable-string-key
predicate into `result-parser-contract.ts` and reused it here. That shared
predicate was removed with the candidate; the current contract owner does not
expose it. Preserve treatment of inherited, symbol, and non-enumerable members
if a materially different future candidate revisits this boundary.

**Measured disposition: rejected after refinement.** The allocation-free
predicate reduced the declared 1,000-row variant-collection parse allocation by
734 KB per operation (28.33%) and full allocation by 737 KB (25.17%). Its
manual key walk also regressed parse CPU by 2.81% and wall time by 3.00%, both
beyond 2×MAD. Restoring the ordinary row guards removed an earlier control-path
regression but not this carrier-path cost. The strict companion gate therefore
removed the candidate; the native `Object.keys()` predicate remains.

### Retained result-path owners

Distinct-truth Phase 10's compiled-selection prototype was measured and
rejected; its conditional Phase 11 result-transport work did not run. Therefore
the following owners are retained, not scheduled for deletion:

- result-shape empty maps/sets;
- `defaultSelect` construction;
- `selectedEntries()` traversal;
- operation-name result carriers.

They are reprofile-only candidates after the first production tranche. A
shared empty collection must be module-private and truly unexposed; a memoized
selection must have an immutable owner and no second projection truth. Count
transport remains outside this micro plan because it changes the result
contract. The current `nativeScalarPassthrough` plus per-scalar guards already
implements the proven identity subset; a broader callback bypass is unsafe
without another explicit adapter-plus-driver capability proof.

Cross-operation `ResultParser` caching remains rejected below.

Validation for Phase 3:

```bash
pnpm test:layer:query-engine
pnpm test:layer:adapters
pnpm test:layer:drivers
pnpm test:layer:client
pnpm test:types
```

## Phase 4 — Diagnostic and context prototypes

These changes have broad leverage but sensitive attribution contracts. Keep
them as independent prototypes, with falsifiers written before production
changes.

### Unit 4.1 — One owner for diagnostic-parameter demand

Add one internal predicate at the driver instrumentation boundary that answers:

> Can any post-entry consumer disclose query parameters for this execution?

It must consider the effective:

- error diagnostic disclosure;
- query/error logging disclosure;
- tracing disclosure.

Implementation:

1. At operation entry, retain the shallow execution-parameter copy.
2. If parameter disclosure is impossible, skip the deep diagnostic snapshot
   and pass an immutable empty diagnostic value through normalization/logging.
3. If disclosure is possible, take exactly one sanitized snapshot before
   provider access and reuse it for errors, logs, and spans.
4. Do not read hostile values twice merely to decide disclosure.

Trace parameter attributes are normally constructed before the provider call,
but the first implementation should use the same pre-provider demand rule for
all disclosures. Split it only if a later profile proves the extra snapshot
material and a test proves timing cannot observe caller mutation.

Required falsifiers:

- no instrumentation and successful execution;
- diagnostics with `includeParams` false/true;
- logger with params false/true;
- tracer with params false/true;
- caller and provider mutation of arrays and nested objects;
- sanitization of hostile accessors, cycles, redacted values, and unsupported
  parameter types;
- failure before and after provider access.

### Unit 4.2 — Conditional, one-pass atomic-batch sidecars

Owner: `drivers/driver-batch-preparation.ts`.

Use one indexed loop to:

- copy/freeze execution parameters;
- snapshot each execution context;
- build each frozen query;
- optionally build diagnostic parameter snapshots;
- optionally build per-statement error-log details.

Always preserve the public `_executeBatch` input-mutation boundary. Diagnostic
arrays and error-log sidecars are created only when effective disclosure or
attribution needs them.

Pin one, ten, and one hundred statements, provider mutation, unique statement
error attribution, setup/cleanup offsets, and transaction fallback.

### Unit 4.3 — Lazy correlation and trusted context identity as one unit

Owners:

- `query-engine/execution-context.ts`;
- `drivers/execution-context.ts`;
- the driver’s `resolveExecutionContext()` seam.

Implement:

1. A closure-backed correlation getter that creates one cached UUID on first
   read.
2. A module-private brand for internal snapshots.
3. Trusted snapshotting that copies the getter without invoking it.
4. Identity return only when the effective model, operation, correlation,
   instrumentation, and bound-context merge are already represented by the
   trusted input.
5. Defensive property reads and fresh immutable snapshots for every external
   object.

Do not add a public context class or generic lazy-value abstraction.

Pin:

- no-instrumentation success generates no ID;
- the first log/trace/error read generates one ID;
- every later layer observes the same ID;
- transaction-bound drivers retain operation attribution;
- native batch can still identify one statement context;
- hostile getters throw or mutate without escaping the defensive boundary;
- public `getExecutionContext().correlationId` still returns a stable string.

### Unit 4.4 — Avoid invisible native-batch SQL concatenation

Prototype only after Units 4.1-4.3.

`_executeBatch` currently joins every statement into one string even when SQL
cannot be disclosed. During preparation, record whether any statement contains
the nested-write assertion marker. Build the joined SQL only when effective
logging/tracing/error diagnostics may expose SQL.

When SQL is not observable, preserve assertion error classification through an
explicit semantic fact or the existing marker sentinel. Do not introduce a
second SQL classifier.

Pin exact SQL for opted-in logs, traces, and errors, plus assertion-floor error
mapping with disclosure disabled.

## Phase 5 — High-value trust-boundary prototypes

These are the largest newly found opportunities. They are not automatic
micro-edits because deleting duplicate work is safe only after one boundary is
proved to own the invariant completely.

### Unit 5.1 — Prove one normalized-result trust boundary

**Measured disposition: rejected after split.** The audit proved that concrete
drivers and documented custom drivers enter through `_execute`, `_executeRaw`,
or `_executeBatch`, which validate generic provider-result shape and total
batch cardinality. Result-parser validation remains a separate semantic model
boundary. Removing the downstream client and executor scans together improved
the declared `atomic-batch-100` full CPU median by 1.73%, but not beyond 2×MAD.
The isolated executor deletion then failed its declared
`bulk-create-returning-100` full CPU target and changed no control beyond
noise. The source and implementation-only tests were restored. Reports:
`/tmp/viborm-unit-5-1.json` and
`/tmp/viborm-unit-5-1-executor.json`.

Current normalized rows are scanned at the driver boundary and again in parts
of `OperationExecutor` and shared client batching. For 1,000/10,000-row reads,
the repeated row-shape checks can cost more than several allocation tweaks
combined.

Before deleting anything:

1. Enumerate every successful result ingress:
   - base `_execute`;
   - base `_executeRaw`;
   - native `_executeBatch`;
   - transaction fallback batch;
   - transaction-bound driver calls;
   - shared client batch;
   - record-series member execution;
   - supported custom/external driver subclass paths.
2. For every downstream `assertNormalizedQueryResult` call, name the malformed
   value it uniquely catches.
3. Add hostile provider tests for malformed result object, missing rows,
   non-array rows, sparse arrays, invalid row members, invalid rowCount, and
   invalid insertId at every real ingress.
4. If the driver public execution boundary catches all of them, document that
   it produces a trusted `QueryResult` and delete only downstream checks whose
   unique failure coverage is empty.
5. If an external/custom ingress bypasses the driver boundary, retain one check
   at that boundary rather than rescanning at every consumer.

Keep normal and batch result-count/cardinality checks distinct when they catch
different failures. This unit applies the project rule “one guard per
invariant”; it does not weaken malformed-provider detection.

Measure 1, 1,000, and 10,000 rows plus 1/10/100 batch results.

### Unit 5.2 — Remove shared-batch result reshaping after Unit 5.1

**Measured disposition: kept.** On the declared `atomic-batch-100`
full-allocation target, direct trusted-result consumption removed 23.0 KB per
operation (0.91%, beyond 2×MAD), or 230 bytes per member. The same cost scaled
to 2.7 KB for ten members and 326 bytes for one member, both beyond 2×MAD.
Complete-operation CPU stayed inside noise, as did the zero-reference and
one-reference nested-transaction controls. Single-statement members now read
their exact indexed result. One full-batch guard owns result shape and total
cardinality. Multi-statement members receive their trusted exact slice without
revalidating slice cardinality and pass the original `QueryResult` objects,
including an optional `insertId`, without wrapper records. Evidence:
`/tmp/viborm-unit-5-2.json`.

Before this unit, the shared client batch sliced each result window, validated
it again, and mapped every normalized result into a new `{ rows, rowCount }`
object. The retained full-batch guard now proves shape and total cardinality
once before those trusted windows are assigned.

After the trust boundary is established:

1. Let the internal parser consume the trusted normalized window directly.
2. Preserve setup/cleanup offsets and per-operation result boundaries.
3. Prove no shared-batch parser relies on removing `insertId`; shared scratch
   is currently refused at preparation.
4. Preserve error attribution to the original operation and statement.

Measure 10 and 100 one-statement operations in one shared native batch.

### Unit 5.3 — Prototype an uncontended serialized-driver queue path

Owner: `drivers/savepoint-queue.ts`.

Sequential SQLite-family statements currently enqueue through a Promise/closure
path even when no job is running or waiting. Prototype an internal idle fast
path:

- the first unbounded job starts under one owned busy state;
- every concurrent or bounded-wait job retains existing FIFO and timeout
  behavior;
- an ordinary query may not interleave with a queued transaction;
- nested savepoints and cleanup retain their current order;
- rejection still releases the queue and starts the next job exactly once.

This likely affects the driver-only floor, but timing semantics are sensitive.
Keep it only if sequential driver execution improves materially and all
concurrency/transaction contracts remain exact.

### Unit 5.4 — Aggregate hot-path ownership-copy audit

Run this unit after every retained Phase 1-4 copy-related edit. It is a
cumulative proof, not a mechanical rewrite.

**Measured disposition: complete; no direct production edit.** The final
cumulative comparison used synthetic base
`95e606dadf02abd51570458c5989cabda22e3c0a` and retained candidate
`fc93a4a269de2d0a2578a8778816d82cc917dd5a`. Both commits contain the same
current protocol (`f9d49656ebfc6557aec91e939dd67ce3630ea9fe7e631f99080305cc095f795a`);
the candidate adds exactly the nine retained production files to the
protocol-only base. It therefore excludes Unit 6.3's rejected adapter JSON
interleavers
while including the corrected linear variant grouping and sole full-batch
result guard. The machine-readable report is
`/tmp/viborm-unit-5-4-final-cumulative.json` (SHA-256
`5235a2447265511d2be938e4960ffdc9ea262518b67cdd6cbace3684dbb69b49`).
Negative values below are improvements by the retained candidate over the base:

| Representative public workload | Allocated bytes/op | CPU median | Wall median |
| --- | ---: | ---: | ---: |
| Scalar read | -3.17% | -1.12% | -4.81% |
| Fixed-target read, 20 rows | -1.88% | -1.69% | -2.38% |
| Fixed-target read, 1,000 rows | -0.06% | -1.30% | -1.49% |
| Variant-target read, 20 rows | -2.88% | -2.71% | -2.84% |
| Variant-target read, 1,000 rows | -0.10% | +0.05% | -0.08% |
| Flat create | -11.07% | -8.30% | -6.47% |
| Flat update | -24.47% | -12.29% | -12.31% |
| Fixed-target nested write | -2.82% | -2.47% | -3.60% |
| Row-held variant-target `createMany`, 100 rows | -8.11% | -4.12% | -3.13% |
| Atomic batch, 100 statements | -8.29% | -10.85% | -10.48% |

The fixed-target 1,000-row allocation and CPU movements and every variant-
target 1,000-row movement stayed inside 2×MAD; the fixed-target wall movement
was a significant improvement. No metric regressed beyond 2×MAD, and every
full-operation pair passed the 10% regression ceiling. This cumulative audit
declared no new target, so its report is deliberately not independently keep-
eligible; the retained units remain authorized by their isolated target reports.
The cumulative run is their final semantic and regression control, and no
retained tranche control failed.

Estimated short-lived allocation churn avoided by the retained candidate is:

| Workload | At 1,000 ops/s | At 10,000 ops/s |
| --- | ---: | ---: |
| Scalar read | 1.14 MB/s | 11.45 MB/s |
| Flat create | 6.23 MB/s | 62.33 MB/s |
| Flat update | 16.32 MB/s | 163.24 MB/s |
| Fixed-target nested write | 4.83 MB/s | 48.34 MB/s |
| Row-held variant-target `createMany`, 100 rows | 128.94 MB/s | 1,289.44 MB/s |
| Atomic batch, 100 statements | 226.55 MB/s | 2,265.46 MB/s |

Fresh source profiles classified the remaining reached sites as follows:

| Profile cluster | Ownership classification and decision |
| --- | --- |
| Scalar reads | At the historical `95e606da...` -> `fc93a4a2...` audit, `ResultParser` field/row parsing, SQL and identifier assembly, argument/rest expansion, and the driver-owned execution-parameter snapshot remained. The later Phase 3 stock-producer proof supersedes only the conclusion about reusable same-key row shells; it leaves every other boundary intact. |
| Fixed-target reads | Provider row/JSON decoding plus fresh nested public row and collection results. Those are required assembly; the previously measured trim candidate remains rejected. |
| Flat update | Validation, SQL/result-shape assembly, and one residual `selectedEntries` filter-result array. Unit 5.4a isolated that array and was rejected by its fixed-read wall control. |
| Fixed-target create | Mutable final INSERT/effective-value assembly plus already-rejected Create scalar, ordinary row-shape, and `TargetConstraint` candidates. One demanded-set spread/filter residue was isolated as Unit 5.4b and rejected by its atomic-batch control. |
| Variant reads: `parseCollectionValue` | Required value assembly: mandatory staging and a fresh public result. Retain. |
| Variant writes: validation and `TargetConstraint` | Required validation/target assembly remains; the tested cleanup was rejected by its performance gate. Retain the existing owners. |
| Atomic batch | Canonical model access, result shaping, and observation. Unit 5.2 already removed the supported redundant reshaping allocation; retain the residue. |
| Flat create | `ResultParser`, SQL/result-shape assembly, and the Create scalar-copy candidate. The assembly is required and the scalar-copy edit was rejected by its split gate. Retain. |

HeapProfiler allocation counts are heuristic source-attribution samples, not
exact object counts. Every reached residual category-3 candidate was therefore
isolated and measured before a decision; the before/after byte, CPU, and wall
measurements own the performance conclusion.

#### Unit 5.4a — Compact `selectedEntries` in place

**Measured disposition: rejected and reverted.** Reusing the fresh
`Object.entries` array removed 380.68 B per flat-update full operation (0.763%,
beyond 2×MAD). The fixed-collection 20-row wall control regressed 1.167%
beyond 2×MAD, so the candidate failed the companion gate. The report is
`/tmp/viborm-unit-5-4a.json`.

#### Unit 5.4b — Scan Create demanded fields once

**Measured disposition: rejected and reverted.** The one-pass demanded-set
scan removed 954.80 B per fixed-row-reference create full operation (0.573%,
beyond 2×MAD), and its initial controls passed. The prescribed isolated
`atomic-batch-100` comparison against the then-current experimental tree
`150964d8…` then regressed
CPU by 25.174%, beyond 2×MAD and the 10% end-to-end ceiling; wall moved
+5.743% inside noise. The decisive report is
`/tmp/viborm-unit-5-4b-atomic-control.json`.

The later aggregate red report that included the rejected candidate is a
falsifier for Unit 5.4b, not accepted cumulative evidence. It does not replace
or amend the final `95e606da…` → `fc93a4a2…` cumulative table above.

**Stop decision.** The fresh profiles exposed two residual private copies, and
both failed an isolated companion gate after clearing their allocation targets.
Every other reached site is mandatory staging, a fresh public result, canonical
model access, SQL/result assembly, validation ownership, or an already-rejected
candidate. Another edit would repeat a failed candidate or add machinery
without evidence. The audit therefore stops unless a new public workload and
source profile establish a different residual category-3 copy above the
continuation gate. Relation resolution remains registration-time work owned by
the existing canonical resolved index; this audit adds no topology cache or
second representation.

#### Static census

1. Refresh the raw spread census for `src/query-engine` and `src/drivers`.
2. Separate at least:
   - array-literal copies;
   - object construction spreads;
   - conditional object spreads;
   - argument expansion;
   - rest declarations/destructuring;
   - comments and documentation.
3. Record the census only as a completeness aid. Do not use the number of
   tokens as a success metric and do not add a lint rule.

#### Dynamic ownership census

For each representative workload from Phase 0:

1. Capture the top allocation source lines in a fresh process.
2. Trace every dynamically reached spread/copy among those frames to its
   semantic owner.
3. Classify it as defensive boundary, required assembly, redundant private
   copy, or argument/rest expansion.
4. For a redundant private copy, prove the source value is fresh, exclusively
   owned, and not observed after ownership transfer.
5. Change one semantic owner at a time and rerun the targeted stage so the
   allocation delta remains attributable.
6. After all retained edits, rerun the complete operation and report the
   cumulative delta; individual sub-noise reductions may add up to a material
   full-path result.

At minimum, audit these already named clusters:

- Create scalar data and generated-field omission;
- insert row shapes, columns, input indexes, and values;
- find joins and cursor order;
- TargetConstraint field collections;
- conditional-arm planning and executor output records;
- ResultParser JSON projection pairs and contextual `(source, field)` slot
  caches;
- driver execution-parameter and diagnostic snapshots;
- atomic-batch queries, diagnostics, SQL, and result windows.

Relation resolution itself is registration-time work, not an operation-path
candidate. A profile that reaches raw target getters, inverse discovery, or a
new fixed/variant topology cache identifies an architectural regression to
remove, not another cache to optimize.

Keep these known ownership boundaries unless a stronger owner is proven:

- `_execute`/`_executeRaw` shallow parameter copies;
- pre-provider diagnostic snapshots when disclosure is possible;
- immutable public configuration/result objects;
- provider transport outer-array separation;
- semantic target, junction, PK, and deduplication keys.

#### Aggregate report and continuation gate

For flat read, flat create, flat update, one nested write, 20-row and 1,000-row
fixed-target reads, matching variant-target reads, and a 100-statement batch,
report:

- total allocated bytes per operation before and after all copy-related units;
- allocation per returned row where applicable;
- estimated allocation churn avoided at 1,000 and 10,000 operations per
  second;
- CPU and wall-time medians/MAD;
- the largest remaining dynamically reached redundant copy;
- every retained defensive copy and the invariant it uniquely owns.

Continue the audit when the residual redundant-copy category exceeds twice the
measured MAD or one percent of the complete operation’s allocation budget.
Stop when remaining sites are required ownership/assembly, cold, or below the
measurement floor. Do not chase a numerical spread-count target.

### Unit 5.5 — Reprofile-only candidates

After all retained phases, inspect fresh profiles before authorizing any of:

- conditional empty-object spreads at named hot call sites;
- traversal of canonical resolved-slot order for variant-target storage
  members, without caching a parallel ordinal or topology map;
- one-pass reference-list aggregation;
- pre-sized arrays where cardinality is already known;
- result-context error metadata allocated only on malformed results.

Each candidate needs a workload that reaches it and a unique semantic proof.
Do not create a general “allocation utilities” module.

## Phase 6 — Cardinality-multiplied second-order costs

The wider audit found a second family of costs that the earlier phases did not
name precisely enough. None is impressive in isolation. Their importance comes
from where they execute:

```text
one public operation
  x predicates
  x selected fields
  x compiled statements
  x returned rows
  x batch entries
```

A fixed object per operation is a small universal tax. A pair array per
selected field or several closures per predicate is a multiplicative tax. The
plan must measure both. At 10,000 operations per second, avoiding 1 KB per
operation removes about 10 MB/s of short-lived allocation pressure even when
no single source line looks alarming.

These units were discovered after Phases 1-5 were written. Their numbering does
not require waiting for every trust-boundary prototype, but the execution order
above still governs. Unit 6.1 is retained. Units 6.3–6.4 and Unit 6.6a's
standalone-optional subunit were measured and rejected. Units 6.2, 6.5, the
remaining Unit 6.6 arms, Units 6.7–6.8, and Units 6.9b–6.9d remain deferred.
Keep each unit independently attributable. Unit 6.9a later landed as supporting
ownership for the retained consumable-row unit.

### Unit 6.1 — Remove identifier-construction protocol churn

Owners:

- `src/adapters/shared/standard-sql.ts::createRawSql`;
- `src/adapters/shared/standard-sql.ts::createIdentifierQuoter`;
- `src/adapters/shared/standard-sql.ts::createIdentifiers`;
- the identifier uses in the shared CTE builders.

**Measured disposition: kept.** The first comparison used a `-20` row-count
workload and did not prove field width. The corrected matrix records the actual
width in each SQL witness and measures 1/20/100 selected columns, ten
predicates, both fixed collection include forms, and 1/20-field creates and
updates. On the declared `wide-scalar-select-100` prepare-allocation target,
direct construction removed 35.8 KB per operation (17.94%, beyond 2×MAD);
prepare CPU fell 26.31%. Full allocation and CPU fell 8.97% and 8.16%. Every
required companion was non-regressing. The protocol-valid five-replicate
report is `/tmp/viborm-unit-6-1-width-matrix.json` (synthetic baseline
`cefb3d3fa74863a4b5baff2e460bb7f4138023f0`, candidate
`7b3d9cc140c54694ffc576b4d4bb549eb8ad0829`).

Identifiers are built for nearly every selected, filtered, joined, ordered,
inserted, and returned column. The current builders route already constructed
strings through the tagged `sql.raw` form, whose interpolation path reduces the
template fragments into another string. The quoter also calls `replaceAll`
when the overwhelmingly common identifier contains no quote character.

Change:

1. Pass already constructed trusted strings to the existing
   `sql.raw(string)` overload directly.
2. Quote with one `indexOf(quoteChar)` check. Use the original name when no
   embedded quote exists; run `replaceAll` only on the escaping branch.
3. Construct each qualified identifier string once before wrapping it in
   `Sql`.
4. Keep expression composition in the normal `sql` tag. This unit removes only
   redundant raw-string protocol work.

Do not add an identifier cache. Model aliases are operation-local, cache
lifetime and invalidation would cost another truth, and repeated construction
must first be shown in a profile.

Proof workloads:

- scalar select with 1, 20, and 100 columns;
- 10 scalar predicates;
- fixed-target collection row-reference and junction includes;
- insert/update with 1 and 20 columns;
- ordinary, quoted, and quote-containing table/column/alias names on all
  dialects.

Keep gate:

- byte-identical SQL and parameter arrays;
- exact embedded quote doubling;
- no parameter appears in a raw identifier fragment;
- construction CPU or allocation improves beyond twice MAD on a wide query;
- no identifier cache or new quoting abstraction is introduced.

### Unit 6.2 — Make scalar-filter construction pay only for the selected operator

Owner: `src/query-engine/builders/where-builder.ts`.

`buildScalarFilter()` and `buildScalarFilterObject()` currently materialize
`Object.entries()` tuples for every filter object. More importantly,
`buildFilterOperation()` creates several closures on every operator and eagerly
builds exact and case-folded text expressions even though one switch arm uses
only a subset. Exact equality can also resolve the same field-reference/SQL
operand more than once.

Implement this as two separately measured edits.

#### 6.2a — Remove tuple arrays

Iterate own enumerable string keys in their existing order and read the value
directly. Preserve:

- `undefined` skipping;
- `mode` handling;
- operator validation and error order;
- nested `not` traversal;
- SQL and parameter order.

Do not replace a parsed-record own-key iteration with an inherited-key
`for...in` assumption unless the parse boundary proves the exact prototype.

#### 6.2b — Demand-drive operator expressions

Keep operator dispatch with `buildFilterOperation`; do not create a filter
strategy table. Move reusable operand operations to module-local functions or
straight-line switch branches so one call does not allocate a family of local
closures. Then:

1. Build `exactTextColumn` only for exact text operations that consume it.
2. Build `foldedTextColumn` only for insensitive operations.
3. Resolve an equality operand once and reuse it for the branch decision and
   emitted comparison.
4. Preserve enum-to-text casts for referenced enum columns.
5. Preserve exact-text index-usable predicates for bound literals.
6. Preserve rejection of field references and SQL fragments in list-only
   operators.

This refactor is kept only when it is at least as legible as the current
operator law. Reject it if the result becomes a mode-bearing helper framework
or materially increases token-bearing code for a sub-noise gain.

Required filter matrix:

- numeric equality and ordered comparison;
- exact text equality;
- insensitive equality, contains, startsWith, and endsWith;
- literal and field-reference enum equality;
- SQL-fragment operands;
- literal `in`/`notIn` and insensitive lists;
- five-deep nested `not`;
- JSON and list filters as unchanged controls.

Measure prepare-only construction for 1 and 10 predicates, then the complete
operation. Keep only with byte-identical SQL/parameters and a prepare-stage
improvement beyond twice MAD without a full-operation regression.

### Unit 6.3 — Preallocate adapter JSON key/value arguments

Owners:

- PostgreSQL `json.object` and `json.objectFromColumns`;
- MySQL `json.object` and `json.objectFromColumns`;
- SQLite `json.object` and `json.objectFromColumns`.

**Measured disposition: rejected and reverted.** The first comparison used a
`-20` row-count workload and did not prove projection width or depth. The
corrected 3×3 matrix records exactly 2/20/100 total fields per relation object
at relation depths 1-3 in each SQL witness; a non-terminal nested relation key
occupies one of those fields. On the declared `relation-projection-100-depth-3`
prepare-allocation target, adapter-local interleavers removed 26.3 KB per
operation (5.37%, beyond 2×MAD); prepare CPU fell 2.21%. Full allocation fell
27.1 KB (2.58%, beyond 2×MAD), while full CPU stayed inside noise. However,
`relation-projection-2-depth-2` prepare CPU regressed by 0.415 µs per operation
(1.69%, beyond 2×MAD), so the companion-cell gate rejects the candidate. The
protocol-valid five-replicate report is
`/tmp/viborm-unit-6-3-depth-matrix-exact.json` (synthetic baseline
`bf0e96af40bd92d0f60e39b9b74df013673b46b3`, candidate
`e09f5c222d863f9bb1cd25ab521f906e12954624`).

Each retained `flatMap` allocates one tiny two-element array per projected field
and then allocates the combined argument array. The rejected candidate used one
adapter-local interleaver that allocated `pairs.length * 2` slots and wrote
key/value entries in order.

The rejected candidate's semantic proof covered:

- preserved PostgreSQL's `::text` key fragments;
- preserved MySQL/SQLite key fragments;
- preserved empty-object special forms;
- preserved key/value and bound-parameter order exactly;
- reused the interleaver for both JSON-object methods in that adapter;
- introduced no cross-dialect JSON strategy or generic allocation helper.

The comparison measured relation projections with 2, 20, and 100 fields and
nested depth 1-3. SQL and parameter snapshots across all adapters were the
primary oracle.

### Unit 6.4 — Tighten the shared INSERT assembler

Owner: `src/adapters/shared/standard-sql.ts::createInsertStatement`.

**Measured disposition: rejected.** On the declared
`bulk-create-returning-100` prepare-allocation target, pre-sized column and row
arrays increased allocation by 716 bytes per operation (0.24%) inside noise.
CPU and full-operation companions also remained within noise, while the
straight-line replacement was longer. It was removed; the upstream create
operation remains the only empty-input guard.

The shared assembler currently maps columns, maps rows through another SQL
wrapper, and creates a fresh empty `Sql` when no prefix exists. The rejected
candidate targeted that row-width and createMany multiplier.

The rejected prototype attempted to:

1. Pre-size and fill the quoted-column array with an indexed loop.
2. Pre-size and fill the row-fragment array with an indexed loop.
3. Reuse `sql.empty` for the absent-prefix case, or branch the template if that
   produces fewer objects without changing grammar.
4. Keep column order, row order, placeholder order, prefix spacing, and the
   current grammar exact. Empty-input refusal is already owned by the public
   create operation; do not add a duplicate adapter guard.

The comparison measured build-only create with 1 and 20 columns and createMany
with 1, 20, and 100 rows. The shared assembler remains the INSERT owner; do not
create a second fast insert builder.

### Unit 6.5 — Remove the public-dispatch envelope allocation

Owner: `src/client/client.ts::createModelProxy`.

Every public model call currently allocates
`{ modelName, operation, args }` only to invoke one of two private callbacks.
Change the callback to positional arguments:

```ts
createOperation(modelName, operation, args)
```

Update the normal and cached client callbacks. Do not capture the resolved
model in the proxy as part of this edit: the current lookup and missing-model
error behavior remain unchanged.

Proof:

- dispatch-only loop compared with direct `engine.prepare`;
- normal and `$withCache` clients;
- missing model, unknown operation, synchronous unique-selector refusal, and
  deferred execution behavior;
- full scalar read/create/update workloads.

This is an internal signature change with no public result or timing change.
Keep it unless measurement shows the runtime already eliminates the envelope
and the source change provides no code simplification.

### Unit 6.6 — Reuse canonical validation results and demand-drive traversal state

Owners:

- `src/validation/primitives/helpers.ts`;
- `src/validation/primitives/optional.ts`;
- `src/validation/primitives/nullable.ts`;
- `src/validation/primitives/json.ts::isJsonValue`;
- `src/validation/primitives/operand.ts::findOpaqueOperand`.

Treat the two representation-preserving candidates independently. The optional
arm is rejected; the other arms remain deferred as stated below.

#### 6.6a — Canonical null and undefined success results

**Measured disposition for the optional wrapper: rejected.** The declared
`scalar-find-many-20` prepare-allocation target improved by 193 bytes per
operation (0.91%, just beyond 2×MAD), but prepare CPU regressed 2.49% and the
full-operation wall median regressed 0.74%, both beyond 2×MAD. The candidate
was removed. Nullable remains deferred for lack of a reaching workload.

The rejected optional prototype reused the existing frozen `OK_UNDEFINED`
object for the standalone wrapper's exact success value. A future nullable
candidate may test `OK_NULL` only with its own reaching workload. Neither arm
may share a mutable or value-bearing success object for arbitrary strings,
numbers, dates, or records.

The operation catalog reached the standalone optional wrapper but not the
standalone nullable wrapper: model-nullable scalars already use the landed
canonical result in `buildValidator`. Do not reapply the rejected `optional.ts`
change. Keep the nullable spelling deferred until a direct workload can prove
it; similarity is not evidence.

The rejected comparison measured empty/simple/nested `where` validation because
missing logical wrappers can invoke several optional validators per query. A
future nullable candidate requires a direct nullable primitive control rather
than borrowing the optional workload.

#### 6.6b — Lazy cycle-state allocation

`isJsonValue` currently allocates a `WeakSet` before it knows whether the value
is composite. `findOpaqueOperand` allocates a `WeakSet` and worklist even for a
primitive root.

Defer both edits in the current tranche. The catalog has neither a JSON-value
nor an opaque-operand workload. In addition, the existing JSON validator
rejects a repeated shared object as if it were a cycle, while this plan's
intended contract says shared references are accepted. Resolve and pin that
semantic question before calling any JSON traversal rewrite
representation-preserving.

- return immediately for primitive roots before creating traversal state;
- create the `WeakSet` only after the first array/object is observed;
- preserve shared-reference acceptance and circular-reference rejection;
- preserve plain-prototype, binary-value, field-reference, and SQL-fragment
  behavior;
- keep the two traversals separate because JSON validity and opaque-operand
  discovery own different invariants.

Measure primitive JSON values, shallow and deep documents, repeated references,
cycles, and full JSON create/update/filter operations.

Do not introduce a second internal validation protocol merely to avoid every
scalar validator's `{ value }` result object. Standard Schema is the current
trust boundary; such a protocol requires separate architectural evidence and a
profile showing validation dominates the complete operation.

### Unit 6.7 — Allocate only top-level SQL tokens

Owner: `src/drivers/shared/sql-statement-tokens.ts`.

Deferred at this baseline: only D1 and PlanetScale consume this tokenizer, and
the SQLite3 benchmark substrate does not reach it. Add a provider-backed
workload before implementing it.

The consumers classify top-level statement structure, but the tokenizer
currently allocates tokens at every parenthesis depth and filters them into a
second array afterwards. Continue scanning nested text for balanced structure,
comments, quotes, placeholders, and statement termination, but append a token
only when it can appear in the final top-level result.

Preserve:

- top-level opening-parenthesis tokens needed by PRAGMA classification;
- correct depth after a closing parenthesis;
- CTE main-command and `RETURNING` detection;
- quoted identifiers, comments, parameters, semicolons, and malformed-depth
  refusal;
- D1 null-result and PlanetScale response classification.

Measure simple SELECT, mutation with RETURNING, deep CTE relation SQL, PRAGMA,
comments/quoted identifiers, and malformed SQL. This is a classifier
optimization, not a SQL parser rewrite.

### Unit 6.8 — Bypass dependency leveling for one planning read

Owner: `OperationExecutor.executePlanningLevels()`.

Deferred at this baseline: the batch catalog distinguishes produced-value
references, not the controlled single planning-read path this unit changes.
Add zero/one/four planning-read workloads and provider call-count evidence
before implementing it.

After the method has proved every planning step is a read, handle
`reads.length === 1` directly through the existing `runLinearStep()` path. The
current code calls `planningLevels()` first, which allocates its dependency map,
level array, and bucket only to discover the already existing one-read path.

Keep:

- the non-read whole-fragment fallback;
- the runtime-values map and normal output resolution;
- unresolved-reference and postcondition behavior;
- one ordinary driver statement call, never `_executeBatch`, for the single
  read.

Benchmark zero, one, and four independent planning reads on a controlled
batch-only driver and assert provider call counts alongside timing.

### Unit 6.9 — Measured fixed per-operation wrappers

These candidates are broad but individually tiny. Prototype them one at a
time; do not keep them merely because the source looks cleaner.

#### 6.9a — One executor pair per engine

**Measured disposition: retained as part of the consumable-row unit, not as an
independent performance claim.** `QueryEngine` resolves the stock
consumable-result candidate once and owns the ordinary executor. When that
candidate exists it also owns one candidate-free executor for cache-managed
reads; otherwise both paths share the ordinary executor. `PendingOperation`
receives the selected executor instead of allocating or caching one per public
operation. A transaction-bound engine owns its own candidate-free execution
context because its driver is not the registered active producer.

`OperationExecutor` retains the engine and the optional immutable candidate;
all per-execution parser, shape, compiled program, proof, result, and output
state stays local to the method call. Concurrent operations therefore share no
mutable execution state. Do not fold the two executors together with a per-call
cache/provider branch.

#### 6.9b — Avoid default empty option bags

Audit default `= {}` parameters in `buildFind`, `buildFindUnique`,
`buildSelect`, `buildInclude`, and `buildSelectWithAliases`. Where the function
only reads optional fields, accept `undefined` and use optional access rather
than allocating an empty object. Preserve overloads and public call shapes.

Measure flat reads and recursive relation selection. Do not introduce a shared
mutable empty bag.

#### 6.9c — Tighten the unique-selector scan

In `client/unique-where-guard.ts`, replace the `Object.keys(where).some(...)`
key array and callback with an own-enumerable early-exit loop. Preserve
synchronous error timing, Proxy enumeration behavior, and the exact five
operation families. The distinct-truth result-contract phase did not run, so
the Set is a retained owner; change it only if this unit's own profile reaches
it.

#### 6.9d — Demand-drive `PendingOperation.options`

This is a compatibility-sensitive prototype because `PendingOperation` is
public. Store the normalized facts needed internally as primitive fields and
materialize one frozen `options` object lazily only when public code reads it.
Preserve stable object identity, `originalOperation`, `throwIfNotFound`,
`skipSpan`, and wrapped-operation behavior. Do not silently delete or repair
the currently unused `throwIfNotFound` field in a performance unit.

Keep each subunit only with a complete-operation allocation improvement beyond
twice MAD or a measurable aggregate contribution in Unit 5.4. Do not combine
them into a generic request context or options carrier.

### Phase 6 aggregate gate

Add these dimensions to the Unit 5.4 ownership-copy report:

- allocations per public dispatch;
- allocations per scalar predicate;
- allocations per selected JSON field;
- allocations per inserted row;
- allocations per SQL token retained versus scanned;
- allocations for zero, one, and four planning reads.

For each retained Phase 6 unit, report both the local multiplier and the
complete-operation effect. A local improvement may be kept below the complete
operation's standalone noise only when the combined Phase 6 result is stable
across five alternating baseline/candidate processes and exceeds twice the
aggregate MAD. Otherwise remove it rather than accumulating clever code whose
benefit exists only in a microbenchmark.

## Distinct-truth and relation-resolution closure at this baseline

The previous deferral is closed. Classify its subjects explicitly rather than
waiting on completed or rejected phases:

### Landed — optimize only the surviving consumer

- `PlanningFragment.outputs` / `planningOutputs()` are deleted; planning
  publication is derived.
- Parsed-record parallel relation collections are deleted; one ordered
  `ParsedRelationMutation[]` owns the payload's relation work.
- Statement-reference discovery has one owner in `OperationFragment.ts`;
  `statementHasReferences()` makes Unit 2.8 actionable now.
- Repeated `getRelationInfo`, raw target resolution, consumer inverse scans, and
  query-time topology reconstruction are replaced by the schema-wide
  `ResolvedRelationIndex` and contextual `ResolvedSlot` views.

Do not optimize or recreate any deleted spelling. In particular, no model-owned
variant storage map, relation-info facade, inverse cache, parallel fixed/variant
collection, or per-operation topology scan may return under a performance
name.

### Retained after measured rejection

- Independent result-shape/select/include traversal and repeated default
  selection remain because compiled selection was rejected at its Phase 10
  gate.
- Operation-name result carriers, routing Sets, and repeated operation
  normalization remain because conditional Phase 11 did not run.
- Fragment-validation temporary collections may be reprofiled now that their
  canonical reference owner exists, but no second reference representation may
  be introduced.

These are local reprofile-only candidates, not architectural debts scheduled
for automatic deletion. Count-result transport remains outside this micro plan.
Provider-certified scalar and whole-row identity parsing already exists for the
proven native-passthrough subset. The retained consumable-row path does not
broaden identity: it separately requires an exact stock active-producer proof
and lets the same compiled parser decide whether a same-key row is `reusable`.
Broader identity without its complete adapter-plus-driver proof remains
rejected.

## Rejected optimizations

Do not implement these as part of this plan:

- a second flat scalar compiler;
- a query-result or query-argument cache;
- a prepared-statement cache;
- a global/cross-operation `ResultParser` cache;
- post-provider diagnostic sanitization;
- a lazy correlation getter without trusted snapshot reuse;
- nested OwnWrite early exits;
- delimiter-based replacements for semantic JSON keys;
- frozen shared Maps/Sets as an immutability claim;
- raw provider outer-array return;
- provider ownership markers, tokens, or public row modes;
- skipping adapter/driver parser callbacks based on provider names or function
  shape;
- transaction-option validation removal;
- a second internal validation protocol whose only purpose is avoiding scalar
  `{ value }` result objects;
- a shared mutable empty args/options object;
- a global identifier or SQL-fragment cache;
- a model-owned relation order, variant-storage map, inverse cache, relation-info
  facade, or any topology fact parallel to `ResolvedRelationIndex`;
- a universal no-spread, no-map, or no-closure rewrite rule;
- a generic allocation helper, pooling framework, object arena, or mutable
  scratch context.

A flat-write compiler bypass might offer a larger architectural gain than this
plan, but it is outside scope. It is acceptable only as a separate prototype
that proves it remains one record compiler rather than creating a second scalar
truth.

## Validation matrix

### Per unit

Run the narrowest applicable memory-capped layer scripts, followed by the
targeted benchmark stages. Never overlap test, TypeScript, or benchmark runs.

| Changed area | Minimum validation |
| --- | --- |
| query construction/write engine/executor | `pnpm test:layer:query-engine`, `pnpm test:types` |
| validation primitives | `pnpm test:layer:validation`, `pnpm test:types` |
| shared SQL/adapters | `pnpm test:layer:adapters`, `pnpm test:layer:query-engine`, `pnpm test:types` |
| driver/context/batch | `pnpm test:layer:drivers`, `pnpm test:layer:instrumentation`, `pnpm test:types` |
| result parser/select builder | `pnpm test:layer:query-engine`, `pnpm test:layer:adapters`, `pnpm test:layer:drivers`, `pnpm test:types` |
| client dispatch/shared batch | `pnpm test:layer:client`, `pnpm test:layer:drivers`, `pnpm test:layer:query-engine`, `pnpm test:types` |
| SQLite-family conversion/queue | affected provider contracts through repository launchers |

### Final validation

```bash
pnpm test:types
pnpm package:build
pnpm test
```

Run `pnpm test:all` only after focused and layer validation is green. Run
provider contracts when services are available and report exact skips.

Use the repository-pinned Biome version only on files owned by the current
unit. Do not run a global `fix` command in a dirty worktree. The old commands
`pnpm test:gates` and `pnpm dlx ultracite ...` are not valid instructions for
this repository state.

### Behavioral parity report

For every retained unit, report:

- files and symbols changed;
- operation shapes measured;
- five-process median and MAD before/after;
- allocation per operation and, where relevant, per row;
- aggregate CPU and wall time;
- SQL, parameter, statement-count, step-order, guard, expectation, pin, and
  error parity evidence;
- focused and layer test results;
- whether the change was kept for measured performance or only for simpler
  code.

## Expected qualitative result

The plan now targets six distinct costs instead of treating every allocation
as equivalent:

1. **Public-dispatch cost:** proxy envelopes, operation options, routing, and
   executor ownership. Per-operation executors are gone; one engine-owned
   ordinary executor and, only when needed, one candidate-free cache executor
   serve the client.
2. **Validation and predicate cost:** optional-result boxes, traversal state,
   filter tuple arrays, closures, and unused expression branches.
3. **Per-field SQL construction cost:** identifiers, projection arguments, and
   recursive selection builders.
4. **Write construction cost:** dormant fresh-record state, OwnWrite root
   setup, insert row assembly, grouping, scratch UUIDs, and executor records.
5. **Per-result cost:** parser caches, wrapper chains, JSON carrier copies, and
   duplicate normalized-row scans.
6. **Batch and provider cost:** diagnostic sidecars, SQL concatenation,
   tokenization, queueing, validation, and result reshaping.

The ownership-copy audit reports the cumulative contribution across all six
cost classes. It prevents individually small array/object copies from escaping
attention merely because each one falls below the standalone noise floor.

The broadest-reach units are classified rather than forecast:

- direct identifier construction in Unit 6.1 and shared-batch result reshaping
  in Unit 5.2 are retained;
- conditional pre-provider diagnostics, trusted context reuse plus lazy
  correlation, and atomic-batch sidecars remain deferred Phase 4 prototypes;
- dormant `CreateOperation` state in Unit 2.1, scalar-filter construction in
  Unit 6.2, and the serialized-driver queue path in Unit 5.3 remain deferred;
- duplicate normalized-result rescans in Unit 5.1, adapter JSON argument
  interleaving in Unit 6.3, and shared INSERT pre-sizing in Unit 6.4 were
  measured and rejected.

The best outcome is not merely fewer allocated bytes. It is less work because
the engine represents each necessary fact once, computes it only when a
consumer asks for it, and keeps every correctness boundary explicit.
