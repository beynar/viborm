# FC-00 — the frozen behavioral closure inventory

One row per **fact**, not per test cell and not per error sentence. This is the
finite surface the rest of the closure program (FC-01 … FC-06) implements
against. It is built from the public entry points, the validation surface, the
failure owners and the registered tests named under *Source identity*, and it
supersedes the refusal census as the authority on **capability**. The census
counts *sentences*; this table counts *behaviors*.

## Source identity

| fact | value |
| --- | --- |
| Branch / HEAD | `pattern-engine` @ `29a7bf9d86026e719bcad5441c5c951670f2cb6c` |
| Node / Vitest | `v24.21.0` / `3.1.4` |
| Engine perimeter | `src/query-engine/**` — 38 files, 20,333 physical lines, **16,036 parser-token-bearing lines** (`scripts/query-engine-structure.mjs`, receipt `receipts/structure-29a7bf9d8.json`) |
| Refusal census at this HEAD | **23** public sentences at 30 sites · 72 registered (inherited) · 21 invariants at 22 sites · 11 internal (private recursive fit) · 57 sites without a readable sentence · **192 sites** (receipt `receipts/census-29a7bf9d8.md`) |
| Registered raptor3 tests | `scripts/raptor3-manifest.mjs`: 187 project files, 178 deterministic, 8 credential-free provider, 29 live-provider; **2,010 declared cells** across the `*_COUNTS` groups (receipt `receipts/manifest-counts.txt`) |
| Projects | `vitest.workspace.ts`: `raptor3`, `raptor3-provider`, `raptor3-live-provider`, `coverage-raptor3`, plus the `layer-*`, `provider-*` and `coverage-*` projects |
| Public entry points | `src/client/types.ts:44` (the closed 16-member `Operations` union) → `src/client/client.ts` → `src/query-engine/query-engine.ts` (`prepare`, `build`, `execute`) → `src/query-engine/pending-operation.ts` → `src/query-engine/raptor3/route/client-route.ts` → `commands/index.ts` |
| Nested verb vocabulary | 11 verbs admitted by `src/validation/model/args/mutation.ts` and composed by `commands/relation-body.ts`: `create`, `createMany`, `connect`, `connectOrCreate`, `update`, `updateMany`, `upsert`, `set`, `disconnect`, `delete`, `deleteMany` |

## How to read a row

`admitted behavior → placement / result mode → mechanism or authority needed →
current outcome → owning rule (source) → witness → action or explicit ruling`,
plus the class.

| class | meaning |
| --- | --- |
| **1** | Supported valid operation. |
| **2** | Avoidable refusal or incorrect failure of an already-admitted operation. **Must be repaired.** |
| **3** | Necessary integrity / concurrency / provider-result failure. Keep. |
| **4** | Explicitly accepted capability limit. D-55, D-56 and D-59 stay binding. |
| **5** | Genuinely new feature or changed public contract — needs Arnaud's decision. |
| **6** | Deferred hosted qualification claim. |

Three standing cautions this inventory enforces:

1. **An error sentence is not a class.** `UPDATE did not produce the required
   record` is reached both by a genuine concurrent delete (class 3, row I-6)
   and by the cascaded-identity defect the closure review executed (class 2,
   row E-2). Repairing E-2 must not delete I-6's sentence.
2. **Inherited text is not an exemption.** The 72 registered sentences the
   census reports as "already carried by the shipped engine" are classified
   here on their behavior, in section K, exactly like the 23 public ones.
3. **A reclassification is not a capability.** Turning a public refusal into an
   `EngineInvariantError` does not enable a request — the review's legal `NOT`
   model (row E-3) reaches precisely such an invariant
   (`shared/query.ts:2171`).

## Class counts

| class | rows |
| --- | ---: |
| 1 — supported | 49 |
| 2 — avoidable refusal / incorrect failure | 5 |
| 3 — necessary integrity / concurrency / provider-result failure | 24 |
| 4 — accepted capability limit | 17 |
| 5 — new feature / changed public contract, decision needed | 4 |
| 6 — deferred hosted claim | 3 |
| **total** | **102** |

The class-2 rows are **E-1, E-2, E-3, F-4, F-6**. Their owners are FC-01,
FC-02A, FC-03, FC-02B and FC-02C respectively, all running in parallel with
this unit; none is repaired here.

No row is counted twice. `D-7`, `D-8` and `D-9` are accepted capability limits
(class 4) recorded in section D because that is where their mechanism lives;
they are not repeated in section J.

---

## A. Read verbs, cardinality and result mode

| # | admitted behavior | placement / result mode | mechanism / authority | current outcome | owning rule (source) | witness | action / ruling | class |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: |
| A-1 | `findMany` / `findFirst` / `findUnique` and both `…OrThrow` variants | root, row or rows | one prepared statement, any transport | executes; `…OrThrow` adds only the public error identity | `Queries.read` states each verb's cardinality and public shape once (`shared/query.ts`), published by `commands/index.ts:105 publishedFacts` | `tests/raptor3/g4/read-operations.test.ts` (11 cells), `g4/unit01/read-verbs.test.ts` | — | 1 |
| A-2 | `count` / `exist` | root, scalar result | one statement | executes | same read owner; SQLite count/exists normalisation qualified under D-17 | `g4/read-operations.test.ts`, `g4/read-aggregates.test.ts` | — | 1 |
| A-3 | `aggregate` (`_count/_avg/_sum/_min/_max`) with an input window | root, aggregate result | one statement; `Queries.page` supplies the `aggregated` window | executes | `Queries.aggregateExpression` over the closed `AGGREGATES` set | `g4/read-aggregates.test.ts` (5 cells) | — | 1 |
| A-4 | `groupBy` with `by`, `having`, ordering | root, grouped rows | one statement; `grouped` emits the raw signed take (the ONE named page-owner exception) | executes | `Queries.page` / `prepareHaving`; `validation/model/args/aggregate.ts` admits no cursor or distinct there | `g4/read-aggregates.test.ts`, `g4/review/unit01/having-projection.test.ts` | — | 1 |
| A-5 | Projection: `select`, `include`, `omit`, nested to-one and to-many windows | root and nested, document result | one statement; the prepared shape carries every decoder fact incl. a reversed window | executes | `Queries` projection owner; `relationShape` restores a nested negative `take` in the same decoder | `g4/read-projection.test.ts` (7), `g4/review/unit01/nested-window.test.ts` | — | 1 |
| A-6 | Filters: the 16 prepared operators over scalar, JSON and aggregate targets, with `AND`/`OR`/`NOT` and relation quantifiers `some/none/every/is/isNot` | root and nested `where` / `having` | one prepared predicate vocabulary | executes | `Queries.prepareOperations` / `lowerOperation`; one operator switch only | `g4/read-filters.test.ts` (13), `g4/unit01/filters.test.ts`, `g4/review/unit01/logical-forms.test.ts` | — | 1 |
| A-7 | A declared scalar or relation literally named `AND` / `OR` / `NOT` is that field in `where`, `having`, `count`, `groupBy` and `include` | root and nested read | admitted payload read as admitted | executes | validation builds combinators first and extends with the model's own fields (`validation/model/core/where.ts`); the engine does not re-read public syntax | `tests/raptor3/g4/parity/combinator-named-scalar.test.ts` (4 cells) | — | 1 |
| A-8 | Ordering: scalars, `{ sort, nulls }`, to-one paths, collection `_count`, distance | root and nested | `Queries.orderTerms`, the one order owner | executes | the bare direction names the provider default; `totalOrder` fills it only on the windowed path | `g4/read-ordering.test.ts` (5), `g4/review/unit01/order-cursor.test.ts`, `null-placement-parity.test.ts` | — | 1 |
| A-9 | Cursor pagination, `take`/`skip`, `distinct`, nested pagination inside a parent's correlation scope | root and nested | `Queries.page`, one operator | executes | the cursor predicate names the same total order the statement emits | `g4/read-pagination.test.ts` (6), `g4/review/unit01/order-cursor.test.ts` | — | 1 |
| A-10 | Scalar decoding for every declared leaf domain (string, int, bigint, float, decimal, boolean, date, dateTime, time, enum, json, blob, vector, GeoPoint) and their list forms | any result | one leaf decoder, reached only through `decodeValue` | executes | `Queries.fieldValue` / `decodeScalar` — one destination-aware operand owner | `g4/read-codecs.test.ts` (12), `g4/unit01/codec-roundtrip.test.ts` | — | 1 |
| A-11 | A `json` field's own declared output schema runs at the result boundary, once | any result | the row boundary | executes | D-33 / D-37; one question about a result, at the operation's own boundary | `g4/parity/json-read-schema.test.ts` | — | 1 |
| A-12 | The member list of a decoded document is the projection's fact, not the row's | any result | prepared shape | executes (repaired by D-61/P1, commit `6af1acc1e`) | the projection owner states the member list | `g4/read-projection.test.ts`; perf cell `fixed-collection-rowref-1000/parse` | — | 1 |
| A-13 | A read publishes its one `Sql` through `PendingOperation.buildStatement()` / `QueryEngine.build()` | root, any read verb | synchronous; no driver reached | executes — the same `Sql` the execution runs | `route/client-route.ts:193` returns `prepared.read?.statement`; `pending-operation.ts:748`; `query-engine.ts:127` | probe `receipts/probe-d14-build-contract.log`, cell *a read publishes its one statement* | — | 1 |

## B. Root write placement and result mode

| # | admitted behavior | placement / result mode | mechanism / authority | current outcome | owning rule (source) | witness | action / ruling | class |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: |
| B-1 | `create` with scalars, generated defaults and nested relation bodies | root, document result | one occurrence tree; RETURNING where the driver has it | executes | `Commands.plan` → `commands/execution.ts` | `tests/raptor3/fixed.test.ts`, `g4/unit02/physical-envelope.test.ts` | — | 1 |
| B-2 | `createMany` with `skipDuplicates`, with and without `select` | root, count result or selected rows | batch or interactive; identity read-back when the driver has no RETURNING | executes | `OperationContext.insert`; `assertExpectedRows` compares the read-back against the submitted count | `g3/bulk-result-boundary.test.ts` (5), `g4/parity/generated-key-reach.test.ts` | — | 1 |
| B-3 | `update` / `delete` by unique identity, with projection | root, document result | one statement on a RETURNING driver; UPDATE + read-back otherwise | executes | `OperationContext.update` / `delete` | `g4/unit02/root-delete.test.ts`, `g4/unit02/returning-safety-gate.test.ts` | — | 1 |
| B-4 | `updateMany` / `deleteMany` by filter, count result | root, `{ count }` | one correlated set statement when no capture is needed | executes | rule 6 (one statement where one statement expresses it) — restored by the parity program's U6.2 | `transitions/*-commands.test.ts`, `g3/bulk-series-contract.test.ts` | — | 1 |
| B-5 | `updateMany` / `deleteMany` with `select` — a **selected series** | root, array of selected rows | plan-time capture of the identities, then the mutation addressed by them | executes | `OperationContext.captureMutationIdentities` (`shared/operation-context.ts:2493`) + `requireCapturedSet` (`:2536`) | `g4/parity/batch-captured-bulk.test.ts` (7 cells), `g3/bulk-series-contract.test.ts` | — | 1 |
| B-6 | The same selected bulk mutation on a **batch-only** transport that holds no session | root, selected rows | the capture is a segment of its own; the premises ride inside the mutation's batch — no lock is claimed where none exists | executes | N4 / plan §4 / D-52, `operation-context.ts:2505-2520` | `g4/parity/batch-captured-bulk.test.ts` cells 1–6 | the former `Driver 'X' cannot atomically capture selected rows.` refusal is **gone from the tree** (verified: no such string under `src/`); refusals-map row #25 is stale | 1 |
| B-7 | `upsert` at root, both arms | root, document result | INSERT … ON CONFLICT where available; otherwise the conditional arm | executes | `commands/commands.ts` upsert fold | `transitions/conditional-upsert-commands.test.ts` (11), `g4/unit02/upsert-key-portability.test.ts` | — | 1 |
| B-8 | A root write's **count** result vs its **document** result are distinct publications | root | — | executes | `Queries.read` / `OperationContext` publish separately; a count is never derived from a decoded document | `g3/bulk-result-boundary.test.ts` | — | 1 |
| B-9 | A single-statement write (`create`, `update`, `delete`, non-relation `deleteMany`) **compiles to exactly one driver query** and is published as one package to the array owner | root | `prepareSingle`, synchronous, reaching no driver | executes as one statement — measured 1/1/1/1 | D-20; `commands/index.ts:228`; `pending-operation.ts:500 #resolveSinglePackage` | probe `receipts/probe-d14-build-contract.log` (`FC00 create/update/delete/deleteMany statements = 1`) | — | 1 |

## C. Nested write placement, verbs and authority

| # | admitted behavior | placement / result mode | mechanism / authority | current outcome | owning rule (source) | witness | action / ruling | class |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: |
| C-1 | All 11 nested verbs under a root `create` / `update` / `upsert` | nested, any depth | one relation body per parent, composed with its resolved slot and semantic verb order | executes | `commands/relation-body.ts` | `transitions/*-commands.test.ts` (~230 cells), `expanded/commands.test.ts` (82) | — | 1 |
| C-2 | To-one and to-many relations, self-relations, junction (m2m) relations, polymorphic / variant collections | nested | `EngineSchema` orientation by slot, not by model | executes | `storage.ts` orientation (`opposite === edge.endpoints[1]`, repaired U6.1) | `transitions/junctions-commands.test.ts` (26), `junction-identity-commands.test.ts`, `variant-removals-commands.test.ts`, `g4/unit01/variants.test.ts` | — | 1 |
| C-3 | Membership is probed on the junction, and a parent-claimed polymorphic membership whose row is gone is **refused, not silently dropped** | nested | membership premise | refuses (integrity) | `Queries` one membership predicate; `correlation()` / `memberWhere()` select the operand form only | `g4/parity/correlated-membership.test.ts`, `suppressed-membership-target.test.ts` | keep | 3 |
| C-4 | Nested `updateMany` / `deleteMany` whose `data` carries no nested relation write is **one correlated set statement**, with no planning read | nested, count result | — | executes | rule 6; parity U6.2 (family 5) | `transitions/*-commands.test.ts`, `prep/set-preparation.test.ts` | — | 1 |
| C-5 | A relation-bearing nested `updateMany` still captures, **at its own position in the declared body order** | nested | capture + series | executes | parity U6.2 invariant: a planning read exists only where one statement cannot express the operation, and runs at its body position | `g4/parity/series-member-premise.test.ts`, `member-boundary-packaging.test.ts` | — | 1 |
| C-6 | A dependent nested lookup is an **ordered observation**: the read is placed at its consumer's execution point, behind the write | nested | the dependency pass spends the overlap on placement; `flush` is the barrier on the batch route | executes under root `update` | D-51 / N1; `commands/commands.ts` dependency pass | `g4/parity/ordered-observation.test.ts`; closure-review control *ordered observation through update* | — | 1 |
| C-7 | A genuine feedback loop (a mutation depending on its own effects) is refused | nested | — | refuses with `Nested operation … depends on an earlier … write in the same nested write. Split these operations into separate queries.` | `commands/commands.ts:701, :737, :760, :840, :914` | `post-prep/g29-dependency-boundaries.test.ts`, `g29-member-dependency.test.ts` | keep — this is the honest half of the sentence E-1 reaches wrongly | 3 |
| C-8 | Repeated occurrence of the same relation body in one payload | nested | each occurrence owns its own materialized subtree; no shared replacement map | executes | `Commands.analyze` materialization within the parent's local direct-child correspondence | `core-structure/repeated-occurrence-ownership.test.ts` | — | 1 |
| C-9 | A created member re-pins its parent in every later segment, declared at the INSERT | nested, cross-segment | `Continuation.declaring` / `membershipParent` | executes | N5 | `g4/parity/member-boundary-packaging.test.ts` | — | 1 |
| C-10 | A choice (`upsert`, `connectOrCreate`, a conditional arm) forwards demands to **both** possible producers without making an untaken arm's values known | nested | `commands/assignments.ts` | executes | one owner for symbolic final fields, exact demands, contributions and provenance | `transitions/conditional-upsert-commands.test.ts` (11), `g4/review/unit01-followup/empty-arm.test.ts` | — | 1 |
| C-11 | Same-operation `connectOrCreate` duplicates converge (first create wins) | nested | the decision read plus the identity rule that makes it independent | executes | parity U6.3 (family 5) | `transitions/conditional-upsert-commands.test.ts`; pg `pg-nested-write-races.test.ts` | — | 1 |
| C-12 | Compound (multi-column) identities across capture, correlation, re-binding and publication | root and nested | the full compound tuple is retained for correlation; `disconnect` / parent-held delete cleanup / `set` departures write only `columns.fields` | executes | `clearableMembership` owns the physical removal answer | `expanded/compound-falsifier.test.ts`, `transitions/keys-commands.test.ts` (14), `g4/parity/published-key.test.ts` | — | 1 |
| C-13 | `set` on a to-many or a variant collection | nested | departures write the authoritative `columns.fields`; a junction deletes its exact membership row | executes | `clearableMembership`; the refusals-map's `Raptor 3 G1 set requires junction storage` sentence is **gone from the tree** | `prep/set-preparation.test.ts`, `g4/parity/lane-x-set-mutations.test.ts` | refusals-map row #32 is stale | 1 |
| C-14 | Supplier continuations: a value one member produces is consumed by a later sibling | nested | `RelationBody` supplier continuation | executes | `commands/assignments.ts` provenance | `transitions/supplier-continuations-commands.test.ts` (10), `shared-key-suppliers-commands.test.ts` | — | 1 |
| C-15 | Exclusive-member cardinality (a singular slot that may hold one member) | nested | — | refuses on a genuine second member (integrity) | `exclusiveMemberMove` (N5) | `g4/parity/exclusive-member-cardinality.test.ts`, `singular-slot-transition.test.ts` | keep | 3 |

## D. Authority and mechanism

"Authority" is who owns the transaction; "mechanism" is what the transport can
do. They are different questions and the engine keeps them apart.

| # | admitted behavior | placement / result mode | mechanism / authority | current outcome | owning rule (source) | witness | action / ruling | class |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: |
| D-1 | **Standalone** authority: the operation opens and owns its own region | any verb | interactive transaction where the driver has one | executes; recovery re-enters the region once with the same attribution | D-18 / D-25; `OperationContext.run` | `g3/scope-failure-contract.test.ts`, `g3/suppression-retry-contract.test.ts` | — | 1 |
| D-2 | **Borrowed** authority: the operation runs inside a caller's transaction | any verb | the caller's session | executes; borrowing grants **no** lifecycle or recovery authority | the non-negotiable design contract; `g4/unit02/borrowed-envelope.test.ts` | `g4/unit02/borrowed-envelope.test.ts` | — | 1 |
| D-3 | **Array** authority: `$transaction([ … ])` | a list of operations | the array owner takes each member's ONE prepared package (`prepare()` + `parseResult()` from the same preparation) | executes | D-20; `pending-operation.ts:500`; `client/array-transaction*.ts` | `g3/transaction-array-contract.test.ts` (4), `g4/unit02/packaged-array.test.ts`, `g4/parity/upsert-array-route.test.ts` | the `Raptor 3 atomic-array execution is not implemented.` sentence the map called dead (#31) is **gone from the tree** | 1 |
| D-4 | **Interactive** mechanism: a session held across statements | any | `FOR UPDATE` protects a capture until its mutation | executes | `operation-context.ts:2505-2512` | `g4/parity/integration-membership-race.test.ts` (PGlite) | — | 1 |
| D-5 | **Atomic batch** mechanism: several statements dispatched as one unit | any | the D-50 scratch, premises queued ahead of the write | executes | `OperationContext.flush` / `preparedBatch` | `g4/parity/batch-observed-publication.test.ts`, `transport-witnesses.test.ts` | — | 1 |
| D-6 | **Sessionless batch-only** mechanism (Neon HTTP / D1 shape): a value produced in one segment is carried into the next **as a literal** | cross-segment | each dispatched unit owns its own scratch; the value is read back at the unit's boundary and carried | executes | **D-58**; `readsBatchReference`, `TransportAttempt.carried` | `g4/parity/transport-seam-pglite.test.ts`, `transport-witnesses.test.ts`, `batch-only-drivers.ts` fixtures | — | 1 |
| D-7 | A failure in a later segment leaves earlier segments committed, and the error says so (`atomicity: "segment"`, `committedSegments`) | cross-segment | — | executes as documented; the approved progress contract, not a rollback promise | D-58; CHANGELOG "Unreleased" | `g4/parity/member-boundary-packaging.test.ts`, `g3/scope-failure-contract.test.ts` | keep | 4 |
| D-8 | A transport fact has its **own witness per driver** | — | — | PGlite establishes what PGlite establishes | **D-53** | `g4/parity/transport-witnesses.test.ts`, `transport-seam-pglite.test.ts` | keep | 4 |
| D-9 | Borrowed `createMany` with `skipDuplicates` needs an operation-owned member rollback region | nested/root under borrowed authority | a savepoint the borrower does not grant | refuses: `Raptor 3 borrowed createMany skipDuplicates requires an operation-owned member rollback region.` (`operation-context.ts:563`, `:617`) | "Borrowing does not grant lifecycle or recovery authority. No broader replay, implicit savepoints…" (design contract) | census row; `g4/unit02/borrowed-envelope.test.ts` | keep as an authority limit; **FC-04 must confirm** it is the authority rule and not an unnamed gap (listed in `remaining-decisions.md` as R-5) | 4 |

## E. The executed valid-operation failures — class 2, owned elsewhere

These are the closure review's three executed failures plus the two
source-reviewed residuals. **Do not repair them in FC-00.** Each row names the
unit that owns it. Their controls are registered neighbours and must stay green.

| # | admitted behavior | placement / result mode | mechanism / authority | current outcome | owning rule (source) | witness | action / ruling | class |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: |
| E-1 | A nested `posts.update` changes `slug`, then a sibling `edited.delete({ slug })` observes that write — **under a root `updateMany`** | root bulk placement, selected/count result | ordinary in-tree dependency placement | **FAILS**: `V7001 … depends on an earlier … write in the same nested write. Split these operations into separate queries.` The identical payload under root `update` passes. | `Commands.expandSeries` sets the operation-global `expanded` flag (`commands/commands.ts:293`, `:1433`) before materializing fresh members; `depend()` reads it as a veto (`:1029`) | red: `closure-review/paired-probes.log` cell *ordered observation through updateMany*; green control: *…through update*. Registered neighbour: `g4/parity/ordered-observation.test.ts` | **FC-01** — delete the operation-global prohibition; derive the boundary from the occurrence's construction and execution position | 2 |
| E-2 | A card whose PK is its cascading account FK: change the account id `a1`→`moved`, change the card's `label`, select the card — **with RETURNING disabled** | root document result | non-RETURNING update + read-back | **FAILS**: `TypeError: UPDATE did not produce the required record` — the right row is updated, then read back at the obsolete `a1` identity. RETURNING control passes. | `CommandExecution` materializes the cascade into `CommandAttempt.bindings`, then passes the **stale** `attempt.rows.get(command.located)` to `OperationContext.update()` (`commands/execution.ts:459-466`) | red: `closure-review/paired-probes.log` cell *cascaded current identity with RETURNING=false*; green control: *…=true* | **FC-02A** — the existing attempt binding reader supplies the current pre-write values for address, arithmetic and final identity; qualify on **local native MySQL** | 2 |
| E-3 | A captured delete with relation projection on a model whose scalar is legally named `NOT` | root selected series with relation projection | captured-set exclusion | **FAILS**: `EngineInvariantError: filter operator 'OR' is not implemented` (`shared/query.ts:2171`) — the internal `{ NOT: { OR: identities } }` is parsed as the declared field. An otherwise equivalent scalar named `flag` passes. | `CommandExecution.requireNoAddedMember` (`commands/execution.ts:938`) and `OperationContext.requireCapturedSet` (`shared/operation-context.ts:2536`) both fabricate public syntax that `Queries` already owns as prepared meaning | red: `closure-review/paired-probes.log` cell *internal captured-set predicates with NOT field*; green control: *…with flag field*. Registered neighbour: `g4/parity/combinator-named-scalar.test.ts` | **FC-03** — compose identity-set exclusion at `Queries`; delete both synthetic selector bags. Reserving `NOT`/`OR` or changing the error class is **not** the repair | 2 |

## F. Identity, reference value and capture lifetime

The cascaded current-identity fact belongs to this area but is recorded once,
at **E-2**, with the other executed failures.

| # | admitted behavior | placement / result mode | mechanism / authority | current outcome | owning rule (source) | witness | action / ruling | class |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: |
| F-1 | A captured identity of any declared key domain (int, bigint, string, decimal, canonical `dateTime`, `date`, `time`) is re-bound through the admitted wire form on a transport without RETURNING | root selected series | `admittedTemporal` — a captured temporal identity crosses the admission boundary again | executes | N5; `commands/{commands,selection,execution}.ts` capture path | `g4/parity/captured-identity-domains.test.ts`, cells *captures and re-binds a … key* (one per domain) | — | 1 |
| F-3 | An ISO `dateTime` key stored as TEXT and spelled canonically (`…T10:00:00.000Z`) stays addressable after capture | root selected series, non-RETURNING | capture decodes to `Date`, re-binding uses `toISOString()` | executes | as F-1 | `captured-identity-domains.test.ts` cell *re-binds a TEXT dateTime key the payload spelled 2020-03-01T10:00:00.000Z* | — | 1 |
| F-4 | The **same** key spelled `…T10:00:00Z` (no milliseconds) or `…T10:00:00+02:00` (offset) — both valid ISO, both stored verbatim by SQLite | root selected series, non-RETURNING | — | **FAILS**: a stale-capture refusal. `captured-identity-domains.test.ts` currently *expects* the failure — a green pin over an unrepaired capability (T3 residual) | logical instant equality does not reconstruct the physical key's bytes; the spelling's owner is the shared capture/codec boundary | green-over-red pins: `captured-identity-domains.test.ts`, the two `cannot re-bind a TEXT dateTime key…` cells | **FC-02B** — keep an internally captured identity provider-addressable while preserving public `Date` output; turn these pins into success assertions. Do not normalise all user input (unapproved contract change) and do not make two distinct stored keys compare equal | 2 |
| F-5 | A parent-held plain `connect` whose located target's referenced field is NULL is refused **by name, before any write** | nested | — | refuses: `Cannot connect relation '…': the located target's referenced field '…' is null.` (`commands/execution.ts:192`, guarded at `:185` by `origin.operation !== "connect"`) | the shared reference-representability requirement — currently only at this one arm | registered refusal (census); `transitions/required-commands.test.ts` | keep the requirement | 3 |
| F-6 | The **found** arm of `connectOrCreate` (and the equivalent supplier paths, junction and compound placements) whose referenced value is NULL | nested | — | **writes the NULL and silently disconnects the holder** — the guard at `execution.ts:185` excludes every arm but `connect` | the same requirement as F-5, applied at one arm only | N5 note `g4/release/n5/note.md` "Unverified — the repair round's residuals"; **no executed witness in the tree** | **FC-02C** — locate the shared relation/reference-value requirement and enforce it where a concrete reference becomes a relation. Do not spread verb-specific guards; do not reject all nullable-key schemas | 2 |
| F-7 | A captured set's claim is asserted **inside the batch that mutates it**: every captured row is still present, still a member, and (for a whole-selection capture) no row has joined | root and nested selected series | premises ahead of the write in the same native batch | executes | `requireCapturedSet` (`operation-context.ts:2536`); rule 5 — an observed set is not a lasting truth | `g4/parity/batch-captured-bulk.test.ts` cells *a captured row lost…* and *a row that JOINED…* | — | 1 |
| F-8 | The **lifetime** of that requirement under real concurrency: an EXISTS premise followed by an ID-only mutation, with another transaction changing a member while holding a row lock | root and nested selected series | local native PostgreSQL schedule through the existing transaction/batch owners | **unproven.** A preceding non-locking SELECT and a later successful row count do not alone establish consumption-time membership. This is a source-derived concern, **not** an executed result. | `requireCapturedSet` / `requireNoAddedMember`; the operation contract states which predicate is a lasting requirement and which is only the initial collection's observation | no witness — the PGlite cell `g4/parity/integration-membership-race.test.ts` is not a native-PostgreSQL lock schedule | **FC-03** — establish the correct expected result from the operation contract first, then falsify with a local native PostgreSQL schedule, plus a truly irrelevant concurrent change. Do **not** prescribe blanket `FOR UPDATE`, serializable isolation or a post-commit count check | 3 |
| F-9 | The initial collection filter of a selected series is an **observation**, not a requirement on every later member | root selected series | — | preserved | the distinction is a necessary one (rule 12) | `g4/parity/series-member-premise.test.ts`, `blind-premise-attribution.test.ts` | keep the distinction; FC-03 must not collapse it | 1 |
| F-10 | Original observations are preserved where choices need them; current bindings are consumed where effects need current values | any | — | the distinction holds in principle; **E-2** is where it is currently broken | the non-negotiable design contract | `post-prep/g29-dependency-choices.test.ts` | keep the distinction — repairing E-2 must not merge the two | 1 |

## G. Result publication and failure composition

| # | admitted behavior | placement / result mode | mechanism / authority | current outcome | owning rule (source) | witness | action / ruling | class |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: |
| G-1 | Dispatch failure, acknowledged-result decoding failure, listener failure and cardinality rejection are **four different timings** | any | — | distinct | rule: do not merge all result catches | `g4/unit02/malformed-result-cuts.test.ts`, `g3/author-execution-regressions.test.ts` | keep distinct (FC-05 must not flatten them) | 1 |
| G-2 | A primary failure plus ordered listener failures compose under **one** rule, preserving primary identity, cause, order and the operation's answered/progress marking | any | — | executes — but through **two** implementations: `OperationContext.retainOutcomeFailure()` duplicates the exported `retainWriteOutcomeFailure()` in `src/extensions/query.ts` | one error-composition owner | D-58's held-listener regression witness; `g4/unit02/uncertain-outcome-meta.test.ts` | **FC-05.1** — use the existing owner; count moved code; retain D-58's witness. No capability change | 1 |
| G-3 | Carrying one scalar expression across a segment boundary | cross-segment | `carryScratch()` → `OperationContext.referenceProjection()` → `Queries.lowerProjectionValues()` | executes, through a generic select/map/assert detour with exactly one production caller that always asks for one field | the scalar's physical shape and codec, not a user projection | `g4/parity/transport-seam-pglite.test.ts`, `postgres-declared-type-scratch.test.ts` | **FC-05.2** — compose the scalar-expression query at `Queries`; keep scratch lifetime and statement count unchanged. No capability change | 1 |
| G-4 | An operation keeps **one identity** per client call, including in a malformed-scalar decode | any | — | executes | N5 class-A/D re-expression | `g4/unit02/malformed-result-cuts.test.ts` | — | 1 |
| G-5 | Uncertain-outcome metadata is published, and an uncertain outcome is never retried | any | — | executes | "no uncertain-outcome retries" (design contract) | `g4/unit02/uncertain-outcome-meta.test.ts` | keep | 4 |

## I. Necessary integrity, concurrency and provider-result failures — keep

Each row is a class-3 **fact**, not a sentence; the census's 30 public sites and
many of its 72 registered ones collapse into these. Removing any of them is not
"reducing unsupported operations".

| # | admitted behavior that fails | placement / result mode | mechanism / authority | current outcome | owning rule (source) | witness | action / ruling | class |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: |
| I-1 | A driver returns no entry for a prepared read it was handed | any | prepared-batch protocol | `Driver '…' omitted the prepared result for operation '…'.` (`operation-context.ts:1127`, `:1905`, `:2591`) | no other owner checks the driver's returned array against what it queued | census; `g4/unit02/prepared-operation.test.ts` | keep | 3 |
| I-2 | A driver reports fewer/more inserted rows than submitted | `createMany` | — | `Driver '…' reported N of M inserted rows…` (`:2250`) | affected-row counts are execution semantics (rule 4); parity U5.5 | `g3/bulk-result-boundary.test.ts` | keep | 3 |
| I-3 | A `createMany` terminal read-back returns more rows than the submitted count | `createMany({select})` | genuine race: a key moved or collided between capture and read-back | `Raptor 3 createMany final read returned inconsistent row counts.` (`query.ts:4360`) | `assertExpectedRows` | census | keep | 3 |
| I-4 | A driver cannot supply the identity of a row it says it inserted | `createMany`, batch | `insertId` absent after a reported success | `INSERT did not produce the required record identity` (`:2168`) | — | census | keep | 3 |
| I-5 | A single-row INSERT succeeds and returns/locates nothing | root create / upsert fold | — | `INSERT did not produce the required record` (`commands.ts:1597`, `:1663`, `operation-context.ts:2781`) and the `… ON CONFLICT …` / `… RETURNING …` variants (`commands.ts:1623`, `:2862`) | three call sites share one sentence | census | keep | 3 |
| I-6 | The row just updated is deleted by another transaction before the follow-up SELECT | root update, non-RETURNING | — | `UPDATE did not produce the required record` (`:3020`, `:3057`) | — | census | keep — **and note it is the same sentence E-2 reaches wrongly**; FC-02A must leave this reach intact | 3 |
| I-7 | The RETURNING update statement answers zero rows for a captured identity | root update, RETURNING | — | `UPDATE RETURNING did not produce the required record` (`:3033`) | — | census | keep | 3 |
| I-8 | The selected row set changes during a locked bulk mutation | selected `updateMany` / `deleteMany` | — | `updateMany` / `deleteMany` `selected-row cardinality changed during its locked mutation.` (`:2372`, `:2462`) | cardinality is an execution fact | `g4/parity/batch-captured-bulk.test.ts` | keep | 3 |
| I-9 | A captured row disappeared, or a new row joined the selection, between capture and mutation | selected series | premises inside the mutation's batch | aborts **before** the write | `requireCapturedSet` | `batch-captured-bulk.test.ts` cells 3–4 | keep | 3 |
| I-10 | A concurrent membership change removes the captured owner of a singular polymorphic member | nested | — | `Concurrent membership change on … retry to converge.` (`:3174`, `:3257`, registered) | — | `g4/parity/suppressed-membership-target.test.ts` | keep | 3 |
| I-11 | A provider value is not a row / not an array / null where the shape is non-nullable | any decode | the one row boundary | `InvalidScalarResult`: *a document the statement always builds is null*, *a requested document is not a provider row*, *a requested relation is not a provider array* (`query.ts:4478`, `:4489`, `:4496`) | D-17 / D-28: the transport is asked about a value **exactly once**, at the row boundary | `g4/read-codecs.test.ts`, `g4/review/unit01/decode-strictness.test.ts` | keep | 3 |
| I-12 | A provider value is outside its declared leaf domain (31 registered `InvalidScalarResult` sentences: canonical integer, safe range, exact decimal at scale, provider timestamp, UTC-midnight date, provider time, enum member, binary value, finite-number vector, declared dimension, JSON value domain, sparse array, …) | any decode | — | `InvalidScalarResult` through `QueryEngineError` | one leaf decoder; the adapter/driver result-parser chain is consumed here (D-17) | `g4/read-codecs.test.ts` (12), `g4/parity/driver-result-parser.test.ts` | keep — **one fact**, not 31 capabilities | 3 |
| I-13 | Four real decoder holes the parity program closed (non-nullable `_count` carrier decoding `null`; inherited-property field reads; raw `TypeError`s not translated; `groupBy` collisions) | any decode | — | fail closed, as `QueryEngineError` | parity U5.3 — the other nine deleted shape checks are structurally redundant because the output is built from the prepared shape | `g4/review/unit01/decode-strictness.test.ts` | keep | 3 |
| I-14 | A polymorphic membership the parent claims whose row is gone; an unknown polymorphic target tag | nested read/write | — | refused, not silently absent (`query.ts:4459`, `:4466`, `:3840`, registered) | derive "linked but absent" from the arm's own selected key, no private carrier (ruling C-Q3) | `g4/unit01/variants.test.ts`, `g4/review/unit01/variant-arms.test.ts` | keep | 3 |
| I-15 | An empty `createMany`; a `select` with no truthy value; a `having`/`groupBy` field outside `by`; an empty scalar or relation filter; a non-portable JSON path | admission | — | refused at admission | D-27 (the empty-filter refusal moved to admission), D-31 (empty `createMany`), rule 4 | `tests/contracts/engine/query/parity-admission.core.test.ts`; `src/validation/scalars/negatable-filter.ts:42` | keep | 3 |
| I-16 | A relation key field set to null while mutating that relation; a located target's NULL referenced field (F-5) | nested | — | `NestedWriteError` (`commands/execution.ts:100`, `:192`, registered) | "a null reference names no row for that relation to point at" | `transitions/required-commands.test.ts` | keep — F-6 **extends** this requirement, it does not remove it | 3 |
| I-17 | A cached result snapshot is malformed, or a result cannot be represented by the cache result codec | route cache | — | `CacheConfigurationError` (`route/client-route.ts:278`, `:291`, registered) | the route seam owns the cache representation | `g4/parity/lane-x-route-seam.test.ts` | keep | 3 |
| I-18 | A driver supports neither transactions nor atomic batch execution | any write | — | `Driver "…" supports neither transactions nor atomic batch execution.` (registered) | a mechanism the engine cannot supply | census | keep | 3 |
| I-19 | A non-returning upsert whose public result parsing cannot be rolled back after an atomic batch commits | root upsert, batch-only | — | `TransactionError` (registered, `operation-context.ts:866`) | progress gates are not deleted | `g4/unit02/returning-safety-gate.test.ts` | keep | 3 |

## J. Accepted capability limits — binding

| # | admitted behavior refused | placement / result mode | what is missing | current outcome | owning ruling | witness | action / ruling | class |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: |
| J-1 | Atomic output for a produced field that is not one `increment` key, on a provider whose RETURNING cannot be segmented | root create, batch | a typed scratch read per produced domain | `Raptor 3 G1 atomic output requires exact identity scratch or segmented RETURNING` (`:2833`) | **D-55 (binding)** | census; `g4/unit02/physical-envelope.test.ts` | keep; do not widen the scratch without a ruling | 4 |
| J-2 | Naming the updated value of a decimal **relation** key under `multiply` / `divide` | nested | the provider owns that operator's rounding inside its own assignment | `Raptor 3 cannot name the updated value of '…' under '…'` (`query.ts:1162`) | **D-56 (binding)** | `g4/unit02/key-arithmetic.test.ts` | keep | 4 |
| J-3 | Locating one selected `createMany` row after insertion when the generated identity is not a single `increment` key, on a non-RETURNING driver | `createMany({select})` | a database-side default spelling; MySQL refuses two `AUTO_INCREMENT` columns at DDL (errno 1075, measured) | `Driver '…' cannot locate one selected createMany row after insertion.` (`:2126`) | **D-59 (binding)** | `g4/parity/generated-key-reach.test.ts`, `increment-key-width.test.ts` | keep; the map's "reachable" column corrected by D-59 | 4 |
| J-4 | Interactive output requiring RETURNING or one generated `increment` field | root create, interactive, non-RETURNING driver | same as J-3 | `Raptor 3 interactive output requires RETURNING or one generated increment field` (`:2753`) | **D-59 (binding)** | as J-3 | keep | 4 |
| J-5 | Arithmetic updates on a non-portable primary-key scalar type; dividing a primary key or a decimal field by zero; more than one update operation on a primary key | root/nested update | portable semantics across providers | `QueryEngineError` (`shared/schema.ts:204`, `query.ts:1052`, registered) | inherited; adjacent to D-56 | `g4/unit02/key-arithmetic.test.ts` | keep | 4 |
| J-6 | GeoPoint `distance` in filter, `orderBy` or `select` on a provider whose adapter has no distance tier; GeoPoint at all without a physical point tier; `within polygon` | root/nested read | a provider tier the engine refuses to emulate in JavaScript | `FeatureNotSupportedError` (`query.ts:2339`, `:863`, `:2124`) | inherited; "never emulates a tier in JavaScript" (AGENTS.md) | `g4/unit01/geo-capability.test.ts`, `g4/review/unit01-followup/distance-parity.test.ts` | keep | 4 |
| J-7 | Vector distance select/order without a pgvector-enabled PostgreSQL driver; a nullable vector field in a distance select; a dimension mismatch | root read | provider tier | `FeatureNotSupportedError` / `QueryEngineError` (`query.ts:2317`–`:2331`) | inherited | `g4/unit02/vector-capability.test.ts` | keep | 4 |
| J-8 | Cursor pagination over a relation or vector-distance `orderBy`; a null cursor field; paginated scalar ordering with no primary identifier | root read | a total order the cursor predicate can name | `QueryEngineError` (`query.ts:2614`, `:2742`, `:2850`, `:2814`, registered) | inherited; the cursor names the same total order the statement emits | `g4/review/unit01-followup2/cursor-refusal.test.ts`, `unit01-followup3/cursor-refusal-sweep.test.ts` | keep | 4 |
| J-9 | A `_distance` result selected beside a model field named `_distance`; more than one `_distance` per select | root read | a name the result shape cannot carry twice | `QueryEngineError` (`query.ts:3643`, `:3650`, `:3664`, registered) | D-24 restored the registered sentence | `g4/review/unit01/distance-projection.test.ts` | keep | 4 |
| J-10 | A field reference comparing columns of different models, naming a non-scalar, or comparing two decimals of different precision/scale | root/nested filter | exact comparison semantics | `QueryEngineError` (`query.ts:1693`–`:1704`, registered) | inherited; exactness | `g4/review/unit01-followup2/decimal-fieldref.test.ts` | keep | 4 |
| J-11 | A decimal field without declared precision and scale; an inexact decimal value or list member; a `having` `_sum` operand outside the exact cast domain | any | an exact value to bind | `QueryEngineError` (`shared/decimal.ts:56`, `:66`, `:85`; `query.ts:2217`, registered) | inherited; exactness over silent rounding | `g4/unit02/decimal-having-operand.test.ts`, `g4/review/unit01-followup3/decimal-domains.test.ts` | keep | 4 |
| J-12 | JSON filter grammar: `path` combined with a whole-column sentinel; a `path` operator needing a number/string operand; non-portable path spellings | root/nested filter | one portable path rule | `QueryEngineError` (`query.ts:2249`, `:2271`, registered) | D-22 (the `mode` asymmetry kept as one target-kind fact), Lane Q | `g4/review/unit01-followup2/json-sentinel.test.ts`, `unit01-followup3/json-sentinel-sweep.test.ts` | keep | 4 |
| J-13 | Encoding a cached result for a verb that publishes no prepared read | route cache | one upstream owner reconciling `CACHEABLE_OPERATIONS` (9 names) with the engine's `READ_OPERATIONS` (7) | `UnsupportedOperationError` (`route/client-route.ts:212`) | kept deliberately as a capability boundary (N4, plan §4) — an assertion here would establish a missing fact, not state an established one | `g4/parity/lane-x-route-seam.test.ts` | keep | 4 |

## K. The 72 inherited sentences — where each one lands

The handoff calls these "the 71 inherited sentences"; the census at this HEAD
reports **72 registered distinct sentences at 72 sites** (`receipts/census-29a7bf9d8.md`;
the N5 note's 71 is the count at N4's tree, before N5 re-added two registered
sentences). "Registered" means only *the shipped engine spelled it too* — it is
a provenance fact, and **not** an exemption from classification. Every one of
them is classified above; none is a class-2 row and none is left unclassified.

| inherited group (sentences) | row |
| --- | --- |
| Leaf-domain decode refusals, `InvalidScalarResult` (31) | I-12 |
| Polymorphic missing record / unknown target (2) | I-14 |
| Admission legality: empty `createMany`, empty `select`, `having`/`groupBy` outside `by` (4) | I-15 |
| Relation key null / located NULL reference (2) | I-16, F-5 |
| Cache snapshot and cache-codec representability (2) | I-17 |
| Driver mechanism absent; non-returning upsert rollback (3) | I-18, I-19 |
| Driver omitted the terminal/prepared result (2) | I-1 |
| Concurrent singular polymorphic membership change (1) | I-10 |
| Primary-key arithmetic portability, divide-by-zero, one operation per key (4) | J-5 |
| GeoPoint tier, within-polygon (2) | J-6 |
| Vector tier, nullable vector, dimension mismatch, vector ordering (4) | J-7 |
| Cursor pagination limits (3) | J-8 |
| `_distance` naming and cardinality (2) | J-9 |
| Field-reference comparability, incl. decimal precision/scale (3) | J-10 |
| Decimal declaration and exactness, `having` `_sum` operand domain (4) | J-11 |
| JSON filter grammar (2) | J-12 |
| Unknown update operation (1) | I-15 (admission) |
| **total** | **72** |

## L. Decisions and deferrals

| # | subject | placement / result mode | what it would need | current outcome | owning rule (source) | witness | decision required | class |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: |
| L-1 | **The public build contract (D-14).** `buildStatement()` / `QueryEngine.build()` answering a folded single-statement write | root `create` / `update` / `delete` / non-relation `deleteMany` | nothing new: the `Sql` already exists synchronously — `prepareSingle` publishes a one-query package for exactly these verbs (row B-9) | reads answer their `Sql`; **every** write answers `undefined`, so `QueryEngine.build()` raises `Operation '…' does not compile to one SQL statement. Execute the operation instead.` — including a scalar `delete` on a RETURNING driver | `route/client-route.ts:193` publishes `prepared.read?.statement` only; D-14 (2026-09-16 22:25) promised *"every read, a folded single-statement write"*; cutover round 3 applied the read half only; CHANGELOG "Unreleased" documents every write as refused | measured: `receipts/probe-d14-build-contract.log` — four write verbs answer `undefined` while executing exactly **one** statement each | **PENDING — Arnaud.** Two options, costs in `remaining-decisions.md` R-1. Do not silently choose either | 5 |
| L-2 | **The private recursive-read fit (D-54).** `Queries.recursive`, `decodeRecursive` and the route's recursive cache codec are built and unit-tested; no public verb, argument or schema option reaches them | would be root + nested, depth-published shape | a public verb/argument in `commands/` that calls the existing `Queries.recursive` owner — a **new public language** | unreachable: privacy re-checked this run by the census (`.recursive(` / `kind: "recursive"` named nowhere in `src/**` outside `shared/query.ts`) | D-54; the 11 internal sentences of the census's *private fits* section | `tests/raptor3/g4/read-recursive-fit.test.ts`, `g4/unit01/recursive-vocabulary.test.ts`, `g4/unit02/recursive-codec-fit.test.ts`, `prep/recursive-read-fit.test.ts` | **PENDING — Arnaud.** `remaining-decisions.md` R-2. Wiring it is a new public contract, not an FC-04 refusal removal | 5 |
| L-3 | **A database-side default spelling.** Every key generator the schema offers is a JavaScript closure evaluated at admission; there is no way to declare a server-side default | schema declaration | a new public schema vocabulary | absent — this is *why* J-3 / J-4 are unreachable in a pushed schema | D-59 explicitly declined it as "a public-contract change, a separate program" | — | **PENDING — Arnaud** (declined once, recorded). `remaining-decisions.md` R-3 | 5 |
| L-4 | **A stronger consumption-time membership guarantee**, if F-8's native schedule shows the current premises do not hold | selected series | a bounded public guarantee or a new recovery authority | unknown until F-8 is executed | FC-03's contract | — | **CONDITIONAL — Arnaud**, only if FC-03's witness demands it. Request the bounded decision; do not silently weaken correctness or refuse a family. `remaining-decisions.md` R-4 | 5 |
| L-5 | **Hosted Neon HTTP.** The cross-segment literal-carrying shape (D-6/D-7) is pinned on a Neon-shaped SQLite fixture; the live cell skips unless `NEON_TEST_DATABASE_URL` is set | cross-segment | a hosted credential | **deferred by Arnaud**; not a gate for this checkpoint | D-58's "Unverified" paragraph | `tests/providers/**/neon-http-transport.test.ts` (gated, skips) | state as deferred; do not request secrets | 6 |
| L-6 | **Hosted D1.** D1 test source exists; source presence is not a passing receipt | cross-segment | a hosted credential | **deferred**; no live D1 witness in the repository | same | `vitest.d1.config.ts` and its suites | state as deferred; FC-06 must not present source presence as evidence | 6 |
| L-7 | **Native local MySQL** qualification of the non-RETURNING cascaded-identity path (E-2) | root update | a Docker MySQL lane run | capability-forced non-RETURNING SQLite is **not** a native MySQL receipt | the closure review's own limit statement | Docker lane `tests/providers/docker/mysql2.test.ts` | **FC-02A owes it.** Not hosted, not deferrable — it is local and required | 6 |

---

> **Addendum — the final local closure (2026-09-21, after the frozen gate on `closure-r`).** The rows below moved; the table above is the inventory as frozen by FC-00 and is not rewritten. **F-6** (a found `connectOrCreate` reference reading NULL) and the two residuals FC-02C recorded beside it (the CREATE arm producing a NULL referenced value; the child-held direction) are **discharged by R1**: one requirement at `CommandExecution.stored` over every record statement's write values — a concrete tuple that becomes an explicit relation must be representable, all components present and non-NULL — with `Commands.assignMembership` as the sole reader of the resolved edge; both directions, found and produced arms, compound references, root and nested placement; controls keep nullable scalars, explicit disconnect and junction pairs legal (`reference-representability` 26 cells, native pg and mysql2 witnesses). **F-8 and L-4** are **closed by R3 under D-65 (adopted)**: a root selected `updateMany`/`deleteMany` carries the complete captured identity set AND the prepared selector in its effect (`OperationContext.capturedTarget` composing through `Queries.includeIdentities`), so a captured row that stopped matching is not mutated and the fewer-rows outcome is the existing cardinality error with truthful acknowledged progress; a nested captured series is a bounded worklist — the pre-unit added-member premise and its recovery stay, a member added after that boundary is outside the worklist (17 cells on native PostgreSQL, default and capability-forced routes). **L-1** stands closed by D-64, whose witness is now registered in the normal inventory (`read-only-build-contract`, R4). **L-7** is **discharged by R2 under D-66 (adopted)**: native MySQL is part of local qualification — the schema-attestation owner repaired (R2a), the exposed behaviour repaired (R2b: ordered pages, list-member codecs, the createMany fold pin), the deadlock policy stated (R2c under D-67: a deadlock victim fails visibly, no replay, no isolation change, the unique-key race still converges) — the lane reads **735 passed / 1 skipped / 0 failed** at the frozen gate (was 589 / 160 / 1). **I-6** keeps its sentence, now reached by three more shapes on purpose (R2c's unlocked probes demand the target's keys so a row moved under a found arm is refused, not silently connected). **L-2, L-3, L-5, L-6** unchanged; hosted qualification stays deferred. **D-9** unchanged (confirmed by FC-04).

> **Addendum — recursive queries (2026-09-23, the recursive-query commit over `076fad02b`).** **L-2** is decided and discharged. Arnaud requested public recursive queries in the same release (2026-09-21), which answers R-2. D-54's private fit is retired, and `recurse` is a public relation-node option in `select`/`include` (`features-docs/recursive-query.md`; verdict `recursive-query/rq07-release-verdict.md`). The census's private-fit bucket was empty at the final gate (`recursive-query/gate-3/census.log`); the pre-merge elegance pass then removed it from the census (`recursive-query/rq07-elegance-pass.md`, F28).

## M. D-16 reconciliation — by current family status

The ledger carries two statements that cannot both be current: `d82c123b`'s
*"D-16 all 115 repaired"* and, three days later, *"the D-16 families Arnaud has
not ruled on"* (the Release verdict record after commit 31, 2026-09-20 evening, and the Release-verdict addendum).
Read against `g4/cutover-execution/note.md` R3.2/R4.2, `docs/architecture/raptor3-parity-plan.md`
and the ledger's own D-16 records, the reconciliation is:

**Every D-16 family is ruled. No family is awaiting Arnaud.**

1. **The ruling.** *D-16 decided (morning, 2026-09-17)*: Arnaud ruled on all
   twenty-one families — relation-filtered bulk mutations, operator bags, JSON
   path filters, read regressions, decimals and scalars, polymorphic
   collections ("absolutely"), the races (converge), interceptors and write
   outcomes — **"all repaired now, before any push"**, plus one correction
   (`where: { name: {} }` must be refused at admission; `where: {}` matches
   everything) and one severity call (the MySQL spatial index is repaired).
2. **The two analyses he asked for were produced and answered.**
   *Result-shape checks* (R4.2 family 19, 13 cells) → parity plan U5.3: four
   are real decoder holes and were repaired; the other nine are structurally
   redundant, because the output is built from the prepared shape (plan §5).
   *Stricter nested writes* (R4.2 family 5, 5 cells) → parity plan U6.2/U6.3:
   Arnaud's suspicion was confirmed — a nested `updateMany`/`deleteMany` with
   no nested relation write is one correlated set statement again, and
   same-operation `connectOrCreate` duplicates converge.
3. **The derived decisions are all closed.** D-17…D-26 and D-30 applied at
   `d82c123b`; **D-27 accepted** and **D-31 confirmed** (Arnaud, 18:11
   2026-09-17); **D-28, D-29, D-32** ruled and applied at `fd441c7f` with
   D-33/D-34/D-36/D-37.
4. **The later "not yet ruled" sentences are stale status paragraphs.** They
   were written after the ruling and are contradicted by it and by
   `d82c123b`'s own commit record. They are superseded here; the guide
   addendum beside them says so.

### What actually remains from the D-16 surface — two items, both already owned

| item | what it is | witnessing cell | owner |
| --- | --- | --- | --- |
| **M-1** | Family 5's refusal sentence still reaches an admitted shape it must not: a dependent nested composition under root `updateMany`. This is **not** an unruled family — it is a new class-2 defect *inside* the family D-16 ruled must execute (row E-1). | `docs/architecture/raptor3-evidence/g4/release/closure-review/paired-probes.log`, cell *review: ordered observation through updateMany* (red); control *…through update* (green) | **FC-01** |
| **M-2** | The pg `batchPrimaryKeyDataflowContract` registration, kept red at the cutover as "a recorded engine limitation" (5 cells). D-58 subsequently executed the cross-segment value carrying that this contract pins, so the record may be obsolete — but its status at this HEAD is **unmeasured** (Docker lane; not run by this unit). | `tests/providers/docker/pg-nested-write-races.test.ts:115` and `tests/providers/local/sqlite3-polymorphic-batch.test.ts:82` | **FC-06** (the one frozen qualification) — measure it and either retire the "kept red" record or restate it |

**Do not reopen the 115 resolved cells and do not put repaired approved work
back on Arnaud.**

## N. The refusals map is stale — six rows no longer exist

`g4/release/plan/refusals-map.md` was written against `464705acc`, before the
parity, N-series and M1 programs. Six of its 55 rows name sentences that are
**not in the tree at `29a7bf9d8`** (verified by grepping each exact sentence
under `src/`). This matters because FC-04 is told to work from this inventory,
not from the map.

| map row | sentence | status at this HEAD |
| --- | --- | --- |
| #23 | `Cannot publish the updated value of '…' … inside an atomic batch` | gone — the batch scratch limitation it named no longer refuses (see D-6); witness `g4/parity/batch-observed-publication.test.ts` ("a bigint key and a decimal key publish through the same observation", "the observation is taken BEHIND the write") |
| #25 | `Driver '…' cannot atomically capture selected …  rows.` | gone — selected bulk mutations execute on batch-only transports (row B-6) |
| #31 | `Raptor 3 atomic-array execution is not implemented.` | gone — the map's own DELETE disposition, applied |
| #32 | `Raptor 3 G1 set requires junction storage` | gone — row C-13 |
| #48 | `Raptor 3 G1 physical field is not implemented: …` | re-expressed as the invariant `'…' is neither a declared scalar of '…' nor one of its variant carrier columns.` (`shared/storage.ts:248`) after the N4 review reached it through a legally-named field (row A-7) |
| #49 | `Raptor 3 G1 variant carrier membership is not implemented: …` | re-expressed as the invariant at `shared/storage.ts:72` |

The map's remaining substantive rows are carried into sections I, J and L above.
Its ranked "ten sentences whose removal would most widen behavior" list is
correspondingly obsolete at positions 1 (recursive — now L-2, a decision, not a
refusal), 2, 5, 6 and 7.

## O. Unverified — stated once

1. **F-6** (the found-`connectOrCreate` NULL reference) has **no executed
   witness** anywhere in the tree. It is carried from the N5 note's
   "Unverified" paragraph and from the source shape of the guard at
   `commands/execution.ts:185`. FC-02C must execute it before repairing it.
2. **F-8** (capture-premise lifetime under concurrency) is a source-derived
   concern. No native PostgreSQL lock schedule has been run, here or by the
   closure review.
3. **M-2** (the kept-red pg registration) was not measured by this unit: the
   Docker lanes are out of scope for a docs unit and out of scope for
   "no wide runs".
4. **Native local MySQL and PostgreSQL** were not run by this unit. Every
   provider-shaped claim above is either sourced to an existing receipt or
   marked as owed (L-7).
5. The row counts in this inventory are **facts**, deliberately not test cells.
   A class-1 row may be witnessed by one cell or by two hundred; the witness
   column names the discriminating file, not an exhaustive list.
6. The D-14 probe (`receipts/probe-d14-build-contract.log`) ran on in-process
   SQLite with `RecordingSQLiteDriver` only. It establishes the *count* of
   statements each write verb compiles to on a RETURNING driver; it does not
   establish which writes stay single-statement on a non-RETURNING driver.
