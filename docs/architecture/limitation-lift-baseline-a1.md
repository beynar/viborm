# Limitation-lift baseline (Package A, unit A1)

Pinned baseline for `docs/architecture/limitation-lift-plan.md` §6 Package A, unit
A1. Every number below is a measurement taken at the commit named here. Later
packages compare against this file; §8.4 compares its type-check median against
it.

## 1. Repository state

| Item | Value |
| --- | --- |
| Branch | `by-query-engine-limitation-lift` |
| HEAD | `59eb97fab44b806a6043949f8295f38a46f5ac74` |
| Starting commit of the plan | `2ca32ad4` |
| Dirty files | `tests/contracts/public-client/client.ts` (modified, unrelated user work) |
| Untracked files | none at measurement time |

```bash
git status --short
git rev-parse HEAD
git rev-parse --abbrev-ref HEAD
```

The single dirty file is a test file. It overlaps no planned production edit, so
the plan's stop condition (A1.4) does not fire.

## 2. Refusal inventory

The tracked census is the throw-site count of `new UnsupportedOperationError(`
across `src/query-engine/write-engine/*.ts`.

| Source | Value |
| --- | --- |
| Pinned in `tests/contracts/engine/write/operation-construction-inventory.test.ts:2145` | 31 |
| Measured in the tree | 31 |

```bash
grep -o "new UnsupportedOperationError(" src/query-engine/write-engine/*.ts | wc -l
```

The pin and the tree agree. No mismatch to report.

### Distribution by owner

| File | Sites |
| --- | --- |
| `RecordUpdateCompiler.ts` | 11 |
| `CreateOperation.ts` | 8 |
| `RelationUpsertPart.ts` | 5 |
| `RelationJunctionPart.ts` | 3 |
| `RelationWritePart.ts` | 2 |
| `UpsertOperation.ts` | 1 |
| `nested-target-parts.ts` | 1 |
| **Total** | **31** |

The remaining 24 write-engine files hold zero sites, including
`UpdateOperation.ts`, `DeleteOperation.ts`, `CreateManyOperation.ts`,
`BulkCountOperation.ts`, and `ManyAndReturnOperation.ts`.

### Site locations

```
CreateOperation.ts:884, 1378, 1647, 1687, 1968, 1998, 2052, 2737
RelationJunctionPart.ts:1348, 1813, 2314
RelationUpsertPart.ts:746, 1062, 1209, 1261, 1302
RelationWritePart.ts:601, 1046
RecordUpdateCompiler.ts:1253, 1324, 1347, 1495, 1670, 1877, 1956, 2631, 3084, 3161, 4116
UpsertOperation.ts:1134
nested-target-parts.ts:190
```

### Stale plan references

The plan's census narrative names sites by owner and line number that no longer
exist. `UpdateOperation` :1456, :2671, and :3184 and `nested-target-parts` :424
have no current counterpart at those coordinates; `UpdateOperation.ts` holds no
refusal site at all today. The selected-record refusals now live in
`RecordUpdateCompiler.ts`. Treat the table above as the current owner map and the
plan's line numbers as historical.

The single remaining route to the frozen engine, pinned separately in the same
file, is `createMany` with `select` plus `skipDuplicates` on non-returning
drivers.

## 3. Production LOC — `src/query-engine`

| Metric | Value |
| --- | --- |
| TypeScript files | 115 |
| Physical LOC | 39 022 |
| Token-bearing LOC | 30 196 |
| Functions | 1 489 |
| Branch nodes | 3 510 |
| Files over 300 lines | 39 |
| Files over 600 lines | 11 |

`src/query-engine/write-engine` alone:

| Metric | Value |
| --- | --- |
| TypeScript files | 31 |
| Physical LOC | 20 983 |
| Token-bearing LOC | 16 051 |
| Functions | 785 |
| Branch nodes | 1 592 |

Commands:

```bash
# physical
find src/query-engine -type f -name '*.ts' -print0 | xargs -0 wc -l | tail -1

# token-bearing (blank and comment-only lines removed)
find src/query-engine -type f -name '*.ts' -print0 | xargs -0 cat \
  | grep -vE '^[[:space:]]*$' \
  | grep -vE '^[[:space:]]*(//|/\*|\*|\*/)' | wc -l

# authoritative repository census (parser-owned token lines)
node scripts/query-engine-structure.mjs
```

Both token-bearing methods return 30 196. The repository census is the owner of
this definition — it counts physical lines on which at least one parser-owned
TypeScript token starts — and is the number later packages must reproduce.

## 4. Write-engine runtime import cycles

`package.json` declares no cycle script and `madge` is not installed, but the
repository already owns this measurement: `scripts/query-engine-structure.mjs`
computes strongly connected components of runtime-only imports internal to the
measured directory, and `tests/contracts/engine/write/architecture-gates.core.test.ts`
consumes its `writeEngine.runtimeImportCycles` field. That script is the tool of
record here; `npx madge` was not used.

| Scope | Cycle components | Files in cycles |
| --- | --- | --- |
| `src/query-engine/write-engine` | 0 | 0 |
| `src/query-engine` (whole layer) | 1 | 6 |

The write-engine figure is the one §9 gates at zero, and it is zero.

The one whole-layer component is pre-existing and lives entirely in
`builders/`, outside the write engine:

```
builders/correlation-utils.ts
builders/many-to-many-utils.ts
builders/relation-data-builder.ts
builders/relation-filter-builder.ts
builders/where-builder.ts
builders/where-unique-builder.ts
```

## 5. Type-check medians

Four sequential `pnpm test:types` executions: one warm-up, then the three warm
runs the plan asks for. All exited 0.

| Run | Seconds |
| --- | --- |
| warm-up | 16.77 |
| warm 1 | 16.71 |
| warm 2 | 16.71 |
| warm 3 | 16.87 |

**Median: 16.71 s.** The §8.4 non-regression ceiling of five percent is
**17.55 s**.

## 6. Baseline gates

Run sequentially, one process at a time, through the repository's memory-capped
launchers.

| Command | Result | Seconds | Detail |
| --- | --- | --- | --- |
| `pnpm test:types` | pass | 16.71 (median of 3) | — |
| `pnpm test:layer:query-engine` | pass | 7.04 | 44 files, 784 tests |
| `pnpm package:build` | pass | 2.87 | tsdown; the `bun` specifier is externalized, as before |
| `pnpm test` | pass | 55.68 | type-check plus 213 files, 4944 tests |

No substitutions were needed: every script the plan names exists in
`package.json` under that exact name.

**The baseline is green.** Package A may proceed to A2.
