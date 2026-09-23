# RQ-07 — pre-merge elegance pass (2026-09-23)

**Scope.** The recursive-query delta of HEAD `bcb364491` (branch
`pattern-engine`), read against `ELEGANCE.md` and the frozen contract
`features-docs/recursive-query.md` (§3 owners, §3.6), through 57
deduplicated review findings from five lenses (duplication, dead code,
needless abstraction, boundary, documentation): F1–F36 in round 1, and
F37–F57 with the round-1 re-check's four minors R2–R5 in round 2 (see
**Round 2** below). One author per round applied them in the working tree;
nothing was committed, staged or pushed. Runner: Node 24.21.0 (pinned),
`TMPDIR=/private/tmp/viborm-rq-elegance-repair`, one vitest at a time through
`scripts/run-vitest-safe.mjs` (heap 768 MiB, RSS 1,536 MiB) or the
credential-free runner, never a wide run, no native lane. Logs, scratch
scripts and outputs are under `elegance-pass/`.

**Outcome.** 33 findings applied (F1 and F31 are one change), F25 applied for
three of its five declarations, 3 declined with the rule they would break.
Every test pinned by a finding is green on the final bytes, the whole-estate
typecheck is 0, and the two stale review probes went from red to green. No
test was deleted, weakened or skipped; no registration count moved. The native
PostgreSQL and MySQL lanes were not run (integrator-owned), so the four native
files this pass edited are typechecked but not executed.

| | production `src/` (code) | tests (incl. 3 new files) | scripts |
| --- | ---: | ---: | ---: |
| lines added / deleted | +306 / −373 | +969 / −1,413 | +15 / −166 |

(`git diff --numstat`, `src/query-engine/raptor3/AGENTS.md` counted with the
docs; `query.ts` alone +106 / −143.)

## Applied

Each row: lens → claim → change (owner) → files → evidence. "Pins" are the
cells the finding named; their runs are listed under **Runs**.

### Production

| # | lens | claim | change and owner | files | evidence |
| --- | --- | --- | --- | --- | --- |
| F1 + F31 | duplication, dead, boundary, abstraction | The eight carrier member names were spelled twice: a per-shape `carriers` object only the decoder read, and bare literals in the lowering. | One module constant `RECURSIVE_CARRIER`; the lowering and `decodeRecursiveCarrier` both read it; `carriers` deleted from the `recursive` arm of `ProjectionShape` and from `relationShape`. Owner: `RECURSIVE_CARRIER`. Spellings unchanged. | `raptor3/shared/query.ts` | carrier-boundary 13/13, cache-codec 10/10, provider-sql-sqlite 15/15, provider-sql-pglite 14/14. Falsified: `key: "__rq_kee"` turns 12 of the 13 carrier-boundary cells red (their literal `__rq_*` carriers) while provider-sql-sqlite stays 15/15 — the lowering and the decoder agree by construction (`44-falsify-carrier-vocabulary.log`). |
| F2 | duplication | Row identity crossed the carrier through two encoders (`recursiveIdentity` over `projectedColumn` for root and node keys, a local `tuple` over raw CTE columns for edge endpoints) that agreed only by coincidence. | `recursiveIdentity(model, key: readonly Sql[])` is the one encoder; called with `rawIdentity(parentAlias)` (`__rq_root`), `rawIdentity(node)` (`__rq_key`), `parentColumns.map(edgeColumn)` and `childColumns.map(edgeColumn)` (`__rq_parent` / `__rq_child`). `keyLeaves` and `tuple` deleted. Owner: `recursiveIdentity`. | `query.ts` | provider-sql-sqlite/pglite (mapped compound keys, distinct DateTime keys), campaign-sqlite 7/7, composition 12/12, carrier-boundary 13/13, `recursive-carrier.review` 4/4. The decimal-key equivalence, stated by reading only in the finding, was also executed: a decimal-primary-key tree answers identically on HEAD's `query.ts` and on the pass's (`41-` / `42-decimal-key-*.log`, scratch `decimal-key.scratch.test.ts.txt`). |
| F3 | duplication, abstraction | `RecursiveRelationValue` restated `WrapRelation` with naked parameters, so the repeated key distributed over a widened cardinality where the outer slot did not. | `RecursiveRelationValue` deleted; `RecursiveRelationNode<Node, S, K, R, Exhaustive>` wraps its repeated key with `WrapRelation<S, K, R, …>`; `ApplyRecurrence` passes `S, K, R`. Owner: `WrapRelation`. | `client/result-types.ts` | typecheck 0 including `tests/types/client/recursive-query.core.types.ts`. Timing could not be compared: load average 45–110 during the pass (176.8 s, then 32.2 s wall vs 9.16 s at gate-3); peak RSS 5,716.5 MiB vs 5,573.1 MiB at gate-3. |
| F4 | duplication | The two recursive node builders repeated the four shared entries, the coerce/omit/refusal chain and the factory tail; the to-many node hand-copied `orderBy`. | One `buildRecursiveNode(relation, field, recurrence, targetSchemas, collectionClauses = {})`, one tail `withRecurrence(ordinary, relation, resolved, targetSchemas, collectionClauses?)` used by both factories, one `termOrList` helper used by `buildToManyNestedNode` and the recursive node. Both node types stay. | `validation/relations/select-include.ts` | recursive-query.core 22/22, to-many 64/64, to-one 40/40, select-include 54/54, orderby 22/22, polymorphic-collection-selection 19/19; schema-introspection 13/13. See **Deviations** (key order, lazy clauses). |
| F5 | duplication | Both codec directions repeated the presence rule and `read` took `continues` only for it. | The check runs once in `walkRecursiveSlot` after `direction.read(occurrence)`; `continues` dropped from `RecursiveDirection.read` and both implementations. | `result/cache-value-codecs.ts` | cache-codec 10/10, cache-lifecycle 7/7. Falsified: removing the moved check turns "refuses a malformed value or snapshot at its own boundary" red (`43-falsify-presence-and-row.log`). |
| F6 | duplication | The complete-key join of an alias to carried key columns was written three times beside `rawIdentity`. | Local `sameRow(alias, carried)`; the three joins call it. SQL text unchanged. | `query.ts` | provider-sql-sqlite/pglite, composition, campaign-sqlite; the SQL diff in **SQL text** shows no join change. |
| F7 | duplication, abstraction | `enterSnapshotObject` repeated `withSnapshotObject`'s enter rule. | `enterSnapshotObject` moved to and exported from `cache-snapshot-structure.ts`; `withSnapshotObject` uses it. Owner: `cache-snapshot-structure.ts`. | `result/cache-snapshot-structure.ts`, `cache-value-codecs.ts` | cache-codec 10/10 (cyclic cells), `cache-result-codec-boundaries.core` 9/9. |
| F8 | duplication | The default depth 100 was stated four times; each `true` arm repeated the options arm's `{}` answer. | `DEFAULT_DEPTH = 100`, `normalizeForeignKey`, `normalizeGraph`; each `true` arm coerces through its topology's normalizer applied to `{}`. | `validation/relations/recurrence.ts` | recursive-query.core 22/22 ("normalizes foreign-key recursion once", "admits both numeric depth bounds …"). |
| F9 | duplication | The `_distance` collision sentence was declared in `query.ts` and in `result-shape.ts`. | Exported once from `result/result-shape.ts`; `query.ts` imports it and lost its copy. | `result-shape.ts`, `query.ts` | distance-key-collision 4/4. Census side effect: see **Refusal census**. |
| F10 | duplication, boundary | The static typo seal restated the recurse bag's keys. | `RecurrenceOptionKey = keyof Exclude<ForeignKeyRecurse \| GraphRecurse, true>`, type-only import from the admission owner. | `client/types.ts` | typecheck 0 (the EXACT OPTIONS cells of `recursive-query.core.types.ts`). |
| F21 | dead | Three `decodeRecursiveCarrier` guards caught nothing a provider or shipped driver produces. | (1) `identity()` returns `JSON.stringify(tuple)`; (2) `rawDepth` is read directly — a bigint depth now fails closed as `Invalid provider recursive depth` (every shipped driver `JSON.parse`s the carrier; no cell has a bigint depth); (3) the row guard is `decoded === null`. Every census sentence is still thrown elsewhere. | `query.ts` | carrier-boundary 13/13. Falsified: removing the remaining `decoded === null` guard turns "rejects sparse node and edge containers and a cyclic JavaScript carrier" red (`43-…`). |
| F23 | dead, abstraction | The reference count in `active` was unobservable. | `active` is a `Set`; `add` on enter, `delete` on leave; the count paragraph deleted. | `query.ts` | carrier-boundary cycle cells, graph-oracle 9/9, composition, campaign-sqlite junction profile. |
| F24 | dead, abstraction | The lowering's `assertInvariant(recurrence !== undefined)` could not fire. | `lowerRecursiveRelationProjection(relation, recurrence: NormalizedRecurrence, parentAlias)`, called with the already-narrowed `field.recurrence`; the assertion deleted; the refusal map's RQ-5 row retired. | `query.ts`, `refusals-map.md` | provider-sql-sqlite/pglite, composition, distance-key-collision; census invariants 24 → 23 sites. |
| F25 (3 of 5) | dead | Five exports had no importer. | `export` dropped from `RecursiveRelationNode`, `HasCompleteStaticPrimaryKey`, `RecursiveRelationSlot`. `ForeignKeyRecurse` / `GraphRecurse` keep theirs (declined below). | `result-types.ts`, `schema/relation/static-membership.ts`, `cache-value-codecs.ts` | typecheck 0. |
| F26 | dead, abstraction | `arrays.literal`, `arrays.push`, `setOperations.unionAll` lost their only caller and were not labelled Reserved; `cte.recursive`'s default mode is unused. | Labelled "Reserved — not called by the query engine yet." (the siblings' label); `cte.recursive` notes that the engine calls only `"distinct"`. Comment-only. | `adapters/database-adapter.ts` | no run (comments). |
| F30 | abstraction | The CTE carried a root identity role neither reader read. | `rootColumns` and its two spreads deleted; the carrier's `__rq_root` (the outer row's key) kept. | `query.ts`, `raptor3/AGENTS.md` | provider-sql-sqlite 15/15 and provider-sql-pglite 14/14 (transport counts per root carrier), carrier-boundary, campaign-sqlite. SQL shrinks by 113 chars (SQLite) / 109 (PostgreSQL) per statement. |
| F33 | abstraction | Both readers wrapped `json.agg` in a second `COALESCE(…, emptyArray)`. | The readers use `a.json.agg(…)` directly; `json.agg`'s doc now states that an empty aggregate is the empty array (all three adapters already coalesce). | `query.ts`, `database-adapter.ts` | natural-end `[]` cells in provider-sql-sqlite/pglite and carrier-boundary; re-recorded SQL bytes. |
| F35 | abstraction | `frame`, `decodeOccurrence` and `required` were single-use closures. | `frame` and `decodeOccurrence` inlined into `follow` (enter, decode, push — order unchanged); `required` inlined into `collapse`, keeping the CM002 `assertInvariant`. | `query.ts`, `refusals-map.md` (RQ-2 row names `collapse()`) | carrier-boundary `__rq_row: null` cell, every occurrence/cutoff cell. |
| F36 | abstraction | `RenderedAliases` was a one-field interface around an array. | The array is passed directly; the interface deleted (see **Deviations**). | `client/typescript-type-renderer.ts` | schema-introspection 13/13, distance-key-collision 4/4 (`_distance?: Array<VibORMRecursiveNode1>`). |

### Tests, harness and scripts

| # | lens | claim | change | files | evidence |
| --- | --- | --- | --- | --- | --- |
| F11 | duplication | The placement-matrix cell body was copied between the SQLite and PGlite tests. | `runPlacementMatrix(engine, observed)` in the fixture, beside `runCase`, holds exactly those assertions; both cells call it. | `provider-sql-fixture.ts`, `provider-sql-sqlite.test.ts`, `provider-sql-pglite.test.ts` | 15/15 and 14/14 (unchanged counts). |
| F12 | duplication, abstraction | Two table languages, four DDL generators, and hand-written matrix DDL in three providers. | `ColumnSpec` / `TableSpec` are the one language; the campaign tables are `Omit<TableSpec, "rows">`; `columnDefinitions(table, types, quote)` is the one speller used by the four generators; the matrix's five tables are `PLACEMENT_MATRIX_TABLES` (rows from `PROVIDER_INITIAL`), created by the same generator as the HIERARCHY and GRAPH worlds on all three providers. | fixture, provider-sql-sqlite/pglite/native, `campaign-harness.ts`, `campaign-native.test.ts` | SQLite 15/15, PGlite 14/14, campaign-sqlite 7/7 (the neutral-tables-vs-migrated-schema cell). Native: typechecked, **not executed**. |
| F13 | duplication | The native test repeated `runCase`'s outcome rule. | `caseOutcome(engine, providerCase)` (value reported before `check`, `QueryEngineError` → `{ failure }`, anything else rethrown) and `owedOutcome(providerCase)` in the fixture; `runCase` asserts `deepEqual(await caseOutcome(…), owedOutcome(…))` before its statement and transport checks; the native test wraps the pair and keeps only its MySQL recursion-limit arm (a `QueryError`, never a `QueryEngineError`, `rq07-native-lanes.md` F3, so the wrapper still sees it). | fixture, `provider-sql-native.test.ts` | SQLite and PGlite world-group cells green. Native: **not executed**. |
| F14 | duplication | Each campaign runner wrote its own receipt block and minimization loop. | `minimizeFailures(cases, verdicts, { insert, statements, client, model })` owns the `100_000` seed start and the judge predicate; `recordCampaignReceipt(provider, providerFacts, invocation, verdicts, minimized)` is the one `afterAll` body. | `campaign-harness.ts`, `campaign-sqlite.test.ts`, `campaign-native.test.ts` | campaign-sqlite 7/7 (incl. the minimizer self-test). Native: **not executed**. |
| F15 | duplication | Two near-verbatim witness files; the second's header claimed a difference that no longer existed. | `tests/raptor3/g4/recursive-fit-cells.ts` exports `describeRecursiveFit(title, entry)` with the schema, seeds, driver, hooks and three cells; each file passes its entry (client `findMany`, engine `execute`); the stale "one change" sentence corrected. | `g4/read-recursive-fit.test.ts`, `g4/unit02/recursive-codec-fit.test.ts`, new `g4/recursive-fit-cells.ts` | 3/3 each (registrations unchanged). |
| F16 | duplication | Two hand-written provider-less counting PostgreSQL drivers and two counting memory caches. | `CountingDriver extends SqlOnlyDriver` in both files (the admission test keeps `supportsTransactions = false`, `supportsBatch = true`); one `CountingMemoryCache` in `tests/fixtures/counting-memory-cache.ts`. | `distance-key-collision.test.ts`, `recursive-query.core.test.ts`, new fixture | distance 4/4 (0 statements, 0 reads, 0 writes); recursive-query.core 22/22 ("refuses invalid recursion before the cache or the provider is asked"). |
| F17 | duplication | Two RQ modules re-implemented the fixture's walkers. | `chainSummary(relation, field = "label")`, used by composition with `"id"`; the harness sums `occurrenceCount(relation)` over its roots. | fixture, `composition.test.ts`, `campaign-harness.ts` | composition 12/12 (cell 4, the 5,000-level chain), campaign-sqlite 7/7. |
| F18 | duplication | Three copies of one decoder factory. | One `decoderFor(model, relation, recurrence, select)`; the three factories are one-line calls with today's arguments. | `carrier-boundary.test.ts` | 13/13. |
| F19 | duplication | Two copied `world()` seeds of one topology. | `tests/raptor3/recursive-query/cache-world.ts` holds the rows and links and `seedCacheWorld(client, extra)`; each file keeps its schema and fills its own columns. | `cache-codec.test.ts`, `cache-lifecycle.test.ts`, new `cache-world.ts` | 10/10 and 7/7. |
| F22 | dead | Two review probes still pinned the retired `Queries.recursive` and failed at HEAD. | alias-scope: `"recursive"` left `STATEMENT_OWNERS` ("six" → "five"), the contract change named at the list; native-fixture-satisfiable: the recursive cell now pins `candidate.execute("node", "findMany", {` and `children: { recurse: { depth: 2 },` plus the one-statement assertion, renamed, header corrected, contract change named. No assertion deleted. | `g4/review/perf/alias-scope.review.test.ts`, `g4/review/witness/native-fixture-satisfiable.review.test.ts` | **Red before**: alias-scope FAIL, 3 skipped (`00-alias-scope-before.log`); native-fixture-satisfiable 1 failed / 4 passed (`01-…`). **Green after**: 3/3 and 5/5 (`67-`, `68-`). |
| F27 | dead | `RQ01_NATIVE_TESTS` had no reader; `RQ06_NATIVE_TESTS` fed only a redundant spread. | Both deleted with the spread and its import; the `*_NATIVE_COUNTS` objects kept. | `scripts/raptor3-manifest.mjs`, `scripts/credential-free-test-manifest.mjs` | Every other export of both manifests evaluates identically before and after (238 exports compared; only the two deleted differ). `raptor3-campaign-receipts.test.mjs` 41/41. |
| F28 | dead, abstraction | The census's private-fit machinery looped over an empty list. | `PRIVATE_FITS` and all of its code deleted (`selectsDiscriminant`, `fitAnchor`, `sourcePaths`/`checkFit`/`fits`, the INTERNAL branch, `internals`/`internalSentences`, the report sentence, banner, row, section, stdout count and exit clause); the header reduced to two outcomes; `declarationName`, whose only caller was `fitAnchor`, deleted with it. | `scripts/raptor3-refusal-census.mjs`, `raptor3/AGENTS.md` | census self-test 7/7; refusal and invariant accounting per **Refusal census**. |
| F29 | dead | The refusal map's RQ addendum pointed at stale lines and said 12 cells; the contract spoke of the retired slice in the present tense. | Map rows name their owning symbols; "(13 cells, `RQ06_CARRIER_BOUNDARY_COUNTS`)"; features-docs §1 "Already present" / "current slice" paragraphs in the past tense as the RQ-00 baseline, retired by RQ-03 (§3.6). | `refusals-map.md`, `features-docs/recursive-query.md` | text. |
| F32 | abstraction | The RQ-06 harness had its own receipt identity framework next to `captureRaptor3Identity()`. | Receipts are stamped with `captureRaptor3Identity()` plus the lane's provider facts and written where `VIBORM_RAPTOR3_EVIDENCE_DIRECTORY` points; `sourceTreeDigest`, `sourceIdentity` / `SourceIdentity`, `runtimeIdentity` and the `VIBORM_RQ06_RECEIPT_DIR` switch deleted. The recorded `rq6-campaign-*.json` stay as history. | `campaign-harness.ts`, both runners | campaign-sqlite 7/7 (the cells never read identity fields). No receipt was written in this pass. |

## Deviations from the letter of a request

- **F4, schema key order.** One shared builder cannot keep both nodes' key
  order: the to-one node listed `recurse` first, the to-many node last. The
  builder spreads the collection clauses first and ends with `recurse`, so the
  to-many node is unchanged and the to-one recursive node now lists `recurse`
  last — as the ordinary to-one, ordinary to-many and recursive to-many nodes
  already do. Only JSON-Schema property order can observe it (the object
  validator's fast path iterates input keys); no JSON-Schema cell covers a
  recursive node (the introspection JSON-Schema cells use the user/post
  schema), and the admission suites above are green.
- **F4, laziness.** `withRecurrence` takes the collection clauses as a thunk,
  so the six to-many clause schemas are built only for a slot that recurses,
  as `buildToManyRecursiveNode` built them before; `buildRecursiveNode` keeps
  the requested `collectionClauses = {}` object parameter.
- **F9, census.** The census resolves only local constants, so the three
  `query.ts` throws of the imported sentence are now counted under "no
  sentence (rethrow)" and the sentence leaves its inherited list (see
  **Refusal census**). The runtime sentence, class and sites are unchanged.
- **F14 with F32.** The receipt helper takes the provider id, the provider
  facts and the invocation (chunking) text; the harness-file list it would have
  taken fed only `sourceIdentity`, which F32 deleted — `captureRaptor3Identity`
  fingerprints all of `tests/raptor3/**`, `scripts/**` and the lockfile.
- **F32.** The receipt's shape changed (`source` + `runtime` →
  `identity` + `providerFacts`), so `formatVersion` is 2. The identity is
  captured only when a directory is set; the credential-free lanes set
  `VIBORM_RAPTOR3_EVIDENCE_DIRECTORY` empty, so they write nothing, as before.
- **F12.** `ColumnType` includes `json`, so the native campaign's type map
  gained a `json` entry it never uses.
- **F18.** `decoderFor`'s `model` is the model's schema key (`"treeNode"`, …)
  so each `EngineSchema` registers the model under its original name.
- **F23.** The last sentence of the deleted paragraph (why the path is the
  stack, not a copied ancestry) is kept; it is not about the count.
- **F36.** The declaration element is named `AliasDeclaration` (the structural
  type was already written twice); no bag type remains.
- **F26.** The label reuses the siblings' exact wording, "… yet."
- **Docs beyond the findings.** `raptor3/AGENTS.md` names the two owners F1
  and F2 created (`RECURSIVE_CARRIER`, `Queries.recursiveIdentity`) in the
  paragraph F30 edits. `rq07-cost-measures.md` gained a dated section (F30/F33
  asked to re-record the SQL bytes; the measured table keeps its identity).
- **Biome.** See **Biome**: regexes hoisted in the fixture (including
  `runCase`'s pre-existing one) and the repository's file-level
  `biome-ignore-all lint/suspicious/noMisplacedAssertion` convention for shared
  assertion helpers applied to the fixture and the new cells module.

## Declined

| # | lens | the requested change | rule or pinned behaviour it would break | recorded instead |
| --- | --- | --- | --- | --- |
| F20 | dead | Delete the recursive shape's `optional` flag (`ProjectionShape` → `RecursiveRelationSlot`), the decoder's CM002 assertion and the codec's `failCacheSnapshot()` arm, retiring the `required` half of `cache-codec.test.ts:714-728`. | **A test is never deleted or weakened**: the `required` half of that cell is the only pin of the codec's refusal of a missing singular successor, and it would be retired. The change also renegotiates §2.4's row "Missing target for a required singular slot → existing result-integrity failure" (§2 is not renegotiable in code). The finding itself names this fallback. | The flag stays as **the deliberately pinned emptiness fact** (`slotMayBeEmpty(resolved)` → `optional`; CM002 is why every admitted value is `true` today). Pending maintainer decision; recommended default: keep. |
| F25 (2 of 5) | dead | Drop `export` from `ForeignKeyRecurse` and `GraphRecurse`. | **One owner per fact**: F10 (applied) makes `client/types.ts` read `RecurrenceOptionKey` from exactly these two bag types; un-exporting them would force the key set back into a second spelling. | Both stay exported with one importer. |
| F34 | abstraction | Replace `recursiveIdentity` by a local `identityTuple` over `projectedColumn` for root and node keys and raw columns for edges. | **One owner per fact**: F2 (applied) already made one encoder of all four identities from the raw key columns and named `recursiveIdentity` the owner; F34 would delete that owner and restore the projected-versus-raw split whose agreement F2 removed. | F2 stands. |
| F37 | boundary | (The finding arrived truncated: its evidence stops mid-sentence and it carries no requested change.) Its claim: `decodeRecursiveCarrier` throws plain `TypeError`s that reach the caller untranslated, where the sibling arms throw `InvalidScalarResult` through `OperationContext.failure`. | **No behaviour change without its contract**: routing these sentences through `InvalidScalarResult` makes `OperationContext.failure` replace them with `Driver "…" returned a malformed … scalar for operation "…": ….`, while contract §2.3 names `Invalid provider recursive depth` as the caller-visible refusal for a volatile filter; the carrier-boundary cells pin the eleven sentences. Nothing to apply exactly. | Open question for the maintainer: §3.3 says "Reject malformed data through the existing result error model", which the untranslated `TypeError` arguably is not. A decision is needed on the public sentence before any change. |

## Runs (final bytes)

All on the tree after the last edit; first-pass runs (`30-`–`39-`) were
green too.

| run | files → cells | result | log |
| --- | --- | --- | --- |
| `raptor3` project | composition 12, cache-codec 10, cache-lifecycle 7, carrier-boundary 13, campaign-sqlite 7, graph-oracle 9, provider-sql-sqlite 15, distance-key-collision 4 | 77 / 77 | `61-final-rq-deterministic.log` |
| `raptor3` project | prep/recursive-read-fit 6, g4/read-recursive-fit 3, g4/unit02/recursive-codec-fit 3, g4/unit01/recursive-vocabulary 1 | 13 / 13 | `62-final-rq-migrated-pins.log` |
| `run-credential-free-tests --only provider-sql-pglite` | provider-sql-pglite 14 | 14 / 14 | `63-final-rq-pglite.log` |
| `layer-operation-schemas` | recursive-query.core 22, to-many 64, to-one 40, select-include 54, orderby 22, polymorphic-collection-selection 19 | 221 / 221 | `64-final-operation-schemas.log` |
| `layer-client` | schema-introspection.core 13 | 13 / 13 | `65-…` |
| `layer-query-engine` | cache-result-codec-boundaries.core 9 | 9 / 9 | `66-…` |
| perf review workspace | alias-scope.review 3 | 3 / 3 (red at HEAD) | `67-…` (`00-…` before) |
| witness review workspace | native-fixture-satisfiable.review 5 | 5 / 5 (1 red at HEAD) | `68-…` (`01-…` before) |
| unit02-phase2 review workspace | recursive-carrier.review 4 | 4 / 4 | `69-…` |
| `run-node-safe` | raptor3-refusal-census.test.mjs | 7 / 7 | `70-…` |
| `run-node-safe` | raptor3-campaign-receipts.test.mjs | 41 / 41 | `71-…` |
| `run-typecheck.mjs` | whole estate | exit 0 (32.2 s, 5,716.5 MiB) | `60-typecheck-final.log` |

**Falsifications** (each on a backup-restored copy, `cmp` verified after):
the moved presence check and the kept row guard (`43-`), the carrier
vocabulary (`44-`), and the decimal-key probe on HEAD's `query.ts` (`42-`).

## SQL text

Five statement shapes cover every cell of `rq07-cost-measures.md`; each
shrinks by 113 characters on SQLite and 109 on PostgreSQL with bind counts and
decoded values unchanged (1,687 → 1,574, 1,568 → 1,455, 1,668 → 1,555,
1,866 → 1,753, 1,746 → 1,633 on SQLite). The diff is exactly the two removed
root columns and the two outer `COALESCE`s. Re-recorded in
`rq07-cost-measures.md`; data in `elegance-pass/sql-shapes-{before,after}.json`.

## Refusal census

`scripts/raptor3-refusal-census.mjs` on HEAD vs the final tree
(`elegance-pass/census-head.md`, `census-final.md`): invariants 24 sites / 23
sentences → 23 / 22 (F24's site); candidate refusals 47 / 36 → 46 / 36 (F21's
second `…recursive identity` site); inherited 76 / 75 → 73 / 74 and "no
sentence" 58 → 61 — the three `query.ts` throws of the `_distance` collision
sentence, now imported from `result-shape.ts` (F9), which the census reads as
another owner's value; total sites 205 → 203. The report no longer prints the
always-zero private-fit row and empty section (F28).

## Biome

`pnpm dlx ultracite check` runs Biome 2.5.14 through `pnpm dlx`; the
repository pins 2.3.11. Both were compared on HEAD's and the final bytes of
every touched file (`elegance-pass/72-`, `73-`, `74-`, `75-`, scripts
`biome-compare*.sh.txt`, `format-hunks.py.txt`):

- **Lint / assist:** no rule count grew in any file, under either version;
  counts fell in the G4 witness pair (noMisplacedAssertion 4 → 0,
  organizeImports 2 → 0), the fixture (noMisplacedAssertion 18 → 0,
  useTopLevelRegex 1 → 0) and the SQLite / PGlite tests (useTopLevelRegex
  12 → 0). Pre-existing diagnostics elsewhere are unchanged and were not
  touched.
- **Format:** files that were formatter-clean at HEAD are clean after
  (`select-include.ts` and the census were re-formatted). `query.ts` and the
  SQLite / PGlite / native provider tests were not formatter-clean at HEAD
  (their prevailing style keeps trailing commas in call arguments); the only
  lines of this pass the formatter would still change there are those
  trailing commas, kept to match the file. Reformatting those whole files
  would be unrelated churn.

## Registrations

No count moved: RQ01_SQLITE 15, RQ01_PGLITE 14, RQ06_CARRIER_BOUNDARY 13,
RQ05_CACHE 10 + 7, RQ06_COMPOSITION 12 + 7, RQ06_GRAPH_ORACLE 9,
RQ07_FOLLOWUP 4, G4 read-recursive-fit 3, g4-unit02 recursive-codec-fit 3,
RQ01_NATIVE 3, RQ06_NATIVE 4. The three new files are helper modules, not test
files. The only manifest edit is F27's removal of two unread exports; the
integrator owns the manifests and should know of it.

## Not re-run, unverified

- Native PostgreSQL / MySQL (integrator-owned): `provider-sql-native` (3),
  `campaign-native` (4), `read-envelope-native` (5). This pass edited the first
  two files (F12, F13, F14, F32) and changed the statement text every native
  cell executes (F30, F33); all are typechecked, none executed natively.
- Timing of F3's type change (machine load 45–110 during the pass).
- `pnpm test:coverage:adapters` (F26 is comment-only), the package build, the
  docs site, the full local gate and perf protocol.
- Receipt writing (F32): no run set `VIBORM_RAPTOR3_EVIDENCE_DIRECTORY`.

## Documentation checked

Updated: `features-docs/recursive-query.md` (§1 baseline tense),
`g4/release/plan/refusals-map.md` (RQ addendum: symbol pointers, 13 cells,
RQ-2 names `collapse()`, RQ-5 retired with a dated note),
`src/query-engine/raptor3/AGENTS.md` (parent/child CTE facts, the carrier and
identity owners, the census's retired private-fit bucket),
`rq07-cost-measures.md` (SQL bytes). Public docs
(`docs/content/docs/client/selecting.mdx`, `README.md`, `CHANGELOG.md`) name no
symbol this pass changed and describe unchanged behaviour. Left as dated
history on purpose: `rq6.md` and `rq07-native-lanes.md` (they record runs made
with `VIBORM_RQ06_RECEIPT_DIR`), `handoff-2026-09-23.md` (it mentions
`PRIVATE_FITS` as empty) — the next handoff supersedes them.

## Round 2

**Scope.** The findings round 1 never received in full — F37–F57 (lenses
boundary and documentation) — and the re-check's four minors on round 1's
work (R2–R5), read from their full text. Same rules, same tree (HEAD
`bcb364491` plus round 1's uncommitted edits), one author, nothing committed,
staged or pushed. Runner: Node 24.21.0 (pinned),
`TMPDIR=/private/tmp/viborm-rq-elegance-repair2`, one vitest at a time
through `scripts/run-vitest-safe.mjs` (heap 768 MiB, RSS 1,536 MiB) or the
credential-free runner, no wide run, no native lane. Receipts, logs and the
scratch witnesses (outside the repository, copied as `.txt`) are under
`elegance-pass/round-2/`. Round 1's sections above are kept as they were;
where this round supersedes one of their records, it says so here.

**Outcome.** 24 findings applied (F38–F57, R2–R5), none declined. F37 is not
applied, by instruction: it is a public error-identity decision, recorded
below as pending with both options. Each production change has its witness
(byte-identical SQL on 21 statements with a falsification, for F38), each
harness change a red-before/green-after witness (R3, R4) or an equivalence
witness (R2, R5), every affected cell is green on the final bytes, the
whole-estate typecheck is 0, and the lint diagnostics of the touched code
files equal those of their pre-round bytes. No test was deleted, weakened or
skipped; no registration count moved. The native PostgreSQL and MySQL lanes
were not run (integrator-owned).

This round's own delta, against the pre-round bytes (`git diff --no-index
--numstat` of each file's backup):

| | production `src/` code | `src/` guides and README | scripts | tests | docs |
| --- | ---: | ---: | ---: | ---: | ---: |
| lines added / deleted | +19 / −16 | +16 / −14 | +135 / −6 | +182 / −94 | +88 / −77 |

(`query.ts` +17 / −13 and `typescript-type-renderer.ts` +2 / −3, a comment;
the census's import resolution is R4's +135 / −6; the fixture's +134 / −82 is
R5's records, which the formatter spells one field per line, and R2.)

### F37 — pending maintainer decision (not applied)

This supersedes round 1's F37 row, written from a truncated finding.

**The question.** `decodeRecursiveCarrier` rejects a malformed provider
carrier at 16 throw sites, with 12 distinct messages (`Invalid provider
recursive carrier`, `… recursive depth`, …), each a plain `TypeError`. The
sibling arms of the same decoder throw `InvalidScalarResult`, which
`OperationContext.failure`, the operation's one public translator, turns into
`QueryEngineError('Driver "<driver>" returned a malformed <scalarType> scalar
for operation "<operation>": <reason>.', { meta: { driver, operation,
scalarType } })`; the region catch gives result-phase attribution to that
class only. What public identity should a malformed recursive carrier have?

**Option A: keep the `TypeError` (the tree as it stands).**

- Keeps: the caller reads the decoder's own sentence, which contract §2.3's
  volatile-filter limit names (as rewritten by F44 below); the 13
  carrier-boundary cells; the census's 12 candidate sentences and the
  refusal map's RQ-3 row as written.
- Breaks or leaves: the failure is not a VibORM error (`isVibORMError`
  false; `classifyFailure` calls it a defect) and carries no driver,
  operation or scalar meta and no result-phase attribution. In batch mode
  after a committed segment it reaches the caller as the generic
  `Record-series execution failed at a committed-segment boundary.`, with the
  `TypeError` as its cause. It departs from the layer guide ("the decoder's
  structural failures are `InvalidScalarResult`, which `run` publishes as
  the public `QueryEngineError`"), from contract §3.3 ("Reject malformed data
  through the existing result error model") and from the sibling arms.
  Within one carrier, a malformed identity scalar already fails through
  `decodeScalar`'s `InvalidScalarResult`, so the same carrier's failures
  reach the caller under two identities.

**Option B: the finding's change, `throw new InvalidScalarResult("<phrase>",
"<the failure that guard alone catches>")` at each of the 16 sites.**

- Keeps: every decoder-level message byte for byte (`Invalid provider
  ${scalarType}`), still a `TypeError` by subclass, so the 13 carrier-boundary
  cells, which call the decoder directly, stay green; the FK-cycle
  `QueryEngineError`, the CM002 invariant and the identity scalars' own
  failures are unchanged.
- Changes: the public failure becomes the same `QueryEngineError` as a
  malformed ordinary collection or row (V9001, a defect to `classifyFailure`
  like its siblings), with `meta.scalarType` naming the check, result-phase
  attribution and record-series progress. One owner, `OperationContext.failure`,
  then holds the public identity.
- Breaks or owes: the caller no longer reads the decoder sentence, so §2.3's
  limit must name the `QueryEngineError` and its `meta.scalarType` in the
  same change. The census reads a `(kind, reason)` construction's first
  argument that contains a space, so it would record each site's phrase
  (`recursive depth`, …) as the sentence: its counts and the map's RQ-3 row
  must be re-recorded. The public witness the finding asks for (a fake
  driver answering a malformed carrier to a public read, which must reject
  with that `QueryEngineError`) and its `RQ06_*` registration are owed.

**Recommended default: B**, landed as one change with its §2.3 sentence, its
public witness and its registration. The rule already exists in the layer
guide and in §3.3, the sibling arms follow it, and B changes no decoder-level
message. Round 2 changed nothing here. Arnaud then chose B (2026-09-23), and
B is landed on the tree: see **F37 — applied (Option B, Arnaud's decision)**
at the end of this ledger.

### Applied — production `src/` code

| # | lens | claim | change and owner | file | run |
| --- | --- | --- | --- | --- | --- |
| F38 | boundary | The LATERAL placement wrote its own `FROM` and one-row source instead of using the adapter-owned SELECT assembly. | The LATERAL arm of `lowerRecursiveRelationProjection` returns ``a.subqueries.scalar(assembleAdapterSelect(a, { columns: carrier(…), from: a.subqueries.correlate(a.clauses.select(sql`1`), one), joins: [a.joins.lateral(…, facts)] }))``. Owner: `assembleAdapterSelect`. | `raptor3/shared/query.ts` | Statement text and binds byte-identical before and after for 21 statements: 7 shapes (tree bounded, exhaustive, upward singular and multi-root; graph bounded and exhaustive; compound mapped key, multi-root) on PostgreSQL and MySQL (the LATERAL arm) and SQLite (`00-`, `05-`, `sql-shapes-{before,after-f38,final}.json`). Falsified in place (`` sql`2` `` in `from`): exactly the 14 LATERAL statements differ (`06-`); restored by `cp`, `cmp` identical. PGlite 14/14, including "mapped compound identity, multiple roots and tied sibling order" (`11-`, `32-`); distance-key-collision 4/4 (PostgreSQL lowering). Native lanes not executed. |
| F55 | documentation | The recursive result's rendering format (alias names, one per slot, outer-first) was written three times. | `operationResultType`'s JSDoc keeps the reason and points to `renderOperationResultType` ("format: …"), whose public JSDoc keeps the format. Comment only. | `client/typescript-type-renderer.ts` (guide below) | typecheck 0. |

### Applied — tests, harness and scripts

| # | lens | claim | change | file | run |
| --- | --- | --- | --- | --- | --- |
| F39 | boundary | The engine-entry cells lowered raw `recurse` spellings that no admitted payload produces. | One `EngineSchema` shared with the `Queries`; cells 1 and 4 pass `engine.admit(place, "findMany", args)`; the V4001-refused `included` spelling enters the engine as the constant `includedAdmitted` (`recurse: { depth: 100, cycles: "reject" }`); the `as never` casts are gone. No assertion changed; the public-client and schema-only cells are as they were. | `distance-key-collision.test.ts` | 4/4 (`10-`, `31-`). |
| R2 | re-check of F13 | `caseOutcome` compared a `structuredClone` of every value, blind to prototypes, class identity and symbol keys. | `reported = summarize ? summarize(value) : check ? structuredClone(value) : value`: a copy only where a check can mutate. The native wrapper shares the rule. | `provider-sql-fixture.ts` | Scratch witness (`fixture-r2-r5.scratch.test.ts.txt`): a null-prototype row and a symbol-keyed row pass round 1's rule and fail the new one; a case with a check still reports a copy taken before the check mutates (`07-`, `30-`). provider-sql-sqlite 15/15, provider-sql-pglite 14/14. |
| R3 | re-check of F17 | The fixture walker's assertion made `judgeOutcome` throw on a malformed published value instead of answering a mismatch verdict. | The finding's first shape: `occurrences` is counted only once the value equals the oracle's rows; a mismatch verdict carries `digest`, `mismatch` and `owner`. F17's single walker is unchanged. | `campaign-harness.ts` | Scratch witness (`judge-total.scratch.test.ts.txt`), red before: a primitive row, a primitive member and a null row each threw `AssertionError: a recursive occurrence is one public object` (`08-`); green after, and a matched value still carries `occurrences` then `digest` (`09-`, `30-`). campaign-sqlite 7/7. |
| R4 | re-check of F9 | The census could not read the `_distance` collision sentence `query.ts` imports from `result-shape.ts`, so its three sites fell to "no sentence". | The census follows a named import to the exporting module's top-level `export const`, resolving the censused tree's `tsconfig.json` `paths` or a relative specifier (`--at` reads the revision). Only the sentence renderer follows it, and only when no declaration, parameter or catch clause of the file binds the name; a thrown value or a factory stays the site's own. | `scripts/raptor3-refusal-census.mjs` | Red before (`01-`, `census-before.md`): inherited 73 sites / 74 sentences, "no sentence" 61, the three `query.ts` sites without a sentence. After (`02-`, `20-`, `census-final.md`): inherited 76 / 75 and "no sentence" 58, HEAD's figures; the diff is exactly those three sites joining the inherited sentence. Candidates 36 at 46 sites, invariants 22 at 23, total 203: unchanged. `--at HEAD` still reproduces round 1's HEAD census, apart from F28's removed prose (`04-`). Self-test 7/7 (`03-`, `21-`). |
| R5 | re-check of F11/F12 | Five table names, five row tuples and `PROVIDER_INITIAL` had no importer outside the fixture; the tuples existed only to build `PROVIDER_INITIAL`. | The finding's "better" shape: the five tables' rows are records written in `PLACEMENT_MATRIX_TABLES`; the tuples and `PROVIDER_INITIAL` are deleted; the five `*_TABLE` names are no longer exported. | `provider-sql-fixture.ts` | Scratch witness: `PLACEMENT_MATRIX_TABLES` is `deepStrictEqual` to round 1's and equal in JSON key order (`07-`, `30-`). provider-sql-sqlite 15, provider-sql-pglite 14 (unchanged counts); native 3 typechecked. |

### Applied — documentation

Each sentence written was checked against the tree as it now stands (round 1
included); where another document owns a fact, the new text points to it.

| # | lens | claim | change | file | checked against |
| --- | --- | --- | --- | --- | --- |
| F40 | documentation | §1 and §3.4 still described the retired slice and the deleted cache refusal as current. | Heading "Provenance and the RQ-00 baseline"; "Present at the RQ-00 baseline (the private slice has since been retired, §3.6):"; "Not proven at that baseline (proven since, see the release verdict):"; §3.4: the recursive arm composes `recursiveRelationCodec` from the node's ordinary row codec, the refusal is deleted. The "That slice carried …" sentence already read as requested (round 1's F29). | `features-docs/recursive-query.md` | `client-route.ts` `case "recursive"` returns `recursiveRelationCodec(slot, shapeCodec(shape.row, …))`; no document links the old heading. |
| F41 | documentation | `PENDING_WORK.md` still listed recursive queries as future feature 1 and first priority. | The future-feature block becomes "_No future feature currently tracked._"; a Recently Completed row; Priority Order points at the deferred hosted qualification; "September 2026". | `PENDING_WORK.md` | Contract §1 defers hosted qualification; the row's paths exist. |
| F42 | documentation | The central plan still called the feature uncommitted and still to implement, without RQ-01's acceptance or the verdict. | The four requested replacements (status, RQ-01 accepted with the final review, the verdict pointer, §10). | `docs/architecture/raptor3-implementation-plan.md` | `bcb364491`'s parent is `076fad02b` and no remote branch contains it; `bc18b4e23` is an ancestor of `076fad02b`. |
| F43 | documentation | The verdict contradicted itself on RQ-01's review and named gate-2 as the last gate. | Status line: "and, last, RQ-01 as one unit and the follow-up round, `rq07-final-review.md`: ACCEPT after one bounded repair round", and gate-3 "on the final bytes"; the Outcome paragraph restated (see **Round 2 deviations**). | `rq07-release-verdict.md` | `rq07-final-review.md` (A ACCEPT; B REVISE; one bounded Opus repair round; re-check ACCEPT; tree over `4ead1c591`); `rq01-sql-placement.md` (decoder repair REVISE, then ACCEPT); the last amend, `3c86b331f` → `bcb364491`, changed no `src/` byte. |
| F44 | documentation | The volatile-filter limit named one sentence and one mechanism. | §2.3: refused at the carrier boundary; PostgreSQL's per-level hop check (`Invalid provider recursive depth`); SQLite typically `… recursive edge endpoint` or `… unreachable recursive node`. `selecting.mdx`: " between hops" deleted. | contract; `docs/content/docs/client/selecting.mdx` | The final review's probe (SQLite 11 resolved, 32 edge endpoint, 17 unreachable node; PGlite 52 resolved, 8 depth; one CTE with two scans on PGlite); the guide's "once per reader". No suite pins it. |
| F45 | documentation | The page omitted two admission refusals and did not say where 3636 appears. | The `recurse: false` and asking-key refusals added; the provider limit is the driver's error with `meta.providerErrno` 3636, the message redacted (see **Round 2 deviations**). | `selecting.mdx` | `recursive-query.core.test.ts` "reads recurse: undefined … refuses recurse: false" and "refuses the asking key …"; `rq07-native-lanes.md` F3 (a driver `QueryError`, errno 3636, message redacted); `drivers/error-mapping.ts` sets `meta.providerErrno`. |
| F46 | documentation | The page did not name the FK-cycle error, which the errors page describes as a bug (V9001). | `selecting.mdx` names the `QueryEngineError` and calls the cycle a property of the data; the V9001 bullet in `errors.mdx` names the one exception. Docs only: whether the refusal should carry its own code or subclass is Arnaud's decision, as the finding says. | `selecting.mdx`, `docs/content/docs/client/errors.mdx` | `follow()` throws `QueryEngineError` without a code, so V9001; `classifyFailure` calls V9001 a defect. |
| F47 | documentation | §2.4 and §5 promised a result-integrity failure no admitted schema reaches. | Both rows annotated (CM002; the decoder's invariant); the contract is not renegotiated. | contract | `collapse()`'s `assertInvariant`; campaign-sqlite's CM002 cell; `relation-resolution.ts` CM002. |
| F48 | documentation | §3.5 omitted `recurrence.ts` and `RecursiveProjectionRootGuard`; §3.1 listed checks the reader does not repeat. | The Relation admission row names `recurrence.ts` and what it owns; Public result inference adds `types.ts`; SQL spelling reads "None was needed (…)"; §3.1 gains the parenthesis. | contract | `NormalizedRecurrence`, `recurrenceSchema` and `carriesRepeatedKey` (read by `query.ts` and `cache-value-codecs.ts`); the factories' `<Source, Key, S, T>(relation, resolved, …)`; `git diff 076fad02b..HEAD -- src/adapters` is empty (round 1 changed comments only there). |
| F49 | documentation | The compatibility page did not note MySQL's recursion cap, nor `recurse` itself. | Two rows, each pointing at Recursive relations on `selecting`. | `docs/content/docs/client/compatibility.mdx` | `exceedsMySQLRecursionLimit` on the two 1,100-level spine cases; the verdict's native MySQL row. "Prisma has no equivalent" is the finding's; not re-checked against Prisma's documentation in this round. |
| F50 | documentation | The closure inventory still held L-2 as pending. | An addendum after the 2026-09-21 addendum; R-2 gets its dated answer (see **Round 2 deviations**). | `g4/release/closure/fc00/inventory.md`, `remaining-decisions.md` | `raptor3-local-release-finish.md` "Co-release update (2026-09-21)"; gate-3's census "internal (private fits) 0 / 0"; round 1's F28. |
| F51 | documentation | The guide's one-producer sentence omitted the nested guard and sat inside the decoder sentence. | Its own sentence, naming both guards and the schema-only mirror. | `src/query-engine/raptor3/AGENTS.md` | The two `prepareProjection` throws, `relationShape`, `result-shape.ts` `addSelectedRelations`; distance-key-collision 4/4. |
| F52 | documentation | The guide pointed only at the N4 census report. | "its N4 report …, which predates the recursive feature; the recursive-query gate's last run is `…/gate-3/census.log`" (see **Round 2 deviations**). | `src/query-engine/raptor3/AGENTS.md` | `n4/census.md` lists the 11 private-fit sentences; `gate-3/census.log` shows 0 / 0. |
| F53 | documentation | The status block kept "Updated 2026-09-21" and did not point at the verdict. | Replaced as requested, one phrase qualified (see **Round 2 deviations**). | contract | — |
| F54 | documentation | §5 still called its lanes a starting point. | Replaced, its last sentence qualified (see **Round 2 deviations**). | contract | `G4_NATIVE_PROVIDER_COUNTS` spreads `RQ01_NATIVE_COUNTS` and `RQ06_NATIVE_COUNTS` for both native modes; the fit modes run `prep/recursive-read-fit` (6) and `g4/read-recursive-fit` (3) through `findMany` with `recurse`; `RAPTOR3_FIXED_LOCAL_TESTS` spreads the six deterministic RQ groups; `RQ01_PGLITE_TESTS` is a `livePgliteProviderStage` (`raptor3-provider`). |
| F55 | documentation | (as above) | The client guide's bullet points at the function's JSDoc. | `src/client/AGENTS.md` | — |
| F56 | documentation | The contract cited two machine-local `/tmp` research files. | The finding's first option: the paragraph is deleted; the Sources list stays the owner. | contract | Both files exist only in this machine's `/tmp`, untracked; left untouched, not copied. |
| F57 | documentation | The adapter README showed only `cte.recursive`'s default spelling. | Both spellings. | `src/adapters/README.md` | The one caller passes `"distinct"`; the `"all"` default stays (labelled reserved by round 1's F26); `dialect-vocabulary.core.test.ts` covers both forms. |

### Round 2 deviations from the letter of a request

- **F43.** "Every unit was independently reviewed as a whole (Opus author,
  …) on the same uncommitted tree over `076fad02b`" is not true of RQ-01:
  its author is not recorded as Opus, and its whole-unit review ran on the
  tree over the amended commit `4ead1c591` (`rq07-final-review.md`, header).
  The paragraph therefore keeps "except RQ-01" for that clause and states
  RQ-01's review separately, with its tree, its reviewer and its repair round.
- **F45.** "because `recurse` already produces it at every level" became
  "because `recurse` already produces it": at a numeric cutoff the repeated
  key is absent.
- **F50.** "The census's private-fit bucket is empty" became "was empty at
  the final gate (`gate-3/census.log`); the pre-merge elegance pass then
  removed it from the census (F28)": round 1 deleted the bucket.
- **F52.** "the latest run is" became "the recursive-query gate's last run
  is": round 1's `census-final.md` and this round's census runs are later,
  as pass receipts on the uncommitted tree.
- **F53.** "the owner of every number" became "owns every executed and
  measured result": the contract owns its normative numbers (depth 100,
  1–1000), and F54 names the manifest as the owner of registered counts.
- **F54.** "The `RQ*_COUNTS` groups … own the cell counts" became
  "`scripts/raptor3-manifest.mjs` owns every registered cell count (the
  feature's suites in its `RQ*_COUNTS` groups)": the fit modes' counts are
  `G3P05_RECURSIVE_READ_FIT_COUNTS` and `G4_READ_RECURSIVE_FIT_COUNTS`, and
  `read-envelope-native`'s is in `G4_NATIVE_PROVIDER_COUNTS`.
- **F55.** The renderer's last sentence, "The text names no exported
  helper.", is kept: it lies outside the span the finding quotes and no other
  `src/` text states it. The guide's replacement line is wrapped to the
  file's width, same words.
- **F40.** Lines 58 and 65 carried round 1's F29 wording; F40's exact wording
  replaces it (it adds the pointer to the verdict).
- **R3.** With the first shape, a mismatching verdict no longer carries
  `occurrences`; no cell or script reads the field, the recorded receipts
  hold no mismatch, and the field's comment says so.
- **R5.** The formatter spells each of the 21 records one field per line, so
  R5 grows the fixture by 50 lines (R2 adds the other 2 of its +52): one row
  representation instead of three
  (tuples, `PROVIDER_INITIAL`, table rows), not a line saving. The file's
  other row tables keep their pre-existing one-record-per-line layout
  (not reformatted).
- **R4.** The report's prose is unchanged: its sentence "a named constant IS
  read at the throw site" is now true of an imported one as well.

### Runs (final bytes)

| run | files → cells | result | log |
| --- | --- | --- | --- |
| `raptor3` project | provider-sql-sqlite 15, composition 12, campaign-sqlite 7, distance-key-collision 4 | 38 / 38 | `31-` (first pass `10-`) |
| `run-credential-free-tests --only provider-sql-pglite` | provider-sql-pglite 14 | 14 / 14 | `32-` (first pass `11-`) |
| scratch witnesses (outside the repository) | lateral-shape 1, fixture-r2-r5 4, judge-total 4 | 9 / 9; SQL byte-identical to the pre-F38 baseline | `30-` |
| `run-node-safe` census | the report | 36 candidate / 75 inherited / 22 invariant sentences, 203 sites | `20-`, `census-final.md` |
| `run-node-safe` census self-test | 7 | 7 / 7 | `21-` |
| `run-typecheck.mjs` | whole estate | exit 0 (6.94 s, 5,444.2 MiB) | `40-` |
| `pnpm dlx ultracite check`, with the project's Biome 2.3.11 first on `PATH` (the dlx cache holds none of its own) | the six touched code files, pre-round bytes (a mirror tree) vs final | 27 errors, 1 info on both; no rule count differs | `13-`, `13a-`, `13b-` |

**Red-before witnesses:** R3 (`08-`, three cells failing), R4
(`census-before.md`), R2 (round 1's rule passing both regressions, inside
`07-`), and F38's falsification (`06-`).

**Biome.** This round's lines are formatter- and lint-clean except the four
trailing commas in F38's hunk, which match `query.ts`'s prevailing style (the
file-level format finding predates this round; `14-`). Two diagnostics this
round first introduced in the census (`noBitwiseOperators` and format, `12-`)
are fixed: the `const` test reads the declaration list's first token, and
Biome formatted those lines only.

### Registrations

No count moved: RQ07_FOLLOWUP 4, RQ01_SQLITE 15, RQ01_PGLITE 14,
RQ06_COMPOSITION 12 + 7, RQ01_NATIVE 3, RQ06_NATIVE 4. No test file was
added to the repository; the scratch witnesses stay outside it (copied as
`.txt` receipts). No manifest was edited.

### Not re-run, unverified

- Native PostgreSQL / MySQL (integrator-owned): `provider-sql-native` (3),
  `campaign-native` (4), `read-envelope-native` (5). F38 changed how their
  statement is assembled, not its text (proven byte-identical on the
  PostgreSQL and MySQL adapters); R2 and R5 changed their fixture, R3 their
  harness. All typechecked, none executed.
- The docs site (`selecting.mdx`, `errors.mdx`, `compatibility.mdx` edited
  in the page's existing table and link forms), the package build, the full
  local gate, coverage.
- "Prisma has no equivalent" (F49's row), as noted above.

### Documentation checked (round 2)

`CHANGELOG.md` restates the MySQL limit in substance ("surfaces as the
provider's error (errno 3636), never as a truncated result"), consistent
with the page's new wording; no finding covers it, so it is not edited.
`rq01-sql-placement.md`'s status line (the whole-unit review "still owed")
is left as dated history: the verdict and the central plan now record the
acceptance. Round 1's **Refusal census** figures describe round 1's tree; R4
restores the inherited figures above.

### F37 — applied (Option B, Arnaud's decision)

**Decision and scope.** Arnaud chose Option B of the pending section above
(2026-09-23). It landed as one change on the tree as it stood — HEAD
`bcb364491` plus rounds 1 and 2, uncommitted — by one author; nothing was
committed, staged or pushed. Runner: Node 24.21.0 (pinned),
`TMPDIR=/private/tmp/viborm-rq-option-b`, one vitest at a time through
`scripts/run-vitest-safe.mjs` (heap 768 MiB, RSS 1,536 MiB) or the
credential-free runner, no wide run, no native lane. Receipts, logs and the
rewrite script are under `elegance-pass/f37-option-b/`.

**The fact and its owner.** A malformed recursive carrier's public identity
now has the owner a malformed ordinary scalar, row or collection has:
`OperationContext.failure`, the operation's one result-failure translation.
`decodeRecursiveCarrier` only names the failed check, as
`InvalidScalarResult(phrase, reason)`; `failure()` publishes
`QueryEngineError` (V9001)
`Driver "<driver>" returned a malformed <phrase> scalar for operation "<operation>": <reason>.`
with `meta` `{ driver, operation, scalarType }`, result-phase attribution and,
in a record series, its progress. No code is deleted. What disappears is the
carrier's second public identity: a raw `TypeError` for a read or inside the
operation's own region, and, after a committed batch segment, the generic
`Record-series execution failed at a committed-segment boundary.` wrapped
around it (the read's and the batch's are observed red below). Unchanged:
every decoder-level message (`InvalidScalarResult`'s constructor spells
`Invalid provider <phrase>`, the same twelve messages), the FK-cycle
`QueryEngineError`, the CM002 `assertInvariant`, the identity scalars' own
`decodeScalar` failures and the `jsonValue` container refusal.

**Sites → phrases → reasons.** `src/query-engine/raptor3/shared/query.ts`,
`decodeRecursiveCarrier`, lines of the final tree. The rewrite
(`apply-option-b.py.txt`) found each site by its line and its exact old text,
and took the phrase from the old message's tail after `Invalid provider `.

| line | what that guard alone catches | phrase (`meta.scalarType`) | reason |
| ---: | --- | --- | --- |
| 4570 | a carrier that is null, a primitive or an array | `recursive carrier` | the carrier is not an object |
| 4579 | `__rq_root`, `__rq_nodes` or `__rq_edges` missing or not an array | `recursive carrier` | the carrier's root, nodes or edges member is not an array |
| 4586 | an identity (root, node key, edge endpoint) that is not an array of the key's width | `recursive identity` | an identity is not a tuple of the key's width |
| 4598 | a node entry that is not an object (a sparse hole included) | `recursive node` | a node entry is not an object |
| 4605 | two node entries with one identity | `duplicate recursive node` | two nodes carry the same identity |
| 4617 | an edge entry that is not an object (a sparse hole included) | `recursive edge` | an edge entry is not an object |
| 4625 | an edge whose child is not a transported node | `recursive edge endpoint` | an edge's child is not a carried node |
| 4633 | a depth on an exhaustive carrier's edge | `exhaustive recursive depth` | an exhaustive carrier states an edge depth |
| 4644 | a bounded edge depth that is missing, not a safe integer, below 1 or above the cutoff | `recursive depth` | an edge depth is not an integer from 1 to the cutoff |
| 4652 | one (parent, child, depth) fact transported twice | `duplicate recursive edge` | an edge fact is carried twice |
| 4674 | an edge parent that is neither the root nor a transported node | `recursive edge endpoint` | an edge's parent is neither the root nor a carried node |
| 4680 | several successors for a singular parent | `recursive singular relation` | a singular parent has several successors |
| 4735 | the per-level hop check (the P2 carrier): a hop below the cutoff whose next-level children are not the parent's one answer | `recursive depth` | a hop below the cutoff omits some of its parent's children |
| 4741 | a bounded fact that no level of the walk consumes | `recursive depth` | an edge is not reachable at its recorded depth |
| 4746 | a node that no consumed edge reaches | `unreachable recursive node` | a carried node is not reachable from the root |
| 4802 | a node row that decodes to null | `recursive row` | a node's row is null |

**The contract, docs and guide.**

- `features-docs/recursive-query.md` §2.3, the volatile-filter limit: where
  PostgreSQL's per-level hop check refuses the carrier, "the caller receives
  the `QueryEngineError` V9001
  `Driver "…" returned a malformed recursive depth scalar for operation "…": ….`,
  whose `meta.scalarType` (`recursive depth`) names the check"; SQLite
  "typically refuses it at the `recursive edge endpoint` or
  `unreachable recursive node` check"; and, once: "Every carrier refused as
  an invalid provider result reaches the caller through the operation's one
  result-failure translation (`OperationContext.failure`), the same as a
  malformed ordinary row or collection (§3.3)." §3.3 is pointed to, not
  restated. ("Refused as an invalid provider result" is the paragraph's own
  term: the FK-cycle refusal, §2.4, stays its own `QueryEngineError`.)
- `docs/content/docs/client/selecting.mdx`, the volatile-filter sentence: "The
  operation then rejects with the `QueryEngineError` (`V9001`) of a malformed
  driver answer, such as `Driver "…" returned a malformed recursive depth
  scalar for operation "…": ….`, and its `meta.scalarType` names the check
  that refused the answer."
- `docs/content/docs/client/errors.mdx`, the V9001 bullet: "The same code
  reports a driver answer the engine refused to decode, `Driver "…" returned a
  malformed … scalar for operation "…": ….`, with `meta.scalarType` naming
  what was malformed: a value, a row, a relation, or one check of a recursive
  projection's answer such as `recursive depth`", linking Recursive relations.
- `src/query-engine/raptor3/AGENTS.md`, the decoder paragraph, names the
  identity once: "Its carrier checks refuse through `InvalidScalarResult`, the
  `scalarType` naming the failed check (…), so a carrier refused there
  reaches the caller as the operation's one malformed-result
  `QueryEngineError`, as a malformed ordinary row does; the FK-cycle refusal,
  a property of the data, is its own `QueryEngineError`."
- `g4/release/plan/refusals-map.md`: the RQ-3 row (the census's twelve
  phrases at sixteen sites, the decoder message, the caller's V9001 and the
  public witness) and a "Respelled by F37" paragraph with the totals.
  `rq07-release-verdict.md`: the census row. Its Risk 3 is unchanged: the
  recursive decoder's sentence it contrasts with a malformed ordinary column
  is the FK-cycle refusal of composition cell 12 (`rq6.md`, observation 2),
  which F37 leaves as it was.

**The witness and its registration.**
`tests/raptor3/recursive-query/composition.test.ts`, where cell 11 pins the
ordinary projection's failure identity, through the shipped client
(`createClient`) on in-memory SQLite:

- **Cell 13 (new).** The `CompositionDriver`'s `corrupt` hook rewrites the
  carrier the provider answered to `findUnique` of `r`'s junction graph
  (`links`, `recurse: { depth: 3 }`, `orderBy: { id: "asc" }`). The
  provider's own answer, through the same parse and re-stringify, decodes to
  the hand-written value. Four malformed answers — a non-object carrier (`[]`),
  a carrier without `__rq_edges`, the P2 carrier (the provider's answer minus
  its one fact `b → r` at level 3, so the hop from `b` at level 2 omits its
  child) and the provider's answer minus node `b` — each reject with a
  `QueryEngineError` whose name, code (V9001), message (driver `sqlite3`,
  operation `findUnique`, the site's reason) and `meta` (exactly `driver`,
  `operation`, `scalarType`, once the helper drops `correlationId`) are
  asserted, after one statement and with no value. Three phrases, four sites:
  `recursive carrier` (two reasons), `recursive depth` (the hop check),
  `recursive edge endpoint` (the child check). Control: the ordinary `links`
  projection answered `{}` rejects through the same translation
  (`collection`, `a requested relation is not a provider array`).
- **Cell 12 (extended).** A third readback, `malformed`: the cycle-closing
  update's recursive readback, its carrier answered `[]`. On the batch-only
  transport — the write acknowledged, then the result-phase refusal — its
  failure is the `QueryEngineError`
  `Driver "sqlite3" returned a malformed recursive carrier scalar for operation "update": the carrier is not an object.`
  with `meta.scalarType` `recursive carrier`, and it satisfies the cell's
  existing progress, storage, invalidation, completion and admission
  assertions unchanged (`phase: "result"`, one committed segment, certainty
  `committed`). In the operation's own region the same readback rejects with
  the same message and rolls back, claiming nothing. The single-operation
  batch placement is therefore covered.
- **Registration.** `RQ06_COMPOSITION_COUNTS`, `composition.test.ts` 12 → 13
  (`scripts/raptor3-manifest.mjs`), the only manifest edit. A stage that lists
  this file (the fixed lane among them) will count one more cell; none was run
  here.

**Red before, green after, falsified.**

- Red (`02-`): the witness on the pre-change `query.ts`, 11 / 13. Cell 12's
  batch arm published `Record-series execution failed at a committed-segment
  boundary.`; cell 13's first malformed answer reached the caller as the raw
  `TypeError: Invalid provider recursive carrier`. Cell 13's well-formed
  decode, which precedes it, passed.
- Green (`03-`, `04-`): composition 13 / 13, carrier-boundary 13 / 13 with no
  assertion edited (`InvalidScalarResult` extends `TypeError`, and the 13
  cells match messages).
- Falsified (`05-`, `05-falsify-hop-site.diff`): the hop-check site alone
  restored to `throw new TypeError("Invalid provider recursive depth")` in the
  working copy (backed up with `cp`, restored with `cp`, `cmp` identical):
  carrier-boundary stays 13 / 13 — the decoder-level cells cannot see the
  public identity — and composition cell 13 fails at the P2 answer with
  `TypeError: Invalid provider recursive depth`, after the two
  `recursive carrier` answers passed.

**Census.** The census takes as a construction's sentence its first argument
whose rendering contains a space, so it now records each site's phrase.
Pre-change tree (`00-`, `census-before.md`) and final tree (`06-`,
`census-after.md`): identical counts, candidates 36 distinct at 46 sites,
inherited 75 at 76, invariants 22 at 23, no sentence 58, 203 sites. The twelve
`TypeError` rows `Invalid provider …` became twelve `InvalidScalarResult` rows
(`recursive carrier`, …) at the same sixteen sites; no phrase occurs in the
old-engine corpus at `0cc61e61f` (checked with `git grep` before the change),
so all twelve stay candidates; every other row is unchanged but for the line
numbers after the first rewritten site, which moved by 45. `--at HEAD` (`01-`,
`census-at-head.md`): candidates 36 at 47, invariants 23 at 24, 205 sites —
the two sites fewer are round 1's F21 and F24, not F37. Self-test 7 / 7
(`07-`); it pins fixture trees, not engine counts, so nothing was re-frozen.
Re-recorded in the refusal map (RQ-3 row, "Respelled by F37" paragraph) and
the verdict's census row.

**Runs.**

| run | files → cells | result | log |
| --- | --- | --- | --- |
| witness on the pre-change `query.ts` | composition 13 | 11 / 13 (cells 12 and 13 red) | `02-` |
| after | composition 13 | 13 / 13 | `03-` |
| after | carrier-boundary 13 | 13 / 13 | `04-` |
| hop-check site falsified | carrier-boundary 13, composition 13 | 25 / 26 (cell 13 red at P2) | `05-` |
| census: pre-change, final, `--at HEAD` | the report | exit 0 each | `00-`, `06-`, `01-` |
| census self-test | 7 | 7 / 7 | `07-` |
| `raptor3` project | distance-key-collision 4, campaign-sqlite 7 | 11 / 11 | `08-` |
| `run-credential-free-tests --only provider-sql-pglite` | provider-sql-pglite 14 | 14 / 14 | `09-` |
| `raptor3` project, final bytes | carrier-boundary 13, composition 13, distance-key-collision 4, campaign-sqlite 7 | 37 / 37 | `13-` |
| `run-typecheck.mjs`, once | whole estate | exit 0 (7.64 s, 5,394.8 MiB) | `14-` |
| `pnpm dlx ultracite check` | the three touched code files; the seven touched docs | see **Biome** | `10-`, `11-`, `12-`; `15-` |

After `03-`, `composition.test.ts` changed only by the formatter's layout of
two statements and two comment rewordings; `13-` ran on the final bytes.
`query.ts` is byte-identical to the bytes `03-`, `04-` and `06-`–`09-` ran on
(`05-` ran on the falsified copy).

**Biome.** `pnpm dlx ultracite check`, with the project's Biome 2.3.11 first
on `PATH` (as in round 2), on the three touched code files, pre-change mirror
against final (`11-`, script `ultracite-compare.sh.txt`): 91 errors and 1 info
on both, no rule count differs. The first check (`10-`) found one format
finding, two long statements in cell 13, fixed with the formatter's own
layout; `composition.test.ts` has no diagnostic before or after. In
`query.ts` the formatter's only disagreement with this change's 61 lines is
the trailing comma of the 15 multi-line argument lists (`12-`), the file's
prevailing style, kept as rounds 1 and 2 kept it; the file-level format
finding predates this change. The seven touched Markdown and MDX files are
outside Biome's languages: the same command checks none of them (`15-`,
"Checked 0 files").

**Measured.** `git diff --no-index --numstat` against the pre-change backups:
`query.ts` +61 / −16 — sixteen one-line throws became fifteen four-line
constructions and one one-line construction; the growth is the sixteen
reasons, which the public sentence now ends with, each construction spelling
its phrase and reason on lines of their own (no deletion);
`composition.test.ts` +177 / −11; manifest +1 / −1; contract +9 / −5,
`selecting.mdx` +4 / −1, `errors.mdx` +6 / −1, layer guide +7 / −1, refusal
map +3 / −1, verdict +1 / −1; the census and its self-test unchanged. Not
measured: bundle size and CPU (the constructions run only on a refusal).

**Beyond the letter of the brief.**

- Cell 12 also carries the owned-region arm, not only the batch-mode
  placement, so its header sentence stays true of both regions.
- Cell 13 adds the ordinary control, which witnesses §2.3's new "the same as
  a malformed ordinary row or collection".
- The pending section keeps its round-2 heading as the record of that round;
  its last paragraph now says B was landed.

**Not run, unverified.**

- Native PostgreSQL / MySQL (integrator-owned). The carrier failures are
  provider-independent, and no native test pins a carrier message: only
  `carrier-boundary.test.ts` and `composition.test.ts` name one.
- The fixed lane, parity, conformance and the rest of the frozen gate; the
  docs-site validate (`selecting.mdx` and `errors.mdx` were edited in their
  existing prose and link forms).
- The owned-region `malformed` arm's pre-change failure: the red run stopped
  at the batch arm, so its raw `TypeError` (by reading: `run`'s catch rethrows
  anything that is not an `InvalidScalarResult` outside a committed batch
  segment) was not executed red.
- The batch-array placement: a member of a `$transaction([...])` array on a
  batch-only transport (`supportsTransactions` false, `supportsBatch` true, as
  the `d1` and `neon-http` drivers declare). No cell runs it. The F37
  re-check observed it with a scratch probe (receipts
  `recheck-own-carrier.scratch.test.ts.txt`,
  `recheck-r19-own-carrier-final.log`): the decoder throws
  `InvalidScalarResult("duplicate recursive node", "two nodes carry the same identity")`,
  and the caller receives `QueryError` V2001 `Query execution failed`, `meta`
  `{ driver, model, operation }`, no `scalarType`. The array owner
  (`array-transaction-legacy.ts`, or `array-transaction-native.ts` when an installed request, query or cache handler makes some member
  require interception (`requiresInterceptedArray`)) parses the member's result
  through the operation owner's `parseResult` — the parser
  `OperationContext.publishPrepared` installs — inside
  `observeTransactionBatchPhase`, whose `normalizeDriverError` hands the
  non-VibORM error to `mapProviderError`; `failure()` is never reached. A
  malformed ordinary collection (`{}`) and a malformed ordinary scalar
  (`label` 42), each as the one member of its own array on the same transport, give the same V2001: parity with ordinary
  rows holds, the V9001 identity does not. The same read as a single
  operation on that transport, and every transactional placement (single,
  array, callback), give V9001 with `scalarType`. The array owner is not
  changed here: the behaviour is shared with ordinary rows (**F37 re-check**,
  below).

#### F37 re-check — three findings applied

**Scope.** The independent re-check of this section returned three findings,
one major and two minor, all on documentation. This round applies them on the
same tree (HEAD `bcb364491` plus the uncommitted rounds, F37 included), by
one author. Nothing was committed, staged or pushed, and no `.ts`, `.mjs` or
test file changed. Runner: Node 24.21.0 (pinned),
`TMPDIR=/private/tmp/viborm-rq-option-b`, one vitest at a time through
`scripts/run-vitest-safe.mjs` (heap 768 MiB, RSS 1,536 MiB), no wide run, no
native lane. Receipts `16-` to `20-`, and the re-check's own probe and log
(`recheck-…`), are under `elegance-pass/f37-option-b/`;
`20-recheck-docs.diff` is this round's diff of the five documents against
their pre-round bytes. The sentences this section quotes above (**The
contract, docs and guide**, **Beyond the letter of the brief**) are F37's as
first landed: where this round rewrote them, the table below supersedes
them, and the batch-array exception qualifies **The fact and its owner** for
that one placement.

| # | severity | claim | change | files | checked against |
| --- | --- | --- | --- | --- | --- |
| 1 | major | §2.3's "Every carrier refused as an invalid provider result reaches the caller through … (`OperationContext.failure`)" is false for a member of a `$transaction([...])` array on a batch-only transport (D1, neon-http), where the caller receives `QueryError` V2001 `Query execution failed` without `scalarType`; `selecting.mdx`, the layer guide, the RQ-3 row and this section repeat it. Parity with ordinary rows holds. | §2.3's sentence is replaced by the finding's text: "A carrier refused as an invalid provider result reaches the caller exactly as a malformed ordinary row or collection does (§3.3): as that V9001 `QueryEngineError` through `OperationContext.failure`, except for a member of a `$transaction([...])` array on a batch-only transport (D1, neon-http). The array owner parses that member's result, and like an ordinary malformed member it surfaces as `QueryError` V2001." One clause each in `selecting.mdx` ("inside a `$transaction([...])` array on a batch-only driver (D1, neon-http) the failure surfaces instead as `QueryError` (`V2001`), as it does for an ordinary malformed member"), in the layer guide's decoder sentence ("except as a member of a `$transaction([...])` array on a batch-only transport: the array owner parses that member's result and, like an ordinary malformed member, it surfaces as `QueryError` V2001") and in the RQ-3 row (the same exception after "(F37, Option B)"). This section: "The single-operation batch placement is therefore covered", and the batch-array placement is listed under **Not run, unverified** with the observation. | contract; `docs/content/docs/client/selecting.mdx`; `src/query-engine/raptor3/AGENTS.md`; `g4/release/plan/refusals-map.md`; this ledger | By reading: `array-transaction.ts` sends a batch-only transport's array to its native-batch arm (`executeInterceptedNativeArray` when an installed request, query or cache handler makes some member require interception (`requiresInterceptedArray`), else the loop in `array-transaction-legacy.ts`); both parse each member through the operation owner's `parseResult` inside its `observeBatchPhase`. `pending-operation.ts` runs the parser `OperationContext.publishPrepared` installed, inside `observeTransactionBatchPhase`, whose `normalizeDriverError` maps a non-VibORM error with `mapProviderError`. `d1` and `neon-http` are the only shipped drivers declaring `supportsTransactions = false`. The re-check's probe (`recheck-r19-own-carrier-final.log`, 18:04) ran on these bytes: none of those files differs from HEAD, and `query.ts` last changed at 17:24. |
| 2 | minor | The V9001 bullet still called every V9001 an engine bug with "one exception", and the code table "a bug", while the added sentence makes V9001 also report a malformed driver answer — for a recursive projection, usually the caller's own volatile filter. | The added sentence ends "That report is not a broken engine invariant: the driver's answer was malformed, and for a recursive projection the usual cause is a volatile node filter (see [Recursive relations](/docs/client/selecting#recursive-relations))"; "one exception" becomes "two exceptions: … refuses cyclic data, and the malformed driver answer below"; the table row reads "An engine invariant broke, or the schema is not coherent — a bug; or a driver answer could not be decoded". | `docs/content/docs/client/errors.mdx` | `selecting.mdx`'s volatile-filter sentence; the RQ-3 row's "reachable" column (no conforming provider reaches the carrier boundary). The page's two readers are green (`16-`, `17-`). |
| 3 | minor | "`meta.scalarType` names the check" overstates it: `recursive depth` covers three checks, `recursive carrier` and `recursive edge endpoint` two each, and there is no `meta.reason`; only the message's closing reason tells them apart. | §2.3: "whose `meta.scalarType` (`recursive depth`) names the kind of check, and whose message ends with the reason of the check that failed"; "names the kind of check" in `selecting.mdx` ("names the kind of check that refused the answer") and in the layer guide ("whose `scalarType` names the kind of check"). | contract; `selecting.mdx`; layer guide | The sites table above, still exact (`recursive depth` at 4644, 4735, 4741; `recursive carrier` at 4570, 4579; `recursive edge endpoint` at 4625, 4674); `OperationContext.failure` publishes `meta` `{ driver, operation, scalarType }` and puts `reason` only at the end of the message. |

**Deviations from the letter.**

- Finding 1: the finding's text is used word for word, its identifiers as
  code spans, as the paragraph spells identifiers. The public page says
  "driver" where the contract says "transport", the page's word
  (`docs/content/docs/drivers/index.mdx`).
- Finding 1's evidence names `array-transaction-native.ts`; the probe's
  client installs no extension (its engine's chain is `undefined`), so by
  reading its array took the loop in `array-transaction-legacy.ts`. Both arms
  parse a member the same way: the documents say "the array owner", and this
  ledger names both.
- Finding 3: in the layer guide, the participle "the `scalarType` naming the
  failed check" becomes "whose `scalarType` names the kind of check", to use
  the finding's phrase.
- Finding 3, one step beyond its list: finding 2's bullet in `errors.mdx`
  said `meta.scalarType` names "one check of a recursive projection's answer
  such as `recursive depth`"; it now says "the kind of check a recursive
  projection's answer failed, such as `recursive depth`", so the four texts
  agree.

**Out of scope, recorded (finding 1, point 4).** The array owner is not
changed. On a batch-only transport it parses every member of a
`$transaction([...])` array outside the member operation's region, so any
malformed answer there — an ordinary scalar, an ordinary collection or a
recursive carrier — reaches the caller as `QueryError` V2001 `Query execution
failed`, its cause redacted, without `scalarType`. Giving that placement the
V9001 identity would change ordinary rows' public failure too: a decision for
the array owner, not for F37.

**Left as written.** `errors.mdx`'s "The same code reports a driver answer
the engine refused to decode" says what V9001 reports, not that every
malformed answer is V9001, and finding 1 does not list the page: no exception
clause there. The census reads only `src/**/*.ts` and this round changed none,
so it was not re-run and the refusal map's counts stand; the RQ-3 row gained
one clause. The pending section's last paragraph still points here.

**Runs.**

| run | files → cells | result | log |
| --- | --- | --- | --- |
| `coverage-errors` project | `docs-errors-examples.test.ts` (8 cells read `errors.mdx`, 5 run its examples) | 13 / 13 | `16-` |
| `coverage-errors` project, `-t "surface 4"` | `error-registry-gate.test.ts`, the 4 cells that read `errors.mdx` (15 deselected by the filter) | 4 / 4 | `17-` |
| `run-typecheck.mjs`, once | whole estate | exit 0 (38.59 s, 5,185.3 MiB) | `18-` |
| `pnpm dlx ultracite check`, project Biome first on `PATH` | the six touched documents | "Checked 0 files" (Markdown and MDX are outside Biome's languages) | `19-` |

No other test or script reads the five documents: `grep` over `tests/` and
`scripts/` finds only these two files reading `errors.mdx`, and the census
names the refusal map only in its report text.

**Measured.** Against the pre-round backups (`git diff --no-index
--numstat`): contract +9 / −6, `selecting.mdx` +4 / −1, `errors.mdx` +8 / −6,
layer guide +6 / −3, refusal map +1 / −1 (one table row), this ledger's two
in-place edits +24 / −2, then this subsection. Documentation only; nothing
deleted.

**Registrations.** None moved; no manifest edited. The re-check's probe stays
outside the test tree, copied as a `.txt` receipt.

**Not run, unverified.**

- The batch-array observation (above) was read, traced in the code and
  recorded from the re-check's probe, not re-executed here; no cell pins it.
- The docs-site build and validate; the native PostgreSQL / MySQL lanes
  (integrator-owned); the rest of the frozen gate.
