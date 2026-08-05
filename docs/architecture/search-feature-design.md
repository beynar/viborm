# Full-Text Search — Design

**Date:** 2026-07-28 (rev 3 — post adversarial review)
**Status:** design; not scheduled, not implemented.
**Execution:** phased plan with units of work and acceptance gates: [search-implementation-plan.md](search-implementation-plan.md). This document is normative for the CONTRACT (tiers, semantics, caveats); the plan's §0 chooses minimal-LOC physical shapes that satisfy it (trigger-computed columns instead of generated columns; query-compiled composites on PG/FTS5 with the combined-vector column as a later opt-in optimization; engine-owned-only trigger machinery). Where physical descriptions in §3 differ from the plan's §0, **§0 governs the implementation**; where contract semantics differ, this document wins.
**Decisions made by the maintainer are marked ✦.**
**Rev 3 provenance:** two independent adversarial reviews (prior-art/design + database-capability), the latter with live experiments on PG 16.14, MySQL 8.4.10 (the project's containers) and SQLite 3.51/FTS5. Two rev-2 Tier-1 claims were falsified and are corrected here (§3.2, §3.3); several sections are new (§4.1 write cost, §4.2 replication, §5.1 scale envelope).

## 1. Positioning

viborm search is a **real middle ground between raw database filtering and a dedicated search engine**: typed search documents, per-field and composite queries, filters, facet counts — with **committed-read consistency**: the index is updated in the same transaction as the data, so there is **no post-commit lag**, ever, including for raw SQL and external writers. (Precision forced by review: on MySQL, InnoDB FULLTEXT search sees only *committed* data — a `MATCH` inside the writing transaction does not see its own uncommitted write. The honest cross-engine claim is "never stale after commit", not "read-your-writes in-transaction"; see Tier 2.)

**Scale envelope (stated, not discovered):** GROUP BY faceting and tsvector-class ranking degrade at large match sets — industry measurements put order-of-magnitude penalties on manual SQL faceting in the tens-of-millions-row class. This feature targets corpora up to roughly the **10⁵–10⁶-row match-set** class. Beyond that, a dedicated engine is the right tool, and the docs say so.

**What it deliberately does not compete on**: typo tolerance / fuzzy (FTS5's trigram and MySQL's ngram tokenizers exist but nothing *portable*), synonyms, learned ranking, extreme-scale latency.

## 2. Why this shape (unchanged by review — both decisions survived attack)

**Derived table, not "materialized view".** PG matviews: no incremental refresh in core, triggers on matviews forbidden (verified), `REFRESH` locking, `pg_ivm` is an extension. MySQL: no matviews. FTS5 *is* natively a derived-table shape. The trigger-synced real table is a hand-maintained incremental materialized view — the only form on all three engines.

**Dedicated operation, not a findMany param.** `findMany` carries the interop promise; search cannot satisfy it for ordering. Review confirmed the cautionary tale in detail: Prisma's in-findMany `search` diverged per dialect in query *language* and match sets, spent years in preview, and split into per-dialect flags in 6.0. House precedents: `exist`, vector `_distance`.

**Triggers, not engine write-through.** ✦ Survives review with credit: the callback-based prior art (Rails pg_search) documents exactly the desync holes triggers close (`update_all`, raw writes). Costs now priced in §4.1–4.2.

**Structured per-field queries, not string grammar.** Also kills Prisma's per-dialect query-language divergence at the type level.

## 3. The search document

```ts
const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    content: s.string(),
    category: s.string(),
    price: s.int(),
  })
  .search({
    fields: { title: { weight: 2 }, content: true },  // searchable fields; keys typed from the model state
    composites: { text: ["title", "content"] },       // members typed against THIS literal's fields keys; $all = implicit composite of ALL fields
    attributes: ["category", "price"],                // filterable/facetable
    name: "post_search",                              // optional
    using: pgroonga(),                                // optional: ONE dialect-scoped implementation override (§3.4)
  });
```

**A model method with an object config** ✦ (the third and final shape — the journey is instructive: rev 3 used a standalone `s.searchIndex(() => post, {…})` object; a chainable standalone builder replaced it for house-style consistency; the maintainer then observed the model-method form beats both). Why it wins: (1) **it dissolves the registration problem** — the standalone forms needed the search index registered somewhere (`createClient({ schema })`? a separate list? — never specified, missed by both reviews); as a model method the index rides the model into the schema with zero extra surface. (2) It matches the house precedent exactly — `.index()`/`.unique()` also declare physical artifacts on the model. (3) It is the CHEAPEST form (one method + config validation; no new builder class — plan §0 L8). Typing is the proven `.omit()` pattern: config keys typed against the model state, and `composites` members typed against the SAME literal's `fields` keys (intra-literal dependent typing, the `createClient` schema→omit inference trick). One search index per model in v1 (a second `.search()` call is a compile+validation error).

**Eligibility is enforced in the types, not just validation — each position completes ONLY the model fields that can legally enter the index:**

| Position | Eligible | Excluded (compile error, not just runtime) |
|---|---|---|
| `fields` keys | non-list **string** scalars | relations, every non-string scalar (int/float/bigint/decimal/boolean/enum/datetime/date/time/json/blob/point/vector), list fields, model-`.omit()`ed fields |
| `composites` members | **keys of THIS literal's `fields` property** (intra-literal dependent typing) — naming an undeclared field cannot compile; composite names must not collide with field names, and `$all` is reserved | anything not in `fields` |
| `attributes` entries | non-list scalars of filterable types: string, enum, int, float, bigint, decimal, boolean, datetime, date, time | relations, json, blob, **list fields** (list-valued facets are fast-follow — accepting the column now would be accept-and-ignore), **point and vector** (DESIGNED fast-follows, not holes — see the roadmap note below the tiers), model-`.omit()`ed fields |

**Model-`.omit()`ed fields are excluded from BOTH positions** (doctrine): a field omitted at the model level is a secret; letting it enter the search document would leak it through matching (`query` probing) even if never projected. The exclusion is type-level AND mirrored by a schema-validation rule (types can be bypassed with `as`; validation cannot be).

| | PostgreSQL (≥12) | MySQL (≥8.0) | SQLite (≥3.9 + FTS5) / D1 |
|---|---|---|---|
| Table | real table: surrogate key + normalized field columns + one plain `tsvector` column per field, **trigger-written** (plan §0 L2 — no generated-column machinery); **no per-composite column** (plan §0 L3 — composites query-compile; a combined vector is a later opt-in optimization) | real table: PK + normalized field columns (`utf8mb4_0900_as_ci`) + **`_bin` attribute columns** | FTS5 external-content over a viborm-managed sibling with an **explicit INTEGER surrogate key** + attribute storage |
| Text index | GIN per tsvector | `FULLTEXT` per field + per composite (all columns of one index share charset/collation — DDL invariant) | FTS5 columns (composites via inline column filters — no extra index) |
| Attribute indexes | btree | btree | btree |

**Version floors (review-derived, normative):** MySQL ≥ 8.0 — **MariaDB is not supported** (no `JSON_TABLE` < 10.6, 0900-collation aliases only ≥ 11.4.5); PG ≥ 12; the trigger bodies and backfill always use the **2-argument `to_tsvector('simple', …)`** (determinism pin — the 1-arg form depends on session config; and should a generated-column form ever be adopted, PG 18 defaults generated columns to VIRTUAL, so `STORED` must be spelled); SQLite ≥ 3.9 with `SQLITE_ENABLE_FTS5` **checked at capability time** (it is a compile flag, not a guarantee), ≥ 3.38 for JSON facet aggregation.

### 3.1 SQLite key mapping (review finding — was a silent fault)

FTS5 external content keys on an **integer rowid**; viborm's house norm is string PKs, and SQLite's *implicit* rowid is not stable (VACUUM renumbers; viborm's own rebuild migration renumbers). Therefore the SQLite search table carries a **viborm-managed integer surrogate** with a `main_pk` unique mapping — never the implicit rowid — and the rebuild migration **forces a resync** in addition to re-emitting triggers. External-content desync on FTS5 is *silent corruption* (`SQLITE_CORRUPT_VTAB`, surfaced only by `integrity-check`), so `resync` on SQLite is the FTS5 `'rebuild'` command, and its severity is documented.

### 3.2 The normalization subsystem (rev-3 correction — the former "identical match set" claim was unimplementable as written)

Review demonstrated that the three engines' **tokenizers** disagree beyond the rev-2 caveats: MySQL treats `_` and inner apostrophes as word characters and its default stopword list is not English-only (`com`, `de`, `en`, `la`, `und`, `www`, `i` — it kills TLDs and French/Spanish articles); PG's default **parser** (which the `simple` *config* does not control — config swaps dictionaries, not the parser) emits email/URL/float/compound tokens (`a@b.com`, `3.14`, `foo-bar` are single tokens); FTS5 splits all of these. Measured: the queries `com`, `07`, `14`, `var` produced **three different answer sets** across the engines on one document.

The fix is that viborm owns tokenization — **"word" is defined by viborm, not by the engines**:

1. **Pinned tokenizer contract:** a word is a maximal run of Unicode letters and digits; every other character is a separator; case-folded; accents kept. (NFC normalization policy: open item.)
2. **Pre-normalization at index time:** the search table stores *normalized* text — punctuation-to-space substitution applied in the PG generated expression (regexp), in the MySQL trigger bodies (shadow normalized columns), and via pinned FTS5 tokenizer arguments. The engines then tokenize text that has only one possible tokenization.
3. **MySQL stopwords are eliminated, not warned:** `innodb_ft_enable_stopword` is session-scoped and dynamic — the derived index is **built stopword-free** (review upgraded this from Tier-2 caveat to Tier-1 fact). Min token size remains global-only → stays Tier 2.
4. **Query-side:** the library normalizes queries with the identical tokenizer before compiling; the highlighter (§5.3) uses the same tokenizer with an offset map back to the raw stored text.

With §3.2 in place, match-set equality becomes an engineered property with one residual caveat (MySQL min token size). Without it, it was aspiration — this subsystem is a **precondition, not an optimization**.

### 3.3 Composites and phrases (rev-3 correction — the PG "position gap" does not exist)

Composite semantics (and `$all`): **each term must appear in at least one of the composite's fields** — document-level AND. Verified native on MySQL (multi-column boolean `+x +y`) and FTS5 (bare multi-term); on PG compiled per term as AND over (OR across the per-field vectors) — plan §0 L3; a combined vector is a later opt-in optimization, not the mechanism.

**The rev-2 phrase mechanism was fiction:** `tsvector || tsvector` makes the two fields exactly **adjacent** (verified: `'world':2A 'goodbye':3B`, and `world <-> goodbye` matches). There is no reliable gap (filler-lexeme tricks die at the 16383 position clamp). Corrected mechanism: **on PG, phrases (like all composite matching under plan §0 L3) compile against the per-field vectors** (OR across fields), which enforces the phrase-boundary rule structurally. On MySQL the no-span behavior is real but *undocumented* (positions share one cross-column space; the `@distance` operator DOES cross the boundary and is never exposed) — the rule is therefore pinned as conformance-verified observed behavior. FTS5 is structurally per-column.

**PG phrase length bound (review):** positions clamp at 16383, so phrase operators are unreliable past ~16k words per field on PG only. Documented bound; fields longer than the indexing cap (§4.1) don't reach it.

### 3.4 Database-specific implementations (`using`) — the extension contract

PostgreSQL and MySQL have rich extension ecosystems (PGroonga, pg_trgm, ngram parsers, …). The declaration accepts **one** optional `using` override — a `SearchImplementation` produced by a factory (`pgroonga()`, `mysqlFullText({ parser: "ngram" })`). Contract:

- **Singular and dialect-scoped, never a map.** The override applies only when the schema is bound to the implementation's dialect; anywhere else it emits ONE warning per schema binding (the instrumentation warning channel, never per query) and the active dialect's built-in stays in force for both migrations and queries. So `using: pgroonga()` in the schema does not break dev-on-SQLite.
- **One seam.** An implementation compiles (pure, deterministic, no SQL execution) to an immutable `SearchProgram` carrying a manifest fingerprint, a declarative deployment, a match/rank compiler — and optionally a highlighter (§5.3). Migrations and queries consume the SAME program, so index shape and query behavior cannot diverge. No driver overrides, no arbitrary SQL callbacks, no separate DDL/query hooks. A fingerprint change (options, revision, dialect, analysis) recreates the managed artifacts and backfills, visibly.
- **The `analysis` bit — "portable" | "custom"** ✦: the one thing an implementation must declare is whether it consumes viborm's normalized document + query contract (§3.2) and therefore returns THE SAME ROWS as the built-ins. `"portable"` (e.g. PGroonga configured with TokenDelimit over the normalized document) = enters the Tier-1 same-rows conformance suite — the suite is the enforcement of the promise — and the dev/prod hit-parity claim holds through the override. `"custom"` (e.g. an ngram parser: matches fragments, different rows by design) = excluded from cross-dialect equality, documented as dialect-specific search. Factories derive the bit from their options — `mysqlFullText({ parser: "ngram" })` IS custom; users never hand-declare it on presets. This bit exists for exactly two things: conformance-suite membership and what the docs may claim. Nothing else hangs off it (highlighting is a separate capability, §5.3).
- **Extension requirements are declared, never installed.** `pgroonga()` declares `pgroonga >= x.y` with a `mustExist` policy — viborm never runs `CREATE EXTENSION`; a missing requirement refuses before the first migration statement. Extension installation is infrastructure ownership (the pgvector precedent).
- **Built-in revision discipline** ✦: the built-ins live behind the same seam with their own revisions; a built-in revision bump forces every user's search table to recreate+backfill on next push, so revisions bump ONLY on semantics-affecting changes, and a bump is a named breaking-change event (changelog + a visible plan-step note) — never a side effect of a refactor.

## 4. Sync: triggers

Three `AFTER INSERT/UPDATE/DELETE FOR EACH ROW` triggers per indexed model (PG: function+trigger; MySQL/SQLite: single objects), deterministic bodies, `viborm_search_` prefix, skip-if-unchanged conditions, FTS5 `'delete'`-command form. All engines fire them in the writing transaction.

Named holes and requirements:
1. **MySQL `TRUNCATE`**: no triggers fire, uncatchable → `resync`. PG: statement-level TRUNCATE trigger (verified). SQLite: safe (truncate optimization self-disables; verified).
2. **SQLite rebuild migration**: re-emits triggers **and forces resync** (§3.1).
3. **MySQL trigger privileges (review-corrected, version-aware):** `log_bin_trust_function_creators` is **deprecated since 8.0.34**; the modern requirement is the **`SET_ANY_DEFINER`** privilege (8.4/9.x; `SET_USER_ID` in late 8.0). The named error names the right knob per server version.
4. **PlanetScale (review-resolved):** the probe's answer **today is refusal** — Vitess supports no stored routines. Search is a typed refusal on PlanetScale MySQL. (PlanetScale-for-Postgres is a different product with trigger support — footnote, not a promise.)
5. **Bulk writes**: row triggers fire per row; documented.

**Backfill**: emitted in the creating migration, **loaded before index creation** (INSERT-then-index, not into live indexes); at large volume this is a long migration — the plan step says so. **`resync`**: full re-derivation; on SQLite the FTS5 `'rebuild'`; lock/time profile documented per dialect. `push --dry-run` shows all trigger DDL.

### 4.1 Write-path cost and limits (new — review: "priced at zero" was a defect)

- **Storage**: the search table duplicates all searchable text (PG/MySQL). Stated cost of the feature.
- **Per-write cost**: trigger dispatch + one row write + per-field/per-composite tsvector computations and GIN insertions (PG) / FULLTEXT maintenance with commit-time token processing (MySQL) / FTS5 insertions — inside the user's transaction. **A/B write benchmarks per dialect are a precondition gate** for this feature (the house PERF standard), not an afterthought.
- **PG GIN pending lists**: `fastupdate` defers cost, then an unlucky writer pays the flush (documented production p99 spikes). The design ships a stance: explicit `gin_pending_list_limit` guidance + autovacuum notes in the docs, and the benchmark gate measures the flush profile.
- **PG hard caps**: tsvector ≤ 1MB, lexeme ≤ 2KB, 256 positions/lexeme. **Policy (pinned): a user's write must never fail because of search indexing** — indexed text is truncated at a documented, configurable per-field cap (default well under the PG limits), with a `push`-time note. Truncation, not write failure.
- **Index lifecycle (new)**: MySQL deleted rows accumulate in `INNODB_FT_DELETED` until `OPTIMIZE TABLE` (with `innodb_optimize_fulltext_only`) — a maintenance op viborm documents and exposes; FTS5 needs `automerge` defaults + periodic `'optimize'` — same treatment; PG pending-list cleanup rides autovacuum.

### 4.2 Replication and CDC (new — was absent)

- **PG logical replication**: subscribers apply with triggers disabled (`session_replication_role = replica`) — a publication carrying only the main tables yields a **silently desynced** search table on subscribers. Guidance shipped with the feature: include `viborm_search_*` tables in publications (search rows replicate as data), do **not** enable the triggers on subscribers; the failure mode is named in the docs.
- **MySQL row-based replication**: verified fine — trigger effects replicate as rows, triggers don't re-fire on replicas. (Statement-based replication nuance documented.)
- **CDC consumers** (Debezium-class) will see `viborm_search_*` churn: payload amplification and duplicated text (PII) in the change stream — named in the docs with a filter recommendation.

## 5. Query surface

```ts
const r = await client.post.search({
  // query: "typescript"  — string shorthand, desugared BY VALIDATION to { $all: "typescript" }
  // (a transform at the parse boundary, house pattern: the engine only ever sees the object form)
  query: {
    $all: "typescript",           // each term in ≥1 field (document-level AND)
    text: "engine internals",     // named composite
    title: '"type inference"',    // per-field; phrases compile per-field on PG (§3.3)
  },
  filter: { category: { in: ["orm", "db"] }, price: { lt: 100 } },   // attributes (index-local, `_bin` semantics)
  where: { author: { is: { active: true } } },                        // main table (full surface, joined by PK)
  facets: {
    category: true,
    price: { ranges: [{ to: 50 }, { from: 50, to: 100 }, { from: 100 }], stats: true },
    authorId: { limit: 20, disjunctive: true },
  },
  orderBy: "_rank",               // DEFAULT when omitted: "_rank" (dialect-owned order, PK tie-break)
                                  // or attribute sorts (portable, deterministic, cursor-able)
  highlight: true,                // library-computed (§5.3)
  select: { id: true, title: true, publishedAt: true },
  include: {                      // FULL read projection surface — any depth
    author: { select: { name: true } },
    tags: { take: 5, orderBy: { name: "asc" } },
    _count: { select: { comments: true } },
  },
  take: 20, skip: 0,
});
// r.hits (+ _rank opaque, + _highlights), r.total, r.facets
```

- **Defaults doctrine** (✦, generalizing the Tier-4 rule): a default is legitimate when it lives in a presentation or dialect-owned dimension (ordering, page shape) or matches the universal expectation with guards; a default that silently ALTERS THE MATCH SET or hides computation is forbidden. Applied: `_rank` ordering defaults (dialect-owned dimension); Algolia-style `prefixLast` (last word auto-prefixed) is REJECTED as a default — it changes the match set — and may only ever ship as an explicit opt-in.
- **`total` is not computed unless asked** (fixes a rev-3 inconsistency): it is returned when facets are present (it rides the facet statement for free) or when `total: true` is passed; otherwise absent — so a facet-less search is genuinely ONE statement. Precedent: `findMany` returns no total; `count()` is a separate ask.
- **`highlight: true` computes highlights for whichever searchable fields ARE in the projection; none projected → `_highlights` is simply empty** ✦ (maintainer decision, reversing the earlier loud-error stance). Legal under the defaults doctrine: highlighting's entire effect is decorative — ignoring it alters no match set, loses no data, and empty highlights are a truthful answer for a projection containing nothing highlightable. Documented on the highlight page; projection is never auto-widened.
- **Facet top-N default is 10** (pinned number, per-facet `limit` overrides).
- **`take` omitted returns all matches** — findMany consistency: no hidden truncation. Documented next to the scale envelope.
- **`orderBy` defaults to `"_rank"` when omitted** ✦ (maintainer decision, reversing the reviewer's required-explicit hardening). Rationale: `findMany` already ships a non-portable default order (no `orderBy` = unspecified engine order) without requiring the argument — search being stricter would be inconsistent, and its default is MORE deterministic (rank + PK tie-break). Relevance order is the universal expectation of a search operation; spelling it adds ceremony, not portability. The reviewer's concern survives through the real guards: rank order is take/skip-only (no cursor), within-engine determinism is guaranteed, and the dev/prod ordering divergence is documented loudly in Tier 3 and on the user docs page. Attribute sorts are portable, deterministic, and cursor-able.
- **Projection is the full read surface** — the hits statement is the existing single-statement read machinery with the match set as driving filter (verified in review against the actual builders); `select`/`include` at any depth, nested relation args, `_count`, `omit`. (Corollary: the FK-index fix from the query-performance plan Phase 1 is a de-facto prerequisite.)
- Execution: hits = 1 statement; the facet/total statement exists ONLY when facets or `total: true` are requested (SELECT-only CTE + JSON aggregation; the facet compiler must NOT rely on `JSON_ARRAYAGG` element order — MySQL leaves it undefined — and never emits `LATERAL` before `JSON_TABLE`). So: plain search = 1 statement; search with facets and/or total = 2.
- **Query escaping is semantics-critical, not cosmetic** (review, empirical): an unescaped `-` in MySQL boolean mode *inverts* meaning (`foo-bar` excluded the row containing "foo bar"). Full escaped set: `+ - > < ~ * ( ) " @`. §3.2's normalization handles this structurally (punctuation → separators before compilation); pinned by conformance tests including hostile inputs.

### 5.1 Faceting

Query-scoped facets: counts over the match set — `GROUP BY`, ordered count-desc/value-binary, top-N; **disjunctive** via per-facet variants (`FILTER` on PG and SQLite ≥ 3.30, `SUM(CASE)` on MySQL); **ranges** via CASE; **stats** (min/max/avg). All Tier 1. Cost note: disjunctive compilation multiplies scan work per facet — a per-request facet cap is enforced, and the §1 scale envelope applies.
**List-valued facets are fast-follow, not v1** (review falsified the reuse claim: only SQLite's adapter has a row-expanding idiom today; PG/MySQL list handling is boolean predicates — this is new machinery on 2 of 3 dialects).
**Global counts for the empty-query sidebar: computed on demand in v1.** The rev-2 maintained-counter tables are **cut** (review, both agents): trigger-maintained counters are the literature's canonical anti-pattern — counter row locks held to commit of the user's whole transaction, insert-path gap-lock deadlocks that update ordering cannot prevent, serialization aborts under RR/SSI, vacuum churn, and replication topologies that silently freeze or double-count. If ever revisited: slotted counters + periodic rollup, surrendering the "transactionally exact" pitch — recorded as the honest trade.

### 5.2 Browse mode, sorting, autocomplete

No-query faceted browse; attribute `orderBy` with cursors (portable); **search-as-you-type via `prefix*` — review-verified including 1–2-char prefixes on MySQL** (prefix queries bypass min token size). Vocabulary suggestions: deferred, dialect-tiered (`fts5vocab` free on SQLite; PG derivable; MySQL awkward).

### 5.3 Library-computed highlighting

Highlighting is computed **in the library** on returned text — the database only returns rows. Spans come from a three-step ladder ✦; presentation (snippet windows, ellipsis, markup, the `_highlights` shape) is ALWAYS engine-owned and uniform, so every implementation's highlights look identical to the app:

1. **Portable implementations** (built-ins, portable extensions): the shared highlighter — the §3.2 pinned tokenizer with an offset map to the raw text; byte-identical across dialects; "a highlighted term is always a matched term" holds exactly. Portable implementations cannot override it (their analysis IS the shared one).
2. **Custom implementations providing `highlightSpans(field, rawText, query)`**: the implementation reproduces its own matching in a pure span function (an ngram implementation: a substring scan); the engine enforces only the interface (spans in bounds, deterministic) and the implementation ships its own span-correctness suite.
3. **Custom implementations without a highlighter**: **fallback to the shared word-based highlighter, best-effort** ✦ — every mark it makes is a genuine query-term occurrence by the portable rules (sound), but a fragment-caused hit may show few or zero marks (incomplete). It never fabricates a span. Documented per implementation; `highlight: true` never throws.

Snippet-window algorithm pinned (S0 decision).

## 6. The portability contract (tiers)

**Tier 1 — identical:** §3.2 tokenization; the grammar (terms/AND, OR, NOT-with-positive, `"phrase"`, `prefix*`); per-field + composite/`$all` document-level AND; phrase-boundary rule (per-field compilation on PG); match-set equality (given §3.2); attribute filters (`_bin` semantics on MySQL — attributes never take the ci collation, review M2); scalar facets incl. disjunctive/ranges/stats; attribute sorting + cursors; browse; library highlighting; full hit projection; committed-read freshness + `resync`; MySQL stopword-free index build.

**Tier 2 — named, checked caveats:** MySQL min token size (global server var — `push` reads and warns); **MySQL in-transaction FULLTEXT visibility** (commit-time only — read-your-writes inside the writing transaction does not hold on MySQL; rollback-wrapped test suites are named as affected); MySQL TRUNCATE hole (→ `resync`); D1: FTS5 officially "subset" supported, triggers work but undocumented-as-guaranteed, **no interactive transactions** (freshness holds per statement/batch), **export unsupported with virtual tables** (backup workflow caveat); SQLite `SQLITE_ENABLE_FTS5` capability check; version floors (§3).

**Tier 3 — dialect-owned:** ranking (`ts_rank` / relevance / BM25) — same rows, engine's order, `_rank` opaque; rank order is the DEFAULT when `orderBy` is omitted (✦, §5) and is take/skip-only; the dev/prod ordering-divergence caveat is documented on the user-facing page; PG phrase-length bound (§3.3).

**Tier 4 — best-effort ranking hints ✦:** field weights — applied on PG as **rank-expression multipliers** (`w1*ts_rank(f1_tsv,q) + w2*ts_rank(f2_tsv,q)` — the L3-compatible mechanism, strictly more expressive than `setweight`'s four buckets) and on SQLite via `bm25(t, w1, w2, …)`; inert + `push` warning on MySQL. Rule unchanged: accept-and-ignore only for ranking-dimension inputs, with a warning.

**Tier 5 — excluded from v1:** stemming/language; string-grammar field targeting; SQL-side snippets; rank thresholds; rank cursors; vocabulary suggestions; list-valued facets (→ fast-follow); maintained counters (→ cut, §5.1); typo tolerance/synonyms (FTS5-trigram/MySQL-ngram exist but nothing portable; later PG-flavored `pg_trgm`); PlanetScale MySQL (typed refusal today); MariaDB (unsupported, named).

**Roadmap note — vector and point in the search document (designed fast-follows, ✦-adjacent):** the two excluded types land in OPPOSITE places of the contract, each where its nature puts it. **Vector = three roles, two contract placements.** (1) *Hybrid rank/fusion* — changes how hits are ORDERED; ranking is Tier-3 dialect-owned, so a fused rank violates nothing, and `SearchMatchPlan.rank: Sql` accommodates it through the seam UNCHANGED. (2) *Distance-threshold filtering* (`filter: { embedding: { near: vec, within: r } }`) and (3) *pure semantic retrieval* (no text query; the k-nearest set IS the result set, attribute filters composed on top) — both CHANGE THE MATCH SET, so they cannot ride the ranking loophole; they are **capability-gated**: well-defined on vector-capable implementations, TYPED REFUSAL elsewhere — never silently different rows. Note the deliberate contrast with the refused text-rank thresholds: `ts_rank`/BM25 scales are incomparable and `rank > x` is meaningless, but cosine/L2 distance is a defined metric — `within: 0.3` means the same thing wherever the vector exists, so the threshold is legal under gating. (PG-first via pgvector; prerequisite: ANN index declarability from the query-performance plan's gap list.) **Point = portable core material**: a point attribute denormalizes to two numeric columns (same triggers, btree); bounding-box filters are plain comparisons (Tier-1, index-usable); haversine distance ordering is deterministic math — the same formula orders identically on every engine, making `near` a PORTABLE orderBy (floor: SQLite math functions are a compile flag, ≥3.35 — same capability-check pattern as FTS5); radius = box prefilter + precise haversine, fine within the scale envelope; true geo indexes (GiST/SPATIAL/R*Tree) are later per-dialect optimizations via the seam. Neither is v1.

### 6.1 Conformance-grade facts (survived deliberate attack — pin these in the suite)

MySQL multi-column boolean = document-level AND · MySQL phrases never span columns (undocumented; pinned as observed; `@distance` never exposed) · FTS5 bare multi-term = per-term any-column AND; column filters; `fts5vocab`; per-column `bm25` weights · FTS5 `remove_diacritics` default is 1 → the explicit `0` is required · `utf8mb4_0900_as_ci` MATCH is case-insensitive/accent-sensitive · multiple FULLTEXT indexes per table OK (FULLTEXT-on-generated-columns fact retained for the L3 opt-in path: STORED OK, VIRTUAL not) · TRUNCATE trigger facts per engine · PG `simple` config behavior · facet SQL portability at the §3 floors · prefix queries bypass MySQL min token size · Neon: clean full pass.

## 7. Migration/DDL work items

1. `TriggerDef` + search-table artifacts; per-dialect generation — **all greenfield** (the migration layer has zero trigger support today; review-verified).
2. Introspection + differ (trigger name + body hash; field/attribute changes → drop + recreate + backfill as visible plan steps).
3. SQLite rebuild: re-emit triggers + forced resync (§3.1).
4. Backfill before index creation; `resync` with per-dialect profile (§4).
5. `push` checks: MySQL min token size, `SET_ANY_DEFINER`/version-aware privilege error, `SQLITE_ENABLE_FTS5`, PlanetScale refusal.
6. Maintenance surface: MySQL `OPTIMIZE TABLE` guidance, FTS5 `'optimize'`, GIN pending-list stance (§4.1).

## 8. Client/engine work items

New operation family (deliberate gate/census growth); §3.2 normalization + query compiler + escaping; facet compiler (CTE + JSON aggregation, order-independent); hits via existing read builders; typed query/filter/facet objects with contextual-typing probes; **the write-path A/B benchmark suite as an acceptance gate**.

## 9. Open items

1. NFC/NFD normalization policy for the §3.2 tokenizer (both index- and query-side).
2. SQLite attribute storage: sibling table vs FTS5 UNINDEXED (measure).
3. Highlight snippet-window algorithm pinned.
4. Facet value ordering: count desc + binary value order — confirm.
5. Per-field indexing opt-out (each PG per-field GIN is real write cost; consider `index: false` per field for composite-only fields).
6. Indexed-text truncation cap default (§4.1).
7. Naming: `search`, `$all`, `filter` vs `where`, `resync`, `_rank`.
8. v1 staging fallback if effort balloons: the reviewer's minimal slice (table+triggers+`$all`+filter+where+attribute orderBy+total+take/skip+resync) first, scalar facets immediately after — recorded as the fallback, not the plan; facets and per-field are in scope ✦.

## 10. The door this opens (unchanged)

Plain views (portable) → read-only models. True matviews (PG-only, capability-gated, `$refreshView()`, staleness documented) → analytics.

## Effort and gates

**W-class-plus, larger than rev 2 believed** (normalization subsystem §3.2, greenfield trigger DDL, write benchmarks, replication docs). The falsifiable heart: the Tier-1 conformance suite — same corpus (including hostile tokens: `foo-bar`, `snake_case`, `aren't`, emails, dates, floats), same structured queries, same filters and facets — asserting **identical hit sets, totals, and facet counts** across pglite/sqlite3/mysql (docker leg), phrase-boundary cases included; ranking asserted only for within-engine determinism; plus the per-dialect write-cost A/B benchmark gate.
