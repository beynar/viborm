# G4-03 → integrator / G4-01 / G4-02 handoff — revision r6 (2026-09-15, after repair 3)

> **r6 (repair 3, after the G4-03b review returned REVISE).** No production
> change: all four files keep their r5 SHA-256. Two previously unrecorded
> divergences from the shipped route are now measured, pinned and recorded as
> **decisions for Arnaud** (D-5, D-6 below); two inventory rows move back to
> PARTIAL; all four registered cell counts move. Details: `note.md`
> "Repair 3".

This unit's contract is small: one route interface, one selection seam, and two
requested changes in files it does not own. The full reasoning, evidence and
§7 answers are in [`note.md`](note.md); this file is the part other streams act
on.

## 1. The route contract (frozen for this milestone)

`src/query-engine/raptor3/route/client-route.ts` — candidate-owned.

```ts
interface ClientOperationRoute {
  operation(
    model: AnyModel,
    requestedOperation: string,       // the caller's verb, OrThrow included
    args: Record<string, unknown>     // client-prepared payload, admitted ONCE by the candidate
  ): RoutedCandidateOperation;
}

interface RoutedCandidateOperation {
  readonly preparedArgs: Record<string, unknown>;            // r5: the candidate's ONE admission
  cacheResultCodec(): RouteCacheResultCodec;                 // refuses today (B-1c)
  prepareBatch(                                              // r5: takes the caller's context
    context: QueryExecutionContext
  ): Promise<PreparedBatchOperation<unknown> | undefined>;
  execute<T>(execution: RoutedOperationExecution): Promise<T>;
}

type ClientOperationRouteFactory = (                         // r5: third parameter
  schema: Schema,
  driver: AnyDriver,
  resolved: ResolvedSchemaViews                              // the client's index + registry
) => ClientOperationRoute;

interface RoutedOperationExecution {
  readonly context: QueryExecutionContext;          // the operation's own attribution
  readonly engineDriver: AnyDriver;                 // driver of the engine it was created on
  readonly driverOverride: AnyDriver | undefined;   // supplied by an existing array owner
  readonly isWrite: boolean;
  readonly committedWriteSegment: (() => Promise<void>) | undefined;
  readonly writeMayBeVisible: (() => Promise<void>) | undefined;
}
```

Selection is `VibORM.create(config, routeFactory)` → `QueryEngine.route` →
`PendingOperation`. `createClient` cannot reach it; `createCandidateClient` in
the same module is the private constructor used by tests.

**Binding rule — r5, three call paths and no envelope decision.** The route
states WHICH SITUATION an operation is in; the candidate decides the envelope.

| Situation | Reaches the route as | Binding |
| --- | --- | --- |
| root | `engineDriver === factoryDriver`, no override | none (standalone) |
| an existing array owner's sequential fallback | `driverOverride` | `{kind, driver}` — **no grant**: the array's own batch is the unit, mirroring the shipped `runLinearOn` |
| inside `$transaction(callback)` / a nested savepoint | a transaction-bound engine | `{kind, driver: engineDriver, operationRegion, memberRollback}` — the caller opened nothing for this operation, so it TRANSFERS the right to open one region |

`atomic-array` is never constructed by the route, so the candidate's refusal for
it stays unreachable from the client and remains a direct-entry contract.

**Divergences D-1 and D-2 are CLOSED.** With `operationRegion` landed
(`shared/operation-context.ts`, G4-02 phase 2) the route no longer wraps a
borrowed write, and `OperationContext.run`'s deferred-statement rule is the one
envelope owner. Measured on both routes: a statement-atomic write inside
`$transaction(callback)` opens nothing and publishes the same three units; a
failing one poisons the caller's transaction identically (both reject, neither
commits); a multi-statement one opens exactly one region on each route; and an
array containing a READ is packaged in one native batch on both. The three
`DIVERGENCE PIN` cases are now parity oracles, and re-opening the region fails
exactly the two cells that own it (`note.md` FU.10, falsification 1).

**Divergence D-5 is OPEN, and it is a REFUSAL REMOVAL.** On a batch-only driver
(`supportsBatch && !supportsTransactions`) a MULTI-statement write as an array
member is refused by the shipped route — `OperationExecutor.ts:1515`,
"query-engine-v2 cannot merge an insertId-scratch operation into a shared driver
batch." — and packaged, committed and returned by the candidate. On an
interactive driver the two routes agree. Nothing in the route decides this: the
array owner asks the route for a package because `#resolveSinglePlan` answers
`undefined` for routed operations, and the candidate's packaging rule has no
counterpart to the shipped refusal. Pinned on both routes in
`route-transactions.test.ts` ("D-5 PIN …"); the decision is Arnaud's
(`note.md` FU.6 D-5). **Do not re-introduce the refusal in the route** — it
would be a second plan authority.

**B-4 is CLOSED.** The route passes `execution.context` — the operation's own
trusted attribution — into `prepared.execute(...)` and `prepared.prepareBatch(...)`,
and `OperationContext.callerAttribution` consumes it. Statement transforms and
statement/transaction/savepoint units now see candidate statements; the whole
observed unit sequence matches the shipped route, and `g4-lifecycle-events` is
3/3 (it was 2 red).

**B-1 is HALF closed.** `prepare(...)` publishes the one admission, so the
interceptor `input` and the cache KEY are the admitted payload on both routes
(LX-12, NS-04). The cache RESULT CODEC still refuses: see §2 and `note.md`
FU.6 B-1c.

**r6 carve-out.** Publishing the ADMISSION is what makes `upsert` diverge: the
shipped route validates the upsert ENVELOPE only and publishes the caller's raw
`create`/`update` arms, while the candidate publishes its one admission (defaults
filled, assignments normalized to `{ set: … }`). Every other verb is
byte-identical. LX-12 is therefore **PARTIAL**, not covered — divergence
**D-6**, a decision for Arnaud (`note.md` FU.6).

**B-3 is CLOSED.** `VibORM`'s constructor hands the route factory
`{index, registry}` and the candidate takes them by identity.

## 2. Requested changes still OPEN (r5)

### 2.1 — `src/query-engine/raptor3/shared/query.ts`: a leaf carries its scalar (blocker B-1c)

The only thing standing between the candidate route and a working `$withCache`
for reads. `PreparedRead` publishes `shape`, `value`, `single` and `empty`, which
is the whole STRUCTURE of the cache codec; what it does not publish is the
`Scalar` each leaf codec is compiled from, and
`src/query-engine/result/cache-value-codecs.ts` — the official owner — addresses
a scalar by the object, never by a type name. Re-dispatching on `Leaf.type` in
the route would be a second scalar-meaning authority, which the §7 gate rejects
and the common brief's stop rules forbid, so it was not written.

```ts
 export type Leaf = {
   kind: "scalar";
   type: string;
   nullable: boolean;
+  /** The declaring scalar, for consumers that compile a value codec from it. */
+  scalar: Scalar;
   …
 };
 …
   private leaf(scalar: Scalar, nullable: boolean): Leaf {
     return Object.freeze({
       kind: "scalar",
       type: state.type,
       nullable,
+      scalar,
```

With it the route composes the codec from the official exported composers
(`compileScalarCodec`, `compileWidenedSumCodec`, `recordCodec`, `arrayCodec`,
`nullableCodec`, `countCodec`, `booleanCodec`, `numberCodec`,
`taggedRelationCodec`) in about 35 lines and adds no authority. Unblocks LX-07's
store/materialize half and the inherited `g4-lifecycle-admission` cache-bypass
red. Reproducers: `route-cache.test.ts` "LX-07 PENDING blocker B-1c …" and
`tests/raptor3/g4/lifecycle-admission.test.ts` "C13 cache-bypass: a cached read
inside a transaction never serves the cache".

### 2.2 — `src/query-engine/raptor3/commands/index.ts`: `prepareBatch` takes a binding (D-3')

`PreparedOperation.prepareBatch(attribution?)` constructs
`new OperationContext(schema, config.driver, …, undefined, true, attribution)`
with the binding argument hard-coded `undefined`, so a package is `_prepare`d on
the FACTORY driver while the array owner executes it on the driver it supplied.
Give it the same `binding?: ExecutionBinding` parameter `execute` already has and
pass it through; the route then forwards `{kind: "borrowed-transaction", driver}`.
Now that B-4 has landed, statement attribution makes this observable in
principle, but no credential-free cell can show it: both drivers are one client
lineage sharing one adapter.

### 2.3 — same file, `publishedFacts`: a prepared read publishes its statement (D-4')

Add `readonly statement: Sql` to `PreparedRead`, sourced from `value.query.sql`.
`PendingOperation.buildStatement()` then answers `prepared.read?.statement`
instead of `undefined`, and `QueryEngine.build(model, op, args)` stops reporting
"does not compile to one SQL statement" for an operation that plainly does.
Internal only: no client surface reaches `QueryEngine.build`.

## 3. Requested changes that LANDED (kept for the record)

| Request | Where it landed | What it closed |
| --- | --- | --- |
| `prepare(...)` splits admission from execution (**B-1**, r1 §2) | `commands/index.ts`, G4-01 | LX-12's interceptor `input`, NS-04's cache key; the codec half became **B-1c** above |
| `callerAttribution` on `OperationContext` (**B-4**, r1 §3) | `shared/operation-context.ts` + `commands/index.ts` | LX-13, LX-15, LX-14's statement units, both `g4-lifecycle-events` cells |
| `operationRegion` on the borrowed binding (G4-02 brief item 11) | `shared/operation-context.ts` | **D-1**, both halves |
| packageable reads (G4-02 item 12) | `commands/` + `shared/` | **D-2** |
| `EngineConfig.resolved` (**B-3**) | `shared/schema.ts` | the second per-client schema resolution |

## 4. Not requested, recorded only

- **B-2** — `TransactionOperationOwner.executeWith` has no capability parameter,
  so the array owner's sequential fallback cannot grant `memberRollback`. The
  candidate's borrowed suppression refusal is therefore preserved as-is.
  **r2 (review finding 8): that refusal is unreachable on every substrate this
  environment can run.** It fires only where
  `adapter.mutations.skipDuplicatesStrategy === "recoverableUniqueError"`, which
  is MySQL only (`src/adapters/databases/mysql/mysql-adapter.ts:851`; SQLite
  `:711` and PostgreSQL `:513` use `"sql"`). So B-2's "preserved" claim is
  **unverified**, and on MySQL it would be an observable array-transaction
  change for a supported verb. A MySQL-lane pin is requested in `note.md` §R.7.
- **B-3** — closed in r5: `EngineConfig.resolved` is supplied by
  `src/client/client.ts` and provably read by the candidate
  (`route-admission.test.ts` B-3 cell, falsification 5).

## 5. For the integrator

- Four behavior suites (**35** tests after repair 3) and one type-probe file.
  The manifest (`scripts/raptor3-manifest.mjs:509–532`) must move **all four**
  counts: `route-transactions.test.ts` **11 → 13**, `route-lifecycle.test.ts`
  **7 → 8**, `route-cache.test.ts` **6 → 7**, `route-admission.test.ts`
  **5 → 7**. Until it does, `node scripts/run-raptor3.mjs g4-route-admission`
  (and `-cache`, `-transactions`, `-lifecycle`) fails with "Missing
  candidate/profile/scenario cell in …", because `run-raptor3.mjs:1025–1036`
  asserts `assertionResults.length` per file. The type probe is covered by
  `run-typecheck.mjs` and is deliberately not a layer type-core file.
- **Rows LX-02, LX-13, LX-14 and LX-15 are COVERED**, and NS-04's key half with
  them. **LX-12 and LX-04 are PARTIAL** (corrected in repair 3): LX-12 is
  covered for every verb but `upsert` (**D-6**), LX-04 for the read half but not
  for a multi-statement write member on a batch-only driver (**D-5**). The table
  is `note.md` FU.11. What remains pending is LX-07's store/materialize half
  (**B-1c**), the package-preparation driver (**D-3'**), `QueryEngine.build`
  (**D-4'**), the MySQL-only borrowed-suppression refusal (**B-2**) and the two
  new divergences — `note.md` FU.11.2 and RP.8.
- **Two decisions are waiting on Arnaud** and block nothing else: **D-5** (a
  registered refusal the candidate route removes) and **D-6** (the `upsert`
  published payload). Both are pinned on both routes, so the tree fails the day
  either answer moves. Neither was taken by this unit, and neither may be
  "fixed" in the route: see `note.md` FU.6.
- Charged cost after r5, unchanged by repair 3 (which edits only tests and
  evidence — every per-file delta measured 0): **+242 token-lines**, +380
  physical lines, +14,653 bytes against `0cc61e61`. The follow-up itself is
  **+6 token-lines**, of which `client-route.ts` is **+1** — it consumed four
  candidate capabilities while deleting the `withTransaction` wrap and the
  read/write branch. Incremental core semantic cost is 0 **outside the new route
  adapter**, which is itself charged in full at +144 token-lines / +9,170 bytes
  (wording corrected in repair 3; `note.md` FU.9).
- One reviewer probe file was edited, mechanically, to forward the new
  `prepareBatch(context)` parameter:
  `tests/raptor3/g4/review/unit03/route-admission-count.review.test.ts`. It is
  another stream's file; the change adds no assertion and is in
  `tests-followup.patch`.
- The C-01 cutover diff is enumerated in `note.md` §F; it deletes the `else` arm
  of each route branch and changes no public surface. The one pre-cutover
  route-side change §F queued (stop wrapping every borrowed write) **has now
  landed**, so §F's "Added in repair 2" paragraph is history, not work.
- Benchmark reachability (no shipped switch) is `note.md` r1 §8.

## Revisions

- **r6** (2026-09-15) — repair 3, after the G4-03b independent review returned
  REVISE. **No production change**: all four files keep their r5 SHA-256 and the
  cost recheck is 0 on every axis. Two divergences the unit had not found are
  measured, pinned on both routes and recorded as decisions for Arnaud: **D-5**
  (a batch-only MULTI-statement array member — shipped refuses via
  `OperationExecutor.ts:1515`, candidate packages and commits) and **D-6** (the
  `upsert` interceptor payload — raw arms vs the one admission). LX-12 and LX-04
  move back to **PARTIAL**; all four registered counts move; three review notes
  (B-1c causation, the manifest counts, the cost sentence) are corrected in
  `note.md`. Full record: `note.md` "Repair 3".
- **r5** (2026-09-15) — the G4-02 follow-up (unit G4-03b). The route contract
  CHANGED for the first time: `prepareBatch` takes the caller's execution
  context, the route factory takes the client's resolved schema views, and
  `preparedArgs` is the candidate's own admission. Divergences **D-1** and
  **D-2** and blockers **B-3** and **B-4** are closed; **B-1** is half closed
  (key yes, result codec no — now blocker **B-1c**); **D-3/D-4** are restated as
  **D-3'/D-4'** against the landed `prepare(...)` boundary. Full record:
  `note.md` "Follow-up after G4-02".
- **r1** (2026-09-14T21:40Z) — first revision.
- **r3** (2026-09-15) — second post-review repair (follow-up findings 9 and 10).
  §1 extends D-1 with its state/outcome half, its `poisonOnFailure` mechanism and
  the decided resolution (G4-02 item 11, so no decision for Arnaud); §2 notes
  where that resolution now lives; §5 updates the counts, the stale manifest line
  range and the partial rows. **No production change**: `src/` is byte-identical
  to the tree the follow-up reviewed. One test was added
  (`route-transactions.test.ts`, now 11). The route contract is **unchanged**.
  One bounded route-side follow-up is queued for this unit: pass `memberRollback`
  as a capability once G4-02 item 11 lands.
- **r2** (2026-09-15) — post-review repair. §1 binding rule now states the
  condition it mirrors (D-1); §2 carries the second requested change (D-3) and
  names the two divergences the seam owns; §4 records B-2 as native-only and
  unverified; §5 updates the test counts and marks LX-04/LX-14 partial. The
  route contract itself is **unchanged** — no interface, signature or selection
  seam moved.
