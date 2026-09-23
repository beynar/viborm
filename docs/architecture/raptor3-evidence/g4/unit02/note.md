# G4-02 — physical/provider envelope, phase 1 (unit note)

Brief: [`../briefs/unit02-physical-provider.md`](../briefs/unit02-physical-provider.md)
(revision 3 — **phase 1 only; `src/query-engine/raptor3/shared/query.ts` is NOT
mine yet**). Contract realized: [`../unit01/handoff.md`](../unit01/handoff.md)
revision 4. Also read before the first edit:
[`../unit03/note.md`](../unit03/note.md) §4 (B-1…B-4), §5, §R.1, §R.2, §R.10;
[`../unit01-review-followup-2.md`](../unit01-review-followup-2.md);
[`../unit03-review-followup-2.md`](../unit03-review-followup-2.md);
[`../witness/handoff.md`](../witness/handoff.md) r3.

Written **before the first production edit**. Section 9 answers the §7 gate
against the actual diff at completion; section 10 is the Phase 2 queue.

---

## 0. Writer transfer

**Writer transfer: query.ts — NOT transferred at the time of writing.** Phase 1
touches none of `shared/query.ts`. Every obligation that needs it is in §10.

---

## 1. The inherited red list (measured, before any edit)

Receipts: [`receipts/inherited/`](receipts/inherited/).

| Mode | Result | Cells still red | Owner |
| --- | --- | --- | --- |
| `g4-read-contracts` | 58 passed / **4 failed** (62) | SC-13 vector refusal identity; Q-W10 tagged variant collection quantifier; Q-O04 collection `_count` ordering; RF-16 recursive fuller codec set | §10 (query.ts), §4.7 (storage.ts) |
| `g4-route-transactions` | **11 passed** | — | — |
| `g4-lifecycle-events` | 1 passed / **2 failed** (3) | C13 missing-event `statement`; C13 statement observation | B-4 → §4.2 + route follow-up §11.2 |
| `g4-lifecycle-admission` | 3 passed / **1 failed** (4) | C13 cache-bypass (`cannot encode a cached result … publishes no prepared read shape`) | B-1 → §4.1 + route follow-up §11.1 |

Exact failure text:

- SC-13: `the candidate raised FeatureNotSupportedError (vector.literal is not
  supported. Load the pgvector extension.) where the shipped engine raises
  QueryError`.
- Q-W10: `board.findMany` answered `[{id:1},{id:2}]` where the hand-computed
  value is `[{id:2}]` — a **wrong answer**, not a refusal.
- Q-O04: `TypeError: Cannot read properties of undefined (reading 'variant')` at
  `src/query-engine/raptor3/shared/storage.ts:97`, reached from
  `Queries.relationOrderTerm` → `bindMembership(schema, model, field)` with no
  variant for a variant-carrier collection.
- RF-16: `Driver "sqlite3" returned a malformed bigint scalar for operation
  "findMany": the value is not a canonical integer.`

---

## 2. Required behavior (rows this unit owns)

OP-W03 (root `delete`), the physical half of SC-03…SC-06, the required provider
profiles (SQLite interactive + atomic batch, scripted TW/TA, PGlite, native
PostgreSQL, native MySQL), the frozen fast paths, and brief items 8–15. The read
semantics themselves are G4-01's and are consumed unchanged.

## 3. Current owner, per obligation

| Obligation | Current owner today | Gap |
| --- | --- | --- |
| verb entry | `commands/index.ts` `createCommandEngine` fuses admission + dispatch + execution inside `run()` | no prepared handle; no published read shape/cardinality (B-1) |
| statement attribution | `OperationContext.attribution` mints `{model, operation, correlationId}`; `statementContext()` mints a second per-statement one | neither carries the client's trusted context, so no candidate statement is transformed or observed (B-4) |
| physical envelope | `OperationContext.run` opens `driver.withTransaction` for **every** non-read standalone operation; the route opens one region for **every** borrowed write | a one-statement operation pays BEGIN/COMMIT (standalone) and a savepoint region (borrowed) — D-1 |
| packaging | `OperationContext.read` throws `incompletePreparation` in `batch-preparation` | a pure read can never be packaged → D-2 |
| schema | `new EngineSchema(schema)` re-hydrates + re-validates + re-resolves per client | B-3 |
| root single-row writes | `Commands.execute` `create`/`update` build a record command, locate, mutate, then re-read (3 statements for `flat-scalar-update`) | no statement-atomic form; root `delete` absent entirely |
| whole-value assignment | `commands/assignments.ts:28` `"set" in value` | `Uint8Array.prototype.set` binds as the blob's value |
| comparison specimen read entry | `program/index.ts` names verbs and calls `queries.select`/`queries.grouped` | a second read entry beside `Queries.read` |

## 4. Smallest proposed change (phase 1)

### 4.1 One prepared operation, one admission (brief 8, B-1)

`createCommandEngine` returns `prepare(modelName, operation, rawArgs)` →
`PreparedOperation { args, read?: { shape, single }, execute(binding?,
attribution?), prepareBatch(attribution?) }`. `execute`/`prepareBatch` become
callers of `prepare`. Admission is memoized inside the handle and happens exactly
once, **lazily** (the shipped `PendingOperation` is lazy — LX-01 — so a handle
that admits eagerly at `client.model.op(...)` call time would break laziness).

`read` is the **same** `Queries.read(model, operation, args)` value the execution
consumes, built once on one engine-lifetime `Queries` bound to
`config.driver.adapter`. Adapter identity is pinned across transaction scoping
(`TransactionBoundDriver` copies `baseDriver.adapter` by identity,
`src/drivers/driver.ts:517-520`; the `Object.create(this)` scope view inherits
it), so the prepared statement and shape are valid for every binding of that
lineage — **one projection, one decoder, no second admission**.

### 4.2 Execution context threading (brief 9, B-4)

`OperationContext` gains a final constructor parameter
`callerAttribution?: QueryExecutionContext`. `attribution` answers it when
present, and **`statementContext()` answers it too** — the chain is held in a
WeakMap keyed by the exact trusted object
(`src/drivers/execution-context.ts`), so a spread copy would lose it.
Without a caller context the two existing spellings are unchanged.

**Corrected in the repair round (review finding 2).** The first version of this
section claimed the shipped executor passes the operation's one context to every
statement. It does not: `statementExecutionContext`
(`src/query-engine/pattern/execute/values.ts:280-287`) returns the operation
context only while `step.model === context.model` and otherwise calls
`deriveStatementExecutionContext` (`src/drivers/execution-context.ts:144-152`),
a trusted derived context carrying the nested model's name **and** the same
resolved chain. `statementContext` now does exactly that, and `read()` takes the
model a nested locate addresses, so the per-statement model multiset matches the
shipped engine's — see "Repair" below.

### 4.3 One physical envelope rule (brief 11, D-1)

**The rule, stated once:** *an operation's physical envelope opens at the first
statement that is not the operation's only statement.*

Mechanically, every provider round trip funnels through one private seam
(`OperationContext.dispatch(statements, terminal, run)`). `run()` marks the
envelope **deferred** when, and only when, an envelope actually exists for this
ownership (standalone on a transaction-capable driver → `driver.withTransaction`;
borrowed-transaction with a granted `memberRollback` → that region). While
deferred:

- a **terminal** call carrying exactly one statement, with no statement executed
  before it, runs directly — no BEGIN/COMMIT, no savepoint. This is the shipped
  `runStatementAtomic` condition (`OperationExecutor.ts:226-247`: empty planning,
  exactly one non-guard step) restated in the candidate's vocabulary;
- anything else raises one private sentinel **before any provider work**, the
  in-memory attempt is discarded, and the body is re-run inside the envelope.

The sentinel can only be raised while `performed === 0`, so the re-run repeats
*construction only* and never re-issues a statement. This mirrors the shipped
executor, which also classifies by constructing (`compileSingleStatementCandidate`
calls `planning()`, and `compile({})`) and then constructs again for the
multi-statement route.

Terminal calls are the existing result-publishing family (`finishOne`,
`finishMany`, `finishValue`, `setMutation`, `setMutations`, and a packaged read);
planning reads, captures, effects and member statements are not. Cardinality is
untouched: the seam counts **physical statements**, never rows (private guide,
"`finishOne`/`finishMany` state operation-owned result cardinality … independent
of the number of physical terminal queries").

### 4.4 Statement-atomic root writes: cardinality over the set-oriented owner (brief 2 + 11)

Root `create`, `update` and `delete` whose **data names no relation** and whose
**projection names no relation** are the existing set-oriented owners plus one
cardinality decision — exactly the way `Queries.read` made cardinality the
operation's decision for reads:

| Verb | Physical owner | Cardinality |
| --- | --- | --- |
| `create` | `OperationContext.createMany(model, [scalars], projection)` | `rows[0]`, else `INSERT did not produce the required record` |
| `update` | `OperationContext.updateMany(model, selector, scalars, undefined, projection)` | `rows[0] ?? throw NotFoundError(model, "update")` |
| `delete` | `OperationContext.deleteMany(model, selector, undefined, projection)` | `rows[0] ?? throw NotFoundError(model, "delete")` |

The three context entries stop taking a raw `select: Input` and take a
`PreparedProjection | undefined` the caller prepared, so the default (no
`select`) projection of a root verb and the explicit projection of a bulk verb
come from the one `prepareProjection` owner.

Gate (the shipped gate, `DeleteOperation.ts:206-212`, `UpdateOperation` `canFold`):
`adapter.capabilities.supportsReturning` **and** every prepared projection field
is `kind: "scalar"`. A relation projection must be read **before** the row is
gone and has no RETURNING spelling; `_count` is a relation projection too.
Root `delete` on a **non-returning** adapter keeps the same owner and takes its
existing capture branch (locked identity capture → prepared-projection read →
`DELETE` with a cardinality check) — brief item 2's "prepared projection plus the
operation-owned locked capture". The `namesRelation(projection)` arm of that
branch exists for root `delete`, the only verb that can present a relation
projection to this owner: a correlated carrier inside `DELETE … RETURNING` would
read rows the statement is removing. **Correction (review finding 8):** an
earlier draft of this section also called the arm a latent-bug fix for
`deleteMany`. It is not — admission refuses a relation `select` on a bulk write
(`'select.posts' is not supported on 'deleteMany': a bulk write projects scalar
fields only`), so `deleteMany` never reaches it.

Root `delete` therefore adds **no per-verb path and no verb interpreter**: the
verb contributes a gate and a cardinality, nothing else.

**Relation actions on root `delete`.** The shipped `DeleteOperation` applies
**none** — its `compile()` emits exactly `[read, delete]` (plus a batch presence
guard), and the fold emits one `DELETE … RETURNING`
(`src/query-engine/write-engine/DeleteOperation.ts:255-330`). Referential action
is the provider's. The candidate must not invent an application-level cascade;
the brief's "apply relation actions through the existing deletion/removal owners"
is satisfied by *not* introducing a second owner. Recorded as a finding, not a
decision (§8.1).

### 4.5 Packageable reads (brief 12, D-2)

`OperationContext.publish(read, missing?)` is the one read-result owner for the
verb entry. In `batch-preparation` it queues the prepared SELECT and installs the
prepared decoder as the package's `parseResult` (the `OrThrow` not-found decision
travels with it); otherwise it executes and decodes exactly as today. An atomic
array containing a read member then succeeds on a batch-only driver.

### 4.6 Schema reuse (brief 10, B-3)

`EngineSchema` accepts the already-resolved `{ index, registry }`;
`EngineConfig` carries it optionally. Nothing else changes: the lazy factory
views stay exactly where they are.

### 4.7 The two G4-01/witness requests reachable without `query.ts` (brief 13, 14)

- `commands/assignments.ts` `scalarAssignment`: `"set" in value` →
  `Object.hasOwn(value, "set")`.
- `program/index.ts` reads through `Queries.read` + `isReadOperation`, so the
  retained comparison specimen keeps **one** read entry.
- `shared/storage.ts` `buildMembershipView`: a variant carrier addressed with no
  variant currently crashes with a bare `TypeError`. It raises the candidate's
  registered unimplemented identity instead
  (`Raptor 3 G1 variant carrier membership is not implemented: <relation>`), the
  string family the witness stream pins as a red cell's *reason*
  (witness handoff §5.1). The answer itself is §10 (query.ts).

## 5. What disappears, and the invariant that replaces it

| # | Decision that disappears | Mechanism today | Consumers | Replacing invariant | Falsifier |
| --- | --- | --- | --- | --- | --- |
| D-a | "does this operation need a transaction?" answered by **verb kind** | `run()` opens `withTransaction` for every non-read; the route opens a region for every borrowed write | `OperationContext.run`, `route/client-route.ts` `runCandidate` | One rule: the envelope opens at the first statement that is not the operation's only one. `Commands.plan` answers only ADMISSIBILITY ("may this form be one statement?"); the COUNT is the construction's, enforced at `dispatch` | An operation that issues one statement must show **no** BEGIN/COMMIT and one round trip; a two-statement operation must show the envelope. Measured rows: `createMany` of 2 rows sharing a column set → 1 statement / 0 tx (shipped: 1 / 0); `createMany` past the bind budget → 2 statements / 1 tx with the sentinel recovering exactly once; root `create` → 2 statements / 1 tx (shipped 1 / 0) — the **one** admitted exception, §8.3 |
| D-b | "which physical path does a single-row root write take?" answered per verb | `create`/`update` build a record command, locate, mutate, re-read | `Commands.execute` | The set-oriented owner is the one physical owner; the verb supplies only cardinality and a gate | `flat-scalar-update` must be **1** statement with the same public value; a relation-bearing update must keep its qualified path |
| D-c | "how does the caller learn the read's shape?" | nowhere — the route refuses the cache codec | `route.cacheResultCodec`, query interceptors, cache key | `prepare()` publishes the one prepared projection shape and cardinality that execution consumes | Two shapes must never exist: the packaged parser and the executed decode must come from the same `Read` |
| D-d | "which context does a candidate statement carry?" | a freshly minted attribution per operation and a second one per statement | driver instrumentation, statement transforms | The caller's trusted context is the authority when it exists | A statement transform/observer must see candidate statements exactly as shipped ones |
| D-e | "can a read be packaged?" | no — `read()` refuses in preparation | array transactions on batch-only drivers | A read is packaged by the same prepared decoder that decodes it live | An array containing a read member must succeed on a batch-only driver |
| D-f | "is a whole value an operator record?" | `"set" in value` (prototype-inclusive) | every blob/Decimal/Date create/update | Own-property test only | Writing `new Uint8Array([1,2,250])` must store the bytes |

## 6. Rules added

1. **One envelope rule** (§4.3), stated in `OperationContext` and nowhere else.
2. **One read-result owner** (`publish`) for both live execution and packaging.
3. **A prepared projection, never a raw `select`,** crosses into the physical
   bulk owners.
4. The caller's trusted `QueryExecutionContext`, when supplied, is the attribution
   authority for the operation **and** for every statement it issues —
   re-attributed to the model a statement addresses through the snapshot owner's
   own `deriveStatementExecutionContext`, exactly as the shipped executor does.
5. A packaged single-row write carries its missing-row premise as a STATEMENT
   (one `assertions.exists` guard declared to the array owner), because a batch
   has no JavaScript postcondition available — the shipped fold's own rule
   (added in the repair round, §R.1).

## 7. Falsifiers this unit must fail

1. `flat-scalar-update` (`user.update({ where: { id }, data: { age: { increment: 1 } } })`)
   on SQLite must issue exactly **one** statement, no BEGIN/COMMIT, and return
   the same row the shipped engine returns.
2. A root `update` whose `data` names a relation must still open its envelope and
   keep its qualified route.
3. A root `delete` on a RETURNING adapter must be one `DELETE … RETURNING`; a
   missing row must raise the same `NotFoundError` identity the shipped engine
   raises; a relation projection must read **before** the delete.
4. A single-statement write on a **borrowed** transaction must run directly on
   the borrowed driver, so a failure poisons the caller's transaction exactly as
   `runStatementAtomic` does; a multi-statement write must roll back only its own
   member.
5. The candidate's single-statement classification must **agree** with the
   shipped `canExecuteDirectly` classification over the qualified verbs
   (G4-03 reviewer's forward-looking note), with ONE recorded exception: root
   `create`, whose fold is withdrawn with evidence in §8.3 (it would stop the
   G2.9 malformed-result witness from witnessing) and which is no frozen
   fast-path workload. Root `create` therefore costs 2 statements and 1
   transaction where the shipped engine costs 1 and 0, and the disagreement is
   deliberate, measured and queued at §10.12 — not an unnoticed gap.
6. An array transaction containing a read member must succeed on a batch-only
   driver.
7. `prepare()` must admit exactly once: a second admission is observable as a
   second transform invocation.
8. Writing `new Uint8Array([1,2,250])` to a blob column must store those bytes.

## 8. Findings recorded, not chosen

### 8.1 Root `delete` applies no application-level relation action
Evidence: `src/query-engine/write-engine/DeleteOperation.ts` `planning()`/
`compile()` emit only locate/read/delete (+ batch presence guard). The candidate
mirrors this. Any cascade the schema declares is the provider's.

### 8.2 SC-13 wants the **shipped** identity, which is not a capability refusal
The witness asserts equality with the shipped engine, and the shipped engine
raises `QueryError` where the candidate raises `FeatureNotSupportedError` from
`unsupportedVector.literal` (`src/errors/query.ts:442-461`). Brief item 14's
wording ("the established capability refusal identity") and the witness disagree;
the witness is the contract. Investigated in phase 1, resolved in §10 if it lands
in `query.ts`/the adapter seam.

### 8.3 Root `create` deliberately keeps its own physical route
The set-oriented fold was implemented for root `update` and root `delete` and
**not** for root `create`. Reason, measured: folding `create` onto
`OperationContext.createMany` removes the stored-row SELECT that the G2.9
malformed-result witness corrupts, so
`tests/raptor3/post-prep/g29-result-progress.test.ts` (both profiles) stops
witnessing the translation it pins
([receipt](receipts/after1/prep.log), 2 failed before the fold was withdrawn).
The candidate's own create also owns generated-output continuations, insert-id
scratch and acknowledged-segment progress that `createMany` does not reproduce
identically. No frozen fast-path workload is a root `create`
(`RAPTOR3_WORKLOADS` in `benchmarks/operation-pipeline-catalog.mjs`), so nothing
required it. Queued for phase 2 with its evidence requirement (§10.11).

### 8.4 A `memberRollback` grant is NOT an operation-region grant
Brief item 11 asks the candidate to run a multi-statement borrowed operation
"inside the `memberRollback` region the existing transaction owner supplies".
Implemented literally, that is refused by two qualified G3 contracts:

**Receipts (re-measured in the repair round — review finding 4).** The first
version of this table cited the POST-revert passing runs, which is a receipt
failure the common brief forbids. The region was re-implemented on the reviewed
tree (one change in `OperationContext.region()`: answer `memberRollback` for a
borrowed ownership), the three contracts were re-run, the failing logs were
saved under [`receipts/withdrawn-operation-region/`](receipts/withdrawn-operation-region/),
and the file was restored from a scratchpad copy with its SHA-256 re-verified
(`5eb8f417…`) and `git apply -R --check` re-run clean.

| Contract | What it pins | What the operation-level region did | Receipt |
| --- | --- | --- | --- |
| `g3-suppression-retry` | one suppression region per suppressed member, none for the operation | **both cells fail**: `TransactionError: Transaction scope for driver "sqlite3" cannot be used while its nested transaction is active` (V5001), and the second cell then sees that error where it requires `UniqueConstraintError` | [`withdrawn-operation-region/g3-suppression-retry.log`](receipts/withdrawn-operation-region/g3-suppression-retry.log) (exit=1, 2 failed) |
| `g3-scope-composition-pg` | composing exact-root suppression into one caller transaction | `TransactionError: Transaction scope for driver "pg" cannot be used while its nested transaction is active` | [`withdrawn-operation-region/g3-scope-composition-pg.log`](receipts/withdrawn-operation-region/g3-scope-composition-pg.log) (exit=1, port 65504) |
| `g3-scope-composition-mysql` | the same, on MySQL | `TransactionError: Transaction scope for driver "mysql2" cannot be used while its nested transaction is active` | [`withdrawn-operation-region/g3-scope-composition-mysql.log`](receipts/withdrawn-operation-region/g3-scope-composition-mysql.log) (exit=1, port 65515) |

The earlier claim that `g3-suppression-retry` reported **4** savepoints instead
of 3 is **withdrawn**: the measured failure is the nested-scope `TransactionError`
above, on both of that mode's cells, not a savepoint count. The conclusion is
unchanged and now evidenced.

The cause is real, not incidental: the grant is a closure bound to the
**caller's** driver, so invoking it again from inside a region it already opened
uses the caller's scope while a nested one is active; and the array-transaction
fallback — which supplies the same grant — mirrors `runLinearOn`, where the
shipped engine opens **no** operation envelope at all.

The binding therefore cannot distinguish "the array owner granted member
isolation" from "the callback-transaction owner transferred the operation
region". Phase 1 keeps the qualified behavior: **a borrowed operation opens no
region of its own**, every statement runs directly on the borrowed driver, and a
failing single-statement write poisons the caller's transaction exactly as the
shipped `runStatementAtomic` does — pinned against the shipped engine in
`tests/raptor3/g4/unit02/borrowed-envelope.test.ts`
([receipt](receipts/final/unit02-author-checks.log)).

**Exact extension the corrected route needs** (a decision for the integrator,
recorded, not taken here) — one additional optional grant on the borrowed
binding, so ownership is stated rather than inferred:

```ts
export type ExecutionBinding =
  | {
      readonly kind: "borrowed-transaction";
      readonly driver: AnyDriver;
      /** MEMBER isolation inside the caller's own scope (array fallback). */
      readonly memberRollback?: MemberRollback;
      /**
       * The caller transferred the OPERATION region: it opened none itself, and
       * the candidate opens exactly one when the operation needs more than one
       * statement. Supplied only by the callback-transaction route.
       */
      readonly operationRegion?: MemberRollback;
    }
  | { readonly kind: "atomic-array" };
```

With it, `OperationContext.region()` answers `operationRegion` for a borrowed
binding and the rule in §4.3 covers both ownerships unchanged.

## 9. §7 decision-elimination answers

**1. Necessary decision or representation repair?**
Every rule added in §6 states a boundary fact, not a reconciliation. The
envelope rule states a measured execution requirement (a one-statement operation
needs no atomic scope — the shipped engine's own `runStatementAtomic` condition)
and it *removes* a reconciliation: the verb no longer decides the envelope in one
place and the route in another. `publish` removes a second read-result site.
The prepared projection crossing into the bulk owners removes a second place
where a raw `select` became a projection.

**Repaired (review findings 3 and 5).** Two reconciliations the first round left
standing are gone:

- The envelope classification was stated twice — the rule in
  `OperationContext.run` and a per-verb statement COUNT in `Commands.plan` — and
  only the second was load-bearing. `PhysicalPlan.single` is now an
  ADMISSIBILITY ("may this form be one statement?"), the count is the
  construction's own answer at `dispatch`, and the sentinel is what makes a
  wrong optimistic answer safe. It is reachable and pinned: a `createMany` past
  the bind budget recovers exactly once (`physical-envelope.test.ts`).
  `get statementAtomic()` had no consumer anywhere and is deleted.
- `publishesSingleRow` — the one duplication this unit knowingly added — is
  **deleted**. `prepare().read` now reads its facts FROM the prepared `Read`
  (`value.result([])`, the read owner's own publication for zero rows), so the
  two cannot disagree for any verb, and the agreement check walks every
  `ReadOperation` instead of three. That also fixes the facts the duplication
  got wrong: `count` and `exist` publish a number and a boolean, not a row.

**2. Exact deletion and replacement obligation?**
Deleted, with mechanism, consumers, invariant and falsifier, are D-a…D-f in §5.
Verified no equivalent mechanism moved elsewhere: `OperationContext.run` is the
only place that opens a transaction for an operation (`region()` is its only
producer); `Commands.plan` is the only place that decides a verb's physical
form; `publish` is the only place a read result is produced. Falsified by
mutation: forcing `plan.single = false` and restoring the per-statement minted
attribution turns **7** of this unit's checks red and nothing else
([receipt](receipts/falsify/mutated-envelope-and-context.log)), and the sources
were restored from scratchpad copies with their SHA-256 re-verified.

**3. One rule across uses?**
The envelope rule is exercised through five placements: a pure read, a
single-statement bulk write, a folded root `update`, a folded root `delete` and
a multi-statement relation-bearing write — all through the same `run` +
`dispatch` seam. The set-oriented owner is exercised by three verbs
(`updateMany`, `delete`, `deleteMany`) plus the bulk verbs, with cardinality as
the only difference. The read-result owner is exercised live and packaged. The
caller-context rule is exercised by the operation's own attribution and by every
nested statement.

**4. What actually grew?**
Incremental, this unit's files, measured with the census owner
(`scripts/query-engine-structure.mjs` `countTokenLines`, JSDoc and EOF
excluded). The repair round added an eighth file, `commands/execution.ts` (three
call sites now name the model a nested locate addresses), so the table is
restated over eight files; the seven-file rows reproduce the reviewed figures
exactly.

| | files | bytes | physical | token-lines |
| --- | --- | --- | --- | --- |
| before (HEAD + G4-01 patch for the three files it also owns) | 7 | 116,906 | 3,594 | 3,543 |
| after, first round | 7 | 135,813 | 4,055 | 3,834 |
| before, eight files (+ untouched `execution.ts`) | 8 | 142,598 | 4,344 | 4,288 |
| after the repair round | 8 | 167,117 | 4,926 | 4,633 |
| **unit increment (with repair)** | 0 | **+24,519** | **+582** | **+345** |
| of which the repair round | 0 | +5,612 | +121 | **+54** |

Cumulative candidate core (every `.ts` under
`src/query-engine/raptor3/commands` + `.../shared`, 12 files): **8,982**
token-lines / 9,435 physical / 319,209 bytes — 8,928 before the repair, so the
+54 above is the whole cumulative movement. The per-file manifest, each file's
SHA-256 and the census-function SHA-256
(`15889231a22297fcf001ae22ca01e6e8c9cd7489dd635c60529dfdc0ac06461e`, the same
function the G3 accounting used) are saved at
[`receipts/repair/candidate-source-cost.json`](receipts/repair/candidate-source-cost.json)
so the figure is reproducible — this closes the review's unverified claim 1 for
the core figure. The whole raptor3 tree (15 files) is 9,751 token-lines /
10,293 physical / 348,475 bytes.

**The "complete charged perimeter" figure (13,850 token-lines / 30 files) stays
UNVERIFIED.** Its charged-file manifest was never saved and the perimeter reaches
outside `src/query-engine/raptor3/`, so it cannot be recomputed from anything in
this directory. It is reported as carried forward, not as measured.

Against the unit's expectation: the note expected the entry's per-verb read
branches to collapse (they did — `program/index.ts` lost its verb ladder and its
second read entry) and root single-row writes to fold onto the set-oriented
owner (they did for `update` and `delete`, not for `create`, §8.3). The +291 is
new behavior — root `delete`, the prepared handle, the packaged read, the
envelope rule — not representation support; the only pure support is
`dispatch`/`withinRegion` (about 25 token-lines).

## 10. Phase 2 queue — every `shared/query.ts` change this unit needs

Each entry: what, where, why, and the exact change.

1. **`updateValue`: `decrement`, `multiply`, `divide` (SC-03…SC-06 write side).**
   `Queries.updateValue` (`query.ts:603`) is the sole interpreter of admitted
   scalar update operators and today spells only a subset. Add the remaining
   operators through `adapter.set.multiply`/`divide`/`decrement` for the mutation
   assignment and `expressions.multiply`/`divide`/`subtract` for the symbolic
   updated-key expression, with the provider numeric semantics (int, float,
   bigint, decimal with the exact descriptor). **No JavaScript arithmetic in the
   context** — `OperationContext.updatedIdentity` and
   `CommandExecution.requireTransitions` already call `updateValue` and need no
   change once the operators exist.
2. **Root `delete` projection detail.** If a `delete` projection admits
   `_distance`, `lowerProjection` must be usable inside `mutations.returning`
   without an alias-bound column reference. Phase 1 gates the fold to
   `kind: "scalar"` fields only; widening the gate needs the projection owner to
   state which lowered fields are RETURNING-safe (a `returningSafe` fact on
   `PreparedProjectionField`, not a second walker).
3. **Q-O04 — collection `_count` ordering over a variant carrier.**
   `Queries.relationOrderTerm` (`query.ts:1670-1690`) calls
   `bindMembership(schema, model, field)` with no variant; a variant carrier has
   no single membership. Change: when the slot is a variant carrier, sum the
   arms' correlated `aggregates.count()` the same way `prepareCounts` +
   `lowerProjection` count a variant collection (one `expressions.add` over the
   arm subqueries, or one count over the carrier's own storage). Same owner, no
   per-provider branch. Phase 1 turns the crash into a named refusal (§4.7).
4. **Q-W10 — tagged variant collection quantifiers over-match.**
   `query.ts:1052-1090` builds one arm per quantifier entry and ANDs them;
   `board.findMany` answered `[{id:1},{id:2}]` where the hand-computed value is
   `[{id:2}]`. The quantifier must apply to the **tagged** membership only
   (`some: { type: T, is: P }` = "some member of arm `T` satisfying `P`"), not to
   the untagged union. Change in `relationSlot`/`relationPredicate`.
5. **RF-16 — recursive read decodes a malformed bigint.**
   `Queries.recursive` (`query.ts:2316`) carries bigint through the CTE without
   the carrier transport cast the ordinary carrier applies (handoff §11.7: inside
   a JSON carrier a `bigint` is cast to text). Change: apply the same
   `expressions.cast(column, "text")` transport rule inside the recursive
   descendant projection, so `decodeValue` sees canonical integer text.
6. **SC-13 — vector refusal identity (§8.2).** If the refusal is raised by
   `Queries.fieldValue`/`decodeValue` calling `adapter.vector.literal` on an
   incapable provider, the owner must raise the identity the shipped engine
   raises for the same public request. Phase 1 records the measured shipped
   identity; phase 2 lands it in the one owner.
7. **D-1 predicate support.** If the single-statement classification is ever
   needed *before* construction (for example to answer a route question), it must
   come from the same construction, not a second predicate. No change is needed
   for phase 1's design; entry kept so phase 2 does not add one.

11. **Fold the published read facts into the `Read` value.** DONE in the repair
    round as far as phase 1 allows: `publishesSingleRow` is deleted and
    `prepare().read` derives `{shape, single, empty}` from the prepared `Read`
    itself (`value.result([])`), so no second statement of the cardinality
    exists. What still belongs in `query.ts`: the PUBLIC value's own shape.
    `Read.query.shape` is the ROW shape, which is the public shape for every
    verb except `count`/`exist` (they publish a number and a boolean derived
    from the row's `_count`), and `ProjectionShape` has no root scalar form to
    say so — `empty` carries the value's kind instead. Add `readonly single:
    boolean` and a public-value shape to the `Read` interface, have `read()` set
    them beside `result`, and `PreparedRead` becomes a straight forward of them.
12. **Root `create` fold (§8.3).** `INSERT … RETURNING <projection>` for a
    relation-free create with a relation-free projection on a RETURNING adapter,
    the way `UpdateOperation`/`DeleteOperation` fold. It must first be settled
    with the owner of `tests/raptor3/post-prep/g29-result-progress.test.ts`: its
    corrupting drivers only corrupt statements matching `^SELECT`, so a folded
    create silently stops witnessing the malformed-result translation. Either the
    specimen moves to a shape that still reads (a non-returning adapter or a
    relation projection), or the driver corrupts `RETURNING` responses too.
13. **Widen the RETURNING-safety gate.** `namesRelation` in
    `shared/operation-context.ts` answers "may this prepared projection ride a
    mutation's RETURNING?" by requiring every field to be `kind: "scalar"`. That
    fact belongs to the projection owner: give `PreparedProjectionField` a
    `returningSafe` fact and let `_distance` (a scalar expression over the
    mutated row) through, instead of a second classification in the physical
    owner.
8. **Native recursive lowering.** `Queries.recursive` must compose
   `adapter.subqueries.recursive`/`cte.recursive` on PostgreSQL and MySQL with the
   same semantics it has on SQLite (depth-as-edges, path-local cycle stop,
   pruning, separate overlapping occurrences). Phase 1 runs the native lanes and
   records what each provider answers; any adapter gap is recorded as a seam.
9. **Indexable `withinBounds` pre-filter beside the GeoPoint distance predicate**
   (handoff §11.8, brief 13). Only if a provider plan requires it, in
   `lowerOperation`, never in a new owner. Phase 1 records the decision; no
   provider plan measured yet.
10. **Decimal `having { _sum: … }` operand domain** (handoff §11.8): binds in the
    field's domain rather than the widened `_sum` domain. One-line fix in
    `fieldValue`'s aggregate-target operand.

## 11. Route follow-up (G4-03's file — exact changes, not made here)

Phase 1 makes each of these a one-line consumption. None is made in this unit.

### 11.1 Consume the prepared read (`route/client-route.ts`)
```
-  const engine = createCommandEngine({ schema, driver: factoryDriver });
+  const engine = createCommandEngine({ schema, driver: factoryDriver });
   …
-      return {
-        preparedArgs: args,
-        cacheResultCodec() { throw new UnsupportedOperationError(…B-1…); },
-        prepareBatch() { return engine.prepareBatch(modelName, operation, args); },
+      const prepared = engine.prepare(modelName, operation, args);
+      return {
+        preparedArgs: prepared.args,
+        cacheResultCodec() { /* build from prepared.read.shape / .single */ },
+        prepareBatch() { return prepared.prepareBatch(); },
```
and `execute` calls `prepared.execute(binding, execution.context)`.

### 11.2 Thread the trusted context (B-4)
Every `engine.execute(modelName, operation, args, binding)` becomes
`prepared.execute(binding, execution.context)`. That alone turns the two red
`g4-lifecycle-events` cells green; nothing in the candidate needs to change
again.

### 11.3 Stop wrapping every borrowed write (D-1, brief item 11)
```
-  return engineDriver.withTransaction(
-    (scoped) => engine.execute(modelName, operation, args, {
-      kind: "borrowed-transaction",
-      driver: scoped as AnyDriver,
-      memberRollback: (execute, context) =>
-        (scoped as AnyDriver).withTransaction(execute, undefined, context),
-    }),
-    undefined,
-    execution.context
-  );
+  return prepared.execute(
+    {
+      kind: "borrowed-transaction",
+      driver: engineDriver,
+      memberRollback: (execute, context) =>
+        engineDriver.withTransaction(execute, undefined, context),
+    },
+    execution.context
+  );
```
**Until this lands, D-1 is unchanged through the route** (the route's own region
still makes a failing single-statement write non-poisoning), and a multi-statement
borrowed write pays one extra nested savepoint because both the route and the
candidate open a region. The candidate side is pinned directly in this unit's
author tests, which construct the exact binding the corrected route will pass.

### 11.4 Schema reuse (B-3)
`ClientOperationRouteFactory` gains the already-resolved views, and
`src/client/client.ts:492` passes `{ index, registry }` into
`createCommandEngine({ schema, driver, resolved })`.

## 12. Completion record

### 12.1 Fast-path statement and round-trip table

Measured by `tests/raptor3/g4/unit02/physical-envelope.test.ts` on SQLite
(`RecordingSQLiteDriver` counts every `_execute`/`_executeBatch` and every
`withTransaction`); the shipped column is the same public request through
`createClient` on the same driver.

| Workload | Candidate before | Candidate after | Shipped | Round trips after |
| --- | --- | --- | --- | --- |
| `scalar-find-unique` (`findUnique`) | 1 statement, 0 tx | **1 statement, 0 tx** | 1 statement, 0 tx | 1 |
| `fixed-collection-rowref-20` (`findMany` + include) | 1 statement, 0 tx | **1 statement, 0 tx** | — | 1 |
| `count` | 1 statement, 0 tx | **1 statement, 0 tx** | — | 1 |
| `flat-scalar-update` (`update` + `increment`) | 3 statements, 1 tx | **1 statement, 0 tx** | 1 statement, 0 tx | 1 |
| `bulk-update-returning` (`updateMany` + select) | 1 statement, 1 tx | **1 statement, 0 tx** | — | 1 |
| root `delete` (new) | — | **1 statement, 0 tx** | 1 statement, 0 tx | 1 |
| `updateMany` with `limit: 0` | 0 statements, 1 tx | **0 statements, 0 tx** | — | 0 |
| `createMany`, 2 rows, one column set | 1 statement, 1 tx | **1 statement, 0 tx** | 1 statement, 0 tx | 1 |
| `createMany` past the bind budget (3 rows, cap 8) | n statements, 1 tx | **2 statements, 1 tx** (sentinel recovers once) | — | 2 |
| root `create` (scalar only) | 2 statements, 1 tx | **2 statements, 1 tx** | **1 statement, 0 tx** | 2 |
| relation-bearing `update` (`nested-conditional`-shaped) | n statements, 1 tx | **n statements, 1 tx** | — | unchanged |
| `update` with a relation projection | n statements, 1 tx | **n statements, 1 tx** | — | unchanged |

No workload's statement or round-trip count increased. The classification agrees
with the shipped engine wherever both were measured **except root `create`**,
which is the single recorded exception (§8.3, falsifier 5): its fold was
withdrawn with evidence and no frozen fast-path workload is a root `create`.
The `createMany` rows were added in the repair round (review finding 3); the
2-row row moved from 1 tx to 0 and now equals the shipped cost.

### 12.2 Suites

Receipts under [`receipts/`](receipts/); `inherited/` is the pre-edit red list,
`final/` the post-edit state.

| Suite / mode | Result | Receipt |
| --- | --- | --- |
| G4-02 author checks (4 files + 1 native, 25 cells) | **24 passed, 1 skipped** | [`final/unit02-author-checks.log`](receipts/final/unit02-author-checks.log) |
| `g4-read-contracts` | 58 passed / **4 failed** — the same four inherited cells, unchanged | [`final/g4-read-contracts.log`](receipts/final/g4-read-contracts.log) |
| `g4-route-lifecycle` | 7 passed | [`final/g4-route-lifecycle.log`](receipts/final/g4-route-lifecycle.log) |
| `g4-route-cache` | 6 passed | [`final/g4-route-cache.log`](receipts/final/g4-route-cache.log) |
| `g4-route-admission` | 4 passed / **1 failed** — pre-existing, falsified below | [`final/g4-route-admission.log`](receipts/final/g4-route-admission.log) |
| `g4-route-transactions` | 10 passed / **1 failed** — the D-2 divergence pin, which flips because the divergence is RESOLVED | [`final/g4-route-transactions.log`](receipts/final/g4-route-transactions.log) |
| `g4-lifecycle-events` | 1 passed / **2 failed** — B-4, unchanged: needs the route to pass `execution.context` (§11.2) | [`final/g4-lifecycle-events.log`](receipts/final/g4-lifecycle-events.log) |
| `g4-lifecycle-admission` | 3 passed / **1 failed** — B-1, unchanged: needs the route to consume `prepare().read` (§11.1) | [`final/g4-lifecycle-admission.log`](receipts/final/g4-lifecycle-admission.log) |
| `g4-generation-selftests` | 6 passed | [`final/g4-generation-selftests.log`](receipts/final/g4-generation-selftests.log) |
| `g1-contracts` / `g2-contracts` / `g25` / `g27` | 143 / 216 / 6 / 6 passed | [`final/`](receipts/final/) |
| `g3p02` / `g3p03` / `g3p04` / `g3p04-review` | 4 / 6 / 5 / 5 passed | [`final/`](receipts/final/) |
| `g3p05-contracts` + its three focused modes | 21 / 11 / 4 / 6 passed | [`final/`](receipts/final/) |
| `g3-bulk-series` / `g3-suppression-retry` / `g3-transaction-array` / `g3-depth-recurrence` | 6 / 2 / 4 / 6 passed | [`final/`](receipts/final/) |
| candidate core (7 files) | 136 passed | [`final/candidate-core.log`](receipts/final/candidate-core.log) |
| expanded commands (4 files) | 141 passed | [`final/expanded.log`](receipts/final/expanded.log) |
| transitions commands (17 files) | 218 passed | [`final/transitions.log`](receipts/final/transitions.log) |
| ownership / polish / occurrence ownership | 17 passed | [`final/ownership-polish.log`](receipts/final/ownership-polish.log) |
| prep (8 files) | 37 passed | [`final/prep.log`](receipts/final/prep.log) |
| post-prep (9 files) | 48 passed | [`final/post-prep.log`](receipts/final/post-prep.log) |
| core-structure (`*.test.ts`, not `measurement/`) | 37 passed | [`final/core-structure.log`](receipts/final/core-structure.log) |
| `core-structure/measurement/extension-campaign.selftest.test.ts` | 32 passed / **10 failed** — PRE-EXISTING, falsified in §12.4b | [`falsify/cs03-selftest-current.log`](receipts/falsify/cs03-selftest-current.log) |
| PGlite lane (`produced-commands`, `batch-produced-commands`, `g29-result-progress-pglite`) | 3 + 2 + 1 passed | [`final/pglite*.log`](receipts/final/) |

**Environment note.** Two PGlite runs and one prep run exceeded the runner's
1,536 MiB sampled RSS ceiling and exited 1 with every test passing; the ceiling
is the harness's resource guard, not a test result, and the logs show the pass
lines. Re-running `batch-produced-commands` alone stayed under the ceiling
(1,520.6 MiB) and exited 0.

### 12.3 Native providers (first real run of the G4 native suites)

Containers: `viborm-raptor3-g3-pg-20260914`
(`7dfda37e8eea…`, image `95206741…`, PostgreSQL 16, **127.0.0.1:65504**, restarts 0)
and `viborm-raptor3-g3-mysql-20260914`
(`d6da412eec3c…`, image `b3b90af2…`, MySQL 8.4, **127.0.0.1:65515**, restarts 0);
[identity receipt](receipts/native-container-identity.txt).

| Mode | Provider | Result | Receipt |
| --- | --- | --- | --- |
| `g4-read-envelope-pg-contracts` (**first ever run**) | pg :65504 | 2 passed / **2 failed** | [`native/g4-read-envelope-pg-contracts.log`](receipts/native/g4-read-envelope-pg-contracts.log) |
| `g4-read-envelope-mysql-contracts` (**first ever run**) | mysql :65515 | **4 failed at seed time** | [`native/g4-read-envelope-mysql-contracts.log`](receipts/native/g4-read-envelope-mysql-contracts.log) |
| `g27-pg-contracts` / `g27-mysql-contracts` | both | 1 / 1 passed | [`native/`](receipts/native/) |
| `g3p04-pg-contracts` / `g3p04-mysql-contracts` | both | 4 / 4 passed | [`native/`](receipts/native/) |
| `g3-scope-composition-pg` / `-mysql` | both | 2 / 2 passed | [`native/`](receipts/native/) |
| `g29-member-dependency-pg` / `-mysql` | both | 2 / 2 passed | [`native/`](receipts/native/) |
| `post-g3-clearability-pg-contracts` / `-mysql-contracts` | both | 2 / 2 passed | [`native/`](receipts/native/) |
| `g4-unit02` native date probe | pg :65504 | 1 passed | [`native/unit02-native-date.log`](receipts/native/unit02-native-date.log) |

**The two native G4 failures are fixture defects, not candidate gaps:**

1. **PostgreSQL `date`.** `Driver "pg" returned a malformed date scalar … the
   Date is invalid or not UTC midnight.` The `pg` driver deliberately returns
   DATE (OID 1082) as raw text so the result parser can build a UTC `Date`
   (`src/drivers/pg/index.ts:46-60`), but that override only applies to a pool
   the DRIVER creates; `tests/raptor3/transitions/live-world.ts:363` builds its
   own `new PgPool(pgOptions)`, so `pg`'s default parser returns a
   process-local `Date`. The shipped engine applies the identical UTC-midnight
   check (`src/query-engine/result/scalar-result-parser.ts:365-380`), so it fails
   the same way on that fixture. **Proof:** on a driver-owned pool against the
   same container, the shipped client and the candidate decode the same DATE
   column identically to `2026-03-05T00:00:00.000Z`
   ([`native/unit02-native-date.log`](receipts/native/unit02-native-date.log),
   `tests/raptor3/g4/unit02/native-date-codec.test.ts`).
2. **MySQL, all four cells.** They fail **before any candidate work**, inside
   the fixture's own seed `write`:
   `Incorrect datetime value: '2024-01-15T10:30:00.123Z' for column
   'moment_value' at row 1` — an ISO-Z literal MySQL will not accept for
   `DATETIME(3)` (stack: `live-world.ts:385` ← `read-envelope-native.test.ts:246`).

The remaining PostgreSQL failure, `g4-native-recursive-read-fit` (`42883`,
undefined function), is a genuine candidate gap in `Queries.recursive` and is
queued at §10.8.

### 12.4 Falsifications

| Claim | Mutation | Result |
| --- | --- | --- |
| `g4-route-admission`'s red cell is pre-existing, not the new `delete` verb | `case "delete":` removed from `admittedOperation` | still **1 failed**, on the FIRST entry (`findFirst`, a G4-01 verb) — [`falsify/route-admission-without-delete-verb.log`](receipts/falsify/route-admission-without-delete-verb.log); source restored, SHA-256 `cb228de1…` re-verified |
| The envelope rule and the context threading are load-bearing | `plan.single` forced to `false`; `statementContext` reverted to minting | **7 failed / 17 passed** — exactly the envelope, delete, borrowed and context cells — [`falsify/mutated-envelope-and-context.log`](receipts/falsify/mutated-envelope-and-context.log); both sources restored, SHA-256 re-verified |
| The `memberRollback` operation region breaks qualified G3 contracts | region implemented, then reverted | `g3-suppression-retry` **2 failed** and `g3-scope-composition-pg`/`-mysql` **1 failed each**, all with `TransactionError … cannot be used while its nested transaction is active`; receipts under [`receipts/withdrawn-operation-region/`](receipts/withdrawn-operation-region/); source restored, SHA-256 `5eb8f417…` re-verified, and all three green again afterwards ([repair receipts](receipts/repair/)) — re-measured in the repair round, §8.4 |

### 12.4b The G0 gate's one red, and the harness CLI self-test

`scripts/raptor3-cli.test.mjs` has one failing case,
*"test:all cannot replace the required lane through inherited specimen
variables"*: it runs the `g0` gate as a child and requires exit 0. The gate
reports **10 failed / 748 passed**, and all ten are in one file,
`tests/raptor3/core-structure/measurement/extension-campaign.selftest.test.ts`
(`Missing semantic cut choice:found|missing/root-member/0`), which this unit's
suite sweep missed because `tests/raptor3/core-structure/*.test.ts` does not
recurse into `measurement/`.

**It is pre-existing, and falsified as such.** The seven files this unit owns
were swapped for their exact pre-edit content (HEAD + the G4-01 patch for the
three files that unit also owns), the selftest was re-run, and it failed
**identically — 10 failed / 32 passed**:

| Tree | Result | Receipt |
| --- | --- | --- |
| current | 10 failed / 32 passed (42) | [`falsify/cs03-selftest-current.log`](receipts/falsify/cs03-selftest-current.log) |
| pre-edit (this unit's files reverted) | 10 failed / 32 passed (42) | [`falsify/cs03-selftest-pre-edit.log`](receipts/falsify/cs03-selftest-pre-edit.log) |

The files were restored from the scratchpad copies and re-verified against
`production.patch`, which reconstructs all seven byte-identically.
Harness self-test receipt:
[`final/harness-selftests.log`](receipts/final/harness-selftests.log)
(`node --test`, the runner the witness stream uses; the safe vitest runner finds
no `.mjs` test files, which is not a failure).
`node scripts/credential-free-test-manifest.mjs` exits 0.

### 12.5 Typecheck

`node scripts/run-typecheck.mjs`, run last, after every source edit and after
the falsification restores: **exactly two diagnostics, both permitted**
(`src/query-engine/pattern/pack.ts:1443`, `:2633`). 6.38 s wall, 5,685.3 MiB
peak sampled RSS, teardown verified —
[`final/typecheck.log`](receipts/final/typecheck.log). Re-run in the repair
round: see §R.5.

### 12.6 Files and identities

**Superseded by §R.6 after the repair round.** Production, this unit only
([`production.patch`](production.patch), SHA-256 `3ce0d456…` at review time,
verified to reconstruct all seven files byte-identically):

- `src/query-engine/raptor3/shared/operation-context.ts`
- `src/query-engine/raptor3/commands/commands.ts`
- `src/query-engine/raptor3/commands/index.ts`
- `src/query-engine/raptor3/commands/assignments.ts`
- `src/query-engine/raptor3/shared/schema.ts`
- `src/query-engine/raptor3/shared/storage.ts`
- `src/query-engine/raptor3/program/index.ts`

Tests ([`tests.patch`](tests.patch), SHA-256 `b4a8009a…` at review time): five
new files under `tests/raptor3/g4/unit02/` plus one type-narrowing line in
`tests/raptor3/g3/generation/transport-plans.ts` (its
`ReturnType<typeof createCommandEngine>` alias became a `Pick` of the two
entries it drives, so the harness still compiles against the prepared handle).

**`src/query-engine/raptor3/shared/query.ts` was NOT edited** (SHA-256
`1cd9bcd217bbb1de955cec389b0818c1af29788bc77172524a841f76c093910b`). Integrator
note: that content is **not** what `g4/unit01/production.patch` produces — the
tree's copy lacks r4's `exactDecimalDomain` refusal, so the main tree appears to
carry an earlier G4-01 revision than the patch file recorded at 01:39.

No file was committed or staged. `CONTEXT.md`, `memory.md`,
`tests/pattern/pack/program-dump.ts`, the witness stream's script/manifest edits
and the G4-03 seams are untouched.

### 12.7 `commands/execution.ts` and the adapter seams

*(True at review time; the repair round edits `execution.ts` — see §R.6.)*
Neither was edited. `execution.ts` needed no change: root `delete` reuses the
existing `Deletion`/selected-series machinery through `OperationContext`, and the
envelope rule is entirely in the context. **No adapter seam was added**: every
capability the realized obligations need (`mutations.delete`,
`mutations.returning`, `set.assign`, `operators.*`) already exists on all three
dialects.

---

# Repair (round 2, after the independent review returned REVISE)

Review: [`../unit02-review.md`](../unit02-review.md). One blocking and four
must-fix findings; the review's own probe suite
(`tests/raptor3/g4/review/unit02/`, the reviewer's estate, not edited) is the
falsifier for each. Every receipt in this section is under
[`receipts/repair/`](receipts/repair/) and
[`receipts/withdrawn-operation-region/`](receipts/withdrawn-operation-region/).

## R.0 Finding → status

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 1 | **blocking** | a packaged root `delete`/`update` that finds no row lets its array siblings commit | **fixed** (§R.1) |
| 2 | must-fix | B-4 threading drops the nested model the shipped engine keeps; §4.2's justification is factually wrong | **fixed** (§R.2) |
| 3 | must-fix | the stated envelope rule is not the operative decision; its recovery is unreachable; two shapes violate its falsifier | **fixed**, with root `create` recorded as the one exception (§R.3) |
| 4 | must-fix | the withdrawn `memberRollback` failures have no receipts; the cited logs are passing runs | **fixed** — re-measured, failing receipts saved (§R.4) |
| 5 | must-fix | the published read facts are wrong for `count`/`exist`; the agreement check skips them | **fixed** (§R.5) |
| 6 | note | obligation 10 (schema reuse) has no caller and no test | **not done** — recorded (§R.7) |
| 7 | note | the two public entries admit twice for one operation | **claim scoped**, not changed (§R.7) |
| 8 | note | §4.4's `deleteMany` "latent-bug fix" is unfounded | **fixed** — §4.4 corrected |
| 9 | note | two registered G4 modes stay red for witness-owned reasons | unchanged; the knock-on the reviewer names is passed on (§R.7) |
| 10 | note | `prepared.read` is a fresh object on every access | **fixed** — memoized beside the handle's admission (§R.5) |
| 11 | note | verified author claims | recorded |

## R.1 Blocking — the packaged presence premise

**What was wrong.** `published` owns the root single-row missing-row failure. In
`batch-preparation` that failure travels inside `preparedParser`, which the array
owner runs AFTER `$transaction([...])` has submitted and committed its one batch,
so a missing row raised the right error while every sibling stayed durable. The
shipped engine never does this: a batch has no JavaScript postcondition, so
`DeleteOperation` replaces the fold's `expects` with a PRESENCE GUARD statement
inside the same batch (`DeleteOperation.ts:207-245`, `buildRootPresenceGuard`).

**Change.** `OperationContext.packagedPresence(model, selector, single)`, stated
beside `published` because it is the same premise in the other substrate: when
(and only when) the ownership is `batch-preparation` and a `single` failure
exists, it queues one `adapter.assertions.exists(<select keys where selector>)`
ahead of the mutation and records a `PreparedBatchGuard`
(`queryIndex`, `premise: "exists"`, `probe`, `failure: {kind: "notFound"}`,
`model`, `operation`). `preparedBatch()` carries those guards in the
`PreparedBatchOperation.guards` field that the shared batch protocol already
defines and already consumes (`array-transaction-native.ts:96`,
`batch-error-attribution.ts`), which re-attributes the index at the merge offset
and reconstructs `NotFoundError(model, operation)` — byte-identical to the
`single()` closure `Commands.plan` supplies. No fallback, no shipped-engine
import: the guard record is data on an existing boundary type.

I chose the reviewer's first resolution rather than refusing packaging, because
refusing it would have raised `TransactionError` ("…cannot be batched
atomically") where the shipped engine raises `NotFoundError` — the probe's second
assertion would still have failed.

**Falsifiers.** The reviewer's `packaged-cardinality.review.test.ts` now passes
all three cells (`DELETE candidate` / `UPDATE candidate` now store
`[present]`, like shipped, and reject with `NotFoundError`). The unit's own pin
is the new [`tests/raptor3/g4/unit02/packaged-array.test.ts`](../../../../../tests/raptor3/g4/unit02/packaged-array.test.ts):
missing delete, missing update, a PRESENT delete that must still commit the whole
array, the packaged plan's shape (`[EXISTS guard, DELETE]` + exactly one guard
record), and `deleteMany` carrying no premise. Receipt:
[`repair/unit02-author-checks.log`](receipts/repair/unit02-author-checks.log),
[`repair/review-probes.log`](receipts/repair/review-probes.log).

## R.2 Statement context — model parity with the shipped engine

**Change.** `statementContext(model, operation)` returns the caller's context
only while `callerAttribution.model === model["~"].names.ts`, and otherwise
`deriveStatementExecutionContext(callerAttribution, model["~"].names.ts!)` — the
snapshot owner's public helper, which keeps the correlation id, instrumentation
and resolved extension chain. `OperationContext.read(query, internal, terminal,
model?)` gained the model a statement addresses, and the five sites that know it
pass it (`deleteMany`'s series read, `captureMutationIdentities`, and three
locate reads in `commands/execution.ts`), because a nested locate is a SELECT and
never went through `statementContext` at all.

**Measured** (reviewer's `statement-context.review.test.ts`):

```
CTX shipped   [SELECT author, SELECT post, UPDATE author, UPDATE post, SELECT author]
CTX candidate [SELECT author, UPDATE author, SELECT post, UPDATE post, SELECT author]
```

Same per-statement model multiset (`author×3, post×2`); the order differs because
the shipped engine locates both records before writing and the candidate locates
each record beside its write — a plan-order difference, not an attribution one.

**Pin changed as the review asked.** `borrowed-envelope.test.ts` no longer
asserts "every statement carries the root model": it keeps the chain and
correlation-id assertions and adds model-parity against the shipped engine's own
per-statement tally for the same request.

## R.3 The envelope rule is now the operative decision

**Change.** `PhysicalPlan.single` is an ADMISSIBILITY, not a count: "may this
form reduce to one statement?" A form whose SHAPE rules it out (a locate-then-
mutate route, a per-row recoverable skip, a re-read after a non-RETURNING write)
answers `false` and opens its region immediately; every other form is admitted
and the COUNT is answered by the construction at `dispatch`, which raises the
sentinel before any provider work. The only gate that was wrong is `createMany`,
which decided by ROW count: `values.length === 1` is gone.

**Consequences, measured** (`physical-envelope.test.ts`, and the reviewer's
`envelope-rule-owner` / `delete-and-envelope` probes):

| shape | before | after | shipped |
| --- | --- | --- | --- |
| `createMany`, 2 rows, one column set | 1 statement, 1 tx | **1 statement, 0 tx** | 1 statement, 0 tx |
| `createMany`, 2 rows + `select` | 1 statement, 1 tx | **1 statement, 0 tx** | — |
| `createMany`, 3 rows, bind cap 8 | — | **2 statements, 1 tx**, sentinel recovers **once** | — |
| root `create` (scalar only) | 2 statements, 1 tx | 2 statements, 1 tx | 1 statement, 0 tx |

The sentinel is now reachable and driven by an executed check: the bind-budget
cell instruments `OperationContext.prototype.restart` for the duration of the
call and asserts `restarts === 1`, with all three rows written exactly once (the
re-run repeated construction only). The two `createMany` cells share ONE plan
admissibility, so the difference between 0 and 1 transaction can only come from
the rule itself. `get statementAtomic()` had no consumer in `src/` or `tests/`
and is deleted; `restart()`, `performed` and `requiresEnvelope` are load-bearing.

The reviewer's `envelope-rule-owner.review.test.ts` now passes both its
assertions (`oneStatementWithEnvelope` empty; `RESTARTS 0` for ITS nineteen
shapes, none of which is bind-budget-split).

**Root `create` stays the exception**, and it is now written into §5 D-a,
falsifier 5 and §12.1 instead of being absent from them. Its fold was withdrawn
with evidence in §8.3 (it stops the G2.9 malformed-result witness from
witnessing, [`receipts/after1/prep.log`](receipts/after1/prep.log)) and no frozen
fast-path workload is a root `create`. The reviewer's "root create" agreement
cell therefore stays red **by design**; it is the one cell of that probe that
does.

## R.4 §8.4 evidence

The withdrawn `memberRollback` operation region was re-implemented on the
reviewed tree (one change: `region()` answers the grant for a borrowed
ownership), the three contracts were re-run, and the failing logs are saved:

| Mode | Result | Receipt |
| --- | --- | --- |
| `g3-suppression-retry` | **2 failed** — `TransactionError … "sqlite3" cannot be used while its nested transaction is active` (V5001) on the first cell, and that error where `UniqueConstraintError` is required on the second | [`withdrawn-operation-region/g3-suppression-retry.log`](receipts/withdrawn-operation-region/g3-suppression-retry.log) |
| `g3-scope-composition-pg` | **1 failed** — same error, driver `"pg"` | [`…/g3-scope-composition-pg.log`](receipts/withdrawn-operation-region/g3-scope-composition-pg.log) |
| `g3-scope-composition-mysql` | **1 failed** — same error, driver `"mysql2"` | [`…/g3-scope-composition-mysql.log`](receipts/withdrawn-operation-region/g3-scope-composition-mysql.log) |

`operation-context.ts` was then restored from the scratchpad copy taken before
the experiment, its SHA-256 re-verified (`5eb8f417…`, the reviewed content) and
`git apply -R --check production.patch` re-run clean before any repair edit. All
three modes are green again on the repaired tree
([`repair/g3-suppression-retry.log`](receipts/repair/g3-suppression-retry.log),
[`repair/native/`](receipts/repair/native/)).

The §8.4 claim that `g3-suppression-retry` reported **4** savepoints instead of 3
is **withdrawn** — it was never what the mode reports. The conclusion (a
`memberRollback` grant is member isolation, not an operation-region grant) is
unchanged and now evidenced.

## R.5 The published read facts

**Change.** `publishesSingleRow` is deleted from `shared/schema.ts`.
`prepare().read` answers `{ shape, single, empty }`, all three read from the
prepared `Read` itself:

- `empty = read.result([])` — the read owner's own publication for zero rows;
- `single = empty === null || (typeof empty === "object" && !Array.isArray(empty))`;
- `shape = read.query.shape`, documented as the ROW shape the statement decodes.

There is now no second statement of the cardinality to disagree with, and the
facts describe the public value: `count` → `single false`, `empty 0`; `exist` →
`single false`, `empty false`; `count` WITH a select → `single true`, `empty {}`
(its public value really is a record of counts); `aggregate` → `single true`;
`findMany`/`groupBy` → `single false`, `empty []`. The public value's own SHAPE
for `count`/`exist` is not expressible in `ProjectionShape` (it has no root
scalar form); `empty` carries the value's kind instead and §10.11 records the
`query.ts` change that removes the gap.

The facts object is memoized beside the handle's admission, so
`prepared.read === prepared.read` (review note 10).

**Pin.** `prepared-operation.test.ts`'s agreement check now walks **every**
`ReadOperation` (8 requests incl. both `count` forms) and compares `single`,
`typeof empty` and `Array.isArray(empty)` against the value the handle actually
publishes. The reviewer's `prepared-and-bulk.review.test.ts` read-facts cell
passes.

## R.6 Files, identities, cost, suites

**Production — eight files** ([`production.patch`](production.patch), SHA-256
`8295d338569b68a5e181754c0deba94d6c22e5dc83247ce6ddccc3334936d974`, verified to
reconstruct all eight byte-identically from the pre-unit content, and
`git apply -R --check` clean against the tree):

| file | SHA-256 |
| --- | --- |
| `src/query-engine/raptor3/shared/operation-context.ts` | `65aa6f5b0b1248b9b62ef737dbcf60f5ec39da9821a7254c0c44054cbb1e0e08` |
| `src/query-engine/raptor3/commands/commands.ts` | `12442b94ac00c25b6edd42a20c4c454998966a9a78035bf74dcad1536fecdf7d` |
| `src/query-engine/raptor3/commands/index.ts` | `546adce4cfdc25b30ced0921abb6e45decdcc2f35704130efbc0e7ccca0f033c` |
| `src/query-engine/raptor3/commands/assignments.ts` | `1e9b7c529d75f9dd75d40f503d6f8e31bd3c36e87f4677f1b8c23447e3292102` |
| `src/query-engine/raptor3/commands/execution.ts` | `54646ed4cb597ac1dfecd4e05a4899997801205a1386fcbc807a263cb496c8c2` |
| `src/query-engine/raptor3/shared/schema.ts` | `c7a58c9c61d6781c6a885c81a3eb4126a9f2c99e91f8866ea56aeea0c0c10166` |
| `src/query-engine/raptor3/shared/storage.ts` | `752215df492fe2feeccf5ec506223212d7c753a1d5f6e54a11f636f7033e57a2` |
| `src/query-engine/raptor3/program/index.ts` | `4aeb2c14e680129d35dda85888d51402d5b94a220f8666dd34db51b763d1e4bd` |

`commands/execution.ts` is new to this unit's diff (§12.7 said it was untouched;
that is true of round 1 only): three `ctx.read(...)` locate sites now name the
model they address (R.2). No adapter and no driver file was edited, and
**`src/query-engine/raptor3/shared/query.ts` is still NOT edited** (SHA-256
`1cd9bcd217bbb1de955cec389b0818c1af29788bc77172524a841f76c093910b`, unchanged
since the review).

**Tests** ([`tests.patch`](tests.patch), SHA-256
`7ac5724fc757a5396dc6e1fabd6009f0c69f4b5a703f81c5ebb1e3aec9463a67`): six files
under `tests/raptor3/g4/unit02/` (`packaged-array.test.ts` is new) plus the
unchanged one-line `transport-plans.ts` narrowing. `tests/raptor3/g4/review/` is
the reviewer's estate and was not edited.

**Cost.** §9 answer 4 is restated over the eight files: unit increment
**+345** token-lines / +582 physical / +24,519 bytes, of which the repair round
is **+54** / +121 / +5,612. Candidate core is **8,982** token-lines with a saved
per-file manifest at
[`repair/candidate-source-cost.json`](receipts/repair/candidate-source-cost.json).

**Suites re-run in the repair round** (serially, through the bounded runner):

| Suite / mode | Result | Receipt |
| --- | --- | --- |
| G4-02 author checks (5 files + 1 native) | **31 passed, 1 skipped** | [`repair/unit02-author-checks.log`](receipts/repair/unit02-author-checks.log) |
| reviewer's probe suite (7 files, 19 cells) | 15 passed / **4 failed**: root `create` (§R.3, by design) + 3 cells that are themselves the evidence for review notes 7 and 8 (2 admissions; bulk relation `select` refused at admission) | [`repair/review-probes.log`](receipts/repair/review-probes.log) |
| `g4-read-contracts` | 58 passed / **4 failed** — the same four inherited cells | [`repair/g4-read-contracts.log`](receipts/repair/g4-read-contracts.log) |
| `g4-route-transactions` | 10 passed / **1 failed** — the stale D-2 divergence pin | [`repair/g4-route-transactions.log`](receipts/repair/g4-route-transactions.log) |
| `g4-route-admission` | 4 passed / **1 failed** — pre-existing (`findFirst`) | [`repair/g4-route-admission.log`](receipts/repair/g4-route-admission.log) |
| `g4-route-cache` / `g4-route-lifecycle` | 6 / 7 passed | [`repair/`](receipts/repair/) |
| `g4-lifecycle-events` | 1 passed / **2 failed** — B-4, needs the route (§11.2) | [`repair/g4-lifecycle-events.log`](receipts/repair/g4-lifecycle-events.log) |
| `g4-lifecycle-admission` | 3 passed / **1 failed** — B-1, needs the route (§11.1) | [`repair/g4-lifecycle-admission.log`](receipts/repair/g4-lifecycle-admission.log) |
| `g4-generation-selftests` | 6 passed | [`repair/g4-generation-selftests.log`](receipts/repair/g4-generation-selftests.log) |
| `g1-contracts` / `g2-contracts` | 143 / 216 passed | [`repair/`](receipts/repair/) |
| `g3-bulk-series` / `g3-suppression-retry` / `g3-transaction-array` / `g3-depth-recurrence` | 6 / 2 / 4 / 6 passed | [`repair/`](receipts/repair/) |
| `g3p05-contracts` / `g29-result-progress` | 21 / 2 passed | [`repair/`](receipts/repair/) |
| `prep` (10 files) | **37 passed**; 4 native files do not collect without a provider env | [`repair/prep.log`](receipts/repair/prep.log) |
| `post-prep` (9 files) | **48 passed**; exit 1 from the runner's RSS ceiling only | [`repair/post-prep.log`](receipts/repair/post-prep.log) |
| `transitions` (45 files) | **434 passed**; 12 files need a live provider | [`repair/transitions.log`](receipts/repair/transitions.log) |
| `expanded` commands + variant identity | 124 passed | [`repair/expanded-commands.log`](receipts/repair/expanded-commands.log) |
| `core-structure` (6 files) | 37 passed | [`repair/core-structure.log`](receipts/repair/core-structure.log) |
| `core-structure/measurement/extension-campaign.selftest` | 32 passed / **10 failed** — PRE-EXISTING, falsified in §12.4b | [`repair/cs03-selftest.log`](receipts/repair/cs03-selftest.log) |
| PGlite lane (`produced-commands`, `batch-produced-commands`, `g29-result-progress-pglite`) | 3 + 2 + 1 passed | [`repair/pglite-*.log`](receipts/repair/) |
| `node scripts/credential-free-test-manifest.mjs` | exit 0 | [`repair/credential-free-manifest.log`](receipts/repair/credential-free-manifest.log) |

**Native providers** (same containers and ports as §12.3;
`viborm-raptor3-g3-pg-20260914` on 127.0.0.1:65504,
`viborm-raptor3-g3-mysql-20260914` on 127.0.0.1:65515, both `Up`):

| Mode | Result | Receipt |
| --- | --- | --- |
| `g3-scope-composition-pg` / `-mysql` | 2 / 2 passed | [`repair/native/`](receipts/repair/native/) |
| `g4-read-envelope-pg-contracts` | 2 passed / **2 failed** — the fixture DATE defect (§12.3) and the §10.8 recursive gap, both unchanged | [`repair/native/g4-read-envelope-pg-contracts.log`](receipts/repair/native/g4-read-envelope-pg-contracts.log) |
| `g29-member-dependency-pg` / `-mysql` | 2 / 2 passed | [`repair/native/`](receipts/repair/native/) |
| `g3p04-pg-contracts` / `-mysql-contracts` | 4 / 4 passed | [`repair/native/`](receipts/repair/native/) |
| `post-g3-clearability-pg-contracts` / `-mysql-contracts` | 2 / 2 passed | [`repair/native/`](receipts/repair/native/) |
| unit02 native date probe | 1 passed | [`repair/native/unit02-native-date.log`](receipts/repair/native/unit02-native-date.log) |

**Typecheck**, run last, after every source edit
([`repair/typecheck.log`](receipts/repair/typecheck.log)): the two permitted
`src/query-engine/pattern/pack.ts` diagnostics, plus **one diagnostic in the
reviewer's own probe file** —
`tests/raptor3/g4/review/unit02/envelope-rule-owner.review.test.ts(224,41): TS2345
Argument of type 'string' is not assignable to parameter of type 'Operations'`.
It is not this repair's: with this unit's eight files reverted to the exact
reviewed content the same three diagnostics appear
([`repair/typecheck-pre-repair-sources.log`](receipts/repair/typecheck-pre-repair-sources.log),
sources restored afterwards and SHA-256 re-verified). The probe's `Shape` tuple
types its verb as `string`; the one-token fix is `operation as Operations`, and I
did not edit the reviewer's estate to make it.

## R.7 What the repair did NOT change

- **Review note 6 (obligation 10, schema reuse).** `EngineConfig.resolved` still
  has no caller and no check. It needs `src/client/client.ts` and the route file
  (§11.4), neither of which this unit owns, so a check that builds an engine from
  the client's `{index, registry}` belongs with that consumption. Recorded as
  incomplete, not as delivered.
- **Review note 7 (two entries, two admissions).** Unchanged, and the §4.1 claim
  is now scoped: admission happens exactly once **per prepared handle**. The
  engine's two convenience entries each build their own handle, so calling both
  for one payload admits twice; §11.1's route consumption holds ONE handle and
  removes it. Sharing a handle between the entries would need a cache keyed on
  the raw-args object, which is a decision, not a repair.
- **Review note 9, second half.** Now that `delete` is admitted,
  `tests/raptor3/g4/route-admission.test.ts`'s
  `world.client.note.delete({ where: { slug: "present" } })` really removes the
  row, so its later `SELECT slug` assertion is unreachable-but-false. That file
  is the witness author's; passed on, not edited.
- **`query.ts`.** Still phase 2. §10 is unchanged apart from entry 11.

---

# Phase 2 — `shared/query.ts` and the physical envelope's remaining obligations

Written **before the first phase-2 production edit** (§P.9 answers the §7 gate
against the actual diff at completion). Brief: revisions 3 and 4 of
[`../briefs/unit02-physical-provider.md`](../briefs/unit02-physical-provider.md)
(item 11 **revision 4** is the integrator's decision on `operationRegion`).
Contract: [`../unit01/handoff.md`](../unit01/handoff.md) r4 + the r5 increment
(finding K / note M in
[`../unit01-review-followup-3.md`](../unit01-review-followup-3.md)).

## P.0 Writer transfer

**Writer transfer: `shared/query.ts` at
`6f39f82a161b6f3cbc5bc78a550048abf9564396cb950a6d6b96c073358e31a7`** — the
G4-01 r5 identity the integrator merged at 04:40 and recorded in
[`../../g4.md`](../../g4.md) ("Quiet-window integration (04:40)"). Phase 1's
copy was `1cd9bcd2…`; every phase-2 statement about `query.ts` is against
`6f39f82a…`.

## P.1 The red list phase 2 inherits (re-measured on the r5 tree)

`node scripts/run-raptor3.mjs g4-read-contracts` →
[`receipts/phase2/inherited/g4-read-contracts.log`](receipts/phase2/inherited/g4-read-contracts.log):
**58 passed / 4 failed (62)**, the same four cells as phase 1 and with the same
text, so r5 changed none of them:

| Cell | Failure |
| --- | --- |
| SC-13 | `the candidate raised FeatureNotSupportedError (vector.literal is not supported. Load the pgvector extension.) where the shipped engine raises QueryError` |
| Q-W10 | `The candidate disagrees with the hand-computed value for board.findMany` |
| Q-O04 | `Raptor 3 G1 variant carrier membership is not implemented: items` |
| RF-16 | `Driver "sqlite3" returned a malformed bigint scalar for operation "findMany": the value is not a canonical integer.` |

## P.2 Required behavior, per scope item

1. `operationRegion` binding extension + `OperationContext.region()` (brief 11
   rev 4, note §8.4). **Landed first**, identity recorded in §P.10.
2. Every entry of §10 (the phase-2 queue), including 10.12 root `create` fold
   with the plan §5.4 eliminated-cut record for the G2.9 malformed-result
   specimen.
3. The four inherited red read cells.
4. Finding K — refusal precedence: mirror the shipped owner sequence.
5. Note M — handoff r5 entry and falsifiers 19–21.
6. Single-statement `NotFoundError` meta parity (suppress the
   `recordSeriesProgress` wrap when there is no series), or RF-15.
7. Native recursive lowering on PostgreSQL and MySQL.

## P.3 Current owner, per obligation

| Obligation | Current owner | Gap |
| --- | --- | --- |
| borrowed multi-statement envelope | `OperationContext.region()` returns `undefined` for every borrowed ownership | a callback-transaction caller that opened no region of its own cannot transfer one; the route keeps wrapping (D-1 residue) |
| scalar update arithmetic | `Queries.updateValue` spells `increment` and `set` only | `decrement`/`multiply`/`divide` raise `Raptor 3 G1 update operator is not implemented` |
| collection `_count` | `correlatedCount` (projection) **and** a second correlated count inside `relationOrderTerm` | two spellings of one fact; neither can address a variant carrier, which has no single membership |
| tagged variant quantifier | `prepareSlotPredicate`'s `many` arm | answers a wrong value for `some`/`none`/`every` over a tagged arm |
| carrier transport | `carriedValue` (relation carriers, grouped) **and** `projectedDocument` inside `Queries.recursive` | the recursive carrier applies its own weaker rule, so `bigint`/`blob`/list/json cross it unprotected (RF-16) |
| vector value crossing | `scalarValue` always calls `adapter.vector.literal` | an incapable provider answers a different refusal than the shipped engine |
| owner sequence of a read | `select()` prepares the projection, then the selector, then pages | every `where`-owned refusal wins where the shipped engine raises the cursor refusal (finding K) |
| root `create` | `Commands.plan` → `execution.complete` (record command, insert, re-read) | 2 statements + 1 transaction where the shipped engine costs 1 and 0 |
| RETURNING safety | `namesRelation(projection)` in `shared/operation-context.ts` | a physical owner classifies a projection the projection owner already understands |
| single-row missing failure meta | `OperationContext.failure` wraps whenever `usesBatch` and a segment committed | a statement-atomic operation has no series and the shipped engine attaches no progress |
| decimal `having { _sum }` operand | `lowerOperation`'s `bind` → `scalarValue` (field domain) | the compared expression is `SUM(col)`, whose domain is the widened one |

## P.4 Smallest proposed change

### P.4.1 `operationRegion` (brief 11 rev 4) — landed first

`ExecutionBinding`'s borrowed arm gains `operationRegion?: MemberRollback`
exactly as §8.4 wrote it. `region()` answers it for a borrowed ownership and
keeps answering `driver.withTransaction` for a standalone one; with no grant a
borrowed operation still opens nothing, which is the array fallback and the
shipped `runLinearOn` behavior. One consequence follows and is stated here
because it is the only way the two grants can coexist: while the operation's
OWN region is open, member isolation nests inside **that** scope
(`this.transport.withTransaction`) rather than re-entering the caller's grant —
re-entering it is precisely the `TransactionError: … cannot be used while its
nested transaction is active` that §8.4 measured. The rule is one sentence: *a
member rollback opens inside whatever scope the operation is currently running
in*.

### P.4.2 One carrier transport rule (§10.5, RF-16)

`Queries.recursive`'s `projectedDocument` stops spelling its own rule and calls
`carriedValue(shape.fields[field], expression)` — the same owner the relation
carrier and `grouped` already use. `bigint` is then cast to text inside the CTE
carrier, `blob` goes through `blobToHex`, and a value that is already JSON is
wrapped in `json.document` instead of arriving as a quoted string.

### P.4.3 One counted-slot owner (§10.3, Q-O04)

`correlatedCount` takes the memberships a slot counts — one edge for an ordinary
relation, **every arm** for a variant carrier — and sums them with
`expressions.add`. `prepareCounts` and `relationOrderTerm` both consume it, so
the second correlated-count spelling inside `relationOrderTerm` disappears and
`_count` over a variant carrier becomes expressible in the projection and in
the ordering at the same time, from one place.

### P.4.4 The tagged quantifier means the tagged membership (§10.4, Q-W10)

`some: { type: T, is: P }` is "some member of arm `T` satisfying `P`";
`none: { type: T }` is "no member of arm `T`"; `every: { type: T, is: P }` is
"every member of the WHOLE collection is an arm-`T` member satisfying `P`" —
which is why `board 1`, whose items are two posts and one tag, is excluded by
`every: { type: "post", … }` while `board 2` (no members) is vacuously included.
`every` is therefore the only tagged quantifier that must also state the other
arms: it is `NOT EXISTS(member of another arm)` conjoined with the arm's own
`every`. `some` and `none` address one arm and nothing else.

### P.4.5 The vector value crossing asks the declared tier (§10.6, SC-13)

`scalarValue`'s `vector` case binds through `adapter.vector.literal` when
`adapter.capabilities.supportsVector`, and otherwise through
`literals.value(value)` — the one crossing the shipped engine uses for every
vector (`values-builder.ts` has no vector case at all). Measured, both engines
then answer `QueryError: Query execution failed` from the driver for a vector
write on SQLite. This is the same capability the distance owner already
consults at `query.ts:1479`; no second capability, no emulation, no JavaScript
tier.

### P.4.6 The shipped owner sequence (finding K)

`select()` runs `page()` first, then `prepareProjection`/`lowerProjection`, then
`prepareSelector`/`lowerSelector` — the shipped sequence
(`operations/find-common.ts` `buildFind`: `buildFindPagination` →
`buildSelectWithAliases` → `buildWhere`). Nothing in `page()` reads the
projection or the selector, so this is a reordering and not a rewrite;
`aggregated()` already pages before its `where`.

### P.4.7 Root `create` folds (§10.12)

`Commands.plan` gains `rootCreate(model, args)` beside `rootUpdate`, with the
same gate (`data` names no relation, the prepared projection is
RETURNING-safe, the adapter supports RETURNING) and the same owner
(`OperationContext.createMany(model, [values], projection, false, single)`),
where `single` is the operation's cardinality: `rows[0]`, else
`INSERT did not produce the required record`.

### P.4.8 RETURNING-safety belongs to the projection owner (§10.13, §10.2)

**Corrected in repair round 3 (§R2.3): this paragraph described a per-field
fact that did NOT land, and the round-2 text is kept below only so the
correction is legible.** What landed, and what stands after the repair, is the
RELOCATION of one kind-test: `namesRelation` moves out of the physical owner
and becomes `returningSafeProjection(projection)` in the module that owns the
field kinds, with the same rule it always had —
`fields.every(kind === "scalar")`. Phase 2 also widened it by one kind
(`distance`); round 3 narrows it back, because no provider in the qualified set
declares the distance tier and nothing could witness the widened arm.

> *Round-2 text, superseded:* "`PreparedProjectionField` gains `returningSafe`,
> stated where the field is prepared; `namesRelation` in the physical owner
> becomes `returningUnsafe(projection)`, a fold of that fact. A `_distance`
> field over the mutated row is then RETURNING-safe and a
> relation/variant/`_count` carrier is not, without a second classification."

### P.4.9 A statement-atomic operation has no record series (scope item 6)

`failure()` attaches `recordSeriesProgress` only when a series exists. "There is
no series" is the fact the envelope rule already owns, read through the same
counter: the operation performed exactly one statement, holds no continuation,
completed no member and committed at most one segment. The shipped engine's
`runStatementAtomic` path attaches no progress for exactly that shape.

### P.4.10 The decimal `_sum` operand binds in the widened domain (§10.10)

`lowerOperation`'s `bind` asks the target: an `_sum` over a decimal column binds
through `literals.decimal(canonical, { precision: max(field, operand), scale })`
and raises the registered refusal when the adapter's
`aggregates.decimalSumOperandPrecision` refuses the coefficient. The sentence is
copied verbatim from the shipped owner; no shipped builder is imported.

### P.4.11 The public read value's own facts (§10.11)

`Read` gains `readonly single: boolean` and `readonly value: ProjectionShape |
Leaf`-shaped public description, set beside `result` by `read()`, and
`commands/index.ts`'s `publishedFacts` forwards them instead of deriving them
from `result([])`. One statement of the cardinality, in the read owner.

### P.4.12 Native recursive lowering (§10.8, scope item 7)

The recursive path carrier holds the **text** of each identity document
(`expressions.cast(json.document(identity), "text")`) instead of a raw JSON
document. PostgreSQL's `json` type has no equality operator, so
`arrays.has(path, doc)` lowered to `doc = ANY(path)` and raised `42883`; with a
text element the same three adapter calls (`arrays.literal`, `arrays.push`,
`arrays.has`) are defined on all three dialects. No adapter seam, no
per-provider branch in the query owner.

## P.5 What disappears, and the invariant that replaces it

| # | Decision that disappears | Mechanism today | Consumers | Replacing invariant | Falsifier |
| --- | --- | --- | --- | --- | --- |
| E-a | "who opens the envelope for a borrowed multi-statement write?" answered by the route wrapping every write | `route/client-route.ts` opens a scope for every borrowed write; `region()` refuses to | route, `OperationContext.run` | Ownership is STATED: `operationRegion` is the callback-transaction route's transfer, `memberRollback` is member isolation, and the one envelope rule covers both | A single-statement borrowed write must poison the caller's transaction; a multi-statement one must roll back only itself; `g3-suppression-retry` must still show one savepoint per suppressed member |
| E-b | "how does a value cross into a JSON carrier?" answered twice | `carriedValue` and `recursive`'s `projectedDocument` | relation carriers, `grouped`, `recursive` | One carrier transport owner | A `bigint` read through a recursive traversal must be exact |
| E-c | "how is a collection counted?" answered twice | `correlatedCount` and `relationOrderTerm`'s own subquery | `_count` projection, `_count` ordering | One counted-slot owner over the slot's memberships | `orderBy: { <variant carrier>: { _count } }` must answer the shipped order; the projection and the ordering must agree |
| E-d | "may this projection ride a RETURNING?" answered by the physical owner | `namesRelation` in `shared/operation-context.ts` | root `update`/`delete`/`create` folds, `deleteMany` | The projection owner answers, with the one kind-test, in the module that owns the kinds (`returningSafeProjection`) — **corrected in round 3 (§R2.3): a relocation, not a per-field fact** | The gate must answer `false` for a `_count`, a relation carrier, a variant slot **and a `_distance`**, and `true` for a scalar-only and a whole-row projection (`returning-safety-gate.test.ts`, 5 cells); a `_count` projection on a root write must not fold |
| E-e | "which refusal wins when two are owed?" answered by the candidate's own owner order | `select()` prepares projection → selector → page | every read verb | The shipped owner sequence, stated once in `select()` | The reviewer's `competing-refusals` / `refusal-order-history` probes must agree with shipped |
| E-f | "does this failure carry record-series progress?" answered by transport kind alone | `failure()`'s `usesBatch && committedSegments > 0` | every batch-driver failure | A statement-atomic operation has no series | A folded root `delete`/`update`/`create` that fails on a batch-only driver must carry the shipped meta; a real series must keep its progress |
| E-g | "what is a vector value on a provider with no vector tier?" answered by the vector tier itself | `scalarValue` → `adapter.vector.literal` | every vector write and every vector operand | The declared capability chooses the crossing | SC-13: both engines must answer the same error identity |

## P.6 Rules added

1. A member rollback opens inside whatever scope the operation is currently
   running in (P.4.1).
2. A tagged quantifier addresses the tagged membership; only `every` also
   states the other arms (P.4.4).
3. A statement-atomic operation has no record series (P.4.9).
4. The path carrier of a recursive traversal holds identity TEXT, because
   provider JSON equality is not portable (P.4.12).

## P.7 Falsifiers phase 2 must fail

1. A multi-statement borrowed write with an `operationRegion` grant rolls back
   only its own member work; a single-statement one poisons the caller's
   transaction. Without the grant, neither opens a region.
2. `g3-suppression-retry`, `g3-scope-composition-pg` and `-mysql` stay green
   (the §8.4 experiment's exact failure must not return).
3. `user.update({ data: { n: { multiply: 3 } } })` must multiply in SQL, and a
   key transition through a multiplied key must compare the same expression.
4. A decimal `divide` by zero must refuse before any statement is issued.
5. RF-16's bigint must decode exactly; the same traversal must run natively on
   PostgreSQL and MySQL.
6. Q-W10's four tagged quantifier cells must equal the hand-computed values.
7. Q-O04's variant `_count` ordering must equal the shipped order.
8. SC-13's write and read refusals must equal the shipped identities.
9. The reviewer's competing-refusal probes must agree with shipped.
10. Root `create` must cost 1 statement and 0 transactions on a RETURNING
    adapter, must publish the same row, and the G2.9 malformed-result specimen
    must still witness the translation at its legal cut.
11. A folded root write's `NotFoundError` on a transaction-less driver must
    carry `{ model, operation }` and nothing else, live and packaged.
12. A real record series must keep its progress meta (the G2.9 specimen's
    atomic-batch cell).

## P.8 Findings recorded, not chosen

Filled in as phase 2 measures them; §P.11 holds the record.


## P.9 §7 decision-elimination answers, against the phase-2 diff

1. **Is each change a necessary decision elimination or a representation
   repair?** Yes, and each one deletes a *second answer* rather than adding a
   first: the carrier transport rule now has one owner (`carriedValue`) instead
   of two (§P.4.2); a counted slot has one owner (`correlatedCount`) instead of
   a projection spelling and an ordering spelling (§P.4.3); RETURNING-safety is
   stated once by the projection owner (`returningSafeProjection`, the one
   kind-test relocated into the module that owns the kinds — **corrected in
   round 3, §R2.3: a relocation, not the per-field fact §P.4.8 first described**)
   instead of a physical-owner walker (§P.4.8); the envelope grant is STATED (`operationRegion`) instead of
   inferred from a `memberRollback` grant (§P.4.1); the read value's cardinality
   is stated once by `read()` (§P.4.11); and the refusal a caller sees is
   decided by ONE sequence, the shipped one, instead of by the candidate's own
   owner order (§P.4.6). Root `create` stops being an exception to the
   set-oriented INSERT owner (§P.4.7), which removes the last "which physical
   route does this verb take?" decision from the root write verbs.
2. **Is the deletion exact, with a replacement obligation?** Yes — §P.5 names
   the mechanism, the consumers, the replacing invariant and the falsifier for
   each of E-a…E-g, and §P.12.4 measures each falsifier on the phase-1 tree:
   twelve author cells go red there and green here, so every replacement
   obligation is exercised by something that fails without it.
3. **Is one rule used across every use?** Yes for the carrier (relation
   carriers, `grouped` and `recursive` call the same function), for the counted
   slot (projection and ordering), for RETURNING-safety (root `update`,
   `delete`, `create`, `deleteMany` and the packaged guard), for the envelope
   (`run`/`dispatch`, standalone and borrowed), and for the owner sequence
   (`select()` and `aggregated()` both page first). The one place two spellings
   remain is `PhysicalPlan.single`, still a per-verb admissibility predicate
   (review note N4) — unchanged by phase 2 and still falsifiable in the
   direction that matters (`physical-envelope.test.ts` bind-budget cell).
4. **What actually grew?** +226 token-lines / +412 physical / +19,325 bytes
   over four files (§P.10), against four decisions deleted and four registered
   refusals gained, with the whole G4-01 review estate (200 cells) and the G4-01
   author estate (83 cells) still green. No second public-syntax walker, no
   per-verb codec, no JavaScript arithmetic beside SQL, no new interpreter or
   scope class, no policy-boolean bag, no legacy import and no fallback appears
   in `production-phase2.patch`.

## P.10 Files, identities, cost

Phase 2 edited **four** production files; the other five this unit owns are
byte-identical to the phase-1 accepted identities (§R.6).

| File | Phase-1 identity (accepted) | Phase-2 identity |
| --- | --- | --- |
| `shared/query.ts` | `6f39f82a…` (the writer-transfer identity, §P.0) | `2feddf986b71a074320581ca3c321f7da2fa568c5c3420097465f440f97d2861` |
| `shared/operation-context.ts` | `65aa6f5b…` | `96222de950ee2e76b8610a891bb9eb16ed9193bc71e8b1aad5098aead5052016` |
| `commands/commands.ts` | `12442b94…` | `e7f8858dea762382f41d8ec247b4592e8199a618f6431818e929cb809408a65a` |
| `commands/index.ts` | `546adce4…` | `f551151f6d279eb783a911e6c1f7794af141704df40cd202c334fc6d4c7c3be9` |
| `shared/schema.ts` | `c7a58c9c…` | unchanged |
| `shared/storage.ts` | `752215df…` | unchanged |
| `commands/assignments.ts` | `1e9b7c52…` | unchanged |
| `commands/execution.ts` | `54646ed4…` | unchanged |
| `program/index.ts` | `4aeb2c14…` | unchanged |

Patches (phase-1 content → now, reconstructible without the tree):
[`production-phase2.patch`](production-phase2.patch)
(`17e8632626da4aefc10e468a2576eecc565794f2fc7840a647d26c72db935dcc`) and
[`tests-phase2.patch`](tests-phase2.patch)
(`496a9b30d981d8d0ef9e7c05f167f6cfc256a1768d6db89a8938bb4564c1b273`, the unit's
17 own test files plus the two G2.9 specimen edits). The phase-1
`production.patch` / `tests.patch` are unchanged.

**Cost**, census function `countTokenLines` of `scripts/query-engine-structure.mjs`
(`censusFunctionSha256 15889231a22297fcf001ae22ca01e6e8c9cd7489dd635c60529dfdc0ac06461e`,
the same value the G3 accounting records), JSDoc and EOF excluded:

| | files | bytes | physical | token-lines |
| --- | --- | --- | --- | --- |
| phase-1 accepted (the four files) | 4 | 236,563 | 6,864 | 6,461 |
| phase 2 (the four files) | 4 | 255,888 | 7,276 | 6,687 |
| **phase-2 increment** | 0 | **+19,325** | **+412** | **+226** |

Candidate **core** (12 files, `commands/` + `shared/`) now measures
**339,972 bytes / 9,875 physical / 9,227 token-lines**; the whole
`src/query-engine/raptor3` tree (15 files) measures
**369,238 bytes / 10,733 physical / 9,996 token-lines**. The phase-1 core
figure (319,209 / 9,435 / 8,982) was taken before the G4-01 r5 increment was
merged into `query.ts`, so the core delta (+20,763 bytes) is larger than this
unit's own (+19,325) by exactly that merge. The **complete charged perimeter**
is still **UNVERIFIED** here, for the reason §R.6 gives (no charged-file
manifest was saved and the perimeter reaches outside `raptor3/`).

Harness identity at the close of the round (the witness stream was editing
`tests/` and `scripts/` throughout):
[`receipts/phase2/harness-identity-final.json`](receipts/phase2/harness-identity-final.json)
— production `a830d713…`, harness `68ef8834…`, Node v24.21.0, vitest 3.1.4,
better-sqlite3 12.6.0. No run in this round was refused with
"Stale Raptor 3 evidence".

## P.11 Findings recorded, not chosen

### P.11.1 The two remaining `g4-read-contracts` cells are witness defects

Phase 2 fixed two of the four inherited reds outright (Q-W10 tagged
quantifiers, Q-O04 variant `_count` ordering); the other two now fail **after**
the candidate answered, for reasons that belong to the witness cells. Each is
pinned, on the same property, by an author check that passes.

| Cell | What it now fails on | Requested one-line witness change | The unit's pin |
| --- | --- | --- | --- |
| **SC-13** (`tests/raptor3/g4/read-codecs.test.ts:457`) | `assert.fail("The required refusal did not fire")` on the **shipped** READ. Both engines now refuse the vector WRITE identically (`QueryError`), so the witness's table is empty and a `findMany({select:{embedding:true}})` over zero rows refuses on neither engine: the shipped result parser decodes a vector column with no capability check. | Drop the read half's `observeFailure`, or seed a row through the raw database before reading; the write half is the capability contract and passes as written. | `tests/raptor3/g4/unit02/vector-capability.test.ts` — both crossings, both engines, identical. |
| **RF-16** (`tests/raptor3/g4/read-recursive-fit.test.ts:254`) | `root.amount` reads `undefined`. The flattening `walk` descends **every** nested value, so the row's own `document: { code: "root" }` JSON payload is pushed into `flat` after the row it belongs to; `new Map(flat…)` keeps the last entry per key and the payload replaces the traversal row. | `walk(row.children)` instead of `for (const nested of Object.values(row)) walk(nested)` — the traversal relation is the thing being flattened. | `tests/raptor3/g4/unit02/recursive-codec-fit.test.ts` — the same three cells with the corrected walk, all green, including the `bigint` RF-16 was opened for. |

Measured on the phase-1 tree the same suite is 58/4 with the four original
sentences ([`falsify/g4-read-contracts-on-phase1-tree.log`](receipts/phase2/falsify/g4-read-contracts-on-phase1-tree.log)),
so the two fixes and the two re-diagnoses are both phase-2 facts.

### P.11.2 `g4-route-transactions` LX-14 is now a stale divergence pin

The pin asserts TODAY's unit tape on both routes and says in its own comment
that it "goes red the day either side moves — including the day the candidate's
own envelope decision makes the candidate column equal the shipped one". The
root `create` fold moved it: the candidate now emits
`[transaction, operation:create, savepoint:create, statement:create]` where the
pin expects a second `statement:create` (the re-read). The savepoint is the
route's own wrap (§11.3, G4-03's file). Owner: the witness estate — the pin's
candidate column needs one `statement:create` removed, and it disappears
entirely when §11.3 lands. LX-04 remains stale for the phase-1 reason.

### P.11.3 The CS-02 / CS-03 measurement reds are INHERITED, not phase-2 work

`g4.md` (06:50) classifies the CS-03 extension-campaign self-test red as a G4
regression, because it passes 42/42 on the clean `0cc61e61` baseline, and
assigns it to the harness reconciliation unit. Phase 2 did not cause it and
does not change it: with this unit's four phase-2 files swapped for their
phase-1 accepted content and everything else identical, the same two
measurement files fail the **same 11 cells**
([`falsify/measurement-on-phase1-tree.log`](receipts/phase2/falsify/measurement-on-phase1-tree.log)),
and `extension-campaign.test.ts` fails on the same seed 7132
([`falsify/extension-campaign-on-phase1-tree.log`](receipts/phase2/falsify/extension-campaign-on-phase1-tree.log)).
Files were restored from a scratchpad copy and the four SHA-256s re-verified
after each swap.

**§5.4 record for the reconciliation unit — the cut
`found|missing/root-member/0`.** The cut is the observation point BETWEEN a root
member's locate statement and the statement that acts on what the locate found.
For a scalar-only root `update`/`delete`/`create` with a RETURNING-safe
projection that interval no longer exists: the mutation itself decides found
from missing by the number of rows it returns.

| Recipe shape | Candidate tape now | Classification | Where the property is checked instead |
| --- | --- | --- | --- |
| root `update`, row present / absent | `[UPDATE]`, 0 transactions | **eliminated by an atomic strategy** (one statement, no envelope) | `root-member-cut-trace.test.ts` cell 1: both branches, both engines, same tape, same published row, same `NotFoundError` + `{model, operation}`, nothing written on the missing branch |
| root `delete`, row present / absent | `[DELETE]`, 0 transactions | **eliminated by an atomic strategy** | `root-member-cut-trace.test.ts` cell 2 (+ `root-delete.test.ts`, 6 cells) |
| root `create`, scalar-only | `[INSERT]`, 0 transactions | **eliminated by an atomic strategy** (this is also the shipped tape) | `root-member-cut-trace.test.ts` cell 3; `malformed-result-cuts.test.ts` cell 3 compares the fold to the shipped engine on a corrupting driver |
| root `create` naming a relation | multi-statement, 1 transaction | **NOT eliminated** — the locate/act interval is still there | `root-member-cut-trace.test.ts` cell 4; `malformed-result-cuts.test.ts` cells 1, 1b, 2 |
| any of the above on a provider **without** RETURNING, or with a relation projection | locate → mutate (→ re-read) | **NOT eliminated** | `malformed-result-cuts.test.ts` cells 1/1b/2, `root-delete.test.ts` |

So for each red cell the question the reconciliation unit must answer is only
*which shape the recipe is*: a scalar-only root member is the eliminated case
and its surrounding cuts are checked above; anything else still has the cut and
a red there would be a genuine regression to hand back.

The CS-02 red (`collects the frozen CS-02 structural work matrix`) is the same
family: `structure/depth-create/1` no longer reports an occurrence, a write and
an `attempt/0/unconditional` activation for the ROOT command, only for the
child. It reproduces identically on the phase-1 tree, so it is inherited by
phase 2 as well; the same §5.4 question applies to it and it is **not** in the
reconciliation brief's outcome list — the integrator should add it.

### P.11.4 Review notes N2 and N3 (phase-1 follow-up) are closed

N2 — the false sentence in `run()`'s doc comment ("two rows with different
column sets are two and raise the sentinel") is replaced by the measured fact:
`schema.scalars` normalizes every row to one column set, so the reachable
sentinel path is the bind budget, and the comment now names the cell that pins
it. N3 — the packaged guard's `failure.message` carries one line saying it is
never user-facing and that only `sameAttribution` reads it. Both are comments;
no behavior changed, and the whole battery below was run after them.

### P.11.5 Still open, and still not this unit's to close

- Obligation 10 (`EngineConfig.resolved` consumption) — needs `client.ts` and
  the route file (§R.7). Undelivered, not claimed.
- Route follow-up §11.1–§11.4 (including the `operationRegion` grant this
  phase landed): `g4-lifecycle-events` (2 red) and `g4-lifecycle-admission`
  (1 red) stay red until G4-03b consumes them.
- `g4-route-admission`'s `findFirst` cell: pre-existing, falsified in §12.4.
- Review probes: the three red-by-construction evidence cells (notes 7 and 8 of
  the phase-1 review) are unchanged and still red by construction; the
  root-`create` cell and N1's two cells are now GREEN, because phase 2 landed
  the fold and the statement-atomic series rule.

## P.12 Completion record

### P.12.1 Fast-path statement and round-trip table (phase-1 → phase-2)

Measured on SQLite by `tests/raptor3/g4/unit02/physical-envelope.test.ts` and
`root-member-cut-trace.test.ts` (`RecordingSQLiteDriver` counts every
`_execute`/`_executeBatch` and every `withTransaction`); the shipped column is
the same public request through `createClient` on the same driver.

| Workload | Phase 1 | **Phase 2** | Shipped | Round trips |
| --- | --- | --- | --- | --- |
| `scalar-find-unique` | 1 / 0 | **1 / 0** | 1 / 0 | 1 |
| `fixed-collection-rowref-20` | 1 / 0 | **1 / 0** | — | 1 |
| `count` | 1 / 0 | **1 / 0** | — | 1 |
| `flat-scalar-update` (`increment`) | 1 / 0 | **1 / 0** | 1 / 0 | 1 |
| root `update`, row absent | 1 / 0 | **1 / 0** | 1 / 0 | 1 |
| root `delete`, present / absent | 1 / 0 | **1 / 0** | 1 / 0 | 1 |
| `bulk-update-returning` | 1 / 0 | **1 / 0** | — | 1 |
| `updateMany` with `limit: 0` | 0 / 0 | **0 / 0** | — | 0 |
| `createMany`, 2 rows, one column set | 1 / 0 | **1 / 0** | 1 / 0 | 1 |
| `createMany` past the bind budget (3 rows, cap 8) | 2 / 1 | **2 / 1** | — | 2 |
| **root `create` (scalar only)** | 2 / 1 | **1 / 0** | 1 / 0 | **1** |
| relation-bearing `create` | n / 1 | **n / 1** | — | unchanged |
| relation-bearing `update` | n / 1 | **n / 1** | — | unchanged |
| `update` with a relation projection | n / 1 | **n / 1** | — | unchanged |

No workload's cost increased. The one recorded phase-1 exception (root `create`
at 2 statements / 1 transaction against shipped's 1 / 0) is **closed**: the
classification now agrees with the shipped engine on every workload where both
were measured.

### P.12.2 Suites — the closing round

Receipts: [`receipts/phase2/final/`](receipts/phase2/final/) (this round, run
after the last source edit), [`receipts/phase2/final-first-pass/`](receipts/phase2/final-first-pass/)
(the 05:47 round the orchestration incident interrupted),
[`receipts/phase2/inherited/`](receipts/phase2/inherited/) (the pre-edit red
list), [`receipts/phase2/falsify/`](receipts/phase2/falsify/),
[`receipts/phase2/native/`](receipts/phase2/native/).

| Suite / mode | Result | Note |
| --- | --- | --- |
| G4-02 author checks (14 files) | **60 passed, 1 skipped** | the skip is the native DATE probe (no live provider in that project) |
| `g4-read-contracts` | 60 passed / **2 failed** | SC-13 and RF-16, both witness defects (§P.11.1); was 58/4 |
| `g4-unit01-author` (10 files) | **83 passed** | the G4-01 estate, green under the new owner sequence |
| `g4-unit01-review` (29 files) | **200 passed** | includes the reviewer's finding-K probes (`unit01-followup3/`), all green |
| review probes `unit02` (11 files) | 31 passed / **3 failed** | the three red-by-construction cells; was 28/6 |
| `g4-route-lifecycle` / `g4-route-cache` | 7 / 6 passed | |
| `g4-route-admission` | 4 passed / **1 failed** | pre-existing `findFirst`, §12.4 |
| `g4-route-transactions` | 9 passed / **2 failed** | LX-04 and now LX-14, both stale pins (§P.11.2) |
| `g4-lifecycle-events` / `g4-lifecycle-admission` | 1/2 and 3/1 | route-owned, §11.1–§11.2 |
| `g4-generation-selftests` | 6 passed | |
| `g1-contracts` / `g1-transport` / `g2-contracts` / `g25` / `g27` | 143 / 44 / 216 / 6 / 6 passed | |
| `g3-bulk-series` / `-suppression-retry` / `-transaction-array` / `-depth-recurrence` | 6 / 2 / 4 / 6 passed | the §8.4 experiment's failure did not return |
| `g3-execution-review` / `-author-execution-regressions` / `-scope-failure` / `-bulk-result-boundary` | 6 / 3 / 2 / 5 passed | |
| `g3p02` / `g3p03` / `g3p04` / `g3p04-review` | 4 / 6 / 5 / 5 passed | |
| `g3p05-contracts` + three focused modes | 21 / 11 / 4 / 6 passed | |
| `post-g3-*` (5 modes) | 4 / 1 / 4 / 4 / 5 passed | |
| `g29-member-dependency` / `-boundaries` / `-choices` / `-result-progress` | 14 / 4 / 10 / 2 passed | the G2.9 specimen passes with the WIDENED cut |
| `cs01-*` (4 modes) / `cs03-member-scope` | 10 / 6 / 4 / 4 and 8 passed | |
| `prep` (6 files) | **37 passed** | the four native files are gated out with no live provider in that project |
| `post-prep` (9 files) | **48 passed** | |
| `transitions` (33 files) | **434 passed** | |
| `expanded` + `ownership` + `polish` (9 files) | **293 passed** | |
| candidate core (7 files) | **136 passed** | |
| `core-structure/` (10 files, 3 failing files) | 74 passed / **12 failed** | all twelve inherited — falsified in §P.11.3 |
| PGlite lanes (`g29`, `produced-commands`, `batch-produced-commands`) | 1 / 3 / 2 passed | `produced-commands` tripped the runner's 1,536 MiB sampled-RSS ceiling on two attempts and passed on the third at 1,535.0 MiB; the ceiling is the harness's resource guard, not a test result |
| harness self-tests (`raptor3-campaign-receipts`, `bounded-process`, `test-run-lock`) | **61 passed** | `scripts/raptor3-cli.test.mjs` was NOT re-run: it runs the whole credential-free lane as a child and its single red is the CS-03 measurement red of §P.11.3, owned by the reconciliation unit |
| `node scripts/credential-free-test-manifest.mjs` | **exit 0** | |

### P.12.3 Native providers

Containers `viborm-raptor3-g3-pg-20260914` (`7dfda37e8eea…`, image
`95206741…`, PostgreSQL 16, **127.0.0.1:65504**, restarts 0) and
`viborm-raptor3-g3-mysql-20260914` (`d6da412eec3c…`, image `b3b90af2…`,
MySQL 8, **127.0.0.1:65515**, restarts 0) —
[identity receipt](receipts/phase2/native-container-identity.txt). One mode per
invocation, `VIBORM_RAPTOR3_PROVIDER_PORT` per provider.

| Mode | pg :65504 | mysql :65515 |
| --- | --- | --- |
| `g4-read-envelope-*-contracts` (incl. `g4-native-recursive-read-fit`) | **5 passed** | **5 passed** |
| `g3-scope-composition-*` | 2 passed | 2 passed |
| `g27-*-contracts` | 1 passed | 1 passed |
| `g3p04-*-contracts` | 4 passed | 4 passed |
| `g29-member-dependency-*` | 2 passed | 2 passed |
| `post-g3-clearability-*-contracts` | 2 passed | 2 passed |

**Scope item 7 is closed.** `g4-native-recursive-read-fit` was the one genuine
candidate gap phase 1 recorded (§10.8): PostgreSQL answered `42883` because the
path carrier held a `json` document and `json` has no equality operator. With
the path element cast to text (§P.4.12) the same three adapter calls
(`arrays.literal`, `arrays.push`, `arrays.has`) lower on all three dialects and
the traversal runs natively on both providers. No adapter seam was added and no
per-provider branch exists in the query owner. The two native fixture defects
phase 1 recorded (the pg DATE pool and the MySQL DATETIME literal) were repaired
by the witness stream, which is why these suites now count 5 cells.

### P.12.4 Falsifications

Every swap used a scratchpad copy of the current file (never `git checkout`),
and the four SHA-256s were re-verified after each restore.

| Claim | Falsification | Result |
| --- | --- | --- |
| Every phase-2 production change is load-bearing | the four phase-2 files swapped for their phase-1 accepted content (`6f39f82a…`, `65aa6f5b…`, `12442b94…`, `546adce4…`), author checks re-run | **STALE — corrected in round 3 (§R2.4).** The receipt recorded 12 failed / 45 passed / 1 skipped over 58 cells; it predates `decimal-having-operand.test.ts`, so it did not cover the 61-cell estate it claimed. The independent review re-ran the same swap and measured **14 failed / 46 passed / 1 skipped**; round 3 re-ran it against the FINAL 17-file estate and measured **32 failed / 46 passed / 1 skipped** ([`repair/falsify-author-checks-on-phase1-tree.log`](receipts/phase2/repair/falsify-author-checks-on-phase1-tree.log)). The conclusion is unchanged and now covers what it claims. Original receipt kept: [`falsify/unit02-author-checks-on-phase1-tree.log`](receipts/phase2/falsify/unit02-author-checks-on-phase1-tree.log) |
| The two read fixes are phase-2 facts | `g4-read-contracts` on the same phase-1 tree | **58 passed / 4 failed**, the four original sentences including Q-W10 and Q-O04 — [`falsify/g4-read-contracts-on-phase1-tree.log`](receipts/phase2/falsify/g4-read-contracts-on-phase1-tree.log) |
| The CS-02 / CS-03 measurement reds are NOT phase-2 regressions | the same swap, `cs02-structure-measure` + `extension-campaign.selftest` re-run | **11 failed / 32 passed**, the same eleven cells as the current tree — [`falsify/measurement-on-phase1-tree.log`](receipts/phase2/falsify/measurement-on-phase1-tree.log) |
| …and neither is the campaign batch cell | the same swap, `extension-campaign.test.ts` | **1 failed**, same seed 7132 — [`falsify/extension-campaign-on-phase1-tree.log`](receipts/phase2/falsify/extension-campaign-on-phase1-tree.log) |

### P.12.5 Typecheck

`node scripts/run-typecheck.mjs`, run last, after every source edit, after every
falsification restore and after the two author checks added at the end of the
round: **exactly two diagnostics, both permitted**
(`src/query-engine/pattern/pack.ts:1443`, `:2633`). 7.35 s wall, 5,762.2 MiB
peak sampled RSS, teardown verified —
[`final/typecheck.log`](receipts/phase2/final/typecheck.log).

### P.12.6 Scope, item by item

| # | Scope item | State |
| --- | --- | --- |
| 1 | `operationRegion` binding + `region()` (brief 11 rev 4) | **done**, landed first; identity in §P.10; pinned by `borrowed-envelope.test.ts` and the `operationRegion` cells |
| 2 | every §10 phase-2 queue entry | **done, with 10.1 corrected in round 3 (§R2.1)**: 10.1 arithmetic operators — round 2 delivered the ASSIGNMENT half only and REFUSED `multiply`/`divide` in the symbolic-name half, which was a live divergence on MySQL; round 3 delivers the name for every integer and float domain and leaves one recorded refusal (exact decimal `multiply`/`divide`), 10.2/10.13 the RETURNING-safety relocation (**not** the per-field `returningSafe` §P.4.8 first described; §R2.3), 10.3 Q-O04, 10.4 Q-W10, 10.5 RF-16 carrier, 10.6 SC-13, 10.7 no second predicate (nothing added), 10.8 native recursive, 10.9 `withinBounds` — still no provider plan requires it, recorded not added, 10.10 decimal `_sum` operand domain (pinned against the shipped lowering on all three dialects by `decimal-having-operand.test.ts`), 10.11 `Read.single`/public value, 10.12 root `create` fold **with** the §5.4 record (`malformed-result-cuts.test.ts`, 4 cells; the G2.9 specimen's cut was WIDENED to any row-bearing response, never weakened) |
| 3 | the four inherited red read cells | **two fixed** (Q-W10, Q-O04); **two re-diagnosed as witness defects** with author pins and the exact requested change (§P.11.1) |
| 4 | finding K (refusal precedence) | **done**: `select()` pages → projects → selects, `aggregated()` already did; the reviewer's own probes are in the tree and all 200 `g4-unit01-review` cells pass |
| 5 | note M (handoff r5 entry, falsifiers 19–21) | **done** in [`../unit01/handoff.md`](../unit01/handoff.md); the revision list is now in r1…r5 order |
| 6 | single-statement `NotFoundError` meta parity | **done**: `run`'s catch only wraps when a series exists (`continuations.length \|\| committedSegments > 0`); the two N1 evidence cells in the reviewer's probe are green |
| 7 | native recursive lowering on pg and MySQL | **done**, §P.12.3 |

### P.12.7 The §P.7 falsifier ledger

| # | Falsifier | Evidence | State |
| --- | --- | --- | --- |
| 1 | granted multi-statement borrowed write rolls back only its own member work; a single-statement one poisons the caller; neither opens a region without the grant | **Corrected in round 3 (§R2.4).** The load-bearing evidence is `phase2-envelope-and-arithmetic.test.ts`'s `operationRegion` cells (2: 1 savepoint granted / 0 with a member-only grant / 0 control for a single statement) ALONE. `borrowed-envelope.test.ts`'s 5 cells (and `packaged-array.test.ts`'s 5) are **green on the phase-1 tree** — they pin the obligation but do not fail without the change, so citing them as part of the falsification was wrong | the `operationRegion` cells **failed as required on the phase-1 tree**, green here; re-measured in round 3 |
| 2 | `g3-suppression-retry`, `g3-scope-composition-pg`/`-mysql` stay green | 2 / 2 / 2 passed (the last two native, :65504 and :65515) | green |
| 3 | `multiply` multiplies in SQL; a key transition through a multiplied key compares the same expression | `phase2-envelope-and-arithmetic.test.ts` arithmetic cell (int multiply, float divide, bigint decrement, decimal multiply and divide with the field's own quantization, integer truncation, list push/unshift) + the 434-cell `transitions` suite, whose key-transition owner calls the SAME `updateValue`. A one-off probe of `parent.update({ id: { multiply: 3 } })` over a referencing child answers `Foreign key constraint violation` on BOTH engines (fixture property, no divergence); the cascading-key cells live in the transitions estate, not here | **Corrected in round 3 (§R2.1).** Round 2's `updateValue` REFUSED `multiply`/`divide`, so the second half was not "covered indirectly" — the shared owner raised. Round 3 names the value: `key-arithmetic.test.ts` (15 cells, shipped-parity on a non-RETURNING driver for int and bigint `multiply`/`divide`) and `native-key-arithmetic.test.ts` (5 cells on the live MySQL container, including `7 / 2 = 3`) make the first half and the KEY half measured facts. The remaining unmeasured shape is a cascading key transition through a multiplied key, which needs a transitions-estate fixture (§P.14 item 2) |
| 4 | an exact decimal divided by zero refuses before any statement | `phase2-envelope-and-arithmetic.test.ts` divide-by-zero cell (statement count asserted 0) | green |
| 5 | RF-16's bigint decodes exactly; the same traversal runs natively on pg and MySQL | `recursive-codec-fit.test.ts` (3 cells) + `g4-native-recursive-read-fit` inside the two native 5/5 suites | green |
| 6 | Q-W10's tagged quantifier cells equal the hand-computed values | `g4-read-contracts` Q-W10 — red on the phase-1 tree, green here | green |
| 7 | Q-O04's variant `_count` ordering equals the shipped order | `g4-read-contracts` Q-O04 — red on the phase-1 tree, green here | green |
| 8 | SC-13's write and read refusals equal the shipped identities | `vector-capability.test.ts` (both crossings, both engines) | green; the witness cell additionally requires a refusal neither engine raises (§P.11.1) |
| 9 | the reviewer's competing-refusal probes agree with shipped | `g4-unit01-review` 200/200, incl. `unit01-followup3/competing-refusals` (4) and `refusal-order-history` (3); copies pinned in this unit as `k-*.test.ts` (7 cells) | **3 of them red on the phase-1 tree**, green here |
| 10 | root `create` costs 1 statement / 0 transactions, publishes the same row, and the G2.9 specimen still witnesses | `root-member-cut-trace.test.ts` cell 3 + `physical-envelope.test.ts` + `malformed-result-cuts.test.ts` cell 3 (shipped parity on a corrupting driver) + `g29-result-progress` 2/2 with the WIDENED cut | green |
| 11 | a folded root write's `NotFoundError` on a transaction-less driver carries `{model, operation}` and nothing else, live and packaged | `phase2-envelope-and-arithmetic.test.ts` statement-atomic meta cell (live) + `packaged-array.test.ts` (5 cells, packaged) + the reviewer's two N1 evidence cells, now green | green |
| 12 | a real record series keeps its progress meta | `g29-result-progress` `sqlite-atomic-batch` profile asserts `recordSeriesProgress` on the failure; both profiles pass | green |

## P.13 Route follow-up, restated for the landed `operationRegion`

The grant is defined in `src/query-engine/raptor3/shared/operation-context.ts`
at identity `96222de950ee2e76b8610a891bb9eb16ed9193bc71e8b1aad5098aead5052016`
(`ExecutionBinding`'s borrowed arm, `operationRegion?: MemberRollback`; the
reader is `region()`), and it was the FIRST phase-2 change to land, before any
of the queue. Everything below is G4-03's file, not this unit's.

§11.3's diff is now **incomplete on its own**: it deletes the route's wrap, and
the candidate opens nothing for a borrowed ownership unless the caller grants a
region. That is correct for the array route (whose caller IS the unit) and wrong
for `$transaction(callback)`, whose caller opened no scope of its own. The exact
binding the callback-transaction route must pass, in
`src/query-engine/raptor3/route/client-route.ts` (G4-03's file):

```ts
return prepared.execute(
  {
    kind: "borrowed-transaction",
    driver: engineDriver,
    // The caller opened no region of its own: transfer the right to open ONE.
    // A single-statement write then runs directly on the caller's transaction
    // driver and poisons that scope exactly as the shipped `runStatementAtomic`
    // path does; a multi-statement one opens one nested region and rolls back
    // only its own work.
    operationRegion: (execute, context) =>
      engineDriver.withTransaction(execute, undefined, context),
    memberRollback: (execute, context) =>
      engineDriver.withTransaction(execute, undefined, context),
  },
  execution.context
);
```

The array route passes **`memberRollback` only** — it must not grant
`operationRegion`, because the array's own batch is the unit (that grant is what
`g3-suppression-retry` and `g3-scope-composition-pg`/`-mysql` refuse, §8.4).
The two grants are separate fields precisely so the route states which of the
two situations it is in, instead of the engine inferring it.

Consequences the route author can rely on, all pinned in
`tests/raptor3/g4/unit02/borrowed-envelope.test.ts` and the `operationRegion`
cells of `phase2-envelope-and-arithmetic.test.ts`:

1. With the grant, a multi-statement borrowed write opens exactly ONE region;
   without it, none.
2. While the operation's own region is open, member isolation nests inside
   **that** scope, not the caller's grant (re-entering the grant is the
   `TransactionError: … cannot be used while its nested transaction is active`
   §8.4 measured). What pins it: the granted cell above asserts **exactly one**
   savepoint for a multi-statement write whose series contains member work —
   re-entry would show a second one or raise that error — and
   `g3-suppression-retry` (2 cells) plus `g3-scope-composition-pg`/`-mysql`
   (2 + 2 native cells) stay green, which is the combination the §8.4
   experiment broke.
3. A single-statement borrowed write opens nothing either way, which is what
   makes LX-02/LX-14 converge on the shipped answer once §11.3 lands.

## P.14 Unverified, and what would settle it

1. The **complete charged perimeter** (files outside `raptor3/` that the unit
   charges) is still not reproducible here — §R.6's reason is unchanged. The
   **core** figure in §P.10 is reproducible to the byte.
2. **Corrected in round 3 (§R2.1).** Round 2 recorded falsifier 3's second half
   as merely unverified; it was in fact REFUSED — `updateValue` raised for
   `multiply`/`divide`, so there was nothing for the shared owner to cover.
   Round 3 names the value and measures it against the shipped engine on a
   non-RETURNING driver and on the live MySQL container. What remains genuinely
   unverified is narrower: no cell multiplies a key and then observes a
   DEPENDENT's transition through the same expression. A probe that tried to
   build one answered a provider FK violation on both engines, so it proved
   parity, not the property. Settling it needs a cascading-key fixture, which
   lives in the transitions estate.
3. `scripts/raptor3-cli.test.mjs` (the harness CLI self-test) was not re-run in
   this round; its one red is the CS-03 measurement red of §P.11.3, owned by the
   reconciliation unit. The first-pass receipt is kept. **Round 3 adds:** the
   three harness self-tests §P.12.2 recorded at 61 passed were not re-runnable
   either — `scripts/*.test.mjs` is no longer matched by any project in the
   current `vitest.workspace.ts` (the witness/harness stream owns that file and
   has been editing it), so `run-vitest-safe` answers "No test files found".
   Round 3 changed nothing under `scripts/`, so the round-2 receipts stand.
4. The two witness cells in §P.11.1 are diagnosed from the witness code and from
   the unit's own pins passing on the same properties; the requested one-line
   changes were NOT made (the witness estate is another stream's), so "green
   once changed" is a claim, not a measurement.

---

# Repair (round 3, after the independent phase-2 review returned REVISE)

Review: [`../unit02-phase2-review.md`](../unit02-phase2-review.md) (1 blocking,
4 must-fix, 5 notes). Receipts for everything below:
[`receipts/phase2/repair/`](receipts/phase2/repair/), identities in
[`repair/identities.txt`](receipts/phase2/repair/identities.txt).

The review's own summary — "what blocks acceptance is the record, not the
machinery" — held for three of the five items. It did not hold for finding 1:
the refusal it found was a real divergence on the project's only non-RETURNING
provider, and round 3 removes it rather than recording it. Repairing finding 2
then uncovered a registered G3 contract the reviewer's suggested repair would
have broken, which is why that one is delivered narrower than the review asked
and the remainder is recorded instead.

## R2.0 Finding → status

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 1 | blocking | `updateValue` refuses `multiply`/`divide`; live divergence on MySQL; record wrong in §P.12.6/§P.12.7/§P.14 and the JSDoc cross-reference | **repaired + recorded** (§R2.1). The value is now named in every integer and float domain, through one new adapter seam; one refusal remains and is a recorded decision. All four record corrections made. |
| 2 | must-fix | `multiply`/`divide` newly reachable on primary keys where the shipped engine refuses by contract | **repaired, narrowed + recorded** (§R2.2). The two refusals that cover the newly-reachable operators are stated at the candidate's admission boundary in the shipped sentences. The other two shapes the review listed are pre-existing, one of them protected by a registered G3 witness; both are recorded as decisions, not decided here. |
| 3 | must-fix | the brief's revision-5 regressions (`g2-mysql-contracts`, `g3-generated-transport-smoke`) neither delivered nor recorded | **measured, attributed, recorded** (§R2.5). `g2-mysql-contracts` is attributed past the phase-1 tree to the PRE-UNIT tree, so it is neither phase's; `g3-generated-transport-smoke` IS phase 2's root-`create` fold and the new shape is recorded per recipe, as the brief asks. |
| 4 | must-fix | two falsifier-ledger claims do not survive re-measurement | **re-measured + corrected** (§R2.4, §P.12.4, §P.12.7 row 1). |
| 5 | must-fix | the RETURNING-safety widening has no falsifier; the note describes a mechanism that did not land | **repaired + restated** (§R2.3). The gate is narrowed back to the witnessed rule and pinned kind by kind; §P.4.8 and §P.9 now say what landed. |
| 6 | note | the G2.9 specimen is another stream's file and one assertion was weakened | **restated, still unsettled** (§R2.6). |
| 7 | note | both remaining `g4-read-contracts` reds are witness defects — confirmed | acknowledged; unchanged (§P.11.1). |
| 8 | note | `g4-route-transactions` LX-04/LX-14 are stale divergence pins | acknowledged; unchanged (§P.11.2). |
| 9 | note | `PreparedRead.value` has no consumer, `empty` still derived | acknowledged; the consumer is G4-03b's (§P.11.5). |
| 10 | note | two new lint diagnostics and formatter drift | **both fixed** (§R2.6). |

## R2.1 [blocking] The updated key is NAMED, not refused

**What was wrong.** `Queries.updateValue` — the owner brief item 3 names for
*both* lowerings — answered the assignment only and raised for `multiply` and
`divide`. `OperationContext.updatedIdentity` (`:1358`) is the non-RETURNING
readback, and `mysql-adapter.ts:929` declares `supportsReturning: false`, so
`update({ where: { id: 7 }, data: { id: { multiply: 2 } } })` wrote nothing on
MySQL where the shipped engine answers `{ id: 14 }`.

**What the repair does.** `updateValue` now names every operator through the
SAME adapter vocabulary its assignment uses, so the expression and the `SET`
clause cannot disagree:

| domain | `increment` / `decrement` | `multiply` | `divide` |
| --- | --- | --- | --- |
| `int` | `expressions.add`/`subtract` over `cast(before,"integer")` | `expressions.multiply` | **`expressions.integerDivide`** |
| `bigint` | `add`/`subtract` | `multiply` | **`integerDivide`** |
| `number` (float) | `add`/`subtract` | `multiply` | `divide` |
| exact `decimal` | `add`/`subtract` (exact in coefficient space) | **refused** | **refused** |

`multiply` needed no seam: `*` is the dialect's own native arithmetic in every
non-decimal domain, and it is literally what `set.multiply` emits for a
non-decimal target. `divide` did: `/` is not portable for an integer target.
SQLite binds a JS number as REAL, MySQL `/` yields a DECIMAL quotient even for
two integers, and PostgreSQL's integer division already truncates — which is why
`set.divide` takes a `target.integer` flag and spells three different things.
Casting the quotient afterwards is not a substitute: MySQL and PostgreSQL ROUND
on cast and only SQLite truncates.

**Adapter seam (the unit's only one).** `expressions.integerDivide(left, right)`
— the expression form of the fact `set.divide`'s `target.integer` flag already
carries, in each dialect's own spelling:

| adapter | spelling | mirrors |
| --- | --- | --- |
| `sqlite-adapter.ts` | `(${left} / CAST(${right} AS INTEGER))` | its own `set.divide` integer arm |
| `postgres-adapter.ts` | `(${left} / ${right})` | its own `set.divide` (ignores the flag; a cast would narrow a `bigint` to `int4`) |
| `mysql-adapter.ts` | `TRUNCATE(${left} / ${right}, 0)` | its own `set.divide` integer arm |

Contract test extended in the same family:
`tests/contracts/adapters/dialect-vocabulary.core.test.ts` ("portable
expressions and aggregates preserve their operands"), 34 passed, and the whole
`tests/contracts/adapters/` family is 182 passed.

**Evidence.**

| Cell | Result |
| --- | --- |
| the reviewer's own `key-arithmetic-parity.review.test.ts`, first two cells (int key `multiply`/`divide` on a non-RETURNING driver) | **green** (`repair/review-probes-all-after.log`); the whole 10-file review-probe estate is 54 passed / 2 failed, and the 2 are §R2.2's recorded divergences |
| `tests/raptor3/g4/unit02/key-arithmetic.test.ts` (new, 15 cells) | shipped-parity for int and bigint `multiply`/`divide`/`increment`/`decrement` on a non-RETURNING driver; the exact per-dialect `integerDivide` spelling; the remaining decimal refusal by identity |
| `tests/raptor3/g4/unit02/native-key-arithmetic.test.ts` (new, 5 cells, live MySQL `:65515`) | **5 passed** — `multiply`, `divide` with a non-exact quotient (`7 / 2 = 3`, the case that separates truncation from real division), `divide` with an exact quotient, `increment`, `decrement`, each compared to the shipped engine AND to the row the provider actually holds (`repair/native-key-arithmetic-mysql.log`) |
| the same native file against the PRE-REPAIR `query.ts` (`2feddf98…`) | **3 failed / 2 passed**, each with `Raptor 3 cannot name the updated value of 'row.id' under '<operator>'` (`repair/falsify-native-key-arithmetic-on-phase2-tree.log`) — the divergence, measured on the real provider, before and after |

**The refusal that remains — a DECISION for Arnaud (blocker R-D1).** An EXACT
DECIMAL field under `multiply` or `divide` still raises
`Raptor 3 cannot name the updated value of '<model>.<field>' under
'<operator>': the provider owns that operator's rounding inside its own
assignment.` The provider's assignment for that domain is a guarded
coefficient rewrite — `guardedCoefficientAssignment` + `halfEvenQuotient` on
SQLite, `mysqlDecimalMultiply`/`mysqlDecimalDivide`, `logicalDecimalMultiply`/
`logicalDecimalDivide` on PostgreSQL — which rounds half-to-even back to the
field's scale and substitutes a range-breaking sentinel for an intermediate the
dialect cannot represent. Restating that as an expression would be a second
arithmetic owner, which the hard rules forbid; giving it an expression seam
would be a third adapter spelling of the same rule. **What it costs:** nothing
for a primary key (§R2.2 refuses decimal key arithmetic at admission first, as
the shipped engine does) — the reachable shape is a decimal RELATION key under
`multiply`/`divide` on a non-RETURNING provider, where the shipped engine would
compute the new key in JavaScript. Recorded, not chosen. Pinned by identity in
`key-arithmetic.test.ts`. **[Corrected in round 4 — §R3.3: the second review
built that relation-key construction three ways and every one answered
identically on both engines, so the refusal is UNREACHABLE from the public
surface. R-D1 itself stands.]**

**Record corrections made:** §P.12.6 item 2, §P.12.7 rows 1 and 3, §P.14 item 2,
and the JSDoc, which now cross-references this section instead of §P.11.1 (the
witness-cell section) and no longer claims `multiply`/`divide` are refused
generally. The review's nit — the ternary whose two branches were identical —
is gone: the sentence interpolates `update.operator` once.

## R2.2 [must-fix] The row key's portability contract, and the two shapes that are NOT this unit's to decide

The review asked for the shipped portability refusals at the candidate's
admission boundary. Stating **all** of them broke a registered contract, which
is the finding this repair adds:

> `tests/raptor3/g3/review-execution-boundaries.test.ts` — *"reads a supported
> decimal key increment through its provider expression"* — asserts the
> candidate performs `updateMany({ where: { id: "8.00" }, data: { id: {
> increment: "2.00" } } })` on a DECIMAL primary key. The shipped engine refuses
> that request (`Arithmetic updates are not portable for decimal primary key
> field 'id'.`). Mirroring the shipped assertion whole turned
> `g3-execution-review` from 6/6 to 5/6 (measured).

So the mirror is deliberately narrower than the shipped assertion, and covers
exactly the operators phase 2 made reachable. `EngineSchema.admit` now calls
`assertPortableKeyUpdate` for `update`/`updateMany`/`upsert`, which raises, in
the shipped engine's own sentences:

1. `Arithmetic updates are not portable for ${scalarType} primary key field '${field}'. Use an explicit set value.` — a `number` or `decimal` row key under `multiply` or `divide`.
2. `Cannot divide primary key field '${field}' by zero.` — a row key under `divide: 0` / `divide: 0n`.

A payload naming `set` never reaches either: `set` is the value `prepareUpdate`
takes, so nothing unnameable is ever built. The shipped assertion's non-finite
operand arm is deliberately NOT mirrored — after rule 1 it can only be reached
for an `int`/`bigint` key, whose validation refuses a non-finite operand, so it
would be a guard whose unique coverage cannot be named.

**Decisions for Arnaud (blocker R-D2), recorded not decided.** Two shapes stay
divergent; both predate this unit (the review measured them identically on the
phase-1 tree) and both are pinned with each engine's exact answer in
`key-arithmetic.test.ts`:

| request | shipped | candidate |
| --- | --- | --- |
| decimal PK `{ increment: "1.00" }` | `QueryEngineError: Arithmetic updates are not portable for decimal primary key field 'id'. Use an explicit set value.` | `{ id: "7", label: "a" }` — the candidate names an exact decimal increment in coefficient space, which is the capability `g3-execution-review` registers |
| PK `{ increment: 1, set: 9 }` | `QueryEngineError: Primary key field 'id' accepts exactly one update operation; received set, increment.` | writes `9` (`set` wins in `prepareUpdate`) |
| **(c, second sentence — added in §R4.4)** the same family on an `upsert` **with relations**: `owner.upsert({ where:{id:6}, create:{…}, update:{ id:{ set:8, multiply:2 }, notes:{ create:[…] } } })` | `QueryEngineError: Cannot determine the updated primary key for model 'owner' because field 'id' uses an unsupported operation.` — a THIRD sentence, from the analysis-time owner (`operations/mutation-identity.ts:187`), and **no row is written** | `ok:{"id":8,"label":"o"}` — `set` wins and the key moves |

Consequently two of the reviewer's seven `key-arithmetic-parity.review.test.ts`
cells stay red — the two the review itself classified as pre-existing. The other
five are green.

## R2.3 [must-fix] RETURNING-safety: the relocation, stated as a relocation, and witnessed

`returningSafeProjection` is narrowed back to `fields.every(kind === "scalar")`
— exactly the deleted `namesRelation` test, relocated into the module that owns
the field kinds. Phase 2's extra `|| kind === "distance"` arm is removed: a
`_distance` IS an expression over the mutated row's own columns, so a wider gate
would be defensible, but no provider in the qualified set declares the distance
tier, so nothing could fail if the arm were wrong. §P.4.8, §P.9 answer 1 and
§P.5 row E-d are corrected in place to describe the relocation rather than the
per-field `PreparedProjectionField.returningSafe` that never landed.

New falsifier: `tests/raptor3/g4/unit02/returning-safety-gate.test.ts` (5 cells)
asks the gate directly over prepared projections of every kind the owner
produces — scalar-only `true`, default whole-row `true`, relation carrier
`false`, `_count` slot `false`, and a `_distance` over a PostGIS-tier
`PostgresAdapter` `false`. The `distance` arm is now pinned by what the gate
ANSWERS, so widening it again goes red here instead of going unnoticed.

## R2.4 [must-fix] The falsification, re-run against the estate it claims

Every swap used scratchpad copies (never `git checkout`); the phase-1 content
was reconstructed by reverse-applying `production-phase2.patch` and verified to
reproduce `6f39f82a…`, `65aa6f5b…`, `12442b94…`, `546adce4…` exactly before any
run, and every restored file's SHA-256 was re-verified afterwards
(`repair/identities.txt`).

| Claim | Falsification | Result |
| --- | --- | --- |
| Every production change this unit made — phase 2 AND repair — is load-bearing | the four phase-2 files → phase-1 content, `shared/schema.ts` → `c7a58c9c…`, the four adapters → their HEAD content; the author estate re-run | **32 failed / 46 passed / 1 skipped** over **16 files / 79 cells** — this row's original label ("the FINAL 17-file author estate … 86 cells") was wrong, the receipt predates the last three author files; corrected in round 4 (§R3.4), where the reviewer's re-run of the identical swap against the final 17-file / 86-cell estate is adopted: **32 failed / 48 passed / 6 skipped**, same failure count, same conclusion, `key-arithmetic.test.ts` 13/15 red, `returning-safety-gate.test.ts` 5/5 red — [`repair/falsify-author-checks-on-phase1-tree.log`](receipts/phase2/repair/falsify-author-checks-on-phase1-tree.log) |
| The load-bearing evidence for falsifier 1 is the `operationRegion` cells, not `borrowed-envelope.test.ts` | the same swap | `borrowed-envelope.test.ts` 5/5 **green** there, `packaged-array.test.ts` 5/5 **green** there — the review's finding 4(a) reproduces exactly; §P.12.7 row 1 corrected |
| The native key-arithmetic parity is a round-3 fact | `query.ts` → `2feddf98…` (phase-2), native MySQL probe re-run | **3 failed / 2 passed** — [`repair/falsify-native-key-arithmetic-on-phase2-tree.log`](receipts/phase2/repair/falsify-native-key-arithmetic-on-phase2-tree.log) |

## R2.5 [must-fix] The brief's revision-5 regressions: measured, attributed, recorded

### `g2-mysql-contracts` — NOT this unit's, in either phase

Native MySQL, container `viborm-raptor3-g3-mysql-20260914`
(`d6da412eec3c…`, image `b3b90af2…`, **127.0.0.1:65515**, restarts 0):

| Tree | Result |
| --- | --- |
| current (round 3) | **10 passed / 3 failed** — `tests/raptor3/transitions/unique-races-live-commands.test.ts`: `g2-race-selected-unique-recovery`, `g2-race-unrelated-unique-refused`, `g2-race-wrong-insert-same-constraint` ([`repair/g2-mysql-contracts.log`](receipts/phase2/repair/g2-mysql-contracts.log)) |
| four phase-2 files → phase-1 content | **the same 3 cells fail** ([`repair/falsify-g2-mysql-on-phase1-tree.log`](receipts/phase2/repair/falsify-g2-mysql-on-phase1-tree.log)) — reproduces the review's attribution |
| **this unit's 8 phase-1 files → PRE-UNIT content** (reverse-apply of `production.patch`; `query.ts` left at the G4-01 r5 identity `6f39f82a…`) | **the same 3 cells fail** ([`repair/falsify-g2-mysql-on-preunit-tree.log`](receipts/phase2/repair/falsify-g2-mysql-on-preunit-tree.log)) |

The third row is the one the note owed and the review did not do: with every
file G4-02 has ever written restored to the content the integrator handed this
unit at the start of phase 1, the three cells fail identically. **G4-02 did not
cause this regression in either phase.** It entered with G4-01, G4-03 or another
stream's file between clean `0cc61e61` (13/13, per the brief) and the G4-02
hand-off. `g2-pg-contracts` is **18/18** on `:65504`, so the family is
MySQL-only. The failing shape is exact failed-INSERT recovery: the loser's row
survives where the winner's is expected (`claim@x`/`loser` instead of
`winner@x`/`winner`), and the unrelated-unique case keeps a `p-request` post it
should not. For the integrator: this needs reassigning, not re-measuring.

### `g3-generated-transport-smoke` — phase 2's root-`create` fold; the new shape, per recipe

| Tree | Result |
| --- | --- |
| current | **1 failed**: `g3-transport:script-shape; Unscripted statement: g3-c11-8027-0:recurrence-0; actual=INSERT; expected=INSERT,SELECT` ([`repair/g3-transport-smoke.log`](receipts/phase2/repair/g3-transport-smoke.log)) |
| four phase-2 files → phase-1 content | **1 passed** ([`repair/falsify-g3-transport-smoke-on-phase1-tree.log`](receipts/phase2/repair/falsify-g3-transport-smoke-on-phase1-tree.log)) |

So this one IS phase 2's, and it is the root-`create` fold of §P.4.7 —
the same cause the brief already diagnosed ("the scripted transport plans
describe the old physical root-write shape"), now attributed by measurement
rather than by inspection. The brief assigns this unit the RECORD, not the
re-scripting, so:

**§5.4 recipe record for the harness reconciliation unit.**
`tests/raptor3/g3/generation/transport-plans.ts`,
`ordinaryRecurrenceReplies` (and the identical tail in
`repeatedRecurrenceReplies` / `variantRecurrenceReplies`) scripts
`recurrence-0` as `INSERT × insertCount` followed by `SELECT × 1`, where
`insertCount = depth + 1 + depth * fanout` and the trailing `SELECT` is the
root's re-read. For a C11 recurrence recipe with **`depth === 0`** —
`insertCount === 1`, a scalar-only root `create` naming no relation, a
RETURNING-safe projection, a RETURNING adapter — the candidate now emits
`[INSERT]` alone and publishes the row from the INSERT's own `RETURNING`,
matching the shipped engine's tape (§P.12.1: root `create` 2 statements / 1
transaction → **1 / 0**, shipped 1 / 0). The re-script is: drop
`...expectedStatements("SELECT", 1)` for that shape and move `expected` onto
the last INSERT's response. `depth >= 1` recipes still name relations, still do
not fold, and keep the trailing `SELECT`. The brief says
`g4-write-transport-seed-batch 100000` fails at the same cell for the same
reason; the same rule applies there.

## R2.6 Notes

- **Note 10 (lint), fixed.** `commands/commands.ts:8` `lint/style/useImportType`
  (`import { type OperationContext }` → `import type { OperationContext }`) and
  `operation-context.ts:1264` `lint/complexity/useSimplifiedLogicExpression`
  (`!A || !B` → `!(A && B)`, same short-circuit) — the two diagnostics phase 2
  added. `biome check` over the nine production files now reports only the
  pre-existing set (`noParameterProperties`, `noParameterAssign`,
  `useDefaultSwitchClause`, four `useSimplifiedLogicExpression` in `query.ts`,
  `noUnusedFunctionParameters`/`noUnusedVariables`) plus the whole-file format
  drift, which is the trailing-comma style of the files as they were handed
  over, not a phase-2 or round-3 artefact — reformatting them would rewrite
  lines this unit does not own. The four adapter files are **clean**. The three
  NEW test files are clean and formatted
  ([`repair/biome.log`](receipts/phase2/repair/biome.log)).
- **Note 6 (the G2.9 specimen), restated, still unsettled.** §P.12.6's sentence
  "the cut was WIDENED …, never weakened" does not cover the second half of that
  edit: for the transaction-capable profile `finalDatabase` went from `[]` to
  `[{ id: 1, label: "written" }]`, because a folded root `create` is one
  statement with no envelope to roll back. That is shipped parity (the reviewer
  verified it independently) but it IS a changed assertion in another stream's
  file, and no settlement with its owner is recorded. Unchanged by round 3; it
  remains a request to the specimen's owner.
- Notes 7, 8 and 9 are acknowledged as the review states them; nothing in round
  3 moves them.

## R2.7 Files, identities, cost

Round 3 edited **five** candidate files (four of them phase-2's, plus
`shared/schema.ts`) and **four** adapter files. The other four files this unit
owns are byte-identical to their phase-1 accepted identities.

| File | Baseline | Round-3 identity |
| --- | --- | --- |
| `shared/query.ts` | `2feddf98…` (phase 2) | `5143b7b36f6711dc0605ee534b8ef28d351f278ebebbed2354e1955c22352715` |
| `shared/operation-context.ts` | `96222de9…` (phase 2) | `8b25f6fea73cfe2a1a50ac2558aeb01c3b2bd7563217e5266a89c22ee10451b6` |
| `commands/commands.ts` | `e7f8858d…` (phase 2) | `a208e1f26856822de46afec09b0098d9b53014382ebec98016bd6240ea978bfe` |
| `commands/index.ts` | `f551151f…` (phase 2) | `f551151f6d279eb783a911e6c1f7794af141704df40cd202c334fc6d4c7c3be9` (unchanged) |
| `shared/schema.ts` | `c7a58c9c…` (phase 1) | `761d5943f991b548e76335e2acbdab3e5f60b46dbc11c3362c14ab1a564a85ae` (corrected in round 4: this cell's original value was stale, the round-3 receipt's is right — §R3.0 finding E; round 4 moves the file again, §R3.6) |
| `shared/storage.ts` / `commands/assignments.ts` / `commands/execution.ts` / `program/index.ts` | phase-1 accepted | unchanged (`752215df…`, `1e9b7c52…`, `54646ed4…`, `4aeb2c14…`) |
| `adapters/database-adapter.ts` | `7d8485a8…` (= HEAD) | `ab95ed3cd1b8542e4ef19c0efdd7a8a9e340eefb156bdd068c1bd5866644e2c5` |
| `adapters/databases/sqlite/sqlite-adapter.ts` | `cc772ecd…` (= HEAD) | `679de883012390217143900b1f52539a767c67460c7e0a1c8ea1a79b58ae450d` |
| `adapters/databases/postgres/postgres-adapter.ts` | `050657a0…` (= HEAD) | `b29d1393a2148369228b0a359138e1d3d8df30d48bd872ffc520c4e9dcef3f7e` |
| `adapters/databases/mysql/mysql-adapter.ts` | `62e60567…` (= HEAD) | `1dd38ed31a23679b247402e5c609179945032df87e1915de44e43bc5fe2beb00` |

**Patches regenerated** (both verified to reverse-apply, and the production one
to reproduce the four phase-1 accepted identities, `c7a58c9c…`, and the four
adapter HEAD identities, exactly):

- [`production-phase2.patch`](production-phase2.patch) — now **nine** files —
  `9f9adfd739c0aed7a02cdd27fcd8ecf2c441f7296241536f80601ec018d4326c`
- [`tests-phase2.patch`](tests-phase2.patch) — the unit's **20** own test files
  (17 + 3 new) plus the two G2.9 specimen edits and the adapter contract test —
  `680a2956166337b350a1dac9a688211e8401c5d4aa137b60482235d60b93a12d`

The phase-1 `production.patch` / `tests.patch` are unchanged.

**Cost**, same census function (`countTokenLines`,
`censusFunctionSha256 15889231a22297fcf001ae22ca01e6e8c9cd7489dd635c60529dfdc0ac06461e`),
JSDoc and EOF excluded:

| | files | bytes | physical | token-lines |
| --- | --- | --- | --- | --- |
| the four phase-2 files, phase-1 accepted | 4 | 236,563 | 6,864 | 6,461 |
| the four phase-2 files, phase 2 | 4 | 255,888 | 7,276 | 6,687 |
| the four phase-2 files, **round 3** | 4 | **257,036** | **7,296** | **6,694** |
| `shared/schema.ts`, before → after | 1 | 10,116 → **13,390** | 341 → **414** | 327 → **370** |
| the four adapters, before → after | 4 | 138,743 → **140,389** | 3,393 → **3,423** | 1,629 → **1,635** |

| Increment | bytes | physical | token-lines |
| --- | --- | --- | --- |
| round 3 over phase 2, candidate core | **+4,422** | **+93** | **+50** |
| round 3 over phase 2, adapters (charged separately) | **+1,646** | **+30** | **+6** |
| phase 2 + round 3 over the phase-1 accepted four files | +20,473 | +432 | +233 |

Candidate **core** (12 files, `commands/` + `shared/`) now measures
**344,394 bytes / 9,968 physical / 9,277 token-lines** (was 339,972 / 9,875 /
9,227); the whole `src/query-engine/raptor3` tree (15 files) measures
**373,660 / 10,826 / 10,046** (was 369,238 / 10,733 / 9,996). The **complete
charged perimeter** is still **UNVERIFIED**, for §R.6's unchanged reason; round
3 adds four `src/adapters/**` files to whatever that perimeter is, measured
above.

## R2.8 Suites, after the last source edit

Serial, through the bounded runner. Receipts in
[`receipts/phase2/repair/`](receipts/phase2/repair/).

| Suite / mode | Result | vs. the reviewed round |
| --- | --- | --- |
| G4-02 author checks (17 files) | **80 passed / 6 skipped** | was 60 / 1 skipped over 14 files; +3 files, +20 cells |
| G4-02 native probe, MySQL `:65515` | **5 passed** | new |
| review probes `unit02-phase2` (10 files) | **54 passed / 2 failed** | was 49 / 7; the 2 are §R2.2's recorded divergences |
| `g4-read-contracts` | 60 passed / **2 failed** (SC-13, RF-16) | unchanged |
| `g4-unit01-review` (29 files) / `g4-unit01-author` (10) | **200** / **83 passed** | unchanged |
| `g1-contracts` / `g1-transport` / `g2-contracts` | 143 / 44 / 216 passed | unchanged |
| `transitions` (33 files) | **434 passed** | unchanged |
| `post-prep` | **49 passed** | unchanged (+1 cell in the estate) |
| `expanded` (7 files) + `ownership` + `polish` | **293 passed** | unchanged |
| `prep` (6 files) | **37 passed** | unchanged |
| candidate core (7 files) | **100 passed** | unchanged |
| `core-structure/` | 81 passed / **13 failed** | the same 12 inherited cells (§P.11.3); `cs02-structure-measure` is counted twice because it is registered in two projects |
| `g3-suppression-retry` / `-bulk-series` / `-transaction-array` / `-depth-recurrence` | 2 / 6 / 4 / 6 passed | unchanged |
| **`g3-execution-review`** | **6 passed** | the cell the first mirror broke, restored by §R2.2's narrowing |
| `g3-author-execution-regressions` / `-scope-failure` / `-bulk-result-boundary` | 3 / 2 / 5 passed | unchanged |
| `g3p02` / `g3p03` / `g3p04` / `g3p04-review` / `g3p05` + 3 focused | 4 / 6 / 5 / 5 / 21 + 11 / 4 / 6 passed | unchanged |
| `post-g3-*` (5 modes) | 4 / 1 / 4 / 4 / 5 passed | unchanged |
| `g29-member-dependency` / `-boundaries` / `-choices` / `-result-progress` | 14 / 4 / 10 / 2 passed | unchanged |
| `cs01-*` (4 modes) / `cs03-member-scope` | 10 / 6 / 4 / 4 and 8 passed | unchanged |
| `g4-route-transactions` / `-admission` / `-cache` / `-lifecycle` | 9/2, 4/1, 6, 7 | unchanged (LX-04, LX-14, `findFirst`: stale pins) |
| `g4-lifecycle-events` / `-admission` | 1/2 and 3/1 | unchanged (route-owned, §P.11.5) |
| `g4-generation-selftests` | 6 passed | unchanged |
| **`tests/contracts/adapters/` (9 files)** | **182 passed** | the adapter seam's own family |
| **`g3-generated-transport-smoke`** | **1 failed** | §R2.5 — phase 2's fold, recorded per recipe |
| native pg `:65504`: `g2-pg-contracts` / `g4-read-envelope-pg` / `g3-scope-composition-pg` / `g29-member-dependency-pg` / `g27-pg` / `g3p04-pg` / `post-g3-clearability-pg` | 18 / 5 / 2 / 2 / 1 / 4 / 2 passed | unchanged |
| native mysql `:65515`: `g4-read-envelope-mysql` / `g3-scope-composition-mysql` / `g29-member-dependency-mysql` / `g27-mysql` / `g3p04-mysql` / `post-g3-clearability-mysql` | 5 / 2 / 2 / 1 / 4 / 2 passed | unchanged |
| **`g2-mysql-contracts`** (`:65515`) | 10 passed / **3 failed** | §R2.5 — not this unit's, in either phase |
| `node scripts/credential-free-test-manifest.mjs` | **exit 0** | unchanged |
| `node scripts/run-typecheck.mjs` | **exactly the two permitted `pattern/pack.ts` diagnostics** (1443, 2633); 8.37 s wall, 6,176.4 MiB peak sampled RSS, teardown verified | unchanged |

## R2.9 Blockers and decisions for Arnaud

| id | What | Where |
| --- | --- | --- |
| **R-D1** | The candidate cannot NAME an exact-decimal field's value under `multiply`/`divide` (only assign it), because the provider's assignment is a guarded coefficient rewrite with no expression form. Reachable shape *as first stated*: a decimal RELATION key on a non-RETURNING provider, where the shipped engine computes the key in JavaScript — **[reachability withdrawn, see §R3.3]**: no public request reaches the refusal; the decision is whether the candidate must ever NAME that value, not how it answers today. Registered refusal identity, pinned. | §R2.1, §R3.3 |
| **R-D2** | Two pre-existing key-update divergences from the shipped engine, now visible because `multiply`/`divide` exist: the candidate SUPPORTS a decimal key `increment` (registered by `g3-execution-review`) where the shipped engine refuses, and lets `set` win over an accompanying operator where the shipped engine refuses both. Each engine's exact answer is pinned. | §R2.2 |
| **R-B3** | `g2-mysql-contracts` 10/13 on native MySQL is a G4 regression that is **not G4-02's in either phase** (measured against the pre-unit tree). Needs reassignment to G4-01/G4-03 or the route. | §R2.5 |
| **R-B4** | `g3-generated-transport-smoke` (and `g4-write-transport-seed-batch 100000`) is phase 2's root-`create` fold. The new shape is recorded per recipe; the re-script belongs to the harness reconciliation unit, as the brief assigns. | §R2.5 |
| (open) | The G2.9 specimen edit is in another stream's file and one assertion changed direction; no settlement recorded. | §R2.6 |

## R2.10 Unverified after round 3

1. The **complete charged perimeter** — unchanged reason (§R.6); the core and
   adapter figures in §R2.7 are reproducible to the byte.
2. The cascading-key property of falsifier 3 (a dependent's transition through a
   MULTIPLIED key) — §P.14 item 2 as corrected. The key half itself is now
   measured on two transports and on live MySQL.
3. `scripts/raptor3-cli.test.mjs` and the three harness self-tests were not
   re-run: `scripts/*.test.mjs` is matched by no project in the current
   `vitest.workspace.ts` (§P.14 item 3). Round 3 changed nothing under
   `scripts/`.
4. The two witness cells of §P.11.1 — unchanged; still another stream's files.
5. `expressions.integerDivide` is measured on SQLite (author checks), on
   PostgreSQL only through the dialect contract test's rendered SQL (the
   candidate never calls it there — PostgreSQL supports `RETURNING`, so
   `updatedIdentity` does not need a name), and end-to-end on live MySQL. No
   cell exercises a PostgreSQL provider whose `supportsReturning` is forced off.

# Repair 3 (round 4, after the second independent phase-2 review returned REVISE)

Review: [`../unit02-phase2-review-followup.md`](../unit02-phase2-review-followup.md)
— **one blocking finding (A)** and four notes (B–E). Receipts for everything
below: [`receipts/phase2/repair4/`](receipts/phase2/repair4/), identities in
[`repair4/identities.txt`](receipts/phase2/repair4/identities.txt), harness
identity before and after the round in
[`identity-before.json`](receipts/phase2/repair4/identity-before.json) /
[`identity-after.json`](receipts/phase2/repair4/identity-after.json) (the
harness fingerprint drifts throughout: another author is editing
`tests/raptor3/**` and `scripts/**` concurrently, so a run that failed *only*
with `Stale Raptor 3 evidence` was retried and both receipts are kept).

The blocking finding is the previous repair's own doing, and round 4 removes it
rather than recording it. Round 3 stated a shipped refusal in a place the
shipped engine does not state it; four public `upsert` shapes — one of them a
row CREATION — were refused by the candidate and performed by the shipped
engine. Round 4 raises the same refusal **where the shipped engine raises it**,
which turns out to have two halves, not one.

## R3.0 Finding → status

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| A | **blocking** | the key-portability mirror fires on `upsert`, where the shipped engine asserts only for a relation-bearing update payload and only on the found arm; four public shapes diverge, one loses a creation | **repaired + witnessed** (§R3.1). The refusal is answered by one owner and raised at the two places the shipped engine raises it. Seven differential cells, three falsifiers, green on SQLite and on live MySQL. |
| B | note | a `number` primary key `increment` diverges too and is not in R-D2's table | **recorded + pinned** (§R3.2): a cell in `key-arithmetic.test.ts` states both engines' answers. R-D2 itself is unchanged, as the integrator asked. |
| C | note | §R2.4's falsification row does not cover the estate it claims | **corrected in place** (§R3.4). |
| D | note | R-D1's stated reachable shape was not reproducible | **corrected** (§R3.3): the refusal is recorded as unreachable from the public surface. The decision itself stands unchanged. |
| E | note | §R2.7's `schema.ts` identity is stale | **corrected in place** — §R2.7 now carries the round-3 receipt's `761d5943…`. |

## R3.1 [blocking] The shipped gate has two halves, and the refusal is now raised in both

> **[Corrected in §R4.3.]** The shipped gate has **three** owners, not two.
> The third — `RecordUpdateCompilerState.interpretReferencedKeyTransition`,
> reached from the `UpsertOperation` **constructor** — runs before either arm
> exists. Two sentences below are therefore wrong as written and are corrected
> in §R4.3: the "TWO halves" model of this heading, and the claim that a fifth
> shape (a relation-bearing payload on a missing row) "is closed here too",
> which held for `multiply` and not for `divide: 0`. The seven cells and the
> three falsifiers below are unaffected and stand as measured.

**What the shipped engine does**, measured in `src/query-engine/write-engine/UpsertOperation.ts`:

| line | fact |
| --- | --- |
| `:291-293` | `updateHasRelations` — the update payload partitions into at least one relation or polymorphic payload |
| `:496-504` | `this.updateLegality = updateHasRelations ? () => { … assertPortablePrimaryKeyUpdateInput(model, "update", updateArgs) … } : undefined` — a scalar-only update payload never builds the assertion at all |
| `:845-853` | `compileFoundArm` calls `this.updateLegality?.()` — after create/update arm selection, before conditional skip/update selection. An upsert whose row is ABSENT takes the create arm and never reaches the contract; the arithmetic is never applied. |

Round 3 called the contract from `EngineSchema.admit` for `update`,
`updateMany` **and** `upsert`. That is wider on both axes: it fires for a
scalar-only payload, and it fires before any row has been located. The review
measured four divergent shapes; a fifth (a relation-bearing payload on a
missing row) was still divergent after the narrow fix and is closed here too.

**What round 4 changes** — two files, both this unit's:

1. `shared/schema.ts`: `assertPortableKeyUpdate` becomes
   `keyPortabilityRefusal(model, data)`. It **answers** the refusal instead of
   throwing it, and no longer decides where it applies; the sentences are
   unchanged. `admit` throws it for `update`/`updateMany` only — the two
   operations whose shipped validator raises it unconditionally.
   `namesRelation(model, data)` becomes the one spelling of "this payload names
   a relation", which this file's own `upsert` admission already needed for its
   create arm and which now also answers the upsert gate.
2. `commands/commands.ts`: the upsert branch hangs the answer on the **found
   arm** — `foundArm.refusal = schema.keyPortabilityRefusal(model, args.update) ?? foundArm.refusal`,
   guarded by `schema.namesRelation(model, args.update)`.

`CommandOccurrence.refusal` is the candidate's **existing** found-arm legality
channel: `commands/execution.ts:260` raises it when the found record runs, and
`:391` raises it after `found.command.fields.activate()` and *before* a
conditional probe is evaluated — the same two positions the shipped comment at
`UpsertOperation.ts:845-853` names ("Found-arm legality runs after create/update
selection but before conditional skip/update selection"). So there is no new
mechanism, no second sentence, no policy boolean, and no admission-time decision
about a row nobody has read yet. It is assigned rather than `??=`-ed onto the
arm because the shipped legality order puts portability ahead of relation
compilability.

**Measured, candidate vs the client's own shipped engine, one world per cell**
— `tests/raptor3/g4/unit02/upsert-key-portability.test.ts` (7 cells), SQLite
with RETURNING, answer **and** the rows the provider holds afterwards compared:

| # | request | shipped | candidate (round 4) |
| --- | --- | --- | --- |
| 1 | `numKey.upsert({ where:{id:6}, create:{…}, update:{ id:{ multiply:2 } } })`, row present | `ok:{"id":12,"label":"a"}` | identical |
| 2 | the same on a **decimal** key (`{ multiply:"2.00" }`) | `ok:{"id":"12","label":"a"}` | identical |
| 3 | `intKey … update:{ id:{ divide:0 } }`, row present | `QueryError` — the statement IS issued | identical |
| 4 | `numKey … where:{id:99}`, **row absent** | `ok:{"id":99,"label":"new"}` — **row created** | identical |
| 5 | `owner … update:{ id:{ multiply:2 }, notes:{ create:[…] } }`, **relation-bearing**, row present | `QueryEngineError: Arithmetic updates are not portable for number primary key field 'id'. Use an explicit set value.` | identical |
| 6 | the same, **row absent** | `ok:{"id":99,"label":"fresh"}` — **row created** | identical |
| 7 | the same as 5 with an unmatched `targetWhere` | the refusal — legality precedes conditional selection | identical |

All seven are green on SQLite
([`repair4/author-checks-final.log`](receipts/phase2/repair4/author-checks-final.log))
and on the live MySQL container `viborm-raptor3-g3-mysql-20260914`
(`d6da412eec3c`, `127.0.0.1:65515`) together with the 5 native key-arithmetic
cells and the 16 `key-arithmetic` cells — 28 passed
([`repair4/native-mysql-final.log`](receipts/phase2/repair4/native-mysql-final.log)).

**Falsifiers.** Each is a scratchpad-backed file swap (never `git checkout`),
identities verified in and out and recorded at the head and foot of its own
receipt, with the whole 18-file author estate re-run. They ran at **93 cells**:
§R3.2's cell was added afterwards, and it is pre-existing (falsifier 2 answers
it identically), so it changes no row below:

| # | swap | what must go red | measured |
| --- | --- | --- | --- |
| 1 | the **round-3 placement** — `schema.ts` → `761d5943…`, `commands.ts` → `a208e1f2…` | the review's four shapes | **5 failed / 82 passed / 6 skipped** — cells 1–4 **and** cell 6 ([`falsify-round3-placement.log`](receipts/phase2/repair4/falsify-round3-placement.log)) |
| 2 | the **contract removed** — `schema.ts` → `c7a58c9c…` (phase-1 accepted), `commands.ts` → `a208e1f2…` | the relation-bearing half, and the `update`/`updateMany` contract | **6 failed / 81 passed / 6 skipped** — cells 5 and 7, plus the four `key-arithmetic.test.ts` contract cells; cells 1–4 and 6 are GREEN there, which is why the review's four shapes were round 3's doing ([`falsify-contract-removed.log`](receipts/phase2/repair4/falsify-contract-removed.log)) |
| 3 | the **deferral dropped** — the round-4 contract raised at `admit` for an upsert whose payload names relations, `commands.ts` at round 4 | only the missing-row creation | **1 failed / 86 passed / 6 skipped** — cell 6 alone ([`falsify-deferral-dropped.log`](receipts/phase2/repair4/falsify-deferral-dropped.log)) |

Falsifier 3 is the one that answers "why not just gate on `updateHasRelations`
at admission": that placement is still wider than the shipped engine's, and the
shape it loses is again a row creation.

**Reviewer probes, re-run.** The follow-up probe suite
(`tests/raptor3/g4/review/unit02-phase2-followup/`) is **15 passed / 1 failed /
3 skipped** (was 11 / 5 / 3): all four `upsert` cells of finding A are green;
the one that remains red is finding B's `number`-key `increment`, which the
review itself measured as pre-existing and which §R3.2 pins
([`review-followup-probes-final.log`](receipts/phase2/repair4/review-followup-probes-final.log)).
The three skipped cells are the reviewer's native PostgreSQL arm; run here with
`VIBORM_RAPTOR3_PROVIDER=pg VIBORM_RAPTOR3_PROVIDER_PORT=65504` against
`viborm-raptor3-g3-pg-20260914` (`7dfda37e8eea`) they are **3 passed**
([`review-native-pg-probe.log`](receipts/phase2/repair4/review-native-pg-probe.log)),
which closes §R2.10 item 5 on this side too. The phase-2 probe suite
(10 files) is unchanged at **54 passed / 2 failed** — the two are R-D2's
recorded divergences ([`review-phase2-probes.log`](receipts/phase2/repair4/review-phase2-probes.log)).

## R3.2 [note B] The `number`-key `increment` arm of the same family

R-D2 (a) records the **decimal** key `increment` the candidate supports where
the shipped engine refuses. The review found the `number` arm of the same
family. It is pre-existing — falsifier 2 (this unit's whole contract removed)
answers it identically — and it is now pinned beside the decimal arm in
`key-arithmetic.test.ts` ("supports a number key increment where the shipped
engine refuses it"), so Arnaud decides the family once:

| request | shipped | candidate |
| --- | --- | --- |
| `numKey.update({ where:{id:6}, data:{ id:{ increment:1 } } })` on `s.number().id()` | `QueryEngineError: Arithmetic updates are not portable for number primary key field 'id'. Use an explicit set value.` | `ok:{"id":7,"label":"a"}` |

**R-D2 itself is unchanged** (§R2.9 stands as round 3 recorded it); this row is
the addendum the review asked for, not a new decision.

## R3.3 [note D] R-D1's refusal is unreachable from the public surface

The review built three constructions on a non-RETURNING driver trying to reach
`Queries.updateValue`'s exact-decimal `multiply`/`divide` refusal through a
decimal RELATION key, and all three answered identically on both engines
(`ForeignKeyError`, or the ordinary `ok`). §R2.1's sentence "the reachable shape
is a decimal RELATION key under `multiply`/`divide` on a non-RETURNING
provider" is therefore **withdrawn**: as of round 4 no public request reaches
that refusal — admission refuses a decimal ROW key first (§R2.2) and a decimal
relation key's transition is spelled by the provider's own assignment. The
refusal is pinned only at the unit level (`key-arithmetic.test.ts:360`).

**R-D1 itself is unchanged** (§R2.9 stands): the decision Arnaud is asked to
take is whether an unreachable-but-registered refusal may stay, now with the
reachability correctly stated rather than overstated.

## R3.4 [note C] §R2.4's falsification row, corrected

The receipt §R2.4 cites
([`repair/falsify-author-checks-on-phase1-tree.log`](receipts/phase2/repair/falsify-author-checks-on-phase1-tree.log))
reports **32 failed / 46 passed / 1 skipped over 16 files / 79 cells**; it was
run before the last three author files were added, so the row's label ("the
FINAL 17-file author estate … 86 cells") was wrong. The reviewer re-ran the
identical swap against the final 17-file estate and measured **32 failed / 48
passed / 6 skipped (86 cells)** — the same failure count, the same conclusion.
That measurement is adopted here; §R2.4's row is corrected in place. Round 4's
own falsifiers (§R3.1) are stated against the 18-file / 93-cell estate they ran
on; the final estate is 94 cells, one more than they saw (§R3.2's).

## R3.5 Suites, after the last source edit

Serial, through the bounded runner, on the identities in
[`repair4/identities.txt`](receipts/phase2/repair4/identities.txt). Receipts in
[`receipts/phase2/repair4/`](receipts/phase2/repair4/).

| Suite / mode | Round 4 | vs. round 3 |
| --- | --- | --- |
| **G4-02 author checks (18 files)** | **88 passed / 6 skipped** (94 cells) | was 80 / 6 over 17 files; +1 file (`upsert-key-portability.test.ts`, 7 cells), +1 cell (§R3.2) |
| **G4-02 native MySQL (`:65515`), 3 files** | **28 passed** | was 5; the upsert gate and the whole key-arithmetic file now run there too |
| review probes `unit02-phase2` (10 files) | 54 passed / **2 failed** | unchanged (R-D2) |
| **review probes `unit02-phase2-followup` (3 files)** | **15 passed / 1 failed / 3 skipped** | was 11 / 5 / 3 |
| **reviewer's native pg probe (`:65504`)** | **3 passed** | was skipped |
| **`g3-execution-review`** | **6 passed** | unchanged — the registered decimal-key-increment witness is intact |
| `g4-read-contracts` | 60 passed / 2 failed at 12:18, **62 passed** at 13:13 ([`g4-read-contracts.log`](receipts/phase2/repair4/g4-read-contracts.log), [`-final.log`](receipts/phase2/repair4/g4-read-contracts-final.log)) | was 60 / 2 — the SC-13 and RF-16 witness defects diagnosed in §P.11.1 went green DURING this round, from an edit in the witness stream's own files; no byte of this unit's diff changed between the two runs except one JSDoc line (§R3.6) |
| `g1-contracts` / `g2-contracts` / `g25` / `g27` | 143 / 216 / 6 / 6 passed | unchanged |
| `g3-suppression-retry` / `-bulk-series` / `-transaction-array` / `-depth-recurrence` | 2 / 6 / 4 / 6 passed | unchanged (`-depth-recurrence` exits non-zero on the harness identity alone — the concurrent harness edits; the six cells pass) |
| `g3-author-execution-regressions` / `-scope-failure` / `-bulk-result-boundary` | 3 / 2 / 5 passed | unchanged |
| `g3p02` / `g3p03` / `g3p04` / `g3p04-review` / `g3p05` + 3 focused | 4 / 6 / 5 / 5 / 21 + 11 / 4 / 6 passed | unchanged |
| `post-g3-*` (5 modes) | 4 / 1 / 4 / 4 / 5 passed | unchanged |
| `g29-member-dependency` / `-boundaries` / `-choices` / `-result-progress` | 14 / 4 / 10 / 2 passed | unchanged |
| `cs01-*` (4 modes) / `cs03-member-scope` | 10 / 6 / 4 / 4 and 8 passed | unchanged |
| `transitions` (33 credential-free files) | **434 passed** | unchanged (the 12 live-provider files do not collect without credentials) |
| `prep` / `post-prep` / `post-prep` PGlite | 37 passed / 9 files green / 1 passed | unchanged; `post-prep` hit the 1536 MiB process-group RSS ceiling at teardown twice (concurrent runs share the sample), so its summary line is missing from both receipts |
| `expanded` (7 files) | **281 passed** | unchanged; same RSS ceiling at teardown |
| candidate core (7 files) | **100 passed** | unchanged |
| `tests/contracts/adapters/` (9 files) | **182 passed** | unchanged (no adapter byte changed this round) |
| `core-structure/` | **92 passed / 2 failed** | was 81 / 13. The CS-03 `extension-campaign.selftest` reds are GONE (42/42) — another stream's repair, not this one's. The two that remain are the single inherited `cs02-structure-measure` file, counted once per project (§P.11.3) |
| `g4-route-transactions` / `-admission` / `-cache` / `-lifecycle` | **13 / 7 / 7 / 8 passed** | was 9/2, 4/1, 6, 7 — the LX-04 / LX-14 stale pins are fixed in the route stream's own files. Each mode now exits non-zero on its REGISTERED CELL COUNT (13 !== 11, etc.): the count belongs to `scripts/run-raptor3.mjs`, which is the harness stream's |
| `g4-lifecycle-events` / `-admission` | **3 passed** / (3 passed, 1 failed) | was 1/2 and 3/1; the one red is the route's cache-codec refusal (G4-03b FU.6 B-1c) |
| `g4-unit01-review` / `g4-unit01-author` | 200 / 83 passed | unchanged |
| `g4-generation-selftests` | 6 passed | unchanged |
| **`g3-generated-transport-smoke`** | **1 passed** | was 1 failed — the harness stream re-scripted `transport-plans.ts` per §R2.5's recipe. **R-B4 is closed.** |
| native pg `:65504`: `g2-pg-contracts` / `g4-read-envelope-pg` / `g3-scope-composition-pg` | 18 / 5 / 2 passed | unchanged |
| native mysql `:65515`: `g4-read-envelope-mysql` / `g3-scope-composition-mysql` | 5 / 2 passed | unchanged |
| **`g2-mysql-contracts`** (`:65515`) | 10 passed / **3 failed** | unchanged — the same three `unique-races-live-commands` cells; R-B3, measured in round 3 against the PRE-UNIT tree, still not this unit's |
| `node scripts/credential-free-test-manifest.mjs` | **exit 0** | unchanged |
| `node scripts/run-typecheck.mjs` | **exactly the two permitted `pattern/pack.ts` diagnostics** (1443, 2633); 10.56 s wall, 5,720.9 MiB peak sampled RSS, teardown verified ([`typecheck-final.log`](receipts/phase2/repair4/typecheck-final.log)) | unchanged |
| `biome check` (the two production files + the two test files) | 6 diagnostics, **all pre-existing** — `noParameterProperties` ×2, `noParameterAssign`, `organizeImports`, `schema.ts`'s single constructor-line format drift and `commands.ts`'s whole-file drift; verified identical on scratchpad copies of both files at their round-3 identities ([`biome.log`](receipts/phase2/repair4/biome.log)). Round 4's own lines are format-clean, and so are both test files | round 3 added none either |

## R3.6 Files, identities, cost

Round 4 edited **two** production files. The other seven this unit owns, and
all four adapters, are byte-identical to their round-3 identities.

| File | Round-3 identity | Round-4 identity |
| --- | --- | --- |
| `shared/schema.ts` | `761d5943…` | `07b3df1af03638667abfbb236d739fe947993f9a4f2fd96793ef3bcc46956613` |
| `commands/commands.ts` | `a208e1f2…` | `f4ecd7addff0719e931925275253159748d65e70f9cae741ae8175b06357b0ce` |
| `shared/query.ts` / `shared/operation-context.ts` / `commands/index.ts` | round 3 | unchanged (`5143b7b3…`, `8b25f6fe…`, `f551151f…`) |
| `shared/storage.ts` / `commands/assignments.ts` / `commands/execution.ts` / `program/index.ts` | phase-1 accepted | unchanged (`752215df…`, `1e9b7c52…`, `54646ed4…`, `4aeb2c14…`) |
| the four `src/adapters/**` files | round 3 | unchanged (`ab95ed3c…`, `679de883…`, `b29d1393…`, `1dd38ed3…`) |

One JSDoc line in `shared/schema.ts` was corrected after the mode receipts were
taken (`999b3c8d…` → `07b3df1a…`; the comment on `namesRelation` claimed three
askers where the method has two). The change is a comment and nothing else —
`diff` between the two identities is that one hunk — and the author estate
(88/6), `g3-execution-review` (6), `g2-contracts` (216), `g4-read-contracts`
(62) and `run-typecheck` were re-run at the final identity, with `-final`
receipts. Every other receipt in this round was taken at `999b3c8d…`.

Test files: `upsert-key-portability.test.ts` is new
(`5a3ff24d00b3d3f281ca39c954de9cca249fa28844b8bee0884af86a04f1dc0c`) and
`key-arithmetic.test.ts` gained §R3.2's cell
(`d054df6d22c15520ac0d9d4503c8a25164d64acc94decc4c4280e8d169827ed9`); the other
19 are unchanged.

**Patches regenerated** (both verified to reverse-apply; the production one
reproduces `6f39f82a…`, `65aa6f5b…`, `c7a58c9c…`, `12442b94…`, `546adce4…` and
the four adapter HEAD identities exactly, the tests one reproduces the three
tracked test files' HEAD content and empties the 21 new ones):

- [`production-phase2.patch`](production-phase2.patch) — nine files —
  `f2ef45982f088682f4e73d484860b2bf04e4400e46fceab6c5962888b38b60dd`
- [`tests-phase2.patch`](tests-phase2.patch) — 24 files (21 own + the two G2.9
  specimen edits + the adapter contract test) —
  `217271063283841a975afd274845be65b94eb33e0971d894d8b6a0e8e9eb3b5b`

The phase-1 `production.patch` / `tests.patch` are unchanged.

**Cost**, same census function as §R2.7
(`countTokenLines`, JSDoc and EOF excluded), recomputed with the reviewer's own
[`cost.mjs`](../unit02-phase2-review-followup-receipts/cost.mjs):

| | files | bytes | physical | token-lines |
| --- | --- | --- | --- | --- |
| the four phase-2 files, round 3 | 4 | 257,036 | 7,296 | 6,694 |
| the four phase-2 files, **round 4** | 4 | **257,754** | **7,307** | **6,699** |
| `shared/schema.ts`, round 3 → **round 4** | 1 | 13,390 → **14,409** | 414 → **426** | 370 → **365** |
| the four adapters | 4 | 140,389 | 3,423 | 1,635 (unchanged) |

| Increment | bytes | physical | token-lines |
| --- | --- | --- | --- |
| round 4 over round 3, candidate core | **+1,737** | **+23** | **0** |

The token-line count of the core is unchanged: the five token-lines
`commands.ts` gains are the five `schema.ts` loses, because answering the
refusal instead of throwing it removed the nested per-operation ternary that
chose the payload — the callers now name their own. Candidate **core** (12 files, `commands/` + `shared/`)
now measures **346,131 bytes / 9,991 physical / 9,277 token-lines**; the whole
`src/query-engine/raptor3` tree (15 files) measures **376,033 / 10,861 /
10,047**. The **complete charged perimeter** is still **UNVERIFIED**, for
§R.6's unchanged reason.

## R3.7 Blockers and decisions for Arnaud, after round 4

| id | What | State |
| --- | --- | --- |
| **R-D1** | the candidate cannot NAME an exact-decimal field's value under `multiply`/`divide` | **unchanged** as §R2.9 records it; §R3.3 corrects only its reachability (no public request reaches it) |
| **R-D2** | two — now three — pre-existing key-update divergences: a decimal key `increment`, the same on a `number` key (§R3.2), and `set` winning over an accompanying operator | **unchanged** as §R2.9 records it; the `number` arm is pinned beside the decimal one |
| **R-B3** | `g2-mysql-contracts` 10/13 on native MySQL is a G4 regression that is not G4-02's in either phase (measured against the pre-unit tree) | **unchanged** — still needs reassignment |
| **R-B4** | `g3-generated-transport-smoke` / the root-`create` fold re-script | **CLOSED** — the harness stream re-scripted it; the mode is 1 passed on this tree |
| (open) | the G2.9 specimen edit is in another stream's file and one assertion changed direction; no settlement recorded | unchanged (§R2.6) |

**Round 4 adds no new decision.** The divergence family finding A named is
closed by parity, not recorded, and the one shape that survived the narrow fix
(a relation-bearing payload on a missing row) is closed with it.

## R3.8 Unverified after round 4

1. The **complete charged perimeter** — unchanged reason (§R.6); the core and
   adapter figures in §R3.6 are reproducible to the byte.
2. `scripts/raptor3-cli.test.mjs` and the three harness self-tests were not
   run: `scripts/*.test.mjs` is matched by no project in the current
   `vitest.workspace.ts` (§P.14 item 3), which another stream owns. Round 4
   changed nothing under `scripts/`.
3. The two witness cells of §P.11.1 (SC-13, RF-16) are now GREEN
   (`g4-read-contracts` 62/62), but the repair is in the witness stream's files,
   not measured or attributed by this unit.
4. The upsert gate is measured on SQLite (RETURNING) and on live MySQL. **No
   PGlite or native-PostgreSQL cell exercises it** — unchanged, and the refusal
   is provider-independent by construction (raised before any statement). The
   atomic-batch (`usesBatch`) half is no longer unmeasured: it is **measured and
   divergent**, and §R4.4 records both halves. The relation-bearing gate is
   raised on a batch profile exactly as the shipped engine raises it (the second
   independent review measured it; this round re-measured the same profile).
   The scalar-only half diverges — a non-`int` key whose expression update is
   demanded under a batch reaches the bare invariant `Error: Raptor 3 update
   expression publication requires an integer field` where the shipped engine
   answers the row. Both answers are now pinned
   (`key-arithmetic.test.ts`, "the batch publication's integer-only expression
   gap") and the gap is decision **R-D3**, not this round's repair.
5. `core-structure` is read here as 92/2 with the CS-03 selftest green; the
   repair that turned those ten cells green is another stream's and was not
   attributed by this unit.

# Closure repair (round 5, after the third independent phase-2 verification)

Brief: [`briefs/unit02-mysql-unique-race-regression.md`](../briefs/unit02-mysql-unique-race-regression.md)
— three obligations in one unit. The base of this round is the round-4 tree the
second independent phase-2 review verified (identities §R3.6), plus the two
files transferred to this unit for obligation 2
(`raptor3/route/client-route.ts`, `tests/raptor3/g4/route-cache.test.ts`).
Environment: node `v24.21.0`, vitest `3.1.4`, better-sqlite3 `12.6.0`; native
MySQL `viborm-raptor3-g3-mysql-20260914` (`d6da412eec3c`, `127.0.0.1:65515`) and
native PostgreSQL `viborm-raptor3-g3-pg-20260914` (`7dfda37e8eea`,
`127.0.0.1:65504`), both up 15 h, restarts 0.

## R4.0 Obligation → what it cost → status

| # | Obligation | Change | Status |
| --- | --- | --- | --- |
| 1 | the three red `g2-mysql-contracts` cells | one rule in `Queries.prepareSelector` + one guard in `lowerOperation`, carried by the admitted-unique call sites | **CLOSED** — `g2-mysql-contracts` **13/13**, `g2-mysql-baseline` 13/13, `g2-pg-contracts` 18/18, `g2-pg-baseline` 17/17 |
| 2 | B-1c cache result codec (writer transfer) | `Leaf.scalar` set once in `Queries.leaf`; the route composes `leafCodec`/`shapeCodec` from the official owners | **CLOSED** — `g4-route-cache` **7/7** with the LX-07 pin flipped positive, `g4-lifecycle-admission` 4/4 |
| 3a | the divide-by-zero **third** shipped owner | `EngineSchema.keyTransitionRefusal`, consulted at analysis in the upsert branch, before any row is located | **CLOSED by parity** — 5 new differential cells; §R3.1 corrected |
| 3b | the four notes of the third verification | §R4.4 | **CLOSED** — one of them becomes decision **R-D3** (recorded, not repaired) |

## R4.1 Obligation 1 — the MySQL unique-race cells

### R4.1.1 Reproduced first, at the inherited identity

`VIBORM_RAPTOR3_PROVIDER_PORT=65515 node scripts/run-raptor3.mjs g2-mysql-contracts`
on the tree as handed over: **10 passed / 3 failed**
([`closure/repro-1-mysql.log`](receipts/closure/repro-1-mysql.log)) — the three
cells of `tests/raptor3/transitions/unique-races-live-commands.test.ts` the brief
names, with the same final-state mismatches the integrator measured (the loser's
`claim@x`/`loser` row surviving where `winner@x`/`winner` is expected; an extra
`p-request` post in the unrelated-unique cell; `wrong-insert-provenance` in the
third).

### R4.1.2 Minimized — the difference is one statement's SPELLING, and it is not a race

The three cells are choreographed by `unique-races-live.ts`'s barrier, which
recognises the `connectOrCreate` probe by its **parameters**:

```js
parameters.filter((value) => value === "wanted").length === 1 &&
parameters.every((value) => value === "wanted" || value === 1)
```

So the minimal question is what the candidate binds for
`where: { id: "wanted" }`. Measured on the same container with a throwaway probe
(source kept beside the receipts), table collation `utf8mb4_0900_ai_ci`, the
**before** column taken with `shared/query.ts` swapped to the round-4 identity
and restored and re-hashed in the same receipt
([before](receipts/closure/probe-mysql-discriminator-spelling-before.log),
[after](receipts/closure/probe-mysql-discriminator-spelling.log)):

| request | shipped | candidate **before** | candidate **after** |
| --- | --- | --- | --- |
| `findUnique({ where:{ id } })` — SQL | ``WHERE `t0`.`id` = ?``, one parameter | ``WHERE (`q0`.`id` = ? AND BINARY `q0`.`id` = ?)``, **two** parameters | ``WHERE `q0`.`id` = ?``, one parameter |
| `findUnique({ where:{ id:"WANTED" } })` (collation-equal) | the row | **`null`** | the row |
| `findUnique({ where:{ email:"CLAIM@X" } })` (unique non-key) | the row | **`null`** | the row |
| extended `findUnique` (`id` + a filter) | the row | **`null`** | the row |
| `findFirst({ where:{ id:"WANTED" } })` | `null`, folded pair | `null`, folded pair — **agrees** | unchanged |
| `connectOrCreate` on a collation-equal key | connects, writes no second owner | **`UniqueConstraintError`** — the probe reported the key free and the index rejected the INSERT | connects |

Two facts follow, and neither is a race:

1. the probe bound `"wanted"` **twice**, so the barrier's selector predicate
   stopped matching, the peer never planted its row at the missing-target
   moment, and the whole recovery choreography — including the failed-INSERT
   provenance the third cell pins — never happened;
2. independently of the harness, the candidate answered `null` where the shipped
   engine answers the row whenever the request's key differs from the stored key
   only by collation — and the `connectOrCreate` row above shows the
   consequence, not a hypothesis: the probe reported the key free and the very
   next INSERT was rejected by the index it had not asked.

### R4.1.3 The mechanism, named

A **unique `where`'s discriminator is the constraint's question, not the
engine's text contract's.** The shipped engine spells exactly this split:
`buildWhereUnique` (`src/query-engine/builders/where-unique-builder.ts:63-73`)
compiles the addressable-key entries with `buildUniqueEquality` (`:213`, a bare
`operators.eq`) and hands only the remainder to `buildWhere`, whose string
equality is `operators.exactTextEq`. On MySQL that operator is deliberately a
**folded pair** — `(col = ? AND BINARY col = ?)`
(`src/adapters/databases/mysql/mysql-adapter.ts:537`) — which is the right
spelling for a filter and the wrong one for a key: it asks a stricter question
than the unique index that answers the INSERT. On PostgreSQL `exactTextEq` is a
plain `=` (`postgres-adapter.ts:234`), which is why the regression was
MySQL-only by construction and `g2-pg-contracts` never moved.

### R4.1.4 Attribution — falsified, not asserted

R-B3 recorded this mode as "not G4-02's in either phase" (§R2.5, three measured
rows). That attribution is **unchanged and now explained**: reverse-applying
`production-closure.patch` and then `production-phase2.patch` reproduces
`shared/query.ts` at the inherited phase-1 identity `6f39f82a…` byte-for-byte,
and that file **already** routes string and enum equality through
`a.operators.exactTextEq` (`:1221` `const text =`, `:1267`) with no
discriminator exception; the MySQL adapter at the same point is byte-identical
to `HEAD` (`62e60567…`), and this unit's only adapter change in any round is
`expressions.integerDivide`. The consumer entered with the file G4-02 inherited
(G4-01 r5), the spelling is `HEAD`'s, and neither is G4-02's authorship —
**but `shared/query.ts` is G4-02's file now**, so the repair belongs here rather
than in a reassignment. R-B3 is therefore **closed as repaired**, not
reassigned.

### R4.1.5 The repair — one rule, in the one owner

`Queries.prepareSelector(model, where, unique)` takes the fact the caller
already knows: this `where` was admitted as a **unique** selector. The fact
cannot be recovered from the object's shape — `{ id: … }` is a discriminator
under `findUnique` and a filter under `findFirst` — so it travels with the
admitted operation and nowhere else. `prepareWhere` passes `unique && key !== undefined`
down to `prepareScalarPredicate`, which marks that one prepared column
`key: true`; `lowerOperation`'s text branch adds one clause:

```ts
const text =
  !(target.kind === "column" && target.key === true && !insensitive) &&
  state !== undefined && state.array !== true &&
  (state.type === "string" || state.type === "enum");
```

An `insensitive` mode is a filter spelling and never reaches a discriminator, so
it keeps the folded pair rather than silently folding one side. **No second
walker, no per-verb branch, no adapter change**: the discriminator falls through
to the same `a.operators.eq(exact(column), …)` every non-text comparison already
uses.

**Corrected in place twice — round-5 review finding 4 (the scope was narrowed
in §R5.1) and round-6 review finding 9 (the narrowing was stated per VERB, and
the shipped classification is per verb AND per EDGE KIND, §R6.1). The list below
is the post-§R6.1 one.** The ROOT callers that state `unique` are the ones whose
shipped counterpart is `buildWhereUnique`: `findUnique` (`query.ts:2398`), root
`update` (`commands.ts:1257`) and its RETURNING fast path (`rootUpdate`,
`:1041`), root `delete` (`:1149`) and the `upsert` locator (`:1164`). Every
NESTED target's spelling is answered by one predicate,
`nestedTargetAddressesConstraint` (`selection.ts`, documented on itself and
pointed at by `SelectionSource.unique`), consulted at the three nested target
sites in `relation-body.ts` — the `disconnect` / `delete` lookup, the
`connect` / `connectOrCreate` / `upsert` / `update` selector and the `set`
target — and it answers *filter* for exactly one family: a **reference-held**
target of `disconnect` / `delete` / `update`. A **junction** target of those same
verbs is a discriminator, because the shipped engine compiles it with
`buildFindUnique` / `whereUnique` in both phases and never reaches
`uniqueSelectorConjuncts` (§R6.1). Everything that is a **filter** is untouched
and keeps the case-sensitive spelling: `findFirst`/`findMany`, `updateMany`
(`commands.ts:1276`), `deleteMany` (`:1137`), the upsert's `targetWhere` /
`setWhere` conditional probes (`:1171`), the reference-held nested
`disconnect` / `delete` / `update` targets, a bulk member's `where` (which never
consults the predicate at all), nested relation filters (`query.ts:3108`,
`:3147`) and every `AND`/`OR`/`NOT` arm and non-key entry of an **extended**
unique `where` — measured in the same statement
(`unique-discriminator.test.ts`, the extended-`where` cell) and, per call site
and differentially, in that file's native scope cell (§R5.1, §R6.3).

The round-5 text of this paragraph named `:214` as "the `connectOrCreate` probe"
and `:346` as "a conditional's own selector". Both were wrong: `:214` is the
`disconnect` / `delete` target lookup, and `:346` was the selector shared by
`connect`, `connectOrCreate`, `upsert` **and nested `update`**. That misreading
is why the widened sites went unmeasured (§R5.1).

### R4.1.6 What the repair does not change

The envelope is untouched: no statement was added, removed or re-ordered, and
the fast-path statement and round-trip pins stand unchanged at
`tests/raptor3/g4/unit02/physical-envelope.test.ts` — **10/10**, re-run after
the last edit — as do `packaged-array` (5) and `prepared-operation` (5). The
repair changes one comparison's spelling inside statements the envelope already
counted, which is why no count needed re-pinning.

### R4.1.7 The invariant, and the falsifier

**Invariant.** A column addressed as a member of an admitted unique selector's
discriminator is compared with the dialect's plain equality; every other
comparison keeps the engine's case-sensitivity contract. One fact (this `where`
is a unique selector), one authority (`prepareSelector`), one consumer
(`lowerOperation`).

**Falsifier** — `shared/query.ts` swapped back to the pre-closure identity
`f84afb62…` (scratchpad copy, never `git checkout`), identities recorded in and
out of the swap, whole author estate re-run
([`closure/falsify-discriminator.log`](receipts/closure/falsify-discriminator.log)):
the three live MySQL cells go red **and** both cells of
`tests/raptor3/g4/unit02/unique-discriminator.test.ts` go red (2 failed / 93
passed / 1 skipped), the native one showing `"ok": null` where the shipped
engine answers the row. Restored identity re-hashed at the foot of the same
receipt.

**New author cells** (`tests/raptor3/g4/unit02/unique-discriminator.test.ts`,
2 cells): a SQLite cell that reads the *spelling* — `findUnique` constraint-side,
`findFirst` text-side, the `connectOrCreate` probe constraint-side, an extended
unique `where` splitting both ways inside one statement — and a native MySQL
cell that reads the *answer*, differentially against the client's own shipped
engine, on a case-insensitive collation it asserts first: `findUnique` by key,
`findUnique` by a unique non-key field, `findFirst` (still a filter), `update`
by key, and a `connectOrCreate` whose probe must connect instead of losing its
INSERT to the index.

### R4.1.8 Receipts

| what | receipt |
| --- | --- |
| reproduced (10/13) | [`closure/repro-1-mysql.log`](receipts/closure/repro-1-mysql.log) |
| minimized spelling probe, **before** (round-4 `query.ts` swapped in, restored and re-hashed in the same receipt) | [`closure/probe-mysql-discriminator-spelling-before.log`](receipts/closure/probe-mysql-discriminator-spelling-before.log) |
| the same probe, **after** (probe source: [`…source.ts`](receipts/closure/probe-mysql-discriminator-spelling.source.ts)) | [`closure/probe-mysql-discriminator-spelling.log`](receipts/closure/probe-mysql-discriminator-spelling.log) |
| the three cells after the repair | [`closure/repro-2-mysql-after.log`](receipts/closure/repro-2-mysql-after.log) |
| mode, after the last edit | [`closure/g2-mysql-contracts-final.log`](receipts/closure/g2-mysql-contracts-final.log) (13/13) |
| falsifier | [`closure/falsify-discriminator.log`](receipts/closure/falsify-discriminator.log) |

## R4.2 Obligation 2 — B-1c, the cache result codec (writer transfer)

The recorded change, done exactly: `Leaf` gains `scalar?: Scalar`, set once in
`Queries.leaf` beside the fields that are already a projection of that same
object, and `route/client-route.ts` composes the codec from the **official
owners** in `src/query-engine/result/cache-value-codecs.ts` —
`compileScalarCodec`, `compileWidenedSumCodec`, `recordCodec`, `arrayCodec`,
`nullableCodec`, `taggedRelationCodec`, `countCodec`, `numberCodec`,
`booleanCodec`. That file was **read and not edited** (identity
`5aef8e7f…`, unchanged from `HEAD`).

- **Structure** comes from the prepared read's own published facts (`shape`,
  `value`, `empty`), not from a second walk: `shapeCodec` maps
  `scalar`/`object`/`collection`/`variants` onto the structural owners, and
  `read.empty === null` — the read owner's own statement about zero rows — is
  what decides nullability at the root.
- **Scalar meaning** is never re-dispatched from a type name where a declaring
  `Scalar` exists: `leafCodec` compiles `compileWidenedSumCodec(declared)` for a
  decimal `_sum` and `compileScalarCodec(declared, false)` otherwise. The three
  leaves with no declaring scalar are the read owner's own values — `_count`,
  `exist`, and the number a non-decimal `_avg` or `_distance` publishes — the
  same classification the shipped compiler makes in `compileAggregateLeafCodec`
  and `compileRootCodec`; anything else refuses rather than guesses.
- **Refusals kept**: a recursive read (a published depth no fixed shape bounds)
  and a verb that publishes no prepared read both raise
  `UnsupportedOperationError`; a value the codec cannot represent, or a
  malformed snapshot, raises `CacheConfigurationError` with the shipped
  method/operation meta.
- The only `type ===` dispatch left in the route is `leafCodec`'s three-way
  naming of the carriers that have **no** declaring scalar (`boolean` →
  `booleanCodec`, `int` → `countCodec`, `number` → `numberCodec`, everything
  else refused). No leaf that a column declares is re-dispatched by name: those
  go to `compileScalarCodec` / `compileWidenedSumCodec` addressed by the
  `Scalar` object itself, so there is no second scalar-meaning authority.

**Registered count changes, for the integrator: none — the counts are
unchanged, one cell's meaning is not.** `g4-route-cache` stays at **7 cells**,
all passing: the seventh was "LX-07 PENDING blocker B-1c: a cached read refuses
at the candidate result codec" and is now "LX-07 a cached read stores and
materializes identically on both routes" (the pending pin flipped positive, in
place). `g4-lifecycle-admission` unchanged at **4/4**; `g4-route-admission` 7,
`g4-route-lifecycle` **8**, `g4-route-transactions` 13 — all unchanged by this
unit and re-run after the last edit. (**Corrected in place, round-5 review
finding 5:** this sentence and the §R4.5 table read "`g4-route-lifecycle` 3",
which was a transcription error — the cited receipt already said 8. The
registered count itself moved **7 → 8** during the round, and the +1 is the
**route follow-up's**: the G4-03/03b repair 3 added the D-6 divergence pin to
`tests/raptor3/g4/route-lifecycle.test.ts` (`g4/unit03/note.md` line 1735,
"7 | **8** | **repair 3** adds the D-6 divergence pin";
`g4/unit03b-review-followup.md:165`, "`route-transactions` 11 → 13,
`route-lifecycle` 7 → 8, `route-cache` 6 → 7"), and
`scripts/raptor3-manifest.mjs:509-511` registers 8 with the comment "Owned by
the G4-03 author". No file of this unit's is in that mode.) NS-04 store/materialize
parity with the shipped route (same cached-value identity rules, fresh
materialized graphs) is asserted by the flipped pin itself.

## R4.3 Obligation 3a — the THIRD shipped key owner, and §R3.1 corrected

**§R3.1's model was wrong, and is corrected at its own heading.** The shipped
gate has **three** owners, not two. The third is
`RecordUpdateCompilerState.interpretReferencedKeyTransition`
(`write-engine/RecordUpdateCompiler.ts:3319` →
`operations/mutation-identity.ts:357`), reached from the `UpsertOperation`
**constructor** (`:480`) — before either arm exists, before any row is located.
A child-held relation written beside a key update forces the parent's
post-transition key value to be named at analysis, because the child rows this
payload writes reference it; `divide: 0` has no value at all, so the transition
refuses with its own sentence, `Cannot divide a primary key by zero.`, and
nothing is written even when the row is absent.

**Mirrored, not decided** (`EngineSchema.keyTransitionRefusal`, consulted in
`commands.ts`'s upsert branch at analysis — after the locator's pinned equalities
exist, before any row is located and before either arm can run).
Its conditions are the shipped ones, each measured rather than assumed
(**corrected in place after the round-5 review**: they are FOUR, and two of them
were stated wider than the shipped owner states them — see §R5.2):

| condition | why | cell |
| --- | --- | --- |
| the relation is **child-held** and references the key being rewritten — read off `RecordCommand.transitions`, which the command tree already built (§R5.2), not re-derived | a parent-held relation builds no referenced-key transition | "answers a PARENT-held relation beside the same divide" |
| the reference key has **exactly one member** (`RecordUpdateCompiler.ts:3310`) | a compound reference key has no construction-time `after`, and falls through to the per-member compile-time source | "does not raise the transition sentence for a COMPOUND reference key" + its absent-row twin (§R5.2) |
| the **discriminator** pins the pre-value as a literal (`selector.facts.keys`, the `key: true` prepared columns — never `facts.equals`) | that is what makes the transition nameable at analysis, and it is what the shipped `pinnedTargetValues` reads | "answers the same divide addressed by a NON-key unique"; "pins the pre-value from the DISCRIMINATOR, not from an AND arm" + its absent-row twin (§R5.2) |
| the payload names no `set` | `set` is the value, not an expression | (R-D2 (c) cell, §R4.4) |

The reviewer's two rows, plus the three boundary rows, are now differential
cells in `tests/raptor3/g4/unit02/upsert-key-portability.test.ts` (third
`describe`, 5 cells, each running the identical request on the client's own
shipped engine and on the candidate and comparing the answer **and** the rows
the provider holds afterwards):

| request (`upsert`, `intOwner`) | both engines now |
| --- | --- |
| row **present**, `update:{ id:{divide:0}, items:{create:[…]} }` | `QueryEngineError: Cannot divide a primary key by zero.` |
| row **absent**, same payload | the same sentence, and **no row written** (rows unchanged at `id 6`) |
| parent-held relation beside the same `divide` | `QueryEngineError: Cannot divide primary key field 'id' by zero.` (the validator's sentence — the third owner never runs) |
| scalar-only `divide: 0` | `QueryError: Query execution failed` — the statement is issued on both |
| the same divide addressed by a **non-key** unique | the validator's sentence on both |

The second row is the one the review called the mirror image of round 3's
blocking finding: the candidate no longer performs a creation the shipped engine
refuses. §R3.1's sentence that a fifth shape "is closed here too" was true for
`multiply` and false for `divide: 0`; it is true for both now.

## R4.4 Obligation 3b — the four notes

1. **R-D2 (c) has a second sentence, and it is now named and pinned.** R-D2 (c)
   pinned the `update`/`updateMany` answer for `set` beside an operator. The
   `upsert`-with-relations request answers a **third** sentence, from the same
   analysis-time owner (`operations/mutation-identity.ts:187`):
   `Cannot determine the updated primary key for model 'owner' because field
   'id' uses an unsupported operation.` — and writes nothing. The candidate lets
   `set` win and performs the write (`ok:{"id":8,"label":"o"}`, key moved). Both
   answers are pinned in `upsert-key-portability.test.ts` ("pins R-D2 (c)'s OWN
   sentence for an upsert with relations") and the row is added to §R2.2's R-D2
   table. Pre-existing: this unit changed neither side.
2. **§R3.8 item 4 is now "measured and divergent"**, corrected in place. The
   relation-bearing gate is raised on an atomic-batch profile exactly as the
   shipped engine raises it; the **scalar-only** half diverges.
3. **The scalar-only batch-publication gap — recorded, not repaired
   (decision R-D3).** Under a `usesBatch` profile an expression update is
   published through the adapter's batch references and read back with an
   integer cast (`shared/operation-context.ts`, `usesBatch` arm), so a non-`int`
   field demanded by a dependent reaches a bare
   `Error: Raptor 3 update expression publication requires an integer field`
   where the shipped engine answers the row. **It is not the family this round
   repaired**: the MySQL regression was a selector *spelling* in
   `shared/query.ts` with no publication involved, and this guard is
   byte-identical at `HEAD`, reached by `increment` (implemented long before
   phase 2) as well as by `multiply`. Widening it needs a typed scratch read per
   domain — with the decimal rounding question `Queries.updateValue` already
   refuses to answer twice — which is a decision for Arnaud, not parity. Both
   engines' answers are pinned on both arms plus the green `int` control in
   `key-arithmetic.test.ts` ("the batch publication's integer-only expression
   gap", 3 cells).
4. **`namesRelation` is now the one spelling.** The three remaining inline
   "names a relation" spellings in `commands.ts` (`rootUpdate`, `rootCreate`,
   the bulk-update `relationBearing`) call `ctx.schema.namesRelation(model, …)`;
   §R3.1's sentence is now true as written. The fourth site the review noted
   (`:1091`) asks the question of a **row**, not a payload, and is deliberately
   left alone.
5. **R-D1's row carries §R3.3's withdrawal**, added in place in §R2.9.

## R4.5 Suites, after the last source edit

Every row below was run after the last production edit, serially, through the
bounded runner; native rows carry their port and container. The harness
reconciliation stream was republishing its fingerprint during this round, so
runs that failed only with "Stale Raptor 3 evidence" were retried, never
relabeled.

| Mode / suite | Result | Receipt |
| --- | --- | --- |
| `g2-mysql-contracts` (65515, `d6da412eec3c`) | **13 passed** | [`closure/g2-mysql-contracts-final.log`](receipts/closure/g2-mysql-contracts-final.log), re-confirmed last of all in [`closure/g2-mysql-contracts-closure.log`](receipts/closure/g2-mysql-contracts-closure.log) |
| `g2-mysql-baseline` (65515) | **13 passed** | [`closure/g2-mysql-baseline-final.log`](receipts/closure/g2-mysql-baseline-final.log) |
| `g2-pg-contracts` (65504, `7dfda37e8eea`) | **18 passed** | [`closure/g2-pg-contracts-final.log`](receipts/closure/g2-pg-contracts-final.log) |
| `g2-pg-baseline` (65504) | **17 passed** | [`closure/g2-pg-baseline-final.log`](receipts/closure/g2-pg-baseline-final.log) |
| `g2-contracts` | **216 passed** | [`closure/g2-contracts-final.log`](receipts/closure/g2-contracts-final.log) |
| `g1-contracts` | **143 passed** | [`closure/g1-contracts-final.log`](receipts/closure/g1-contracts-final.log) |
| `g3-suppression-retry` / `g3-transaction-array` / `g3-bulk-series` | **2 / 4 / 6 passed** | [`…suppression…`](receipts/closure/g3-suppression-retry-final.log), [`…array…`](receipts/closure/g3-transaction-array-final.log), [`…bulk…`](receipts/closure/g3-bulk-series-final.log) |
| `g3-execution-review` | **6 passed** (the registered decimal-key `increment` witness intact) | [`closure/g3-execution-review-final.log`](receipts/closure/g3-execution-review-final.log) |
| `g3-generated-transport-smoke` | **1 passed** | [`closure/g3-generated-transport-smoke-final.log`](receipts/closure/g3-generated-transport-smoke-final.log) |
| `g29-result-progress` | **2 passed** | [`closure/g29-result-progress-final.log`](receipts/closure/g29-result-progress-final.log) |
| `g4-read-contracts` | **62 passed** | [`closure/g4-read-contracts-final.log`](receipts/closure/g4-read-contracts-final.log) |
| `g4-route-cache` | **7 passed** | [`closure/g4-route-cache-final.log`](receipts/closure/g4-route-cache-final.log) |
| `g4-route-admission` / `g4-route-lifecycle` / `g4-route-transactions` | **7 / 8 / 13 passed** (round-5 review finding 5: "3" was a transcription error; the receipt says 8) | [`…admission…`](receipts/closure/g4-route-admission-final.log), [`…lifecycle…`](receipts/closure/g4-route-lifecycle-final.log), [`…transactions…`](receipts/closure/g4-route-transactions-final.log) |
| `g4-lifecycle-admission` / `g4-lifecycle-events` | **4 / 3 passed** | [`…admission…`](receipts/closure/g4-lifecycle-admission-final.log), [`…events…`](receipts/closure/g4-lifecycle-events-final.log) |
| G4-02 author checks, SQLite (19 files) | **98 passed / 7 skipped** | [`closure/author-checks-closure-sqlite.log`](receipts/closure/author-checks-closure-sqlite.log) |
| G4-02 author checks, native MySQL (65515) | **104 passed / 1 skipped** | [`closure/author-checks-closure-mysql.log`](receipts/closure/author-checks-closure-mysql.log) |
| `node scripts/run-typecheck.mjs` (whole estate) | exactly the two permitted `pattern/pack.ts` diagnostics (1443, 2633); 7.11 s, 6,352.7 MiB peak | [`closure/typecheck-closure.log`](receipts/closure/typecheck-closure.log) |

The author estate grew from 94 to **105** cells: +2 `unique-discriminator`,
+5 the third key owner, +3 the batch publication gap, +1 the R-D2 (c) pin.

## R4.6 Files, identities, cost

Six production files changed in this round; the other four this unit owns and
all four adapters are byte-identical to their round-4 identities
([`closure/identities-closure.txt`](receipts/closure/identities-closure.txt)).

| File | Round-4 / transferred identity | Closure identity |
| --- | --- | --- |
| `shared/query.ts` | `5143b7b3…` | `694cdb8a06e8a00d098c8759acb35b6c59b182327df54a07b7f06e3804184c9f` |
| `shared/schema.ts` | `07b3df1a…` | `cfbcffd26ad4c3b5aa6eb2a767ce96366a1bf4970d64338932c3530cc1432469` |
| `commands/commands.ts` | `f4ecd7ad…` | `820f6204765936568bd23d3381006dd24a82b9eced769fc53ae1a8f2e48cffa5` |
| `commands/selection.ts` | `874dc5ec…` (= `HEAD`; untouched by phases 1–2) | `ac5213bfd166d0faa8c33d6953352953129c6f4ee662ffbb6987e4207db9cbcf` |
| `commands/relation-body.ts` | `79066ea8…` (= `HEAD`; untouched by phases 1–2) | `fa7aac3aca1d699912e85e5281fbdbede927760454b8f3dd5a94c07e71c11cc8` |
| `route/client-route.ts` (transferred) | `82ba9c9e…` | `7766098c4b8c73e18cf1e2d735c44e4509a6a9b83351bd856df7d205ab130103` |
| `shared/operation-context.ts`, `commands/index.ts`, `shared/storage.ts`, `commands/execution.ts`, `commands/assignments.ts`, `program/index.ts`, the four adapters | round 4 | **unchanged** |
| `src/query-engine/result/cache-value-codecs.ts` (another stream's) | — | **read, not edited** (`5aef8e7f…`) |

Test files changed: `unique-discriminator.test.ts` (new, `66dcbc3b…`),
`upsert-key-portability.test.ts` (`7d07b287…`), `key-arithmetic.test.ts`
(`c73e1908…`), `route-cache.test.ts` (transferred, `9d4992b8…`).

**Patches** (a third pair, so the reviewed `production-phase2.patch` /
`tests-phase2.patch` stay exactly as verified; both new ones were checked to
reverse-apply and reproduce every base identity above):

- [`production-closure.patch`](production-closure.patch) — six files —
  `1eea9e9fbbcd61f9bddf3197db4c50f429d9d2c68709c0be36f7102a9d912ee1`
- [`tests-closure.patch`](tests-closure.patch) — four files —
  `3a3c082dd5a358466cbecdc6995c0250fb5adc3ba6d4365fcf3a23458cd8d6c4`

**Identity recapture** (`captureRaptor3Identity`, after the last edit):
production `1696696474e97765407dd977be94455b2818680b60dc3b6566f14f69d22a1267`,
harness `c8232495f9c5467992706f55506632e3ce52a10520816e81f2794515c3ced6da`
([`closure/identity-after.json`](receipts/closure/identity-after.json); the
round's opening capture is [`closure/identity-before.json`](receipts/closure/identity-before.json)).
The **harness** half moved for reasons outside this unit — the reconciliation
stream republished during the round — which is also why several runs needed a
"Stale Raptor 3 evidence" retry.

**Cost**, same census function and script as §R3.6:

| | files | bytes | physical | token-lines |
| --- | --- | --- | --- | --- |
| the four phase-2 files, round 4 → **closure** | 4 | 257,754 → **261,301** | 7,307 → **7,382** | 6,699 → **6,729** |
| `shared/schema.ts`, round 4 → **closure** | 1 | 14,409 → **16,837** | 426 → **477** | 365 → **390** |
| `commands/selection.ts` + `commands/relation-body.ts` | 2 | 32,481 → **32,971** | 999 → **1,010** | 990 → **995** |
| `route/client-route.ts` (transferred) | 1 | 9,170 → **14,880** | 234 → **378** | 144 → **247** |
| the four adapters | 4 | 140,389 | 3,423 | 1,635 (unchanged) |

| Increment | bytes | physical | token-lines |
| --- | --- | --- | --- |
| closure over round 4, candidate **core** (12 files) | **+6,465** | **+137** | **+60** |
| closure over round 4, `raptor3` tree (15 files) | **+12,175** | **+281** | **+163** |

Candidate **core** now measures **352,596 bytes / 10,128 physical / 9,337
token-lines**; the whole `src/query-engine/raptor3` tree (15 files) measures
**388,208 / 11,142 / 10,210**. The 60 core token-lines are the closure's three
obligations: ~25 the discriminator rule and its callers, ~25 the third key
owner, ~10 the `Leaf.scalar` publication and the `namesRelation` routing. The
route's +103 token-lines are B-1c's composed codec; the transferred record
estimated "~35 lines" for the composition itself, and the measured figure
includes the two structural functions, the three refusals and the snapshot /
materialize wrappers. The **complete charged perimeter** is still **UNVERIFIED**
for §R.6's unchanged reason.

## R4.7 §7 decision-elimination answers, against the closure diff

1. **What decision disappears?** "Which spelling does this comparison use?" is
   no longer asked per call site or per provider: a discriminator asks the
   constraint, a filter asks the text contract, and the admitted operation is
   the only thing that decides which one a `where` is. And "where does an
   upsert's key refusal come from?" no longer has an unowned third answer — the
   analysis-time transition is named once in `EngineSchema`.
2. **What replaces it?** One prepared fact (`key: true` on the prepared column,
   set only under an admitted unique selector) consumed by the single lowering
   owner; one refusal method consulted once, at analysis, before any row is located.
3. **Consumers?** `lowerOperation` for the first; the upsert branch for the
   second; the cache route for `Leaf.scalar`. No new class, no policy boolean,
   no fallback, no legacy import, no adapter capability.
4. **Falsifier?** §R4.1.7's swap (three live cells + two author cells red), and
   the third owner's five cells, which go red if the refusal is moved to either
   of the two positions §R3.1 modelled.

## R4.8 Blockers and decisions for Arnaud, after the closure

| id | What | State |
| --- | --- | --- |
| **R-B3** | `g2-mysql-contracts` 10/13 on native MySQL | **CLOSED — repaired here** (§R4.1). The attribution stands (not G4-02's authorship in either phase); the fix landed in `shared/query.ts`, which this unit owns. No reassignment needed |
| **R-D1** | the candidate cannot NAME an exact-decimal field's value under `multiply`/`divide` | unchanged; the R-D1 row now carries §R3.3's reachability withdrawal |
| **R-D2** | three key-update divergences — decimal key `increment`, `number` key `increment`, `set` winning over an accompanying operator (now with its second, `upsert`-with-relations sentence) | unchanged; (c) is pinned on both shapes |
| **R-D3** | **new, recorded not decided**: under an atomic-batch profile a non-`int` field whose expression update is demanded reaches `Error: Raptor 3 update expression publication requires an integer field` where the shipped engine answers the row. Pre-existing (byte-identical guard at `HEAD`, reached by `increment` too). Both answers pinned | **needs a decision**: widen the publication to a typed scratch read per domain (and answer the decimal rounding question), or keep the refusal and give it a public identity |
| **R-D4** | **DECIDED by Arnaud, 2026-09-15: "accept the candidate behavior"** — see "Decisions applied". On a collation-equal `connect` / `connectOrCreate`, the child's FK stores the **located row's** key (`wanted`) on the candidate and the **request's literal** (`WANTED`) on the shipped engine — both reference the same parent under a `_ci` collation, but the bytes in the child column differ. It follows from where each engine takes the value (the candidate binds `parent.located.fields`), and it applies to plain `connect`, not only `connectOrCreate`. **Provenance, corrected after the round-7 verification (note 12): the divergence is PRE-EXISTING at the committed `0cc61e61`.** The measurement that matters is the one run in the clean `0cc61e61` worktree `/private/tmp/viborm-g4-perf-baseline`, where the reviewer's own round-5 probe reproduces it byte-for-byte ([`classify-rd4-baseline-0cc61e61.log`](../unit02-closure-review-followup-2-receipts/classify-rd4-baseline-0cc61e61.log), and on a second position in [`classify-root-parent-held-baseline-0cc61e61.log`](../unit02-closure-review-followup-2-receipts/classify-root-parent-held-baseline-0cc61e61.log)). The earlier attribution ("created by this unit's repair") was measured on the INTERMEDIATE phase-2 tree — the round-4 patch base, which already carries this unit's uncommitted `exactTextEq` spelling — where the collation-equal `connect` is refused outright; what this unit changed there is REACHABILITY on that intermediate tree, which round 3 restores to the baseline. The claim that "pre-existing" was "a measured falsehood" is **withdrawn**. The cell is now the positive contract witness for the decision (`unique-discriminator.test.ts`, "R-D4 THE CONTRACT…") | **DECIDED — applied** |
| **R-B4** | `g3-generated-transport-smoke` | CLOSED (§R3.7), still 1 passed |
| (open) | the G2.9 specimen edit settlement | unchanged |
| **request** | **register `g4-unit02-author`**, which `scripts/credential-free-test-manifest.mjs:249-253` says is this stream's request to make: the file walk currently *excludes* `tests/raptor3/g4/unit02/` because it has no registered mode. The suite is at **125 cells** over 20 files (115 passed / 10 skipped credential-free; 124 passed / 1 skipped on native MySQL) and already carries its own `unit02.workspace.ts`. (Superseded twice since this row was written: 119 over 19 files at §D.4, and 125 over 20 after the decisions round 2 adds `nested-key-refusal.test.ts` — 6 credential-free cells — see "Decisions round 2" below. The mode `g4-unit02-author` IS registered since 17:13; what it still lacks is that one file.) (This row said 105 through the closure and round 2; corrected to the live figures after the round-6 review's finding 11 — 105 at round 4, 111 after round 2 (§R5.10), 112 after round 3, which adds the junction delete pin (§R6.3), 119 after the decisions round (§D.4), **125** after decisions round 2.) The exact change, for the owner of that file and of `scripts/run-raptor3.mjs`: add a `g4-unit02-author` mode running `--workspace=tests/raptor3/g4/unit02/unit02.workspace.ts tests/raptor3/g4/unit02/` (credential-free arm) plus the same with `VIBORM_RAPTOR3_PROVIDER=mysql` (native arm, 7 of the cells), and move `tests/raptor3/g4/unit02/` out of the walk exclusion into `extendedLocalExclusions` exactly as `unit01/` is. **Not edited here** — both files belong to other streams | **needs the integrator** |

## R4.9 Unverified after the closure

1. The **complete charged perimeter** — unchanged reason (§R.6); every core,
   adapter, route and tree figure in §R4.6 is reproducible to the byte.
2. `scripts/raptor3-cli.test.mjs` and the three harness self-tests — still run
   by no one: `scripts/*.test.mjs` matches no project in the current
   `vitest.workspace.ts`, which another stream owns. This round changed nothing
   under `scripts/`.
3. The upsert key gate (all three owners) is measured on SQLite and on live
   MySQL. **No PGlite or native-PostgreSQL cell exercises it**; the refusals are
   provider-independent by construction (raised before any statement is built),
   which is an argument, not a measurement.
4. The discriminator rule is measured on SQLite (spelling) and on live MySQL
   (answers, on a `utf8mb4_0900_ai_ci` table). PostgreSQL's `exactTextEq` is a
   plain `=`, so no PostgreSQL cell can distinguish the two spellings — the
   claim "no PostgreSQL behaviour changes" rests on reading that operator plus
   `g2-pg-contracts` 18/18 and `g2-pg-baseline` 17/17, not on a differential
   cell.
5. B-1c's NS-04 parity is asserted through the route-cache pin's own
   store/materialize assertions; no cell compares a cached graph against the
   shipped route's cached graph object-by-object. **Added after the round-5
   review (finding 6):** `leafCodec`'s `compileWidenedSumCodec(declared)` arm —
   the decimal `_sum` branch — is **UNVERIFIED and unreachable in this estate**.
   On SQLite, the only provider the cache cells run on, the candidate's READ
   refuses a decimal `_sum` before any codec runs (`QueryEngineError: Driver
   "sqlite3" returned a malformed decimal scalar for operation "aggregate": the
   sum is not an exact decimal at this column's scale`, `shared/query.ts:3610-3627`)
   where the shipped engine answers `Decimal:123456.001`. The divergence is
   pre-existing — nothing in either closure diff touches that decode, and the
   reviewer's probe reproduces byte-identically here before and after round 2
   ([`closure2/probe-route-cache-codec.log`](receipts/closure2/probe-route-cache-codec.log),
   9 passed / 2 failed, the same two cells as the reviewer's own run) — but its
   consequence is that the widened-sum arm of the new codec is executed by no
   cell anywhere.
6. `core-structure` (§R3.8 item 5) was not re-measured this round.
7. **R-D4's history — settled, and corrected twice.** The round-5 review
   reverse-applied `production-closure.patch` and measured the pre-closure
   answer on THAT tree (the round-4 patch base, which still carries this unit's
   uncommitted phase-1/phase-2 work): the candidate **refused** the
   collation-equal `connect` outright. That is a fact about the intermediate
   tree, not about `HEAD`. The round-7 verification (note 12) ran the same probe
   in the clean `0cc61e61` worktree and reproduced the FK-byte divergence
   byte-for-byte, so R-D4 is **pre-existing at the committed tree**; this unit
   restores its baseline reachability rather than creating it. §R4.8 and §R5.6
   are re-worded accordingly, and the decision itself is taken (2026-09-15).

# Closure repair round 2 (after the independent closure review returned REVISE)

Review: [`unit02-closure-review.md`](../unit02-closure-review.md) (round 5,
independent). Its two must-fix findings say the same thing twice: **each of the
round's two new owners is wider than the shipped owner it claims to mirror**,
and each widening changes a public answer. Nothing else in the round moved —
the review reproduced every registered suite, identity, patch hash and cost
figure byte-for-byte.

Base of this round: the reviewed closure tree
([`closure2/identities-round2-base.txt`](receipts/closure2/identities-round2-base.txt),
`query.ts 694cdb8a…`, `schema.ts cfbcffd2…`, `commands.ts 820f6204…`,
`selection.ts ac5213bf…`, `relation-body.ts fa7aac3a…`, `client-route.ts
7766098c…`). Environment: node `v24.21.0`, vitest `3.1.4`, better-sqlite3
`12.6.0`; native MySQL `viborm-raptor3-g3-mysql-20260914` (`d6da412eec3c`,
`127.0.0.1:65515`) and native PostgreSQL `viborm-raptor3-g3-pg-20260914`
(`7dfda37e8eea`, `127.0.0.1:65504`), both up 16 h, restarts 0.

## R5.0 Finding → status

| # | Finding | Status |
| --- | --- | --- |
| 1 | [must-fix] the discriminator repair widened to the nested `disconnect` / `delete` / `update` target lookups | **REPAIRED** — narrowed to the `buildWhereUnique` call sites; the reviewer's three diverging cells now agree to the byte (§R5.1) |
| 2 | [must-fix] `keyTransitionRefusal` pins from equalities the shipped owner never reads | **REPAIRED** — the pins are the discriminator's own (`facts.keys`), never `facts.equals` (§R5.2) |
| 3 | [must-fix] the refusal fires for a COMPOUND reference key | **REPAIRED** — the shipped single-member arity is mirrored (§R5.2) |
| 4 | [note] §R4.1.5 misidentifies the nested call sites | **CORRECTED in place**, per verb, at §R4.1.5 (§R5.3) |
| 5 | [note] `g4-route-lifecycle` reported as 3, measured 8 | **CORRECTED in place** at §R4.2 and §R4.5; the registered +1 is attributed (§R5.4) |
| 6 | [note] B-1c's widened-sum branch is unreachable | **RECORDED as unverified** beside §R4.9 item 5 (§R5.5) |
| 7 | [note] R-D4 is created by this round, not inherited | **RE-ATTRIBUTED** in §R4.8, §R4.9 item 7 withdrawn, both engines' FK values pinned in an author cell (§R5.6) |
| 8 | [note] the refusal re-derives a fact the command tree owns | **REPAIRED with finding 2** — the second `relationNames`-over-`data` walk is deleted; `namesRelation` stays the one spelling (§R5.2) |

## R5.1 Finding 1 — the rule's SCOPE, narrowed to the shipped classification

**What the round got wrong.** §R4.1.3 took the shipped split from
`buildWhereUnique` → `buildUniqueEquality` and treated it as *the* spelling of a
unique selector. It is one of **two**. The other is
`uniqueSelectorConjuncts` (`write-engine/shared.ts:671`), which recombines the
target selector as `{ field: { equals: value } }` and hands the whole thing to
`buildWhere` — i.e. the folded `exactTextEq` pair on MySQL. Which one a call
site gets is the shipped engine's own classification:

| shipped owner | call sites | spelling |
| --- | --- | --- |
| `buildWhereUnique` | `findUnique`, root `update` / `delete`, the `upsert` locator, the `connect` / `connectOrCreate` probe, the `set` target, the nested `upsert` probe (`RelationUpsertPart.ts:265` builds it with `buildFindUnique`) | the constraint's plain equality |
| `uniqueSelectorConjuncts` | the nested `disconnect` / `delete` / `update` targets — **both** their planning probe and their batch guard (`RelationWritePart.ts:987` `optionalWhereFilters`, `UpdateOperation.ts:469`, `RecordUpdateCompiler.ts:3722`) | a filter, so the engine's case-sensitivity contract |

**This table is incomplete, and §R6.1 completes it.** Its second row is a
**reference-held** family only: a junction target of the same three verbs is
compiled by `RelationJunctionPart`, which never reaches
`uniqueSelectorConjuncts`. Round 2 therefore narrowed three call sites per
VERB where the shipped engine classifies per verb AND per edge kind, and
turned a junction `disconnect` / `update` into a refusal the shipped engine
performs (round-6 review, finding 9). Read §R6.1 for the rule as it now
stands; the paragraphs below record what round 2 did.

**The repair — three bytes of scope, in the two places the scope is stated.**

- `relation-body.ts:214` (the `case "disconnect": case "delete":` target lookup)
  no longer says `unique: true`; the comment beside it names the shipped owner
  it mirrors.
- `relation-body.ts:357-361` — the selector shared by `connect`,
  `connectOrCreate`, `upsert` **and nested `update`** — prepares with
  `verb !== "update"` instead of `true`. The verb, not the object's shape, is
  what separates a probe from a filter.
- `SelectionSource.unique`'s own documentation (`selection.ts:21-31`) now states
  the rule as the shipped classification rather than as "admitted unique".

Nothing else changed: the root verbs, the `set` target (`:591`) and the
`connect` / `connectOrCreate` / `upsert` probe keep the constraint's equality,
because that is what the shipped engine compiles for them.

**Measured, differentially, on the live container.** The reviewer's own probe
(`tests/raptor3/g4/review/unit02-closure/mysql-discriminator-scope.review.test.ts`,
11 cells, each re-seeded and run on both engines, comparing the answer **and**
the rows afterwards) reported **four** divergences before and reports **one**
after — and the one is R-D4's FK bytes (§R5.6), not a selector spelling:

| cell | before (round 5) | after (round 2) |
| --- | --- | --- |
| nested `disconnect` on a collation-equal key | candidate `ok`, `notes.ownerId` set to `NULL`; shipped `NestedWriteError` | both `NestedWriteError: Cannot disconnect relation 'notes': target record was not found for this parent.`, row untouched |
| nested `delete` | candidate `ok`, **child row deleted** | both `NestedWriteError: Cannot delete relation 'notes'…`, row untouched |
| nested `update` | candidate `ok`, child row updated | both `NestedWriteError: Cannot update relation 'notes'…`, row untouched |
| nested `connect` | FK bytes differ | **unchanged — R-D4**, §R5.6 |
| the other 7 (root `delete`, root `upsert`, nested `set`, nested `upsert`, compound selector, extended filter half, `deleteMany`) | agree | agree |

Receipt: [`closure2/probe-mysql-discriminator-scope.log`](receipts/closure2/probe-mysql-discriminator-scope.log).

**The unit's own cell.** `unique-discriminator.test.ts` gains a native
`describe` ("G4-02 native MySQL discriminator scope") whose first cell runs ten
per-call-site differential rows on a `utf8mb4_0900_ai_ci` table it asserts
first: five that must address through the constraint (root `delete`, root
`upsert`, nested `set`, nested `upsert`, a compound selector) and five that must
stay filters (nested `disconnect`, nested `delete`, nested `update`, the
extended `where`'s filter half, `deleteMany`). Each compares the answer and the
rows the provider holds afterwards.

**Falsifier.** `relation-body.ts` swapped back to the round-5 identity
(scratchpad copy, never `git checkout`), identities recorded in and out of the
swap and restored and re-hashed in the same receipt
([`closure2/falsify-scope-narrowing.log`](receipts/closure2/falsify-scope-narrowing.log)):
the scope cell goes red at "nested disconnect stays a filter" — 1 failed / 3
passed — and the other three cells of the file stay green, which is the
statement that the narrowing is the only thing this hunk decides.

## R5.2 Findings 2, 3 and 8 — ONE authority for the key transition

**What the round got wrong.** The mirror restated two facts the tree already
owns, and both restatements drifted wider than the shipped owner:

1. it pinned the key's pre-value from `selector.facts.equals`, which
   `prepareScalarPredicate` fills for **every** equality the selector walks —
   an extended `where`'s filter half and the arms of `AND`/`OR`/`NOT` included —
   where the shipped `pinnedTargetValues` → `getWhereUniqueEntries` →
   `partitionWhereUnique` reads the **discriminator** alone;
2. it accepted any child-held edge with `edge.pairs.some(...)`, where
   `RecordUpdateCompiler.ts:3310` requires `referencedFields.length === 1` and
   says so in its own comment ("a compound one falls through to the per-member
   compile-time source rather than borrowing member zero's answer").

Both widenings refuse a creation the shipped engine performs — the mirror image
of round 3's blocking finding, from the other side.

**The repair — read the facts, do not restate them.**

- **The relation fact is the command tree's.** `RelationBody.relation`
  (`relation-body.ts:194-201`) already records, for exactly this shape, that a
  child-held reference edge references a field the payload writes:
  `parent.transitions.push(edge)`. `keyTransitionRefusal` now takes that list
  (`commands.ts:1200-1205` passes `found.command.transitions`) and the second
  `relationNames`-over-`data` walk in `schema.ts` is **deleted** — which is what
  makes §R4.4 item 4's "`namesRelation` is the one spelling" true as written
  (finding 8).
- **The pin is the discriminator's.** `SelectorFacts` gains `keys`
  (`query.ts:221`), written only where `prepareScalarPredicate` marks a column
  `key: true` (`:1126`) — that is, only for the top-level addressable-key
  entries of a selector the caller admitted as unique. `prepareWhere` does not
  pass `unique` into an `AND`/`OR`/`NOT` arm (`:1060`, against `:1087` for a
  top-level entry), so an arm can never pin, by construction rather than by a
  check. The upsert branch passes
  `lookup.selector.facts.keys`; `facts.equals` is untouched and keeps its own
  consumers (identity and membership, `commands.ts:560`, `:620`).
- **The arity is the shipped one.** `edge.pairs.length === 1 &&
  edge.pairs[0]!.source === keyField` (`schema.ts:292-296`).
- The refusal moved four statements later in the same function — it is
  consulted once the update arm is **constructed** (so the transitions exist)
  and still before any row is located, before either arm can run, and before
  anything is written. `plan()` builds; `run()` executes.

**Measured.** The reviewer's own probe
(`upsert-transition-scope.review.test.ts`, 9 differential SQLite cells) was
**4 failed / 5 passed** and is now **9 passed**
([`closure2/probe-upsert-transition-scope.log`](receipts/closure2/probe-upsert-transition-scope.log)):

| cell | shipped | candidate before | candidate after |
| --- | --- | --- | --- |
| `where:{code:"c6",AND:[{id:6}]}`, `update:{id:{divide:0}, items:{create}}`, row present | `Cannot divide primary key field 'id' by zero.` | `Cannot divide a primary key by zero.` | the validator's sentence |
| the same, row **absent** | `ok:{"id":99,…}` — the row is created | the transition refusal, nothing written | the row is created |
| compound reference key, row present | `Cannot divide primary key field 'a' by zero.` | `Cannot divide a primary key by zero.` | the validator's sentence |
| compound reference key, row **absent** | `ok:{"a":7,"b":8,…}` | the refusal, nothing written | the row is created |
| the five the round genuinely fixed (root `update` present/absent, bigint `0n`, a `connect` payload, a relation that does not reference the rewritten key) | — | green | green |

The four rows are now the unit's own cells too
(`upsert-key-portability.test.ts`, third `describe`, which grows 5 → 9 cells and
gains a compound-key model pair), so the estate refuses the widening on its own.

**Falsifier.** `query.ts` + `schema.ts` + `commands.ts` swapped back to their
round-5 identities (scratchpad copies), identities in and out of the swap,
restored and re-hashed
([`closure2/falsify-transition-owner.log`](receipts/closure2/falsify-transition-owner.log)):
**exactly** the four new cells go red (4 failed / 13 passed) and the thirteen
older ones stay green.

## R5.3 Finding 4 — the call-site list, per verb

§R4.1.5's list named `:214` as "the `connectOrCreate` probe" and `:346` as "a
conditional's own selector". `:214` is the `disconnect` / `delete` target lookup
and `:346` was the selector shared by four verbs — which is why the widened
sites went unmeasured. The paragraph is **corrected in place** at §R4.1.5, per
verb, against the post-§R5.1 source, and says what it got wrong.

## R5.4 Finding 5 — `g4-route-lifecycle` is 8, and the +1 is the route follow-up's

Measured here, twice: **8 passed**
([`closure2/g4-route-lifecycle.log`](receipts/closure2/g4-route-lifecycle.log)),
as the cited round-5 receipt already said. §R4.2's sentence and §R4.5's table
are corrected in place. The registered count moved **7 → 8** during the round
and the +1 is **not this unit's**: the G4-03/03b route follow-up (repair 3)
added the D-6 divergence pin to `tests/raptor3/g4/route-lifecycle.test.ts`
(`g4/unit03/note.md`: "`route-lifecycle.test.ts` | 7 | **8** | **repair 3** adds
the D-6 divergence pin"; `g4/unit03b-review-followup.md:165`:
"`route-transactions` 11 → 13, `route-lifecycle` 7 → 8, `route-cache` 6 → 7"),
and `scripts/raptor3-manifest.mjs:509-511` registers 8 under the comment "Owned
by the G4-03 author". No file of this unit's is in that mode, and this unit's
**own** registered counts are unchanged.

## R5.5 Finding 6 — B-1c's widened-sum branch is unverified

Recorded beside §R4.9 item 5, not repaired: on SQLite — the only provider the
cache cells run on — the candidate's **read** refuses a decimal `_sum` before
any codec runs, so `leafCodec`'s `compileWidenedSumCodec(declared)` arm is
executed by no cell in the estate. The divergence is pre-existing and this round
changed nothing near it: the reviewer's probe reproduces **byte-identically**
here, 9 passed / 2 failed, the same two cells
([`closure2/probe-route-cache-codec.log`](receipts/closure2/probe-route-cache-codec.log)
versus the review's own
[`probe-route-cache-codec.log`](../unit02-closure-review-receipts/probe-route-cache-codec.log)).
The other nine cells — the 23-scalar codec world, lists, JSON, a relation
include, a NULL to-one, a relation `_count`, an integer-only aggregate, a
located `null`, fresh-graph identity on every hit — pass on both runs.

## R5.6 Finding 7 — R-D4, and which tree each measurement ran on

**Corrected after the round-7 verification (note 12); the error was the
reviewer's, adopted here.** Two measurements exist and they answer two
different questions:

- reverse-applying `production-closure.patch` lands on the **round-4 patch
  base** — a tree that still carries this unit's uncommitted phase-1/phase-2
  work, including the new `exactTextEq` spelling. On that INTERMEDIATE tree the
  candidate refuses the collation-equal `connect` outright, which is what the
  round-5 review measured;
- the tree that answers "did G4-02 create this?" is the **committed
  `0cc61e61`**, because the whole unit is uncommitted. Run there, in the clean
  worktree `/private/tmp/viborm-g4-perf-baseline`, the reviewer's own round-5
  probe reproduces the FK-byte divergence byte-for-byte
  ([`classify-rd4-baseline-0cc61e61.log`](../unit02-closure-review-followup-2-receipts/classify-rd4-baseline-0cc61e61.log)),
  and so does a second position, the parent-held `connect`
  ([`classify-root-parent-held-baseline-0cc61e61.log`](../unit02-closure-review-followup-2-receipts/classify-root-parent-held-baseline-0cc61e61.log)).

So R-D4 is **pre-existing at `0cc61e61`**. What this unit's repairs changed is
REACHABILITY on the intermediate tree: round 2 refused the collation-equal
`connect`, and round 3 restores the baseline behaviour. "Now a measured
falsehood" is withdrawn.

It was **recorded, not repaired**, until Arnaud decided it on 2026-09-15
("accept the candidate behavior"); the cell is now a positive contract witness
(see "Decisions applied"). The two engines' answers, as measured:

| | answer | `notes` afterwards |
| --- | --- | --- |
| shipped | `ok:{"id":"n2","title":"T","ownerId":"WANTED"}` | `n1 → wanted`, `n2 → **WANTED**` (the request's literal) |
| candidate | `ok:{"id":"n2","title":"T","ownerId":"wanted"}` | `n1 → wanted`, `n2 → **wanted**` (the located row's key) |

Both rows reference the same parent under a `_ci` collation. The cell pins the
divergence rather than asserting parity, deliberately: it will go red the moment
either engine moves, which is what a recorded decision needs.

## R5.7 Suites, after the last source edit

Every row was run after the last production edit, serially, through the bounded
runner; native rows carry their port and container.

| Mode / suite | Result | Receipt |
| --- | --- | --- |
| `g2-mysql-contracts` (65515, `d6da412eec3c`) | **13 passed** | [`closure2/g2-mysql-contracts.log`](receipts/closure2/g2-mysql-contracts.log), re-confirmed last of all in [`closure2/g2-mysql-contracts-closing.log`](receipts/closure2/g2-mysql-contracts-closing.log) |
| `g2-mysql-baseline` (65515) | **13 passed** | [`closure2/g2-mysql-baseline.log`](receipts/closure2/g2-mysql-baseline.log) |
| `g2-pg-contracts` (65504, `7dfda37e8eea`) | **18 passed** | [`closure2/g2-pg-contracts.log`](receipts/closure2/g2-pg-contracts.log) |
| `g3-execution-review` | **6 passed** | [`closure2/g3-execution-review.log`](receipts/closure2/g3-execution-review.log) |
| `g4-read-contracts` | **62 passed** | [`closure2/g4-read-contracts.log`](receipts/closure2/g4-read-contracts.log) |
| `g4-route-cache` / `g4-route-admission` / `g4-route-lifecycle` / `g4-route-transactions` | **7 / 7 / 8 / 13 passed** | [`…cache…`](receipts/closure2/g4-route-cache.log), [`…admission…`](receipts/closure2/g4-route-admission.log), [`…lifecycle…`](receipts/closure2/g4-route-lifecycle.log), [`…transactions…`](receipts/closure2/g4-route-transactions.log) |
| reviewer probe — the discriminator's other call sites (65515) | **1 divergence: R-D4 only** (was 4) | [`closure2/probe-mysql-discriminator-scope.log`](receipts/closure2/probe-mysql-discriminator-scope.log) |
| reviewer probe — the third key owner's conditions | **9 passed** (was 4 failed / 5 passed) | [`closure2/probe-upsert-transition-scope.log`](receipts/closure2/probe-upsert-transition-scope.log) |
| reviewer probe — the composed cache codec | **9 passed / 2 failed**, byte-identical to the review's own run (§R5.5) | [`closure2/probe-route-cache-codec.log`](receipts/closure2/probe-route-cache-codec.log) |
| G4-02 author estate, SQLite (19 files) | **102 passed / 9 skipped (111)** | [`closure2/author-estate-sqlite.log`](receipts/closure2/author-estate-sqlite.log) |
| G4-02 author estate, native MySQL (65515) | **110 passed / 1 skipped (111)** | [`closure2/author-estate-mysql.log`](receipts/closure2/author-estate-mysql.log) |
| frozen fast-path pins (inside the estate runs) | `physical-envelope` **10**, `packaged-array` **5**, `prepared-operation` **5** — unchanged | same two receipts |
| `node scripts/run-typecheck.mjs` (whole estate) | exactly the two permitted `pattern/pack.ts` diagnostics (1443, 2633); 14.42 s, 5,340.5 MiB peak | [`closure2/typecheck.log`](receipts/closure2/typecheck.log) |
| falsifier — the scope narrowing | 1 failed / 3 passed, restored and re-hashed | [`closure2/falsify-scope-narrowing.log`](receipts/closure2/falsify-scope-narrowing.log) |
| falsifier — the transition owner | 4 failed / 13 passed, restored and re-hashed | [`closure2/falsify-transition-owner.log`](receipts/closure2/falsify-transition-owner.log) |

Both falsifier swaps ran between the suite rows and restored **byte-identical**
files (each receipt records the identity before, in and after the swap), and
`g2-mysql-contracts` was re-run last of all, after every swap, to close the
round on the same bytes the identities name.

The author estate grew from 105 to **111** cells: +2 the native discriminator
scope and the R-D4 pin, +4 the transition owner's two conditions. **Registered
count changes, for the integrator: none** — no file of this unit's is in a
registered mode (§R4.8's standing request), and `g4-route-lifecycle`'s 8 is the
route follow-up's, not a change (§R5.4).

## R5.8 Files, identities, cost

Five production files changed in round 2. `route/client-route.ts` and the other
four this unit owns, all four adapters and
`src/query-engine/result/cache-value-codecs.ts` are **byte-identical** to their
round-5 identities
([`closure2/identities-round2.txt`](receipts/closure2/identities-round2.txt)).

| File | Round-5 (reviewed) identity | Round-2 identity |
| --- | --- | --- |
| `shared/query.ts` | `694cdb8a…` | `7ffbea606cbd6e62636f9dcc89b93991a50fb9f7d48c02f84a416dfcc99f96aa` |
| `shared/schema.ts` | `cfbcffd2…` | `48fc18c13d558c6fad237d7ffab7588437c72ed354d43799a506f52dedc465c9` |
| `commands/commands.ts` | `820f6204…` | `7843d0dc4deb5eddbf0b8fbfa7d4112a6e34c893e69de36451c72e234f1394a1` |
| `commands/selection.ts` | `ac5213bf…` | `31528299cbf52124def84145d0eb51eba417c80eddb4e3942a5513a4b6f0a7cd` |
| `commands/relation-body.ts` | `fa7aac3a…` | `bbccc1313821e2d75f753ac85b98d7e380a02980d6eac1985b716977463688f5` |
| `route/client-route.ts`, `shared/operation-context.ts`, `shared/storage.ts`, `commands/execution.ts`, `commands/assignments.ts`, `commands/index.ts`, `program/index.ts`, the four adapters | round 5 | **unchanged** |

Test files changed: `unique-discriminator.test.ts` (`d6eebde7…`),
`upsert-key-portability.test.ts` (`97d5c91d…`). `key-arithmetic.test.ts`
(`c73e1908…`) and `route-cache.test.ts` (`9d4992b8…`) are unchanged.

**Patches — regenerated in place**, so the closure pair still names the round-4
base and now carries round 2 as well:

- [`production-closure.patch`](production-closure.patch) — six files —
  `5e0b62d4728bca44595799a2bb6183549e25af07c29177940ad6e45a345f0cdb`
- [`tests-closure.patch`](tests-closure.patch) — four files —
  `38920ca800c4d3fc6e236b550cde97c58cfd32545b4a7dd7ab01ba1cac2e9f87`

Both were verified in a scratchpad copy of the reconstructed round-4 base:
forward-applying reproduces every current identity above exactly, and
reverse-applying reproduces the round-4 base identities the review names
(`5143b7b3…`, `07b3df1a…`, `f4ecd7ad…`, `874dc5ec…`, `79066ea8…`, `82ba9c9e…`)
with `unique-discriminator.test.ts` absent, as at round 4.

**Identity recapture** (`captureRaptor3Identity`, after the last edit):
production `e0b8b0fe5e163753d15ae2b9353e7535b436c18bca7f214bc39e1b6c680324a5`,
harness `6e399b9cdebe3d96629ffcee2428168b36586013f0f902d79ec4050216dea60f`
([`closure2/identity-after.json`](receipts/closure2/identity-after.json)). The
harness half also carries the reviewer's own probe directory
(`tests/raptor3/g4/review/unit02-closure/`), which is in the tree and is not
this unit's.

**Cost**, same census function and script as §R4.6
(`censusFunctionSha256 15889231a22297fcf001ae22ca01e6e8c9cd7489dd635c60529dfdc0ac06461e`):

| | files | bytes | physical | token-lines |
| --- | --- | --- | --- | --- |
| the four phase-2 files, closure → **round 2** | 4 | 261,301 → **262,286** | 7,382 → **7,402** | 6,729 → **6,738** |
| `shared/schema.ts`, closure → **round 2** | 1 | 16,837 → **17,464** | 477 → **485** | 390 → **387** |
| `commands/selection.ts` + `commands/relation-body.ts` | 2 | 32,971 → **34,114** | 1,010 → **1,025** | 995 → **994** |
| `route/client-route.ts` | 1 | 14,880 | 378 | 247 (unchanged) |
| the four adapters | 4 | 140,389 | 3,423 | 1,635 (unchanged) |

| Increment | bytes | physical | token-lines |
| --- | --- | --- | --- |
| round 2 over the closure, candidate **core** (12 files) | **+2,755** | **+43** | **+5** |
| round 2 over the closure, `raptor3` tree (15 files) | **+2,755** | **+43** | **+5** |

Candidate **core** now measures **355,351 bytes / 10,171 physical / 9,342
token-lines**; the whole `src/query-engine/raptor3` tree (15 files) measures
**390,963 / 11,185 / 10,215**. The five core token-lines are the whole round:
the `facts.keys` field and its two writes, the arity clause, and the narrowed
argument — and `shared/schema.ts`'s own token-lines went **down by 3**, because
deleting the second `relationNames` walk pays for both new conditions. The
remaining bytes are documentation: the two comments that name which shipped
owner each call site mirrors. The **complete charged perimeter** is still
**UNVERIFIED** for §R.6's unchanged reason.

## R5.9 §7 decision-elimination answers, against the round-2 diff

1. **What decision disappears?** "Is this `where` a discriminator?" is no longer
   answered per call site by whoever wrote the call site: it is answered by the
   shipped classification the call site mirrors, stated once per site and
   documented on the field that carries it. And "where does the key transition's
   pre-value come from, and which relation makes it nameable?" is no longer
   asked twice — the prepared selector publishes the discriminator's pins, and
   the command tree publishes the transition edges. Nothing re-walks the payload
   to re-answer either.
2. **What replaces it?** Two published facts and no new derivation:
   `SelectorFacts.keys` (written exactly where `key: true` is written) and
   `RecordCommand.transitions` (written exactly where the relation body decides
   the edge is a key transition).
3. **Consumers?** `lowerOperation` for the prepared column's `key`; the upsert
   branch for the refusal. No new class, no policy boolean, no fallback, no
   legacy import, no adapter change, no per-verb branch beyond the verb the
   shipped engine itself branches on.
4. **Falsifier?** §R5.1's and §R5.2's two swaps, which turn exactly the six new
   cells red and nothing else.

## R5.10 Blockers and decisions for Arnaud, after round 2

| id | What | State |
| --- | --- | --- |
| **R-B3** | `g2-mysql-contracts` 10/13 on native MySQL | **CLOSED — repaired** (§R4.1), still 13/13 with the scope narrowed |
| **R-D1**, **R-D2**, **R-D3** | unchanged from §R4.8 | unchanged |
| **R-D4** | **pre-existing at `0cc61e61`** (§R5.6, re-worded after the round-7 verification's note 12; the earlier "attributed to this unit's repair" was measured on the intermediate phase-2 tree): on a collation-equal `connect` / `connectOrCreate` the candidate stores the located row's key and the shipped engine the request's literal | **DECIDED 2026-09-15** — "accept the candidate behavior"; applied as a positive contract witness |
| **request** | **register `g4-unit02-author`** — unchanged from §R4.8, and the estate was **111 cells** over 19 files after round 2 (102 passed / 9 skipped credential-free; 110 passed / 1 skipped on native MySQL); round 3 makes it **112** (§R6.7). The exact change is in §R4.8 | **needs the integrator** |

## R5.11 Unverified after round 2

1. The **complete charged perimeter** — unchanged reason (§R.6); every figure in
   §R5.8 is reproducible to the byte.
2. `scripts/raptor3-cli.test.mjs` and the three harness self-tests — still run
   by no one; this round changed nothing under `scripts/`.
3. The upsert key gate (all three owners) is measured on SQLite and on live
   MySQL; **no PGlite or native-PostgreSQL cell exercises it**. The refusals are
   provider-independent by construction, which is an argument, not a
   measurement.
4. "No PostgreSQL behaviour changes" still rests on `exactTextEq` being a plain
   `=` there plus `g2-pg-contracts` 18/18, not on a differential PostgreSQL
   cell. Round 2 narrows the rule, so it can only reduce what a PostgreSQL cell
   could have seen.
5. B-1c's NS-04 parity, and the **widened-sum codec branch**, which no cell in
   the estate executes (§R5.5).
6. `core-structure` (§R3.8 item 5) was not re-measured in this round either.
7. The nested `upsert` probe's key spelling is mirrored from
   `RelationUpsertPart.ts:265`'s `buildFindUnique` and measured on MySQL only; the
   corresponding **guard** statement's own spelling (`foundGuardStatement`,
   which uses the conjuncts) is not compared statement-for-statement by any
   cell — only the observable answer and the rows are.

# Closure repair round 3 (after the independent closure-repair round-2 review returned REVISE)

Review: [`unit02-closure-review-followup.md`](../unit02-closure-review-followup.md)
(round 6, independent, same reviewer). It confirms round 2 repaired all three
must-fix findings **for the family they were measured on** and reproduces every
suite, identity, patch hash and cost figure to the byte. It returns REVISE for
one thing: the narrowing round 2 landed is stated **per verb**, and the shipped
classification is **per verb AND per edge kind**. Two notes accompany it.

Base of this round: the reviewed round-2 tree
([`closure3/identities-round3-base.txt`](receipts/closure3/identities-round3-base.txt)
— `query.ts 7ffbea60…`, `schema.ts 48fc18c1…`, `commands.ts 7843d0dc…`,
`selection.ts 31528299…`, `relation-body.ts bbccc131…`, `client-route.ts
7766098c…`, `unique-discriminator.test.ts d6eebde7…`,
`upsert-key-portability.test.ts 97d5c91d…`), byte-identical to the identities
§R5.8 names and to the tree the round-6 review verified. Environment: node
`v24.21.0`, vitest `3.1.4`, better-sqlite3 `12.6.0`; native MySQL
`viborm-raptor3-g3-mysql-20260914` (`d6da412eec3c`, `127.0.0.1:65515`) and
native PostgreSQL `viborm-raptor3-g3-pg-20260914` (`7dfda37e8eea`,
`127.0.0.1:65504`), both up 17 h, restarts 0.

## R6.0 Finding → status

| # | Finding | Status |
| --- | --- | --- |
| 9 | [must-fix] the narrowing is per VERB; the shipped classification is per verb AND per EDGE KIND, so a junction `disconnect` / `update` refuses what the shipped engine performs | **REPAIRED** — one predicate, one owner; the reviewer's probe goes 4 divergences → 2, and the 2 are finding 10's, on both selectors (§R6.1–§R6.4) |
| 10 | [note] a junction `delete` by exact bytes is a `ForeignKeyError` on the candidate | **CLASSIFIED, not repaired** — **pre-existing at `0cc61e61`**, measured in the clean worktree with the same minimized request and the same container; no G4 unit introduced it (§R6.5) |
| 11 | [note] §R4.8's request row still says 105 cells | **CORRECTED in place** at §R4.8 and §R5.10, to the live figures and with the history (§R6.7) |

## R6.1 Finding 9 — the rule is stated where the shipped engine states it: per EDGE KIND, in one owner

**What round 2 got wrong.** §R5.1's table names one shipped filter owner,
`uniqueSelectorConjuncts`, and reaches it from `RelationWritePart.ts:987`,
`UpdateOperation.ts:469` and `RecordUpdateCompiler.ts:3722`. Those are the
**reference-held** relation parts. `nested-target-parts.ts:226` sends
`relation.position === "junction"` to `buildJunctionParts`
(`RelationJunctionPart`) instead, and that owner never calls
`uniqueSelectorConjuncts` at all (`grep -rn uniqueSelectorConjuncts
src/query-engine/` lists nine call sites; none is in
`RelationJunctionPart.ts`). It spells the target selector as a **discriminator
in both phases**:

```
RelationJunctionPart.ts:1498-1509  connected ? membershipRead({ whereUnique: where, … })
                                             : buildFindUnique(this.childScope, { where, … })
RelationJunctionPart.ts:1629       statement: buildFindUnique(this.childScope, { where: item.where, … })
RelationJunctionPart.ts:1663       statement: buildFindUnique(this.childScope, { where: item.where, … })
RelationJunctionPart.ts:1698/2146/2259   membershipRead({ whereUnique: … })
JunctionStatements.ts:322-323      if (isRecord(args.whereUnique))
                                     predicates.push(buildWhereUnique(child, args.whereUnique, table));
```

`membershipRead` takes `whereUnique` and `where` as two separate arguments of
one statement (`JunctionStatements.ts:304-330`): the shipped engine keys the
spelling on **which half of the selector it is**, never on the verb. Round 2's
`verb !== "update"` and its bare `case "disconnect": case "delete":` lookup
applied the reference family's answer to both edge kinds, so on a
`utf8mb4_0900_ai_ci` collation the candidate refused a junction `disconnect` and
a junction `update` the shipped engine performs.

**The repair — one predicate, one owner, no verb table.**
`commands/selection.ts` gains `nestedTargetAddressesConstraint(edge, verb)`,
which is the whole rule and carries the shipped citations on itself:

```ts
export function nestedTargetAddressesConstraint(
  edge: Membership,
  verb: string
): boolean {
  return (
    edge.kind === "junction" ||
    (verb !== "disconnect" && verb !== "delete" && verb !== "update")
  );
}
```

`SelectionSource.unique` widens from `true` to `boolean` and its doc stops
restating the classification: it points at the predicate and says a bulk
member's `where` never asks. The three nested target sites in `relation-body.ts`
— the `disconnect` / `delete` lookup, the `connect` / `connectOrCreate` /
`upsert` / `update` selector, and `setTargets` — each consult it and nothing
else; the two prose comments that used to state the rule twice are gone. The
root verbs keep stating `unique: true` themselves, as they always did: their
selector is the root `where`, not a nested target.

**What it does not change.** No statement was added, removed or re-ordered: the
frozen fast-path pins stand at `physical-envelope` **10**, `packaged-array`
**5**, `prepared-operation` **5**. `updateMany` / `deleteMany` members never
reach the predicate, so a bulk member's `where` is still a filter by contract.
PostgreSQL cannot distinguish the two spellings (`exactTextEq` is a plain `=`
there), and `g2-pg-contracts` is 18/18.

## R6.2 The invariant, and the falsifier

**Invariant.** A nested write's unique target selector is a discriminator unless
the shipped engine recombines it through `uniqueSelectorConjuncts`, which it
does for exactly one family: a **reference-held** target of `disconnect` /
`delete` / `update`. One fact, one owner
(`nestedTargetAddressesConstraint`), three consumers (the three nested target
sites), zero restatements.

**Falsifier.** `selection.ts` + `relation-body.ts` swapped back to their round-2
identities from scratchpad copies (never `git checkout`), the reconstructions
first verified to hash **exactly** to `31528299…` and `bbccc131…` — the
identities §R5.8 records — which is also the proof that this round's diff is the
three scope hunks and the rule's documentation and nothing else. Identities
recorded before, in and after the swap, and the files restored byte-identically
and re-hashed in the same receipt
([`closure3/falsify-junction-scope.log`](receipts/closure3/falsify-junction-scope.log)):
**exactly the two new junction cells go red** (2 failed / 3 passed) and the
three older cells of the file — the SQLite spelling cell, the native answer cell
and the R-D4 pin — stay green.

## R6.3 The author's own cells — a junction relation in the scope cell's model set

`unique-discriminator.test.ts`'s scope world gains a junction: `scopeTag` plus
`SCOPE_LINKS` (`ownerId`/`tagId`, FK to both sides), created, seeded and dropped
beside the existing three tables, and `ScopeOutcome` grows `links` and `tags` so
every cell now compares the link rows and the target rows as well as the answer
and the child rows. The reviewer's observation that the round-2 model set had no
junction in it — so neither its five "must address through the constraint" rows
nor its five "must stay filters" rows could see finding 9 — is closed.

The differential cell grows **10 → 13** rows, all re-seeded and run on both
engines on a `utf8mb4_0900_ai_ci` table it asserts first:

| new row | shipped | candidate |
| --- | --- | --- |
| junction `disconnect` on a collation-equal key | `ok`, the link row removed | same |
| junction `update` on a collation-equal key | `ok`, the tag's `label` is `u` | same |
| junction `connect` on a collation-equal key (control) | `ok`, the link unchanged | same |

A **new cell** beside it — the file's fifth — pins finding 10's divergence on
**both** selectors (§R6.5); that is the one cell the estate gains, taking it to
**112** over 19 files (was 111). The three rows above are rows of the existing
differential cell and add none.

## R6.4 Measured — the reviewer's own probes, re-run unmodified

| probe | before this round | after |
| --- | --- | --- |
| `unit02-closure2/mysql-scope-boundaries.review.test.ts` (15 cells, live MySQL) | **4 divergences** — junction `disconnect`, junction `update`, junction `delete` collation-equal, junction `delete` exact bytes ([`closure3/repro-scope-boundaries.log`](receipts/closure3/repro-scope-boundaries.log)) | **2** — the two junction `delete` cells, which now answer **identically to each other** ([`closure3/probe-scope-boundaries-after.log`](receipts/closure3/probe-scope-boundaries-after.log)) |
| `unit02-closure2/transition-owner-boundaries.review.test.ts` (14 cells) | 14 passed | **14 passed** |
| `unit02-closure/mysql-discriminator-scope.review.test.ts` (11 cells, live MySQL) | 1 divergence (R-D4) | **1 — still R-D4 only** ([`closure3/probe-mysql-discriminator-scope.log`](receipts/closure3/probe-mysql-discriminator-scope.log)) |
| `unit02-closure/upsert-transition-scope.review.test.ts` (9 cells) | 9 passed | **9 passed** ([`closure3/probe-upsert-transition-scope.log`](receipts/closure3/probe-upsert-transition-scope.log)) |

The two remaining cells are the evidence that the repair reached the target, not
a residue of it: before the round the collation-equal junction `delete` answered
`NestedWriteError: … target record was not found for this parent` (it could not
address the row) and the exact-byte one answered `ForeignKeyError`. After it,
**both** answer `ForeignKeyError: Foreign key constraint violation` with the
link and tag rows untouched — the selector's spelling is no longer what
separates them, and what remains is finding 10.

## R6.5 Finding 10 — classified: PRE-EXISTING at `0cc61e61`, not introduced by G4

The reviewer's control cell — `owner.update({ where:{id:"wanted"}, data:{ tags:
{ delete:[{ id:"g1" }] } } })`, the target's **exact bytes** — answers `ok` on
the shipped engine (link row and tag row both gone) and `ForeignKeyError` on the
candidate, which writes nothing.

Minimized to that one request with a two-model junction world and **run
unchanged in two trees against the same container**
(`viborm-raptor3-g3-mysql-20260914`, `d6da412eec3c`, `127.0.0.1:65515`); the
probe source is kept beside the receipts
([`closure3/probe-junction-delete-baseline.source.ts`](receipts/closure3/probe-junction-delete-baseline.source.ts),
[`…workspace.source.ts`](receipts/closure3/probe-junction-delete-baseline.workspace.source.ts)):

| tree | shipped | candidate |
| --- | --- | --- |
| this G4 working tree ([`closure3/classify-junction-delete-candidate.log`](receipts/closure3/classify-junction-delete-candidate.log)) | `ok:{"id":"wanted","name":"winner"}`, `links []` `tags []` | `ForeignKeyError: Foreign key constraint violation`, `links [{wanted,g1}]` `tags [{g1,tag}]` |
| clean `0cc61e61` worktree `/private/tmp/viborm-g4-perf-baseline` ([`closure3/classify-junction-delete-baseline-0cc61e61.log`](receipts/closure3/classify-junction-delete-baseline-0cc61e61.log)) | the same, byte for byte | **the same, byte for byte** |

The baseline receipt records the worktree's commit and the committed identities
it ran on (`selection.ts 874dc5ec…`, `relation-body.ts 79066ea8…`,
`shared/query.ts e0c4d420…`), and that the probe copy was removed afterwards so
the worktree is clean again. **Verdict: pre-existing at `0cc61e61`; no G4 unit
introduced it, and no mechanism of this unit's is involved.**

**Wording corrected after the round-7 verification (note 2).** At the clean
baseline BOTH junction `delete` spellings already reached the
`ForeignKeyError`. Round 2 turned the collation-equal one into a
`NestedWriteError`; round 3 **restores** the baseline reachability of both
spellings. "Round 3 makes it reachable by a second selector spelling" is true of
the round-2 tree and describes a restoration, not an expansion, relative to
`HEAD`.

It was recorded as R-B5 for the junction delete ordering's owner, and pinned on
both engines in this unit's own estate (§R6.3) so it could not silently move.
**It is repaired in this unit** (brief item 10) — see "Decisions applied".

## R6.6 Suites, after the last edit

Every row was run serially through the bounded runner; the last production edit
precedes all of them, and the author-estate rows and the closing
`g2-mysql-contracts` were re-run after the final (formatting-only) test edit.

| Mode / suite | Result | Wall / peak RSS | Receipt |
| --- | --- | --- | --- |
| `g2-mysql-contracts` (65515, `d6da412eec3c`) | **13 passed** | 5.23 s / 680.5 MiB | [`closure3/g2-mysql-contracts.log`](receipts/closure3/g2-mysql-contracts.log), closing re-run **13 passed** (5.51 s / 701.1 MiB) [`…-closing.log`](receipts/closure3/g2-mysql-contracts-closing.log) |
| `g2-mysql-baseline` (65515) | **13 passed** | 4.56 s / 643.1 MiB | [`closure3/g2-mysql-baseline.log`](receipts/closure3/g2-mysql-baseline.log) |
| `g2-pg-contracts` (65504, `7dfda37e8eea`) | **18 passed** | 5.25 s / 716.8 MiB | [`closure3/g2-pg-contracts.log`](receipts/closure3/g2-pg-contracts.log) |
| `g3-execution-review` | **6 passed** | 4.02 s / 535.5 MiB | [`closure3/g3-execution-review.log`](receipts/closure3/g3-execution-review.log) |
| `g4-read-contracts` | **62 passed** | 4.98 s / 721.7 MiB | [`closure3/g4-read-contracts.log`](receipts/closure3/g4-read-contracts.log) |
| `g4-route-cache` / `g4-route-admission` / `g4-route-lifecycle` / `g4-route-transactions` | **7 / 7 / 8 / 13 passed** | 4.40 / 4.15 / 4.14 / 4.03 s | [`…cache…`](receipts/closure3/g4-route-cache.log), [`…admission…`](receipts/closure3/g4-route-admission.log), [`…lifecycle…`](receipts/closure3/g4-route-lifecycle.log), [`…transactions…`](receipts/closure3/g4-route-transactions.log) |
| G4-02 author estate, SQLite (19 files) | **102 passed / 10 skipped (112)** | 4.34 s / 713.3 MiB | [`closure3/author-estate-sqlite.log`](receipts/closure3/author-estate-sqlite.log) |
| G4-02 author estate, native MySQL (65515) | **111 passed / 1 skipped (112)** | 5.05 s / 701.6 MiB | [`closure3/author-estate-mysql.log`](receipts/closure3/author-estate-mysql.log) |
| frozen fast-path pins (inside the estate runs) | `physical-envelope` **10**, `packaged-array` **5**, `prepared-operation` **5** — unchanged | — | same two receipts |
| `node scripts/run-typecheck.mjs` (whole estate) | exactly the two permitted `pattern/pack.ts` diagnostics (1443, 2633), and no third | 7.07 s / 5,955.5 MiB | [`closure3/typecheck.log`](receipts/closure3/typecheck.log) |
| reviewer probes, both round-6 files | scope boundaries **2 divergences** (both finding 10), transition boundaries **14 passed** | 3.21 s / 594.2 MiB | [`closure3/probe-closure2-both-closing.log`](receipts/closure3/probe-closure2-both-closing.log) |
| reviewer probes, both round-5 files re-run | discriminator scope **1 divergence (R-D4)**, transition scope **9 passed** | 2.42 / 2.51 s | [`…discriminator-scope…`](receipts/closure3/probe-mysql-discriminator-scope.log), [`…transition-scope…`](receipts/closure3/probe-upsert-transition-scope.log) |
| falsifier — the edge-kind rule | 2 failed / 3 passed, restored and re-hashed | 2.99 s | [`closure3/falsify-junction-scope.log`](receipts/closure3/falsify-junction-scope.log) |

Biome: `npx biome format` reports **no** diff in `relation-body.ts` or in
`unique-discriminator.test.ts`, and the six diffs it reports in `selection.ts`
are pre-existing — the same six lines, at the same offsets, in the round-2 copy
of the file. `npx biome lint` on the test file is clean.

## R6.7 Files, identities, cost

Two production files and one test file changed in round 3; every other file this
unit owns, the transferred route, the four adapters and
`result/cache-value-codecs.ts` are **byte-identical** to their round-2
identities ([`closure3/identities-round3.txt`](receipts/closure3/identities-round3.txt)).

| File | Round-2 (reviewed) identity | Round-3 identity |
| --- | --- | --- |
| `commands/selection.ts` | `31528299…` | `57ec20aa9c819de8f45fae9fe17be1eafc41b40938a71c722b79ed0b46e72aac` |
| `commands/relation-body.ts` | `bbccc131…` | `a3bf3e7beb9da956a1321c1ccf36cc168d225c6220585400bcc6f6b54b6db9f4` |
| `shared/query.ts`, `shared/schema.ts`, `commands/commands.ts`, `route/client-route.ts`, `shared/operation-context.ts`, `shared/storage.ts`, `commands/execution.ts`, `commands/assignments.ts`, `commands/index.ts`, `program/index.ts`, the four adapters | round 2 | **unchanged** |
| `tests/…/unit02/unique-discriminator.test.ts` | `d6eebde7…` | `9760a56a52bffbe1c894ff66cc340c354a2929577aac8a52e830219b365b98c8` |
| `upsert-key-portability.test.ts`, `key-arithmetic.test.ts`, `route-cache.test.ts` | round 2 | **unchanged** |

**Patches — regenerated in place** (the closure pair still names the round-4
base). Both were verified in a scratchpad copy: the round-4 base was
reconstructed by reverse-applying the round-2 patches and reproduces the six
base identities the round-6 review names (`5143b7b3…`, `07b3df1a…`,
`f4ecd7ad…`, `874dc5ec…`, `79066ea8…`, `82ba9c9e…`) exactly, and
forward-applying the regenerated pair onto it reproduces every current identity
above, to the byte, with `unique-discriminator.test.ts` created from `/dev/null`
as at round 4.

- [`production-closure.patch`](production-closure.patch) — six files —
  `4a20a31efe54be3cc3f75f1e1f80f3d804753194d26ec2c62d25185baf80f331`
- [`tests-closure.patch`](tests-closure.patch) — four files —
  `50baa7de565acbf5b73f8c0cdec9fb6a199647b39a673dc0e7fbf55e753f3556`

**Identity recapture** (`captureRaptor3Identity`, after the last edit):
production `751be3526ca5ac4de12cb7062d4482adc6c32b4e563a0199c4f5ccafd3b9e3b0`,
harness `adeee90f70c7944e42d592a5bba906218c669c73f5c2ca64707050646a5161eb`
([`closure3/identity-after.json`](receipts/closure3/identity-after.json)). The
harness half still carries the reviewer's two probe directories
(`tests/raptor3/g4/review/unit02-closure/`, `…/unit02-closure2/`), which are in
the tree and are not this unit's.

**Cost**, same census function as §R5.8 — the run reproduces every unchanged
group's round-2 figure to the byte (four phase-2 files 262,286 / 7,402 / 6,738;
`schema.ts` 17,464 / 485 / 387; `client-route.ts` 14,880 / 378 / 247; the four
adapters 140,389 / 3,423 / 1,635), which is the check that the method is the
reviewer's ([`closure3/cost.txt`](receipts/closure3/cost.txt)):

| | files | bytes | physical | token-lines |
| --- | --- | --- | --- | --- |
| `commands/selection.ts` + `commands/relation-body.ts`, round 2 → **round 3** | 2 | 34,114 → **34,609** | 1,025 → **1,045** | 994 → **1,009** |
| every other charged group | — | unchanged | unchanged | unchanged |

| Increment | bytes | physical | token-lines |
| --- | --- | --- | --- |
| round 3 over round 2, candidate **core** (12 files) | **+495** | **+20** | **+15** |
| round 3 over round 2, `raptor3` tree (15 files) | **+495** | **+20** | **+15** |

Candidate **core** now measures **355,846 bytes / 10,191 physical / 9,357
token-lines**; the whole `src/query-engine/raptor3` tree (15 files) measures
**391,458 / 11,205 / 10,230**. Per file, measured the same way
([`closure3/cost.txt`](receipts/closure3/cost.txt)): `selection.ts` 4,874 →
**6,035** bytes, 145 → **154** token-lines — the predicate's own nine lines; the
`boolean` widening and the rewritten field doc cost none. `relation-body.ts`
29,240 → **28,574** bytes, 849 → **855** — six token-lines for the three call
sites net of the two expressions they replace, and **666 bytes fewer**, because
the two prose comments that used to state the rule twice are deleted. A rule
that now carries eight shipped citations costs the tree +495 bytes in total.
The **complete charged perimeter** is still **UNVERIFIED** for §R.6's unchanged
reason.

## R6.8 §7 decision-elimination answers, against the round-3 diff

1. **What decision disappears?** "Is this nested target a discriminator?" is no
   longer answered at the call site, and no longer answered from the verb alone.
   It is answered once, by the shipped engine's own classification — which
   compiler owns this edge — stated in one function that carries the citations
   for both halves of the answer.
2. **What replaces it?** One predicate, `nestedTargetAddressesConstraint(edge,
   verb)`, and a `SelectionSource.unique` whose documentation points at it
   instead of restating it. No table, no per-verb branch beyond the one the
   shipped engine itself branches on, no new field, no new class.
3. **Consumers?** The three nested target sites in `relation-body.ts`, and
   `Selection`'s existing `source.unique === true` read. Nothing else; bulk
   members never ask. No adapter change, no legacy import, no fallback.
4. **Falsifier?** §R6.2's swap, which turns exactly the two new junction cells
   red and leaves the other three green — and whose swapped-in files are first
   proved byte-identical to the reviewed round-2 tree.

## R6.9 Blockers and decisions for Arnaud, after round 3

| id | What | State |
| --- | --- | --- |
| **R-B3** | `g2-mysql-contracts` on native MySQL | **CLOSED — repaired**, still 13/13 with the rule stated per edge kind |
| **R-D1**, **R-D2**, **R-D3** | unchanged from §R4.8 | unchanged |
| **R-D4** | unchanged from §R5.6/§R5.10: on a collation-equal `connect` / `connectOrCreate` the candidate stores the located row's key, the shipped engine the request's literal; pinned on both engines, and still the single divergence of the reviewer's round-5 probe | **needs a decision**: publish the request literal, or keep the located key |
| **R-B5** | a junction `delete` — by exact bytes or by a collation-equal key — answered `ForeignKeyError: Foreign key constraint violation` on the candidate and wrote nothing, where the shipped engine deletes the link row and the target. **Pre-existing at `0cc61e61`** (§R6.5, two receipts, the same minimized request in both trees) | **CLOSED — repaired in this unit** (brief item 10, "Decisions applied"): the junction `delete` places the link removal before the target deletion, the shipped `compileDelete` order. Measured on live MySQL and, credential-free, on SQLite |
| **request** | **register `g4-unit02-author`** — unchanged in substance from §R4.8, whose figures are now corrected: **112 cells** over 19 files (102 passed / 10 skipped credential-free; 111 passed / 1 skipped on native MySQL) | **needs the integrator** |

## R6.10 Unverified after round 3

1. The **complete charged perimeter** — unchanged reason (§R.6); every figure in
   §R6.7 is reproducible to the byte.
2. `scripts/raptor3-cli.test.mjs` and the three harness self-tests — still run
   by no one; this round changed nothing under `scripts/`.
3. The upsert key gate (all three owners) is measured on SQLite and on live
   MySQL; **no PGlite or native-PostgreSQL cell exercises it**.
4. "No PostgreSQL behaviour changes" still rests on `exactTextEq` being a plain
   `=` there plus `g2-pg-contracts` 18/18, not on a differential PostgreSQL
   cell. Round 3 widens the rule again for one edge kind, so a PostgreSQL cell
   still cannot distinguish the two spellings; none was added.
5. B-1c's NS-04 parity, and the **widened-sum codec branch**, which no cell in
   the estate executes (§R5.5). Unchanged, and untouched by this round.
6. `core-structure` (§R3.8 item 5) was not re-measured in this round either.
7. The nested `upsert` probe's own **guard** statement's spelling (§R5.11
   item 7) is still compared by no cell — only the observable answer and the
   rows are.
8. **New:** the junction rule is measured on the `disconnect` / `update` /
   `connect` / `set` / `delete` verbs against a `toMany().through()` junction
   with a compound link key. A junction with a `uniqueSide`, a variant carrier
   and a polymorphic collection reach the same predicate and are measured by no
   cell of this unit's; the argument that they are the same rule is the
   predicate's own shape (it asks `edge.kind`), not a measurement.
9. **New:** R-B5's *mechanism* is not diagnosed. This round establishes only
   that both engines' answers are the same in the candidate tree and in the
   clean `0cc61e61` worktree; it does not name why the candidate's junction
   delete violates the link table's foreign key, which is the owning stream's to
   determine.

# Decisions applied (2026-09-15, after Arnaud's 16:55 decisions and the round-7 ACCEPT)

Brief: [`briefs/decisions-implementation.md`](../briefs/decisions-implementation.md)
(both sections). Inputs read in order: `briefs/common.md`, the brief, the
decisions table in [`g4.md`](../../g4.md) ("Arnaud's decisions (16:55,
2026-09-15)"), this note's R-D1…R-D4 rows and §§R4.*–R6.*,
[`unit03/note.md`](../unit03/note.md) FU.6 (D-5, D-6), and the round-7
verification [`unit02-closure-review-followup-2.md`](../unit02-closure-review-followup-2.md).

Nothing here re-opens a decision. Each decided answer became either PARITY (the
shipped sentence, in the owner that already states it) or a POSITIVE CONTRACT
witness (the candidate's answer asserted, the shipped answer recorded as a
legacy baseline that does not gate). One inherited parity defect, R-B5, is
repaired. Receipts: [`receipts/decisions/`](receipts/decisions/).

## D.1 Decision → change → cell → receipt

| id | decision | change (owner) | cell | receipt |
| --- | --- | --- | --- | --- |
| **R-D1** | "authorize" — the candidate MAY name an exact decimal under `multiply`/`divide` | **none, by design.** No admitted public request reaches the refusal (§R3.3), so writing the expression now would be dead code. The authorization is recorded in the R-D1 row, in the private guide, and in the cell's own comment | `key-arithmetic.test.ts` → "the one shape with no expression form stays refused" (unchanged assertions, new comment naming the authorization) | [`author-estate-sqlite.log`](receipts/decisions/author-estate-sqlite.log) |
| **R-D2 (a)** | "adopt (a)" — a decimal primary-key `increment` is the contract | `EngineSchema.keyPortabilityRefusal` now states the rounding rule per OPERATOR domain: a `decimal` key refuses `multiply`/`divide` only, so `increment`/`decrement` stay named | `key-arithmetic.test.ts` → "R-D2 (a) THE CONTRACT: names a decimal key increment…" (candidate answer + rows asserted; the shipped refusal recorded in the comment) and "R-D2 (a) leaves the exact-domain decimal operators reachable and the rounding ones refused" | [`author-estate-sqlite.log`](receipts/decisions/author-estate-sqlite.log), [`g3-execution-review.log`](receipts/decisions/g3-execution-review.log) (6/6 — the registered G3 witness that pins the capability) |
| **R-D2 (b)** | revert to the shipped refusal | same owner: a `number` key under ANY arithmetic answers `Arithmetic updates are not portable for number primary key field 'id'. Use an explicit set value.` | `key-arithmetic.test.ts` → "R-D2 (b) PARITY: refuses a number key increment with the shipped sentence" (`increment` and `decrement`, both engines, answer + rows) | [`author-estate-sqlite.log`](receipts/decisions/author-estate-sqlite.log) |
| **R-D2 (c)** | revert to the shipped refusals | same owner for the `update`/`updateMany` sentence (`Primary key field 'id' accepts exactly one update operation; received set, increment.`), and `EngineSchema.keyTransitionRefusal` — the THIRD shipped owner, already present — for the upsert-with-relations sentence (`Cannot determine the updated primary key for model 'owner' because field 'id' uses an unsupported operation.`, `operations/mutation-identity.ts:187`). No new walk: both read the payload the admission already produced | `key-arithmetic.test.ts` → two "R-D2 (c) PARITY" cells; `upsert-key-portability.test.ts` → "R-D2 (c) PARITY: answers the transition's OWN sentence…", "…refuses the SAME way on a missing row, and writes nothing", "…answers the ARITY sentence where no transition is built" | [`author-estate-sqlite.log`](receipts/decisions/author-estate-sqlite.log) |
| **R-D3** | "give it a public identity now" | `OperationContext.update`'s `usesBatch` arm raises a registered `QueryEngineError` at the same point (before any statement of the update is dispatched) instead of a bare `Error`, naming the model, the field and the operation, with `meta` `{ model, operation, field }` | `key-arithmetic.test.ts` → the two "R-D3 refuses a number key … with its registered identity" cells (message, `instanceof`, `meta`, rows; the shipped row answer asserted as the accepted divergence) | [`author-estate-sqlite.log`](receipts/decisions/author-estate-sqlite.log) |
| **R-D4** | "accept the candidate behavior" | **none** — the candidate already binds `parent.located.fields`. The pin became a positive contract witness and gained the PARENT-held position the reviewer asked for (note 13) | `unique-discriminator.test.ts` → "R-D4 THE CONTRACT: a collation-equal connect stores the LOCATED row's key in the foreign-key column" (child-held `create`, parent-held `update`, parent-held `connectOrCreate`; shipped answer recorded in the comment with its baseline receipt) | [`author-estate-mysql.log`](receipts/decisions/author-estate-mysql.log) |
| **D-5** | "accepted" — the refusal removal stands | **none** — the candidate already packages it | `route-transactions.test.ts` → "D-5 CONTRACT a MULTI-statement array member is packaged atomically on a batch-only driver" (one native batch, committed rows, the interactive-substrate parity kept; the shipped refusal recorded in the comment, `notEqual` removed) | [`g4-route-transactions.log`](receipts/decisions/g4-route-transactions.log) 13/13 |
| **D-6** | "accept the normalized payload as the contract" | **none** — the candidate already publishes its one admission | `route-lifecycle.test.ts` → "D-6 CONTRACT the interceptor input for upsert is the ONE admission on the candidate route" (identical public results and envelope still asserted; the shipped raw arms recorded in the comment, `notDeepEqual` removed) | [`g4-route-lifecycle.log`](receipts/decisions/g4-route-lifecycle.log) 8/8 |
| **note 14** | type the predicate's verb | `commands/selection.ts` exports `NestedTargetVerb`, the case-label union of `RelationBody.relation`'s own switch; `nestedTargetAddressesConstraint(edge, verb: NestedTargetVerb)`. No guard, no runtime branch | the typecheck itself | [`falsify-verb-union.log`](receipts/decisions/falsify-verb-union.log) — passing `"createMany"` at `relation-body.ts:215` is `error TS2345: Argument of type '"createMany"' is not assignable to parameter of type 'NestedTargetVerb'` |
| **note 13** | two author rows | the junction `upsert` row joins the differential scope cell (13 → 14 rows) | `unique-discriminator.test.ts` → "addresses through the constraint exactly the call sites the shipped engine compiles with buildWhereUnique" | [`author-estate-mysql.log`](receipts/decisions/author-estate-mysql.log) |
| **R-B5** | inherited parity defect (§D.3) | `commands/relation-body.ts`'s `disconnect`/`delete` arm places the junction link removal BEFORE the target deletion | `unique-discriminator.test.ts` → "R-B5: a junction delete removes the link row and the target, by either spelling" (live MySQL) and the three credential-free cells of "the junction delete removes the link row, then the target" | [`author-estate-mysql.log`](receipts/decisions/author-estate-mysql.log), [`author-estate-sqlite.log`](receipts/decisions/author-estate-sqlite.log), falsifier [`falsify-junction-delete-sqlite.log`](receipts/decisions/falsify-junction-delete-sqlite.log) |

## D.2 The key-update rule, stated once

`EngineSchema.keyPortabilityRefusal` is now the shipped
`assertPortablePrimaryKeyUpdateInput` with exactly ONE adopted divergence:

1. the payload must name **exactly one** of `set`/`increment`/`decrement`/`multiply`/`divide`, or it answers the arity sentence with the names in the shipped order (R-D2 (c));
2. the single operation, when it is not `set`, is refused as non-portable for a `number` key (any operator) and for a `decimal` key under `multiply`/`divide` — the two that carry the provider's rounding. **The adopted divergence is here**: a `decimal` key under `increment`/`decrement` is exact in coefficient space and stays supported (R-D2 (a));
3. a `divide` by zero on the remaining key domains answers the validator's sentence.

The shipped non-finite-operand arm is still not mirrored: after rules 1–2 it is
reachable only for an `int`/`bigint` key, whose validation already refuses a
non-finite operand, so it would be a guard whose unique coverage cannot be named.

`EngineSchema.keyTransitionRefusal` keeps its three structural conditions
(child-held transition on the key, single-member reference key, discriminator
pins the pre-value) and now classifies the payload the way
`getSafeUpdatedScalarValue` does: not-exactly-one-operation is the `:187`
sentence, `divide: 0` is the transition's own sentence. Both are raised at
analysis, before either arm of an `upsert` exists, so a missing row is refused
too and nothing is written — measured.

**Falsifier.** Swapping `shared/schema.ts` and `shared/operation-context.ts`
back to their pre-decision copies turns exactly **8** cells red — the two
R-D2 (c) cells in `key-arithmetic.test.ts`, the R-D2 (b) cell, the two R-D3
cells and the three R-D2 (c) cells in `upsert-key-portability.test.ts` — and
leaves the R-D2 (a) contract cells green, which is the right shape: (a) is
what the code already did
([`falsify-key-decisions.log`](receipts/decisions/falsify-key-decisions.log),
8 failed / 31 passed; both files restored and re-hashed in
[`identities-after.txt`](receipts/decisions/identities-after.txt)).

## D.3 R-B5 — the junction delete's foreign-key failure, repaired

**Minimized.** `owner.update({ where: { id: "wanted" }, data: { tags: { delete:
[{ id }] } } })` on a `toMany().through()` junction whose link table declares a
plain `FOREIGN KEY (tagId) REFERENCES tags (id)`. Before the repair the
candidate answered `ForeignKeyError: Foreign key constraint violation` and wrote
nothing, for both selector spellings; the shipped engine removed the link row
and the target.

**Mechanism, named.** `commands/relation-body.ts`'s `disconnect`/`delete` arm
placed, for every non-parent-held edge, a single command: `remove` for a
`disconnect`, `delete` for a `delete`. For a JUNCTION `delete` that is the
target's `DELETE` **with no link-row statement at all** — the link row still
references the row being deleted, so a provider that enforces the constraint
refuses the whole write. It is the missing statement, not the selector or the
order of two existing statements.

**Repair, in that one owner.** The arm now places the link removal first and the
target deletion second, in the same region, when (and only when) the verb is
`delete` and the edge is a junction. That is the shipped order, stated in the
shipped engine's own comment — "delete — locate the connected child, DELETE its
join rows, then the child" (`write-engine/RelationJunctionPart.ts:911-937`
`compileDelete`: `junctionDeleteTargets`, then `childDelete`). Both placements
carry the same origin, so the body keeps insertion order. Nine added lines.

**Invariant.** A junction `delete` issues the link removal before the target
deletion; a `disconnect` issues the removal alone; a reference-held target
issues its deletion alone. No other verb or edge kind gains a statement.

**Falsifier.** With `relation-body.ts` swapped back to its pre-repair copy, the
credential-free contract cell fails with exactly the inherited answer
(`ForeignKeyError`, `links [{wanted,g1}]`, `tags [{g1,tag}]`) while the
`disconnect` and reference-`delete` cells stay green — 1 failed / 4 passed
([`falsify-junction-delete-sqlite.log`](receipts/decisions/falsify-junction-delete-sqlite.log));
the file was restored and re-hashed.

**Measured on SQLite, with one qualification the brief asked for.** The estate's
own migration emits `ON DELETE CASCADE ON UPDATE CASCADE` on BOTH junction
foreign keys (measured:
[`probe-sqlite-ddl.log`](receipts/decisions/probe-sqlite-ddl.log)), so on a
generated SQLite world the provider removes the link for you and the ordering is
**unobservable** — which is why no SQLite cell in this estate ever saw R-B5, and
why the first version of the new cell passed with and without the repair
([`falsify-junction-delete-sqlite.log`](receipts/decisions/falsify-junction-delete-sqlite.log)
is the corrected run; [`probe-junction-sqlite-2.log`](receipts/decisions/probe-junction-sqlite-2.log)
is the earlier, non-discriminating one, kept). The credential-free world now
re-creates the link table with the PLAIN foreign keys the live MySQL world in
the same file declares, and `SQLite3Driver`'s `PRAGMA foreign_keys = ON`
(`src/drivers/sqlite3/index.ts:131`) enforces them. Both providers therefore
measure the repair, and the MySQL cell remains the falsifier of record.

**Statement counts.** The frozen fast-path pins are unchanged —
`physical-envelope` **10**, `packaged-array` **5**, `prepared-operation` **5**
(inside both estate runs). The added statement is the junction `delete`'s own
link removal, which no fast-path cell exercises.

**Collation.** Both selector spellings (`g1`, `G1`) now answer identically on the
`utf8mb4_0900_ai_ci` table, because a junction target is addressed through the
constraint (§R6.1). That closes the round-7 note 2 wording: round 3 restored the
baseline reachability of both spellings, and this round makes both answer the
shipped result.

## D.4 Cells, file by file

| file | before | after | what changed |
| --- | --- | --- | --- |
| `unit02/key-arithmetic.test.ts` | 19 | **20** | the "two key shapes that stay divergent" describe became "R-D2, decided by Arnaud on 2026-09-15": one positive contract cell for (a), two parity cells for (c), one parity cell for (b) covering `increment` and `decrement`, one cell holding both halves of (a). The R-D3 describe asserts the new identity, `instanceof` and `meta`. The R-D1 describe keeps its assertions and gains the authorization comment. The file header is re-worded |
| `unit02/upsert-key-portability.test.ts` | 17 | **19** | the R-D2 (c) pin became a parity cell, and two cells were added: the same payload on a MISSING row (the transition owner refuses before either arm), and the same payload beside a PARENT-held relation (no transition, so the arity sentence answers) |
| `unit02/unique-discriminator.test.ts` | 5 | **9** | the R-B5 pin became the positive contract; the R-D4 pin became the positive contract over three positions; the differential scope cell gained the junction `upsert` row (13 → 14 rows); three credential-free junction cells were added (contract by exact bytes, the collation-equal control, `disconnect` unchanged, reference-`delete` unchanged) |
| `g4/route-transactions.test.ts` | 13 | **13** | D-5's pin became the contract; the shipped refusal is a comment; `notEqual` removed |
| `g4/route-lifecycle.test.ts` | 8 | **8** | D-6's pin became the contract; the shipped arms are a comment; `notDeepEqual` removed |

**Count change to report (no manifest edited).** The author estate is **119**
cells over 19 files (was 112): 109 passed / 10 skipped credential-free, 118
passed / 1 skipped on native MySQL. The registration request in §R4.8 stands
with those figures. Every registered mode keeps its registered count —
`g4-route-transactions` 13, `g4-route-lifecycle` 8, `g4-route-admission` 7,
`g4-route-cache` 7, `g4-read-contracts` 62, `g3-execution-review` 6,
`g2-mysql-contracts` 13, `g2-mysql-baseline` 13, `g2-pg-contracts` 18.

## D.5 Suites, after the last source edit

Every row ran serially through the bounded runner and **after the last source
edit** — the restoration of `shared/schema.ts` and `shared/operation-context.ts`
at the end of §D.2's falsification, 17:33:55; the earliest row below starts at
17:40:29. (An earlier, identical pass ran at 17:31–17:32 against byte-identical
copies of those two files; these are the closing runs.) Native rows: MySQL
`viborm-raptor3-g3-mysql-20260914` `d6da412eec3c` `127.0.0.1:65515`, PostgreSQL
`viborm-raptor3-g3-pg-20260914` `7dfda37e8eea` `127.0.0.1:65504`.

| Mode / suite | Result | Wall / peak RSS | Receipt |
| --- | --- | --- | --- |
| G4-02 author estate, SQLite (19 files) | **109 passed / 10 skipped (119)** | 5.80 s / 714.1 MiB | [`author-estate-sqlite.log`](receipts/decisions/author-estate-sqlite.log) |
| G4-02 author estate, native MySQL | **118 passed / 1 skipped (119)** | 10.51 s / 674.0 MiB | [`author-estate-mysql.log`](receipts/decisions/author-estate-mysql.log) |
| `g4-route-transactions` | **13 passed** | 7.13 s / 510.1 MiB | [`g4-route-transactions.log`](receipts/decisions/g4-route-transactions.log) |
| `g4-route-lifecycle` | **8 passed** | 6.11 s / 497.8 MiB | [`g4-route-lifecycle.log`](receipts/decisions/g4-route-lifecycle.log) |
| `g4-route-admission` | **7 passed** | 8.78 s / 517.1 MiB | [`g4-route-admission.log`](receipts/decisions/g4-route-admission.log) |
| `g4-route-cache` | **7 passed** | 5.09 s / 528.7 MiB | [`g4-route-cache.log`](receipts/decisions/g4-route-cache.log) |
| `g3-execution-review` | **6 passed** | 5.79 s / 527.0 MiB | [`g3-execution-review.log`](receipts/decisions/g3-execution-review.log) |
| `g4-read-contracts` | **62 passed** | 12.04 s / 684.4 MiB | [`g4-read-contracts.log`](receipts/decisions/g4-read-contracts.log) |
| `g2-mysql-contracts` (65515) | **13 passed** | 6.45 s / 701.3 MiB | [`g2-mysql-contracts.log`](receipts/decisions/g2-mysql-contracts.log) |
| `g2-mysql-baseline` (65515) | **13 passed** | 4.68 s / 640.0 MiB | [`g2-mysql-baseline.log`](receipts/decisions/g2-mysql-baseline.log) |
| `g2-pg-contracts` (65504) | **18 passed** | 5.85 s / 696.0 MiB | [`g2-pg-contracts.log`](receipts/decisions/g2-pg-contracts.log) |
| frozen fast-path pins | `physical-envelope` **10**, `packaged-array` **5**, `prepared-operation` **5** — unchanged | — | the two estate receipts |
| `node scripts/run-typecheck.mjs` | exactly the two permitted `pattern/pack.ts` diagnostics (1443, 2633) and no third | 12.59 s / 5,727.5 MiB | [`typecheck.log`](receipts/decisions/typecheck.log) |
| falsifier — the key decisions | **8 failed / 31 passed** | 3.46 s | [`falsify-key-decisions.log`](receipts/decisions/falsify-key-decisions.log) |
| falsifier — the junction delete order | **1 failed / 4 passed / 4 skipped** | 2.81 s | [`falsify-junction-delete-sqlite.log`](receipts/decisions/falsify-junction-delete-sqlite.log) |
| falsifier — the predicate's verb union | `TS2345` at `relation-body.ts:215` | 13.11 s | [`falsify-verb-union.log`](receipts/decisions/falsify-verb-union.log) |

Biome: `npx biome format` reports **no** diff in `relation-body.ts` or in any of
the five test files; the diffs it reports in `selection.ts` (6), `schema.ts` (1,
the constructor line) and `operation-context.ts` (28) are **pre-existing and
unchanged in count** — measured on the pre-decision copies of the same files.
An earlier `--write` in this round reformatted them wholesale; the files were
rebuilt from their pre-decision copies with only this round's edits re-applied,
so no unrelated formatting churn is in the diff.

**Environment event, recorded (not this unit's code).** The first closing
attempt at `g2-mysql-contracts` / `g2-mysql-baseline` failed — 6 of 13 cells red,
then all 13 — with `Create table/tablespace '…' failed, as disk is full`: the task container's
512 MiB tmpfs datadir was **100 % full**, holding **1,086 leftover `r3_<uuid>`
databases** created by the live-provider harness and never dropped (mtimes
spread over 12:12–15:42 UTC, ~13–39 per run). No test process was running; I
dropped the 1,053 of them older than eight minutes, which took the datadir from
512/512 MiB to 240/512 MiB, and both modes then passed 13/13 and 13/13 — the
same results as the 17:31 pass. **The leak itself is unfixed and belongs to the
live-provider harness owner**: at the observed rate the container refills within
a few hours and every native mode starts failing with a disk error that looks
like a product fault. The PostgreSQL container is at 161/512 MiB and healthy.
The host volume is at 4.9 GiB free, which is the standing G4 disk blocker.

## D.6 Files, identities, cost

| File | pre-decision identity | identity now |
| --- | --- | --- |
| `shared/schema.ts` | `48fc18c1…` | `b3f237a172ff9355b46d96c0b759530f7ee8169048c32b73eeca9b49faa77b86` |
| `shared/operation-context.ts` | `8b25f6fe…` | `3e0b3bf69b1cabddcacab38c5ec179231da2fb97efc4338722e056903327752b` |
| `commands/selection.ts` | `57ec20aa…` | `84aa0c448e375713bca8791c591a28015dec97ace0afb635df51df716d189ace` |
| `commands/relation-body.ts` | `a3bf3e7b…` | `3bf284452f04aa8d18116fd2cf21043697f5c969d28bb432210cbf5cfb412aec` |
| `shared/query.ts`, `commands/commands.ts`, `route/client-route.ts`, `shared/storage.ts`, `commands/execution.ts`, `commands/assignments.ts`, `commands/index.ts`, `program/index.ts`, the four adapters, `result/cache-value-codecs.ts` | — | **unchanged** |
| `unit02/key-arithmetic.test.ts` | `c73e1908…` | `11cb6d904894e01cecf7af1c997a77307bdd829768961a1baca1b17b1ed577d6` |
| `unit02/upsert-key-portability.test.ts` | `97d5c91d…` | `9618b8db9d1a77eac36e6af5b99a5e9215b89b87fe7e97f83d7e8e4b5f77975c` |
| `unit02/unique-discriminator.test.ts` | `9760a56a…` | `5392ea7413fc79394bce03e31ec9cfccf91a8592c5560dfed271a8ef6f15305a` |
| `g4/route-transactions.test.ts` | `8c93d18a…` | `63becd16c5ae72c1307a66dfbd341e2d5b2ef2ffea89c06a529fe023661b577b` |
| `g4/route-lifecycle.test.ts` | `1e557cd9…` | `ebe59800dd00d26d6433be1b9a7bdce9e2be67f88d967447cefa53f815e18569` |
| `src/query-engine/raptor3/AGENTS.md` | — | seven appended paragraphs, one per decided behaviour plus R-B5's order |

**Patches — regenerated in place.** `production-closure.patch` now carries seven
files (the six it had, plus `shared/operation-context.ts`) and
`tests-closure.patch` six (the four it had, plus the two transferred route
files). The base is unchanged for the six production and three test files it
already carried — reverse-applying the pair reproduces the round-4 identities
`5143b7b3…`, `07b3df1a…`, `f4ecd7ad…`, `874dc5ec…`, `79066ea8…`, `82ba9c9e…`
exactly, and removes `unique-discriminator.test.ts`; for the three files new to
the pair the base is their pre-decision identity above. Forward-applying onto
that base reproduces all thirteen current identities to the byte
([`patch-integrity.txt`](receipts/decisions/patch-integrity.txt)).

- [`production-closure.patch`](production-closure.patch) — seven files — `9553f3887269cffc1fb31c9adcb686b15b1f7bbe56dee348e403d9334e5cbee4`
- [`tests-closure.patch`](tests-closure.patch) — six files — `7e5e245900554df7611c8598b4a2433acf95a6aa325c3b3fb28b7610e5076585`

**Identity recapture** (`captureRaptor3Identity`, after the last edit):
production `69dcfd215b36afb10b0089411156e258d4a409871d745396a716cc91d8255546`,
harness `eadf9d76888be1be448c579a1b078e487ffbfd7d8b2cad7eb77ec264abb9ca66`
([`identity-after.json`](receipts/decisions/identity-after.json)). The harness
half still carries the reviewer's three probe directories, which are in the tree
and are not this unit's.

**Cost**, same `countTokenLines` census as §R6.7, over the same groups
([`cost.txt`](receipts/decisions/cost.txt)); the two groups this round does not
touch reproduce their round-3 figures to the byte (`client-route.ts` 14,880 /
378 / 247; the four adapters 140,389 / 3,423 / 1,635), which is the check that
the method is the reviewer's.

| group | round 3 | now | increment |
| --- | --- | --- | --- |
| four phase-2 files | 262,286 / 7,402 / 6,738 | **263,306 / 7,418 / 6,745** | +1,020 / +16 / +7 |
| `shared/schema.ts` | 17,464 / 485 / 387 | **19,305 / 526 / 410** | +1,841 / +41 / +23 |
| `selection.ts` + `relation-body.ts` | 34,609 / 1,045 / 1,009 | **35,911 / 1,072 / 1,020** | +1,302 / +27 / +11 |
| `route/client-route.ts` | 14,880 / 378 / 247 | unchanged | 0 |
| four adapters | 140,389 / 3,423 / 1,635 | unchanged | 0 |

| Increment | bytes | physical | token-lines |
| --- | --- | --- | --- |
| this round over round 3, candidate **core** (12 files) | **+4,163** | **+84** | **+41** |
| this round over round 3, `raptor3` tree (15 files) | **+4,163** | **+84** | **+41** |

Candidate **core** now measures **360,009 bytes / 10,275 physical / 9,398
token-lines**; the whole `src/query-engine/raptor3` tree (15 files) measures
**395,621 / 11,289 / 10,271**. Per file: `schema.ts` 17,464 → **19,305** bytes,
387 → **410** token-lines (the two refusal rules and their doc);
`operation-context.ts` 69,074 → **70,094**, 1,774 → **1,781** (R-D3's identity
and its nine-line reason); `selection.ts` 6,035 → **6,505**, 154 → **162** (the
verb union and its doc); `relation-body.ts` 28,574 → **29,406**, 855 → **858**
(the junction link removal and its citation). The **complete charged perimeter**
is still UNVERIFIED for §R.6's unchanged reason.

## D.7 §7 decision-elimination answers, against this round's diff

1. **What decision disappears?** Four. "Which key-update shapes does the
   candidate refuse?" is no longer a per-shape recollection split between a
   `set`-shaped skip and a rounding list — it is the shipped predicate with one
   named exception. "What identity does the batch publication gap have?" is no
   longer "an internal invariant" answered by a bare `Error`. "Does a nested
   verb consult the edge-kind rule?" is no longer a runtime default — it is a
   type. "Does a junction `delete` need a link statement?" is no longer implicit
   in an `else` branch shared with `disconnect`.
2. **What replaces them?** One predicate list (`KEY_UPDATE_OPERATIONS`) in the
   one owner, plus a two-line domain rule; one registered error identity with
   the meta the rest of the estate uses; one exported case-label union; one
   conditional placement carrying the shipped citation. No table, no new class,
   no new field, no policy-boolean bag.
3. **Consumers?** `EngineSchema.admit` and the upsert found-arm channel
   (unchanged call sites); `OperationContext.update`'s `usesBatch` arm
   (unchanged call site); the three existing `nestedTargetAddressesConstraint`
   call sites; `Commands.place`, already the owner of every placement. No
   adapter change, no legacy import, no fallback.
4. **Falsifier?** Three, all recorded in §D.5: the 8-cell key-decision swap, the
   junction-order swap (1 of 5 cells, credential-free), and the verb-union
   typecheck.

## D.8 Blockers and decisions for Arnaud, after this round

| id | What | State |
| --- | --- | --- |
| **R-D1** | authorized, unwritten (no reachable shape) | **recorded** — nothing to decide; the refusal pin stays until a reachable shape exists |
| **R-D2 (a)(b)(c)**, **R-D3**, **R-D4**, **D-5**, **D-6** | applied exactly as decided | **CLOSED** |
| **R-B5** | junction `delete` foreign-key failure | **CLOSED — repaired on the first attempt** (§D.3), measured on live MySQL and credential-free on SQLite, with a falsifier. No stop rule was reached |
| **R-B3** | `g2-mysql-contracts` | still 13/13 |
| **request** | **register `g4-unit02-author`** — unchanged in substance from §R4.8; the estate is now **119 cells** over 19 files (109 passed / 10 skipped credential-free; 118 passed / 1 skipped on native MySQL) | **needs the integrator** |
| **E-1** | **new, environment, not this unit's**: the live-provider harness leaks one `r3_<uuid>` database per world and never drops them; 1,086 had accumulated and filled the MySQL container's 512 MiB tmpfs, so every native mode failed with `… failed, as disk is full` (§D.5). Reclaimed by dropping the 1,053 older than eight minutes | **needs an owner** — the live-provider harness stream; it will refill within hours |
| (open) | the G2.9 specimen edit settlement | unchanged |

## D.9 Unverified after this round

1. The **complete charged perimeter** — unchanged reason (§R.6); every figure in
   §D.6 is reproducible.
2. `scripts/raptor3-cli.test.mjs` and the three harness self-tests — still run by
   no one; this round changed nothing under `scripts/`.
3. The key-update rules are measured on SQLite and (for the transition owner's
   placement) nowhere else; **no PGlite or native-PostgreSQL cell exercises
   them**. They are provider-independent by construction — raised before any
   statement is built — which is an argument, not a measurement. Unchanged from
   §R6.10 item 3.
4. "No PostgreSQL behaviour changes" still rests on `exactTextEq` being a plain
   `=` there plus `g2-pg-contracts` 18/18, not on a differential PostgreSQL cell.
   The junction-delete repair adds a statement on every provider, and no
   PostgreSQL cell measures it; `g2-pg-contracts` and `g2-pg-baseline` cover the
   provider generally, not this verb.
5. B-1c's NS-04 parity, and the **widened-sum codec branch**, which no cell in
   the estate executes (§R5.5). Untouched by this round.
6. `core-structure` (§R3.8 item 5) was not re-measured in this round either.
7. **New:** R-D3's identity is measured on the SQLite-backed atomic-batch
   profile only (the D1-shaped driver). No native batch-only provider cell
   raises it, and the `meta` it publishes is asserted by one cell family.
8. **New:** the junction-delete order is measured for the `delete` verb on a
   two-model junction with a plain foreign key. `deleteMany` on a junction edge —
   the shipped `compileDeleteMany`, which has its own ordering — is exercised by
   no cell of this estate, and this round did not touch it.
9. **New:** the `decimal` key `decrement` arm of R-D2 (a) is asserted on the
   candidate only (the shipped engine refuses it, as it refuses `increment`);
   the G3 witness registers `increment`, not `decrement`.

---

# Decisions round 2 (2026-09-15, after the independent decisions review returned REVISE)

Written by the G4 **freeze-preparation** unit, not by the decisions author: the
review's two code findings live in this unit's files, and the freeze brief
(`briefs/freeze-prep.md` part 0) hands them here so the private guide can be
written knowing they are closed. Inputs: [`../decisions-review.md`](../decisions-review.md)
in full and its receipts, this note §§D.1–D.9, and the actual source.
Receipts for this round are under [`../freeze/receipts/`](../freeze/receipts/).

## DR2.1 Finding 1 — R-D2 (c) at the nested sites (parity, same owner)

**What was wrong.** `EngineSchema.keyPortabilityRefusal` was asked at the two
ROOT positions only. Four reachable nested shapes therefore let `set` win beside
an operator on a CHILD's key, where the shipped engine refuses and writes
nothing — measured by the reviewer on both engines and byte-identical at the
committed `0cc61e61`, so inherited rather than introduced.

**The change — the same owner, at the positions the body already admits the
payload in.** `commands/relation-body.ts` asks
`EngineSchema.keyPortabilityRefusal(edge.target, …)` at exactly two call sites,
covering the three nested positions a child update payload can occupy:

| call site | payload asked about | verbs it covers |
| --- | --- | --- |
| the `connect`/`connectOrCreate`/`upsert`/`update` arm, right after `conditional` is formed | `verb === "upsert" ? conditional.update : conditional.data` (hoisted as `childUpdate`, and the `found` arm now consumes that same binding) | nested child `update`, nested child `upsert`; `connect` and `connectOrCreate` carry no update payload, so the owner is asked about `undefined` and answers `undefined` |
| the `updateMany`/`deleteMany` member loop, right after `input` is formed | `input.data` | nested `updateMany` member; a `deleteMany` member has no `data` |

No new walk, no per-verb table, no second sentence: both sites hand the owner
the payload the admission already produced, exactly as `EngineSchema.admit` and
the upsert found-arm gate do. The refusal is raised during construction, before
any statement is dispatched, which is what makes "writes nothing" true.

> **Corrected in freeze round 2** (freeze review finding 1;
> [`../freeze/note.md`](../freeze/note.md) §R2.1). The last sentence above is
> true of the nested `update` and the `updateMany` member and NOT of the nested
> `upsert`. The shipped engine builds that one assertion as a closure
> (`RelationUpsertPart.ts:1006`) and invokes it only inside the found arm
> (`:468`), so an ABSENT target creates its row with the update payload
> unjudged; refusing it at construction refused a request the shipped engine
> performs. The `upsert` arm now hands the refusal to the found arm's deferred
> `Assignments`, and the scope control in `nested-key-refusal.test.ts` pins both
> directions on SQLite and on live MySQL.

**Measured.** The reviewer's probe
`tests/raptor3/g4/review/unit02-decisions/nested-key-refusal.review.test.ts`,
re-run unmodified through the bounded runner, goes **4 divergences → 0** (5/5
AGREE, [`probe-nested-key-refusal.log`](../freeze/receipts/probe-nested-key-refusal.log)).

## DR2.2 Note 3 — the last bare `Error` in the key family

A root `upsert` whose update payload names NO relation never reaches the
found-arm key channel — the shipped engine does not gate it there either — so
`update: { id: {} }` fell through to `Queries.prepareUpdate`'s "not implemented"
throw and answered a bare `Error`. `prepareUpdate` now raises the shipped
engine's own sentence and identity for a payload that names no operator:
`QueryEngineError: Unknown update operation: ` (`builders/set-builder.ts:217-219`),
before any statement. The reviewer's 23-row probe
`key-refusal-parity.review.test.ts` goes **1 unadopted divergence → 0** (21
AGREE + the 2 adopted R-D2 (a) rows,
[`probe-key-refusal-parity.log`](../freeze/receipts/probe-key-refusal-parity.log)).

## DR2.3 Note 4 — R-D3's error class, for Arnaud

Recorded, no code: `QueryEngineError` stays as Arnaud worded it
("a registered `QueryEngineError` identity"). The reviewer's observation is
worth one line in the ledger — `UnsupportedOperationError` (`V8003
UNSUPPORTED_OPERATION`, `src/errors/query.ts:363`) **extends**
`QueryEngineError` and carries `meta` the same way, so it satisfies the decision
too, and it distinguishes a documented capability boundary from an engine crash
(`V9001 INTERNAL_ERROR`), which is what the author's own comment calls this
refusal. The same file already throws `UnsupportedOperationError` for a
capability boundary. Changing it is a public-identity change and therefore
Arnaud's, not this unit's.

## DR2.4 Cells added (no manifest edited)

New file `tests/raptor3/g4/unit02/nested-key-refusal.test.ts`, **6
credential-free cells**, every one differential against the shipped engine over
the same SQLite data, asserting the answer AND both tables' rows:

1. nested child `update`, key naming `set` beside `increment` — the arity sentence;
2. nested child `upsert`, same payload — the same sentence;
3. nested `updateMany` member, same payload — the same sentence;
4. nested child key naming nothing — `received none.`;
5. **scope control**: a nested child key naming exactly one operation (`set`, and
   `increment`) still performs on both engines, so the refusal is the shipped
   predicate and not a wider "no nested key writes" rule;
6. the relation-free root `upsert` of DR2.2 — the shipped `Unknown update
   operation:` sentence.

**Counts to report (the manifest is the integrator's).** The author estate is
now **125 cells over 20 files**: 115 passed / 10 skipped credential-free
([`author-estate-sqlite.log`](../freeze/receipts/author-estate-sqlite.log)), 124
passed / 1 skipped on live MySQL
([`author-estate-mysql.log`](../freeze/receipts/author-estate-mysql.log)). Every
registered per-file count is unchanged — no existing test file was edited — so
the only registration change needed is to add
`"tests/raptor3/g4/unit02/nested-key-refusal.test.ts": 6` to
`G4_UNIT02_AUTHOR_COUNTS` (`scripts/raptor3-manifest.mjs`), which would take
`g4-unit02-author` from 104 over 16 files to **110 over 17**. Until it is added,
the new cells run only through the estate workspace, not through the registered
mode.

*Review finding 2 is already closed by the integrator:* the manifest now reads
`key-arithmetic.test.ts` 20, `upsert-key-portability.test.ts` 19 and
`unique-discriminator.test.ts` 9 — the measured figures.

## DR2.5 Suites, after the last source edit

Every row ran serially through the bounded runner, one mode per invocation,
after the last production edit. Receipts under [`../freeze/receipts/`](../freeze/receipts/).

| mode / suite | result |
| --- | --- |
| author estate, SQLite (20 files) | **115 passed / 10 skipped (125)** |
| author estate, native MySQL (`127.0.0.1:65515`) | **124 passed / 1 skipped (125)** |
| reviewer probe `nested-key-refusal.review.test.ts` | **0 divergences** (was 4) |
| reviewer probe `key-refusal-parity.review.test.ts` | **0 unadopted divergences** (was 1) |
| `g4-read-contracts` | 62 |
| `g3-execution-review` | 6 |
| `g3-bulk-series` | 6 |
| `g2-contracts` | 216 |
| `g4-route-transactions` | 13 |
| `g2-mysql-contracts` (65515) | 13 |
| `g2-pg-contracts` (65504) | 18 |
| `node scripts/run-typecheck.mjs` | the two permitted `pattern/pack.ts` diagnostics, **plus five inherited diagnostics in the decisions reviewer's own probe files** — see DR2.7 |

## DR2.6 Files, identities, patches

| File | identity before this round | identity now |
| --- | --- | --- |
| `commands/relation-body.ts` | `3bf284452f04aa8d18116fd2cf21043697f5c969d28bb432210cbf5cfb412aec` | `5b00a2d9347f3413f7766df18fa67558b0353fc4e572a06b98a66ff97d57c8c1` |
| `shared/query.ts` | `7ffbea606cbd6e62636f9dcc89b93991a50fb9f7d48c02f84a416dfcc99f96aa` | `38328088e4f3a5cea13723ff5dd0e3855ef7af5438b420d7818fa59816ef7bd6` |
| `unit02/nested-key-refusal.test.ts` | — (new) | `59487465e09dbdb6f2e68ddc717258b15bdf3f26980b177309d87b30a3607566` |

`shared/query.ts` also carries this unit's part-2 change (one exported
`wholeValue` owner); the whole file diff is in
[`../freeze/freeze-only.patch`](../freeze/freeze-only.patch).

**Patches regenerated in place.** The base is unchanged and proven so:
reverse-applying the PREVIOUS pair to the pre-round-2 file copies reproduces
`5143b7b3…`, `07b3df1a…`, `f4ecd7ad…`, `874dc5ec…`, `79066ea8…`, `82ba9c9e…`
and `8b25f6fe…` exactly, and forward-applying the NEW pair onto that base
reproduces all fourteen current files byte-identically (`cmp`,
[`closure-patches-regenerated.log`](../freeze/receipts/closure-patches-regenerated.log)).

- [`production-closure.patch`](production-closure.patch) — seven files — `2b3c6845c1ac1a3d07b4c043ac2ddbdedc45a82cdfeaa88966c70c49fd812279`
- [`tests-closure.patch`](tests-closure.patch) — seven files (the six it had, plus `nested-key-refusal.test.ts`) — `ad81019fb4c4f6bedf802f7700609d30a323d709770b7cf2fcc2eac509253919`

**Cost** (same `countTokenLines` census, bytes / physical / token-lines):
`relation-body.ts` 29,406 / 871 / 858 → **30,353 / 887 / 866**; `shared/query.ts`
138,763 / 3,920 / 3,563 → **139,660 / 3,940 / 3,568** (both this round's nested
refusal and the freeze unit's `wholeValue` owner). Candidate core (12 files)
360,009 / 10,275 / 9,398 → **361,859 / 10,310 / 9,406**
([`cost.txt`](../freeze/receipts/cost.txt)).

## DR2.7 Recorded, not repaired

The whole-estate typecheck carries five diagnostics that are **not** the two
permitted Pattern ones and **not** this round's: they are in the decisions
reviewer's own probe files (`tests/raptor3/g4/review/unit02-decisions/`, mtimes
17:57–18:06 on 2026-09-15) —
`batch-publication-identity.review.test.ts(48,60)` and
`junction-delete-mechanism.review.test.ts(75,60)` TS2554 (a driver subclass
calling `super.execute` with four arguments),
`junction-link-bytes.review.test.ts(220,32)` and `(222,30)` TS18048, and
`nested-key-refusal.review.test.ts(74,42)` TS2345 (an untyped `operation:
string` at `candidate.execute`). **Attributed by measurement, not by argument:**
with this round's three production files restored to their pre-round identities
and the new cell file parked, the same five diagnostics are still reported
([`typecheck-attribution.log`](../freeze/receipts/typecheck-attribution.log));
every file was then restored byte-identically from its scratchpad copy. They
belong to the reviewer's stream and were not edited here.

## P.0 D-7.1 — decided by Arnaud (2026-09-16): accept the difference

Written by the performance pass ([`../perf/note.md`](../perf/note.md), brief
item 7) into this unit's note, because the row belongs to the unit that owns
the pin. **No code.**

| id | decision | change (owner) | cell | receipt |
| --- | --- | --- | --- | --- |
| **D-7.1** | "accept the difference" — a root `update`/`delete` rejected BEFORE dispatch on a batch-only driver publishes no `statementIndex`, where the shipped engine publishes `0` | **none.** The shipped fold is two statements (presence guard + mutation, a real batch); this engine's D-7 fold is ONE statement with a JavaScript postcondition, so the driver seam has no batch to index. Matching it would need a per-verb branch or a second statement, and the frozen fast-path counts must not increase. The difference is now stated in the private guide's envelope paragraph (`src/query-engine/raptor3/AGENTS.md:411-423`), with the instruction not to manufacture the index | `lone-statement-transport.test.ts` → **row 7, unchanged**: it stays the recorded difference, not a defect. No registered oracle reaches it | [`../perf/receipts/g4-unit02-author.log`](../perf/receipts/g4-unit02-author.log) (127/127 at the decision, `lone-statement-transport` 7/7), ledger row [`../../g4.md:448`](../../g4.md) |

Classified as an RF-15 diagnostic-meta difference: `statementIndex` describes
the shipped engine's own physical layout, which this engine deliberately does
not share. The same price read from the other side is D-7 itself, which Arnaud
accepted on 2026-09-15.
