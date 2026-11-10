# V4: set-oriented lists (plan, 2026-11-03)

Status: V2 was reverted (#134); lever 1 shipped differently from this plan
(see "Outcome of lever 1" below). Release target: once two GPT-6.1 Sol
reviews are clean (owner, 2026-11-03).

## Outcome of lever 1 (2026-11-03)

The set form below was built, reviewed (Sol: correct; slower than main on
wide unselected columns, small pages of a large tree, overlapping subtrees,
Neki's budget, +0.7 kB), fixed, and then removed: what made main's lists slow
was not the per-row walk but its two readers, each rejoining the walked rows
to their table, which PostgreSQL planned as a hash of the whole table per
listed row (it estimates ten rows per recursion level). A first fix carried
each row's sibling order through the walk and read nodes by key on
PostgreSQL (1,040 rows with ancestors 265 → 14 ms); two reviews (Sol E, F)
rejected it: a carried value joins `UNION`'s identity (a sort value that
changes within the statement defeated cycle deduplication), widens every
recursion (SQLite 8 KiB keys 4.9×), and node and order lookups by key lose
to the join on broad walks (PGlite 9,999 descendants 1.14×, a 5-term order
1.6×). What shipped keeps the walk narrow and the node reader joined, and
orders edges from the walk's own columns when the order is key columns
alone (the default), joining nothing; any other order reads the joined
child as main does. PG 18: 1,040 rows with ancestors 255 → 133 ms, a
governed 100-row page 11.8 → 6.8 ms; every reviewed shape on every engine
at or below main; Neki relations equal or one fewer; +91 B (D1) / +119 B
(pg) gzip. The gain the by-key node read had (about 9× more on that list)
is left: it needs a plan that hashes the table once for a broad walk and
probes it for many small ones, which no single statement shape gives.

## Where a governed list spends its time

Pyxel main (0fa8f09), PostgreSQL 18, 500 organizations, `tenant` declared,
V2 merged: `documents.list (mine)` 180–200 ms for 1,040 rows. EXPLAIN ANALYZE
(times inflated about 2× by EXPLAIN) of the main statement:

| part | per row | EXPLAIN ms |
| --- | --- | --- |
| `recurse` select (the document's parent chain): correlated recursive CTE + carrier aggregates, SubPlan/InitPlan per row | 1 walk + 2 aggregates | ~130 of 331 |
| access walks up the ancestors (`upTree`: a grant on the document or an ancestor names me), three walks | 3 walks | ~100 of 331 |
| sort, scan, the rest | | ~100 |

The SQL and parameters of every Pyxel read (V2, with and without `tenant`) are
in `viborm-evidence/pyxel-permissions-2026-11-02/v4/sql-v2-tenant{0,1}.json`.

Why V2 does not lift the access walks: they are read on each listed row, not
inside a repeated body, and Pyxel's NAMING has an `everyone: true` arm (a
boolean: not anchored).

## Levers, by risk

1. **A list's `recurse` select as one walk** (low risk, ~40 % of the read).
   Today `#lowerRecursiveRelationProjection` writes one correlated recursive
   CTE per outer row (`LATERAL` where spelled, else per-row CTE on SQLite) and
   packs a carrier `{__rq_root, __rq_nodes, __rq_edges}` per row. Set form:
   the root page materialized once (`WITH page AS MATERIALIZED (root select,
   with its order/skip/take)`), ONE recursive CTE seeded by every page row and
   carrying its root key, the node and edge facts aggregated per root once
   (`GROUP BY root`), joined back to the page by key. The carrier, its decoder
   and the cache codec are unchanged: only where the facts are computed moves.
   No selectivity guess: the walk starts from rows the list returned.
2. **`_count` per page** (low risk, smaller): one grouped count over the page's
   keys instead of a correlated count per row.
3. **Per-row access walks as one set** (high risk): the top-down closure the
   2026-11-02 prototype hand-wrote (`ideal-docs.sql`: 375 → 25 ms at 5 orgs,
   identical rows). It is the lift Sol showed blows up on broad data; it needs
   its own cost rule (seeded by the actor, bounded by `tenant`), so it comes
   last, measured, and may stay out.

## Lever 1 design questions

- Where the root statement is assembled, so a page CTE can wrap it without
  moving the access predicate (it must run once, on the root, not again on
  the seed).
- Nested lists (a `recurse` select under an include): seed from the
  enclosing relation page, or keep the per-row form there (first cut: root
  lists only).
- MySQL: the per-row CTE lives in a `LATERAL` derived table because MySQL
  materializes a correlated CTE once per statement; the set form has no
  correlation, so it is the natural shape there. SQLite and D1: same shape,
  `MATERIALIZED` spelled as each adapter does.
- Depth cutoffs, edge order (`#completeOrder` per parent), `maxOccurrences`
  budget: unchanged, they are facts of the carrier.
- Writes answering projections in their own statement (`answersInStatement`)
  keep the per-row form.

## Tests and measurement

- Equivalence: every recursive-query corpus case (`tests/raptor3/…`,
  `recursive-query` ledgers) in both forms, rows and order identical, all
  dialects.
- Falsification: the set form forced off must fail the new shape assertions.
- Pyxel: re-clone 0fa8f09 with a filtered install (database, auth, api, web:
  1.3 GB), interleaved runs 1.9.1+V2 vs V4, with and without `tenant`, 5 and
  500 organizations.
- Bundle: hot path (pg / D1 application) cost measured and raised under OD-17
  only with the owner informed.
