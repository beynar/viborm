# Full-Text Search — Architecture-Aligned Implementation Plan

**Date:** 2026-08-10

**Status:** implementation plan; current-architecture revision

**Product contract:** [search-feature-design.md](search-feature-design.md)
**Scope:** model search declarations, managed search deployments, portable text
matching, filtering, ordering, cursors, facets, totals, highlighting, and the
first sealed PostgreSQL extension preset.

This revision replaces the former “implementation-seam rev 3” plan. It keeps
the product direction but corrects assumptions invalidated by the live model,
migration, adapter, cursor, result, cache, and query-engine architecture.

The feature design remains the product source of truth. Where that document
still says `main_pk`, describes search hits as only an `EXISTS` predicate, or
leaves a contract item open, the fixed contracts below govern implementation.
Phase S0 updates the feature design before production code begins so the two
documents become consistent.

## 1. Required outcome

Implement one portable search feature without adding a parallel query engine or
a general user-facing trigger framework.

The implementation must preserve these boundaries:

- A model owns one immutable public search declaration.
- Final schema validation resolves that declaration against the complete model.
- One normalized search definition is the semantic source used by migrations
  and queries.
- Migrations own the complete lifecycle of derived search artifacts.
- Migration drivers own provider-specific deployment SQL.
- Database adapters and sealed extension compilers own provider-specific match,
  rank, and search-source SQL.
- The query engine owns composition with normal `where`, projection,
  pagination, execution, cache, and result parsing.
- Plain search remains one statement and one round trip.
- Facets and/or an explicit total add one statement, not one statement per
  facet.
- Search synchronization covers ORM writes, row-triggering raw SQL, and
  external writers through database triggers. Provider operations that do not
  fire row triggers, notably MySQL `TRUNCATE`, are an explicit `resyncSearch`
  boundary rather than a false freshness promise.
- No adapter method is added for execution. No runtime step kind is added.
- No generic lifecycle hook, strategy table, opaque DDL callback, or arbitrary
  public SQL extension is introduced.

The existing query-performance Phase 1 foreign-key indexes are a satisfied
prerequisite, not pending work.

## 2. Canonical language and ownership

Use these terms precisely.

### Search declaration

The model-level public intent supplied through `.search({ ... })`. It names
searchable fields, composites, attributes, a logical name, and an optional
sealed implementation preset. It contains no resolved database names or SQL.

### Resolved search definition

The immutable, final-graph form of a search declaration. It contains the
ordered source row key, mapped columns, normalized field and attribute order,
implementation identity and options, semantic revision, and stable manifest
fingerprint. It contains no executable lifecycle.

### Search deployment

The engine-managed physical artifact group for one resolved search definition:
sibling storage, indexes, virtual table when applicable, trigger/function
artifacts, requirements, manifest row, backfill, verification, and exact
create/rebuild/drop/resync order. Its contents are derived and reconstructable,
not user data.

### Search query source

The adapter-compiled, joinable source for one request. It exposes exactly one
row per source record, the complete row-key join, the match predicate, rank,
and declared attribute expressions.

### Matched set

The engine-owned composition of one search query source with the normalized
query, source-model `where`, and search-attribute `filter`. Hit and facet
statements compile from this same semantic owner.

The dependency shape is:

```text
SearchDeclaration
        ↓ final model-graph validation
ResolvedSearchDefinition
        ├── SearchDeploymentDef ──→ MigrationDriver
        └── SearchQuerySource   ──→ DatabaseAdapter
                                      ↓
                               SearchMatchedSet
                                      ↓
                               SearchOperation
```

Do not import query-engine `TargetProjection` into schema or migrations. Search
reuses the underlying ordered model row-key fact from schema/model metadata.

## 3. Fixed public contract

### 3.1 Declaration

```ts
const post = s
  .model({
    tenantId: s.string(),
    id: s.string(),
    title: s.string(),
    content: s.string(),
    category: s.string(),
    price: s.decimal({ precision: 12, scale: 2 }),
  })
  .id(["tenantId", "id"])
  .search({
    fields: {
      title: { weight: 2 },
      content: true,
    },
    composites: {
      text: ["title", "content"],
    },
    attributes: ["category", "price"],
    name: "post_search",
    using: pgroonga(),
  });
```

Rules:

- One declaration per model in v1.
- At least one searchable field is required.
- `fields` accepts non-list strings that are not model-omitted.
- Composite members must be fields named by the same declaration.
- Composite names are unique, cannot collide with a field, and cannot be
  `$all`.
- V1 has no per-field `index: false` option. Every declared field is physically
  searchable by itself; composites reuse those fields rather than creating a
  second public indexing policy.
- Attributes are unique non-list filterable scalars and are not model-omitted.
- Search requires a real stable primary key and supports every member of a
  compound primary key in declared order.
- A model without a real primary key is rejected at definition validation.
- `_rank` and `_highlights` are reserved public result keys on a model carrying
  a search declaration. A conflicting model field is rejected.
- Generated artifact names use bounded deterministic names with a stable hash
  suffix. Final-graph validation rejects global collisions and an existing user
  artifact occupying a managed name.
- Both method orders are protected:

```ts
model.omit({ secret: true }).search(/* secret is unavailable */);
model.search(/* uses title */).omit({ title: true }); // rejected
model.search(/* uses title */).extends({ title: s.int() }); // rejected
```

Call-site typing gives immediate feedback. Final schema validation owns the
security and builder-order invariant.

### 3.2 Query input

```ts
const result = await client.post.search({
  query: {
    $all: "typescript OR orm",
    title: '"type inference"',
    text: "query engine*",
  },
  filter: {
    category: { in: ["orm", "database"] },
    price: { lt: "100.00" },
  },
  where: {
    published: true,
  },
  orderBy: [{ category: "asc" }],
  cursor: { tenantId_id: { tenantId: "acme", id: "p42" } },
  take: 20,
  skip: 0,
  total: true,
  facets: {
    category: true,
    price: {
      ranges: [{ to: "50" }, { from: "50", to: "100" }],
      stats: true,
    },
  },
  highlight: true,
  select: { tenantId: true, id: true, title: true },
  // `include` and `omit` use the same mutually-compatible projection rules as
  // normal reads; `select` and `include` remain mutually exclusive.
});
```

Input rules:

- A bare string desugars at validation to `{ $all: string }`.
- Multiple keys in a query object combine with logical AND.
- Omitting `query` means browse mode.
- An empty object, an empty string, or whitespace-only query is invalid.
- Each value uses one versioned portable mini-language. Its parser owns
  precedence, grouping, quoting, prefix, escaping, and pure-negative refusal;
  adapters consume only a normalized AST.
- `filter` accepts declared attributes only. `where` retains the full normal
  source-model surface.
- `select`, `include`, and `omit` reuse normal read projection and default-omit
  behavior. Validation performs the existing `omit`-to-`select` lowering before
  the query engine sees the request.
- `orderBy` is `"_rank"` or the normal scalar sort/null syntax restricted to
  declared attributes, as one object or an ordered array.
- Omitted order defaults to rank descending plus the complete ordered row key.
  In browse mode rank is `0`, so the same default becomes row-key order.
- Rank ordering supports `take` and `skip`, not cursors.
- Attribute ordering supports the ordinary source-model `whereUnique` cursor.
  Cursor comparison uses attribute values from the search source and every
  row-key tie-break member.
- Negative `take` reverses the compiled order and restores public hit order,
  as `findMany` does.
- `distinct` is not part of the v1 search API.
- Normalized input is capped before SQL expansion. S0 fixes and documents the
  exact maximum input length, AST node count, depth, prefix count, and facets
  per request.

### 3.3 Query result

```ts
type SearchResult<Hit, Facets> = {
  hits: Array<
    Hit & {
      _rank: number;
      _highlights?: Readonly<
        Partial<Record<string, readonly SearchHighlight[]>>
      >;
    }
  >;
  total?: number;
  facets?: Facets;
};

interface SearchHighlight {
  readonly snippet: string;
  /** UTF-16 offsets relative to `snippet`; end is exclusive. */
  readonly matches: readonly { start: number; end: number }[];
}
```

- `_rank` is always a finite number and is opaque across providers.
- `_highlights` is present only when `highlight: true`; it is `{}` when no
  searchable field is projected.
- `total` is present only for `total: true` or when facets are requested.
- `facets` is present only when requested and is keyed by the requested literal.
- A value facet returns `{ value, count }[]`; SQL null is a `null` bucket sorted
  after non-null values for equal counts.
- Ranges are half-open `[from, to)`, with omitted ends unbounded; null is not in
  a range.
- Stats preserve scalar decoding and return `min`, `max`, and `avg` only when
  requested.
- Disjunctive faceting removes only that attribute's filter. It retains the
  normalized text query, source `where`, and every other attribute filter.

Plain search is one statement. Facets and/or total produce one additional
statement. V1 promises that each statement observes committed data; it does not
promise that the two statements share one database snapshot under concurrent
writes. Both statements are compiled from the same matched-set definition.

### 3.4 Decimal contract

Search reuses the field's declared fixed-decimal domain and the existing
descriptor-aware codec. It does not introduce a search-specific decimal mode or
provider capability verdict.

- Equality, inequality, membership, ordering, range comparison, range facets,
  `min`, `max`, and `avg` remain exact on every provider that admits the field's
  `{ precision, scale }` descriptor.
- PostgreSQL and MySQL operate on their native fixed-decimal values. SQLite
  operates on the checked scaled-integer coefficient and uses the same guarded
  half-even arithmetic as ordinary decimal queries.
- Search SQL composes through the adapter's exact-decimal vocabulary, and facet
  results decode through the existing scalar result owner. Do not add a
  `supportsExactDecimal` flag, a SQLite refusal ladder, or another result codec.

## 4. Final internal contracts

Names may move during implementation, but their semantic boundaries are fixed.

```ts
interface ResolvedSearchDefinition {
  readonly logicalName: string;
  readonly sourceTable: string;
  readonly rowKey: readonly SearchRowKeyMember[];
  readonly fields: readonly ResolvedSearchField[];
  readonly composites: readonly ResolvedSearchComposite[];
  readonly attributes: readonly ResolvedSearchAttribute[];
  readonly implementation: SearchImplementationDescriptor;
  readonly semanticRevision: number;
  readonly manifest: JsonValue;
  readonly fingerprint: string;
}

interface SearchRowKeyMember {
  readonly field: string;
  readonly column: string;
  readonly scalar: Scalar;
}
```

`rowKey`, fields, composite members, and attributes preserve schema order. No
identity is concatenated or serialized into one string.

Public implementation factories return sealed descriptors, not callbacks:

```ts
interface SearchImplementationDescriptor {
  readonly id: string;
  readonly dialect: Dialect;
  readonly analysis: "portable" | "custom";
  readonly revision: number;
  readonly options: JsonValue;
  readonly [SEARCH_IMPLEMENTATION_BRAND]: true;
}
```

Only package-owned factories can construct the brand in v1. A public trusted
third-party compiler protocol is separate future work.

Migrations consume a serializable deployment fact:

```ts
interface SearchDeploymentDef {
  readonly name: string;
  readonly definitionFingerprint: string;
  readonly sourceTable: string;
  readonly rowKey: readonly SearchDeploymentKeyMember[];
  readonly requirements: readonly MigrationRequirement[];
  readonly storage: TableDef;
  readonly triggers: readonly TriggerDef[];
  readonly virtualTables: readonly VirtualTableDef[];
  readonly manifest: JsonValue;
}

interface SearchDeploymentKeyMember {
  readonly sourceColumn: string;
  readonly storageColumn: string;
  readonly type: string;
}
```

`SearchDeploymentDef` is not an opaque list of SQL strings. Migration drivers
lower its finite artifact vocabulary and own provider-specific lifecycle order.
`storage.indexes` is the one index list; the lifecycle owner creates the table
without those secondary indexes when it must load first, then materializes that
same list. There is no second parallel index collection. The deployment key is
fully serializable and does not contain runtime `Scalar` instances.

Queries consume a joinable source:

```ts
interface SearchQuerySource {
  readonly source: Sql;
  readonly joinPredicate: Sql;
  readonly matchPredicate: Sql | undefined;
  readonly rank: Sql;
  readonly rankDirection: "asc" | "desc";
  readonly attributes: ReadonlyMap<string, Sql>;
  readonly rowKey: readonly SearchQueryKeyMember[];
}
```

The query engine never switches on PostgreSQL, MySQL, SQLite, FTS5, `MATCH`,
`tsquery`, or PGroonga operators.

## 5. Managed deployment lifecycle

### 5.1 Why one owner is required

An ordinary table has independent structural changes. A search deployment has
coordinated derived artifacts and data movement. Its invariant is not preserved
if the generic differ independently renames, drops, or confirms destruction for
its table, virtual table, triggers, and indexes.

The search deployment owner must:

- bypass ordinary user-table rename similarity;
- treat dropped derived rows as reconstructable, not user data loss;
- preserve the old full deployment in generated snapshots for down migration;
- persist a live fingerprint for `push()` convergence;
- detect missing or altered managed physical artifacts;
- order create, rebuild, recovery, resync, and drop;
- integrate with dry-run, generate, apply, down, reset, and squash.

### 5.2 Live manifest

Create one engine-owned `viborm_search_manifest` table when the first search
deployment is installed. It stores the logical deployment name, source table,
implementation ID and revision, fingerprint, and owned artifact names.

- File snapshots store the full serializable old and new deployment.
- Live introspection reads the manifest plus physical artifacts.
- A matching fingerprint with missing physical artifacts plans repair.
- A differing fingerprint plans a managed rebuild.
- The manifest row is written only after successful verification.
- Removing the final deployment may remove the empty manifest table.
- A user object occupying a declared managed name is a collision, not ownership.

Do not use a raw database-deparsed trigger body as the sole ownership or
revision signal. Provider introspection may normalize bodies, whitespace,
definers, and SQL modes.

### 5.3 Statement transport

Before trigger support, replace migration-driver `string` DDL transport and
`split(";\n")` with explicit atomic statements:

```ts
interface DDLStatement {
  readonly sql: string;
  readonly transaction: "normal" | "outside";
}
```

The exact transaction discriminator may reuse an existing migration concept.
The required fact is that a PostgreSQL function or MySQL/SQLite trigger body is
one statement even when its body contains semicolons.

Update generation, push, apply, down parsing, squash, file writing, and rollback
together. Do not add a SQL parser.

### 5.4 Physical schema vocabulary

Extend existing schema artifacts rather than hiding search properties in type
strings or parallel arrays:

- `ColumnDef` gains optional physical collation with DDL, differ, and
  introspection support.
- Replace raw `IndexDef.columns` internally with ordered `IndexMemberDef[]`,
  where each member binds its column and optional operator class.
- `IndexDef.type` remains the existing access-method/index-kind fact.
- Managed index metadata adds canonical keyed parameters and an optional MySQL
  parser.
- Public `.index()` remains closed and unchanged; search uses trusted managed
  metadata.
- Add finite `TriggerDef` and `VirtualTableDef` artifacts. A PostgreSQL
  `TriggerDef` owns the logical body and its driver-owned supporting function as
  one managed trigger artifact; do not create an unrelated public routine API.
- SQLite introspection recognizes virtual tables and excludes FTS5 shadow tables
  from ordinary user tables.

### 5.5 Apply-time requirements

Requirements belong to the target database, not the machine that generated a
migration. Serialize `MigrationRequirement[]` in generated migration metadata
or compile target-side assertions that execute before all destructive DDL.

Requirements include:

- exact driver/capability identity, not dialect alone;
- provider and extension version floor;
- FTS5 availability;
- required parser or extension;
- privileges needed to create triggers/functions;
- unsupported hosted-driver refusals.

Use boundary-owned errors:

- definition problems use schema validation errors;
- query request-shape refusals may use V8003;
- provider capability failures use V8001 or migration
  `FEATURE_NOT_SUPPORTED`, depending on the boundary.

### 5.6 Backfill, rebuild, and resync

V1 uses a correctness-first blocking protocol where an online protocol cannot
be proven:

1. Check all requirements before destructive action.
2. Acquire the provider-specific source/write protection needed for a stable
   backfill.
3. Create shadow or empty managed storage.
4. Install the provider's required virtual/search structure and synchronization
   artifacts in a safe order.
5. Backfill through idempotent upsert semantics.
6. Reconcile source and derived row counts and complete row keys.
7. Build expensive secondary indexes after load when the provider permits it.
8. Verify integrity and match smoke probes.
9. Publish the manifest and release protection.

The concrete order may differ where, for example, an FTS virtual table must
exist before its trigger. One deployment owner records each dialect's complete
order; generic operation priorities do not infer it.

MySQL DDL implicitly commits, so a surrounding transaction is not accepted as
the synchronization proof. The MySQL plan must name its source lock or
maintenance-window behavior. Interruption leaves either the old deployment
active or a manifest-visible incomplete deployment that the next push repairs.

`resyncSearch({ models?, optimize? })` lives beside migration `push`. Omitted
models means every declared search. It uses the same deployment compiler,
locking, requirements, verification, and manifest ownership as rebuild. It is
not a query-engine operation.

## 6. Live owner map

The implementer must begin from these current owners instead of creating a
parallel search subsystem.

| Concern | Existing owner to extend |
|---|---|
| Immutable model state and chain methods | `src/schema/model/model.ts` |
| Final schema hydration and names | `src/schema/hydration.ts`, `src/schema/model/` |
| Definition validation | `src/schema/validation/` |
| Operation input schemas and exact typing | `src/validation/model/`, `src/client/types.ts` |
| Physical schema snapshot | `src/migrations/types.ts`, `src/migrations/serializer.ts` |
| Structural and managed diffing | `src/migrations/differ.ts`, `src/migrations/utils.ts` |
| Generate/apply/down/push lifecycle | `src/migrations/generate/`, `src/migrations/apply/`, `src/migrations/push/` |
| Provider DDL and introspection | `src/migrations/drivers/<provider>/` |
| Provider query SQL | `src/adapters/<provider>/`, `src/adapters/database-adapter.ts` |
| Normal find projection | `src/query-engine/operations/find-common.ts`, `src/query-engine/builders/select-builder.ts` |
| Ordering and cursors | `src/query-engine/operations/cursor-order.ts`, `cursor-condition.ts`, `find-pagination.ts` |
| Runtime operation and execution atom | `src/query-engine/write-engine/routing.ts`, `OperationFragment.ts`, `OperationExecutor.ts` |
| Model-row parsing | `src/query-engine/result/ResultParser.ts` and its parser contracts |
| Default omit | `src/client/omit.ts` |
| Read caching | `src/query-engine/cache-flow.ts`, `src/cache/` |
| Operation tracing/logging | `src/query-engine/execution-context.ts`, `src/instrumentation/` |

New concern-named modules may be added beside these owners when one file would
otherwise mix independent responsibilities. Do not create `search-utils.ts`, a
search query AST that replaces the normal read engine, or a second migration
driver hierarchy.

## 7. Ordered implementation phases

Every unit is atomic. Run only the relevant memory-capped layer scripts during
the unit. Do not run layer or provider suites concurrently.

### Phase S0 — Contract closure and feasibility

#### S0-U1 — Record baseline

- Record branch, commit, dirty files, production LOC, and three warm
  `pnpm test:types` timings.
- Preserve unrelated changes.
- Record provider and driver matrix: pg, postgres, PGlite, Neon and Bun SQL;
  mysql2 and PlanetScale; sqlite3, Bun SQLite, libSQL, and D1.
- Mark query-performance Phase 1 as delivered.

#### S0-U2 — Normalize the public contract

Update `search-feature-design.md` to match §3 of this plan:

- complete ordered row keys;
- result metadata and reserved-key policy;
- query combination and browse behavior;
- exact ordering/cursor rules;
- facet/range/null/decimal semantics;
- two-statement snapshot statement;
- request complexity limits;
- one pinned highlight snippet-window algorithm;
- all declared fields individually indexed and no v1 `index: false` option;
- `resyncSearch` API;
- no remaining contradictory open item.

#### S0-U3 — Tokenizer feasibility spike

Build a throwaway conformance spike before public schema or DDL production code.
It must compare library, PostgreSQL, MySQL, SQLite FTS5, and PGroonga token sets
over composed/decomposed accents, Unicode case folds, CJK, punctuation,
apostrophes, underscores, email-like strings, numbers, phrases, and prefixes.

The proposed portable word is a maximal Unicode letter/digit run; punctuation
is a separator; case is folded; accents remain significant. The spike must
decide normalization:

- If NFC is part of the contract, prove every provider can normalize raw SQL
  writes. PostgreSQL's built-in `normalize()` requires PostgreSQL 13+, so raise
  the floor when used.
- If exact parity is impossible, narrow the portable character contract or add
  a named tier/refusal. Do not silently claim equal hit sets.

Pin UTF-16 highlight offsets and truncation units. Fix request and document
caps from measurements, not arbitrary SQL limits.

Acceptance: the feature design contains no open implementation decision and the
hostile corpus has a recorded portable result or an explicit named carve-out.

### Phase S1 — Model declaration and final-graph validation

#### S1-U1 — Immutable declaration state

- Add one optional search declaration to `ModelState` and model construction.
- Add exact `.search()` contextual typing.
- Preserve the raw declaration through `.map()`, `.omit()`, `.extends()`,
  `.index()`, `.id()`, and `.unique()` chains.
- Reject a second declaration at type and runtime boundaries.

#### S1-U2 — Final-graph search validation

Add definition rules for:

- real primary key presence and compound order;
- eligible/searchable fields and attributes;
- at least one field;
- duplicate/empty composites and attributes;
- `$all` and result-key reservations;
- omit/extends invalidation in either method order;
- mapped fields and table names;
- implementation descriptor/options;
- managed name length and global collision.

Client construction must run search rules whenever any model declares search,
including otherwise ordinary schemas.

#### S1-U3 — Public type probes and cost

Probe real client/model calls with fresh and non-fresh values and typos beside
real keys at every new nesting level. Search-specific exactness guards must not
widen the global query exactness types. Run three warm type checks; median may
not regress by more than 5%.

### Phase S2 — Resolved definition and sealed implementations

#### S2-U1 — One resolver

Build `ResolvedSearchDefinition` after model hydration. It binds:

- complete mapped row key;
- field, composite, and attribute order;
- physical scalar metadata;
- implementation descriptor and canonical options;
- semantic revision and deterministic manifest/fingerprint.

The resolver is pure and deterministic. Migration and query consumers compare
the same manifest fixtures.

#### S2-U2 — Schema-binding cache

Cache query-side resolution per schema/client binding and actual driver
capability profile. Do not put one mutable dialect-specific program on `Model`:
the same model instance can bind to different clients and dialects.

#### S2-U3 — Built-in and extension descriptors

- Add sealed descriptors for built-in PostgreSQL, MySQL, and SQLite search.
- Add `pgroonga()` and `mysqlFullText()` as sealed option factories.
- A non-applicable descriptor falls back to the active built-in.
- Client binding reports one warning through instrumentation.
- Migration planning reports the same warning in its result surface.
- Ignored descriptors compile no requirement or SQL.

Do not implement PGroonga deployment yet; it proves the stable seam in S10.

### Phase S3 — Migration substrate prerequisites

#### S3-U1 — Atomic DDL statements

Implement §5.3 across migration drivers, generate, push, apply, down, squash,
and file writing. Prove multi-statement trigger/function bodies round-trip as one
statement. Existing DDL output remains byte-identical where it contains no
compound body.

#### S3-U2 — Exact column/index metadata

Implement collation, ordered index members/operator classes, canonical options,
and MySQL parser through serialization, DDL, differ, introspection, and
idempotent re-push. Existing public indexes retain their SQL.

#### S3-U3 — Trigger and virtual-table vocabulary

Add engine-managed `TriggerDef` and `VirtualTableDef`, not public schema APIs.
Add SQLite virtual-table recognition and FTS5 shadow filtering before producing
any search deployment.

#### S3-U4 — Apply-time requirements

Extend generated migration metadata/application so requirements are checked on
the target before the first deployment statement. Pin missing/old extension,
missing FTS5, insufficient privilege, PlanetScale, D1, and libSQL behavior.

### Phase S4 — Managed search deployment

#### S4-U1 — Snapshot and differ owner

Add `SearchDeploymentDef[]` to `SchemaSnapshot` and one managed differ for
create/rebuild/drop/repair. Reuse physical `TableDef`, `ColumnDef`, and
`IndexDef` children. Exclude managed storage from ordinary table rename and
destructive-data resolution.

#### S4-U2 — Live manifest

Implement `viborm_search_manifest`, target introspection, fingerprint
comparison, physical drift detection, and last-deployment cleanup. A revision
change plans rebuild even when the visible table columns are unchanged.

#### S4-U3 — Provider deployment compilers

Implement built-ins:

- PostgreSQL: sibling table, normalized text, per-field tsvector, GIN, source
  triggers/function, TRUNCATE handling.
- MySQL: sibling table, searchable collation, binary attributes, per-field and
  composite FULLTEXT, parser metadata, source triggers.
- SQLite/libSQL/D1: sibling table, stable integer FTS rowid, unique complete
  source row-key tuple, FTS5 external-content table, source triggers.

Migration drivers own all provider SQL. Search definitions contain no dialect
SQL.

#### S4-U4 — Full lifecycle integration

Cover push, dry-run, generate, apply on another target, down, reset, squash,
declaration add/remove/rename, implementation revision/options change,
model/table/column mapping changes, force reset, failed requirements, and
interrupted rebuild recovery.

### Phase S5 — Synchronization, backfill, and maintenance

#### S5-U1 — Trigger correctness

Prove insert, update, delete, no-WHERE delete, raw SQL, ORM mutations,
createMany, nested writes, rollback, and complete row-key transitions.
Skip trigger work when indexed inputs and attributes are unchanged.

#### S5-U2 — Backfill and concurrent-write protocol

Implement §5.6 per provider. Falsify concurrent insert, update, delete, and row
key transition during deployment. Prove no stale resurrection, lost row, or
duplicate derived row. Record lock duration and interruption recovery.

#### S5-U3 — Resync and integrity

Implement `resyncSearch`. Cover induced desynchronization, MySQL TRUNCATE,
SQLite FTS5 rebuild/integrity-check, missing managed artifacts, row-count and
complete-key reconciliation, and optional optimize maintenance.

### Phase S6 — Query normalization and adapter sources

#### S6-U1 — Versioned query AST

Implement one parser/normalizer with the S0 grammar. Adapters receive only a
normalized AST. Add fuzz/property tests for operator escaping and bounded SQL
growth. Pure-negative and malformed expressions fail at validation.

#### S6-U2 — Adapter search source

Add an exact search compiler group to each database adapter or sealed extension
owner. It returns `SearchQuerySource`. Pin source alias, complete row-key join,
rank expression, attribute expressions, and query parameters.

#### S6-U3 — Portable match conformance

Run the hostile corpus on PGlite/PostgreSQL, SQLite/libSQL, docker MySQL, and
the batch-only SQLite leg. Portable implementations must return the same hit
set within the recorded S0 contract. Ranking is asserted only for finite value
and deterministic within-provider order.

### Phase S7 — One-statement hits and `SearchOperation`

#### S7-U1 — Complete public operation registration

Add `search` to every live public/runtime owner:

- client operations, payloads, and results;
- operation-schema registry and validator;
- routed operation set;
- cacheable read set and cache flow;
- client default omit handling;
- instrumentation/logging names;
- architecture census and gates.

Do not add `search` to generic model-row result parsing as a second projection
truth. `SearchOperation` reuses `ResultParser.parse("findMany", ...)` after
separating private rank transport.

#### S7-U2 — Shared matched-set compiler

Build one `SearchMatchedSet` from definition, normalized query, `where`, and
attribute filter. It owns the complete-key join once. Hits and facets consume
it; no verb writes its own match/discriminator/provider predicate.

#### S7-U3 — Minimal trusted find seam

Extend existing find compilation with the exact internal join/source and order
expressions needed by search. Preserve ordinary find SQL byte-for-byte. Do not
expose a generic user join hook.

Pin query plans so hit filtering, rank projection, and ordering use one search
source rather than duplicate correlated search evaluation.

#### S7-U4 — Search operation and strict results

Implement a dedicated operation shell:

- empty planning;
- one hits `ReadStep`;
- optional facet/total `ReadStep` added in S9;
- normal projection parsing for the record;
- finite rank parsing through a private collision-proof SQL alias;
- public `_rank`/`_highlights` assembly;
- negative-take restoration;
- strict unexpected/missing-column failures.

Plain search must compile to one statement and execute directly in one round
trip.

#### S7-U5 — Cache and instrumentation

- Cache normalized validated args, so string shorthand and `{ $all }` share a
  key.
- Include the search-definition fingerprint in persistent cache namespacing.
- Preserve normal model mutation invalidation.
- Trace the operation and both read statements without hot-path diagnostic
  chatter.

### Phase S8 — Filters, ordering, and cursors

#### S8-U1 — Attribute filters

Compile declared attribute operators from `SearchQuerySource.attributes` with
binary/equivalent portable semantics. Apply the fixed-decimal descriptor and
codec rules.
Pin null, enum, bigint, decimal, date/time, and mapped-column behavior.

#### S8-U2 — Rank and attribute ordering

Rank defaults to descending with every row-key member as tie-breaker. Attribute
ordering reuses the existing normalized cursor-order representation after it is
extended to accept trusted field-bound expressions. Ordinary scalar order SQL
and index-seek plans remain byte-identical.

#### S8-U3 — Cursor source

Extend cursor condition construction so the cursor row can obtain declared
attribute expressions from the search source while the public cursor remains a
normal source-model `whereUnique`. Prove mapped and compound keys, null order,
forward/backward pages, wrong cursor, and no duplicates/gaps. Rank cursor is a
validation error.

### Phase S9 — Facets and totals

#### S9-U1 — Exact facet schemas and types

Implement value, range, stats, limit, and disjunctive inputs and the conditional
result types from §3. Probe every literal level through real client calls,
including non-fresh values and typos beside real keys.

#### S9-U2 — One facet/total statement

Compile one provider-portable aggregate statement from the same
`SearchMatchedSet`. It computes total and all requested facets without one
statement per facet. JSON aggregation order is not trusted; final deterministic
ordering occurs in an owned SQL or parser step.

Decode facet scalars through existing scalar result owners. Preserve each
decimal descriptor, exact provider semantics, and the existing half-even
derived-result rule.

#### S9-U3 — Two-step operation behavior

Add the aggregate `ReadStep` only when facets or `total: true` require it. Pin:

- plain search: one statement and round trip;
- facets and/or total: two statements;
- no duplicated match semantics;
- documented adjacent-snapshot behavior under concurrent commits;
- loud substrate refusal only where the existing executor cannot run the
  multi-step read.

### Phase S10 — Highlighting and sealed PGroonga preset

#### S10-U1 — Structured highlighting

Implement library highlighting over projected searchable raw text with UTF-16
offsets, structured snippets, no HTML generation, and the pinned S0 window
algorithm. Portable highlights use the shared tokenizer. Custom analysis may
provide sealed span compilation; invalid/out-of-bounds spans fail loudly.

#### S10-U2 — PGroonga deployment and query compiler

Implement the already-proven sealed descriptor through the same definition,
deployment, requirement, query-source, conformance, manifest, and rebuild
owners. Missing/old extension fails before DDL. PGroonga adds no query-engine
branch and no new artifact kind beyond the finite vocabulary.

### Phase S11 — Performance, documentation, and final hardening

#### S11-U1 — Read and write performance

Benchmark indexed vs unindexed create/update/delete/createMany and search hit,
attribute filter, rank, cursor, facet, backfill, rebuild, and resync paths on
real PostgreSQL and MySQL plus SQLite. Record write overhead, index build time,
lock duration, storage multiplier, query plan, and scale envelope.

#### S11-U2 — Public and operational documentation

Document declaration, query grammar, result shape, sorting/cursors, facets,
highlighting, portability tiers, provider requirements, locking/backfill,
replication/CDC, maintenance, resync, cache revision behavior, scale envelope,
and the exact unsupported surfaces.

#### S11-U3 — Final validation

Run sequentially through repository launchers:

```bash
pnpm test:layer:relations
pnpm test:layer:schema-validation
pnpm test:layer:operation-schemas
pnpm test:layer:migrations
pnpm test:layer:adapters
pnpm test:layer:drivers
pnpm test:layer:query-engine
pnpm test:layer:client
pnpm test:layer:cache
pnpm test:layer:instrumentation
pnpm test:types
pnpm package:build
pnpm test
pnpm test:all
```

Run `pnpm test:providers` when services are available. Run any new search
coverage commands through the same memory-capped one-worker launcher. Do not
restore the obsolete `test:gates` command.

Run three warm final type checks; median regression must remain below 5%.

## 8. Adversarial review protocol

After S2:

- Trace one model instance bound to two different driver families.
- Search for mutable program state on `Model`.
- Prove migration and query projections share definition fingerprint, field
  order, row key, and implementation options.

After S4:

- Attempt to corrupt trigger DDL with internal semicolons.
- Plant FTS5 shadow tables and foreign user triggers.
- Change only implementation revision.
- Remove one managed artifact while leaving the manifest.
- Generate, apply elsewhere, down, squash, reset, and re-push.

After S5:

- Race insert, update, delete, and compound-key transitions against backfill.
- Interrupt every lifecycle phase and re-run push.
- Confirm no derived row is treated as irreplaceable user data.

After S7/S8:

- Inspect emitted SQL for duplicate match/rank evaluation.
- Confirm every join and tie-break uses the complete ordered row key.
- Compare ordinary find SQL and cursor plans byte-for-byte.
- Inject model fields named like private SQL aliases.

After S9:

- Compare hit and facet matched-set predicates structurally.
- Check decimal and scalar codecs.
- Commit writes between the two statements and confirm documented semantics.

Before finalization, a fresh-context reviewer traces declaration → final graph
validation → manifest → deployment → trigger write → query source → matched set
→ hit/facet parsing without relying on migration history comments.

## 9. Acceptance criteria

The feature is complete only when:

- one resolved search definition owns all logical search semantics;
- search identity is the complete ordered source row key;
- one managed deployment owner controls every derived physical artifact;
- live `push()` observes implementation revision and physical drift;
- trigger/function bodies are transported atomically;
- concurrent deployment/resync cannot lose or resurrect writes;
- SQLite FTS5 shadow tables never enter the ordinary table differ;
- provider requirements execute on the migration target before DDL;
- the query engine contains no dialect-specific search SQL or operator names;
- hits and facets consume one matched-set owner;
- plain search is exactly one statement and one round trip;
- facets/total add exactly one statement;
- no hit SQL duplicates the search scan to obtain rank;
- compound-key joins, transitions, tie-breakers, and cursors use every member;
- ordinary find, projection, cursor, cache, and write paths retain their SQL and
  performance contracts;
- public types and runtime validation agree for fresh and non-fresh values;
- decimal operations never silently lose exactness;
- the type-check median regresses by less than 5%;
- all provider limitations and adjacent-snapshot semantics are documented.

## 10. Explicit non-goals

- Multiple search declarations per model.
- User-authored trigger definitions.
- Arbitrary third-party SQL callbacks.
- Fuzzy matching, synonyms, stemming/language analysis, typo tolerance.
- List-valued facets.
- Rank thresholds or rank cursors.
- SQL-generated HTML highlighting.
- Search on models without a stable primary key.
- One serialized string standing in for a compound row key.
- Online zero-lock rebuild unless separately proven per provider.
- Vector or geospatial search in this implementation.

## 11. Size and delivery expectation

This is a W-class-plus feature. The old estimate of roughly seven cohesive
pieces was too small because it omitted migration statement transport,
deployment lifecycle, live manifest ownership, compound row keys, cursor-source
extension, exact result parsing, and provider recovery.

Expected shape:

- 12 ordered phases;
- 39 named atomic units, including contract, validation, provider, performance,
  and documentation units;
- provider work begins before the public query operation;
- PGroonga proves an established seam rather than defining it;
- no new architectural layer and no parallel query engine.

The implementation may land as stacked pull requests at phase boundaries. A
failed optional provider optimization does not invalidate the portable core;
retain the correct blocking or built-in path and continue with the next unit.
