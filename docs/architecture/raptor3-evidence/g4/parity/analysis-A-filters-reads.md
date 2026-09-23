<!-- read-only analysis by an Opus analyst, 2026-09-17 morning; input to parity-plan.md -->

I have completed the investigation. Here is the report.

---

# Raptor 3 — Class‑A diagnosis for families 2, 3, 4, 8, 10, 12, 18, 20

**Method.** Every claim below is either a line of the current tree (HEAD `356254a2`), a line of the deleted engine read with `git show ff5e77ca:…` / `git show 5a37bcd7:…`, or **SQL I printed from the running candidate**. I built a throw‑away ESM loader in the session scratchpad (`--experimental-transform-types` + a tsconfig‑path resolver) and drove the *public client* against a real in‑memory `SQLite3Driver`, wrapping `DriverTransactionBase.prototype._execute` to capture each statement. Nothing in the repository was written, staged or checked out. One test file was run under the bounded runner as a reproduction check:

```
tests/providers/local/sqlite3-returning-json.test.ts → 27 failed | 149 passed (176)
```
— exactly the 18 + 8 + 1 of families 2, 3 and 4 in `provider-local-cutover.MINE.log`.

**One correction to the ledger up front.** Family 20's observable is **not** `TypeError: vector.orderBy is not a function`. The receipt line is truncated at the column limit (`…but got 'vector.orderBy is n`). The actual throw, reproduced on all three dialect adapters, is

```
FeatureNotSupportedError: vector.orderBy is not supported. vector ordering requires a pgvector-enabled PostgreSQL driver
    at Queries.distanceExpression (src/query-engine/raptor3/shared/query.ts:1889)
```

That changes the diagnosis from "a crash" to "two refusals in the wrong order", and the fix with it.

---

## Family 2 — relation‑filtered `updateMany`/`deleteMany` affect the wrong row set (18 cells)

**Diagnosis.** The wrong row set comes from **relation‑predicate lowering, not from target selection**. There is no subquery keyed by the wrong identity anywhere on this path; there is one correlated `EXISTS` whose **parent column is emitted unqualified**, so it re‑binds to the child table inside the subquery and the `EXISTS` is *always empty*. `Queries.lowerMutationLimit` (`src/query-engine/raptor3/shared/query.ts:1052-1059`) lowers the selector with **no alias** when there is no `limit`; `Queries.lowerRelationPredicate` (`:1918`) then calls `this.correlation(predicate.edge, parentAlias ?? "", childAlias)` (`:1928`), and `Queries.column(model, field, alias)` (`:524-529`) treats the empty string as "no alias" and falls through to `adapter.identifiers.escape(name)`. Printed from the candidate:

```sql
UPDATE "relation_filter_mutation_users" SET "name" = ?
 WHERE EXISTS (SELECT 1 FROM "relation_filter_mutation_posts" AS "q0"
               WHERE ("id" = "q0"."authorId" AND "q0"."published" = ?))
```

`"id"` resolves against `q0` (posts has an `id` column), so `q0.id = q0.authorId` is never true. That single fact predicts every observable exactly: `some` → 0 rows, `none` → all rows, `every` → all rows (`NOT EXISTS(… NOT cond)` over an empty set). It also explains the *passing* siblings: a to‑one `author: { is: … }` on `post` survives because `"authorId"` does not exist in `users`, so SQLite resolves it outward; the self‑relation cells all fail because every column name collides; and `updateMany limit … composes with a relation filter` passes because the `limit` branch (`:1072-1082`) builds an **aliased** `SELECT … AS q0 WHERE …` subquery and emits the correct `"q0"."id" = "q1"."authorId"`. Singular `update`/`delete` land here too — `commands/commands.ts:1044` and `:1154` call `ctx.updateMany` / `ctx.deleteMany` with `limit: undefined` — which is why the two unique‑where cells fail with the same signature (`UPDATE "emp" … EXISTS (… WHERE "id" = "q0"."managerId" …)`), while `upsert`'s update arm passes because it *locates first* with an aliased `SELECT` and then updates by identity.

The old engine stated this explicitly. `ff5e77ca:src/query-engine/operations/update.ts:79-90` and `delete.ts:85-92` pass the **table name** as the alias — "the unaliased UPDATE target is addressable only by its name, so a relation filter's EXISTS subquery correlates against `` `tbl`.`col` `` instead of a bare `col` that would bind to the RELATED table whenever both carry that column" — and set `mutationTable` so `hideMutationTarget` (`ff5e77ca:src/query-engine/builders/mutation-target-subquery.ts:37-43`) can wrap the subquery on MySQL. The deleted `sql-generation` cells named the same invariant (`5a37bcd7:tests/contracts/engine/query/sql-generation.core.test.ts:1679-1727`, regex `"authors"."id"`).

**I falsified the fix.** Monkey‑patching only `lowerMutationLimit`'s no‑limit branch to `this.lowerSelector(selector, model["~"].names.sql)` and re‑running all 17 count scenarios plus the four unique‑where arms against a live SQLite database: **17/17 counts correct, all four unique‑where arms correct**, with `WHERE ("rfm_emp"."id" = ? AND EXISTS (… "rfm_emp"."id" = "q0"."managerId" …))`.

| cell | observable | raptor3 owner | old engine @ff5e77ca | truth | fix | falsifier |
|---|---|---|---|---|---|---|
| `updateMany with some relation filter affects only matching rows` | `expected +0 to be 1` | `query.ts:1059`, `:1928` | `operations/update.ts:160-164` | lowering | qualify the mutation selector with the target's SQL table name | the 18 restored cells; SQL pin `UPDATE … EXISTS … "<table>"."id" =` |
| `updateMany with every …` | `expected 3 to be 2` | same | same | lowering | same | same |
| `updateMany with none …` | `expected 3 to be 2` | same | same | lowering | same | same |
| `deleteMany with some …` | `expected +0 to be 1` | `query.ts:1059`, `:1928` (via `operation-context.ts:1664`) | `operations/delete.ts:89-92` | lowering | same | same |
| `deleteMany with every …` | `expected 3 to be 2` | same | same | lowering | same | same |
| `deleteMany with none …` | `expected 3 to be 2` | same | same | lowering | same | same |
| `combined … updateMany some and none` | `expected +0 to be 1` | same | same | lowering | same | same |
| `combined … updateMany some and every` | `expected +0 to be 1` | same | same | lowering | same | same |
| `combined … updateMany every and none` | `expected 3 to be 1` | same | same | lowering | same | same |
| `combined … deleteMany reversed none and some` | `expected 3 to be 1`† | same | same | lowering | same | same |
| `combined … deleteMany reversed every and some` | `expected 3 to be 1`† | same | same | lowering | same | same |
| `combined … deleteMany reversed none and every` | `expected 3 to be 1`† | same | same | lowering | same | same |
| `rolls back a combined-filter mutation when a later operation fails` | `expected +0 to be 1` | same | same | lowering | same | same |
| `self-relation … updateMany to-many` | `expected +0 to be 1` | same | same | lowering | same + MySQL 1093 wrap | same, on MySQL too |
| `self-relation … updateMany to-one` | `expected +0 to be 1` | same | same | lowering | same | same |
| `self-relation … deleteMany` | `expected 3 to be 1` | same | same | lowering | same | same |
| `self-relation … update by a unique where locates or declines` | `NotFoundError: No employee record found for update` | `commands.ts:1044` → `query.ts:1059` | `operations/update.ts:86-90` (`buildWhereUnique(…, tableName)`) | lowering | same | restored cell |
| `self-relation … delete by a unique where removes one row` | `promise resolved "{ id: 'e1', … }" instead of rejecting` | `commands.ts:1154` → `query.ts:1059` | `operations/delete.ts:51-54` | lowering | same | restored cell |

† counts read from the summary lines of `provider-local-cutover.MINE.log`; the detail blocks for these three were truncated in the receipt but the cells are in the same `describe` and share the signature.

**Second, latent defect this fix exposes.** Raptor 3 has **no** consumer of `adapter.capabilities.supportsMutationTargetInSubquery` (`grep` over `src/query-engine/raptor3/**` returns nothing; the capability exists and is `false` for MySQL at `src/adapters/databases/mysql/mysql-adapter.ts:948`). Once the correlation is correct, a self‑relation `updateMany`/`deleteMany` on MySQL emits `UPDATE emp … EXISTS (SELECT 1 FROM emp …)` and hits **ERROR 1093**. `relationFilterMutationContract` *is* registered for MySQL (`tests/providers/docker/mysql2-relations-ddl.test.ts:80`), a suite outside the four bisected lanes. The family‑2 fix is therefore two things in one owner: qualify the parent, and reinstate the derived‑table wrap in `lowerRelationPredicate` when `!supportsMutationTargetInSubquery` and the subquery's table is the mutation target.

---

## Family 3 — JSON string and array path filters (8 cells)

**Diagnosis — three distinct causes, all in `Queries.prepareOperations` (`query.ts:1214-1250`).**

**(3a) The string path form is not implemented at all.** `query.ts:1232-1238` scopes the target only `if (state?.type === "json" && Array.isArray(filter.path))`, and `:1243` then *drops* `path` from the operator loop. A `path: "$.theme"` is therefore silently discarded and the filter degrades to a whole‑document comparison at the root. Printed:

```sql
-- path: ["theme"], equals "dark"
WHERE "q0"."metadata" -> '$' -> ? = ?          -- correct
-- path: "$.theme", equals "dark"
WHERE "q0"."metadata" = ?                      -- path GONE
-- path: "$.level", gte 2
WHERE (CASE WHEN json_type("q0"."metadata" -> '$') IN … END) >= ?   -- root, not $.level
```
Admission deliberately accepts both spellings — `src/validation/scalars/json.ts:131` is `path: v.union([v.array(v.string()), v.string()])` — and the deleted engine owned the normalization (`ff5e77ca:src/query-engine/builders/json-filter-builder.ts:72-114` `parseJsonStringPath`, `:122-127` `resolveJsonPath`, with the grammar and its six refusal sentences). Three cells *appear* to pass only by accident: `'$' alone is the document root`, `string paths carry the mode too` (the whole document text happens to contain `ark`), and `a dot is always a separator` (expects `[]`, gets `[]` for the wrong reason). Same on every dialect (`PG: "q0"."metadata" = ?`, `MySQL: q0.metadata = CAST(? AS JSON)`).

**(3b) There is no portable‑path contract.** Raptor 3 never runs `assertPortableJsonPath` (`ff5e77ca:json-filter-builder.ts:216-224`). On SQLite the *adapter's own defensive* guard fires instead — `src/adapters/databases/sqlite/sqlite-adapter.ts:177-186`, whose comment literally says "the portable query contract rejects keys containing `"` or `\` before adapter execution. This throw is defensive." — and it throws a bare `Error`, not a `QueryEngineError`. PostgreSQL and MySQL have **no** such guard and bind the segment silently (`"q0"."metadata"#>?::text[] = ?`). One question, three answers: a rule‑5 violation ("validate once at the admission boundary") and a rule‑4 violation ("adapters spell dialect SQL").

**(3c) `mode` is a dropped key, not a resolved fact.** `query.ts:1231` is `const folded = insensitive || filter.mode === "insensitive"` — inheritance only flows *down* and can never be reset, and `:1243` filters `mode` out without ever asking whether it governs anything. The old engine had both rules explicitly: `resolveJsonFilterMode` (`ff5e77ca:json-filter-builder.ts:38-45`) — "A filter object's own `mode` wins over the inherited one in BOTH directions" — and `assertModeGovernsSomething` (`:199-214`). Printed for the nested‑override cell: both arms come out `instr(lower(…), lower(?))`, so the inner `mode: "default"` is ignored. Printed for the inert‑mode cell: `metadata -> '$' -> ? = ?` — the mode vanishes.

| cell | observable | raptor3 owner | old engine @ff5e77ca | truth | fix | falsifier |
|---|---|---|---|---|---|---|
| `json path filters › non-portable JSON path segments reject before execution` | `expected … 'portable JSON path' but got 'SQLite JSON path segments containing …'` | `query.ts:1232-1243`; backstop `sqlite-adapter.ts:182` | `json-filter-builder.ts:152`, `:216-224` | admission | resolve + validate the path once where it is prepared, and raise `QueryEngineError("… requires a portable JSON path; segments containing '"' or '\\' are not supported.")`; leave the adapter throw as the defensive backstop it claims to be | the cell, **plus** the same input on PG and MySQL (which today build silently) |
| `mode: insensitive › a nested not may override the inherited mode` | `expected [ 'light' ] to deeply equal [ 'dark', 'light' ]` | `query.ts:1231` | `json-filter-builder.ts:38-45` | preparation | `resolveMode(filter.mode, inherited)` — a declared `default` resets, a declared `insensitive` sets | the cell + a pin that the two arms lower to `instr(lower(…))` and `instr(…)` respectively |
| `mode: insensitive › an inert mode is refused, not ignored` | `promise resolved "[ 'dark' ]" instead of rejecting` | `query.ts:1243` | `json-filter-builder.ts:199-214` | admission | refuse a declared `mode: 'insensitive'` on a JSON filter object that has no `string_contains/starts_with/ends_with` and no non‑sentinel `not` | the cell + a positive control (`{mode, string_contains}` still compiles) |
| `json string paths › dot paths equal their array form` | `expected [] to deeply equal [ 'dark' ]` | `query.ts:1233` | `json-filter-builder.ts:72-127` | preparation | normalize `string \| string[]` → segments in the one place the path is read | the four string‑path cells + a `getSql` equality pin `"$.a.b" === ["a","b"]` |
| `json string paths › bracket segments address array elements` | `expected [] to deeply equal [ 'dark' ]` | same | same | preparation | same | same |
| `json string paths › every operator accepts the string form` | `expected [] to deeply equal [ 'dark' ]` | same | same | preparation | same | same |
| `json string paths › unsupported path grammar rejects before execution` | `promise resolved "[]" instead of rejecting` | same | `json-filter-builder.ts:49-56, 72-114` | admission | the six grammar refusals ride the same parser | all ten refused path strings |
| `json string paths › quoted labels keep the portable-path refusal` | `promise resolved "[]" instead of rejecting` | same + (3b) | `json-filter-builder.ts:216-224` | admission | parser feeds the portable‑path assertion | `'$."a b"'` and `"$.a\\b"` |

---

## Family 4 — the JSON null‑sentinel inert‑mode refusal (1 cell)

**Diagnosis.** Same owner, same line as (3c): `where: { meta: { mode: "insensitive", not: DbNull } }` has no string operator and its `not` is a **sentinel**, so the declared mode governs nothing. Raptor 3 filters `mode` out at `query.ts:1243` and resolves every row. The old engine refused it from the sentinel clause of `assertModeGovernsSomething` (`ff5e77ca:json-filter-builder.ts:199-207`): "A SENTINEL `not` (`not: DbNull`) is not an exemption: it inherits nothing and case‑folds nothing."

| cell | observable | raptor3 owner | old engine @ff5e77ca | truth | fix | falsifier |
|---|---|---|---|---|---|---|
| `json null sentinel › refusals › an inert mode beside a sentinel not is refused` | `promise resolved "[ 'doc', 'js', 'nest' ]" instead of rejecting` (`/mode: 'insensitive'/`) | `query.ts:1231, 1243` | `json-filter-builder.ts:199-214` | admission | the same inert‑mode refusal, with `jsonNullKindOf(filter.not) !== undefined` denying the `not` exemption | this cell together with family 3's inert‑mode cell — **one guard, two witnesses** |

---

## Family 18 — read‑path admission refusals no longer raised (11 cells)

**Diagnosis.** Two causes. Six of the eleven are family 3's missing path parser and portable‑path assertion, re‑witnessed through `getSql` instead of a live driver — **merge them, do not fix them twice**. The other five are one new cause and one shared with family 8: **"the caller wrote nothing" and "the caller wrote an empty object" are the same value to the preparer.** `Queries.prepareOperations` (`query.ts:1214-1250`) builds `{kind:"and", predicates:[]}` from a filter object with no admitted operator; `Queries.prepareSlotPredicate` (`:1358-1387`) does the same for a relation slot, because `Object.keys({}).every(QUANTIFIERS.has)` is vacuously `true` so `arms` is empty; `states()` (`:299-301`) reads an empty conjunction as "states nothing", and `lowerPredicate`'s `and` arm spells it as the adapter's TRUE. Printed, on all three dialects:

```sql
where: { name: {} }                  → WHERE 1   / WHERE TRUE
where: { posts: {} }                 → WHERE 1   / WHERE TRUE
where: { metadata: { path:["status"] } } → WHERE 1 / WHERE TRUE
where: {}                            → WHERE 1   / WHERE TRUE
```
and the headline, measured live:

```sql
updateMany({ where: { name: {} } })  →  UPDATE "u18" SET "name" = ? WHERE 1    → { count: 3 }
deleteMany({ where: { name: {} } })  →  DELETE FROM "u18" WHERE 1
```

**Where the validation authority is, and why `{}` passes.** `EngineSchema.admit` (`src/query-engine/raptor3/shared/schema.ts:193-206`) does no shape work of its own for reads: it calls `admitArguments` (`:208-227`), which is `parseValidated(this.registry.getModelSchemas(model).args[operation], input, …)`. So the authority is **`src/validation/**`, not `admit`**. Concretely, for a scalar field filter the object is built per scalar — e.g. `stringFilterBase = v.object({ in, notIn, contains, startsWith, endsWith, mode })` at `src/validation/scalars/string.ts:15-22` — and finished in the one shared place, `buildNegatableFilterSchema` at `src/validation/scalars/negatable-filter.ts:44-55` (`base.extend({ not: … })`); those per‑field schemas are assembled into the model `where` by `getScalarFilter` (`src/validation/model/core/filter.ts:33-35`) and `src/validation/model/core/where.ts`. **`{}` passes because every member of those objects is optional and `v.object` is partial by default, and because none of them passes `nonEmpty`.** The `v.object` primitive already supports the constraint (`src/validation/primitives/object.ts:54-55`, enforced at `:548-560`, message `"Object cannot be empty"`), and the estate already uses it — but only for `whereUnique` (`src/validation/model/core/where.ts:165-170` and `:271-276`, with `requiresOneOf`). The deleted engine did not refuse at admission either: it refused at **lowering**, in `buildScalarFilter` (`ff5e77ca:src/query-engine/builders/where-builder.ts:381-385`), `buildJsonFilter` (`json-filter-builder.ts:179-183`) and `buildRelationFilter` (`relation-filter-builder.ts:94-98`, `:142-146`). Arnaud's decision moves the refusal to admission, which is also where rule 5 puts it.

`nonEmpty: true` alone is **not** sufficient: `{ path: ["status"] }` and `{ mode: "insensitive" }` are non‑empty but state no operation, and the old sentence was "must contain at least one **operation**". The precise admission rule is `requiresOneOf: [<operator keys minus `mode` and `path`>]`, i.e. exactly the vocabulary `v.object` already speaks.

| cell | observable | raptor3 owner | old engine @ff5e77ca | truth | fix | falsifier |
|---|---|---|---|---|---|---|
| `refuses non-portable JSON string path` ×6 (`status`, `$.`, `$.*`, `$[last]`, `$[0`, `$status`) | `expected [Function] to throw an error` | `query.ts:1233` | `json-filter-builder.ts:49-114` | admission | **merged into family 3 (3a)** | the six `test.each` arms |
| `refuses path segments whose escaping is not portable` | `expected [Function] to throw an error` | `query.ts:1233`; backstop `sqlite-adapter.ts:182` | `json-filter-builder.ts:216-224` | admission | **merged into family 3 (3b)** | `['quoted"key']`, `["back\\slash"]`, `'$."quoted"'` on all three dialects |
| `json filter with only a path fails closed` | `expected [Function] to throw an error` (`Filter for field 'metadata' must contain at least one operation`) | `query.ts:1243-1250` | `json-filter-builder.ts:179-183` | admission | `requiresOneOf` on the JSON filter object, excluding `path`/`mode` | the cell + a positive control `{ path, equals }` |
| `empty accepted scalar filter fails closed` (`where: { name: {} }`) | `expected [Function] to throw an error` | `query.ts:1214-1250` + `:299-301` | `where-builder.ts:381-385` | admission | `nonEmpty: true, requiresOneOf: [<ops>]` in `negatable-filter.ts:44-55` | the cell, **and** `updateMany/deleteMany({where:{name:{}}})` must refuse, **and** `findMany({where:{}})` must still match everything |
| `empty accepted relation filter fails closed` (`where: { posts: {} }`) | `expected [Function] to throw an error` (`Relation filter 'posts' requires one of: some, every, none`) | `query.ts:1373-1377` | `relation-filter-builder.ts:94-98` / `:142-146` | admission | to‑many relation filter schema gets `requiresOneOf: [["some","every","none"]]`; to‑one gets `[["is","isNot"]]` (admission already normalizes the bare nested `where` into `is`) | the cell + a positive control `{ author: { name: "Alice" } }` |
| `groupBy throws when direct having filter field is not in by` | `expected [Function] to throw an error` | `query.ts:3467-3508` | `operations/groupby-having.ts:203-209` | preparation | **merged into family 8's `by` authority** | see family 8 |

Printed for the last one: `groupBy({ by:["editorId"], having:{ title:"A1" } })` emits `… GROUP BY "q0"."editor_id" HAVING "q0"."title" COLLATE BINARY = ?` — not even valid grouped SQL on a strict dialect.

---

## Family 8 — Prisma‑parity refusals for empty select and non‑grouped `groupBy`/`having` (5 cells)

**Diagnosis — two causes.** (8a) `Queries.prepareProjection` (`query.ts:3054-3176`) has **no empty‑projection arm at all**: it neither refuses an explicit empty/all‑false `select` nor supplies a sentinel column for a model whose *default* projection is empty. The result is literally `SELECT  FROM …`, a syntax error the driver reports as the opaque `QueryError: Query execution failed`. Printed:

```sql
findMany({ select: {} })  →  SELECT  FROM "ep_parent" AS "q0" WHERE 1
```

The deleted engine answered all three cases in one place, `ff5e77ca:src/query-engine/builders/select-builder.ts:418-437`: no `_count` pair when nothing is counted (`:418`), a sentinel `EMPTY_ROW_RESULT_KEY` column `CAST(1 AS integer)` when the projection is empty **and no `select` was written** (`:425-430`), and the refusal `The 'select' statement for model '<M>' needs at least one truthy value.` when it is empty **because** a `select` was written (`:433-436`). The key constant still exists in the tree at `src/query-engine/result-aliases.ts:8`, unused by raptor 3.

(8b) **The grouped read has no `by` authority.** `Queries.grouped` reads `args.by!` raw (`query.ts:3429`) and `prepareHaving` (`:3467`) and `groupOrderTerms` (`:3511`) never see `by` at all, so Prisma's membership rule has no owner. The deleted engine had three small owners: `getGroupByFields` (`ff5e77ca:src/query-engine/operations/groupby-fields.ts:3-17` — normalizes `string | string[]`, refuses duplicates), `groupby-having.ts:203-209` (`Scalar '<f>' used in 'having' must be included in 'by'.`) and `groupby.ts:258-264` (`GroupBy orderBy field '<k>' must be included in 'by' …`). Admission intentionally defers: `src/validation/model/args/aggregate.ts:859` admits `by: v.union([scalarSchema, v.array(scalarSchema)])` and `:700-703` says in so many words "membership in `by` is enforced at query time".

| cell | observable | raptor3 owner | old engine @ff5e77ca | truth | fix | falsifier |
|---|---|---|---|---|---|---|
| `Prisma parity › empty select rejection › empty select object throws` | `expected … /needs at least one truthy value/ but got 'Query execution failed'` | `query.ts:3054-3176` | `select-builder.ts:433-436` | preparation | one empty‑projection arm at the end of `prepareProjection`, three cases as at `select-builder.ts:418-437` | this cell + the two below + the two family‑12 cardinality cells, from **one** change |
| `Prisma parity › empty select rejection › all-false select throws` | same | same | same | preparation | same | same |
| `read-path regression › empty default projections › still rejects an explicit empty select` | `expected … /at least one truthy value/i but got 'Query execution failed'` | same | same | preparation | same | same |
| `Prisma parity › groupBy ordering and having › orderBy a non-grouped column is rejected` | `promise resolved "[ { authorId: 'u1' }, … ]" instead of rejecting` (`/must be included in 'by'/`) | `query.ts:3511-3540` (no `by` in scope) | `operations/groupby.ts:258-264` | preparation | `grouped` computes the `by` set once and hands it to `groupOrderTerms` | this cell + family 18's `having` cell + family 12's `by.map` cell |
| `Prisma parity › having boolean combinators › a field-keyed condition inside an OR arm still requires by` | `promise resolved "[ { authorId: 'u1' } ]" instead of rejecting` | `query.ts:3467-3508` | `operations/groupby-having.ts:203-209` | preparation | same set handed to `prepareHaving`, which recurses into `AND`/`OR`/`NOT` already | same |

---

## Family 12 — read regressions (4 cells)

**Diagnosis.** Three separate causes, two of which merge upward.

**(12a) `by.map is not a function`** — `query.ts:3429-3432` does `const by = args.by!` then `by.map(…)`. `by: "editorId"` is a legal admitted input (`aggregate.ts:859`) and nothing normalizes it. Same owner as family 8b: **one `by` authority fixes both, and the duplicate‑`by` refusal of family 19 with them** (printed today: `by: ["editorId","editorId"]` emits `SELECT "q0"."editor_id" AS "editorId", "q0"."editor_id" AS "editorId" … GROUP BY …, …` and resolves).

**(12b) the two `empty default projections` cardinality cells** — the same missing `prepareProjection` arm as family 8a; they need the *sentinel* half of the old rule rather than the refusal half (`select-builder.ts:425-430`). The sentinel is safe in raptor 3 without any decoder change, because `decodeProjection` (`query.ts:3552`) reconstructs the row from `projection.shape` and ignores unrequested provider columns.

**(12c) `_count: true` publishes `{}`** — `query.ts:3078-3089` pushes a `counts` projection field unconditionally, even when `prepareCounts` (`:3226-3255`) returns an empty list, so a model with no to‑many relation gets `json_object() AS "_count"` and a `_count: {}` key. Printed: `SELECT "q0"."id" AS "id", json_object() AS "_count" FROM "g_post" …` for **both** `_count: true` and `_count: { select: {} }` — the two spellings agree with each other but not with Prisma. Old engine: `if (relationCountPairs.length > 0)` at `select-builder.ts:418` — no pair, no key.

| cell | observable | raptor3 owner | old engine @ff5e77ca | truth | fix | falsifier |
|---|---|---|---|---|---|---|
| `read-path regression › named inverse relations › groupBy returns mapped scalars under their public names` | `TypeError: by.map is not a function` at `query.ts:3432` | `query.ts:3429-3432` | `operations/groupby-fields.ts:3-17` | preparation | **merged into family 8b's `by` authority**: normalize `string \| string[]`, refuse duplicates, publish the set | this cell + `by: ["a","a"]` refusal + the two family‑8 membership cells |
| `empty default projections › preserves root and nested row cardinality` | `QueryError: Query execution failed` (`SELECT  FROM …`) | `query.ts:3054-3176` | `select-builder.ts:425-430` | preparation | **merged into family 8a**: sentinel column when the projection is empty and no `select` was written | `findMany` → `[{}, {}]`; `include` → `[{children:[{},{}]}, {children:[]}]` |
| `empty default projections › returns an empty public object from a live nested create` | `QueryError: Query execution failed` | same | same | preparation | same | `create` → `{}`; `findUnique + include` → `{children:[{},{}]}` |
| `_count: true shorthand › _count: true skips to-one relations` | `expected [ { id: 'p1', _count: {} } ] to deeply equal [ { id: 'p1' } ]` | `query.ts:3078-3089` | `select-builder.ts:418-422` | preparation | `if (counts.length === 0) continue;` — an empty count selection contributes no field | the cell asserts both `toEqual([{id:'p1'}])` **and** shorthand≡explicit‑empty, so it cannot be satisfied by publishing `{}` on both |

---

## Family 10 — cursor paging over duplicate sort keys (1 cell)

**Diagnosis — the engine is correct; this is a pin on a private carrier name.** The receipt's `expected +0 to be 5` is **not** a row count: it is `expect(guardedSpellings).toBe(rowValueSpellings)` at `tests/contracts/drivers/behaviors/ordering-plan-behavior.ts:361`, where `guardedSpellings` counts statements containing the literal `__viborm_cursor_0` (`:356`). Raptor 3 names the carrier `0viborm_cursor_${index}` (`query.ts:2350`); the deleted engine named it `__viborm_cursor_${index}` (`ff5e77ca:src/query-engine/operations/cursor-condition.ts:268`). Nothing else differs.

**And yes, the cursor condition uses a total order with the identity tie‑break, exactly as the old engine did.** `Queries.page` (`:2198-2206`) requires every requested term to be a direct scalar, then `totalOrder` (`:2251-2266`) fixes the null placement and appends `identityOrder(model)` (`:2268-2283`) plus any extra cursor key. I reproduced the parity oracle end‑to‑end on a live database (70 rows, 7 per sort value, 6 pages of 5):

```
rowValueSpellings 5   guarded(__viborm_) 0   guarded(0viborm_) 5
notNullPages 6 pages / 30 rows;  equal to nullablePages: true;  contiguous r00000…r00029: true
```
with `ORDER BY "q0"."bucket" ASC, "q0"."id" ASC` on the sargable arm and the full null‑guarded `EXISTS` over a derived `"q2"."0viborm_cursor_0"` row on the nullable arm. Both spellings are taken, and they agree row for row. **The same rename also reddens three deleted cells** — `'PostgreSQL'/'MySQL'/'SQLite' cursor SQL a nullable sort column keeps the null-guarded predicate` in `cursor-pagination-sql.core.test.ts`, each `expected '…' to contain '__viborm_cursor_0'`. Four cells, one cause.

| cell | observable | raptor3 owner | old engine @ff5e77ca | truth | fix | falsifier |
|---|---|---|---|---|---|---|
| `ordering query plan › both cursor spellings page identically over duplicate sort keys` | `expected +0 to be 5` (count of statements containing `__viborm_cursor_0`) | `query.ts:2350` | `operations/cursor-condition.ts:268` | adapter contract / naming, **not** semantics | give the carrier prefix one home — export it from `src/query-engine/result-aliases.ts` beside `EMPTY_ROW_RESULT_KEY` (`:8`) and have both `Queries.cursorCondition` and the behaviour module read it, so no test pins a literal | after the change the cell must pass **and** `namespace-qualification.core.test.ts:406-408` must still pass (I checked: the sargable arm emits no carrier, and the guarded arm qualifies it with the derived‑table alias `q2`, never `"billing"`) |
| (same cause) 3× `cursor SQL a nullable sort column keeps the null-guarded predicate` | `expected '…' to contain '__viborm_cursor_0'` | same | same | same | same | the three restored dialect arms |

---

## Family 20 — vector‑distance cursor ordering (3 cells)

**Diagnosis — two refusals in the wrong order, not a crash.** Reproduced on `PostgresAdapter`, `MySQLAdapter` and `SQLiteAdapter` (all `supportsVector: false`, all carrying `vector = { literal, l2, cosine }`):

```
FeatureNotSupportedError: vector.orderBy is not supported. vector ordering requires a pgvector-enabled PostgreSQL driver
    at Queries.distanceExpression (query.ts:1889)
    at Queries.orderTerm (query.ts:2084)
```

`Queries.page` decides cursor eligibility *after* the terms are built (`:2199` `orderTerms` → `:2202` `requested.every(term => term.field !== undefined)` → `:2205-2208` the refusal), but `orderTerm`'s `_distance` arm (`:2079-2088`) calls `distanceExpression`, which consults the **provider capability** (`:1886-1892`) while constructing the expression. The capability refusal therefore pre‑empts the cursor refusal. The relation twin (`orderBy: { posts: { _count } }`) still answers correctly — `relationOrderTerm` builds a term with `field: undefined` and `page` then raises the right sentence — which is why only the vector arms are red. Note the bug is **provider‑conditional**: on a pgvector‑capable adapter the distance term builds fine and `page` raises the correct refusal, so "the refusal is present" is true only where the provider happens to support vectors.

The deleted engine's oracle is `5a37bcd7:tests/contracts/engine/query/cursor-pagination-sql.core.test.ts:316-329` against `operations/cursor-order.ts`, which classified the requested order *before* lowering any expression.

| cell | observable | raptor3 owner | old engine @5a37bcd7/ff5e77ca | truth | fix | falsifier |
|---|---|---|---|---|---|---|
| `'PostgreSQL' cursor SQL vector-distance cursor ordering fails explicitly` | `expected … 'Cursor pagination supports direct sca…' but got 'vector.orderBy is not supported. …'` | `query.ts:2084` → `:1889`, pre‑empting `:2205-2208` | oracle at `cursor-pagination-sql.core.test.ts:316-329`; owner `operations/cursor-order.ts` | preparation (ordering of two refusals) | thread the windowed/cursor fact into the **one** order walker so `orderTerm`'s non‑direct‑scalar arms raise `"Cursor pagination supports direct scalar sort directions only; …"` *before* `distanceExpression` is consulted — keeps one walker, one sentence, one authority; the `page` post‑check then stays as the single raise point for relation terms | the three dialect arms on a **non**‑pgvector adapter, **plus** a new arm on a pgvector‑capable adapter (which must raise the same cursor refusal, proving it is not accidental) |
| `'MySQL' …` | same | same | same | same | same | same |
| `'SQLite' …` | same | same | same | same | same | same |

---

## Root causes, merged and ordered by severity

1. **Silent wrong row set in bulk and unique‑where mutations (18 cells + 6 deleted `sql-generation` cells).** `Queries.lowerMutationLimit`'s no‑limit branch (`query.ts:1059`) lowers a mutation's selector with no qualifier, so `lowerRelationPredicate`'s `parentAlias ?? ""` (`:1928`) emits the parent column unqualified and the correlated `EXISTS` re‑binds to the child table. Data loss class: `deleteMany` removes the complement of the intended set. Fix: qualify with the target's SQL table name (falsified: 17/17 + 4/4), and reinstate the MySQL 1093 derived‑table wrap the capability already declares.
2. **An empty filter object is indistinguishable from no filter (5 cells + the unmeasured bulk‑mutation blast).** `prepareOperations` (`:1214-1250`) and `prepareSlotPredicate` (`:1373-1377`) both yield an empty conjunction, which `states()` (`:299-301`) reads as silence and the lowerer spells `TRUE`. `updateMany/deleteMany({ where: { name: {} } })` touch **every row**. Authority is `src/validation/**` (`negatable-filter.ts:44-55` and the per‑scalar filter objects, e.g. `string.ts:15-22`), reached through `EngineSchema.admit` → `parseValidated` (`schema.ts:193-227`); `{}` passes because those objects are partial and carry no `nonEmpty`/`requiresOneOf`, the two options `primitives/object.ts:54-55` already implements and `where.ts:165-170` already uses for `whereUnique`.
3. **The JSON filter language lost three of its rules (9 cells across families 3, 4, 18).** (a) the string `path` form is dropped rather than parsed (`:1233`), silently retargeting the filter at the document root; (b) there is no portable‑path contract, so SQLite's *defensive* adapter throw (`sqlite-adapter.ts:182`) is the only guard and PG/MySQL have none; (c) `mode` is a filtered‑out key rather than a resolved fact, so a nested override cannot reset it (`:1231`) and an inert mode is ignored rather than refused (`:1243`). All three lived in one deleted file, `ff5e77ca:src/query-engine/builders/json-filter-builder.ts`.
4. **`prepareProjection` has no empty‑projection arm (5 cells across families 8 and 12).** `query.ts:3054-3176` emits `SELECT  FROM …` for an empty projection and never refuses an explicit empty `select`; `:3078-3089` publishes `_count: {}` for an empty count selection. One replacement for `ff5e77ca:select-builder.ts:418-437`'s three cases.
5. **The grouped read has no `by` authority (4+ cells across families 12, 8, 18, and family 19's two duplicate‑`by` cells).** `grouped` (`:3429`) trusts `args.by` to be an array, and `prepareHaving`/`groupOrderTerms` never see `by`. One normalization + one published set restores `getGroupByFields` (`ff5e77ca:groupby-fields.ts:3-17`) and both membership sentences.
6. **A capability refusal pre‑empts a cursor refusal (3 cells, family 20).** `orderTerm` (`:2084`) lowers a `_distance` expression — and consults `supportsVector` (`:1889`) — before `page` (`:2205`) can decide the order is not cursor‑eligible.
7. **A private carrier alias was renamed (4 cells, family 10 + three deleted `cursor-pagination-sql` arms).** `0viborm_cursor_N` (`:2350`) vs `__viborm_cursor_N` (`ff5e77ca:cursor-condition.ts:268`). Semantics verified identical end to end; give the prefix one home instead of pinning a literal in a behaviour module.

---

## Open questions

1. **Does the empty‑filter refusal belong at admission or at lowering?** Arnaud's decision puts it at admission, which rule 5 endorses; but the deleted engine raised all three sentences at **lowering** (`where-builder.ts:381`, `json-filter-builder.ts:179`, `relation-filter-builder.ts:94`/`:142`). Moving them changes *when* they fire for shapes reached only at build time (e.g. a filter object that becomes empty only after `undefined` members are dropped). Is `undefined`-only (`{ equals: undefined }`) an empty filter, or a stated one? The old lowering rule said empty; a `requiresOneOf` at admission would say stated. This needs a ruling before the schema change is written.
2. **Does `not: {}` count as an operation?** `buildNegatableFilterSchema` makes `not` self‑referential at any depth. A `requiresOneOf` that includes `not` accepts `{ not: {} }`; one that requires it to be non‑empty recursively refuses it. The old engine refused the inner object (its recursion re‑entered `buildScalarFilterObject`) but I could not find a witness for it.
3. **Is `mode` allowed to win in both directions for *scalar* filters too?** `ff5e77ca:json-filter-builder.ts:31-36` states the asymmetry deliberately — JSON honors a declared `default`, the scalar where‑builder only allows an upgrade. Raptor 3's "one operator vocabulary over one target" (`query.ts:1210-1213`) has no room for two rules. Keeping parity means a JSON‑only branch in a deliberately unified walker; unifying on the JSON rule is a new observable for scalar filters. This is a decision, not a repair.
4. **MySQL 1093.** Fixing family 2's correlation makes self‑relation mutation filters *reach* MySQL correctly and therefore *fail* there without the derived‑table wrap. Should the wrap land in the same change (my recommendation: yes, in `lowerRelationPredicate`, gated on the existing `supportsMutationTargetInSubquery`), and is `tests/providers/docker/mysql2-relations-ddl.test.ts` in scope for the verification lane? It was not in any of the four bisected lanes.
5. **Is the cursor carrier name a contract?** If `0viborm_…` is the estate's private‑alias convention (it matches `result-aliases.ts:7-8`), then family 10 and the three deleted `cursor-pagination-sql` arms are stale pins and the engine should not be changed. If `__viborm_…` is the contract, the engine changes. Either way the *behaviour* is proven correct, so this should not be counted as an engine defect.
6. **The SQLite adapter's bare `Error`.** `sqlite-adapter.ts:182` throws `Error`, not `QueryEngineError`, so even as a backstop it escapes the engine's error taxonomy and the driver's redaction. Worth converting when the portable‑path contract lands — but it is an adapter‑owned file and outside the raptor 3 seam.
7. **Two receipt texts should be corrected in the ledger**: family 20's observable is a `FeatureNotSupportedError`, not `TypeError: vector.orderBy is not a function`; and family 10's `expected +0 to be 5` is a count of statement spellings, not of rows.
