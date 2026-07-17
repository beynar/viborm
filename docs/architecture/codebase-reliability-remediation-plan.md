# Codebase Reliability Remediation Plan

Status: proposed

Audit baseline: 2026-07-09

Companion plan: [Query Engine Correctness Remediation Plan](./query-engine-correctness-remediation-plan.md)

## Purpose

Turn the non-query-engine findings from the July 2026 codebase audit into an
implementation sequence that can be executed as small, reviewable changes.

This plan covers:

- migration generation, push, apply, rollback, status, and squash;
- CLI safety;
- schema definition and validation behavior;
- JSON Schema export;
- cache consistency and cache drivers;
- instrumentation behavior and privacy;
- Worker/runtime compatibility outside query execution;
- package exports, declarations, documentation, and release gates;
- structural cleanup outside the query-engine-owned modules.

The objective is not to add features. It is to make existing promises true,
especially promises around dry-run safety, migration state, validation
equivalence, committed mutation semantics, cache coherence, and supported
runtimes.

## Cross-Database Interoperability Contract

Cross-database interoperability is a release invariant, not an aspirational
documentation claim.

The same VibORM schema, migration intent, validation input, client operation,
and cache-visible result must have the same observable semantics on every
advertised PostgreSQL, MySQL, and SQLite-family driver. Database-specific SQL
and provider capabilities must be absorbed inside adapters, drivers, and
migration execution strategies.

The acceptable implementation choices are:

1. use the provider's native capability;
2. emulate the portable contract safely with transactions, batches, locking,
   compensation, or resumable state;
3. keep database-native behavior behind an explicit native escape hatch outside
   the portable contract.

Documenting a provider limitation or rejecting a portable operation only on one
database does not satisfy interoperability. If a driver cannot pass the shared
conformance contract, it is not releasable as a supported driver.

Performance and generated SQL may differ. Accepted inputs, state transitions,
result meaning, failure semantics, and recovery guarantees may not.

## Ownership Boundary

This document and its companion deliberately split ownership by execution
boundary.

| This plan owns | Companion query-engine plan owns |
| --- | --- |
| CLI migration workflow and safety | Query construction and result flow |
| Migration storage, state, locking, apply, down, squash | SQL builders and adapter behavior |
| Validation primitives and operation schemas | Driver execution and provider result protocols |
| Schema definition invariants and hydration | Cursor, relation-filter, createMany, and mutation semantics |
| Cache lifecycle and invalidation policy | Driver-side D1/blob conversion and result parsing |
| Logging, tracing, and public privacy policy | Error normalization and raw query/parameter metadata |
| Packaging, declarations, docs, CI, and release checks | Query/adapter/driver module decomposition |

Two findings cross the boundary:

1. Worker blob support: this plan owns validation and package/runtime policy;
   the companion plan owns driver binding and result decoding.
2. Error privacy: this plan owns the public redaction contract and safe
   observability serialization; the companion plan owns removing raw SQL and
   parameters from normalized driver errors.

Neither cross-boundary item is complete until both units pass their shared
acceptance test.

## Current Failure Context

The audit found two release-blocking migration defects:

- force-reset dry-run can execute destructive SQL before the dry-run barrier;
- interactive push can display one resolved plan and execute a newly planned,
  more destructive plan.

It also confirmed broader integrity failures:

- migration files are not checked against their recorded checksum;
- apply has no effective cross-process lock;
- status converts arbitrary database errors into an empty applied set;
- down can untrack a migration without reversing it;
- squash can fabricate applied state and break index-derived filenames;
- D1 and Neon file migration apply selects an unsupported transaction mode;
- defaults, scalar modifiers, relation definitions, vectors, aggregate filters,
  and JSON Schema exports can disagree with runtime behavior;
- cache writes and invalidations can race database commits and each other;
- instrumentation can throw before or after a valid bigint mutation;
- Worker-facing validation assumes Node Buffer;
- supported Node versions cannot load the documented TypeScript config;
- public examples and packed declarations do not match the package surface;
- local quality gates pass selectively, but there is no tracked CI workflow.

## Non-Negotiable Contracts

1. Dry-run executes zero mutating statements.
2. Approval applies the exact plan that was displayed.
3. Migration state is derived from real files and real database state; errors
   are never converted into plausible pending/applied data.
4. A reported rollback has executed a real reverse operation.
5. Every advertised migration driver satisfies the same portable execution and
   recovery contract. Fail-closed rejection is only an interim containment
   measure, not the completed cross-database implementation.
6. Runtime validation, inferred types, operation schemas, and exported JSON
   Schema describe the same accepted values.
7. Definition-time schema validation rejects configurations that cannot be
   serialized or queried correctly.
8. A database commit is never reported as a database failure because cache or
   observability work failed afterward.
9. Cache entries cannot cross database, environment, or tenant namespaces.
10. Worker-supported paths do not require undeclared Node compatibility.
11. Documentation examples compile against the packed package.
12. Every failure introduced for verification must fail before its fix and pass
    after it; no test may be weakened to accommodate current behavior.

## Delivery Rules

Each unit of work below is intended to be one logical commit unless the unit
explicitly says it has a shared gate.

For every unit:

- add the smallest regression test that demonstrates the contract;
- change only the owning layer;
- propagate errors rather than substituting defaults;
- preserve public APIs unless the unit explicitly introduces a fail-closed
  validation error;
- run the focused suite, type-check, and git diff --check;
- update public documentation only after runtime behavior is true.

Do not combine structural decomposition with correctness changes. First lock the
behavior with tests, then move code in a later unit.

## Phase Sequence

| Phase | Theme | Dependency |
| --- | --- | --- |
| 0 | Contain destructive CLI behavior | Immediate release blocker |
| 1 | Make migration state trustworthy | Phase 0 |
| 2 | Make migration execution cross-database and capability-aware | Phase 1 |
| 3 | Repair validation primitive safety and type contracts | Can start after Phase 0 |
| 4 | Repair scalar, model, and relation invariants | Phase 3 foundations |
| 5 | Rebuild or explicitly limit JSON Schema export | Phases 3-4 |
| 6 | Define and implement cache consistency | Can start after Phase 0 |
| 7 | Make instrumentation non-interfering and private | Coordinate with companion plan |
| 8 | Align runtimes, package output, and public documentation | Behavior phases sufficiently stable |
| 9 | Enforce CI and reduce structural risk | Start gates early; decompose last |

Phases 1-2 are sequential. Phases 3-5 are sequential. Phase 6 can proceed in
parallel with those tracks. Phase 7 has one shared gate with the companion plan.

## Phase 0: Destructive CLI Containment

### Goal

Make every preview and dry-run command mechanically incapable of performing a
write, and ensure an approval applies the reviewed plan.

### Context

The current push command interleaves confirmation, reset execution, planning,
display, and replanning. The dry-run check is too late, and the second planner
invocation discards interactive resolutions.

### Unit R0.1: Absolute dry-run write barrier

Outcome: no branch reachable under dry-run can execute SQL, write migration
state, or invoke reset execution.

Work:

- Separate reset planning from reset execution.
- Resolve dry-run at the workflow boundary before any executor is created.
- Make the executor reject execution when its plan is marked preview-only.
- Record attempted statements in CLI tests and assert the list remains empty.

Primary files:

- src/cli/commands/push.ts
- src/migrations/push/reset.ts
- src/migrations/push/index.ts
- tests/cli/push.test.ts

Acceptance:

- force-reset plus dry-run displays the destructive plan but leaves tables and
  migration metadata unchanged.
- Every confirmation response, including yes, still performs zero writes.

### Unit R0.2: Immutable approved push plan

Outcome: execution consumes the exact operations and resolutions shown during
preview.

Work:

- Introduce one immutable planned-push value containing operations, resolutions,
  and a source-schema fingerprint.
- Remove the post-confirmation forced replanning call.
- Execute the captured plan directly.
- Re-read the fingerprint immediately before execution and abort on drift.

Primary files:

- src/cli/commands/push.ts
- src/migrations/push/planner.ts
- src/migrations/push/executor.ts
- tests/cli/push.test.ts
- tests/migrations/resolver.test.ts

Acceptance:

- A rename approved in preview executes as that rename.
- Add/drop fallback cannot replace an approved resolution.
- Schema drift between preview and execution produces a clear no-write error.

### Unit R0.3: Validate destructive numeric options and preview bounds

Outcome: invalid CLI bounds cannot broaden an operation to all migrations.

Work:

- Parse --to, --steps, and --count through one positive-integer validator.
- Reject NaN, infinity, zero, negative values, fractions, and trailing junk.
- Apply --to before displaying the apply preview so preview and execution have
  identical scope.

Primary files:

- src/cli/commands/migrate.ts
- src/cli/command-factory.ts
- tests/cli/migrate.test.ts

Acceptance:

- Malformed values exit before storage or database access.
- The previewed migration list equals the executed migration list.

### Phase 0 gate

    pnpm vitest run tests/cli/push.test.ts tests/cli/migrate.test.ts tests/migrations/resolver.test.ts
    pnpm type-check
    git diff --check

No migration correctness work proceeds to release until this phase is complete.

## Phase 1: Trustworthy Migration State

### Goal

Make files, journal entries, and database tracking records form one verifiable
state machine.

### Context

Current checksums do not cover the executable migration file, migration identity
depends on a non-unique display name, apply reads pending state outside a lock,
and generation writes multiple state files independently.

### Unit R1.1: Canonical executable checksum

Outcome: any edit to executable up or down content is detected.

Work:

- Define one canonical byte representation for checksum input.
- Calculate checksums only after final migration content exists.
- Recalculate from storage immediately before apply, down, reset, status, and
  integrity reporting.
- Compare file, journal, and database checksums and identify which side differs.

Primary files:

- src/migrations/generate/index.ts
- src/migrations/apply/index.ts
- src/migrations/apply/down.ts
- src/migrations/storage/driver.ts
- tests/migrations/apply.test.ts
- tests/migrations/storage.test.ts

Acceptance:

- Editing a pending migration fails before SQL execution.
- Editing an applied migration is reported as integrity drift.
- Formatting and line-ending policy is deterministic and documented.

### Unit R1.2: One effective migration lock protocol

Outcome: only one process can read pending state and apply it at a time.

Work:

- Hold the lock across state read, checksum verification, SQL execution, and
  tracking insertion.
- Make lock acquisition return an explicit acquired result.
- For MySQL, inspect GET_LOCK result and pin acquire/use/release to one
  connection.
- Preserve the original operation error if release also fails.

Primary files:

- src/migrations/context.ts
- src/migrations/apply/index.ts
- src/migrations/drivers/mysql/index.ts
- migration driver lock implementations
- tests/migrations/apply.test.ts
- tests/migrations/ddl-drivers.test.ts

Acceptance:

- A second concurrent apply fails or waits without executing migration SQL.
- MySQL 0 and NULL lock results are rejected.
- Lock release occurs on success and failure.

### Unit R1.3: Fail-closed state reads and immutable migration identity

Outcome: storage/database failures surface, and two migrations cannot collapse
onto one identity.

Work:

- Remove catch-all substitution from applied-state reads.
- Recognize only an explicit missing-tracking-table condition where necessary.
- Add an immutable migration ID independent from the display name.
- Reject duplicate IDs and duplicate sanitized names during generation and
  journal loading.
- Use the immutable ID for applied-state comparison.

Primary files:

- src/migrations/apply/index.ts
- src/migrations/generate/index.ts
- src/migrations/types.ts
- src/migrations/storage/driver.ts
- tests/migrations/apply.test.ts
- tests/migrations/storage.test.ts

Acceptance:

- Connection and permission failures never appear as an empty applied set.
- Duplicate names fail before files are written.
- Renaming a display label does not change identity.

### Unit R1.4: Atomic migration artifact publication

Outcome: generation cannot leave a journal referring to missing or partial
files.

Work:

- Stage up SQL, down SQL, journal, and snapshot under temporary names.
- Validate all staged content and checksums.
- Publish using the strongest atomic rename/transaction primitive offered by
  the storage driver.
- Define cleanup behavior for interrupted publication.

Primary files:

- src/migrations/generate/index.ts
- src/migrations/storage/driver.ts
- filesystem and custom storage implementations
- tests/migrations/storage.test.ts

Acceptance:

- Injected failure at every publication step leaves either the old complete
  state or the new complete state.
- No journal entry points to an absent file.

### Phase 1 gate

    pnpm vitest run tests/migrations/apply.test.ts tests/migrations/storage.test.ts tests/migrations/ddl-drivers.test.ts
    pnpm type-check
    git diff --check

## Phase 2: Cross-Database Migration Execution

### Goal

Execute, reverse, squash, and report migrations under one observable contract
across every advertised driver, using provider-specific strategies internally.

### Unit R2.1: Satisfy one contract through real driver capabilities

Context: apply currently requires callback transactions even for advertised
batch-only drivers.

Work:

- Define the portable apply outcome, tracking, failure, and recovery contract
  independently from any provider API.
- Use callback transactions where they satisfy that contract.
- Use atomic DDL-plus-tracking batches where they satisfy that contract.
- For providers such as MySQL whose DDL can implicitly commit, implement the
  required compensation, resumable state machine, or equivalent strategy so a
  partial operation cannot masquerade as success or unrecoverable ambiguity.
- Keep fail-closed preflight rejection during implementation, but do not mark
  the unit complete until every advertised driver executes the portable
  contract.

Primary files:

- src/migrations/apply/index.ts
- src/migrations/context.ts
- src/migrations/drivers/base.ts
- D1 binding, Neon HTTP, and MySQL migration drivers
- tests/migrations/apply.test.ts
- tests/migrations/ddl-drivers.test.ts

Acceptance:

- D1/Neon-style drivers apply and track under the same observable contract as
  PostgreSQL and SQLite.
- MySQL interruption and implicit-commit cases recover to the same defined state
  transition as other drivers.
- No advertised driver finishes the phase with a provider-specific unsupported
  migration path.
- No driver is routed through an incompatible provider API.

### Unit R2.2: Honest reverse migrations

Context: absent down SQL currently permits untracking without schema reversal.

Work:

- Reject absent or empty down SQL by default.
- Keep untracking as a separate explicit repair operation, not implicit down.
- Verify down-file checksum before execution.
- Remove the tracking row only after the reverse operation succeeds.

Primary files:

- src/migrations/apply/down.ts
- src/migrations/storage/driver.ts
- tests/migrations/apply.test.ts

Acceptance:

- A reported rollback changes the schema and tracking state together.
- Missing down content leaves both unchanged.

### Unit R2.3: Safe squash state machine

Work:

- Permit squash only for an entirely applied range or an entirely pending
  range.
- Reject mixed ranges.
- Stop deriving file identity from mutable journal position, or atomically
  rename all affected files.
- Preserve checksums, IDs, applied state, and later migration readability.

Primary files:

- src/migrations/squash.ts
- src/migrations/storage/driver.ts
- tests/migrations/storage.test.ts
- add focused squash behavior tests under tests/migrations

Acceptance:

- Pending SQL is never marked applied.
- Every later migration remains readable after squash.
- Interrupted squash leaves the original set intact.

### Unit R2.4: Truthful preview and result reporting

Work:

- Make apply dry-run calculate applied and pending state normally.
- Return the real remaining pending set after bounded apply.
- Make direct generate options agree with runtime storage requirements.
- Ensure status, preview, result objects, and docs use one vocabulary.

Primary files:

- src/migrations/apply/index.ts
- src/migrations/generate/index.ts
- src/migrations/types.ts
- tests/migrations/apply.test.ts

Acceptance:

- Dry-run excludes already applied migrations.
- Applying through a bound reports the actual remaining migrations.
- Public option types describe every runtime requirement.

### Phase 2 gate

    pnpm vitest run tests/migrations
    pnpm type-check
    git diff --check

The same migration conformance suite must pass on external PostgreSQL, MySQL,
D1-compatible, and Neon-compatible environments before this phase is complete.

## Phase 3: Validation Primitive Safety

### Goal

Restore equivalence between primitive schema types, runtime parsing, transforms,
defaults, and JavaScript object safety.

### Unit R3.1: Validate and transform resolved defaults

Work:

- Type static and functional defaults against the schema input.
- Resolve the default, then send it through the normal validation and transform
  pipeline.
- Preserve correct error paths and avoid recursive default resolution.
- Cover scalar, array, nullable, optional, and transformed schemas.

Primary files:

- src/validation/primitives/helpers.ts
- src/validation/types.ts
- primitive schema implementations
- tests/validation/optional.test.ts
- tests/validation/transform.test.ts
- relevant scalar tests

Acceptance:

- Invalid defaults fail with the same issue as invalid supplied input.
- Output types and runtime values agree after transforms.

### Unit R3.2: Safe records and composable pipes

Work:

- Build record outputs with a null prototype or safe own-property definitions.
- Explicitly test __proto__, constructor, and prototype keys.
- Encode pipe action compatibility so every action input matches the previous
  output.
- Add negative compile-time cases and runtime transformation cases.

Primary files:

- src/validation/primitives/record.ts
- src/validation/primitives/pipe.ts
- tests/validation/record.test.ts
- tests/validation/pipe.test.ts

Acceptance:

- Parsed records cannot acquire attacker-controlled prototypes.
- Incompatible pipes fail at compile time.
- Inferred and runtime pipe outputs have the same type.

### Unit R3.3: Align object extension, lazy reflection, and ISO dates

Work:

- Make ObjectSchema.extend replace overridden keys rather than intersect them.
- Either implement the promised parse method and options or remove them from
  the public type.
- Make lazy schema reflection obey Proxy invariants.
- Validate calendar components rather than accepting JavaScript date rollover.

Primary files:

- src/validation/primitives/object.ts
- src/validation/primitives/lazy.ts
- src/validation/primitives/iso.ts
- tests/validation/object.test.ts
- tests/validation/circular.test.ts
- tests/validation/iso.test.ts

Acceptance:

- Runtime and type-level extend behavior match.
- Object.keys and descriptor inspection on lazy schemas do not throw.
- Impossible dates and timestamps are rejected.

### Phase 3 gate

    pnpm vitest run tests/validation
    pnpm type-check
    git diff --check

## Phase 4: Scalar, Model, and Relation Invariants

### Goal

Reject invalid definitions before migration or query layers see them, and make
every scalar modifier preserve its effective validator.

### Unit R4.1: Canonical scalar base reconstruction

Context: nullable and array modifiers on numeric and temporal scalars can drop
custom schemas.

Work:

- Introduce one scalar-local reconstruction path that preserves custom schema,
  nullable, array, default, and transform state.
- Replace repeated reconstruction in integer, float, decimal, bigint,
  datetime, and affected scalar classes.
- Add chain-order tests for schema before and after modifiers.

Primary files:

- src/schema/scalars
- src/validation/scalars
- tests/scalars
- tests/model/create/scalar-create.test.ts
- tests/model/update/scalar-update.test.ts
- tests/model/filter/scalar-filter.test.ts

Acceptance:

- The same invalid value is rejected in create, update, and filter schemas.
- Modifier order does not discard a custom schema.

### Unit R4.2: Enforce vector and enum definition invariants

Work:

- Require vector dimension to be a positive integer.
- Pass dimension into base, create, update, default, and operation validators.
- Require at least one unique enum member.
- Delete or implement the current no-op enum definition rule.

Primary files:

- src/schema/scalars/vector
- src/validation/scalars/vector.ts
- src/schema/validation/rules/database.ts
- src/validation/primitives/enum.ts
- tests/scalars/vector-scalar-schemas.test.ts
- tests/validation/vector.test.ts
- tests/validation/enum.test.ts

Acceptance:

- Dimension mismatch fails in every operation schema.
- Empty and duplicate enums fail at definition time.

### Unit R4.3: Complete model, relation, and foreign-key validation

Work:

- Require non-empty compound IDs, indexes, and unique definitions.
- Require non-empty paired fields/references declarations.
- Validate relation optionality against FK nullability.
- Use the runtime inverse-pairing predicate, including relation names, during
  definition validation.
- Validate storage-level FK compatibility: array state, native type, enum
  identity, vector dimension, compound uniqueness, onDelete, and onUpdate.
- Reject conflicting many-to-many through definitions.

Primary files:

- src/schema/model/model.ts
- src/schema/relation
- src/schema/validation/rules/model.ts
- src/schema/validation/rules/relation.ts
- src/schema/validation/rules/fk.ts
- tests/schema
- tests/model/relations
- tests/relations

Acceptance:

- Every accepted relation serializes and correlates successfully.
- Invalid definitions fail during validateSchema, before migration or query
  construction.

### Unit R4.4: Operation schema semantic consistency

Work:

- Build groupBy having aggregate operators by scalar capability.
- Restrict avg and sum to numeric scalars; use scalar-domain min/max.
- Reuse top-level integer pagination schemas for nested relation take/skip.
- Treat explicit undefined select/include values as absent after normalization.

Primary files:

- src/validation/model/args/aggregate.ts
- src/validation/relations/select-include.ts
- src/validation/model/args/select-include-exclusivity.ts
- tests/relations/select-include.test.ts
- model argument tests

Acceptance:

- Impossible aggregate operations fail validation.
- Nested pagination rejects negative and fractional values.
- select/include exclusivity matches parsed values, not raw property presence.

### Unit R4.5: Isolate schema hydration

Context: hydration mutates reusable model and relation identities, allowing one
client/schema to change another.

Work:

- Choose one explicit contract: immutable per-schema hydration context, cloned
  hydrated graph, or rejection of reused identities.
- Remove the first-model-only hydration completeness check.
- Ensure relation source binding cannot be overwritten by another model.
- Add cross-client and reused-definition tests.

Primary files:

- src/schema/hydration.ts
- schema registry and relation source binding
- tests/schema/shared-scalar.test.ts
- add focused hydration identity tests

Acceptance:

- Hydrating one schema cannot rename or rebind another schema.
- Completeness is checked across the whole model graph.

### Phase 4 gate

    pnpm vitest run tests/scalars tests/schema tests/model tests/relations
    pnpm type-check
    git diff --check

## Phase 5: JSON Schema Contract

### Goal

Either make JSON Schema a faithful export of VibORM validation or explicitly
reduce the supported surface until it can be faithful.

### Unit R5.1: Decide and publish the supported contract

Work:

- Enumerate every validation primitive, option, transform, object constraint,
  lazy reference, and custom-schema behavior.
- Classify each as exactly representable, conservatively representable, or not
  representable in JSON Schema.
- Reject export for unsupported semantics instead of emitting plausible but
  false schemas.
- Mark the API experimental until the conformance gate passes.

Primary files:

- src/validation/json-schema
- docs validation/reference pages
- tests/validation/json-schema.test.ts

Acceptance:

- No unsupported feature is silently omitted.
- Public docs distinguish input and output schemas.

### Unit R5.2: Separate input and output conversion

Work:

- Build distinct input/output conversion paths for transforms and defaults.
- Preserve array, nullable, optional, required, default, object omit, and
  validation constraints.
- Define conservative representations where exact transforms are impossible.

Primary files:

- src/validation/json-schema/factory.ts
- src/validation/json-schema/converters.ts
- tests/validation/json-schema.test.ts

Acceptance:

- Exported input accepts no value rejected by the documented runtime contract.
- Exported output describes transformed results rather than pre-transform
  input.

### Unit R5.3: Correct references, drafts, and naming

Work:

- Emit the correct definitions keyword and reference path per draft.
- Detect duplicate schema names and fail or disambiguate deterministically.
- Add recursive/lazy reference tests.
- Add a conformance matrix comparing runtime cases with a JSON Schema validator.

Acceptance:

- Draft-07 output contains valid draft-07 references.
- Duplicate names cannot overwrite a prior definition silently.
- The conformance matrix passes for every supported primitive and option.

### Phase 5 gate

    pnpm vitest run tests/validation/json-schema.test.ts tests/validation
    pnpm type-check
    git diff --check

## Phase 6: Cache Consistency and Isolation

### Goal

Define exactly when cache maintenance occurs relative to database commit and
make stale publication, cross-client contamination, and namespace leakage
impossible.

### Unit R6.1: Define mutation/cache failure semantics

Work:

- Decide whether invalidation is guaranteed, best effort, or durable.
- Represent a committed mutation plus invalidation failure explicitly; never
  report it as an uncommitted database failure.
- Centralize this policy at the client/query-engine cache boundary.
- Document retry behavior.

Primary files:

- src/query-engine/cache-flow.ts
- src/client/client.ts
- src/cache
- tests/cache/cache.test.ts

Acceptance:

- A cache outage after commit cannot invite a blind mutation retry.
- Callers can distinguish database failure from cache-maintenance failure.

### Unit R6.2: Publish invalidation after successful transaction or batch

Work:

- Queue model/dependency invalidations in transaction context.
- Publish only after successful outer commit.
- Discard the queue on rollback.
- Collect successful native-batch mutations and invalidate after atomic batch
  completion.

Primary files:

- src/client/client.ts
- src/query-engine/cache-flow.ts
- transaction and batch execution context
- tests/cache/cache.test.ts
- transaction behavior tests

Acceptance:

- No invalidation occurs before commit or after rollback.
- Native D1/Neon-style batch mutations invalidate the same dependencies as
  ordinary mutations.

### Unit R6.3: Fence stale fills and replace fake SWR locking

Work:

- Add per-key or per-dependency generations to prevent a pre-invalidation read
  from publishing afterward.
- Await cold fills where fencing is unavailable.
- Replace get-then-set revalidation locking with a driver-level atomic
  primitive.
- For Cloudflare, use a Durable Object or another strong coordinator when the
  portable cache contract promises single-owner revalidation.
- If a weaker cache mode is useful, expose it as a distinct explicit mode; it
  may not share the name or guarantees of the portable strong mode.
- Handle background cleanup rejection explicitly.

Primary files:

- src/cache/driver.ts
- cache driver contract
- src/cache/drivers/cloudflare-kv.ts
- tests/cache/cache.test.ts

Acceptance:

- A query started before mutation cannot repopulate stale data afterward.
- Concurrent revalidation grants one owner where strong SWR is advertised.
- No background cache promise produces an unhandled rejection.

### Unit R6.4: Namespace keys and track dependencies

Work:

- Require an immutable database/environment/tenant cache namespace.
- Place custom keys beneath their model/dependency namespace.
- Record all models used by includes, joins, and relation filters.
- Invalidate by dependency tags, not only the root model prefix.
- Correct version-prefix handling for fully generated keys.

Primary files:

- src/cache/key.ts
- src/cache/driver.ts
- src/cache/schema.ts
- query cache metadata boundary
- tests/cache/cache.test.ts

Acceptance:

- Shared KV storage cannot return entries from another configured namespace.
- Mutating a related model invalidates cached root queries that depend on it.
- Custom keys participate in automatic invalidation.

### Unit R6.5: Lossless cache value codec and immutable memory results

Work:

- Introduce a tagged codec for bigint, Date, Uint8Array, decimal, and nested
  relation results.
- Make codec failure explicit.
- Prevent MemoryCache callers from mutating the stored value, through a
  documented immutable-result contract or clone boundary.
- Preserve shared references without treating them as cycles; reject only real
  ancestor cycles during key serialization.

Primary files:

- src/cache/drivers/cloudflare-kv.ts
- src/cache/drivers/memory.ts
- src/cache/key.ts
- tests/cache/cache.test.ts

Acceptance:

- Every supported scalar round-trips with the same runtime type.
- Mutating a returned value cannot corrupt a later cache hit.
- Shared non-cyclic input references generate a key successfully.

### Unit R6.6: Bind cache configuration per client

Work:

- Replace mutable version state on a shared cache driver with an immutable
  per-client facade.
- Keep storage transport shareable while namespace/version/policy remain
  client-owned.
- Add two-client interleaving tests.

Primary files:

- src/client/client.ts
- src/cache/driver.ts
- tests/cache/cache.test.ts

Acceptance:

- Creating one client cannot change another client's cache keys or policy.

### Phase 6 gate

    pnpm vitest run tests/cache/cache.test.ts
    pnpm vitest run tests/client
    pnpm type-check
    git diff --check

A distributed Cloudflare test is required for any claim of strong SWR
coordination.

## Phase 7: Non-Interfering, Private Instrumentation

### Goal

Logging and tracing must never change query success, and privacy options must
cover every serialized error and event.

### Unit R7.1: Non-throwing structured value serialization

Work:

- Replace raw JSON.stringify calls with one total serializer supporting bigint,
  Date, Uint8Array, circular detection, and bounded depth/size.
- Make logger/tracer failures isolated from database execution.
- Record serialization failure as a safe marker rather than throwing.

Primary files:

- src/instrumentation/logger.ts
- src/instrumentation/tracer.ts
- shared instrumentation serializer
- tests/instrumentation/logger.test.ts
- tests/instrumentation/tracer.test.ts
- tests/instrumentation/driver-wiring.test.ts

Acceptance:

- Enabling logging or tracing cannot change whether a query commits.
- Bigint and binary parameters never throw.

### Unit R7.2: One privacy boundary for events and errors

Work:

- Define redaction defaults for SQL, parameters, nested metadata, and causes.
- Apply the policy to logs, spans, error toJSON output, and serialized causes.
- Coordinate with the companion plan's error-normalization unit so raw
  parameters are absent by default at their source.
- Add secret-canary tests proving the canary never appears in default output.

Primary files:

- src/instrumentation
- src/errors/base.ts
- companion-owned src/drivers/error-mapping.ts
- instrumentation and error tests

Acceptance:

- includeParams false and includeSql false prevent leakage through every output
  path.
- Explicit opt-in is required for raw diagnostic values.

### Unit R7.3: Optional dependency and version truthfulness

Work:

- Test the packed package with OpenTelemetry physically absent.
- Derive service/library versions from one generated package version source.
- Remove hardcoded 0.1.0 values.

Primary files:

- src/instrumentation/tracer.ts
- src/cli/index.ts
- package build configuration
- packed-consumer tests

Acceptance:

- Instrumentation degrades safely when the peer is not installed.
- CLI and tracing version metadata match package.json.

### Phase 7 gate

    pnpm vitest run tests/instrumentation
    pnpm type-check
    git diff --check

The secret-canary test must also cover the companion plan's driver errors.

## Phase 8: Runtime, Package, and Documentation Alignment

### Goal

Make the declared engines, Worker support, export map, declarations, and public
examples match what a clean consumer actually receives.

### Unit R8.1: Explicit Worker compatibility boundary

Work:

- Remove unguarded Buffer use from validation blob paths.
- Coordinate portable Uint8Array and ArrayBuffer handling with the companion
  driver's D1/result-decoding unit.
- Split Node-only storage and migration imports away from edge-safe exports.
- Test with Buffer undefined and without nodejs_compat assumptions.

Primary files:

- src/validation/primitives/blob.ts
- migration/package entrypoints
- companion-owned driver/result files
- tests/validation/blob.test.ts
- packed Worker consumer

Acceptance:

- Documented Worker entrypoints import and execute without Node globals.
- Blob validation and D1 round-trip work with Uint8Array.

### Unit R8.2: Load configuration on every supported Node version

Work:

- Choose a bundled TypeScript config loader or require compiled JavaScript.
- Preserve the original configuration exception and stack instead of rewriting
  every failure as loader advice.
- Align package engines and docs with the chosen behavior.

Primary files:

- src/cli/utils.ts
- src/cli/index.ts
- package.json
- tests/cli/utils.test.ts
- docs configuration page

Acceptance:

- The documented default config loads on the minimum supported Node version.
- Errors inside a config remain visible as their real errors.

### Unit R8.3: Isolate declarations and optional peers

Work:

- Prevent root/schema declarations from importing all optional driver and OTel
  peers.
- Keep declarations scoped to each export-map entry.
- Install the packed tarball into clean fixtures with no optional peers and
  type-check representative imports.

Primary files:

- tsdown.config.ts
- package exports and declaration entrypoints
- package.json
- packed-consumer fixtures

Acceptance:

- A schema-only consumer type-checks without database or tracing packages.
- Each driver entry requires only its own peer.

### Unit R8.4: Compile public documentation examples

Work:

- Correct import paths and public API examples in README and docs.
- Cover pglite, cache drivers, D1, migration push, tracing, and squash results.
- Extract or generate snippet fixtures and compile them against the packed
  tarball in CI.

Primary files:

- README.md
- docs/content/docs
- package export map
- documentation snippet fixtures

Acceptance:

- Every executable public example compiles against the packed package.
- Documentation build cannot pass when an import path does not exist.

### Unit R8.5: Reproducible package publication

Work:

- Add a release/prepack path that builds dist from a clean checkout.
- Add the actual license file matching package metadata.
- Repair or remove stale scripts and unused runtime dependencies.
- Resolve the deprecated tsdown option and stale declaration comments.
- Enforce the intended package-size budget after the size tool exists.

Primary files:

- package.json
- tsdown.config.ts
- LICENSE
- release scripts

Acceptance:

- npm pack from a clean checkout contains built exports, declarations, README,
  and LICENSE.
- Every package script referenced by release documentation succeeds.

### Phase 8 gate

    pnpm package:build
    pnpm --dir docs run build
    npm pack --dry-run --json
    pnpm type-check
    git diff --check

Also run clean packed-consumer type checks on every supported Node major.

## Phase 9: Enforced Quality Gates and Structural Reduction

### Goal

Make regressions visible before merge, then reduce oversized modules without
mixing behavior changes into file movement.

### Unit R9.1: CI database and runtime matrix

Work:

- Add tracked CI for type-check, unit tests, package build, docs build, lint,
  packed consumers, and snippet compilation.
- Run PostgreSQL, postgres.js, MySQL, and local SQLite/PGlite suites rather than
  allowing their complete skip.
- Add a Worker-compatible runtime job for D1-facing paths.
- Run one shared cross-database conformance suite with identical expected
  behavior for every portable schema, migration, mutation, transaction, scalar,
  and result contract.
- Make an unexpectedly skipped required suite fail.

Acceptance:

- The current 570 environment-skipped database tests run in CI.
- No required driver can silently lose all conformance coverage.
- Provider-specific fixtures are allowed; provider-specific expected semantics
  in the portable suite are not.

### Unit R9.2: Restore an actionable lint and type baseline

Work:

- Classify intentional bitwise/hash diagnostics and suppress them narrowly.
- Fix real unused/dead-code diagnostics.
- Re-enable cognitive complexity and relevant safety rules incrementally.
- Separate Node, Worker/DOM, Bun, and test TypeScript environments.
- Plan the migration to noImplicitAny true and exact optional properties without
  hiding failures behind broad assertions.

Primary files:

- biome.json
- tsconfig files
- source diagnostics
- CI configuration

Acceptance:

- Biome check exits zero.
- Runtime-specific globals cannot mask unsupported APIs.
- New complexity and unsafe-any regressions fail CI.

### Unit R9.3: Repair test and release scripts

Work:

- Point test:types and test:runtime at real suites or remove misleading names.
- Install and configure the declared size tool or remove the dead command.
- Add packed-consumer and docs-snippet scripts with stable names.

Acceptance:

- Every package.json script exits successfully from a clean checkout when its
  documented prerequisites are present.

### Unit R9.4: Decompose non-query monoliths after behavior is locked

Targets include:

- src/validation/primitives/object.ts
- src/schema/validation/rules/relation.ts
- src/client/client.ts
- src/migrations/types.ts
- migration base and dialect driver files

Work:

- Follow docs/architecture/code-organization-refactor-map.md.
- Split one responsibility per commit with no semantic changes.
- Remove generic helper/utils files by moving each real concept to a named
  module.
- Keep public exports stable.

Acceptance:

- No source file exceeds the repository's 600-line hard limit.
- Moved code has identical focused and full-suite behavior.
- Complexity drops because responsibilities moved, not because diagnostics were
  disabled.

### Phase 9 gate

    pnpm build
    pnpm test
    pnpm package:build
    pnpm --dir docs run build
    pnpm biome check src
    npm pack --dry-run --json
    git diff --check

## Definition of Done

This plan is complete only when:

- dry-run has a tested zero-write guarantee;
- approved migration plans are executed without replanning;
- migration files, journal state, and database tracking are checksum-verified
  under an effective lock;
- D1, Neon, MySQL, PostgreSQL, and SQLite migrations satisfy one tested
  observable execution and recovery contract;
- rollback and squash cannot fabricate state;
- validation defaults, scalar modifiers, vectors, relations, aggregate inputs,
  and exported JSON Schema agree with their inferred types;
- record parsing is prototype-safe and pipe composition is type-safe;
- cache invalidation is commit-aware, dependency-aware, namespaced, and fenced
  against stale publication;
- supported cache values round-trip without type loss;
- instrumentation cannot throw through a query and cannot leak default-redacted
  values;
- Worker paths run without undeclared Node globals;
- the minimum supported Node version loads the documented config;
- clean consumers resolve only the peers used by their chosen export;
- public examples compile against the packed package;
- CI runs the real database matrix and all quality gates;
- all advertised drivers pass the same portable conformance expectations;
- the companion query-engine plan's shared Worker and privacy gates also pass.

## Explicit Non-Goals

- New ORM operations or Prisma-parity features.
- New cache backends.
- A new migration file format unless immutable identity cannot be added
  compatibly.
- Silent fallback when a provider cannot guarantee the required atomicity.
- Provider-specific degradation or rejection inside the portable schema,
  migration, validation, transaction, cache, or client API.
- Treating documentation of a dialect limitation as completion of an
  interoperability unit.
- Broad refactoring before regression behavior is locked.
- Weakening validation or tests to preserve currently incorrect behavior.
