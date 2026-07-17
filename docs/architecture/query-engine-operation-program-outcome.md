# Query Engine Operation Program — Final Outcome

Captured on 2026-07-13 after Phase 11 of
`query-engine-operation-program-implementation-plan.md`.

## Architecture outcome

The query engine now has one operation lifecycle and one execution language:

```text
QueryEngine
  -> PendingOperation
    -> validation
    -> OperationCompiler
      -> OperationProgram
        -> OperationRuntime or OperationBatchRuntime
          -> Driver
            -> OperationResults
```

- `QueryEngine` owns the client-scoped driver, model/schema registry,
  instrumentation, client identity, and transaction-scope identity. Binding a
  transaction driver preserves the client lineage and creates a new scope.
- `PendingOperation` is the only deferred lifecycle object. It preserves lazy
  validation, Promise-like memoization, preparation, instrumentation, cache
  invalidation, and explicit program inspection through `compile()`.
- Every accepted operation compiles to data-only `OperationProgram` steps.
  Programs contain no arbitrary callbacks, context bags, or SQL AST duplicate.
- `OperationCompiler` and `WriteOperations` own relation meaning. Runtime
  modules execute program vocabulary and do not import relation semantics.
- `OperationRuntime` is the sole runtime capability selector. Dynamic branches
  are specialized by `OperationBatchRuntime` without changing their meaning.
- SQL construction remains adapter-backed. `QueryEngine.build()` inspects only
  a genuine single-statement program and rejects multi-step programs instead of
  pretending they are one statement.
- `OperationResults` owns provider middleware selection and parser identity.
  Result parsing remains strict: missing, malformed, or ambiguous provider
  results fail explicitly rather than becoming plausible defaults.

`QueryMetadata<T>` remains a deprecated type-only alias of
`PendingOperation<T>` through the next published compatibility release. It is
not a runtime object and carries no callback or closure metadata.

## Structural outcome

The structural figures are informational under the 2026-07-13 execution
override. They were not used to trade away correctness or interoperability.

| Metric | Phase 0 | Phase 10 | Final | Phase 0 -> final |
| --- | ---: | ---: | ---: | ---: |
| TypeScript files | 121 | 94 | 91 | -30 |
| Physical LOC | 24,204 | 22,112 | 22,073 | -2,131 |
| Functions | 932 | 983 | 984 | +52 |
| Function parameters | 2,291 | 2,089 | 2,095 | -196 |
| Functions with at least five parameters | 123 | 68 | 66 | -57 |
| Branch nodes | 2,340 | 2,408 | 2,409 | +69 |
| Runtime import cycle components | 3 | 2 | 0 | -3 |
| Runtime files participating in cycles | 13 | 5 | 0 | -13 |
| Files over 300 LOC | 29 | not recorded | 31 | +2 |
| Files over 600 LOC | 0 | 0 | 0 | 0 |

The final query engine contains 568 TypeScript import declarations. Phase 0 did
not record imports, so no baseline import delta is claimed.

The original at-most-70-file target was not reached. Reaching it mechanically
would require merging independent relation-analysis, relation-mutation,
runtime, and SQL concerns. The final 91-file roster instead removes the 44-file
nested-write subsystem, every runtime import cycle, and the duplicate lifecycle
without recreating large mixed-concern modules. Branch count rose by 69 because
formerly implicit nested-write mode behavior is now represented by explicit,
fail-closed program and result contracts. High-arity functions fell by 46%.

## Deleted migration and legacy paths

The following temporary or replaced paths are absent:

- `tests/query-engine/operation-program-migration-registry.ts`
- `src/query-engine/operation-builder.ts`
- `src/query-engine/BulkWritePrograms.ts`
- `src/query-engine/executor.ts`
- `src/query-engine/transaction-flow.ts`
- `src/query-engine/result-flow.ts`
- `src/query-engine/context/query-context.ts`
- `src/query-engine/context/alias-generator.ts`
- the entire `src/query-engine/operations/nested-writes/` directory
- the old nested-write detector and architecture gate

Phase 11 also consolidated result parsing by deleting
`result/result-parser.ts`, `result/result-parser-chain.ts`, and
`result/count-value.ts`. Their surviving behavior belongs to
`result/ResultParser.ts` and `result/result-count-parser.ts`.

Intermediate relation micro-files removed after consolidation include
`OwnWriteBranches.ts`, `OwnWriteTarget.ts`, `RelationKeyUpdates.ts`,
`RelationMembershipScope.ts`, `RootMembershipFootprint.ts`,
`TargetPredicateFootprint.ts`, and `ToOneUpdateFootprint.ts`. Their semantics
now live in the cohesive compiler owner that consumes them.

The read and write migration verification suites became permanent regression
contracts and were renamed to `operation-program-read-contracts.test.ts` and
`operation-program-write-contracts.test.ts`. No temporary runtime route remains.

## Final ownership rosters

### Relation and write compiler

```text
OperationCompiler.ts
WriteOperations.ts
WritePrograms.ts
MutationStatements.ts
ManyToManyMemberships.ts
ManyToManyMutations.ts
ManyToManyStatements.ts
OwnWriteAnalyzer.ts
OwnWriteLedger.ts
OwnWriteRelation.ts
OwnWriteSteps.ts
RelationBranches.ts
RelationCaptures.ts
RelationMembership.ts
RelationMutationPlan.ts
RelationMutationValidation.ts
RelationMutations.ts
RelationProgramValues.ts
RelationRemovals.ts
RelationUpdates.ts
RelationUpserts.ts
TargetConstraint.ts
```

### Runtime

```text
OperationRuntime.ts
OperationBatchRuntime.ts
```

### Results

```text
OperationResults.ts
result/ResultParser.ts
result/result-parser-contract.ts
result/result-shape.ts
result/result-row-parser.ts
result/scalar-result-parser.ts
result/scalar-blob-parser.ts
result/scalar-structured-parser.ts
result/relation-result-parser.ts
result/relation-count-parser.ts
result/result-aggregate-parser.ts
result/result-count-parser.ts
```

## Large-file review

No source file exceeds 600 LOC. Each file above the 300-LOC smell threshold
retains one cohesive concern:

| File | LOC | Retained concern |
| --- | ---: | --- |
| `ManyToManyMemberships.ts` | 320 | Compile junction membership reads and differences. |
| `ManyToManyMutations.ts` | 593 | Compile the complete many-to-many mutation family. |
| `ManyToManyStatements.ts` | 320 | Materialize junction relation statements. |
| `OperationBatchRuntime.ts` | 543 | Specialize and execute one program on an atomic batch substrate. |
| `OperationRuntime.ts` | 550 | Select one execution capability and run one program lifecycle. |
| `OwnWriteLedger.ts` | 330 | Track write footprints and dependency conflicts. |
| `OwnWriteRelation.ts` | 327 | Analyze relation-local write effects. |
| `OwnWriteSteps.ts` | 510 | Compile relation write inputs into ordered program steps. |
| `RelationBranches.ts` | 434 | Compile conditional relation alternatives. |
| `RelationMutationPlan.ts` | 347 | Represent and validate the relation mutation plan. |
| `RelationMutations.ts` | 481 | Orchestrate relation mutation compilation. |
| `RelationRemovals.ts` | 348 | Compile disconnect and delete relation semantics. |
| `RelationUpdates.ts` | 406 | Compile relation update and update-many semantics. |
| `TargetConstraint.ts` | 521 | Prove target identity and predicate constraints. |
| `WriteOperations.ts` | 509 | Own write-operation and relation semantic entry points. |
| `WritePrograms.ts` | 421 | Compose root writes into complete operation programs. |
| `builders/correlation-utils.ts` | 311 | Build adapter-backed relation correlations. |
| `builders/include-builder.ts` | 339 | Build include SQL and nested selection entry points. |
| `builders/many-to-many-utils.ts` | 339 | Build adapter-backed junction SQL primitives. |
| `builders/relation-data-builder.ts` | 399 | Separate scalar and relation write input. |
| `builders/relation-filter-builder.ts` | 470 | Build correlated relation-filter SQL. |
| `builders/select-builder.ts` | 484 | Build scalar and relation selection SQL. |
| `builders/values-builder.ts` | 341 | Build insert value rows and generated values. |
| `builders/where-builder.ts` | 568 | Build scalar, logical, and relation-aware predicates. |
| `operation-program.ts` | 505 | Define and validate the single data-only program vocabulary. |
| `operations/groupby-having.ts` | 328 | Build grouped HAVING predicates. |
| `operations/groupby.ts` | 303 | Build group-by operation SQL. |
| `operations/mutation-identity.ts` | 422 | Capture and refetch mutation identity. |
| `relation-preflight.ts` | 371 | Fail closed on unsupported relation mutation shapes. |
| `result/scalar-result-parser.ts` | 474 | Parse every scalar result contract. |
| `types.ts` | 393 | Define the query-engine public and boundary types. |

The classes with more than ten methods were reviewed by distinct concern, not
method count alone: `PendingOperation` exposes the stable deferred/Promise-like
contract; `OperationRuntime` owns one execution lifecycle; `OwnWriteLedger`
owns one dependency ledger; `OwnWriteRelation` owns one relation-analysis
facade; and `RelationMutations` owns one relation compiler orchestration
boundary. Splitting them would introduce forwarding children or context bags
without removing a concern.

## Verification

| Command | Result |
| --- | --- |
| `pnpm type-check` | passed after final residue cleanup |
| `pnpm test` | 172 files passed, 3 provider files skipped; 5,447 tests passed, 663 skipped |
| permanent read/write contracts plus architecture gates | 41 passed after test rename |
| `pnpm test:gates` | 18 passed |
| `pnpm test:pglite` | 421 passed |
| `pnpm test:sqlite` | 740 passed across SQLite and LibSQL |
| `pnpm test:mysql` | 357 passed against the existing MySQL 8 service |
| `pnpm test:pg` | 292 passed; 14 pgvector-only tests skipped |
| `pnpm package:build` | passed; existing optional Bun resolution warning only |
| `pnpm test:package:phase7` | package build and both packed smoke tests passed |
| `pnpm --dir docs build` | passed; existing TanStack deprecation and bundle-size warnings only |
| scoped Biome | 23 Phase 11 code and test files passed |
| `pnpm bench:compare` | passed; the post-matrix run was host-load skewed, so lifecycle paths were rerun in isolation |
| independently repeated operation-lifecycle benchmark | deferred read creation 1,879,137 Hz; preparation 199,990 Hz; direct write 50,012 Hz; non-returning write 1,426 Hz; nested relation write 10,575 Hz |
| `git diff --check` | passed |

PostgreSQL and MySQL used the existing dedicated test containers on ports 5434
and 3307. Their connection settings were derived without printing credentials.
The containers were not recreated, reset, or removed.

## Residual risks

- Pgvector-specific coverage remains unavailable because no
  `PGVECTOR_TEST_CONNECTION_STRING` service is configured.
- The 91-file result misses the original aesthetic target even though it is 30
  files below Phase 0. Further compression should follow observed shared
  concerns, not a file quota.
- Branch nodes are slightly above Phase 0. The new architecture makes dynamic
  and failure behavior explicit; future branch reduction must preserve the
  same fail-closed and cross-provider contracts.
- The full benchmark comparison immediately after the provider matrix was
  host-load skewed: raw SQLite controls fell by 27–48% as well. The exact Phase
  0 lifecycle command independently rerun in isolation measured deferred read
  creation at 1,879,137 Hz (-14% throughput), preparation at 199,990 Hz (-8%),
  direct write at 50,012 Hz (-2%), non-returning write at 1,426 Hz (-6%), and
  nested relation write at 10,575 Hz (-19%). The direct paths remain
  proportionate; the nested-path difference is retained as a visible
  optimization target rather than weakening its semantics.
- `QueryMetadata<T>` remains intentionally until one published compatibility
  window has elapsed.
- Contributor `AGENTS.md` files still contain historical vocabulary. They were
  not changed because repository instructions prohibit modifying agent
  configuration files.
