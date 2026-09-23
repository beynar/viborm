# RQ-03 / RQ-04 — chains, hierarchies, junction graphs and the private-pin migration

Unit `rq34`, 2026-09-22/23. Scope: `features-docs/recursive-query.md` RQ-03 and
RQ-04 in full, plus the handoff's "Old private executable pins to migrate".
This is an author record, not an acceptance verdict: the independent review,
the native PostgreSQL/MySQL lanes (the integrator's) and RQ-05/06/07 are owed
by their own owners.

## Identity of what was executed

| Fact | Recorded value |
| --- | --- |
| Repository / branch / HEAD | `/Users/arnaud/code/viborm`, `pattern-engine`, `076fad02b1c77435ce7389a51996163c66aad819` (uncommitted tree preserved; nothing staged or committed) |
| Runtime / harness | Node `24.21.0` (`/Users/arnaud/.vite-plus/js_runtime/node/24.21.0/bin`), Vitest `3.1.4`, `scripts/run-vitest-safe.mjs --heap-limit-mb=768 --rss-limit-mb=1536 --wall-limit-ms=120000`, `scripts/run-credential-free-tests.mjs --only provider-sql-pglite`, `scripts/run-typecheck.mjs` |
| Starting `query.ts` | SHA-256 `7ba81f05fd890eb8aab20a181f2c8da132a8136182cc5b3dd14daf857581c1cb` — the bytes the RQ-01 decoder note records |
| Final owned bytes (SHA-256) | `query.ts` `140edb00…d7d9cf21`; `schema.ts` `ffd0c223…dc5764f` (unchanged); `provider-sql-fixture.ts` `91a37b0c…ad45ef372`; `provider-sql-sqlite.test.ts` `c51bbc24…acf53980`; `provider-sql-pglite.test.ts` `c35d8d37…5541a4cc`; `provider-sql-native.test.ts` `dc5cb586…4ceee5a`; `carrier-boundary.test.ts` `5b680217…b6f78605` (unchanged); `prep/recursive-read-fit.test.ts` `10ec40bd…1af14`; `g4/read-recursive-fit.test.ts` `f499f014…2e620a`; `g4/unit02/recursive-codec-fit.test.ts` `9973ac86…4a457`; `g4/review/unit02-phase2/recursive-carrier.review.test.ts` `b4ee457e…f50f`; `g4/unit01/recursive-vocabulary.test.ts` `18679dc1…36ebc`; `g4/native/read-envelope-native.test.ts` `f80c9156…fad530` |
| Concurrent files (NOT mine; other units were editing them during these runs) | read just after the final typecheck: `recurrence.ts` `31cfe13c…90d90af3`, `select-include.ts` `b69d5a20…6b3e6e63`, `relations/index.ts` `621103b0…b4a396be`, `static-membership.ts` `c3939a8d…235e2122`, `result-types.ts` `a308ff18…8b62c822`, `client/types.ts` `70d52f5f…8a492f0e`, `client-route.ts` `49deb8d1…8933731f`, `cache-value-codecs.ts` `324d612c…476c3484`. `result-types.ts` and `client/types.ts` changed between the first and the final runs; the others did not |

The final runs below were taken between two identical `shasum -a 256 -c`
readings of the thirteen owned files.

## Result in one paragraph

Every RQ-03 and RQ-04 falsifier the brief names is now a registered cell on
SQLite and PGlite and part of a native world. The production projection
already answered all of them but one: **sibling ties broke on a second,
recursion-only complete key** (the row key in constraint order) instead of the
order owner's one tie-break, so the same tied children came back in a
different order under `recurse` than under the ordinary window. That was
repaired by moving the tie-break into one owner (`Queries.completeOrder`) and
**deleting** the recursion's copy (`Queries.recursiveOrder`): −10
code-bearing lines. All six private pin files are re-expressed through the
ordinary entries with every intentional contract change named at its cell;
no cell was retired or deleted, and no cell count changed.

## The one production change — the complete-key tie-break

**Red witness (before).** New cell *RQ-03/RQ-04 sibling ties break on the
order owner's one complete key* on a compound key declared in the other
order from its scalars (`.id(["code", "tenant"])`, scalars `tenant, code`),
three children tied on `rank`. The ordinary windowed control
(`children: { orderBy: { rank }, take: 10 }`) answered `a/y, b/x, c/w`; the
recursive collection answered the reverse:

```
× … RQ-03/RQ-04 sibling ties break on the order owner's one complete key
  → recursive FK collection: the same ties in the same order
  + { code: 'w', tenant: 'c' } … { code: 'y', tenant: 'a' }
  - { code: 'y', tenant: 'a' } … { code: 'w', tenant: 'c' }
```

(`/private/tmp/viborm-rq34-tmp/red-tiebreak-sqlite.log`; the same cell red on
PGlite, `red-tiebreak-pglite.log`: 1 failed | 13 passed.)

**The fact and its owner.** *How one model's tied rows break a tie* — owned by
`Queries.totalOrder`'s identity completion (`identityOrder`: bare id, else
the row key in scalar declaration order). §2.3 requires recursion to reuse
"the ordinary SQL order owner … and complete-key tie-breaking";
`recursiveOrder` spelled its own loop over `schema.keys(model)` (constraint
order) instead.

**The hunk (`src/query-engine/raptor3/shared/query.ts`).** `totalOrder` keeps
only what is its alone — the windowed null-placement default — and hands the
identity completion to `completeOrder(model, terms, alias, cursorFields)`.
The recursive edge page orders by
`lowerOrder(completeOrder(model, orderTerms(model, orderBy, edgeChild), edgeChild))`.
Unspelled `nulls` still stay the provider's default under recursion (it is not
a window), exactly as before.

**Deleted.** `Queries.recursiveOrder` (its own tie-break loop and its
constraint-order key reading). No replacement concept: the loop that remained
in `totalOrder` became `completeOrder`, one owner with two consumers.
`query.ts` 5,370 → 5,368 physical lines, 4,373 → 4,363 code-bearing lines.

**Second placement.** The junction graph (`links` over the same compound
model) orders its ties through the same owner: falsified independently by
moving that case first and restoring the pre-repair `query.ts` from the backup
copy — red with the same reversed order (`red-tiebreak-junction.log`), then
both files restored by `cp` (SHA `140edb00…` re-verified). The window's own
consumers stayed green: `read-pagination`, `order-cursor`, `nested-window`,
`nested-reversal`, `order-oracle`, `order-projection`, `cursor-refusal`,
`read-operations`, `read-filters` — 61/61.

**After.** Green on SQLite (15/15) and PGlite (14/14, both stages).

## RQ-03 / RQ-04 falsifier groups

Where: `tests/raptor3/recursive-query/provider-sql-fixture.ts` owns two
provider-neutral worlds (`HIERARCHY_WORLD`, `GRAPH_WORLD`: tables, rows,
cases grouped by falsifier) and one runner, `runCase`: the public value (or
the exact `QueryEngineError` sentence), exactly ONE provider statement
carrying the recursive CTE (an ordinary control carries none), and — where a
case states it — what the root carrier transported (`__rq_nodes`,
`__rq_edges`). Every expectation is written by hand from the stored rows.
Each group is one registered cell on SQLite and on PGlite: **13 group cells,
61 cases** (38 RQ-03, 23 RQ-04). They are not 61 registered tests.

Witness method for groups that needed no production change: one mutation of
the owning production rule at a time, run against the whole SQLite file,
restored from the backup copy by `cp` with the SHA re-verified after each
(`/private/tmp/viborm-rq34-tmp/falsify.sh`, logs `falsify-m*.log`):

| Mutation (production rule broken) | Cells it reddened |
| --- | --- |
| M1 publish the repeated key at the numeric cutoff | 12 of 15: every cell with a numeric cutoff; green, as they must be: the exhaustive chain, the omitted-keys group (exhaustive and natural ends only) and the ladder |
| M2 prune an FK cycle instead of rejecting it | the FK cycle window cell only (of the then-14) |
| M3 recursive member bound `<=` depth (one extra hop) | 9 of the then-14: every bounded cell — the carrier boundary refuses the extra hop (`Invalid provider recursive depth`) |
| M4 collection filter on the anchor only, not the recursive member | the filtered-bridge cell only (of the then-14) |
| M5 graph prevention only against the outer row | the self-loop / cycle cell only (of the then-14) |
| M6 decoded occurrence shared per node inside one carrier (shallow copy) | the diamond cell only (of the then-14; fresh `payload` object) |
| M7 node identity = the alternate reference tuple (applied to that one table) | the alternate-reference cell — run filtered to that cell |
| M8 siblings deduplicated by their public row | the omitted-compound-keys cell only (of 15) |
| M9 decoded occurrences cached on the engine-lifetime `Queries` across carriers | unfiltered, with the old check: 4 of the then-15 (FK cycle window, include/second slot, diamond, self-loops) — **not retained**: `falsify.sh` writes `falsify-$1.log`, and `falsify-m9-cross-root-cache.log` now holds only the filtered rerun (1 failed, 14 skipped); after the check below was strengthened, the independent-roots cell too (run filtered to that cell); the FK-directions cell in the repair round (filtered, below) |
| M10 exhaustive traversal silently cut off at 1,000 | the exhaustive-chain cell only (of 15) |
| M11 a global visited set instead of the active path | 6 of 15: matrix junction case, diamond, simple paths, filter control, independent roots, ladder |

M9 found one weak check: the independent-roots cell compared a nested
occurrence with the OUTER row, which is never decoded from a carrier, so a
cross-root cache of descendants passed. The check now also compares `d3`
under `d0 → d1` with `d3` under the root `d1`; M9 reddens it
(`falsify-m9-cross-root-cache.log`), the unmutated file is green.

| Group (cell) | Cases | Fact | Owner | Witness | Second placement | Result |
| --- | ---: | --- | --- | --- | --- | --- |
| RQ-03 FK directions and inverse one-to-one end naturally before the cutoff | 8 | upward/downward FK and inverse one-to-one; `[]`/`null` at a natural end before the cutoff; the outer key present at a natural end; depth-1 omission on a singular | lowering `correlation` (membership) + decoder `collapse`/`cutoff` | M1 | matrix "owning foreign-key direction", "inverse one-to-one direction" (existing, extended not duplicated) | green SQLite, PGlite |
| RQ-03 depth 1, 2, 100 (the default) and 1000 cut off without an extra hop | 7 | `true` and `{}` are depth 100; depth 1/2/1000 both directions; key omitted at the cutoff; carrier transports exactly `depth` nodes and edges | recursive member bound + decoder cutoff | M1, M3 | upward depth-1000 chain; natural end at depth 1000 | green |
| RQ-03 an exhaustive acyclic chain beyond the public depth ceiling | 2 | 1,100-level chain, both directions, `[]` / `null` at the end; 1,100 nodes/edges transported | exhaustive UNION DISTINCT closure + iterative decoder | M10 | upward direction | green SQLite, PGlite; MySQL expects the provider's own limit failure (below) |
| RQ-03 an FK cycle closing inside the traversed window fails; outside it, it does not | 13 | ring closing at hop 3: depth 2 answers, depth 3/exhaustive fail; lasso (cycle off the outer row); self-parent/self-child fail at hop 1; three roots on one ring stay independent objects | decoder `follow` (active path, `reject`) | M2, M9, M1 | both directions; lasso upward vs downward | green |
| RQ-03 an alternate nullable reference is not the row's primary identity | 2 | two rows with a NULL alternate reference are two leaves and nobody's parent; upward through the alternate reference | identity = `schema.keys` (primary), correlation = reference pairs | M7 | upward case | green |
| RQ-03/RQ-04 sibling ties break on the order owner's one complete key | 3 | see "The one production change" | `Queries.completeOrder` | red before | junction graph | green after |
| RQ-03 omitted compound keys stay the private identity in both directions | 2 | three siblings with identical public rows stay three occurrences; upward through a compound reference with the key omitted | carrier identity tuples (not the projected row) | M8 | upward case | green |
| RQ-03 include placement, counts and a second recursive slot in the repeated node | 1 | `include` placement: default scalars, `_count` and the REVERSE slot recursing inside the repeated node, at every level | ordinary node projection repeated per level | M1, M9 | matrix "recursive node to ordinary relation and second recursive slot" | green |
| RQ-04 both paired directions, a diamond, converging paths and disconnected rows | 5 | diamond: shared descendant once per path with fresh objects and fresh JSON leaves (mutation of one does not reach the other); the paired inverse walks the junction backwards; one row is a natural end at depth 1 and cut off at depth 2; a disconnected row has `[]` both ways | junction orientation + decoder occurrences | M6, M9, M11, M1 | inverse direction | green |
| RQ-04 self-loops, a cycle to the outer row, pruning versus bounded unfolding, simple paths | 9 | default prevention prunes self-loops and the edge back to the outer row; `preventCycles: false` unfolds to the cutoff (depth 3, 5 and the default 100); exhaustive always prevents; exhaustive simple paths through every ordered pair; bounded unfolding through every ordered pair | decoder `follow` (`prevent`/`allow`) | M5, M11, M1 | default depth 100 unfolding | green |
| RQ-04 the collection filter prunes every hop, a bridge included | 3 | a closed bridge hides what only it reaches; the filter applies to direct children; unfiltered control; the filter is in SQL (transport excludes the pruned rows) | `lowerSelector` at the anchor AND the recursive member | M4, M1 | inner closed hop (`b4`) | green |
| RQ-04 independent roots and graph recursion under an ordinary relation | 2 | two roots, one inside the other's graph, unfold their own occurrences (nested and descendant objects distinct); graph recursion under an ordinary to-one | per-root correlated carrier; ordinary projection composition | M9, M11, M1 | ordinary→graph | green |
| RQ-04 transport grows with distinct edge facts while output grows with paths | 4 | ladder of 1/2/4/8 diamonds: carrier `3k` nodes and `4k` edges, output `4(2^k−1)` occurrences | compact carrier + decoder unfolding | M11 | 3-cycle / K3 measurements below | green |

Carrier boundary (`carrier-boundary.test.ts`): **no cell added**. Each RQ-03
/ RQ-04 fact whose owner is the carrier boundary already has its cell there
(extra-hop refusal at `depth > n`; cutoff omission under `allow`; diamond
freshness; empty singular `null`; 1,101- and 12,000-level chains); the new
facts above are placement facts that need real SQL, so they live in the
provider fixture. The file is byte-identical to the RQ-01 repair round.

## RQ-03 exit

- **Read and mutation readback use the same projection**: the matrix's
  `update` (post-write) and `delete` (pre-delete) cases decode through the
  same `prepareProjection`/`lowerRecursiveRelationProjection`/`decodeValue`
  path as every read above (unchanged, still green on both providers).
- **No SQL path payload**: `grep arrays.push|arrays.literal|unionAll|__rq_path`
  on `query.ts` is empty.
- **No copied scalar decoder**: the carrier decoder validates identity members
  and decodes rows only through `decodeScalar`/`decodeValue`.
- **No repeated admission**: `query.ts` reads `recurse` once
  (`recurrence: nested.recurse`), the admitted `NormalizedRecurrence`.
- **No new command interpreter**: nothing under `commands/` changed.
- **Deleted by this unit**: `Queries.recursiveOrder` (above). Deleted earlier
  in this same uncommitted tree by the previous query author, and **not
  claimed here**: `Queries.recursive`, `decodeRecursive`, `TraversalArgs` /
  `RecursiveTraversal`, the silent asking-key strip `withoutRelation`, the
  "A recursive shape requires occurrence rows" refusal, the carried stored
  scalars (`storedFields`). The adapter members `arrays.literal`,
  `arrays.push` and `setOperations.unionAll` now have no engine caller (their
  only one was `Queries.recursive`); deleting them belongs to the adapter
  owner.

## The private pins — migrated, none retired

Every file now enters a normal entry (`createCommandEngine(...).execute`, or
the public client), and every intentional change is named in a comment at the
cell that meets it. No cell count changed.

| Old cell | New placement | Named contract change |
| --- | --- | --- |
| `prep/recursive-read-fit` › mapped compound keys hidden … overlapping occurrences | engine `findMany` roots `root`+`alpha`, `include` notes + `children: { recurse: { depth: 2 }, where, orderBy, include }` | root cardinality (repeated seed not expressible; overlap re-expressed by `alpha` as root AND nested, distinct objects); cutoff omits `children` at level 2 |
| › singular slot name … prunes the upward descent | `parent: { recurse: { depth: 2 \| 3 } }` with notes; the per-level singular `where` is refused before any statement | cutoff omits `parent` at depth 2 (`null` at depth 3); singular nodes admit select/include/omit only |
| › depth zero and empty branches | depth 0 refused (both directions, zero statements); depth 32 empty branches `[]` / `null` | depth 0 invalid |
| › multiple roots from one seed … sibling order | `findMany` `orderBy: { label }`, depth 1 and 2 | operation owns root order; depth 0 → 1; cutoff omission |
| › complete-key revisit … no global dedup | cycle `one ⇄ two` fails at depth 32 and 2 (both directions, one statement each); depth 1 answers with independent objects | FK cycle in window errors instead of pruning |
| › one SQL shape while output widens at 1/2/8/32 | same four depths; SQL length and bind count identical, one provider row, carrier bytes strictly increasing; objects `1+2d`, arrays `2d−1` | cutoff omission (arrays were `1+2d`); one outer row instead of one row per occurrence |
| `g4/read-recursive-fit` (3) | public client `findMany` | third cell: operation owns roots/order, depth 0 → 1 |
| `g4/unit02/recursive-codec-fit` (3) | the same property through `createCommandEngine` — the second entry, not a duplicate | as above |
| `g4/review/unit02-phase2/recursive-carrier.review` (4, unregistered) | engine `findMany`; ring fails at depth 3 and 8, depth 2 reaches root→mid→leaf; two roots; escaped identity; bigint | FK cycle errors; operation owns roots |
| `g4/unit01/recursive-vocabulary` (1) | engine `findMany` `include: { children: { recurse: { depth: 8 } } }`; last row `children: []` | none beyond the entry |
| `g4/native/read-envelope-native` › `g4-native-recursive-read-fit` only | candidate engine `findMany` with `recurse` on `children`, `expectedExecutions: 1`, still one statement | operation owns the root; the other four cells untouched |

Archived receipts under `docs/architecture/raptor3-evidence/` were not
touched.

## Runs (final, frozen owned bytes)

| Command | Result |
| --- | --- |
| raptor3: `provider-sql-sqlite`, `carrier-boundary`, `prep/recursive-read-fit`, `g4/read-recursive-fit`, `g4/unit02/recursive-codec-fit`, `g4/unit01/recursive-vocabulary` (final bytes) | **40/40** (15 + 12 + 6 + 3 + 3 + 1), 628.6 MiB peak |
| raptor3: nine window/order pins (listed above; `query.ts` `140edb00…`, unchanged since) | **61/61**, 666.5 MiB peak |
| unregistered review file, through a throwaway workspace in `$TMPDIR` (no repo file; it imports no fixture) | **4/4** |
| `run-credential-free-tests.mjs --only provider-sql-pglite` (final bytes) | **14/14** in `raptor3-provider` (1,479.6 MiB) and **14/14** in `extended-local` (1,459.8 MiB), 2,560 MiB isolated ceiling |
| Red witnesses | SQLite tie-break (1 failed), junction second placement (1 failed), PGlite tie-break (1 failed \| 13 passed) — all on restored pre-repair bytes |
| Falsifications M1–M11 | as tabled; every restore SHA-verified at `140edb00…` |

`tests/raptor3/g4/parity/`: no file there uses a window (`take`/`cursor`) or a
recursive projection, so none reaches the two owners this unit changed; the
window's own pins were run instead (61/61).

## Typecheck (once, at the end)

`node scripts/run-typecheck.mjs` on the final bytes: **13 diagnostics, 0 in
any file this unit owns.** All thirteen sit in the concurrently edited type
unit's files or in type pins downstream of them:
`src/validation/relations/select-include.ts` (TS2322),
`tests/types/client/recursive-query.core.types.ts` (2 × TS2322, TS2353,
6 × TS2578), `tests/types/client/polymorphic-result.core.types.ts`
(2 × TS2578), `tests/contracts/public-client/relation-types.test.ts`
(TS2344). 12.84 s, 5,798.9 MiB peak (8,192 MiB ceiling). The thirteen owned
files' SHA-256 were identical immediately before and after the run.

It ran TWICE, not once: the first run (8 diagnostics, the same files, none
mine) predated the last fixture edit — the strengthened independent-roots
check M9 exposed — so it did not attest the final bytes and is withdrawn.
Neither is a zero-diagnostic receipt for the estate; that one belongs to the
integrator on frozen integrated source.

## Registrations owed (the integrator edits the manifest)

| File | Declared | Now |
| --- | ---: | ---: |
| `tests/raptor3/recursive-query/provider-sql-sqlite.test.ts` (`RQ01_SQLITE_COUNTS`) | 2 | **15** |
| `tests/raptor3/recursive-query/provider-sql-pglite.test.ts` (`RQ01_PGLITE_COUNTS`) | 1 | **14** |
| `tests/raptor3/recursive-query/provider-sql-native.test.ts` (`RQ01_NATIVE_COUNTS`, per PG/MySQL profile) | 1 | **3** |
| `carrier-boundary`, `prep/recursive-read-fit`, `g4/read-recursive-fit`, `g4/unit02/recursive-codec-fit`, `g4/unit01/recursive-vocabulary`, `g4/native/read-envelope-native` | 12, 6, 3, 3, 1, 5 | unchanged |
| `g4/review/unit02-phase2/recursive-carrier.review.test.ts` | unregistered | 4, still unregistered (review tree convention) |

Registration gap observed, not mine to fix: `EXTENDED_LOCAL_TESTS` also adopts
`carrier-boundary`, `graph-oracle`, `provider-sql-pglite`,
`provider-sql-sqlite` (and the cache unit's two new files) because
`extendedLocalExclusions` does not name them, so `--only provider-sql-pglite`
runs the PGlite file twice (both stages above).

## Transport versus required output — measured

SQLite, one sample, the transported bytes are the carrier column's JSON text
length; the output bytes are `JSON.stringify` of the public value (a size
proxy, not memory). Script: `/private/tmp/viborm-rq34-tmp/measure/transport.measure.test.ts`
(run through a throwaway workspace; data `transport.json`).

| Case | SQL chars | binds | provider rows | carrier bytes | nodes | edges | occurrences | output bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| FK chain depth 1 | 1673 | 13 | 1 | 142 | 1 | 1 | 1 | 16 |
| FK chain depth 2 | 1673 | 13 | 1 | 239 | 2 | 2 | 2 | 44 |
| FK chain depth 8 | 1673 | 13 | 1 | 821 | 8 | 8 | 8 | 212 |
| FK chain depth 32 | 1673 | 13 | 1 | 3263 | 32 | 32 | 32 | 907 |
| FK chain depth 100 | 1673 | 13 | 1 | 10203 | 100 | 100 | 100 | 2880 |
| FK chain depth 1000 | 1673 | 13 | 1 | 106507 | 1000 | 1000 | 1000 | 29881 |
| FK chain exhaustive (1,100) | 1554 | 9 | 1 | 96816 | 1100 | 1100 | 1100 | 32995 |
| ladder 1 rung, exhaustive | 1755 | 9 | 1 | 368 | 3 | 4 | 4 | 97 |
| ladder 2 rungs | 1755 | 9 | 1 | 686 | 6 | 8 | 12 | 287 |
| ladder 4 rungs | 1755 | 9 | 1 | 1322 | 12 | 16 | 60 | 1427 |
| ladder 8 rungs | 1755 | 9 | 1 | 2594 | 24 | 32 | 1020 | 24227 |
| 3-cycle unfolding depth 3 | 1875 | 13 | 1 | 366 | 3 | 3 | 3 | 62 |
| 3-cycle unfolding depth 30 | 1875 | 13 | 1 | 2007 | 3 | 30 | 30 | 683 |
| 3-cycle unfolding depth 300 | 1875 | 13 | 1 | 18678 | 3 | 300 | 300 | 6893 |
| complete 3-graph unfolding depth 2 | 1875 | 13 | 1 | 544 | 3 | 6 | 6 | 107 |
| complete 3-graph unfolding depth 4 | 1875 | 13 | 1 | 1264 | 3 | 18 | 30 | 563 |
| complete 3-graph unfolding depth 8 | 1875 | 13 | 1 | 2704 | 3 | 42 | 510 | 9683 |
| complete 3-graph unfolding depth 12 | 1875 | 13 | 1 | 4162 | 3 | 66 | 8190 | 155603 |
| complete 3-graph, exhaustive simple paths | 1755 | 9 | 1 | 446 | 3 | 6 | 4 | 95 |

Read: the statement is one shape per mode (bounded 1,673–1,875 chars / 13
binds; exhaustive 1,554–1,755 / 9) and one provider row regardless of depth.
Transport grows with distinct (edge, depth) facts — linear in depth for a
chain or a bounded cycle, `4k` for a `k`-rung ladder, `6(n−1)` for bounded
unfolding of the complete 3-graph — while output grows with paths: 1,020
occurrences from 32 edge facts (ladder 8), 8,190 from 66 (complete 3-graph at
depth 12). For an FK chain transport and output are both linear (a tree has
one path per node). Also probed: a 1,000-level and a 1,100-level chain through
the **public client** decode without a stack failure
(`client-depth.measure.test.ts`, 1/1).

**Not measured**: PGlite/native bytes (the PGlite cells assert the same node
and edge counts, not bytes); CPU, allocation, peak memory per case,
database-side evaluation work; any comparison with the retired private fit.
No runtime, allocation or bundle improvement is claimed.

## Native confirmation owed (integrator's lanes)

`provider-sql-native.test.ts` now runs the matrix plus one live world per RQ
world (`RQ-03 foreign-key chains and hierarchies`, `RQ-04 junction graphs
through the same mechanism`); it typechecks but was **not run**. Needed, and
why:

1. **MySQL depth 1000** (two cases): 1,000 levels is exactly MySQL's default
   `cte_max_recursion_depth`; the expectation (success, 999 productive
   iterations then one empty) is a reading of MySQL's documented limit, not
   an observation.
2. **MySQL exhaustive 1,100-level chains** (two cases, marked
   `exceedsMySQLRecursionLimit`): the test expects the provider's own failure
   (matched on `cte_max_recursion_depth|Recursive query aborted after` along
   the cause chain) and no value — the §2.4 "provider limit, never a truncated
   success" rule. The exact wrapped error shape is unverified. PostgreSQL
   expects success.
3. **The tie-break fix** on both providers (ORDER BY with the identity in the
   bounded derived edge page, MySQL `noLimitValue`).
4. **Seeding shapes**: JSON `payload` (JSONB/JSON), BOOLEAN `open` filters on
   MySQL, the 4 × VARCHAR(191) primary key of the compound junction table
   (3,056 bytes, under InnoDB's 3,072), `rank` quoted as a MySQL reserved word.
5. **`g4-native-recursive-read-fit`** (read-envelope cell 4) through the
   candidate engine, on both providers.

## Unverified

- Every native PostgreSQL/MySQL claim above (not run by this unit).
- `create` / `upsert` recursive readback placements (RQ-06 owns the full
  mutation/transaction/array composition; this unit relied on the matrix's
  `update` and `delete`).
- Biome/ultracite cleanliness of the touched test files: they follow the
  raptor3 test estate's existing style (assertions in helpers, regex
  literals), which Biome's `noMisplacedAssertion` / `useTopLevelRegex` flag
  in untouched files as well; no `--write` was run over the estate.
- The PGlite red witness exists for the tie-break only; the M1–M11
  falsifications ran on SQLite.

## Blockers

None. No repair failed; no representation attempt was spent.

## Cost

| Measure | Before | After |
| --- | ---: | ---: |
| `query.ts` physical / code-bearing lines | 5,370 / 4,373 | 5,368 / 4,363 |
| `schema.ts` | unchanged | unchanged |
| `provider-sql-fixture.ts` physical lines | 423 | 1,983 (two worlds, 61 hand-written cases, the shared runner) |
| three provider test files | 540 | 803 |
| six pin files | 2,344 | 2,158 |

## Repair round — 2026-09-23

The independent review returned three minor findings. Each requested change
was applied as written, and nothing else in code or tests changed. `query.ts`
was mutated only inside the one falsification below and restored by `cp`, and
its SHA-256 is still
`140edb0067c7a611186d2b65a5957dab10edcc9bdf0f5cc1cf6d95f5a7d9cf21`. No
production change, no case added or removed, and no registered cell added,
removed or renamed.

### 1. An FK-placement identity witness for independent roots (`provider-sql-fixture.ts`)

- **The hunk.** The FK-directions cell's case at line 861 is renamed
  "owning one-to-one: exhaustive to the natural end". The ", depth 1 to the
  cutoff" suffix is dropped because the depth-1 read is the next case. The
  case gains a `check`: `step-3` under step-1 → step-2 (`value[0].next.next`)
  and `step-3` under the root step-2 (`value[1].next`) must be
  `assert.deepEqual` and `assert.notStrictEqual`. The cell still holds 8
  cases, and there are still 61 cases in all.
- **Red witness.** M9 (`m9-cross-root-cache.py`, unchanged) was run filtered
  to "RQ-03 FK directions and inverse one-to-one end naturally before the
  cutoff" through `/private/tmp/viborm-rq34-tmp/falsify-repair.sh`. That
  script mutates only while no workspace verification process runs, and it
  restores by `cp` and re-verifies the SHA after every attempt. Result:
  **1 failed | 14 skipped**. The failure is at `provider-sql-fixture.ts:889`,
  the new `assert.notStrictEqual(nested, direct)`, with "Compared values have
  no visual difference". The case's value deep-equal and the check's own
  deep-equal passed. The log is
  `/private/tmp/viborm-rq34-tmp/falsify-m9-fk-independent-roots.log`. It has
  its own name so that `falsify-m9-cross-root-cache.log` keeps the RQ-04
  filtered run cited above. `query.ts` was restored and its SHA re-verified.
- **Observed while witnessing.** M9's cache hangs on the `Queries` that
  decodes. That is the operation context's own instance (`new Queries` at
  `operation-context.ts:417`, one per `OperationContext`), not the
  engine-lifetime instance at `commands/index.ts:153` that the M9 row names.
  The cache therefore spans the carriers of one operation. That is why the
  six single-root reads before this case, in the same cell, pass under M9.
- **After.** `provider-sql-sqlite.test.ts` passed 15/15. `--only
  provider-sql-pglite` passed 14/14 in `raptor3-provider` and 14/14 in
  `extended-local`.

### 2. The dropped `^` anchor named at prep cells 1 and 6 (`prep/recursive-read-fit.test.ts`)

- **The hunk.** A one-line comment now sits above each
  `assert.match(statement.sql, /WITH RECURSIVE\b/)`, at lines 384 and 624
  (the asserts are now at 385 and 625). It reads: "Representation change —
  the recursive CTE is now a scalar subquery inside the ordinary SELECT's
  relation column (recursive-query.md §3.2/§3.6), not the statement's
  prefix." The review offered two options, and the comment was chosen, not
  the direct shape assertion. The expectation itself is unchanged. The code
  fact the comment names: `lowerRecursiveRelationProjection` returns
  `a.subqueries.scalar(WITH RECURSIVE … SELECT carrier)` (`query.ts:4354`),
  and that is the relation field's projected expression (`query.ts:3798`).
- **Witness.** None is owed, because a comment changes no behaviour.
- **After.** The two cells, filtered with `-t`: 2 passed | 4 skipped.

### 3. Two statements in this note that went beyond their evidence

- In the private-pin table, "SQL text and binds identical" now reads "SQL
  length and bind count identical". Cell 6 asserts one `sqlChars` value and
  one `binds` value across the four depths, not the SQL text.
- In the M9 row of the mutation table, the unfiltered result (4 of the
  then-15) is marked **not retained**. `falsify.sh` wrote
  `falsify-$1.log`, and the filtered rerun overwrote that log. The unfiltered
  run was not repeated, because this round's run scope is the affected cells.

### Runs (this round)

| Command | Result |
| --- | --- |
| M9 filtered to the FK-directions cell (the red witness) | 1 failed \| 14 skipped, at the new check (`fixture.ts:889`); `query.ts` restored and SHA re-verified |
| raptor3 `tests/raptor3/recursive-query/provider-sql-sqlite.test.ts` | **15/15**, 496.3 MiB peak |
| raptor3 `tests/raptor3/prep/recursive-read-fit.test.ts`, cells 1 and 6 (`-t`) | **2 passed \| 4 skipped**, 461.5 MiB peak |
| `run-credential-free-tests.mjs --only provider-sql-pglite` | **14/14** `raptor3-provider` (1,456.4 MiB) and **14/14** `extended-local` (1,403.4 MiB), 2,560 MiB ceiling |
| `run-typecheck.mjs` (once) | exit 0, **0 diagnostics**, 7.86 s, 5,329.5 MiB peak (8,192 MiB ceiling) |

The thirteen owned files' SHA-256 were identical immediately before and after
the typecheck. The 13 diagnostics recorded above were all in the concurrent
type unit's files or in the type pins downstream of them, and two of those
files have changed since. Read just after this typecheck, `select-include.ts`
is `ec7f935a1d81e88d1f9407d1b5606efc81da9fa1d7ef564cf20d4160f6a047ab` and
`client/types.ts` is
`d042c8c99464c207d4d7054e82defcfac59483e7307d1d28f2bc49978d62ca83`. The other
six concurrent files (`recurrence.ts`, `relations/index.ts`,
`static-membership.ts`, `result-types.ts`, `client-route.ts`,
`cache-value-codecs.ts`) are as in the identity table. This is still not the
estate's zero-diagnostic receipt. That receipt belongs to the integrator, on
frozen integrated source.

**Owned bytes after this round.** `provider-sql-fixture.ts` is
`01789315a843453d5cadc31c88d88e201dce7ebf5698f619a91057838ee91a05`.
`prep/recursive-read-fit.test.ts` is
`a4f64fbc84ddb22e4676431adb05f91818a55027c125d7c52c3c0db06b09dd8b`. These two
supersede the identity table's values; the other eleven owned files are
unchanged.

**Registrations owed.** Unchanged from the table above.

**Lint (read-only `biome lint` on the two edited files).** The two new
assertions inside the `check` (fixture lines 888 and 889) raise
`noMisplacedAssertion`. The file's existing `check`s already raise the same
rule (lines 1130, 1852, 1853 and 1856). The prep comments raise nothing new;
that file's diagnostics are the earlier ones, shifted by the inserted
lines. Nothing was rewritten.

**Unverified.** The new check on native PostgreSQL/MySQL: the RQ-03 world in
`provider-sql-native.test.ts` carries it, but running it is the integrator's
job. The unfiltered M9 run: with the new check it should also redden the
FK-directions cell, but that was shown filtered only.

## Native observation (2026-09-23)

The two RQ-03 spine cases marked `exceedsMySQLRecursionLimit` were executed on
native MySQL 8.4.11 (`rq07-native-lanes.md`): the provider answered with
`ER_CTE_MAX_RECURSION_DEPTH` (errno 3636) and the engine surfaced it as the
mapped `QueryError` with `meta.providerErrno = 3636` — no truncated success,
no engine-side limit. Both hierarchy and graph worlds ran on native PostgreSQL
16.14 and MySQL 8.4.11 (3 / 3 cells per provider) on the lateral-carrier shape.
