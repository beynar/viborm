# Five Refusal-Site Lifts

**Date:** 2026-08-15

**Status:** Implemented; focused provider validation is recorded below

**Starting branch:** `by-relation-bearing-bulk`

**Starting commit:** `2b1cb0d0`

**Implementation overlay (2026-08-17):** All five packages are implemented. The live literal
`new UnsupportedOperationError` constructor census is **8 write-engine / 10
query-engine / 11 whole `src`**. Only site 26 left the census. Sites 13, 19, 27,
and 28 remain as narrower, falsified boundaries. This document is a product plan,
not a promise
to remove constructors. Its five programs are the coherent liftable parts of
sites 13, 19, 26, 27, and 28. Some sites also own a contradiction or a
substrate boundary that must remain.

Focused contracts in this branch cover PGlite and SQLite paths for the mutation
and raw-operation work, real workerd D1 bind-budget chunking, and the
credential-free Neon HTTP fake. They do not constitute the full provider matrix
proposed in §10.2. Docker PostgreSQL/MySQL, hosted Neon, and the other
hosted/provider legs remain evidence to run and report, not capabilities claimed
by this overlay.

The former “correlated incoming-parent mutation” and “progressive final key”
items are not separate architectures. They are two halves of one requirement:
identify the selected row, then keep addressing that same row if its key
changes. This plan calls that requirement **selected-row continuity**. Bind-
budget chunking remains separate even though it shares site 27's refusal
factory.

## 1. Outcome

Deliver five programs without weakening an accepted correctness contract:

1. raw SQL is a lazy operation that can participate in
   `$transaction([...])`;
2. selected-row continuity admits a correlated update/found-upsert of the exact
   incoming parent and follows that same row across an enclosing row-key
   transition;
3. semantic bulk builders can split splittable statements to a provider's bind
   budget;
4. RETURNING adapters can fold a scalar generated-output result, and
   PostgreSQL-family adapters can fold a bounded multi-write graph, into one
   SQL statement inside an indivisible transaction-array unit;
5. a non-returning create can publish plural database-assigned row-key members
   when another complete explicit unique key can locate the inserted row.

The delivery target is capability, not a lower number. Site 26 should disappear.
Sites 13, 19, 27, and 28 should become narrower. A remaining constructor is
correct when it still names one real boundary and a falsifier reaches it.

## 2. Plan vocabulary

**Deferred operation**:
An operation value that captures call inputs and attribution but performs no
validation, warning, or database I/O until it is awaited or consumed by a
transaction coordinator.
_Avoid_: Promise, when execution timing is the relevant fact

**Transaction operation**:
A deferred operation that exposes ownership, execution, preparation, and result
parsing to the array-transaction coordinator. Model operations and raw
operations are two implementations.
_Avoid_: Pending model operation, when raw SQL is also included

**Stable post-write locator**:
A complete addressable key whose exact values are explicitly written by the
create operation and can therefore locate that row for a focused read. It is a
row locator, not necessarily the row key.
_Avoid_: Generated identity, inferred unique

**Indivisible operation group**:
The explicit `$transaction([...])` array. Its members may be lowered into one
provider transaction, but no member may commit as a progressive prefix.
_Avoid_: Batch, when the atomicity promise is the relevant fact

**Selected-row placement**:
Whether later relation work executes before or after the enclosing selected-
record write. Each existing relation-arm or record-series ordering owner supplies
this phase; the phase decides whether the work addresses the captured row key or
the final row key.
_Avoid_: Old/new ID special case

**Selected-row continuity**:
Proof that later work still addresses the same logical record selected earlier,
even when an enclosing write changes one or more row-key members. Selection
establishes the captured record; selected-row placement chooses its captured or
final complete execution key. Portable identity is the complete key plus exact
membership, not an invisible physical row incarnation.
_Avoid_: Same ID, when the row key is compound or can change

## 3. Non-negotiable contracts

Every package below keeps these invariants:

1. **No guessed row.** A generated value, locator, or relation target comes from
   an explicit value, a provider result, or an exact guarded continuation. It is
   never reconstructed from sequence adjacency or a stale selector.
2. **No hidden atomicity downgrade.** Default operations may use the documented
   progressive committed-segment contract. An explicit `$transaction([...])`
   remains all-or-nothing.
3. **No guard-to-write gap.** A premise that protects a mutation shares the same
   atomic database unit as that mutation.
4. **One owner per fact.** Row keys remain in `ModelKeyCatalog`, selected values
   in `TargetProjection`, final selected-record values in
   `RecordUpdateCompiler`, operation result lowering in the operation compiler,
   and transaction coordination in the client.
5. **No driver-name branches.** The query engine asks adapter and driver
   capabilities. The adapter owns dialect SQL.
6. **Old accepted paths stay stable.** A lift does not change SQL, result shape,
   warning timing, cache behavior, or retry behavior for an unrelated accepted
   route unless the package explicitly names that change.
7. **Failure integrity remains exact.** Validation and construction errors are
   pre-I/O. A progressive failure reports its committed prefix. An indivisible
   operation either completes or rolls back.
8. **A red-capable witness precedes production.** Each package has at least one
   test that fails for the old exact reason, plus a neighboring control that
   prevents an overbroad implementation.

## 4. Scope and delivery order

| Order | Program | Starting owner | Delivered capability | Boundary that remains |
|---:|---|---|---|---|
| 1 | Lazy raw transaction operations | `client/raw.ts` site 26 | Raw and model operations mix in one array transaction | Ordinary promises and foreign-client/scope operations remain invalid |
| 2 | Selected-row continuity | `RelationUpsertPart` site 13 + the moving-key arm of `OperationExecutor.progressiveSeriesRefusal` site 27 | Correlated update/found-upsert targets the exact incoming parent through captured-to-final key transitions | `delete`, global adopt, and a key-changing loopback itself remain refused |
| 3 | Bind-budget chunking | The capacity arm of `OperationExecutor.progressiveSeriesRefusal` site 27 | Splittable bulk statements fit verified bind limits | One indivisible over-limit statement remains refused |
| 4 | Indivisible generated-output folds | `OperationExecutor.assertIndivisibleGeneratedOutput` site 28 | RETURNING scalar arms, plus bounded PG/Neon CTE DAGs, execute inside `$transaction([...])` | Non-returning scalar arms and non-CTE/attribution-ambiguous graphs remain refused |
| 5 | Alternate-unique produced-field locator | `CreateOperation.producedReference` site 19 | A focused read publishes plural generated row-key fields through another explicit unique | An unnameable row remains refused |

Implementation result:

| Package | Landed owner/result | Retained boundary |
|---:|---|---|
| 1 | `RawOperation` and the shared pending-execution lifecycle make raw and model calls one-shot transaction operations | Ordinary promises, foreign clients/scopes, and reused operations are rejected |
| 2 | `RecordUpdateCompiler` publishes one selected-row captured/final-key continuity fact to correlated re-entry and progressive placement | Same-incoming delete/global-adopt and a re-entry that itself changes the incoming row key remain refused |
| 3 | `buildCreateManyPlan` and junction insert owners partition compiled statements by the active driver's verified bind budget; the executor enforces the final limit | An indivisible over-limit statement and unsafe progressive placement remain refused |
| 4 | RETURNING scalar arms and snapshot-safe PostgreSQL-family mutation DAGs fold into one statement for an indivisible array member | A graph with no exact one-batch lowering remains refused |
| 5 | `createDataUniqueWhere` derives an explicit stable post-write locator for the existing focused publication read | A non-returning plural generated row key with no addressable explicit locator remains refused |

This order is deliberate. Package 1 hardens the shared-array protocol without
changing write compilation. Package 2 unifies row selection and temporal key
tracking before Package 3 touches bulk statement shape. Package 4 then adds
another atomic lowering. Package 5 is last among the mutation lifts because it
has no known shipped-provider schema today.

Site 27's “effect before a skippable root” refusal remains a separate scheduler
invariant outside Packages 2 and 3. Sharing an error factory does not make it a
continuity or capacity problem.

## 5. Package 1 — lazy, batchable raw SQL

### 5.1 Current failure

`createRawSurface` executes a driver call immediately and tags the resulting
native promise. The array coordinator accepts only `PendingOperation`, sees the
tagged raw promise, and raises site 26 because no operation remains to prepare.

This is a representation choice, not a database limitation.

### 5.2 Public contract

~~~ts
const disable = client.$executeRaw`
  UPDATE account SET active = ${false} WHERE tenant_id = ${tenantId}
`;
// No validation, warning, or I/O yet.

const [affected, accounts] = await client.$transaction([
  disable,
  client.$queryRaw<{ id: string }>`
    SELECT id FROM account WHERE tenant_id = ${tenantId}
  `,
]);
~~~

The two statements execute in declared order inside the existing transaction
boundary. The second statement can observe the first database effect. It cannot
interpolate the first statement's JavaScript result.

### 5.3 Smallest coherent design

1. Add an internal `TransactionOperation<T>` protocol beside
   `PendingOperation`. It contains only what the array coordinator consumes:
   client and scope ownership, a logical model/method label, `executeWith`,
   `prepare`, optional `prepareBatch`, `parseResult`, `observeBatchPhase`, and
   execution attribution.
2. Extract the one-shot lazy promise state from `PendingOperation` into one
   concern-owned pending-execution lifecycle. `PendingOperation<T>` and a new
   client-owned `RawOperation<T>` use it. Two substitutable implementations make
   this protocol real; it is not a speculative interface.
3. Keep the public model `PendingOperation` class and `isPendingOperation`
   contract unchanged. Add an internal transaction-operation guard. Arbitrary
   promises never become batchable.
4. Change the four `RawSurface` return signatures from `Promise<T>` to the
   exported `RawOperation<T>` subtype, and widen the transaction tuple's input
   and unwrapping types to model or raw transaction operations. Without this
   public return type, TypeScript would erase the deferrable capability back to
   `Promise<T>` before the value reaches `$transaction([...])`.
5. Make `RawOperation<T>` implement the complete `Promise<T>` structural
   surface: `then`, `catch`, `finally`, and `Symbol.toStringTag`. `await`,
   `Promise.resolve`, `Promise.all`, and assignment to `Promise<T>` remain
   valid. Native `instanceof Promise` is not an existing supported contract and
   must not become one accidentally in documentation.
6. Bind raw operations to the active `QueryEngine`, not only its driver. A root
   operation receives the root client/scope IDs; an interactive-transaction
   operation receives the bound engine IDs. Existing ownership checks then work
   without a raw-specific exception.
7. Capture the method, arguments, and immutable attribution at call time.
   Perform argument validation, legacy-string warning, SQL preparation, and I/O
   only when the operation is awaited or submitted.
8. Safe tagged templates and `Sql` fragments prepare through `_prepare` and
   execute through `_execute`. Unsafe and legacy strings preserve verbatim SQL,
   positional parameters, and `_executeRaw` direct execution.
9. `prepare()` returns one `PreparedQuery`. `parseResult()` returns rows for
   query methods and `rowCount` for execute methods. The shared-array merge gains
   no raw branch.
10. Preserve today's cache rule: raw writes do not guess a model footprint and
   therefore do not perform model cache invalidation.
11. Delete `RAW_OPERATION`, `isRawOperationPromise`,
    `rawOperationInBatchError`, and site 26 after every raw method has the new
    operation representation.

### 5.4 Mandatory falsifiers

- Construct a raw operation, flush microtasks, and prove zero driver calls and
  zero legacy warnings.
- Mix raw and model operations on a batch-only PGlite driver; prove one native
  `_executeBatch`, declared SQL order, and exact public tuple result types from
  both an inline literal and a predeclared operation variable.
- Make the later raw statement fail; prove an earlier raw/model write rolls
  back.
- Pass an `Sql` fragment with extra values; prove rejection before batch
  dispatch and before effects.
- Prove every safe interpolation remains a bound parameter in an array.
- Reject foreign-client and foreign-scope raw operations before dispatch.
- Reuse an already executed operation; prove the same one-shot lifecycle error
  family as model operations.
- Keep interactive and nested callback-transaction raw behavior unchanged.
- Reject ordinary promises and junk with `InvalidTransactionInputError`.
- Emit one legacy warning per executed method and none for an abandoned
  operation.

### 5.5 Provider and completion gate

- PGlite and SQLite3: direct, interactive, nested, and rollback behavior.
- Forced batch-only PGlite: one shared native batch and all-or-nothing failure.
- D1 fixture: raw/model ordering through `batch()`.
- Neon fake: one `transaction([...])` request.
- Docker PostgreSQL and MySQL: placeholder and rollback parity.

Done when the public raw surface remains promise-compatible, all four raw
methods join both transaction forms, site 26 is deleted, and the raw refusal
contract is removed from the live census.

Likely owners: `src/client/raw.ts`, `src/client/client.ts`,
`src/query-engine/pending-operation.ts`, execution context/cache flow, public
client type probes, and raw/transaction contract suites.

## 6. Package 2 — selected-row continuity

### 6.1 One missing fact, two consumers

Site 13 and the moving-key arm of site 27 ask the same question:

> Which complete row key names the record selected by the original locate at
> the point where this later work executes?

Site 13 needs that answer when a correlated child arm re-enters its incoming
parent. Site 27 needs it when a progressive nested series starts another
committed segment. The relation-arm classifier and the segment scheduler remain
separate consumers; neither may invent its own “old ID” or “new ID” rule.

### 6.2 Single semantic owner

`RecordUpdateCompiler` already owns the facts:

- `TargetProjection` owns the complete captured row key;
- `plannedParentId(targetReadId)` supplies its before-root members;
- `postTransitionReference` supplies every final field after the root write;
- `RecordUpdateCompiler` exposes the complete compound-safe key through a
  `selectedRowKeyAt("beforeRoot" | "afterRoot")`-shaped concern owner;
- each existing consumer supplies its own phase: the actual transition barrier
  chosen by `resolveOrdinaryChildHeld` / `resolvePolymorphicParent` and
  `compileLocatedRecord` for site 13, and `resolveCreateParent(...).afterRoot`
  for the fresh series;
- existing membership and continuation guards prevent redirection to a
  different complete key or moved membership.

Build one complete, field-keyed, compound-safe before/final row-key fact after
transition topology is known. Unchanged members keep their captured value;
changed members use their final reference. Both consumers ask that owner for a
key at their already-decided phase. Site 13's phase must come from the emitted
root/child transition barrier, not be inferred from the array into which a Part
was first collected. The consumers do not share relation classification,
placement decisions, or segment scheduling. This is a shared semantic result,
not a new identity framework, context object, or scheduler.

Never re-run the caller's unique selector to find the row after a transition.
That selector may no longer match, and a replacement could now own it.

### 6.3 Consumer A — correlated incoming-parent re-entry

Admit the relation mutation only when:

- the enclosing upsert is `correlation: "correlated"`;
- the nested relation targets the exact incoming parent-held membership;
- the verb is `update`, or the found arm of `upsert`;
- the nested mutation does not itself change a member of that parent's row key;
  and
- no `connect`, `create`, or `connectOrCreate` supplier precedes this route.

Remove the current requirement that the enclosing parent's row key remain
stable. When the child work is before the enclosing root transition, address
the parent with the before-root tuple. When it is after, use the final tuple.
Statement-order conflicts follow the same placement: the later statement wins.

The current refusal fires before the nested compiler is built, so merely deleting
it would not wire the right target. For the exact matching incoming relation,
thread one narrow selected-target override from
`buildCorrelatedToManyUpsertParts` into `updateSelected`.

That override has two deliberately different views:

- planning probes, the optional nested filter, and pre-write membership guards
  still locate the captured before-root tuple, because all planning runs before
  either write and the final key may not exist yet;
- execution addresses use `selectedRowKeyAt(phase)`, so an after-root mutation
  writes the final tuple and a before-root mutation writes the captured tuple.

Keep the two compiler levels explicit. The selected-child arm compiler only
transports this relation-scoped override; none of its own root, terminal,
projection, or sibling addresses change. When it reaches the exact matching
incoming-parent relation and builds the selected-parent compiler, that parent
compiler uses the captured key for planning and `selectedRowKeyAt(phase)` for
every execution-time address in the parent subtree, including deeper membership
sources and terminal addresses—not only its root `UPDATE WHERE`.

Leave the admitted mutation in that existing nested `RecordUpdateCompiler` with
its target projection, existence guard, membership premise, and race handling.
Do not flatten a conditional found arm into the enclosing final-assignment
ledger.

An update beside a supplier remains an accepted but different route: it mutates
the supplied row, not the incoming parent, and does not consume this continuity
fact.

### 6.4 Consumer B — progressive nested series

Make `progressiveParentRowKey` a thin consumer of the same placement-owned fact:

- cascading/before-root placement uses the captured complete tuple;
- non-cascading/after-root placement uses the complete final tuple.

Every later write segment re-pins liveness and exact membership for that tuple
inside the same atomic batch as its mutation. This is field-agnostic, works for
compound/mapped row keys, and never redirects to a different key or a row that
now owns a moved membership.

### 6.5 Retained boundary

Keep focused boundaries for facts continuity cannot supply:

- `delete`, because the selected row no longer exists and enclosing siblings or
  the terminal result may still need it;
- `global-adopt`, because the found target is not proved to be the selected
  incoming parent;
- a nested re-entry that itself changes the incoming parent's row key, because
  that conditional branch does not yet publish its final tuple back to the
  enclosing compiler and later siblings;
- complete-key or membership drift across committed segments, which must abort
  through the existing guard rather than redirect.

A delete-and-reinsert with the identical complete key and identical membership
is an ABA-identical logical record under the portable contract. Distinguishing
physical incarnation requires an explicit version field and is not something an
ORM can infer from ordinary SQL row identity.

Do **not** retain a blanket refusal for an enclosing direct or relation-derived
row-key transition. Resolving that case is the practical payoff of sharing the
before/final key fact. A future lift of a key-changing loopback may reuse the
same vocabulary, but it first needs the conditional child arm to return a new
final continuity value.

### 6.6 Mandatory falsifiers and completion gate

- Stable-key correlated update changes the exact incoming parent; a same-shape
  decoy stays unchanged.
- Correlated upsert found arm updates; its create sentinel is absent.
- The child create arm leaves the parent mutation inert.
- An optional nested filter is conjoined with the selected-parent key, and a
  same-shaped child/sibling target proves the override cannot escape its one
  incoming relation.
- An enclosing direct scalar key transition and a relation-derived key
  transition both succeed.
- Cascading placement proves before-root addressing; a reachable direct-
  polymorphic after-root correlated-found shape proves final-key addressing.
- Same-field conflicts prove the correct later-statement winner in both
  placements.
- Progressive series succeeds across direct and relation-derived transitions.
- Compound partial-key transitions and mapped columns use the complete tuple.
- Implementations forced to always use the old tuple and always use the final
  tuple both fail.
- Moving membership to a decoy or replacing it under a different key between
  segments never redirects a write; an identical-key/membership ABA control is
  documented as the same logical record unless a version field is present.
- Delete, global-adopt, and a key-changing nested re-entry remain typed focused
  refusals with zero effects.
- Supplier-plus-update remains accepted and mutates the supplier.

Run PGlite transaction and atomic-batch behavior first, then SQLite, D1/workerd,
and Docker PostgreSQL/MySQL. Done when `RecordUpdateCompiler` publishes one
before/final row-key truth, both consumers use it, admitted cases have exact
result/state parity, and neither consumer independently derives an old/final
key.

Likely owners: `RecordUpdateCompiler.ts`, `RelationUpsertPart.ts`,
`FreshRecordSeriesPart.ts`, existing target projection/transition/membership
owners, nested-arm and progressive-row-key contracts, and the guard ledger.

## 7. Package 3 — bind-budget chunking

### 7.1 Separate capacity from continuity

`progressiveSeriesRefusal` is an error factory, not one domain invariant. Its
capacity arm is unrelated to selected-row continuity even though both currently
share site 27.

Current disposition of the other reasons:

| Reason | Disposition |
|---|---|
| Selected row moves before later nested work | Package 2 |
| A splittable bulk statement exceeds a verified bind limit | Lift here at the statement owner |
| A write or nested series must occur before a skippable root | Keep; skipping would orphan a committed effect |
| One indivisible SQL statement exceeds the verified provider limit | Keep |
| Provider has neither transactions nor native atomic batch | Keep as a custom-driver substrate boundary; no shipped driver currently has this pair |
| Generated output crosses a nested series | Retire; the recursive progressive route already owns it |
| Internal capture/final-result/planning placements with no public shape | Reclassify as internal invariants or delete if unreachable |

### 7.2 Builder-owned partitioning

The executor's final capacity assertion remains. The executor must not parse and
rewrite arbitrary SQL.

Start with `buildCreateManyPlan`, where row grouping and result semantics are
already known. When a provider exposes a verified
`maxBindParametersPerStatement`, partition a same-shape row group into the
largest chunks whose compiled `Sql.values.length` fits. Keep all chunks inside
the same interactive transaction or native atomic batch.

`buildCreateManyPlan` currently receives a `QueryScope`, whose concern is the
adapter, while the verified limit belongs to the active driver. Pass the
numeric budget from its `QueryEngine` callers. Do not make `QueryScope` reach
through to driver state and do not move provider limits into the adapter.

Then audit set/connect/disconnect/updateMany/deleteMany builders separately.
Split only when their owner can preserve count, order, conflict, returning, and
atomicity semantics. A single row or predicate whose one statement is still too
large retains the pre-effect refusal.

Implementation disposition:

| Semantic bulk owner | Disposition |
|---|---|
| `buildCreateManyPlan` | Chunk contiguous same-shape rows from compiled bind counts; applies to root, nested, polymorphic, skip, and returning callers |
| Junction `connect` / `set` join INSERT | Chunk the already-captured complete target-key list; guards and `set` clearing remain in the same atomic operation |
| Scalar `updateMany` / `deleteMany` | Retain one statement: replaying an arbitrary predicate can rematch rows, double-count, or change the selected limited set |
| Child-held grouped `connect` / `disconnect` | Retain until the owner can partition its all-target probe and matching write from compiled counts as one semantic plan |
| Junction `deleteMany` | Retain: its added/removed guards compare the complete captured set; a subset makes other chunks appear as differences |
| Per-target junction disconnect/delete and record-series updates | Already one statement/member per semantic target; no grouped SQL leaf remains to partition |

Do not estimate binds as `rows * columns`; casts, predicates, discriminators,
and adapter lowering can change the actual parameter count. Budget the compiled
`Sql` values.

### 7.3 Observable statement-trigger contract

Chunking changes one observable database detail for a payload that is currently
unexecutable: a statement-level trigger fires once per chunk, not once for the
logical maximal same-shape run. Row-level triggers remain once per row.
Document this as the large-payload contract. Keep under-limit runs as one
statement, and prefer a future adapter-owned packed-value lowering if a provider
can preserve one statement without losing type or result semantics.

### 7.4 Mandatory falsifiers and completion gate

- Real workerd D1 executes a relation-bearing `createMany` above 100 total
  binds, with every statement at or below the verified limit.
- Exact row order, count, skip behavior, and failure rollback are preserved.
- A compound relation tuple crosses a chunk boundary without losing a member.
- One indivisible row above the limit refuses before I/O.
- A provider with no declared limit submits a small statement and lets the
  provider own a later native capacity error with exact prior progress.
- A forced-low-limit PostgreSQL contract uses a statement-level trigger to prove
  one firing per chunk, while an under-limit control still fires once.

Run bind-budget contracts on D1/workerd plus a small-limit synthetic driver.
Re-run every retained site-27 reason by exact class/message and pre-effect or
progress state.

Done when the factory reports only distinct live boundaries and every
semantically splittable builder either chunks or has an explicit reason not to.

Likely owners: `operations/create.ts`/`buildCreateManyPlan`, the semantic bulk
builders, `QueryEngine` budget plumbing, `OperationExecutor.ts` for final
enforcement only, and D1/capacity contracts.

## 8. Package 4 — indivisible generated-output folds

### 8.1 Current failure

A default operation may materialize a provider output between guarded committed
segments. An explicit `$transaction([...])` cannot: the shared operation is
indivisible, so `prepareSharedBatch` raises site 28 when one operation still
contains a cross-statement generated-output dependency.

The refusal is correct for an arbitrary graph. It is too broad for a scalar
result a RETURNING adapter can publish directly, and for a graph the PostgreSQL
adapter can express as one data-modifying CTE statement.

### 8.2 Atomicity contract

Never segment the explicit array. The lift succeeds when the operation compiler
eliminates every cross-statement generated-output dependency. A value used only
as the producing statement's public result may stay in that statement's
`RETURNING`; a value consumed by another write must be folded with that consumer
into one data-modifying CTE statement. Independent probes and guards may remain
separate entries because the existing provider batch/transaction keeps the
whole array indivisible. Those entries join all siblings in the same existing
provider transaction:

- PostgreSQL/PGlite forced batch: one atomic provider batch;
- Neon HTTP: one `client.transaction([...])` request;
- SQLite/D1 returning scalar arm: the producing INSERT returns its public scalar
  directly inside the existing atomic SQLite transaction or D1 `batch()`;
- interactive drivers: the existing sequential transaction path.

Non-returning scalar arms and non-expressible graphs retain a typed pre-effect
refusal. A returning adapter does not need mutation CTE support for the scalar
arm. Relation projections and multi-write graphs do.

### 8.3 Deliverable A — generated upsert create result

The first two public witnesses are missing upsert create arms whose INSERT
generates a row-key field and whose terminal result consumes it.

For an adapter with `supportsReturning`:

1. A scalar projection becomes one `INSERT ... RETURNING` statement that
   returns the requested fields directly.
2. Keep the probe-first branch and its guards unchanged. This package lowers
   result transport; it does not invent another upsert decision algorithm.
3. Preserve a root race pin for the default-operation executor only when the
   folded command contains that one attributable write. The explicit array's
   prepared-batch protocol does not carry race pins or retry the whole array;
   this package does not add that separate capability.

This covers one generated primary key and one generated member of a compound
row key. The complete result comes from `RETURNING`, never from the upsert
selector. SQLite and D1 take this scalar path despite
`supportsCteWithMutations: false`.

For a relation projection, require
`supportsReturning && supportsCteWithMutations` and use the existing mutation-
projection fold. Apply the same `projectionReadsMutatedModel` rule as
`CreateOperation`; PostgreSQL's outer query cannot pretend to see a newly
mutated base table through the pre-statement snapshot.

### 8.4 Deliverable B — safe relation-bearing create DAGs

Pass the enclosing create-race fact into `CreateOperation` before it decides
whether to fold. Remove the post-compilation `annotateCreateRacePin` rewrite.

Permit the existing mutation-dependency CTE fold only when:

- every cross-arm value is a strictly forward, non-optional `firstRowField`;
- planning asks no database-dependent branch question;
- the graph has no guard, JavaScript postcondition, record series, or savepoint-
  only skip effect;
- sibling writes are already proved order-insensitive;
- the projection is scalar-only or passes the existing mutation-snapshot rule;
- a root race pin cannot be confused with a descendant failure.

A multi-write command carrying a root race pin must decline when a descendant
can violate the same table/constraint. PostgreSQL reports the constraint, not
the failing CTE arm; retrying it as a root race could silently switch the
enclosing upsert to its update arm. Pin-free extended-selector DAGs may fold; a
one-write pinned arm may fold.

### 8.5 Mandatory falsifiers

- Batch-only PGlite executes the current generated-ID upsert array and returns
  its exact projection.
- A compound row key returns its literal and generated members; no read uses
  the upsert `where` as the created identity.
- A failing sibling rolls back the folded write and every array sibling.
- The adjacent default-operation plain unique missing-arm race still retries
  correctly for the one-write fold.
- The same race inside an explicit array surfaces its typed unique failure,
  rolls back every array member, and does not retry or switch to the update arm.
- An extended-unique create conflict stays a real `UniqueConstraintError`.
- A descendant that can violate the root's pinned constraint is not folded or
  misattributed.
- A relation projection reading a table mutated by the same command declines.
- Forced SQLite/D1 batch executes the scalar RETURNING arm atomically; a
  relation projection or multi-write graph still declines without mutation
  CTE support.
- Non-CTE adapters receive no PostgreSQL syntax. Non-returning adapters keep
  their exact existing route/refusal.
- Structural SQL proves no `OperationValueReference` survives the fold.
- A Neon fake observes one provider transaction request; hosted Neon is the
  final provider evidence, not the semantic owner.

### 8.6 Completion gate

Implement the scalar/generated upsert fold on every RETURNING adapter first.
Retarget the current single and compound site-28 refusals to positive atomic
behavior, with SQLite/D1 controls proving CTE support is not required. Then pass
root-race ownership into delegated `CreateOperation` and enable only safe
PostgreSQL-family create DAGs.

Finally audit every remaining public route to
`assertIndivisibleGeneratedOutput`. Keep site 28 with a narrower non-expressible
falsifier if one remains. If only impossible compiler states remain, translate
them to the internal error model instead of advertising a product limitation.

Likely owners: `UpsertOperation.ts`, `CreateOperation.ts`, shared mutation-
projection/CTE fold code, site-28 and mutation-dependency tests, forced
SQLite/D1/PG and Neon contracts, and `OperationExecutor.ts` only for the final
invariant.

## 9. Package 5 — alternate-unique produced-field locator

### 9.1 Current failure and reach

On a non-returning adapter, a create with more than one database-assigned
row-key member has no singular insert-id selector. Site 19 refuses when a later
write demands one of those fields.

The row is not always unnameable. Its create payload may explicitly write
another complete addressable unique key. That key can locate the row for the
focused post-insert read the create compiler already uses.

No shipped provider currently exposes the motivating schema: PostgreSQL and
SQLite have `RETURNING`, while MySQL/PlanetScale permit only one
`AUTO_INCREMENT` column. This package is valid generic adapter work and custom-
adapter behavior, but it is deliberately last.

### 9.2 Locator eligibility

A stable post-write locator is one `ModelKeyCatalog.addressableKeys` entry for
which every member:

- is explicitly present in the parsed create source;
- has the exact scalar value emitted by the INSERT;
- is neither `null`, `undefined`, `Sql`, nor database-assigned;
- participates in a public unique selector.

A raw unique index that has no addressable selector does not qualify. A compound
unique preserves its ordered field group. The row key itself remains the row
key; the alternate key is only a locator.

### 9.3 Smallest coherent design

1. Extend the existing `shared.ts::createDataUniqueWhere` owner, which already
   scans `ModelKeyCatalog.addressableKeys`, preserves compound selector shape,
   and accepts only addressable literals. Give that scan an explicit-field
   provenance predicate/set, or extract one shared catalog scan that both its
   current callers and this locator use. Do not add a second unique-key scan
   near mutation identity.
2. Compute the locator through that owner from source explicitness and parsed
   scalar values before
   `RecordPlan` freezes its identity/publication data.
3. Carry it as part of the create record plan; do not create a universal
   identity abstraction.
4. When a demanded plural database-assigned field cannot use `RETURNING`, let
   `producedReference` register the existing focused publish-read if the locator
   exists.
5. Make `createdRowWhere` use the alternate locator only in this otherwise-
   unaddressable path. Preserve singular insert-id and RETURNING SQL byte for
   byte.
6. Select all demanded produced fields in one read. Zero rows fails loudly and
   rolls back on the required transaction substrate; multiplicity is excluded
   by the addressable unique constraint and needs no second guard.
7. Keep site 19 unchanged when no locator exists.

### 9.4 Mandatory falsifiers

- A synthetic non-returning adapter creates a row with a scalar alternate
  unique, publishes both generated row-key members, and feeds exact child FKs
  through one focused read.
- Repeat with a compound alternate unique and mapped columns.
- No alternate unique reaches the exact existing refusal with zero effects.
- A null member, omitted/defaulted member, `Sql` expression, raw-only unique
  index, and incomplete compound unique do not qualify.
- A RETURNING adapter performs no locator read.
- A singular insert-id route keeps its existing SQL and output channel.
- A concurrent alternate-unique occupant produces its native unique failure;
  the read never redirects to that row.

As with the existing explicit-primary-key terminal read on a non-returning
provider, user-defined database triggers that rewrite an explicitly inserted
key member are outside this locator contract. Do not claim trigger-proof
identity without a provider-returned value.

Done when a synthetic/custom non-returning adapter contract proves the
capability without changing any shipped provider's ordinary path. If that
contract exposes a missing generic driver fact, the package is blocked and the
mutation-lift plan is not complete; do not call the refusal lifted or land
speculative machinery.

Likely owners: `CreateOperation.ts`, `shared.ts::createDataUniqueWhere`, focused
produced-field read tests, and the residual refusal witness.

## 10. Cross-package verification

### 10.1 Per-package red/green loop

For every package:

1. capture the exact current failure with one public witness;
2. add the neighboring acceptance/control cases;
3. change the single semantic owner;
4. run the focused contract on every applicable substrate, plus the package's
   retained-boundary control; when that boundary is substrate-specific, run it
   on that substrate;
5. run the owning layer and `pnpm test:types`;
6. update the live guard ledger, inventory coordinates, public docs, and stale
   historical claims in the same package;
7. run focused Biome and `git diff --check`.

Do not overlap Vitest or TypeScript runs in this workspace.

### 10.2 Final provider matrix

| Capability | Core substrate | Required real/fake provider evidence |
|---|---|---|
| Lazy raw | transaction + shared native batch | PGlite, SQLite3, D1, Neon fake, Docker PG/MySQL |
| Selected-row continuity | selected-record atomic execution + capability-false progressive batch | PGlite, SQLite, D1/workerd, Docker PG/MySQL; stable/moving, direct/relation-derived, compound/mapped |
| Bind chunking | verified small/real bind limit | D1/workerd and a synthetic exact-limit driver |
| Indivisible output fold | RETURNING for scalar; data-modifying CTE for relation/DAG; atomic shared batch | forced SQLite/D1 and PGlite/PG, Docker PG, Neon fake and hosted Neon |
| Alternate locator | non-returning + interactive transaction | synthetic/custom adapter contract; shipped controls unchanged |

### 10.3 Final gates

After all focused suites are green:

- `pnpm test:types`
- `pnpm test:coverage:write-engine`
- relevant credential-free provider aggregate
- live Docker PostgreSQL and MySQL suites
- hosted Neon/D1 legs where the package changes their route
- operation-construction inventory and literal
  `new UnsupportedOperationError` constructor census
- focused Biome on changed files
- `git diff --check`

The final report must distinguish passed, skipped, unavailable, and untested
provider legs. A skipped hosted provider is not positive evidence.

## 11. Completion criteria

This plan is complete when:

1. all admitted public shapes in the five packages execute with exact
   result and state parity;
2. every retained boundary has one owner, one precise reason, and one
   distinguishing falsifier;
3. explicit transaction arrays remain indivisible;
4. no capability depends on a driver-name branch or guessed identity;
5. scalar and unrelated accepted SQL remains byte-compatible where promised;
6. the live inventory describes product capabilities rather than counting error
   constructors as features;
7. `RecordUpdateCompiler` publishes one selected-row before/final-key truth and
   neither `RelationUpsertPart` nor `FreshRecordSeriesPart` independently derives
   an old/final key.
