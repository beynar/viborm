# 1.3.3 performance work: measurements

Evidence for the 1.3.3 performance PR. Each section was measured by the
lane that made the change. Every comparison ran the old and the new SQL (or
code) interleaved, on the same database in one process, and checked that the
answers were identical.

The machine was shared by five lanes running tests, with a load average of
15–38. Byte, bound-value, table-reference and buffer counts are exact. Times
are medians and should be read as ratios.

- **Datasets:** PGlite is PostgreSQL 17. SQLite is better-sqlite3 3.53.2,
  with libSQL, Bun and D1 where noted.
- **Workloads:**
  - "governed" is the permissions acceptance policy
    (`tests/types/permissions/acceptance-policy.ts`) with soft delete.
  - "blog" is a 5-model schema with deep includes, relation filters,
    `_count`, upsert and nested writes.
- **Scripts:** the harnesses (SQL capture, EXPLAIN comparison, runtime lab)
  lived in a scratch directory; each section names its harness and dataset.


## 0. PostgreSQL: correlated shared bodies are `NOT MATERIALIZED` (orchestrator)

Since 1.3.1 every PostgreSQL driver shares repeated relation bodies by default (`sharedRelationBodies: true`).
PostgreSQL 12+ materializes a `WITH` member that is referenced twice. A materialized member has no index, so each
correlated use (`EXISTS (SELECT 1 FROM "__shared_N" WHERE outer.fk = "__shared_N"."k0")`) scans the whole member
once per outer row (`CTE Scan … Filter: k0 = q4.authorId, Rows Removed 1076, loops=30`).

- `SharedBody.correlated`: relation bodies are `true`, uncorrelated `$exists` bodies are `false`
  (`src/query-engine/raptor3/shared/query.ts`).
- `cte.with` definitions carry `inlined`. `createCteBuilders(quoteIdent, inlining?)` writes
  `AS NOT MATERIALIZED (…)`, and only the PostgreSQL adapter passes it.
- The 1.3.2 `$exists` bodies keep the materialized form: they are read once per statement, with `LIMIT 1`.
- SQLite, MySQL and D1 are unchanged. SQLite already inlines; MySQL shares nothing.

Measured on PGlite (PostgreSQL 17), median of 11 runs, identical rows. The query is `post.findMany` with a nested
author/comments include, under a `user.posts some published` policy:

| data | 1.3.2 (materialized) | 1.3.3 (`NOT MATERIALIZED`) |
|---|---|---|
| 2k users / 20k posts / 100k comments | 4.78 ms | 1.23 ms |
| 10k users / 100k posts / 500k comments | 19.65 ms | 1.48 ms |

The old form's cost grows with table size; the new one is flat. The SQL is 17 B longer.
Smallest case found: `org.findMany` including documents (200k documents) went 0.49 → 0.53 ms.

Test: `tests/providers/local/pglite-shared-bodies.test.ts` checks:
- a relation body is `NOT MATERIALIZED`, an `$exists` body is not;
- the rows are the same with sharing on and off.

Ran 7/7. Falsified: reverting the adapter line makes the new test fail.

## Group A — SQL sharing (perf 1.3.3)

Machine note: load average 29–38 during every measurement (five agents running
tests). Absolute times are inflated; every comparison below is interleaved
(before/after alternating per iteration, same process, same database) so the
ratios hold, and SQL bytes / bound values are exact.

### A1. Shared relation bodies on by default for SQLite3 / libSQL / Bun SQLite — NOT SHIPPED

Decision: leave `sharesRelationBodies` absent on the in-process SQLite drivers
(sqlite3, libsql, bun-sqlite). D1 keeps it (statement-size bound). There is no
node:sqlite driver in src/drivers; the SQLite family is sqlite3, libsql,
bun-sqlite, d1, all checked. No driver code changed.

Why: measured on better-sqlite3 it is SLOWER end to end. SQLite runs both
spellings in about the same time (it inlines the CTE: EXPLAIN QUERY PLAN of the
shared `can()` statement has 0 MATERIALIZE steps, same as `AS NOT MATERIALIZED`),
but the engine spends ~230 µs more JS per governed statement finding and
keying the repeats (`sharedKey`: ~62 calls per `can()`; profile shows the
sharing path — sharedKey/peekRuns/relationExists — as the added self time).
In-process there is no transport that charges for bytes or binds, so the
saving buys nothing.

Harness: /tmp/perf133/A/a1.lane.ts (acceptance policy
tests/types/permissions/acceptance-policy.ts + softDelete on TOMBSTONED_MODELS,
permissions-app seed: 3 orgs, 60 users, 200 pages, 150 docs, ~280 grants;
blog = /tmp/vb-sql-lane workloads). Capability toggled on a fresh
RecSQLite (better-sqlite3 :memory:) per variant; N=200 interleaved iterations,
writes in a rolled-back transaction. "raw" = better-sqlite3 `stmt.all()` of the
captured statement alone (off / on / on+NOT MATERIALIZED / on+MATERIALIZED).

| workload (actor u02 unless noted) | SQL bytes off → on | binds off → on | median µs off → on (end to end) | raw SQLite µs off / on / onNM / onM |
|---|---|---|---|---|
| P1 document.findMany take 10 | 12,522 → 10,568 | 68 → 39 | 1126 → 1407 | 574 / 617 / 592 / 670 |
| P2 page.findMany include group | 12,556 → 7,464 | 107 → 50 | 2194 → 1997 | 1295 / 832 / 812 / 535 |
| P3 document 3-level select | 37,870 → 16,527 | 208 → 51 | 8029 → 8662 | 4335 / 4454 / 4456 / 3433 |
| P4 document.count | 12,009 → 10,055 | 67 → 38 | 1239 → 1482 | 936 / 977 / 976 / 756 |
| P5 document.update | 18,401 → 13,022 | 99 → 43 | 373 → 621 | |
| P7 document.updateMany | 17,995 → 12,616 | 99 → 43 | 322 → 565 | |
| P8 document.can("update") | 17,910 → 12,505 | 98 → 42 | 301 → 531 | 20 / 15 / 15 / 26 |
| P9 document.upsert | 56,533 → 51,014 | 299 → 243 | 2134 → 2424 | |
| P10 update + nested updateMany | 56,618 → 45,580 | 299 → 187 | 1615 → 2112 | |
| u05 P8 can | 17,910 → 12,505 | 98 → 42 | 322 → 549 | 39 / 38 / 38 / 186 |
| blog (13 workloads) | identical except W8 422 → 468 | W8 4 → 3 | equal ±10 µs (W2 37 → 47, W12 29 → 34) | |

All answers identical (P5/P9/P10 differ only in `updatedAt`).
Side finding: AS MATERIALIZED would be 20–60 % faster on SQLite for the big
reads (P2 1295 → 535, P3 4335 → 3433) but 5× slower on u05 P8 — not a safe
default either; not shipped.

Docs: src/adapters/AGENTS.md (capability paragraph) now records the
measurement so the default is not re-tried blind. User docs unchanged (they
already say only D1 and the PostgreSQL drivers share).

Open risk: the ~230 µs/statement JS cost of sharing is also paid on every
PostgreSQL driver (default on) and D1. Worth a runtime item: `sharedKey`
(peekRuns + regex renumbering + JSON.stringify per body, ~10 µs/call under
load) and building both `inline` and key-set forms for every body.

### A2. Located / captured lookups share their bodies — SHIPPED

Change: src/query-engine/raptor3/shared/query.ts — `Queries.select` is now a
wrapper that runs the old body (`#select`) inside `#sharingBodies` when the
adapter shares; new module interface `SelectControls` (the old inline type).
Re-entry: `#sharingBodies` returns `build()` untouched when a scope is open,
so a `select` inside `read()` (or inside `Queries.sharing`) joins that
statement's scope — no nested WITH; `select` returns the same `Query` object
when nothing was shared. Covers every `select` caller: operation-context
captureMutationIdentities / premises / probes / re-reads, commands/selection
`#rowQuery` + `captured`, commands/execution absent/series/finishOne,
commands.ts locked capture. `FOR UPDATE` stays at the end of the SELECT after
the leading WITH (valid on PostgreSQL; PGlite executes it; locking clause
does not apply to WITH members, which were EXISTS sublinks before anyway).
MySQL shares nothing (unchanged); SQLite has no FOR UPDATE (D1 / forced-on
SQLite3 verified). WITH inside `EXISTS (…)` of `assertions.exists/notExists`
is valid on PostgreSQL and SQLite; sqlite-statement-classifier already
handles a leading WITH.

Before → after (PGlite, acceptance policy + soft delete, actor u02, one call):

```
before: SELECT "q0"."id", … FROM "public"."document" AS "q0" WHERE (… EXISTS (…session…) … EXISTS (…same body…) …) ORDER BY "q0"."id" ASC LIMIT $94 FOR UPDATE
after:  WITH "__shared_0" AS NOT MATERIALIZED (SELECT "q4"."userId" AS "k0" FROM "public"."session" …), … SELECT "q0"."id", … ORDER BY "q0"."id" ASC LIMIT $40 FOR UPDATE
```

| workload | whole call bytes | whole call binds | the FOR UPDATE lookup bytes / binds / FROM+JOIN refs |
|---|---|---|---|
| document.upsert | 45,321 → 35,277 (−22 %) | 230 → 122 (−47 %) | 16,205 / 94 / 132 → 11,183 / 40 / 103 |
| document.update + nested updateMany | 40,392 → 35,370 (−12 %) | 176 → 122 (−31 %) | 16,183 / 93 / 132 → 11,161 / 39 / 103 |
| document.update, delete, create nested | unchanged | unchanged | — |

(Earlier analysis quoted 51.9 → 41.1 KB for upsert; the base has since shrunk
by other groups' work — the delta, −10 KB / −108 binds, matches.)

PostgreSQL plan: EXPLAIN (ANALYZE, FORMAT JSON) of the lookup before vs after
has the identical node tree (299 nodes, same types/relations; only recursive
CTE alias numbers differ). Execution 1.43 → 1.42 ms (upsert), 1.36 → 1.35 ms
(nested); planning 11.99 → 12.25 / 10.30 → 11.88 ms (median of 40, noisy
under load; a second run gave the opposite sign for upsert). End-to-end PGlite
op times swing ±50 % between runs under this load and show no stable
difference.

JS cost (same ~230 µs/statement effect as A1), measured on better-sqlite3
with sharing forced on (D1 form), interleaved N=400: upsert 3047 → 4262 µs
(raw SQLite for the two lookups 448 → 489 µs each), nested 2478 → 2769 µs. On
PostgreSQL drivers this is the trade 1.3.2 already accepted for reads/UPDATE/
DELETE (and Neki's 256-relation bound: the lookup drops 132 → 103 refs).

Harnesses: /tmp/perf133/A/a2.lane.ts, a2t.lane.ts (PGlite, EXPLAIN),
a2s.lane.ts (SQLite forced on). The temporary `__A2_OFF` toggle used for the
interleaved before/after has been removed from query.ts.

Docs: src/query-engine/raptor3/AGENTS.md (E5.2 scope list: since 1.3.3 every
`Queries.select` statement), docs/content/docs/extensions/permissions.mdx
(PostgreSQL drivers paragraph: since 1.3.3 the upsert / nested update
`SELECT … FOR UPDATE`).

### Tests

Added:
- tests/contracts/public-client/extension-shared-bodies.core.test.ts —
  "an upsert's located lookups state the repeated body once, read twice"
  (SQLite3, capability forced on: probe + located row each start
  `WITH "__shared_0" AS (…members…), "__shared_1" AS (…)` and read
  `__shared_1` twice; same answer as inline; inline has no WITH).
- tests/providers/local/pglite-shared-bodies.test.ts —
  "PGlite: an upsert's locked lookup states its repeated body once, ahead of
  FOR UPDATE" (NOT MATERIALIZED member, `__shared_1` read twice, statement
  ends `FOR UPDATE` and executes; found and not-found upserts answer the same
  shared and inline).
Falsified: with `select` bypassing sharing both new tests fail (4 failures
across projects), pass with it.

Commands (all from the worktree):
- `pnpm exec vitest run --workspace vitest.workspace.ts tests/contracts/public-client/extension-row-checks.core.test.ts tests/contracts/engine/query/for-update-dialects.core.test.ts tests/contracts/adapters/sqlite-deep-expressions.core.test.ts tests/contracts/drivers/sqlite-temporary-objects.core.test.ts tests/contracts/public-client/extension-shared-bodies.core.test.ts tests/providers/local/pglite-shared-bodies.test.ts` → 11 files, 147 tests passed.
- `pnpm exec vitest run --workspace vitest.workspace.ts tests/providers/local/pglite-permissions-verbs.test.ts tests/providers/local/pglite-permissions-placement.test.ts tests/providers/local/pglite-permissions-app.test.ts` → 3 files, 93 tests passed.
- tests/providers/local/pglite-permissions-entry.test.ts → 82/83 passed; W-CAN6 (`can` against the oracle on every accessGrant row for u03) hit the timeout at 313 s with the load average at 30–38. It is a timeout, not a wrong answer. It was not re-run alone.
- tests/raptor3/post-prep/row-scopes.test.ts: W-K1e golden fails, but on
  other groups' SQLite changes (json_group_array without COALESCE, COUNT
  without COALESCE) — SQLite3 there does not share, so A2 does not touch it.

Goldens believed affected by A2: none found. tests/raptor3/post-prep/__golden__
(SQLite3, no sharing) — no; tests/providers/workers/__golden__/d1-composed-rows-sql.json
(D1 shares) — its upsert/nested-update lookups carry tenancy/soft-delete column
predicates, no repeated relation body, so expected byte-identical (not run:
workers). instrumentation __golden__ — no policy.

## Group B — ordering by a to-one relation (B1) and mixed-direction cursors (B2)

Worktree `/Users/arnaud/.t3/worktrees/viborm/perf-1.3.3`, base 951e64998. Scratch: `/tmp/perf133/B/`.

### B1 — a to-one order term is one LEFT JOIN per relation path

**Files:** `src/query-engine/raptor3/shared/query.ts`
- new `interface OrderJoins` (beside `OrderTerm`): per-page map `"<parentAlias>.<field>" -> joined alias` plus the ordered LEFT JOIN list.
- `#orderTerms` / `#orderTerm` / `#relationOrderTerm` take an optional `joins` collector. When it is there and `#joinsOnce(edge)` holds, the relation is LEFT JOINed once per path. The ON clause is `correlation(edge, parent, joined)`, so the related domain (soft delete, `rows`, permission verbs) is in ON and never in WHERE. A deeper hop chains off the joined alias. If the edge is not joinable, the term stays the correlated scalar subquery, and its inner hops stay inside that subquery: joins never leave a subquery.
- `#joinsOnce`: `edge.kind === "reference" && scope.edge.kind === "foreignKey" && (edge.owner === "source" || resolved.unique)`. Either the parent holds the key, which references a target key (`checkStoredReference`), or the target holds it under the resolver's unique flag. Junctions, variant carriers and polymorphic arms keep the subquery.
- `#page(…, joined = true)` returns `joins`. Consumers that append them after their FROM: `select()` (root reads), `aggregated()` (the paged count/aggregate window) and `#lowerRelationProjection` (nested page; the join comes after the junction's own join). `select()` passes `!controls.forUpdate`, because PostgreSQL refuses FOR UPDATE on the nullable side of an outer join. Recursive projections (`#orderTerms` in the walk) and grouped orders pass no collector and keep the subquery.
- Alias numbering is unchanged for the first term on a path. A repeated path allocates no alias.

**SQL before → after** (PGlite, captured from the client):
```
-- one hop
ORDER BY (SELECT "q1"."name" FROM "public"."user" AS "q1" WHERE "q0"."authorId" = "q1"."id" LIMIT $1) ASC NULLS LAST, "q0"."id" ASC LIMIT $2
FROM "public"."post" AS "q0" LEFT JOIN "public"."user" AS "q1" ON "q0"."authorId" = "q1"."id" ORDER BY "q1"."name" ASC NULLS LAST, "q0"."id" ASC LIMIT $1
-- two hops (comment -> post.author.name)
ORDER BY (SELECT (SELECT "q2"."name" FROM "public"."user" AS "q2" WHERE "q1"."authorId" = "q2"."id" LIMIT $1) FROM "public"."post" AS "q1" WHERE "q0"."postId" = "q1"."id" LIMIT $2) …
FROM "public"."comment" AS "q0" LEFT JOIN "public"."post" AS "q1" ON "q0"."postId" = "q1"."id" LEFT JOIN "public"."user" AS "q2" ON "q1"."authorId" = "q2"."id" ORDER BY "q2"."name" ASC NULLS LAST, …
-- soft delete on user: the domain is in ON
LEFT JOIN "public"."user" AS "q1" ON ("q0"."authorId" = "q1"."id" AND "q1"."deletedAt" IS NULL)
```
MySQL: `LEFT JOIN \`node\` AS \`q1\` ON … ORDER BY (\`q2\`.\`label\` IS NULL) ASC, \`q2\`.\`label\` ASC` (pinned). Each hop drops one bound value (the `LIMIT 1`).

### B2 — a leading-key bound beside the general cursor window

**File:** `src/query-engine/raptor3/shared/query.ts`, `#cursorCondition`. The general (non-sargable) branch now returns
`lead <=|>= (SELECT lead FROM t WHERE <cursor unique> LIMIT 1) AND EXISTS(<unchanged OR-of-ANDs>)`. The direction comes from `order[0].descending`, so it is already reversed for a backward `take`. The bound is emitted only when the leading term is not nullable (`nullable` includes read-gated fields). The sargable branch is unchanged. With a missing or hidden anchor, the scalar subquery is NULL, so the comparison is unknown and the page is empty, as before. The anchor subquery reuses the same `where` (domain included). Cost: +2 bound values and about 100 bytes per cursor statement.

```
WHERE ("q0"."createdAt" <= (SELECT "q1"."createdAt" FROM "post" AS "q1" WHERE "q1"."id" = ? LIMIT ?) AND EXISTS (SELECT 1 FROM (SELECT "q1"."createdAt" AS "0viborm_cursor_0", …
```

### Equivalence (identical rows, old engine vs new)

The same script ran under the base worktree (`rbac`, 951e64998 source) and under perf-1.3.3, through the jiti alias loader `/tmp/perf133/B/load.mjs` + `/tmp/perf133/B/equiv.ts`. The fixture is 12 users (tied names, 2 soft-deleted, three orgs), 40 posts (every 7th with a NULL author, tied titles and createdAt) and 80 comments.

The run crossed:
- 25 cases: one hop asc/desc, explicit nulls first/last, same path read twice, two hops, take+skip, take<0, distinct, distinct+take<0, nested include with relation order, findFirst, count and aggregate windows, a relation filter with a relation order, and 10 cursor cases (mixed, backward, skip, nullable later key, nullable lead, missing anchor, domain anchor, hidden anchor, nested cursor, count with cursor).
- 4 clients: base, `softDelete` on user, a `rows` verb domain on user (`viewer` control), and a relational domain (user via `posts.some`, post via `author.is`, PostgreSQL shared bodies on).
- 2 providers: SQLite (better-sqlite3) and PGlite.

**Result: 200/200 cases identical, 0 errors; 120 statements used LEFT JOIN.** The test is not vacuous: base and domain results differ for every relation-order case.

### Measurements

The dataset was 2,000 users (10 % soft-deleted), 100,000 posts (every 13th with a NULL author, createdAt ties in pairs) and 100,000 comments, followed by ANALYZE. Old and new statements ran **interleaved on the same database**, median of 31 (`bench.ts`, `PRIOR=bench-old.json REPS=31`). The machine was loaded by the other groups, so absolute numbers are noisy; the ratios held across runs. PGlite EXPLAIN ANALYZE execution times are given alongside.

| case | SQLite old → new (ms) | PGlite old → new (ms) | PG EXPLAIN exec old → new |
|---|---|---|---|
| post by author.name, take 20 | 38.4 → 11.2 | 413.5 → 78.9 | 870 → 154 (SubPlan ×100k → Hash Left Join) |
| same, soft delete on user | 55.3 → 23.2 | 475.4 → 108.5 | 942 → 212 |
| same, permission domain on user | 39.7 → 22.9 | 432.8 → 87.7 | 677 → 408 |
| comment by post.author.name (2 hops) | 101.5 → 47.9 | 940.5 → 221.2 | 1982 → 444 |
| 10k-row filtered full sort, no take | 22.8 → 25.1 (3 reruns: +19 %, −10 %, −13 %: noise) | 169.5 → 133.4 | 237 → 107 |
| cursor createdAt desc, id asc at row 75k | 90.4 → 0.24 | 142.8 → 1.12 | 241.9 → 0.23 (Rows Removed 74,999 → index cond `createdAt <= InitPlan`) |
| same at row 1k | 0.62 → 0.13 | 0.96 → 0.56 | 2.47 → 0.16 |

SQLite plans: two hops `CORRELATED SCALAR SUBQUERY ×2` → `SEARCH … LEFT-JOIN ×2`; the cursor plan goes from `SCAN q0 USING COVERING INDEX post_createdAt_idx` to `SEARCH q0 USING COVERING INDEX post_createdAt_idx (createdAt<?)`. Every bench case returned identical rows old vs new.

Byte and bind counts per statement (old → new; the byte counts also include other groups' concurrent projection-alias changes): one hop 2 → 1 binds, two hops 3 → 1, cursor 3 → 5 binds and about +100 bytes.

### Tests

Added:
- `tests/contracts/engine/query/orderby-relation-depth.core.test.ts`: exact PG SQL for one hop with path reuse (one join, two terms, 0 binds), a chained two-hop join, a nested include page with its own join and distinct aliases, and the MySQL two-hop text.
- `tests/contracts/engine/query/namespace-qualification.core.test.ts`: the leading-key bound on a qualified table (`"billing"."ns_posts"`, 5 binds), and none on a nullable lead.
- `tests/contracts/drivers/behaviors/nested-orderby-behavior.ts` (SQLite: sqlite3-scalar-roundtrip; PGlite: pglite-reads; plus docker pg/mysql runners): "terms on one path share its row and two paths to one model keep their own" and "distinct keeps the first row of each group in a relation order".
- `tests/contracts/drivers/behaviors/cursor-pagination-behavior.ts` (sqlite3-index-ddl, pglite-reads): a NOT NULL lead under mixed directions, covering forward and backward pages that meet at the anchor, a short tail, and a missing anchor.

Existing coverage of "a hidden related row orders as NULL and its parent is kept": `row-scope-behavior.ts` "is, isNot and a to-one order term read the related domain" (passes on SQLite and PGlite).

No pinned SQL needed updating. No golden is affected by B1/B2: `__golden__` has no relation-order subquery or general cursor statements. `row-scopes.test.ts` W-K1e currently fails on 2 lines from another group's json_group_array/COUNT COALESCE change, not on B.

Commands (all `pnpm exec vitest run --workspace vitest.workspace.ts …`):
- g4 read-ordering/pagination/aggregates/operations, unit01 repairs/order-projection, parity-preparation/lowering, aggregate-window-sql, post-prep row-scopes: 544/544 passed (before goldens were touched by others).
- sqlite3-scalar-roundtrip, sqlite3-index-ddl, pglite-reads, namespace-qualification, write/reads: 953/953 passed.
- orderby-relation-depth, namespace-qualification, sqlite3-scalar-roundtrip, sqlite3-index-ddl after the new tests: 765/765 passed.
- pglite-reads (150), pglite-row-scopes (45), pglite-soft-delete (12): 207/207 passed.
- golden-transcript, sqlite3-permissions-{placement,app,verbs}, g4 ordering/pagination, unit01: all passed. row-scopes W-K1e: 2 failures, both from the other group (see above).
- `tsc --noEmit -p tsconfig.json`: clean for B files. The remaining errors are in `sqlite3-permissions-reuse.test.ts` and `retirement-closure.review.test.ts` (not B).
- `biome check` (read-only) on the 4 touched test files: clean.

Scripts: `/tmp/perf133/B/{load.mjs,equiv.ts,equiv-schema.ts,bench.ts,sqlshape.ts,pins.ts}`. Outputs: `out-{old,new}.json`, `bench-{old,new}.json`.

### Open risks / notes
- "Recursive relations keep the subquery" is read as: the recursive-projection walk's sibling order and grouped orders pass no join collector. A self relation (`parent.parent.label`) is joined, with distinct aliases per hop, as V1 did.
- A unique target-held key relies on the resolver's `unique` flag (the published unique index). A database whose unique index was dropped out of band could duplicate parents. The subquery's `LIMIT 1` masked that before.
- On PGlite at this scale the two-hop plan is a hash join over all comments. It is 4× faster than 100k SubPlans, but it is not a top-N index walk.
- MySQL was checked at SQL shape only (pinned). It was not executed live.

## Group C — relation predicates (perf 1.3.3)

Scratch, scripts and raw outputs: /tmp/perf133/C/ (chain.lane.ts, perm.lane.ts, cmp.mjs, print.lane.ts, out-chain-full.json, out-lite-*.json, perm-{base,merge,both}.json). The measurement toggles (`VB_FLATTEN`, `VB_MERGE`) were temporary and are removed from the source.

### C1 — `some`/`is` chains reading a row above their parent become one EXISTS over a join (SHIPPED, all dialects)

**What changed** — `src/query-engine/raptor3/shared/query.ts`
- `#lowerRelationPredicate`: a *semijoin* hop (`some`/`is` with a body, no `recurse`, a plain `reference` edge without discriminator, i.e. never junction/polymorphic/recursive) opens a frame with `joins: []`. A semijoin that is a **direct conjunct** of such a body and whose body names a row **above its parent** (`{ $row, up }` — detected by the existing frame `escaped` marks: lowering the child marks the parent frame) pushes `INNER JOIN <target> q ON <membership> AND <its related domain>` (+ its own joins) into the parent's frame and returns its body as a plain conjunct. The parent then lowers `EXISTS (SELECT 1 FROM t1 q1 INNER JOIN t2 q2 ON … WHERE …)`.
- `#apart` (used by `or`/`not` in `#lowerPredicate`): a relation under OR/NOT is not a conjunct, so it never joins.
- `#relationExists` takes the joins (inline only; such a body is escaped, so never shared — unchanged rule) and its domain lowering is factored into `#relatedWhere`; `#correlated` is the joined hop's ON. `every`/`none`/`isNot` (anti-joins) are never flattened, each hop keeps its related domain (rows/permissions/soft-delete), the orchestrator's `SharedBody.correlated` is kept.
- `LoweringFrame` interface (frames gain the optional `joins`).
- Decision: flatten only when an outer reference escapes (the measured case). "Always flatten" gave identical SQL on the measured policies, but would rewrite every chain and defeat PostgreSQL body sharing (`WITH __shared_N`), so the narrower rule is the safer one.

**Before → after (PGlite, document count, OR policy)**
```
before: … OR EXISTS (SELECT 1 FROM "org" AS "q1" WHERE ("q0"."orgId" = "q1"."id" AND EXISTS (SELECT 1 FROM "member" AS "q2" WHERE ("q1"."id" = "q2"."orgId" AND ("q2"."userId" = $2 AND CAST("q2"."role" AS TEXT) = CAST("q0"."granteeRole" AS TEXT))))))
after:  … OR EXISTS (SELECT 1 FROM "org" AS "q1" INNER JOIN "member" AS "q2" ON "q1"."id" = "q2"."orgId" WHERE ("q0"."orgId" = "q1"."id" AND ("q2"."userId" = $2 AND CAST("q2"."role" AS TEXT) = CAST("q0"."granteeRole" AS TEXT))))
```
Plan: before `SubPlan 1 -> Nested Loop Semi Join … loops=199960` (Execution 1503 ms under EXPLAIN); after `hashed SubPlan 2 -> Hash Join … loops=1` (73 ms).

**Measured** — dataset 500 orgs / 20,000 members / 200,000 documents (10% NULL `granteeRole`), user 42, policies OR = `{ OR: [{ ownerId }, { org: { is: { members: { some: { userId, role: { $row: "granteeRole", up: 2 } } } } } }] }`, AND = the chain alone. Median of 7 (PG) / 21 (SQLite) raw executions; same answers in every mode (asserted per op).

| dialect | policy | op | bytes before→after | binds | ms before → after |
|---|---|---|---|---|---|
| PGlite | OR | count | 346 → 325 | 2 | 864 → 87 |
| PGlite | OR | page of 50 | 390 → 369 | 3 | 64.8 → 6.0 |
| PGlite | AND | count | 321 → 300 | 1 | 142 → 2.3 |
| PGlite | AND | page of 50 | 365 → 344 | 2 | 49.6 → 1.4 |
| SQLite | OR | count | 347 → 326 | 2 | 53.8 → 43.6 (run 2: 54.8 → 58.9) |
| SQLite | OR | page of 50 | 398 → 377 | 3 | 4.0 → 2.8 |
| SQLite | AND | count | 323 → 302 | 1 | 24.7 → 24.4 (run 2: 68 → 40) |
| SQLite | AND | page of 50 | 374 → 353 | 2 | 2.74 → 2.80 |

SQLite is neutral-to-better (the AND page-of-50 regression of the first noisy run, 3.5 → 5.3 ms, did not reproduce with 21 reps in either mode order: 2.74 vs 2.80 / 2.76 vs 2.96). Same plan shape (correlated subquery searching `member(userId, orgId)` then org PK). So no adapter capability: applied on every dialect. MySQL not measured (no live server here); it cannot semijoin-transform a doubly nested correlated EXISTS either, so it should be equal or better — open risk, unmeasured.

### C2 — quantifiers over one relation merged (SHIPPED)

**What changed** — `query.ts`: `mergeQuantifiers(kind, arms)` + `connectiveArms`, `sameRange`, `quantifiedArms`, `disjunction`. Applied at preparation: `combine("OR")` (`sameColumnIn ?? merge ?? or`), `combine("AND")`, and `foldConditions` when a folded `and`/`or` is rebuilt (a dropped `$if` arm can bring two quantifiers together). Rules:
- OR: `some A OR some B` → `some (A OR B)`; `is A OR is B` → `is (A OR B)`.
- AND: `none A AND none B` → `none (A OR B)`; `isNot A AND isNot B` → `isNot (A OR B)`.
- Only when edge (memoized per schema, compared by identity), quantifier, `unscoped` and `closure` (depth, self) are identical and both have a body; `every` and body-less `is`/`isNot` never merge. Nested ORs (through one-member `and`s) are searched; where nothing merges the connective keeps its own structure (no SQL churn). Merged arm sits at its first member's position; bodies in arm order; the merged body is itself a `disjunction`, so it merges again (`some {name:"a"} OR some {name:"b"}` → `some (name IN …)`). Deterministic text ⇒ stable `sharedKey`s.

**Three-valued proof.** `EXISTS(q)` is two-valued. `EXISTS(S WHERE m AND A) OR EXISTS(S WHERE m AND B)` is TRUE iff some row r has `m(r) AND A(r)` TRUE or some row has `m(r) AND B(r)` TRUE, iff some row has `m(r) AND (A(r) OR B(r))` TRUE (`X OR Y` is TRUE iff X TRUE or Y TRUE, whatever the other is, NULL included) ⇒ `EXISTS(S WHERE m AND (A OR B))`. Empty relation / NULL FK: no row satisfies `m`, both sides FALSE. `none`/`isNot` are `NOT EXISTS`: `NOT E1 AND NOT E2 = NOT (E1 OR E2)` on two-valued E. The related domain (`m` includes it) and the closure walk are identical by `sameRange`.

**Before → after (PostgreSQL pin, `tests/contracts/engine/query/parity-lowering.core.test.ts`)**
```
where: { OR: [{ OR: [{ reports: { some: { name: "a" } } }, { views: 1 }] }, { reports: { some: { views: { gt: 3 } } } }] }
before: ((EXISTS (… "q1"."name" = ?) OR "q0"."views" = ?) OR EXISTS (… "q2"."views" > ?))
after:  (EXISTS (SELECT 1 FROM … AS "q1" WHERE ("q0"."id" = "q1"."managerId" AND ("q1"."name" = ? OR "q1"."views" > ?))) OR "q0"."views" = ?)
```

**Measured** — permissions acceptance policy (tests/types/permissions/acceptance-policy.ts, permissions-app fixture + soft delete), 8 workloads × actors u02/u05, fresh seeded DB per workload, SQLite + PGlite live, MySQL recorded; identical results in every workload (values and errors compared):

| dialect | bytes before → after | binds | FROM/JOIN | WITH RECURSIVE |
|---|---|---|---|---|
| PGlite | 179,978 → 158,224 (−12.1%) | 632 = | 1,654 → 1,416 (−14.4%) | 118 → 84 |
| SQLite | 268,942 → 245,514 (−8.7%) | 1,586 = | 2,260 → 1,994 (−11.8%) | 160 → 122 |
| MySQL | 282,024 → 258,638 (−8.3%) | 2,636 = | 2,222 → 1,956 (−12.0%) | 160 → 122 |

Per document read: PG P1 findMany 10,562 → 9,301 B (7 → 5 walks), P3 include-3 16,853 → 14,285 B (13 → 9); SQLite P3 37,570 → 33,877 B (24 → 18). End-to-end median of 31 calls (tiny fixture, noisy — other agents running): PGlite P3 244 → 66 ms (u02), 66 → 56 (u05), P1 60 → 19 / 96 → 24, P4 count 59 → 27 / 45 → 31; SQLite P3 13.2 → 6.0 / 14.6 → 4.1, P4 2.1 → 1.3 / 2.8 → 1.1. (Two PG cells read higher after — P8 can u05 19.5 → 35.6, P2 u05 27 → 32 — P2 is a page read whose SQL is unchanged, so this is noise of the shared machine.) C1 changes nothing on this policy (no escaping `$row` chains): "both" mode bytes identical to "merge".

### Tests added / updated
- `tests/contracts/engine/query/parity-lowering.core.test.ts`: new describe "quantifiers over one relation" (3 tests: some/is merge through nested OR; none merge and merged body → `= ANY(?)`; every / presence test / anti-join kept).
- `tests/contracts/public-client/extension-row-checks.core.test.ts`: "a semijoin chain reading a row above its parent is one EXISTS over a join, each hop under its domain" — exact SQLite SQL pin with a `member` related domain in the JOIN's ON, results before/after archiving a member, `none` not joined (results g2,g4), a chain under OR not joined (falsified: disabling `#apart` reddens it).
- `tests/contracts/engine/query/domain-predicate-behavior.ts`: oracle test "relation chains and repeated quantifiers answer as their oracle…" (2- and 4-hop `$row` chains, a hidden member on a hop, `none`, merged some / none / isNot, chain under a merged OR) — runs on SQLite (raptor3 row-scopes), PGlite, D1 and the docker pg/mysql runners.
- No pinned SQL elsewhere changed.

### Commands run (worktree /Users/arnaud/.t3/worktrees/viborm/perf-1.3.3)
- `pnpm exec vitest run --workspace vitest.workspace.ts tests/contracts/public-client/extension-row-checks.core.test.ts` → 51/51 (3 projects); after the new test `--project layer-client` 18/18.
- `… tests/contracts/engine/query/parity-lowering.core.test.ts` → 29/29.
- `… --project raptor3 tests/raptor3/post-prep/row-scopes.test.ts -t "relation chains and repeated"` → 3/3; `--project provider-pglite tests/providers/local/pglite-row-scopes.test.ts -t …` → 1/1; `tests/providers/workers/d1-domain-predicates.test.ts -t …` → 1/1.
- `… tests/providers/local/sqlite3-permissions-*.test.ts` → 25 files, 1,459 passed, 6 skipped.
- `… --project provider-pglite` pglite-permissions-{app,compiled-policy,evidence,verbs,adversarial,placement} → 446/446.
- `… extension-shared-bodies, relation-filter, recursive-query provider-sql-{sqlite,pglite}, instrumentation golden-transcript + tracer-platform-otel` → all pass (provider-sql-native needs a live pg/mysql: not run).
- `… field-reference-sql, operand-callback-sql, namespace-qualification, parity-admission, extension-relation-depth, polymorphic-collection-filter, sqlite3-recursive-filter, atomic-unit-batch, mutation-projection-cte-fold, adversarial-v1-remediation, unit/permissions/reuse` → 16 files, 502/502.
- `pnpm exec tsc --noEmit -p tsconfig.json` → no error in any file of group C (7 errors elsewhere: sqlite3-permissions-reuse.test.ts, retirement-closure.review.test.ts — not ours).
- Measurement: `cd /tmp/perf133/C && ./node_modules/.bin/vitest run --config vitest.config.ts chain.lane.ts` (env ORGS/MEMBERS/DOCS/REPS/MODES/DIALECTS) and `perm.lane.ts` once per mode, `node cmp.mjs base merge both`.

### Goldens
- `tests/raptor3/post-prep/__golden__/composed-rows-sql.json` and `tests/providers/workers/__golden__/d1-composed-rows-sql.json` currently fail (W-K1e) on COALESCE/json_group_array projection changes from another group; the diff is byte-identical with C1/C2 toggled off, so neither golden is affected by group C. Instrumentation goldens pass.

## Group D — projection / count / walk SQL trims (perf-1.3.3)

Method: an isolated A/B. `/tmp/perf133/D/before` is a snapshot of the shared worktree's `src` taken before my edits (others' work included). `/tmp/perf133/D/after` is the same snapshot plus only my patch (`/tmp/perf133/D/D-src.patch`, applied unchanged to the worktree with `patch -p1`). Both roots run the same harness (`/tmp/perf133/D/lane/`), so every delta below comes from group D alone.

### Items

### D1 — SQLite `json_group_array(json(json_object(…)))` → `json_group_array(json_object(…))`
- Files: `src/adapters/databases/sqlite/sqlite-adapter.ts` (`json.agg`), with the contract noted on `DatabaseAdapter.json.agg` (`src/adapters/database-adapter.ts`) and in `src/adapters/AGENTS.md`.
- The SQLite `agg` also drops its own `COALESCE(…, json_array())` (called D1b below). `json_group_array` over zero rows is already `[]`. Probed on better-sqlite3 (SQLite 3.53.2), libSQL (3.45.1), Bun (3.51.0) and D1 (miniflare/workerd 1.20260310).
- Subtype rule, probed on all four: `json_group_array(json_object(…))` keeps the nested JSON. `json_group_array(x)` where `x` comes from a subquery column quotes it as a string (`["{\"a\":1}"]`).
- All three engine callers of `json.agg` are safe without the old `json()`:
  - the relation page passes a `json_object` call;
  - the recursive node carrier passes a `json_object` call;
  - the recursive edge aggregate reads a subquery column, but already wraps it in `json.document`. It used to be `json(json(col))` and is now `json(col)`.
- Before: `(SELECT COALESCE(COALESCE(json_group_array(json(json_object(?, "q5"."id", …))), json_array()), json_array()) FROM …`
- After: `(SELECT json_group_array(json_object(?, "q5"."id", …)) FROM …`
- Results byte-identical (sha256 of the JSON-encoded results) on better-sqlite3 and libSQL. Cases covered:
  - 3-deep to-many include with JSON columns at every level;
  - a to-one chain over 500 rows;
  - JSON and string-list columns inside a select with a filtered `take`;
  - empty to-many plus `_count`.
- Timing: the same seeded file DB, the same raw statements, before and after run alternately in one process (`tools/bench-sqlite.cjs`, `tools/bench-libsql.mjs`):

| query (700 users / 5.6k posts / 56k comments) | result | before | after |
|---|---|---|---|
| better-sqlite3, 3-deep include | 9.4 MB | 180.9 ms | 109.0 ms (−40%) |
| better-sqlite3, JSON select | 1.7 MB | 27.3 ms | 20.3 ms (−25%) |
| better-sqlite3, 3-deep include (200 users) | 2.7 MB | 57.6 ms | 32.2 ms |
| libSQL, 3-deep include | 9.4 MB | 226.6 ms | 160.7 ms (−29%) |
| libSQL, JSON select | 1.7 MB | 124.7 ms | 91.4 ms (−27%) |
| to-one chain / empty+count | | unchanged | unchanged |

- A client-level run in separate processes showed the opposite (124 → 238 ms). That was noise from the five concurrent agents. The interleaved raw run is the measurement.

### D2 — drop `"q0"."id" AS "id"` on PostgreSQL and MySQL
- Files:
  - `src/adapters/shared/standard-sql.ts`: `createIdentifiers(quoteIdent, namespace, namesQualifiedColumns)` gets `isQualifiedColumnNamed`. The single guard sits in `identifiers.aliased`.
  - `src/sql/sql.ts`: new `Sql.leafText`, an O(1) read of a raw fragment's text that never flattens a subquery.
  - The PG and MySQL adapters pass `true`. SQLite keeps every alias.
- The alias is dropped only when the expression is a raw leaf that is exactly `<one quoted identifier>.<quoteIdent(alias)>`, with doubled-quote escapes handled. Kept in every other case: three-part names, unqualified names, wrapped or bound expressions, and a different name. A mapped column (`"post_title" AS "title"`) keeps its alias.
- Decoding: PG and MySQL drivers return object rows keyed by result column name. mysql2 refuses `rowsAsArray`. PG names an unaliased `"q0"."id"` result column `id`, and MySQL names it as written. `distinctColumnAliases`, shared CTE bodies, derived pages and the ORDER BY / GROUP BY / HAVING lowering all reference qualified columns (`"q3"."id"`), never the bare alias text. `sharedKey` is text-based, so equal bodies still share.
- Bytes, blog workload: PG 12,618 → 11,498 for D2 alone (−8.9%); MySQL 8,571 → 7,815 (−8.8%). Governed workload: PG −1,092 B (−0.8%), MySQL −1,092 B (−0.5%).

### D3 — drop the outer `COALESCE(json.agg(…), emptyArray)` (`query.ts` `#lowerRelationProjection`)
- Each adapter's `agg` really answers `[]` on zero rows. Pinned in `dialect-vocabulary.core.test.ts`:
  - PG: `COALESCE(json_agg(x), '[]'::json)`
  - MySQL: `COALESCE(JSON_ARRAYAGG(x), JSON_ARRAY())`
  - SQLite: `json_group_array(x)` (natively `[]`)
- `COALESCE(COALESCE(` count, before → after: blog 11 / 11 / 8 → 0; governed 4 → 0.

### D4 — drop `COALESCE((SELECT COUNT(*) …), $0)` (`query.ts` `#correlatedCount`)
- Its callers are the `_count` projection (plain, filtered and negated), `_count` ordering, and the variant-carrier sum of arms. Each arm is `SELECT COUNT(*) FROM <table> WHERE …` with no GROUP BY, LIMIT or HAVING, so it returns exactly one row. No grouped or limited form reaches this path, so no COALESCE was kept anywhere.
- Before: `json_build_object($1::text, COALESCE((SELECT COUNT(*) FROM "public"."posts" AS "q1" WHERE "q0"."id" = "q1"."authorId"), $2), …`
- After: `json_build_object($1::text, (SELECT COUNT(*) FROM "public"."posts" AS "q1" WHERE "q0"."id" = "q1"."authorId"), …`
- Blog workload: 3 binds fewer per dialect (171 → 168 SQLite, 170 → 167 PG, 109 → 106 MySQL).

### D5 — no `WHERE TRUE` in a recursive walk's recursive member (`query.ts` `#walk`)
- The WHERE is omitted when the walk has no depth bound and no selector. Evaluation order is unchanged (same aliases and binds).
- Governed workload `WHERE TRUE` / `WHERE 1` count: SQLite 134 → 0, PG 96 → 0, MySQL 134 → 0.

### Totals (`lane/cmp.mjs`, `lane/items.mjs`, `lane/d2bytes.mjs`)

Same results on SQLite and PGlite for every workload; MySQL is SQL capture only.

| workload, dialect | bytes before → after | change | binds before → after |
|---|---|---|---|
| blog, SQLite | 11,533 → 10,900 | −5.5% | 171 → 168 |
| blog, PG | 12,618 → 11,213 | −11.1% | 170 → 167 |
| blog, MySQL | 8,571 → 7,584 | −11.5% | 109 → 106 |
| governed, SQLite | 221,724 → 220,436 | −0.6% | 1,294 (unchanged) |
| governed, PG | 140,260 → 138,024 | −1.6% | 484 (unchanged) |
| governed, MySQL | 234,146 → 231,484 | −1.1% | 2,158 (unchanged) |

### Tests
- New: `tests/contracts/public-client/projection-trims-behavior.ts`, with runners `tests/providers/local/sqlite3-projection-trims.test.ts` and `pglite-projection-trims.test.ts`. Expected values are hand-written; the suite asserts the SQL shape per item.
  - Falsified: run against the before snapshot, all 6 fail on the SQL assertions only, with values equal.
- New adapter tests:
  - `identifier-escaping.core.test.ts`: D2 drop/keep matrix per dialect, including quote-containing names.
  - `dialect-vocabulary.core.test.ts`: `json.agg` pins for all three dialects.
- Updated pins:
  - `tests/contracts/engine/query/identifier-storage-sql.core.test.ts` (2 PG/MySQL strings).
  - `tests/raptor3/recursive-query/provider-sql-pglite.test.ts` (D2, D5).
  - `tests/raptor3/recursive-query/provider-sql-sqlite.test.ts` (D1, D5).
  - `tests/raptor3/recursive-query/provider-sql-native.test.ts` MySQL pins (D2, D5). These cannot run here (no Docker daemon). They were validated by generating the MySQL SQL through `createTestCommandEngine` with a recording MySQL driver (`lane/mysqlpins.lane.ts`): 11/11 statements match the new pins, and 7/11 differ from the old ones.

Commands (all `pnpm exec vitest run --workspace vitest.workspace.ts …`):
- `tests/contracts/engine/query/ tests/contracts/adapters/` → 79 files, 1496 passed, 40 skipped.
- The 12 targeted files (adapters ×2, identifier-storage, projection-trims ×2, provider-sql sqlite/pglite, extension row-checks / shared-bodies / relation-depth, lookup-recognizer, lateral-joins) → 18 project-files, 256 passed.
- `pglite-reads`, `pglite-permissions-app` → 218 passed. `sqlite3-permissions-app` → 152 passed. A first combined run hit a vitest worker RPC timeout under load; it passed when rerun on its own.
- Adapter coverage: `VIBORM_COVERAGE_SUBSYSTEM=adapters … --project layer-adapters --project coverage-adapter-storage --coverage` gives 100% branches. The remaining uncovered lines are not mine: `standard-sql.ts` 246 and 255–258 (`rowValues` / `unionTypedRows`) and 368 (the `NOT MATERIALIZED` arm).
- `tsc` over my changed src and test files: clean. Biome check (read-only) on my files: clean.

### Goldens affected

The orchestrator re-recorded both. In each, only these trims changed: `composed-rows-sql.json` (3 lines) and two calls of `d1-composed-rows-sql.json`, compared after the test's own derived-table unwrapping.
- `tests/raptor3/post-prep/__golden__/composed-rows-sql.json` (SQLite: D1/D1b, D3, D4).
- `tests/providers/workers/__golden__/d1-composed-rows-sql.json` (D1: D1/D1b, D3, D4).
- `tests/unit/instrumentation/__golden__/transcript.json`: none of the patterns appear.

### Risks
- D2 and D4 on live MySQL/Vitess are unverified here (Docker daemon down). They rely on mysql2 keying rows by the result `name`, which is the select text, not `org_name`. CI's mysql2 and provider-sql-native lanes must run.
- `json.agg` on SQLite now needs a JSON-subtyped argument. That is documented on the interface; all current callers comply.

## Group E — runtime, bundle, permissions (perf-1.3.3)

Worktree: /Users/arnaud/.t3/worktrees/viborm/perf-1.3.3 (uncommitted).
Measurement isolation: every runtime/bundle number compares HEAD (951e64998,
copy at /tmp/vb-runtime-lane/base) against a copy of HEAD carrying ONLY group
E's files (/tmp/perf133/E/tree-e = E1–E4, /tmp/perf133/E/tree-ef = all of E,
query.ts with only the jsonValue hunk), so other groups' edits do not leak in.

Runtime harness: /tmp/perf133/E/lab.mjs (copy of /tmp/vb-runtime-lane/lab.mjs,
plus `ALLOCN` env to shrink the bytes window so no GC lands in it), dists built
from source with esbuild (`/tmp/perf133/E/build-dist.mjs <root> <out>`),
interleaved base/E runs, medians (`/tmp/perf133/E/bench.sh <rounds> <lab args>`).
Machine heavily loaded: bytes/op is the reliable signal, µs/op indicative.

### E1. Permissions: per-config memo of the methods step's action check

Files: src/permissions/index.ts.
- `preparedFor(schema)` is the one revision check (declarationRevision over
  [config, schema]); `apply` (= `$extends(policy)`) uses it once for both steps.
- `Prepared.actions` caches `evidenceOf(config, model).names` for every listed
  model (the actionsOf + edit-distance typo check) on the prepared entry; a
  mutated config fails `current()`, so a new entry is built and re-checked.
  `policy.methods(client)` alone reuses the entry only when it is current.
- Typo errors still surface at the first `$extends` of a config (and at every
  later one until fixed: a throwing check never caches).

Measured (`--workload unique --mode client --perm`, fresh `$extends(policy).$as(actor)` + findUnique per op, 9 interleaved runs):
- base 357.6 µs/op, 367,889 B/op → E 121.0 µs/op, 199,855 B/op (−66 % µs, −46 % bytes).
  (E1–E4-only dist, 7 runs: 381.0 → 211.6 KB/op.)

Test: tests/providers/local/sqlite3-permissions-reuse.test.ts
"can and assert answer the actions of the declaration as each application found it"
(action added later answered only by the next application; a typo introduced
later refused at every `$extends` and by `policy.methods`; fixed declaration
answered). Falsified: a memo that never invalidates fails it ("The publish on post is not permitted").

### E2. Result decoding

(a) `jsonValue` (src/query-engine/raptor3/shared/query.ts, only that function and
`#enterJsonContainer`): `Object.keys` + plain assignment; `Object.defineProperty`
only for keys `in Object.prototype` (`__proto__`, and anything a hardened
prototype would refuse); cycle path is an array stack (push/pop/includes)
instead of a Set per document.

(b) `decodeProviderTimestamp` (src/validation/primitives/datetime-physical-codec.ts):
`decodeCanonicalTimestamp` reads `YYYY-MM-DDTHH:MM:SS.sssZ` by char codes with
the same validators (isGregorianCalendarDate, isDateTimeClock,
isDateTimeInstant) and `Date.UTC`; years < 100 and every other spelling fall
back to the regex.

Measured (`--workload rows100 --mode warm`, 100 posts with json + 1 datetime, ALLOCN=10, 9 runs):
- base 292.3 µs/op, 298,756 B/op → E 230.5 µs/op, 215,171 B/op (−21 % µs, −28 % bytes).
- `include` workload (5 runs): 251,968 → 204,401 B/op (µs too noisy: 755 vs 840, overlapping ranges).

Tests:
- tests/unit/validation/datetime-physical-codec.core.test.ts: +21 canonical
  cases each compared with the same instant through the general grammar
  (space separator): valid, hour 24, minute/second 60, Feb 29 in 2024/2000
  (leap) and 2023/1900 (not), Feb 30, Apr 31, month 00/13, day 00, years
  0000/0004/0099/0100/9999, non-digits, a sign; +7 near-canonical spellings
  (no millis, 1 and 6 fraction digits, +01:00, -0130, no zone, year 0050 with
  +00) that take the regex. Falsified (fast path ms+1): 5 cases fail.
- tests/raptor3/recursive-query/carrier-boundary.test.ts: indirect cycle through
  a list refused; new test: own `__proto__`/`constructor`/`toString`/
  `hasOwnProperty` keys stay own keys (prototype unpolluted), shared container
  repeated at two depths is copied. Falsified (`if (false)` instead of the
  prototype check): fails.

### E3. Lazy query-interceptor input

Files: src/query-engine/pending-operation.ts (`#queryContext`: `input` getter,
memoized `snapshotQueryInput`), src/extensions/query.ts (`exposeHandlerContext`:
`input` getter reading through). One snapshot object per chain, shared by every
handler and read; `Object.keys(context)` unchanged
(`mode, kind, model, operation, input, proceed, onWriteOutcome`); the context is
still frozen (the property is an accessor now, not a data property).

Semantics check:
- The engine never writes the prepared payload: /tmp/perf133/E/e3probe2.mts runs
  10 operations (nested create, update with nested create+updateMany, two
  upserts, updateMany, createMany, findMany+include, deleteMany, array
  $transaction) once reading `input` before `proceed()` and once only after;
  normalized (ULIDs/ISO stamps) snapshots are identical (10/10).
- One observable difference: a caller-owned `Uint8Array` (blob) is borrowed by
  admission. If the caller mutates it after starting the call and an
  interceptor first reads `input` after an `await`, the snapshot now shows the
  mutated bytes — which is what the database received; HEAD showed the
  pre-mutation bytes while the database received the mutated ones
  (/tmp/perf133/E/e3probe.mts: HEAD late-read [9,9] vs db [7,9]; E [7,9] vs db [7,9]).
  JSON and Date values are copied by admission and are unaffected.

Measured (`--workload updateMany --mode warm --perm`, 9 runs; E3 is the only
item on this path except E5(b)'s upsert branch, which does not run here):
- base 42.8 µs/op, 55,463 B/op → E 39.4 µs/op, 50,322 B/op (−9 % bytes).
  (Lower than the earlier 56–58 → 47 KB estimate.)

Test: tests/contracts/public-client/query-interceptors-integration.core.test.ts
"snapshots input once for the chain, at its first read, the same before and after proceed".

### E4. `allRules` is a function

Files: src/schema/validation/rules/index.ts (`export function allRules()`),
callers src/schema/validation/validator.ts (3), src/migrations/push-v1.ts,
tests/unit/schema-validation/decimal-foreign-key-domain.core.test.ts.
(`allRules` is not a public export; src/schema/validation/index.ts re-exports the function.)

Measured: tsdown dists of the app entries (minify, as the package) built into
/tmp (`/tmp/perf133/E/mk-tsd.mjs` + `node node_modules/tsdown/dist/run.mjs --config …`),
then the size-limit-style fixtures bundled with esbuild (`/tmp/perf133/E/bundle-dist.mjs`), gzip -9:

| fixture | HEAD | E4 only | all of E |
|---|---|---|---|
| pg-representative | 183,501 | 181,839 (−1,662) | 182,268 (−1,233) |
| d1-worker | 182,793 | 181,143 (−1,650) | 181,590 (−1,203) |
| pg-permissions | 195,748 | 194,076 (−1,672) | 194,766 (−982) |

(Measured before the E5(b) rework, which moved the upsert check into core. The rest of E adds ~+430 B gzip to the pg app: the canonical timestamp reader,
the refusal reason, the upsert check.) Bundling from src (not dist) shows no
delta: the spread only survives inside a prebuilt chunk. `pnpm package:build` +
size-limit was NOT run in the shared worktree (it would mix in A–D's changes);
the orchestrator's final gate run will show the combined number.

### E5. Permissions correctness and guide

(a) distinct/groupBy over a read-gated field — docs/content/docs/extensions/permissions.mdx §5:
replaced "Rows are never dropped because of it" with what happens: the field
reads NULL in where/orderBy/cursors/distinct/groupBy/aggregates; `count`/
`findMany` keep the row; `{gt:5}` excludes, `null` matches, `distinct` keeps
one, `groupBy` merges into one `null` group, `_sum/_count` skip; how to avoid.
Probe /tmp/perf133/E/p1b.mts (4 rows): findMany 4, where gt [] , where null 4,
distinct 1, groupBy [{budget:null,_count:4}], aggregate _count 0.
Test: sqlite3-permissions-extends "a read-gated field reads NULL where withheld: distinct and groupBy over it merge rows".

(b) upsert without the update action — REWORKED after orchestrator review (the
first version's up-front refusal is removed; src/permissions/index.ts now carries
only E1). The upsert runs as before; src/query-engine/raptor3/commands/commands.ts
`#foundUnwritable` wraps both root-upsert plans (folded and conditional) when a
rows layer's `update` predicate for the model matches nothing (`{ OR: [] }`, what
an undeclared/false update compiles to): a `UniqueConstraintError` whose violated
constraint is the key `where` located by — SQLite `meta.columns` equal to the
key's columns; PostgreSQL `meta.constraint` equal to `<table>_pkey` /
`<table>_<field|compound>_key` (the migrations' names) — is rethrown as
`ForbiddenError(model, "update", { reason: "the row this upsert locates exists", cause })`.
Anything else (another key, a provider that reports neither, an identifier PG
truncated) keeps the original error. `ForbiddenError` gained a `cause` option
(src/errors/query.ts); as for every VibORM error the cause is the sanitized copy
(code V3001 kept, class `Error`).
Missing row → created (writing or empty update arm); `update: {}` unchanged.
Limitation: when the create collides on several unique keys, the provider reports
one (SQLite reported `slug` for an `id`+`slug` collision), so such an upsert keeps
the UniqueConstraintError.
Message: `The update on tag is not permitted: the row this upsert locates exists`.
Test: tests/contracts/public-client/permissions-upsert-behavior.ts, run from
tests/providers/local/sqlite3-permissions-extends.test.ts (SQLite3) and
tests/providers/local/pglite-permissions-entry.test.ts (PGlite): existing row by
id and by a unique field → ForbiddenError + cause code V3001; missing row with a
writing arm → created; `update: {}` on an existing row → returned; a create
colliding on another key → UniqueConstraintError.
`-t "upsert onto an existing row"`: 4 passed (SQLite3 ×3 projects, PGlite).
Falsified: wrapper disabled → 4 failed; constraint match forced true → 3 failed.
Guide: the "What each call sends" paragraph and the errors table describe this.

(c) refusal reason — the engine names the moved fields a root update writes:
src/errors/query.ts (`ForbiddenError` option `reason`, appended to the message),
src/query-engine/types.ts (`PreparedGuardFailure.reason`),
src/query-engine/batch-error-attribution.ts (passes it; guard agreement compares it),
src/query-engine/raptor3/shared/operation-context.ts (`#updateRefusal`, used by
`update` and `updateMany` judged statements: written fields that a rows layer's
`moves` judges again, and the relations whose key holds them).
Before: `The update on post is not permitted`. After:
`The update on post is not permitted: the row it would leave, judged again because it writes authorId (through author), is refused`.
Guide (Writes, in detail) explains it is the `create` rule reading `authorId`.
Outside the listed files (core error/engine), touched minimally; no SQL change.
Test: sqlite3-permissions-extends "a refused new row names the key an update writes through a nested to-one delete" (+ a direct `authorId: null` write). Falsified.

(d) guide fixes (permissions.mdx): Size section no longer claims "built only
from public extension capabilities" (compiling reads schema declarations through
the internal accessors); `{ $row, up }` across a polymorphic relation or naming
an incomparable column → new errors-table row (`UnsupportedOperationError` at the
first call; `policy.compile` does not check it) and the `$row` paragraph;
existence leaks now include an update writing a unique value a hidden row holds
(errors table + Boundaries). Also the upsert rule in "What each call sends" and
the errors table. src/permissions/index.ts header comment fixed;
tsdown.config.ts:74 still says "built from public capabilities only" (not my file).

### Commands run (all passed)

- `pnpm exec vitest run --workspace vitest.workspace.ts tests/unit/validation/datetime-physical-codec.core.test.ts` → 52 passed
- `… tests/raptor3/recursive-query/carrier-boundary.test.ts tests/raptor3/result-decoder-placements.test.ts` → 4 files, 52 passed
- `… tests/contracts/public-client/query-interceptors-integration.core.test.ts tests/contracts/public-client/query-interceptors.core.test.ts tests/contracts/public-client/query-interceptors-array.core.test.ts tests/contracts/engine/query/query-inspection.core.test.ts` → 10 files, 449 passed
- `… tests/unit/schema-validation/{decimal-foreign-key-domain,validate,model-rules}.core.test.ts` → 90 passed
- `… tests/unit/permissions/ tests/contracts/public-client/extension-*.core.test.ts tests/contracts/adapters/assertion-holds.core.test.ts tests/contracts/engine/query/batch-attribution-hazard-signature.core.test.ts tests/contracts/drivers/error-mapping.core.test.ts tests/contracts/public-client/errors/ tests/contracts/public-client/public-runtime-surface.core.test.ts tests/providers/local/sqlite3-permissions-*.test.ts` → 108 files, 3085 passed, 10 skipped
- `… tests/providers/local/sqlite3-permissions-extends.test.ts tests/contracts/public-client/extension-produced.core.test.ts tests/contracts/public-client/extension-verbs.core.test.ts` (after the last edit) → 10 files, 453 passed
- `… tests/providers/local/pglite-permissions-entry.test.ts pglite-permissions-verbs.test.ts pglite-permissions-placement.test.ts pglite-produced-rows.test.ts` → 4 files, 131 passed
- `… tests/providers/local/pglite-permissions-{adversarial,app,compiled-policy,evidence}.test.ts` → 4 files, 421 passed
- After the rework: `… retirement-closure.review.test.ts tests/unit/permissions/ tests/contracts/public-client/extension-*.core.test.ts tests/contracts/engine/query/batch-attribution-hazard-signature.core.test.ts tests/contracts/public-client/errors/ tests/providers/local/sqlite3-permissions-*.test.ts` → 102 files, 2930 passed, 10 skipped
- tsc errors reported by the orchestrator: both were mine. sqlite3-permissions-reuse.test.ts (my E1 test's loose config typing; fixed earlier) and retirement-closure.review.test.ts:207 (the D-15 type anchor pins `PreparedBatchGuard["failure"]` to the base shape; E5(c) added `reason`). The anchor now pins the base shape without `reason` plus `reason: string | undefined`.
- Type check of every changed source + test file (and their graph):
  `node node_modules/typescript-native/bin/tsc -p /tmp/perf133/E/tsconfig.check.json` → 0 errors.

Goldens: none affected (no SQL text changes; no golden contains the changed messages).
