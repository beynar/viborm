# Query Engine V2

> **Status:** internal architectural experiment. Query Engine V1 remains the
> public implementation and continues to define client behavior.

## Why This Experiment Exists

VibORM promises one portable query model across PostgreSQL, MySQL, SQLite,
LibSQL, and PGlite. That promise is non-negotiable. The existing query engine
has accumulated the machinery required to preserve it across simple queries,
deep returns, generated values, relation mutations, transactions, and atomic
batches.

The resulting implementation is correct and broad, but its general operation
program, compiler families, runtime specialization, and relation machinery also
create a large structural surface. Adding or understanding one operation can
require navigating many files, branches, intermediate concepts, and ownership
seams. The machinery risks becoming harder to reason about than the operation
it represents.

V2 tests a smaller hypothesis:

> A concrete operation should validate and understand its payload, compile it
> into capability-specialized linear SQL fragments, and delegate only generic
> provider execution to a small executor.

This is not a rewrite commitment. It is a controlled proof intended to discover
whether a simpler architecture can preserve the complete interoperability and
safety contract before any public migration occurs.

## Architectural Hypothesis

```text
QueryEngine
└── creates a concrete operation
    ├── validates and interprets its payload
    ├── selects the available atomic capability
    ├── compiles planning and final linear fragments
    └── parses the declared result
             ↓
      OperationFragment
      ordered SQL steps + symbolic values
             ↓
      OperationExecutor
      provider execution + atomic envelope + strict results
             ↓
      driver and adapter
```

The architecture separates two kinds of knowledge:

- an operation knows what the request means;
- the executor knows how to execute already-compiled steps safely.

The executor must not learn about create, update, relation, filter, or nested
mutation semantics. Concrete operations must not implement provider protocols
or dialect syntax.

## Current Modules

| Module | Responsibility |
| --- | --- |
| [`CreateOperation`](./CreateOperation.ts) | Validate the supported create payload, resolve relation metadata, choose transaction or batch mode, compile planning and final fragments, and parse the create result |
| [`OperationFragment`](./OperationFragment.ts) | Represent ordered statement and guard steps, declared outputs, and references to values produced by earlier statements |
| [`OperationExecutor`](./OperationExecutor.ts) | Execute linear fragments, provide transaction or atomic-batch envelopes, lower symbolic values, manage batch scratch values, validate provider results, and attribute guard failures |
| `QueryEngine` | Remain the client-scoped owner of the driver, adapter, schema registry, instrumentation, and transaction identity |
| adapters | Own dialect SQL, assertions, casts, locking syntax, returning behavior, and batch-reference SQL |
| drivers | Own connection and provider execution semantics |

There is deliberately no base operation class, operation hierarchy, compiler
object, context bag, generic fragment validator, or second SQL AST.

## Main Ideas

### 1. Concrete operations own semantics

Each public operation kind may be represented by one concrete class such as
`CreateOperation` or a future `UpdateOperation`. The class owns the semantic
decisions unique to that operation:

- input validation and normalization;
- model and relation interpretation;
- statement ordering;
- capability specialization;
- result selection and parsing;
- typed operation failures.

Concrete classes do not inherit from an operation base class. A shared module
is introduced only after at least two real operations expose the same semantic
rule and would otherwise duplicate it.

### 2. Final fragments are linear

An `OperationFragment` is trusted internal compiler output. Its step order is
its execution order.

```ts
type OperationStep = StatementStep | GuardStep;
```

There is no generic runtime branch interpreter. When an operation needs a
database-dependent decision, the concrete operation performs a planning read
and creates the selected linear fragment before final execution.

Planning is guard-free. Root operation planning usually contains reads, but
E6.9 skip-duplicate capture intentionally performs preparation writes in this
phase and passes their outcomes to final compilation. Nested `Part.planning()`
currently contributes reads. Guards belong only to the final fragment.

This keeps the executor small and makes the generated operation inspectable:

```text
guard, when required
→ root write
→ selected relation write
→ final read
```

### 3. Capabilities shape compilation

The operation selects its execution mode once from the driver capabilities.
Transactions are preferred; otherwise an atomic batch is used. A driver
supporting neither is rejected before provider access.

Transaction mode:

```text
open transaction
  → execute locked planning read
  → compile the selected final fragment
  → execute the final fragment
  → parse the result
commit
```

Batch mode:

```text
execute planning read
→ compile the selected final fragment with a guard first
→ execute the complete final fragment as one atomic batch
→ parse the result
```

The guard pins the planning premise so a stale batch decision aborts before any
write. Database capabilities may change the generated SQL and steps, but they
must not change the portable operation semantics.

### 4. Runtime values remain explicit

Known values remain ordinary SQL parameters. Values that do not exist until a
prior statement completes use `OperationValueReference`.

This supports generated identifiers without hiding dependencies in callbacks
or mutable context:

```text
user.create.id
      ↓
post.create.userId
      ↓
user.select.where.id
```

Transaction execution resolves references to concrete provider values. Atomic
batch execution lowers them through adapter-owned batch-reference SQL. Casts
remain destination-field-aware and adapter-owned.

### 5. Nested mutations should compose, not create another engine

A nested write is not a separate runtime. It is operation semantics that
contributes planning reads, final mutation steps, dependencies, final guards,
and outputs to the same operation lifecycle. Root planning additionally owns
the E6.9 preparation-write exception described above.

The current proof keeps one nested upsert inside `CreateOperation` so the seam
is discovered from working code rather than invented in advance. If a future
`UpdateOperation` repeats the same relation-upsert rules, that duplication will
earn a concrete relation compiler such as a provisional `RelationUpsert` module.
It would produce ordinary fragment steps; it would not own execution or form a
class hierarchy.

### 6. Statements need semantic success contracts

A normalized provider result is not by itself proof that an operation fulfilled
its promise. Reads and writes must eventually declare the cardinality or effect
that constitutes success, for example:

```text
planning lookup  → zero or one row
single create    → exactly one affected row and its generated value
single update    → exactly one affected row
terminal read    → exactly one row
```

This is a statement postcondition, not another output value. Transaction mode
can verify returned results before commit. Batch mode must enforce any
rollback-relevant condition inside the atomic batch through adapter-owned
assertions, locked guards, constraints, or an equivalent portable mechanism.

The exact representation remains intentionally undecided until it can express
the required cross-database guarantees without rebuilding the larger V1
program vocabulary.

## The First Vertical Slice

The current implementation proves one intentionally narrow operation:

```ts
client.user.create({
  data: {
    name: "henry",
    posts: {
      upsert: {
        where: { id: 1 },
        create: { id: 1, title: "post" },
        update: { title: "post" },
      },
    },
  },
  select: {
    name: true,
    posts: true,
  },
});
```

The supported shape has:

- a root create with a database-generated incrementing identifier;
- one child-held-FK, to-many relation;
- one nested upsert selected by a global child lookup;
- reparenting on the update branch;
- generated parent-ID injection on both branches;
- a terminal deep selection.

The operation becomes one of two final linear sequences:

```text
transaction, existing child:
  user.create → post.update → user.select

transaction, missing child:
  user.create → post.create → user.select

batch, existing child:
  guard.exists → user.create → post.update → user.select

batch, missing child:
  guard.notExists → user.create → post.create → user.select
```

The same behavior has been verified through transaction and forced-batch paths
on PostgreSQL, MySQL, SQLite, LibSQL, and PGlite. This proves the slice, not the
generality of the architecture.

## What V2 Is Expected to Achieve

### Preserve correctness and interoperability

Portable operations must have equivalent observable behavior on every
supported database. Generated values, atomicity, locking, stale-decision
protection, error propagation, result parsing, instrumentation, and transaction
cleanup may not be weakened to simplify the implementation.

### Improve locality

A maintainer changing create semantics should primarily work in the create
module and the builders owning the affected SQL concern. Runtime execution
should not change when a new operation semantic is added.

### Enable composition

Complex operations should be constructed from the same small primitives used
by simple operations: parameterized statements, explicit produced values,
ordered dependencies, guards, and declared results. Nested depth should add
composed operation parts, not another interpreter.

### Compress structure

The architecture should reduce independent concepts, branches, high-arity
functions, context threading, and duplicated transaction/batch implementations.
Line count is evidence, not the objective: moving the same complexity into more
files or generic types is not success.

### Remain inspectable and fail closed

The compiled fragment should make ordering and dependencies visible. Missing
values, malformed provider results, violated postconditions, stale premises,
and unsupported operation shapes must raise typed errors. No layer may replace
failure with plausible empty data.

## How the Architecture Earns Its Next Seams

The second materially different operation is the decisive test.

A future `UpdateOperation` should be implemented concretely first. Its result
will determine whether two additional seams are real:

1. **Operation-to-executor interface.** If create and update expose the same
   mode, planning, final-fragment, and parsing lifecycle, introduce one small
   internal structural interface and remove create-specific knowledge from the
   executor. It must not become another public lifecycle object or compete with
   `PendingOperation`.
2. **Relation-operation composition.** If both operations implement the same
   nested-upsert semantic rules, extract those rules into one concrete relation
   module. Extract the shared meaning, not merely similar syntax.

The executor and fragment algebra should remain unchanged when the second
operation is added. If they acquire update-specific branches, relation imports,
or operation unions, the current seam is leaking and must be reconsidered.

## Deliberate Non-Goals

V2 does not currently attempt to provide:

- public client routing;
- a replacement for `PendingOperation`;
- a universal operation program;
- a complete SQL AST;
- arbitrary runtime callbacks or closure bags;
- a generic branch interpreter;
- a base class or subclass per operation;
- a defensive validator for compiler-created fragments;
- every nested mutation shape;
- transparent retry for unresolved write races.

Unsupported shapes must fail before provider access. New concepts are added
only when a concrete supported operation cannot preserve its semantics through
the existing model.

## Questions the Experiment Must Answer

Before V2 can replace any part of V1, it must demonstrate:

1. Can a second operation reuse the executor without adding semantic branches?
2. Can nested operations compose recursively without recreating a universal
   intermediate representation?
3. Can statement postconditions be enforced atomically and portably in both
   transaction and batch modes?
4. Can operations whose decisions depend on their own earlier writes remain
   linear, or do they prove the need for one additional finite primitive?
5. Can the architecture cover compound keys, both FK directions,
   many-to-many relations, non-returning mutations, and deep returns while
   remaining smaller and easier to navigate?
6. Can V1 behavior contracts be reused at the operation interface so migration
   deletes old semantics rather than maintaining two implementations?

If the answers require rebuilding V1 under different names, the experiment has
failed. If each new operation adds local semantic code while leaving the
executor, adapter seam, and fragment vocabulary stable, V2 has earned adoption.

## Adoption Standard

V2 is ready for incremental routing only when:

- its supported operation has behavior parity with V1;
- PostgreSQL, MySQL, SQLite, LibSQL, and PGlite pass the same contract;
- transaction and atomic-batch outcomes are equivalent;
- provider and semantic failures remain typed and fail closed;
- the operation adds no dialect inspection to the query engine;
- the migrated operation has one semantic implementation;
- the resulting module graph is smaller and more local than the path it
  replaces.

Until then, V2 remains a proof beside the production engine, not a promise that
the proof has already generalized.
