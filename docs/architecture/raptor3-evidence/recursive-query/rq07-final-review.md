# RQ-07 — the final independent review: RQ-01 as one unit, and the follow-up round (2026-09-23)

One Opus reviewer (effort max) over (A) RQ-01 — SQL placement and the decoder
as one statement/answer contract, owed since RQ-01 — and (B) the external
review's follow-up round (P1, P2, P3) on the uncommitted tree over `4ead1c591`;
one bounded Opus repair round; one re-check by the same reviewer. Workflow
`wf_bf101c2b-196`; raw structured results in the session scratchpad
(`final-review-results.json`), reproduced here in full. The repair round's own
receipts are in `final-repair/` and its record is the "Final repair round"
section of `rq07-review-followups.md`.

## A — RQ-01 as one unit: **ACCEPT**

A (RQ-01 as one unit): the SQL placement and the decoder hold as one statement/answer contract. I found no correctness defect in RQ-01. Verdict on A alone: ACCEPT, with the minor repairs listed: the consumed guard's lost witness, stale ledgers, the unstated SQL invariant, the re-spelled cutoff predicate, and SQLite's unrecorded double evaluation of the CTE.

What I ran:
- **SQL shape.** I lowered the recorded two-root matrix case through the built package on the MySQL, PostgreSQL and SQLite adapters. Each gives one statement with one recursive CTE. The MySQL text is byte-identical, after whitespace and namespace normalization, to the statement recorded in rq07-native-lanes.md. PostgreSQL takes the lateral form (`FROM (SELECT 1) JOIN LATERAL (WITH RECURSIVE …)`), SQLite the scalar form, and the unbounded LIMIT appears only on MySQL.
- **Constructed cases.** 241 legitimate cases on SQLite and 240 on PGlite, run through the public client against an independent in-memory oracle:
  - junction out/in from five roots at depths 1–9, with cycles prevented and allowed, plus exhaustive;
  - every row as a root in one findMany;
  - paired directions nested (out→in);
  - a relation-valued node filter;
  - FK children/parent from seven roots at depths 1–5 and exhaustive, through a ring and two lassos; the cycle errors fall exactly where the oracle errs;
  - DateTime physical keys at depth 3: two TEXT keys for one instant keep separate subtrees.

  The per-level hop check produced no false refusal. Every case was exactly one statement.
- **Falsification outside the tree** on copies of dist: without P2, the P2 witness carrier decodes with the invented occurrence; without the consumed check, only an extra-level fact goes unrefused.
- **EXPLAIN** on SQLite and PGlite.

Native evidence: gate-2's native lanes ran on this same src digest, 7/7 per provider with 300/300 campaign cases each.

Why the contract holds:
- Every refusal in decodeRecursiveCarrier is unreachable from a well-formed statement. UNION DISTINCT excludes duplicate facts. The distinct-id reader excludes duplicate nodes. The key joins exclude dangling endpoints. The depth bind excludes out-of-range depths. Singular successors are unique through the FK or UNIQUE constraint.
- Every carrier the statement can produce is accepted: empty, bounded, exhaustive, root re-entered, self-loop, singular.
- The per-level invariant P2 enforces is exactly the statement's. The anchor and the recursive member apply the same correlation and filter, and the only level-dependent SQL is the bound, which matches `level < depth`.
- Identity is spelled by one rule (`carriedValue` over the key leaves) for the root, the node keys and the edge tuples.
- `completeOrder` is the one tie-break. The edge page orders by parent, then sibling order, then complete key, which is the decoder's per-parent first-occurrence order on every provider. The PG plan sorts before the aggregate, and on MySQL the LIMIT prevents the merge.

## B — round 1 verdict **REVISE** (11 findings: one major — P1 was not closed for the NESTED spelling, a recursive slot named `_distance` whose repeated node selects a distance — and ten minors)

- **major** `src/query-engine/raptor3/shared/query.ts`:3622 — P1 is not closed. When a recursive slot is named `_distance` and its repeated node selects a point's distance, the node's `_distance` key has two producers: the distance leaf and the repeated slot. Admission and preparation both accept this payload. The decoder publishes the children array at every level below the cutoff and the distance number at the cutoff. The schema-only renderer declares the key twice. This is the behaviour the follow-ups ledger itself describes at lines 20-22 ('wrote the slot over the distance wherever the repeated key is present and left the distance where a numeric cutoff omits the key'). It contradicts 'One sentence, both orders, every producer' (rq07-review-followups.md:32), 'never both' (:45), the CHANGELOG sentence and the selecting.mdx sentence.
  - evidence: Setup: the built package (dist/ built by gate-2 from src digest 04903b9b…, which is the current tree), with a lowering driver on PostgresAdapter+PostGIS. Payload: `findMany({ select: { id: true, _distance: { recurse: { depth: 2 }, select: { id: true, at: { _distance: { to: paris } } } } } })`. Results: (1) Accepted, 1 statement. The binds name the node document keys "id","_distance" followed by the distance operands. (2) Control: the same schema with the asking key itself spelled in the node is refused with V4001 '_distance is produced by recurse and cannot be selected again inside its own recursive node'. So admission sees input keys only. (3) A carrier of that statement (root→a@1, a→b@2, node rows {id,_distance:11.5} and {id,_distance:22.5}) decodes to [{id:'root',_distance:[{id:'a',_distance:[{id:'b',_distance:22.5}]}]}]. (4) renderOperationResultType renders `type VibORMRecursiveNode1 = { id: string; _distance: number; _distance?: Array<VibORMRecursiveNode1>; }`. The TS compiler reports TS2300 Duplicate identifier '_distance' and TS2717 on that text. (5) Through `$withCache()` the second read executes again (statements 1 → 2). (6) The static type of the node key is a merged Number/Array member bag.
  - requested: Refuse the pair at one owner with the registered sentence. In `relationShape`'s recurrence arm (query.ts:3622), throw `DISTANCE_NAME_COLLISION` when `nested.projection.shape.fields[nested.edge.name]` is present. Admission already refuses the key itself, so only a distance can put it there. Mirror the refusal in result-shape.ts `addSelectedRelations` when a recurrence is admitted, `relationName === '_distance'` and the nested shape has `distanceScalar`. An alternative single owner for both views is to extend `askingKeyRefusal` (select-include.ts:96) to a distance selection inside the repeated node. Add the nested spelling to distance-key-collision.test.ts for the engine entry, the shipped client (0 statements) and renderOperationResultType; these cells are red on this tree.
- **minor** `tests/raptor3/recursive-query/distance-key-collision.test.ts`:148 — The witness's cache assertion proves nothing. The cell calls `client.place.findMany`, which never reaches the cache (only `$withCache()` reads do), so `memory.writes === 0` holds for any query. The ledger's 'zero statements and zero cache writes' (rq07-review-followups.md:42) is therefore not witnessed by this cell.
  - evidence: Same client construction on dist. An accepted `findMany({ select: { id: true } })` through the plain path gives 1 statement, 0 reads, 0 writes; through `$withCache()` it gives 1 statement, 1 read, 1 write. The refused pair through `$withCache()` gives 0 statements, 0 reads, 0 writes, because preparation precedes the lookup: `readPendingCacheResult` resolves `#cacheResultCodec()`, which prepares the read, before `executeCachedResultOperation` calls `get`.
  - requested: Route the cache half of the cell through `client.$withCache().place.findMany(args)`. Assert `memory.reads === 0` and `memory.writes === 0` beside the existing statement count.
- **minor** `src/query-engine/result/result-shape.ts`:180 — The schema-only hunk has no red witness, and its only new coverage cannot be reached through its only caller. At HEAD the guard already sat after the SELECTED relations, so both spellings the renderer cell tests were already refused before the repair. The move adds only the INCLUDED relation, and renderOperationResultType never reaches that spelling because admission refuses `select` beside `include` (V4001). The ledger's sentence 'so the renderer could declare the key twice for an included relation' (rq07-review-followups.md:24) describes a case the renderer cannot reach.
  - evidence: `git show HEAD:src/query-engine/result/result-shape.ts` lines 162-166 put the guard after addSelectedRelations(select)/addSelectedPolymorphicRelations(select). On dist, renderOperationResultType(schema,'place','findMany',included) returns V4001 'Mutually exclusive fields cannot be used together: select, include'. No test calls buildExpectedResultShape with the included spelling.
  - requested: Choose one: (a) add a cell below admission, `buildExpectedResultShape(place, 'findMany', included, index)` expecting the collision sentence, which is red on HEAD's bytes; or (b) revert the hunk and correct the ledger sentence to say admission refuses the included spelling (V4001) before any shape is built.
- **minor** `tests/raptor3/recursive-query/carrier-boundary.test.ts`:316 — P2 took over the only witness of the bounded consumed-facts guard (query.ts:4716). This cell's wrong-level carrier is now refused by the per-level hop check at the root's hop, so deleting the consumed guard leaves every cell green. The guard still has unique coverage. rq01-decoder-repair.md:289 ('deleting it outright … turns rejects bounded edge facts attributed to the wrong traversal level red') no longer holds.
  - evidence: Falsification outside the tree, on copies of dist in TMPDIR, through the public client with crafted carriers. With the consumed check removed, `root→child@2, child→grandchild@1` (depth 2) is still refused with 'Invalid provider recursive depth', now by P2. The carrier `root→P@1, P→C@2, P→C@3` (depth 3, P reached only at level 1) then decodes silently to [{id:'P',links:[{id:'C',links:[]}]}]; the original build refuses it. With P2 removed instead, the P2 witness carrier decodes with the invented `leaf`, which confirms that witness was red before the repair.
  - requested: Add to this cell: graphDecoder({depth:3,cycles:'prevent'}) on carrier(['root'],[node('P'),node('C')],[edge('root','P',1),edge('P','C',2),edge('P','C',3)]), expecting /Invalid provider recursive depth/.
- **minor** `src/query-engine/raptor3/shared/query.ts`:4136 — The invariant P2 relies on is stated only at the decoder. The SQL owner's doc comment does not say that every reached (parent, level) below the bound is expanded with the same correlation and filter, and that nothing is pruned in SQL. Any future SQL-side pruning, or a caller's volatile filter, therefore surfaces as a provider error.
  - evidence: The doc comment at query.ts:4135-4139 covers only edge facts, the node table and decoder ownership. Probe with an admitted raw fragment, `where: { rank: { gte: sql`floor(random()*8)::int` } }`, in a depth-6 walk with preventCycles false: on PGlite 52 of 60 runs resolved and 8 raised 'Invalid provider recursive depth' (P2). On SQLite 49 of 60 were already refused by the edge-endpoint and unreachable-node checks, because SQLite materializes the CTE once per reader.
  - requested: Add one sentence to `lowerRecursiveRelationProjection`'s doc comment: the recursive member expands every reached row below the bound with the same correlation and filter and prunes nothing (the cycle policy belongs to the decoder), because `decodeRecursiveCarrier` refuses a carrier in which a parent lacks its children at any level it is reached below the cutoff.
- **minor** `src/query-engine/raptor3/shared/query.ts`:4711 — The per-level check writes its own copy of 'below the cutoff' (`level < shape.recurrence.depth`) instead of calling the fact's owner, `carriesRepeatedKey`, which `cutoff` and the cache codec both use.
  - evidence: Compare query.ts:4709-4713 with recurrence.ts:18-23 and query.ts:4736-4737.
  - requested: Replace the condition with `shape.recurrence.depth !== false && carriesRepeatedKey(shape.recurrence.depth, level) && children.size !== (successors.get(parent)?.length ?? 0)`.
- **minor** `src/query-engine/raptor3/shared/query.ts`:3497 — The distance arm's comment is stale after P1. It cites `result/result-shape.ts:164`, but that guard moved to buildModelShape after every producer (around line 184). It also says the collision is with 'a scalar of that name', while the arm now also refuses a relation or variant slot prepared earlier.
  - evidence: query.ts:3497-3499 compared with result-shape.ts:180-188.
  - requested: Change the reference to point at `result/result-shape.ts` buildModelShape (the guard after every producer), and change 'a scalar of that name' to 'a field of that name: scalar, relation or variant slot'.
- **minor** `docs/architecture/raptor3-evidence/recursive-query/rq01-decoder-repair.md`:87 — RQ-01's two ledgers predate P2, which changed RQ-01's walk, and no longer match the tree. This ledger (line 87) still says 'Two refusals fall out of that single walk'; there are now three. Its round-A falsification (:289) no longer holds (see the carrier-boundary finding). Its 'Left unverified' item (:235) is partly superseded by P2. rq01-sql-placement.md:81 still says carrier-boundary went '11 → 12' (it is now 13). Its :41-42 native rows still read NOT RUN with no superseded note, and :43 holds a garbled cell ('3 ⎯⎯⎯').
  - evidence: Compare with query.ts:4661-4717 (walk comment with three questions; checks at 4709 and 4716), the manifest (13 cells) and rq07-native-lanes.md.
  - requested: Add a dated line to each ledger pointing to rq07-review-followups.md P2: the walk's third question, 13 cells, and the wrong-level carrier now answered by the hop check. Mark the native rows in rq01-sql-placement.md as superseded by rq07-native-lanes.md. Restore the garbled cell as '8 passed, 3 failed (11)', the red baseline recorded in rq01-decoder-repair.md.
- **minor** `docs/architecture/raptor3-evidence/recursive-query/rq07-release-verdict.md`:41 — The verdict's wording no longer matches what was reviewed. Line 41 says RQ-01's review 'is owed until the native receipts exist', but the receipts exist. Line 3 names only RQ-01's review as owed, yet it already calls the three external findings 'closed', although the follow-up round is reviewed only by rq07-final-review.md (and P1 is not closed, see the major finding). Risk 4 (line 135) scopes the delta since the perf attestation to the carrier placement, but P1 changed `prepareProjection`, which every comparator cell prepares through, and it was not re-attested.
  - evidence: rq07-release-verdict.md lines 3, 37-43 and 133-137. The rq07-native-lanes.md receipts exist. The P1 hunk is at query.ts:3515-3521.
  - requested: Line 41: 'is owed until the native receipts exist' → 'and the follow-up round's review are `rq07-final-review.md`'. Line 3: say RQ-01's whole-unit review and the follow-up round's review are owed, and replace 'are closed on this tree' with 'are repaired on this tree, pending that review'. Line 135: append that the follow-up round's hoisted guard in `prepareProjection` runs on every comparator cell's preparation (one comparison per projected relation field) and was not re-attested.
- **minor** `docs/architecture/raptor3-evidence/recursive-query/rq07-review-followups.md`:90 — The environment record for the RQ-00 native stages is not what the logs show. The stage logs carry neither container names nor server versions. The PostGIS container was started nine minutes before the stage, and no ledger records that.
  - evidence: Read-only `docker inspect`, with the port read silently from the connection file: /private/tmp/viborm-fc-env/pg maps to viborm-triage-pg-20260918 (postgis/postgis:16-3.4, restart policy no). It stopped at 2026-09-23T06:55:13Z (the engine restart) and started at 08:47:16Z; the stage began at 08:56:34Z. /private/tmp/viborm-m1-env/mysql maps to viborm-triage-mysql-20260918 (image mysql:8, up since 06:55:57Z); the version 8.4.11 comes from the native round, not from these logs. The handoff's rules forbid launching a service.
  - requested: Record the container start: time, who started it, and under which authorization. State that the versions come from the image tag (PostGIS 16/3.4) and from the native round's observation (MySQL 8.4.11), not from the stage logs.
- **minor** `docs/architecture/raptor3-evidence/recursive-query/rq07-cost-measures.md`:71 — The contract's §3.2(6) asks for database evaluation work to be measured, and it is still listed as not measured. SQLite's plan evaluates the carrier's recursive CTE once per reader, so twice per carrier. PostgreSQL evaluates it once. No ledger or guide records this; AGENTS.md says only that SQLite 'evaluates the correlated CTE per row as written'.
  - evidence: EXPLAIN QUERY PLAN of the engine's own statement (depth-40 chain) shows two `MATERIALIZE __q1_recursive` blocks, one under the nodes subquery and one under the edges subquery, each with SETUP/RECURSIVE STEP. The PGlite EXPLAIN shows one `CTE __q1_recursive` (Recursive Union) read by two CTE Scans. The volatile-filter probe shows the two SQLite readers see different evaluations.
  - requested: In the 'Not measured here' bullet and in AGENTS.md's SQLite clause, record that SQLite evaluates the recursion once per reader (twice per carrier) while PostgreSQL materializes it once per outer row. Claim no number.

### Probes

All probes ran with pinned Node 24.21.0 and TMPDIR=/private/tmp/viborm-rq-final-review-tmp. Each ran under the shared lock through scripts/run-node-safe.mjs (heap 512–1024 MB, RSS 1536 MiB) against the built package dist/, which gate-2 built at 09:13:26Z from src digest 04903b9b…. I recomputed that digest and it equals the current tree. Nothing in the repository was edited.

1. **Cache path (p1-probe).** Lowering driver on PostgresAdapter+PostGIS with a recording MemoryCache.
   - Refused pair (distance first or relation first), plain path and `$withCache()`: 0 statements, 0 reads, 0 writes.
   - Included spelling: V4001, both in the client and in renderOperationResultType.
   - Accepted control: plain path 1 statement, 0 reads, 0 writes; `$withCache()` 1 statement, 1 read, 1 write.
2. **Legitimate carriers (p2-probe).** SQLite 241/241 and PGlite 240/240 matched the independent oracle, one statement each. Carrier shapes: SQLite scalar, PGlite lateral.
3. **Volatile raw filter fragment (p2-volatile), 60 runs each.** SQLite: 11 resolved, 32 edge-endpoint, 17 unreachable-node. PGlite: 52 resolved, 8 'Invalid provider recursive depth'.
4. **Falsification (falsify)** on three dist copies in TMPDIR (original, P2 removed, consumed check removed), through the public client with crafted carriers. The results are those given in the carrier-boundary finding. The copies were deleted afterwards.
5. **SQL shape (sql-shape).** The MySQL statement matches the ledger; PostgreSQL is lateral, SQLite scalar.
6. **EXPLAIN.** SQLite shows two `MATERIALIZE __q1_recursive` per carrier. PGlite shows one CTE with two CTE Scans.
7. **Nested `_distance` spelling (p1-nested, p1-nested-sql, p1-nested-cache, asking-slot).**
   - The payload is admitted with 1 statement.
   - The node document keys are id and `_distance`.
   - The decoded value mixes array and number across levels.
   - The rendered helper fails with TS2300/TS2717.
   - A `$withCache()` second read executes again.
   - The asking key itself inside the node is refused with V4001.
8. **Types.** The TS 5.9 compiler API over dist .d.mts types the refused pair's `_distance` as a merged Number/Array bag, and the nested pair the same way; each producer alone types as `number` / node array.
9. **Vitest, once.** carrier-boundary 13 + distance-key-collision 3 = 16/16, 503.4 MiB peak.
10. **Container mapping (env-map + docker inspect).** Read-only; no port or URL printed. Results are in the environment-record finding.
11. **Inventory.** `closure-final-inventory.mjs json`: unresolvedSpreads is empty; distance-key-collision is collected by raptor3 and coverage-raptor3 and is not unregistered.

Not run: a native scratch probe (native lanes are harness-only; gate-2 native 7/7 per provider on this digest is the receipt), a typecheck (gate-2 reports 0 diagnostics on this digest), and any wide suite. Also noted: the cost-measure log shows the scratch test ran as `|extended-local|` inside the repository, not through a throwaway config as the ledger says; the numbers are unaffected.

### Confirmed

**Gate-2** ran 09:10:28–09:13:48Z on src digest 04903b9b…, which equals the current tree. Every stage exited 0:
- typecheck: 0 diagnostics (native TS7, 7.76 s);
- fixed lane: 1,032/1,032 across 97 files (1,028 plus 1 P2 cell plus 3 one-producer cells);
- recursive-query deterministic: 76/76 (carrier 13, distance 3, sqlite 15, composition 12, cache-codec 10, cache-lifecycle 7, campaign-sqlite 7, oracle 9);
- migrated pins 13/13; admission and introspection 61/61; PGlite 14/14; parity 172+140+215 = 527; conformance 172; g2 216 twice; g1 36; modes 3 and 6; live PGlite pins 7/7;
- native PostgreSQL and native MySQL (provider-sql-native 3 + campaign-native 4): 7/7 each, 300/300 campaign cases each. The receipts were rewritten with head 4ead1c591 and src 8e78568f…; the diff is 4 lines, so per-case outcomes are unchanged;
- census: 36 distinct candidate sentences, unchanged, at 47 sites. The one added site is the hop check reusing the existing 'Invalid provider recursive depth';
- census self-test 7/7; campaign-receipts self-test 41/41; coverage policy, build, source-size, recount and docs-validate exit 0.

**Native release stages:**
- provider-pg: 7 files, 490 passed, 7 skipped (all in pg.test.ts);
- provider-mysql2: 15 files, 793 passed, 1 skipped (mysql2.test.ts).

Each log holds exactly one file with 'Test Files 1 passed'. The inventory matches the RQ-00 lists (7 and 15). The stages ran 08:56–09:10Z, after the production edits at 08:49:44Z and 08:50:09Z; dirty=7 at start.

**P1, root level.** The pair is refused in every order and form the engine prepares (scalar, relation, variant slot, and the included spelling below admission), with the unchanged sentence. The engine was red at HEAD for the distance-first and included spellings. The cached path refuses before the lookup.

**P2.** The witness carrier decodes with an invented occurrence when the check is removed and is refused with it. The invariant is exact: for every reached (parent, level) below the cutoff, the transported children equal the parent's one answer, and no legitimate statement violates it (481 constructed cases).

**Registration.** RQ07_FOLLOWUP_COUNTS has distance-key-collision at 3 and RQ06_CARRIER_BOUNDARY_COUNTS is 13. The credential-free manifest lists the new file in the fixed lane and in the extended-local exclusions.

**Tests.** No test was deleted, weakened, skipped or re-expressed: the round only adds 27 lines and one file.

**Cost cells.** The §6 cells match the plan: depths 1/2/8/32/100/1000, the exhaustive 1,100 chain, widths 1/2/8/32 at depth 2, ladders and cycles. The JSON equals the table. The script matches the description (1 warm-up, 7 timed runs, medians, one heap-delta execute, 1 statement asserted per sample). Peak RSS is one whole-file sample (573.9 MiB). No improvement is claimed.

## Repair round (Opus author)

Applied:
- major: P1 was not closed. A recursive slot named `_distance` whose repeated node selects a point's distance gave that node's `_distance` key two producers. Admission and preparation accepted it, the decoder published the slot before the cutoff and the distance at it, and the renderer declared the key twice. → `src/query-engine/raptor3/shared/query.ts; src/query-engine/result/result-shape.ts; tests/raptor3/recursive-query/distance-key-collision.test.ts` — In `Queries.relationShape`'s recurrence arm: `if (nested.projection.shape.fields[nested.edge.name]) throw new QueryEngineError(DISTANCE_NAME_COLLISION)`. Admission refuses the asking key inside the node, so only a distance can put that name there. In result-shape.ts `addSelectedRelations`, the mirror `if (recurrence && relationName === "_distance" && shape.distanceScalar) throw new QueryEngineError(DISTANCE_NAME_COLLISION)`. The registered sentence is unchanged; result-shape.ts now holds it once as a module constant used by its two sites (one fact, one owner). The witness adds the nested spelling to the engine entry, the shipped client (plain and `$withCache()`, 0 statements) and `renderOperationResultType`. Before: 2 of 4 cells red with 'Missing expected exception'; the built dist (src 04903b9b…, the pre-repair tree) accepted the payload, 1 statement plain, then 1 more statement plus 1 cache read and 1 cache write through `$withCache()`. After: 4/4. Each guard was falsified alone in a backup copy restored by cp: without the engine guard only cell 1 goes red, without the mirror only the renderer cell.
- minor: the witness's cache assertion proved nothing, because `client.place.findMany` never reaches the cache. → `tests/raptor3/recursive-query/distance-key-collision.test.ts` — The cache half now also reads through `client.$withCache().place.findMany(args)` for distanceFirst, relationFirst and nested, beside the plain read. It asserts `memory.reads === 0` and `memory.writes === 0` beside `driver.statements === 0`. The dist probe confirms the old assertion was vacuous: the accepted plain read made 0 cache reads and 0 writes, and `$withCache()` made 1 of each.
- minor: the schema-only hunk (guard after every producer in buildModelShape) had no red witness. → `tests/raptor3/recursive-query/distance-key-collision.test.ts` — Option (a). The hunk stays. A new cell, 'refuses the included spelling in the schema-only shape below admission', calls `buildExpectedResultShape(place, "findMany", included, index)` with `index` from `new EngineSchema(schema)` and expects the collision sentence. It is red on HEAD's result-shape.ts bytes (placed with cp, restored with cp) and green on this tree. The file goes from 3 to 4 cells. The ledger row notes that the P1 paragraph's 'renderer could declare the key twice for an included relation' describes the schema-only shape below admission, which renderOperationResultType never reaches (V4001).
- minor: P2 had taken over the only witness of the bounded consumed-facts guard. → `tests/raptor3/recursive-query/carrier-boundary.test.ts` — Added to the cell 'rejects bounded edge facts attributed to the wrong traversal level': `graphDecoder({ depth: 3, cycles: "prevent" })` on `carrier(["root"], [node("P"), node("C")], [edge("root","P",1), edge("P","C",2), edge("P","C",3)])`, expecting /Invalid provider recursive depth/. With the consumed guard deleted in a backup copy (restored by cp), that cell goes red at the new assertion (12/13). The file stays at 13 cells.
- minor: the invariant P2 relies on was stated only at the decoder. → `src/query-engine/raptor3/shared/query.ts` — One sentence added to `lowerRecursiveRelationProjection`'s doc comment: the recursive member expands every reached row below the bound with the same correlation and filter and prunes nothing (the cycle policy belongs to the decoder), because `decodeRecursiveCarrier` refuses a carrier in which a parent lacks its children at any level it is reached below the cutoff.
- minor: the per-level check wrote its own copy of 'below the cutoff'. → `src/query-engine/raptor3/shared/query.ts` — The condition is now `shape.recurrence.depth !== false && carriesRepeatedKey(shape.recurrence.depth, level) && children.size !== (successors.get(parent)?.length ?? 0)`. It is equivalent by definition.
- minor: the distance arm's comment was stale (it cited result-shape.ts:164 and said 'a scalar of that name'). → `src/query-engine/raptor3/shared/query.ts` — The reference now points at `result/result-shape.ts` `buildModelShape` (the guard after every producer), and 'a scalar of that name' became 'a field of that name: scalar, relation or variant slot'.
- minor: RQ-01's two ledgers predate P2 (two refusals, 11→12 cells, stale falsification and 'Left unverified' items, NOT RUN native rows, a garbled cell). → `docs/architecture/raptor3-evidence/recursive-query/rq01-decoder-repair.md; docs/architecture/raptor3-evidence/recursive-query/rq01-sql-placement.md` — Added a dated 2026-09-23 note to each ledger pointing to rq07-review-followups.md P2: the walk's third question, 13 cells, and the wrong-level carrier now answered by the hop check at the root's hop. The decoder ledger's note also reads round A's falsification and the first 'Left unverified' item against P2. The native rows in rq01-sql-placement.md are marked as superseded by rq07-native-lanes.md, and the garbled cell is restored as '8 passed, 3 failed (11)'.
- minor: the verdict's wording no longer matched what was reviewed. → `docs/architecture/raptor3-evidence/recursive-query/rq07-release-verdict.md` — Line 3 now says RQ-01's whole-unit review and the follow-up round's review are the ones still owed, and 'are closed on this tree' became 'are repaired on this tree, pending that review'. On line 41, 'is owed until the native receipts exist' became 'and the follow-up round's review are `rq07-final-review.md`'. Risk 4 gained a closing sentence: the follow-up round's hoisted guard in `prepareProjection` runs on every comparator cell's preparation (one comparison per projected relation field) and was not re-attested.
- minor: the environment record for the RQ-00 native stages did not match what the logs show. → `docs/architecture/raptor3-evidence/recursive-query/rq07-review-followups.md` — P3 item 1 now records the following. The stage logs carry neither container names nor versions. A read-only `docker inspect` by port (read silently) maps /pg to viborm-triage-pg-20260918 (postgis/postgis:16-3.4, restart policy no) and /mysql to viborm-triage-mysql-20260918 (mysql:8, restart policy no, up since 06:55:57Z). The versions come from the image tag (PostGIS 16/3.4) and from the native round's observation (MySQL 8.4.11), not from the stage logs. The PostGIS container stopped with the engine at 06:55:13Z. The integrating session itself started it at 08:47:16Z with `docker start` (per the session transcript; docker StartedAt agrees), nine minutes before the stage. No authorization was asked: the only explicit Docker authorization was Arnaud's 'go ahead restart' at 06:52:25Z, for the engine, and the forwarded review at 08:43:05Z asked for the native projects. The start is recorded as a deviation from the handoff's rule against launching a service.
- minor: the contract's §3.2(6) database evaluation work was unrecorded, specifically that SQLite evaluates the recursion once per reader. → `docs/architecture/raptor3-evidence/recursive-query/rq07-cost-measures.md; src/query-engine/raptor3/AGENTS.md` — The 'Not measured here' bullet and AGENTS.md's SQLite clause now record that SQLite evaluates the carrier's recursive CTE once per reader (twice per carrier) while PostgreSQL materializes it once per outer row. No number is claimed. Verified by EXPLAIN of the engine's own statement from dist (the SQL is unchanged by this round): better-sqlite3 (SQLite 3.51.2) shows two `MATERIALIZE __q1_recursive` blocks, one under each reader; PGlite (PostgreSQL 17.4) shows one `CTE __q1_recursive` in the lateral subplan read by two `CTE Scan`s.
- Round record requested by the brief. → `docs/architecture/raptor3-evidence/recursive-query/rq07-review-followups.md; docs/architecture/raptor3-evidence/recursive-query/final-repair/` — Appended a 'Final repair round' section (finding → change → file → run, a runs table, what was not run and why, registrations owed, what is unverified). Receipts are copied byte for byte into docs/architecture/raptor3-evidence/recursive-query/final-repair/: logs 00–13, the probe scripts as .mjs.txt, and exit-codes.txt. REGISTRATION OWED to the manifest owner (scripts/raptor3-manifest.mjs was not edited): RQ07_FOLLOWUP_COUNTS for tests/raptor3/recursive-query/distance-key-collision.test.ts should go from 3 to 4. No script reads that value today. RQ06_CARRIER_BOUNDARY_COUNTS is unchanged at 13.

Declined: none

Runs: Pinned Node 24.21.0, TMPDIR=/private/tmp/viborm-rq-final-repair-tmp, one vitest at a time. Logs are in docs/architecture/raptor3-evidence/recursive-query/final-repair/.
(00) dist probe on the pre-repair build: the nested spelling was ACCEPTED. Plain read: 1 statement, 0 reads, 0 writes. `$withCache()`: 2 statements, 1 read, 1 write (cumulative).
(01) Before the production edits, distance-key-collision + carrier-boundary: exit 1, 2 failed, 15 passed of 17. Both failures are 'Missing expected exception' on the nested payload, in the engine-entry cell and the renderer cell.
(02) Falsification, new below-admission cell on HEAD's result-shape.ts bytes: exit 1, 1 failed.
(03) Falsification, consumed-facts guard deleted: carrier-boundary exit 1, 1 failed, 12 passed (red at the new assertion).
(04) After the repairs, both files: exit 0, 17/17 (13 + 4).
(05) relationShape guard removed: only cell 1 red.
(06) addSelectedRelations mirror removed: only the renderer cell red.
Every falsification was restored by cp, with the SHA-256 re-verified.
(07) gate-2's rq-deterministic command (8 files): 77/77.
(08) rq-migrated-pins: 13/13.
(09) rq-admission-introspection: 61/61, 1,470.8 MiB peak.
(10) and (11) EXPLAIN probes: SQLite shows two MATERIALIZE blocks; PGlite shows one CTE with two CTE Scans.
(13) Read-only docker inspect by port; no connection string printed.
NOT run:
- PGlite stage and the native PostgreSQL/MySQL lanes: no SQL changed. The only lowerRecursiveRelationProjection hunk is a doc comment, the new refusal fires before lowering, and the decoder condition is the same predicate read through carriesRepeatedKey.
- Fixed lane, parity, conformance, census, recount, bundles, build: no wide runs. The census would show one more candidate site of the registered _distance sentence; the fixed-lane total would be 1,033.
Final src-digest (gate measure): 243127df7dfc7e6ce592cbdad63d2ca2e979c1bada4df14a8870ffef23b28237. Before this round it was 04903b9b….

Typecheck: `node scripts/run-typecheck.mjs` ran once, at the end, on the final code and test bytes (2026-09-23T10:03:12Z). Result: exit 0, 0 diagnostics (whole estate, native), 8.32 s wall, 4,953.7 MiB peak against an 8,192 MiB ceiling. The SHA-256 of query.ts (54eff16f…), result-shape.ts (d91b1789…), distance-key-collision.test.ts (588a0ebb…) and carrier-boundary.test.ts (84831b8f…) was identical before and after the run. Log: docs/architecture/raptor3-evidence/recursive-query/final-repair/12-typecheck.log.

## Re-check — verdict **ACCEPT** (3 residual documentation minors, applied by the orchestrator afterwards: the verdict's final-repair-round row and the 4-cell registration, the census sentence in the follow-ups ledger, the "second Left unverified item" wording)

- **minor** `docs/architecture/raptor3-evidence/recursive-query/rq07-release-verdict.md`:98 — The verdict does not record the final repair round's source identity. Its newest gate row is gate-2 on src-digest 04903b9b…, but the tree the verdict calls 'this tree' is now 243127df…: query.ts, result-shape.ts and AGENTS.md changed after gate-2. The row still reports the fixed lane at 1,032 with 'the 3 one-producer cells', while the witness now has 4 cells. The follow-ups ledger says this at lines 206-207; the verdict does not point there. The handoff (handoff-2026-09-23.md:26) also still says '3 cells'.
  - evidence: The current tree's digest by the gate's measure (git ls-files -z src | xargs -0 shasum -a 256 | shasum -a 256) is 243127df7dfc7e6ce592cbdad63d2ca2e979c1bada4df14a8870ffef23b28237. With the repair's backup-before copies of query.ts, result-shape.ts and AGENTS.md substituted, it reproduces gate-2's 04903b9b1c0ce28a…681bfd exactly. scripts/raptor3-manifest.mjs:516 still declares distance-key-collision at 3 cells. This is the owed registration, and grep shows no script reads the value.
  - requested: After the gate-2 row (line 98), add the row: `| **Final repair round** after gate-2 (`rq07-review-followups.md`, "Final repair round"; src-digest `243127df…`) | re-run on the final bytes: recursive-query deterministic **77 / 77**, migrated pins 13 / 13, admission + introspection 61 / 61, typecheck 0 diagnostics, census exit 0 (inherited 76 sites; candidates 36 at 47); not re-run: the fixed lane (1,033 expected), parity, conformance, PGlite, native lanes, build, recount |`. In handoff-2026-09-23.md:26, change '3 cells' to '4 cells'. The integrator's owed registration, RQ07_FOLLOWUP_COUNTS 3 → 4, lands with it.
- **minor** `docs/architecture/raptor3-evidence/recursive-query/rq07-review-followups.md`:198 — The 'Not run' paragraph predicts that 'the census would count one more candidate site of the registered `_distance` sentence'. The census, and this ledger itself (line 135), use 'candidate' for the unmatched bucket. The `_distance` sentence is inherited, so the new relationShape throw lands among the inherited sites and the candidate count does not change.
  - evidence: gate-2/census.log lists the sentence under '## Inherited sentences' (query.ts:3501, :3521). I ran the read-only census on the current tree (node scripts/raptor3-refusal-census.mjs, stdout to TMPDIR; exit 0; git status unchanged). Inherited is now 76 sites / 75 sentences (was 75 / 75). Candidates are unchanged at 36 sentences / 47 sites. Total sites are 205 (was 204). The sentence's row now lists query.ts:3503, :3523, :3630.
  - requested: Replace 'The census would count one more candidate site of the registered `_distance` sentence (the `relationShape` throw), and the token recount grows by the two guards; neither was measured.' with 'The census counts the `relationShape` throw as one more inherited site of the registered `_distance` sentence (inherited 75 → 76 sites, total 204 → 205; candidates unchanged at 36 sentences / 47 sites; measured read-only by the final review). The token recount grows by the two guards and was not measured.'
- **minor** `docs/architecture/raptor3-evidence/recursive-query/rq01-decoder-repair.md`:19 — The dated note says 'The first "Left unverified" item is partly superseded'. P2 actually supersedes the second bullet, which is the one round 1 cited at the old line 235. The first bullet is 'PGlite, native PostgreSQL and native MySQL placements'. The follow-ups ledger row (rq07-review-followups.md:163) repeats 'the first'.
  - evidence: The current rq01-decoder-repair.md section '## Left unverified by this unit' (around line 247) has three bullets: (1) PGlite/native placements; (2) 'Whether the provider states *every* edge fact a complete traversal needs…'; (3) everything outside the four defects. In the repair's pre-round backup, line 235 is bullet (2). The note's own description (a carrier that transports a hop's children at one level but not another) matches bullet (2).
  - requested: rq01-decoder-repair.md:19-20: change 'The first "Left unverified" item' to 'The second "Left unverified" item ("Whether the provider states *every* edge fact…")'. rq07-review-followups.md:163: change 'the first "Left unverified" item' to 'the second "Left unverified" item'.

### Probes

All runs used pinned Node 24.21.0 and TMPDIR=/private/tmp/viborm-rq-final-review-tmp. Vitest ran one at a time through scripts/run-vitest-safe.mjs (heap 768, RSS 1536). Nothing in the repository was edited: `git status --porcelain` digests were identical before and after every run, and the four changed code and test files had the same SHA-256 before and after the typecheck.

1. **Identity.** I recomputed the gate measure over tracked src.
   - Current tree: 243127df…, as the ledger states.
   - Substituting the repair's backup-before copies of query.ts, result-shape.ts and AGENTS.md reproduces gate-2's 04903b9b… exactly. So those three are the only src files that moved.
   - Harness identity is fb30927a…, unchanged since gate-2.
   - scripts/raptor3-manifest.mjs is byte-identical to its backup, and dist/ is untouched.
   - The mtime sweep since round 1 shows only 3 src files, 2 tests, 5 ledgers and final-repair/.
2. **Hunk diffs** against backup-before:
   - query.ts: 4 hunks (distance-arm comment, relationShape guard, doc sentence, carriesRepeatedKey).
   - result-shape.ts: module constant, the guard using it, and the addSelectedRelations mirror.
   - tests: the nested spelling, the `$withCache()` half with reads/writes, the new below-admission cell, and one carrier assertion.
   - ledgers and AGENTS.md as requested.
3. **Vitest re-runs:**
   - rq-deterministic 77/77 (641 MiB);
   - admission + introspection 61/61 (1,476 MiB);
   - migrated pins 13/13 (584 MiB).
4. **Out-of-tree probe** (scratch config and test in TMPDIR, aliases to the tree's src):
   - Included nested spelling (top-level include; the recursive `_distance` node selects `at._distance`): refused with the registered sentence by the engine entry, renderOperationResultType, plain findMany and `$withCache()`, with 0 statements, 0 reads, 0 writes.
   - Exhaustive nested (depth false): refused.
   - Recursive `_distance` nested under `parent`: refused.
   - No over-refusal: a distance inside a non-recursive relation of the recursive node is accepted, and a recursive relation named `links` whose node selects a distance is accepted by the engine, the renderer (`_distance: number`, `links?`) and the client (1 statement).
   - Positive cache control: an accepted `$withCache()` read gives 1 statement, 1 read, 1 write, so the witness's zero counters count real reads and writes.
5. **Out-of-tree falsifications** (src copies in TMPDIR, aliases redirected; the copies and symlinks were removed afterwards):
   - relationShape guard removed: the first cell only is red (1 failed / 3 passed).
   - Mirror removed: the renderer cell only is red.
   - HEAD's result-shape.ts bytes: the included-spelling cell is red (and the renderer's nested spelling).
   - Consumed guard removed: carrier-boundary 12/13, red at line 350.
6. **Typecheck** (node scripts/run-typecheck.mjs, once): exit 0, 7.09 s, 5,676.6 MiB.
7. **Refusal census** (read-only, stdout to TMPDIR): exit 0; inherited 76 sites / 75 sentences, candidates 36 / 47, total 205.
8. **Environment record.**
   - Session transcript: user 'go ahead restart' at 06:52:25.670Z; forwarded review at 08:43:05.410Z; the session's own `docker start viborm-triage-pg-20260918` (via perl exec) at 08:47:16.538Z.
   - 13-docker-inspect.log: StartedAt 08:47:16Z, FinishedAt 06:55:13Z.
   - native-projects summary: started 08:56:34Z; the stage logs carry no container names or versions.
9. **Receipts 00–13** read in full; exit-codes.txt agrees with each log.
10. **Biome** (read-only check) on the 4 code and test files: only pre-existing diagnostics (useTopLevelRegex, formatting of lines that already existed); none on this round's hunks.

Not run, deliberately: the fixed lane, parity, conformance, the isolated PGlite stage, native lanes, build and recount. There is no lowering change and no wide runs were allowed.

### Confirmed

**Every one of the 11 requested changes is applied as asked, and the code matches the ledger's hashes:** query.ts 54eff16f…, result-shape.ts d91b1789…, distance-key-collision 588a0ebb…, carrier-boundary 84831b8f….

- **Major (P1 nested).**
  - `Queries.relationShape` throws DISTANCE_NAME_COLLISION when the node's shape holds a field named after the edge. Admission refuses the asking key in the node's select and include (select-include.ts askingKeyRefusal), and schema field names exclude Object.prototype names, so only a distance can reach this guard.
  - `addSelectedRelations` mirrors it (recurrence, `_distance`, distanceScalar) for both the select and include passes.
  - The sentence is byte-identical in query.ts, result-shape.ts and the test.
  - The witness holds the nested spelling at the engine entry, the shipped client (plain and `$withCache()`) and the renderer: 4/4 green.
  - Each guard has unique coverage (reproduced out of tree). The shipped client relies on the engine guard alone, because buildExpectedResultShape's only caller is the type renderer.
  - CHANGELOG and selecting.mdx ('one producer') are now true, including the included nested spelling, which is public and refused everywhere with 0 statements and 0 cache I/O.
- **Cache.** The witness now asserts reads 0 and writes 0 through `$withCache()`, beside the statement count. The accepted control shows 1/1/1, so the assertion is not vacuous.
- **Schema-only hunk.** Option (a) was taken. The new below-admission cell is red on HEAD's bytes and green now.
- **Carrier-boundary.** Exact carrier added; still 13 cells; the consumed guard is unique again.
- **Doc sentence** at the SQL owner: added verbatim.
- **carriesRepeatedKey** condition: equivalent.
- **Distance-arm comment:** updated.
- **RQ-01 ledgers:** dated notes added, native rows superseded, the garbled cell restored ('first'/'second' slip noted as a finding).
- **Verdict:** line 3, line 41 and risk 4 are exact.
- **Environment record:** verified against the transcript and docker inspect.
- **SQLite/PostgreSQL evaluation counts:** recorded without a number.

**Runs on the final bytes:** rq-deterministic 77/77, migrated pins 13/13, admission + introspection 61/61, typecheck 0 diagnostics, census exit 0.

**Tests.** No test was deleted, weakened or skipped: the round only adds loops, assertions and one cell.

**Registrations.**
- RQ06_CARRIER_BOUNDARY_COUNTS is 13, correct.
- RQ07_FOLLOWUP_COUNTS still reads 3 against 4 cells. This is correctly reported as owed to the manifest owner, and no script reads it.
- The file is registered in the raptor3 project and the fixed lane, so the fixed lane would total 1,033.

## Disposition

RQ-01 is accepted as one unit by this review. The follow-up round's major
(the nested `_distance` spelling) is repaired at `Queries.relationShape` with
the registered sentence, mirrored in the schema-only shape, and witnessed at
the engine entry, the shipped client (plain and `$withCache()`, zero
statements, zero cache reads and writes) and the renderer (4 cells). The three
residual minors were applied verbatim by the orchestrator, and the frozen gate
re-ran on the final bytes into `gate-3/` (recorded in the verdict).
