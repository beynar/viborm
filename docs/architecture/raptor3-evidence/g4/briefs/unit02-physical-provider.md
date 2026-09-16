# G4-02 brief — complete the physical/provider envelope

Read `common.md` first. You are the sole production author for this unit.
This brief is revision 1; the "Handoff realization" section is bound to the
G4-01 handoff revision named in your prompt. Read that handoff completely
before your first edit.

## Where you work

Main tree **`/Users/arnaud/code/viborm`**, after the accepted G4-01 patch has
been applied by the integrator (verify: `git diff --stat` shows the G4-01
files changed and `g4/unit01-review.md` or its follow-up says ACCEPT). The
witness author may still be editing `tests/raptor3/g4/**` and the manifest;
the G4-03 author may still be editing `src/query-engine/raptor3/route/` and
its seams. Do not edit any of those.

Evidence directory:
`/Users/arnaud/code/viborm/docs/architecture/raptor3-evidence/g4/unit02/`.
Write `note.md`, receipts and your final `production.patch` there.

## Files you own

- `src/query-engine/raptor3/shared/operation-context.ts` (primary).
- `src/query-engine/raptor3/commands/execution.ts`.
- `src/query-engine/raptor3/shared/query.ts` — **writer transferred to you**
  from G4-01 at the start of this unit; keep its prepared-selector /
  prepared-projection / decoder ownership intact and extend only where the
  physical realization requires it. `Queries.updateValue` is the sole scalar
  update owner: extend it for the remaining operators; never add JavaScript
  arithmetic in the context.
- `src/query-engine/raptor3/commands/commands.ts`, `relation-body.ts`,
  `assignments.ts`, `selection.ts` only for root `delete` construction and
  its relation-action requirements (reuse the existing `Deletion` command
  and selected-series deletion; do not add a verb interpreter).
- `src/query-engine/raptor3/commands/index.ts` for the `delete` verb gate.
- Exact adapter/driver seams named in your note when a provider genuinely
  lacks a spelling the handoff needs (`src/adapters/**`): smallest additive
  capability, with the adapter's own contract test extended in the same
  adapter test file family. Record every such edit.
- Author checks under `tests/raptor3/g4/unit02/`.

## Outcome

1. **Handoff realization.** Every physical obligation in the G4-01 handoff is
   implemented for the admitted profiles: relation carriers and nested
   pagination on SQLite, PostgreSQL (PGlite lowering now; native when a
   provider answers) and MySQL adapters; cursor/distinct/`_count`/distance
   lowering; scalar codec representations the decoder expects from each
   provider (DateTime, decimal, bigint, JSON, blob, vector, GeoPoint, lists,
   enums, booleans) at read and write crossings; malformed-row failures at
   the provider boundary with the established identities; `findFirst`,
   `count`, `exist`, `aggregate`, `OrThrow` cardinalities through
   `finishOne`/`finishMany`/`finishValue` and `read` without allocating write
   machinery for pure reads.
2. **Root `delete` (OP-W03).** Locate by extended-unique selector, apply
   relation actions through the existing deletion/removal owners, return the
   removed row projection (RETURNING where the adapter supports it, prepared
   projection plus the operation-owned locked capture on non-returning
   adapters), preserve not-found and relation-action error precedence, and
   package for `prepareBatch` where statically packageable. Reuse the
   selected-series deletion mechanism; add no per-verb path.
3. **Scalar update language completion (SC-03–SC-06 write side).** Extend
   `Queries.updateValue` with `decrement`, `multiply`, `divide` and the
   provider numeric semantics (int, float, bigint, decimal with the exact
   descriptor) so both mutation SQL and symbolic final-key expressions come
   from that one owner. Preserve the non-RETURNING simple/compound/decimal
   key-transition witnesses with keys omitted from the projection, including
   low bind caps. List updates (`set`/`push`/`unshift`) go through the
   existing whole-list value crossing (`fieldValue` → adapter list vocabulary).
4. **Provider profiles.** SQLite interactive and atomic-batch (Raptor
   profiles), scripted transport profiles TW/TA, PGlite, native PostgreSQL and
   MySQL. Non-returning adapters must reach every new result mode through the
   prepared-projection continuation without rebuilding SQL. Bind-budget
   partitioning stays in the existing `compileBindBudgetChunks` owner.
5. **Existing fast paths.** For the frozen scalar/bulk workloads
   (`scalar-find-unique`, `flat-scalar-update`, `bulk-update-returning-100`,
   `fixed-collection-rowref-20/1000`, `key-transition-cascade`,
   `nested-conditional-*`, `relation-series-2` in
   `benchmarks/operation-pipeline-catalog.mjs`), the candidate's physical
   statement and round-trip counts must not increase relative to the G3
   candidate; a pure single-statement read is one provider round trip with no
   transaction envelope and no scratch. Record the counts you observe in
   `note.md` with a witness that pins them.
6. **Recursive-read fit, native lowering.** `Queries.recursive` lowers through
   `adapter.subqueries.recursive` (or the exact capability the adapter
   exposes) on PGlite now and native PostgreSQL/MySQL when available, with
   the fuller codec set, depth-as-edges, path-local cycle stop, pruning and
   separate overlapping occurrences preserved. No query-per-depth, no finite
   include unrolling, no test-only traversal.
7. **Preserve every G3 contract.** Acknowledged progress, exact failed-INSERT
   recovery scope, borrowed-transaction non-authority, root-only completion,
   suppression regions, terminal-result cardinality, bulk set-orientation.

## Phasing and writer transfer (revision 3 of this brief)

The main tree already contains the G4-01 r4 production patch and the
accepted G4-03 seams. The G4-01 author is still repairing three narrow parity
items **inside `src/query-engine/raptor3/shared/query.ts` only** in its
worktree (round 3). Therefore:

- **Phase 1 (now):** you own `operation-context.ts`, `execution.ts`,
  `commands.ts`, `relation-body.ts`, `assignments.ts`, `selection.ts`,
  `commands/index.ts`, `shared/schema.ts`, `shared/storage.ts`,
  `program/index.ts` and assigned adapter seams. **Do not edit `query.ts`**
  in phase 1; where an obligation needs a `Queries` change, implement the
  context/execution side against the existing `Queries` surface and record
  the exact `query.ts` change you need in `note.md` under "Phase 2 queue".
- **Phase 2:** the integrator applies the round-3 increment to `query.ts`
  and transfers the writer role to you in writing (a line in
  `g4/unit02/note.md` "Writer transfer: query.ts at <identity>"). Only then
  do you edit `query.ts` (arithmetic in `updateValue`, delete projection
  details, native recursive lowering, refusal identities, D-1 predicate
  support). If the transfer has not happened when phase 1 is complete, stop
  and return with phase 1 evidence; do not wait idle.
- Start by running `node scripts/run-raptor3.mjs g4-read-contracts` and
  `g4-route-transactions`, `g4-lifecycle-events`, `g4-lifecycle-admission`
  on the main tree to record the exact red list you inherit (receipts under
  `g4/unit02/receipts/inherited/`). The witness stream's handoff
  (`g4/witness/handoff.md`) explains each red cell's reason.

## Regressions measured against the clean baseline (revision 5, 08:05) — phase-2 author and reviewer

Both were classified by the integrator on a clean `0cc61e61` worktree with
the same providers, so they are G4 regressions, not pre-existing reds:

- **`g2-mysql-contracts`**: 13/13 on clean HEAD
  (`g4/environment/g2-mysql-contracts-clean-0cc61e61.log`); on the current
  tree the three `tests/raptor3/transitions/unique-races-live-commands.test.ts`
  cells fail (witness follow-up §14.3). Unique-race recovery on native MySQL
  through the candidate is broken by a G4 change (suspects: the
  statement-atomic fold / envelope rule interacting with exact failed-INSERT
  recovery, the prepared boundary, or `operationRegion`). Reproduce with
  `VIBORM_RAPTOR3_PROVIDER=mysql VIBORM_RAPTOR3_PROVIDER_PORT=<port> node scripts/run-raptor3.mjs g2-mysql-contracts`,
  minimize, repair in the owning candidate file, and pin. The reviewer must
  run this mode on both providers.
- **`core-structure/measurement/extension-campaign.selftest`**: 42/42 on clean
  HEAD; 10 cells red now with `Missing semantic cut choice:found|missing/root-member/0`
  (`g4/environment/cs03-selftest-main-0705.log`). The observation cut of a
  root conditional member no longer appears. The author records, per plan
  §5.4, the concrete atomic strategy that eliminated the cut and the property
  checked at the surrounding cuts (in `note.md`), so the harness
  reconciliation unit can re-register or record the cut; if the cut merely
  moved or the engine regressed, say so with the trace.
- **`g3-generated-transport-smoke`**: 1/1 on clean HEAD; red now at the same
  cell as `g4-write-transport-seed-batch 100000` (unscripted `INSERT`): the
  scripted transport plans describe the old physical root-write shape. Record
  the new shape per recipe so the harness reconciliation can re-script it.

## Obligations added by the G4-01 and G4-03 reviews (revision 2 of this brief)

Read `g4/unit01-review.md` (+ follow-up), `g4/unit03-review.md` (+ follow-up),
`g4/unit03/note.md` §4 (blockers B-1…B-4) and §R.*, and `g4/witness/handoff.md`
before starting. These are yours:

8. **Prepared operation boundary (G4-03 blocker B-1).** `createCommandEngine`
   gains `prepare(modelName, operation, rawArgs)` returning one prepared handle
   `{ args, read?: { shape, single }, execute(binding?), prepareBatch() }`:
   admission happens exactly once in `prepare`, the read's prepared projection
   shape and cardinality are exposed for the client's cache key, cache result
   codec and interceptor input, and the two existing entries become callers of
   `prepare`. No second admission, no second projection. `commands/index.ts`
   is yours for this.
9. **Execution context threading (G4-03 blocker B-4).** The client's trusted
   `QueryExecutionContext` (which carries the resolved extension chain) must
   reach every candidate statement so statement transforms and observers see
   candidate statements exactly as they see shipped ones. Extend
   `ExecutionBinding`/`OperationContext` with the smallest context carrier;
   keep `attribution` facts intact.
10. **Schema reuse (G4-03 blocker B-3).** `EngineSchema` must be constructible
    from the client's already-resolved registry/index instead of re-hydrating
    and re-validating the schema per client (`shared/schema.ts` is yours).
11. **Statement-atomic fast path and conditional regions.** The candidate,
    not the route, decides the physical envelope after construction, in
    `OperationContext` (one owner, one rule):
    - standalone: an operation that lowers to exactly one physical statement
      (scalar-only create/update/delete on a RETURNING adapter, every pure
      read) runs with no BEGIN/COMMIT, exactly as the shipped
      `runStatementAtomic` path; anything else keeps its qualified route;
    - borrowed transaction: a single-statement operation runs directly on the
      borrowed driver (so a failure poisons the caller's transaction exactly
      as the shipped route does — G4-03 follow-up finding 9, divergence D-1);
      a multi-statement operation runs inside the `memberRollback` region the
      existing transaction owner supplies (savepoint rollback only for that
      member, caller's transaction stays usable — the shipped
      `runTransactionScope` behavior). The route must pass `memberRollback`
      as a capability the candidate invokes, never wrap every write itself
      (coordinate the route-side change with the integrator; the route file
      is G4-03's, and its author gets a bounded follow-up after your unit).
    This removes D-1 without a compatibility decision because it reproduces
    the shipped semantics; if a case cannot be mirrored, record it as a
    decision for Arnaud instead of choosing. Pin statement and round-trip
    counts for the frozen fast-path workloads and the two D-1 outcomes
    against the shipped engine.
    **Revision 4 (integrator decision after phase 1, note §8.4):** the
    `memberRollback` grant is member isolation only. Add
    `operationRegion?: MemberRollback` to the borrowed binding (supplied only
    by the callback-transaction route); `OperationContext.region()` answers
    it for a multi-statement borrowed operation and opens nothing when it is
    absent (array fallback, mirroring the shipped `runLinearOn`). Pin the
    G3 suppression SAVEPOINT count and the scope-composition native modes
    unchanged, and pin the classification agreement with the shipped
    `canExecuteDirectly` over the qualified verb set (G4-03 follow-up 2,
    finding 11).
12. **Packageable reads.** A pure read must be statically packageable by
    `prepareBatch` (queue the SELECT, parser = the prepared decoder) so an
    atomic array containing a read member succeeds on a batch-only driver as
    it does on the shipped route (G4-03 review finding 2).
13. **Requests from G4-01.** `commands/assignments.ts` `scalarAssignment`:
    `"set" in value` → `Object.hasOwn(value, "set")` (a `Uint8Array` inherits
    `set`; reproducer in `g4/unit01/note.md` §8). Route
    `program/index.ts` reads through `Queries.read` and `isReadOperation` so
    the retained comparison specimen keeps the one read entry (unit01 review
    finding 8). Consider the indexable `withinBounds` pre-filter beside the
    GeoPoint distance predicate only if a provider plan requires it; record
    the decision.
14. **Requests from the witness stream.** A tagged variant collection
    quantifier must raise its public error identity, not a bare `TypeError`
    from `buildMembershipView`; a vector column on an incapable provider must
    raise the established capability refusal identity; `s.number()` is a
    public domain the candidate must decode (verify G4-01's repair covered it).
15. **Providers are available now** (see `g4.md` environment table): run
    native PostgreSQL and MySQL modes with `VIBORM_RAPTOR3_PROVIDER_PORT` set
    to the current loopback port (`docker port viborm-raptor3-g3-pg-20260914 5432`
    / `docker port viborm-raptor3-g3-mysql-20260914 3306`). Record the port and
    container identity in every native receipt. The witness stream's native
    suites `g4-read-envelope-pg-contracts` / `g4-read-envelope-mysql-contracts`
    are registered and never ran; their first real run is yours.

## Method

1. Read the G4-01 handoff, `operation-context.ts`, `execution.ts`, the
   current `query.ts`, `commands/index.ts`, the adapter contracts for the
   capabilities the handoff names (`src/adapters/database-adapter.ts`,
   `shared/standard-sql.ts`, each dialect adapter), the driver result
   contracts (`tests/contracts/drivers/provider-result-contracts.core.test.ts`),
   and the G3 witnesses that pin fast paths and key transitions
   (`tests/raptor3/g3/*.test.ts`, `tests/raptor3/prep/set-preparation.test.ts`,
   `tests/raptor3/post-prep/g29-result-progress*.test.ts`).
2. Write `note.md` (decision-elimination gate) before the first edit. Expected
   deletions: the entry's per-verb read branches collapse into one
   cardinality decision; any remaining physical-route SQL that the handoff
   makes derivable from prepared meaning; the separate `referenceProjection`
   assembly if the projection owner now covers it. Name invariants and
   falsifiers.
3. Implement, running the affected registered suites and the witness
   author's G4 read/lifecycle suites (`node scripts/run-raptor3.mjs g4-…`
   once registered, or `node scripts/run-vitest-safe.mjs run <files>`),
   serially. Run the PGlite lane (`tests/raptor3/expanded/*.test.ts`,
   `post-prep/g29-result-progress-pglite.test.ts`, your new PGlite fit
   witness). Attempt native modes once and keep the exact blocked receipt if
   providers are still down. Run `node scripts/run-typecheck.mjs` before
   hand-off.
4. Cost via `node scripts/query-engine-structure.mjs` conventions
   (incremental and cumulative against the G4-01 accepted figures).
5. Hand off: `production.patch`, `note.md` with the four §7 answers and the
   fast-path count table, adapter seam list, blockers, unverified claims.

## Exit and return value

Return a structured summary: unit, patch path, note path, handoff revision
realized, obligations implemented / partial / not started with reasons, fast-
path count table (workload → statements, round trips, before/after), suites
run with pass/fail and receipt paths, PGlite and native results (or blocked
receipts), typecheck result, cost figures, removed decisions, added rules,
adapter seams touched, blockers, unverified claims.
