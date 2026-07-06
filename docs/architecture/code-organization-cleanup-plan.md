# Code Organization Cleanup Plan

**Status:** Phases 0-2 and 4-6 executed in the working tree as of 2026-07-02
(uncommitted). Phase 3 (query engine orchestration split) is also executed
(`executor.ts`, `cache-flow.ts`, `transaction-flow.ts`, `result-flow.ts` exist
alongside a 171-LOC `query-engine.ts`). The Phase 5 driver-base split
(`execution-context.ts`) and the unscheduled `src/client/` split
(`model-proxy.ts`, `cache-client.ts`, `transaction.ts`) described in the
refactor map have not been done — `src/drivers/driver.ts` (821 LOC) and
`src/client/client.ts` (722 LOC) remain monolithic. Verify against disk
(`ls src/query-engine/operations/nested-writes/`,
`wc -l src/query-engine/query-engine.ts`) before relying on this plan as a
to-do list.

## Goal

Make VibORM structurally leaner without changing behavior: smaller cohesive
files, clearer domain boundaries, less duplicated setup, and fewer god modules.

## Context

The top-level layer architecture is sound for an ORM:

- validation
- schema
- query-engine
- adapters
- drivers
- client
- migrations
- cache
- instrumentation

The weakness is not the folder model. The weakness is that several folders
contain files that carry whole subsystems.

Primary cleanup targets:

- `src/query-engine/operations/nested-writes.ts`
- `src/query-engine/query-engine.ts`
- `src/migrations/push.ts`
- `src/client/client.ts`
- `src/drivers/driver.ts`
- `src/errors.ts`
- repeated test schemas, seed helpers, and driver setup

## Constraints

- No public API changes.
- No behavior changes unless a hidden bug is exposed.
- No adapter boundary violations: query engine decides what, adapters decide SQL.
- No speculative abstractions.
- No generic manager/context objects unless there are multiple real consumers.
- No unrelated Prisma-parity implementation work inside these phases.
- Each phase must be independently reviewable and reversible.

## Phase 0: Refactor Map

Create a small architecture note before moving code.

Output: `docs/architecture/code-organization-refactor-map.md`.

Work:

- Document intended file splits for each target module.
- Document import direction inside each domain.
- Add a "no new god files" rule for future Prisma-parity work.
- Mark which files are allowed to stay large because they are cohesive.

Done when:

- The split map exists.
- Later phases can follow it without re-deciding boundaries.
- No production code changes are made.

Verification:

```bash
git diff --check
```

## Phase 1: Shared Test Infrastructure

Reduce duplicated test setup before refactoring runtime code.

Work:

- Extract common `user/post` test schemas used across driver, client, and
  query-engine tests.
- Extract seed helpers for deterministic users/posts.
- Extract local in-memory driver setup helpers for PGlite, SQLite3, and LibSQL.
- Keep driver-specific tests for driver-specific behavior only.
- Keep behavior specs separate from raw driver smoke tests.

Target areas:

- `tests/drivers/**`
- `tests/client/**`
- `tests/query-engine/**`

Done when:

- Common schema and seed setup are reused instead of copied.
- Existing driver tests still read clearly.
- Shared helpers do not hide driver-specific behavior.

Verification:

```bash
pnpm test:drivers:local
pnpm vitest run tests/client/operations.test.ts tests/query-engine/sql-generation.test.ts
pnpm type-check
git diff --check
```

## Phase 2: Split Nested Writes

Break `src/query-engine/operations/nested-writes.ts` by nested mutation concern.

Target shape:

```text
src/query-engine/operations/nested-writes/
  index.ts
  create.ts
  update.ts
  connect.ts
  connect-or-create.ts
  disconnect.ts
  delete.ts
  set.ts
  fk.ts
  assertions.ts
```

Work:

- Move FK matching, FK assignment, and parent correlation helpers into `fk.ts`.
- Move validation/assertion helpers into `assertions.ts`.
- Move each relation mutation executor into its own file.
- Keep existing exported operation names stable through `index.ts`.
- Do not introduce a nested-write manager class.

Done when:

- No nested-write file exceeds roughly 400 LOC.
- Each file owns one mutation concern.
- FK/correlation logic has one home.

Verification:

```bash
pnpm vitest run tests/query-engine/nested-writes.test.ts tests/query-engine/nested-mutation-routing.test.ts tests/query-engine/nested-create-many.test.ts
pnpm vitest run tests/client/operations.test.ts
pnpm type-check
git diff --check
```

## Phase 3: Split Query Engine Orchestration

Shrink `src/query-engine/query-engine.ts` into explicit execution flows.

Target shape:

```text
src/query-engine/
  query-engine.ts
  executor.ts
  cache-flow.ts
  transaction-flow.ts
  result-flow.ts
```

Work:

- Keep `QueryEngine` as the public orchestration class.
- Move operation dispatch into `executor.ts`.
- Move cache lookup/write/invalidation into `cache-flow.ts`.
- Move transaction and batch execution flow into `transaction-flow.ts`.
- Move result parsing/hydration flow into `result-flow.ts`.
- Keep SQL construction in `operations/` and `builders/`.

Done when:

- `query-engine.ts` is an orchestration shell.
- Operation builders remain unchanged in responsibility.
- Adapter SQL ownership remains untouched.

Verification:

```bash
pnpm vitest run tests/client/operations.test.ts tests/client/batch-transaction.test.ts
pnpm vitest run tests/query-engine/sql-generation.test.ts
pnpm type-check
git diff --check
```

## Phase 4: Split Migration Push

Break `src/migrations/push.ts` into workflow pieces.

Target shape:

```text
src/migrations/push/
  index.ts
  planner.ts
  executor.ts
  reset.ts
  enum-removals.ts
  format.ts
```

Work:

- Keep exported `push`, `introspect`, `generateDDL`, `formatOperation`, and
  `formatOperations` compatible.
- Move serialization, introspection, diffing, and resolution into `planner.ts`.
- Move DDL execution into `executor.ts`.
- Move force reset into `reset.ts`.
- Move enum value removal logic into `enum-removals.ts`.
- Move formatting helpers into `format.ts`.

Done when:

- Push workflow reads top-to-bottom.
- Resolution, reset, DDL execution, and formatting are not mixed.
- Migration public exports remain compatible.

Verification:

```bash
pnpm vitest run tests/migrations/differ.test.ts tests/migrations/ddl.test.ts tests/migrations/ddl-drivers.test.ts
pnpm type-check
git diff --check
```

## Phase 5: Driver And Adapter Deduplication

Remove real duplication without hiding dialect differences.

Work:

- Compare Postgres, MySQL, and SQLite adapter assembly code.
- Extract shared helpers only where structure is identical across at least three
  dialects.
- Keep dialect-specific SQL syntax inside adapter implementations.
- Extract repeated driver lifecycle logic only where at least three drivers share
  the same behavior.
- Keep driver files backend-specific and readable.

Anti-goals:

- No generic universal SQL adapter.
- No inheritance hierarchy for one-off dialect quirks.
- No abstraction that makes generated SQL harder to inspect.

Done when:

- Repeated assembly/lifecycle code is reduced where the common shape is real.
- Dialect differences remain explicit.
- Driver and adapter tests still identify which backend failed.

Verification:

```bash
pnpm vitest run tests/query-engine/sql-generation.test.ts tests/query-engine/for-update-dialects.test.ts
pnpm test:drivers:local
pnpm type-check
git diff --check
```

## Phase 6: Split Error Domain

Break `src/errors.ts` by domain while preserving public exports.

Target shape:

```text
src/errors/
  base.ts
  constraints.ts
  query.ts
  validation.ts
  transaction.ts
  migrations.ts
  cache.ts
  index.ts
```

Work:

- Move base error and shared metadata helpers into `base.ts`.
- Move constraint errors into `constraints.ts`.
- Move query and not-found errors into `query.ts`.
- Move transaction errors into `transaction.ts`.
- Move migration errors into `migrations.ts`.
- Move cache errors into `cache.ts`.
- Preserve the current import surface through `src/errors.ts` or a compatibility
  re-export if needed.

Done when:

- Error classes are grouped by domain.
- Existing imports still compile.
- Error mapping tests still pass.

Verification:

```bash
pnpm vitest run tests/drivers/error-mapping.test.ts tests/drivers/sqlite3.test.ts
pnpm type-check
git diff --check
```

## Phase 7: Final Cleanliness Gate

Run a repo-level organization audit after the splits.

Check:

- No implementation file over 600 LOC without a written justification.
- No class carries unrelated responsibilities.
- No repeated schema/seed/driver setup that should be shared.
- No barrel export creates accidental import cycles.
- No behavior drift from the refactors.
- No new abstractions with only one real consumer unless they name a complex
  local step.

Verification:

```bash
pnpm test:drivers:local
pnpm vitest run tests/query-engine/nested-writes.test.ts tests/query-engine/nested-mutation-routing.test.ts tests/query-engine/nested-create-many.test.ts
pnpm vitest run tests/client/operations.test.ts tests/client/batch-transaction.test.ts
pnpm vitest run tests/migrations/differ.test.ts tests/migrations/ddl.test.ts tests/migrations/ddl-drivers.test.ts
pnpm type-check
pnpm test
pnpm build
git diff --check
```

## Recommended Execution Order

1. Phase 0: write the split map.
2. Phase 1: extract shared test infrastructure.
3. Phase 2: split nested writes.
4. Phase 3: split query engine orchestration.
5. Phase 4: split migration push.
6. Phase 5: deduplicate drivers/adapters where the abstraction is real.
7. Phase 6: split errors by domain.
8. Phase 7: final cleanliness gate.

## Success Criteria

- The layer architecture remains intact.
- Large files become cohesive smaller modules.
- Shared helpers reduce duplication without hiding domain behavior.
- Public APIs and runtime behavior remain unchanged.
- Refactors are independently reviewable.
- Future Prisma-parity work has clear places to land.
