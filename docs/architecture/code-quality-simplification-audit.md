# Code Quality and Simplification Audit

> **Superseded analysis.** This audit motivated the operation-program
> reorganization. Its measurements and proposals are preserved as history;
> [`query-engine-operation-program-implementation-plan.md`](./query-engine-operation-program-implementation-plan.md)
> and the current query-engine guides describe the implemented architecture.

Historical status: living analysis

Audit baseline: 2026-07-11 working tree compared with `HEAD`

Related documents:

- [Query Engine Correctness Remediation Plan](./query-engine-correctness-remediation-plan.md)
- [Codebase Reliability Remediation Plan](./codebase-reliability-remediation-plan.md)
- [Code Organization Cleanup Plan](./code-organization-cleanup-plan.md)

## Purpose

Record the structural and stylistic cost of the correctness remediation so the
codebase can be simplified without weakening its verified behavior.

The remediation restored important contracts, especially cross-database query
semantics, transaction atomicity, result correctness, error privacy, and
provider failure handling. It also introduced substantial file, function,
branch, parameter, and defensive-code growth.

This document is the shared workspace for deciding what should be deleted,
consolidated, or redesigned. It is diagnostic. Proposed shapes and reduction
estimates are not accepted architecture until reviewed and verified.

## Non-Negotiable Constraint

Simplification must not trade away database interoperability.

The same portable schema and client operation must continue to have the same
observable meaning on PostgreSQL, MySQL, and SQLite-family databases. Generated
SQL, statement count, locking, transaction strategy, and native provider APIs
may differ. Accepted inputs, selected records, mutation atomicity, returned
values, constraint failures, and recovery semantics may not.

Every cleanup must preserve:

- the query-engine/adapter/driver ownership boundary;
- atomic nested writes;
- exact non-`RETURNING` mutation behavior;
- provider-result failure handling;
- default redaction of SQL and parameters;
- operation-scoped driver context;
- cross-driver conformance tests.

The objective is not to remove checks indiscriminately. It is to validate once
at the correct boundary, convert to a trusted internal representation, and stop
revalidating that representation throughout the call graph.

## Audit Summary

### Structural growth

| Area | Files at `HEAD` | Current files | LOC at `HEAD` | Current LOC | Net LOC |
| --- | ---: | ---: | ---: | ---: | ---: |
| Query engine | 66 | 121 | 18,021 | 24,204 | +6,183 |
| Nested writes | 17 | 44 | 6,842 | 10,140 | +3,298 |
| Adapters | 10 | 14 | 3,109 | 3,138 | +29 |
| Drivers | 22 | 34 | 3,926 | 6,806 | +2,880 |

Across the query engine, adapters, and drivers, the working tree contains
approximately 9,092 more lines and 71 more TypeScript files than `HEAD`.

Tracked diff summaries under-report this growth because new untracked files are
not included in ordinary `git diff --stat` totals.

### Query-engine complexity growth

AST-based counts are directional metrics, not formal cyclomatic-complexity
scores.

| Metric | `HEAD` | Current | Change |
| --- | ---: | ---: | ---: |
| Functions | 645 | 932 | +287 |
| Total function parameters | 1,569 | 2,291 | +722 |
| Functions with at least five parameters | 87 | 123 | +36 |
| Branch nodes | 1,533 | 2,340 | +807 |
| Interfaces | 75 | 101 | +26 |
| Type aliases | 39 | 62 | +23 |

### Defensive-code growth

| Driver metric | `HEAD` | Current |
| --- | ---: | ---: |
| `try`/`catch` blocks | 17 | 64 |
| `throw` statements | 25 | 88 |
| `typeof` guards | 4 | 72 |
| Named guard functions | 2 | 23 |

Additional area growth:

| Area | LOC at `HEAD` | Current LOC | Net LOC |
| --- | ---: | ---: | ---: |
| Errors | 839 | 1,997 | +1,158 |
| Instrumentation | 1,390 | 1,929 | +539 |
| Cache | 1,138 | 1,300 | +162 |
| Client | 1,778 | 1,918 | +140 |
| Scalar definitions | 2,483 | 2,488 | +5 |

Six new defensive support files total 2,018 lines:

- `src/errors/diagnostics.ts`
- `src/errors/diagnostic-safety.ts`
- `src/drivers/driver-error-context.ts`
- `src/drivers/execution-context.ts`
- `src/drivers/normalized-result.ts`
- `src/drivers/planetscale/response-contract.ts`

Not all of these lines are unnecessary. Their concentration identifies a
high-value simplification area.

## Quality Target: The Existing Scalar Style

The scalar-state implementation is the clearest local expression of the target
style.

The concrete scalar classes do not currently inherit a shared scalar base
class. `State extends ScalarState<...>` is a generic constraint, not class
inheritance. Their clarity comes from common state semantics, local ownership,
and one shared state-transition helper. That distinction matters when applying
the pattern to query construction: class ownership is useful; an inheritance
hierarchy is useful only where several implementations are genuinely
substitutable.

### Complete state ownership

A scalar instance owns its state. Methods do not receive a loose context bag or
reconstruct state from unrelated arguments.

`StringScalar`, `IntScalar`, and the other scalar classes expose small,
operation-shaped methods such as `nullable`, `array`, `id`, `default`, and
`increment`.

### Types encode the invariant

`ScalarState` is the single state generic flowing through the scalar class.
`UpdateState` changes the runtime object and its compile-time meaning together.

The implementation does not repeatedly ask whether state created by the scalar
is malformed. The constructor and transition method establish the invariant;
later methods trust it.

### One abstraction does real work

`updateState` is justified because every scalar transition needs the same
runtime merge and type transformation. It is not a forwarding wrapper or a
namespace for one call.

### Explicit repetition is allowed

Scalar methods repeat a visible construction pattern. That repetition is often
clearer than a generic modifier framework with callbacks, option objects, and
runtime dispatch.

The target is therefore not maximum DRY. The target is minimal indirection with
one authoritative representation of each invariant.

## Quality Target: The Original Driver Abstraction

The pre-remediation driver was too large and contained a real mutable-context
race. It should not be restored unchanged. It nevertheless demonstrates useful
design qualities:

- `Driver` was the obvious owner of connection, execution, instrumentation,
  batch, and transaction behavior;
- concrete drivers implemented a small set of provider primitives;
- `TransactionBoundDriver` represented a real runtime object rather than an
  abstract organizational layer;
- control flow was long but locally traceable;
- invariants lived on the owning object instead of being passed through many
  helpers.

The lesson is not that one 854-line class is ideal. The lesson is that splitting
must follow owned responsibilities, not line-count pressure.

The desired driver shape should retain operation-scoped context and corrected
transaction semantics while recovering the original locality. Composition is
preferable to an inheritance ladder created solely to distribute methods across
files.

## Abstractions Worth Preserving

The following remediation abstractions solve real problems and should remain
unless a demonstrably simpler implementation preserves the same contract.

### Query-engine, adapter, and driver boundary

- Query engine owns query meaning and operation structure.
- Adapter owns dialect SQL.
- Driver owns provider execution, connections, transactions, and raw response
  normalization.

### One relation-mutation semantic implementation

Nested-write meaning must not fork by provider. Live transactions and atomic
batches are execution substrates, not separate semantic engines. The current
single interpreter established this invariant; simplification may absorb that
logic into `QueryOperation`, but it must not recreate two semantic paths.

### `Mode` as the execution-substrate axis

The live/planned distinction is real. It captures whether an operation can
observe its own writes and how produced values cross statement boundaries.

### `NestedWriteStep` semantic plan

The discriminated step representation is reused by execution and preflight
analysis. It is a meaningful internal representation, not a ceremony type.

### Strict normalized provider results

Malformed provider success payloads must throw. They must never become
plausible empty rows, zero counts, or undefined identifiers.

### Privacy and cleanup contracts

- SQL and parameters remain redacted by default.
- User logger/tracer failures do not replace valid database behavior.
- Rollback/release failures do not replace the original operation error.
- Concurrent operations retain their own execution context.

## Theme 1: File Fragmentation Without Semantic Boundaries

The nested-write directory grew from 17 to 44 TypeScript files.

Current clusters include:

| Cluster | Files | LOC |
| --- | ---: | ---: |
| `interpret-*.ts` | 11 | 3,894 |
| `own-write-*.ts` | 9 | 1,522 |
| `*footprint.ts` | 3 | 377 |
| `planned-*.ts` | 4 | 963 |

The query-engine architecture guide currently states that the interpreter is
split across family files "purely for navigability" and that the file
boundaries "carry no semantic meaning." That is evidence of decomposition by
size rather than by concept.

The current interpreter family also contains one eight-file runtime import
strongly connected component across create, update, upsert, connected-update,
and many-to-many modules. Function declarations make the present cycle work,
but the cycle demonstrates that the files do not own independent concepts.

### Desired direction

- Keep the flat nested-write directory small.
- Group one subsystem in a named subfolder only when it has several cohesive
  internal parts.
- Make every file boundary express ownership or an actual axis of variation.
- Do not create a file for one interface or one forwarding function unless it
  is a genuine public boundary.
- Do not merge everything back into a monolith merely to reduce file count.

## Theme 2: Parameter Plumbing and Context Bags

The interpreter repeatedly passes `interp`, `ctx`, relation metadata, FK
direction, decision-state data, final-state data, parent identity, selectors,
and operation-specific values.

Representative high-parameter functions include:

- `processRelationMutation`: nine parameters;
- several relation-removal and upsert functions: eight parameters;
- several connected-update and result-parser functions: seven parameters.

`Interp` is a three-field bundle containing mode, effect emission, and symbol
generation. `OwnWriteStepContext` contains eleven fields and is passed through
the own-write analysis graph.

These objects reduce signature length superficially but do not establish clear
ownership. They are transport containers created because functions were split
apart.

### Desired direction

- Put operation-lifetime state on the owning `QueryOperation`.
- Use child components only for real semantic families.
- Pass the parent instance to child components rather than constructing shared
  context bags.
- Keep per-node or per-relation values explicit when they genuinely vary during
  recursion.
- Do not replace many positional parameters with one unowned `Options` object.

## Theme 3: Branch Density and Repeated Traversal

Some branching is the domain language and should remain visible.

The scalar-filter operation switch, operation dispatch, and nested-step dispatch
represent real discriminated behavior. Replacing those switches with dynamic
lookup tables would hide complexity rather than remove it.

The avoidable complexity is repeated preparation around those branches:

- scalar filters compile normal filters and nested `not` filters through
  duplicated loops;
- legality validation, nested-write validation, own-write dependency analysis,
  and interpretation walk overlapping portions of the same tree;
- operation validation returns broad `Record<string, unknown>` values, causing
  downstream code to recheck shapes that validation already established.

### Desired direction

- Preserve exhaustive domain dispatch.
- Remove duplicated traversal and setup around dispatch.
- Convert validated input once into a trusted discriminated internal form.
- Make invalid states unrepresentable instead of adding another assertion at
  every consumer.

## Theme 4: Defensive Code at the Wrong Trust Boundary

The remediation correctly strengthened external boundaries. It also began
treating typed internal objects as hostile JavaScript values.

### Boundaries that require defensive validation

- user input before validation;
- raw database/provider responses;
- arbitrary provider error objects;
- user-supplied logger, tracer, cache, and callback execution;
- persisted files and external serialized state;
- transaction cleanup and concurrent execution.

### Internal values that should normally be trusted

- `QueryExecutionContext` instances created by VibORM;
- instrumentation configuration after construction;
- `VibORMError` instances created by VibORM;
- records created inside the diagnostic sanitizer;
- validated operation arguments after conversion to an internal type;
- normalized driver results after the driver boundary assertion;
- semantic plan nodes created by the planner.

### Current symptoms

- `execution-context.ts` uses reflective reads, runtime logger/tracer interface
  inspection, freezing, and fallbacks around an internal typed object;
- instrumentation accessors wrap typed property reads in `try`/`catch`;
- diagnostic helpers catch property-definition failure on fresh records created
  by the sanitizer itself;
- driver error handling reflectively reconstructs every VibORM error subtype;
- internal operation code throws messages such as "schema validation should
  have normalized this" and "validated arguments are missing";
- multiple local `isRecord` helpers compensate for lost type information.

### Governing rule

Validate once at an external boundary. Convert once to a trusted internal form.
Do not continue distrusting that form throughout the call graph.

## Theme 5: Driver Inheritance as Organizational Decomposition

The current driver implementation follows this chain:

```text
Driver
  extends DriverTransactionBase
    extends DriverInstrumentationBase
```

The base classes are not interchangeable implementations. They are one driver
implementation distributed through inheritance. `DriverTransactionBase` also
introduces a single-use `TransactionScopeDriver` interface and one abstract
factory implemented by `Driver`.

This makes behavior harder to locate and creates upward/downward knowledge
between files.

### Desired direction

Keep `Driver` as the public/provider subclass surface. Let it own cohesive
transaction and instrumentation collaborators when their responsibilities are
large enough to justify extraction. Pass the driver parent to those
collaborators so they can use owned state without ceremony interfaces.

Do not restore mutable shared query context. Operation-scoped context is a real
correctness improvement and remains mandatory.

## Theme 6: Derived State and Redundant Flags

The remediation added `disallowZero` to scalar and validation state to reject
explicit zero for portable auto-increment fields.

`autoGenerate: "increment"` already identifies the exact semantic condition.
Persisting both values creates redundant state and allows contradictory
combinations.

### Governing rule

Do not store state that can be derived cheaply and unambiguously from an
authoritative field.

This applies beyond scalar state:

- avoid capability booleans that duplicate adapter strategy values;
- avoid mode flags derivable from the selected mode object;
- avoid cached classifications unless measurement justifies them;
- prefer discriminated unions over several partially related booleans.

## Low-Hanging Simplification Units

These units are intended to preserve behavior exactly. Expected reductions are
directional estimates, not acceptance criteria.

### Unit Q1: Remove forwarding and micro-file abstractions

Candidates:

- delete `own-write-dependency.ts` and expose the real analysis operations;
- merge `relation-membership-endpoints.ts` with relation-membership scope;
- fold one-interface files into the module that owns and consumes the type;
- remove re-export layers that have no compatibility purpose.

Expected effect:

- two to four fewer files;
- fewer import edges;
- approximately 40 to 100 lines removed.

Risk: low.

### Unit Q2: Remove unused mode plumbing

Work:

- remove the unused `_mode` parameter from `assertPlanExecutable`;
- remove the unused `mode` callback argument from `AtomicScope.run`;
- put `bindContext` on the `Mode` contract;
- remove concrete `LiveMode`/`PlannedMode` checks from the interpreter entry.

Expected effect:

- smaller signatures;
- one cleaner abstraction boundary;
- removal of concrete mode knowledge from interpreter setup.

Risk: low.

### Unit Q3: Compile scalar filters through one local context

Work:

- share the operation loop between normal filters and nested `not` filters;
- capture `ctx`, field, scalar state, and column once;
- reduce `buildFilterOperation` to the values that actually vary;
- preserve the explicit operator switch.

Expected effect:

- approximately 30 to 50 lines removed;
- fewer repeated parameters;
- no change to adapter delegation or filter semantics.

Risk: low.

### Unit Q4: Remove redundant scalar state

Work:

- remove `disallowZero` from `ScalarState`;
- derive the create-input restriction from `autoGenerate === "increment"`;
- preserve the same validation error and provider behavior.

Expected effect:

- one fewer state dimension;
- less scalar-to-validation plumbing;
- impossible contradictory state removed.

Risk: low, with focused integer/bigint and cross-driver create tests.

### Unit Q5: Trust internal execution context

Work:

- construct an immutable operation-scoped context directly;
- stop reflectively validating internally created context and instrumentation;
- retain isolation of logger/tracer callback failures;
- retain correlation ID and privacy behavior.

Expected effect:

- substantial reduction in `execution-context.ts`;
- removal of repeated typed-property `try`/`catch` blocks;
- simpler driver instrumentation access.

Risk: medium because concurrency and privacy tests are load-bearing.

### Unit Q6: Separate hostile provider errors from trusted VibORM errors

Work:

- retain safe reads and bounded serialization for arbitrary provider errors;
- stop treating `VibORMError` instances as hostile provider objects;
- replace reflective subtype reconstruction with one owned context-enrichment
  mechanism;
- remove impossible fallbacks on records created by the sanitizer.

Expected effect:

- fewer reflective operations and catches;
- a smaller error-context layer;
- preserved subtype, redaction, and correlation semantics.

Risk: medium to high. The secret-canary, frozen-error, logger-failure, and error
subtype tests must remain unchanged.

### Unit Q7: Introduce trusted normalized operation arguments

Work:

- convert validation output into an operation-keyed discriminated type;
- stop passing generic `Record<string, unknown>` through the execution core;
- delete checks whose messages say validation should already have normalized
  the value;
- keep validation at public build/execute boundaries.

Expected effect:

- fewer casts, `isRecord` helpers, and impossible error paths;
- clearer operation signatures;
- a stronger foundation for simplifying nested-write execution.

Risk: medium because the type flow spans validation, operation building,
execution, and result parsing.

## Deeper Structural Workstreams

These are not low-hanging changes. They require an explicit design review before
implementation.

### Workstream A: Own-write analyzer

Current footprint:

- nine `own-write-*` files and 1,522 lines;
- three additional footprint files and 377 lines;
- an eleven-field `OwnWriteStepContext`;
- several forwarding functions over `OwnWriteLedger`.

Candidate shape:

```text
nested-writes/own-write/
  analyzer.ts
  ledger.ts
  constraints.ts
  footprints.ts
```

The analyzer should own operation-lifetime state. The final shape may use fewer
or more files if review finds a better semantic boundary. File count is not the
primary acceptance criterion.

Indicative opportunity:

- six to eight fewer files;
- approximately 150 to 300 fewer lines;
- substantially fewer context parameters.

### Workstream B: Relation mutations inside `QueryOperation`

Candidate direction:

- `QueryOperation` owns plan compilation and operation-lifetime symbol
  generation;
- one `RelationMutations` child owns create, update, upsert, and many-to-many
  relation semantics;
- relation components receive `QueryOperation` as their parent;
- family components call the parent instead of importing each other;
- per-relation values remain explicit;
- relation mutations contribute steps to the same `QueryPlan` used by every
  other operation;
- `OperationRuntime` selects direct, transactional, or atomic-batch execution
  from the completed plan;
- the runtime import cycle disappears.

This removes the nested-write interpreter as a top-level architectural concept.
It should turn file boundaries into semantic ownership boundaries and remove
`interp` from signatures: the operation itself is the owner.

### Workstream C: One preflight traversal

Legality validation, nested branch validation, portability checks, and own-write
dependency analysis currently traverse overlapping trees.

Investigate whether one preflight analyzer can run several explicit checks over
one normalized `NestedWriteStep` traversal without introducing a generic visitor
framework more complex than the duplication it replaces.

The desired outcome is fewer traversals and fewer branches, not a ceremonial
visitor pattern.

### Workstream D: Driver composition

Replace organizational inheritance with owned collaborators while preserving
the provider subclass surface.

Candidate responsibilities:

- `Driver`: public execution surface, client ownership, provider primitives;
- transaction component: transaction scopes, savepoints, scheduling, cleanup;
- instrumentation component: spans, logs, disclosure, operation context;
- provider result normalization: boundary functions owned by each driver or a
  genuinely shared result contract.

The parent remains the composition root and passes itself to children.

### Workstream E: Diagnostic boundary reduction

The privacy contract is correct; its implementation may be over-general.

Investigate a smaller design with two explicit paths:

1. trusted VibORM errors with owned metadata and serialization;
2. untrusted external errors sanitized once at the boundary.

Avoid a universal sanitizer that treats every internal record, array, error,
context, and configuration object as potentially hostile.

### Workstream F: Operation-owned query construction

The scalar analogy suggests a useful direction, but not one universal base
builder containing every concern.

Current `QueryContext` combines SQL construction, result parsing, validation
registry access, driver middleware, alias state, and mutation state. Usage is
highly uneven:

| `QueryContext` field | Approximate query-engine references |
| --- | ---: |
| `adapter` | 189 |
| `model` | 185 |
| `nextAlias` | 31 |
| `driver` | 6 |
| `schemaRegistry` | 1 |
| `registry` | 0 |

This argues against making the existing context the state of a universal base
class. It argues for separating compilation state from execution state.

#### Corrected ownership model

A nested write is not a peer abstraction beside `QueryOperation`. It is one
mutation operation whose normalized data contains relation mutations and whose
execution therefore needs an atomic multi-step runtime.

The current `PendingOperation` already owns the public lazy-operation lifecycle,
but delegates its behavior through `QueryMetadata`: a bag containing
`execute`, `prepare`, `prepareBatch`, and `parseResult` closures assembled in
`executor.ts`. That closure bag is the stronger consolidation target.

The candidate shape is one concrete operation composition root:

```text
QueryOperation
  owns client, model, operation, raw/validated arguments, and execution context
  owns lazy PromiseLike execution currently implemented by PendingOperation
  owns validation, build/prepare, execution, parsing, and instrumentation phases
  owns the operation-lifetime symbol namespace

  QueryScope
    owns adapter, model, alias allocation, and compilation-only state
    creates child scopes for relation models
    owns cohesive SQL-builder children

  OperationExecution
    evaluates the operation plan through direct, transactional, or atomic-batch mechanics
    selects the substrate from the plan's requirements and driver contract

  RelationMutations
    owns create/update/upsert/connect/disconnect relation semantics
    receives QueryOperation as its parent
    contributes read, write, guard, and branch steps to the operation plan

  OperationResults
    owns expected result shape, provider middleware, parsing, and post-processing
```

`QueryScope` should remain pure. Instrumentation does not belong in SQL
builders: it observes validation, building, execution, and parsing from the
operation boundary. SQL is an output or plan value, not constructor state for
the builder.

`QueryOperation` does not need to be abstract initially. The scalar classes show
that owned state and clear methods matter more than inheritance. One concrete
operation object with an operation discriminant can keep exhaustive dispatch
visible while deleting the metadata/closure assembly layer.

Inheritance should be introduced only if two or more operation classes retain a
large, stable common lifecycle after composition. Creating one subclass for
every small operation such as `count`, `delete`, or `findUnique` would be
phantom abstraction.

The builder side should prefer composition:

```ts
class QueryScope {
  readonly where = new WhereBuilder(this);
  readonly select = new SelectBuilder(this);
  readonly include = new IncludeBuilder(this);
  readonly mutations = new MutationBuilder(this);

  child(model: Model<any>, alias = this.nextAlias()): QueryScope {
    // Reuses adapter and alias allocation while changing the current model.
  }
}
```

The exact children must be earned by multiple cohesive methods. A child class
containing one forwarding method is worse than the current function.

#### One universal operation plan, not a second SQL language

The current nested-write `Mode`, `Effect`, `Probe`, and symbol machinery is not
fundamentally about nesting. It is about executing an atomic mutation program
whose later work may depend on reads or values produced by earlier work.

The earlier recommendation that simple reads and writes should bypass an
operation plan was too conservative. It would preserve the architectural split
that currently forces `executor.ts` and `operation-preparation.ts` to branch
between:

- direct statements;
- `createMany` plans;
- non-`RETURNING` mutation emulation;
- many-row return refetches;
- nested-write execution;
- single-query preparation;
- atomic-batch preparation.

These are not different operation lifecycles. They are programs with different
numbers of steps, value dependencies, result contracts, and atomicity
requirements.

Every operation should therefore compile to the same `QueryPlan` shape. A
simple read or write is not a bypass; it is the degenerate and most common
one-step program. A nested relation mutation is a larger program constructed
from the same execution primitives.

The important boundary is between an **operation program** and a **SQL syntax
tree**:

- the operation program describes ordered reads, writes, guards, branches,
  produced values, atomicity, and final result ownership;
- existing query builders and adapters still produce `Sql` fragments;
- the plan must not reimplement projections, joins, filters, aggregation,
  grouping, ordering, dialect functions, or quoting as a second general SQL
  AST;
- database-specific SQL remains exclusively adapter-owned.

This preserves the compositional principle without duplicating the adapter
layer. The plan's smallest primitives are execution semantics, not tokens of
SQL syntax.

The preliminary algebra is:

```ts
interface QueryPlan<T> {
  readonly steps: readonly QueryStep[];
  readonly result: OperationResult<T>;
  readonly atomicity: "statement" | "operation";
}

type QueryStep =
  | ReadStep
  | WriteStep
  | GuardStep
  | BranchStep;
```

Sequence is represented by the step array and by the step arrays owned by a
branch; it does not require a `SequenceStep`. Produced values live in
operation-owned slots/symbols referenced by later steps. `OperationResult`
identifies the terminal rows, row count, held record, or refetch that becomes
the public result and owns its parsing contract.

`ReadStep` and `WriteStep` may carry an already adapter-built `Sql` statement
when no deferred value exists. Mutation statements that consume a value
produced by an earlier step retain the current small `Expr` vocabulary until
the runtime can lower them. The exact statement carrier is an implementation
question for the pilot; it must not be solved with arbitrary callbacks, which
would merely recreate `QueryMetadata` as a closure bag inside the IR.

Under this model, the current nested-write vocabulary moves into the universal
plan and receives responsibility-based names:

- `OperationRuntime` instead of nested-write `Mode`;
- `WriteStep` instead of nested-write `Effect`;
- `ReadStep` instead of nested-write `Probe`;
- operation-owned symbols instead of interpreter-owned symbols;
- relation mutation compilation as one child of `QueryOperation`.

Atomicity is a plan requirement, not a separate nested-write runtime. The same
runtime executes one-step direct operations, multi-step non-`RETURNING`
emulation, bulk mutations, relation mutations, and refetch programs. It chooses
direct execution, an interactive transaction, or an atomic batch from the
plan's dependencies and the driver's honest capabilities.

The historical total-IR design identified the correct compositional pressure
but chose a much broader static write language and two substantial backend
interpreters. Its problems do not prove that a universal plan is wrong. They
show that the plan must stay smaller than the query language, that substrate
differences must remain localized, and that the migration must demonstrate net
deletion at every stage.

The intended simple case is therefore still direct in behavior, but not a
separate architecture:

```ts
const plan: QueryPlan<User[]> = {
  steps: [{ kind: "read", statement: buildFindMany(scope, args) }],
  result: rowsFrom(0),
  atomicity: "statement",
};
```

The runtime can fast-path that one step to `driver._execute`. Consistency does
not require imposing transaction machinery, symbol tables, or branch
allocation on it; those structures are materialized only when corresponding
steps exist. Universal representation and proportional runtime cost are
compatible.

#### Static factory rule

A static operation factory is useful if it performs real construction work:

- captures immutable operation context;
- preserves deferred validation semantics;
- creates the root query scope;
- replaces `QueryMetadata` closure assembly;
- returns the lazy `QueryOperation` directly to the client.

A static method that only forwards arguments to `new Subclass(...)` should not
exist.

#### Recommended pilot

Test the universal-plan shape on the read path before adopting it across the
engine:

1. replace `QueryMetadata` closures for `findUnique`, `findFirst`, and
   `findMany` with methods on `QueryOperation`;
2. compile all three to one-step `QueryPlan` values and execute them through
   `OperationRuntime`'s direct fast path;
3. create `QueryScope` with `where`, `select`, and child-scope ownership;
4. keep instrumentation on `QueryOperation`, outside `QueryScope`;
5. preserve lazy validation, PromiseLike behavior, native batch preparation,
   parsing, and generated SQL;
6. migrate one non-relation mutation and express its non-`RETURNING` refetch as
   a multi-step plan;
7. compare files, LOC, parameter counts, operation-specific executor branches,
   import cycles, allocations, and generated SQL;
8. abandon or reduce the design if it adds indirection without measurable
   deletion and lifecycle convergence.

Only after the read and simple-mutation pilots demonstrate compression should
relation mutations be compiled into the same plan. The intended endpoint is the
deletion of the nested-write execution category, not its relocation behind a
new name.

## Cleanup Anti-Goals

- Do not delete provider-result checks to reduce line count.
- Do not reintroduce shared mutable driver context.
- Do not replace explicit domain switches with string-keyed dispatch tables.
- Do not collapse nested writes into one multi-thousand-line module.
- Do not introduce generic `Manager`, `Handler`, `Context`, or `Options` types to
  hide parameter counts.
- Do not merge dialect SQL into the query engine.
- Do not weaken tests, add provider-specific expected failures, or document
  interoperability gaps as acceptable behavior.
- Do not optimize for a file-count or LOC number at the expense of semantic
  boundaries.

## Verification Contract for Every Cleanup Unit

Every unit must demonstrate behavior preservation with checks proportional to
its scope.

Minimum gates:

```bash
pnpm type-check
pnpm vitest run tests/query-engine/
pnpm test:drivers:local
git diff --check
```

When the unit touches driver execution, transactions, provider normalization,
or nested writes, also run every available real PostgreSQL and MySQL integration
suite plus the isolated PGlite matrix when the monolithic runner is unstable.

Additional mandatory checks by concern:

- error/diagnostic cleanup: packed error-name and optional-OTel smoke tests,
  privacy canaries, custom logger/tracer failure tests;
- nested-write cleanup: architecture gates, full nested conformance, atomicity,
  concurrency, and non-`RETURNING` mutation suites;
- scalar-state cleanup: scalar schemas, inferred types, create validation, and
  integer/bigint integration behavior;
- driver cleanup: transaction lifecycle, savepoint scheduling, provider result
  contracts, and context-concurrency tests.

No cleanup is accepted because snapshots or generated SQL look simpler. The
observable contract must remain identical.

## Evaluation Questions

Use these questions when adding or reviewing code:

1. What external or mutable boundary makes this guard necessary?
2. Has this value already been validated or normalized?
3. Can the type make the invalid state impossible?
4. Is this property authoritative, or derived from another property?
5. Does this file own a concept, or merely satisfy a size threshold?
6. Can this helper be inlined without losing a name that explains domain intent?
7. Is this interface used for real polymorphism or only to connect two files?
8. Does this context object own behavior, or only transport fields?
9. Is a branch expressing domain semantics or compensating for weak internal
   types?
10. Does the failure surface clearly, or does defensive code replace it with a
    plausible fallback?
11. Would a new database require changing query meaning, or only an adapter or
    driver implementation?
12. Can a reader follow the operation without jumping through several files
    whose boundaries carry no semantic meaning?

## Proposed Order of Analysis and Implementation

1. Execute the low-risk deletion units Q1-Q4.
2. Re-measure files, LOC, parameters, branches, and import cycles.
3. Execute internal-context simplification Q5 with privacy and concurrency
   gates.
4. Design the trusted-error boundary before changing Q6.
5. Introduce normalized operation arguments in Q7.
6. Reassess whether the own-write analyzer and relation-mutation component still
   require the larger Workstreams A-C.
7. Design driver composition and diagnostic reduction only after the smaller
   deletions expose the irreducible responsibilities.

This order follows deletion before replacement. Larger abstractions should be
introduced only after the existing ceremony is removed and the remaining
responsibilities are visible.

## Current Decision Record

Accepted principles:

- cross-database interoperability remains a release invariant;
- the current correctness tests are assets, not obstacles to cleanup;
- the working tree is structurally larger and less cohesive than the target;
- scalar-state ownership is a useful style oracle;
- the original driver demonstrates useful locality but must not regain mutable
  shared context;
- defensive validation belongs at trust boundaries;
- semantic cohesion matters more than mechanical file-size reduction;
- deletion and consolidation precede new abstractions;
- every query operation should compile to one universal operation plan;
- a universal operation plan must not become a second SQL syntax tree;
- one-statement plans retain a direct execution fast path.

Open decisions:

- exact boundary between `QueryOperation`, `QueryPlan`, `RelationMutations`,
  and `OperationRuntime`;
- the smallest declarative statement carrier that supports produced-value
  references without reintroducing closure bags or reifying all SQL;
- whether preflight checks can share one traversal without a generic visitor;
- how trusted VibORM errors receive execution context without subtype cloning;
- final composition boundary inside `Driver`;
- which provider response checks are irreducible contracts and which duplicate
  the generic normalized-result assertion.
