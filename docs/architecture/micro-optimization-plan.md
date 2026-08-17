# Operation-pipeline allocation and CPU optimization plan

## Status

This is the execution-ready revision of the earlier write-path micro-
optimization plan. It incorporates a source audit of the live driver,
instrumentation, query-construction, write-engine, executor, result-parser, and
benchmark paths.

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
- relation and polymorphic-relation reads;
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
- The current `ResultParser`, driver wrappers, `Sql`, and benchmark files have
  concurrent work in the worktree. Their post-change state must become the
  baseline; do not optimize or compare against an obsolete pre-change copy.

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
typed read-only, never exposed to code that can mutate it, and not scheduled for
deletion by the distinct-truth plan.

### Result aliasing

Result parsing may reuse trusted row objects where the current contract permits
it. It may not return the provider’s outer row array directly: callers must not
gain an alias to provider-owned transport storage.

### Spread syntax and copy ownership

The live query-engine and driver tree contains 584 textual `...` occurrences,
including 92 explicit array-literal copies of the form `[...value]`. This is a
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

| Candidate from the old plan | Decision | Correction |
| --- | --- | --- |
| Lazy diagnostic sanitization | Prototype | Make the pre-provider snapshot conditional on actual parameter-disclosure demand. Never sanitize after provider execution. |
| Lazy correlation ID | Prototype jointly | Combine with trusted context identity reuse; alone it is immediately forced. |
| Context snapshot reuse | Prototype jointly | A bound context and fallback operation are always supplied today, so the old short-circuit condition was unreachable. |
| Observer wrapper gate | Keep | Gate both operation observers on configured tracing/logging, not on the always-present no-op tracer. |
| SQLite value conversion | Keep per driver | SQLite3/Bun/D1 may return the input when unchanged; libSQL must still validate/narrow into `InValue[]`. |
| Single-row insert shape | Keep | Bypass grouping key construction and preserve contiguous grouping for multiple rows. |
| Value-group push loops | Keep | Transfer ownership of fresh `inputIndexes`; do not copy it defensively again. |
| TargetConstraint Set/spread cleanup | Reprofile | Root OwnWrite bypass may remove it from flat-create profiles. If retained, sort and compact one array in place. |
| Create scalar copy | Keep | Reuse parsed scalar data when no field must be omitted and no shared-key merge is needed. |
| OwnWrite early return | Keep at root only | Never skip nested analysis. |
| Returning-clause scan | Keep | Scan SQL string segments directly; do not join and trim. |
| Generic idiom sweep | Reject | Each occurrence needs its own hot-path evidence and semantic proof. |
| Lazy ResultParser maps | Keep after current parser work | There are four maps, including `nestedRowParsers`. |
| Field-chain specialization | Prototype | Preserve adapter/driver callback and error behavior; remove only wrappers proven absent. |
| Shared result-shape empties | Defer | Compiled selection is intended to delete that result-shape owner. |
| Memoized `defaultSelect` | Defer | Compiled selection should own projection meaning once. |
| JSON projection copy-on-write | Keep | Return the original pairs until the first bigint/decimal/blob conversion. |
| SQLite prepared-statement cache | Reject here | It changes handle lifetime, retained heap, `safeIntegers` behavior, schema invalidation, and connection ownership. |

## Phase 0 — Repair and split the proof surface

No production optimization starts until this phase is complete.

### Unit 0.1 — Stabilize the baseline owner

1. Record the starting commit, branch, runtime versions, CPU, and operating
   system.
2. Record dirty files. The current ResultParser, Sql, driver-wrapper, and
   benchmark work must either land or be isolated before the baseline is
   measured.
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
| ordinary relation read, 20 and 1,000 rows | prepare, execute, parse, raw+parse, full |
| polymorphic relation read, 20 and 1,000 rows | parse, full |
| enum-heavy read, 20 and 1,000 rows | parse, full |
| flat create with explicit ID | prepare, execute, raw+parse, full |
| flat create with database-generated ID | same |
| flat scalar update | same |
| relation-bearing create and update | prepare, full |
| atomic batch, 1/10/100 statements | prepare, execute, full |
| nested transaction with zero vs one inter-step reference | prepare, full |
| many-and-return, 100 rows | prepare, parse, full |

### Unit 0.5 — Performance keep gate

A performance-specific implementation is retained only when:

- its targeted median improves by more than twice the measured MAD;
- no targeted workload regresses by more than twice MAD;
- no corresponding full operation regresses materially;
- no end-to-end pair regresses by more than the repository-wide 10% ceiling;
- behavior tests and byte-level SQL/fragment witnesses remain green;
- the implementation does not add more conceptual machinery than the work it
  removes.

If a local rewrite is also plainly simpler and allocation-neutral, it may be
kept as a simplification, but it must not be reported as a performance win.

## Phase 1 — Universal low-risk fast paths

These units are independent. Implement and measure them one at a time.

### Unit 1.1 — Gate operation observation before allocation

Owner: `src/query-engine/execution-context.ts`.

For `observeOperationExecution()`:

1. Read the effective instrumentation configuration.
2. If neither tracing nor logging is configured, return `execute(undefined)`
   before building attributes, reading the correlation ID, calling
   `Date.now()`, or allocating the inner async closure.
3. If logging exists without tracing, preserve error observation but do not
   build span attributes or invoke the no-op tracer.
4. Gate on configured tracing, not on tracer object truthiness. The
   instrumentation context can contain a no-op tracer.

Apply the analogous fast path to `observePendingBatchPhase()`:

- success without instrumentation bypasses span/log plumbing;
- failure must still pass through driver-error normalization even when no
  instrumentation is configured.

Proof:

- no instrumentation;
- logging only;
- tracing configured but disabled by provider state;
- active tracing;
- successful operation and thrown driver error;
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

Walk each `returning.strings` segment and each character until a non-whitespace
character is found. Do not allocate the joined string or trimmed copy. The
answer remains a property of the built SQL, not an inferred adapter capability.

### Unit 1.4 — Remove small unconditional read-builder arrays

Implement as three separately measured edits:

1. In `builders/orderby-builder.ts::buildOrderByInternal`, allocate relation
   alias state only when the first relation order is encountered. Scalar-only
   order must allocate no relation map.
2. In `operations/find-common.ts::buildFind`, reuse the one non-empty joins
   array when either lateral joins or order joins is empty; concatenate only
   when both contain elements.
3. In `operations/cursor-order.ts::normalizeCursorOrder`, reuse the private
   fresh array returned by `parseRequestedScalarOrder()` and populate the
   ordered-field set in one loop instead of copying then mapping.

Preserve relation alias insertion order, cursor tie-breaker order, null-order
semantics, and input immutability.

### Unit 1.5 — Indexed normalized-batch validation

Owner: `src/drivers/normalized-result.ts::assertNormalizedBatchResults`.

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

At `assertCreateOwnWriteSafety()` and `assertUpdateOwnWriteSafety()`:

1. Test that both the root ordinary-relation map and polymorphic-relation map
   have zero own keys.
2. Return before constructing the analysis tree.
3. Leave `analyzeCreate()` and `analyzeUpdate()` unchanged for recursive calls.

Add a falsifier showing that a nested relation-free insert/update still
contributes the existing barrier/target/transition fact to an enclosing
relation-bearing operation.

### Unit 2.3 — Avoid needless Create scalar copies

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
- `builders/values-builder.ts`.

For one row:

- compute active fields once;
- return one group without a grouping key.

For multiple rows:

- preserve maximal contiguous runs;
- compare the new field list elementwise with the active group’s field list;
- never reorder rows or merge non-contiguous equal shapes.

When lowering value groups:

- build columns and row values with push loops;
- append private polymorphic values only when present;
- transfer the freshly created `inputIndexes` array rather than copying it;
- express that ownership in the internal type without an assertion.

Pin heterogeneous rows, generated defaults, destination casts, polymorphic
private storage, skip-duplicate grouping, and returned-input order.

### Unit 2.5 — Reprofile TargetConstraint after the root bypass

Do not change `TargetConstraint` before Unit 2.2 is measured. If it disappears
from flat create/update profiles, restrict this unit to the nested-write
workload that still names it.

If retained:

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

### Unit 2.8 — Reference-free SQL materialization after distinct-truth Phase 9.5

This unit depends on the canonical statement-reference extractor planned in
`query-engine-distinct-truth-compression-plan.md`, Phase 9.5.

Once that fact exists, make `materializeLinearSql()` and
`materializeBatchSql()` return the original `Sql` when a statement contains no
`OperationValueReference`. Do not add a second reference scanner for this
optimization.

Whenever a reference exists, preserve:

- reference resolution order;
- optional missing-reference-to-`NULL` behavior;
- batch-reference lowering;
- the original SQL strings and non-reference values.

### Unit 2.9 — Measured nested-only local candidates

Profile these separately after the preceding units:

- direct loops in `conditionalArmPlanning` instead of
  `Object.fromEntries`/`Object.entries` churn;
- one-pass classification in `resolveOutputList` for 100-row
  many-and-return folds;
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

### Unit 3.0 — Adopt current ResultParser work as baseline

Concurrent work already implements:

- nested row-parser reuse;
- zero-copy row-array validation;
- pre-sized parsed-row output;
- allocation-free expected-key counting;
- reuse of compiled nested parsers in ordinary and polymorphic relation reads.

Do not reimplement these changes. Land or isolate them, run their contracts,
and measure their post-change state before starting this phase.

### Unit 3.1 — Lazily allocate all four ResultParser caches

Owner: `result/ResultParser.ts`.

Make these caches optional and initialize them in their owning getters:

- `fieldChains`;
- `relationChains`;
- `polymorphicChains`;
- `nestedRowParsers`.

Expected allocation shape:

- count-only result: none of the four;
- scalar row: field cache only;
- ordinary include: field, relation, and nested-row caches as demanded;
- polymorphic include: polymorphic cache only when encountered.

### Unit 3.2 — Specialize field chains and cache enum membership

Build the smallest exact chain for each scalar:

- no driver-field wrapper when `driver.result.parseField` is absent;
- no legacy-decimal wrapper unless number compatibility is active;
- adapter field parsing remains mandatory unless an explicit provider
  capability proves identity;
- provider decoding errors retain the same typed error and operation metadata.

Cache enum membership in a module-local `WeakMap<Scalar, ReadonlySet<string>>`.
Do not add a mutable cache to public scalar/model state.

This is a prototype, not a mechanical rewrite. Keep it only if scalar and enum
parse workloads improve beyond noise.

### Unit 3.3 — Avoid trimmed JSON relation copies

Owner: `src/adapters/shared/result-parsing.ts::tryParseJsonString`.

Scan from both ends for JSON whitespace (`space`, tab, carriage return, line
feed), inspect the first and last meaningful characters, and pass the original
string to `JSON.parse`. Preserve current behavior for:

- whitespace-only strings;
- non-JSON strings;
- malformed arrays/objects;
- valid JSON surrounded by whitespace.

Measure SQLite/MySQL relation carriers at 20 and 1,000 rows.

### Unit 3.4 — Copy-on-write JSON scalar projection pairs

Owner: `builders/select-builder.ts::castNumericPairsForJson`.

Return the input pairs when no selected scalar is bigint, decimal, or blob. On
the first affected field, allocate one output array, copy the prefix once, and
append transformed or original pairs from that point.

Prove callers treat the input pair array and tuples as immutable after the
call.

### Unit 3.5 — Reuse allocation-free polymorphic envelope key checks

`polymorphic-result-parser.ts::hasExactKeys` still builds `Object.keys()` per
carrier. Reuse the exact-own-enumerable-string-key primitive introduced by the
current result-parser work. Preserve treatment of inherited, symbol, and
non-enumerable members.

### Deferred result-path work

Do not implement these in the micro plan:

- shared empty result-shape maps/sets;
- memoized `defaultSelect`;
- manual optimization of `selectedEntries()`;
- count-result transport rewrites;
- provider-certified whole-row identity parsing.

Result-shape/default-selection traversal is owned by the distinct-truth
compiled-selection phase. Count transport belongs to its result-contract
phase. Cross-operation `ResultParser` caching is rejected below. Provider-
certified per-scalar identity parsing is potentially large—for example, a
SQLite text-only selection need not lose all passthrough because the same
driver can decode booleans and JSON—but it belongs in the compiled-selection
prototype, where one compiled field decoder can prove the complete adapter-
plus-driver chain. A false identity declaration would bypass strict scalar
validation, so it is not a local shortcut.

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

The shared client batch currently slices each result window, validates it
again, and maps every normalized result into a new `{ rows, rowCount }` object.

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
- ResultParser JSON projection pairs;
- driver execution-parameter and diagnostic snapshots;
- atomic-batch queries, diagnostics, SQL, and result windows.

Keep these known ownership boundaries unless a stronger owner is proven:

- `_execute`/`_executeRaw` shallow parameter copies;
- pre-provider diagnostic snapshots when disclosure is possible;
- immutable public configuration/result objects;
- provider transport outer-array separation;
- semantic target, junction, PK, and deduplication keys.

#### Aggregate report and continuation gate

For flat read, flat create, flat update, one nested write, a 20-row relation
read, a 1,000-row relation read, and a 100-statement batch, report:

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
- cached immutable schema order for polymorphic storage members;
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
not require waiting for every trust-boundary prototype: after Phase 0 is green,
the local KEEP units may run beside their owning construction, validation, or
driver phase. Keep each unit independently attributable.

### Unit 6.1 — Remove identifier-construction protocol churn

Owners:

- `src/adapters/shared/standard-sql.ts::createRawSql`;
- `src/adapters/shared/standard-sql.ts::createIdentifierQuoter`;
- `src/adapters/shared/standard-sql.ts::createIdentifiers`;
- the identifier uses in the shared CTE builders.

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
- one-to-many and M2M includes;
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

Each current `flatMap` allocates one tiny two-element array per projected field
and then allocates the combined argument array. Replace it with one
adapter-local interleaver that allocates `pairs.length * 2` slots and writes
key/value entries in order.

Rules:

- preserve PostgreSQL's `::text` key fragments;
- preserve MySQL/SQLite key fragments;
- preserve empty-object special forms;
- preserve key/value and bound-parameter order exactly;
- reuse the interleaver for both JSON-object methods in that adapter;
- do not introduce a cross-dialect JSON strategy or generic allocation helper.

Measure relation projections with 2, 20, and 100 fields and nested depth 1-3.
SQL and parameter snapshots across all adapters are the primary oracle.

### Unit 6.4 — Tighten the shared INSERT assembler

Owner: `src/adapters/shared/standard-sql.ts::createInsertStatement`.

The shared assembler currently maps columns, maps rows through another SQL
wrapper, and creates a fresh empty `Sql` when no prefix exists. This cost
multiplies by inserted row width and createMany row count.

Change:

1. Pre-size and fill the quoted-column array with an indexed loop.
2. Pre-size and fill the row-fragment array with an indexed loop.
3. Reuse `sql.empty` for the absent-prefix case, or branch the template if that
   produces fewer objects without changing grammar.
4. Keep column order, row order, placeholder order, prefix spacing, and the
   current empty-input refusal behavior exact.

Measure build-only create with 1 and 20 columns and createMany with 1, 20, and
100 rows. This remains the shared INSERT owner; do not create a second fast
insert builder.

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

Implement two independent representation-preserving edits.

#### 6.6a — Canonical null and undefined success results

Reuse the existing frozen `OK_NULL` and `OK_UNDEFINED` objects wherever the
standalone optional/nullable wrappers return those exact values. Do not share a
mutable or value-bearing success object for arbitrary strings, numbers, dates,
or records.

Measure empty/simple/nested `where` validation because missing logical wrappers
can invoke several optional validators per query. Include direct nullable and
optional primitive controls.

#### 6.6b — Lazy cycle-state allocation

`isJsonValue` currently allocates a `WeakSet` before it knows whether the value
is composite. `findOpaqueOperand` allocates a `WeakSet` and worklist even for a
primitive root.

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

#### 6.9a — One stateless executor per engine

`OperationExecutor` retains only its `QueryEngine`; execution state is local to
each method call. Demand-drive one executor per `QueryEngine` and let
`PendingOperation` use it instead of retaining an `executorInstance` and
`executor()` cache per operation. A transaction-bound engine owns its own
executor.

Verify concurrent operations do not share mutable execution state and that no
runtime write-engine import cycle is introduced. Measure the first operation
separately from sustained operations.

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
operation families. Before changing the operation-family Set, verify that the
distinct-truth operation contract is not about to delete it.

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

## Explicitly deferred to distinct-truth compression

The following may improve speed, but optimizing their current implementation
would preserve an owner scheduled for deletion:

- `PlanningFragment.outputs` and `planningOutputs()`;
- independent result-shape/select/include traversal;
- repeated default-selection construction;
- operation-name result carrier sets;
- parsed-record parallel relation collections;
- repeated `getRelationInfo`, `getPrimaryKeyFields`, `bindRelation`, and inverse
  topology reconstruction;
- fragment-validation `StepRecord`, output-Set, and temporary reference-array
  allocations before one statement-reference owner exists;
- operation-family routing Sets and repeated operation normalization before the
  result/operation contract owns those facts;
- direct reference scanning in SQL materializers before Phase 9.5.

Add performance acceptance to the owning phases of
`query-engine-distinct-truth-compression-plan.md` instead:

- Phase 1: immutable model key catalog;
- Phases 2/4/7: inverse and relation topology;
- Phase 6: parsed mutation dispatch;
- Phase 9.1: derived planning outputs;
- Phase 9.5: one statement-reference fact;
- Phase 10: compiled selection;
- Phase 11: result transport contract.

Provider-certified per-scalar identity parsing should be investigated with the
compiled-selection phase. It can be a large relation-read win, but only a
compiled field decoder knows whether the complete adapter-plus-driver chain is
identity for the selected scalar.

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
- skipping adapter/driver parser callbacks based on provider names or function
  shape;
- transaction-option validation removal;
- a second internal validation protocol whose only purpose is avoiding scalar
  `{ value }` result objects;
- a shared mutable empty args/options object;
- a global identifier or SQL-fragment cache;
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

Use the repository-pinned Ultracite version only on files owned by the current
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
   per-operation executor ownership.
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

The largest likely gains are no longer presented as guaranteed numbers. They
are the units with the broadest proven reach:

- conditional pre-provider diagnostics;
- trusted context reuse plus lazy correlation;
- allocation-light identifier and scalar-filter construction;
- preallocated JSON-object and INSERT assembly;
- dormant CreateOperation state;
- duplicate normalized-result validation, if the driver boundary proof holds;
- shared-batch sidecar/result compression;
- an uncontended serialized-driver queue path, if concurrency parity holds.

The best outcome is not merely fewer allocated bytes. It is less work because
the engine represents each necessary fact once, computes it only when a
consumer asks for it, and keeps every correctness boundary explicit.
