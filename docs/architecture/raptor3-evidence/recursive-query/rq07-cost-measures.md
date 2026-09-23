# RQ-07 — the plan's §6 cost cells, measured (source-bound, 2026-09-23)

**What this records.** `features-docs/recursive-query.md` §6 asks for depths
1 / 2 / 8 / 32, long chains at 100 / 1000 and a supported exhaustive path
beyond 1000, widths 1 / 2 / 8 / 32 at a controlled shallow depth, graph
diamonds and cycles at a controlled output size — each with the statement
count, SQL and bind sizes, transported node and edge facts, returned
occurrences, output size, CPU, memory. RQ-03/04 (`rq34-chains-hierarchies-graphs.md`,
"Transport versus required output — measured") recorded the transport and
output columns for depths, ladders and cycles and left CPU, allocation and
peak memory unmeasured; this ledger adds the width cells and the CPU, wall,
heap and peak-memory columns for every cell, on the tree of the native round
(`Queries.decodeRecursiveCarrier` with the per-level hop check, the lateral
carrier placement on providers that spell `LATERAL` — SQLite here takes the
scalar form).

**How.** SQLite in-memory through the ordinary command engine, one execute per
sample: one warm-up, then seven timed executes (`process.cpuUsage` user+system
and `hrtime` wall, medians), then one execute between two `heapUsed` readings
(no exposed GC in the worker, so the delta is the retained value plus whatever
garbage the sample left — an upper bound, not an allocation count). Statement
count asserted at 1 for every sample. Script: `perf/rq07-cost-measures.script.ts.txt`
(a copy of the scratch test that ran through a throwaway vitest config on this
tree, deleted after the run); data: `perf/rq07-cost-measures.json`; run log:
`perf/rq07-cost-measures.log`. Runtime v24.21.0 darwin-arm64, pinned.

| cell | SQL chars | binds / bind bytes | carrier bytes | nodes / edges | occurrences | output bytes | CPU µs (median of 7) | wall µs | heap Δ one execute |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| FK chain depth 1 | 1,687 | 13 / 117 | 151 | 1 / 1 | 1 | 13 | 691 | 369 | 475,912 |
| FK chain depth 2 | 1,687 | 13 / 117 | 254 | 2 / 2 | 2 | 38 | 741 | 672 | 101,560 |
| FK chain depth 8 | 1,687 | 13 / 117 | 872 | 8 / 8 | 8 | 188 | 779 | 720 | 121,208 |
| FK chain depth 32 | 1,687 | 13 / 118 | 3,458 | 32 / 32 | 32 | 811 | 906 | 853 | 198,504 |
| FK chain depth 100 | 1,687 | 13 / 119 | 10,806 | 100 / 100 | 100 | 2,580 | 1,761 | 1,230 | 412,152 |
| FK chain depth 1000 | 1,687 | 13 / 120 | 112,510 | 1,000 / 1,000 | 1,000 | 26,881 | 7,291 | 7,056 | 3,187,704 |
| FK chain exhaustive (1,100) | 1,568 | 9 / 98 | 103,419 | 1,100 / 1,100 | 1,100 | 29,695 | 9,058 | 7,069 | 3,669,736 |
| FK chain upward depth 32 (singular) | 1,668 | 13 / 119 | 3,489 | 32 / 32 | 32 | 692 | 477 | 453 | 189,696 |
| width 1 at depth 2 | 1,687 | 13 / 117 | 274 | 2 / 2 | 2 | 44 | 210 | 253 | 106,024 |
| width 2 at depth 2 | 1,687 | 13 / 117 | 732 | 6 / 6 | 6 | 119 | 439 | 394 | 112,848 |
| width 8 at depth 2 | 1,687 | 13 / 117 | 8,394 | 72 / 72 | 72 | 1,241 | 720 | 853 | 268,640 |
| width 32 at depth 2 | 1,687 | 13 / 117 | 128,276 | 1,056 / 1,056 | 1,056 | 18,679 | 6,906 | 6,914 | 2,621,000 |
| ladder 4 rungs exhaustive (diamonds) | 1,746 | 9 / 98 | 1,286 | 12 / 16 | 60 | 1,247 | 395 | 394 | 157,456 |
| ladder 8 rungs exhaustive (diamonds) | 1,746 | 9 / 98 | 2,522 | 24 / 32 | 1,020 | 21,167 | 886 | 819 | 693,912 |
| 3-cycle unfolding depth 30 | 1,866 | 13 / 118 | 1,998 | 3 / 30 | 30 | 593 | 748 | 758 | 165,904 |
| complete 3-graph unfolding depth 8 | 1,866 | 13 / 117 | 2,695 | 3 / 42 | 510 | 8,153 | 1,101 | 846 | 372,296 |
| complete 3-graph exhaustive simple paths | 1,746 | 9 / 98 | 437 | 3 / 6 | 4 | 83 | 214 | 212 | 106,200 |

**Peak memory.** The safe runner sampled **573.9 MiB peak process-group RSS**
for the whole file (vitest worker included; ceiling 1,536 MiB). Node's own
`resourceUsage().maxRSS` for the worker read 193,408 (a per-platform
unit; recorded, not interpreted).

**Read.**

- *Statements, SQL, binds*: one statement per read at every depth and width;
  the statement is one shape per mode (bounded 1,687 chars / 13 binds on the
  tree model, exhaustive 1,568 / 9; the graph model 1,866 / 13 and 1,746 / 9),
  independent of the requested depth — the depth is a bind.
- *Transport and output*: linear in facts for a chain (depth 1000: 1,000 nodes
  and edges, 112,510 carrier bytes, 26,881 output bytes) and for a width world
  (width 32 at depth 2: 1,056 facts and occurrences); output grows with paths
  where the graph has them (ladder 8: 32 edge facts, 1,020 occurrences;
  complete 3-graph at depth 8: 42 facts, 510 occurrences), as §6 states.
- *CPU*: sub-millisecond for every cell up to depth 32 and width 8; about
  7 ms for 1,000–1,100 occurrences on a chain or a width-32 world and 0.9 ms
  for the 1,020-occurrence ladder — the cost tracks returned occurrences and
  carried bytes, not depth. The width-1 and 3-graph exhaustive cells (~0.2 ms)
  are the floor of one prepared statement through SQLite plus the decoder.
- *Memory*: the one-execute heap delta grows with the returned value (3.2–3.7
  MB retained for 1,000–1,100 occurrences with their key strings; ~0.1 MB at
  the floor). No production allocation-instrumentation API was added (§6).
- *Not measured here*: native provider bytes and evaluation work beyond the
  SQLite double evaluation recorded in the follow-ups ledger (the native lanes
  assert node/edge counts and one statement, `rq07-native-lanes.md`). Cache
  materialization cost per occurrence is measured in the section below. The
  plans differ in how often the recursion is evaluated, which no cell here
  measures: SQLite evaluates the carrier's recursive CTE once per reader —
  twice per carrier, one `MATERIALIZE` under the nodes reader and one under
  the edges reader in `EXPLAIN QUERY PLAN` of the engine's own statement —
  while PostgreSQL materializes it once per outer row (one `CTE` read by two
  `CTE Scan`s inside the lateral subplan). No number is claimed for either.
- No runtime, allocation or bundle improvement is claimed from these numbers.

## Parse and cache allocation — measured (external profiling, added after the second external review)

§6 names "parse/cache allocation" and allows external profiling. Measured on
the same SQLite worlds through the **shipped client**, with V8's sampling heap
profiler driven through `node:inspector` (`HeapProfiler.startSampling`,
sampling interval 256 bytes, objects collected by minor and major GC
included, so the figure is every sampled allocation of the window, not only
what survived), over 20 executes per cell and divided by 20; retained bytes
per held result from `heapUsed` around ten held results with a forced GC on
both sides (`NODE_OPTIONS=--expose-gc`), divided by ten; CPU as the median of
20 unprofiled executes. "Execute" is the whole public read: statement build,
the provider round trip, the carrier decode and the public value. "Cache hit"
is the same read through `$withCache()` after one miss stored the snapshot:
key, lookup, and materialization of fresh public occurrences from the stored
snapshot (`recursiveRelationCodec`) — no statement. Script:
`perf/rq07-allocation-measures.script.ts.txt`; data
`perf/rq07-allocation-measures.json`; log `perf/rq07-allocation-measures.log`.
Runtime v24.21.0 darwin-arm64, pinned.

| cell | occurrences | execute: sampled allocated bytes | per occurrence | CPU µs (median of 20, unprofiled) | retained bytes per held result | per occurrence | cache hit: sampled allocated bytes | per occurrence | CPU µs (median of 20) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| FK chain depth 32 | 32 | 197,907 | 6,185 | 1,277 | 1,295 | 40 | 251,058 | 7,846 | 472 |
| FK chain depth 1000 | 1,000 | 2,886,228 | 2,886 | 9,161 | 235,710 | 236 | 4,360,574 | 4,361 | 3,465 |
| FK chain exhaustive (1,100) | 1,100 | 3,462,660 | 3,148 | 7,718 | 257,960 | 235 | 4,757,639 | 4,325 | 2,006 |
| width 32 at depth 2 | 1,056 | 2,538,844 | 2,404 | 6,786 | 66,781 | 63 | 3,283,620 | 3,109 | 1,281 |
| ladder 8 rungs exhaustive (diamonds) | 1,020 | 702,987 | 689 | 732 | 209,021 | 205 | 4,247,430 | 4,164 | 1,578 |
| complete 3-graph unfolding depth 8 | 510 | 369,900 | 725 | 950 | 86,347 | 169 | 2,039,881 | 4,000 | 711 |

**Read.**

- An execute allocates about 2.4–2.9 KB per returned occurrence on a chain
  or a width world (statement, provider row, carrier text, decode, the public
  object with its key strings) and 0.7 KB per occurrence on the ladder, where
  1,020 occurrences unfold from 24 nodes and 32 edges: the carrier is small
  and the unfold allocates the occurrence objects. Retained per occurrence is
  40–240 bytes on the tree cells and ~200 on the ladder (fresh objects and
  arrays per occurrence, the mutable-value rule of §6).
- A cache hit allocates MORE than the execute it replaces (1.3–6× per cell:
  4.4 MB vs 2.9 MB at depth 1,000; 4.2 MB vs 0.7 MB on the ladder) while
  costing less CPU (3.5 ms vs 9.2 ms at depth 1,000) and no statement. The
  materialization restores every occurrence and leaf as a fresh object from
  the stored snapshot; the ladder's ratio shows it pays per occurrence, not
  per stored fact. This is a measured fact about `recursiveRelationCodec`'s
  materialization, recorded here, not a claim of improvement or a budget.
- No production allocation-instrumentation API was added; the profiler is
  external to the package and the script is a throwaway test.

## SQL text after the RQ-07 elegance pass — re-recorded (2026-09-23)

The elegance pass (`rq07-elegance-pass.md`) changed the recursive statement's
text twice and nothing else in it: the recursive CTE no longer carries the
unread root identity role (`__qN_root_*` in the anchor and the recursive
member — the CTE is evaluated per outer row, and the carrier's `__rq_root` is
the outer row's own key), and the two carrier readers no longer wrap
`json.agg` in a second `COALESCE(…, emptyArray)` that every adapter's
`json.agg` already applies. Re-rendered through the ordinary command engine on
the same models as the table above — SQLite executed in memory, PostgreSQL
lowered through `PostgresAdapter` with no provider — once on HEAD `bcb364491`
and once on the pass's tree. The depth is a bind, so one statement shape covers
every row of the table that uses it:

| statement shape | cells above | SQLite chars (HEAD → pass) | binds | PostgreSQL chars (HEAD → pass) | binds |
| --- | --- | ---: | ---: | ---: | ---: |
| tree, bounded | FK chain depth 1…1000; width 1…32 at depth 2 | 1,687 → 1,574 | 13 | 1,808 → 1,699 | 13 |
| tree, exhaustive | FK chain exhaustive (1,100) | 1,568 → 1,455 | 9 | 1,678 → 1,569 | 9 |
| tree, upward singular, bounded | FK chain upward depth 32 | 1,668 → 1,555 | 13 | 1,789 → 1,680 | 13 |
| graph, bounded, prevention off | 3-cycle depth 30; complete 3-graph depth 8 | 1,866 → 1,753 | 13 | 2,005 → 1,896 | 13 |
| graph, exhaustive | ladders 4 / 8; complete 3-graph simple paths | 1,746 → 1,633 | 9 | 1,874 → 1,765 | 9 |

The HEAD column reproduces this ledger's SQL chars exactly; the decoded public
values are identical on every shape before and after, and the bind counts are
unchanged. Script, outputs and logs: `elegance-pass/sql-shape.scratch.test.ts.txt`,
`elegance-pass/sql-shapes-{before,after}.json`,
`elegance-pass/02-sql-shapes-before.log`, `elegance-pass/40-sql-shapes-after.log`.
**Not re-measured:** carrier bytes, CPU, wall, heap and peak memory (the table
above keeps its measured identity), and native PostgreSQL/MySQL text. The
machine's load average was 45–110 during the pass, so no timing was taken.
