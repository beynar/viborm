# A blind first-principles derivation of the ORM, then a comparison with the repo

Parts 1 and 2 were written without reading any file under the repository. Part 3 was written after.

## Part 1 — Bricks

The feature list is large but its generating set is small. Everything below reduces to nine runtime primitives plus a type-level mirror.

| # | Brick | Inputs | Distinct implementations | Why it is irreducible |
|---|---|---|---|---|
| B1 | **Schema descriptor** | user declaration | 1 (runtime object) + 1 type-level mirror | Every other brick is parametrised by it. Polymorphism, compound keys, FK-to-non-PK-unique all live here as data, not as code paths. |
| B2 | **Scalar codec** | (column type, dialect) | one table cell per (type × dialect): encode → bind param, decode ← provider cell, DDL type name, and the validator | 15 types × 3 dialects is a table, not 45 modules. Vector/geo/json are cells with a non-trivial encode expression (`ST_MakePoint`, `::vector`) — still cells. |
| B3 | **SQL fragment** | text pieces + ordered params | 1 composable AST; 1 renderer with a **dialect divergence table** (~15 entries: placeholder style, quoting, RETURNING, upsert clause, JSON path op, geo fn, LIMIT/OFFSET, `INSERT IGNORE`/`ON CONFLICT DO NOTHING`, row-value comparison, bool literal, namespace prefix, last-insert fn, JSON aggregation fn) | "Exact SQL and parameter order are part of the contract" forces an explicit AST; text concatenation cannot guarantee order under composition. |
| B4 | **Edge (membership predicate)** | relation r, anchor side | **2 shapes × optional discriminator**: (a) *direct* — tuple equality `(holder.cols) = (referent.key)`, roles fixed by which side holds the FK; (b) *carried* — equality through a junction row `J.a = A.key AND J.b = B.key`. Polymorphic row-held = (a) + constant conjunct `holder.type = 'V'`; polymorphic collection = (b) with a per-variant junction. | Every relation feature — filters, include, connect, disconnect, set, delete ordering, `_count`, relation orderBy — is "rows related to anchor", i.e. this predicate. Polymorphism is **not** a third shape; it is a *family* of edges indexed by variant plus one extra literal column write. Slot uniqueness is a unique constraint on the holder pair / junction, not a predicate kind. |
| B5 | **Predicate tree** | where args | 3 node kinds: scalar-op leaf (from B2's op table), boolean combinator, **quantified edge** (`some/is` = `EXISTS(target WHERE edge AND P)`, `none/isNot` = `NOT EXISTS(...)`, `every` = `NOT EXISTS(target WHERE edge AND NOT P)`) | Recursion in relation filters is the quantified-edge node calling B5 on the target model. JSON path / geo distance are scalar-op leaves whose rendering is a B3 dialect cell. |
| B6 | **Row-set expression** (query IR) | model, B5, projection tree, order keys, window, group/having | 1 relational form: SELECT with correlated subqueries. Nested include = correlated JSON-aggregating subquery (all three dialects have one) with a windowed inner select for per-relation take/skip/cursor/distinct; relation `_count` and relation-aggregate orderBy = correlated scalar subqueries. | Needed as a *value* because reads appear inside writes (decision reads, premises, in-DB key references), so a read must be representable without executing it. |
| B7 | **Statement** | kind ∈ {INSERT, UPDATE, DELETE, SELECT}, target, column ← value, where: B5, returning | 4 kinds; a value is a **literal, a slot reference, or a SQL expression** (B6 scalar subquery, `currval`, `last_insert_rowid()`). Bulk = the same kind with many rows, chunked by the dialect's bind limit. | This is the only thing a database executes. Every nested-write verb must die into these four before rendering. |
| B8 | **Slot** (deferred key value) | (table, unique selector) or "key of statement S" | 4 resolvers: literal (given), client-generated (cuid/uuid default), **in-DB expression** (`(SELECT key FROM t WHERE sel)`, `currval(seq)`), fetched-from-prior-result (RETURNING / last-insert + reselect). Memoised per program by (table, selector). | Turns a tree of nested args into a DAG of statements. Memoisation is exactly the "duplicate connectOrCreate converges, first-create-wins" semantic: the second occurrence gets the first's slot, not a second read. |
| B9 | **Decide** | a B6 read, a continuation `result → program` | 1 form: lazy thunk. Two arms, only the chosen one is ever expanded (so it is neither validated nor executed — inertness falls out for free). | Branching on a read is the one thing a straight statement DAG cannot express. Its interaction with the substrates is hard problem #2. |
| B10 | **Execution unit** | ordered statements, premises, expected row counts | 3 schedulers over the *same* program: interactive (statement-at-a-time with feedback, savepoints), atomic batch (no feedback: reads hoisted, writes guarded), committed segments (a loop of atomic batches with slot refill and progress) | The substrate is a property of the driver, not of the verb. |

Migrations add three more, all data-shaped: **Snapshot** (tables/columns/indexes/FKs/uniques as a normalised set; produced either from B1 or from introspection), **Diff** (set difference → operation list: add/drop/alter column, table, index, FK), and **Ledger** (a control table with name, checksum, evidence hash, applied_at). DDL rendering is B3 with a DDL divergence table; SQLite table recreation is a *rewrite pass* over the op list (any unsupported ALTER on table T → `CREATE new, INSERT…SELECT, DROP, RENAME`), and MySQL's non-transactional DDL is a scheduler property (record ledger progress per statement, not per migration) — B10 again.

### Composition of the nested-write verbs

Notation: `E` is the edge for the relation (B4), `s` the slot of the anchor row, `R(t,sel)` = Resolve slot of target by unique selector, `∃` = existence read.

| Verb | Direct edge, FK on this row | Direct edge, FK on the other row | Carried (junction) | Polymorphic delta |
|---|---|---|---|---|
| create | INSERT target → slot t; then this row's FK column ← t (target ordered *before* this row) | INSERT this → s; INSERT target with FK ← s | INSERT this; INSERT target → t; INSERT J(s,t) | add `type ← 'V'` literal to the holder's column list / junction row |
| connect | FK ← R(target,sel); R must resolve (else typed not-found) | UPDATE target SET fk=s WHERE sel; expect 1 row | INSERT J(s, R(target,sel)) | same |
| connectOrCreate | Decide(∃ target sel) → connect \| create+connect; memoised R | same | same | same |
| disconnect | FK ← NULL (validation refuses if not nullable) | UPDATE target SET fk=NULL WHERE E(s) [AND sel] | DELETE J WHERE E(s) [AND sel] | same |
| set | disconnect-all then connect each | UPDATE target SET fk=NULL WHERE E(s); then connects | DELETE J WHERE E(s); INSERTs | same |
| update | UPDATE target SET … WHERE E(s) [AND sel]; target's key becomes a slot for its own nested args | same | same | same |
| upsert | Decide(∃ target WHERE E(s) AND sel) → update-arm \| create-arm | same | same | same |
| delete | dependents first (recursively, by required-FK rule), then DELETE target WHERE E(s) [AND sel] | same | DELETE J row, then DELETE target | same |
| updateMany / deleteMany | one UPDATE/DELETE WHERE E(s) AND where; no nesting; count only | same | same | OR over variant edges |
| createMany | INSERT many with FK ← s, chunked; skipDuplicates → dialect cell | same | INSERT many targets + INSERT many J | same |

Every top-level verb is the nested verb with no incoming edge: `create` = create with no parent; `update` = `R(root, where)` then update; `upsert` = Decide; `delete` = delete; `createMany` without relation args = one chunked INSERT, with relation args = N sequential single-row programs; `updateMany/deleteMany(+AndReturn)` = one statement with RETURNING, or (non-RETURNING providers) key-preselect → write → reselect by keys.

### Composition of reads

`findMany` = B6. `findFirst` = take 1. `findUnique` = B5 with the unique selector. `OrThrow` = post-check. `count/aggregate` = projection of aggregate expressions over B6. `groupBy` = group keys + aggregates + `having` as a B5 over aggregate leaves. `exist` = `SELECT EXISTS(B6)`. Cursor = row-value comparison `(orderCols) > (cursor row's cols)`, expanded into a disjunction when directions are mixed (a B3 cell). Result decoding = walk the projection tree with B2 decoders; shape validation = the same walk asserting presence and provider type.

### Composition of migration commands

| Command | Composition |
|---|---|
| snapshot | B1 → Snapshot |
| diff | Diff(Snapshot(prev), Snapshot(schema)) → ops |
| generate/apply | ops → SQLite-recreation rewrite → DDL render → B10 (tx per migration; MySQL: per statement) + Ledger insert with evidence hash |
| down | Diff reversed (inverse ops are a table) → same pipeline |
| reset | drop-all ops + apply all |
| resolve | Ledger write without execution |
| status | Ledger ∩ migration files (three sets: applied, pending, unknown) |
| verify | evidence hash of Snapshot(introspect(db)) vs ledger |
| push | Diff(Snapshot(introspect(db)), Snapshot(schema)) → apply without ledger |
| introspect | provider catalog → Snapshot (the inverse of B1 → Snapshot; one reader per dialect) |

### The two genuinely hard problems

**H1 — Referential dependency ordering with deferred keys.** A nested-write tree yields statements whose *order* is not the tree order: a `create` with a to-one whose FK sits on *this* row needs the target inserted first; the same `create` with the FK on the *other* row needs this row first; a `delete` needs dependents removed first; a singular polymorphic slot needs the old member unlinked before the new is linked. The smallest structure that solves all of it is a **statement DAG with slots (B8) and exactly one relation-derived edge rule**: *a holder row is written after the row it references exists, and is unlinked before that row is removed*. Value dependencies (a statement consumes a slot) and constraint dependencies (that rule) both become DAG edges; a stable topological sort gives the order, and "exact SQL order is contractual" is satisfied because the sort is deterministic in tree order. Primary-key updates fall out only if the *new* key is a slot value the dependents' updates consume; with immediate FK checking on MySQL/SQLite this is only executable if the migrations engine emits `ON UPDATE CASCADE` (or PG deferrable constraints), so the runtime's job is just to substitute the new key in the program — I am flagging this as an assumption to check in Part 3.

**H2 — Branching on a read across two atomicity substrates, with inert untaken arms.** `upsert`, `connectOrCreate`, `set`, and required-relation deletes all *decide* on a read. Interactively this is trivial. On an atomic native batch there is no feedback between statements, so every decision read must run *before* the batch, which opens a window for a concurrent change. The smallest structure: **Decide as a lazy thunk (B9) + hoisted read + premise**. The read runs pre-batch, the thunk chooses the arm, and the chosen arm's statements carry the premise (`EXISTS`/`NOT EXISTS` of the same selector) as a WHERE conjunct; every write in the batch is guarded by the conjunction of all premises, so under the batch's single snapshot either all writes apply or all are no-ops, and a post-batch affected-count check turns "all no-ops" into the same typed error the interactive path would raise. Existence of connect targets needs no pre-read at all: it is a premise plus an in-DB slot expression. The **own-write feedback hazard** is a Decide whose read footprint (table + selector) intersects the write footprint of statements already in the program; interactively it would observe the write, in batch it would not, so refusing it is the only way the two substrates agree — and the check is a set intersection at lowering time, not a runtime mechanism. The **committed-segments** substrate exists for the residue: a slot that has no batch-resolvable resolver (autoincrement parent, no natural unique, multi-level nesting — `currval` works on PG, but MySQL/SQLite last-insert functions are connection-global) or a bulk row that may legitimately observe the previous row; the program is cut at that point and each piece is an atomic batch whose results refill slots before the next piece renders.

## Part 2 — Architecture and size

**Phases.** (1) *Declare*: builder → B1 descriptor; the type mirror is compile-time only. (2) *Validate*: per verb, per model, generated from B1 and the B2 op table; invoked when a node is *expanded*, never on the whole args object (that is what makes the untaken arm inert and gives call-time laziness). (3) *Lower*: args → IR. Reads lower to B6; writes lower to a program {statements, slots, decides, premises, footprint, expected counts}. **The verb discriminant dies here.** (4) *Render*: IR → SQL + ordered params through one renderer and the dialect table. (5) *Schedule*: one of three B10 schedulers. (6) *Decode*: projection tree + B2. Cross-cutting concerns attach at phase boundaries: the cache key is the rendered SQL+params and its invalidation set is the program's write footprint (already computed for H2); OTel spans wrap phases 3–6; the extension chain has one hook per boundary (request transform before 2, interceptor around 3, statement transform after 4, observer after 6) plus client/model method registration; raw SQL enters at phase 4 with B2 for parameters.

**Two IRs, both required.** The query IR (B6) because reads must be first-class values inside write programs. The write-program IR because the three schedulers must consume one artefact — if each scheduler re-derived statements from args, the verb semantics would exist three times.

**Execution on the three substrates.** (i) Interactive: topo-walk; each statement executes; slots fill from RETURNING or last-insert+reselect; Decide executes its read inline; a savepoint wraps any nested sub-program the user can catch (user-level `tx.savepoint`), not each verb. (ii) Atomic batch: pass A hoists Decide reads (their footprints are already proven disjoint from prior writes, so hoisting is sound); pass B assigns slot resolvers to {literal, client-generated, in-DB expression}, refusing to (iii) if any slot has none; pass C renders every write with the premise conjunction; pass D submits and verifies counts. (iii) Segments: split the DAG at unresolvable slots and at bulk-row boundaries; run (ii) per segment; refill slots from segment results; report progress; on failure report the committed prefix. **Polymorphism enters** at B1 (relation → variant edges + discriminator column) and at lowering (the arg names the variant; pick the edge; add the literal). Plural polymorphic reads fan out to an OR over edges or per-variant correlated subqueries. Nothing else knows. **Bulk vs single**: without relation args, bulk verbs are one chunked B7; with relation args, they are N single-row programs run as segments. **Migrations** share Snapshot + Diff + rewrite + render + B10-with-ledger; the ten commands are compositions in the table above.

### Size estimate (careful production TypeScript, excluding tests)

| Subsystem | Lines | Basis |
|---|---|---|
| Schema builders + runtime descriptor | 1,800 | fluent API for 15 scalar kinds, 4 relation storages, keys/uniques/defaults |
| Type-level inference (args, where, select/include, result, relation writes) | 3,500 | unavoidably verbose; one generic mapper per axis, not per verb |
| Validation (lazy, descriptor-driven) | 1,400 | per-verb arg shapes + scalar op table + relation-write shapes |
| Codecs (B2 table incl. decimal/date/json/blob/vector/geo) | 800 | |
| SQL AST + renderer + dialect table | 2,000 | |
| Read lowering (B5, B6, include/JSON hydration, cursor, aggregate, groupBy) | 2,500 | |
| Write lowering (verbs → DAG, edges, slots, Decide, premises, footprint, polymorphic fan-out, PK-change substitution) | 2,800 | |
| Schedulers ×3 + tx envelope + chunking + id publication on non-RETURNING | 1,600 | |
| Result decode + shape validation | 800 | |
| Driver adapters (11) | 1,800 | ~150 each; batch capability flag |
| Cache / OTel / extension chain / raw SQL | 1,500 | |
| Client surface, errors with codes, tx API | 1,000 | |
| Migrations: snapshot 600, diff 900, DDL render + SQLite rewrite 1,500, introspection ×3 1,300, ledger + commands 1,200 | 5,500 | |
| **Total** | **≈ 27,000** | ±30% |

**Decisions that would multiply code if taken wrongly.** (1) Writing the program per substrate: ×3 on write lowering (≈ +5,600). (2) Keeping the verb discriminant past lowering: the renderer and schedulers grow a `switch` per verb, ×(verbs) on ~3,500 lines. (3) Lowering per dialect instead of rendering per dialect: ×3 on 5,300 lines of lowering. (4) A relation engine per storage kind, or treating polymorphism as its own engine: ×2–4 on write lowering. (5) Separate nested and top-level verb implementations: ×2 on write lowering. (6) One module per scalar type: 45 files for what is a table. (7) One result type per verb instead of one projection→result mapper: ×N on the type layer, which also multiplies typecheck time, the scarcest resource in a zero-codegen ORM. (8) Hydrating includes with per-level follow-up queries *and* JSON subqueries: two hydration engines when one suffices.

## Part 3 — Comparison with the repository

Sources read: `docs/architecture/retired/write-engine-ATOM.md` (1,300 lines), `src/query-engine/AGENTS.md` (871 lines), and `wc -l` over the requested directories. Nothing was modified.

### Measured sizes (non-test TypeScript; the repo keeps tests outside `src`)

| Subsystem | Actual | My blind estimate | Ratio |
|---|---|---|---|
| `query-engine/write-engine/` | 34,075 | 2,800 (write lowering) + 1,600 (schedulers) | 7.7× |
| `query-engine/builders/` | 10,132 | 2,500 (read lowering) | 4.1× |
| `query-engine/` top-level + `operations/` + `context/` | 10,564 | — (folded into the above) | — |
| `query-engine/result/` | 5,438 | 800 | 6.8× |
| `validation/` | 20,705 | 1,400 | 14.8× |
| `schema/` | 15,008 | 1,800 (+ part of 3,500 types) | 3–8× |
| `migrations/` | 28,604 | 5,500 | 5.2× |
| `adapters/` + `sql/` | 5,361 | 2,000 | 2.7× |
| `drivers/` (11 + shared 1,890) | 11,703 | 1,800 | 6.5× |
| `client/` | 6,972 | 1,000 (+1,129 of it is result types) | ~3× |
| `cache/` + `instrumentation/` + `extensions/` + `errors/` | 10,760 | 1,500 | 7.2× |
| `cli/` | 780 | — | — |
| **Total `src/`** | **160,427** | **≈27,000** | **5.9×** |

### Where the existing architecture agrees with the derivation

1. **The verb discriminant dies at lowering.** ATOM §2: "No branch, locate, relation, or mutation kind is a runtime step kind. Those are compiler concepts that lower to reads, writes, and guards." The runtime vocabulary is `ReadStep | WriteStep | GuardStep | RecordSeriesStep` — my B7 (four statement kinds) plus premise plus the segment container. `OperationValueReference` pointing backward in the fragment is B8 (slot). "Final sources can also be … lookup SQL" is my in-DB resolver; "lookup SQL cannot decide a planning branch" is my rule that Resolve is a slot, not a read.
2. **Two-phase branch with an inert untaken arm.** `planning() → PlanningKnown → compile(known)` is my Decide continuation with the read hoisted. "A missing create arm does not analyze the untaken update subtree"; "an untaken top-level upsert update arm remains inert because capture and replay occur only after that arm is selected." Same mechanism, same consequence.
3. **Batch substrate = guards before writes, stable order inside both buckets** (§3, core rule 5). The own-write hazard is `OwnWriteAnalyzer` with the "split these operations" failure — my footprint intersection, including the refinement that a same-operation duplicate `connectOrCreate` "adopts that row" via a local first-create-wins registry rather than a re-read (§12 "Same-operation duplicate").
4. **Relation-bearing bulk writes are N single-record programs.** §17: "a second relation compiler for bulk rows would be the thing this document exists to prevent"; `CreateManyRecordSeries` / `UpdateManyRecordSeries` are ordinary `CreateOperation` / `RecordUpdateCompiler` members run left to right; on batch-only drivers they run as committed segments with `recordSeriesProgress`. This is exactly my substrate (iii) and its raison d'être.
5. **Lower once, spell per dialect.** "The query engine decides what statement is needed. The adapter decides how to spell it" — with an explicit list of tokens the engine may never emit (quoting, JSON, RETURNING, conflict, assertion CTEs, locks, casts, batch refs). Adapters at 5,361 lines are within 2.7× of my estimate, the closest match in the table, which is consistent with the divergence table being small when it is actually kept as one.
6. **Chunking is measured, not estimated**: `bind-budget.ts` partitions by compiled `Sql.values.length` because casts, private storage, and SQL-valued cells add binds. A refinement I did not have; ~60 lines.

### Where it took a different decision, and what each one costs or buys

**D1. Guards are separate statements (assertion CTEs owned by the adapter), not a premise conjoined onto every write.** I proposed the conjunct so that a stale premise makes every write a no-op and a count check raises afterward. The repo emits a `GuardStep` whose failure aborts the atomic batch. Theirs is better: affected-row counts stay meaningful for the public `count` contract, `expects` postconditions already exist for other reasons, and a guard is one extra statement in the same round trip. I concede this; it costs nothing measurable.

**D2. Retryable race pins.** `create-race-pin.ts`, `race-retry.ts`, `TargetConstraint.ts` (575), `unique-conflict-target.ts`: the missing arm of `connectOrCreate`/`upsert` uses the unique constraint as its premise and classifies the matching violation as *retryable*, re-probing and re-selecting the arm. I treated a stale premise as a typed error. Under concurrency an upsert must converge, not fail, so this is a semantic I underestimated: +~1,000 lines in a careful implementation (pin construction, provider-error attribution to a specific constraint, a bounded retry loop, the "extended selector does not get a pin" rule).

**D3. Wrong-row protection and captured row keys (§15).** Every selected-record write addresses the *captured complete primary key*, never the selector, because the operation may change fields in the selector; in batch mode a guard reasserts selector + captured key, and the conditional-skip arm needs two guards in a fixed order (presence, non-raceable; then absence, raceable) so that SQL UNKNOWN is a no-match. My slot table already keys on the captured value, but I did not state the second guard or the UNKNOWN subtlety. +~300.

**D4. Primary-key transitions are runtime-ordered, not delegated to `ON UPDATE CASCADE` (§14).** I assumed the migrations emit CASCADE and the runtime merely substitutes the new key. The repo carries `onUpdate` on every bound FK membership, gives every correlated FK member *two* sources (old-read, new-write), and decides per edge whether descendant work goes before or after the root UPDATE; where no cascade exists an occupied old slot is refused before any write. Polymorphic memberships have no database FK at all, so their referenced-value transition is entirely the compiler's. This dual-source discipline is threaded through `relation-membership.ts` (1,047) and `RecordUpdateCompiler`. Legitimate; +~800 over my design, and it is the strongest argument in the doc for keeping a *selected-record* compiler distinct from a *fresh-record* one (a fresh row has no "before" key).

**D5. Generated-output publication is a per-substrate lattice (§9).** RETURNING; non-RETURNING transaction → one focused post-insert read located by `insertId` or by a complete *explicitly literal* unique, else refuse before the INSERT; SQLite/MySQL batch → statement-local insert-id lowering (`batchRefs`); PostgreSQL batch → never `lastval()` (trigger-sensitive) — either an exact RETURNING fold or a committed segment; `$transaction([...])` → a data-modifying-CTE DAG fold when the projection reads no sibling-mutated table. I had proposed `currval(seq)` for PG; they are right to reject it (a trigger inserting into the same table advances the same sequence). The CTE-DAG fold for array transactions is a fourth substrate I did not derive. +~800.

**D6. Polymorphism is a third `membership.kind`, and junctions can be to-one.** I claimed polymorphism is FK + a discriminator conjunct, not a separate shape. The repo says the same about the predicate ("expresses a conjunction, not two independent links") but still binds it as its own kind because it has private storage, no referential action, and the discriminator participates in OwnWrite scope, `set` departure, and bulk predicates. More importantly, a polymorphic collection member whose inverse is singular binds as `position: "junction", cardinality: "one"` — a *slot-replacement* protocol (`junction-singular-transfer.ts`, 400; `RelationJunctionToOnePart.ts`, 1,200): capture, then CAS in batch or a row lock in a transaction, with a MySQL-specific fallback because it cannot target a duplicate clause. I reduced slot uniqueness to a unique constraint; replacing the previous occupant atomically is a real semantic I missed. +~1,200.

**D7. `skipDuplicates` beside relation data.** Interactive: one savepoint per member subtree; batch: the root write is isolated as its own segment and its row count decides whether descendants run; junction `createMany` chooses among four dispositions *per row*. I had skipDuplicates as a dialect cell. +~500.

**D8. Error order and exact messages are contract (§19, core rule 3).** Whole-argument validation, PK validation, relation-key legality, update-many legality, OwnWrite, planning, execution — in that order; ordinary relation payloads transformed before polymorphic ones so a mixed malformed payload reports the same first error. This forbids the "validate on expansion" laziness I proposed in its purest form: root update must "spell its own two passes" rather than delegate. It is a legitimate contract that manufactures mass everywhere parsing happens; I cannot bound it precisely, but it is at least +~2,000 across validation and write-engine.

**D9. One invariant, one guard, one falsifier.** Core rule 8 ties every `UnsupportedOperationError` site to a ledger and a construction-inventory test. Each refusal in §17 (N>1 root child-held move, loopback key change, pre-effect before a skippable root, unguardable progressive placement, dynamic series inside `$transaction([...])`, plural produced key with no locator …) is a distinct semantic verdict my derivation did not enumerate. Twenty to forty such sites at 50–100 lines is +~2,500. This is not duplication; it is the enumerated boundary of the batch substrate.

**D10. The verb × position × freshness × phase grid.** This is where the multiplier lives. `RecordUpdateCompiler` (5,803) and `CreateOperation` (4,315) are two record compilers (D4 justifies the split); relation owners are per position — `RelationWritePart` (1,650, child-held), `RelationJunctionPart` (3,461), `RelationJunctionToOnePart` (1,200), `PolymorphicCollectionPart` (248), `RelationUpsertPart` (1,131) — and inside each owner every verb has its own `planning()` and `compile(known)` body because guard policy, pin policy, and messages differ per verb (§12). The doctrine's "ONE dispatcher per position, not one per position × membership" is honoured for *storage*, but verb semantics are still instantiated per position and per phase: ≈ 10 verbs × 3 positions × 2 phases of 50–150 lines ≈ 3,000–9,000 lines. My design instantiates each verb once against three ~30-line membership primitives (assign / clear / probe) and gets per-verb guard policy from a small table. The repo's `relation-membership.ts` *is* that factoring for lowering — so the grid is not a failure to factor the edge, it is a decision to keep verb-specific guard/pin/message policy inline rather than tabulated. AGENTS.md is explicit that this is deliberate: "Do not add a generic mutation DSL, payload walker, branch-step IR, locator, strategy, lifecycle hook, or shared utility landfill." That rule rejects exactly my Decide-node IR. The trade: no interpreter for branch nodes, at the cost of every owner implementing both phases. I estimate this decision, net of the legitimate semantics in D2–D9, accounts for ~12,000–14,000 of the write engine's 34,075.

**D11. A home-grown validation library and one file per scalar.** `validation/primitives/` (~5,500: `v.ts`, `object`, `operand`, `pipe`, `iso`, geo codecs, `decimal-codec` 1,127) is a standalone validator rather than a dependency; `validation/scalars/` is fifteen ~200-line files — the "one file per scalar type" multiplier I named — and `json-schema/` (~870) exports JSON Schema, a feature not in the brief. The decimal codec alone is 1,127 lines because exact decimals on SQLite need a canonical, sortable physical carrier and arithmetic lowering ("provider-specific physical carriers"), which I had wrongly filed as a codec cell: legitimate +~1,500 across validation, adapters, migrations. Net: ~5,500 (own primitives) + ~2,000 (per-scalar files over a table) + ~900 (JSON-Schema export) of the 20,705 is decision, not semantics.

**D12. Cached results are stored decoded, so the cache needs its own codecs.** `result/cache-*.ts` ≈ 1,000 lines serialise `Decimal`, `Date`, `bigint`, blobs for the cache. My design caches provider rows keyed by SQL+params and re-decodes on hit — zero codec code, at the price of decode cost on every hit. A decision, ~1,000 lines. Related: the "consumable rows / lexical proof" path (in-place decode only when the driver is an exact stock sqlite3/PGlite client, proven on one lexical stack) is a performance optimisation with a security-flavoured proof discipline, ~600 lines across `ResultParser` and `OperationExecutor`, that my design would not carry.

**D13. Typed JSON documents.** `schema/json/` ≈ 3,500 lines (`read` 1,375, `serialize` 630, `interpret` 545, `default-codec` 449, issues, native catalog) is a typed-JSON-field language with its own validation and native-type catalog. The brief says "json" and "JSON path filters"; if typed JSON documents are in scope, ~1,500–2,000 is defensible and I under-scoped; the remainder is decision.

**D14. Migrations: 28,604 vs 5,500.** Splitting the actual mass: introspection ×3 ≈ 1,786 (my 1,300 — agreement); per-dialect DDL drivers + base ≈ 5,600 (my 1,500 — SQLite physical forms for decimal/datetime, `sql-lexing`, `column-constraints`, MySQL `decimal-recovery`, PG index-predicate canonicalisation are legitimate: revise to ~3,500); diff/graph/resolver/operators/serializer ≈ 4,200 (my 1,500; the operator catalog at 1,312 and canonical serialisation for evidence hashes at 968+116 are real: revise to ~2,500); ledger/control/apply/status ≈ 1,800 (my 1,200); push family (`push-plan`, `push/planner`, `push-consent`, `push-fingerprint`, `enum-removals`) ≈ 2,000 (my ~400 — consent and fingerprinting are features beyond "dev sync"); `reset-v1` + `live-reset` ≈ 1,500 (two resets); `v1-parse-*` + `v1-types` ≈ 1,900 (a versioned on-disk format with its own parser layer); `storage/` ≈ 650 (pluggable migration storage backends — fs, object store, memory, conformance); `statement-safety` 876; `pinned-session` ×2 ≈ 750 (holding one connection for MySQL's non-transactional DDL — I had this as "a scheduler property", which it is, but it is also connection pinning across statements). Legitimate revision ≈ 12,000; ≈ 6,000 is features I did not have (storage backends, versioned format, consent/fingerprint, statement safety) and ≈ 4,000 is doubled resets and per-dialect breadth.

**D15. Drivers at ~400 lines each plus 1,890 shared.** I budgeted 150 per driver. Provider error recognition (constraint attribution feeds D2's retry classification), the `insertId` channel, batch capability flags, `supportsOrderedCommittedSegments`, and consumable-transport nomination are each real. Revise to ~4,500; the remainder is the extension-authority machinery leaking into drivers.

**D16. Extensions carry an authority model.** "No operation method, symbol property, public token, or structural protocol grants execution authority" — authority is resolved from a private `WeakMap` and class-private state; there are four capability protocols with single runners and an admission latch. My 1,500 for all cross-cutting assumed trusted extensions. The threat model (an extension must not be able to forge transaction authority) is a decision; ~2,000 of the 3,387.

**What I would push back on.** Two decisions manufacture size without buying a semantic: (a) the per-verb × per-position × per-phase bodies in the relation owners, where guard/pin/message policy could be a table consumed by one lowering per storage (D10); and (b) the decoded-result cache codecs (D12). One decision I would call a wash: the explicit rejection of a branch IR — it removes an interpreter but forces every owner to implement `planning()` and `compile(known)`, which is the same code volume relocated. And one decision is strictly better than mine: separate guard statements (D1).

**What the repo saw that I did not.** Retry convergence under concurrency (D2), runtime-ordered key transitions with dual sources and no DB cascade for polymorphic memberships (D4), the generated-output lattice including the CTE-DAG fold and the rejection of PostgreSQL session functions (D5), singular junction slots with a transfer protocol (D6), subtree-scoped skipDuplicates (D7), error order as contract (D8), and exact decimals/datetimes on SQLite as physical-carrier problems rather than codec cells (D11).

### Revised estimate

| Subsystem | Blind | Revised for missed semantics | Actual | Decision-attributable remainder |
|---|---|---|---|---|
| Write engine (lowering + schedulers + own-write) | 4,400 | 12,000 | ~44,600 (write-engine + query-engine top-level + operations) | verb×position×phase grid, refusal-site enumeration, exact-message plumbing |
| Read lowering (builders) | 2,500 | 4,500 | 10,132 | includes ~2,500 of write-side parsing/topology; polymorphic-collection `every` and geo bounds are legitimate |
| Result decoding | 800 | 2,000 | 5,438 | cache codecs ~1,000, consumable-row proof ~600, middleware chains |
| Validation | 1,400 | 4,000 | 20,705 | own primitive library, per-scalar files, JSON-Schema export |
| Schema (runtime) + types | 5,300 | 7,500 | 15,008 + 1,129 (client result types) | typed JSON document language beyond brief |
| Adapters + SQL | 2,000 | 3,500 | 5,361 | close to legitimate |
| Drivers | 1,800 | 4,500 | 11,703 | authority/transport nomination |
| Cross-cutting + client | 2,500 | 6,000 | 17,732 | extension authority model, exact error catalogue |
| Migrations | 5,500 | 12,000 | 28,604 | storage backends, versioned format, consent/fingerprint, statement safety, two resets |
| **Total** | **≈27,000** | **≈56,000** | **160,427** | **≈100,000** |

My blind number was about 2× too low on semantics the brief compressed into single clauses ("primary-key updates cascade correctly", "same observable semantics on both substrates", "failures typed with codes", "decimal(p,s)"). The remaining ≈2.8× is attributable to named decisions, of which the largest single one is keeping verb-specific policy inline across positions and phases in the write engine rather than tabulating it against one lowering per membership storage. The repo's own doctrine ("one invariant has one guard", "no generic mutation DSL") is internally consistent with that choice; it trades line count for the property that every refusal and every guard has one nameable owner and one falsifier, which is a maintainability bet, not an accident.
