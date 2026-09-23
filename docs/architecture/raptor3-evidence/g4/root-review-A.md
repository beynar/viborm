# G4-04 root integrated review — Area A (source and ownership)

Independent reviewer, read-only. Opened 17:41, closed 18:05, 2026-09-15.
Brief: [`briefs/root-review.md`](briefs/root-review.md) "Area A"; checklist
[`root-review-checklist.md`](root-review-checklist.md) section A; ledger
[`g4.md`](../g4.md).

**Outcome: ACCEPT** — with two must-fix notes on the private guide (checklist
line A5) and two notes on one-authority spellings (line A2).

None of the four REVISE triggers is present: no legacy import or fallback in
`src/query-engine/raptor3/**` or `route/`, no changed file outside an accepted
unit's declared ownership, no claimed deletion still present, and no second
authority that changes a public answer, an error identity or committed state.
The two one-authority findings below are real second *spellings* of a fact; I
sized both against the REVISE bar and state in each row why they do not clear
it, and exactly what would close the checklist line with a receipt instead of
an exception.

## Method and limits

- Read-only. **No probes were written and no suite was run** — the brief
  restricts Area A to grep/read/`node -e`, and the validation lock is held by
  the decisions unit. `tests/raptor3/g4/review/root/A/` does not exist and was
  not created. Every row below is closed by a source citation, not a receipt.
- The parity claims I make about the shipped engine are read from the shipped
  source at the cited line, not measured.

### In-flight edits at read time

The decisions unit ([brief](briefs/decisions-implementation.md)) was still
editing when I read. Read-time identity of every file this review cites
(sha256 prefix, mtime):

| sha256[0:16] | mtime | file | in flight? |
| --- | --- | --- | --- |
| `f2c9de8967828560` | 09-15 17:30:05 | `src/query-engine/raptor3/AGENTS.md` | **yes** |
| `b3f237a172ff9355` | 09-15 17:33:55 | `shared/schema.ts` | **yes** |
| `3e0b3bf69b1cabdd` | 09-15 17:33:55 | `shared/operation-context.ts` | **yes** (not in the list my prompt named) |
| `3bf284452f04aa8d` | 09-15 17:29:31 | `commands/relation-body.ts` | **yes** |
| `84aa0c448e375713` | 09-15 17:28:08 | `commands/selection.ts` | **yes** |
| `7ffbea606cbd6e62` | 09-15 15:53:29 | `shared/query.ts` | no |
| `7843d0dc4deb5edd` | 09-15 15:53:29 | `commands/commands.ts` | no |
| `f551151f6d279eb7` | 09-15 13:29:49 | `commands/index.ts` | no |
| `54646ed4cb597ac1` | 09-15 10:09:53 | `commands/execution.ts` | no |
| `1e9b7c529d75f9dd` | 09-15 10:09:53 | `commands/assignments.ts` | no |
| `4aeb2c14e680129d` | 09-15 10:09:53 | `program/index.ts` | no |
| `752215df492fe2fe` | 09-15 10:09:53 | `shared/storage.ts` | no |
| `7766098c4b8c73e1` | 09-15 15:28:13 | `route/client-route.ts` | no |
| `1e19986c9a751ab1` | 09-15 11:51:45 | `query-engine/pending-operation.ts` | no |
| `bb07f7a0e52e61c0` | 09-14 23:35:22 | `query-engine/query-engine.ts` | no |
| `764336127b1eba68` | 09-15 10:32:02 | `client/client.ts` | no |

**Conclusions the integrator must re-check after the freeze**, because they rest
on a file the decisions unit was editing:

1. **A5 finding 1 and 2** (guide content) — `AGENTS.md` at `f2c9de89…`. The
   decisions unit's item 5 appends only the decision paragraphs; if it also
   corrects the borrowed-transaction paragraph, finding 2 is moot. Re-read
   lines 272–285 and re-run the "does the guide name the new owners" grep in
   row A5.
2. **A4 rows for `namesRelation` and the R-B5 junction order** — read from
   `operation-context.ts` `3e0b3bf6…` and `relation-body.ts` `3bf28445…`.
3. **A2 rows for `keyPortabilityRefusal` and `nestedTargetAddressesConstraint`**
   — read from `schema.ts` `b3f237a1…` and `selection.ts` `84aa0c44…`.
4. Everything else (the combined diff, the legacy-import scan, `query.ts`'s
   authority rows, the route and the three client seams) is on files the
   decisions unit had not touched since 15:53 and is unaffected.

`shared/operation-context.ts` is also in flight (17:33:55) although my prompt's
in-flight list did not name it. It is inside the decisions unit's declared
ownership (`src/query-engine/raptor3/**`), so this is a note to the integrator,
not a finding.

---

## A1 — combined diff against `0cc61e61`, ownership attribution per file

**Closed. Receipt:** `git diff --name-only 0cc61e61 -- src scripts tests
vitest.workspace.ts` → 37 tracked files; `git status --porcelain` → 4 untracked
roots. `git diff --cached --name-only` is **empty** (no staged files).

I derived the attribution mechanically: the union of every `+++`/`---` path in
every `*.patch`/`*.diff` under `g4/` (70 distinct paths) covers **every changed
file except two**, both explained below.

| file | attributed to | evidence patch |
| --- | --- | --- |
| `scripts/credential-free-test-manifest.mjs` | witness | `witness/production.patch` |
| `scripts/raptor3-campaign-receipts.test.mjs` | witness | `witness/production.patch` |
| `scripts/raptor3-cli.test.mjs` | witness | `witness/production.patch` |
| `scripts/raptor3-manifest.mjs` | witness | `witness/production.patch` |
| `scripts/run-raptor3.mjs` | witness | `witness/production.patch` |
| `vitest.workspace.ts` | witness | `witness/production.patch` |
| `src/adapters/database-adapter.ts` | G4-02 | `unit02/production-phase2.patch` |
| `src/adapters/databases/{mysql,postgres,sqlite}/*-adapter.ts` | G4-02 | `unit02/production-phase2.patch` |
| `tests/contracts/adapters/dialect-vocabulary.core.test.ts` | G4-02 | `unit02/tests-phase2.patch`; declared in `unit02/note.md:1826` as the `integerDivide` seam's own contract test |
| `src/client/client.ts` | G4-03 | `unit03/production{,-followup}.patch` |
| `src/query-engine/pending-operation.ts` | G4-03 | `unit03/production{,-followup}.patch` |
| `src/query-engine/query-engine.ts` | G4-03 | `unit03/production{,-followup}.patch` |
| `src/query-engine/raptor3/route/client-route.ts` (untracked) | G4-03, then G4-02 closure (B-1c writer transfer) | `unit03/production*.patch`, `unit02/production-closure.patch` |
| `raptor3/commands/index.ts` | G4-01 → G4-02 | `unit01/production.patch`, `unit02/production{,-phase2}.patch` |
| `raptor3/shared/query.ts` | G4-01 → G4-02 (writer transfer 04:40) | `unit01/production.patch`, `unit02/production-{phase2,closure}.patch` |
| `raptor3/shared/schema.ts` | G4-01 → G4-02 | `unit01/production.patch`, `unit02/production*.patch` |
| `raptor3/shared/operation-context.ts` | G4-01 (one-line `isReadOperation`, merged by the integrator) → G4-02 | `unit01/production.patch`, `unit02/production*.patch` |
| `raptor3/commands/{assignments,commands,execution}.ts`, `raptor3/shared/storage.ts`, `raptor3/program/index.ts` | G4-02 | `unit02/production.patch` |
| `raptor3/commands/{relation-body,selection}.ts` | G4-02 closure | `unit02/production-closure.patch` |
| `tests/raptor3/g4/**` (untracked), `tests/types/raptor3/**` (untracked) | G4-01 / G4-02 / G4-03 / witness / reviewers | `unit0*/tests*.patch`, `unit03/tests*.patch` |
| `tests/raptor3/g3/generation/transport-plans.ts` | G4-02, then harness reconciliation | `unit02/tests.patch`, `witness/receipts/reconciliation/repair/*.patch` |
| `tests/raptor3/post-prep/g29-result-progress{,-pglite}.test.ts` | G4-02 | `unit02/tests-phase2.patch` |
| `tests/raptor3/g3/generation/{recipe,sqlite-campaign,transport-campaign}.ts` | witness (campaign seed bounds became a parameter; accepted by the integrator, `g4.md` "Frozen additional campaign ranges") | `witness/receipts/*/witness-harness-vs-0cc61e61.patch` |
| `tests/raptor3/g3/generation/generated-transport-smoke.test.ts` | harness reconciliation | `witness/receipts/reconciliation/repair/reconciliation.patch` |
| `tests/raptor3/core-structure/measurement/extension-{a,composition}-scenario.ts` | harness reconciliation | `witness/receipts/reconciliation/*.patch` |
| `tests/raptor3/transitions/live-world.ts` | witness follow-up (native pool repair) + G4-02 | `witness/receipts/*/witness-harness-vs-0cc61e61.patch`, `unit02/tests*.patch` |

The two files in no evidence patch:

- **`src/query-engine/raptor3/AGENTS.md`** — the private guide. It is the
  integrator's own file and checklist line A5's subject; see A5 below.
- **`tests/pattern/pack/program-dump.ts`** — a known unrelated dirty file.

**Unrelated dirty files untouched.** `g4/environment/` holds no session-start
snapshot of the three dirty files (only `starting-identity.json`, the typecheck
logs and the classification logs), so I substituted two independent checks:

| file | mtime | G4 opened 2026-09-14 21:20 | diff content |
| --- | --- | --- | --- |
| `CONTEXT.md` | 09-09 18:37:16 | predates G4 by 5 days | not read (outside the diff scope) |
| `memory.md` | 09-14 19:48:06 | predates the opening by 1 h 32 m | — |
| `tests/pattern/pack/program-dump.ts` | **09-02 17:37:16** | predates G4 by 12 days | the whole diff is the pre-existing `alignById` TS2532 guard (`table[i]` hoisted to `row`); it names no raptor3 symbol |

*Note (not a finding):* the brief asks for the comparison against a
`g4/environment/` snapshot that was never written. Recording the three files'
`0cc61e61` diff + mtime in `g4/environment/` at the freeze would make this row
reproducible instead of inferential.

**Fourth untracked path.** `git status --porcelain` also lists
`tests/pattern/match/decode-malformed.core.test.ts` (mtime **09-02 17:36:43**),
which the brief's expected-untracked list does not name. It predates G4 by 12
days, is unreferenced by `vitest.workspace.ts`, `scripts/` and every test
(grep clean), and belongs to the pattern-engine work like the untracked
evidence archives. **Not a G4 file.** Worth one line in the ledger's untouched
list so the next census does not trip on it.

---

## A2 — one authority per fact

| fact | owner (read) | second implementation? |
| --- | --- | --- |
| cardinality / public shape per read verb | `Queries.read` — `shared/query.ts:2383-2521`; every verb returns `{query, single, value, result}` | **None.** Consumers: `commands/index.ts:150` and `program/index.ts:56` only. Grep for a second single-row publication (`rows[0] ?? null`, `results[0]`) outside `query.ts` returns 14 hits, all in `operation-context.ts`/`execution.ts` and all *internal* statement results (locate, capture, terminal), none a verb's public cardinality. `commands/index.ts:88-95` `publishedFacts()` **reads** the facts off the prepared `Read` rather than restating them. |
| one prepared predicate vocabulary (`where`/`having`/nested) | prepare: `prepareOperations` `query.ts:1140` → `prepareOperation` `:1184`; lower: `lowerPredicate` `:1442` → `lowerOperation` `:1484` | **None.** `prepareHaving` (`:3365`) builds `{kind:"column"}` / `{kind:"aggregate"}` targets and calls the same `prepareOperations`. `relationPredicate`/`membershipWhere` likewise. Operator case-labels across all of `raptor3/**`: 30 hits, **all in `query.ts`**, in exactly three switches — prepare (`:1197`), lower (`:1530`) and the JSON-path lowering (`:1728`) dispatched from the single lower entry at `:1494`. The `lowerValuePredicate` ladder is gone (A4). |
| one page owner | `page()` `query.ts:2097-2143` — total order, cursor predicate, signed window, `distinct` | **One documented exception, parity-correct** — see note A2-N1. Root `select` `:2366`, aggregate window `:2552` and every nested to-many node `:3297` consume `page()`. |
| one projection owner | `prepareProjection` `query.ts:2958`; lowered once by `lowerProjection` `:3182` | **None.** 17 call sites across `query.ts`, `operation-context.ts`, `commands.ts`, `selection.ts`, `execution.ts`, all calling the one walker. No second `select`/`include` walk. |
| one leaf decoder | `decodeScalar` `query.ts:3562` / `decodeList` `:3753`, reached only through `decodeValue` `:3518` ← `decodeQuery` `:3440` / `decodeProjection` `:3449` | **None.** Every decode entry point in `operation-context.ts` (13 sites) calls `queries.decodeQuery`/`decodeProjection`. No `JSON.parse` and no per-type ladder outside `query.ts`. The route's `leafCodec` (`client-route.ts:300`) is the *cache snapshot* codec, composed from the official `result/cache-value-codecs` owners (B-1c) — a different fact, and it consumes the query owner's `Leaf`. |
| one carrier transport rule | `carriedValue` `query.ts:634-643` | **None.** Three consumers: aggregate carrier `:2605`, recursive walk `:2806`, relation projection `:3307`. |
| one counted-slot owner | `countedMemberships` `query.ts:3163-3181` | **None.** Both the `_count` projection (`:3139`) and `_count` ordering (`:2031`) read it; both lower through `correlatedCount` `:3233`. |
| `Queries.updateValue` for every scalar operator and symbolic key | `prepareUpdate` `query.ts:732-774` → `updateAssignment` `:795` / `updateValue` `:834` | **One partial second spelling** — see note A2-N2. Consumers: `operation-context.ts:1186,1360,1579,1594` and `execution.ts:94`. No competing arithmetic switch. |
| `fieldValue` for value lowering | `fieldValue` `query.ts:486` → private `scalarValue` `:493` | **None.** Every `adapter.literals.value` call in all of `raptor3/**` is inside `Queries.value` `:479`, `scalarValue` `:508-538`, or `lowerJsonOperation`'s JSON-member literal `:1726`. 24 `fieldValue(` call sites, one definition. |
| one envelope rule in `OperationContext.run` | `run()` `operation-context.ts:433-465` (region selection, deferred state, one restart) with the operative test in `dispatch()` `:466-479` | **None.** All 12 `dispatch(` sites pair 1:1 with the 12 `this.transport._execute`/`_executeBatch` calls; no provider round trip bypasses it. Only two `withTransaction` sites exist in `raptor3/**` (`:299` member rollback, `:387` standalone region) plus the route's two *grant callables*. |
| `operationRegion` vs `memberRollback` ownership | **Stated, not inferred** — the `ExecutionBinding` type documents both grants (`operation-context.ts:59-74`) and `region()`'s docblock (`:362-374`) states the rule; `client-route.ts:317-337` states which situation supplies which | Correct. `region()` reads `operationRegion` only; `withMemberRollback()` (`:280-299`) reads `memberRollback` only and guards re-entry with `ownRegionOpen`. |

### A2-N1 [note] `grouped()` emits `limit`/`offset` without the page owner

`shared/query.ts:3358-3359` — `groupBy` applies `args.take`/`args.skip`
directly (`limit: args.take === undefined ? undefined : this.value(args.take)`)
instead of going through `page()`. It therefore has no `Math.abs`, no order
reversal and no cursor/distinct handling.

**Why this is a note and not a second-authority finding.** `groupBy` admits no
`cursor` and no `distinct` (`src/validation/model/args/aggregate.ts:805-870`
lists `by, where, having, orderBy, take, skip` and the five aggregates), so
two of the three extra facts `page()` owns do not exist for this verb. The
third — a negative `take` — *is* admitted (`paginationTake()` is a bare
`v.integer()`, `src/validation/model/args/pagination.ts:8`), and the candidate
reproduces the shipped engine exactly: `src/query-engine/operations/groupby.ts:107-110`
also does `args.take !== undefined ? adapter.literals.value(args.take)` with no
absolute value and no reversal. So the second emission site produces the
shipped answer by construction.

**What would close A2's "one page owner" line with a receipt instead of an
exception:** either route `grouped()` through `page()` while keeping the raw
signed limit (a `page()` option, not a branch), or record this as the named
exception in the private guide's page paragraph, with the shipped citation.
Unverified by me: I did not execute `groupBy({ take: -2 })` on any dialect.

### A2-N2 [must-fix] two spellings of "a scalar update's whole value"

Two predicates answer "is this admitted scalar value an operator record whose
`set` names the whole value?", with different tests:

- `shared/query.ts:742-744` — `if (!isOperatorRecord(value)) return {kind:"value", value};`
  then `if (Object.hasOwn(operation, "set")) return {kind:"value", value: operation.set};`
  where `isOperatorRecord` (`:451-454`) is `prototype === Object.prototype || prototype === null`.
- `commands/assignments.ts:28-38` — `scalarAssignment(value)`:
  `value !== null && typeof value === "object" && !(value instanceof Sql) && Object.hasOwn(value, "set") ? record(value).set : value`,
  applied to every entry in the `Assignments` constructor (`:56`), including the
  `"update"` construction at `commands/commands.ts:275-282`.

The second predicate is strictly broader: it unwraps `set` on **any** object
with an own `set`, where the query owner treats a non-plain object as one whole
value in every domain. The private guide states the stricter rule as normative
twice (`AGENTS.md:151-155` "`Queries.updateValue` is the sole interpreter of
admitted scalar update operators", and G4-01's own repair 4 rationale,
`unit01/note.md` r3 table row 4: "a non-plain object is one whole value for
**every** domain").

**Why the outcome is still ACCEPT.** I enumerated the object domains an
admitted scalar value can be and the two predicates agree on all of them:
`Uint8Array` (own props are indices), `Date`, big.js `Decimal` (own `s`,`e`,`c`),
arrays, `Map`/`Set`, `Sql` (excluded by both), `null` (excluded by both), plain
objects and `Object.create(null)` records (both unwrap — which is the correct
Prisma reading for a JSON `{set: …}`). A divergence needs a value-domain class
instance carrying an **own** `set` property; `grep -rn "this\.set\s*=" src/validation/ src/schema/ src/query-engine/`
is empty, so nothing in the estate produces one. The two sites also serve
different consumers — `updateAssignment` produces the provider's `SET`, while
`Assignments` holds the value only for key reconciliation (`equal` `:139`,
`absorb` `:113`, `requireLiteral` `:90`), and passing an unrecognised operator
record through as a non-literal is deliberate there. No public answer, error
identity or committed state differs today.

**Resolution.** Expose the existing `prepareUpdate`'s whole-value answer (a
one-line `wholeValue(model, field, value)` on `Queries`, or exporting
`isOperatorRecord`) and have `scalarAssignment` call it; delete the inline
predicate. Until then checklist line A2 cannot be closed with a receipt for
this fact — close it with this recorded exception instead.

---

## A3 — no legacy import or fallback in `raptor3/**` and `route/`

**Closed, with every hit listed.** I enumerated all 52 distinct module
specifiers imported anywhere under `src/query-engine/raptor3/` (including
`route/`), then grepped the five checklist terms as raw text.

**Every raw hit for `write-engine` / `builders/` / `result/` / `operations/` /
`pattern/` in `raptor3/**`:**

| file:line | kind | justification |
| --- | --- | --- |
| `route/client-route.ts:39` | **import** `../../result/cache-value-codecs` | **Allowed (B-1c, accepted).** The official cache codec owner. Verified not the shipped result engine: its own imports are `@schema/scalars`, `@validation/primitives/{decimal-codec,geo-point-codec}` and two sibling `./cache-*` modules only — no compiler, lowerer, executor or `ResultParser`. |
| `shared/schema.ts:16` | **import** `../../write-engine/parse-boundary` | **Allowed (named retention, `AGENTS.md:262-265`).** Present at `0cc61e61` unchanged (`git grep` on the baseline). |
| `route/client-route.ts:200` | comment | cites `src/query-engine/result/cache-value-codecs.ts` as the codec owner |
| `shared/schema.ts:109, 276, 277, 304` | comments | cite `operations/mutation-identity.ts`, `write-engine/RecordUpdateCompiler.ts`, `write-engine/shared.ts` as the shipped parity oracles |
| `shared/operation-context.ts:196` | comment | cites `pattern/execute/values.ts` |
| `shared/query.ts:74, 217, 260, 296, 332, 333, 526, 1792, 2334` | comments | cite `result/cache-value-codecs.ts`, `write-engine/shared.ts`, `builders/{where-unique-builder,where-builder,sort-order-builder,values-builder,distance-builder}.ts`, `operations/{groupby-having,find-pagination,find-common}.ts` |
| `commands/selection.ts:63, 69` | comments | cite `write-engine/{RelationJunctionPart,shared}.ts` |
| `commands/relation-body.ts:266` | comment | cites `write-engine/RelationJunctionPart.ts:911-937 compileDelete` (the R-B5 order) |

**No other boundary is a legacy import.** The only non-comment imports outside
the two allowed ones are `@errors`, `@sql`, `@schema/**`, `@validation/**`,
`@adapters/**`, `@drivers/**`, `@client/types`, `../../types` (type-only) and
`@client/client` (the route constructing the client — it *is* the seam), plus
`../../bind-budget`.

*Note (not a finding):* `shared/operation-context.ts:28` imports
`../../bind-budget`, which is not one of the five checklist terms and is
**present at `0cc61e61` unchanged**. It is a pure `Sql` chunker
(`src/query-engine/bind-budget.ts` imports only `@sql` and
`@drivers/bind-parameter-capacity`) shared by `write-engine`, `operations`,
`pattern` and the candidate alike — a retained neutral boundary, not the
shipped engine. Worth naming in the retention paragraph beside
`parse-boundary` so the next scan does not have to re-derive it.

**No fallback.** No `require(` and no dynamic `import(` anywhere in
`raptor3/**`. No shipped-engine symbol is referenced in code:
`OperationExecutor|ResultParser|QueryCompiler|buildWhereUnique\(|RecordUpdateCompiler|RelationJunctionPart|prepareResultRows|parsePreparedResult|compileOperation`
is grep-clean outside comments. In the three client seams every route branch is
exclusive — `pending-operation.ts` `#preparedInput` `:570`, `#cacheResultCodec`
`:576`, `#resolveSinglePlan` `:604`, `prepareBatch` `:372`, `#runRouted` `:765`,
`buildStatement` `:865`, `#cacheKeyPayload` `:848` each read `if (this.#route)`
and take the shipped path only when the route is absent; nothing catches a
candidate failure and retries on the shipped engine. The four `fall back`
occurrences in `raptor3/**` all describe the *client's* array fallback
(`client-route.ts:322`, `operation-context.ts:63,69,372`), not a fallback to the
shipped engine.

---

## A4 — deletions verified gone

| claimed deletion | verdict | receipt |
| --- | --- | --- |
| `lowerValuePredicate` | **gone** | present at `0cc61e61` (`query.ts:740,749,763,1453`); `grep -rn lowerValuePredicate src/ tests/` is empty. `having` now shares `prepareOperations` via `prepareHaving` (`query.ts:3365-3406`). |
| `grouped` shape assembly | **gone in the reviewed sense** | the inline leaf table (`_avg → float`, `_sum → int`) is gone; `grouped()` (`:3323-3362`) now classifies every leaf through `scalarShape` (`:644`) and `prepareAggregates.fields_`. The *record* assembly remains in `grouped()` — G4-01's note discloses this and corrects its own r1 over-claim ("three assembly sites, one leaf classifier", `unit01/note.md:192`), and `unit01-review.md:372` accepted exactly that. Not a finding; the checklist line should be read as the leaf-table deletion it was. |
| entry `take: 1` | **gone** | `0cc61e61:commands/index.ts:41-45` had `findUnique` → `select(model, {...args, take: 1})`; the current entry (`commands/index.ts:136-210`) has no `take` at all. The four surviving `take: 1` sites (`program/program.ts:456`, `selection.ts:157`, `execution.ts:117,333`) are nested row-locate and absence-probe statements, a different fact. |
| `publishesSingleRow` | **gone** | grep-clean across `src/`; the only hit anywhere is a reviewer probe's comment (`tests/raptor3/g4/review/unit02/repair-read-facts.review.test.ts:5`). Replaced by `Read.single` stated by the read owner. |
| `statementAtomic` | **gone from raptor3** | grep-clean in `raptor3/**`; the two remaining hits are `src/query-engine/pattern/execute/index.ts:93,160`, the unrelated pattern engine. |
| `namesRelation` **in the physical owner** | **gone** | `grep -n namesRelation src/query-engine/raptor3/shared/operation-context.ts` is empty. The kind-test was relocated to the projection owner as `returningSafeProjection` (`query.ts:181`), one definition, four consumers (`operation-context.ts:1266`, `commands.ts:1039,1067,1139,1151`). `EngineSchema.namesRelation(model, data)` (`schema.ts:199`) is a **different** function added by G4-02 (does this write payload name relations — the upsert gate); it did not exist at `0cc61e61` and is not the deletion the checklist names. |
| the `findMany`/`findUnique`/`groupBy` triple | **gone** | the baseline's two dispatch triples (`commands/index.ts:40-50`, `program/index.ts:44-49`) are both replaced by one `Queries.read` call each (`commands/index.ts:148-151`, `program/index.ts:56`). |
| the `parseResult` guard | **gone** | `pending-operation.ts:380-384` carries the invariant as a comment ("A routed operation never reaches here…"); the `parseResult` handler itself is byte-unchanged from `0cc61e61` (no route branch, no throw). |
| the second read entry in `program/index.ts` | **gone** | `program/index.ts:53-56`: "The specimen keeps ONE read entry: the same `Queries.read` owner"; no `grouped`/`select` dispatch remains. |

---

## A5 — private guide

### Spot-check: ten paragraphs against the code

| # | guide paragraph | verdict |
| --- | --- | --- |
| 1 | `:61` "`Queries.prepareProjection` owns one immutable alias-free projection description and decoder shape… Only `decodeQuery` consumes query-level row-count requirements." | **true** — one walker (A2); `expectedRows` is produced once (`query.ts:2698`) and consumed only at `decodeQuery` `:3441-3443`. |
| 2 | `:74` "`Queries.prepareSelector` owns one alias-free symbolic selector description… Do not add a second selector walker." | **true** — one `prepareSelector` (`:874`), one `lowerSelector` (`:966`); 11 call sites, no second walk. |
| 3 | `:54` "`EngineSchema` owns lazy immutable factory-lifetime views for physical field descriptors, ordered stored fields, … slot clearability." | **true** — `shared/storage.ts` builds `buildPhysicalFieldView` / `buildStoredFieldsView` / `buildMembershipView`, imported once by `schema.ts:18-21`; `physicalField` has one definition (`storage.ts:184`). |
| 4 | `:151` "`Queries.updateValue` is the sole interpreter of admitted scalar update operators… operation contexts must not reconstruct those operators in JavaScript." | **true of the operation contexts** (`operation-context.ts` and `execution.ts` call `updateValue`/`updateAssignment`, never re-switch). **Partially false of `commands/assignments.ts`** — see A2-N2. |
| 5 | `:157` "`finishOne` and `finishMany` state operation-owned result cardinality… both paths consume the same terminal-result decoder." | **true** — `operation-context.ts:862,865` both delegate to `finishTerminals` `:887` → `decodeTerminalResults` `:868`. |
| 6 | `:262` "Named retention: `write-engine/parse-boundary.ts` remains the existing schema-to-ValidationError admission owner." | **true** — `schema.ts:13-16` imports `parseValidated`, `upsertEnvelopeSchema` and nothing else from it. |
| 7 | `:281` "An `atomic-array` binding is a capability refusal and must throw `TransactionError` before raw-argument admission or provider work." | **true** — `operation-context.ts:139-141`, raised in the constructor, before `admit`. |
| 8 | `:324-328` "a borrowed operation must receive the executable `memberRollback` capability… A plain `borrowed-transaction` binding remains refused before member effects even when its driver supports savepoints." | **true** — `suppressionRefusal()` `:302-316` refuses on `ownership === "borrowed-transaction" && !this.memberRollback`. |
| 9 | decisions block: "An exact-decimal primary key under `increment`/`decrement` is SUPPORTED… `multiply`/`divide` on the same key stay refused… keep it in the one owner (`EngineSchema.keyPortabilityRefusal`)… a key update naming anything but exactly one operation… is refused for its arity, before any statement." | **true** — `schema.ts:238-266`: `ROUNDING_KEY_UPDATES = ["multiply","divide"]` gates the decimal refusal; `number` is refused for any arithmetic; `named.length !== 1` is the arity refusal; one owner, two consumers (`schema.ts:167`, `commands.ts:1238`). |
| 10 | decisions block: "A batch-only expression publication of a non-`int` field is a registered `QueryEngineError` naming the model, the field and the operation, with `meta` `{ model, operation, field }`, raised before any statement of that update is dispatched." | **true** — `operation-context.ts:1560-1570`, inside `if (this.usesBatch)` before `queue()`, with exactly that `meta`. |
| 11 | decisions block: "A junction `delete` removes the LINK row and then the target, in one region." | **true** — `relation-body.ts:260-278`: the `Removal` is placed before the target `delete` when `verb === "delete" && edge.kind === "junction"`, citing `RelationJunctionPart.ts:911-937`. (Read at `3bf28445…`, in flight.) |
| 12 | `:274-278` "A `borrowed-transaction` binding uses the exact supplied transaction driver directly; the candidate does not open or close a transaction, create a savepoint, disconnect, replay, or fall back to the factory driver." | **FALSE** — see A5-2. |

### A5-1 [must-fix] the guide carries no unit paragraph from G4-01, G4-02 or G4-03

Checklist line A5 is "Private guide updated for the new owners and rules **from
every unit's proposed paragraphs**". `git diff 0cc61e61 -- src/query-engine/raptor3/AGENTS.md`
is **+58 lines, all of them the decisions unit's seven paragraphs** appended
after line 408. Nothing else in the guide changed.

G4-01 wrote an explicit proposal for the root to merge —
`g4/unit01/note.md:328` "## 10. Proposed private-guide paragraph (for the root
to merge into `raptor3/AGENTS.md`)" — and it is absent. Every distinctive
phrase is grep-clean in the guide: "one read language" 0, "One page owner" 0,
"single leaf decoder" 0, "destination-aware operand owner" 0.

The new owners this milestone created are likewise unnamed in the guide:
`grep -niE "Queries\.read|page owner|carriedValue|returningSafeProjection|operationRegion|integerDivide|countedMemberships"`
returns **only** three pre-existing `memberRollback`/`prepareProjection`
mentions from G3. So the guide does not state: `Queries.read` as the cardinality
owner, the one page owner, the one carrier transport rule, the one counted-slot
owner, `returningSafeProjection`'s relocation, the `integerDivide` adapter seam,
or the `operationRegion` grant.

**Resolution.** Merge G4-01's §10 paragraph and the equivalent owner paragraphs
from `unit02/note.md` (phase 1 §8.4 envelope rule, phase 2 `operationRegion` /
`integerDivide` / `returningSafeProjection` / counted slot) and `unit03/note.md`
(the route's "decides which situation, never whether an envelope is needed")
before closing the line. This is the integrator's file, not the decisions
unit's, so it will not resolve itself at the freeze.

### A5-2 [must-fix] the borrowed-transaction paragraph no longer states a fact the code carries

`src/query-engine/raptor3/AGENTS.md:274-278`:

> A `borrowed-transaction` binding uses the exact supplied transaction driver
> directly; the candidate does not open or close a transaction, create a
> savepoint, disconnect, replay, or fall back to the factory driver.

G4-02 phase 2 changed this deliberately. `shared/operation-context.ts:375-388`:

```
if (this.ownership === "borrowed-transaction") {
  const granted = this.operationRegion;
  return granted ? (execute) => granted(execute, this.attribution) : undefined;
}
```

and `route/client-route.ts:352-363` supplies
`operationRegion: (execute, scoped) => engineDriver.withTransaction(execute, undefined, scoped)`
for the `$transaction(callback)` situation. So a borrowed multi-statement
operation **does** open (and close) one nested region on the caller's driver.
That is the integrator decision recorded in `g4.md` ("Integrator decision (§8.4
of the note): approved") and the G4-03b route follow-up — the code is right and
the guide is stale.

The next sentence compounds it: "The optional executable `memberRollback`
capability **is the only authority for one operation-owned** … region inside a
borrowed transaction" now reads as excluding `operationRegion`, which is exactly
the distinction `region()`'s own docblock (`:362-374`) was written to make.

**Resolution.** Rewrite the paragraph to the shipped rule the code now carries:
a borrowed operation owns a region only when its caller granted
`operationRegion`; without the grant the caller's scope is the unit and a
failing statement poisons it (mirroring `runStatementAtomic` / `runLinearOn`);
`memberRollback` remains member isolation only. The wording already exists,
correct, in `operation-context.ts:362-374` — lift it.

*Caveat:* `AGENTS.md` was in flight (17:30:05, `f2c9de89…`) when I read it. If
the decisions unit's item 5 also corrected this paragraph, re-read 272–285 and
close this row.

### A5-3 [note] one broken sentence in the R-D4 paragraph

Decisions block, the `connect`/`connectOrCreate` paragraph:

> Under a case-insensitive collation that differs from the request's literal,
> and the located value is the contract: the bytes written always exist in the
> parent table.

The subordinate clause has no main clause ("Under a collation … **the stored
bytes may differ** from the request's literal, and the located value is the
contract"). The rule it means is right and matches the code; the sentence as
written does not parse. In flight — the decisions unit may still be editing it.

---

## Summary of rows

| checklist line | outcome |
| --- | --- |
| A1 combined diff / ownership / no staged / dirty untouched | **closed** — 37 tracked + 2 untracked roots, every one attributed; nothing staged; the three dirty files predate G4; one extra pre-existing untracked pattern test named as a note |
| A2 one authority per fact | **closed with one recorded exception** — 9 of 11 facts have exactly one authority with no second implementation; A2-N1 (grouped page, parity-correct) and A2-N2 (whole-value `set`, unreachable) are the two spellings |
| A3 no legacy import or fallback | **closed** — 2 allowed imports (`parse-boundary`, `cache-value-codecs`), 17 comment citations, `bind-budget` noted as a retained neutral boundary; no fallback in the candidate or the three seams |
| A4 deletions verified gone | **closed** — all nine; `namesRelation` disambiguated (the physical-owner kind-test is gone; the upsert-gate function of the same name is a G4 addition) |
| A5 private guide | **NOT closed** — A5-1 (no unit paragraphs merged) and A5-2 (stale borrowed-transaction paragraph) are must-fix before the freeze |
