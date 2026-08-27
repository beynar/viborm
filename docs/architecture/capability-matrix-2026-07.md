# VibORM — Capability, Parity and Interoperability Matrix

> **Superseded relation spellings.** This document is a historical record. Its
> relation declarations use the retired six-factory API, and its diagnostics and
> internal type names may name owners that no longer exist. The shipped language
> is two factories, `s.toOne` and `s.toMany`, whose argument states the target
> domain; pairing, foreign-key ownership, uniqueness, junction topology and slot
> emptiness are all derived by one schema-wide resolver. See
> [`./global-relation-cardinality-plan.md`](./global-relation-cardinality-plan.md) for the unified language and
> the deliberate verdict changes it made. The measured history below is
> deliberately not rewritten into a new-API history.

**Repo:** `/Users/arnaud/code/viborm` @ `main` (`dccafe1`), working tree clean.
**Date:** 2026-07-25. Read-only audit; nothing in `src/` was modified to produce it.

> ### ⚠️ This is a snapshot of 2026-07-25, **before** the parity waves
>
> It is the audit that produced [prisma-parity-v2-plan.md](prisma-parity-v2-plan.md), and it is kept
> as a record of what was true when the work started — not rewritten to look like it predicted the
> outcome. Waves W1–W6 have since landed on `prisma-parity-v2`; **for what shipped, in what commit,
> and with what deliberate divergence, read the "Delivery status" table at the top of
> [prisma-parity-v2-plan.md](prisma-parity-v2-plan.md)** — that table is the summary of record.
>
> Rows this branch changed carry an inline annotation naming the closing commit. For current
> behavior, §0's residual-lift overlay and the linked residual plan supersede unannotated rows
> from the dated July snapshot; this file has not been re-audited line by line as one current
> matrix. Line-number citations were correct on 2026-07-25 and may have drifted since; the file
> and symbol names are the durable part of each citation.
>
> **Current residual-lift overlay (2026-08-14).** The executable refusal census is **8
> write-engine / 10 query-engine / 12 whole `src`**, and every live site has a falsifier;
> the former 76/68/40-site and zero-test statements below are historical audit checkpoints.
> Junction `createMany` now routes each row independently: a vacuous skip drops the flag, one
> exact selector adopts, and an unnameable conflict uses member suppression. Interactive
> drivers use a savepoint; batch-only drivers isolate the root write and observe normalized
> row count. A prior write or nested series remains a pre-effect refusal. Ordinary
> child-held progressive guards use READ row-key + READ membership for existing members and
> WRITE row-key + WRITE membership for supplier continuations. The Phase-3 PostgreSQL batch
> reconciliation closed 19 files / 126 write-engine failures and the live PG provider is green
> at 876 passed / 7 skipped / 0 failed. The residual plan and guard ledger are the current
> sources of record.

Three deliverables in one document:

- **[Part 1](#part-1--prisma-client--viborm-feature-parity)** — Prisma Client ↔ viborm feature parity.
- **[Part 2](#part-2--database-interoperability-the-honest-matrix)** — the database-interoperability promise, honestly.
- **[Part 3](#part-3--what-is-not-permitted-not-implemented-or-deferred)** — everything not permitted, not implemented, or deferred.

**Verification levels used below.** `[V]` = I reproduced it myself against a live database or read both ends of the code path in this session. `[E]` = file:line evidence cited, not independently executed. `[?]` = asserted by no test on any real backend.

**Legend.** ✅ full · 🟡 partial (gap named) · ❌ absent · ➕ viborm-only · ↔️ intentionally different · ⚠️ emulated (same result, different mechanism) · ❓ unverified against a real backend.

---

## §0 — Executive summary

### 0.0 Current relation-bearing bulk contract

The bulk-write surface now has two execution shapes:

| Shape | Current contract |
|---|---|
| Scalar `createMany` / `updateMany` | Set-oriented grouped SQL remains the fast path. |
| Root relation-bearing `createMany` | Input rows run left to right as ordinary fresh-record trees. On interactive drivers the operation is atomic. A batch-only driver isolates a skippable root as one atomic segment and suppresses descendants when normalized row count is zero. A write or nested series before that root remains a pre-effect refusal. |
| Root relation-bearing `updateMany` | The matching complete row keys are captured once, sorted, and updated through ordinary selected-record compilation. One named child-held target cannot be moved to more than one captured root. |
| Nested relation-bearing `createMany` | Rows run as ordered fresh-record subtrees at the exact nested position. Scalar-only rows remain grouped. |
| Nested relation-bearing `updateMany` | Correlated targets are captured at the exact nested position and updated in complete-row-key order. Scalar-only data remains set-oriented. |
| Returning record series | Final rows are fetched in K bounded set reads, normally one, and restored to source order. |
| Batch-only dynamic series | Any no-transaction driver with native atomic batch can execute safe committed segments after normalized awaited success. A nested series requires the exact compiler-owned complete-parent and, where needed, membership guard. Ordered commit callbacks strengthen failure attribution; they are not eligibility. |
| Explicit batch `$transaction([...])` | Static operations stay one atomic batch. A dynamic record series is refused because the array API promises one commit. |

No native libSQL batching optimization, compiler terminal-read elimination, or
whole-series PostgreSQL writable-CTE fold is part of this contract.

### 0.1 The three defects worth fixing before anything else

| # | Defect | Class | Who hits it |
|---|---|---|---|
| **1** | `updateMany` / `updateManyAndReturn` accept nested relation writes, report success, and **silently discard them** — **FIXED 2026-08-10** (limitation lift, Package K: the writes now execute, one ordinary update per matching row) | silent wrong-success | anyone doing a bulk update whose `data` also names a relation |
| **2** | `viborm push` discards the interactive **rename** decision and applies DROP + ADD | silent data loss | anyone renaming a column through `push` |
| **3** | M2M nested `create` with a **database-generated** target PK hard-fails | regression from the V1 deletion | `post.create({ tags: { create: {…} } })` with an autoincrement tag id |

**Defect 1 — verified live `[V]`. HISTORICAL as of 2026-08-10: fixed by the
query-engine limitation lift, Package K, not by a guard but by making the
payload mean something.** The example below is the state at this matrix's date;
everything from here to the end of this sub-section describes that state. Today
the same call updates the user AND creates the post: `data` still binds to
`core.update`, and a relation-bearing `data` now routes to
`UpdateManyRecordSeries`, which captures the matching root keys and runs one
ordinary selected-record update per root inside a transaction. `count` on that
arm is the captured root count. The `set-builder` skip is no longer reachable
with a relation key, and `BulkCountOperation`'s docblock — quoted below as the
false premise it was — has been corrected. See
[`limitation-lift-plan.md` §5.2](limitation-lift-plan.md) and
`write-engine/ATOM.md` §17.

```ts
client.user.updateMany({
  where: { id: "u1" },
  data: { name: "B", posts: { create: { id: "p-new", title: "…" } } },
})
// 2026-07 → { count: 1 }.  users = ["B"].  posts = [].  No error, no warning.
// 2026-08 → { count: 1 }.  users = ["B"].  posts = ["p-new"].
```

`UpdateManyArgs.data` binds to `core.update` — the **full** schema including every relation's nested-write object — not `core.scalarUpdate`
([mutation.ts:184](../../src/validation/model/args/mutation.ts:184), and `:221` for `updateManyAndReturn`).
The payload then reaches [set-builder.ts:34](../../src/query-engine/builders/set-builder.ts:34), which does `if (isRelation(...)) continue; // Skip relations`.

Prisma rejects this shape loudly. viborm accepts it and lies. Worse, the engine documents the opposite as its justification —
`BulkCountOperation`'s docblock, as it read at this matrix's date (the text is gone from the file — corrected 2026-08-11): *"updateMany with relation data is rejected by V1's own validation schema (reused here), so a relation payload never reaches the builder — parity is inherited, not re-derived."* That premise is false, and it is why no test was ever written.

Degenerate sub-case: if `data` contains **only** relation keys, the user gets a bare `QueryEngineError: No fields to update` ([set-builder.ts:53](../../src/query-engine/builders/set-builder.ts:53)) that never names the relation.

**Defect 2 — verified by reading both call sites `[V]`.**
[push.ts:106](../../src/cli/commands/push.ts:106) plans the dry run with `resolve: options.force ? undefined : interactiveResolve`.
[push.ts:182](../../src/cli/commands/push.ts:182) then re-plans and applies with `push(client, { force: true, dryRun: false })` — **no `resolve` callback**, so [planner.ts:250](../../src/migrations/push/planner.ts:250) falls back to `alwaysAddDropResolver`. A change the user answered *"rename"* to executes as DROP + ADD. (Outright rejections still abort correctly, because `reject()` throws.)

**Defect 3 — verified with a live probe `[V]`.**
[RelationJunctionPart.ts:982](../../src/query-engine/write-engine/RelationJunctionPart.ts:982) requires the target PK as a compile-time literal in the create data. With V1 deleted there is no fallback, so an ordinary Prisma-shaped payload now throws.
The retired implementation ledger predicted exactly this and reasoned it away:
*"No current test schema hits it (all M2M targets carry provided PKs), so the
route inventory over the reachable corpus is exactly one."* Every M2M fixture
in `tests/fixtures/many-to-many-schema.ts` uses `s.string().id()` with explicit
values. **The gates measured corpus-reachability, not user-reachability.** The
full ledger remains available at commit
`db3317770ce7e589ba1da849570eda6925c4c478`.

> **All three defects are fixed on `prisma-parity-v2`** — before the waves, not by them, which is why they have no row in the plan's delivery table. Defect 1: `bd091a0` binds `updateMany`'s `data` to `core.scalarUpdate` (`validation/model/args/mutation.ts:212`), so a relation key is refused at the parse boundary instead of discarded. Defect 2: `a9cf030` records the dry-run resolutions and replays them on the apply pass (`src/cli/resolve-recorder.ts`). Defect 3: `b1392ca` threads the junction target's DB-generated identity as a backward `Ref`, plus a generated-PK M2M fixture. The findings below are kept as written.

### 0.2 The systemic finding behind defect 3

`UnsupportedOperationError extends QueryEngineError {}` ([shared.ts:160](../../src/query-engine/write-engine/shared.ts:160)) with **no `diagnosticName` override**, and it is **not exported** from `src/index.ts` or `src/errors/index.ts`. So all **76** deliberate capability boundaries surface as:

```
err.name === "QueryEngineError"
err.code === VibORMErrorCode.INTERNAL_ERROR   // V9001
err.message === "query-engine-v2 update does not support …"
```

A documented capability boundary is indistinguishable from an internal engine crash, and there is no exported class to `instanceof` against. `FeatureNotSupportedError` (code `FEATURE_NOT_SUPPORTED`) exists and *is* exported — it is used for pgvector and never for these. **One small change makes 76 refusals honest.**

> **Done — `e109946`** (pre-wave, same branch): `UnsupportedOperationError` has its own code `V8003` and is exported from `src/index.ts:101`. Every "CLOSED by W5-U3 / typed V8003" annotation later in this document depends on that change. The stale-comment half of this finding is a separate item — see the last row of the Appendix.

Compounding it: **73 comments across `src/` still say "routes to V1" / "hands to V1"**, which was true before P6 and is false now. They are the only per-site record of *why* each shape is refused, and they assert a consequence that no longer exists. Commit `9e2d650` is itself labelled *"deliverable 3 (**partial**)"* — the de-staling was never finished.

### 0.3 The class of bug the gates never covered

Defects 1 and `findFirst({ take })` are the same shape: **validation accepts what the engine ignores.** The machine-checked gates in this repo prove that no shape silently *routes away*. Nothing proves that no shape is silently *dropped*. That is the gap worth closing structurally, not one defect at a time.

### 0.4 One-paragraph verdict on each deliverable

- **Prisma parity:** the query, filter, write and nested-write surfaces are close to complete and in several places a genuine superset. The gaps are ecosystem-shaped, not query-shaped: no `$extends`, no `$use`, no field references (W2-B), no full-text search, and the CLI is two commands. (W5 closed the raw-SQL, transaction-option, `omit` and — partly — the error-code items this bullet used to list; W6-U1 closed the `Decimal` one.)
- **Interoperability:** more portable than the README claims and less verified than it implies. The abstraction is real and carefully built; but "works in every provider" is currently a claim about **three embedded databases** extrapolated to eleven drivers. Four drivers have never executed a query against their real backend (W6-U2 moved `bun-sqlite` out of that set — and the first real query it ever ran proved it could not open a database).
- **Not-implemented, at the 2026-07 snapshot:** 76 typed refusals, of which ~40 were narrower boundaries with no tests. The current executable census is 8 / 10 / 11 and every live site has a falsifier; keep the old figures only as the audit baseline that motivated the lift.

---

# Part 1 — Prisma Client ↔ viborm feature parity

**Engine note.** `src/query-engine/write-engine/` is the sole engine on the client path
([pending-operation.ts:124](../../src/query-engine/pending-operation.ts:124) → `constructRoutedOperation`; [routing.ts:20](../../src/query-engine/write-engine/routing.ts:20) *"with V1 deleted there is no fallback arm"*).
`src/query-engine/` was **not** deleted — it survives as the SQL-building substrate (builders, read operations, `PendingOperation`) that V2 delegates into.

## 1.1 Headline gaps a Prisma user hits first

1. **No `$extends`, no `$use`.** Client extensions (result/model/query/client) and middleware are absent entirely — the client proxy is a closed `if (prop === …)` dispatch with no user-extensible slot ([client.ts:373-786](../../src/client/client.ts:373); [types.ts:178](../../src/client/types.ts:178)). Largest ecosystem gap.
2. ~~**Raw SQL is inverted and partly unreachable.**~~ — **CLOSED by W5-U1 and the five-capability Package 1 lift**: `$queryRaw`/`$executeRaw` are tagged templates that bind every interpolation (returning `T[]` / the affected count), `$queryRawUnsafe`/`$executeRawUnsafe` carry Prisma's string signatures, `sql`/`join`/`empty`/`raw` are exported from the package root and from `viborm/sql`, and all four methods exist on the interactive transaction client bound to the open transaction. Raw calls are lazy, promise-compatible operations and mix with model operations in `$transaction([...])`. The pre-1.0 `(string, params?)` form survives one release behind a `warning`-channel deprecation notice.
3. ~~**Transaction options are rejected, not ignored.**~~ — **CLOSED by W5-U3** (decision D-2): `$transaction` accepts `{ isolationLevel, timeout, maxWait }`. `assertNoTransactionOptions` is retired; each driver declares a contract in `transactionOptionSupport()` and the resolver ([transaction-options.ts](../../src/drivers/shared/transaction-options.ts)) either builds an executable plan or refuses with `UnsupportedOperationError` (V8003); a malformed options object is still `V5005`. Per-driver cells are pinned in `tests/drivers/transaction-portability.test.ts` and tabulated in [transactions.mdx](../content/docs/client/transactions.mdx).
4. ~~**Error codes don't port.**~~ — **PARTLY CLOSED by W5-U2**: every error still carries its own `V####` `code`, and now also a `prismaCode` where a Prisma counterpart exists (`e.prismaCode === 'P2002'` works in a catch written for Prisma). P2000 is mapped (`ValueTooLongError` V3005, from PG `22001` / MySQL `1406`) and client construction throws `ClientInitializationError` (V1004 → P1012). Deliberately partial: viborm-only families (transactions, nested writes, cache, migrations, V8003) report `undefined` rather than a code Prisma never defined — see the table in §1.8.
5. ~~**No field references**~~ — **CLOSED by W2-B**, resurfaced by **W8-A**: the operand callback `(ctx) => ctx.fields.<field>` is Prisma's `FieldRef` (see §1.3). **No full-text search** still stands: `search` / `_relevance` return zero hits repo-wide.
6. ~~**Extended `whereUnique` is absent.**~~ — **CLOSED by W4-U1**, and **extended PAST Prisma by N6-U1 and N6-U2** (decisions D-N1, D-N2): `findUnique`/`findUniqueOrThrow`/`update`/`delete`/`upsert` take Prisma ≥4.5's extended unique `where` (discriminator + non-unique scalar filters + `AND`/`OR`/`NOT`), and so do the **nested `update` / `upsert` / `delete` target selectors**, where Prisma is unique-only — see the superset row in §2. W4 had scoped those out because "a nested target is located by PK boundaries the extra filters would collide with"; N1/N4-U1 removed the collision by making a nested locate return its primary key however the row was named — and since N6-U2 landed in the same schema, a nested selector's filter half may be a relation filter too (it rides the aliased probe, never the write, so no `mutationTable` composition is owed at depth). ~~Relation filters inside a unique `where` are refused by name~~ — **CLOSED by N6-U2**: `buildUpdate`/`buildDelete` now qualify the unique `where` by the target's table name and declare it as the `mutationTable`, the spelling `buildUpdateMany`/`buildDeleteMany` always used, so the correlated `EXISTS` names the mutated table and MySQL's error 1093 is answered by the same derived-table wrapper. `connect`/`disconnect`/`set`/`connectOrCreate.where` and `cursor` stay strict on their own merits — they name a row to link or address, they do not locate one to mutate.
7. ~~**`Decimal` is a JS `number`.**~~ — **CLOSED by W6-U1**: `s.decimal()` is string-backed. It reads as the exact canonical decimal string, accepts `string | number` on write (a `number` is documented as possibly carrying float error the caller already made), and every comparison and arithmetic happens in SQL — `CAST(? AS NUMERIC)` on PG, `CAST(? AS DECIMAL(65,30))` on MySQL (uncast, MySQL would compare an exact column as a *double*). SQLite stores `TEXT` (was `REAL`): reads, writes and equality are exact, while ordering, aggregation and atomic arithmetic are a typed `UnsupportedOperationError` rather than a double-precision guess. A one-release `decimal: "number"` client option restores the old decode at runtime only.
8. **Nested `create`/`createMany` under `update` is conditionally refused.** Works only when the referenced parent column is single-field *and* pinned by the unique `where` or rewritten by the root SET ([UpdateOperation.ts:1327-1382](../../src/query-engine/write-engine/UpdateOperation.ts:1327)). Inverse-side to-one nested `create`/`createMany`/`updateMany`/`deleteMany` are absent outright (`:1671-1676`). Prisma has no such condition.
9. ~~**No `omit`, no query-level projection sugar.**~~ — **CLOSED by W5-U4**: query-level `omit` (every returning operation, plus nested relation nodes) and client-level `omit` both ship, desugaring in validation into the `select` they denote ([args/omit.ts](../../src/validation/model/args/omit.ts), [client/omit.ts](../../src/client/omit.ts)). Model-level `.omit()` ([model.ts:155](../../src/schema/model/model.ts:155)) became a HARD exclusion in the same unit — the field has neither a `select` nor an `omit` key — so the three layers rank schema > client > query. ~~`_count: true` shorthand fails strict validation~~ — **CLOSED by W1-B**: the shorthand desugars to `{ select: { <every to-many relation>: true } }` in validation (see §1.4).
10. **Tooling is a fraction of Prisma's CLI.** Two commands: `viborm push` and `viborm migrate {generate,apply,down,status}`. No Studio, no `db seed`, no `db pull` command, no drift detection, no shadow DB. (`migrate drop` was deleted in B4: untracking an applied migration while its schema stays live bypasses the rollback policy each migration now persists.)

## 1.2 Model queries

| Operation | Status | Evidence |
|---|---|---|
| `findUnique` | ✅ | [find.ts:20-48](../../src/validation/model/args/find.ts:20); `routing.ts:32` |
| `findUniqueOrThrow` | ✅ | [ReadOperation.ts:80](../../src/query-engine/write-engine/ReadOperation.ts:80) |
| `findFirst` | ✅ — `take` honored with Prisma's sign semantics (`f105500`); `distinct` accepted, array **or** bare-string form (W1-B unit 3) | `find.ts` `getDistinctSchema` feeds findMany and findFirst alike; `ReadOperation` passes the whole validated args to `buildFind` |
| `findFirstOrThrow` | ✅ | `types.ts:113-114` |
| `findMany` | ✅ | `find.ts:107-157` |
| `create` | ✅ | `mutation.ts:19-45`; `CreateOperation.ts` |
| `createMany` (+`skipDuplicates`) | ✅. Scalar rows — plus a direct polymorphic `connect`, which stays connect-only — keep the grouped multi-row `INSERT`. A row carrying a general relation program routes the whole call to an ordered record series of ordinary creates. Interactive drivers use one transaction; any no-transaction driver with native atomic batch uses committed segments. `skipDuplicates` suppresses a conflicting root's complete subtree. Batch execution isolates the root; only a prior write or nested series remains a pre-effect refusal. | `mutation.ts` `getCreateManyArgs`; `write-engine/CreateManyRecordSeries.ts` |
| ~~`createManyAndReturn`~~ | **REMOVED as a name** (W3-B, decision D-1): `createMany` with a `select` IS the returning form. That `select` is **scalar-only** — a relation key, `_count`, or `include` is refused at the parse boundary (W3 fix round: the projection used to be accepted and answered with wrong data). `+skipDuplicates` still refused on non-returning drivers | `mutation.ts` `getCreateManyArgs`; `args/bulk-write-projection.ts`; `ManyAndReturnOperation.ts` |
| `update` | ✅ unique-`where` enforced | `mutation.ts:126-155` |
| `updateMany` | ✅ incl. `limit` (W4-U2). Scalar-only `data` keeps one set-based `UPDATE` and the provider's affected-row `count`. Relation-bearing data captures the matching complete root keys once and runs ordinary selected updates in key order, reporting the captured count. Interactive drivers use one transaction; any no-transaction driver with native atomic batch uses committed segments. A named child-held target cannot be moved to more than one captured root. | `mutation.ts` `getUpdateManyArgs`; `operations/bulk-limit.ts`; `write-engine/UpdateManyRecordSeries.ts` |
| ~~`updateManyAndReturn`~~ | **REMOVED as a name** (W3-B, decision D-1): `updateMany` with a `select`. Same scalar-only projection as `createMany`; `limit` caps this arm too. Relation-bearing series fetch final rows with K bind-budgeted set reads, normally one, and restore captured order. A missing final key still fails rather than shortening the result; the `{ count }` arm can succeed. `deleteMany` with a `select` is the same public shape, past Prisma, which has no returning `deleteMany`. | `mutation.ts` `getUpdateManyArgs` / `getDeleteManyArgs`; `args/bulk-write-projection.ts`; `write-engine/series-result-read.ts` |
| `upsert` | ✅ **+ superset** (`targetWhere`/`setWhere`) | `mutation.ts:309-346`; probe-first, not `ON CONFLICT` ([UpsertOperation.ts:79](../../src/query-engine/write-engine/UpsertOperation.ts:79)) |
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
| `not` nesting | ✅ **CLOSED by W1-U1** (`94e0bb0`) — `not` is lazily self-referential per scalar filter, so it nests at ANY depth, matching the builder that always recursed. (Was: validation allowed one level.) The JSON-Schema converter learned the resulting cycle in `b2f8f79` | `scalars/negatable-filter.ts`; `where-builder.ts` `buildFilterOperation` |
| `contains`/`startsWith`/`endsWith` | ✅ **safer than Prisma** — compiled to `POSITION`/`LEFT`/`RIGHT`/`LOCATE`/`instr`, so `%`/`_` are literal | `where-builder.ts:451-470` |
| `mode: 'insensitive'` | ✅➕ works on **PG, MySQL and SQLite** (Prisma: PG/Mongo only) — ↔️ folds **ASCII A–Z only**, so it diverges from `ILIKE` on accented text | `where-builder.ts:325-345` |
| `search` / `_relevance` | ❌ | zero hits in `src/`; declared non-goal |
| `AND` / `OR` / `NOT` (obj or array) | ✅ incl. Prisma's per-item NOT semantics | `core/where.ts:57-65`; `where-builder.ts:156-231` |
| Empty `OR: []` → FALSE | ✅ | `where-builder.ts:199` |
| Null handling (bare, `{equals:null}`, `{not:null}`, NULL-excluding negation) | ✅ | `where-builder.ts:350-372` |
| List filters `has`/`hasEvery`/`hasSome`/`isEmpty`/`equals`/`not` | ✅➕ on **all three dialects** (Prisma: PG/Cockroach/Mongo only) | `scalars/string.ts:88-105`; all three adapters |
| Relation `some`/`every`/`none` (incl. M2M) | ✅ | `relations/filter.ts:66-82` |
| Relation `is`/`isNot`, `relation: null` | ✅ | `filter.ts:15-57` |
| To-one **shorthand** `{ author: { name: "x" } }` without `is` | ✅ **CLOSED by W1-U5** (`a6ae6b4`) — Prisma's own disambiguation: keys ⊆ `{is, isNot}` is the explicit form, anything else desugars to `{ is: … }`; `author: null` unchanged. ↔️ a target model owning a field literally named `is`/`isNot` is reachable only through the explicit form — the same collision Prisma has, resolved the same way | `relations/filter.ts` `toOneFilterFactory` (rule stated at `:13-30`) |
| Relation filters in `updateMany`/`deleteMany` | ✅ incl. MySQL error-1093 derived-table workaround | `relation-filter-builder.ts:395-411` |
| JSON `path`/`equals`/`not`/`string_*`/`array_*` | ✅ all three dialects | `scalars/json.ts:38-54`; `json-filter-builder.ts:83-150` |
| JSON `path` grammar | ↔️ **string form CLOSED by W2-U4** (`126eb77`) — Prisma-MySQL's `'$.a.b'` / `'$.arr[0]'` is parsed into the array form and produces identical SQL. The accepted grammar is exactly `'$'`, `'$.key'`, `'$.key[0]'`: quoted labels (`'$."a b"'`) and wildcards are refused with a message naming the array form. Segments with `"` or `\` are **still** rejected pre-SQL on every dialect | `json-filter-builder.ts:54-64` |
| JSON `lt/lte/gt/gte`, JSON `mode` | ✅ **CLOSED by W2-U1** (`494362a`) **and W2-U2** (`724b6eb`) — one portable comparison contract on all three dialects; the operand's class picks numeric vs lexicographic comparison, and a mixed-type row neither matches nor errors. `mode: "insensitive"` applies the same ASCII A–Z fold as the scalar path to the extracted text | `scalars/json.ts:10-11,52-59`; `json-filter-builder.ts` |
| **Field-to-field comparison (`FieldRef`)** | ✅ **W2-B**, surface reshaped by **W8-A** (D-7/D-8) — the operand callback `{ views: { gt: (ctx) => ctx.fields.likes } }` in `equals`/`not`/`lt`/`lte`/`gt`/`gte`, incl. nested relation wheres (where `ctx` is the TARGET model) and `updateMany`/`deleteMany`; string `contains`/`startsWith`/`endsWith` keep the token operand (no callback, no fragment); `mode: "insensitive"` folds both sides. Excluded from `having`/`groupBy` (Prisma parity), `in`/`notIn`, list ops, JSON (filter **and** write data), blob/vector/point. `client.$fields` is **removed** — the token machinery is `ctx.fields`' internals and a stored token is still a valid operand | `src/schema/field-ref.ts`; `validation/primitives/operand.ts`; `validation/scalars/json.ts` (`noFieldRef`); `where-builder.ts` `fieldRefColumn` |
| **SQL fragment as a filter operand** | ✅ **W8-A** — `{ views: { gt: (ctx) => ctx.sql`"likes" * ${2}` } }` splices the fragment PARENTHESIZED into the comparison with its interpolations bound; same operator set as the reference above. Escape hatch: the fragment's text is the caller's dialect responsibility (`$queryRaw`'s trust model) and is outside the portability promise. Refused wherever a reference is, `having` included | `validation/primitives/operand.ts` `comparisonOperand`; `where-builder.ts` `fragmentOperand` |
| DateTime/Date/Time/BigInt/Decimal/Boolean/Enum filters | ✅ | `src/validation/scalars/*` |
| Bytes (blob) filters | ✅ **CLOSED by W1-U2** (`f64a315`) — `in`/`notIn` shipped with `BytesFilter` parity, incl. empty `in: []` → FALSE; pinned live on pg, pglite, postgres.js, mysql2, sqlite3 and libsql (`tests/drivers/blob-filter-behavior.ts`) | `scalars/blob.ts` `buildBlobFilterSchema`; `scalar-filter-operators.ts` |
| Compound unique in `findUnique` | ✅ | `core/where.ts:98-121` |
| **Extended whereUnique** | ✅ **W4-U1**, widened by **N6-U2** — discriminator + non-unique filters (scalar **and relation**, the relation half added by N6-U2) + `AND`/`OR`/`NOT` on top-level `findUnique`/`findUniqueOrThrow`/`update`/`delete`/`upsert`. Only the LINK selectors stay strict: `connect`/`disconnect`/`set`/`connectOrCreate.where` and `cursor` | `core/where.ts` `getWhereUniqueExtendedSchema`; `where-unique-builder.ts` `partitionWhereUnique` |
| **Extended whereUnique in NESTED target selectors** | ⬆️ **SUPERSET — N6-U1 (D-N1)**. Nested `update` / `upsert` / `delete` targets take `{ <unique>, ...filters }` — including RELATION filters, once N6-U2 merged into this schema; **Prisma's nested selectors are unique-only in these three positions**. The filter half joins the locate and every batch guard; the discriminator alone still feeds the located PK, identity and `racePin` (withheld under an extended selector, as at the root). At depth the filter needs no `mutationTable` composition: a nested targeted write addresses the row by the key its probe captured, so the filter only ever rides an aliased SELECT | `relations/update.ts`; `query-engine-v2/shared.ts` `uniqueSelectorConjuncts`; `fragment-builders.ts` `childRacePin`; witnesses in `depth-seam-behavior.ts` (N6-U1 block) and `extended-where-unique-behavior.ts` §8 (the merge surface), compile-pinned in `unique-where-relation-filter-plan.test.ts` |
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
| `omit` (query-level + client config) | ✅ (W5-U4) — on every returning operation and on nested relation nodes; query-level `omit` subtracts from `select`; an `omit` that empties the projection is refused; on a bulk write either projection key selects the row-returning arm | `validation/model/args/omit.ts`; `client/omit.ts` |
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
| `orderBy` nested to-one relation field | 🟡 **cap raised 3 → 8 by W1-U7** (`391b634`, decision D-5) — raised, not removed: unbounded needs lazy self-reference in the orderBy schema, deferred until a user asks. To-many mid-chain still rejected. The cap is mirrored in two files by design, each naming the other | `relations/order-by.ts` + `relation-orderby-builder.ts:42` (`MAX_RELATION_ORDER_DEPTH`) |
| `orderBy` relation `_count` | ✅ (only `_count` — no `_sum`/`_avg` relation ordering) | `relations/order-by.ts:235-241` |
| `orderBy` aggregate in groupBy | ✅ | `aggregate.ts:341-369` |
| `orderBy: { sort, nulls }` | ✅ native on PG, emulated via `(col IS NULL)` on MySQL/SQLite | `sort-order-builder.ts:72-89` |
| To-many scalar-field `orderBy` | ❌ deliberately rejected (Prisma doesn't support it either) | — |
| `relationLoadStrategy` | ❌ as public API; internally auto-selected LATERAL (PG, MySQL 8.0.14+) vs correlated subquery (SQLite) — always **one round trip** | `select-builder.ts:163-185` |

## 1.5 Writes and nested writes

| Feature | Under `create` | Under `update` | Notes |
|---|---|---|---|
| `create` (single + array) | ✅ all cardinalities | ✅ all cardinalities — parent-held to-one, **inverse to-one (N2-U1)**, and to-many on any spelling of the unique `where` (**N1-U1** removed the pinning gate; the referenced column rides the located-parent Ref) | an occupied inverse-to-one slot errors on the 1:1 FK's UNIQUE constraint, matching Prisma |
| `createMany` (+`skipDuplicates`) | ✅ to-many, **✅ M2M since N3-U1** | ✅ to-many, any `where` spelling (N1-U1); **✅ M2M since N3-U1**. Not offered on a to-one — **Prisma parity**, measured: `createMany` is absent from Prisma 7.9.1's to-one nested-update input too | Rows may carry nested relations. Scalar-only rows remain grouped; relation-bearing rows use ordered fresh-record subtrees. On interactive series, a skipped member suppresses its complete subtree. The legacy scalar M2M grouped path keeps its join semantics. |
| `connect` | ✅ | ✅ | fails if target missing |
| `connectOrCreate` | ✅ | ✅ — ↔️ **global** lookup-and-adopt (reparents), not parent-correlated | `UpdateOperation.ts:1434` |
| `update` | — | ✅ to-one takes bare data **or** Prisma 5's `{where?,data}` (W4-U3; `where` is a NON-unique filter on the connected record, filter-miss → P2025-equivalent, whole tree rolls back). ⚠️ on a target owning a field named `data` the two spellings collide and viborm **refuses** the shape (Prisma picks one silently) — spell the envelope out, `{where:{},data:{…}}`. To-many `{where,data}` ✅ | `update.ts:45-79`, `to-one-update-form.ts` |
| `updateMany` | — | ✅➕ `where` is **optional** (Prisma requires it), and `data` may carry relations | Scalar-only data remains set-oriented; relation-bearing data captures exact correlated targets and reuses the selected-record compiler |
| `upsert` | ➕ **child-held to-many only, viborm superset**, global-adopt-and-update, **executable today**. ⚠️ the same key on a **many-to-many** relation under `create` is refused (`CreateOperation.ts:1648`) — the schema offers it on both, and the audit found this the one kind that actually reaches that site, with no recorded reason covering it | ✅ to-one `{create,update}`, to-many `{where,create,update}`, m2m ✅ | `create.ts:182-201`; proven in `create-nested-upsert-behavior.ts:123`. `compatibility.mdx:66` saying "the current engine rejects it" is **stale**. The m2m asymmetry is item 3 of the floor audit |
| `delete` | — | 🟡 boolean (to-one), whereUnique single+array (to-many). **Narrower than Prisma on the to-one**: Prisma 7.9.1 takes `WhereInput \| boolean`, viborm only the boolean (N2-U3 — see §3.B). ✅ the literal `delete: false` is now the **no-op** Prisma's boolean arm makes it (N7-U-B, measured against a live Prisma 7.9.1; the three refusal sites are gone) | ↔️ inverse-side `delete: true` with no related row is a **no-op**; Prisma throws P2025 |
| `deleteMany` | — | ✅ to-many. Not offered on a to-one — **Prisma parity**, measured against Prisma 7.9.1's to-one nested-update input (N2-U2) | `update.ts:172` |
| `set` | — | ✅ to-many, with orphan guard. To-one: Prisma parity, absent there too | `RelationWritePart.ts:910-947` |
| `disconnect` | — | 🟡 boolean on optional to-one; whereUnique on to-many. **Narrower than Prisma on the to-one**: Prisma 7.9.1 takes `WhereInput \| boolean`, viborm only the boolean (N2-U3 — see §3.B). ✅ `disconnect: false` is now a **no-op**, matching Prisma (N7-U-B). It had been worse than an error at two paths: the parent-held arm and the depth arm DISCONNECTED on `false` | `update.ts:49,251-253` |
| Required-relation orphaning | ✅ throws, Prisma-equivalent — **plus stricter typing**: on a required to-one the `disconnect`/`delete` keys aren't in the schema at all | `RelationProgramValues.ts:181-188` |
| Atomic `set`/`increment`/`decrement`/`multiply`/`divide` | ✅ Int, Float, BigInt, Decimal | `set-builder.ts:106-134` |
| Atomic arithmetic **on a primary key** | ➕ with a portability gate (one op per PK; float/decimal arithmetic and `divide: 0` rejected) | `mutation-identity.ts:190-236` |
| Scalar-list `push`/`set` | ✅➕ also `unshift`, and on **all dialects** (Prisma: PG only) | `scalars/string.ts:127,142` |
| Json field update | ✅ `set` shorthand + `DbNull`/`JsonNull` sentinels (W4-U4); ↔️ a bare top-level `null` is **refused** in write position, as Prisma's `InputJsonValue` documents | `scalars/json.ts`, `primitives/json-null.ts` |
| Json null filtering | ✅ `equals`/`not` take `DbNull`/`JsonNull`/`AnyNull`, same truth table on all 3 dialects; ↔️ a sentinel under a `path` is refused (use `path` + `equals: null`) | `json-filter-builder.ts` |
| Nesting depth | ➕ **no engine limit**; only ceiling is TS literal inference (~31 rich levels) | `x1-depth-stress.test.ts`; `x1b-ts-ceiling.test.ts:139` |
| Write-race retry | ➕ whole operation retried **exactly once** on a racePin-matched unique violation; fail-closed on missing attribution | `race-retry.ts:27-113` |
| Implicit transaction around multi-statement writes | ✅ **stricter than Prisma** — a driver with neither transactions nor atomic batch is *rejected* | `OperationExecutor.ts:98-140` |

**How every targeted nested row above names its target — ⬆️ SUPERSET since N6-U1/N6-U2.** The `update` / `upsert` / `delete` rows take `{ <unique>, ...filters }`, scalar filters and relation filters alike, where Prisma's nested selectors are unique-only; the discriminator keeps its monopoly on the located PK, identity and `racePin`. The row is stated once, with its seams and witnesses, in §1.3 ("Extended whereUnique in NESTED target selectors") — the write rows point at it rather than restating it. `connect` / `disconnect` / `set` / `connectOrCreate.where` stay strict: they name a row to link, not one to locate and mutate.

**Own-write preflight (viborm-specific).** Any nested decision read whose footprint overlaps an *earlier write in the same tree* is rejected before I/O — for example `{ posts: { delete: [{ id: 1 }], update: [{ where: { id: 1 }, data: {…} }] } }` → `Nested operation 'update' on relation 'posts' depends on an earlier 'delete' target write in the same nested write. Split these operations into separate queries.` ([OwnWriteLedger.ts:247](../../src/query-engine/OwnWriteLedger.ts:247)).

**N6-U3 DELIVERED (2026-07-30) — the obligation this row carried is discharged.** Two corrections to what stood here.

1. *The example was wrong.* `{ posts: { create: {…}, connect: {…} } }` — the payload this row printed, and the one the plan called A14's headline — does **not** reject and never did, on a to-many or a many-to-many, whether or not the two kinds name the same row. It executes; both rows land. Measured before anything was changed. The illustration above is a shape that genuinely produces the message.
2. *The doctrine was not what the refusal rested on.* Sibling kinds on one relation now linearize in ONE fixed, documented order (ATOM §4.1), used by both the emission and the legality derivation. Before the amendment there were **two** orders — `RELATION_MUTATION_KEYS` for emission, `planRelationMutationSteps`' own if-chain for derivation — disagreeing on `deleteMany` vs `upsert`, so a shape's soundness was checked against a sequence the engine never executed. Deleting the second order, not weakening the check, is what moved the surface: over all 55 sibling pairs × {to-many, m2m} × {disjoint, same identity} plus the create root, **92 rejections became 41**. What survives is a payload contradiction (two kinds naming one row) or a many-to-many `deleteMany` whose filter cannot be bounded — both re-justified, neither inherited.

**Versus Prisma, measured (7.9.1, pg adapter, query log per shape):** Prisma has no order at all — it executes sibling kinds in the enumeration order of the JS object literal, so `{ create, deleteMany }` deletes the row it just created while `{ deleteMany, create }` keeps it. That is [prisma/prisma#16606](https://github.com/prisma/prisma/issues/16606), open and labelled `bug/2-confirmed`. viborm's order is fixed and independent of how the caller spelled the object. Prisma also does not offer `createMany` on an implicit many-to-many; viborm does (N3-U1).

## 1.6 Transactions

| Feature | Status | Evidence |
|---|---|---|
| Sequential `$transaction([...])` | ✅ operations are lazy `PromiseLike` | `client.ts:171-179,398-436` |
| Interactive `$transaction(async tx => …)` + rollback | ✅ | `client.ts:640-741` |
| Isolation levels | ✅ **CLOSED by W5-U3** — all four levels on the PG and MySQL families, `Serializable` honored by construction on SQLite, the weaker three refused there; D1 / Neon HTTP refuse outright | [transaction-options.ts](../../src/drivers/shared/transaction-options.ts); per-driver cells in `tests/drivers/transaction-portability.test.ts` |
| `maxWait` / `timeout` | ✅ **CLOSED by W5-U3** — `timeout` honored on every transaction-capable driver (expiry drains, rolls back, `V5002`); `maxWait` honored where the acquisition can be bounded and abandoned, refused with a reason where it cannot | same module; behavior pinned in `tests/drivers/transaction-options-behavior.test.ts` |
| Nested transactions / savepoints | ➕ Prisma has no nested `$transaction` | `driver.ts:450-462`; `savepoint-queue.ts` |
| Raw SQL inside a tx | ✅ **CLOSED by W5-U1** — `tx.$queryRaw` / `tx.$executeRaw` and both Unsafe variants ride the transaction-bound driver, so they share its connection and roll back with it | `client/raw.ts`; tx proxy in `client.ts` |

**Per-driver:** interactive + batch on pg, postgres.js, pglite, bun-sql, mysql2, planetscale (single-shard), sqlite3, libsql, bun-sqlite. **Batch-only (interactive throws):** neon-http, d1. `d1-http` is **not implemented** despite `AGENTS.md:184` listing it.

## 1.7 Raw SQL

| Feature | Status | Evidence |
|---|---|---|
| `$queryRaw` tagged template | ✅ **CLOSED by W5-U1** — tagged; every interpolation binds, rendered per dialect by `toStatement`. Returns `T[]`. The pre-1.0 `(sql: string, params?)` form survives one release behind a `warning`-channel deprecation notice | `client/raw.ts` |
| `$executeRaw` | ✅ **CLOSED by W5-U1** — tagged (a prebuilt `Sql` is still accepted), returns the affected count as `number`, no row type parameter. **Breaking**: it used to answer `QueryResult<T>` | `client/raw.ts` |
| `$queryRawUnsafe` / `$executeRawUnsafe` | ✅ **CLOSED by W5-U1** — Prisma's exact `(sql, ...params)` signatures. `$queryRawTyped` still does not exist (it is generated-client machinery viborm has no analogue for) | `client/raw.ts` |
| `Prisma.sql` / `join` / `empty` / `raw` | ✅ **CLOSED by W5-U1** — exported from the package root and from a `viborm/sql` subpath, alongside `Sql` and `isSql` | `src/index.ts`, `package.json` exports, `tsdown.config.ts` |
| Helper signature deltas | ✅ **CLOSED by W5-U1** — `join` takes `RawValue[]` (plain values bind, nested fragments splice), and `raw` gained Prisma's `raw(string)` splice alongside the tagged form the adapters use | `sql.ts` |
| `Sql.toStatement("$n"|":n"|"?")` dialect renderer | ➕ | `sql.ts:99` |
| Raw fails closed during an open tx on single-connection drivers | ➕ | `driver-transaction-base.ts:44-59` |

## 1.8 Client-level

| Feature | Status | Evidence |
|---|---|---|
| Middleware `$use` | ❌ | closed dispatch |
| `$extends` | ❌ | `types.ts:178-182` |
| `$on` events / `log: ['query']` | 🟡 different: constructor-config **callbacks**, levels `query\|cache\|warning\|error`; no emitter, no `target`, no `info`; sql/params stripped by default | `instrumentation/types.ts:13,18-39` |
| `$connect` / `$disconnect` | ✅ | `client.ts:180-182,744-764` |
| Error taxonomy | 🟡➕ **partly CLOSED by W5-U2** — every error keeps its `V####` `code`, and the ones with a Prisma counterpart now also publish `prismaCode` (`P####`). Partial by design: the families Prisma has no code for report `undefined` rather than inventing one | `errors/base.ts`; table below |
| `datasources`/`datasourceUrl` | ↔️ connection lives on the driver | — |
| `adapter` (driver adapters) | ✅ mandatory; 11 first-party drivers | `client.ts:122` |
| `errorFormat` | ❌ (nearest: `diagnostics.{includeSql,includeParams}` — controls *disclosure*, not formatting) | `errors/diagnostics.ts:31-34` |
| `transactionOptions` | 🟡 **per-call only (W5-U3)** — `$transaction(fn, { isolationLevel, timeout, maxWait })` is accepted per call; there is still no client-construction `transactionOptions` default | §1.6 |
| Global `omit` config | ✅ (W5-U4) — `createClient({ omit: { user: { passwordHash: true } } })`, applied as an args rewrite; a query overrides per field with `false` or wholesale with `select`; never flips a bulk write's return shape | `client/omit.ts` |
| Preview features / flags | ❌ by design | — |
| OpenTelemetry tracing | ✅➕ **GA, not preview**; no separate instrumentation package; optional peer dep with no-op fallback | `instrumentation/tracer.ts:393` |
| Query caching | ➕ built-in, pluggable, no Accelerate service | `cache/schema.ts:61-116` |
| `$metrics` | ❌ | internal `PerfTracker` not in the published entrypoint |

**Error mapping (viborm → Prisma):** `UniqueConstraintError V3001`→P2002 · `ForeignKeyError V3002`→P2003 · `NotNullConstraintError V3003`→P2011 · `CheckConstraintError V3004`≈P2004 · `NotFoundError V6001`→P2025 · `ValueTooLongError V3005`→P2000 (W5-U2) · `ConnectionError V1001/V1002/V1003`→P1001/P1002/P1017 · `ClientInitializationError V1004`→P1012 (W5-U2) · `ValidationError V4001`→PrismaClientValidationError · `QueryError V2001`≈PrismaClientUnknownRequestError · `QueryEngineError V9001`≈RustPanic. Normalization is real and multi-dialect (PG SQLSTATE, MySQL errno + `ER_*`, SQLite `SQLITE_CONSTRAINT_*`, PlanetScale errno-in-message, D1 suffix stripping — [error-mapping.ts:23-226](../../src/drivers/error-mapping.ts:23)).
**Closed by W5-U2:** P2000 is `ValueTooLongError` (V3005), mapped from PG `22001` and MySQL `1406`/`ER_DATA_TOO_LONG`; client-construction failures are `ClientInitializationError` (V1004). **Documented absence:** no SQLite P2000 — SQLite does not enforce declared column lengths, so there is no error to map (quaint agrees; `SQLITE_TOOBIG` is the ~1 GB size cap, a different failure, and stays a generic `QueryError`). **Still missing:** P2034 on the transaction family — no member is 1:1, since V5xxx also carries `SQLITE_BUSY` and timeouts; use `isRetryable()`.
**viborm-only:** `TransactionError`, `NestedWriteError` (V7001-6), `FeatureNotSupportedError` (V8001), `PendingOperationError` (V12001-4), cache errors (V10001-4), `isRetryableError()`, and a SQL/param redaction layer.

## 1.9 Schema and types

| Prisma | viborm | Status |
|---|---|---|
| String, Int, BigInt, Float, Boolean, DateTime, Json, Bytes | `s.string/int/bigInt/number/boolean/dateTime/json/blob` | ✅ |
| **Decimal** | `s.decimal()` | ✅ **exact, string-backed** (W6-U1). Reads a canonical decimal `string`; writes accept `string \| number`. Prisma returns a `decimal.js` instance that serializes to a string — viborm returns the string itself and skips the dependency |
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
| `@ignore` / `@@ignore` | `.omit({field:true})` | 🟡 **different semantic** — a SCHEMA-level projection exclusion (since W5-U4: hard, unnameable in `select`/`omit`), not "invisible to client but present in DB": the column is still writable and filterable. No DB-only-field marker |
| `@@index` | `.index(fields, {name, unique, type, where})` | ✅➕ adds `unique`, `btree\|hash\|gin\|gist\|fulltext\|spatial` (refused by name on the dialects that lack each), PG/SQLite partial-index `where`. ❌ **field NAMES only** — an EXPRESSION index (`lower(email)`) cannot be declared, which closes the only index escape for `mode: "insensitive"` predicates; see plan §10.5 |
| `@@fulltext` | `.index(fields, { type: "fulltext" })` | ✅ **CLOSED by plan §10.6** (MySQL only — the emitter, introspection and capability list already had it; only the schema-level `IndexType` union was short) |
| — | ANN vector index (`ivfflat`, `hnsw`) | ❌ **not declarable while vector `orderBy` ships** — so every vector similarity query is a full scan. Needs a metric-matched operator class and build parameters `IndexOptions` has no shape for; see plan §10.5 |
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
| `migrate resolve` | — | ❌ no equivalent in either direction. The old `migrate drop` ≈ `--rolled-back` was **deleted in B4**: it removed tracking rows while leaving the schema live, which bypasses a migration's persisted `manual`/`irreversible` rollback policy |
| `migrate status` | `migrate status` | 🟡 tracking table stores only `name/checksum/applied_at` — no failed-migration state, no drift report |
| `db push` | `viborm push` | ✅➕ `--force-reset`, `--strict`, `--verbose`, `--dry-run`, interactive resolver. ⚠️ `--accept-data-loss` is spelled `--force`. **See defect 2** |
| `db pull` / introspection | full introspectors for PG/MySQL/SQLite | 🟡 **internal only** — return a `SchemaSnapshot`, no TS emitter, no CLI command |
| `db seed` | — | ❌ |
| `studio` | — | ❌ |
| `generate` | — | n/a by design (zero codegen) |
| `validate` | implicit inside every CLI command | 🟡 no standalone command |
| Shadow DB | — | ❌ (snapshot-based instead) |
| `migration_lock.toml` | journal v3 `target` (the estate) + the one admission gate | ✅➕ stronger. The journal's top-level `dialect` and the two ad-hoc dialect checks (`validateJournalDialect` plus the hidden one in `getOrCreateJournal`) are **gone**; version 3 stores a `MigrationTarget` and there is no legacy reader for version 2. A PostgreSQL estate binds its exact schema, a MySQL estate stays database-relative and portable, and `MIGRATION_DIALECT_MISMATCH` is now actually raised on a mismatch instead of a plain `Error`. A cross-estate attempt is refused after at most lock acquisition/release and the authoritative journal read — before snapshot/artifact reads, tracking, DDL, other provider work, or any storage write |
| `_prisma_migrations` | `_viborm_migrations`, ➕ configurable via `--table-name` | ✅ |
| Concurrency lock | PG advisory lock on a RESERVED session; MySQL database-scoped `GET_LOCK` on a RESERVED connection; **SQLite/LibSQL reserve nothing → no lock** | 🟡 `apply()`, `down()`, `reset()`, `squash()` and effectful `push()` all run inside `withLockedSession`, which reserves ONE physical producer and runs the acquisition, every authoritative read, every statement and the release on it; both the acquisition and the release are PROVEN from the provider's own answer, and an unproven one destroys that session instead of returning it to a pool holding a lock nobody owns. `down()`/`squash()` additionally reread journal, applied state and every artifact INSIDE the lock and recompute their decision there, and `apply()` rereads authoritative state before each of its per-entry commits. Still 🟡 for one reason: SQLite/libSQL take no lock at all, so on those substrates the in-lock recomputation is the only defence |
| Providers | postgresql, mysql, sqlite3, libsql | 🟡 no SQL Server / MongoDB / CockroachDB. **D1 has no migration driver** (falls through to sqlite3, untested) and `migrate apply` **cannot work on D1 or neon-http** — `apply()` requires `withTransaction`, which both throw |

**DDL differ covers:** create/drop table, add/drop/alter column, indexes (incl. PG partial), unique constraints, primary keys, foreign keys with forward-reference ordering, enum create/drop/alter with value-removal data remapping.
**Not supported:** automatic rename detection, data migrations / custom SQL steps, views, triggers, sequences, extensions, partitions, RLS, CHECK constraints, comments, collations, column reordering, multi-schema.

➕ **viborm-only tooling:** down migrations with lossy-operation warnings and a per-migration persisted rollback policy (`automatic`/`manual`/`irreversible`, refused pre-effect group-wide), caller-owned `manualMigration` artifacts for data-bearing transitions, `squash` with backup archive (S3/DB/edge-capable), programmatic `createMigrationClient()` with storage-less push for Workers, per-change resolve callbacks (`proceed/reject/rename/addAndDrop/mapValues/useNull`), `push --strict`.

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
| **Extended `whereUnique` in nested `update`/`upsert`/`delete` target selectors** (N6-U1), including **relation filters inside a unique `where`** at the root and at depth (N6-U2) — Prisma is unique-only in the nested positions and refuses relation filters in a unique `where` everywhere | §1.3 row; `shared.ts` `uniqueSelectorConjuncts`; `depth-seam-behavior.ts`, `extended-where-unique-behavior.ts`, `unique-where-relation-filter-plan.test.ts` |
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

There is no separate driver-capability object. The driver base directly owns
`supportsTransactions`, `supportsBatch`, `supportsOrderedCommittedSegments`,
and `maxBindParametersPerStatement`. D1 is currently the only built-in driver
that proves ordered committed segments. The parameter budget is a conservative
provider fact used to chunk grouped series-result reads. `supportsReturning`
still lives on the adapter, not the driver.

**Neon HTTP keeps `supportsOrderedCommittedSegments: false`, for a recorded reason.**
That flag is now an attribution-strength claim, not general RecordSeries eligibility.
Neon has the execution substrate (no interactive transaction, a native atomic batch),
so safe series reach its awaited batch route. Enabling the stronger flag would still
require live proof of batch atomicity and order, intra-batch visibility, a later request
observing the commit, no effects from a failed batch, exact RETURNING normalization,
a stable failing-statement index, exact race classification, and diagnostics at the
acknowledged commit. The local prerequisite is wired and tested:
`executeBatch` awaits commit acknowledgement immediately after
`client.transaction(...)` resolves and before cardinality or result parsing. The fake
client proves that code order, including post-commit malformed results and no callback
on provider rejection; it does not prove a hosted commit. **Hosted facts remain
unmeasured:** this environment has no Neon credentials, `NEON_TEST_DATABASE_URL` is
unset, the hosted suite skips, and durability, visibility, normalization, and exact
error attribution remain unproven. The stronger capability therefore stays false. The
same credential-free suite pins that a safe root series reaches and awaits
`_executeBatch`; it makes no hosted durability claim.

`BatchOptions.atomic` (`src/drivers/types.ts:72-75`) is **dead code** — nothing reads it. (The second half of this claim, "every transaction entry point calls `assertNoTransactionOptions`", was retired by W5-U3; the entry points now resolve a `TransactionOptions` plan. `BatchOptions.atomic` is still unread.)

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
| `supportsCteWithMutations` | true | false | **false** (was `true`, and wrong) | yes — the Phase 8 folds |
| `supportsFullOuterJoin` | true | false | false | **no — dead flag** |
| `supportsUpsertWhere` | true | false | true | **no — dead flag** |

Placeholder style is **dialect-derived, never driver-derived**: `$n` for postgres, `?` for mysql/sqlite. No driver overrides it.

## 2.2 Execution substrate

| Feature | postgres family | mysql family | sqlite family |
|---|---|---|---|
| Interactive `$transaction(cb)` | ✅ except ❌ `neon-http` | ✅ | ✅ except ❌ `d1` |
| Batch `$transaction([...])` | ✅ | ✅ | ✅ |
| Root relation-bearing record series | ✅ one transaction; `neon-http` uses native atomic batch segments after normalized awaited success | ✅ one transaction | ✅ one transaction; D1 uses ordered committed atomic segments and reports exact callback-acknowledged progress |
| Nested relation-bearing record series | ✅ in the enclosing transaction; `neon-http` uses exactly guarded atomic segments | ✅ in the enclosing transaction | ✅; D1 uses exactly guarded committed segments. An unguardable placement refuses before the containing member writes and earlier progressive roots can already be committed |
| Savepoints / nested tx | ⚠️ **hand-rolled, uniform** `SAVEPOINT sp_<uuid>` emitted as literal SQL for every dialect ([transactions.ts:227-253](../../src/drivers/shared/transactions.ts:227)) — deliberately bypasses postgres.js `sql.savepoint` and Bun SQL `savepoint`. Unavailable on `d1`/`neon-http` |
| Isolation levels | ✅ **CLOSED by W5-U3** — `SET TRANSACTION ISOLATION LEVEL` after `BEGIN` on the PostgreSQL family, before `BEGIN` on the MySQL family; `Serializable` honored by construction on SQLite-family drivers with the weaker three refused; batch-only drivers (`d1`, `neon-http`) refuse all four. Per-driver table in [transactions.mdx](../content/docs/client/transactions.mdx) |
| Concurrency | 🟡 pooled (`pg`, `postgres`, `bun-sql`); serialized (`pglite`) | 🟡 pooled | 🟡 **serialized** (`sqlite3`, `bun-sqlite`, in-memory `libsql`) |

**The `requiresAtomicResolution` refusal — real code, currently unreachable in production.**
[routing.ts:107-126](../../src/query-engine/write-engine/routing.ts:107) refuses `update`/`delete`/`upsert` when `supportsBatch && !supportsTransactions && !supportsReturning`. The only non-returning adapter is MySQL, and no shipped MySQL driver is batch-only; the only batch-only drivers (`d1`, `neon-http`) both support RETURNING. So **no shipped driver combination can hit this refusal.** It is exercised only by an artificial test subclass (`tests/drivers/batch-forced-mysql2.ts:11`) inside the docker-gated MySQL suite — a test that does not run by default.

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

**Row-name note (W3-U4, `c9de15f`).** The three `*AndReturn` rows above name **internal** operation tokens, not client methods: `createManyAndReturn`/`updateManyAndReturn` were deleted from the client surface, and the row-returning arm is now reached by putting a `select` on `createMany`/`updateMany`/`deleteMany`. The dialect behavior each row describes is unchanged.

**MySQL's cost is structural, not cosmetic.** Every single-row write is 2–3 statements instead of 1, and the re-read is a separate statement inside the transaction. `libsql` has its own quirk in the other direction: it reports `rowsAffected: 0` for RETURNING mutations, so the driver prefers `rows.length`.

## 2.4 Types

| Type | postgres | mysql | sqlite | Verdict |
|---|---|---|---|---|
| **JSON** | `jsonb`, `#>`/`#>>`/`@>` | `JSON`, `JSON_EXTRACT`/`JSON_CONTAINS` | `JSON`(TEXT), chained `->`, `json_each` for `@>` | 🟡 identical operator set, three SQL shapes |
| **Scalar lists / arrays** | ✅ native `type[]` | ⚠️ **JSON emulation** | ⚠️ **JSON emulation** (string-surgery concat for push/unshift) | ⚠️ never refused. Prisma refuses lists on MySQL/SQLite; viborm emulates |
| **Enum** | native `CREATE TYPE` | inline `ENUM('a','b')` | ⚠️ `TEXT CHECK(col IN (…))` | 🟡 three storage strategies, identical query surface |
| **Decimal** | `numeric` | `DECIMAL(65,30)` | **`TEXT`** (W6-U1: was `REAL`) | ✅ **exact everywhere** — decodes to a canonical `string`, never a double. Comparison is server-side (`CAST(? AS NUMERIC)` / `CAST(? AS DECIMAL(65,30))` / canonical text equality). **SQLite refuses** ordered and derived decimal ops (`lt`/`lte`/`gt`/`gte`, `orderBy`, `_min`/`_max`/`_sum`/`_avg`, atomic arithmetic) rather than answer them at double precision — in **every spelling**, including paginated windows (`take`/`skip`/`cursor`/`findFirst`), relation and nested-read `orderBy`, `groupBy`'s `orderBy` and aggregate `having`, and a decimal PK/unique used as a pagination tie-breaker (`tests/query-engine/decimal-refusal-surface.test.ts` enumerates the surface and pins each spelling as answered on PGlite and refused on SQLite) |
| **BigInt** | `bigint` | `BIGINT` + `supportBigNumbers` | `INTEGER` + `safeIntegers(true)` / `intMode:"bigint"` | ✅ exact round-trip proven for `9007199254740993n` on sqlite3, libsql **and (since W6-U2) `bun-sqlite`**, which now opts in per statement like sqlite3 and is proven on a real Bun. `d1` still sets no int mode ❓ |
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
| `$queryRaw` (tagged) | 🟡 values portable, text is not | 🟡 | 🟡 | **W5-U1**: interpolations bind and are rendered in each driver's own placeholder style, so a *value* is portable. The SQL text you write is still yours to keep portable. `$queryRawUnsafe` is verbatim — you write `$1` or `?` yourself |

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
| `d1` | Workers provider contract | Provider-only | Native binding batch, ordered committed root series, cache invalidation, and partial-progress failures in `tests/providers/workers/d1.test.ts` |
| `planetscale` | — | — | ❓ **0 real queries** — ~39 mock tests |
| `neon-http` | — | — | ❓ **6 mentions total**, all capability-flag assertions |
| `bun-sql` | — | — | ❓ **1 test** that spawns `bun --eval` against `postgres://127.0.0.1:1` to assert `sql.close()` is thenable — skipped when `bun` isn't on PATH |
| `bun-sqlite` | 1 spawned probe + 5 unit | ✅ when `bun` is on PATH | 🟡 **1 real end-to-end run** (W6-U2) — `bun-sqlite-runtime.test.ts` spawns Bun on a probe that pushes a schema, creates, reads, reads through an `include`, and exercises both raw forms against a real in-memory `bun:sqlite`; skipped when `bun` is absent. Everything else is still `vi.fn()` fakes |

```
↓ tests/drivers/pg.test.ts       (303 tests | 303 skipped)
↓ tests/drivers/postgres.test.ts (145 tests | 145 skipped)
↓ tests/drivers/mysql2.test.ts   (474 tests | 474 skipped)
Test Files  3 skipped (3)   Tests  922 skipped (922)
```

**There is no CI.** `.github/` does not exist. There is no `docker-compose.yml`. The docker-gated suites depend on a human remembering `pnpm test:mysql` / `pnpm test:pg`.

Net: **~1,430 tests hit a real (embedded) database by default, across 3 drivers, none of them a networked server.** 922 more exist for the two most-used production drivers and never run. Four drivers have never executed a single query against their actual backend — `d1`, `planetscale`, `neon-http`, `bun-sql`. (It was five; W6-U2 moved `bun-sqlite` out with a spawned real-runtime probe, and found the driver could not even open a database.)

The stand-in for hosted batch drivers is `BatchOnlyPGliteDriver` / `BatchOnlySQLite3Driver` — a local driver with its capability flags flipped. That proves the *engine's* batch path; it proves nothing about D1's `batch()` semantics, Neon's HTTP transaction, or PlanetScale's Vitess behavior.

The repo is honest about this in its own docs (`tests/drivers/README.md:38`, `nested-write-provider-gaps.md:10-20`, `AGENTS.md:556`). **Nothing enforces those admissions.**

## 2.8.1 Polymorphic collections — measured per provider family (2026-08-19)

> **Later than this file's snapshot.** `s.polymorphicToMany` did not exist on
> 2026-07-25. This block is a fresh measurement, added when the cardinality
> program (`polymorphic-cardinality-plan.md`, Packages A–F) landed, and it obeys
> the same honesty rule as §2.8: **a cell with no executed run says NOT RUN.**
> Nothing here is inferred from a sibling dialect.

The shared behaviors are `tests/contracts/drivers/behaviors/`:
`polymorphic-collection-read-behavior.ts` (12 tests — envelope, `only`,
arm-local order/window/distinct, tagged quantifiers, total and filtered counts,
count ordering, orphan integrity, both inverse arities),
`polymorphic-collection-write-behavior.ts` (18 tests — all eleven direct verbs,
the guarded singular transfer, both inverse arities, and one write-then-read
crossover), and `polymorphic-member-junction-behavior.ts` (1 test — member-table
DDL, database-enforced singular/plural inverse, both cascade directions, and an
**empty second push**). Which provider suite mounts which is declared in
`tests/providers/matrix.ts` (`PROVIDER_RUNS`), so every cell below is a
registration fact plus an executed run, not a claim.

| Provider | Collection read | Collection write | Member junction DDL + 2nd push | Run |
|---|---|---|---|---|
| `pglite` | ✅ | ✅ | **NOT RUN** — contract not registered for this fixture | `--project=provider-pglite` → **839 passed / 1 skipped**, 318s |
| `sqlite3` | ✅ | ✅ | ✅ | `--project=provider-sqlite3` → **1209 tests / 1 skipped** |
| `libsql` | **NOT RUN** | **NOT RUN** | **NOT RUN** | `--project=provider-libsql` → **1125 tests / 1 skipped**; it registers `polymorphicRelationContract` (the to-one path) only |
| `pg` (docker) | ✅ | ✅ | ✅ | `PG_TEST_CONNECTION_STRING=… --project=provider-pg` → **922 passed / 7 skipped**, 43s |
| `postgres` (postgres.js, docker) | **NOT RUN** | **NOT RUN** | **NOT RUN** | registers no polymorphic contract at all; it delegates to the canonical PG fixture |
| `mysql2` (docker) | ✅ | ✅ | ✅ | `MYSQL_TEST_CONNECTION_STRING=… --project=provider-mysql2` → **1108 passed / 1 skipped**, 92s |
| `d1` | **NOT RUN** | **NOT RUN** | **NOT RUN** | `--project=provider-d1` fails at COLLECT time — `@paralleldrive/cuid2` generates a random value in global scope, which workerd forbids. **Pre-existing and unrelated to this feature**: zero tests execute, so nothing about D1 is measured either way |
| `neon-http` | **NOT RUN** | **NOT RUN** | **NOT RUN** | no credentials on this machine (`availability: "neon-credentials"`) |
| `planetscale` | **NOT RUN** | **NOT RUN** | **NOT RUN** | no credentials on this machine (`availability: "planetscale-credentials"`) |
| `bun-sql`, `bun-sqlite` | **NOT RUN** | **NOT RUN** | **NOT RUN** | platform runtime probes only; shared database contracts run on the canonical fixtures |

**What that buys, honestly.** Three dialect families execute the complete
collection surface against a real database: PostgreSQL (`pg`), MySQL (`mysql2`)
and SQLite (`sqlite3`), plus PGlite for the read/write halves. The member
junction's compound primary keys, dual FK groups, reverse indexes and singular
unique side are introspected back and found stable by an **empty second push** on
all three of those families — which is the check that would fail if the
serializer and the introspector disagreed on any spelling.

**What it does not buy.** libsql runs the to-one path only; postgres.js runs
neither. Both are SQLite-family and PostgreSQL-family respectively, so the
dialect SQL is exercised elsewhere, but the *driver* is not — and this file does
not let a sibling dialect stand in for a driver. D1, Neon, PlanetScale and Bun
remain unmeasured for this feature exactly as they are for the rest of §2.8.

**Specific dialect facts the runs pinned**, each from the member-junction
behavior rather than from reading code:

| Fact | postgres | mysql | sqlite |
|---|---|---|---|
| Member table quoting of camelCase owner row-key columns | `"..."` | `` `...` `` | `"..."` |
| Singular inverse enforced by the database | ✅ unique constraint | ✅ unique index | ✅ table-level `CONSTRAINT … UNIQUE` |
| Dropping that unique side to falsify the pin | ✅ `ALTER TABLE … DROP CONSTRAINT` | ✅ but only after dropping the FKs first — MySQL satisfies the FK's index requirement with that very unique index (errno 1553) | ❌ backed by an internal auto-index SQLite refuses to drop; the duplicate-row arm measures the invariant from the other side there |
| Cascade from owner and from target | ✅ | ✅ | ✅ (FKs enforced per connection; the driver enables them) |
| Second forced push | ✅ empty | ✅ empty | ✅ empty |

## 2.9 Interop defects found while building this matrix

1. **`push({ forceReset: true })` is broken on the entire SQLite family.** [reset.ts:23](../../src/migrations/push/reset.ts:23) and [reset.ts:95](../../src/migrations/reset.ts:95) call `generateDropTableSQL(name, /*cascade*/ true)`; the SQLite driver does not override [base.ts:555](../../src/migrations/drivers/base.ts:555), which emits `DROP TABLE IF EXISTS "x" CASCADE`. Confirmed against better-sqlite3: `near "CASCADE": syntax error`. The CLI's `--force-reset` path passes no cascade and is safe, which is why no test caught it (`tests/cli/push.test.ts:396` runs on PGlite).
2. **Native type + `.array()` silently drops array-ness on MySQL and SQLite.** [mysql/index.ts:94](../../src/migrations/drivers/mysql/index.ts:94) and [sqlite/index.ts:75](../../src/migrations/drivers/sqlite/index.ts:75) return `nativeType.type` without consulting `scalarState.array`; PG does it correctly. `s.string(MYSQL.STRING.VARCHAR(50)).array()` emits `VARCHAR(50)`, not `JSON`.
3. **`s.enum([...]).array()` never produces an array column on any dialect.** The serializer's enum branch bypasses `mapScalarType` and assigns `columnType = enumName` ([serializer.ts:98-121](../../src/migrations/serializer.ts:98)).
4. **`s.enum([...]).name("status")` emits an invalid MySQL column type** — `serializer.ts:106` prefers `enumName` whenever `supportsNativeEnums`, which includes MySQL, where the correct type is the literal `ENUM('a','b')` string.
5. **SQLite enum schemas likely re-diff forever.** Desired type is `TEXT CHECK(...)`; `PRAGMA table_info` reports `TEXT`; `columnsEqual` compares raw strings. Perpetual `alterColumn`, classified destructive → a non-forced re-push of a SQLite schema containing an enum is refused. No idempotency test covers this.
6. **~~`bun-sqlite` has no BigInt-safety path.~~ FIXED (W6-U2) — and the driver turned out to be worse than this line said.** The typed read path now calls `safeIntegers(true)` per statement exactly as `sqlite3` does ([bun-sqlite/index.ts:171](../../src/drivers/bun-sqlite/index.ts:171)); `$queryRawUnsafe` deliberately stays driver-native, the same boundary `sqlite3` has. A Bun too old to expose the method is refused with `FeatureNotSupportedError` (V8001) instead of returning a rounded value. Three corrections to the original claim, all found by finally running the thing:
   - **The driver could not connect at all.** `initClient` passed `options ?? {}`, and `new Database(path, {})` throws SQLITE_MISUSE — *"flags must include SQLITE_OPEN_READONLY or SQLITE_OPEN_READWRITE"*. The documented default (`createClient({ schema })`, no options) had **never** executed a query. Fixed in the same unit: an options bag with no keys is omitted so Bun applies its own default.
   - **"Silently" was wrong for `s.bigInt()` fields.** A rounded value past 2^53 is not a safe integer, so the shared result parser rejected it — `QueryEngineError V9001, "returned a malformed bigint scalar … not a canonical integer"`. Loud, not silent. Silent loss was confined to `int`-typed columns and raw reads.
   - **"With no test" is now false in the strongest sense available.** [tests/drivers/bun-sqlite-runtime.test.ts](../../tests/drivers/bun-sqlite-runtime.test.ts) spawns Bun on a probe that drives the real client — push, create, findUnique, include, both raw forms — against a real in-memory `bun:sqlite`, and skips cleanly when Bun is absent. [tests/drivers/sqlite-integer-safety.test.ts](../../tests/drivers/sqlite-integer-safety.test.ts) pins the same split at the unit level against a fake that rounds like the real provider, next to the `sqlite3` contract it matches. **`bun-sqlite` is therefore no longer one of the five drivers that have never executed a query** (§2.10) — it is the first of them to be moved out.
7. **Resolved after this audit: the dead MySQL/SQLite portability warnings were deleted.** Dialect restrictions now remain with migration dialect validation, where the target database and its real behavior are known; definition-time validation no longer exposes rules that no production path executes.
8. **ORM-level vector *writes* are untested on every dialect.** `buildScalarSqlValue` has no `vector` branch; the only vector suite seeds rows with raw `$3::vector` SQL.

## 2.10 Verdict

**Where the promise genuinely holds.** The public result contract is dialect-blind: blobs come back as `Uint8Array` regardless of `Buffer` / `ArrayBuffer` / `number[]` / PG hex / MySQL base64-JSON; booleans normalize `true/1/1n`; BigInts round-trip exactly at 2⁵³+1; malformed provider values throw typed errors instead of being coerced. Read shapes are identical by construction (JSON aggregation on all three). Aggregation, groupBy, having, cursor pagination, and the entire nested-write interpreter contain zero dialect branching. Semantics are *actively normalized* where SQL disagrees — integer division truncates toward zero everywhere; MySQL's `ON DUPLICATE KEY` is deliberately not used because it fires on the wrong constraint; ERR 1093 is worked around with derived tables; `mode:"insensitive"` folds ASCII only so no locale can change the answer. Refusals are typed, pre-flight, and documented.

**Where it's emulated-but-equivalent.** Scalar lists on MySQL/SQLite, enums on SQLite, NULLS FIRST/LAST, `DISTINCT ON`, booleans, savepoints, bare `OFFSET`. All produce the same answer. The cost is invisible in results and very visible in query plans. **"Works the same" is true. "Performs the same" is not, and nothing in the docs says so.**

**Where it's genuinely different and under-documented.** Timezone data is lost on MySQL. DateTime precision differs (µs / ms / string). `Decimal` is exact everywhere since W6-U1, at the price of a **named refusal on SQLite** for ordering, aggregation and arithmetic — the one place the divergence is now loud instead of silent. **Foreign keys are not enforced on SQLite.** Partial indexes are PG-only and the `where` is *silently dropped* on SQLite. Full-text search exists nowhere and isn't listed as a non-goal. Portability is sometimes bought by *degrading Postgres* — JSON path segments with `"` or `\` are refused on PG solely because SQLite's grammar has no escape syntax. ~~Isolation levels are unavailable everywhere with no escape hatch.~~ **Closed by W5-U3** (`812a750`): every driver declares a contract, and each option is either honored or refused with a typed V8003 naming the reason — including the SQLite family, which honors `Serializable` by construction and refuses the weaker three. `$queryRaw` is portable in its *values* since W5-U1 (`ad9901f`) — the text you write is still yours to keep portable.

**Where it's simply unverified.** Four of eleven drivers have never executed a query against their real backend; their coverage is `vi.fn()` object literals asserting the *normalizer's* contract, which proves viborm handles a well-formed response and proves nothing about what those services return. `bun-sqlite` was the fifth until W6-U2 spawned Bun on it, and what that first real query found — a driver that threw SQLITE_MISUSE before it could open a database — is the strongest available argument that the remaining four are not fine either. The two drivers most people deploy — `pg` and `mysql2` — have 777 tests between them that don't run on `pnpm test` and have no CI to run them. The batch-only path that D1 and Neon users depend on entirely is proven only by a local driver with its booleans flipped.

**Bottom line: the engine is more portable than its README claims and less verified than its README implies.** "Works in every provider" is currently a claim about three embedded databases extrapolated to eleven drivers. Shipping a CI matrix with docker Postgres and MySQL would convert 922 tests from aspiration to evidence overnight — that single change would do more for the honesty of the claim than any code in the repo.

---

# Part 3 — What is not permitted, not implemented, or deferred

## 3.0 The structural fact that reframes everything

**V1 is gone.** [routing.ts:64](../../src/query-engine/write-engine/routing.ts:64) — *"with V1 deleted there is no fallback arm to catch it."*

Consequence: **every `UnsupportedOperationError` throw site is now a terminal, user-facing error.** Before P6 they were *routes* — the tree quietly re-ran on V1 and the user got a working query. `ATOM.md:1469` confirms: *"The former route-to-V1 declines are now terminal `UnsupportedOperationError`s."*

But **58 comments across `src/` still say "routes to V1"** (was 73; the N-waves retired 15 of them by deleting or rewriting the sites). See §0.2.

### The refusal surface, counted at the historical audit checkpoint

Re-counted on `nested-write-boundaries` @ `6910728` (grep over
`src/query-engine/write-engine/*.ts`). This section is historical. Current counts are
8 / 10 / 12 and the live site table is in `guard-ownership-ledger.md`.

| Class | Sites in `src/query-engine/write-engine/*.ts` | Nature |
|---|---:|---|
| `UnsupportedOperationError` | **68** (pinned: `route-inventory.test.ts:1706`) | shape the engine declines — but see the audit below: 25 of the 68 are unreachable guards |
| `QueryEngineError` | 85 | fail-closed invariants (X1c/N2-U1/N4-U2 converted three unreachable declines into this class) |
| `NestedWriteError` | 35 | relation legality / target-not-found / own-write preflight |
| `TransactionError` | 7 | driver-capability refusals |
| `ValidationError` | 1 | the single parse boundary |

> **Census on this branch: 78 → 68**, pinned at `route-inventory.test.ts:1706`, with every delta's rationale written above the assertion in the count-evolution log. The composition changed more than the number: absorptions removed whole families (N1-U1's pinning gate, N2-U1's inverse-to-one create, N3-U1's M2M `createMany`, N4-U1's located-target seams, N4-U2's six create-arm guards, N5-U1's adopt ordering) while each one drew a finer boundary in its place.
>
> **The floor claim is audited, and it does not hold at 68.** Site-by-site disposition with live reachability measurements is in [nested-write-boundaries-plan.md § "The floor — final census disposition"](./nested-write-boundaries-plan.md): 3 parity · 15 genuinely inexpressible · **50 unjustified**, of which 25 refuse nothing at all (the parse boundary or an exhaustive dispatch answers first). Applying the disposition this branch already gave two such sites — convert to `QueryEngineError` — would take the census to 43 with no user-visible change. **DONE, and then some:** N7-U-A converted 23 of the 25 (census 68 → 45, two of the claims were refuted), and N7-U-B measured the rest against a live Prisma 7.9.1 oracle — 5 sites ABSORBED, the (c-iii) class emptied, census **40**. The standing balance is 4 parity · 19 inexpressible · **17 reachable with a mechanism this engine already has**, grouped into four named waves.

## 3.A Hard refusals a user could hit

*Ranked by likelihood in a normal application.*

**A1. ~~M2M nested `create` with a database-generated target PK — the top hazard.~~ FIXED (`b1392ca`, then completed by the residual lift).** The child INSERT publishes the identity and the junction row references it. `create`, `connectOrCreate`, and the upsert missing arm all reuse the fresh-record publisher. On a PostgreSQL-family batch path, a default operation keeps an exact fold or carries the producer's own `RETURNING` through guarded segments. Only an explicit indivisible array without an exact one-batch lowering refuses that crossing. For junction `createMany + skipDuplicates`, disposition is row-local: a vacuous row drops the flag, one exact selector adopts, and an unnameable conflict suppresses the complete target-and-join member. Interactive execution uses a savepoint; batch execution isolates the root and observes normalized row count.

**A2. `update`/`delete`/`upsert` on a batch-only, non-returning driver.** The returned row's identity can only be parsed after the batch commits, and that parse cannot be rolled back. `TransactionError`. A substrate limit; `ATOM.md:318` says it stays *"unless a deliberate design note lifts it."* **Currently unreachable** — no shipped driver combination qualifies.

**A3. No application-level ID generation (uuid / ulid / cuid) in the values builder.** `Auto-generated value '…' must be provided explicitly … Application-level ID generation (uuid, ulid, cuid) is not yet implemented.` ([values-builder.ts:182](../../src/query-engine/builders/values-builder.ts:182)). Related: on a non-returning driver, `create` refetch requires a single `autoGenerate: "increment"` PK.

**A4. `createManyAndReturn` + `skipDuplicates` on a non-returning driver.** The one refusal the maintainer explicitly authorized — genuinely inexpressible (no portable `ON CONFLICT DO NOTHING` that also reports which rows were inserted). The *sole* entry in `REMAINING_ROUTE`. **Spelling changed by W3-U4** (`c9de15f`): the refusal is now reached as `createMany({ …, skipDuplicates: true, select })`; the method name is gone.

**A5. Async validation is not supported, anywhere.** The whole validation layer is synchronous; any Standard Schema with an async refinement is rejected at runtime with `Async validation is not supported` — surfaced as a `ValidationError` issue, not a clear unsupported-feature signal ([validation/index.ts:73](../../src/validation/index.ts:73) and 8 more sites).

**A6. ~~Nested relation queries reject negative `take` and any `cursor`.~~ Resolved by W3-A units 1–2.** The relation subquery now runs the same `buildFindPagination` pipeline as the top level: a negative `take` flips the order, takes `|n|` and has its logical order restored by the result parser, and `cursor` (including compound uniques) is applied per parent through the shared cursor condition.

**A7. Root and nested `updateMany` accept relation data.** Scalar data keeps the
set-oriented statement. A relation-bearing root captures matching roots once
and runs ordinary selected updates; a relation-bearing nested operation captures
its correlated targets at the ordered position in the parent tree. The
N-greater-than-one named child-held move remains refused because one child row
cannot store several parent memberships.

**A8. Root and nested `createMany.data` accept relations.** Scalar-only rows
remain grouped. Relation-bearing rows run as ordinary fresh-record subtrees.
On interactive drivers, `skipDuplicates` suppresses the complete subtree of a
conflicting root through a savepoint. A batch-only substrate isolates the root
write and suppresses descendants when normalized row count is zero. It refuses
only when a write or nested series precedes that root. Junction rows whose flag
is vacuous or whose conflict one exact selector can adopt retain their faster routes.

**A9. No relation projection on a bulk write's returned rows** — neither `include` nor a relation key (or `_count`) inside `select`, on `createMany` / `updateMany` / `deleteMany`. DIVERGENCE, deliberate (W3 fix round): Prisma's `createManyAndReturn`/`updateManyAndReturn` do accept relations there (its generator emits `<Model>SelectCreateManyAndReturn` / `<Model>IncludeCreateManyAndReturn`). viborm refuses instead, because the projection it had was unsound — a relation subquery in a `RETURNING` list has no alias to correlate against, so it bound by name and was captured by the inner table: every to-many came back `[]`, a self-referencing to-one came back `null`, while the same projection through `findMany` returned the real rows. Read relations in a separate query. (`args/bulk-write-projection.ts`.)

**A10. Relation `orderBy` supports only `_count`.** Parity, but viborm additionally rejects to-one relation ordering combined with cursor pagination.

**A11. Cursor pagination cannot be combined with relation or vector ordering.** `cursor-order.ts:53`.

**A12. `createMany({skipDuplicates})` with a defaults-only row.** No portable `INSERT … DEFAULT VALUES … ON CONFLICT DO NOTHING`.

**A13. Arithmetic on a primary key — four portability refusals.** Two ops on one PK; float/decimal PK arithmetic; `divide: 0`; non-finite operand. Plus: a derived write to a **relation key** field while mutating that relation.

**A14. The own-write preflight.** See §1.5. viborm-specific. Prisma has no fixed sibling order at all (it follows the payload's key order — prisma/prisma#16606); viborm linearizes in one documented order (ATOM §4.1, N6-U3) and rejects only a payload contradiction or an unbounded many-to-many `deleteMany` filter.

**A15. Referential-action legality: nested adopt under a non-cascade PK transition.** A root `update` rewriting a parent PK a child references with `onUpdate: restrict/setNull/noAction`, while nesting `connect`/`connectOrCreate`/`set`/to-many `upsert`. *(The T4c-fix commit `b82a729` exists because this guard was originally wired only into the inverse-to-one `upsert` — every other kind silently diverged into corruption. Fixed; recorded because it shows the class is live.)*

**A16. Every model must have a primary key.** Engine, `push` and `migrate` all refuse.

**A17. Parity refusals inside nested writes** (all match Prisma's own rejections): `update`/`delete`/`set`/`disconnect` inside a `create` payload; M2M `upsert`/`disconnect`/`set`/`delete` under `create`; unsupported combinations of two kinds on one to-one arm — **narrowed 2026-08-10** (limitation lift, Package H): a to-one update payload is now one composition `(vacate?, supplier, modify?)`, so the five vacate-then-supply replacements are accepted on the parent-held direction as well as the child-held one, and a `connect` may carry an `update` beside it (VibORM extensions, all of them). What stays refused: two suppliers, `upsert` beside another intent, a vacate with a modify and no supplier, two vacates, `delete + connectOrCreate`, and — parent-held only, at the type boundary — `create`/`connectOrCreate` beside an `update`. **Narrowed again 2026-08-13** (residual lift, Package E): on the CHILD-HELD direction a producing supplier now carries its `update`, as a one-member record-series continuation located by post-supply membership, so the engine site that named a missing produced-identity channel is deleted; ~~object-form `disconnect: {…}`/`delete: {…}` on a to-one~~ (**N2-U3 — this entry was WRONG, and is retracted**: measured against Prisma 7.9.1's generated `ProfileUpdateOneWithoutUserNestedInput`, both keys are typed `ProfileWhereInput | boolean`, a filter narrowing which connected record is acted on. viborm types them `v.boolean()`, so the object form is refused at the parse boundary — a genuine, narrower surface, not parity. Moved to §3.B); writing a relation's owned FK inside its own nested create; nested create identity must match the unique `where`; M2M `disconnect: true` without a selector; `set` that would orphan a required FK.

**A17a. Selected-row continuity (five-capability Package 2, 2026-08-17).** A
correlated nested update or found-upsert that re-enters the exact incoming
parent now addresses the captured selected row, not a row found by re-evaluating
the public selector. If the enclosing update changes the parent row key, the
relation placement chooses before-root or after-root and the selected-record
compiler supplies the complete captured or final key. Same-incoming delete and
global-adopt still refuse, as does a re-entry that itself changes the incoming
parent's row key and would need to publish another final tuple outward.

**A17b. Bind-budget partitioning (five-capability Package 3, 2026-08-17).**
`createMany` groups and junction `connect`/`set` inserts split at their semantic
builders from the compiled `Sql.values.length`, using the active driver's
verified `maxBindParametersPerStatement`. Count, input order, conflict behavior,
and atomicity remain operation-wide. Arbitrary predicate updates/deletes and a
single indivisible over-limit statement are not rewritten by the executor; the
latter refuses before I/O. Large-payload statement-level triggers fire once per
chunk, while an under-limit same-shape run remains one statement.

**A18a. Generated-output transport on a batch path** (residual lift Package B,
then Track A, 2026-08-14). MySQL (`LAST_INSERT_ID()`) and the SQLite family
(`last_insert_rowid()`, D1 included) keep their exact statement-local channels.
PostgreSQL never uses session-global, trigger-sensitive `lastval()`. A default
PostgreSQL-family operation instead keeps the producer's own `RETURNING` in one exact
fold or materializes it before a guarded dependent segment; Neon HTTP uses the same
route, with no atomicity across segments. An explicit `$transaction([...])` remains
indivisible, but scalar RETURNING arms and bounded PostgreSQL-family mutation DAGs
whose projection does not read a sibling-mutated table fold into one statement. A
graph with no exact one-batch lowering still refuses before effects. A non-returning
adapter publishes a plural database-assigned row key through one focused read when
the create source explicitly writes a complete addressable alternate unique; an
unnameable row still refuses. Every output crossing a segment must carry the
compiler's exact continuation premise. The former public-scratch crossing and
later-race-pin refusals are retired.

**A18. Driver / dialect capability refusals.** `d1`/`neon-http` callback transactions; ~~`$transaction` options~~ (**W5-U3, `812a750`** — no longer a blanket refusal: options are honored per driver, and only the combinations a driver cannot execute are refused, each with a reason); array-form `$transaction` with a non-batchable op on a batch-only driver; cross-statement generated output inside an indivisible array without an exact lowering; a generated-output segment with no compiler continuation premise; PlanetScale cross-shard; `mysql2` `multipleStatements`; SQLite RIGHT/FULL OUTER/LATERAL; MySQL FULL OUTER; JSON path segments with `"` or `\`; nullable vector column in a distance select.

## 3.B Historical narrower-boundary audit

This section records the dated audit that drove the residual lift. Its present-tense
claims are not current: the live census is 8 / 10 / 11 and every surviving site has
an exact falsifier in the guard ledger.

Census evolution: 36 → 49 → 51 → 59 → 62 → 65 → 73 → 74 → 75 → 78 → 81 → 86 → 87 → 90 → 89 → 84 → 83 → 78 → 76 → 74 (N4/N5) → **68** (N4-U2) → 45 (N7-U-A) → **40** (N7-U-B), and 68 through N4-U4, N6-U1, N6-U2 and N6-U3 — the last four moved capability without moving the count, each for a reason the log states (the shape missed the census, the refusal lived at the parse boundary, or it raised a different error class). Every absorption added finer boundaries — until N4-U2, whose six sites were boundaries of a hand-rolled arm rather than of anything the engine could not express, and which therefore added none.

**Audited 2026-07-30 — the §3.B rows below are a taxonomy of *sites*, not of refusals.** The per-site disposition (with live reachability probes) is in [nested-write-boundaries-plan.md § "The floor — final census disposition"](./nested-write-boundaries-plan.md). Its headline for this section: **B12's "degenerate/unreachable guards" is far larger than the one row suggests — 25 of the 68 sites are unreachable** (N7-U-A then converted 23 of the 25; TWO turned out to be reachable — see B12), and N7-U-B then absorbed five more against a live Prisma oracle, including two paths where viborm silently did the OPPOSITE of what the payload asked, and several rows below (B2's compound-key family, B7's connect-by-other-unique, parts of B3/B4) name shapes whose closing mechanism already exists elsewhere in the engine. Line numbers in the `Sites` column predate the N-waves and are indicative, not current.

| # | Boundary | Sites |
|---|---|---|
| **B1** | Shared-primary-key edges whose fold value isn't a compile-time literal (`A.id` *is* the FK to `B`). **N4-U4 (2026-07-30) absorbed the `create` cause on the CREATE root under BOTH provenances** — a literal target key, and one the database generates, which the record's identity and its terminal read take as a backward `Ref` to the producing before-parent INSERT. What survives there is a non-referenced `connect` (its FK is a lookup subquery, and re-evaluating it for the identity is a second provenance) and a `connectOrCreate` (a runtime arm decision). N4-U4 also widened a fresh record's identity past its primary key, so an edge referencing one of its other uniques now resolves | `CreateOperation.ts:758`, `UpdateOperation.ts:2491` |
| **B2** | Compound keys at the wrong place in the tree | `CreateOperation.ts:1230`, `UpdateOperation.ts:1333,1129,2046`, `RelationUpsertPart.ts:653` |
| **B3** | Nested writes that must locate their target by its primary key (a nested `update`/`upsert` carrying its own relation writes needs a construction-time literal FK) | `RelationWritePart.ts:596`, `RelationUpsertPart.ts:740`, `RelationJunctionPart.ts:1339` |
| **B4** | Nested relation writes in arms that can't carry them (upsert create arm; `updateMany`/connectOrCreate-adopt data; parent-held to-one located data; before-root target create) | `RelationWritePart.ts:375,586,576`, `UpdateOperation.ts:2318,2506` |
| **B5** | **PK transition + a non-cascading child-held edge** — *"routed for correctness, not inexpressibility"*. Witness test exists | `RelationWritePart.ts:637` |
| **B6** | Nested `create` under a PK-transitioning parent (unpinned pre-transition value; non-literal arithmetic rewrite; reference neither pinned nor rewritten) | `UpdateOperation.ts:1352,1367,1379,1156` |
| **B7** | Connect by a non-referenced unique in the wrong position | `UpdateOperation.ts:2993,2574`, `RelationUpsertPart.ts:940` |
| **B8** | ~~The connectOrCreate / upsert create-arm depth guard (one level deeper)~~ **ABSORBED by N4-U2 (2026-07-30).** The arm's row is PRODUCED, and a produced row's relations are the create ROOT's surface, so the whole relation-carrying arm is a create SUBTREE (X1b's `nestedFresh` reuse through an injected builder). Five sites deleted, one converted to a structural invariant. What remains is named for the UPDATE arm, whose target is LOCATED: an m2m edge and a parent-held to-one one level deeper | `RelationUpsertPart.ts` (update-arm sites only) |
| **B9** | Depth leaves in `nested-target-parts.ts` (5 sites). **The depth limit itself is gone** — X1/X1b/X1c lifted it entirely; a 40-level chain is exercised. These are *seam* differences, not a counter. `:537` is the live tripwire the decline-surface gate keeps alive | `nested-target-parts.ts:307,335,481,537,555` |
| **B10** | T4b/T4c narrower boundaries (located-only pre-transition PK, compound generated PK, non-portable arithmetic; the A15 adopt decline) | `ATOM.md:1383,1424,1445` |
| **B11** | Top-level `upsert` update arm with a parent-held to-one relation | `route-inventory.test.ts:456` |
| **B12** | ~~Degenerate/unreachable guards~~ **EMPTIED by N7-U-A (2026-07-30)**, and then some: the audit found this row was 25 sites wide, not the handful it listed. 23 of them are now `QueryEngineError` internal invariants (the N2-U1 / X1c disposition — a branch unreachable BY CONSTRUCTION is not a capability boundary), so they are no longer refusal sites at all; the census pin dropped 68 → 45 with **no user-visible change**, because none of them fires. Witnesses: `census-conversion-witnesses.test.ts`. TWO survivors were re-measured as **REACHABLE**: the create-root relation-type guard (a `manyToOne` with no `.fields()`, which the same schema's `update` root accepts) and the to-many upsert builder's direction guard (a parent-held to-one `connectOrCreate` on an upsert UPDATE arm, where the grandchild fold dispatches on the kind alone). Both reclassified as unwired mechanisms, not degenerate guards | `CreateOperation.ts:822`, `RelationUpsertPart.ts:708` |

### The user-facing shapes inside §3.B worth calling out by name

These are ordinary Prisma payloads:

| Payload | Result |
|---|---|
| `user.update({ where:{ id }, data:{ profile:{ create:{ bio } } } })` on an **inverse-side to-one** | ✅ since **N2-U1**: the arity-1 case of the child-held create, on both parent provenances (pinned `where` or N1's located-parent Ref). An OCCUPIED slot errors as Prisma's does — the 1:1 FK's UNIQUE constraint, no pre-check probe and no retry. `tests/query-engine-v2/inverse-to-one-create-behavior.ts`, every driver leg × both substrates |
| `user.update({ where:{ email }, data:{ posts:{ create:{…} } } })` | ✅ since **N1-U1** (the located-parent Ref): the locate selects the referenced column and the nested create reads it from the located row, compiling to the same statements as the `where: { id }` spelling |
| `post.update({ where:{ id }, data:{ tags:{ createMany:{ data:[…] } } } })` (M2M) | ✅. Each row routes independently: spelled key keeps the leaf, a vacuous generated-key skip drops the flag, one exact selector adopts, and an unnameable conflict suppresses target plus join through an interactive savepoint or an isolated batch root segment. |
| `article.update({ …, data:{ labels:{ upsert:{ where:{ name }, create:{ name }, update } } } })` with a generated `label.id` | ✅. The missing arm is an ordinary fresh-record subtree and publishes the generated key exactly; only a substrate without an exact cross-statement identity channel refuses that transport. |
| Many-to-many on a model with a **compound primary key** | ✅ **LIFTED by the residual compound-junction pass (2026-08-14).** `.A()` / `.B()` remain one string each; scalar sides use the exact column and compound sides expand that token positionally in row-key order. One bound `JunctionSide` owns every physical-to-referenced member. Migration DDL/introspection, reads, writes, cascades, generated tuple publication, and conditional skip-and-link all consume the complete groups. PGlite transaction+batch, better-sqlite3, live MySQL2, and PostgreSQL/MySQL/SQLite SQL contracts are pinned. |
| `tags: { update: { where:{ slug }, data:{ posts:{…} } } }` | ❌ must locate the target by its primary key (N4-U1's unit: the same Ref generalizes, applied there) |
| `user.update({ where:{ id }, data:{ profile:{ disconnect:{ …filter } } } })` / the same with `delete` | ❌ refused at the **parse boundary** — viborm types both keys `v.boolean()`. Prisma 7.9.1 types them `WhereInput \| boolean` (a filter narrowing which connected record is acted on), so this is a NARROWER surface, not a parity refusal (**N2-U3**, retracting the A17 claim). Closing it is a schema widening plus a filtered disconnect write; `delete`'s half is nearly free since `delete: true` already compiles through the filter-taking `deleteMany` leaf |
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

**C9. Genuinely unimplemented features with written specs.** Recursive queries (`WITH RECURSIVE`, "Medium"); Redis cache driver. *(Query-level `omit` was on this list; shipped in W5-U4. Polymorphic relations were on this list at the July snapshot; the row-held `s.polymorphicToOne` slot shipped, and the `s.polymorphicToMany` collection followed with the cardinality program — see §2.8.1 for the per-provider evidence.)*

**C10. Resolved after this audit.** The empty `enumValueValid` rule and its unreachable database-rule subsystem were deleted instead of being covered by artificial tests.

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

**D4. The volume prize was NOT achieved in that phase.** The retired design
predicted 10.8k → ~3–4k lines. Measured: V2 was **13,984 raw / 10,623 code** —
≈1.3–1.6× V1's write root. What compressed was *structure* (2 runtimes → 1,
five orthogonal axes back to data), not lines. Recorded as the right trade, not
a win. The original ledger remains at
`db3317770ce7e589ba1da849570eda6925c4c478`.

**D5. Batch-only drivers keep the plan-then-execute path.** An exact generated-output
fold can stay one statement; otherwise a default RETURNING-capable operation can
continue through guarded committed segments. Any no-transaction driver with native
atomic batch supports root and exactly guarded nested dynamic record series. D1's
ordered callback capability gives exact acknowledged progress; Neon HTTP uses the
same general route without claiming that stronger hosted attribution.

**D6. SQLite silently ignores `FOR UPDATE`** — a deliberate no-op. Row-level locking semantics differ from PG/MySQL with no signal.

## 3.E Unverified surface — the honest "we don't know"

**E1. Historical gap, closed by the residual lift.** The ~40 untested narrower
boundaries described the dated audit. The current 8 / 10 / 11 construction sites are
enumerated in the guard ledger and each has a falsifier; no live site has an empty
falsifier cell.

**E2. Hosted-driver coverage is uneven.** D1 has a Workers provider contract
covering the real binding path, including progressive root series. Neon HTTP and
PlanetScale still depend mainly on mocked capability/error contracts unless
their provider services are available.

**E3. Docker-gated suites skip silently on a normal `pnpm test`.** MySQL is the only non-returning dialect and the only `recoverableUniqueError` dialect; a default local run exercises neither.

**E4. `pg` / `postgres` get driver-level suites only.** Real-Postgres coverage of the adapter matrix is inferred from PGlite, not run.

**E5. Two contracts died with V1** (C5, C6) and are now untested on either engine.

**E6. `compatibility.mdx` is stale in the *under-promising* direction.** It still documents the X1c limitation as live (*"One shape is still one level short at a located target…"*) — X1c deleted exactly those two throws (`fd492d1`, census 78→76). Same page also still says nested `upsert` under `create` *"still rejects"*; the create tree routes to V2 now and the child-held one-to-many case **is** implemented as a deliberate Prisma superset. Users are being told shapes fail that now work.

**E7. The parity contract's own coverage column is full of gaps.** `prisma-parity-contract.md` self-reports *"missing dialect test"* on six rows, *"missing direct client type tests"* on four, *"missing result type tests"*, *"missing client-level raw SQL parity matrix"*, and *"hosted/external D1 binding, Neon HTTP, and MySQL/PlanetScale suites remain open."* It carries an explicit honesty clause: *"the public surface looks more Prisma-complete than it currently is. The main risk is false confidence."*

**E8. The TypeScript type-instantiation ceiling (~31 levels).** A rich per-level literal create payload type-checks at 30 levels and fails at 32 with TS2321. The runtime carries no depth counter and folds a 40-level chain. A **DX** ceiling on client input inference, not an engine limit. Workaround: build the payload programmatically so the compiler never infers the deep literal.

**E9. Documentation contradictions that make the current state hard to establish.** `ATOM.md:1004` *"(V1 not yet deletable)"* vs `routing.ts:26` *"with V1 deleted"*. `src/query-engine/write-engine/README.md:3` still declares *"Query Engine V1 remains the public implementation"*; its module table lists only `CreateOperation` (25 modules exist); `:291` says *"A future `UpdateOperation` should be implemented concretely first"* (it is 3,300+ lines); its "Deliberate Non-Goals" lists three things that all shipped. `correlation-utils.ts:19` claims M2M junction handling is *"not yet implemented"* while `:62` routes it to a working helper. `src/README.md:110` — *"when the database adapter system is implemented in a future phase"*. Plus the 73 "routes to V1" comments.

**E10. Reproducibility.** The benchmark baseline (`benchmarks/baseline.json`) is a **machine-local, untracked artifact**. None of the §3.D numbers is reproducible from a clean clone without regenerating it.

**E11. Silent data-integrity divergence on LibSQL migrations.** [libsql/index.ts:8-10](../../src/migrations/drivers/libsql/index.ts:8): *"CAVEAT: LibSQL's `ALTER COLUMN` only validates newly inserted/updated rows, NOT existing data."* A constraint added on LibSQL does not validate what's already in the table — a divergence from Postgres with no error and no test. Related: `unapply` does **not** run down migrations, it only removes tracking rows; bare `DECIMAL` defaults to a fixed `DECIMAL(65,30)`; the forward-ref FK lift is *"deliberately surgical"* — only FKs referencing a table created later **in the same batch** are lifted, other cycles unhandled.

## 3.F Client-surface items exposed but not wired end-to-end

| # | Item | Effect |
|---|---|---|
| F1 | `exist` has no arg schema of its own | validated against the **`count`** schema; `orderBy`/`cursor`/`take`/`skip`/`select` accepted at runtime but invisible to types; runs a full `COUNT`, not an `EXISTS` |
| F2 | ~~`$transaction` accepts no options~~ | **CLOSED by W5-U3** — both forms take options; each is honored or refused with a reason, never ignored |
| F3 | ~~Raw SQL~~ | **CLOSED by W5-U1** — tagged templates, Prisma's return shapes, `*Unsafe` variants, helpers exported from the root and `viborm/sql` |
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
| `README.md:39` | "no `updateManyAndReturn`" | ~~it exists~~ — **resolved by W3-U4** (`c9de15f`, docs `27d8e53`): the method genuinely does not exist; `README.md:37,39` now describe the implicit-returning form instead |
| `README.md:271-295` | `instrumentation: { tracing: { enabled: true } }` | `TracingConfig` has no `enabled` field |
| `prisma-core-gaps.md:20-22` | `createManyAndReturn`/`updateManyAndReturn` are non-goals | ~~both implemented~~ — **W3-U4 made the doc right for the wrong reason**: the names are non-goals now by decision D-1, and the capability ships under `createMany`/`updateMany` + `select`. The page still needs that sentence |
| `src/query-engine/write-engine/README.md:3` + 73 in-file comments | "V1 remains the public implementation" / "routes to V1" | V1 fallback deleted; those errors now propagate |
| `src/client/AGENTS.md:255-260` | `$transaction(cb, { isolationLevel })` | ~~any second argument throws `V5005`~~ — **resolved by W5-U3** (`812a750`): the documented call now works; a *malformed* options object is what raises `V5005` |
| `src/migrations/AGENTS.md:191` | `viborm push --accept-data-loss` | the flag is `--force` |
| `AGENTS.md:184` | 13+ drivers including `d1-http` | 11 drivers; `d1-http` does not exist |
| `ATOM.md:1004` | "(V1 not yet deletable)" | V1 deleted at P6 |
| `correlation-utils.ts:19` | M2M junction handling "not yet implemented" | `:62` routes to a working helper |
| `src/README.md:110-112` | "when the database adapter system is implemented in a future phase" | adapters exist |
| `instrumentation.md` (repo root) | reads as viborm docs | it is a research dump about *Prisma's* `@prisma/instrumentation` |

---

## Recommended order of work

*(Status as of 2026-07-28 on `prisma-parity-v2`. Items 1–4 are done; 5 and 6 are still open and are not part of any wave.)*

1. ~~**Defect 1**~~ — **done, `bd091a0`.** `data` binds to `core.scalarUpdate`; the false premise in `BulkCountOperation.ts` went with it.
2. ~~**Export `UnsupportedOperationError`**~~ — **done, `e109946`.** Own code `V8003`, exported from `src/index.ts`.
3. ~~**Defect 3**~~ — **done, `b1392ca`.** Junction id threaded as a backward `Ref`, plus the generated-PK M2M fixture.
4. ~~**Defect 2**~~ — **done, `a9cf030`.** Dry-run resolutions are recorded and replayed on the apply pass.
5. **A CI matrix with docker Postgres + MySQL** — still open. Converts 922 tests from aspiration to evidence. `.github/` still does not exist.
6. **Finish the stale-comment sweep** — still open; the only per-site record of *why* each shape is refused currently asserts something false.
7. **Correct `compatibility.mdx`** — it under-promises against the shipped engine in two places.
