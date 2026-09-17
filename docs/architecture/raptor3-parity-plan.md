# Raptor 3 parity plan — closing D-16 at the owners that hold the truth

Status: proposal for Arnaud, 2026-09-17. Inputs: the three read-only analyses under
`docs/architecture/raptor3-evidence/g4/parity/` (A filters and reads, B values,
codecs and shape, C writes, races and observability), the cutover note
(`g4/cutover-execution/note.md` R3.2, R4.2) and the twelve rules of
`g4/briefs/common.md`, re-affirmed by Arnaud for this work. Base: `356254a2`
(commit 5). Nothing here is applied yet.

## 0. What the 115 cells actually are

Every red cell reproduces on the pre-cutover tree with the candidate route, so
none is a cutover effect. Grouped by the truth they touch, the 115 cells (and
the ten deleted `sql-generation` and `cursor-pagination-sql` cells that were
their earlier witnesses) reduce to **fourteen root causes at seven owners**.
Three "defects" are not: the duplicate-key cursor paging is proven correct (the
cell counts a private alias spelling), the "vector cursor crash" is two
refusals raised in the wrong order, and the refusal wording `Driver "x"` is the
surviving driver seam's own sentence, unchanged since before the cutover.

The plan fixes causes, not cells. Each unit names one owner, the invariant it
restores, and a falsifier that reddens if the fix is wrong. No unit may
reconcile two representations of one fact, add a second public-syntax walker,
a policy boolean, a per-verb codec or a wrapper file.

## 1. Owners and units

### U1 — Admission: the shapes the validation layer must refuse
Owner: `src/validation/**` (the one public-syntax walker), reached through
`EngineSchema.admit → parseValidated` (`raptor3/shared/schema.ts:193-227`).
Rule 4: validate once at the genuine admission boundary; trust downstream.

1. An **empty filter object is not a filter.** `where: { name: {} }`,
   `where: { posts: {} }` and a JSON filter with only `path`/`mode` state no
   operation and today lower to `TRUE` (`query.ts:1214-1250`, `:1373-1377`,
   `:299-301`), so `updateMany`/`deleteMany` touch every row. The per-scalar
   filter objects (`validation/scalars/*.ts`, finished in
   `negatable-filter.ts:44-55`) and the relation filter objects gain
   `nonEmpty` + `requiresOneOf(<operator keys>)` — the two options
   `primitives/object.ts:54-55` already implements and `where.ts:165-170`
   already uses for `whereUnique`. `where: {}` keeps matching everything.
   Sentences: the registered `Filter for field '<f>' must contain at least one
   operation.` and `Relation filter '<r>' requires one of: some, every, none`
   (to-one: `is, isNot`).
2. **JSON path grammar and portability are admission facts.** The JSON filter
   schema (`validation/scalars/json.ts:131`) admits `path: string | string[]`
   and today the preparer drops the string form (`query.ts:1233`), so
   `path: "$.theme"` silently filters the document root. Admission parses the
   string form into segments once (the grammar and its six refusal sentences
   of the deleted `json-filter-builder.ts:49-114`), asserts portability (no
   `"` or `\` in a segment, `:216-224`) on every dialect, and refuses an inert
   `mode` (a declared `insensitive` with no string operator and a sentinel
   `not`, `:199-214`). The preparer consumes segments only. The SQLite adapter's
   throw at `sqlite-adapter.ts:182` stays as the defensive backstop it claims
   to be, converted to the engine's error class.
3. **`groupBy` arguments.** `by` is admitted as `string | string[]`
   (`aggregate.ts:859`) and never normalised, so `by.map` crashes; a duplicate
   `by` member and a grouped scalar named `_count`/`_avg` colliding with the
   aggregate of the same name are silently accepted (`query.ts:3426-3444`).
   Admission normalises `by` to an array and refuses duplicates and the
   collision (the registered `select-builder.ts:367` sentence).
4. **Two refusals lost their owner.** The nested default-only
   `createMany { skipDuplicates }` refusal lives on the physical owner
   (`operation-context.ts:1379-1382`) and never sees a nested `createMany`
   (expanded row by row at `relation-body.ts:302-326`); it moves to the
   `createMany` admission arm so root and nested ask once. The empty
   `createMany` on the batch-preparation seam (`No data to insert`) returns on
   `prepareBatch` only; the direct path keeps Prisma's `{ count: 0 }`.

Invariant: an admitted `where`, `by` and `data` are complete facts; no
preparer re-reads public syntax or discovers a missing operation.
Falsifiers: the eleven family-18 cells; `updateMany/deleteMany({ where: { name: {} } })`
refuses while `findMany({ where: {} })` matches all; `by: "category"` groups;
`by: ["a","a"]` refuses; the same non-portable path refuses on all three
dialects; `client.$transaction([createMany({ data: [] })])` refuses and the
direct call answers `{ count: 0 }`.

Open ruling for Arnaud (A-Q1/Q2): a filter object that becomes empty only
after `undefined` members are dropped, and `not: {}`, count as empty. The
plan takes "empty" (the old lowering rule) unless he says otherwise.

### U2 — Queries lowering: one statement means what it says
Owner: `raptor3/shared/query.ts` (lowering half). Rule 1: one predicate, one
lowering; rule 11: the adapter spells dialect SQL, `Queries` composes it.

1. **The mutation selector is unqualified** in `lowerMutationLimit`'s no-limit
   branch (`:1052-1059`), so `lowerRelationPredicate`'s `parentAlias ?? ""`
   (`:1928`) emits the parent column bare and the correlated `EXISTS` rebinds
   to the child table: `some` → 0 rows, `none`/`every` → all rows. Eighteen
   cells, data loss. Fix: lower with the target's SQL table name as the
   correlation alias, as `operations/update.ts:79-90` did; and reinstate the
   derived-table wrap when `!adapter.capabilities.supportsMutationTargetInSubquery`
   (MySQL error 1093, a capability the candidate never consumes). Falsified
   live by the analyst: 17/17 counts and 4/4 unique-where arms correct.
2. **A raw `Sql` operand is not parenthesised** (`:533-534`, `:548-551`;
   `where-builder.ts:472` did). One line at the one operand-binding owner.
3. **Two refusals in the wrong order.** `orderTerm`'s `_distance` arm lowers
   the expression and consults the provider capability (`:2084 → :1889`)
   before `page` (`:2205`) can say the order is not cursor-eligible. Thread the
   windowed fact into the one order walker so the cursor refusal is raised
   first; keep `page` as the single raise point for relation terms.
4. **A bounded positive distance filter lost its index-probe conjunct**
   (`:1723-1739`). Thread polarity through `prepareWhere`/`prepareOperations`
   (flipped by each `not`) and, for a point target in positive polarity with a
   finite `lt`/`lte`, prepend `geoPoint.withinBounds(column,
   geoBoundsForDistance(to, bound))` — the adapter already spells both arms
   (`mysql-adapter.ts:988-1001`, `shared/geo-point.ts:49-113`); the composition
   is `Queries`'. Negative polarity must not probe (`NOT(A ∧ B) ≠ NOT B`).
5. **Mode precedence.** A JSON filter's own `mode` wins in both directions
   (`json-filter-builder.ts:38-45`); today it only flows down (`:1231`). One
   target-kind fact inside the one operand owner (rule 12), not a second
   walker. Ruling for Arnaud (A-Q3): keep the old asymmetry (scalar filters
   upgrade-only) as parity, or unify on the JSON rule as a new observable.

Falsifiers: the 18 mutation cells plus SQL pins `UPDATE … EXISTS … "<table>"."id" =`
and, on MySQL, the self-relation `updateMany` succeeding through the wrap; the
scalar-subquery cell; the three cursor-refusal arms on a non-pgvector adapter
and one on a pgvector adapter; the MySQL EXPLAIN loop (`range` on the spatial
index for `within` and bounded `distance`, `ALL` under `gte` and `NOT`).

### U3 — Queries preparation: the projection and the grouped read
Owner: `raptor3/shared/query.ts` (preparation half: `prepareProjection`,
`grouped`, `prepareHaving`, `groupOrderTerms`, `prepareCounts`).

1. **No empty-projection arm** (`:3054-3176`): an explicit empty or all-false
   `select` emits `SELECT  FROM …`; an empty default projection is not given
   the sentinel column; `_count: true` publishes `{}` when nothing is counted
   (`:3078-3089`). One arm with the three cases of `select-builder.ts:418-437`
   (refuse the explicit empty select with the registered sentence, sentinel
   `EMPTY_ROW_RESULT_KEY` — still in `result-aliases.ts:8` — for an empty
   default projection, no `_count` field when `prepareCounts` is empty).
2. **The grouped read has no `by` authority.** `grouped` reads `args.by!`
   raw (`:3429`); `prepareHaving` and `groupOrderTerms` never see `by`.
   `grouped` computes the `by` set once from the admitted array (U1.3) and
   hands it to both, restoring `Scalar '<f>' used in 'having' must be included
   in 'by'.` and `GroupBy orderBy field '<k>' must be included in 'by'`.
3. **A tagged polymorphic `_count` filter is prepared as a scalar predicate
   against one arm** (`:3250`), so the tag key `type` is looked up as a column
   and `storage.ts:210` throws. `prepareCounts` reads `where.type` first,
   keeps that arm's membership, prepares `is`/`isNot` against that arm's
   target, and refuses an unknown tag with the registered sentence.

Falsifiers: `findMany({ select: {} })` refuses; `findMany` on an empty-default
model answers `[{}, {}]` and includes answer `{ children: [{}, {}] }`;
`_count: true` on a model with no to-many relation publishes no `_count`;
the two `by`-membership cells; the tagged count cell (1 / 3 / ordered).

### U4 — The update language is consumed once
Owner: `raptor3/commands/assignments.ts` (with `Queries.prepareUpdate` as the
sole interpreter). Rules 1 and 9.

`scalarAssignment` unwraps `{ set: X }` at storage time (`assignments.ts:34-36`,
`:55`); the value then reaches `Queries.updateAssignment → prepareUpdate`
(`operation-context.ts:1966-1968`, `query.ts:807-850`) a second time. For a
string or number the second pass is a no-op; for a JSON document or a GeoPoint
`{ longitude, latitude }` it is `Unknown update operation: z`, and a document
that itself carries a `set` key is silently rewritten. The root fold
(`commands.ts:1032-1046`) bypasses `Assignments`, which is why only relation-
bearing updates fail on SQLite/PostgreSQL and every root JSON/GeoPoint update
fails on MySQL (`supportsReturning: false`). Fix: `Assignments` stores the
admitted payload verbatim; `wholeValue` is applied lazily at the
key-reconciliation readers (`known`, `equal`, `requireLiteral`, `absorb`) —
what its own comment at `assignments.ts:28-33` already claims; `prepareUpdate`
runs exactly once per admitted `(model, field, payload)`.

Falsifiers: the nine cells; `score: { increment: 2 }` still increments on both
the fold and the record route (the half a naive "stop unwrapping" breaks);
`requireLiteral`'s relation-key refusal still fires for `{ increment: 1 }` on a
relation key; a document `{ set: { z: 1 }, increment: 4 }` round-trips verbatim.

### U5 — One physical result vocabulary and the driver result seam
Owner: `raptor3/shared/query.ts` (decoder half: `projectedColumn`,
`carriedValue`, `decodeQuery`, `decodeValue`, `decodeScalar`) and the adapter
result contract (`src/adapters/adapter-result-parser.ts:116-165`). Rules 7
and 11. This unit needs Arnaud's decision D-17 first (§3).

1. **The JSON-window vocabulary is stated twice and differently.**
   `projectedColumn` (`:658-683`) casts a decimal to text; `carriedValue`
   (`:689-696`, the value inside a `json_object`) casts only `bigint`, so a
   decimal aggregate or list arrives as a JSON number/array and the existing
   decimal codec (which requires text) refuses. `carriedValue` consumes the
   same physical fact `projectedColumn` produced (the old
   `aggregate-utils.ts:123-128` cast both to text).
2. **The driver's representation rules were inlined into the decoder.**
   `query.ts:3815-3816` `JSON.parse`s a string itself, so a window value is
   parsed twice (`"just a json string"` → `SyntaxError`) and the old
   normalisation (`bigint → number` when safe, non-finite refused, prototype-
   safe records) is gone (`42n` where `42` was expected; SQLite's `JSON`
   affinity). No file under `raptor3/` calls `adapter.result.parseField`,
   `parseRelation` or `parseResult`; the whole adapter/driver result chain is
   declared, implemented by every adapter and driver, and unreached. The
   decoder invokes that chain at its one row boundary and never re-parses a
   value the window already decoded.
3. **Four real decoder holes** among the thirteen deleted shape checks (the
   other nine are structurally redundant now: the output is built from the
   prepared shape, so an unrequested column can never reach the caller and a
   missing requested scalar already fails closed): (a) an object shape carries
   no nullability, so a non-nullable `_count` carrier can decode as `null`;
   (b) fields are read with inherited-property semantics
   (`record(decoded)[field]`, `:3656`), so an omitted field named `toString`
   inherits a function — read with `Object.hasOwn`; (c) the decoder's
   structural failures are raw `TypeError`s (`:3643`, `:3647`, `:3655`) that
   `run` does not translate — raise them as `InvalidScalarResult`-class so the
   caller sees `QueryEngineError`; (d) the `groupBy` collisions of U1.3.
4. **Polymorphic integrity refusals** lived in the deleted result parser
   (`polymorphic-result-parser.ts:442-498`): an orphaned membership now reads
   as absent and a duplicate singular inverse silently answers the first row.
   The one decoder that owns the arm shape refuses "linked but absent" from
   the arm's own selected key and counts a singular inverse's rows before the
   `LIMIT` (ruling C-Q3: derive from the selected key, no private carrier).
5. **`createMany` trusts the provider's `rowCount`** (`operation-context.ts:1528-1532`)
   — compare the sum against the rows submitted before publishing a count.
   Affected-row counts are execution semantics (rule 4).

Falsifiers: `_sum/_avg/_min/_max` of a `decimal(12,2)` exact on SQLite at top
level and inside an `include`; `meta: "just a json string"` round-trips; all
five JSON primitives keep their `typeof`; a fake driver returning a `null`
`_count` carrier, a row omitting a field named `toString`, and a 2-row
`createMany` answered with one `rowCount: 1` all raise and publish nothing;
the orphan and duplicate-inverse cells on SQLite and MySQL; the cache SWR
hostile-JSON count equals the getter reads.

### U6 — Execution: membership, series, recovery
Owner: `raptor3/commands/relation-body.ts`, `commands/execution.ts`,
`commands/commands.ts`, `shared/operation-context.ts`, `shared/storage.ts`.
Rules 2, 5, 6, 10.

1. **Junction orientation by slot, not by model** (`storage.ts:164`): on a
   self relation both endpoints name the same model, so `followedBy` is bound
   with `follows`'s sides. `opposite` is already computed at `:138-141`; the
   orientation is `opposite === edge.endpoints[1]`. One expression.
2. **Nested set mutations are set-oriented again** (family 5, four cells).
   Every nested `updateMany`/`deleteMany` is compiled as a plan-time lookup
   plus a captured series (`relation-body.ts:538-601`) and every capture is
   hoisted ahead of every sibling effect (`execution.ts:284/:307/:309`), which
   manufactures the dependency `readTarget` then honestly refuses
   (`commands.ts:638-645`). Arnaud's suspicion is right: the old engine
   compiled these as one correlated statement with no planning read
   (`RelationWritePart.ts:484-504`, `:674-693`) and kept the "split these
   operations" refusal (ATOM.md §13) for genuine planning reads. Fix: a nested
   `updateMany`/`deleteMany` whose `data` carries no nested relation write is
   one correlated set statement (rule 6, first sentence); a relation-bearing
   `updateMany` still captures, at its own position in the declared body
   order; `readTarget` is untouched and still refuses a real feedback loop.
   Invariant: a planning read exists only where one statement cannot express
   the operation; every planning read runs at its body position.
3. **Same-operation `connectOrCreate` duplicates** (family 5, one cell):
   port the first-create-wins rule of ATOM.md §12 (`OwnWriteSteps.ts:646-724`)
   into `RelationBody`'s `connectOrCreate` loop — the decision read is real;
   the missing piece is the identity rule that makes it independent.
4. **The one-recovery allowance is gated on the transport mode**
   (`operation-context.ts:967`: `standalone && usesBatch`) and lives inside the
   region it must replace, so on every transaction-capable provider a lost
   create race escapes as `UniqueConstraintError` (four cells). Move the
   allowance to the owner that opens the region (`run`, `:593-607`): on an
   exact failed-INSERT attribution with no acknowledged segment and no member
   admission started, `restart()` and re-enter `withinRegion` once (a fresh
   transaction, as `routing.ts:180-208` did); `recoveryRejection` asks about
   attribution and progress only; the in-batch arm and "a missing winner never
   authorises a new INSERT" stay. Ruling C-Q2: same attribution and
   correlation id, one recovery; the harness's `expectedAttempts` pins become
   mode-aware again.
5. **A captured set is trusted without enforcing the absence it asserts**
   (family 14): on a batched selected series with a membership edge, queue one
   raceable `requireAbsent` over "connected ∧ filter ∧ key ∉ captured" in the
   same batch (`operation-context.ts:759-768` exists); with U6.4 the abort
   retries once and converges.
6. **`skipDuplicates` suppression rolls back membership with the target
   insert** (`operation-context.ts:396-416`, `execution.ts:566-576`): roll back
   only the target insert; when it was skipped because the row exists, write
   the membership against the existing target (the adapter's insert-select
   shape) and let a second member naming the same target adopt the first's row.

Falsifiers: `u2.followedBy === ['u1']` and the disconnect round trip; the four
family-5 cells plus a constructed feedback loop that still refuses and a
statement-count pin (one `UPDATE`, not `SELECT` + N); the `tag-9` cell with two
different-target entries still refusing; two clients racing the same missing
key converge to one row on the PostgreSQL transaction driver and a second
consecutive race still propagates; the staleness cell aborts and converges;
the singular transfer cell answers `['t1/right/eu/111']` with one membership row.

### U7 — Route seam and transport identity
Owner: `raptor3/route/client-route.ts`, `commands/index.ts`,
`shared/operation-context.ts` (region and queue). Rule 10.

1. **The driver's prepared-statement provenance is discarded** by the two
   batch-query copies (`operation-context.ts:355-358`, `:1160-1165`), so a
   deferred statement transform never runs for any candidate statement on an
   observed client. Wrap both with `transferPreparedStatement`
   (`drivers/prepared-statement-provenance.ts:10-18`, written for exactly this).
2. **A standalone transaction region publishes no commit certainty**
   (`region()` `:544-546` passes raw attribution; the route publishes on
   success only). `region()` binds the `readyToCommit`/`committed` phases,
   `withinRegion`'s failure path maps phase → certainty, attaches
   `commitCertainty`, composes a listener failure with
   `retainWriteOutcomeFailure`, and the success path notifies the seam — the
   five steps of the old `runTransactionScope`, owned by the context because
   only it opens the region.
3. **A one-statement write publishes no single package** (`commands/index.ts:208-214`),
   so the array owner parses through the batch and its `parseResult` seam and
   interceptor onion are bypassed. `prepareSingle` answers for any verb whose
   plan is one statement, reusing the `single` decision `Commands.plan` already
   publishes — the same package `prepareBatch` would publish, no second
   preparation. Ruling C-Q5: take it.
4. **Pre-dispatch capability gates left the construction path**: the `upsert`
   decision read reaches the provider on a driver with neither transactions nor
   batch (`operation-context.ts:650-666`), and the MySQL batch-only
   non-returning refusal has no owner. One gate on the route's construction
   path, before any statement, with one class (`TransactionError`) and one
   `meta { driver, operation }` — the position of the deleted
   `assertRoutedAtomicResolution` (`routing.ts:104-164`).

Falsifiers: the three interceptor-array cells (timeline order, five-error
aggregate, `driver.events === []` on a throwing transform) plus a positive
probe that a statement transform rewrites a candidate read's SQL; the two
write-outcome cells with the phase-blind-driver cell still green; the `upsert`
class cell with no provider dispatch; the MySQL unreachable-host cell raising
with zero connection attempts.

### U8 — Pins and names, no production change
`select-mode-capability-matrix` asserts the surviving driver seam's sentence
`Driver "x" …` (`driver-transaction-base.ts:790/:979`, unchanged since before
the cutover) and its `meta { driver, method }`; the cursor carrier prefix gets
one home (`result-aliases.ts`) that both `Queries.cursorCondition` and the
ordering behaviour module read (ruling A-Q5: keep `0viborm_`, the estate's
private-alias convention); the `_distance` sentence is restored to the
registered `A distance result cannot be selected together with a model field
named '_distance'.` (refusals are contracts).

## 2. Sequencing

Two lanes, because `query.ts` is one file and `operation-context.ts` is one
file; a unit never edits another lane's owner.

| Lane | Order | Why |
| --- | --- | --- |
| Q (admission, query owner) | U1 → U2 → U3 → U4 → U5 | U3 and U5 consume U1's normalised `by` and segments; U5 needs D-17 |
| X (execution, route) | U6.1 → U6.2/U6.3 → U6.4 → U6.5/U6.6 → U7 | U6.5 needs U6.4's retry; U7.2 shares `region()` with U6.4 |

Each unit: decision-elimination gate written before the first edit (required
behaviour, current owner, proposed change, invariant, falsifier), author at
maximum effort, independent review, repair rounds to ACCEPT, the guide
(`raptor3/AGENTS.md`) updated with the invariant, the falsifiers registered in
the estate. Nothing is deleted from a test to make it green; a cell that stays
red is reported.

## 3. Decisions for Arnaud before the units start

| Id | Question | Recommendation |
| --- | --- | --- |
| D-17 | The adapter/driver result-parser chain is declared and implemented everywhere and reached by nothing. Restore its consumer in the decoder (U5.2) or retire the contract? | Restore: it is the existing scalar-meaning boundary (rule 11); retiring it is a public adapter change. |
| D-18 | Recovery re-enters the region once with the same attribution and correlation id (U6.4). | Yes; the `expectedAttempts` harness pins become mode-aware. |
| D-19 | Polymorphic "linked but absent": derive from the arm's own selected key, no private carrier column (U5.4). | Yes. |
| D-20 | `prepareSingle` publishes a one-statement write's package to the array owner (U7.3). | Yes; it is the package `prepareBatch` already publishes. |
| D-21 | Cursor carrier prefix: keep `0viborm_` and re-pin the ordering module (U8). | Yes; behaviour is proven identical. |
| D-22 | JSON `mode` precedence: keep the old asymmetry (JSON honours a declared `default`, scalar filters upgrade only) as one target-kind fact, or unify on the JSON rule? | Keep parity (rule 12: a necessary distinction with one owner). |
| D-23 | An object that is empty after dropping `undefined` members, and `not: {}`, are empty filters (U1.1). | Yes (the old lowering rule). |
| D-24 | The `_distance` refusal sentence: restore the registered one (U8). | Yes. |

## 4. Verification, and the gate that was missing

The estate lanes that surfaced these differences were never registered as a
qualification gate; that is why six attempts missed them. Before the units
start, the qualification driver gains an `estate` group that runs, on the
frozen tree: `pnpm test:core`, the `provider-sqlite3` and `provider-libsql`
projects, and the two Docker provider projects, with the base's red set pinned
as the ceiling. The parity program ends with a freeze, qualification attempt 7
(fixed, native, campaigns, replays, structure, support, estate), the 20-cell
series as the record, packaging, and one commit per lane plus the estate gate.
Exit condition: the four lanes at or below the pre-cutover base's red set
(`5 / 42` on the core lane, `0` on the local provider lanes, `0` and `4` on the
Docker lanes) with no `.skip`, no deleted witness, no pin rewritten to a wrong
answer.

## 5. What this plan deliberately does not do

- It does not restore the nine redundant shape checks (U5.3): the decoder now
  builds the row from the prepared shape, so they reconcile nothing.
- It does not re-pin old-engine SQL text; parity is behavioural.
- It does not add a mode flag, a per-verb interpreter or a second walker to
  make a cell green; where a rule and a cell disagree, the rule wins and the
  cell is reported.
- It does not touch the accepted D-9 performance cost; each unit's A/B on the
  three preparation cells is recorded, not gated.
