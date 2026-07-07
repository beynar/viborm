# Vector similarity search — phased plan

Status: **proposed**. Anchor: branch `prisma-parity`.

## Problem & first principles

`s.vector().dimension(N)` exists as a scalar; the PG adapter already implements
`adapter.vector = { literal, l2, cosine }` (`postgres-adapter.ts:383-388`,
operators `<->` and `<=>`). But **nothing in the query engine calls it** — the
namespace is marked "Reserved". The similarity *filters* (`l2`/`cosine`) were
deliberately removed from validation (`validation/scalars/vector.ts` header
comment) because the engine rejected them.

The real primitive users want is **not a filter** — a WHERE with a distance
threshold is niche. It is **nearest-neighbour ordering**: "give me the N rows
whose embedding is closest to this query vector," i.e.
`ORDER BY embedding <-> $queryVec LIMIT N`, and usually **the distance value
back** as a score. So this is fundamentally an **orderBy feature plus an
optional computed select**, not a filter.

### The cross-adapter constraint (load-bearing)

Vector support is **per-driver, not per-dialect**: only PostgreSQL implements
it, and *only when the driver's `pgvector` option is enabled* (`pg/index.ts:70`
swaps `adapter.vector = unsupportedVector` otherwise). MySQL/SQLite hard-wire
`vector = unsupportedVector` (`sqlite-adapter.ts:491`, `mysql-adapter.ts`).

This is the sanctioned edge-case exception to the "identical on every database"
principle (AGENTS.md: *"beside very edge cases like vector"*). The rule that
still binds: **never silently diverge — offer it where the column type makes it
statically legal, and throw a clear typed error where the driver can't honor
it.** The honest seam:

- **Static (type) gate:** the distance-order option is offered **only on
  `s.vector()` columns** — statically known from the schema, so the type is
  honest about *what kind of column* supports it. This is NOT the filter
  anti-pattern (which offered `l2`/`cosine` on the base filter type
  unconditionally); it is column-type-gated.
- **Runtime (driver) gate:** whether *this driver instance* has vectors is a
  capability, unknowable from the schema. The engine throws a clear
  `FeatureNotSupportedError` when a vector order reaches a non-vector adapter.

There is no capability flag today (gating is done by swapping the whole
namespace). Phase 1 adds one.

## API shape (decided)

Nearest-neighbour ordering, Prisma-shaped as an orderBy on the vector column:

```ts
client.doc.findMany({
  orderBy: { embedding: { _distance: { to: [0.1, 0.2, 0.3], metric: "cosine" } } },
  take: 10,
})
```

`metric`: `"l2" | "cosine"` (extensible to `innerProduct` later — pgvector `<#>`).
`to`: `number[]`, validated against the column's `.dimension(N)` at query time.

Selecting the score (Phase 3):
```ts
select: { id: true, embedding: { _distance: { to: [...], metric: "cosine" } } }
// → { id, _distance: number }
```

### Rejected alternatives
- **A WHERE filter (`embedding: { cosine: { lt: 0.3 } }`)** — rejected: distance
  thresholds are a niche secondary use; the primary need is top-K ordering,
  which a filter cannot express. May be added later as a pure addition; not v1.
- **A top-level `client.doc.similaritySearch(...)` method** — rejected: forks
  the query API, loses composition with `where`/`select`/`take`. Ordering
  composes for free.
- **Making the type unconditionally offer `_distance` on all columns** —
  rejected: repeats the vector-filter anti-pattern. Column-type gate only.

---

## Phase 0 — Capability flag & honest failure (no user-facing feature yet)

**Goal:** make "does this driver support vectors" a first-class, checkable bit,
and make every vector path fail loud instead of silently.

- Add `capabilities.supportsVector: boolean` to the adapter interface
  (`database-adapter.ts`, beside `supportsLateralJoins` etc.). Default `false`
  in MySQL/SQLite adapters; PG adapter sets it in tandem with the existing
  `pgvector` swap (`pg/index.ts:70`, `postgres/index.ts:108` — where
  `adapter.vector = unsupportedVector` is decided, also set the flag).
- Unit test: a PG driver with `pgvector: true` reports `supportsVector === true`;
  without it, `false`; MySQL/SQLite always `false`.

*Gate:* type-check + full suite green; capability-matrix unit test.
*No behavior change* for existing users.

## Phase 1 — Distance ordering, PG only, runtime-gated

**Goal:** `orderBy: { vecCol: { _distance: { to, metric } } }` produces
`ORDER BY col <-> '[...]'::vector` on a pgvector driver; a clear typed error
everywhere else.

- **Validation** (`validation/relations/order-by.ts` sits next to the scalar
  orderBy; the *scalar* orderBy schema is `model/core/orderby.ts`
  `sortOrderSchema`). Add a `vectorDistanceOrderSchema` (`{ _distance: { to:
  number[], metric: enum["l2","cosine"] } }`) and make the model orderBy schema
  emit it **for vector-typed columns only** (branch in the per-scalar orderBy
  schema assembly by scalar type — vector columns get the distance schema
  instead of / in addition to plain asc/desc). Column-type gate = honest type.
- **Engine** (`builders/sort-order-builder.ts` `buildSingleOrder`): detect the
  `_distance` shape. Resolve the column, assert `ctx.adapter.capabilities.
  supportsVector` — else `throw new FeatureNotSupportedError("vector ordering
  requires a pgvector-enabled PostgreSQL driver")`. Validate `to.length ===
  column dimension` (throw a clear dimension-mismatch error). Emit
  `adapter.orderBy.asc(adapter.vector[metric](column, adapter.vector.literal(to)))`
  (distance is always ascending = nearest-first; `desc` = farthest, allowed).
- **Parameterization:** `adapter.vector.literal` currently interpolates a raw
  string (`'[..]'::vector`) — confirm it binds as a parameter or is built from a
  validated `number[]` (numbers can't inject, but prefer a bound param;
  harden if needed — this is the one injection-surface check).

*Gate:* new `tests/drivers/vector-behavior.ts` wired into `pg.test.ts` /
`postgres.test.ts` (Docker, pgvector image) asserting: seeded rows return in
correct nearest-first order for l2 and cosine; `take` yields top-K; dimension
mismatch throws; **a non-vector driver (sqlite3) throws `FeatureNotSupported`
for the same query** (parity: fail-closed, not wrong results). Migration DDL
checkpoint: confirm `s.vector().dimension(N)` maps to `vector(N)` in the PG
migration type-mapping (`migrations/drivers/postgres`), add if missing.

## Phase 2 — Ordering inside includes & relation orderBy

**Goal:** distance ordering composes where scalar ordering already does — nested
`include: { docs: { orderBy: { embedding: { _distance } }, take } }`.

- The include path already routes orderBy through the same builders
  (`include-builder` → `buildOrderByParts`). Verify the `_distance` order flows
  through the lateral/subquery include assembly unchanged; add coverage. Likely
  near-zero engine code — mostly a test that the Phase 1 mechanism composes.

*Gate:* nested-include vector-order scenario in the vector suite.

## Phase 3 — Selecting the distance as a score

**Goal:** return the computed distance so callers can display similarity.

- **Validation:** extend the vector column's *select* schema to accept the same
  `{ _distance: { to, metric } }`, yielding a `number` result key `_distance`.
- **Select builder** (`builders/select-builder.ts`): when a vector column's
  select value is a `_distance` object, emit the distance expression aliased as
  `_distance` (or a user-named alias — decide: fixed `_distance` for v1, matches
  the orderBy key). **Result parser** (`result/result-parser.ts`): `_distance`
  is a float — ensure it parses as `number` on all PG drivers (pg returns
  numeric as string for some types — pin it, cf. the aggregate `_count` string
  bug fixed earlier).
- Capability + dimension gates identical to Phase 1 (reuse the helper).

*Gate:* select-distance returns correct floats, typed as `number`; combined
`orderBy _distance + select _distance` returns rows ordered with matching
scores.

## Phase 4 (optional) — Index support in migrations

**Goal:** performant ANN, not brute-force scans.

- pgvector needs `ivfflat`/`hnsw` indexes with an operator class
  (`vector_l2_ops` / `vector_cosine_ops`). Extend the index API
  (`s.model(...).index(...)` / index DDL in `migrations/drivers/postgres`) to
  express vector index method + opclass. Non-PG: no-op or reject.
- **Explicit non-goal for v1 if scope-bound:** brute-force `ORDER BY <->` is
  correct without an index (just slow); ship Phases 1–3 and treat indexes as a
  follow-up. Say so rather than half-building.

*Gate:* migration emits a valid `USING hnsw (embedding vector_cosine_ops)`;
introspection round-trips it (or documented as write-only).

## Risks
- **`vector.literal` injection/parameterization** — the one real safety check
  (Phase 1).
- **Result float typing across PG drivers** — same class as the `_count` string
  bug; pin in Phase 3.
- **Type-recursion cost** — the vector orderBy schema is a *leaf* addition (no
  recursion), so it does not risk the TS2589 depth issues that the nested
  relation orderBy plan must manage. Keep it a leaf.

## Definition of done
Vector columns support nearest-neighbour `orderBy` (and `select` score) on
pgvector-enabled PostgreSQL, compose with `where`/`include`/`take`, and throw
one clear typed error on every driver that lacks vector support — never wrong
results, never a silent no-op. The type offers `_distance` **only** on
`s.vector()` columns.
