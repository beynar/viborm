# VibORM — Capability, Parity and Interoperability Matrix

**Repo:** `/Users/arnaud/code/viborm` @ `main` (`dccafe1`), working tree clean.
**Date:** 2026-07-25. Read-only audit; nothing in `src/` was modified to produce it.

Three deliverables in one document:

- **[Part 1](#part-1--prisma-client--viborm-feature-parity)** — Prisma Client ↔ viborm feature parity.
- **[Part 2](#part-2--database-interoperability-the-honest-matrix)** — the database-interoperability promise, honestly.
- **[Part 3](#part-3--what-is-not-permitted-not-implemented-or-deferred)** — everything not permitted, not implemented, or deferred.

**Verification levels used below.** `[V]` = I reproduced it myself against a live database or read both ends of the code path in this session. `[E]` = file:line evidence cited, not independently executed. `[?]` = asserted by no test on any real backend.

**Legend.** ✅ full · 🟡 partial (gap named) · ❌ absent · ➕ viborm-only · ↔️ intentionally different · ⚠️ emulated (same result, different mechanism) · ❓ unverified against a real backend.

---

## §0 — Executive summary

### 0.1 The three defects worth fixing before anything else

| # | Defect | Class | Who hits it |
|---|---|---|---|
| **1** | `updateMany` / `updateManyAndReturn` accept nested relation writes, report success, and **silently discard them** | silent wrong-success | anyone doing a bulk update whose `data` also names a relation |
| **2** | `viborm push` discards the interactive **rename** decision and applies DROP + ADD | silent data loss | anyone renaming a column through `push` |
| **3** | M2M nested `create` with a **database-generated** target PK hard-fails | regression from the V1 deletion | `post.create({ tags: { create: {…} } })` with an autoincrement tag id |

**Defect 1 — verified live `[V]`.**

```ts
client.user.updateMany({
  where: { id: "u1" },
  data: { name: "B", posts: { create: { id: "p-new", title: "…" } } },
})
// → { count: 1 }.  users = ["B"].  posts = [].  No error, no warning.
```

`UpdateManyArgs.data` binds to `core.update` — the **full** schema including every relation's nested-write object — not `core.scalarUpdate`
([mutation.ts:184](../../src/validation/model/args/mutation.ts:184), and `:221` for `updateManyAndReturn`).
The payload then reaches [set-builder.ts:34](../../src/query-engine/builders/set-builder.ts:34), which does `if (isRelation(...)) continue; // Skip relations`.

Prisma rejects this shape loudly. viborm accepts it and lies. Worse, the engine documents the opposite as its justification —
[BulkCountOperation.ts:26](../../src/query-engine-v2/BulkCountOperation.ts:26): *"updateMany with relation data is rejected by V1's own validation schema (reused here), so a relation payload never reaches the builder — parity is inherited, not re-derived."* That premise is false, and it is why no test was ever written.

Degenerate sub-case: if `data` contains **only** relation keys, the user gets a bare `QueryEngineError: No fields to update` ([set-builder.ts:53](../../src/query-engine/builders/set-builder.ts:53)) that never names the relation.

**Defect 2 — verified by reading both call sites `[V]`.**
[push.ts:106](../../src/cli/commands/push.ts:106) plans the dry run with `resolve: options.force ? undefined : interactiveResolve`.
[push.ts:182](../../src/cli/commands/push.ts:182) then re-plans and applies with `push(client, { force: true, dryRun: false })` — **no `resolve` callback**, so [planner.ts:250](../../src/migrations/push/planner.ts:250) falls back to `alwaysAddDropResolver`. A change the user answered *"rename"* to executes as DROP + ADD. (Outright rejections still abort correctly, because `reject()` throws.)

**Defect 3 — verified with a live probe `[V]`.**
[RelationJunctionPart.ts:982](../../src/query-engine-v2/RelationJunctionPart.ts:982) requires the target PK as a compile-time literal in the create data. With V1 deleted there is no fallback, so an ordinary Prisma-shaped payload now throws.
`PLAN.md:421` predicted exactly this and reasoned it away: *"No current test schema hits it (all M2M targets carry provided PKs), so the route inventory over the reachable corpus is exactly one."* Every M2M fixture in `tests/fixtures/many-to-many-schema.ts` uses `s.string().id()` with explicit values. **The gates measured corpus-reachability, not user-reachability.**

### 0.2 The systemic finding behind defect 3

`UnsupportedOperationError extends QueryEngineError {}` ([shared.ts:160](../../src/query-engine-v2/shared.ts:160)) with **no `diagnosticName` override**, and it is **not exported** from `src/index.ts` or `src/errors/index.ts`. So all **76** deliberate capability boundaries surface as:

```
err.name === "QueryEngineError"
err.code === VibORMErrorCode.INTERNAL_ERROR   // V9001
err.message === "query-engine-v2 update does not support …"
```

A documented capability boundary is indistinguishable from an internal engine crash, and there is no exported class to `instanceof` against. `FeatureNotSupportedError` (code `FEATURE_NOT_SUPPORTED`) exists and *is* exported — it is used for pgvector and never for these. **One small change makes 76 refusals honest.**

Compounding it: **73 comments across `src/` still say "routes to V1" / "hands to V1"**, which was true before P6 and is false now. They are the only per-site record of *why* each shape is refused, and they assert a consequence that no longer exists. Commit `9e2d650` is itself labelled *"deliverable 3 (**partial**)"* — the de-staling was never finished.

### 0.3 The class of bug the gates never covered

Defects 1 and `findFirst({ take })` are the same shape: **validation accepts what the engine ignores.** The machine-checked gates in this repo prove that no shape silently *routes away*. Nothing proves that no shape is silently *dropped*. That is the gap worth closing structurally, not one defect at a time.

### 0.4 One-paragraph verdict on each deliverable

- **Prisma parity:** the query, filter, write and nested-write surfaces are close to complete and in several places a genuine superset. The gaps are ecosystem-shaped, not query-shaped: no `$extends`, no `$use`, raw SQL inverted and partly unreachable, `V####` instead of `P####` error codes, no field references, no full-text search, `Decimal` is a JS `number`, and the CLI is two commands.
- **Interoperability:** more portable than the README claims and less verified than it implies. The abstraction is real and carefully built; but "works in every provider" is currently a claim about **three embedded databases** extrapolated to eleven drivers. Five drivers have never executed a query against their real backend.
- **Not-implemented:** 76 typed refusals, of which ~40 are *narrower boundaries* reached by zero tests **by construction** — the census gate is empty precisely because nothing reaches them. With V1 deleted, "unreached by the corpus" and "unreachable by a user" are no longer the same claim, and the docs conflate them.

---

# Part 1 — Prisma Client ↔ viborm feature parity

**Engine note.** `src/query-engine-v2/` is the sole engine on the client path
([pending-operation.ts:124](../../src/query-engine/pending-operation.ts:124) → `constructRoutedOperation`; [routing.ts:20](../../src/query-engine-v2/routing.ts:20) *"with V1 deleted there is no fallback arm"*).
`src/query-engine/` was **not** deleted — it survives as the SQL-building substrate (builders, read operations, `PendingOperation`) that V2 delegates into.

## 1.1 Headline gaps a Prisma user hits first

1. **No `$extends`, no `$use`.** Client extensions (result/model/query/client) and middleware are absent entirely — the client proxy is a closed `if (prop === …)` dispatch with no user-extensible slot ([client.ts:373-786](../../src/client/client.ts:373); [types.ts:178](../../src/client/types.ts:178)). Largest ecosystem gap.
2. ~~**Raw SQL is inverted and partly unreachable.**~~ — **CLOSED by W5-U1**: `$queryRaw`/`$executeRaw` are tagged templates that bind every interpolation (returning `T[]` / the affected count), `$queryRawUnsafe`/`$executeRawUnsafe` carry Prisma's string signatures, `sql`/`join`/`empty`/`raw` are exported from the package root and from `viborm/sql`, and all four methods exist on the interactive transaction client bound to the open transaction. The pre-1.0 `(string, params?)` form survives one release behind a `warning`-channel deprecation notice; `$transaction([...])` refuses a raw operation with a typed V8003.
3. **Transaction options are rejected, not ignored.** `isolationLevel`, `timeout`, `maxWait` all throw `V5005` — `assertNoTransactionOptions` ([transactions.ts:8](../../src/drivers/shared/transactions.ts:8)), pinned across all 11 drivers. No provider-native escape hatch.
4. **Error codes don't port.** viborm has a real, driver-normalized taxonomy — but `V####`, not `P####`. `e.code === 'P2002'` becomes `V3001` ([base.ts:12](../../src/errors/base.ts:12)). No `P2000` mapping at all; PG `22001` / MySQL `1406` fall through to generic `QueryError`.
5. ~~**No field references**~~ — **CLOSED by W2-B**: `client.$fields.<model>.<field>` is Prisma's `FieldRef` (see §1.3). **No full-text search** still stands: `search` / `_relevance` return zero hits repo-wide.
6. ~~**Extended `whereUnique` is absent.**~~ — **CLOSED by W4-U1**: `findUnique`/`findUniqueOrThrow`/`update`/`delete`/`upsert` take Prisma ≥4.5's extended unique `where` (discriminator + non-unique scalar filters + `AND`/`OR`/`NOT`). Two divergences remain, both stated: relation filters inside a unique `where` are refused by name (the filter half compiles into UPDATE/DELETE, where MySQL rejects a subquery reading the mutated table), and nested relation-write target selectors / `cursor` keep the strict discriminator-only form.
7. **`Decimal` is a JS `number`.** `s.decimal()`'s runtime base is `v.number()` ([scalar.ts:11](../../src/schema/scalars/decimal/scalar.ts:11)) while the DDL is real `numeric` / `DECIMAL` — lossy round-trip. No Decimal.js/string-backed type exists.
8. **Nested `create`/`createMany` under `update` is conditionally refused.** Works only when the referenced parent column is single-field *and* pinned by the unique `where` or rewritten by the root SET ([UpdateOperation.ts:1327-1382](../../src/query-engine-v2/UpdateOperation.ts:1327)). Inverse-side to-one nested `create`/`createMany`/`updateMany`/`deleteMany` are absent outright (`:1671-1676`). Prisma has no such condition.
9. **No `omit`, no query-level projection sugar.** Query-level `omit` is a declared non-goal; only model-level `.omit()` exists ([model.ts:155](../../src/schema/model/model.ts:155)). ~~`_count: true` shorthand fails strict validation~~ — **CLOSED by W1-B**: the shorthand desugars to `{ select: { <every to-many relation>: true } }` in validation (see §1.4).
10. **Tooling is a fraction of Prisma's CLI.** Two commands: `viborm push` and `viborm migrate {generate,apply,down,status,drop}`. No Studio, no `db seed`, no `db pull` command, no drift detection, no shadow DB.

## 1.2 Model queries

| Operation | Status | Evidence |
|---|---|---|
| `findUnique` | ✅ | [find.ts:20-48](../../src/validation/model/args/find.ts:20); `routing.ts:32` |
| `findUniqueOrThrow` | ✅ | [ReadOperation.ts:80](../../src/query-engine-v2/ReadOperation.ts:80) |
| `findFirst` | ✅ — `take` honored with Prisma's sign semantics (`f105500`); `distinct` accepted, array **or** bare-string form (W1-B unit 3) | `find.ts` `getDistinctSchema` feeds findMany and findFirst alike; `ReadOperation` passes the whole validated args to `buildFind` |
| `findFirstOrThrow` | ✅ | `types.ts:113-114` |
| `findMany` | ✅ | `find.ts:107-157` |
| `create` | ✅ | `mutation.ts:19-45`; `CreateOperation.ts` |
| `createMany` (+`skipDuplicates`) | ✅ | `mutation.ts:54-79` |
| ~~`createManyAndReturn`~~ | **REMOVED as a name** (W3-B, decision D-1): `createMany` with a `select` IS the returning form. That `select` is **scalar-only** — a relation key, `_count`, or `include` is refused at the parse boundary (W3 fix round: the projection used to be accepted and answered with wrong data). `+skipDuplicates` still refused on non-returning drivers | `mutation.ts` `getCreateManyArgs`; `args/bulk-write-projection.ts`; `ManyAndReturnOperation.ts` |
| `update` | ✅ unique-`where` enforced | `mutation.ts:126-155` |
| `updateMany` | ✅ incl. `limit` (W4-U2) — **and see defect 1** | `mutation.ts` `getUpdateManyArgs`; `operations/bulk-limit.ts` |
| ~~`updateManyAndReturn`~~ | **REMOVED as a name** (W3-B, decision D-1): `updateMany` with a `select`. Same scalar-only projection as `createMany`; `limit` caps this arm too, so the rows returned are the rows affected. `deleteMany` with a `select` is the same shape, past Prisma, which has no returning `deleteMany` | `mutation.ts` `getUpdateManyArgs` / `getDeleteManyArgs`; `args/bulk-write-projection.ts` |
| `upsert` | ✅ **+ superset** (`targetWhere`/`setWhere`) | `mutation.ts:309-346`; probe-first, not `ON CONFLICT` ([UpsertOperation.ts:79](../../src/query-engine-v2/UpsertOperation.ts:79)) |
| `delete` | ✅ unique-`where` enforced | `mutation.ts:236-262` |
| `deleteMany` | ✅ incl. `limit` (W4-U2) | `mutation.ts` `getDeleteManyArgs`; `operations/bulk-limit.ts` |
| `count` | ✅ incl. `select: { _all, field }`, where/orderBy/cursor/take/skip | `aggregate.ts:111-148` |
| `aggregate` | ✅ `_count`(+`_all`)/`_avg`/`_sum`/`_min`/`_max`, input-window pagination | `aggregate.ts:158-202` |
| `groupBy` | ✅ `by`/`having`/`orderBy`/`take`/`skip` + all 5 aggregates; Prisma's orderBy⊆by rule enforced at runtime | `aggregate.ts:384-446`; `groupby.ts:251` |
| `exist` | ➕ Prisma has no such method | `routing.ts:39`. Runtime accepts full count args; client type exposes only `{ where? }` ([types.ts:132](../../src/client/types.ts:132)) — a type/runtime asymmetry, and it runs a full `COUNT`, not an `EXISTS` |
| Per-mutation `cache` arg | ➕ | `mutation.ts:27,40,61,98,135,171,207,244,278,319` |

Surface pinned by a compile-time exhaustiveness guard: `tests/query-engine-v2/route-inventory.test.ts:658-677`.

## 1.3 Filtering

Single compile path: [where-builder.ts](../../src/query-engine/builders/where-builder.ts) (V2 reads delegate into it).

| Feature | Status | Evidence |
|---|---|---|
| `equals`/`not`/`in`/`notIn`/`lt`/`lte`/`gt`/`gte` | ✅ | `scalars/int.ts:97-114`; allow-list `scalar-filter-operators.ts:5-53` |
| Shorthand `field: value` | ✅ | `primitives/shorthand.ts:11` |
| Empty `in: []` / `notIn: []` | ✅ Prisma semantics | `where-builder.ts:416-438` |
| `not` nesting | 🟡 validation allows **one** level; `not: { not: {…} }` rejected though the engine handles it | `scalars/string.ts:58-60` vs `where-builder.ts:379-389` |
| `contains`/`startsWith`/`endsWith` | ✅ **safer than Prisma** — compiled to `POSITION`/`LEFT`/`RIGHT`/`LOCATE`/`instr`, so `%`/`_` are literal | `where-builder.ts:451-470` |
| `mode: 'insensitive'` | ✅➕ works on **PG, MySQL and SQLite** (Prisma: PG/Mongo only) — ↔️ folds **ASCII A–Z only**, so it diverges from `ILIKE` on accented text | `where-builder.ts:325-345` |
| `search` / `_relevance` | ❌ | zero hits in `src/`; declared non-goal |
| `AND` / `OR` / `NOT` (obj or array) | ✅ incl. Prisma's per-item NOT semantics | `core/where.ts:57-65`; `where-builder.ts:156-231` |
| Empty `OR: []` → FALSE | ✅ | `where-builder.ts:199` |
| Null handling (bare, `{equals:null}`, `{not:null}`, NULL-excluding negation) | ✅ | `where-builder.ts:350-372` |
| List filters `has`/`hasEvery`/`hasSome`/`isEmpty`/`equals`/`not` | ✅➕ on **all three dialects** (Prisma: PG/Cockroach/Mongo only) | `scalars/string.ts:88-105`; all three adapters |
| Relation `some`/`every`/`none` (incl. M2M) | ✅ | `relations/filter.ts:66-82` |
| Relation `is`/`isNot`, `relation: null` | ✅ | `filter.ts:15-57` |
| To-one **shorthand** `{ author: { name: "x" } }` without `is` | ❌ | strict `{is,isNot}` object + strict-by-default objects |
| Relation filters in `updateMany`/`deleteMany` | ✅ incl. MySQL error-1093 derived-table workaround | `relation-filter-builder.ts:395-411` |
| JSON `path`/`equals`/`not`/`string_*`/`array_*` | ✅ all three dialects | `scalars/json.ts:38-54`; `json-filter-builder.ts:83-150` |
| JSON `path` grammar | ↔️ **array-only on every dialect**; Prisma's MySQL `'$.a.b'` string form rejected; segments with `"` or `\` rejected pre-SQL | `json-filter-builder.ts:56-64` |
| JSON `lt/lte/gt/gte`, JSON `mode` | ❌ | documented; `scalar-filter-operators.ts:36-45` |
| **Field-to-field comparison (`FieldRef`)** | ✅ **W2-B** — `client.$fields.<model>.<field>` in `equals`/`not`/`lt`/`lte`/`gt`/`gte` (+ string `contains`/`startsWith`/`endsWith`, and `mode: "insensitive"` folds both sides), incl. nested relation wheres and `updateMany`/`deleteMany`; excluded from `having`/`groupBy` (Prisma parity), `in`/`notIn`, list ops, JSON (filter **and** write data), blob/vector/point | `src/schema/field-ref.ts`; `validation/primitives/field-ref.ts`; `validation/scalars/json.ts` (`noFieldRef`); `where-builder.ts` `fieldRefColumn` |
| DateTime/Date/Time/BigInt/Decimal/Boolean/Enum filters | ✅ | `src/validation/scalars/*` |
| Bytes (blob) filters | 🟡 **`in`/`notIn` missing** (Prisma's `BytesFilter` has them) | `scalars/blob.ts:9,41-47` → falls to `{equals,not}` |
| Compound unique in `findUnique` | ✅ | `core/where.ts:98-121` |
| **Extended whereUnique** | ✅ **W4-U1** — discriminator + non-unique scalar filters + `AND`/`OR`/`NOT`, top-level `findUnique`/`findUniqueOrThrow`/`update`/`delete`/`upsert` only; relation filters refused by name; nested target selectors and `cursor` stay strict | `core/where.ts` `getWhereUniqueExtendedSchema`; `where-unique-builder.ts` `partitionWhereUnique` |
| `_count` in `where` | ❌ — matches Prisma | `where-builder.ts:110` |

**Reverse gap — CLOSED by W1-B unit 1.** The engine had always implemented `having: { AND | OR | NOT }` ([groupby-having.ts:17](../../src/query-engine/operations/groupby-having.ts:17)) while `getHavingSchema` built entries only from scalar names, so `groupBy({ having: { OR: [...] } })` died at validation with `Unknown key: OR`. `getHavingSchema` now builds AND/OR/NOT through the same thunk self-reference `getWhereSchema` uses (AND/NOT object-or-array, OR array-only; scalar entries applied last, so a scalar literally named `AND` still wins — identical precedence to `where`). Field references are excluded from `having` by an explicit `v.noFieldRef` wrapper (W2-B), matching Prisma.

Opening that surface exposed two latent engine bugs, both fixed in review, and both of the same shape: a combinator that had never been reachable from the client, so nothing had ever checked its truth table against `where`'s.

1. `buildHavingLogicalOr` returned `undefined` on an empty disjunction, which dropped the key and silently widened the result to *every* group, while `where: { OR: [] }` had always compiled to the dialect FALSE literal. The empty-combinator truth table is now identical on both sides of the boundary — OR of nothing is FALSE, AND and NOT of nothing are TRUE — and a non-array `OR` throws instead of being ignored, matching `buildLogicalOr`.
2. `buildHavingLogicalNot` computed `NOT (c1 AND c2)` for the array form, where `where`'s `buildLogicalNot` computes Prisma's `NOT c1 AND NOT c2` ("all conditions must return false"). The two readings agree only when the arms can be true together; when they exclude *different* groups — the ordinary way a `NOT` array is written — the conjunction is a contradiction and negating it returned **every** group, i.e. precisely the ones the caller asked to exclude. It now negates each arm and ANDs the negations, so `having` and `where` resolve an identical payload identically. The object form is still one item, so `NOT: { a, b }` remains `NOT (a AND b)` — per-arm negation distributes over array items, never over keys inside one item.

## 1.4 Selection, pagination, ordering

| Feature | Status | Evidence |
|---|---|---|
| `select` / `include`; empty-or-all-false select throws | ✅ | `core/select.ts:81,158` |
| `select`+`include` exclusivity | 🟡 enforced at **runtime** everywhere; at the **type** level it resolves the result to `never` rather than erroring | `select-include-exclusivity.ts:23`; `result-types.ts:211-215` |
| Arbitrary-depth nesting; select↔include alternation | ✅ | `relations/select-include.ts:114-196` |
| `omit` (query-level + client config) | ❌ declared non-goal | model-level `.omit()` only |
| `_count: { select: { rel: true } }`, filtered `_count` | ✅ in both select and include | `select.ts:128-133,181-189` |
| `_count: true` shorthand | ✅ (W1-B unit 2) — desugars in validation to `{ select: { <every to-many relation>: true } }`, in both `select` and `include`; the engine still sees only the object form. A model with no to-many relations expands to `{ select: {} }` (Prisma emits no `_count` field at all there, so there is no runtime behavior to mirror) | `validation/model/core/select.ts` `getCountSchema`; `result-types.ts` `InferRelationCountSelection` |
| `distinct` | ✅ findMany + `findFirst` + nested relation args, **array or bare-string** (W1-B unit 3 + W3-A unit 3); still not on `groupBy` | `find.ts` `getDistinctSchema`, `builders/distinct-builder.ts`, `relations/select-include.ts` |
| `distinct` SQL strategy | ↔️ SQL-backed, not Prisma's in-memory: PG `DISTINCT ON` when no orderBy, else `ROW_NUMBER()` everywhere | `shared/select-assembly.ts:77-151` |
| Relation args in include: `where`/`orderBy`/`take`/`skip`/`select`/`include` | ✅ (to-one correctly limited to select/include) | `relations/select-include.ts:114-185` |
| Relation-level negative `take` | ✅ (W3-A unit 1) — same pipeline as the top level: reversed order + absolute limit in the relation subquery, logical order restored on the result | `builders/nested-read-window.ts` |
| Relation-level `cursor` (incl. compound) | ✅ (W3-A unit 2) — the dialect-neutral cursor condition applied per parent inside the relation subquery; a cursor matching no row leaves that window empty | `builders/nested-read-window.ts`, `operations/cursor-condition.ts` |
| Relation-level `distinct` | ✅ (W3-A unit 3) — array of related-model scalars; the relation subquery goes through the adapter's own DISTINCT assembly, so each parent's window is deduplicated in order and only then windowed by take/skip | `builders/nested-read-window.ts`, `builders/include-query.ts` |
| `take`/negative `take`/`skip`/`cursor`/compound cursor | ✅ (top-level findMany) | `args/pagination.ts:6-17` |
| `orderBy` object / array / asc / desc | ✅ | `orderby-builder.ts:63-109` |
| `orderBy` nested to-one relation field | 🟡 **capped at 3 hops** (`MAX_RELATION_ORDER_DEPTH`); to-many mid-chain rejected | `relations/order-by.ts:60,117-125` |
| `orderBy` relation `_count` | ✅ (only `_count` — no `_sum`/`_avg` relation ordering) | `relations/order-by.ts:235-241` |
| `orderBy` aggregate in groupBy | ✅ | `aggregate.ts:341-369` |
| `orderBy: { sort, nulls }` | ✅ native on PG, emulated via `(col IS NULL)` on MySQL/SQLite | `sort-order-builder.ts:72-89` |
| To-many scalar-field `orderBy` | ❌ deliberately rejected (Prisma doesn't support it either) | — |
| `relationLoadStrategy` | ❌ as public API; internally auto-selected LATERAL (PG, MySQL 8.0.14+) vs correlated subquery (SQLite) — always **one round trip** | `select-builder.ts:163-185` |

## 1.5 Writes and nested writes

| Feature | Under `create` | Under `update` | Notes |
|---|---|---|---|
| `create` (single + array) | ✅ all cardinalities | 🟡 parent-held to-one ✅; **inverse to-one ❌** (`UpdateOperation.ts:1671`); **to-many conditional** — needs a single-field referenced column pinned by the unique `where` or rewritten by root SET (`:1327-1382`) | `client.user.update({ where:{ email }, data:{ posts:{ create:{…} } } })` fails; `where:{ id }` works |
| `createMany` (+`skipDuplicates`) | ✅ to-many | 🟡 same pinning gate; ❌ inverse to-one; ❌ M2M (`RelationJunctionPart.ts:1615`) | — |
| `connect` | ✅ | ✅ | fails if target missing |
| `connectOrCreate` | ✅ | ✅ — ↔️ **global** lookup-and-adopt (reparents), not parent-correlated | `UpdateOperation.ts:1434` |
| `update` | — | ✅ to-one takes bare data **or** Prisma 5's `{where?,data}` (W4-U3; `where` is a NON-unique filter on the connected record, filter-miss → P2025-equivalent, whole tree rolls back). ⚠️ on a target owning a field named `data` the two spellings collide and viborm **refuses** the shape (Prisma picks one silently) — spell the envelope out, `{where:{},data:{…}}`. To-many `{where,data}` ✅ | `update.ts:45-79`, `to-one-update-form.ts` |
| `updateMany` | — | ✅➕ `where` is **optional** (Prisma requires it) | `update.ts:153-161` |
| `upsert` | ➕ **to-many only, viborm superset**, global-adopt-and-update, **executable today** | ✅ to-one `{create,update}`, to-many `{where,create,update}` | `create.ts:182-201`; proven in `create-nested-upsert-behavior.ts:123`. `compatibility.mdx:66` saying "the current engine rejects it" is **stale** |
| `delete` | — | ✅ boolean (to-one), whereUnique single+array (to-many) | ↔️ inverse-side `delete: true` with no related row is a **no-op**; Prisma throws P2025 |
| `deleteMany` | — | ✅ to-many; ❌ inverse to-one | `update.ts:172` |
| `set` | — | ✅ to-many, with orphan guard | `RelationWritePart.ts:910-947` |
| `disconnect` | — | ✅ boolean on optional to-one; whereUnique on to-many | `update.ts:49,251-253` |
| Required-relation orphaning | ✅ throws, Prisma-equivalent — **plus stricter typing**: on a required to-one the `disconnect`/`delete` keys aren't in the schema at all | `RelationProgramValues.ts:181-188` |
| Atomic `set`/`increment`/`decrement`/`multiply`/`divide` | ✅ Int, Float, BigInt, Decimal | `set-builder.ts:106-134` |
| Atomic arithmetic **on a primary key** | ➕ with a portability gate (one op per PK; float/decimal arithmetic and `divide: 0` rejected) | `mutation-identity.ts:190-236` |
| Scalar-list `push`/`set` | ✅➕ also `unshift`, and on **all dialects** (Prisma: PG only) | `scalars/string.ts:127,142` |
| Json field update | ✅ `set` shorthand + `DbNull`/`JsonNull` sentinels (W4-U4); ↔️ a bare top-level `null` is **refused** in write position, as Prisma's `InputJsonValue` documents | `scalars/json.ts`, `primitives/json-null.ts` |
| Json null filtering | ✅ `equals`/`not` take `DbNull`/`JsonNull`/`AnyNull`, same truth table on all 3 dialects; ↔️ a sentinel under a `path` is refused (use `path` + `equals: null`) | `json-filter-builder.ts` |
| Nesting depth | ➕ **no engine limit**; only ceiling is TS literal inference (~31 rich levels) | `x1-depth-stress.test.ts`; `x1b-ts-ceiling.test.ts:139` |
| Write-race retry | ➕ whole operation retried **exactly once** on a racePin-matched unique violation; fail-closed on missing attribution | `race-retry.ts:27-113` |
| Implicit transaction around multi-statement writes | ✅ **stricter than Prisma** — a driver with neither transactions nor atomic batch is *rejected* | `OperationExecutor.ts:98-140` |

**Own-write preflight (viborm-specific).** Any nested decision read whose footprint overlaps an *earlier write in the same tree* is rejected before I/O: `{ posts: { create: {…}, connect: { where: {…} } } }` → `Nested operation 'connect' on relation 'posts' depends on an earlier 'create' target write in the same nested write. Split these operations into separate queries.` ([OwnWriteLedger.ts:247](../../src/query-engine/OwnWriteLedger.ts:247)). Prisma linearizes some of these. Deliberate doctrine: ATOM §4 rejects rather than linearizes, because reimplementing ~1.2k lines of legality semantics per-Part *"would fork the theorem the whole architecture rests on."*

## 1.6 Transactions

| Feature | Status | Evidence |
|---|---|---|
| Sequential `$transaction([...])` | ✅ operations are lazy `PromiseLike` | `client.ts:171-179,398-436` |
| Interactive `$transaction(async tx => …)` + rollback | ✅ | `client.ts:640-741` |
| Isolation levels | ❌ **actively rejected** (`V5005`) | [transactions.ts:8](../../src/drivers/shared/transactions.ts:8). `src/client/AGENTS.md:255-260` documents an `isolationLevel` option that does not exist |
| `maxWait` / `timeout` | ❌ actively rejected | same gate |
| Nested transactions / savepoints | ➕ Prisma has no nested `$transaction` | `driver.ts:450-462`; `savepoint-queue.ts` |
| Raw SQL inside a tx | ❌ at the client surface | `client.ts:653-731` — tx proxy is model-ops only |

**Per-driver:** interactive + batch on pg, postgres.js, pglite, bun-sql, mysql2, planetscale (single-shard), sqlite3, libsql, bun-sqlite. **Batch-only (interactive throws):** neon-http, d1. `d1-http` is **not implemented** despite `AGENTS.md:184` listing it.

## 1.7 Raw SQL

| Feature | Status | Evidence |
|---|---|---|
| `$queryRaw` tagged template | ❌ / ↔️ signature is `(sql: string, params?) => QueryResult<T>` — i.e. Prisma's `$queryRawUnsafe`. Caller writes `$1` vs `?` by hand | `client.ts:148-151` |
| `$executeRaw` | ↔️ takes a prebuilt `Sql`, returns `QueryResult<T>` (rows *and* rowCount) — the query/execute split is inverted vs Prisma | `client.ts:144-147` |
| `$queryRawUnsafe` / `$executeRawUnsafe` / `$queryRawTyped` | ❌ names don't exist | — |
| `Prisma.sql` / `join` / `empty` / `raw` | 🟡 **implemented but not publicly exported** | [sql.ts:221](../../src/sql/sql.ts:221) absent from `src/index.ts`, all `*/exports.ts`, `tsdown.config.ts`, `package.json` exports |
| Helper signature deltas | 🟡 `join` requires `Sql[]`; `sql.raw` is a **tagged template**, not `Prisma.raw(string)` | `sql.ts:156-172` |
| `Sql.toStatement("$n"|":n"|"?")` dialect renderer | ➕ | `sql.ts:99` |
| Raw fails closed during an open tx on single-connection drivers | ➕ | `driver-transaction-base.ts:44-59` |

## 1.8 Client-level

| Feature | Status | Evidence |
|---|---|---|
| Middleware `$use` | ❌ | closed dispatch |
| `$extends` | ❌ | `types.ts:178-182` |
| `$on` events / `log: ['query']` | 🟡 different: constructor-config **callbacks**, levels `query\|cache\|warning\|error`; no emitter, no `target`, no `info`; sql/params stripped by default | `instrumentation/types.ts:13,18-39` |
| `$connect` / `$disconnect` | ✅ | `client.ts:180-182,744-764` |
| Error taxonomy | 🟡 real and driver-normalized, but `V####` not `P####` | below |
| `datasources`/`datasourceUrl` | ↔️ connection lives on the driver | — |
| `adapter` (driver adapters) | ✅ mandatory; 11 first-party drivers | `client.ts:122` |
| `errorFormat` | ❌ (nearest: `diagnostics.{includeSql,includeParams}` — controls *disclosure*, not formatting) | `errors/diagnostics.ts:31-34` |
| `transactionOptions` | ❌ rejected | §1.6 |
| Global `omit` config | ❌ (model-level only) | — |
| Preview features / flags | ❌ by design | — |
| OpenTelemetry tracing | ✅➕ **GA, not preview**; no separate instrumentation package; optional peer dep with no-op fallback | `instrumentation/tracer.ts:393` |
| Query caching | ➕ built-in, pluggable, no Accelerate service | `cache/schema.ts:61-116` |
| `$metrics` | ❌ | internal `PerfTracker` not in the published entrypoint |

**Error mapping (viborm → Prisma):** `UniqueConstraintError V3001`→P2002 · `ForeignKeyError V3002`→P2003 · `NotNullConstraintError V3003`→P2011 · `CheckConstraintError V3004`≈P2004 · `NotFoundError V6001`→P2025 · `ConnectionError V1001/2/3`≈P1001/P1002 · `ValidationError V4001`→PrismaClientValidationError · `QueryError V2001`≈PrismaClientUnknownRequestError · `QueryEngineError V9001`≈RustPanic. Normalization is real and multi-dialect (PG SQLSTATE, MySQL errno + `ER_*`, SQLite `SQLITE_CONSTRAINT_*`, PlanetScale errno-in-message, D1 suffix stripping — [error-mapping.ts:23-226](../../src/drivers/error-mapping.ts:23)).
**Missing:** P2000, `PrismaClientInitializationError` (client-construction failures are plain `Error`).
**viborm-only:** `TransactionError`, `NestedWriteError` (V7001-6), `FeatureNotSupportedError` (V8001), `PendingOperationError` (V12001-4), cache errors (V10001-4), `isRetryableError()`, and a SQL/param redaction layer.

## 1.9 Schema and types

| Prisma | viborm | Status |
|---|---|---|
| String, Int, BigInt, Float, Boolean, DateTime, Json, Bytes | `s.string/int/bigInt/float/boolean/dateTime/json/blob` | ✅ |
| **Decimal** | `s.decimal()` | 🟡 **JS `number`, not arbitrary precision** — lossy round-trip against a real `numeric` column |
| enum | `s.enum([...])`, `.name(dbEnumName)` | ✅ (inline only). Native PG/MySQL enums; SQLite `CHECK` emulation |
| `Unsupported("...")` | — | ❌ closed `ScalarType` union |
| Native types `@db.*` | first ctor arg, `s.string(TYPES.PG.STRING.VARCHAR(255))` | ✅ (applied only on matching driver) |
| `@id` / `@@id([a,b])` | `.id()` / `model.id([...], {name})` | ✅ — `s.string().id()` implicitly adds ULID + unique |
| `@unique` / `@@unique` | `.unique()` / `model.unique([...], {name})` | ✅ accumulating |
| `@default(static)` | `.default(v)` **+ `.default(() => v)` factory** | ✅➕ |
| `autoincrement()`/`uuid()`/`cuid()`/`ulid()`/`nanoid()`/`now()` | `.increment()`/`.uuid(prefix?)`/`.cuid(prefix?)`/`.ulid(prefix?)`/`.nanoid(len?,prefix?)`/`.now()` | ✅➕ prefixes are viborm-only; `.cuid()` is **cuid2** |
| `dbgenerated()`, `auto()` | — | ❌ |
| `@updatedAt` | `.updatedAt()` | ✅ |
| `@map` / `@@map` | `.map()` | ✅ |
| `@ignore` / `@@ignore` | `.omit({field:true})` | 🟡 **different semantic** — client-level projection exclusion, not "invisible to client but present in DB". No DB-only-field marker |
| `@@index` | `.index(fields, {name, unique, type, where})` | ✅➕ adds `unique`, `btree\|hash\|gin\|gist`, PG partial-index `where` |
| `@@fulltext` | — | ❌ at schema level, though the migration layer supports it |
| `@relation(fields, references)` | `.fields()` / `.references()` | ✅ |
| `@relation(name:)` | `.name()` on all 4 relation kinds | ✅ |
| Referential actions | `.onDelete()`/`.onUpdate()`: `cascade\|setNull\|restrict\|noAction` | 🟡 **`SetDefault` absent** at schema level. **DDL-enforced only** — no `relationMode="prisma"` client emulation |
| Self-relations 1:1, 1:N | ✅ | — |
| Self-relation M:N | 🟡 requires explicit `.A()`/`.B()` (Prisma auto-assigns) | `helpers.ts:175` |
| Implicit M:N | ✅ auto junction `post_tag` / `postId`,`tagId` — ↔️ different naming from Prisma's `_PostToTag`/`A`/`B` | `relation/helpers.ts:21-36` |
| Explicit M:N (join model) | ✅ as two ordinary 1:N pairs | `many-to-many.ts:50` |
| List fields `String[]` | 🟡 PG native arrays; MySQL/SQLite emulate with JSON — **and the warning that would say so is dead code** (see §3.C10) | — |
| `view` blocks, `type` blocks, `@@schema`/multiSchema | — | ❌ |
| — | `s.date()`, `s.time()`, `s.point()`, `s.vector().dimension(n)` | ➕ |
| — | per-field `.schema(standardSchemaValidator)` (Zod/Valibot) | ➕ |

**Definition-time validation** (`src/schema/validation/`, 40+ codes) — 🟡 important caveat: it does **not** run on `createClient` ([client.ts:352](../../src/client/client.ts:352) only hydrates names). It fires only in the CLI and `db push`. A schema with a missing inverse relation constructs a client fine and fails only at migrate/push time.

## 1.10 Migrations and tooling

| Prisma | viborm | Status |
|---|---|---|
| `migrate dev` | split into `migrate generate` + `migrate apply` | 🟡 no one-shot; **no drift detection** (diffs models vs stored `meta/_snapshot.json`, never vs live DB); no shadow DB, no reset prompt, no seed |
| `migrate deploy` | `migrate apply` | 🟡 near-full — per-migration transaction, checksum verification, PG advisory lock. ↔️ **interactive by default**, needs `--force` for CI. ➕ `--to <index>` partial apply |
| `migrate reset` | `reset()` API only | 🟡 not a CLI subcommand; no seed step; no test coverage |
| `migrate diff` | `diff()`/`preview()`/`generateDDL()` primitives | 🟡 no command; can't diff DB↔DB |
| `migrate resolve` | `migrate drop` ≈ `--rolled-back` | 🟡 no `--applied` equivalent |
| `migrate status` | `migrate status` | 🟡 tracking table stores only `name/checksum/applied_at` — no failed-migration state, no drift report |
| `db push` | `viborm push` | ✅➕ `--force-reset`, `--strict`, `--verbose`, `--dry-run`, interactive resolver. ⚠️ `--accept-data-loss` is spelled `--force`. **See defect 2** |
| `db pull` / introspection | full introspectors for PG/MySQL/SQLite | 🟡 **internal only** — return a `SchemaSnapshot`, no TS emitter, no CLI command |
| `db seed` | — | ❌ |
| `studio` | — | ❌ |
| `generate` | — | n/a by design (zero codegen) |
| `validate` | implicit inside every CLI command | 🟡 no standalone command |
| Shadow DB | — | ❌ (snapshot-based instead) |
| `migration_lock.toml` | journal `dialect` + `validateJournalDialect` | ✅ equivalent |
| `_prisma_migrations` | `_viborm_migrations`, ➕ configurable via `--table-name` | ✅ |
| Concurrency lock | PG advisory lock; MySQL `GET_LOCK`; **SQLite/LibSQL return null → no lock** | 🟡 |
| Providers | postgresql, mysql, sqlite3, libsql | 🟡 no SQL Server / MongoDB / CockroachDB. **D1 has no migration driver** (falls through to sqlite3, untested) and `migrate apply` **cannot work on D1 or neon-http** — `apply()` requires `withTransaction`, which both throw |

**DDL differ covers:** create/drop table, add/drop/alter column, indexes (incl. PG partial), unique constraints, primary keys, foreign keys with forward-reference ordering, enum create/drop/alter with value-removal data remapping.
**Not supported:** automatic rename detection, data migrations / custom SQL steps, views, triggers, sequences, extensions, partitions, RLS, CHECK constraints, comments, collations, column reordering, multi-schema.

➕ **viborm-only tooling:** down migrations with lossy-operation warnings, `squash` with backup archive, pluggable storage drivers (S3/DB/edge-capable), programmatic `createMigrationClient()` with storage-less push for Workers, per-change resolve callbacks (`proceed/reject/rename/addAndDrop/mapValues/useNull`), `push --strict`.

## 1.11 viborm superset — things Prisma does not have

| Feature | Evidence |
|---|---|
| **Zero codegen** — types inferred from schema, Standard Schema V1 compliant, JSON Schema export | `getSchemas()` at `src/index.ts:81` |
| **Vector similarity search** (pgvector): `s.vector().dimension(n)`, `orderBy: { embedding: { _distance: { to, metric } } }`, selectable `_distance` | `builders/vector-distance-builder.ts` |
| **Nested `upsert` under `create`** (to-many) with global-adopt-and-update | `create.ts:182-201`; `create-nested-upsert-behavior.ts:123` |
| **No engine depth limit** on nested writes; every mechanism at every level | `x1*-*.test.ts` |
| **Built-in caching** with TTL/SWR, memory + Cloudflare KV + custom drivers, per-mutation invalidation, `cacheVersion` | `cache/schema.ts:61-116` |
| **Nested transactions / savepoints** with a poisoning-aware serializer | `savepoint-queue.ts` |
| **Write-race retry** (once, racePin-matched, fail-closed) | `race-retry.ts` |
| `upsert` `targetWhere` / `setWhere` — partial-unique-index targeting and conditional `DO UPDATE ... WHERE` | `UpsertOperation.ts:84-89` |
| `exist({ where? }) → boolean` | `docs/…/exist.mdx` |
| Nested `updateMany` with optional `where` | `update.ts:153-161` |
| `mode:'insensitive'`, scalar-list filters, list `push/unshift/set` on **MySQL and SQLite** | §1.3, §1.5 |
| Atomic arithmetic on primary keys with a portability gate | `mutation-identity.ts:190-236` |
| `s.date()`, `s.time()`, `s.point()`, per-field Standard-Schema validators, function-valued defaults, ID prefixes, partial/typed indexes, explicit junction naming | §1.9 |
| Down migrations, squash, pluggable storage, per-change resolvers | §1.10 |
| `isRetryableError()` + SQL/param redaction in thrown *and* serialized errors | `errors/diagnostic-safety.ts` |
| 11 first-party drivers incl. edge/serverless from one codebase | `src/drivers/` |

---

# Part 2 — Database interoperability, the honest matrix

**The claim under test** (`docs/content/docs/client/compatibility.mdx:11`): *"Everything in the API works the same on every database unless noted under Database differences."* The doc lists exactly **two** differences (serverless batch-only transactions; vector/geospatial). The real list is longer.

## 2.1 Drivers and dialects

**11 drivers, 3 dialects, 4 migration drivers.** `AGENTS.md:184` claims "13+: … d1-http, …" — **`d1-http` does not exist**; it appears only in prose.

There is **no driver-level capability interface**. `src/drivers/types.ts` defines no capability type; the driver capability surface is two booleans + one protected field on the base class ([driver-instrumentation.ts:112,120,135](../../src/drivers/driver-instrumentation.ts:112)). `supportsReturning` lives on the **adapter**, not the driver.

`BatchOptions.atomic` (`src/drivers/types.ts:72-75`) is **dead code** — nothing reads it, and every transaction entry point calls `assertNoTransactionOptions`.

| Driver | Dialect | `supportsTransactions` | `supportsBatch` | `serializeTransactions` | Declared at |
|---|---|---|---|---|---|
| `pg` | postgres | true | false | false | `pg/index.ts:70` |
| `postgres` (postgres.js) | postgres | true | false | false | `postgres/index.ts:104` |
| `pglite` | postgres | true | false | **true** | `pglite/index.ts:51,56` |
| `neon-http` | postgres | **false** | **true** | false | `neon-http/index.ts:124` |
| `bun-sql` | postgres | true | false | false | `bun-sql/index.ts:97` |
| `mysql2` | mysql | true | false | false | `mysql2/index.ts:137` |
| `planetscale` | mysql | true | false | false | `planetscale/index.ts:80` |
| `sqlite3` | sqlite | true | false | **true** | `sqlite3/index.ts:60,65` |
| `libsql` | sqlite | true | false | **conditional** (in-memory only) | `libsql/index.ts:94,101` |
| `d1` | sqlite | **false** | **true** | false | `d1/index.ts:137` |
| `bun-sqlite` | sqlite | true | false | **true** | `bun-sqlite/index.ts:88` |

**Adapter capabilities** ([adapter-capabilities.ts](../../src/adapters/adapter-capabilities.ts)):

| Flag | postgres | mysql | sqlite | Read by the engine? |
|---|---|---|---|---|
| `supportsReturning` | true | **false** | true | yes |
| `supportsLateralJoins` | true | true (8.0.14+) | **false** | yes |
| `supportsMutationTargetInSubquery` | true | **false** (ERR 1093) | true | yes |
| `supportsVector` | false → true only via `{ pgvector: true }` | false | false | yes |
| `supportsCteWithMutations` | true | false | true | **no — dead flag** |
| `supportsFullOuterJoin` | true | false | false | **no — dead flag** |
| `supportsUpsertWhere` | true | false | true | **no — dead flag** |

Placeholder style is **dialect-derived, never driver-derived**: `$n` for postgres, `?` for mysql/sqlite. No driver overrides it.

## 2.2 Execution substrate

| Feature | postgres family | mysql family | sqlite family |
|---|---|---|---|
| Interactive `$transaction(cb)` | ✅ except ❌ `neon-http` | ✅ | ✅ except ❌ `d1` |
| Batch `$transaction([...])` | ✅ | ✅ | ✅ |
| Savepoints / nested tx | ⚠️ **hand-rolled, uniform** `SAVEPOINT sp_<uuid>` emitted as literal SQL for every dialect ([transactions.ts:227-253](../../src/drivers/shared/transactions.ts:227)) — deliberately bypasses postgres.js `sql.savepoint` and Bun SQL `savepoint`. Unavailable on `d1`/`neon-http` |
| Isolation levels | ❌ **not exposed at all, on purpose** — `assertNoTransactionOptions` rejects any second argument. No provider-native escape hatch |
| Concurrency | 🟡 pooled (`pg`, `postgres`, `bun-sql`); serialized (`pglite`) | 🟡 pooled | 🟡 **serialized** (`sqlite3`, `bun-sqlite`, in-memory `libsql`) |

**The `requiresAtomicResolution` refusal — real code, currently unreachable in production.**
[routing.ts:107-126](../../src/query-engine-v2/routing.ts:107) refuses `update`/`delete`/`upsert` when `supportsBatch && !supportsTransactions && !supportsReturning`. The only non-returning adapter is MySQL, and no shipped MySQL driver is batch-only; the only batch-only drivers (`d1`, `neon-http`) both support RETURNING. So **no shipped driver combination can hit this refusal.** It is exercised only by an artificial test subclass (`tests/drivers/batch-forced-mysql2.ts:11`) inside the docker-gated MySQL suite — a test that does not run by default.

## 2.3 RETURNING

| Feature | postgres | mysql | sqlite |
|---|---|---|---|
| `RETURNING` clause | ✅ | ❌ (`returning()` returns `sql.empty`) | ✅ (3.35+) |
| `create` fold | ✅ 1 stmt | ⚠️ INSERT + refetch by mutation identity | ✅ 1 stmt |
| `update` fold | ✅ 1 stmt | ⚠️ locate + UPDATE + re-read | ✅ 1 stmt |
| `upsert` fold | ✅ | ⚠️ locked target-aware branch (MySQL's `ON DUPLICATE KEY` ignores the conflict target) | ✅ |
| `createManyAndReturn` | ✅ one `INSERT…RETURNING` per row | ⚠️ per-row INSERT + identity refetch | ✅ |
| `updateManyAndReturn` | ✅ | ⚠️ capture PK set → bulk UPDATE → re-read | ✅ |
| `*AndReturn` in forced batch on a non-returning driver | n/a | ❌ `TransactionError` | n/a |
| Affected-row postcondition enforcement | ✅ | 🟡 **weaker** — `enforceAffected = txMode && supportsReturning`, so MySQL skips the `affectedRows(1)` postcondition | ✅ |

**MySQL's cost is structural, not cosmetic.** Every single-row write is 2–3 statements instead of 1, and the re-read is a separate statement inside the transaction. `libsql` has its own quirk in the other direction: it reports `rowsAffected: 0` for RETURNING mutations, so the driver prefers `rows.length`.

## 2.4 Types

| Type | postgres | mysql | sqlite | Verdict |
|---|---|---|---|---|
| **JSON** | `jsonb`, `#>`/`#>>`/`@>` | `JSON`, `JSON_EXTRACT`/`JSON_CONTAINS` | `JSON`(TEXT), chained `->`, `json_each` for `@>` | 🟡 identical operator set, three SQL shapes |
| **Scalar lists / arrays** | ✅ native `type[]` | ⚠️ **JSON emulation** | ⚠️ **JSON emulation** (string-surgery concat for push/unshift) | ⚠️ never refused. Prisma refuses lists on MySQL/SQLite; viborm emulates |
| **Enum** | native `CREATE TYPE` | inline `ENUM('a','b')` | ⚠️ `TEXT CHECK(col IN (…))` | 🟡 three storage strategies, identical query surface |
| **Decimal** | `numeric` | `DECIMAL(65,30)` | 🟡 **`REAL`** | 🟡 **lossy on all three at the JS boundary** — decodes to an IEEE-754 double |
| **BigInt** | `bigint` | `BIGINT` + `supportBigNumbers` | `INTEGER` + `safeIntegers(true)` / `intMode:"bigint"` | ✅ exact round-trip proven for `9007199254740993n` — **except `bun-sqlite`** has no BigInt-safety opt-in at all, and `d1` sets no int mode ❓ |
| **Bytes / blob** | `bytea` | `BLOB` | `BLOB` | ✅ all representations normalized to `Uint8Array`, incl. PG `\x…` hex and MySQL `base64:typeNNN:` JSON. `.array()` refused |
| **DateTime** | `timestamptz`/`timestamp`, µs | 🟡 `DATETIME(3)` — **ms only, and `withTimezone` maps to the same type: tz is lost** | 🟡 `TEXT` ISO, `withTimezone` silently ignored | 🟡 largest emulation surface. Sub-ms precision is **rejected**, not truncated |
| **Boolean** | `boolean` | `TINYINT(1)` | `INTEGER` 0/1 | ⚠️ fully transparent |
| **UUID** | `text` + `gen_random_uuid()` | `VARCHAR(191)` when keyed; **no DB default** | `TEXT`, app-generated | 🟡 **there is no `uuid` scalar type** — it's `s.string().uuid()` |
| **Vector / pgvector** | 🟡 opt-in only | ❌ | ❌ | ❌ `FeatureNotSupportedError`. **But DDL happily creates a `JSON` column for a vector field on MySQL/SQLite** — the schema migrates, then every query refuses. Same for `point`/PostGIS |

## 2.5 Query features

| Feature | postgres | mysql | sqlite | Verdict |
|---|---|---|---|---|
| `mode: "insensitive"` | ⚠️ `TRANSLATE` | ⚠️ **26 nested `REPLACE()`** | ⚠️ `lower(x)` | ✅ semantically identical everywhere (ASCII A–Z only, so no locale divergence). 🟡 **never index-usable, pathological on MySQL**. `ILIKE` is never used, despite the PG adapter docstring claiming otherwise |
| `contains`/`startsWith`/`endsWith` | `POSITION`/`LEFT` | `LOCATE(BINARY…)` | `instr`/`substr COLLATE BINARY` | ✅ same result. 🟡 **`startsWith` never emits `LIKE 'x%'`** — no B-tree prefix scan on any dialect |
| **Full-text search** | ❌ | ❌ | ❌ | **Not implemented anywhere.** Not mentioned in the compatibility doc — reads as an unlisted gap rather than a stated non-goal |
| `distinct` | 🟡 native `DISTINCT ON` only when there is no `orderBy` | ⚠️ ROW_NUMBER emulation | ⚠️ ROW_NUMBER emulation | Requires MySQL 8.0 / SQLite 3.25 |
| Relation reads (include/select) | lateral join | lateral join (8.0.14+) | ⚠️ correlated subquery | ✅ **identical result shape** — all three use JSON aggregation |
| JSON path filters | ❌ segments with `"` or `\` | ❌ same | ❌ same | ❌ **the SQLite limit is levelled up to every dialect**. PG and MySQL *could* address those keys; they are refused so behavior can't diverge |
| `nulls: first/last` | ✅ native | ⚠️ emulated | ⚠️ emulated | — |
| Cursor pagination | ✅ | ✅ | ✅ | fully dialect-neutral |
| `skip` without `take` | ✅ bare `OFFSET` | ⚠️ `LIMIT 18446744073709551615` | ⚠️ `LIMIT -1` | — |
| LIMIT/OFFSET binding | parameterized | 🟡 **inlined as literals** (mysql2 binds JS numbers as DOUBLE) | parameterized | 🟡 defeats statement-cache reuse on MySQL |
| `FOR UPDATE` | ✅ | ✅ | 🟡 **silently omitted** | SQLite locks at DB level; no signal |
| aggregate / groupBy / having | ✅ | ✅ | ✅ | zero dialect branching in the builders |
| `updateMany`/`deleteMany` with a self-relation filter | ✅ | ⚠️ derived-table wrapper (ERR 1093, needs 8.0.14+) | ✅ | — |
| `$queryRaw` | ❌ not portable | ❌ | ❌ | you write `$1` or `?` yourself. No translation, no warning |

## 2.6 Writes

| Feature | postgres | mysql | sqlite |
|---|---|---|---|
| `upsert` | `ON CONFLICT (target) DO UPDATE` | ⚠️ **not** `ON DUPLICATE KEY` — a locked, target-aware locate/branch, because MySQL's primitive fires on *any* unique collision | `ON CONFLICT` |
| `createMany({skipDuplicates})` | ✅ 1 statement | ⚠️ **N INSERTs, each in its own `SAVEPOINT`**, unique violations swallowed in JS | ✅ 1 statement |
| m2m junction `skipDuplicates` | SQL | SQL (`ON DUPLICATE KEY UPDATE col=col`) | SQL |
| atomic `increment`/`decrement`/`multiply` | ✅ shared | ✅ shared | ✅ shared |
| integer `divide` | native truncation | ⚠️ `TRUNCATE(col / ?, 0)` | ⚠️ `col / CAST(? AS INTEGER)` — **deliberately normalized to PG's truncate-toward-zero** |
| Referential actions | ✅ DB-level | ✅ DB-level | 🟡 **clauses emitted, not enforced by default** |

> **The single most consequential undocumented difference.** SQLite defaults `PRAGMA foreign_keys` to **OFF**, and **nothing in `src/drivers/` ever turns it on** — the only occurrences in `src/` are the OFF/ON pair bracketing a table rebuild ([sqlite/index.ts:177,248](../../src/migrations/drivers/sqlite/index.ts:177)). The test suite enables it by hand ([sqlite3.test.ts:416](../../tests/drivers/sqlite3.test.ts:416)). On `sqlite3`/`bun-sqlite`/`libsql` your `onDelete: cascade` is decorative unless you issue the pragma yourself.

## 2.7 Migrations / DDL

| Feature | postgres | mysql | sqlite / libsql |
|---|---|---|---|
| FK placement | separate `ALTER TABLE` | **inline** | **inline** |
| Forward-FK ordering fix | ✅ lifted to ALTER | ✅ lifted | 🟡 kept inline (cannot ALTER-ADD-FK) |
| `alterColumn` | direct | `MODIFY COLUMN` (implicit commit) | ⚠️ **full table rebuild** (7 steps); libsql has native `ALTER COLUMN … TO` |
| PK / FK changes | direct | direct | ⚠️ table rebuild |
| Rebuild refusal | — | — | ❌ `Cannot add NOT NULL column … SQLite requires a default value or nullable column for table recreation.` |
| Enum DDL | `CREATE TYPE` / `ALTER TYPE ADD VALUE` (pulled **out** of the transaction — not rollbackable) | comment no-op + `MODIFY COLUMN` per dependent column | comment no-op + table rebuild |
| Index types | btree, hash, gin, gist; **only dialect with partial-index `WHERE`** | btree, fulltext, spatial | btree only — and **`index.where` is silently dropped** even though SQLite supports partial indexes |
| Expression indexes / MySQL prefix lengths | ❌ not representable | ❌ (solved by type substitution: keyed `TEXT` → `VARCHAR(191)`) | ❌ |
| Fulltext/spatial indexes from the schema API | — | ❌ not declarable | — |
| CHECK constraints | ❌ | ❌ | ❌ (the only `CHECK(...)` is the SQLite enum emulation) |
| Migration lock | `pg_advisory_lock` | `GET_LOCK(…,30)` | **none** |

No warning anywhere that a SQLite `alterColumn` rebuilds+copies the table, that MySQL DDL implicitly commits, or that `ALTER TYPE ADD VALUE` runs outside the transaction.

## 2.8 Testing reality — the honesty column

Measured, not estimated.

| Driver | Real-DB suite | Runs on `pnpm test`? | Measured |
|---|---|---|---|
| `pglite` | 24 shared suites | ✅ | **433 passed** |
| `sqlite3` | 32 suites | ✅ | **515 passed** |
| `libsql` | 31 suites | ✅ | **482 passed** |
| pgvector on pglite | 1 suite | ✅ | 7 passed |
| `mysql2` | 32 suites — the **fullest** matrix | ❌ docker + env var | **474 skipped** |
| `pg` | 22 suites | ❌ docker + env var | **303 skipped** |
| `postgres` (postgres.js) | **9 suites** | ❌ docker + env var | **145 skipped** |
| `d1` | — | — | ❓ **0 real queries** — fakes + `Reflect.construct(D1Driver, [{ database: {} }])` |
| `planetscale` | — | — | ❓ **0 real queries** — ~39 mock tests |
| `neon-http` | — | — | ❓ **6 mentions total**, all capability-flag assertions |
| `bun-sql` | — | — | ❓ **1 test** that spawns `bun --eval` against `postgres://127.0.0.1:1` to assert `sql.close()` is thenable — skipped when `bun` isn't on PATH |
| `bun-sqlite` | — | — | ❓ **0 real queries**, all `vi.fn()` fakes |

```
↓ tests/drivers/pg.test.ts       (303 tests | 303 skipped)
↓ tests/drivers/postgres.test.ts (145 tests | 145 skipped)
↓ tests/drivers/mysql2.test.ts   (474 tests | 474 skipped)
Test Files  3 skipped (3)   Tests  922 skipped (922)
```

**There is no CI.** `.github/` does not exist. There is no `docker-compose.yml`. The docker-gated suites depend on a human remembering `pnpm test:mysql` / `pnpm test:pg`.

Net: **~1,430 tests hit a real (embedded) database by default, across 3 drivers, none of them a networked server.** 922 more exist for the two most-used production drivers and never run. Five drivers have never executed a single query against their actual backend.

The stand-in for hosted batch drivers is `BatchOnlyPGliteDriver` / `BatchOnlySQLite3Driver` — a local driver with its capability flags flipped. That proves the *engine's* batch path; it proves nothing about D1's `batch()` semantics, Neon's HTTP transaction, or PlanetScale's Vitess behavior.

The repo is honest about this in its own docs (`tests/drivers/README.md:38`, `nested-write-provider-gaps.md:10-20`, `AGENTS.md:556`). **Nothing enforces those admissions.**

## 2.9 Interop defects found while building this matrix

1. **`push({ forceReset: true })` is broken on the entire SQLite family.** [reset.ts:23](../../src/migrations/push/reset.ts:23) and [reset.ts:95](../../src/migrations/reset.ts:95) call `generateDropTableSQL(name, /*cascade*/ true)`; the SQLite driver does not override [base.ts:555](../../src/migrations/drivers/base.ts:555), which emits `DROP TABLE IF EXISTS "x" CASCADE`. Confirmed against better-sqlite3: `near "CASCADE": syntax error`. The CLI's `--force-reset` path passes no cascade and is safe, which is why no test caught it (`tests/cli/push.test.ts:396` runs on PGlite).
2. **Native type + `.array()` silently drops array-ness on MySQL and SQLite.** [mysql/index.ts:94](../../src/migrations/drivers/mysql/index.ts:94) and [sqlite/index.ts:75](../../src/migrations/drivers/sqlite/index.ts:75) return `nativeType.type` without consulting `scalarState.array`; PG does it correctly. `s.string(MYSQL.STRING.VARCHAR(50)).array()` emits `VARCHAR(50)`, not `JSON`.
3. **`s.enum([...]).array()` never produces an array column on any dialect.** The serializer's enum branch bypasses `mapScalarType` and assigns `columnType = enumName` ([serializer.ts:98-121](../../src/migrations/serializer.ts:98)).
4. **`s.enum([...]).name("status")` emits an invalid MySQL column type** — `serializer.ts:106` prefers `enumName` whenever `supportsNativeEnums`, which includes MySQL, where the correct type is the literal `ENUM('a','b')` string.
5. **SQLite enum schemas likely re-diff forever.** Desired type is `TEXT CHECK(...)`; `PRAGMA table_info` reports `TEXT`; `columnsEqual` compares raw strings. Perpetual `alterColumn`, classified destructive → a non-forced re-push of a SQLite schema containing an enum is refused. No idempotency test covers this.
6. **`bun-sqlite` has no BigInt-safety path.** `sqlite3` opts into `safeIntegers(true)`, `libsql` forces `intMode:"bigint"`; [bun-sqlite/index.ts:133-147](../../src/drivers/bun-sqlite/index.ts:133) has no equivalent. Large integers silently lose precision on that driver only, with no test.
7. **The MySQL/SQLite portability warnings are dead code.** `DB001` ("will use JSON") and `DB002` ("will use CHECK constraint") at [database.ts:32-89](../../src/schema/validation/rules/database.ts:32) are only reachable via `createDatabaseRules(db)`, which nothing calls; the default rule set contains only `enumValueValid`. Users are never told their arrays became JSON.
8. **ORM-level vector *writes* are untested on every dialect.** `buildScalarSqlValue` has no `vector` branch; the only vector suite seeds rows with raw `$3::vector` SQL.

## 2.10 Verdict

**Where the promise genuinely holds.** The public result contract is dialect-blind: blobs come back as `Uint8Array` regardless of `Buffer` / `ArrayBuffer` / `number[]` / PG hex / MySQL base64-JSON; booleans normalize `true/1/1n`; BigInts round-trip exactly at 2⁵³+1; malformed provider values throw typed errors instead of being coerced. Read shapes are identical by construction (JSON aggregation on all three). Aggregation, groupBy, having, cursor pagination, and the entire nested-write interpreter contain zero dialect branching. Semantics are *actively normalized* where SQL disagrees — integer division truncates toward zero everywhere; MySQL's `ON DUPLICATE KEY` is deliberately not used because it fires on the wrong constraint; ERR 1093 is worked around with derived tables; `mode:"insensitive"` folds ASCII only so no locale can change the answer. Refusals are typed, pre-flight, and documented.

**Where it's emulated-but-equivalent.** Scalar lists on MySQL/SQLite, enums on SQLite, NULLS FIRST/LAST, `DISTINCT ON`, booleans, savepoints, bare `OFFSET`. All produce the same answer. The cost is invisible in results and very visible in query plans. **"Works the same" is true. "Performs the same" is not, and nothing in the docs says so.**

**Where it's genuinely different and under-documented.** Timezone data is lost on MySQL. DateTime precision differs (µs / ms / string). `Decimal` is a JS number everywhere. **Foreign keys are not enforced on SQLite.** Partial indexes are PG-only and the `where` is *silently dropped* on SQLite. Full-text search exists nowhere and isn't listed as a non-goal. Portability is sometimes bought by *degrading Postgres* — JSON path segments with `"` or `\` are refused on PG solely because SQLite's grammar has no escape syntax. Isolation levels are unavailable everywhere with no escape hatch. `$queryRaw` is not portable at all.

**Where it's simply unverified.** Five of eleven drivers have never executed a query against their real backend; their coverage is `vi.fn()` object literals asserting the *normalizer's* contract, which proves viborm handles a well-formed response and proves nothing about what those services return. The two drivers most people deploy — `pg` and `mysql2` — have 777 tests between them that don't run on `pnpm test` and have no CI to run them. The batch-only path that D1 and Neon users depend on entirely is proven only by a local driver with its booleans flipped.

**Bottom line: the engine is more portable than its README claims and less verified than its README implies.** "Works in every provider" is currently a claim about three embedded databases extrapolated to eleven drivers. Shipping a CI matrix with docker Postgres and MySQL would convert 922 tests from aspiration to evidence overnight — that single change would do more for the honesty of the claim than any code in the repo.

---

# Part 3 — What is not permitted, not implemented, or deferred

## 3.0 The structural fact that reframes everything

**V1 is gone.** [routing.ts:64](../../src/query-engine-v2/routing.ts:64) — *"with V1 deleted there is no fallback arm to catch it."*

Consequence: **all 76 `UnsupportedOperationError` throw sites are now terminal, user-facing errors.** Before P6 they were *routes* — the tree quietly re-ran on V1 and the user got a working query. `ATOM.md:1469` confirms: *"The former route-to-V1 declines are now terminal `UnsupportedOperationError`s."*

But **73 comments across `src/` still say "routes to V1"**. See §0.2.

### The refusal surface, counted

| Class | Sites in `src/query-engine-v2/*.ts` | Nature |
|---|---:|---|
| `UnsupportedOperationError` | **76** (pinned: `route-inventory.test.ts:622`) | shape the engine cannot express |
| `QueryEngineError` | 82 | ~4 real declines, ~78 fail-closed invariants |
| `NestedWriteError` | 32 | relation legality / target-not-found |
| `TransactionError` | 5 | driver-capability refusals |
| `ValidationError` | 1 | the single parse boundary |

## 3.A Hard refusals a user could hit

*Ranked by likelihood in a normal application.*

**A1. M2M nested `create` with a database-generated target PK — the top hazard.** See [defect 3](#01-the-three-defects-worth-fixing-before-anything-else). Zero test coverage; every M2M fixture uses explicit string PKs.

**A2. `update`/`delete`/`upsert` on a batch-only, non-returning driver.** The returned row's identity can only be parsed after the batch commits, and that parse cannot be rolled back. `TransactionError`. A substrate limit; `ATOM.md:318` says it stays *"unless a deliberate design note lifts it."* **Currently unreachable** — no shipped driver combination qualifies.

**A3. No application-level ID generation (uuid / ulid / cuid) in the values builder.** `Auto-generated value '…' must be provided explicitly … Application-level ID generation (uuid, ulid, cuid) is not yet implemented.` ([values-builder.ts:182](../../src/query-engine/builders/values-builder.ts:182)). Related: on a non-returning driver, `create` refetch requires a single `autoGenerate: "increment"` PK.

**A4. `createManyAndReturn` + `skipDuplicates` on a non-returning driver.** The one refusal the maintainer explicitly authorized — genuinely inexpressible (no portable `ON CONFLICT DO NOTHING` that also reports which rows were inserted). The *sole* entry in `REMAINING_ROUTE`.

**A5. Async validation is not supported, anywhere.** The whole validation layer is synchronous; any Standard Schema with an async refinement is rejected at runtime with `Async validation is not supported` — surfaced as a `ValidationError` issue, not a clear unsupported-feature signal ([validation/index.ts:73](../../src/validation/index.ts:73) and 8 more sites).

**A6. ~~Nested relation queries reject negative `take` and any `cursor`.~~ Resolved by W3-A units 1–2.** The relation subquery now runs the same `buildFindPagination` pipeline as the top level: a negative `take` flips the order, takes `|n|` and has its logical order restored by the result parser, and `cursor` (including compound uniques) is applied per parent through the shared cursor condition.

**A7. `updateMany` is scalar-only** — the engine's position ([relation-key-legality.ts:21](../../src/query-engine/relation-key-legality.ts:21)), which matches Prisma. **But validation doesn't enforce it — see [defect 1](#01-the-three-defects-worth-fixing-before-anything-else).**

**A8. `createMany.data` cannot nest relations.** Parity.

**A9. No relation projection on a bulk write's returned rows** — neither `include` nor a relation key (or `_count`) inside `select`, on `createMany` / `updateMany` / `deleteMany`. DIVERGENCE, deliberate (W3 fix round): Prisma's `createManyAndReturn`/`updateManyAndReturn` do accept relations there (its generator emits `<Model>SelectCreateManyAndReturn` / `<Model>IncludeCreateManyAndReturn`). viborm refuses instead, because the projection it had was unsound — a relation subquery in a `RETURNING` list has no alias to correlate against, so it bound by name and was captured by the inner table: every to-many came back `[]`, a self-referencing to-one came back `null`, while the same projection through `findMany` returned the real rows. Read relations in a separate query. (`args/bulk-write-projection.ts`.)

**A10. Relation `orderBy` supports only `_count`.** Parity, but viborm additionally rejects to-one relation ordering combined with cursor pagination.

**A11. Cursor pagination cannot be combined with relation or vector ordering.** `cursor-order.ts:53`.

**A12. `createMany({skipDuplicates})` with a defaults-only row.** No portable `INSERT … DEFAULT VALUES … ON CONFLICT DO NOTHING`.

**A13. Arithmetic on a primary key — four portability refusals.** Two ops on one PK; float/decimal PK arithmetic; `divide: 0`; non-finite operand. Plus: a derived write to a **relation key** field while mutating that relation.

**A14. The own-write preflight.** See §1.5. viborm-specific — Prisma linearizes some of these.

**A15. Referential-action legality: nested adopt under a non-cascade PK transition.** A root `update` rewriting a parent PK a child references with `onUpdate: restrict/setNull/noAction`, while nesting `connect`/`connectOrCreate`/`set`/to-many `upsert`. *(The T4c-fix commit `b82a729` exists because this guard was originally wired only into the inverse-to-one `upsert` — every other kind silently diverged into corruption. Fixed; recorded because it shows the class is live.)*

**A16. Every model must have a primary key.** Engine, `push` and `migrate` all refuse.

**A17. Parity refusals inside nested writes** (all match Prisma's own rejections): `update`/`delete`/`set`/`disconnect` inside a `create` payload; M2M `upsert`/`disconnect`/`set`/`delete` under `create`; two kinds on one to-one arm; object-form `disconnect: {…}`/`delete: {…}` on a to-one; writing a relation's owned FK inside its own nested create; nested create identity must match the unique `where`; M2M `disconnect: true` without a selector; `set` that would orphan a required FK.

**A18. Driver / dialect capability refusals.** `d1`/`neon-http` callback transactions; `$transaction` options; array-form `$transaction` with a non-batchable op on a batch-only driver; insertId-scratch batch merge; PlanetScale cross-shard; `mysql2` `multipleStatements`; SQLite RIGHT/FULL OUTER/LATERAL; MySQL FULL OUTER; JSON path segments with `"` or `\`; nullable vector column in a distance select; compound-PK many-to-many (query **and** migration).

## 3.B Narrower boundaries — the deep shapes the engine declines

These are the *interesting* category. `route-inventory.test.ts:70-73` states plainly: **"NO conformance scenario reaches any of them (that is why the census is zero)."** They were unreachable-by-test *and* silently handled by V1. **V1 is gone. They are now live cliffs with zero test coverage.**

Census evolution: 36 → 49 → 51 → 59 → 62 → 65 → 73 → 74 → 75 → 78 → 81 → 86 → 87 → 90 → 89 → 84 → 83 → 78 → **76**. Every absorption added finer boundaries.

| # | Boundary | Sites |
|---|---|---|
| **B1** | Shared-primary-key edges whose fold value isn't a compile-time literal (`A.id` *is* the FK to `B`; works for a direct-referenced `connect` or literal-id `create`, fails for a non-referenced `connect`, a generated create id, or `connectOrCreate`) | `CreateOperation.ts:758`, `UpdateOperation.ts:2491` |
| **B2** | Compound keys at the wrong place in the tree | `CreateOperation.ts:1230`, `UpdateOperation.ts:1333,1129,2046`, `RelationUpsertPart.ts:653` |
| **B3** | Nested writes that must locate their target by its primary key (a nested `update`/`upsert` carrying its own relation writes needs a construction-time literal FK) | `RelationWritePart.ts:596`, `RelationUpsertPart.ts:740`, `RelationJunctionPart.ts:1339` |
| **B4** | Nested relation writes in arms that can't carry them (upsert create arm; `updateMany`/connectOrCreate-adopt data; parent-held to-one located data; before-root target create) | `RelationWritePart.ts:375,586,576`, `UpdateOperation.ts:2318,2506` |
| **B5** | **PK transition + a non-cascading child-held edge** — *"routed for correctness, not inexpressibility"* (`PLAN.md:1314`). Witness test exists | `RelationWritePart.ts:637` |
| **B6** | Nested `create` under a PK-transitioning parent (unpinned pre-transition value; non-literal arithmetic rewrite; reference neither pinned nor rewritten) | `UpdateOperation.ts:1352,1367,1379,1156` |
| **B7** | Connect by a non-referenced unique in the wrong position | `UpdateOperation.ts:2993,2574`, `RelationUpsertPart.ts:940` |
| **B8** | The connectOrCreate / upsert create-arm depth guard (one level deeper) | `RelationUpsertPart.ts:806,848,854,916,923,495,597` |
| **B9** | Depth leaves in `nested-target-parts.ts` (5 sites). **The depth limit itself is gone** — X1/X1b/X1c lifted it entirely; a 40-level chain is exercised. These are *seam* differences, not a counter. `:537` is the live tripwire the decline-surface gate keeps alive | `nested-target-parts.ts:307,335,481,537,555` |
| **B10** | T4b/T4c narrower boundaries (located-only pre-transition PK, compound generated PK, non-portable arithmetic; the A15 adopt decline) | `ATOM.md:1383,1424,1445` |
| **B11** | Top-level `upsert` update arm with a parent-held to-one relation | `route-inventory.test.ts:456` |
| **B12** | Degenerate/unreachable guards — `'<label>' must be an object.` ×4, the upsert fourth-key gate, `read does not handle '…'`, `No validation schema exists for relation '…'`, the defensive relation-type guard | — |

### The user-facing shapes inside §3.B worth calling out by name

These are ordinary Prisma payloads:

| Payload | Result |
|---|---|
| `user.update({ where:{ id }, data:{ profile:{ create:{ bio } } } })` on an **inverse-side to-one** | ❌ `does not support nested 'create' on the inverse-side to-one relation 'profile'` ([UpdateOperation.ts:1671](../../src/query-engine-v2/UpdateOperation.ts:1671)). `tests/query-engine-v2/to-one-update-family.test.ts:260-440` enumerates every other inverse-to-one kind — **no `create` case** |
| `user.update({ where:{ email }, data:{ posts:{ create:{…} } } })` | ❌ `requires the referenced parent column 'id' to be pinned by the unique where or rewritten by the update`. Works with `where: { id }` |
| `post.update({ where:{ id }, data:{ tags:{ createMany:{ data:[…] } } } })` (M2M) | ❌ `does not support nested 'createMany' on many-to-many relation 'tags'` |
| `tags: { update: { where:{ slug }, data:{ posts:{…} } } }` | ❌ must locate the target by its primary key |
| Two kinds on one to-one arm, or connect-by-other-unique on a parent-held to-one | ❌ see §1.5 |

## 3.C Deferred engineering (backlog, no direct user impact)

**C1. The narrowing / precise-type refactor through Part builders.** The remaining `requireRecord`/`normalizeSingle`/`normalizeItems`/`isRecord` narrowings are runtime-unreachable (the parse boundary already validated the tree) but are genuine `unknown → Record` **type** narrowings. Deleting them without an `as` needs the precise per-relation parsed type threaded through `interpretRelation` and every Part builder. **Current measured residue: 82 `QueryEngineError` throws and 41 `as Record<string, unknown>` casts** (docs said "~38"; it has grown). Guarded by a growth **ratchet** — the surface may only shrink.

> *Note: the label "X2b" used in earlier discussion does not exist anywhere in this repo. The work is X2's unlabeled "honest residue."*

**C2. `assertUpsertKeys` + upsert's `requireRecord` — the X2 conflict, deliberately kept.** Upsert is the only write op with no whole-args parse; its arms re-parse the RAW payload. Adding `parseValidated(args.upsert)` regressed the estate two ways: a non-idempotent transform failed on re-parse, and it validated the **untaken** arm, which `deferArmLegality` forbids. Reverted in `c5ee344`. **User-visible residue:** a malformed top-level **upsert** payload raises the coarse `UnsupportedOperationError` while create/update/delete raise a precise `ValidationError` — inconsistent error class across the write families.

**C3. "Part B" — array-mode driver rows (read fast path) — DESCOPED.** Part A shipped (identity decoders + whole-row passthrough, **2.08× on the parse step**, `-0.147 ms` on `findMany 1000`, Postgres-family only). Part B would eliminate PGlite's object-mode `Object.fromEntries` — the residual **~0.31 ms/op** end-to-end gap vs Drizzle. Blocked: it crosses the normalized cross-driver `QueryResult` contract and needs row column-order threaded to the parser.

**C4. Post-P6 backlog item 1** — substantially delivered by X1/X1b/X1c (census 90 → 76); what survives is B5, B9's `createMany`-under-planned-parent leaf, and the B10 mechanisms.

**C5. `maximumAffectedRows` postcondition.** V1's defensive rollback message for a physically-unreachable `count > 1`. V2 rolls the batch back correctly; only the *message* differs. Expressing it means growing the FROZEN step vocabulary. Test was retargeted to V1 and **died with V1 at P6** — now untested on either engine.

**C6. `disconnect`-array statement dedup.** V2 emits one statement per target where V1 deduped. Observably idempotent, identical final state. Same fate — test died with V1.

**C7. Postconditions and `onUniqueConflict: skip` have no atomic-batch lowering.** Both fail closed rather than silently degrade. Mitigated because the only `recoverableUniqueError` dialect (MySQL) runs transactions in production.

**C8. Dead-but-implemented adapter capability surface.** Fully implemented across all three dialect adapters, **never called by the engine**: pgvector similarity filters (`l2`, `cosine`); PostGIS operators (`intersects`/`contains`/`within`/`crosses`/`overlaps`/`touches`/`covers`/`dWithin`); `greatest`/`least`; array `length`/index get/index set. Validation types are deliberately truncated to `equals`/`not` to match. Plan doc: `docs/architecture/vector-similarity-plan.md`.

**C9. Genuinely unimplemented features with written specs.** Polymorphic relations (8 phases, "Large"); recursive queries (`WITH RECURSIVE`, "Medium"); Redis cache driver; query-level `omit`.

**C10. A registered schema-validation rule that is an empty stub.** `enumValueValid` (rule **V001**) — [database.ts:93-108](../../src/schema/validation/rules/database.ts:93). The loop body contains only a comment. Registered and **can never report anything**. *(This is why the DB001/DB002 portability warnings in §2.9-7 are unreachable: `enumValueValid` is the only rule in the default set.)*

**C11. Type-safety and heuristic holes accepted by design.** `RelationState.getter` must stay `any` (circular model references); the `*Id`-suffix FK heuristic emits false-positive CM001 warnings; a "simplified" FK-direction check in `relation-data-builder.ts:314`.

**C12. Items I could not substantiate.** *"Re-pinning exact create write-SQL in `sql-generation.test.ts`"* — no evidence; the create assertions there are (and were before P6) loose `toContain("INSERT INTO")` checks. Commit `164fd88` re-pinned the **delete** test, not create. If this obligation exists it is tracked nowhere in the repo.

## 3.D Accepted performance trade-offs

**D1. V2 per-call construction cost on in-memory drivers.**

| Op | V1 hz | V2 hz | Ratio |
|---|---:|---:|---|
| scalar update | 36,312 | 31,226 | ~1.16× slower |
| scalar create | 26,524 | 22,950 | ~1.16× slower |
| scalar update (P5) | — | — | ~1.37× slower |
| upsert (P5) | — | — | ~1.39× slower |

Residual is V2's fixed per-call construction cost (fresh operation object + own-write preflight + schema parse); `upsert` additionally keeps its probe-first locate by design. **Dominant only on in-memory SQLite's ~20 µs round-trip; noise on any networked driver.** Maintainer-accepted.

**D2. Cold start** — +1.4 µs per client instantiation (118,367 → 101,964 hz) from added import-time module surface.

**D3. Read parse cost** — half the gap closed (Part A), half descoped (C3). End-to-end `findMany 1000` vs Drizzle is 0.86–0.95× and noise-limited.

**D4. The volume prize was NOT achieved.** `WHY-V1-GREW.md:273` predicted 10.8k → ~3–4k lines. Measured: V2 is **13,984 raw / 10,623 code** — ≈1.3–1.6× V1's write root. What compressed is *structure* (2 runtimes → 1, five orthogonal axes back to data), not lines. Recorded as the right trade, not a win.

**D5. Batch-only drivers keep the plan-then-execute path** — the single-statement RETURNING fast path is disabled there. Perf gap for D1 / Neon HTTP.

**D6. SQLite silently ignores `FOR UPDATE`** — a deliberate no-op. Row-level locking semantics differ from PG/MySQL with no signal.

## 3.E Unverified surface — the honest "we don't know"

**E1. All ~40 category-(iii) narrower boundaries are reached by zero tests, by design.** The census gate is *empty* precisely because nothing reaches them. **The gate proves they are unreached, not that they are correct or that no user will reach them.** §3.B is, structurally, an untested cliff.

**E2. No hosted-driver coverage at all.** D1, Neon HTTP, PlanetScale have no local fixtures or credentials. Batch-only PGlite is the stand-in.

**E3. Docker-gated suites skip silently on a normal `pnpm test`.** MySQL is the only non-returning dialect and the only `recoverableUniqueError` dialect; a default local run exercises neither.

**E4. `pg` / `postgres` get driver-level suites only.** Real-Postgres coverage of the adapter matrix is inferred from PGlite, not run.

**E5. Two contracts died with V1** (C5, C6) and are now untested on either engine.

**E6. `compatibility.mdx` is stale in the *under-promising* direction.** It still documents the X1c limitation as live (*"One shape is still one level short at a located target…"*) — X1c deleted exactly those two throws (`fd492d1`, census 78→76). Same page also still says nested `upsert` under `create` *"still rejects"*; the create tree routes to V2 now and the child-held one-to-many case **is** implemented as a deliberate Prisma superset. Users are being told shapes fail that now work.

**E7. The parity contract's own coverage column is full of gaps.** `prisma-parity-contract.md` self-reports *"missing dialect test"* on six rows, *"missing direct client type tests"* on four, *"missing result type tests"*, *"missing client-level raw SQL parity matrix"*, and *"hosted/external D1 binding, Neon HTTP, and MySQL/PlanetScale suites remain open."* It carries an explicit honesty clause: *"the public surface looks more Prisma-complete than it currently is. The main risk is false confidence."*

**E8. The TypeScript type-instantiation ceiling (~31 levels).** A rich per-level literal create payload type-checks at 30 levels and fails at 32 with TS2321. The runtime carries no depth counter and folds a 40-level chain. A **DX** ceiling on client input inference, not an engine limit. Workaround: build the payload programmatically so the compiler never infers the deep literal.

**E9. Documentation contradictions that make the current state hard to establish.** `ATOM.md:1004` *"(V1 not yet deletable)"* vs `routing.ts:26` *"with V1 deleted"*. `src/query-engine-v2/README.md:3` still declares *"Query Engine V1 remains the public implementation"*; its module table lists only `CreateOperation` (25 modules exist); `:291` says *"A future `UpdateOperation` should be implemented concretely first"* (it is 3,300+ lines); its "Deliberate Non-Goals" lists three things that all shipped. `correlation-utils.ts:19` claims M2M junction handling is *"not yet implemented"* while `:62` routes it to a working helper. `src/README.md:110` — *"when the database adapter system is implemented in a future phase"*. Plus the 73 "routes to V1" comments.

**E10. Reproducibility.** The benchmark baseline (`benchmarks/baseline.json`) is a **machine-local, untracked artifact**. None of the §3.D numbers is reproducible from a clean clone without regenerating it.

**E11. Silent data-integrity divergence on LibSQL migrations.** [libsql/index.ts:8-10](../../src/migrations/drivers/libsql/index.ts:8): *"CAVEAT: LibSQL's `ALTER COLUMN` only validates newly inserted/updated rows, NOT existing data."* A constraint added on LibSQL does not validate what's already in the table — a divergence from Postgres with no error and no test. Related: `unapply` does **not** run down migrations, it only removes tracking rows; bare `DECIMAL` defaults to a fixed `DECIMAL(65,30)`; the forward-ref FK lift is *"deliberately surgical"* — only FKs referencing a table created later **in the same batch** are lifted, other cycles unhandled.

## 3.F Client-surface items exposed but not wired end-to-end

| # | Item | Effect |
|---|---|---|
| F1 | `exist` has no arg schema of its own | validated against the **`count`** schema; `orderBy`/`cursor`/`take`/`skip`/`select` accepted at runtime but invisible to types; runs a full `COUNT`, not an `EXISTS` |
| F2 | `$transaction` accepts no options | JS callers get a runtime error, TS callers a compile error |
| F3 | Raw SQL | no tagged templates, inverted naming, no `*Unsafe` variants, `sql` unexported |
| F4 | No extensions, middleware, or event hooks | only interception points are construction-time `InstrumentationConfig` and the internal-only `PendingOperation.wrapExecutor` |
| F5 | Prepared statements are internal-only | `prepare()`/`prepareBatch()` are public on an exported class but no client API hands you a re-executable handle |
| F6 | Per-query `cache` arg is stripped before validation | every mutation schema carries `cache: cacheInvalidationSchema`, but the client proxy destructures `cache` out **before** building the operation ([client.ts:244-253](../../src/client/client.ts:244)). Dead schema entry. Reads have no `cache` entry at all |
| F7 | `$withCache` returns a non-batchable client | its results cannot be passed to `$transaction([...])` |
| F8 | Nested `$transaction` is savepoint-emulated only on transaction-capable drivers | unavailable entirely on D1 / Neon HTTP |

## 3.G Cross-cutting observation

**Decline messages leak internal vocabulary.** ~86 `UnsupportedOperationError` sites emit strings prefixed `query-engine-v2 …` referencing internal concepts ("parent-held to-one", "pastSurface", "compile-time literal"). These were written when the error was an internal routing signal caught by a V1 fallback. With V1 deleted they are the end-user error text.

---

## Appendix — documentation drift

| Doc | Claim | Reality |
|---|---|---|
| `compatibility.mdx:66` | nested `upsert` under `create` "still rejects" | it executes |
| `compatibility.mdx:43` | nested `create`/`createMany` under `update` marked plain ✅ | carries the literal-FK pinning restriction; absent on inverse-side to-one |
| `compatibility.mdx` (depth section) | "one shape is still one level short at a located target" | X1c deleted exactly those two throws |
| `compatibility.mdx:11` | "everything works the same on every database unless noted" + 2 noted differences | see Part 2 §2.10 |
| `README.md:39` | "no `updateManyAndReturn`" | it exists |
| `README.md:271-295` | `instrumentation: { tracing: { enabled: true } }` | `TracingConfig` has no `enabled` field |
| `prisma-core-gaps.md:20-22` | `createManyAndReturn`/`updateManyAndReturn` are non-goals | both implemented |
| `src/query-engine-v2/README.md:3` + 73 in-file comments | "V1 remains the public implementation" / "routes to V1" | V1 fallback deleted; those errors now propagate |
| `src/client/AGENTS.md:255-260` | `$transaction(cb, { isolationLevel })` | any second argument throws `V5005` |
| `src/migrations/AGENTS.md:191` | `viborm push --accept-data-loss` | the flag is `--force` |
| `AGENTS.md:184` | 13+ drivers including `d1-http` | 11 drivers; `d1-http` does not exist |
| `ATOM.md:1004` | "(V1 not yet deletable)" | V1 deleted at P6 |
| `correlation-utils.ts:19` | M2M junction handling "not yet implemented" | `:62` routes to a working helper |
| `src/README.md:110-112` | "when the database adapter system is implemented in a future phase" | adapters exist |
| `instrumentation.md` (repo root) | reads as viborm docs | it is a research dump about *Prisma's* `@prisma/instrumentation` |

---

## Recommended order of work

1. **Defect 1** — bind `updateMany`/`updateManyAndReturn` `data` to `core.scalarUpdate`, and correct the false premise in `BulkCountOperation.ts:26`. Smallest diff, worst bug.
2. **Export `UnsupportedOperationError`** with its own `diagnosticName`/code. One change, 76 boundaries become honest.
3. **Defect 3** — thread the produced junction id as a `Ref` (the T4a/T4b machinery already built and proven), plus an M2M fixture with a generated PK.
4. **Defect 2** — pass `resolve` through to the apply pass in `push.ts:182`.
5. **A CI matrix with docker Postgres + MySQL** — converts 922 tests from aspiration to evidence.
6. **Finish the stale-comment sweep** (73 sites) — the only per-site record of *why* each shape is refused currently asserts something false.
7. **Correct `compatibility.mdx`** — it under-promises against the shipped engine in two places.
