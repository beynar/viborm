# Query Engine Operation Program — Phase 0 Baseline

Captured on 2026-07-12 from the working tree that contains the completed
correctness remediation. This is the comparison point for every later phase of
`query-engine-operation-program-implementation-plan.md`.

## Reproduce

```bash
node scripts/query-engine-structure.mjs
pnpm vitest run tests/query-engine/pending-operation-contracts.test.ts
pnpm vitest run tests/query-engine/operation-equivalence-oracles.test.ts
pnpm test:gates
pnpm vitest bench --run operation-lifecycle --reporter=verbose
```

The structural script prints JSON and defines every counted AST node in its
`definitions` field. Later phases must use this script unchanged or explain a
metric-definition change beside both old and new results.

## Structural baseline

| Metric | Query engine | Nested writes |
| --- | ---: | ---: |
| TypeScript files | 121 | 44 |
| Physical LOC | 24,204 | 10,140 |
| Functions | 932 | 405 |
| Function parameters | 2,291 | 1,014 |
| Functions with at least five parameters | 123 | 64 |
| Branch nodes | 2,340 | 811 |
| Runtime import cycle components | 3 | 1 |
| Runtime files participating in cycles | 13 | 8 |
| Files over 300 LOC | 29 | 13 |
| Files over 600 LOC | 0 | 0 |

Functions are function-like declarations with bodies excluding constructors
and accessors. Branch nodes are `if`, ternary, `case`, loops, `catch`, `&&`, and
`||`; `??` and default clauses are excluded. Runtime cycles exclude type-only
imports.

### Runtime import cycles

1. `include-builder.ts` → `include-many-to-many.ts` → `select-builder.ts`
   (one three-file strongly connected component).
2. `relation-filter-builder.ts` ↔ `where-builder.ts`.
3. One eight-file nested-write component:
   `interpret-connected-update.ts`, `interpret-create-family.ts`,
   `interpret-m2m-membership.ts`, `interpret-m2m-update.ts`,
   `interpret-m2m.ts`, `interpret-update-family.ts`,
   `interpret-update-relations.ts`, and `interpret-upsert-family.ts`.

### Files over 300 LOC

| File | LOC |
| --- | ---: |
| `builders/correlation-utils.ts` | 315 |
| `builders/include-builder.ts` | 376 |
| `builders/many-to-many-utils.ts` | 333 |
| `builders/relation-data-builder.ts` | 399 |
| `builders/relation-filter-builder.ts` | 513 |
| `builders/select-builder.ts` | 416 |
| `builders/values-builder.ts` | 341 |
| `builders/where-builder.ts` | 531 |
| `executor.ts` | 419 |
| `operations/bulk-create.ts` | 374 |
| `operations/groupby-having.ts` | 328 |
| `operations/groupby.ts` | 303 |
| `operations/mutation-returns.ts` | 539 |
| `operations/nested-writes/interpret-connected-update.ts` | 327 |
| `operations/nested-writes/interpret-create-family.ts` | 493 |
| `operations/nested-writes/interpret-m2m-delete.ts` | 363 |
| `operations/nested-writes/interpret-relation-removals.ts` | 519 |
| `operations/nested-writes/interpret-shared.ts` | 365 |
| `operations/nested-writes/interpret-update-family.ts` | 399 |
| `operations/nested-writes/interpret-upsert-family.ts` | 490 |
| `operations/nested-writes/legality.ts` | 429 |
| `operations/nested-writes/live-mode.ts` | 562 |
| `operations/nested-writes/own-write-ledger.ts` | 316 |
| `operations/nested-writes/own-write-tree.ts` | 424 |
| `operations/nested-writes/planned-mode.ts` | 565 |
| `operations/nested-writes/semantic-plan.ts` | 346 |
| `result-flow.ts` | 328 |
| `result/scalar-result-parser.ts` | 474 |
| `types.ts` | 462 |

## Frozen `PendingOperation` contract

`tests/query-engine/pending-operation-contracts.test.ts` names and locks:

- lazy validation and execution;
- one memoized execution across `then`, `catch`, `finally`, and `execute`;
- same-driver `executeWith` memoization;
- default-after-driver, driver-after-default, and different-driver conflicts;
- `prepare`, `prepareBatch`, and unavailable-preparation behavior;
- `canBatch`, `isBatchOperation`, raw arguments, model, operation, client
  identity, immutable attribution, and `parseResult`;
- immutable `wrapExecutor` decoration with driver forwarding;
- mutation-only cache invalidation after successful execution, and preservation
  of the original mutation failure without invalidation;
- root and `viborm/client` `PendingOperation` exports and the type-level
  `QueryMetadata` export.

Existing instrumentation suites remain the oracle for `observeBatchPhase`,
native-batch attribution, logging isolation, and typed driver error mapping.

## Program-equivalence oracles

- `operation-equivalence-oracles.test.ts` freezes complete SQL text and ordered
  parameters for one representative read and ordinary write on PostgreSQL,
  MySQL, and SQLite adapters.
- `request-result-shape-contracts.test.ts`,
  `result-parser-contracts.test.ts`, `scalar-result-contracts.test.ts`, and
  `count-result-carrier.test.ts` freeze scalar, relation, deep include,
  aggregate, group-by, count, omitted-field, and private-carrier results.
- `nested-write-conformance.test.ts` runs every registered nested scenario
  through transaction and atomic-batch modes and requires identical rejection,
  typed error, and persisted state.
- `m7-error-surface.test.ts` and `m8-race-retry.test.ts` freeze typed failures,
  raceability classification, retry limits, and final surfaced causes.
- The provider driver suites remain the executable portability oracle; no
  provider-specific expected failure is accepted.

## Migration gates

`operation-program-migration-registry.ts` exhaustively marks all 16 operation
kinds as `legacy` at this baseline. A later phase must change an operation to
`migrated` in the same change that names its owning program files, forbidden
legacy imports, and forbidden legacy routing tokens.

`operation-program-architecture-gates.test.ts` enforces:

- every operation is classified;
- migrated owners cannot import their named legacy implementation;
- migrated operations cannot retain their named executor route;
- runtime modules cannot import `compiler/relations`;
- operation-program vocabulary stores data, not arbitrary callbacks;
- runtime capability selection occurs in at most one module,
  `OperationRuntime.ts`.

Synthetic migrated-operation fixtures prove that forbidden legacy-owner imports
and retained executor routes are detected while the real registry remains
all-legacy. Additional detector fixtures cover relation compiler imports,
re-exports, dynamic imports, and callback-bearing program nodes.

## Performance baseline

Command:

```bash
pnpm vitest bench --run operation-lifecycle --reporter=verbose
```

| Path | Mean | Throughput | RME |
| --- | ---: | ---: | ---: |
| Create deferred one-step read | 0.0005 ms | 2,175,060 Hz | ±2.76% |
| Prepare deferred one-step read | 0.0046 ms | 216,703 Hz | ±0.59% |
| Execute direct write | 0.0196 ms | 50,939 Hz | ±4.41% |
| Execute non-`RETURNING` write | 0.6613 ms | 1,512 Hz | ±2.40% |
| Execute nested relation write | 0.0763 ms | 13,107 Hz | ±2.87% |

These are local comparative baselines, not product latency promises. The direct
and nested writes use in-memory SQLite; non-`RETURNING` emulation uses in-memory
PGlite with `RETURNING` disabled at the adapter boundary.

Vitest/tinybench does not expose stable per-benchmark allocation counts, and
this run was not started with an isolated heap-profiler process. Allocations
are therefore recorded as unavailable rather than inferred from noisy global
heap deltas. Later phases should use heap profiles if object expansion is
suspected and must compare the same five benchmark paths.

## Baseline verification

| Command | Result |
| --- | --- |
| `pnpm type-check` | passed |
| `pnpm vitest run tests/query-engine/` | 45 files, 878 passed |
| `pnpm test:pglite` | 418 passed |
| `pnpm test:sqlite` | 734 passed |
| `pnpm test:mysql` | 354 passed against disposable MySQL 8 |
| `pnpm test:pg` | 287 passed, 14 optional pgvector tests skipped against disposable PostgreSQL 17 |
| `pnpm test:gates` | 11 passed |
| `git diff --check` | passed |

PostgreSQL and MySQL were rerun against newly created, isolated databases on
ports 55432 and 53307. Only those disposable databases were reset; both
containers were removed afterward. Pre-existing containers on ports 5434 and
3307 were not modified.
