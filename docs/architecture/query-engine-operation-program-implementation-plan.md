# Query Engine Operation Program Reorganization Plan

## Status

**Proposed. Not implemented.**

This document turns the July 2026 query-engine simplification discussion into
an incremental implementation plan. It is subordinate to the established
correctness and interoperability contracts: no structural milestone is
complete unless the same portable behavior remains green across PostgreSQL,
MySQL, SQLite, LibSQL, PGlite, transactional drivers, and batch-only drivers.

Companion documents:

- [Query Engine Correctness Remediation Plan](./query-engine-correctness-remediation-plan.md)
- [Codebase Reliability Remediation Plan](./codebase-reliability-remediation-plan.md)
- [Code Quality and Simplification Audit](./code-quality-simplification-audit.md)
- [Historical Total Plan IR Proposal](./engine-unification/design-total-ir.md)

The companion documents describe the correctness history and the structural
problems that motivate this work. This document is the implementation contract
for the reorganization itself.

## Concise Destination

```text
Client
└── QueryEngine                         one per client or transaction scope
    └── PendingOperation               one per user operation
        ├── OperationCompiler
        │   └── OperationProgram
        │       └── Read | Write | Guard | Branch
        ├── OperationRuntime
        │   └── Direct | Transaction | Atomic batch
        └── OperationResults
```

```text
validated operation
→ compile one universal operation program
→ execute it according to driver capabilities
→ resolve its declared result
```

A simple query is a one-step program. A nested relation write is a larger
program composed from the same primitives. There is no separate nested-write
engine in the target architecture.

## Purpose

The correctness remediation made VibORM materially safer and more portable,
but the query-engine structure expanded beyond a clear ownership model.

The audited baseline is approximately:

| Scope | Current size |
| --- | ---: |
| `src/query-engine/` files | 121 |
| `src/query-engine/` TypeScript LOC | 24,204 |
| `operations/nested-writes/` files | 44 |
| `operations/nested-writes/` TypeScript LOC | 10,140 |

The problem is not the numbers alone. The engine currently expresses one
operation lifecycle through several parallel routes:

- direct statement execution;
- nested-write interpreter execution;
- bulk-create planning;
- non-`RETURNING` mutation emulation;
- many-row mutation refetch;
- direct preparation;
- nested atomic-batch preparation;
- result parsing closures stored in `QueryMetadata`.

The target is one operation object, one compiled program shape, one runtime
selection point, and one result contract.

## Agreed Architectural Decisions

### 1. `PendingOperation` is the operation object

Do not introduce a separate `QueryOperation` class.

`PendingOperation` already represents the public deferred operation. It will
become the real lifecycle owner instead of delegating through a `QueryMetadata`
closure bag.

```text
Before

PendingOperation
└── QueryMetadata
    ├── execute closure
    ├── prepare closure
    ├── prepareBatch closure
    └── parseResult closure

After

PendingOperation
├── compile()
├── execute()
├── executeWith()
├── prepare()
├── prepareBatch()
├── OperationCompiler
├── OperationRuntime
└── OperationResults
```

### 2. `QueryEngine` is a client-scoped owner, not a passthrough

`QueryEngine` remains only if it becomes the canonical owner of shared query
state:

- driver;
- model and schema registry;
- instrumentation;
- root client identity;
- transaction-scope identity;
- creation of `PendingOperation` children.

The client must not retain duplicate copies of the same query infrastructure.
If `QueryEngine` cannot become that owner, it must be deleted rather than kept
as a forwarding class.

### 3. Every operation compiles to `OperationProgram`

```ts
interface OperationProgram<T> {
  readonly steps: readonly OperationStep[];
  readonly result: OperationResult<T>;
  readonly atomicity: "statement" | "operation";
}

type OperationStep =
  | ReadStep
  | WriteStep
  | GuardStep
  | BranchStep;
```

Sequence is the step array. Branch arms contain step arrays. A separate
`SequenceStep` is not required unless the implementation proves otherwise.

### 4. Use a balanced logical representation

The program represents operation semantics, not the whole SQL language.

It owns:

- ordered reads and writes;
- produced-value dependencies;
- guards and their typed failures;
- branches;
- atomicity;
- result ownership.

Existing SQL builders and adapters continue to own:

- filters and predicates;
- projections and includes;
- joins and correlation;
- grouping, aggregation, ordering, and pagination;
- dialect functions, quoting, literals, and capabilities.

The implementation must not create a second full SQL AST.

### 5. Produced values are first-class operation values

A value generated or discovered by one step can be consumed by a later step
without a runtime callback closure.

```ts
type OperationValue =
  | LiteralValue
  | SqlValue
  | ProducedValue;
```

The transaction runtime resolves `ProducedValue` to a concrete value. The
batch runtime lowers the same reference through its ordered scratch-value
mechanism. The operation owns the symbol namespace.

### 6. Batch branching specializes the same semantic program

The transaction runtime evaluates a branch against live transaction state.
The batch runtime may perform a decision read before batch execution, choose
an arm, and emit guards that pin the premise. This is runtime specialization,
not a second relation implementation.

### 7. Client identity and execution scope are separate

`clientId` identifies the originating client. `scopeId` identifies the root or
transaction-bound execution scope. A transaction-bound engine preserves the
client identity and receives a new scope identity.

### 8. Relation mutations belong under writes

```text
OperationCompiler
├── ReadOperations
└── WriteOperations
    └── RelationMutations
```

Relations expand write programs. They are not peers of the compiler and are
not owned directly by `PendingOperation`.

## Target Responsibilities

### `QueryEngine`

- Own immutable client-scoped query dependencies.
- Own `clientId` and the current `scopeId`.
- Create `PendingOperation` children.
- Create a transaction-bound engine with the same `clientId` and a fresh
  `scopeId`.
- Expose compilation/build inspection only when it is a real supported API.

It must not validate, compile, execute, or parse individual operations itself.

### `PendingOperation`

- Own model, operation, raw arguments, options, and execution context.
- Preserve lazy validation and lazy execution.
- Preserve Promise-like memoization and execution-mode conflict checks.
- Own `OperationCompiler`, `OperationRuntime`, and `OperationResults` children.
- Expose direct execution, transaction-bound execution, and preparation.
- Preserve cache execution decoration without a metadata closure bag.

### `OperationCompiler`

- Exhaustively dispatch validated operation kinds.
- Compile every operation to `OperationProgram`.
- Own read and write compiler children.
- Allocate operation-scoped produced-value identifiers.
- Decide semantic order, dependencies, guards, branches, atomicity, and result
  source.
- Never choose a driver strategy or execute I/O.

### `WriteOperations`

- Compile create, update, delete, upsert, bulk, and return-emulation programs.
- Own `RelationMutations`.
- Use the same step primitives for ordinary and relation-bearing writes.

### `RelationMutations`

- Normalize relation mutation input.
- Compile relation create, connect, update, removal, upsert, and many-to-many
  semantics.
- Own relation preflight and own-write analysis.
- Contribute steps to the parent write program.
- Never execute steps or inspect concrete runtime implementations.

### `OperationRuntime`

- Fast-path one-step programs to direct driver execution.
- Execute operation-atomic programs through a transaction when available.
- Specialize and lower programs to an atomic batch when required.
- Resolve produced values.
- Attribute errors and instrumentation to the immutable operation context.
- Never import relation compiler modules.

### `OperationResults`

- Resolve the public result from the program's declared result source.
- Own result shape, provider middleware, parsing, and pagination
  post-processing.
- Treat a deep return as a terminal read plus an expected result shape.
- Never decide mutation order or runtime strategy.

### SQL builders and adapters

- Continue producing parameterized `Sql` fragments.
- Continue delegating every dialect decision to the adapter.
- Remain pure and unaware of execution strategy.

## Non-Negotiable Constraints

1. PostgreSQL, MySQL, SQLite, LibSQL, PGlite, transaction, and atomic-batch
   semantics remain equivalent for every portable operation.
2. No phase may weaken the existing regression or conformance suite.
3. No operation kind may have two active semantic implementations.
4. Database-specific SQL remains adapter-owned.
5. Malformed provider output continues to fail closed.
6. Privacy, instrumentation, cleanup-error, and transaction-lifecycle contracts
   remain intact.
7. Lazy validation and Promise-like `PendingOperation` behavior remain intact.
8. No arbitrary callback or closure may be stored as a program statement.
9. No abstract base class or subclass-per-operation hierarchy is introduced.
10. No generic `Context`, `Options`, `Manager`, `Handler`, `Utils`, or `Helpers`
    abstraction may hide unclear ownership.
11. No file may exceed 600 LOC at phase completion; aim for 200–450 LOC.
12. Structural compression must be measured. Renaming the existing machinery is
    not completion.

## Explicit Non-Goals

- Do not add user-facing query features.
- Do not redesign validation schemas or public query syntax.
- Do not build a cost-based database query planner.
- Do not replace the database's optimizer.
- Do not recreate SQL as a complete relational AST.
- Do not change adapter or driver ownership boundaries.
- Do not rewrite all operation families in one milestone.
- Do not collapse relation semantics into one multi-thousand-line file.
- Do not use provider-specific expected failures to make parity suites green.

## Migration Rules

### One semantic owner per operation kind

During the strangler migration, routing may temporarily choose between the new
compiler and the legacy path by an explicit migrated-operation set. Once an
operation kind moves, the old implementation for that kind is deleted in the
same phase.

The migration must never run both implementations and compare only their happy
path. The conformance suite is the comparison oracle.

### Temporary files have expiry phases

Any compatibility shim or temporary routing file must state the phase that
deletes it. No temporary abstraction may survive the final legacy-retirement
phase.

### File-count budget

- Phases 0–2 may introduce at most four net query-engine files for the program
  foundation.
- By Phase 4, query-engine file count must be at or below the starting count.
- Every phase after Phase 4 must be net neutral or delete files.
- Final target: at most 70 query-engine files; desired range 55–65.
- `operations/nested-writes/` must not exist at completion.

### LOC budget

LOC is a diagnostic, not a correctness target. Nevertheless:

- every phase records query-engine LOC before and after;
- any phase adding more LOC than it deletes must explain the temporary debt and
  its expiry phase;
- the final engine must demonstrate material net deletion from the 24,204-line
  baseline;
- if the universal program adds indirection without deleting lifecycle routing,
  the design must be reduced or abandoned.

### Commit discipline

Each numbered unit of work is intended to be independently reviewable and,
where practical, independently committable. Suggested commits use Conventional
Commits and must not combine unrelated cleanup.

## Dependency Order

```text
Phase 0  baseline and contracts
   ↓
Phase 1  QueryEngine + PendingOperation ownership
   ↓
Phase 2  OperationProgram read pilot
   ↓
Phase 3  all reads and unified preparation
   ↓
Phase 4  direct writes and result contracts
   ↓
Phase 5  linear multi-step programs and atomic runtime
   ↓
Phase 6  produced values, guards, branches, batch specialization
   ↓
Phase 7  relation create/connect families
   ↓
Phase 8  relation update/removal and own-write analysis
   ↓
Phase 9  upsert/connectOrCreate/many-to-many
   ↓
Phase 10 retire the nested-write subsystem and narrow QueryScope
   ↓
Phase 11 consolidate files and prove final parity
```

## Global Verification Levels

### Level A — Structural-only change

```bash
pnpm type-check
pnpm vitest run tests/query-engine/
git diff --check
```

### Level B — Operation-semantic change

```bash
pnpm type-check
pnpm vitest run tests/query-engine/
pnpm test:drivers:local
pnpm test:gates
git diff --check
```

### Level C — Runtime, transaction, batch, or relation change

```bash
pnpm type-check
pnpm vitest run tests/query-engine/
pnpm test:pglite
pnpm test:sqlite
pnpm test:mysql
pnpm test:pg
pnpm test:gates
git diff --check
```

Database-backed commands require their documented local services. A phase
cannot be declared complete because an unavailable provider was skipped; the
missing matrix must run before completion.

---

## Phase 0: Freeze Baseline and Architecture Contracts

### Goal

Create a measurable and behaviorally frozen starting point before changing
ownership or execution flow.

### Context

The working tree contains the completed correctness work and a large number of
new files. Reorganization without a baseline would make it impossible to prove
that the new abstraction deleted code rather than merely moving it.

### Needs

- Current correctness and interoperability suites must be green.
- Current query-engine file and LOC counts must be recorded from the exact
  branch being reorganized.
- Existing public exports and `PendingOperation` behaviors must be inventoried.

### Units of Work

#### 0.1 — Record structural baseline

- Record query-engine files, LOC, functions, high-parameter functions, branch
  nodes, and import cycles.
- Record the `operations/nested-writes/` subset separately.
- Record files exceeding 300 and 600 LOC.
- Store the commands used so later phases can reproduce the measurements.

Suggested commit: `docs: record query engine reorganization baseline`.

#### 0.2 — Freeze public operation behavior

- Lock lazy validation: constructing an operation performs no validation I/O.
- Lock Promise-like memoization across `then`, `catch`, `finally`, and
  `execute`.
- Lock `executeWith` conflict behavior for default, same-driver, and
  different-driver execution.
- Lock `prepare`, `prepareBatch`, `canBatch`, `wrapExecutor`, operation
  attribution, and cache decoration behavior.
- Lock package exports involving `PendingOperation` and `QueryMetadata`.

Suggested commit: `test: freeze pending operation contracts`.

#### 0.3 — Freeze program-equivalence oracles

- Preserve SQL text and parameter snapshots for representative reads and
  ordinary writes.
- Preserve result shapes for scalar, relation, aggregate, count, and deep
  include returns.
- Preserve transaction-versus-batch nested-write state equivalence.
- Preserve typed error and race-retry expectations.

Suggested commit: `test: freeze operation execution equivalence`.

#### 0.4 — Add architecture gates for the migration

- Add a temporary migrated-operation registry gate.
- Assert a migrated operation does not import or route through its legacy
  implementation.
- Assert runtime modules do not import relation compiler modules.
- Assert no program statement stores an arbitrary builder callback.
- Assert only one capability-selection point exists in the runtime.

Suggested commit: `test: add operation program architecture gates`.

#### 0.5 — Capture performance baseline

- Benchmark creation and direct execution preparation for a one-step read.
- Benchmark a direct write, a non-`RETURNING` write, and a nested relation write.
- Record allocations when available.
- Use the baseline to detect accidental per-step or per-child object expansion.

Suggested commit: `perf: baseline operation lifecycle overhead`.

### Deletion Targets

None. This phase establishes proof, not structure.

### Acceptance Criteria

- All baseline measurements are reproducible.
- Every existing public `PendingOperation` behavior is named by a test.
- The architecture gates can distinguish migrated and legacy operation kinds.
- The full provider matrix is green before structural work starts.
- No production behavior changes.

### Verification

Run Level C and the recorded benchmark baseline.

### Completion Record

**Completed 2026-07-12 — score: 11.7/12.**

Changed files:

- `package.json`
- `scripts/query-engine-structure.mjs`
- `docs/architecture/query-engine-operation-program-phase-0-baseline.md`
- `benchmarks/operation-lifecycle.bench.ts`
- `tests/query-engine/pending-operation-contracts.test.ts`
- `tests/query-engine/operation-equivalence-oracles.test.ts`
- `tests/query-engine/operation-program-architecture-gates.test.ts`
- `tests/query-engine/operation-program-migration-registry.ts`

Deleted files: none.

Structural delta:

- query-engine production files and LOC: unchanged;
- Phase 0 support: seven new files, approximately 1,157 LOC;
- recorded baseline: 121 query-engine files, 24,204 LOC, 932 functions,
  2,291 parameters, 123 functions with at least five parameters, 2,340 branch
  nodes, three runtime cycle components, and 13 runtime files in cycles;
- nested-write baseline: 44 files, 10,140 LOC, 405 functions, 1,014
  parameters, 64 functions with at least five parameters, 811 branch nodes,
  and one eight-file runtime cycle.

Verification:

- focused Phase 0 contracts: 23/23 passed;
- query-engine suite: 880/880 passed;
- architecture gates: 12/12 passed;
- PGlite: 418/418 passed;
- SQLite3 and LibSQL: 734/734 passed;
- MySQL: 354/354 passed against an isolated disposable MySQL 8 service;
- PostgreSQL drivers: 287 passed and 14 optional pgvector tests skipped against
  an isolated disposable PostgreSQL 17 service;
- type-check, benchmark baseline, structural reproduction, Biome checks, and
  `git diff --check`: passed;
- disposable review database containers were removed after verification.

Residual risks:

- stable per-operation allocation counts were unavailable from the current
  Vitest/tinybench runner;
- the 14 pgvector-only tests require a pgvector-enabled image and were not part
  of this baseline run.

No production behavior changed in this phase.

---

## Phase 1: Make `QueryEngine` and `PendingOperation` the Real Owners

### Goal

Establish lifetime ownership without introducing `OperationProgram` behavior
yet.

### Context

`QueryEngine` currently duplicates state also stored by the client and rebuilds
a `QueryEngineDependencies` bag. `PendingOperation` owns deferred execution
state but delegates the actual lifecycle through `QueryMetadata` closures
assembled in `executor.ts`.

### Needs

- Phase 0 contracts.
- A reviewed decision for any published `QueryMetadata` type compatibility.
- No changes to SQL generation or runtime strategy.

### Units of Work

#### 1.1 — Make `QueryEngine` the canonical query environment

- Keep driver, registry, instrumentation, `clientId`, and `scopeId` on
  `QueryEngine`.
- Remove duplicate adapter state; read it from `driver.adapter`.
- Remove duplicate schema-registry state; read it from `registry.schemas` after
  constructor validation.
- Remove `getDependencies()` and `getDriver()` forwarding methods.
- Change the client to access query infrastructure through the engine rather
  than storing duplicate copies.

Suggested commit: `refactor: centralize query environment ownership`.

#### 1.2 — Split client identity from transaction scope

- Preserve `clientId` when deriving a transaction-bound engine.
- Mint a new `scopeId` for each transaction-bound engine.
- Store both identifiers in immutable operation execution context.
- Validate client ownership separately from execution-scope ownership.
- Add explicit tests preventing accidental mixing of root and callback-
  transaction operations while preserving legitimate nested transaction use.

Suggested commit: `refactor: separate client and transaction identities`.

#### 1.3 — Move the real `PendingOperation` implementation into query-engine ownership

- Place the implementation beside the engine lifecycle rather than under the
  client layer.
- Preserve the public `PendingOperation` export name.
- Update the client to request an operation from `QueryEngine`.
- Avoid a runtime wrapper or `QueryOperation` compatibility class.

Suggested commit: `refactor: move pending operation into query engine`.

#### 1.4 — Replace `QueryMetadata` closures with operation-owned methods

- Store model, operation, arguments, options, execution context, and client
  identity directly on `PendingOperation`.
- Move execute, prepare, batch-prepare, and parse entry methods onto the class.
- Let methods temporarily call existing executor functions with
  `PendingOperation` as the parent while later phases migrate internals.
- Preserve promise caching, execution-mode conflict detection, and
  `wrapExecutor` immutability.
- Delete the runtime `QueryMetadata` object and closure assembly.

Suggested commit: `refactor: make pending operation own its lifecycle`.

#### 1.5 — Preserve or retire the public `QueryMetadata` type intentionally

- Verify whether `QueryMetadata` is part of the supported package contract.
- If compatibility is required, retain a deprecated type-only alias for one
  release; do not retain a runtime metadata object.
- Otherwise remove it from package exports and document the advanced-API
  change.

Implementation decision: retain `QueryMetadata<T>` for one compatibility
release as a deprecated type-only alias to `PendingOperation<T>`. The former
object shape, callback fields, and direct metadata-based construction are
retired; no runtime `QueryMetadata` value or compatibility constructor remains.

Suggested commit: `refactor: retire query metadata export`.

### Deletion Targets

- `QueryEngineDependencies` if it has no remaining independent consumer.
- `QueryEngine.getDependencies()`.
- `QueryEngine.getDriver()`.
- Runtime `QueryMetadata` construction.
- `createPreparedOperation` as a closure-assembly factory.
- Duplicate client-held query infrastructure.
- Any `QueryOperation` proposal or compatibility wrapper.

### Acceptance Criteria

- `PendingOperation` remains the only public deferred-operation class.
- `QueryEngine` is the canonical owner of shared query state.
- No runtime `QueryMetadata` closure bag exists.
- Root and transaction scope identity tests pass.
- SQL, parameters, results, instrumentation, and errors are unchanged.
- Query-engine file count is net neutral or lower excluding the moved class.

### Verification

Run Level C plus package export smoke tests.

### Completion Record

**Completed 2026-07-12 — score: 11.7/12.**

Changed files:

- `docs/architecture/query-engine-operation-program-implementation-plan.md`
- `src/client/client.ts`
- `src/client/exports.ts`
- `src/client/types.ts`
- `src/errors/base.ts`
- `src/errors/query.ts`
- `src/index.ts`
- `src/query-engine/cache-flow.ts`
- `src/query-engine/execution-context.ts`
- `src/query-engine/executor.ts`
- `src/query-engine/operation-builder.ts`
- `src/query-engine/operation-preparation.ts`
- `src/query-engine/operations/bulk-create-preparation.ts`
- `src/query-engine/pending-operation.ts`
- `src/query-engine/query-engine.ts`
- `src/query-engine/result-flow.ts`
- `src/query-engine/types.ts`
- `tests/client/batch-transaction.test.ts`
- `tests/client/nested-transaction-contract.test.ts`
- `tests/instrumentation/native-batch-attribution.test.ts`
- `tests/package-error-names-smoke.mjs`
- `tests/query-engine/operation-program-architecture-gates.test.ts`
- `tests/query-engine/pending-operation-contracts.test.ts`

Deleted files:

- `src/client/pending-operation.ts`

Structural delta from the Phase 0 baseline:

- query-engine files: 121 to 122 solely because the real `PendingOperation`
  implementation moved from the client layer into query-engine ownership;
- query-engine LOC: 24,204 to 24,363; excluding the 257-line moved class, the
  layer fell to 24,106 LOC, a net reduction of 98 lines;
- total parameters: 2,291 to 2,290;
- functions with at least five parameters: 123 to 118;
- runtime import cycles: unchanged at three components and 13 files;
- `QueryEngineDependencies`, `getDependencies()`, `getDriver()`, runtime
  `QueryMetadata` construction, `createPreparedOperation`, duplicate
  client-owned query infrastructure, and the client-layer implementation were
  removed;
- the final executor decoration is one typed function, not a callback bag,
  single-method interface, context object, or compatibility wrapper.

Verification:

- type-check: passed;
- query-engine suite: 882/882 passed;
- architecture gates: 13/13 passed;
- PGlite: 418/418 passed;
- SQLite3 and LibSQL: 734/734 passed;
- MySQL: 354/354 passed against an isolated disposable MySQL 8 service;
- PostgreSQL drivers: 287 passed and 14 optional pgvector tests skipped against
  an isolated disposable PostgreSQL 17 service;
- package build, root/client `PendingOperation` export identity smoke, packaged
  error-name smoke, focused Biome checks, structural reproduction, and
  `git diff --check`: passed;
- disposable review database containers were removed after verification.

Rating basis:

- correctness, architecture fit, `PendingOperation` lifecycle ownership,
  cross-database behavior, transaction scope safety, side-effect safety,
  retry/idempotency preservation, observability, error propagation, and
  regression coverage passed without a known defect;
- structural compression improved high-arity count and removed dependency and
  closure bags without introducing `QueryOperation` or another SQL AST;
- 0.2 deducted because direct construction of the retired advanced
  `QueryMetadata` object shape is intentionally source-incompatible, despite
  the one-release type alias;
- 0.1 deducted because the optional pgvector-only provider slice was not run.

Residual risks:

- advanced consumers that constructed `QueryMetadata` objects directly must
  migrate to the public `PendingOperation` lifecycle;
- pgvector behavior remains covered by the Phase 0 baseline limitation rather
  than this phase's local PostgreSQL image.

---

## Phase 2: Introduce `OperationProgram` Through a Read Pilot

### Goal

Prove that a universal program can represent simple queries without adding
meaningful overhead or duplicating SQL construction.

### Context

The design succeeds only if the simplest query remains simple. `findUnique`,
`findFirst`, and `findMany` are the safest pilot because they already compile
to one statement and do not need produced values or operation-level atomicity.

### Needs

- Phase 1 operation ownership.
- Existing `QueryContext` and SQL builders remain temporarily authoritative.
- No relation or write migration in this phase.

### Units of Work

#### 2.1 — Define the minimal program vocabulary

- Add `OperationProgram`, `ReadStep`, `OperationResult`, step identifiers, and
  `atomicity: "statement"`.
- Keep related types together initially; do not create one file per node.
- Do not add `WriteStep`, `GuardStep`, `BranchStep`, or produced-value machinery
  until their migration phase unless exhaustive unions require empty shapes.

Suggested commit: `refactor: add minimal operation program`.

#### 2.2 — Add `OperationCompiler` and read ownership

- Create `OperationCompiler` as a child of `PendingOperation`.
- Compile `findUnique`, `findFirst`, and `findMany` to one `ReadStep` using the
  existing SQL builders unchanged.
- Preserve validated arguments and expected result shape on the operation or
  result contract without a closure.

Suggested commit: `refactor: compile core reads to operation programs`.

#### 2.3 — Add the direct runtime fast path

- Create `OperationRuntime` as a child of `PendingOperation`.
- Execute a one-step statement program through the existing driver `_execute`
  contract.
- Preserve instrumentation span order: validate, build, execute, parse.
- Avoid allocating symbol tables, branch state, transaction state, or batch
  state for the direct path.

Suggested commit: `refactor: execute one-step operation programs`.

#### 2.4 — Add program inspection tests

- Assert one read step, statement atomicity, and one declared result source.
- Assert generated SQL and parameters are byte-for-byte equivalent to the
  legacy builder output.
- Compare direct-path operation creation and preparation benchmarks against
  Phase 0.

Suggested commit: `test: verify read operation programs`.

#### 2.5 — Remove migrated read routing

- Delete legacy executor dispatch for the three migrated reads.
- Mark them migrated in the temporary architecture gate.
- Ensure no fallback can silently route them back through the old path.

Suggested commit: `refactor: remove legacy core read routing`.

### Deletion Targets

- Legacy executor branches for `findUnique`, `findFirst`, and `findMany`.
- Read-specific metadata parsing closures.
- Any new class that only forwards to an existing read builder.

### Acceptance Criteria

- The three read operations always execute through `OperationProgram`.
- SQL and public results are identical across all adapters.
- Direct execution has no transaction or batch machinery.
- Benchmark regression is measured and accepted explicitly.
- The phase adds no more than four net query-engine files from the original
  baseline.

### Verification

Run Level B plus focused SQL-generation and result-shape suites.

### Completion Record

**Completed 2026-07-12 — score: 11.6/12.**

Changed files:

- `src/query-engine/operation-program.ts`
- `src/query-engine/OperationCompiler.ts`
- `src/query-engine/OperationRuntime.ts`
- `src/query-engine/pending-operation.ts`
- `src/query-engine/execution-context.ts`
- `src/query-engine/executor.ts`
- `src/query-engine/operation-builder.ts`
- `src/query-engine/operation-preparation.ts`
- `src/query-engine/query-engine.ts`
- `src/query-engine/result/result-parser.ts`
- `src/query-engine/result/result-shape.ts`
- `tests/query-engine/operation-program-read-pilot.test.ts`
- `tests/query-engine/operation-program-architecture-gates.test.ts`
- `tests/query-engine/operation-program-migration-registry.ts`

Deleted files: none.

Deleted responsibilities:

- removed the legacy `findUnique`, `findFirst`, and `findMany` dispatch cases
  from `buildOperation`;
- direct execution, preparation, and `QueryEngine.build()` now compile those
  reads to one `OperationProgram` without a fallback executor route;
- marked exactly those three operations migrated in the temporary gate.

Structural delta:

- query-engine files: 122 to 125 from Phase 1, and 121 to 125 from the Phase 0
  baseline; the +4 baseline cap includes the class moved in Phase 1;
- query-engine LOC: 24,363 to 24,617 from Phase 1, +254 lines;
- functions: 952 to 966 from Phase 1; parameters: 2,290 to 2,304;
- high-arity functions: 118 to 119, still four below the Phase 0 baseline;
- branch nodes: 2,355 to 2,363;
- runtime import cycles: unchanged at three components and 13 files;
- the program is one data-only read step plus one declared result source; no
  write, guard, branch, produced-value, transaction, batch, or symbol machinery
  was introduced.

Verification:

- type-check: passed;
- query-engine suite: 888/888 passed;
- Level B local drivers: PGlite 418/418, SQLite3 391/391, and LibSQL 343/343,
  for 1,152/1,152 passed;
- architecture gates: 14/14 passed;
- focused read-program, SQL-generation, result-shape, instrumentation, and
  failure contracts: passed;
- PostgreSQL/MySQL/SQLite adapter SQL and parameters: byte-for-byte equivalent
  for all three migrated reads;
- additional cross-provider review: MySQL 354/354 and PostgreSQL drivers 287
  passed with 14 optional pgvector tests skipped against isolated disposable
  services;
- package build, package export/error-name smoke, focused Biome checks,
  structural reproduction, and `git diff --check`: passed;
- disposable review database containers were removed after verification.

Benchmark comparison with Phase 0:

- independent read creation: 2,347,753 Hz versus 2,175,060 Hz, +7.9%;
- independent read preparation: 207,994 Hz versus 216,703 Hz, -4.0%;
- preparation mean: 0.0048 ms versus 0.0046 ms;
- the agent's separate run measured +9.6% creation and -4.5% preparation,
  confirming the same direction; the absolute preparation cost remains under
  five microseconds locally.

Rating basis:

- correctness, DRY ownership, architecture fit, program adherence,
  cross-database interoperability, side-effect safety, transaction and data
  safety, retry/idempotency preservation, tests, observability, fail-closed
  errors, and concurrency risk passed without a known defect;
- structural growth stayed at the phase's exact file ceiling, introduced no
  cycle, and deleted the migrated legacy routes;
- 0.2 deducted because the phased internal `PendingOperation.compile()` hook
  is visible in generated declarations until final advanced exports are
  resolved;
- 0.2 deducted for the small repeatable local preparation benchmark regression
  and non-isolated benchmark environment.

Residual risks:

- Phase 11 must either make program inspection a deliberate supported API or
  remove the declaration leak;
- allocation counts remain unavailable from the current benchmark runner;
- optional pgvector reads were not exercised by the disposable PostgreSQL
  image.

---

## Phase 3: Migrate All Reads and Unify Preparation

### Goal

Make every read-like operation use the universal one-step program and derive
preparation from the program instead of operation-specific closures.

### Context

Count, existence, aggregate, group-by, pagination, ordering, relation filters,
and deep includes are logically more complex SQL, but they remain one operation
step. Their complexity belongs in existing SQL builders, not in the operation
program node set.

### Needs

- Successful Phase 2 pilot with acceptable overhead.
- SQL builders remain pure and adapter-backed.
- Existing result-shape regression coverage.

### Units of Work

#### 3.1 — Migrate count and existence reads

- Compile `count` and `exist` to `ReadStep`.
- Declare count-carrier parsing through `OperationResult`.
- Delete operation-specific count result routing.

Suggested commit: `refactor: compile count operations to programs`.

#### 3.2 — Migrate aggregate and group-by reads

- Compile `aggregate` and `groupBy` to one-step programs.
- Preserve aggregate selection, having, ordering, and result-shape contracts.
- Keep aggregate SQL details below the program boundary.

Suggested commit: `refactor: compile aggregate operations to programs`.

#### 3.3 — Derive direct preparation from the program

- Replace read-specific `prepare` closures with runtime preparation of a
  one-step program.
- Preserve immutable execution attribution in `PreparedQuery`.
- Make unsupported preparation a property of the program/runtime contract, not
  a hardcoded operation list.

Suggested commit: `refactor: prepare reads from operation programs`.

#### 3.4 — Consolidate read operation dispatch

- Let `OperationCompiler` own one exhaustive read dispatch.
- Keep operation-family files only where they contain cohesive compilation
  logic rather than one forwarding method.
- Delete migrated `operations/find-*.ts` micro-files that no longer earn a
  boundary.

Suggested commit: `refactor: consolidate read operation compilation`.

### Deletion Targets

- Read branches in `operation-builder.ts` and `executor.ts`.
- Read preparation closures in `operation-preparation.ts`.
- Inlinable `findFirst`/`findMany` wrappers.
- Result carrier flags that can be derived from `OperationResult`.

### Acceptance Criteria

- Every read-like operation uses `OperationProgram`.
- Read preparation is program-driven.
- Deep includes and aggregate results preserve exact public shapes.
- No new general SQL AST has appeared.
- Query-engine file count is at or below the Phase 2 count.

### Verification

Run Level B plus all pagination, relation-read, aggregate, and result-parser
contract suites.

### Completion Record

**Completed 2026-07-12 — score: 11.7/12.**

Changed files:

- `src/query-engine/OperationCompiler.ts`
- `src/query-engine/OperationRuntime.ts`
- `src/query-engine/executor.ts`
- `src/query-engine/index.ts`
- `src/query-engine/operation-builder.ts`
- `src/query-engine/operation-preparation.ts`
- `src/query-engine/operation-program.ts`
- `src/query-engine/pending-operation.ts`
- `src/query-engine/result-flow.ts`
- `src/query-engine/types.ts`
- `src/query-engine/operations/find-common.ts`
- `src/query-engine/operations/index.ts`
- `src/query-engine/operations/many-returns.ts`
- `src/query-engine/result/result-count-parser.ts`
- `src/query-engine/result/result-row-parser.ts`
- `src/query-engine/result/result-shape.ts`
- `tests/query-engine/operation-program-architecture-gates.test.ts`
- `tests/query-engine/operation-program-migration-registry.ts`
- `tests/query-engine/operation-program-read-pilot.test.ts`

Deleted files:

- `src/query-engine/operations/find-first.ts`
- `src/query-engine/operations/find-many.ts`

Deleted and consolidated responsibilities:

- all seven read-like operations now compile through one exhaustive
  `OperationCompiler` dispatch;
- removed count, existence, aggregate, and group-by routing from the legacy
  operation builder and removed legacy read preparation/pagination routing;
- preparation now derives from the compiled one-step program in
  `OperationRuntime` with immutable execution attribution;
- count and existence parsing derives from `OperationResult.shape.carrier`,
  not result-layer operation-name branches;
- direct callers that need cohesive find SQL use `buildFind`; the two
  forwarding wrapper files and exports were deleted;
- the migration gate marks exactly all seven reads migrated and proves there
  is no legacy fallback.

Structural delta from Phase 2:

- query-engine files: 125 to 123;
- LOC: 24,617 to 24,612;
- functions: unchanged at 966;
- parameters: 2,304 to 2,303;
- high-arity functions: unchanged at 119;
- branch nodes: 2,363 to 2,361;
- runtime import cycles: unchanged at three components and 13 files.

Verification:

- type-check: passed;
- query-engine suite: 889/889 passed;
- Level B local drivers: PGlite 418/418, SQLite3 391/391, and LibSQL 343/343,
  for 1,152/1,152 passed;
- architecture gates: 15/15 passed;
- focused read/count/result contracts: 258/258 initially and 165/165 after
  root-requested remediation;
- explicit relation-read, aggregate, and adapter-result contracts: 149/149
  passed;
- additional live-provider review: MySQL 354/354 and PostgreSQL drivers 287
  passed with 14 optional pgvector tests skipped against isolated disposable
  services;
- package build, packaged error-name smoke, focused Biome checks, structural
  reproduction, and `git diff --check`: passed;
- disposable review database containers were removed after verification.

Rating basis:

- correctness, code quality, architecture fit, operation-program adherence,
  cross-database interoperability, side-effect and transaction safety,
  retry/idempotency preservation, regression coverage, observability,
  fail-closed errors, and concurrency risk passed without a known defect;
- structural compression is positive: two files, five net lines, one parameter,
  and two branch nodes removed with no new cycle;
- the initial 10.9/12 review found an unsafely broad registry type, an
  impossible shape guard, and avoidable new assertions; the same phase agent
  removed them and the full matrix was rerun;
- 0.2 deducted for the unchanged temporary `PendingOperation.compile()`
  declaration exposure;
- 0.1 deducted because the disposable PostgreSQL image did not include
  pgvector.

Residual risks:

- Phase 11 must resolve program inspection as a deliberate public API or hide
  the internal declaration;
- the optional pgvector provider slice retains the Phase 0 baseline gap.

---

## Phase 4: Migrate Direct Writes and Establish Result Contracts

### Goal

Represent every single-statement write as a `WriteStep` and make its public
result source explicit.

### Context

Direct create, update, delete, bulk update/delete, and supported direct upsert
currently mix SQL construction, affected-row checks, result parsing, and
fallback routing in the executor.

### Needs

- All reads migrated.
- A reviewed `WriteStep` shape that reuses existing mutation SQL builders.
- Existing returning and mutation-miss regressions.

### Units of Work

#### 4.1 — Add `WriteStep` and write result sources

- Add write statement, expected cardinality, affected-row requirement, and
  produced raw result identifiers.
- Define result sources for returned rows and row counts.
- Keep write statement representation balanced: semantic fields where later
  produced values will matter, existing `Sql` leaves where they already work.

Suggested commit: `refactor: add write steps and result sources`.

#### 4.2 — Migrate direct create and delete

- Compile direct create and delete operations to one-step programs.
- Preserve `RETURNING`, default insert, select/include, and not-found behavior.
- Route result parsing through `OperationResults`.

Suggested commit: `refactor: compile direct create and delete programs`.

#### 4.3 — Migrate direct update and bulk mutations

- Compile direct update, updateMany, updateManyAndReturn, and deleteMany where
  one statement is sufficient.
- Preserve affected-row semantics and count carriers.
- Keep operations needing refetch on the legacy multi-step path until Phase 5.

Suggested commit: `refactor: compile direct update programs`.

#### 4.4 — Migrate direct upsert where one statement is semantically complete

- Use direct adapter upsert only when it already satisfies portable semantics
  and result requirements.
- Leave fallback/branching upsert for Phases 5–6.
- Do not classify portability by provider name; use the existing capability
  contract.

Suggested commit: `refactor: compile direct upsert programs`.

#### 4.5 — Unify mutation result resolution

- Create `OperationResults` as the one owner of returned rows, row counts,
  definitive misses, pagination post-processing, and public parsing.
- Remove mutation result decisions from the executor as operation families
  migrate.

Suggested commit: `refactor: centralize operation result resolution`.

### Deletion Targets

- Direct mutation branches in `executor.ts`.
- Direct mutation parsing closures.
- Duplicated `isBatchOperation`/return-shape flags where derivable from the
  result contract.
- Migrated one-operation wrapper files.

### Acceptance Criteria

- Every semantically single-statement write uses a one-step program.
- Mutation miss and return behavior are unchanged.
- Program result contracts identify the public result source without
  operation-specific executor branching.
- Query-engine file count is at or below the Phase 0 baseline.

### Verification

Run Level C, emphasizing returning, createMany, many-and-return, default insert,
and mutation result contract suites.

### Completion Record

- **Status:** complete.
- **Score:** 11.5/12 after remediation. The first review scored 10.6/12
  because singleton MySQL `createMany({ skipDuplicates: true })` incorrectly
  bypassed recoverable unique-error handling. Capability-based routing and a
  live-provider regression test corrected the defect.
- **Implemented:** direct reads and semantically complete single-statement
  writes compile to one-step `OperationProgram` values; `OperationResults`
  owns returned rows, row counts, definitive misses, pagination
  post-processing, and public parsing; unsupported multi-step cases continue
  through one explicit legacy boundary.
- **Changed:** `operation-program.ts`, `OperationCompiler.ts`,
  `OperationRuntime.ts`, `OperationResults.ts`, `executor.ts`,
  `execution-context.ts`, `pending-operation.ts`, `query-engine.ts`,
  `operation-preparation.ts`, `types.ts`, `builders/nested-write-detector.ts`,
  `operations/bulk-create.ts`, `operations/many-returns.ts`, nested-write live
  and planned modes, batch transaction tests, operation-program pilot/gate
  tests, the migration registry, and result-shape contract tests.
- **Deleted:** `operation-builder.ts`, `result-flow.ts`, and
  `operations/bulk-create-preparation.ts`.
- **Boundaries reviewed:** the compiler has no relation or nested-write
  imports; runtime owns execution but not relation semantics; dialect choices
  remain capability- and adapter-owned; programs contain declarative data and
  `Sql` leaves, not callbacks or closure bags.
- **Structural delta from Phase 3:** query-engine files 123 -> 121; LOC
  24,612 -> 24,575; functions 966 -> 962; parameters 2,303 -> 2,295;
  high-arity functions 119 -> 118; branch nodes 2,361 -> 2,404; runtime import
  cycles unchanged at 3 components / 13 files.
- **Verified:** type-check; package build; Biome on the phase surface; 17/17
  architecture gates; 899/899 query-engine tests; PGlite 419/419;
  SQLite/LibSQL 736/736; MySQL 355/355; PostgreSQL 287 passed with 14 optional
  pgvector skips; package error-name and optional-OTel smoke tests. The direct
  write benchmark remained within its recorded envelope.
- **Residual risks:** branch count increased while one explicit legacy
  boundary remains; `OperationCompiler.ts` and `executor.ts` exceed the
  300-line smell threshold; the public `PendingOperation.compile()` seam and
  multi-step native-batch result finalization remain scheduled for later
  phases. No correctness or interoperability exception is accepted.

---

## Phase 5: Generalize Linear Multi-Step Programs and Atomic Runtime

### Goal

Express non-branching multi-statement operations through the same program and
runtime before migrating relation semantics.

### Context

Non-`RETURNING` emulation, many-row refetch, bulk chunking, and final deep
refetch already require multiple statements and atomicity. They are ideal
proof that multi-step execution is not specific to nested writes.

### Needs

- Direct writes and result contracts migrated.
- Correct transaction primitives and provider result normalization.
- No produced-value dependency beyond values already known or returned through
  a completed step; general symbols arrive in Phase 6.

### Units of Work

#### 5.1 — Add operation-level atomicity

- Support `atomicity: "operation"` on `OperationProgram`.
- Make runtime selection depend on program requirements and driver capability.
- Preserve direct one-step fast paths.

Suggested commit: `refactor: add operation atomicity to programs`.

#### 5.2 — Add transaction execution for linear programs

- Execute steps in order on one transaction driver.
- Preserve immutable operation context across every step.
- Ensure parsing/finalization failures happen before commit when their contract
  must be rollback-capable.
- Preserve primary failure over cleanup failure.

Suggested commit: `refactor: execute linear programs transactionally`.

#### 5.3 — Add atomic-batch execution for linear programs

- Lower a linear program to setup, body, and cleanup queries.
- Preserve one connection, ordering, and atomicity capability requirements.
- Reject honestly when a driver cannot guarantee the program contract.
- Do not add branch or produced-value specialization yet.

Suggested commit: `refactor: execute linear programs as atomic batches`.

#### 5.4 — Migrate non-`RETURNING` mutation emulation

- Compile mutation, identity capture/refetch, and final result read as explicit
  steps.
- Preserve locks, post-update identity, stale-row prevention, and rollback-
  capable parsing.
- Remove specialized executor routing after each family migrates.

Suggested commit: `refactor: compile non-returning mutation programs`.

#### 5.5 — Migrate many-return and bulk-create execution

- Compile row-shape groups, chunked writes, and final result collection as
  linear programs.
- Reuse the canonical row-shape planner.
- Derive preparation and execution from the program.

Suggested commit: `refactor: compile bulk mutation programs`.

### Deletion Targets

- `operations/many-returns.ts` after migration.
- `operations/mutation-returns.ts` after migration.
- Bulk-specific execution and preparation routing.
- Non-`RETURNING` branches in `executor.ts`.
- Generic transaction-flow logic that is now runtime-owned.

### Acceptance Criteria

- Non-relation multi-step writes use `OperationProgram`.
- Atomicity is declared by the program, not inferred from nested-write
  detection.
- Transaction and batch results are state- and error-equivalent.
- All specialized executor branches listed above are deleted.
- The phase is net file- and LOC-negative.

### Verification

Run Level C plus non-returning atomicity, many-and-return, bulk plan, provider
result, and transaction lifecycle suites.

### Completion Record

- **Status:** complete.
- **Score:** 11.4/12 after two reviews. Initial implementation review scored
  10.8/12 because produced-result identifiers were ceremonial and direct miss
  classification still depended on the pending operation kind. Both contracts
  now fail closed from declared program data; root also replaced an O(n²)
  source-validation scan with one step-ID map.
- **Implemented:** operation-level atomicity; ordered transaction execution;
  static atomic-batch lowering; rollback-capable result resolution before
  commit; linear non-`RETURNING` capture/mutation/refetch; row-shape/chunked
  bulk writes; compiler-owned `WriteOperations` and `BulkWritePrograms`.
- **Changed:** `operation-program.ts`, `OperationCompiler.ts`,
  `OperationRuntime.ts`, `OperationResults.ts`, `WriteOperations.ts`,
  `BulkWritePrograms.ts`, `pending-operation.ts`, `query-engine.ts`,
  `executor.ts`, nested-only `transaction-flow.ts`, `validator.ts`,
  `operations/mutation-identity.ts`, nested-write record/live access, and the
  focused operation-program, atomicity, transaction, instrumentation, client,
  and live-driver regressions.
- **Deleted:** `operations/many-returns.ts`,
  `operations/mutation-returns.ts`, `operations/bulk-create.ts`, and
  `operation-preparation.ts`.
- **Boundaries reviewed:** runtime contains no relation semantics or dialect
  choices; `transaction-flow.ts` is nested-only legacy; dynamic Phase-5
  dependencies are limited to `capturedMutation` and `capturedRead`; programs
  contain no callbacks, closure bags, general symbols, guards, or branches;
  migrated linear cases have no executor fallback.
- **Structural delta from Phase 4:** files 121 -> 120; LOC 24,575 -> 24,495;
  functions 962 -> 963; parameters 2,295 -> 2,279; high-arity functions
  118 -> 113; branch nodes 2,404 -> 2,427; cycles unchanged at 3 components /
  13 files; no file exceeds 600 LOC.
- **Verified:** type-check; package build; Biome; diff check; 18/18 architecture
  gates; 901/901 query-engine; 210/210 root focused atomicity/result/
  transaction tests; PGlite 421/421; SQLite/LibSQL 740/740; MySQL 357/357;
  PostgreSQL 291 passed with 14 optional pgvector skips; package error/OTel
  smokes. Benchmark: direct write ~51,918 ops/s, non-returning write ~1,550
  ops/s, nested relation write ~13,661 ops/s.
- **Residual risks:** branch nodes are +23; `WriteOperations.ts` (563 LOC) and
  `OperationRuntime.ts` (315 LOC) remain above the 300-line smell threshold;
  branch-capable upsert remains intentionally deferred to Phase 6. No
  interoperability or data-safety exception is accepted.

---

## Phase 6: Add Produced Values, Guards, Branches, and Batch Specialization

### Goal

Complete the universal program vocabulary required for dependent and dynamic
operations before relation families migrate.

### Context

Nested relation writes need later steps to consume generated IDs, and
connect-or-create/upsert need data-dependent branches. Transactions can observe
their own writes; one-shot batches cannot. The semantic program must remain one
while the runtime specializes execution honestly.

### Needs

- Linear atomic runtime.
- Existing batch scratch-value and assertion mechanisms remain the behavioral
  oracle until replaced.
- Typed guard failures and race retry contracts.

### Units of Work

#### 6.1 — Add operation-owned produced values

- Define `ProducedValue` with monotonic operation-scoped identifiers.
- Let write steps declare produced fields.
- Let later statement values reference produced values declaratively.
- Prohibit arbitrary value-resolver callbacks.

Suggested commit: `refactor: add produced values to operation programs`.

#### 6.2 — Lower produced values in transaction execution

- Capture generated/returned/read values immediately after their producing
  step.
- Resolve later values through the operation runtime.
- Preserve scalar serialization and field-name translation choke points.

Suggested commit: `refactor: resolve produced values in transactions`.

#### 6.3 — Lower produced values in batch execution

- Move scratch-value storage and retrieval behind batch runtime ownership.
- Enforce store-immediately-after-producer ordering structurally.
- Preserve text round-trip cast behavior and cleanup guarantees.
- Reject unsupported generated compound identities explicitly.

Suggested commit: `refactor: resolve produced values in atomic batches`.

#### 6.4 — Add `GuardStep`

- Represent exists/not-exists and affected-row premises with typed failure
  ownership.
- Transaction execution checks the premise live.
- Batch execution lowers the premise to adapter assertions and maps failure to
  the same typed VibORM error.
- Preserve raceable guard attribution.

Suggested commit: `refactor: add guarded operation steps`.

#### 6.5 — Add `BranchStep`

- Represent a branch over a prior read result with explicit true and false
  step arrays.
- Require branch premises and pin policy to be visible in the program.
- Preserve one semantic branch definition for both runtime strategies.

Suggested commit: `refactor: add branch steps to operation programs`.

#### 6.6 — Implement batch runtime specialization

- Execute decision reads at planning time when the substrate cannot branch
  live.
- Select the corresponding branch arm.
- Emit guards that pin the observed premise at batch execution.
- Re-plan and retry only for explicitly raceable failures.
- Reject any branch that cannot be specialized safely rather than silently
  weakening semantics.

Suggested commit: `refactor: specialize branches for atomic batches`.

#### 6.7 — Prove the machinery with non-relation upsert

- Migrate top-level fallback upsert through read, branch, guard, write, and
  result steps.
- Demonstrate transaction/batch equivalence before relation compilation uses
  the machinery.

Suggested commit: `refactor: compile fallback upsert programs`.

### Deletion Targets

- Produced-value mechanics duplicated outside runtime ownership.
- Generic guard realization in nested mode files after consumers migrate.
- Top-level upsert fallback routing.
- Capability checks outside the single runtime selection boundary.

### Acceptance Criteria

- Produced values work identically in transaction and batch execution.
- Guard errors have the same type, message contract, and race attribution.
- One `BranchStep` semantic definition drives both runtimes.
- Batch specialization never drops a premise.
- Top-level upsert parity and concurrency suites pass on every provider.
- The runtime imports no relation semantic module.

### Verification

Run Level C plus upsert atomicity, race retry, batch reference, guard, and
concurrency suites.

### Completion Record

- **Status:** complete.
- **Score:** 11.0/12 after two root remediation cycles. The first root review
  scored 10.3/12 because retry authorization covered unrelated unique failures
  and direct atomic-batch guard indices ignored scratch setup queries.
- **Implemented:** monotonic operation-owned `ProducedValue`; declarative
  `GuardStep` and `BranchStep`; live transaction traversal; atomic-batch
  specialization with planning reads, premise pins, scratch storage/casts/
  cleanup, affected-row postconditions, and typed failure attribution; portable
  non-relation fallback upsert through one program definition.
- **Correctness remediation:** unique/deadlock/serialization retry is scoped to
  the selected missing/create arm and exact declared write step; unique retry
  additionally requires normalized provider table/column/constraint metadata
  matching the compiler-declared target. Missing or contradictory attribution
  fails closed. Guard/race indices are offset by setup-query count; indexed
  cleanup and unrelated assertion failures remain unchanged.
- **Changed:** `operation-program.ts`, `OperationCompiler.ts`,
  `OperationRuntime.ts`, `OperationBatchRuntime.ts`, `OperationResults.ts`,
  `WriteOperations.ts`, `WritePrograms.ts`, `executor.ts`, query-engine/client
  batch types and execution context, the where-unique predicate boundary,
  mutation identity/nested record access, migration registry/gates, and focused
  program/race/batch tests.
- **Deleted:** `transaction-flow.ts`, `BulkWritePrograms.ts`, and the
  non-relation top-level fallback-upsert executor route.
- **Boundaries reviewed:** runtime imports no relation/nested semantic module;
  compiler owns exact unique-target derivation; adapters own SQL/assertions/
  scratch primitives; programs contain data and `Sql` leaves, not callbacks or
  closure bags; nested relation execution remains behind one explicit legacy
  executor boundary for Phases 7–10.
- **Structural delta from Phase 5:** files 120 -> 120; LOC 24,495 -> 25,626;
  functions 963 -> 1,026; parameters 2,279 -> 2,404; high-arity 113 -> 116;
  branches 2,427 -> 2,570; cycles unchanged at 3 components / 13 files; no file
  exceeds 600 LOC. `OperationRuntime` 535 LOC, `OperationBatchRuntime` 494,
  `WriteOperations` 583, `WritePrograms` 424.
- **Verified independently:** type-check; package build and smokes; Biome;
  diff check; 18/18 gates; 79/79 focused retry/batch; 910/910 query-engine;
  PGlite 421/421; SQLite/LibSQL 740/740; MySQL 357/357; PostgreSQL 291 passed
  with 14 optional pgvector skips. Benchmark: direct write ~51,282 ops/s,
  non-returning ~1,548 ops/s, nested relation ~13,448 ops/s.
- **Residual risks:** structural expansion is material and must be repaid by
  deletion in Phases 8–11; four core files exceed the 300-line smell threshold;
  providers omitting both constraint and column attribution may cause a safe
  false-negative retry, never a false-positive retry.

---

## Phase 7: Migrate Relation Create and Connect Families

> **Execution override — 2026-07-13:** Per user direction, LOC growth is
> recorded but is not a blocking acceptance gate for this phase or the
> remaining implementation phases. Structural consolidation remains explicit
> Phase 11 work. Correctness, single ownership, legacy deletion where the
> replacement is complete, interoperability, and the 11/12 review threshold
> remain mandatory.

### Goal

Prove relation compilation on the simplest dependency directions and remove
their legacy interpreter implementations.

### Context

Create and connect cover both primary value-flow directions:

- child first, produced child identity consumed by the parent;
- parent first, produced parent identity consumed by children.

They also cover target existence guards, createMany row-shape planning, and
deep nested returns without requiring the full update/removal surface.

### Needs

- Produced values and guards.
- Working transaction and batch runtimes.
- Existing FK-direction and relation-correlation builders.
- Explicit migration routing by relation mutation kind.

### Units of Work

#### 7.1 — Establish relation compiler ownership

- Add `WriteOperations` and its `RelationMutations` child.
- Pass the parent object rather than a new relation context bag.
- Normalize relation input once.
- Keep per-relation semantic values explicit.

Suggested commit: `refactor: establish relation mutation compiler`.

#### 7.2 — Compile nested create

- Compile parent-holds-FK and child-holds-FK create ordering.
- Thread generated identities through `ProducedValue`.
- Support recursive relation create trees without interpreter-family imports.
- Preserve scalar-only versus terminal-refetch result behavior.

Suggested commit: `refactor: compile nested relation creates`.

#### 7.3 — Compile nested createMany

- Reuse canonical row-shape planning.
- Preserve defaults, generated values, skip-duplicate semantics, and FK
  assignment.
- Keep unsupported combinations as typed preflight errors.

Suggested commit: `refactor: compile nested relation createMany`.

#### 7.4 — Compile connect

- Compile target-existence guards and FK assignment for both directions.
- Preserve correlated versus target-not-found error taxonomy.
- Reuse adapter-backed subqueries where they remain valid SQL leaves.

Suggested commit: `refactor: compile nested relation connect`.

#### 7.5 — Compile deep return as a terminal read

- Append the same read step used by ordinary `findUnique` compilation.
- Declare deep expected result shape through `OperationResult`.
- Remove relation-execution-owned result refetch logic for migrated families.

Suggested commit: `refactor: compile deep mutation returns as reads`.

#### 7.6 — Delete migrated legacy semantics

- Delete legacy create/createMany/connect interpreter branches in the same
  phase.
- Update architecture gates so those kinds can only use the compiler.
- Remove any cross-family import that existed only for migrated kinds.

Suggested commit: `refactor: remove legacy relation create execution`.

### Deletion Targets

- Legacy create/connect interpreter functions and helpers used only by them.
- Nested create result assembly.
- `Interp` parameters from migrated call chains.
- Duplicate generated-ID bookkeeping.

### Acceptance Criteria

- All relation create/createMany/connect trees compile to `OperationProgram`.
- Both FK directions work on every supported database.
- Deep returns are terminal reads, not nested-write special cases.
- Migrated semantic implementations are deleted.
- The phase is materially file- and LOC-negative.

### Verification

Run Level C plus nested create, nested createMany, parent-PK dataflow, captured
target, deep return, and full nested-write conformance suites.

### Completion Record

- **Status:** complete.
- **Score:** 11.2/12. Correctness, cross-database parity, side-effect safety,
  transaction/batch equivalence, typed error propagation, observability, and
  regression protection are strong. Deductions: deferred update/upsert/
  connect-or-create/many-to-many governors still retain exclusively reachable
  compatibility leaves, and the migration temporarily adds structural bulk.
  Per the 2026-07-13 execution override, LOC growth itself did not block the
  phase.
- **Implemented:** `WriteOperations` owns `RelationMutations`; pure FK-backed
  nested create, createMany, and connect compile recursively to
  `OperationProgram` in both FK directions; generated identities flow through
  `ProducedValue`; connect targets use explicit existence guards; deep and
  scalar mutation returns end in the ordinary `findUnique` read contract;
  compound primary-key selectors, native scalar carriers, defaults, and
  createMany row shapes are preserved.
- **Changed:** `RelationMutations.ts`, `WriteOperations.ts`,
  `OperationCompiler.ts`, `OperationRuntime.ts`, `OperationBatchRuntime.ts`,
  `operation-program.ts`, `pending-operation.ts`, relation mutation/value
  builders, migration registry and architecture gates, and focused relation
  program tests.
- **Deleted:** `operations/nested-writes/assertions.ts` and
  `operations/nested-writes/create-identity.ts`; migrated create/connect result
  assembly and generated-identity ownership no longer have a standalone legacy
  route. Remaining create-family leaves are reachable only under semantic
  governors scheduled for Phases 8–9.
- **Boundaries reviewed:** runtimes import no relation semantics; dialect SQL
  remains adapter-owned; programs contain declarative data and `Sql` leaves,
  not callbacks or closure bags; batch preparation selects the program route
  before compatibility routing; transaction guard reads preserve locking;
  provider result metadata remains strict and malformed cardinality fails
  closed. No unrelated code was intentionally changed.
- **Structural record from Phase 6:** files 120 -> 119; LOC 25,626 -> 26,079;
  functions 1,026 -> 1,052; parameters 2,404 -> 2,461; high-arity 116 -> 116;
  branches 2,570 -> 2,620; cycles unchanged at 3 components / 13 files; no file
  exceeds 600 LOC. These figures are informational until Phase 11.
- **Verified independently:** type-check; package build and packed error/OTel
  smokes; Biome; diff check; 19/19 architecture gates; 169/169 focused relation
  suites; 912/912 query-engine; PGlite 421/421; SQLite/LibSQL 740/740; MySQL
  357/357; PostgreSQL 291 passed with 14 optional pgvector skips. Benchmark:
  direct write ~47,161 ops/s, non-returning write ~1,391 ops/s, nested relation
  write ~12,932 ops/s.
- **Residual risks:** deferred relation governors must be migrated before their
  compatibility leaves can be deleted; temporary files over the 300-line smell
  threshold and legacy import cycles remain explicit Phase 10–11 debt.

---

## Phase 8: Migrate Relation Updates, Removals, and Own-Write Analysis

### Goal

Move update, updateMany, set, disconnect, delete, and deleteMany semantics into
the relation compiler while consolidating legality analysis.

### Context

These families contain parent correlation, required-FK constraints,
after-image primary keys, departing-row checks, and same-operation dependencies.
The current implementation distributes these rules across interpreter files,
legality traversal, and numerous own-write analysis micro-files.

### Needs

- Relation create/connect migration.
- Produced-value and guard support.
- Existing legality and own-write regression suites.
- A measured consolidation design for analysis files.

### Units of Work

#### 8.1 — Compile nested update and updateMany

- Preserve scalars-before-relations ordering.
- Model post-update primary-key identity explicitly.
- Preserve parent correlation and affected-row rules.
- Reject nested relations inside updateMany data through preflight.

Suggested commit: `refactor: compile nested relation updates`.

#### 8.2 — Compile disconnect and set

- Preserve nullable versus required FK behavior.
- Compile departing-row guards and null-aware membership conditions.
- Preserve explicit-target versus boolean-true affected-row semantics.
- Keep set ordering identical across runtimes.

Suggested commit: `refactor: compile relation disconnect and set`.

#### 8.3 — Compile delete and deleteMany

- Preserve junction/FK ordering and parent correlation.
- Preserve lax set-based semantics for deleteMany and strict explicit-target
  semantics for delete.
- Keep required relation constraints as typed preflight or guard failures.

Suggested commit: `refactor: compile relation removals`.

#### 8.4 — Consolidate relation preflight

- Normalize relation input once.
- Run legality, portability, nested update validation, and dependency analysis
  over one explicit traversal where their data needs coincide.
- Avoid a generic visitor framework.
- Keep independent checks explicit and named.

Suggested commit: `refactor: consolidate relation preflight analysis`.

#### 8.5 — Consolidate own-write analysis

- Replace forwarding micro-files with a cohesive analyzer, ledger, constraints,
  and footprint representation.
- The analyzer owns operation-lifetime state.
- Remove context parameter bags and pass the owning parent.
- Preserve every same-operation dependency rejection and allowed case.

Suggested commit: `refactor: consolidate own-write analysis`.

#### 8.6 — Delete migrated legacy semantics

- Delete update/removal interpreter implementations and orphaned helpers.
- Update migrated-operation architecture gates.
- Verify no runtime imports the new relation compiler.

Suggested commit: `refactor: remove legacy relation update execution`.

### Deletion Targets

- Legacy update/removal interpreter families.
- Redundant nested validation traversals.
- Forwarding own-write files and context types.
- Mutable parent-data overlays replaced by explicit operation values.

### Acceptance Criteria

- All listed relation mutation kinds compile through one semantic owner.
- Parent correlation, required FK, after-image PK, and departing-row contracts
  remain green.
- Own-write analysis uses substantially fewer files and parameters.
- Migrated legacy semantics are deleted.
- No file exceeds 600 LOC.

### Verification

Run Level C plus legality, own-write, relation-key update, target constraint,
target footprint, relation filter mutation, and nested conformance suites.

### Completion Record

- **Status:** complete.
- **Score:** 11.1/12 after remediation. The first root review stayed below the
  gate because mixed create/update trees could still route wholly through the
  legacy interpreter and the first own-write consolidation merely relocated a
  context bag. Both deficiencies were corrected before acceptance. Correctness,
  cross-database parity, side-effect safety, transaction/batch equivalence,
  fail-closed result handling, typed errors, and regression protection are
  strong. Deductions remain for the measurable nested-write benchmark decline,
  Phase 9 compatibility leaves, and broad analysis/value modules above the
  300-line smell threshold.
- **Implemented:** FK-backed update, updateMany, set, disconnect, delete, and
  deleteMany now compile to `OperationProgram`; after-image identities and
  captured rows use explicit produced/derived values; read specialization and
  execution statements are separate; mixed update plus create/connect trees
  compose through `RelationMutations`; relation preflight is consolidated; and
  `OwnWriteAnalyzer` owns operation-lifetime state through parent-owned
  relation and step components rather than a context parameter bag.
- **Changed:** `RelationMutations.ts`, `RelationUpdates.ts`,
  `RelationRemovals.ts`, `RelationCaptures.ts`, `RelationProgramValues.ts`,
  `relation-preflight.ts`, the own-write analyzer/ledger/constraints modules,
  `OperationCompiler.ts`, `OperationRuntime.ts`, `OperationBatchRuntime.ts`,
  `operation-program.ts`, migration routing/gates, and focused program tests.
- **Deleted:** `legality.ts`, `own-write-dependency.ts`,
  `own-write-step-context.ts`, `own-write-branch-summary.ts`,
  `relation-membership-endpoints.ts`, `own-write-tree.ts`,
  `own-write-step.ts`, and `own-write-footprints.ts` from
  `operations/nested-writes/`. The migrated FK update/removal path has one
  semantic owner; remaining interpreter code is reachable only for Phase 9
  connect-or-create, upsert, and many-to-many governors.
- **Boundaries reviewed:** runtimes import no relation semantics; dialect SQL
  remains adapter-owned; programs store declarative values/statements rather
  than callbacks or closure bags; provider result cardinality fails closed;
  transaction guards retain locking; retry classification remains explicit;
  and no unrelated code was intentionally changed.
- **Structural record:** query-engine files 119; LOC 27,290; functions 1,118;
  parameters 2,543; high-arity functions 114 (down from 116); branch nodes
  2,757; cycles unchanged at 3 components / 13 files; no file exceeds 600 LOC.
  Per the 2026-07-13 execution override, LOC and file gains are informational
  and non-blocking until the later cleanup pass.
- **Verified:** type-check; package build and packed error/OTel smokes; Biome;
  diff check; 19/19 architecture gates; 238/238 focused legality/own-write/
  target/conformance tests; independently rerun query-engine 913/913 and
  PGlite 421/421; SQLite/LibSQL 740/740; MySQL 357/357; PostgreSQL 291 passed
  with 14 optional pgvector skips; instrumentation/transaction/provider-result/
  error suites 431/431.
- **Residual risks:** the nested relation benchmark fell from about 12.9k to
  10.8k operations/second; Phase 9 must remove the last interpreter governors
  and compatibility cycle; `RelationProgramValues` and several own-write files
  remain legitimate but broad cleanup candidates for Phase 11.

---

## Phase 9: Migrate Upsert, Connect-or-Create, and Many-to-Many

### Goal

Complete relation semantic migration through the branch-heavy and junction
families.

### Context

Upsert and connect-or-create use dynamic reads and branch pinning. Many-to-many
mutations add junction membership, self-relations, symmetric-difference guards,
and race retry. These are the final proof of the universal program.

### Needs

- Branch and batch-specialization machinery proven by top-level upsert.
- Relation update/removal migration.
- Existing many-to-many and concurrency conformance suites.

### Units of Work

#### 9.1 — Compile connect-or-create

- Compile existence read, found/missing branches, guards, connect, and create
  through the shared program vocabulary.
- Preserve first-create-wins deduplication within one operation.
- Preserve unique-race retry behavior.

Suggested commit: `refactor: compile connect-or-create programs`.

#### 9.2 — Compile nested upsert

- Compile correlated read, uncorrelated-exists rejection, update branch, and
  create branch.
- Preserve targetWhere/setWhere semantics.
- Preserve typed deletion-during-upsert and not-found behavior.

Suggested commit: `refactor: compile nested upsert programs`.

#### 9.3 — Compile many-to-many create and connect

- Represent junction insertion as an ordinary write statement owned by the
  relation compiler.
- Preserve self-relation endpoint direction and idempotent membership.
- Thread parent and target identities through operation values.

Suggested commit: `refactor: compile many-to-many link programs`.

#### 9.4 — Compile many-to-many update and removal

- Compile set, disconnect, update, updateMany, delete, and deleteMany.
- Preserve junction-first deletion where required.
- Preserve connected-target materialization and membership scope.

Suggested commit: `refactor: compile many-to-many mutation programs`.

#### 9.5 — Preserve staleness and race contracts

- Compile symmetric-difference or equivalent guards for materialized
  membership decisions.
- Keep raceability explicit in guard failure data.
- Re-plan the whole operation only for classified race losers.
- Reject any unpinnable branch that cannot meet portable semantics.

Suggested commit: `refactor: preserve many-to-many branch consistency`.

#### 9.6 — Delete all remaining relation interpreter semantics

- Remove the final `interpret-*` semantic bodies.
- Remove migrated routing and the temporary migrated-operation registry if no
  operation remains legacy.
- Make architecture gates reject any reintroduction of nested-write semantic
  execution.

Suggested commit: `refactor: remove legacy relation interpreter`.

### Deletion Targets

- Remaining `interpret-*` files.
- Relation-specific branches in runtime modes.
- Duplicate many-to-many inline branch logic.
- Temporary migrated-operation routing.

### Acceptance Criteria

- Every relation mutation kind compiles to `OperationProgram`.
- Transaction and batch runtimes execute the same semantic programs.
- Many-to-many, self-relation, concurrency, retry, and deep return suites pass
  on every provider.
- No relation semantic implementation remains in runtime files.
- The phase is materially file- and LOC-negative.

### Verification

Run Level C plus all nested-write conformance, many-to-many behavior,
concurrency, race retry, and upsert suites.

### Completion Record

- **Status:** complete.
- **Score:** 11.2/12 after remediation. The first root review scored 10.9
  because the runtime-import architecture gate enumerated semantic modules and
  omitted new Phase 9 owners. The gate now resolves runtime value imports
  generically, rejects all internal non-runtime dependencies, permits type-only
  ownership imports, and has positive fixtures for every current relation
  semantic owner. Correctness, interoperability, atomicity, branch isolation,
  fail-closed retry classification, typed errors, and regression coverage are
  strong. Deductions remain for the unreachable Phase 10 mode/effect substrate,
  three orchestration files near 600 lines, and two builder cycles.
- **Implemented:** connect-or-create and nested/top-level upsert compile to
  branch steps with branch-selected produced values and branch-local failures;
  many-to-many create, connect, set, disconnect, update, updateMany, delete,
  deleteMany, and upsert compile through compiler-owned junction statements;
  produced row sets preserve complete materialized memberships; symmetric-
  difference guards pin stale membership decisions; referenced-key occupancy
  guards run before parent scalar writes; and compilation is exhaustive rather
  than optional.
- **Changed/added:** `RelationBranches.ts`, `RelationUpserts.ts`,
  `ManyToManyMutations.ts`, `ManyToManyMemberships.ts`,
  `ManyToManyStatements.ts`, `MutationStatements.ts`, the relation compiler
  owners, `operation-program.ts`, compiler/runtime/results modules, relation
  preflight, driver error attribution, PostgreSQL forced-batch coverage, and
  program/runtime architecture gates including `runtime-import-boundary.ts`.
- **Deleted:** all twelve `interpret-*`/`interpreter.ts` semantic files,
  interpreter-only `update-identity.ts`, the temporary operation-program
  migration registry, legacy executor/runtime/pending-operation fallback
  routing, and all production references to those paths.
- **Boundaries reviewed:** relation statement materialization remains under
  `WriteOperations`; runtimes import only runtime peers and program data at
  value level, not relation semantics; the program is data-only and contains
  no stored callbacks; adapter-owned builders retain dialect SQL; exact unique
  retry still requires a matching pinned constraint/column identity; and no
  unrelated code was intentionally changed.
- **PostgreSQL remediation:** the `pg` forced-batch path retained exact table
  and constraint metadata but lost the failing statement index. Sequential
  batch normalization now attaches its exact loop index, allowing the existing
  fail-closed race classifier to select the correct pin without broadening
  retry to arbitrary `23505` errors. A real-provider regression covers the
  index, table, and constraint contract.
- **Structural delta from Phase 8:** files 119 -> 112; LOC 27,290 -> 25,028;
  functions 1,118 -> 1,094; parameters 2,543 -> 2,322; high-arity functions
  114 -> 80; branch nodes 2,757 -> 2,614; cycles 3 components / 13 files -> 2
  components / 5 files; no file exceeds 600 LOC. `operations/nested-writes/`
  fell from 37 files / 9,593 LOC to 24 files / 5,254 LOC. Per the 2026-07-13
  override, LOC remains informational, although this phase is materially
  negative.
- **Verified independently:** type-check; package build and packed error/OTel
  smokes; scoped Biome; diff check; 17/17 architecture gates; query-engine
  911/911 including nested conformance 169/169; PGlite 421/421; SQLite/LibSQL
  740/740; MySQL 357/357; PostgreSQL 292 passed with 14 optional pgvector
  skips; focused PostgreSQL attribution/race 3/3, concurrency 5/5, and M8 retry
  7/7. Benchmark: direct write ~50,189 ops/s, non-returning write ~1,525 ops/s,
  nested relation write ~10,602 ops/s.
- **Residual risks:** 24 unreachable mode/effect/planned/live files remain for
  mandatory Phase 10 deletion; `ManyToManyMutations`, `OperationRuntime`, and
  `OperationBatchRuntime` are near the 600-line ceiling; native batch providers
  without exact failing-statement attribution intentionally fail closed; and
  the two remaining builder cycles require Phase 10–11 cleanup.

---

## Phase 10: Retire the Nested-Write Subsystem and Narrow Compilation State

### Goal

Delete the obsolete architectural category and make the final dependency
direction explicit.

### Context

After Phase 9, `Mode`, `Effect`, `Probe`, interpreter dispatch, nested-write
detection, and special transaction flow should have no semantic consumers.
Keeping them as compatibility vocabulary would preserve the conceptual split
the reorganization is meant to remove.

### Needs

- All operation and relation kinds migrated.
- No temporary fallback routing.
- Full provider matrix green.

### Units of Work

#### 10.1 — Delete nested-write execution vocabulary

- Delete interpreter entry and family modules.
- Delete `Mode`, `LiveMode`, and `PlannedMode` after their mechanical behavior
  is owned by runtime modules.
- Delete `Effect`, `Probe`, nested result types, and interpreter symbol minters.
- Delete nested-write-specific preparation and routing.

Suggested commit: `refactor: remove nested write execution subsystem`.

#### 10.2 — Finalize runtime files

- Keep `OperationRuntime` as the sole strategy selector.
- Keep cohesive transaction execution, batch execution, batch state, and step
  lowering files only where each owns real behavior.
- Merge planned-state/sql/abort micro-files when their separation no longer
  earns a boundary.
- Ensure runtime imports program and driver contracts only.

Suggested commit: `refactor: finalize operation runtime boundaries`.

#### 10.3 — Replace `QueryContext` with narrow `QueryScope`

- Remove driver, schema registry, model registry fields that SQL construction
  does not use.
- Keep adapter, model, alias allocation, root alias, and mutation-target
  compilation state.
- Create child scopes for relation models.
- Migrate SQL builders in cohesive groups; do not keep parallel context types
  after the phase.

Suggested commit: `refactor: narrow query compilation scope`.

#### 10.4 — Finalize compiler ownership

- Keep one exhaustive `OperationCompiler` entry.
- Keep read, aggregate, and write compiler children only when they contain
  cohesive logic.
- Keep `RelationMutations` under `WriteOperations`.
- Remove child classes with a single forwarding method.

Suggested commit: `refactor: finalize operation compiler boundaries`.

#### 10.5 — Replace architecture gates

- Remove legacy roster and mode-specific gates.
- Assert the target dependency direction:

```text
PendingOperation → compiler → program → SQL/adapters
PendingOperation → runtime  → program → drivers
PendingOperation → results  → result parsers
```

- Assert runtime cannot import compiler relation modules.
- Assert compiler cannot import concrete runtime implementations.
- Assert no `operations/nested-writes/` directory exists.

Suggested commit: `test: enforce operation program architecture`.

### Deletion Targets

- Entire `src/query-engine/operations/nested-writes/` directory.
- `builders/nested-write-detector.ts`.
- Nested-write-specific branches in `transaction-flow.ts` and
  `operation-preparation.ts`.
- `QueryContext` and its unused fields.
- Temporary compatibility and migration files.

### Acceptance Criteria

- “Nested write” survives only as public feature terminology, not an engine
  subsystem.
- One runtime selects all execution strategies.
- One compiler owns all operation semantics.
- Only `QueryScope` reaches SQL builders.
- Import graph is acyclic across compiler/runtime/result domains.
- Query-engine file count is materially below baseline.

### Verification

Run Level C, full architecture gates, import-cycle checks, and structural
metrics.

### Completion Record

- **Status:** complete.
- **Score:** 11.4/12 after remediation. The first independent root review
  scored 10.8 because the Phase 10 file roster failed its Biome formatting and
  import-order gate. The same phase agent repaired only the files touched by
  this phase; type-check, architecture gates, focused contracts, scoped Biome,
  diff validation, the complete query-engine suite, and the provider matrix
  then passed again. Correctness, operation-program ownership, portability,
  atomicity, retry classification, typed failure propagation, and deletion of
  the replaced subsystem are strong. Deductions remain for the two SQL-builder
  cycles, several compiler/runtime classes above the Phase 11 method-count
  smell, remaining high-arity functions, stale current architecture prose,
  and unavailable pgvector-only coverage.
- **Implemented:** `PendingOperation` remains the sole lifecycle composition
  root; `OperationCompiler` compiles every operation exhaustively and resets
  produced-value identity per compilation; `OperationRuntime` is the sole
  capability selector; `OperationBatchRuntime` specializes dynamic branches;
  `OperationResults` owns strict provider result resolution; and
  `QueryEngine` remains the client-scoped owner of driver, registry,
  instrumentation, client identity, and transaction scope identity.
- **Changed/added:** lifecycle owners `pending-operation.ts`,
  `query-engine.ts`, `OperationCompiler.ts`, `OperationRuntime.ts`,
  `OperationBatchRuntime.ts`, `OperationResults.ts`, `operation-program.ts`,
  `WriteOperations.ts`, `MutationStatements.ts`, and `RelationMutations.ts`;
  compiler-analysis owners `OwnWriteAnalyzer.ts`, `OwnWriteLedger.ts`,
  `OwnWriteRelation.ts`, `OwnWriteSteps.ts`, `RelationBranches.ts`,
  `RelationMembership.ts`, `RelationMutationPlan.ts`,
  `RelationMutationValidation.ts`, `RelationProgramValues.ts`, and
  `TargetConstraint.ts`; `context/query-scope.ts`; `result/ResultParser.ts`;
  affected SQL-builder/result-parser call sites; the structure reporter; and
  operation-boundary, pending-operation, SQL-generation, equivalence,
  result-contract, batch, and provider contract tests.
- **Deleted:** the entire 24-file `operations/nested-writes/` directory;
  `builders/nested-write-detector.ts`; `executor.ts`; `transaction-flow.ts`;
  `context/query-context.ts`; `context/alias-generator.ts`; the old
  nested-write architecture gate; and the relocated micro-files
  `OwnWriteBranches.ts`, `OwnWriteTarget.ts`, `RelationKeyUpdates.ts`,
  `RelationMembershipScope.ts`, `RootMembershipFootprint.ts`,
  `TargetPredicateFootprint.ts`, and `ToOneUpdateFootprint.ts` after their
  surviving semantics were consolidated into cohesive compiler owners.
- **Boundaries reviewed:** runtime value imports resolve only to runtime peers,
  operation-program data, execution attribution, drivers, adapters, SQL, and
  instrumentation; runtime imports no relation semantics; compiler owners
  import no concrete runtime; result parsers import neither compiler nor
  runtime; `QueryScope` contains only adapter, model, alias allocator, root
  alias, and optional mutation table; programs contain no stored callback or
  closure bag; adapter-owned dialect SQL remains unchanged; and multi-step
  operations fail explicitly at the single-statement `QueryEngine.build`
  boundary rather than pretending to be one statement.
- **Structural delta from Phase 9:** files 112 -> 94; LOC 25,028 -> 22,112;
  functions 1,094 -> 983; parameters 2,322 -> 2,089; high-arity functions 80
  -> 68; branch nodes 2,614 -> 2,408; no file exceeds 600 LOC.
  `operations/nested-writes/` fell from 24 files / 5,254 LOC to zero. Compiler,
  runtime, and result domains are acyclic; two pre-existing SQL-builder cycle
  components remain. Per the 2026-07-13 override, file and LOC movement is
  informational and was not used as a completion blocker.
- **Verified independently:** type-check; scoped Biome; diff check; structural
  report; 17/17 architecture gates; query-engine 908/908 including nested
  conformance 169/169; PGlite 421/421; SQLite/LibSQL 740/740; MySQL 357/357
  against the service; PostgreSQL `pg` and `postgres.js` 292 passed with 14
  pgvector-only skips. The first root PostgreSQL invocation used invalid test
  credentials and failed with provider code `28P01`; it was not counted, and
  the rerun derived the existing test container settings without printing
  credentials and passed.
- **Residual risks:** the two SQL-builder cycles remain for Phase 11;
  `OperationRuntime`, `PendingOperation`, relation compiler owners, and several
  result helpers still exceed the method-count or high-arity smell threshold;
  current README/contributor architecture prose still describes the retired
  subsystem; pgvector-specific tests were unavailable; and native batch
  providers without exact failing-statement attribution intentionally retain
  fail-closed generic error behavior.

---

## Phase 11: Consolidate Results and SQL Files, Then Prove Final Parity

### Goal

Complete the aesthetic and structural cleanup after semantic migration, prove
that the new design is smaller, and update documentation.

### Context

The strangler phases prioritize correctness and deletion of duplicate
lifecycles. Once those paths are gone, result and SQL modules can be evaluated
without legacy consumers obscuring their real boundaries.

### Needs

- Legacy subsystem deleted.
- Stable compiler and runtime imports.
- Full correctness matrix green before mechanical consolidation.

### Units of Work

#### 11.1 — Consolidate result ownership

- Make `OperationResults` the parent of shape, row, scalar, relation, aggregate,
  and count parsing.
- Merge micro-files that are always used together.
- Preserve provider middleware, parser identity caches, deep result shapes,
  alias behavior, and strict absence handling.
- Keep no plausible-default fallback.

Suggested commit: `refactor: consolidate operation result parsing`.

#### 11.2 — Reorganize SQL construction by semantic concern

- Rename `builders/` to `sql/` only if the move improves navigation after
  consolidation.
- Keep pure adapter-backed functions.
- Merge one-use wrappers and micro-files.
- Keep large independent concerns such as where, relation filters, include,
  selection, ordering, aggregation, mutations, values, and many-to-many
  construction separate.
- Avoid path churn that produces no deletion.

Suggested commit: `refactor: organize query sql construction`.

#### 11.3 — Finalize public and advanced exports

- Keep `PendingOperation` as the public deferred-operation class.
- Remove `QueryOperation` terminology from code and current architecture docs.
- Resolve deprecated `QueryMetadata` compatibility.
- Define whether `QueryEngine.build` remains a single-statement API or becomes
  program inspection; do not make a multi-step program pretend to be one SQL
  statement.
- Preserve supported advanced builder exports deliberately.

Suggested commit: `refactor: finalize query engine exports`.

#### 11.4 — Run the self-review gate

- No source file above 600 LOC; justify every file above 300 LOC.
- No class above ten distinct concerns.
- No arbitrary context bags or runtime closure metadata.
- No unused flags, dead routes, or duplicated semantic switches.
- No import cycle between compiler, runtime, SQL, results, client, and driver.
- Trigger representative failures mentally and through tests; all failures
  surface explicitly.

Suggested commit: `refactor: remove final query engine scaffolding`.

#### 11.5 — Measure structural outcome

- Compare files, LOC, functions, parameters, high-arity functions, branches,
  imports, and cycles against Phase 0.
- Report temporary files introduced and prove each was deleted.
- Report the final relation compiler and runtime file rosters.
- Explain any missed target rather than altering the baseline.

Suggested commit: `docs: report query engine reorganization outcome`.

#### 11.6 — Run full interoperability and package proof

- Run every query-engine and local driver suite.
- Run PostgreSQL and MySQL suites against real services.
- Run SQLite, LibSQL, and PGlite suites.
- Run package build and package smoke tests.
- Run instrumentation, cache, transaction, and error suites affected by the
  operation lifecycle.
- Re-run benchmarks and compare against Phase 0.

Suggested commit: `test: prove operation program interoperability`.

#### 11.7 — Update architecture documentation

- Replace nested-write-interpreter diagrams with operation-program diagrams.
- Document `QueryEngine`, `PendingOperation`, compiler, runtime, result, SQL,
  adapter, and driver ownership.
- Preserve historical design documents as history and mark them superseded.
- Update contributor navigation and architecture gates.

Suggested commit: `docs: document operation program architecture`.

### Deletion Targets

- Redundant result micro-files.
- Inlinable SQL wrapper files.
- Stale nested-write architecture documentation in current guides.
- Deprecated compatibility types whose window has elapsed.
- Any temporary migration registry, adapter, or alias.

### Acceptance Criteria

- Final query-engine file count is at most 70; desired range is 55–65.
- `operations/nested-writes/` is deleted.
- Query-engine LOC is materially below 24,204.
- No file exceeds 600 LOC.
- No lifecycle branch remains based on `hasNestedWrites`.
- No runtime `QueryMetadata` closure bag remains.
- Every accepted portable operation passes the same shared behavior suites on
  PostgreSQL, MySQL, SQLite, LibSQL, and PGlite.
- Direct-read performance remains proportionate; any measured regression is
  documented and accepted explicitly.
- Package build, type-check, smoke tests, and documentation build pass.

### Verification

```bash
pnpm type-check
pnpm test
pnpm test:gates
pnpm test:pglite
pnpm test:sqlite
pnpm test:mysql
pnpm test:pg
pnpm package:build
pnpm test:package:phase7
pnpm bench:compare
git diff --check
```

### Completion Record

- **Status:** complete.
- **Score:** 11.1/12. Correctness, operation-program ownership, cross-database
  parity, side-effect safety, transaction and atomic-batch behavior, retry
  classification, strict result contracts, instrumentation, and typed failure
  propagation are green. Deductions remain for the isolated nested-relation
  benchmark regression, the missed aesthetic file-count target, a small branch
  and parameter increase from Phase 10, unavailable pgvector-only coverage,
  and historical vocabulary in protected `AGENTS.md` files.
- **Implemented:** `OperationResults` now owns parser selection per execution
  driver; `result/ResultParser.ts` owns provider middleware and parser identity;
  both remaining SQL-builder runtime cycles are removed; `PendingOperation`
  remains the only deferred lifecycle; `QueryEngine.build()` remains an honest
  single-statement inspection API; `QueryMetadata<T>` is a deprecated type-only
  alias through the next published compatibility release; permanent read and
  write regression contracts replace migration-pilot terminology; and current
  architecture documentation describes the operation-program design.
- **Changed/added:** `OperationResults.ts`, `result/ResultParser.ts`, cohesive
  result parser modules, relation-filter/where and select/include SQL builders,
  `pending-operation.ts`, `types.ts`, client operation naming, current query
  engine guides, historical-design supersession banners, permanent read/write
  contract suites, and
  `docs/architecture/query-engine-operation-program-outcome.md`.
- **Deleted:** `result/result-parser.ts`, `result/result-parser-chain.ts`,
  `result/count-value.ts`, and the old read/write pilot test paths. The migration
  registry, legacy executor/flow files, `BulkWritePrograms`, and the entire
  `operations/nested-writes/` subsystem remain absent.
- **Boundaries reviewed:** the complete query-engine runtime import graph is
  acyclic; runtime imports no relation semantics; compiler owners import no
  concrete runtime; result modules import neither compiler nor runtime
  implementations; programs contain no stored callback or closure bag;
  `QueryScope` remains SQL-construction-only; and adapter-owned dialect behavior
  is unchanged.
- **Structural delta from Phase 0:** files 121 -> 91; LOC 24,204 -> 22,073;
  functions 932 -> 984; parameters 2,291 -> 2,095; high-arity functions 123 ->
  66; branch nodes 2,340 -> 2,409; runtime import cycles 3 components / 13 files
  -> zero; no file exceeds 600 LOC. The original at-most-70-file target was not
  reached. Per the 2026-07-13 execution override, file and LOC figures are
  informational and were not used to trade away correctness or portability.
- **Verified:** type-check; full repository suite 5,447 passed with only
  separately configured provider files skipped; 18/18 architecture gates;
  PGlite 421/421; SQLite/LibSQL 740/740; MySQL 357/357; PostgreSQL 292 passed
  with 14 pgvector-only skips; package build and packed smokes; documentation
  build; scoped Biome; structural report; and diff check.
- **Performance:** the exact Phase 0 lifecycle benchmark rerun in isolation
  measured deferred read creation about 13-14% below baseline throughput,
  preparation about 8-9% below, direct writes about 2% below, non-returning
  writes about 1-6% below, and nested relation writes about 19-20% below. Direct
  paths remain proportionate. Nested execution remains an explicit optimization
  target; no semantic or safety check was weakened for benchmark gain.
- **Residual risks:** nested relation execution performance; 91 files and 31
  files above the 300-LOC smell threshold; several large but cohesive compiler
  and runtime owners; pgvector-only coverage unavailable; deprecated type-only
  `QueryMetadata` pending its compatibility window; and protected contributor
  `AGENTS.md` files retaining historical terms.

---

## Target File Organization

The exact roster must be earned during migration. The expected shape is:

```text
src/query-engine/
├── QueryEngine.ts
├── PendingOperation.ts
├── OperationProgram.ts
├── OperationCompiler.ts
├── OperationRuntime.ts
├── OperationResults.ts
├── QueryScope.ts
├── validateOperation.ts
├── cacheExecution.ts
├── types.ts
├── index.ts
│
├── compiler/
│   ├── ReadOperations.ts
│   ├── AggregateOperations.ts
│   ├── WriteOperations.ts
│   ├── CreateOperations.ts
│   ├── UpdateOperations.ts
│   ├── DeleteOperations.ts
│   └── relations/
│       ├── RelationMutations.ts
│       ├── RelationInput.ts
│       ├── RelationCreates.ts
│       ├── RelationUpdates.ts
│       ├── RelationRemovals.ts
│       ├── ManyToManyMutations.ts
│       ├── RelationPreflight.ts
│       ├── OwnWriteAnalysis.ts
│       └── OwnWriteLedger.ts
│
├── runtime/
│   ├── TransactionExecution.ts
│   ├── BatchExecution.ts
│   ├── BatchState.ts
│   └── lowerStep.ts
│
├── sql/
│   └── pure adapter-backed SQL construction by real concern
│
└── result/
    └── result shape and parsing by real concern
```

This is a ceiling, not a requirement to create every named file. If a proposed
child would contain only a forwarding method, keep the behavior on its parent.

## Final Definition of Done

The reorganization is complete only when all of the following are true:

1. `PendingOperation` is the sole operation lifecycle object.
2. `QueryEngine` is a real client-scoped owner or has been deleted; it is not a
   passthrough.
3. Every operation compiles to `OperationProgram`.
4. A simple query is a one-step direct program.
5. Multi-step, non-`RETURNING`, bulk, relation, deep-return, and branching
   operations compose from the same step vocabulary.
6. Relation mutations are owned under writes.
7. Transaction and batch execution specialize the same semantic program.
8. Produced values are declarative operation references, not callback state.
9. `OperationResults` owns the declared public result.
10. No separate nested-write interpreter, mode, effect, probe, or routing path
    remains.
11. Adapter and driver boundaries remain unchanged in responsibility.
12. Cross-database conformance is fully green.
13. The final codebase contains materially fewer files, lines, parameters,
    branches, and import cycles than the baseline.

If the universal program exists but the legacy routing, closure bags, and file
fragmentation remain, the objective has not been achieved.

## Final Review Record

- **Status:** complete under the 2026-07-13 structural-metrics override.
- **Final score:** 11.0/12. Items 1-12 of the final definition of done are
  satisfied. Item 13 is only partially satisfied: files, LOC, parameters,
  high-arity functions, and import cycles are lower, but branch nodes rose from
  2,340 to 2,409 and the 70-file ceiling was missed. Those figures remain
  explicit debt; they were not reduced by weakening correctness, portability,
  atomicity, or fail-closed behavior.
- **Correctness and interoperability:** every operation compiles to
  `OperationProgram`; `PendingOperation` is the sole lifecycle;
  `QueryEngine` is client-scoped ownership rather than a passthrough; relation
  semantics remain under `WriteOperations`; runtime imports no relation
  semantics; dialect behavior remains adapter-owned; transaction and atomic
  batch execution share the same program; PostgreSQL, MySQL, SQLite, LibSQL,
  and PGlite portable suites are green.
- **Safety:** lazy validation, Promise-like memoization, instrumentation,
  privacy, typed errors, strict provider results, transaction cleanup,
  operation atomicity, one-retry race handling, idempotent membership behavior,
  cache invalidation, and migration/data-safety contracts are covered by the
  final suite. No test was weakened and no provider-specific expected failure
  was added.
- **Final graph:** 91 query-engine files; 22,073 LOC; 984 functions; 2,095
  parameters; 66 high-arity functions; 2,409 branch nodes; zero runtime import
  cycle components; zero files above 600 LOC; zero files under
  `operations/nested-writes/`.
- **Final independent verification:** `pnpm type-check`; full `pnpm test`
  (172 files, 5,447 passed, 663 separately configured provider skips);
  18/18 architecture gates; PGlite 421/421; SQLite/LibSQL 740/740; MySQL
  357/357; PostgreSQL 292 passed with 14 pgvector-only skips; package build and
  both packed smoke tests; documentation build; scoped Biome; structural
  report; final import and legacy-scaffolding searches; and `git diff --check`.
- **Performance:** isolated Phase 0 command reruns keep direct execution
  proportionate but retain a roughly 19-20% nested-relation throughput
  regression. This is a visible optimization target, not a hidden waiver.
- **Deductions:** nested-relation benchmark regression; 91 files and 31 files
  above the 300-LOC smell threshold; branch growth and six additional Phase 11
  parameters; unavailable pgvector-only coverage; deprecated type-only
  `QueryMetadata` for one compatibility release; and stale historical terms in
  protected `AGENTS.md` files.
- **Deployment:** no commit, push, publication, PR, or deployment was made.
