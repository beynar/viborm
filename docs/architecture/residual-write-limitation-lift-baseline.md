# Residual Write-Limitation Lift Baseline

**Date:** 2026-08-13

**Branch:** `by-relation-bearing-bulk`

**Starting commit:** `2b1cb0d0efb66db1ca3d5a52a4abae4f1077b9ce`

**Plan:**
[residual-write-limitation-lift-plan.md](residual-write-limitation-lift-plan.md)

## Repository state

The only dirty files at baseline are the task's planning artifacts:

~~~text
M  CONTEXT.md
M  docs/architecture/relation-bearing-bulk-round-trip-plan.md
?? docs/architecture/residual-write-limitation-lift-plan.md
~~~

No pre-existing production or test change overlaps the implementation.

## Write-engine structure

Measured with `node scripts/query-engine-structure.mjs`:

| Metric | Baseline |
|---|---:|
| TypeScript files | 36 |
| Physical lines | 26,285 |
| Token-bearing lines | 19,286 |
| Functions | 987 |
| Branch nodes | 1,915 |
| Runtime import-cycle components | 0 |
| Runtime files in cycles | 0 |

## Refusal census

`rg -n "new UnsupportedOperationError" src/query-engine/write-engine/*.ts`
finds 13 construction sites:

| Owner | Sites |
|---|---:|
| `CreateOperation` | 3 |
| `OperationExecutor` | 1 |
| `RecordUpdateCompiler` | 5 |
| `RelationJunctionPart` | 1 |
| `RelationUpsertPart` | 2 |
| `UpsertOperation` | 1 |
| **Total** | **13** |

The executable inventory test owns their invariant classification. This file
owns only the numerical starting point.

## Type-check baseline

All four runs used the repository's memory-capped `pnpm test:types` launcher
and exited successfully. The first run is a warm-up.

| Run | Wall seconds |
|---|---:|
| Warm-up | 18.31 |
| Warm 1 | 17.84 |
| Warm 2 | 18.00 |
| Warm 3 | 17.80 |

**Warm median:** 17.84 seconds.

**Five-percent ceiling:** 18.73 seconds.

## Fixed comparisons

Every package compares against this starting architecture:

- existing accepted SQL text and parameter order;
- planning and final step IDs;
- statement outputs;
- guards, expectations, race pins, and retry attribution;
- statement and driver-call counts;
- public result shape and exact error diagnostics;
- zero write-engine runtime import cycles.

Newly accepted shapes may add the statements required to express their meaning.
Existing accepted shapes may not regress.
