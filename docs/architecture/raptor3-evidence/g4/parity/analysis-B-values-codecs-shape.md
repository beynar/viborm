<!-- read-only analysis by an Opus analyst, 2026-09-17 morning; input to parity-plan.md -->

I have everything I need. Writing the report.

# Raptor 3 — families 1, 11, 19, 21, 6, 16, 17

All line numbers are at HEAD `356254a2`; old-engine lines are at `ff5e77ca` unless marked `5a37bcd7`. Family 11 was reproduced live (12 failed / 168 passed in `tests/providers/local/sqlite3-scalar-roundtrip.test.ts`, identical to the round-4 receipt). Nothing in the tree was changed.

---

## Family 1 — a nested object value parsed as an update-operator bag (9 cells)

**Diagnosis.** This is not a missing rule about "which objects are operator bags". The rule exists and is right: the **validation update schema** answers it per scalar kind, once, at admission. `src/validation/scalars/json.ts:180-189` builds a JSON field's update schema as `v.coerce(jsonWriteOperand, value => ({ set: value }))` — a JSON field has *no* update operators, so every admitted document is wrapped, including `{ set: {z:1}, increment: 4 }`, which becomes `{ set: { set: {z:1}, increment: 4 } }`. `src/validation/scalars/point.ts` does the same through `v.shorthandUpdate` (`src/validation/primitives/shorthand.ts:19`). The old engine consumed that and nothing else: `buildAssignment`'s header at `builders/set-builder.ts:88-92` states "Schema validation normalizes all values to operation objects", and its `Unknown update operation` throw at `:215-217` was documented as unreachable. Raptor3 runs the same schemas (`shared/schema.ts:208-227`, `parseValidated`).

The defect is **double consumption of the one update language**. `commands/assignments.ts:34-36` (`scalarAssignment`) unwraps `{ set: X }` to `X` at *storage* time and `:55` writes that unwrapped value into `writes`. `command-attempt.ts:60-67` (`values`) hands those unwrapped values to `commands/execution.ts:291`/`:299`, which passes them to `OperationContext.update` / `insert`, which calls `Queries.updateAssignment` (`shared/operation-context.ts:1966-1968`) → `prepareUpdate` (`shared/query.ts:807-850`) a **second** time. For string/number payloads the second pass is a no-op (`wholeValue` returns early for non-objects, `query.ts:471-472`). For an object domain it is not: `{ set: {z:1} }` → `{z:1}` → no `set`, no operator → `Unknown update operation: z` (`query.ts:846-849`). The adversarial cell proves the double pass arithmetically: `{ set: {z:1}, increment: 4 }` is admitted as `{ set: <doc> }`, unwrapped once to `<doc>`, unwrapped again by `wholeValue` (which finds the user's own `set` key) to `{z:1}` — exactly the observed `expected { z: 1 } to deeply equal { set: { z: 1 }, increment: 4 }`.

The reachability split explains the cell distribution. `Commands.rootUpdate` (`commands/commands.ts:1032-1046`) bypasses `Assignments` and passes `ctx.schema.scalars(model, args.data)` — the *admitted* payload — straight to `ctx.updateMany`, so it interprets exactly once. It is gated on `!namesRelation` **and** `supportsReturning`. So: SQLite/PG are broken only when the update names a relation (the 7 delegated-JSON cells); MySQL has `supportsReturning: false` (`src/adapters/databases/mysql/mysql-adapter.ts:934`), so **every** root update of a JSON or GeoPoint column on MySQL is broken (the 2 GeoPoint cells). `wholeValue`'s sibling `addressesOperators` (`query.ts:420-427`) already carries the per-scalar-kind rule on the *filter* side (`json`/`point` need a known filter operator key) — the update side has no such need, because admission already normalized.

| cell | observable | raptor3 owner | old engine | truth | fix | falsifier |
|---|---|---|---|---|---|---|
| delegation seam stores the JSON document (sqlite3) | `Unknown update operation: z` | `commands/assignments.ts:34-36,55` → `command-attempt.ts:60-67` → `commands/execution.ts:291` → `shared/query.ts:807-850` | `builders/set-builder.ts:88-92` consumed the admitted envelope once; `:215-217` unreachable | update language (rule 9) + one authority (rule 1) | `Assignments` stores the **admitted payload verbatim**; `wholeValue` is applied lazily only at the key-reconciliation readers (`known`, `equal`, `requireLiteral`, `absorb`) — which is what its own comment at `assignments.ts:28-33` already claims | see below |
| depth-2 / depth-3 to-one chain | `Unknown update operation: m` / `s` | same | same | same | same | same |
| delegated to-many update target | `Unknown update operation: z` | same | same | same | same | same |
| documented `data`-column escape | `Unknown update operation: label` | same | same | same | same | same |
| non-delegated depth-1 target | `Unknown update operation: z` | same | same | same | same | same |
| JSON doc that LOOKS like the envelope | `expected { z: 1 } to deeply equal { set: { z: 1 }, increment: 4 }` | same (two unwraps) | same | same | same | same |
| MySQL GeoPoint round-trip | `Unknown update operation: longitude, latitude` | same, reached because `mysql-adapter.ts:934` disables `rootUpdate` (`commands.ts:1038`) | same | same | same | same |
| MySQL GeoPoint callback/array transactions | same | same | same | same | same | same |

**Invariant.** `Queries.prepareUpdate` is applied exactly once per admitted `(model, field, payload)`; no owner feeds its output back into it. `Assignments` holds admitted payloads, never interpreted ones.
**Falsifier.** With the fix: (a) a JSON column whose admitted document is `{ set: {z:1}, increment: 4 }` round-trips verbatim through a nested update on SQLite/PG *and* through a root update on MySQL; (b) `payload: {z:1}` stores `{z:1}`; (c) `score: { increment: 2 }` still increments by 2 on **both** routes (the fold and the record route) — this is the half a naive "stop unwrapping" patch breaks; (d) a GeoPoint `{longitude, latitude}` round-trips on MySQL; (e) `requireLiteral`'s relation-key refusal still fires for `{ increment: 1 }` on a relation key.

---

## Family 11 — decimal exactness and scalar round-trip decoding (7 cells)

**Diagnosis.** Three distinct causes, none of which is "the leaf codec reimplements decimals". The decimal path *does* go through the existing codecs (`decodePhysicalDecimal`, `decodePhysicalDecimalList`, `materializePhysicalDecimal`, `validateGeoPoint`, `decodeBlob` at `query.ts:3729-3739, 3856-3866`), so rule 11 is honoured there. What raptor3 dropped is the **adapter/driver result seam**: it never calls `adapter.result.parseField` or `driver.result.parseField` (only the four representation flags at `query.ts:618, 734, 3731, 3861, 3874`). The old engine routed every scalar through both (`result/ResultParser.ts:790-800, 806`).

**(a) The JSON-window vocabulary is stated twice and differently.** `projectedColumn` (`query.ts:658-683`) casts a scalar decimal to text and spells a decimal list through `arrays.decimalProjection`. `carriedValue` (`query.ts:689-696`) — the value carried *inside* a `json_object` — casts only `bigint` to text and wraps `list | json | point | vector` in `json.document(...)`. So inside a window: a decimal aggregate arrives as a JSON **number** while `decodeCoefficientAtPrecision` requires `isString` (`src/validation/primitives/decimal-codec.ts:765-773`); a decimal **list** arrives as a JSON **array** while `decodeDecimalListContainerAtPrecision` requires `isString` (`decimal-codec.ts:1106-1118`). The old engine cast `bigint` *and* `decimal` to text before the `json_object` — verbatim, `builders/aggregate-utils.ts:123-128`: `if (scalarType === "bigint" || scalarType === "decimal") expr = adapter.expressions.cast(expr, "text")`.

**(b) A rule the driver owns was inlined into the decoder.** `query.ts:3815-3816` is `case "json": return typeof value === "string" ? JSON.parse(value) : value`. The parse belongs to `src/drivers/shared/sqlite-utils.ts:59-63` ("SQLite stores json as TEXT — decode here where we know the string is serialized JSON"); the SQLite *adapter*'s `parseField` is a pass-through (`sqlite-adapter.ts:880-884`). Inlining it produces two symptoms. Inside a window the value is already parsed, so a JSON document that *is* a string gets parsed twice → `JSON.parse("just a json string")` → `SyntaxError` (stack confirmed live at `query.ts:3816` under `3626 ← 3656 ← 3654 ← 3646 ← 3645`). And the old `parseJsonValue` normalization is gone (`ff5e77ca:src/query-engine/result/scalar-structured-parser.ts:144-200`: bigint→number when safe, non-finite number refused, sparse array refused, prototype-safe record rebuild). SQLite declares a `json` column as `JSON` (`src/migrations/drivers/type-mapping.ts:56`), which has **NUMERIC affinity**, so the bound text `"42"` is stored as INTEGER 42 and `better-sqlite3` with `safeIntegers` returns `42n` — published verbatim. Hence `expected 42n to deeply equal 42`.

**(c) A raw `Sql` operand is not parenthesized.** `Queries.value`/`scalarValue` return an `Sql` verbatim (`query.ts:533-534, 548-551`), so `"views" >= SELECT MAX("views") FROM …` is emitted. The old engine wrapped it: `builders/where-builder.ts:472` — `const fragmentOperand = (fragment: Sql): Sql => sql\`(${fragment})\`` — applied at `:492`. (Its companion refusal, "An SQL fragment is not supported by the '<op>' filter", `where-builder.ts:527-533`, *is* still honoured — the neighbouring cell "a fragment is refused where a reference is" passes.)

| cell | observable | raptor3 owner | old engine | truth | fix | falsifier |
|---|---|---|---|---|---|---|
| include round-trips datetime, decimal, bigint | `malformed decimal scalar … "findUnique": not an exact decimal list` | `query.ts:689-696` (`carriedValue` wraps a decimal list in `json.document`) vs `:658-664` | `builders/aggregate-utils.ts:123-128`; select-builder cast to text | codec ↔ adapter boundary (rule 11) | `carriedValue` must consume the **same** physical fact `projectedColumn` produced instead of re-deriving from the leaf kind: a decimal (scalar or list) stays TEXT inside a window | a decimal list and a decimal aggregate decode identically at top level and inside an `include` |
| `_min/_max/_sum/_avg are exact` | `malformed decimal scalar … "aggregate"` | `query.ts:2733-2757` + `:689-696` (no decimal text cast) | `aggregate-utils.ts:120-128` | same | same | `_sum`/`_avg`/`_min`/`_max` of a `decimal(12,2)` are exact on SQLite |
| `_avg rounds exact ties to the even neighbour` | same | same | same | same | same | same |
| `groupBy compares a widened _sum` | `… "groupBy": the sum is not an exact decimal at this column's scale` | same (`widened` leaf, `query.ts:2729`) | same | same | same | same |
| every scalar type inside an include | `SyntaxError: Unexpected token 'j', "just a json string"` | `query.ts:3815-3816` | driver seam `drivers/shared/sqlite-utils.ts:59-63` + `scalar-structured-parser.ts:144-200` | codec/decoder (rule 11, rule 7) | the decoder asks the **driver/adapter result seam** for the provider's JSON form, and normalizes through the existing `parseJsonValue` equivalent; the window's already-decoded value is never re-parsed | `meta: "just a json string"` round-trips at top level and inside an `include` |
| json primitives round-trip with exact types | `expected 42n to deeply equal 42` | `query.ts:3815-3816` (no bigint arm) | `scalar-structured-parser.ts:165-175` | codec | same | all five cases (`"hello"`, `42`, `true`, `"123"`, an array) round-trip with `typeof` preserved |
| a scalar subquery compares against the whole table | `QueryError: Query execution failed` | `query.ts:533-534, 548-551` | `builders/where-builder.ts:472,492` | codec/lowering | parenthesize a raw `Sql` operand at the one operand-binding owner | `views: { gte: ctx => ctx.sql\`SELECT MAX("views") FROM …\` }` returns `["hot"]`; the single-value fragment cells stay green |

**Invariant (a+b).** A projected scalar's physical form is stated **once per (leaf, carrier)** — top-level column or JSON-window member — and the decoder receives that form, never a guess from the value's runtime type.

---

## Family 19 — fail-closed result contracts (13 cells)

**Diagnosis.** The old and the new engine build the result in opposite directions, and that is the whole story. The old parser compiled its row parser from **the driver row's own keys** — `result/result-row-parser.ts:164` (`const keys = Object.keys(row)`) and `:192` — and its fastest path (`:468-484`, `containerPolicy: "identity"`) **returns the driver's row object itself**. In that architecture `assertExpectedRowKeys` (`result/result-parser-contract.ts:177-206`, LENGTH via `countOwnEnumerableKeys` + MEMBERSHIP via `hasEveryOwnKey`) is the only thing standing between an unrequested column and the caller: it is a genuine provider-boundary check under rule 4.

Raptor3 builds the output **from the prepared shape**: `decodeValue`'s object arm (`query.ts:3653-3658`) is `Object.fromEntries(Object.entries(shape.fields).map(([field, nested]) => [field, decodeValue(nested, record(decoded)[field])]))`, and `shape` comes from `prepareProjection(model, args)` (`query.ts:3054-3113`) over the *same admitted args* the TypeScript result type is computed from. An unrequested column is never read, so it cannot reach the caller; a requested-but-absent scalar hits `decodeScalar`'s `value === undefined` arm (`query.ts:3679-3680`) and throws `InvalidScalarResult`, which `OperationContext.run` (`operation-context.ts:607-616`) converts into the shipped `Driver "x" returned a malformed …` `QueryEngineError` via `failure` (`:458-475`). So most of the old check is now **redundant payload validation**, and three residues are not.

| cell | observable | raptor3 owner | old engine | truth | fix | falsifier |
|---|---|---|---|---|---|---|
| requested projection not enforced on direct execution | resolves instead of rejecting | `query.ts:3653-3658` (extra key never read) | `result-row-parser.ts:164,192`+`result-parser-contract.ts:177-206` | decoder | **none** — structurally redundant | a `select:{id}` row carrying `secret` publishes `{id}` only |
| unrequested + uniformly-missing scalar columns | not `QueryEngineError` | same; the missing half *does* throw at `query.ts:3679-3680` | same | decoder | none for the extra half; the missing half already fails closed | `select:{id,secret}` with row `{id}` raises the malformed-scalar refusal |
| unrequested private carriers (`0viborm_*`) | not `QueryEngineError` | same | same | decoder | none — raptor3 mints no such carriers | a row of only `{0viborm_relation_counts}` still raises (its `id` is absent) |
| nested include shapes | not `QueryEngineError` | `query.ts:3644-3648` throws `TypeError("Invalid provider collection")` for a missing relation; an extra inner key is dropped | same | decoder + error class | wrap the decoder's structural `TypeError`s so `run` publishes them as `QueryEngineError` | a missing `children` array raises `QueryEngineError`, not `TypeError` |
| relation-count row: missing carrier | `TypeError`, not `QueryEngineError` | `query.ts:3654-3655` (`typeof undefined !== "object"` → `Invalid provider row`) | `result-parser-contract.ts:177` | error class | same wrap | as above |
| relation-count row: primitive carrier | same | same | same | error class | same wrap | as above |
| relation-count row: missing inner relation | already fails closed | `query.ts:3679-3680` → `run` wrap | same | — | none | — |
| relation-count row: **extra** inner relation | resolves | `query.ts:3653-3658` | same | decoder | none — dropped, not leaked | — |
| duplicate `groupBy` fields (×2) | resolves | `query.ts:3426-3444`: both `by` entries alias the same column; `fields[field]` dedupes | refused | admission | refuse a duplicate `by` member at admission | `by:["category","category"]` raises |
| `by.map is not a function` | raw `TypeError` | `query.ts:3432` and `:3449` on `args.by` | old engine normalized | **admission** | `by: v.union([scalarSchema, v.array(scalarSchema)])` (`src/validation/model/args/aggregate.ts:859`) admits a bare string and never coerces it — add `shorthandArray` so `by` is always an array, exactly as `orderBy` is normalized by `entries()` | `groupBy({ by: "category" })` groups by one column instead of crashing |
| `Invalid provider integer` raw `TypeError` | leaks | `query.ts:358-365` — only wrapped inside `run` (`operation-context.ts:607-616`), which the old test's `prepare().parseResult()` harness bypassed | wrapped at the parser | error class | none on the client path; the decoder's non-`InvalidScalarResult` `TypeError`s do need the wrap (rows above) | on the public client, a malformed int raises `QueryEngineError` |
| grouped scalar `_count` colliding with aggregate `_count` | silently wrong answer | `query.ts:3430-3441`: the `by` loop writes `fields["_count"]`, then the aggregate loop **overwrites** it while both columns carry the alias `"_count"` | `builders/select-builder.ts:367` / `result/result-shape.ts:164` refused | admission | restore the refusal at admission (one sentence, both `_count` and `_avg`) | `groupBy({ by:["_count"], _count:true })` on a model with a `_count` scalar raises |
| simultaneous scalar + computed `_distance` | refusal sentence changed | `query.ts:3095-3098`: `"Distance select supports only one _distance field per select."` | `builders/select-builder.ts:317`: `"A distance result cannot be selected together with a model field named '_distance'."` | refusal identity (rule: refusals are contracts) | Arnaud's call: restore the registered sentence or register the new one | the registered sentence is asserted |

**Root cause merge for 19:** one *behaviour* change (the shape now drives the output, so extra-column checks are redundant) + three *real* regressions that the deleted suite happened to be the only witness for: the duplicate-`by` and `_count`-collision admission refusals, the bare-string `by`, and the decoder's unwrapped `TypeError` class.

---

## Family 21 — a short provider result window reports a count (1 cell)

**Diagnosis.** The deleted cell (`5a37bcd7:tests/contracts/engine/query/bulk-create-plan.core.test.ts:410-423`) fed `prepareBatch().parseResult([{rows:[],rowCount:1}])` — one response for a two-statement `createMany` — and expected `Operation reference '<step>.<output>' is unresolved.` from `write-engine/OperationExecutor.ts:3242`. That owner is deleted and the cell was retired for pinning its *message* (note §R4.5 table, "the deleted engine's short-window message"), not because the behaviour was re-checked.

Raptor3 has two candidate owners and they disagree in strength. The window **length** is checked: `setMutations`'s batch-preparation parser raises `TransactionError: Driver '<name>' omitted the prepared result for operation '<op>'` when `window.length !== statements.length` (`operation-context.ts:1199-1211`), and `decodeTerminalResults` does the same per terminal (`:1105-1110`). What is **not** checked is the window's *content*: `createMany`'s count arm is `results.reduce((count, result) => count + result.rowCount, 0)` (`operation-context.ts:1528-1532`), which trusts each `rowCount` without comparing the total to the number of rows submitted. Statically, the deleted cell's two rows (`{label}` and `{id,label}`) form two column groups at `operation-context.ts:1481-1493`, so its exact input should now raise on length.

| cell | observable | raptor3 owner | old engine | truth | fix | falsifier |
|---|---|---|---|---|---|---|
| short provider result window | a count instead of raising | `operation-context.ts:1528-1532` (rowCount trusted); length guarded at `:1199-1211` | `write-engine/OperationExecutor.ts:3242` via batch-reference resolution | execution semantics (rule 4: affected-row counts are execution semantics, keep them) | compare the summed `rowCount` against the number of rows the plan submitted before publishing `{ count }` | a driver returning one response of `rowCount: 1` for a 2-row `createMany` raises instead of answering `{count:1}` |

**Unverified**, and deliberately so: the witness is deleted and I did not add one. The falsifier above is the cheapest reproduction (a fake driver under-reporting `rowCount` for a single grouped INSERT). If it turns out the length guard already covers the original input, the residue is narrower than the note's wording — *trusted rowCount*, not *short window* — and should be re-labelled.

---

## Family 6 — nested default-only duplicate skipping not refused (2 cells)

**Diagnosis.** The refusal exists and is correct, but it is stated on the **physical set-oriented owner** instead of at admission. `OperationContext.createMany` raises `"createMany with skipDuplicates cannot include a row with no explicit scalar values; no portable duplicate-only DEFAULT VALUES primitive exists."` (`operation-context.ts:1379-1382`) — which is why the root cell `rejects default-only createMany duplicate skipping before writing` is green. A **nested** `createMany` never reaches that owner: `RelationBody` expands it row-by-row into `create` record commands and stamps each with `suppression = { kind: "skipDuplicate" }` (`commands/relation-body.ts:302-326`). So `defaultOnlyParent.create({ data: { id, children: { createMany: { data:[{}], skipDuplicates:true } } } })` writes the parent and the child and resolves.

| cells | observable | raptor3 owner | old engine | truth | fix | falsifier |
|---|---|---|---|---|---|---|
| sqlite3 + pg `rejects nested default-only duplicate skipping before the parent write` | `promise resolved "{ id: 'default-only-parent' }" instead of rejecting` | `commands/relation-body.ts:302-326`; guard only at `operation-context.ts:1379-1382` | refused at the shipped write boundary before the parent write | **admission** (rule 4: validate once at the genuine admission boundary) | move the fact to `EngineSchema.admit`'s `createMany` arm so it is asked of the admitted payload wherever the verb appears — root or nested — and delete the physical-owner copy | both cells raise `"no portable duplicate-only DEFAULT VALUES primitive"`, `defaultOnlyParent.count()` and `defaultOnlyChild.count()` are 0, and the root cell stays green |

---

## Family 16 — MySQL batch-only non-returning upsert refusal not thrown (1 cell)

**Diagnosis.** The gate was `assertRoutedAtomicResolution` in `write-engine/routing.ts:145-163`, which refused `update`/`delete`/`upsert` **before construction** when `driver.supportsBatch && !driver.supportsTransactions && !adapter.capabilities.supportsReturning`. The cutover kept `routing.ts`'s `READ_OPERATIONS`/`ROUTED_OPERATIONS` verbatim in `src/query-engine/routed-operations.ts` but **not** this function, and raptor3 has no successor — every `supportsReturning` read in `raptor3/**` is a physical-strategy choice (`operation-context.ts:1410, 1555, 1632, 1785, 1790, 1796, 1835, 1979`; `commands/commands.ts:1038, 1066, 1086`), never a pre-flight capability refusal. The test (`tests/providers/docker/mysql2.test.ts:431-456`) points the driver at `mysql://invalid.invalid/viborm`, so its title — "before provider access" — is the contract: the refusal must precede any connection.

| cell | observable | raptor3 owner | old engine | truth | fix | falsifier |
|---|---|---|---|---|---|---|
| batch-only non-returning upsert | `expected [Function] to throw … 'cannot execute non-returning upsert w…'` — nothing thrown | no owner; nearest are the strategy reads above | `write-engine/routing.ts:145-163` (`ATOMIC_RESOLUTION_OPERATIONS = {update, delete, upsert}`) | **driver contract** (a capability boundary, not an execution outcome) | restore the pre-flight gate once, beside the other capability refusals, keyed on `supportsBatch && !supportsTransactions && !supportsReturning`; its `update`/`delete` sentence (`Driver '<name>' cannot execute '<op>' because public result parsing cannot be rolled back.`) is part of the same contract and should come back with it | the cell raises on an unreachable host, i.e. with zero connection attempts |

---

## Family 17 — the refusal wording `Driver 'name'` → `Driver "name"` (2 cells)

**Diagnosis.** **Nobody changed a spelling.** Both spellings existed side by side; the deletion changed *which owner raises*.

- `Driver "<name>" supports neither transactions nor atomic batch execution.` is owned by `src/drivers/driver-transaction-base.ts:790` and `:979`. It is **byte-identical at `ff5e77ca` and at HEAD** — verified by diffing the two, same lines, double quotes both times.
- `Driver '<name>' supports neither transactions nor atomic batch execution.` was owned by `ff5e77ca:src/query-engine/write-engine/shared.ts:727` (`noAtomicSubstrateError`) and raised from `write-engine/OperationExecutor.ts:362` and `pattern/execute/index.ts:98`. Both call sites and the function are deleted.

**The registered contract is the driver seam's double-quoted spelling**, at `src/drivers/driver-transaction-base.ts:790` and `:979`. It is the surviving owner, it is reached through public `$transaction([...])`, and it never moved. `tests/contracts/engine/query/select-mode-capability-matrix.core.test.ts:72` builds its expectation as `` `Driver '${driver.driverName}' …` `` — it was pinning the *engine's* copy, and with the engine gone the driver's sentence is what a caller sees. The `meta` differs too: the driver's is `{ driver, method: "$transaction([...])" }`, the engine's was `{ driver, operation }`; the class (`TransactionError`) is the same.

| cells | observable | raptor3 owner | old engine | truth | fix | falsifier |
|---|---|---|---|---|---|---|
| `select-mode-capability-matrix` `'create'`, `'update'` | `Driver "x" …` where `Driver 'x' …` was expected | `src/drivers/driver-transaction-base.ts:790`, `:979` (unchanged) | `write-engine/shared.ts:727` (deleted) | **driver contract** | update the two test expectations to the surviving owner's sentence and `meta`; no production edit. The only open decision is whether the engine-level `meta.operation` should be preserved — the driver seam cannot know the operation | the two cells assert the driver seam's sentence and pass with no production change; `client-coverage.core.test.ts:44`'s quote-agnostic regex stays green |

---

## Root causes, merged and ranked

1. **The update language is consumed twice** — `commands/assignments.ts:34-36,55` unwraps `{ set: … }` before `shared/query.ts:807-850` interprets it. Nine cells. Severity: highest — it is data loss, not a refusal; on MySQL it hits *every* root JSON/GeoPoint update, and the adversarial-document cell shows a user's own document silently rewritten. Rules 1 and 9.
2. **A JSON window's physical vocabulary is derived twice and differently** — `query.ts:689-696` (`carriedValue`) vs `:658-683` (`projectedColumn`), and `:3815-3816` re-parses a value the window already decoded. Five cells (2 decimal-list/include, 3 decimal aggregate) plus the JSON-string-in-include cell. Rules 7 and 11.
3. **The driver/adapter result seam is bypassed** — no `parseField`/`parseRelation` call anywhere in `raptor3/**`; the SQLite driver's JSON rule (`drivers/shared/sqlite-utils.ts:59-63`) and the old `parseJsonValue` normalization are gone. One cell today (`42n`), but it is the general hole: any driver-owned representation rule is now invisible to the decoder. Rule 11.
4. **Two admission refusals lost their owner** — the nested default-only `skipDuplicates` refusal lives on the physical owner (`operation-context.ts:1379-1382`) instead of at admission, and the batch-only non-returning pre-flight gate (`write-engine/routing.ts:145-163`) has no successor at all. Families 6 and 16, 3 cells. Rule 4.
5. **`groupBy` argument normalization and collision refusals** — `by` may be a bare string (`validation/model/args/aggregate.ts:859`) and `query.ts:3432` calls `.map` on it; a duplicate `by` member is accepted; a grouped scalar named `_count`/`_avg` silently collides with the aggregate of the same name and the aggregate wins (`query.ts:3430-3441`). Four cells; the collision is a *silently wrong answer*, the worst kind in family 19.
6. **A raw `Sql` operand is not parenthesized** — `query.ts:533-534, 548-551` vs `builders/where-builder.ts:472`. One cell, one-line fix.
7. **The decoder's structural failures are raw `TypeError`s** — `query.ts:3643,3647,3655` are not `InvalidScalarResult`, so `operation-context.ts:607-616` does not translate them. Four cells' error class. Cosmetic next to the above, but it is a public class contract.
8. **`createMany` trusts the provider's `rowCount`** — `operation-context.ts:1528-1532`. One cell, unverified.
9. **A refusal's owner moved, not its wording** — family 17. Test-only fix.

---

## Arnaud's question: does losing family 19's checks break the type guarantee?

**No — not for the reason the deleted cells imply, and for one reason they do not.** The short answer: an unrequested column cannot reach the caller, and `undefined` cannot sit where the type says `number`. What *can* go wrong is narrower and different.

**Why the leak is structurally impossible now.** The two engines build the row in opposite directions.

- Old: `result/result-row-parser.ts:164` compiles the parser from `Object.keys(row)` — the *driver's* keys — and `:468-484` has a whole-row passthrough (`containerPolicy: "identity"`) that **returns the driver's row object itself**. An unrequested column would therefore be handed to the caller verbatim. `assertExpectedRowKeys` (`result/result-parser-contract.ts:177-206`) was the only thing preventing that. **That check was a provider-boundary check under rule 4, and it was necessary — in that architecture.**
- New: `query.ts:3653-3658` builds a fresh object by iterating `shape.fields`, and `shape` is produced by `prepareProjection(model, args)` (`query.ts:3054-3113`) from the same admitted `select`/`include`/`omit` the TS type is inferred from. The output's key set *is* the requested projection. A column the provider volunteers is never read. **In this architecture the same check is redundant payload validation.**

**Case by case, from the decoder's code:**

| provider anomaly | raptor3 | caller sees |
|---|---|---|
| extra scalar column (incl. a model-level `omit`ted one, or a `0viborm_*` carrier) | never read (`query.ts:3653-3658`) | correct row; **no leak** |
| requested scalar absent | `decodeScalar` `value === undefined` → `InvalidScalarResult` (`query.ts:3679-3680`) → `run` → `QueryEngineError` (`operation-context.ts:607-616`, `:468-475`) | raises; **no `undefined` where the type says `number`** |
| requested scalar present but wrong domain | per-type refusal (`query.ts:3665-3846`), all through the existing codecs | raises |
| requested relation collection absent / not an array | `TypeError("Invalid provider collection")` (`query.ts:3644-3647`) — **not** wrapped | raises, wrong class |
| `_count` carrier absent or primitive | `TypeError("Invalid provider row")` (`query.ts:3654-3655`) — not wrapped | raises, wrong class |
| `_count` inner relation absent | `InvalidScalarResult` on `COUNT_LEAF` → wrapped | raises |
| `_count` inner relation **extra** | dropped (`query.ts:3653-3658`) | correct counts; no leak |
| **`_count` carrier is `null`** | `query.ts:3649` `if (decoded === null) return null` fires **before** the object arm, and an object shape carries no nullability flag | `_count: null` typed `{ children: number }` — **a real hole** |
| **field named `toString`/`constructor`/`valueOf`, omitted by the provider** | `record(decoded)[field]` (`query.ts:3656`) is a plain member read on a `JSON.parse` result, so it finds the **inherited** `Object.prototype` value. For a `json` leaf `query.ts:3815-3816` returns it verbatim | a function published as JSON — **a real hole**; the old parser used own-key semantics throughout (`hasEveryOwnKey`, `countOwnEnumerableKeys`, `result-parser-contract.ts:166-174`) and the deleted suite pinned exactly these three identifiers (`5a37bcd7:…:26-31`) |
| **grouped scalar `_count` + aggregate `_count`** | both alias `"_count"`; `fields["_count"]` is overwritten by the aggregate (`query.ts:3430-3441`) | a **silently wrong value** under the right type — the worst case in the whole family, and the only one where the type is satisfied and the *value* is wrong |
| **`by: "category"`** (a string, admitted by `validation/model/args/aggregate.ts:859`) | `by.map` (`query.ts:3432`) | raw `TypeError` before any SQL |

**The cache path is strictly stronger, not weaker.** `route/client-route.ts:250-322` composes the codec from the *same* published shape and the official value codecs (`compileScalarCodec(declared, false)`, `compileWidenedSumCodec`), and `recordCodec` (`src/query-engine/result/cache-value-codecs.ts:142-178`) enforces an exact key set — length **and** membership, on both `snapshot` and `materialize`. So the old `assertExpectedRowKeys` discipline survives verbatim on the cached path; it is only the direct-execution path that dropped it, and only where it was redundant.

**Verdict.** Of the 13 cells: nine were redundant payload validation made unnecessary by the inverted construction — do not restore them. Four were not, and they are the ones to fix: (1) the object shape must carry nullability so a non-nullable carrier cannot decode as `null`; (2) `decodeValue` must read fields with own-key semantics (`Object.hasOwn`) so a prototype-named field cannot inherit a value; (3) the `groupBy` collision and duplicate-`by` refusals must come back at admission, with `by` normalized to an array there; (4) the decoder's structural `TypeError`s must be raised as `InvalidScalarResult`-class failures so `run` publishes them as `QueryEngineError`. Falsifier for the set: a fake driver that returns, in turn, a null `_count` carrier, a row omitting a field named `toString` on a `json` column, and `groupBy({ by: "_count", _count: true })` on a model with a `_count` scalar — all three must raise, and none may publish a value.

---

## Open questions

1. **Family 17 `meta`.** The driver seam's `meta` is `{ driver, method: "$transaction([...])" }`; the deleted engine's was `{ driver, operation }`. Is `meta.operation` part of the registered contract? The driver cannot supply it.
2. **Family 19 `_distance` sentence.** `"Distance select supports only one _distance field per select."` (`query.ts:3096-3098`) vs the registered `"A distance result cannot be selected together with a model field named '_distance'."` (`builders/select-builder.ts:317`). Restore or register? The `_count` twin (`select-builder.ts:367`) has no raptor3 counterpart at all: `prepareProjection`'s `if (name === "_count" && !model["~"].state.scalars[name])` (`query.ts:3078`) silently reinterprets a relation-count request as a scalar select on a model that owns a `_count` column.
3. **Family 21 scope.** Whether the residue is "short window" (my static read says the length guard at `operation-context.ts:1199-1211` already covers the deleted cell's input) or "trusted `rowCount`" (`:1528-1532`). Needs one reproducer; the note's wording may be broader than the fact.
4. **Family 11 aggregate cast and `having`.** Adding the decimal text cast to `carriedValue` changes the aggregate's transport form. `prepareHaving`/`lowerOperation` already reason about decimal operand casts (`query.ts:1788-1790` has a dedicated exact-HAVING-operand refusal) — does the cast interact with that refusal's domain?
5. **Family 1 blast radius beyond JSON/GeoPoint.** `wholeValue`'s `isOperatorRecord` test (`query.ts:452-454`) is prototype-based, so a `Decimal`, `Date` or `Uint8Array` is safely whole. Any *other* scalar whose public value is a plain object would be caught by the same double pass — worth a census before the fix lands.
6. **Rule 4 vs. the nine redundant cells.** Rule 4 says "Never remove these to save lines" about provider-boundary checks. I read the nine as no longer being provider-boundary checks *because* the construction inverted, not as checks removed for line count. That reading should be confirmed before the cells are formally retired.
