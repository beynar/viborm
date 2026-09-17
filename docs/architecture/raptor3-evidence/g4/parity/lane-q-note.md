# Lane Q — admission, lowering, preparation, assignments, decoder

Worktree `/private/tmp/viborm-parity-q`, branch `parity-q`, base `356254a2`,
`TMPDIR=/private/tmp/viborm-parity-tmp-q`. Units U1 → U5 of
`docs/architecture/raptor3-parity-plan.md`, in that order. Receipts under
`receipts/lane-q/`.

One rule decided at the start and applied to every U1 refusal, because it is
the price of moving a refusal from lowering to admission (rule 5):

> **At admission the field names itself through the issue PATH, not through the
> sentence.** The old sentences spelled the field (`Filter for field 'name' …`)
> because the lowerer held the field name. The per-scalar filter objects are
> INTERNED per scalar type (`validation/scalars/intern.ts`), so the admission
> owner cannot know which field it is validating without duplicating every
> filter schema per field and defeating that interner. The `ValidationError`
> carries `issues[0].path = "where.name"`, so the fact is not lost — it moved
> from the message to the structured issue. Relation filters keep the field in
> the sentence (their schemas ARE per relation), so those two sentences are
> restored byte for byte.

---

## U1 — Admission: the shapes the validation layer must refuse

### Decision-elimination gate (written before the first edit)

| | |
| --- | --- |
| **Required behaviour** | (1) An empty filter object is not a filter: `where: { name: {} }`, `where: { posts: {} }`, `where: { metadata: { path: [...] } }` refuse; `where: {}` still matches everything. (2) A JSON `path` string is parsed into segments once, with the six grammar refusals and the portable-path assertion on every dialect, and an inert `mode` is refused. (3) `groupBy`'s `by` is an array, duplicates refuse, and a grouped scalar colliding with an aggregate of the same name refuses. (4) A nested default-only `createMany { skipDuplicates }` refuses wherever the verb appears. |
| **Current owner** | `src/query-engine/raptor3/shared/query.ts:1214-1250` (`prepareOperations` builds an empty conjunction), `:1358-1387` (`prepareSlotPredicate`), `:299-301` (`states()` reads it as silence) — so the lowerer spells `TRUE`. `:1232-1238` scopes only `Array.isArray(filter.path)` and `:1243` drops `path`/`mode`. `aggregate.ts:859` admits `by: string \| string[]` and `query.ts:3429-3432` calls `.map` on it. `operation-context.ts:1379-1382` holds the default-only refusal on the physical owner, which a nested `createMany` never reaches (`relation-body.ts:302-326`). |
| **Proposed change** | One whole-object refusal hook on the ONE admission owner (`validation/primitives/object.ts`), spelled by each filter object that owns a completeness rule: the shared negatable filter base (`scalars/negatable-filter.ts`), the JSON filter (`scalars/json.ts`), the to-one/to-many relation filters (`relations/filter.ts`) and the polymorphic collection filter. JSON `path` becomes a schema that parses `string` → segments and asserts portability, so the preparer consumes segments only. `by` becomes `v.union([array, shorthandArray])` and the groupBy args object refuses duplicates and the collision. The `createMany` payload object refuses a default-only row under `skipDuplicates`. |
| **Invariant** | An admitted `where`, `by` and `data` are complete facts. No preparer re-reads public syntax, discovers a missing operation, parses a path string, or normalises an argument shape. |
| **Falsifier** | `tests/raptor3/g4/parity/lane-q/u1-admission.test.ts` (new): the eleven family-18 shapes; `updateMany`/`deleteMany({ where: { name: {} } })` refuse while `findMany({ where: {} })` matches all; `by: "category"` groups and `by: ["a","a"]` refuses; the same non-portable path refuses on all three dialects; `{ equals: undefined }` and `not: {}` are empty (D-23). Plus the repaired files `tests/providers/local/sqlite3-returning-json.test.ts` (families 3/4) and the round-4 review probe, inverted. |

### Changes

| file:line | change |
| --- | --- |
| `src/validation/primitives/object.ts:54-75, 409, 655, 745` | one new runtime-only option, `refuse(value) => string \| undefined`: the whole-object refusal an object owns, with its own sentence. It replaces the plan's `nonEmpty` + `requiresOneOf` pair for the filter objects, for three reasons recorded here: (a) the REGISTERED sentences (`Relation filter 'posts' requires one of: …`) cannot be spelled by the primitive's generic messages, (b) `requiresOneOf` also carries a TYPE effect — `ApplyRequiresOneOfGroups` distributes one union arm per operator key, on a filter type that is recursive through `not` — which the public filter surface must not gain, and (c) one hook answers BOTH the emptiness rule and the JSON inert-`mode` rule, which no key-level option can express. It runs on the validated output, so a key spelled `undefined` is already absent (D-23). |
| `src/validation/scalars/negatable-filter.ts:1-60` | `requireFilterOperation`: every scalar filter object (the one shared place that finishes them) refuses when no key outside `path`/`mode` carries a value. The vocabulary is not captured at build time on purpose — `model/args/aggregate.ts`'s `listHavingSchema` EXTENDS a list filter with `_count`, and `ObjectSchema.extend` reuses the parent's options, so a captured operator list would refuse a legitimate `having: { prices: { _count: { gt: 1 } } }` (measured, then fixed). |
| `src/validation/scalars/json.ts:127-280` | the JSON path grammar (six refusals) and the portability rule move to admission and normalise BOTH spellings to segments; the inert-`mode` refusal joins the filter's own `refuse`. `JsonPathOperand` is now `VibSchema<readonly string[] \| string, string[]>`: the preparer consumes segments only. |
| `src/validation/relations/filter.ts:123-148, 195-232`, `relations/index.ts:111` | to-one and to-many relation filters refuse an empty quantifier set, in the registered sentence, with the slot's own name (their schemas ARE per relation). `toManyFilterFactory` takes the `ResolvedSlot` its caller already held. |
| `src/validation/model/args/aggregate.ts:849-876, 895` | `by` is admitted as an array (`v.union([array, shorthandArray])`); the groupBy args object refuses a duplicate `by` member (registered sentence) and a grouped column named like a selected aggregate. |
| `src/validation/model/args/mutation.ts:56-85, 128`, `relations/create.ts:173`, `relations/update.ts:433` | `refuseDefaultOnlySkipDuplicates`, asked wherever the `createMany` verb is admitted — root, nested-in-create, nested-in-update. |

### Receipts

- `receipts/lane-q/u1-sqlite3-returning-json-after.txt` — `tests/providers/local/sqlite3-returning-json.test.ts`: **27 failed → 19 failed**. The eight family-3/4 JSON cells are green; the remaining 19 are family 2 (U2.1, 18 cells) and the nested-mode cell (U2.5).
- `receipts/lane-q/u1-layers-after.txt` — `layer-query-engine` + `layer-validation` + `layer-relations` + `layer-operation-schemas`: 5 failed / 2762 passed. All five are pre-existing and none is U1's: `contract-matrix` (an unclassified `tests/raptor3/candidate-handoff.test.ts`), `bulk-insert-row-shapes` (the hand-over below) and `select-mode-capability-matrix` ×3 (lane X, U7.4/U8).
- New falsifier `tests/contracts/engine/query/parity-admission.core.test.ts`, registered in `scripts/query-engine-test-manifest.mjs`: **69 cells, 3 dialects, all green**.

### Two witnesses re-pinned (not weakened)

Both asserted the DEFECT, so the repair inverts them; each now pins the decided behaviour and is strictly stronger:

- `tests/unit/operation-schemas/args/aggregate-args.core.test.ts` — "preserves by as string" → "normalises a single by to an array", plus a new duplicate-`by` refusal cell.
- `tests/unit/operation-schemas/relations/filter.core.test.ts` — "`{}` reads as the vacuous explicit filter" → "`{}` is refused", plus `{ is: undefined }`.
- `tests/raptor3/g4/review/cutover/round4-deleted-refusals.review.test.ts` — the round-4 REVIEW PROBE, whose every cell asserted the fail-open it was written to document. Inverted to assert the restored refusals. NOTE: this file is registered in no vitest project (it is a reviewer's probe), so it is inverted but NOT executed; its cells are covered by the new falsifier through the same public client.

### Hand-over to lane X (U1)

1. **`operation-context.ts:1379-1382` is now a second copy** of the default-only `skipDuplicates` refusal. Admission owns it (root and nested). Delete the physical copy — one guard per invariant.
2. **The empty `createMany` refusal on the `prepareBatch` seam** (`tests/contracts/engine/query/bulk-insert-row-shapes.core.test.ts` "empty createMany rejects during batch preparation", `No data to insert`) has no owner in lane Q's files: the decision is mode-dependent (preparation vs direct), so admission cannot own it, and both candidate owners — `OperationContext.createMany`'s `rows.length === 0` arm (`shared/operation-context.ts:1376`) and the `prepareBatch` seam (`commands/index.ts:227-243`) — are lane X's. Proposed: in `OperationContext.createMany`, `if (rows.length === 0) { if (this.ownership === "preparation") throw new QueryEngineError("No data to insert"); return this.emptyBulkResult(projection); }` — the direct path keeps Prisma's `{ count: 0 }`. **That cell stays red in lane Q.**

---

## U2 — Query lowering: one statement means what it says

### Decision-elimination gate (written before the first edit)

| | |
| --- | --- |
| **Required behaviour** | (1) A relation-filtered `updateMany`/`deleteMany`/`update`/`delete` affects exactly the rows the filter names, on every dialect, including a self relation and including MySQL (error 1093). (2) A raw `Sql` operand is one operand. (3) A cursor over a non-scalar order raises the CURSOR refusal, whatever the provider's vector support. (4) A bounded positive distance filter probes the spatial index; a negative one does not. (5) A JSON filter's own `mode` wins in both directions. |
| **Current owner** | `shared/query.ts:1052-1059` (`lowerMutationLimit`'s no-limit branch lowers the selector with NO qualifier) → `:1928` (`parentAlias ?? ""`) → `:524-529` (`column` treats `""` as "no alias") — the parent column is emitted bare and the correlated `EXISTS` rebinds to the child table. `:533-534, :548-551` return a raw `Sql` verbatim. `:2084 → :1889` consults `supportsVector` while BUILDING the term, before `:2205` can classify the order. `:1723-1739` lowers the distance comparisons with no index probe and no polarity. `:1231` folds `mode` downward only. |
| **Proposed change** | `lowerMutationLimit` lowers its selector with the target's SQL TABLE NAME as the qualifier (what `operations/update.ts:79-90` did) and threads that one fact so `lowerRelationPredicate` can hide a subquery over the mutation target behind a derived table when `!supportsMutationTargetInSubquery`. `value`/`scalarValue` parenthesise a raw fragment. `orderTerms`/`orderTerm` take the `cursored` fact and raise the cursor refusal in the `_distance` arm before `distanceExpression`. `prepareWhere`/`prepareOperations`/`prepareSlotPredicate` thread polarity; a bounded positive point distance carries `probe: true` and `lowerOperation` prepends the adapter's `withinBounds(geoBoundsForDistance(...))`. `prepareOperations` resolves `mode` per TARGET KIND (D-22). |
| **Invariant** | A lowered statement's correlation names the table the statement mutates; an operand is one expression; a refusal that classifies the REQUEST is raised before one that classifies the PROVIDER; a filter's index probe is a conjunct of the predicate it is implied by, never of its negation. |
| **Falsifier** | `tests/contracts/engine/query/parity-lowering.core.test.ts` (new): the `UPDATE … EXISTS … "<table>"."id" =` pin on three dialects, the MySQL derived-table wrap, the parenthesised fragment operand, the three cursor-refusal arms on a non-pgvector adapter plus one on a pgvector-capable adapter, the probe present under `lt`/`lte` and absent under `gte`/`NOT`, and the nested-mode SQL. Plus the 18 restored cells of `tests/providers/local/sqlite3-returning-json.test.ts` and the MySQL EXPLAIN loop in `tests/providers/docker/mysql2.test.ts`. |

### Changes

| file:line | change |
| --- | --- |
| `raptor3/shared/query.ts` `lowerMutationLimit` | both unaliased branches lower the selector with the target's SQL table NAME as the qualifier, and declare that name as the statement's mutation target. The capped branch is unchanged: it already reads the target through its own alias. |
| `raptor3/shared/query.ts` `lowerSelector` / `lowerPredicate` / `lowerRelationPredicate` | one new threaded fact, `mutationTarget`, and `hideMutationTarget`: an `EXISTS` over the mutated table is wrapped in `SELECT * FROM (…) qN` exactly when `!adapter.capabilities.supportsMutationTargetInSubquery` — the capability the estate declared and nothing consumed (MySQL ERROR 1093). |
| `raptor3/shared/query.ts` `value` / `scalarValue` | a raw `Sql` operand is parenthesised: it is an expression, not a token. |
| `raptor3/shared/query.ts` `orderTerms` / `orderTerm` / `page` + `CURSOR_ORDER_REFUSAL` | the `cursored` fact reaches the one order walker, so the `_distance` arm raises the CURSOR refusal before `distanceExpression` consults `supportsVector`. `page` remains the single raise point for relation terms; the sentence is stated once. |
| `raptor3/shared/query.ts` `prepareWhere` → `prepareSlotPredicate` / `prepareScalarPredicate` / `prepareOperations` / `prepareOperation`, `relationScope`, `lowerOperation` | polarity is threaded and a bounded positive GeoPoint `distance` carries `probe: true`; lowering prepends the adapter's `withinBounds(geoBoundsForDistance(to, bound))`. A relation arm's existing `inexact` fact IS its polarity (`none`/`isNot`/`every` consume their nested predicate under a negation), so no second flag was added. |
| `raptor3/shared/query.ts` `prepareOperations` | D-22: `mode` resolves per TARGET KIND — a JSON filter's own `mode` wins in both directions, a scalar filter's may only upgrade. |

### Receipts

- `receipts/lane-q/u2-sqlite3-returning-json-after.txt` — `tests/providers/local/sqlite3-returning-json.test.ts`: **176 passed / 176**. The 18 family-2 cells, the 8 family-3/4 cells and the nested-mode cell are all green; the file that opened this program at 27 red is clean.
- `receipts/lane-q/u2-mysql-relation-filter-mutation.txt` — `tests/providers/docker/mysql2-relations-ddl.test.ts`, MySQL 8 on 127.0.0.1:55730: **all 25 `relation-filter mutation behavior` cells pass**, including the three self-relation cells that reach ERROR 1093 without the derived-table wrap. The file's other 30 failures are `Push completed its statements but the final live fingerprint does not match the desired schema` and the known pre-existing mysql2 red set — the two lanes share this container and drop/create their own tables concurrently; no lane-Q owner is involved.
- New falsifier `tests/contracts/engine/query/parity-lowering.core.test.ts` (registered): **20 cells green** — the qualifier on three dialects, the wrap present on MySQL and absent elsewhere, the parenthesised fragment, the cursor refusal on non-pgvector AND pgvector adapters, and the probe present under `lte`, absent under `gte`, absent under `NOT` and absent inside a `none` arm.

---

## U3 — Query preparation: the projection and the grouped read

### Decision-elimination gate (written before the first edit)

| | |
| --- | --- |
| **Required behaviour** | (1) An explicit empty or all-false `select` is refused in the registered sentence; an empty DEFAULT projection still emits a row; a `_count` that counts nothing publishes no `_count`. (2) `having` and the grouped `orderBy` know the grouped column set. (3) A tagged polymorphic `_count` filter selects its arm. |
| **Current owner** | `shared/query.ts:3054-3176` (`prepareProjection`) has no empty arm at all — `SELECT  FROM …`, reported by the driver as the opaque `Query execution failed`; `:3078-3089` pushes the `_count` field unconditionally. `:3429` reads `args.by!` raw and neither `prepareHaving` (`:3467`) nor `groupOrderTerms` (`:3511`) ever sees `by`. `:3250` prepares a tagged `_count` filter as a scalar predicate against `edges[0].target`, so the tag key `type` is looked up as a column and `storage.ts:210` throws. |
| **Proposed change** | One arm at the end of `prepareProjection` with the shipped engine's two cases, plus `continue` on an empty count selection; a `sentinel` projection field carrying `EMPTY_ROW_RESULT_KEY` (already in `result-aliases.ts`). `grouped` computes the `by` SET once and hands it to both owners. `countedMemberships` publishes the `variants` fact it already computes, and `prepareCounts` reads `where.type` first, keeps that arm, prepares `is`/`isNot` against that arm's target and refuses an unknown tag. |
| **Invariant** | A prepared projection always names at least one column, and what it names is what the caller asked for; the grouped column set is computed once by the grouped read and consumed by everything that needs it; a tagged filter selects an arm, it is never a scalar predicate over one. |
| **Falsifier** | `tests/contracts/engine/query/parity-preparation.core.test.ts` (new, 36 cells × 3 dialects) and the provider cells `empty default projections` ×3, `Prisma parity › groupBy ordering and having` ×2, `_count: true skips to-one relations`, `polymorphic collection reads › total and filtered counts, and count ordering`. |

### Changes

| file:line | change |
| --- | --- |
| `raptor3/shared/query.ts` `PreparedProjectionField` | new `sentinel` kind and a named `PreparedCount` type. |
| `raptor3/shared/query.ts` `prepareProjection` | an empty count selection contributes no field; the empty-projection arm refuses an explicit empty `select` with the registered sentence and gives an empty DEFAULT projection the `EMPTY_ROW_RESULT_KEY` sentinel. |
| `raptor3/shared/query.ts` `lowerProjection`, `returningSafeProjection` | the sentinel lowers to `CAST(1 AS integer)` and rides a `RETURNING` like any other constant of the mutated row. |
| `raptor3/shared/query.ts` `countedMemberships` | publishes `{ edges, variants }` — the carrier fact it already computed, so `prepareCounts` does not classify the slot a second time. |
| `raptor3/shared/query.ts` `prepareCounts`, `correlatedCount` | a tagged `_count` filter selects its arm by `where.type`, prepares `is`/`isNot` against that arm's target, carries `negated` for `isNot`, and refuses an unknown tag with the registered sentence. |
| `raptor3/shared/query.ts` `grouped`, `prepareHaving`, `groupOrderTerms` | the grouped column set is computed once and threaded; both registered membership sentences are restored. |

### Receipts

- New falsifier `tests/contracts/engine/query/parity-preparation.core.test.ts` (registered): **36 cells green**.
- `receipts/lane-q/u3-sqlite3-polymorphic-batch.txt` — `sqlite3-polymorphic-batch.test.ts`: **3 failed / 146 passed** (was 5 failed). The two `groupBy` membership cells and `polymorphic collection reads › total and filtered counts, and count ordering` are green. The three that remain are U5.4 (two orphan cells) and lane X's U6.6 singular-transfer write cell.
- `sqlite3-scalar-roundtrip.test.ts` `empty default projections` ×3: green (was 2 red + 1 red).

---

## U4 — The update language is consumed once

### Decision-elimination gate (written before the first edit)

| | |
| --- | --- |
| **Required behaviour** | An admitted `(model, field, payload)` is interpreted by `Queries.prepareUpdate` EXACTLY once. A JSON document or a GeoPoint survives a nested update and a MySQL root update; a document that carries its own `set` key round-trips verbatim; `{ increment: 2 }` still increments on both routes; `requireLiteral`'s relation-key refusal still fires. |
| **Current owner** | `commands/assignments.ts:34-36, :55` — `scalarAssignment` unwraps `{ set: X }` at STORAGE time; `command-attempt.ts:60-67` hands the unwrapped value to `commands/execution.ts:291/:299` → `OperationContext.update/insert` → `Queries.updateAssignment` (`operation-context.ts:1966-1968`) → `prepareUpdate` (`query.ts:807-850`), a second pass. For a string it is a no-op; for a document it is `Unknown update operation: z`, and for a document with its own `set` key it is a silent rewrite. |
| **Proposed change** | `Assignments` stores the admitted payload verbatim. One private `named(assignment)` answers "the value this payload names, or `undefined` when it names an OPERATION", gated on `operation === "update"` because the envelope exists only in the update language — which also stops a CREATE's document spelled `{ set: … }` from being unwrapped. Its readers are exactly the key-reconciliation ones: `known`, `equal`, `requireLiteral`, and the new `stated`, which `CommandAttempt.read` consumes. `values()` keeps submitting the payload verbatim. |
| **Invariant** | `Assignments` holds admitted payloads, never interpreted ones; the value inside an update envelope is read where a KEY is reconciled and nowhere else. |
| **Falsifier** | `tests/contracts/engine/query/parity-assignments.core.test.ts` (new) and the ten `delegated nested update — JSON write envelope` cells of `tests/providers/local/sqlite3-nested-write.test.ts`, plus the two MySQL GeoPoint cells. |

### Changes

| file:line | change |
| --- | --- |
| `raptor3/commands/assignments.ts` | `scalarAssignment` is deleted; the constructor stores `literal(value)`. New private `named()` and public `stated()`; `known()`, `equal()` and `requireLiteral()` read through `named()`. `requireLiteral` now accepts `{ set: 'x' }` by asking the same owner instead of by the accident of an unwrapped storage value. |
| `raptor3/commands/command-attempt.ts` `read` | resolves through `fields.stated(field)` — the key-reconciliation reader — instead of the raw contribution, so a referenced key crosses as its value while the row's own write still carries its payload. |

### Receipts

- `receipts/lane-q/u4-sqlite3-nested-write.txt` — `tests/providers/local/sqlite3-nested-write.test.ts`: **4 failed / 81 passed** (was 11 failed). All ten `delegated nested update — JSON write envelope` cells are green, including the adversarial `{ set: { z: 1 }, increment: 4 }` document and the `data`-column escape. The four that remain are lane X's: two `keep child mutations parent-correlated` (U6.2) and two many-to-many cells (U6.1/U6.3).
- New falsifier `tests/contracts/engine/query/parity-assignments.core.test.ts` (registered): **6 cells green** — the adversarial document on the update, create and RECORD routes, `increment` still spelled `"score" = "score" + ?` on both routes, the relation-key refusal, and the `{ set: … }` spelling the refusal's own sentence names.

---

## U5 — One physical result vocabulary and the driver result seam

### Decision-elimination gate (written before the first edit)

| | |
| --- | --- |
| **Required behaviour** | (1) A decimal is exact wherever it is read — top level, inside an `include`, as an aggregate. (2) The provider's own representation rules are asked once, at the row boundary, and never again for a value a JSON window already decoded. (3) A wrong provider row fails closed with the public error class, and a carrier the statement always builds cannot decode as `null`. (4) A polymorphic membership whose row is gone is refused, not read as absent. (5) The registered `_distance` collision sentence and the cursor carrier's one home. |
| **Current owner** | `query.ts:658-683` casts a projected decimal to text while `:689-696` (`carriedValue`) casts only `bigint`, so a decimal inside a window arrives as a JSON number or array and its codec refuses it. `:3815-3816` `JSON.parse`s a string in the decoder, so a window value is parsed twice and the driver's own rules (`drivers/shared/sqlite-utils.ts:59-63`) and the old JSON normalization are unreached — `adapter.result.parseField` / `parseRelation` / `parseResult` are declared, implemented by every adapter and driver, and called by NOTHING. `:3643/:3647/:3655` raise bare `TypeError`s that `run` does not translate; `:3649` returns `null` for any object shape; `record(decoded)[field]` reads inherited members. A polymorphic orphan reads as absent. |
| **Proposed change** | `carriedValue` states the SAME physical fact `projectedColumn` produced for a decimal. `Queries` takes the driver's `DriverResultParser` and asks driver→adapter→codec once per ROW value (`providerValue`), with `carried` threaded through `decodeValue`/`decodeScalar` so a window value is never asked again; the JSON value domain is normalized by the decoder (`jsonValue`). Object shapes carry `nullable`, members are read with `Object.hasOwn`, structural failures are `InvalidScalarResult`. A variant ROW carrier's arm is lowered as "claimed ⇒ a document (empty when the row is gone), unclaimed ⇒ null" and the decoder refuses the empty one. `CURSOR_CARRIER_PREFIX` joins `result-aliases.ts`. |
| **Invariant** | A projected scalar's physical form is stated once per (leaf, carrier) and the decoder receives that form; the transport is asked about a value exactly once, at the boundary where the provider handed it over. |
| **Falsifier** | `tests/contracts/engine/query/parity-decoding.core.test.ts` (new) plus `sqlite3-scalar-roundtrip.test.ts` (180/180), the MySQL GeoPoint suite, and the polymorphic orphan cells. |

### Changes

| file:line | change |
| --- | --- |
| `raptor3/shared/query.ts` `carriedValue` | a decimal — scalar or list — crosses a window as TEXT, the fact `projectedColumn` already stated. |
| `raptor3/shared/query.ts` `Queries` constructor, `providerValue` | the driver's `DriverResultParser` reaches the decoder (D-17); the chain is driver → adapter → codec, and a throwing provider rule becomes `InvalidScalarResult` instead of escaping as a `SyntaxError`. |
| `raptor3/shared/query.ts` `decodeProjection` / `decodeValue` / `decodeScalar` / `decodeList` | `carried` threading: the chain runs at the ROW boundary only. Own-key member reads, `InvalidScalarResult` for the three structural failures, and the null/absent questions answered on the RAW value so a provider that decodes `'null'` into the JSON null document still writes a NOT NULL `json` column. |
| `raptor3/shared/query.ts` `jsonValue` + `isPlainJsonRecord` | the JSON value domain: `bigint` → number when safe (SQLite's `JSON` column has NUMERIC affinity, so `42` comes back `42n`), non-finite refused, sparse array refused, prototype-safe rebuild. |
| `raptor3/shared/query.ts` `ProjectionShape` + `prepareProjection` | object shapes carry `nullable`; a `_count` carrier is `nullable: false`. |
| `raptor3/shared/query.ts` `parentClaimsArm`, `lowerProjection`, `decodeValue`, `orphanedArm` | a variant ROW carrier's arm distinguishes EMPTY from ORPHANED, from the arm's own selected keys and no private carrier column (D-19). |
| `raptor3/shared/query.ts` `prepareProjection` + `DISTANCE_NAME_COLLISION` | the second registered `_distance` sentence (`result/result-shape.ts:164`) is restored, in both key orders; the two-distance sentence, which two registered G4 tests pin, is unchanged (D-24 read as "restore the missing one", because BOTH sentences are registered in a surviving file). |
| `src/query-engine/result-aliases.ts` + `query.ts` + `tests/contracts/drivers/behaviors/ordering-plan-behavior.ts` | `CURSOR_CARRIER_PREFIX` gets one home and the behaviour module reads it (D-21); the same module's plan pins now read the statement's OWN outer alias instead of the deleted engine's `t0`. |
| `raptor3/shared/operation-context.ts:303`, `raptor3/commands/index.ts:144` | ONE argument each — the two `new Queries(...)` call sites hand over `driver.result`. These two lines are in lane X's files and are the only lane-Q edit there; D-17 cannot be satisfied without them. |

### Receipts

- `tests/providers/local/sqlite3-scalar-roundtrip.test.ts`: **180 passed / 180** (was 12 failed) — decimal exactness at top level, in an `include` and in `groupBy`, every scalar type inside an include, and the JSON primitives with their `typeof`.
- `receipts/lane-q/u5-mysql2.txt` — `tests/providers/docker/mysql2.test.ts`: the eleven `GeoPoint behavior` cells and `uses the GeoPoint spatial index only for positive indexable predicates` (the U2.4 EXPLAIN loop) are green. 8 cells remain red: the collection orphan and the singular-inverse duplicate (below), the singular-transfer write and the batch-only refusal (lane X), and four `MySQL namespace containment` cells that are pre-existing/environmental (both lanes drop and recreate tables in this container).
- `tests/providers/local/sqlite3-polymorphic-batch.test.ts`: **2 failed / 147 passed** (was 5 failed at the start of the lane).
- New falsifier `tests/contracts/engine/query/parity-decoding.core.test.ts` (registered): **9 cells green**.

### Still red, with the reason

1. **`polymorphic collection reads › an owner-scoped orphan fails the read, even hidden behind only`** (sqlite3 + mysql2). The to-one carrier's orphan is repaired; a COLLECTION's is not. The cell requires the refusal under `only: []` — i.e. with NO arm selected — so it cannot be derived from any arm's selected key: the membership rows live in the junction, and "a membership whose target row is gone" is a fact only a probe OUTSIDE the arm subqueries can state (which is what the deleted `POLYMORPHIC_COLLECTION_ORPHANS_KEY` carrier was). That is a private carrier column, which D-19 rules out for the to-one case and says nothing about here. **Decision needed from Arnaud**, and then: one correlated count per CONFIGURED member — `COUNT(*) FROM <junction> j WHERE <source correlation> AND NOT EXISTS (SELECT 1 FROM <target> t WHERE <target correlation>)` — emitted whatever `only` selects, published under `POLYMORPHIC_COLLECTION_ORPHANS_KEY`, and refused in the same decoder arm as the to-one orphan (`Queries.decodeValue`'s variants branch, which already owns the sentence).
2. **`polymorphic collection reads › a singular-inverse duplicate fails BEFORE the LIMIT`** (mysql2). Needs the arm to COUNT its rows before the row `LIMIT` — a second aggregate beside the arm's row window, the same "a probe outside the row subquery" shape as (1), and best done with it.
3. **`official cache stale-while-revalidate › contains provider, snapshot, set, and cleanup failures`** (`hostileJsonReadsAtCoreBoundary` is 0 where 1 is required). The counter is captured INSIDE the driver's `parseResult` — the seam that wraps the whole result parsing — and the cell requires exactly one hostile-getter read before that capture and none after. The decoder's new prototype-safe JSON rebuild reads a hostile member exactly once, which is the half lane Q owns; the read that has to happen BEFORE the boundary is the cache route's own materialization (`route/client-route.ts` and `result/cache-value-codecs.ts`, both lane X's). Reported, not hidden.

---

## Lane state at hand-off

Whole-estate typecheck: **zero diagnostics** (`node scripts/run-typecheck.mjs`,
`receipts/lane-q/typecheck.txt`). `npx biome check` on every touched file: no
diagnostic that was not already there at `356254a2` (the one file that still
reports `format` and `noParameterProperties`, `shared/query.ts`, reported both
before this lane; the five new files and every edited test file are clean).

| suite | at `356254a2` | now |
| --- | --- | --- |
| `tests/providers/local/sqlite3-returning-json.test.ts` | 27 red | **0** |
| `tests/providers/local/sqlite3-scalar-roundtrip.test.ts` | 12 red | **0** |
| `tests/providers/local/sqlite3-nested-write.test.ts` | 11 red | 4 red (all lane X) |
| `tests/providers/local/sqlite3-polymorphic-batch.test.ts` | 5 red | 2 red (1 lane Q, reported above; 1 lane X) |
| `tests/providers/local/sqlite3-index-ddl.test.ts` | 2 red | **0** |
| local provider lanes (`provider-sqlite3` + `provider-libsql`) | — | 6 red: 5 lane X, 1 lane Q (the collection orphan) |
| core layers other than query-engine/client/drivers | — | **0 red** (6,240 cells) |
| `layer-query-engine` + `layer-client` + `layer-drivers` | — | 11 red: 1 lane Q (cache SWR), 9 lane X, 1 pre-existing (`contract-matrix` does not classify `tests/raptor3/**`, which no lane touched) |
| `tests/providers/docker/mysql2.test.ts` | — | 8 red: 2 lane Q (above), 2 lane X, 4 pre-existing/concurrent-DDL namespace cells; the eleven GeoPoint cells and the spatial-index EXPLAIN loop are green |
| `tests/providers/docker/mysql2-relations-ddl.test.ts` | — | all 25 `relation-filter mutation` cells green (the ERROR 1093 wrap), 30 pre-existing/concurrent reds |

Five new falsifier files, all registered in
`scripts/query-engine-test-manifest.mjs` → `layer-query-engine`, **140 cells,
all green**: `parity-admission`, `parity-lowering`, `parity-preparation`,
`parity-assignments`, `parity-decoding` (`receipts/lane-q/falsifiers.txt`).
No raptor3-manifest count was touched (no registered raptor3 file gained a cell).

### Hand-overs to lane X, in one list

1. Delete the now-duplicated default-only `skipDuplicates` refusal at
   `shared/operation-context.ts:1379-1382` (admission owns it).
2. Add the `No data to insert` refusal on the preparation route, in
   `OperationContext.createMany`'s `rows.length === 0` arm — the exact diff is
   in U1's hand-over above. `bulk-insert-row-shapes` stays red until then.
3. Two lines of lane X's files carry lane Q's D-17 change and must survive a
   merge: `shared/operation-context.ts:303` and `commands/index.ts:144` now
   pass `driver.result` to `new Queries(...)`.
4. The cache SWR hostile-JSON cell needs the cache route's own materialization
   to read a published hostile member once, before the driver's `parseResult`
   boundary (U5, "still red" item 3).

### Follow-ups for Arnaud

- **The collection orphan and the singular-inverse duplicate** need a probe
  outside the arm's row subquery — D-19 forbade a private carrier for the
  TO-ONE case and is silent on the collection, whose `only: []` spelling makes
  an arm-derived answer impossible. The design is written out in U5's "still
  red" item 1.
- **The admission sentences lost their field name** (the rule at the top of
  this note). If `Filter for field '<f>' must contain at least one operation.`
  is wanted byte for byte, the per-scalar filter schemas have to be built per
  FIELD, which defeats `validation/scalars/intern.ts`'s interner; the field is
  currently in the `ValidationError`'s issue path instead.
- **`Aggregate '_count' cannot be selected together with a model field named
  '_count'.`** is a NEW sentence, in the register of the relation-count one it
  mirrors (`select-builder.ts:367`); the shipped engine had no groupBy twin.

---

# Round 2 — the resolutions of `lane-q-review.md`, and nothing else

Same worktree (`/private/tmp/viborm-parity-q`, branch `parity-q`, base
`356254a2`), same `TMPDIR`. Seven findings, applied exactly as the review
spelled them; receipts are `receipts/lane-q/round2-*.txt`.

## R1 (blocking) — the decimal LIST carrier, repaired

`src/query-engine/raptor3/shared/query.ts` `carriedValue`. The unit's own
invariant is "`carriedValue` consumes the physical fact `projectedColumn`
produced", and `projectedColumn` produces TWO spellings for a decimal: a text
cast for a scalar, `adapter.arrays.decimalProjection(column)` for a list
(`CAST(x AS TEXT[])` on PostgreSQL). The arm now states the same pair:

```ts
    if (leaf.type === "decimal")
      return leaf.list
        ? this.adapter.arrays.decimalProjection(expression)
        : this.adapter.expressions.cast(expression, "text");
```

The comment above it names the two spellings instead of "scalar OR list … as
TEXT". No-op on SQLite and MySQL (one spelling there), and it removes the one
cell the branch had added on PostgreSQL.

**Receipts.**

| suite | before (review) | now |
| --- | --- | --- |
| `tests/providers/docker/pg.test.ts` | 21 red | **20 red** (`round2-pg.txt`), and `pg scalar round-trip behavior › include round-trips datetime, decimal, and bigint exactly` is **green** |
| `tests/providers/docker/postgres-serialization.test.ts` | the same cell red | **4 red** (`round2-postgres-serialization.txt`), all four the pre-existing `enum references` cells; the decimal include cell is **green** |
| `tests/providers/local/sqlite3-scalar-roundtrip.test.ts` | 180/180 | **180/180** (`round2-sqlite3.txt`) |

The 20 PostgreSQL reds are the pre-existing set the review attributed at the
base: 15 GeoPoint/PostGIS cells (this container has no PostGIS),
`JsonNull is storable in a NOT NULL json column`, and the four `enum references`
cells. The −18 the lane repairs is unchanged; the +1 is gone.

## R2 (blocking) — the polymorphic collection filter is closed

`src/validation/relations/polymorphic/filter.ts`
`polymorphicCollectionFilterFactory` now takes the slot name — its one caller,
`src/validation/relations/polymorphic/index.ts:306`, passes the `relationKey`
it already holds — and carries the `refuse` hook with the shipped engine's
registered sentence, byte for byte from
`builders/polymorphic-collection-filter-builder.ts:126-130` at `ff5e77ca`:

> `Polymorphic collection filter '<slot>' requires one of: some, every, none.`

so `where: { items: {} }` no longer lowers to `WHERE 1`. That closes the third
relation surface that spells quantifiers; the to-one variant filter was already
closed by its presence arm.

**Falsifier.** `tests/contracts/engine/query/parity-admission.core.test.ts`
gains "a polymorphic collection filter names its own slot", beside the two
relation-filter cells, over a new two-variant `gallery` model in the file's
schema: **69 → 72 cells (3 dialects), all green** (`round2-core-falsifiers.txt`).

**One witness inverted, not deleted.**
`tests/unit/operation-schemas/relations/polymorphic-collection-filter.core.test.ts`
"an empty filter object is accepted and states nothing" asserted the fail-open
this repair closes; it is now "an empty filter object is refused" and pins the
registered sentence. Same cell count (19), stronger assertion — the same
treatment the lane gave the three round-1 witnesses.

## R3 — U5.5 is not lost: hand-over #5

Not implemented in lane Q, reported here with its exact diff, the way U1's two
hand-overs are written. The owner is lane X's file and the rule has one real
exception the plan's sentence does not carry (`skipDuplicates` is a LEGITIMATE
shortfall), so it is a lane-X edit, not a lane-Q one.

**Hand-over #5.** `src/query-engine/raptor3/shared/operation-context.ts`,
`createMany`'s result reducer (`:1529-1533` on this branch):

```diff
     return this.setMutations(statements, (results) => {
-      if (!projection)
-        return {
-          count: results.reduce((count, result) => count + result.rowCount, 0)
-        };
+      if (!projection) {
+        const count = results.reduce(
+          (total, result) => total + result.rowCount,
+          0
+        );
+        // Affected-row counts are execution semantics (rule 4), and this is
+        // the one verb that knows exactly how many rows it submitted.
+        // `skipDuplicates` is the ONLY legitimate shortfall — every other one
+        // is a provider that under-reported, and publishing it as `{ count }`
+        // is a wrong answer, not a smaller one.
+        if (!skipDuplicates && count !== rows.length)
+          throw new QueryEngineError(
+            `Driver "${this.driver.driverName}" reported ${count} inserted rows for a createMany of ${rows.length}.`,
+            {
+              meta: {
+                driver: this.driver.driverName,
+                operation: this.operation
+              }
+            }
+          );
+        return { count };
+      }
       const output: Input[] = [];
```

Falsifier (the plan's own): a fake driver answering a 2-row `createMany` with
one `rowCount: 1` raises and publishes nothing, while the same 2-row call with
`skipDuplicates: true` still publishes `{ count: 1 }`.

## R4 — the D-22 falsifier now falsifies

`tests/contracts/engine/query/parity-lowering.core.test.ts`, both "JSON mode
precedence (D-22)" cells. They asserted that `lower(` appears at least once,
which is true of the upgrade-only rule D-22 replaced. They now pin the
ASYMMETRY — the difference a declared `default` makes:

- `a JSON filter's own 'default' wins against the inherited mode`: the statement
  whose inner `not` carries `mode: "default"` DIFFERS from the same statement
  without it, and folds strictly fewer arms.
- `a scalar filter's 'default' changes nothing — its mode may only upgrade`: the
  two statements are identical, and both still fold.

**Falsification receipt** (`round2-d22-falsification.txt`): with the D-22 arm
reverted to `const folded = insensitive || declared === "insensitive";` in a
backed-up copy, the file is **1 failed / 19 passed** — the JSON cell reddens and
the scalar cell stays green, which is exactly right (the reverted rule IS the
scalar rule). Restored from the scratchpad copy, md5 verified. Before the
repair the same mutation left the file 20/20 green.

## R5 — no code change; it is Arnaud's ruling

The four sentences that lost their `for field '<f>'` clause stay as they are.
The reason is the rule at the top of this note (the per-scalar filter objects
are interned, so the admission owner cannot name the field; the field is in
`issues[0].path`), the review confirmed the substitute is real, and it is
already escalated under "Follow-ups for Arnaud". Round 2 changes nothing here:
until he rules, the lane claims "the relation, groupBy, select, `_distance` and
polymorphic sentences are restored byte for byte", NOT "every refusal is".

## R6 — the one new format hunk is gone

`src/query-engine/raptor3/commands/index.ts` wraps the `new Queries(...)` call
as the formatter prints it. `npx biome check` on that file now reports exactly
the two hunks that were there at `356254a2` (the multi-line `throw new Error`
and the `NotFoundError` arrow), neither of them in this lane's diff.

## R7 — the claim in `mutation.ts` is made true

`refuseDefaultOnlySkipDuplicates` is now asked on the polymorphic collection
group too (`src/validation/relations/polymorphic/collection-mutation.ts`, the
`createMany` verb builder; `TaggedVerbOptions` gained the optional `refuse`).
The comment at `src/validation/model/args/mutation.ts:57-67` said the refusal is
asked "wherever the verb appears … and a polymorphic collection group", and it
now is — which also means hand-over #1 (deleting the physical copy at
`operation-context.ts:1379-1382`) opens no hole on that route.

`layer-operation-schemas`: **47 files / 1290 cells, all green**
(`round2-operation-schemas.txt`).

## Round 2 state

| check | result | receipt |
| --- | --- | --- |
| `parity-admission` + `parity-lowering` + `parity-decoding` | 101 cells green (72 + 20 + 9) | `round2-core-falsifiers.txt` |
| `layer-operation-schemas` (whole project) | 1290 green | `round2-operation-schemas.txt` |
| `sqlite3-scalar-roundtrip` + `sqlite3-polymorphic-batch` | 327 green, 2 red (the reported collection orphan + lane X's singular transfer) | `round2-sqlite3.txt` |
| `tests/providers/docker/pg.test.ts` | 20 red, all pre-existing at the base | `round2-pg.txt` |
| `tests/providers/docker/postgres-serialization.test.ts` | 4 red, all pre-existing `enum references` | `round2-postgres-serialization.txt` |
| `decimal-list-surface.test.ts` (live PGlite PostgreSQL) | 41 green | `round2-decimal-list-surface.txt` |
| D-22 falsification | JSON cell reddens under the revert | `round2-d22-falsification.txt` |
| `node scripts/run-typecheck.mjs` | **zero diagnostics**, exit 0 | `round2-typecheck.txt` |

`npx biome check` on every file this round touched: no diagnostic this round
introduced (`shared/query.ts` keeps only the pervasive pre-existing set, and its
new lines are in no format hunk; `commands/index.ts` is back to its two base
hunks). No `.skip`, no deleted cell, no test weakened. Files changed in round 2:

- `src/query-engine/raptor3/shared/query.ts` (`carriedValue`)
- `src/query-engine/raptor3/commands/index.ts` (format)
- `src/validation/relations/polymorphic/filter.ts` (+ `polymorphic/index.ts`)
- `src/validation/relations/polymorphic/collection-mutation.ts`
- `src/query-engine/raptor3/AGENTS.md` (lane Q section: the three quantifier
  surfaces, the polymorphic `createMany` group, the two decimal spellings)
- `tests/contracts/engine/query/parity-admission.core.test.ts`
- `tests/contracts/engine/query/parity-lowering.core.test.ts`
- `tests/unit/operation-schemas/relations/polymorphic-collection-filter.core.test.ts`

One of the review's unverified items is now partly answered: the decimal LIST
path R1 repairs is green on a LIVE PGlite PostgreSQL
(`decimal-list-surface.test.ts`, 41 cells, 1481 MiB peak — it fits the ceiling
where `pglite-scalars.test.ts` does not). Still unverified, unchanged from the
review: the `provider-pglite` project cannot run under
the 1536 MiB runner ceiling, and the hosted drivers (`planetscale`, `neon-http`)
declare no `DriverResultParser`, so a hosted transport that hands JSON back as
text would publish the string after D-17.
