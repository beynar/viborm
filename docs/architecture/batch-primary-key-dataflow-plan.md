# Batch Primary-Key Dataflow Plan

## Purpose

Document and remove the batch-only nested-write limitation around generated and
updated primary keys.

The initial gap was that the batch path could execute nested writes atomically
only when parent and child primary keys were known before the batch was built.
It failed closed for:

- auto-increment parent IDs needed by later child statements;
- auto-increment child IDs needed by parent FK updates;
- updated primary keys in top-level `update` / `upsert` batch paths;
- downstream relation work that needs a primary key produced earlier in the
  same atomic batch.

That was correct safety-wise, but it was not the desired VibORM contract.
Nested writes should be provider-independent when the driver has an atomic
strategy.

## Current Documentation Status

Updated primary-key dataflow remains supported when the compiler can derive the
final value. Generated-ID dataflow is provider-specific: SQLite and MySQL keep
their exact statement-local batch lowerings. PostgreSQL never uses `lastval()`,
which is session-global and can be changed by another generated column or by a
trigger. Instead, a default PostgreSQL-family operation keeps the producer's own
`RETURNING` in one exact fold where possible, otherwise materializes it before a
guarded dependent segment. Segments can commit a prefix and report it. An
explicit `$transaction([...])` remains indivisible and refuses before effects
when no exact one-batch lowering can carry the output. The same segment runner
now serves safe RecordSeries on every no-transaction driver with native atomic
batch; `supportsOrderedCommittedSegments` strengthens attribution only. The
phase notes below are historical design records; this paragraph is the current
contract.

## T4b Reconciliation — the updated-PK class on V2 (delivered 2026-07-22)

Phases 1–5 below describe the **V1** batch runtime (the `batch-references.ts` /
`batch-updated-primary-keys.ts` symbol model, an adapter-owned batch-ref STORE for
computed PKs). That machinery still lives, frozen, in V1 (`src/query-engine/`,
`src/adapters/shared/batch-refs.ts`) and is the fallback. On the V2 query engine (the
default since P5) the **updated-PK** class — a top-level `update`/`upsert` that
TRANSITIONS its primary key while a nested `create` references it — is solved WITHOUT
any new adapter machinery, and reality diverged from the plan in one load-bearing way:

- **The updated PK is compile-known, not runtime-deferred.** V2's batch executor runs
  planning (the locate read) before it compiles the atomic batch, so at compile the
  located row's pre-transition PK is a concrete JS value; the where-pinned cases carry it
  even earlier, at construction. The post-transition value is therefore derived by V1's
  exact `getUpdatedPrimaryKeyValue` arithmetic (literal / `{ set }` / portable
  int·bigint `increment`·`decrement`·`multiply`·`divide`, `Math.trunc` for int divide) —
  the **same** function `UpdateOperation.buildTerminal` already uses to address the
  post-update row. Because `assertPortablePrimaryKeyUpdateInput` rejects non-portable
  (float/decimal) PK arithmetic up front, JS arithmetic equals the SQL the UPDATE's SET
  computes, so the child FK lowers to a construction **literal** — not a `BatchValueRef`,
  not an `adapter.batchRefs.store` of a computed expression. The batch-ref STORE the plan
  envisioned for computed updated PKs is **not needed on V2**.
- **Ordering, not a ref, is the mechanism.** A NO-ACTION child FK does not cascade, so the
  fresh INSERT must run AFTER the root UPDATE (the new parent row must exist first). V2
  collects such creates in `UpdateOperation.afterRootCreateParts` and emits them after the
  root UPDATE in BOTH `reorderRootUpdateAfterChildren` branches. This is distinct from the
  existing M2M / existing-edge reorder (those write against the PRE-transition value and
  rely on the junction FK's ON UPDATE CASCADE).
- **The generated-PK class uses only exact provider lowerings.** SQLite and MySQL
  use `last_insert_rowid()` / `LAST_INSERT_ID()` through
  `adapter.batchRefs.storeLastInsertId`. PostgreSQL never uses session-global
  `lastval()`: the producer's `RETURNING` either stays inside one exact mutation fold
  or is materialized before a guarded dependent batch segment. Explicit
  `$transaction([...])` arrays remain indivisible and refuse when no exact one-batch
  lowering exists.
- **Dialect coverage.** The updated-PK lowering is dialect-agnostic, but the family it
  belongs to (single-row `update`/`upsert` refetch) needs RETURNING on a batch-only
  driver. Certified native fallback-off on the RETURNING-capable batch-only drivers —
  SQLite3, LibSQL, PGlite, Postgres — plus SQLite3 transaction mode.
  **MySQL boundary-stop:** MySQL has no RETURNING, so a batch-only MySQL is a
  non-returning atomic driver; V1 AND V2 refuse the whole single-row update/upsert refetch
  family before I/O (byte-identical `TransactionError`, `routing.ts`
  `assertRoutedAtomicResolution`). MySQL therefore carries these mutations in
  TRANSACTION mode only — this is a family-level capability boundary, not a CLASS III gap.
- **Narrower boundaries still routing to V1:** a pre-transition PK knowable only from the
  located row (a non-PK `where` selecting the transitioning row), a compound generated PK,
  or a non-portable arithmetic op.

## Non-Negotiable Contract

- Query engine decides the mutation graph and primary-key data dependencies.
- Adapters decide dialect SQL for temporary references, generated IDs, computed
  PK expressions, and cleanup.
- Batch-only default operations stay atomic when an exact lowering exists.
  RETURNING-capable drivers may otherwise use guarded committed segments.
- An accepted segmented write can report a committed prefix after a later
  failure; it must never reuse provider output for the wrong row.
- Explicit `$transaction([...])` arrays stay indivisible.
- No public API change.
- No provider-specific public nested-write surface.
- No fake defaults, swallowed errors, or accepted-but-ignored nested branch.
- No destructive migrations, database drops, or persistent user-visible tables.

## Implementation Decision

Use internal adapter-owned batch reference storage.

Reason: SQLite/D1 cannot use `INSERT ... RETURNING` as a CTE source, and
`last_insert_rowid()` is volatile after later inserts. Without storing a
generated value immediately after the statement that produced it, deep generated
ID dependency graphs cannot be represented as one prebuilt atomic batch.

The reference storage must be:

- internal and invisible to users;
- scoped by a generated batch id;
- created/cleared inside the batch plan;
- cleaned on success;
- safe if a previous failed batch left rows behind for another batch id.

## Target Behavior

| Shape | Target behavior |
|-------|-----------------|
| Parent `create` with auto-increment ID and child create/connect/update | Child FK reads parent ID from batch ref |
| Child `create` before parent, child has auto-increment ID | Parent FK reads child ID from batch ref |
| Recursive generated IDs | Each produced PK can feed later descendants |
| `createMany` with generated IDs | Allowed only when later relation work does not need individual generated IDs |
| Top-level `update` updates PK with literal / `{ set }` | Final refetch and nested work use updated PK |
| Top-level `update` updates numeric PK with `increment/decrement/multiply/divide` | New PK is computed by SQL and stored as a batch ref |
| Top-level `upsert` update branch updates PK | Same behavior as update branch |
| Compound PKs | Work when every PK part is literal or ref-able |
| Unsafe PK updates | Reject before batch execution |

Unsafe means `null`, raw `Sql`, array operations, missing generated compound PK
parts, or unknown operation objects.

## Phase 0: Contract and Failing Tests

### Scope

Lock the exact generated/updated PK behavior before changing implementation.

### Work

- Add focused failing tests for batch-only drivers:
  - generated parent ID feeds to-many child FK;
  - generated child ID feeds to-one parent FK;
  - generated parent ID feeds multiple sibling relation branches;
  - generated parent -> generated child -> generated grandchild chain;
  - top-level update changes PK with direct literal and `{ set }`;
  - top-level update changes numeric PK with `increment`, `decrement`,
    `multiply`, and `divide`;
  - top-level upsert update branch changes PK and then executes nested create;
  - `$transaction([...])` flattens nested batch plans and returns results in
    input operation order;
  - unsupported compound/generated and unsafe PK update shapes reject before
    parent mutation.
- Add the same behavioral cases to local driver conformance where practical:
  - PGlite batch-only wrapper for Postgres/Neon-style semantics;
  - SQLite-family batch-only wrapper for D1-style semantics.

### Success Criteria

- Tests describe exact behavior and failure modes.
- Current implementation fails only on the missing dataflow behavior, not on
  unrelated setup.
- The tests prove rollback/no-parent-mutation on a failure after refs are
  created.

### Verification

```bash
pnpm vitest run tests/query-engine/nested-mutation-routing.test.ts tests/client/batch-transaction.test.ts
pnpm test:drivers:local
git diff --check
```

## Phase 1: Batch Reference Domain Model

### Scope

Add query-engine data structures for PK refs without adding SQL details.

### Work

- Add compact internal types under nested writes:
  - `BatchValueRef`;
  - `BatchRecordRef`;
  - `BatchPrimaryKeyRef`;
  - `BatchReferenceStore`;
  - `BatchResolvableValue = unknown | Sql | BatchValueRef`.
- Extend `PlanState` with:
  - unique `batchId`;
  - monotonically increasing ref keys;
  - setup statements;
  - cleanup statements;
  - helper to register produced PK refs for a model record.
- Define one canonical conversion function:
  - literal values stay literals;
  - `Sql` values stay SQL fragments;
  - refs lower through the adapter batch-ref API.
- Do not leak refs into public result parsing. Refs are only for SQL planning.

### Success Criteria

- Batch refs are domain objects, not raw SQL strings.
- Existing literal-only batch plans still build the same SQL except setup/cleanup
  is absent when no refs are used.
- No adapter-specific SQL appears in query-engine code.

### Expected Tests

- Unit tests for ref allocation:
  - unique keys;
  - deterministic ordering;
  - cleanup only when refs are allocated;
  - no ref allocation for fully literal PKs.

### Verification

```bash
pnpm vitest run tests/query-engine/nested-mutation-routing.test.ts
pnpm type-check
git diff --check
```

## Phase 2: Adapter-Owned Batch Ref SQL

### Scope

Add adapter APIs that let batch plans store and read refs safely.

### Work

- Extend `DatabaseAdapter` with an internal `batchRefs` namespace:
  - `setup(batchId): Sql[]`;
  - `clear(batchId): Sql`;
  - `cleanup(batchId): Sql`;
  - `store(batchId, key, valueSql): Sql`;
  - `read(batchId, key): Sql`;
  - `storeLastInsertId(batchId, key): Sql`.
- PostgreSQL adapter:
  - uses transaction-scoped temp storage for explicit values;
  - deliberately omits `storeLastInsertId`; immediacy does not make
    session-global `lastval()` exact in the presence of triggers;
  - `read` returns a scalar subquery.
- SQLite adapter:
  - use temp storage valid for the connection/batch execution;
  - `storeLastInsertId` uses `last_insert_rowid()` immediately after insert;
  - `read` returns a scalar subquery.
- MySQL adapter:
  - implement the same API with `LAST_INSERT_ID()` and temp storage so the
    interface remains complete, even though MySQL drivers normally use
    transaction paths.
- Ref setup must be idempotent:
  - create storage if absent;
  - clear the current batch id before first use;
  - cleanup current batch id at the end.

### Success Criteria

- Query engine can request refs without knowing temp table syntax.
- Ref setup/cleanup SQL is adapter-owned.
- Batch failure cannot commit partial user data; ref cleanup is best effort only
  after success because failed atomic batches roll back user mutations.

### Expected Tests

- SQL-generation tests for Postgres and SQLite adapter output:
  - setup;
  - clear;
  - store last insert id;
  - store arbitrary expression;
  - read expression;
  - cleanup.
- Driver smoke tests for local SQLite/PGlite:
  - ref store can hold and read a generated ID inside one batch.

### Verification

```bash
pnpm vitest run tests/query-engine/nested-mutation-routing.test.ts tests/query-engine/sql-generation.test.ts
pnpm test:drivers:local
pnpm type-check
git diff --check
```

## Phase 3: Generated PK Propagation for Batch Creates

### Scope

Replace static PK assumptions in batch `create` with ref-aware PK resolution.

### Work

- Replace `getStaticPrimaryKeyWhere()` usage in batch create/upsert create
  branches with `getBatchPrimaryKeyRef()`.
- For provided PKs:
  - use literal values as today.
- For validation-generated string IDs:
  - keep using the value in the create data once generated by validation.
- For single auto-increment PKs:
  - append the insert;
  - immediately append `storeLastInsertId(batchId, refKey)`;
  - return a `BatchRecordRef` instead of mutating parent data with unknown IDs.
- Update FK assignment helpers to accept `BatchResolvableValue`.
- Update `buildValues`, `buildWhereUnique`, and nested FK builders only where
  needed so refs become adapter `read()` SQL expressions.
- Keep `createMany` conservative:
  - if generated IDs from individual rows are needed downstream, reject before
    execution;
  - if no downstream relation needs those IDs, allow it as today.

### Success Criteria

- Parent generated IDs can feed all later child statements.
- Child generated IDs can feed parent FK updates.
- Recursive generated create chains work.
- Literal-only plans do not regress.
- A non-returning plural generated key with no complete selector fails before
  mutation; PostgreSQL publishes the complete tuple through `RETURNING`.

### Expected Tests

- SQLite-family batch-only drivers retain the generated-ID cases below.
- Batch-only PGlite proves exact one-statement folds and guarded `RETURNING`
  segments, including compound/plural generated-key publication.
- An explicit indivisible batch remains the pre-effect refusal witness when its
  internal statements need a generated output and no exact one-batch lowering
  exists.

### Verification

```bash
pnpm vitest run tests/query-engine/nested-mutation-routing.test.ts tests/query-engine/nested-writes.test.ts tests/query-engine/nested-create-many.test.ts
pnpm test:drivers:local
pnpm type-check
git diff --check
```

## Phase 4: Updated PK Propagation for Batch Update and Upsert

### Scope

Remove blanket rejection for primary-key updates in batch nested `update` and
upsert update branches.

### Work

- Replace `primaryKeyIsUpdated()` rejection with a ref-aware PK update planner.
- Add `getBatchUpdatedPrimaryKeyRef()`:
  - starts from the before-record PK;
  - for unchanged PK parts, keeps literal/ref from before-record;
  - for direct literal and `{ set }`, stores the new literal/ref;
  - for numeric ops, stores SQL expression based on the old PK value:
    - `increment`: old + value;
    - `decrement`: old - value;
    - `multiply`: old * value;
    - `divide`: old / value.
- Store computed updated PK refs immediately after the update statement.
- Use updated PK refs for:
  - final refetch;
  - nested relation mutations that need the parent PK after update;
  - `$transaction([...])` operation result parsing.
- Reject before execution for:
  - `null` PK updates;
  - raw `Sql` PK updates;
  - array ops on PK fields;
  - unknown operation envelopes;
  - numeric ops on non-numeric PK scalar types.

### Success Criteria

- Updating an ID in a batch-only nested update works when SQL can compute the
  new ID.
- Upsert update branch follows the same dataflow.
- Nested work after a PK update uses the new key, not the old key.
- Unsafe PK updates fail closed before the first mutation statement.

### Expected Tests

- Batch-only PGlite and SQLite-family (updated-PK class only):
  - update `id: "new-id"` then nested create uses `"new-id"`;
  - update `id: { set: "new-id" }` then final result refetch works;
  - numeric PK `increment/decrement/multiply/divide` refetches by computed PK;
  - upsert update branch changes PK then nested create uses changed PK;
  - unsafe PK updates reject before parent mutation.

### Verification

```bash
pnpm vitest run tests/query-engine/nested-mutation-routing.test.ts tests/client/batch-transaction.test.ts
pnpm test:drivers:local
pnpm type-check
git diff --check
```

## Phase 5: Batch Transaction Flattening

### Scope

Make `$transaction([...])` preserve generated/updated PK refs across each nested
operation plan while keeping public results ordered by input operation.

### Work

- Ensure every nested batch operation contributes:
  - setup refs only once per flattened transaction;
  - statements in operation order;
  - cleanup at the end;
  - parser indexes for operation results.
- Keep ordinary prepared-query batching unchanged when no nested plan is present.
- Reject the whole transaction before execution if any operation cannot produce
  an atomic ref-safe batch plan.
- Make generated batch ids unique per flattened transaction, not per operation,
  so sibling operations cannot collide.

### Success Criteria

- `$transaction([createWithGeneratedNested, updatePkWithNested, ...])` executes
  as one atomic batch.
- Result parsing still maps each final selected result to the matching input
  operation.
- A failure in any operation rolls back all previous operations and internal
  refs.

### Expected Tests

- `$transaction([...])` with:
  - generated parent nested create;
  - updated PK nested create;
  - mixed ordinary and nested operations;
  - failing later operation proving rollback of earlier generated refs and user
    rows.

### Verification

```bash
pnpm vitest run tests/client/batch-transaction.test.ts tests/query-engine/nested-mutation-routing.test.ts
pnpm test:drivers:local
pnpm type-check
git diff --check
```

## Phase 6: Docs and Capability Matrix

### Scope

Update docs so nested-write batch support claims are honest and exact.

### Work

- Update nested-write docs:
- batch-only drivers support updated PK dataflow; generated PostgreSQL values use
  exact one-statement folds or guarded `RETURNING` segments in default operations,
  while an indivisible explicit array still requires an exact one-batch lowering;
  - no provider-specific public nested-write surface;
  - impossible or unsafe PK shapes fail closed.
- Update compatibility matrix:
  - D1 bindings and Neon HTTP are not blanket nested-write gaps;
  - mark hosted conformance as externally verified only after external runs.
- Update architecture docs:
  - query engine tracks semantic refs;
  - adapters own ref SQL;
  - drivers execute atomic batches.

### Success Criteria

- Docs do not overclaim hosted external proof.
- Docs state the PostgreSQL generated-ID batch boundary without weakening the
  portable public operation surface.

### Verification

```bash
git diff --check -- docs README.md
```

## Phase 7: Final Audit

### Scope

Prove the feature is complete, provider-independent, and does not leak adapter
details into the query engine.

### Work

- Inspect diff for:
  - hardcoded dialect SQL in query-engine;
  - non-atomic fallback paths;
  - accepted-but-ignored nested branches;
  - temp/ref storage leaking into public APIs;
  - stale fail-closed messages claiming PK dataflow is unsupported.
- Check file cohesion:
  - no nested-write god file;
  - ref storage helpers are in focused files;
  - adapter methods are named as internal implementation detail.
- Run the strongest practical verification set.

### Verification

```bash
pnpm vitest run tests/query-engine/nested-mutation-routing.test.ts tests/query-engine/nested-writes.test.ts tests/query-engine/nested-create-many.test.ts tests/query-engine/named-inverse-nested-writes.test.ts
pnpm vitest run tests/client/batch-transaction.test.ts tests/client/operations.test.ts tests/client/select-include-result.test.ts
pnpm test:drivers:local
pnpm type-check
pnpm test
pnpm build
git diff --check
```

## Residual Risks

- Hosted D1 bindings and Neon HTTP still need external conformance runs after local
  proof.
- Temp storage syntax can differ subtly across hosted environments; adapter tests
  reduce but do not remove that risk.
- Numeric PK `divide` may have dialect-specific integer division behavior. Tests
  should use values that produce exact integer results.
- Compound generated PKs remain constrained by whether every part can be known
  or ref-ed safely.
