# Prisma Parity Follow-up

## Purpose

This document records the adversarial review performed after the schema registry
migration and nested-write hardening work.

The current pull request should stay focused on the schema registry migration,
nested create correctness, validation/runtime coherence, and the tests added for
that work. The issues below are real, but they should be tackled in one or more
follow-up PRs instead of expanding the current PR.

## Current Stability Claim

Do not claim full Prisma parity yet.

The honest current claim is:

> VibORM has a Prisma-inspired API with strong PGlite/Postgres-style happy-path
> CRUD coverage, broad schema/type validation, and an improving zero-codegen
> type system. Prisma parity is not complete.

The adversarial review found that the public surface looks more Prisma-complete
than it currently is. The main risk is false confidence: some inputs validate or
type-check but are unsupported, ignored, or semantically different from Prisma.

## Current PR Scope

Keep this PR limited to:

- Runtime schema registry ownership of model/field/relation operation schemas.
- Nested create and nested `createMany` foreign key omission/assignment.
- Validation/runtime alignment for supported nested write operations.
- Rejection of unsupported nested mutation keys.
- Test coverage added during the schema registry migration.
- Documentation updates that explain the new registry architecture.

Do not fold the Prisma parity work below into this PR unless a bug directly
breaks the schema registry migration itself.

## Follow-up Work

### 1. Fail Closed for Unsupported Query Inputs

Some query args are accepted but ignored or compiled with incorrect semantics.
This must be fixed before VibORM can be described as stable.

Known issues:

- Relation `orderBy` is accepted but skipped by the query builder.
- Some advanced scalar filters can validate but be ignored by `where` building.
- `count` and `aggregate` accept pagination/cursor/order args beyond the current
  implementation's correct semantics.
- `every: {}` and `OR: []` need Prisma-compatible semantics or explicit
  rejection.
- Dialect-specific null ordering support needs either implementation or
  validation rejection.

Expected follow-up PR:

- Reject unsupported accepted inputs at validation time, or implement them fully.
- Add runtime tests proving unsupported inputs cannot silently return broad data.

### 2. Tighten Prisma-like Type Algebra

VibORM's happy-path inference is useful, but it does not yet enforce Prisma's
strict operation input algebra.

Known gaps:

- No equivalent of Prisma's `Exact`, `XOR`, or `SelectSubset` helpers.
- Top-level `select` and `include` can be provided together; Prisma rejects this.
- Checked and unchecked create/update inputs are not separated like Prisma.
- Type tests often prove assignability, not exactness.
- GroupBy and aggregate result types need stronger coupling to selected args.

Expected follow-up PR:

- Introduce strict operation input helpers.
- Decide whether `select` + `include` is an intentional VibORM extension or a
  Prisma-compatibility bug.
- Add direct client-call type tests using `@ts-expect-error`, not only
  `expectTypeOf` assignability.

### 3. Fix `whereUnique` Safety

Prisma requires a real unique selector for unique operations. VibORM currently
has risk around empty or structurally weak `whereUnique` inputs.

Known risks:

- `where: {}` can validate or type-check in some paths.
- `buildWhereUnique` can return no condition if no unique fields are present.
- Single-record operations can then behave unlike Prisma or return surprising
  rows.

Expected follow-up PR:

- Require at least one valid unique discriminator at validation and type level.
- Add runtime tests for `findUnique`, `update`, `delete`, and `upsert` with empty
  or invalid unique inputs.

### 4. Align Single-record Mutation Semantics

Prisma throws on missing records for single-record `update` and `delete`.
VibORM can currently return `null` while the public type says a record.

Expected follow-up PR:

- Make missing `update` and `delete` throw a stable not-found error.
- Align result types with runtime behavior.
- Add tests for missing `update`, missing `delete`, and selected/included
  variants.

### 5. Harden Cross-dialect Mutation Returns

Postgres/PGlite paths are well covered. MySQL-style adapters do not support
`RETURNING`, so ordinary mutations need a refetch strategy or clearly different
semantics.

Known risks:

- `create`, `update`, `delete`, and `upsert` can rely on returned rows.
- MySQL adapters return empty `RETURNING`.
- Nested create has fallback/refetch logic that ordinary mutations do not share.

Expected follow-up PR:

- Implement per-dialect mutation return strategies.
- Add mysql/mysql2 runtime tests for basic mutations and selected/included
  results.

### 6. Scope Nested Relation Mutations

Implemented nested relation mutations must not mutate unrelated child rows.

Known risks:

- Specific to-many `disconnect` and `delete` should prove the target child row is
  currently related to the parent.
- Many-to-many nested write schemas can imply support that the executor does not
  safely provide.
- Required vs optional relation constraints should be rejected before database
  constraint errors where possible.

Expected follow-up PR:

- Scope specific `disconnect` and `delete` with parent FK correlation.
- Either remove many-to-many nested write schemas or implement junction-table
  nested write semantics.
- Add cross-parent mutation tests.

### 7. Clarify Relation and Nested Write Scope

Current relation querying is reasonably Prisma-like for basics, but nested writes
are a subset.

Supported today, subject to the caveats above:

- Relation include/select.
- To-one `is` / `isNot` and to-many `some` / `every` / `none` filters.
- Nested `create`, `createMany`, `connect`, `connectOrCreate`, `disconnect`,
  `delete`, and `set` for supported FK-backed relations.

Not Prisma-complete:

- Nested `update`.
- Nested `updateMany`.
- Nested `deleteMany`.
- Nested relation `upsert`.
- Full many-to-many nested write semantics.

Expected follow-up PR:

- Update public docs to describe the supported subset exactly.
- Add runtime tests before documenting additional Prisma-like nested write
  operations as supported.

### 8. Runtime Stability and Driver Semantics

The runtime is promising but not release-stable across all drivers.

Known issues:

- Transaction state can be too global for pooled/concurrent drivers.
- Constraint errors are not consistently mapped to stable ORM error classes.
- Some no-transaction or batch-only drivers can weaken `$transaction` semantics.
- `TransactionOptions.timeout` is declared but not enforced.

Expected follow-up PR:

- Audit transaction state per driver.
- Normalize common constraint errors.
- Reject unsupported transaction modes or make non-atomic behavior explicit.
- Implement or remove unused transaction options.

## Documentation Follow-up

Before claiming Prisma-like basics in public docs:

- Replace broad "Prisma parity" language with "Prisma-inspired alpha" language.
- Document all intentional differences from Prisma.
- Remove or mark unsupported nested write examples that use nested `update`,
  `updateMany`, `deleteMany`, or `upsert`.
- Audit docs for cursor pagination, distinct, JSON filters, array filters,
  relation ordering, and case-insensitive filtering against actual runtime
  support.

## Suggested PR Breakdown

1. Fail-closed validation for unsupported accepted inputs.
2. `whereUnique` safety and single-record mutation not-found semantics.
3. Prisma-like type algebra and exactness.
4. Nested relation mutation scoping and many-to-many nested write decision.
5. Cross-dialect mutation return strategy.
6. Public documentation cleanup for Prisma-inspired alpha scope.

Each PR should include focused runtime tests and type tests for the behavior it
claims to support.
