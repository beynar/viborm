# Query Engine Correctness Remediation Plan

## Status

**Proposed.** This plan is derived from the July 2026 read-only audit of the
query engine, SQL layer, database adapters, and drivers.

Companion plan: [Codebase Reliability Remediation Plan](./codebase-reliability-remediation-plan.md).
Worker blob portability and privacy/redaction are shared gates: neither plan
may mark those gates complete until both plans' acceptance criteria pass.

No implementation work is complete merely because an item appears here. A
phase is complete only when its acceptance criteria and verification commands
pass. Correctness phases precede decomposition: moving incorrect behavior into
smaller files would only distribute the defect.

## Purpose

Restore and lock the core correctness contracts that sit between validated ORM
input and provider execution.

The audit found no P0 issue, but it did find failures that can:

- broaden destructive relation filters;
- duplicate or omit cursor-paginated records;
- persist generated increment sentinels as real IDs;
- reject valid SQLite statements based on an identifier name;
- fail on binary values in a standard Cloudflare Worker runtime;
- return stale or unrelated rows after non-`RETURNING` mutations;
- parse nested relation results with another model's schema;
- serialize private query parameters into errors;
- misattribute concurrent driver operations;
- convert malformed provider responses into plausible empty results;
- hide original transaction failures or accept ignored transaction options.

The target is not feature expansion. It is one portable behavioral contract
implemented across every advertised database. Provider-specific rejection is
acceptable only as an interim safety barrier while a defect is being repaired;
it is not a completed interoperability solution.

## Cross-Database Interoperability Contract

The same VibORM schema and portable client operation must have the same
observable semantics on PostgreSQL, MySQL, and SQLite-family databases:

- the same valid input is accepted;
- the same predicate selects the same logical records;
- mutations have the same atomicity and result semantics;
- generated/default values preserve the same meaning;
- result values have the same shape and runtime scalar types;
- equivalent constraint and transaction failures surface consistently.

Adapters and drivers may use different SQL, statement counts, locks,
transactions, batches, or emulation strategies. Those differences are
implementation details. They may affect performance, but not correctness.

Raw SQL and explicitly database-native escape hatches are outside this portable
contract. Everything exposed through the ordinary schema and client API is
inside it.

A driver does not satisfy this contract by documenting a limitation or
rejecting an otherwise portable operation only on that provider. If a backend
cannot yet implement a portable operation, that driver fails the support gate
for that release.

## Ownership Boundary

| Layer | Owns in this plan | Must not own |
|---|---|---|
| Validation | Which relation-filter and pagination shapes are accepted | SQL combination or database semantics |
| Query engine | Boolean meaning, total ordering, row-shape planning, result cardinality, mutation orchestration | Dialect syntax or provider-specific statement APIs |
| Adapters | Dialect SQL for null ordering, conflict behavior, locking, and returning capabilities | Query intent or execution state |
| Drivers | Provider statement classification, binary parameter conversion, transactions, result-shape normalization | ORM filtering or mutation business rules |
| Errors and instrumentation | Redaction policy and operation-scoped context | Provider execution decisions |
| Tests | Cross-driver behavioral contracts and focused unit regressions | Provider-specific assumptions hidden in shared expectations |
| Documentation | The portable contract and native escape-hatch boundaries | Provider-specific degradation presented as interoperability |

The query-engine/adapter boundary remains non-negotiable: the query engine
decides **what** operation is required; adapters decide **how** that operation
is expressed for a dialect; drivers decide **how** the provider executes it.

## Current Failure Context

| Priority | Failure | Current evidence | User-visible consequence |
|---|---|---|---|
| P1 | Combined relation operators | `relation-filter-builder.ts:47-106` returns after the first supplied operator | Later predicates are silently ignored; bulk mutations can affect excess rows |
| P2 | Empty `every` | `relation-filter-builder.ts:330-350` lowers it as “no related rows” | Parents with any related row fail an always-true predicate |
| P1 | Cursor ordering | `find-pagination.ts:284-367` omits unique tie-breakers and null-aware comparisons | Duplicate or missing records across pages |
| P1 | Mixed `createMany` defaults | `values-builder.ts:120-198` unions columns across heterogeneous rows | Generated IDs can be persisted as `0` / `0n` |
| P1 | SQLite `RETURNING` classification | SQLite-family drivers search the entire SQL string for `RETURNING` | Ordinary table names such as `returning_events` break writes and migrations |
| P1 | D1 binary portability | `sqlite-utils.ts:20-28` assumes global `Buffer` | Blob writes fail without Workers `nodejs_compat` |
| P1 | Non-`RETURNING` mutation flow | `result-flow.ts:105-218` performs read/write/refetch without one locked transaction | Returned row can be stale or belong to a concurrent writer |
| P2 | Relation parser cache identity | `result-parser.ts:116-127` keys by bare relation name | Deep values can be parsed with another model's scalar schema |
| P1 | Error metadata leakage | `error-mapping.ts:224-237` always retains SQL and parameters | Secrets and personal values can enter serialized logs |
| P2 | Driver context race | `driver.ts:107-120` stores request context on a shared instance | Concurrent traces and errors can be attributed to the wrong operation |
| P2 | Provider results fail open | Neon HTTP, D1 binding, planned mode, and generic parsing synthesize empty results | Provider drift or malformed responses appear successful |
| P2 | Transaction cleanup | rollback paths can mask the original error and leave savepoints unreleased | Wrong exception reaches the caller; nested transaction state can remain dirty |
| P2 | Nested isolation options | `TransactionBoundDriver.transaction` accepts then ignores options | Publicly accepted behavior is not applied |
| Risk | MySQL conflict semantics | target is ignored for upsert; `INSERT IGNORE` suppresses more than duplicates | API wording can over-promise portable behavior |
| Risk | Oversized correctness hotspots | eleven scoped files exceed 600 lines | Defects cluster in files with multiple distinct responsibilities |

The regression suite must preserve concrete reproductions, not just test the
implementation shape. In particular:

- a relation filter containing more than one operator in the same object;
- `every: {}` with empty and non-empty child collections;
- tied and `NULL` sort values on both forward and reverse cursor pages;
- one bulk-create row with an explicit ID and one relying on generation;
- a SQLite identifier containing the word `returning`;
- a D1 blob operation with no global `Buffer`;
- two concurrent non-`RETURNING` mutations targeting the same unique value;
- two nested models that both expose a relation called `children`;
- a constraint error containing a secret-like parameter;
- two overlapping operations on one driver instance;
- malformed “successful” provider payloads;
- rollback failure after a callback failure.

## Non-Negotiable Contracts

1. **All accepted predicates apply.** No operator may be ignored because a
   sibling operator appeared first in object iteration or branch order.
2. **Relation quantifiers keep their mathematical meaning.** `every: {}` is
   true for every parent, including parents with children.
3. **Cursor traversal has a total order.** Every page is stable across ties,
   explicit null placement, forward traversal, and reverse traversal.
4. **Database-generated values remain database-generated.** A sentinel used by
   validation or schema state must never become a persisted value accidentally.
5. **Drivers classify statements from provider semantics, not text accidents.**
6. **Worker-facing paths use Worker-compatible binary APIs by default.**
7. **Read/write/refetch mutation flows are one atomic semantic operation.**
8. **Caches are keyed by semantic identity, not a coincidental display name.**
9. **Private SQL and parameters are absent by default from serializable errors.**
10. **Execution context is request-scoped.** A shared driver contains no
    mutable per-operation attribution state.
11. **Malformed provider output throws.** It never becomes `[]`, `0`, `null`,
    or another plausible success value.
12. **The first failure remains the primary failure.** Cleanup errors are
    attached without replacing the operation error.
13. **Transaction options have one public contract.** Every advertised driver
    implements an accepted option, or that option is rejected uniformly by
    client validation before any provider is selected.
14. **Portable behavior is database-independent.** Adapter and driver
    capability differences are emulated internally and may not leak into
    accepted inputs, mutation meaning, result shape, or errors.
15. **No source decomposition begins until behavioral gates are green.**

## Dependency Order

The phases are ordered by semantic dependency:

1. freeze current failures in tests;
2. repair pure query semantics;
3. repair row-shape and adapter/driver execution primitives;
4. make parsing, privacy, context, and transaction failures fail closed;
5. build atomic non-`RETURNING` mutation flow on the corrected transaction
   primitives;
6. implement cross-database parity for remaining dialect gaps and prove it
   through one shared conformance suite;
7. decompose correctness hotspots without changing behavior.

Independent units inside a phase may be developed in parallel, but each unit
must remain independently reviewable and committable.

## Phase 0: Freeze the Behavioral Contracts

### Goal

Turn each confirmed failure into a minimal regression before modifying source
behavior.

### Context

Several current suites exercise adjacent happy paths but miss the exact edge:
relation filters combine through a top-level `AND`, pagination uses unique
order tuples, bulk rows are homogeneous, and non-`RETURNING` mutation tests are
sequential.

### Units of Work

#### 0.1 — Query-semantics regressions

- Add same-object `some` + `none`, `some` + `every`, and `is` + `isNot` cases.
- Include `findMany`, `updateMany`, and `deleteMany` assertions so destructive
  broadening is covered.
- Add `every: {}` for parents with zero, one, and several related rows.
- Add cursor cases for tied values, nullable values, compound cursors, negative
  `take`, `skip`, and explicit `nulls: "first" | "last"`.

Suggested commit: `test: lock query semantic edge cases`.

#### 0.2 — Write and driver regressions

- Add mixed explicit/generated increment rows to top-level and nested
  `createMany`.
- Add SQLite statement tests whose identifiers, comments, and string values
  contain `returning`, plus genuine mutation `RETURNING` statements.
- Add a D1-compatible binary test with `globalThis.Buffer` unavailable.

Suggested commit: `test: lock bulk write and sqlite driver failures`.

#### 0.3 — Parsing, privacy, and concurrency regressions

- Add a recursive graph where two model levels use the same relation name but
  target different scalar types.
- Assert error JSON excludes a secret-like parameter and SQL when disclosure is
  disabled.
- Overlap two operations on one driver and assert each span/error retains its
  own model and operation.
- Feed malformed successful payloads to Neon HTTP, D1 binding, planned mode, and
  generic result parsing; assert explicit errors.

Suggested commit: `test: lock parsing and observability isolation`.

#### 0.4 — Transaction and mutation regressions

- Add rollback-failure tests that retain the callback error and expose cleanup
  failure as secondary context.
- Define one portable nested-transaction option contract and assert it before
  any provider-specific test runs.
- Add deterministic barriers around concurrent MySQL-style non-`RETURNING`
  update/delete flows.
- Lock the desired portable upsert-target and skip-duplicate behavior, then run
  the same assertions against MySQL.

Suggested commit: `test: lock transaction and mysql contracts`.

### Affected Files

- `tests/client/relation-filter.test.ts`
- `tests/drivers/relation-filter-mutation-behavior.ts`
- `tests/drivers/relation-read-aggregate-behavior.ts`
- `tests/drivers/distinct-skip-window-behavior.ts`
- `tests/drivers/many-and-return-behavior.ts`
- `tests/query-engine/nested-create-many.test.ts`
- `tests/drivers/sqlite3.test.ts`
- `tests/query-engine/vector-distance-result-parser.test.ts` or a focused new
  result-parser regression file
- `tests/drivers/error-mapping.test.ts`
- `tests/instrumentation/context-spans.test.ts`
- `tests/drivers/savepoint-queue.test.ts`
- `tests/query-engine/non-returning-mutation-returns.test.ts`
- `tests/drivers/mysql2.test.ts`

### Acceptance Criteria

- Every audit reproduction exists as a named test with an assertion on the
  externally visible result.
- Tests fail for the intended reason on the current implementation.
- No test depends on timing alone; concurrency tests use barriers or controlled
  fake providers.
- Provider-specific expectations are isolated from shared portable behavior.

### Expected Tests

- Focused unit tests for builders, parsers, error normalization, and transaction
  cleanup.
- Shared driver behavior tests for public client semantics.
- Local PGlite and SQLite3 integration reproductions.

### Verification Commands

```bash
pnpm vitest run tests/client/relation-filter.test.ts tests/drivers/pglite.test.ts tests/drivers/sqlite3.test.ts tests/drivers/libsql.test.ts -t "Client Relation Filters|relation-filter mutation behavior"
pnpm vitest run tests/drivers/pglite.test.ts tests/drivers/sqlite3.test.ts tests/drivers/libsql.test.ts -t "relation read/aggregate behavior|distinct/skip windows"
pnpm vitest run tests/query-engine/nested-create-many.test.ts tests/drivers/pglite.test.ts tests/drivers/sqlite3.test.ts tests/drivers/libsql.test.ts -t "Nested CreateMany|createManyAndReturn / updateManyAndReturn"
pnpm vitest run tests/drivers/sqlite3.test.ts tests/drivers/error-mapping.test.ts
pnpm vitest run tests/instrumentation/context-spans.test.ts tests/drivers/savepoint-queue.test.ts
pnpm vitest run tests/query-engine/non-returning-mutation-returns.test.ts
pnpm vitest run tests/drivers/pglite.test.ts tests/drivers/sqlite3.test.ts tests/drivers/libsql.test.ts -t "upsert atomicity behavior"
pnpm vitest run tests/query-engine/result-contract-regressions.test.ts
pnpm type-check
git diff --check
```

## Phase 1: Relation Filter Semantics

### Goal

Apply every supplied relation operator and restore correct empty-`every`
semantics without changing the public filter shape.

### Context

`buildToManyFilter` and `buildToOneFilter` return on the first matching branch.
The accepted object shape permits siblings, so branch order currently changes
meaning. Separately, negating an absent inner predicate makes `every: {}` mean
“has no children” rather than “no child violates true.”

### Units of Work

#### 1.1 — Combine to-many operators

- Build each supplied `some`, `every`, and `none` predicate independently.
- Combine the resulting fragments with the adapter's boolean `and` primitive.
- Preserve a clear invalid-input error when none is supplied.
- Do not encode dialect SQL in the builder.

Suggested commit: `fix: combine to-many relation filters`.

#### 1.2 — Combine to-one operators

- Build both `is` and `isNot` when present.
- Combine through the same adapter boolean primitive.
- Cover `null` and object forms explicitly.

Suggested commit: `fix: combine to-one relation filters`.

#### 1.3 — Implement vacuous truth

- Detect an empty inner predicate for `every` before lowering the correlated
  subquery.
- Represent the result as an adapter-owned true condition or elide that one
  conjunct; do not reinterpret it as `none: {}`.
- Preserve non-empty `every` as “no related row violates the predicate.”

Suggested commit: `fix: preserve empty every semantics`.

### Affected Files

- `src/query-engine/builders/relation-filter-builder.ts`
- `src/query-engine/builders/where-builder.ts` only if a reusable boolean
  identity is required
- adapter interfaces only if no portable true-condition primitive exists
- relation-filter tests established in Phase 0

### Acceptance Criteria

- The result is independent of operator key order.
- All combinations of supported sibling operators apply.
- `every: {}` matches parents with and without related rows.
- Bulk update/delete affects exactly the rows matching the complete filter.
- Generated SQL remains parameterized and dialect-neutral in query-engine code.

### Expected Tests

- Builder SQL snapshots for combined predicates.
- Shared public behavior tests across PostgreSQL, MySQL, and SQLite families.
- Mutation rollback assertions when a later operation fails.

### Verification Commands

```bash
pnpm vitest run tests/client/relation-filter.test.ts tests/model/filter/relation-filter.test.ts
pnpm vitest run tests/drivers/pglite.test.ts tests/drivers/sqlite3.test.ts tests/drivers/libsql.test.ts -t "relation-filter mutation behavior|relation read/aggregate behavior"
pnpm vitest run tests/query-engine/sql-generation.test.ts
pnpm type-check
git diff --check
```

## Phase 2: Total, Null-Aware Cursor Ordering

### Goal

Make cursor traversal deterministic and lossless for ties, nullable sort keys,
compound keys, and reverse pagination.

### Context

The current lexicographic predicate uses only user-requested order fields.
Several rows can therefore occupy the same position. Ordinary comparisons with
`NULL` evaluate to unknown, and reverse traversal flips direction without
flipping null placement.

### Units of Work

#### 2.1 — Define normalized total order

- Introduce one internal normalized-order representation containing direction,
  null placement, scalar expression, and whether the key is an appended
  tie-breaker.
- Append the canonical scalar or compound primary identity after user order
  fields on every paginated query. Then append any remaining alternate-cursor
  fields in stable model-key order; this suffix cannot change the order because
  the canonical identity is already unique.
- Reuse the representation for SQL ordering and cursor predicate generation so
  the two cannot drift.

Suggested commit: `refactor: normalize cursor ordering`.

#### 2.2 — Generate null-aware lexicographic predicates

- Encode before/equal/after for null and non-null cursor values according to
  explicit null placement.
- Avoid ordinary `column = NULL` and `column > NULL` comparisons.
- Keep every dialect decision in adapter order/comparison primitives where SQL
  differs.

Suggested commit: `fix: make cursor predicates null aware`.

#### 2.3 — Correct reverse traversal

- Reverse sort direction and null placement as one operation.
- Apply `skip` relative to the cursor before trimming to the requested window.
- Reverse returned rows only at the established result boundary.

Suggested commit: `fix: preserve reverse cursor order`.

#### 2.4 — Bound cursor subquery work

- Ensure cursor row values are fetched once per order key rather than repeated
  through an O(k²) expansion where possible.
- Treat this as a mechanical optimization after semantic tests pass; do not
  change public SQL shape merely for aesthetics.

Suggested commit: `perf: reuse cursor order values`.

### Affected Files

- `src/query-engine/operations/find-pagination.ts`
- `src/query-engine/operations/cursor-order.ts`
- `src/query-engine/operations/cursor-condition.ts`
- `src/query-engine/operations/find-common.ts`
- `src/query-engine/operations/aggregate-input.ts`
- adapter ordering/comparison interfaces and dialect implementations if needed
- `tests/drivers/distinct-skip-window-behavior.ts`
- `tests/drivers/cursor-pagination-behavior.ts`
- `tests/query-engine/cursor-pagination-sql.test.ts`
- `docs/content/docs/client/pagination.mdx`

### Acceptance Criteria

- Repeated pagination visits every row exactly once with no duplicates.
- Tied requested order values are resolved by appended unique keys.
- `NULL` works at either end in ascending and descending order.
- Forward then reverse traversal is symmetric.
- Compound cursors and multi-key ordering preserve stable precedence.
- Documentation examples describe the actual total-order contract.

### Expected Tests

- Table-driven predicate tests for direction × null placement × cursor-nullness.
- Shared driver behavior with ties and nulls.
- Property-style traversal test asserting concatenated pages equal a one-shot
  total-order query.

### Verification Commands

```bash
pnpm vitest run tests/drivers/pglite.test.ts tests/drivers/sqlite3.test.ts tests/drivers/libsql.test.ts -t "distinct/skip windows|total cursor pagination"
pnpm vitest run tests/query-engine/sql-generation.test.ts tests/query-engine/cursor-pagination-sql.test.ts
pnpm test:drivers:local
pnpm type-check
git diff --check
```

## Phase 3: Correct Bulk Insert Row Shapes

### Goal

Preserve per-row default and generated-value semantics in heterogeneous
`createMany` inputs.

### Context

The current builder takes the union of columns across all rows. Once one row
provides an increment column, another row's generated sentinel is serialized as
a real value. Nested write lowering contains parallel logic and must use the
same canonical row-shape rule.

### Units of Work

#### 3.1 — Compute effective columns per row

- Define a generated/default omission predicate from scalar state.
- Produce each row's effective column set after validation but before SQL
  serialization.
- Make sentinel persistence impossible by construction.

Suggested commit: `fix: preserve createMany row defaults`.

#### 3.2 — Group compatible insert rows

- Group rows by identical effective column set while retaining original input
  indexes.
- Emit one insert per group unless an adapter explicitly supports per-cell
  `DEFAULT` safely.
- Reassemble count and returning results in the public contract's required
  order.

Suggested commit: `fix: group heterogeneous bulk inserts`.

#### 3.3 — Reuse the canonical planner in nested writes

- Remove the duplicate row-column union logic from nested effect lowering.
- Route top-level and nested bulk inserts through the same effective-row-shape
  implementation.
- Reject before parent mutation if a driver's atomic mode cannot express all
  required grouped statements.

Suggested commit: `refactor: share bulk insert row planning`.

### Affected Files

- `src/query-engine/builders/values-builder.ts`
- `src/query-engine/builders/generated-scalar.ts`
- `src/query-engine/operations/nested-writes/effect-lowering.ts`
- nested planned/live execution files only where multiple insert groups must be
  scheduled
- `tests/drivers/many-and-return-behavior.ts`
- `tests/query-engine/nested-create-many.test.ts`

### Acceptance Criteria

- Missing generated increment values use database generation, never `0`/`0n`.
- Explicit values remain explicit.
- Application defaults and database defaults retain their distinct semantics.
- Returned rows/counts correspond to input rows despite grouping.
- Nested and top-level `createMany` share one row-shape implementation.
- Atomic-only modes reject unsupported grouping before user data changes.

### Expected Tests

- Mixed explicit/generated integer and bigint primary keys.
- Mixed optional database defaults.
- Multiple row-shape groups with `createManyAndReturn`.
- Nested create-many rollback and ordering tests.

### Verification Commands

```bash
pnpm vitest run tests/drivers/pglite.test.ts tests/drivers/sqlite3.test.ts tests/drivers/libsql.test.ts -t "createManyAndReturn / updateManyAndReturn"
pnpm vitest run tests/client/many-and-return-types.test.ts
pnpm vitest run tests/query-engine/nested-create-many.test.ts tests/query-engine/nested-mutation-routing.test.ts
pnpm test:drivers:local
pnpm type-check
git diff --check
```

## Phase 4: SQLite-Family Statement Execution

### Goal

Remove text-based statement misclassification.

### Context

SQLite3, Bun SQLite, and D1 decide whether a statement returns rows by searching
the full SQL text for `RETURNING`.

### Units of Work

#### 4.1 — Provider-owned SQLite3 classification

- Use better-sqlite3 statement metadata such as `reader` after preparation.
- Select `.all()` or `.run()` from provider metadata, not SQL text.
- Preserve changes and last-insert metadata for non-reader statements.

Suggested commit: `fix: classify sqlite3 statements by metadata`.

#### 4.2 — Bun SQLite and D1 classification

- Verify the installed provider APIs before choosing the classification
  mechanism.
- Prefer provider metadata or a unified execution result that exposes both rows
  and mutation metadata.
- If a provider cannot classify a shape safely, require an explicit internal
  statement intent from the query engine rather than parsing SQL text.

Suggested commits:

- `fix: classify bun sqlite statements safely`
- `fix: classify d1 statements safely`

### Affected Files

- `src/drivers/sqlite3/index.ts`
- `src/drivers/bun-sqlite/index.ts`
- `src/drivers/d1/index.ts`
- shared SQLite statement-intent types if provider metadata is insufficient
- `tests/drivers/sqlite3.test.ts`
- Bun SQLite and D1 driver tests/fixtures

### Acceptance Criteria

- Identifiers, comments, and literals containing `returning` do not affect
  execution mode.
- Genuine result-producing statements return rows; mutations preserve changes
  and generated-ID metadata.
- CTE, PRAGMA, EXPLAIN, and raw-query cases are explicitly covered.

### Expected Tests

- Provider-level statement matrix.
- Public migration/create/insert regression using `returning_events`.

### Verification Commands

```bash
pnpm vitest run tests/drivers/sqlite3.test.ts
pnpm test:sqlite
pnpm type-check
git diff --check
```

## Phase 5: Worker-Safe Binary Values

### Goal

Make D1 and other Worker-facing paths function without a Node `Buffer` global.

### Context

The shared SQLite converter currently conflates Node provider requirements with
Worker provider requirements. Result parsing also uses `Buffer` for binary/base64
decoding.

### Units of Work

#### 5.1 — Split provider parameter conversion

- Define the binary types each provider accepts from its installed API.
- Preserve `Uint8Array`/`ArrayBuffer` for D1 and HTTP/Worker paths.
- Import `node:buffer` only in Node-only driver modules that require a `Buffer`.
- Remove global `Buffer` reads from shared Worker-reachable modules.

Suggested commit: `fix: keep d1 binary parameters worker safe`.

#### 5.2 — Portable result decoding

- Move binary decoding behind an environment-neutral helper or adapter/driver
  result normalizer.
- Support `ArrayBuffer`, typed arrays, and provider base64 representations.
- Throw on an unsupported binary representation instead of returning it
  unchanged as a plausible scalar.

Suggested commit: `fix: decode binary results portably`.

#### 5.3 — Align driver documentation

- State whether any Node compatibility flag is required.
- Keep D1's default path free of `nodejs_compat` if the implementation no
  longer needs it.

Suggested commit: `docs: clarify d1 binary runtime support`.

### Affected Files

- `src/drivers/shared/sqlite-utils.ts`
- `src/drivers/d1/index.ts`
- `src/drivers/sqlite3/index.ts`
- `src/drivers/bun-sqlite/index.ts`
- `src/drivers/libsql/index.ts`
- `src/query-engine/result/result-parser.ts`
- `docs/content/docs/drivers/d1.mdx`
- relevant D1, SQLite, and result-parser tests

### Acceptance Criteria

- D1 blob create/read/update works with no global `Buffer`.
- Node SQLite providers continue receiving their required binary type.
- Binary round trips preserve byte equality and empty values.
- Unsupported provider representations throw with provider context.

### Expected Tests

- Worker-like fake binding with `Buffer` removed.
- Byte round trips for empty, small, and non-UTF-8 payloads.
- Node provider regression verifying `Buffer` conversion remains local.

### Verification Commands

```bash
pnpm vitest run tests/drivers/sqlite3.test.ts tests/query-engine/vector-distance-result-parser.test.ts
pnpm test:drivers:local
pnpm package:build
pnpm type-check
git diff --check
```

## Phase 6: Result Parsing by Identity and Strict Provider Contracts

### Goal

Parse each result with the correct model/relation schema and reject malformed
provider output.

### Context

Relation parser chains are cached by relation name, which is not globally
unique. Generic and provider-specific paths also return empty result shapes for
unknown or missing payloads.

### Units of Work

#### 6.1 — Key relation parser cache by identity

- Replace the string-keyed relation cache with a `WeakMap` keyed by relation
  identity, or a model-identity + relation-name key if weak identity cannot be
  used in the current context type.
- Ensure nested parsers share caches without sharing entries across unrelated
  relations.
- Keep cache lifetime request-scoped.

Suggested commit: `fix: key relation parsers by identity`.

#### 6.2 — Define strict provider result contracts

- Document the normalized result shape required from every driver operation.
- Validate Neon HTTP and D1 binding successful payloads before returning them.
- Include operation and provider in malformed-result errors, but no private
  parameter values.

Suggested commit: `fix: validate http driver results`.

#### 6.3 — Remove generic/planned-mode plausible defaults

- Replace missing-result fallbacks in result parsing and planned mode with
  explicit cardinality/result-shape errors.
- Distinguish a valid zero-row result from an absent statement result.
- Verify batch statement count and result count match before parsing.

Suggested commit: `fix: reject missing query results`.

### Affected Files

- `src/query-engine/result/result-parser.ts`
- `src/query-engine/types.ts`
- `src/query-engine/operations/nested-writes/planned-mode.ts`
- `src/drivers/neon-http/index.ts`
- shared normalized driver result types
- focused parser, HTTP driver, and nested planned-mode tests

### Acceptance Criteria

- Same-named relations at different graph positions parse with their own target
  scalar definitions.
- Valid empty queries remain valid.
- Missing, truncated, or structurally unknown results throw.
- Planned batches verify one result per expected statement/result slot.
- No fallback manufactures `[]`, `0`, `null`, or `{}` for an unknown shape.

### Expected Tests

- Repeated relation-name graph with differing date, bigint, JSON, and blob
  scalars.
- Malformed provider payload matrix.
- Batch result cardinality mismatch tests.

### Verification Commands

```bash
pnpm vitest run tests/query-engine/vector-distance-result-parser.test.ts
pnpm vitest run tests/query-engine/nested-mutation-routing.test.ts
pnpm test:drivers:local
pnpm type-check
git diff --check
```

## Phase 7: Privacy-Safe Errors and Operation-Scoped Driver Context

### Goal

Prevent private query material and concurrent operation metadata from crossing
their intended boundaries.

### Context

Driver error normalization always retains SQL and parameters, while error JSON
serializes all metadata. Instrumentation flags therefore do not protect callers
that log the error directly. Separately, `currentContext` is mutable state on a
shared driver instance.

### Units of Work

#### 7.1 — Define one redaction policy

- Make SQL and parameter inclusion explicit, opt-in, and independently
  configurable.
- Default error metadata to operation/provider codes without raw SQL values.
- Recursively sanitize nested errors and logger event payloads.
- Preserve enough structured metadata for diagnosis without value disclosure.

Suggested commit: `fix: redact query error metadata by default`.

#### 7.2 — Remove shared mutable execution context

- Pass operation context through the execution call path explicitly.
- If a runtime-specific scoped store is introduced, keep explicit context as
  the portable contract and scoped storage as an implementation detail.
- Make transaction-bound and base drivers follow the same context path.

Suggested commit: `fix: scope driver context per execution`.

#### 7.3 — Verify concurrent attribution

- Use controlled promises to overlap successful and failing operations.
- Assert model, operation, correlation ID, duration, and error metadata remain
  attached to the originating call.

Suggested commit: `test: verify concurrent driver attribution`.

### Affected Files

- `src/drivers/error-mapping.ts`
- `src/drivers/driver.ts`
- `src/query-engine/executor.ts`
- `src/errors/base.ts`
- `src/instrumentation/logger.ts`
- instrumentation/tracing context types
- `tests/drivers/error-mapping.test.ts`
- `tests/instrumentation/logger.test.ts`
- `tests/instrumentation/context-spans.test.ts`
- `tests/instrumentation/driver-wiring.test.ts`

### Acceptance Criteria

- Default `toJSON()` contains no raw SQL or parameters.
- Explicit diagnostics options include only the requested fields.
- Nested causes are sanitized recursively.
- Concurrent operations retain correct attribution with no shared mutable
  request state.
- Error redaction does not remove stable provider/error codes needed by retry
  logic.

### Expected Tests

- Secret-like insert value causing a unique violation.
- Custom logger receiving both raw error and serialized error.
- Overlapping driver operations and nested transactions.

### Verification Commands

```bash
pnpm vitest run tests/drivers/error-mapping.test.ts
pnpm vitest run tests/instrumentation/logger.test.ts tests/instrumentation/context-spans.test.ts tests/instrumentation/driver-wiring.test.ts
pnpm type-check
git diff --check
```

## Phase 8: Transaction Cleanup and Option Semantics

### Goal

Make cleanup deterministic, preserve original failures, and enforce one
transaction-option contract before dispatching to any database.

### Context

Several drivers duplicate rollback logic. Cleanup can replace the callback
error, and some nested savepoint paths do not release after `ROLLBACK TO`.
Nested transaction options are accepted but ignored.

### Units of Work

#### 8.1 — Canonical savepoint lifecycle

- Centralize savepoint create, release, rollback-to, and post-rollback release.
- Preserve the callback error as primary.
- Attach rollback/release failures through `cause`, `AggregateError`, or one
  repository-wide structured cleanup-error form.
- Close transaction-bound drivers after either success or failure.

Suggested commit: `fix: preserve transaction failures during cleanup`.

#### 8.2 — Adopt the lifecycle in every driver

- Replace provider copies in PostgreSQL, MySQL, SQLite3, Bun SQLite, LibSQL, and
  shared transaction helpers.
- Retain provider-specific SQL only in the provider boundary.
- Verify no savepoint remains live after recovery.

Suggested commit: `refactor: share savepoint lifecycle`.

#### 8.3 — Enforce portable nested option semantics

- Inventory timeout, isolation, access mode, and provider-specific options.
- Define the portable subset at the client boundary.
- Implement every accepted portable option across every advertised driver.
- Reject options outside that subset uniformly before provider selection and
  before creating a savepoint.
- Keep provider-native options behind explicit native escape hatches.
- Remove underscore-prefixed accepted-but-unused option parameters.

Suggested commit: `fix: enforce portable nested transaction options`.

### Affected Files

- `src/drivers/shared/transactions.ts`
- `src/drivers/driver.ts`
- PostgreSQL, MySQL2, SQLite3, Bun SQLite, and LibSQL driver transaction modules
- `tests/drivers/savepoint-queue.test.ts`
- `tests/client/batch-transaction.test.ts`
- provider transaction tests

### Acceptance Criteria

- Callback failure remains the primary error if rollback or release also fails.
- Cleanup failure is still observable.
- Rolled-back savepoints are released when required by the provider.
- Inputs outside the portable option contract reject before user callback
  execution on every database.
- Every accepted timeout/isolation behavior passes the same shared conformance
  assertions on every advertised driver.

### Expected Tests

- Callback failure + rollback failure.
- Callback failure + rollback success + release failure.
- Nested success/failure queues on one connection.
- Isolation option matrix by provider and nesting depth.

### Verification Commands

```bash
pnpm vitest run tests/drivers/savepoint-queue.test.ts tests/client/batch-transaction.test.ts
pnpm test:drivers:local
pnpm test:mysql
pnpm test:pg
pnpm type-check
git diff --check
```

## Phase 9: Atomic Non-`RETURNING` Mutations

### Goal

Make create, update, delete, and upsert result emulation atomic on drivers that
cannot return mutation rows directly.

### Context

The current flow performs selection, mutation, and optional refetch as separate
operations. Correct transaction cleanup and option rejection from Phase 8 are
prerequisites. The query engine already has a `forUpdate` mechanism, but this
flow does not use it.

### Units of Work

#### 9.1 — Define mutation identity capture

- Resolve and lock the target row inside one transaction for update/delete.
- Capture its complete primary key before mutation.
- Apply mutation and refetch by captured key, not by a reusable non-primary
  unique selector.
- Define behavior when the primary key itself changes.

Suggested commit: `fix: lock non-returning mutation targets`.

#### 9.2 — Transaction-scope update and delete emulation

- Route prefetch, write, affected-row verification, and refetch through one
  transaction-bound driver.
- Use adapter-owned lock syntax.
- Preserve not-found and uniqueness error contracts.

Suggested commit: `fix: make non-returning updates atomic`.

#### 9.3 — Transaction-scope create and upsert refetch

- Keep provider `insertId` capture and refetch on the same connection and
  transaction.
- For upsert, identify which branch ran without relying on a racy post-write
  lookup.
- Reject any shape whose final row identity cannot be determined atomically.

Suggested commit: `fix: make non-returning create refetch atomic`.

#### 9.4 — Concurrency conformance

- Add two-connection tests for replacement-row delete races, competing updates,
  and insert/upsert refetch.
- Assert returned data corresponds to the mutation performed by that operation.

Suggested commit: `test: verify non-returning mutation isolation`.

### Affected Files

- `src/query-engine/result-flow.ts`
- `src/query-engine/executor.ts`
- `src/query-engine/operations/mutation-returns.ts`
- query-engine transaction flow
- adapter locking/capability interfaces
- MySQL and PlanetScale-style drivers
- `tests/query-engine/non-returning-mutation-returns.test.ts`
- `tests/drivers/mysql2.test.ts`

### Acceptance Criteria

- No non-`RETURNING` read/write/refetch sequence escapes its transaction.
- A concurrent replacement row cannot be mutated through a stale unique
  selector.
- Returned row data belongs to the current operation's committed mutation.
- A refetch failure cannot leave an unreported committed write.
- Every advertised driver meets the atomic contract. An inability to do so
  fails that driver's interoperability gate and blocks release; it is not a
  documented provider exception.

### Expected Tests

- Deterministically interleaved update/delete/create/upsert cases.
- Primary-key-changing update.
- Rollback after post-write parse/refetch failure.
- Pool with multiple connections to prove connection affinity.

### Verification Commands

```bash
pnpm vitest run tests/query-engine/non-returning-mutation-returns.test.ts
pnpm test:mysql
pnpm test:drivers:local
pnpm type-check
git diff --check
```

## Phase 10: Cross-Database Mutation Parity

### Goal

Make MySQL implement the same public upsert and duplicate-skipping semantics as
PostgreSQL and SQLite-family databases.

### Context

MySQL's native primitives are broader than the VibORM contract: upserts react to
any unique collision, while `INSERT IGNORE` can suppress failures unrelated to
duplicates. The adapter must compensate for those differences rather than
expose them through the portable API.

### Units of Work

#### 10.1 — Emulate target-specific upsert semantics

- Define the target-specific behavior once in the shared mutation contract.
- Implement an adapter-owned MySQL strategy using the required transaction,
  locking, precondition, or guarded-update mechanics.
- Prove that a collision on another unique constraint does not execute the
  requested target's update branch.
- Preserve one atomic externally visible operation.

Suggested commit: `fix: preserve upsert target semantics on mysql`.

#### 10.2 — Narrow skip-duplicate behavior

- Implement duplicate skipping without suppressing not-null, foreign-key,
  truncation, conversion, or unrelated integrity failures.
- Use a narrower statement or explicit adapter-owned emulation.
- Preserve the same result count and generated/default value behavior as the
  shared PostgreSQL and SQLite-family contract.

Suggested commit: `fix: narrow mysql skip duplicate behavior`.

#### 10.3 — Make the shared conformance matrix the support gate

- Run identical upsert, duplicate-skipping, error, count, and result assertions
  against PostgreSQL, MySQL, and SQLite-family drivers.
- Permit provider-specific fixtures and setup, but no provider-specific expected
  behavior inside the portable suite.
- Publish implementation notes only after every shared assertion passes.

Suggested commit: `test: enforce cross-database mutation parity`.

### Affected Files

- `src/adapters/databases/mysql/mysql-adapter.ts`
- MySQL operation validation/capability checks
- `tests/drivers/mysql2.test.ts`
- `tests/drivers/many-and-return-behavior.ts`
- shared upsert/create-many documentation

### Acceptance Criteria

- Target-specific upsert behavior is observably identical across supported
  databases.
- Duplicate skipping ignores only duplicate conflicts and surfaces unrelated
  failures everywhere.
- The same portable inputs, result counts, and errors pass one shared suite.
- MySQL support remains blocked until those assertions pass.

### Expected Tests

- Collision on requested unique target.
- Collision on a different unique constraint.
- not-null, foreign-key, truncation, and duplicate-key cases under skip mode.

### Verification Commands

```bash
pnpm test:mysql
pnpm vitest run tests/drivers/many-and-return-behavior.ts
pnpm type-check
git diff --check
```

## Phase 11: Post-Correctness Decomposition

### Goal

Split correctness hotspots into one-concept modules while preserving the now
locked behavior.

### Context

The post-correctness audit baseline contains exactly thirteen oversized
hotspots. Later correctness work increased several line counts before this
phase began; the inventory is by source responsibility, not by a frozen line
estimate:

1. `operations/nested-writes/interpret-update-family.ts`;
2. `operations/nested-writes/interpret-m2m.ts`;
3. `result/result-parser.ts`;
4. `drivers/driver.ts`;
5. `operations/nested-writes/planned-mode.ts`;
6. `executor.ts`;
7. `builders/where-builder.ts`;
8. `adapters/database-adapter.ts`;
9. `builders/relation-data-builder.ts`;
10. `operations/nested-writes/interpret-create-family.ts`;
11. `builders/include-builder.ts`;
12. `operations/groupby.ts`;
13. `drivers/error-mapping.ts`.

The resulting named modules are part of the Phase 11 inventory:

- result parsing: `result-parser-chain.ts`, `result-row-parser.ts`,
  `result-shape.ts`, `result-aggregate-parser.ts`, `result-count-parser.ts`,
  `relation-result-parser.ts`, and the scalar parser modules;
- driver execution: `driver-instrumentation.ts`,
  `driver-transaction-base.ts`, `driver-batch-preparation.ts`,
  `driver-error-context.ts`, and `driver-diagnostics.ts`;
- nested writes: `interpret-update-relations.ts`,
  `interpret-connected-update.ts`, `interpret-relation-removals.ts`,
  `update-identity.ts`, the three `interpret-m2m-*.ts` concern modules,
  `create-identity.ts`, `planned-state.ts`, `planned-abort.ts`, and
  `planned-sql.ts`;
- query construction: `operation-builder.ts`, `operation-preparation.ts`,
  `json-filter-builder.ts`, `scalar-filter-operators.ts`,
  `relation-mutation-parser.ts`, the `include-*.ts` modules, and the
  `groupby-*.ts` modules;
- adapter contracts: `adapter-capabilities.ts`, `adapter-core-types.ts`,
  `adapter-query-parts.ts`, and `adapter-result-parser.ts`.

Decomposition begins only after Phases 1–10 pass, so moves can be checked
against stable behavior rather than changing architecture and semantics at once.

### Units of Work

#### 11.1 — Split result parsing by result concept

- Separate scalar decoding, relation parsing, aggregate parsing, and mutation
  result/cardinality validation.
- Keep one request-scoped parser context as the composition root.

Suggested commit: `refactor: split result parsing concerns`.

#### 11.2 — Split driver base by execution concern

- Separate transaction-bound execution, instrumentation, error normalization,
  and provider result normalization.
- Parent driver orchestrates; child modules execute one concern.

Suggested commit: `refactor: decompose driver execution`.

#### 11.3 — Split nested interpreters by operation family

- Separate create, update, connect/disconnect, set, and many-to-many lowering
  only where exports are consumed independently.
- Preserve one interpreter composition root and one shared effect vocabulary.

Suggested commit: `refactor: split nested write interpreters`.

#### 11.4 — Split builders and adapter surface by concept

- Extract predicate, relation-data, include, pagination, and mutation-return
  concepts into named modules.
- Split the database adapter interface into cohesive namespaces without
  introducing single-implementation ceremony types.

Suggested commit: `refactor: decompose query builder boundaries`.

#### 11.5 — Delete duplication after the second consumer is proven

- Consolidate provider transaction cleanup and statement-result normalization.
- Delete obsolete compatibility branches and dead helpers revealed by the
  split.
- Do not create `utils.ts`, `helpers.ts`, or speculative extension points.

Suggested commit: `refactor: remove duplicated driver mechanics`.

### Affected Files

- the oversized files listed above
- their focused sibling modules and local `index.ts` public surfaces
- architecture maps if module ownership changes materially
- no public package exports unless required by an existing public symbol

### Acceptance Criteria

- No scoped source file exceeds 600 lines; 300 lines remains the target.
- Each file has one primary concept and no unrelated exports.
- No source behavior or public API changes in decomposition commits.
- Existing regression and conformance suites pass unchanged.
- Duplicate transaction, parsing, and statement mechanics have one owner.

### Expected Tests

- No new semantic tests are required solely for moves.
- All tests from Phases 0–10 remain the oracle.
- Import/public-export tests cover moved symbols where relevant.

### Verification Commands

```bash
pnpm test:gates
pnpm test:drivers:local
pnpm test:types
pnpm package:build
pnpm type-check
find src/query-engine src/adapters src/drivers src/sql -name '*.ts' -print0 | xargs -0 wc -l | sort -nr | head -30
git diff --check
```

## Final Definition of Done

This remediation is complete only when all of the following are true:

- Same-object relation operators are all enforced for reads and bulk mutations.
- Empty `every` obeys vacuous truth.
- Cursor pagination is total, null-aware, and symmetric in both directions.
- Heterogeneous bulk inserts preserve each row's generated/default semantics.
- SQLite-family drivers no longer inspect incidental SQL text to determine
  execution mode.
- D1 binary operations work without Node globals.
- Every non-`RETURNING` mutation result flow is atomic on every advertised
  driver.
- Nested relation parsing caches by semantic identity.
- Errors and logs omit SQL and parameters by default, recursively.
- Concurrent operations on one driver cannot share attribution context.
- Malformed provider and planned-batch results throw explicit errors.
- Transaction cleanup preserves original failures and closes savepoints.
- Accepted transaction options behave identically across drivers; options
  outside the portable subset reject uniformly before provider selection.
- Upsert conflict targeting and duplicate skipping have the same observable
  behavior on PostgreSQL, MySQL, and SQLite-family databases.
- Every portable behavior passes one shared conformance suite without
  provider-specific expected results.
- Post-correctness decomposition brings every scoped file below the 600-line
  hard limit without semantic drift.
- `pnpm test:gates`, local driver tests, MySQL/PostgreSQL integration suites,
  package build, and full type checking pass.

Final verification:

```bash
pnpm test:gates
pnpm test:drivers:local
pnpm test:mysql
pnpm test:pg
pnpm test:types
pnpm package:build
pnpm type-check
git diff --check
```

## Explicit Non-Goals

- Adding new query operators, relation features, pagination modes, or public
  mutation APIs.
- Changing validation semantics beyond defining one database-independent
  portable contract.
- Adding a non-atomic fallback for drivers without a safe transaction/batch
  mechanism.
- Replacing provider libraries or changing deployment targets.
- Broad performance rewrites unrelated to the identified cursor subquery
  repetition.
- Schema migrations, destructive database operations, or persistent internal
  tables.
- Exposing dialect limitations through the portable schema or client API;
  database-native behavior belongs only in explicit native escape hatches.
- Introducing speculative abstractions, plugin systems, generic utility files,
  or public exports solely to facilitate decomposition.
- Mixing source decomposition into correctness commits.
