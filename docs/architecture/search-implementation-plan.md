# Full-Text Search — Implementation Plan (implementation-seam revision)

**Date:** 2026-08-01 (rev 3 — database-specific implementations)
**Spec:** [search-feature-design.md](search-feature-design.md) (rev 3) — normative for the CONTRACT (tiers, semantics, caveats). This plan chooses the cheapest physical shapes that satisfy it; §0 records each choice so later work does not re-inflate. The optional `using` selector added here is a dialect-scoped physical override; it does not weaken the spec's portable contract unless the resolved implementation carries `analysis: "custom"` (spec §3.4; factories derive the bit from analysis-changing options).
**Status:** plan; not scheduled.

## §0 — LOC-minimization decisions (binding for the implementation)

Every row trades no contract semantics — only implementation mass.

| # | Decision | What it replaces | Saved |
|---|---|---|---|
| L1 | **The search table compiles to EXISTING serializer artifacts** (`TableDef`, columns, and an in-place extension of `IndexDef`). `IndexDef` gains only the structured physical properties proved necessary by real implementations: PostgreSQL access method, per-column operator class, ordered index parameters, and MySQL parser. The ONLY new DDL kinds remain `TriggerDef` and the FTS5 virtual table. | A new `SearchIndexDef` artifact class or extension-owned opaque DDL callbacks | Separate differ/introspection paths for search tables and indexes; extension properties still round-trip through the existing index owner |
| L2 | **Triggers compute everything; no generated-column machinery.** The sync triggers (which must exist anyway) write the normalized text AND the tsvector columns as plain columns. Backfill computes the same expressions in its `INSERT … SELECT`. | Generated-column support in the serializer/differ/introspection (a whole new DDL feature) for PG STORED tsvectors and MySQL shadow columns | An entire migration-layer feature; one mechanism (triggers) instead of two |
| L3 | **PG and FTS5 composites are query-compiled, not materialized.** `$all`/composites compile per term as AND over (OR across per-field matches) — document-level AND semantics, identical result set, zero extra columns/indexes. Only MySQL needs a physical per-composite structure (a multi-column FULLTEXT — one IndexDef via L1). Phrases were already per-field on PG (spec §3.3). | Combined weighted tsvector column + GIN per composite on PG | Storage + write cost + DDL per composite on PG; nothing on FTS5 (inline column filters were already free). PG combined-vector column stays available as a LATER opt-in perf optimization if BitmapOr shows up in benchmarks |
| L4 | **TriggerDef is engine-owned-only.** Generation + name-and-body-hash diff of `viborm_search_*` triggers exclusively; introspection reads name+body as opaque strings; no parsing, no user-facing trigger feature, foreign triggers invisible to the differ. | General trigger support in the migration layer | Body parsing, user-trigger diffing, docs surface |
| L5 | **`resync` lives in the migration layer** (a function beside `push`, running generated SQL through the existing migration executor), not a client operation. | A new client operation family entry for resync | Client proxy/validation/routing/census surface for one admin verb |
| L6 | **The hits path injects a match predicate into the EXISTING findMany compilation** (an internal `WHERE EXISTS (search-table match ∧ pk join)` conjunct + rank ORDER BY threading), reusing the read builders, projection, cursors, and count machinery wholesale. `search()` is still its own public operation (spec ✦), but internally it is findMany + one conjunct + one facet statement. | A parallel read-compilation path for search hits | Everything except the conjunct injection seam and the facet compiler |
| L7 | Already cut by spec: maintained counters, list-valued facets, vocabulary suggestions, SQL-side snippets. | — | — |
| L8 | **The declaration is a model method with an object config** (`model.search({ …, using? })`), not a standalone builder. `using` is one dialect-scoped override: `using: pgroonga()` or `using: mysqlFullText({ … })`, never a dialect map or array. | A standalone `s.searchIndex` chainable builder class (UpdateState machinery, registration wiring into the schema map) | The builder class AND the registration surface — the index rides the model into the schema for free |
| L9 | **One resolved `SearchImplementation<Dialect>` compiles one immutable `SearchProgram` consumed by BOTH migrations and queries.** The program carries a stable manifest, declarative deployment, and match/rank compiler. The active dialect always has a built-in implementation: PostgreSQL tsvector/GIN, MySQL FULLTEXT, SQLite FTS5. A matching `using` value replaces that built-in; a non-applicable override warns once and leaves the active dialect's default unchanged for both paths. No driver-method overrides, arbitrary SQL callbacks, or separate migration/query hooks. | A dialect-keyed `using` map; driver overrides; independent DDL and query extension hooks | One seam and one normalized configuration source; index options cannot diverge from query behavior |

Estimated implementation mass after L1–L9: **the genuinely new code is ≈ 7 cohesive pieces** — the library tokenizer (+highlighter), the search-implementation seam and its concrete implementations, the per-dialect normalization expressions, the trigger generator, the FTS5 DDL arm, the query→match integration, and the facet-statement compiler — plus the fixed cost of one new operation family. Everything else is wiring into existing machinery.

## Conventions

Standard harness per unit (implementer → contract attacker → theater attacker, ≤2 fix rounds); estate + `test:gates` green per phase; **docker MySQL per phase from S3** (S3's push checks and idempotency acceptance need the real server; FULLTEXT/stopwords/commit-visibility are load-bearing); the conformance suite is cumulative in `tests/drivers/search-conformance-behavior.ts` — identical hit sets, totals, facet counts across engines on the hostile corpus; contextual-typing probes on every new typed literal surface. The PGroonga reference implementation uses the official PGroonga container in S2. **Prerequisite:** query-performance plan Phase 1 (FK indexes) done.

## Phase S0 — Kickoff decisions + capability scaffolding (S)

Maintainer decisions: NFC policy, indexed-text truncation cap default, naming, per-field index opt-out (§9.5 — if accepted, S2-U1 builds `index: false`), the highlight snippet-window algorithm (§9.3 — BLOCKS S7-U1, decide here not at S9), facet value ordering confirmation (§9.4). Recorded resolution: §9.2 (SQLite attribute storage) is settled by §0 L1's sibling-table choice — noted, no measurement needed.

| Unit | What | Acceptance |
|---|---|---|
| S0-U1 | Capability plumbing: `SQLITE_ENABLE_FTS5` runtime probe; PlanetScale typed refusal; D1 caveats (no interactive tx; virtual-table export); MariaDB named-unsupported; version floors (MySQL ≥8.0, PG ≥12, SQLite ≥3.9/3.38). Reuse the existing capability/refusal machinery (V8003 class) throughout. | Each refusal/warning typed and tested on local dialects + the batch-only driver. |

## Phase S1 — Tokenizer + normalization (M) — the precondition

| Unit | What | Acceptance |
|---|---|---|
| S1-U1 | **Library tokenizer** (one module, shared by index expressions, query compiler, highlighter): word = Unicode letters/digits runs; case-folded; accents kept; NFC per S0; offset map to raw text. | Golden-file tokens over the hostile corpus (`foo-bar`, `snake_case`, `aren't`, emails, floats, dates, CJK, empty/huge). |
| S1-U2 | **Index-side normalization expressions** per dialect as SQL snippets FOR THE TRIGGER BODIES (L2): PG regexp punctuation→space feeding 2-arg `to_tsvector('simple', …)`; MySQL shadow-column expression; FTS5 tokenizer args (`unicode61 remove_diacritics 0` + separators matching U1). | **Cross-engine token identity test** — the falsifiable heart: normalized-text token sets identical to U1's output on PG/FTS5 now, MySQL in S4. Falsify: drop one rule → the test names engine and token. |
| S1-U3 | **Query normalizer + grammar + escaping** (terms/AND, OR, NOT-with-positive, phrase, prefix; full MySQL boolean escape set; `@` never emitted). | Operator-fuzz property test (no input reaches an engine as an operator); the `foo-bar`-inversion named regression; pure-negation → ValidationError everywhere. |

## Phase S2 — Singular database-specific implementations (`using`) (M/L)

`using` selects exactly one implementation for the declaration:

```ts
model.search({
  fields: { title: true, content: true },
  using: pgroonga(),
});

// Or, on a MySQL-specific model:
model.search({
  fields: { title: true, content: true },
  using: mysqlFullText({ parser: "ngram" }),
});
```

It is not a dialect map. `using` is one override scoped by the implementation's own `dialect`. Omitting it keeps the active dialect's built-in implementation: PostgreSQL tsvector/GIN, MySQL FULLTEXT, or SQLite FTS5. A matching override replaces that default. A non-applicable override emits one non-throwing warning per schema binding and leaves the active dialect's default unchanged. Thus `using: pgroonga()` affects PostgreSQL only; the same model bound to MySQL still uses MySQL FULLTEXT. The resolved implementation supplies the manifest, deployment, and match plan, so migrations and queries cannot choose different fallbacks.

The proposed seam is one pure compilation method:

```ts
interface SearchImplementation<D extends Dialect> {
  readonly id: string;
  readonly revision: number;
  readonly dialect: D;
  readonly analysis: "portable" | "custom";

  compile(context: SearchCompileContext<D>): SearchProgram<D>;
}

interface SearchProgram<D extends Dialect> {
  readonly manifest: JsonValue;
  readonly deployment: SearchDeployment<D>;

  match(
    context: SearchMatchContext<D>,
    query: NormalizedSearchQuery
  ): SearchMatchPlan;

  /** Custom-analysis implementations only (spec §5.3 ladder). Pure span
   *  finder over returned raw text; presentation (windows/markup/_highlights
   *  shape) stays engine-owned. Portable implementations may not provide it. */
  highlightSpans?(
    field: string,
    rawText: string,
    query: NormalizedSearchQuery
  ): ReadonlyArray<{ start: number; end: number }>;
}

interface SearchMatchPlan {
  readonly predicate: Sql;
  readonly rank: Sql;
  readonly rankDirection: "asc" | "desc";
}
```

`compile()` is deterministic and side-effect free. It returns declarative artifacts and `Sql` fragments; it never executes SQL. The migration path consumes `deployment`; the query path consumes `match()` from the same compiled program. The manifest fingerprint includes implementation `id`, `revision`, `dialect`, `analysis`, canonical options, and stable field order. Built-in revision discipline (spec §3.4 ✦): built-ins bump `revision` ONLY on semantics-affecting changes, and a bump is a named breaking-change event with a visible plan-step note — never a refactor side effect. A fingerprint change recreates the managed search artifacts and backfills; an unchanged fingerprint is a no-op.

`analysis: "portable"` means the implementation consumes the S1 normalized document/query contract and remains in the Tier-1 conformance suite (spec §3.4 — the suite is the enforcement of the same-rows promise). `analysis: "custom"` permits implementation-owned analysis such as an ngram parser; its match set is explicitly dialect-specific. **Factories derive the bit**: `mysqlFullText({ parser: "ngram" })` resolves to `analysis: "custom"` automatically — pinned in S2-U2. Highlighting follows the spec §5.3 ladder: portable → shared highlighter (not overridable); custom with `highlightSpans` → implementation spans; custom without → shared word-based fallback, best-effort (sound marks, possibly incomplete), never a refusal. An option such as `mysqlFullText({ parser: "ngram" })` must put parser availability in `deployment.requirements`; requirements fail before DDL rather than being installed implicitly. Every v1 implementation must support terms, boolean composition, phrases, prefixes, composites, and numeric rank, or refuse the configuration before SQL generation. Only ranking hints retain the existing Tier-4 accept-and-warn rule.

| Unit | What | Acceptance |
|---|---|---|
| S2-U1 | `model.search({ fields, composites, attributes, name, using? })` — **a model method with an object config** (✦ spec §3; §0 L8). `using` accepts one dialect-scoped `SearchImplementation` override, never an array or dialect map; the supplied value is stored in immutable model state and resolved when the schema is bound to a driver. **STRICT eligibility typing per the spec's table** remains unchanged: `fields` keys complete ONLY non-list string scalars; `composites` members complete ONLY keys of the SAME literal's `fields` property; `attributes` completes ONLY filterable non-list scalar types; model-`.omit()`ed fields are excluded everywhere. Per-field options remain `weight` and, if S0 accepts §9.5, `index: false`. One search declaration per model in v1. | Public call-site probes cover every existing field constraint plus `using`: one implementation accepted; an array/map rejected; a second `.search()` rejected; implementation factory option bags reject unknown keys for fresh AND non-fresh values. Runtime schemas falsify each type-level declaration rule once. A non-applicable override emits one warning and leaves the active dialect's default unchanged. The warning is not repeated per query, and no SQL or requirement from the ignored override is compiled. |
| S2-U2 | Implement `SearchImplementation<D>` and compile/cache one `SearchProgram<D>` per model+dialect. The three built-in PostgreSQL/MySQL/SQLite implementations move behind the same seam; omission or a non-applicable override resolves to the active dialect's built-in. Factories own option validation and canonicalization before compilation. The snapshot stores only the resolved manifest fingerprint; migration and query consumers receive the same program. Custom-analysis implementations are marked by their factories; `mysqlFullText({ parser: "ngram" }).analysis === "custom"` is pinned. | All three built-ins compile through this interface with no dialect branch in their consumers. `compile()` determinism pinned. Migration and query probes observe the same canonical options and field order. Unchanged resolved manifest → empty diff; a resolved implementation's option, revision, dialect, or analysis change → visible recreate+backfill; changes inside a non-applicable override → empty diff. Unsupported match-set capability fails before SQL generation. |
| S2-U3 | **First extension implementation: `pgroonga()`**, a PostgreSQL-only `analysis: "portable"` preset. It declares `pgroonga >= 3.1.6` with `mustExist` policy (VibORM does not run `CREATE EXTENSION`), stores normalized fields in one stable-order `text[]` document, and creates one PGroonga index with `TokenDelimit`, `normalizers=''`, and no token filters. Query compilation uses the normalized AST, escaped PGroonga query literals, and per-field/composite weight masks over that stable order. Rank is a plan-independent weighted matched-positive-leaf expression; `pgroonga_score()` is forbidden until its sequential-scan zero behavior can satisfy the rank contract. Extend `IndexDef` in place for PostgreSQL access method, per-column operator class, ordered index parameters, and MySQL parser; extend render/diff/introspection with those same fields. | Official PGroonga-container gate: missing/old extension on PostgreSQL refuses before DDL; create/introspect/re-push is idempotent; access method/operator class/ordered parameters round-trip; option or implementation-revision change recreates+backfills; `$all`, per-field, composite, phrase-boundary, prefix, and hostile escaping cases match the portable corpus; forced index-scan and sequential-scan plans return identical hit sets and deterministic rank order. `using: pgroonga()` on MySQL leaves MySQL FULLTEXT active after one warning; a MySQL override on PostgreSQL leaves built-in PostgreSQL search active after one warning; neither compiles ignored requirements or SQL. A custom-analysis option cannot enter the Tier-1 suite; PGroonga (portable) joins the S1 cross-engine token-identity suite — its TokenDelimit-over-normalized-document tokens must equal the library tokenizer's, same falsification discipline. |

## Phase S3 — DDL via existing machinery (M — was L before §0)

| Unit | What | Acceptance |
|---|---|---|
| S3-U1 | Consume `SearchProgram.deployment` and lower its declarative columns/indexes through the existing `TableDef`/extended `IndexDef` machinery (L1). Built-in outputs remain: PG normalized text + per-field tsvector columns and GIN indexes; MySQL `as_ci` searchable columns, `_bin` attributes, per-field FULLTEXT plus per-composite multi-column FULLTEXT; SQLite ordinary sibling table plus FTS5 virtual table. Extension implementations may choose another physical shape without adding a second DDL path; PGroonga emits its stable-order `text[]` document and extension index here. | `push` idempotent on all built-ins and PGroonga; model-field `.map()` resolution correct in search columns and trigger projections; introspection round-trips every built-in and extension index property; a declaration or implementation-manifest change produces drop+recreate+backfill. The ONLY new DDL-kind differ/introspection arms are triggers (S3-U2) and FTS5. |
| S3-U2 | **TriggerDef, engine-owned-only (L4)**: deterministic bodies from the selected deployment (normalization + implementation-owned document projection; FTS5 `'delete'` form; PG TRUNCATE statement trigger; skip-if-unchanged), name+body-hash diff, `viborm_search_` prefix, dry-run visibility. | Create/diff/drop idempotency for every built-in and PGroonga; a planted user trigger is invisible to the differ (falsify by planting one). |
| S3-U3 | **Backfill + rebuild + push checks** from the selected deployment: backfill `INSERT … SELECT` load-then-index; SQLite rebuild re-emits triggers + forces resync; MySQL checks min token size, version-aware `SET_ANY_DEFINER`, stopword-free build, and **weights-inert warning**; extension requirements are checked before any DDL. | Backfill count parity and a visible long-migration note; a `fields`/`attributes`/implementation change compiles to drop+recreate+backfill; SQLite `alterColumn` rebuild leaves triggers present and FTS5 `integrity-check` clean; MySQL checks pass against docker; missing PGroonga refuses before the first migration statement. |

## Phase S4 — Sync correctness (M)

| Unit | What | Acceptance |
|---|---|---|
| S4-U1 | Trigger bodies live on all dialects and PGroonga; conformance: ORM writes, raw SQL writes, `createMany`, nested writes → search-table parity everywhere incl. docker MySQL (this also completes S1-U2's MySQL leg), the PGroonga container, and the batch-only driver (writes via `_executeBatch` fire triggers — D1 model). | Falsify: disable one trigger → parity test names implementation+table+operation. |
| S4-U2 | The named holes as pinned tests: PG TRUNCATE trigger; MySQL TRUNCATE desync detected + repaired by resync; SQLite no-WHERE DELETE fires; rollback leaves no residue; **MySQL commit-visibility caveat asserted** (in-tx miss, post-commit hit; PG/SQLite in-tx hit). | Each hole falsified once. |
| S4-U3 | **`resync` in the migration layer (L5)**: full re-derivation through the selected deployment; FTS5 `'rebuild'`; 100k-row lock/time profile documented. Sibling maintenance helpers, same L5 shape: FTS5 `'optimize'` (+ pinned `automerge` defaults in the DDL) and the MySQL `OPTIMIZE TABLE` guidance surfaced as a documented helper. | Parity after induced desync for all built-ins and PGroonga; `integrity-check` clean. |

## Phase S5 — The `search()` operation (M/L)

| Unit | What | Acceptance |
|---|---|---|
| S5-U1 | Operation-family scaffolding (the irreducible fixed cost): routing/tokens/census deliberate edits, client proxy entry, validation args (`query: string \| {…}` — **the bare-string form desugars to `{ $all }` via a validation transform**, so the engine sees only the object form; object keys typed from the declaration; `filter` attributes, `where`, `orderBy: "_rank" \| attributes` **defaulting to `"_rank"` when omitted** (✦ spec §5), take/skip, select/include). Typing probes throughout. | Gates edited-not-loosened; typo probes; loud arg validation; string-vs-object equivalence pinned (`search({ query: "x" })` ≡ `search({ query: { $all: "x" } })` — identical SQL and hits); omitted-orderBy ≡ `orderBy: "_rank"` pinned (identical SQL and hits); statement-count contract pinned (no facets and no `total: true` → exactly ONE driver execution; with either → exactly two); `highlight: true` without a projected searchable field → `_highlights` empty, no error (✦ spec §5) — pinned. |
| S5-U2 | **Match-predicate + filter + rank integration (L3+L6+L9)**: the engine passes the normalized query to the selected `SearchProgram.match()` and injects its predicate/rank into the existing findMany path. It does not switch on PostgreSQL/MySQL/SQLite or name extension operators. **`filter` compilation** remains engine-owned: `equals/not/in/notIn/lt/lte/gt/gte` (+ null forms) become plain conjuncts on the search table through existing expression helpers. Built-in program shapes remain PG per-term AND-over-OR + weighted `ts_rank`, MySQL multi-column FULLTEXT + `MATCH` relevance (weights inert + warning from S3-U3), and FTS5 + `bm25`; PGroonga uses the S2 program. | Consumer test proves a fake implementation can change deployment+match without editing the query engine. Pinned built-in and PGroonga SQL shapes; phrase-boundary and split-terms composite conformance; **filter `_bin` semantics pinned** (`filter: { category: { equals: "Foo" } }` does NOT match "foo" on portable implementations); weight-effect test (PG/SQLite reorder, MySQL warning, PGroonga deterministic implementation-owned rank); **hits projection parity**: search hits with nested include ≡ findMany on the same ids. |
| S5-U3 | Match-set conformance battery across the three built-ins, PGroonga, and the batch-only driver leg (the D1 stand-in: search after batched writes — the Tier-2 per-batch freshness claim, exercised not assumed); default-orderBy behavior (`_rank` when omitted); attribute sorts + cursors (existing cursor machinery); rank order is take/skip-only (cursor with `"_rank"` = ValidationError). Custom-analysis implementations run their own result-set suite and are excluded from cross-dialect equality claims. | Identical hit sets + totals on pglite/sqlite3/mysql2 and portable PGroonga; `_rank` present and numeric on every hit (opaque value pinned as type+presence, never as a number); `take` omitted returns ALL matches; rank order within-engine deterministic; rank-cursor refusal pinned; batch-driver leg green; custom-analysis results never enter the Tier-1 equality assertion. |

## Phase S6 — Facets (M)

| Unit | What | Acceptance |
|---|---|---|
| S6-U1 | **The facet-statement compiler** (the second genuinely new compiler): one SELECT-only-CTE statement — total + scalar facets (top-N **default 10**, per-facet `limit` override, count-desc/binary-value order) + disjunctive (`FILTER`/`SUM(CASE)`) + ranges + stats; JSON aggregation order-independent; per-request cap. Reuses the adapters' existing JSON-aggregation expression helpers. | Identical counts/ranges/stats across portable implementations; mixed-case values distinct everywhere (`_bin` proof); disjunctive equals hand-computed; cap enforced; default-limit-10 pinned; contextual-typing probes on the `facets` argument (typo'd attribute = compile error). |
| S6-U2 | Browse mode (no-query path through the same compilers). | Browse conformance parity. |

## Phase S7 — Highlighting + polish (S)

| Unit | What | Acceptance |
|---|---|---|
| S7-U1 | Highlighting per the spec §5.3 ladder: shared library highlighter (S1 tokenizer + offset map + pinned snippet-window algorithm) for portable implementations; `program.highlightSpans` for custom implementations that provide it (engine enforces spans-in-bounds + determinism, presentation stays engine-owned so `_highlights` shape is uniform); **shared word-based fallback for custom implementations without one — best-effort, never refused** (✦). `_highlights` for projected fields only. | Byte-identical `_highlights` across portable implementations (golden files); highlighted-term ⊆ matched-term property (falsify via skewed normalizer); custom-spans interface probes (out-of-bounds span rejected loudly; portable implementation providing highlightSpans rejected); fallback case pinned: an ngram-caused hit whose text lacks the whole word shows zero/partial marks and NEVER a fabricated span. |
| S7-U2 | Autocomplete pattern doc + prefix conformance incl. 1–2-char MySQL prefixes. | Pinned on docker MySQL. |

## Phase S8 — Write-cost gate + docs (M) — acceptance gate

| Unit | What | Acceptance |
|---|---|---|
| S8-U1 | A/B write benchmarks (indexed vs unindexed model; create/update/delete/createMany; **docker PG — not pglite/WASM — for the PG numbers**, sqlite3, docker MySQL, and PGroonga; GIN pending-list flush profile). | A stated per-write overhead envelope per implementation, maintainer-signed. **The phase fails if it cannot state one.** |
| S8-U2 | Truncation policy: user writes never fail from search limits (cap per S0). | Oversized write succeeds, truncated indexing pinned at each implementation's declared limit. |
| S8-U3 | Docs: user pages (declaration, singular dialect-scoped `using`, built-in vs extension implementations, portable vs native analysis, querying, facets, ranking honesty + dev/prod ordering divergence, scale envelope), ops page (extension installation ownership, replication guidance, CDC note, MySQL OPTIMIZE/`INNODB_FT_DELETED`, FTS5 `'optimize'`, GIN stance), compatibility + capability matrix rows. | Grep-checked doc coverage: every Tier-2 caveat, the Tier-3 PG phrase-length bound, the bulk-write trigger cost, the FTS5 silent-corruption severity + `resync='rebuild'`, Neon, PGroonga requirement/rank caveat, non-applicable-override warning/default behavior, and the native-analysis Tier-1 exclusion — each verbatim on a user-facing page. |

## Phase S9 — Final hardening (S)

Full estate + gates + MySQL/PostgreSQL/PGroonga docker legs; cumulative conformance complete; matrix updated; fast-follow list recorded (list facets, vocabulary, `pg_trgm` flavor, PG combined-vector optimization per L3, **geo point attributes** — portable core: box filter + deterministic haversine `near` ordering, math-function capability floor, spec roadmap note — and **vector in the search document** — three roles per the spec roadmap note: fused rank through the existing `SearchMatchPlan.rank` seam (Tier-3, no contract change), distance-threshold filters and pure semantic retrieval (match-set-affecting → capability-gated with typed refusal on non-vector dialects, NEVER silent divergence; distance thresholds are legal unlike text-rank thresholds because cosine/L2 are defined metrics); PG-first, gated on ANN index declarability); design-doc §9 items resolved or re-owned.

## Ordering

```
S0 → S1 → S2  (normalization contract before implementations; S0 also feeds S5-U1 naming and S7-U1 snippets)
             ├→ S3 → S4      (S3 consumes SearchProgram.deployment; S4 proves its triggers)
             └→ S5-U1        (parallel with S3/S4 — client scaffolding consumes S2 typing)
S5-U2/U3 after S2+S4 → S6 → S7
S8 after S4 (benchmarks need live triggers) · S9 last
```

Sizing after §0: S0=S, S1=M, S2=M/L, S3=M (was L), S4=M, S5=M/L, S6=M, S7=S, S8=M, S9=S — **~10–12 harness drives**. The remaining long poles are S2's real extension proof and S5's operation-family fixed cost; neither is interface ceremony.

## Abort criteria (unchanged)

Token identity unachievable on an input class → loud Tier-1 carve-out, never silent. No statable write-overhead envelope → triggers not on-by-default; design returns with numbers. Any surviving conformance divergence → named tier entry or typed refusal.
