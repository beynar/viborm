# G4-03 brief — client lifecycle and public type integration

Read `common.md` first. You are the sole production author for this unit.

## Where you work

Main tree **`/Users/arnaud/code/viborm`**. Another stream (the independent
witness author) is concurrently adding files under `tests/raptor3/g4/` and
editing `scripts/raptor3-manifest.mjs`, `scripts/run-raptor3.mjs`,
`scripts/raptor3-campaign-receipts.test.mjs`, `scripts/raptor3-cli.test.mjs`.
The G4-01 author edits `src/query-engine/raptor3/shared/query.ts`,
`shared/schema.ts` and `commands/index.ts` in a separate worktree; the copies
in this tree are the frozen G3 versions and will be replaced by its patch
later. Do not edit any of those files.

Evidence directory:
`/Users/arnaud/code/viborm/docs/architecture/raptor3-evidence/g4/unit03/`.
Write `note.md`, receipts and your final `production.patch` there.

## Files you own

- New candidate-owned route module(s) under `src/query-engine/raptor3/route/`
  (create the directory). Keep the candidate's private `execute`/`prepareBatch`
  boundary; the route adapts the existing client protocol to it.
- The **minimal** seam in the existing owners, only as strictly required:
  `src/query-engine/query-engine.ts`, `src/query-engine/pending-operation.ts`,
  `src/query-engine/write-engine/OperationExecutor.ts`, `src/client/client.ts`
  and its transaction/array files. Every line you add there must be explained
  in `note.md`; the shipped default route must remain behaviorally identical
  (the existing client suites are your falsifier).
- Tests: `tests/raptor3/g4/route-*.test.ts` (C13 lifecycle oracles through the
  private route) and public type probes under `tests/types/raptor3/`
  (see `tests/types/client/contextual-typing-gate.core.types.ts` for the
  probe discipline: enter through real public syntax, typo beside a real key
  at every nesting level, variable-held inputs, `@ts-expect-error` that must
  stay used). Send registration requests (file, expected test count, native
  or credential-free, project) to the witness author through your `note.md`
  section "Registration requests"; do not edit the manifest yourself.

## Outcome

Complete C13 (inventory LX-01–LX-18, NS-03–NS-05, RF-09/RF-10) through the
candidate **without switching the shipped client route**:

1. A private, non-public way to construct a client (or engine) whose model
   operations execute through `createCommandEngine` while reusing, unchanged:
   lazy `PendingOperation` memoization and once-only preparation (LX-01),
   request transforms and default omit (LX-09, LX-11), the extension chain
   and its exact ordering/collision errors (LX-10), query interceptors with
   `proceed()` authority (LX-12), statement transforms and observation
   (LX-13), official cache read/write/invalidation rules and bypasses (LX-07,
   LX-08, RF-10, NS-04), raw bypass (LX-05, LX-06, NS-03), callback, nested
   and array transactions through the existing owners (LX-02–LX-04, RF-09,
   NS-05), observers (LX-14, LX-15), connect/disconnect/dispose and
   introspection (LX-16, LX-17), and the canonical public types (LX-18).
2. **No duplicated admission.** Determine exactly where the shipped route
   validates the payload today (`PendingOperation`/executor/schema registry)
   and ensure the candidate route admits each input exactly once through the
   candidate's `EngineSchema.admit` (which reuses the same registry schemas).
   Request transforms and client omit still run before admission, once.
3. **Binding mapping.** A callback/nested transaction supplies the exact
   transaction driver → candidate `borrowed-transaction` binding with the
   existing `memberRollback` capability only where the existing owner grants
   it. An array transaction composes `prepareBatch` packages through the
   existing array owner or its sequential fallback; the candidate never owns
   lifecycle, savepoints or replay. `atomic-array` refusal stays a refusal
   before admission.
4. **Result and error identity.** Results published to the client are the
   candidate's decoded results (fresh containers); errors keep their existing
   public identities (`ValidationError`, `QueryEngineError`, `TransactionError`,
   not-found, capability refusals). Lifecycle observers must receive the same
   unit kinds (operation, statement, batch, transaction, savepoint, segment,
   connection, cache) as today; a missing event must fail your oracle.
5. **Unsupported verbs.** Until G4-01/G4-02 land, the candidate refuses
   `findFirst`, `count`, `aggregate`, `exist`, `delete` and the `OrThrow`
   forms. Your route must surface those refusals unchanged (never fall back
   to the shipped engine). Write your lifecycle oracles against the verbs the
   frozen candidate already supports (`create`, `createMany`, `update`,
   `upsert`, `updateMany`, `deleteMany`, `findMany`, `findUnique`, `groupBy`)
   and leave clearly marked pending cases for the rest.
6. **Design for cutover.** Shape the seam so that the future C-01 cutover diff
   is: flip the default selection and delete the old executor path. Do not
   perform that flip. Document in `note.md` the exact lines a cutover would
   change and what it would delete.
7. **Benchmark reachability.** The performance protocol runs public client
   workloads from the built package (`benchmarks/operation-pipeline-fixtures.mjs`
   imports `../dist/index.mjs`). Explain in `note.md` how a candidate-only
   package (cutover applied in an isolated worktree) would be built for the
   comparison; do not add an environment-variable switch to shipped code.

## Method

1. Reconcile LX rows against current source: read `src/client/client.ts`
   `prepareModelOperation` and `withCache`, `src/query-engine/query-engine.ts`,
   `src/query-engine/pending-operation.ts` (how `#executor()`, `#resolveOperation`,
   `buildStatement`, `prepareBatch`, cache keys and instrumentation facts are
   produced), `write-engine/OperationExecutor.ts` `execute`/`prepareSharedBatch`,
   `src/query-engine/transaction-operation.ts`, the array-transaction files, and
   the cited shipped suites for each LX row. Read the candidate's
   `commands/index.ts`, `shared/operation-context.ts` (`ExecutionBinding`,
   `run`, `preparedBatch`, `isIncompletePreparation`) and the G3 tests that
   already exercise borrowed bindings and array packaging
   (`tests/raptor3/g3/transaction-array-contract.test.ts`,
   `tests/raptor3/ownership/*.test.ts`, `tests/raptor3/prep/set-preparation.test.ts`).
2. Write `note.md` (decision-elimination gate) before the first production
   edit: required behavior, current owner, smallest change, what disappears
   (expected: nothing in the shipped route until cutover; inside the
   candidate, the direct-driver test entry stops being the only lifecycle),
   and the invariant that keeps admission single.
3. Implement the route and the oracles. Existing client suites that must stay
   green (run the most relevant ones, not the whole estate):
   `tests/contracts/public-client/pending-operation*.test.ts`,
   `extensions-foundation.core.test.ts`, `request-transforms.core.test.ts`,
   `query-interceptors*.core.test.ts`, `statement-transforms-integration.core.test.ts`,
   `official-cache-reads.test.ts`, `official-cache-invalidation.test.ts`,
   `nested-transaction-contract*.test.ts`, `batch-transaction.test.ts`,
   `array-transaction-legacy-batch-boundaries.core.test.ts`,
   `raw-sql.test.ts`, `protected-driver-lifecycle-observers.core.test.ts`,
   `client-construction-boundaries.core.test.ts`, `schema-introspection.core.test.ts`.
   Run through `node scripts/run-vitest-safe.mjs run <files>`; save JSON
   receipts and resource lines. Run `node scripts/run-typecheck.mjs` before
   hand-off; the type probes are part of that check.
4. Measure cost: the route module and every added line in shipped files are
   charged to the candidate perimeter (report file, LOC, tokens, bytes via
   `node scripts/query-engine-structure.mjs` conventions).
5. Hand off: `production.patch` (git diff of your files), `note.md` with the
   four §7 answers, registration requests, cutover-diff description, blockers,
   unverified claims.

## Exit and return value

Return a structured summary: unit, patch path, note path, files changed with
line deltas, LX/NS/RF rows covered / pending with reasons, tests written
(paths, counts), suites run with pass/fail and receipt paths, typecheck
result, cost figures, removed decisions, added rules, registration requests,
cutover-diff description, blockers, unverified claims.
