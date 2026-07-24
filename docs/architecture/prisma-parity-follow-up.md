# Prisma Parity Execution Plan

## Purpose

This document is the execution plan for moving VibORM from "Prisma-inspired
alpha" toward Prisma-like developer experience for the core ORM surface.

The goal is not to clone every Prisma feature. The goal is stricter:

1. Inputs that look supported must either work correctly or fail loudly.
2. Runtime behavior and TypeScript behavior must agree.
3. The basic CRUD, filtering, relation, nested write, aggregate, transaction, and
   cross-dialect behavior should feel familiar to a Prisma user.
4. Any intentional difference must be documented as a VibORM decision, not
   discovered by surprise.

This plan was written after the schema registry migration was merged. That PR
fixed the architecture needed for dynamic model operation schemas. This document
organizes the next work into phases that should usually map to separate PRs.

## Current Stability Claim

Do not claim full Prisma parity yet.

The honest current claim is:

> VibORM has a Prisma-inspired API with strong PGlite/Postgres-style happy-path
> CRUD coverage, broad schema/type validation, and an improving zero-codegen
> type system. Prisma parity is not complete.

The adversarial review found that the public surface looks more Prisma-complete
than it currently is. The main risk is false confidence: some inputs validate or
type-check but are unsupported, ignored, or semantically different from Prisma.

## Definition of the Holy Grail

VibORM reaches the "Prisma parity" target for this roadmap when the following
claims are true:

- Basic model operations behave like Prisma: `findUnique`, `findFirst`,
  `findMany`, `create`, `createMany`, `update`, `updateMany`, `upsert`, `delete`,
  `deleteMany`, `count`, `aggregate`, and `groupBy`.
- `where`, `whereUnique`, `orderBy`, `cursor`, `skip`, `take`, `distinct`,
  `select`, and `include` either match Prisma semantics or are documented
  intentional differences.
- Relation filters and includes work for to-one, to-many, and many-to-many where
  documented.
- Supported nested writes are Prisma-compatible. Unsupported nested writes are
  rejected before query generation.
- TypeScript catches the same basic misuse Prisma catches: invalid args, invalid
  `select`/`include` combinations, missing unique selectors, unsupported nested
  writes, and invalid aggregate/groupBy shapes.
- Cross-dialect mutation return values are stable across Postgres, SQLite, and
  MySQL-style drivers.
- Docs describe the exact supported API, not the imagined API.

## Global Rules for Every Phase

### Rule 1: Fail Closed

Never leave an accepted input path that silently does nothing. If an input shape
is Prisma-like, VibORM has only two valid choices:

1. Implement it with Prisma-compatible semantics.
2. Reject it before query generation.

Unsupported Prisma-like features must not be ignored, partially applied, or
compiled into a broader query than the user requested.

Bad:

```ts
await orm.user.findMany({
  orderBy: { posts: { _count: "desc" } },
});
// Relation order accepted, then ignored.
```

Good:

```ts
// Implement relation count ordering with Prisma-like semantics in its phase.
// Until then, reject it with a clear validation error before SQL generation.
```

### Rule 2: Type and Runtime Must Agree

If TypeScript accepts an input, runtime should accept it. If runtime rejects an
input, TypeScript should reject it when the shape is statically visible.

Temporary exceptions are allowed only if documented in the phase notes and
covered by runtime tests.

### Rule 3: Prisma Compatibility Requires Exactness

Structural assignability is not enough. Many TypeScript tests should use direct
client calls with `// @ts-expect-error` because that catches the real developer
experience better than broad `expectTypeOf(...).toMatchTypeOf(...)` checks.

### Rule 4: Each Phase Ships with Tests

Every phase must add or update tests in the existing test structure:

- Type tests: `tests/client/**`, `tests/model/args/**`, `tests/relations/**`.
- Runtime client tests: `tests/client/**`.
- Query engine tests: `tests/query-engine/**`.
- Validation tests: `tests/model/**`, `tests/validation/**`.
- Driver/adapters tests: `tests/drivers/**`, `tests/adapters/**`,
  `tests/query-engine/*dialects*.test.ts`.

### Rule 5: No Broad Refactors Without a Phase Reason

Do not clean unrelated modules while working through a phase. Prisma parity is
large enough; each PR should have one dominant concern.

## Systematic Verification Loop

Use this loop for every phase:

1. Start from clean `main`.

   ```bash
   git status --short --branch
   ```

2. Add failing tests that describe the target behavior.

3. Implement the smallest code change that makes those tests pass.

4. Run focused tests for the phase.

   ```bash
   pnpm vitest run tests/path/to/file.test.ts
   ```

5. Run broad checks.

   ```bash
   pnpm type-check
   pnpm test
   pnpm build
   ```

6. Review the diff for accidental scope creep.

7. Update this document only when the phase scope changes materially.

## Phase 0: Baseline Audit and Contract Matrix

### Goal

Create a precise contract table for the Prisma-like surface VibORM intends to
support. This phase prevents the rest of the work from drifting into anecdotes.

### Units of Work

#### Unit 0.1: Operation Contract Matrix

Document the expected status of each operation:

- `findUnique`
- `findUniqueOrThrow`
- `findFirst`
- `findFirstOrThrow`
- `findMany`
- `create`
- `createMany`
- `update`
- `updateMany`
- `upsert`
- `delete`
- `deleteMany`
- `count`
- `aggregate`
- `groupBy`
- `exist` boolean check
- `$queryRaw`
- `$executeRaw`

For each operation record:

- Prisma behavior.
- Current VibORM behavior.
- Intended VibORM behavior.
- Type-level tests that should exist.
- Runtime tests that should exist.
- Dialect-specific risks.

Plan decision:

- Keep `exist` as the VibORM boolean-existence operation for this roadmap.
- Do not add an `exists` alias during Prisma parity work.
- Document `exist` as a VibORM extension because Prisma does not expose this
  operation directly.

Suggested file:

- `docs/architecture/prisma-parity-contract.md`

#### Unit 0.2: Argument Contract Matrix

Document the intended behavior for:

- `where`
- `whereUnique`
- `select`
- `include`
- `omit`
- `data`
- `orderBy`
- `cursor`
- `skip`
- `take`
- `distinct`
- `_count`
- `_avg`
- `_sum`
- `_min`
- `_max`
- `having`

#### Unit 0.3: Test Inventory

Map existing tests to the contract matrix. Mark gaps as:

- `missing type test`
- `missing runtime test`
- `missing dialect test`
- `known unsupported`
- `intentionally different from Prisma`

### Target Files

- `docs/architecture/prisma-parity-contract.md`
- `docs/architecture/prisma-parity-follow-up.md`

### Exit Criteria

- The contract matrix exists.
- Every later phase can cite contract rows rather than re-arguing intended
  behavior.
- No production code changes in this phase unless a typo blocks documentation.

## Focused Core Gaps

The detailed implementation roadmap for the first Prisma-compatible core gaps
has moved to `docs/architecture/prisma-core-gaps.md`.

This file keeps the broader parity contract, verification loop, runtime
stability work, documentation cleanup, and final audit process. Do not duplicate
the focused implementation list here.

## Remaining Phase 1: Transactions, Error Semantics, and Driver Stability

### Goal

Make runtime behavior stable enough for real applications, not only local PGlite
tests.

### Units of Work

#### Unit 1.1: Transaction State Isolation

Current risk:

- Transaction state can be too global for pooled or concurrent drivers.

Work:

- Audit `Driver` transaction state.
- Move transaction state into transaction-scoped context where needed.
- Add concurrent transaction tests for pooled drivers where available.

Target files:

- `src/drivers/**`
- `src/client/client.ts`
- `tests/client/batch-transaction.test.ts`
- `tests/drivers/savepoint-queue.test.ts`

#### Unit 1.2: Unsupported Transaction Modes — Done

Work:

- Identify drivers that cannot provide callback transaction atomicity.
- Reject unsupported transaction usage or require explicit non-atomic opt-in.
- Remove silent `console.warn` fallback where it implies atomicity.

Status: done. `src/client/client.ts` and `src/drivers/driver.ts` throw
`"does not support callback transactions"` instead of silently falling back;
no `console.warn` calls remain in `src/`.

#### Unit 1.3: Stable Error Classes — Done

Work:

- Map common database errors:
  - unique constraint
  - foreign key constraint
  - not-null constraint
  - check constraint
  - serialization/deadlock for drivers that expose reliable error codes
- Ensure errors include model and operation context for ORM-generated queries.

Target files:

- `src/errors/**` or current error location
- `src/drivers/**`
- `tests/drivers/**`

Status: done. `src/errors/constraints.ts` defines `UniqueConstraintError`,
`ForeignKeyError`, `NotNullConstraintError`, and `CheckConstraintError`;
serialization/deadlock mapping lives in `src/drivers/error-mapping.ts` and
`src/errors/base.ts`.

#### Unit 1.4: Transaction Options — Superseded

Phase 8 of the query-engine correctness remediation plan replaced the earlier
timeout design with an empty portable option subset. `$transaction` accepts no
second options argument because timeout, isolation, access-mode, and
provider-specific settings do not have one honest meaning across every
advertised driver. Removed options reject before callback or provider work; the
old `Promise.race` timeout path no longer exists.

### Exit Criteria

- Transaction behavior is explicit per driver.
- Common database errors are normalized.
- The portable API declares no transaction option it cannot honor everywhere.

## Remaining Phase 2: Documentation and Public Contract Cleanup

### Goal

Make public docs match the actual supported surface.

### Units of Work

#### Unit 2.1: Replace Overclaims

Work:

- Replace broad "Prisma parity" language with "Prisma-inspired" until all
  earlier phases are complete.
- Avoid claims like "all nested writes" unless the matrix proves it.

Target files:

- `README.md`
- `docs/content/docs/**`
- `readme/**`

#### Unit 2.2: Document Intentional Differences

Known likely differences:

- `exist` naming if kept.
- Blended checked/unchecked create inputs if kept.
- Raw query API shape.
- Excluded nested-write shapes.
- Driver-specific feature availability.

#### Unit 2.3: Add Compatibility Tables

Docs should include tables for:

- operation support
- relation filter support
- nested write support
- dialect support
- type-system differences

#### Unit 2.4: Add Examples Backed by Tests

Rule:

- Every public docs example for Prisma-like behavior should correspond to a test
  or be marked conceptual.

### Exit Criteria

- Docs no longer overclaim.
- Unsupported Prisma features are listed explicitly.
- Compatibility tables match tests and implementation.

## Remaining Phase 3: Final Parity Audit

### Goal

Run an adversarial final review before declaring the core Prisma-like surface
stable.

### Units of Work

#### Unit 3.1: Multi-agent Review

Repeat adversarial review across:

- operation API
- type system
- filters/pagination/aggregate
- relations/nested writes
- runtime/drivers/transactions
- docs/tests

#### Unit 3.2: Contract Matrix Reconciliation

Work:

- Compare implementation against `prisma-parity-contract.md`.
- Mark every row:
  - complete
  - intentionally different
  - unsupported and documented
  - still broken

#### Unit 3.3: Release Gate

Run:

```bash
pnpm type-check
pnpm test
pnpm build
```

Run local database suites:

```bash
pnpm test:pglite
pnpm test:sqlite
pnpm test:drivers:local
```

MySQL, PlanetScale, D1, and other hosted-driver suites are external follow-up
work until dedicated scripts and credentials exist.

### Exit Criteria

- No known accepted-but-ignored inputs remain.
- No known type/runtime mismatch remains in the basic surface.
- Docs match the implementation.
- The stability claim can be upgraded from "Prisma-inspired alpha" to a narrower
  but honest statement such as:

> VibORM supports a Prisma-like core CRUD and relation query experience for the
> documented feature set, with zero code generation and explicit documented
> differences from Prisma.

## Recommended PR Order

1. Phase 0: Contract matrix.
2. Focused core gaps roadmap in `docs/architecture/prisma-core-gaps.md`.
3. Remaining Phase 1: Runtime stability and driver semantics.
4. Remaining Phase 2: Documentation cleanup.
5. Remaining Phase 3: Final parity audit.

If a phase becomes too large, split by unit of work. Do not merge unrelated
phases into one PR for convenience.

## First Implementation Recommendation

Start with `docs/architecture/prisma-core-gaps.md`, Unit 1: fail closed for
accepted-but-ignored inputs.

Reason: fail-closed behavior is the safety floor. It prevents VibORM from
accepting Prisma-like inputs that silently broaden or change a query while the
rest of the focused gaps are implemented.
