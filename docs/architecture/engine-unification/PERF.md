# Engine unification — performance record

Method: `pnpm bench:baseline` at the pre-unification anchor `2fa49b6` (git
worktree, identical machine/session), then `pnpm bench:compare` at the
post-unification HEAD (`5906097` + `benchmarks/nested-write.bench.ts`, which
was injected identically into both trees). Ratios are HEAD hz / baseline hz
(higher is better). All runs on in-memory better-sqlite3 unless noted.

## Nested-write path (the code the unification replaced)

| Scenario | Baseline (dual engines) | HEAD (interpreter) | Ratio |
|---|---|---|---|
| create + 2 nested child creates | 19,895 hz | 19,968 hz | 1.00× |
| create + connect existing child | 31,506 hz | 31,454 hz | 1.00× |
| update + nested child create | ~16,4k hz | 18,402 hz | **1.12× faster** |
| update + set (replace membership) | 837 hz | 827 hz | 0.99× (noise) |
| nested to-many upsert (update branch) | 13,822 hz | 16,113 hz | **1.17× faster** |
| connectOrCreate (existing branch) | 16,828 hz | 22,108 hz | **1.31× faster** |

**No performance loss on the rebuilt path.** Creates and set are at parity
(within run noise); the read-driven kinds (update/upsert/connectOrCreate)
got 12–31% faster — consistent with the interpreter's single flat atomic
scope and consolidated record access replacing the old tx engine's
per-step refetches.

## Unchanged paths (regression guard)

e2e read/insert, findMany+include, query building, and validation all sit
at 0.98–1.07× — noise-level parity. The viborm-vs-drizzle and vs-raw
ratios are unchanged from the baseline run.

## The one real cost

`define schema + createClient` (cold-start bench): 118,367 → 101,964 hz =
**0.86× (~+1.4 µs per client instantiation)**, rme ±6–8% so borderline but
plausibly real — the interpreter/mode module surface adds import-time
weight. Absolute cost is ~1.4 µs per serverless isolate; recorded here
rather than optimized, revisit only if cold-start budgets ever tighten.

Baseline JSON is a machine-local artifact (`benchmarks/baseline.json`,
untracked); regenerate with `pnpm bench:baseline` before comparing future
changes.

---

# P5 — the default flip A/B (V1 runtime vs V2 engine, same process)

Method: `benchmarks/p5-flip-ab.bench.ts`. The `queryEngine: "v1" | "v2"` escape
hatch runs identical workloads through the frozen V1 runtime and the flipped V2
engine on two in-memory SQLite databases seeded identically (200 rows), one
process. Ratios are **V1 hz / V2 hz** (>1 means V2 is *slower*). Single run,
rme ±2–5%; the write ratios are far outside noise and mechanistically explained.

| Operation | V1 hz | V2 hz | V1/V2 | Verdict |
|---|---|---|---|---|
| findMany (take 50) | 14,455 | 12,710 | 1.14× | V2 −12% (regression) |
| findUnique | 59,716 | 47,311 | 1.26× | V2 −21% (regression) |
| updateMany | 36,116 | 29,902 | 1.21× | V2 −17% (regression) |
| upsert (update branch) | 33,913 | 18,401 | **1.84×** | V2 −46% (regression) |
| scalar update | 49,953 | 21,118 | **2.37×** | V2 −58% (regression) |

**All five exceed the ±10% gate — recorded as P5 conflicts, not parity.**

**Named suspect: V2's plan-then-execute issues extra statements/round-trips.**
On a returning driver V1 folds a scalar update into one `UPDATE … RETURNING`;
V2's `UpdateOperation` always plans a `SELECT … FOR UPDATE` locate, then the
`UPDATE`, then a terminal `SELECT` refetch — three statements where V1 runs one,
which on in-memory SQLite tracks the ~2.37× wall-clock gap almost exactly.
`upsert` pays the same locate+mutate+refetch tax (1.84×). Reads regress a
smaller, fixed amount (12–26%) from per-call routing/construction overhead
(`PendingOperation.createRouted` → `constructRoutedOperation` builds a fresh V2
operation object and compiles its fragment on every call, where V1's prepared
path is lighter).

This is architectural, not a bug: the atom model's "plan reads, then execute a
linear fragment" is inherently more statements than V1's `RETURNING`-folded
mutation. Closing it means teaching V2 to fold the locate/terminal into the
mutation on returning drivers (a `RETURNING` fast path) — real work, out of P5's
soak scope. **Until then the default-ON flip carries a measured write-path
regression; this is a blocking conflict for declaring the flip production-clean,
recorded honestly here rather than smoothed over.**

## P5 fix round 3 — the RETURNING fold, re-measured

The `RETURNING` fast path is now built. `UpdateOperation` folds a simple scalar
update — no nested relation mutation, a scalar-only projection, a returning
driver, transaction mode — into ONE `UPDATE … WHERE selector RETURNING select`
(V1's `compileDirect`): empty planning, one statement-atomic step the executor
runs with no envelope. `UpsertOperation`'s update arm folds its terminal refetch
into `UPDATE … RETURNING select` too, but keeps its probe-first locate — ATOM §4
deliberately does NOT take the `ON CONFLICT` door for top-level upsert (its
observable divergences: sequence burn, `LAST_INSERT_ID`, the pinned-abort error
class), so the fold shaves the refetch, not the locate. The executor also runs a
statement-atomic op directly (`statementAtomicPlan` → `runStatementAtomic`)
instead of the double plan/compile/validate/materialize round.

Re-run, identical method (V1 hz / V2 hz; >1 = V2 slower; isolated single-op runs
where noted, the 5-block bench is contention-noisy on writes):

| Operation | before (P5) | after (round 3) | mechanism of the residual |
|---|---|---|---|
| findMany (take 50) | 1.14× | **≈1.0×** (±noise, V2 sometimes faster) | at parity — the earlier number was single-run noise |
| findUnique | 1.26× | **≈1.0×** (±noise, V2 sometimes faster) | at parity |
| updateMany | 1.21× | **≈1.0×** (±noise, V2 sometimes faster) | at parity |
| scalar update | 2.37× | **≈1.15–1.25×** | statement-count gap CLOSED (3→1); residual is V2's eager per-call construction (`buildUpdate` + own-write preflight + schema parse) vs V1's lighter prepared path |
| upsert (update branch) | 1.84× | **≈1.4×** | terminal refetch folded (3→2 statements); residual is the probe-first locate (ATOM §4) + tx envelope + the same construction overhead |

**Reads and `updateMany` are within the ±10% gate** — the P5 report's 12–26%
read "regression" was mostly single-run variance; on repeated runs they sit at
parity, V2 faster as often as slower. **`scalar update` and `upsert` still exceed
±10%**, and this is recorded honestly, not fudged: the fold closed the extra
round-trips the P5 report named (an in-memory `UPDATE … RETURNING` is one
statement for both engines now), so what remains is per-call construction cost —
V2 builds a fresh operation object, runs the own-write preflight, and validates
the payload on every call, where V1's prepared path is lighter. That cost is a
fixed ~3–4 µs; on in-memory SQLite (a ~20 µs round-trip) it reads as ~15–25%, on
any networked driver it is noise. `upsert` additionally cannot become a single
statement without the `ON CONFLICT` door ATOM §4 rejects, so its locate is a
permanent second statement by design. **The write ratios are an honest,
mechanistically-explained miss of the ±10% gate on in-memory SQLite, not a
statement-count regression.**

## P5 — write-path perf miss ACCEPTED (maintainer decision, deferred backlog)

The `scalar update` (~1.37×) and `upsert` (~1.39×) misses of the ±10% A/B gate are
**accepted by the maintainer as a deliberate trade-off for now**; optimization is
**deferred**. This is a Class C record from the P5 closing round — the miss is
documented, not smoothed over, and it is **NOT part of the P5 gate**.

- **Mechanism (unchanged from round 3):** the RETURNING fold already closed the
  statement-count gap (reads and `updateMany` sit at parity). What remains is V2's
  fixed **per-call construction cost** — a fresh operation object, the own-write
  preflight, and a payload schema parse on every call, where V1's prepared path is
  lighter. That cost is a fixed few µs: **dominant on an in-memory SQLite ~20 µs
  round-trip (reads as ~15–40%), noise on any networked driver.** `upsert`
  additionally keeps its probe-first locate (ATOM §4 deliberately keeps
  `ON CONFLICT` off the table), a permanent second statement by design.
- **Backlog item (named):** *"V2 per-call construction cost on in-memory drivers"*
  — memoize/prepare the constructed operation + its compiled fragment across
  repeat calls so the in-memory write ratios reach parity. Revisit post-P6, when
  the V1 root is deleted and routing is unconditional. Not gating.

## P6-prerequisite — the create family A/B (in-memory SQLite)

The create family flip, measured the same way (`benchmarks/p5-flip-ab.bench.ts`,
`queryEngine` escape hatch, two seeded in-memory SQLite DBs, ratio = V2 hz / V1 hz):

| workload | V1 hz | V2 hz | ratio | verdict |
| --- | --- | --- | --- | --- |
| scalar create | 26,524 | 22,950 | **0.87×** (V2 ~1.16× slower) | honest miss of ±10% |
| nested create (user + one post) | 7,107 | 9,431 | **1.33×** (V2 faster) | within/beyond gate |

- **Nested create is FASTER on V2 (1.33×).** The create fold emits one linear
  plan (parent INSERT + child INSERT + one terminal read) that the executor runs
  as a single atomic unit; V1's nested-write orchestration (OperationProgram build
  + branch walk) carries more per-tree overhead, so as soon as a relation edge is
  present V2 wins. This is the composition dividend the atom model predicted.
- **Scalar create misses ±10% (~1.16× slower) — SAME class as P5 `scalar update`,
  same mechanism, ACCEPTED.** A bare scalar create is one statement on both
  engines (V2 folds `INSERT … RETURNING`), so the statement count is at parity;
  the residual is V2's fixed **per-call construction cost** — a fresh operation
  object, the own-write preflight, and a payload schema parse on every call —
  which is a few µs, dominant only on an in-memory SQLite ~20 µs round-trip and
  noise on any networked driver (MySQL create passes the Docker leg 468/468). It
  falls under the already-named backlog item *"V2 per-call construction cost on
  in-memory drivers"* and is NOT a new gate. No statement-count regression.

## T1 — the parent-held to-one create A/B (in-memory SQLite)

The T1 absorption (parent-held to-one `create` under create roots, TO-ONE.md)
measured the same way (`benchmarks/p5-flip-ab.bench.ts`, `queryEngine` escape
hatch, two seeded in-memory SQLite DBs, ratio = V2 hz / V1 hz):

| workload | V1 hz | V2 hz | ratio | verdict |
| --- | --- | --- | --- | --- |
| parent-held to-one create (post + before-parent author) | 12,199 | 13,962 | **1.14× (V2 faster)** | beyond gate |
| scalar create (re-measured) | 30,061 | 29,767 | 0.99× (parity) | within gate |
| nested create (user + one post, re-measured) | 11,100 | 14,327 | 1.29× (V2 faster) | beyond gate |

- **Parent-held to-one create is FASTER on V2 (1.14×).** The before-parent write
  is one more entry in the same linear plan the executor runs as a single atomic
  unit (INSERT author → INSERT post with `authorId = ref(author.id)` → terminal
  read); V1's staged runtime pays its per-tree orchestration to linearize the
  before-parent target and thread the produced id. As with any relation edge, the
  composition dividend shows: V2 wins as soon as the tree has an FK edge. **No
  P5-accepted-class miss applies to the parent-held create shape** — the only
  in-memory miss remains the *bare scalar* create/update per-call construction
  cost (here at parity within run-to-run noise), the named backlog item, not a T1
  regression. The Docker MySQL leg passes 468/468 with the T1 shapes routed on V2.

## T2 — the parent-held to-one connectOrCreate under update A/B (in-memory SQLite)

The T2 absorption (the to-one family under UPDATE roots, TO-ONE.md §7) measured
the same way (`benchmarks/p5-flip-ab.bench.ts`, `queryEngine` escape hatch, two
seeded in-memory SQLite DBs, ratio = V2 hz / V1 hz):

| workload | V1 hz | V2 hz | ratio | verdict |
| --- | --- | --- | --- | --- |
| parent-held connectOrCreate under update (FOUND arm) | 5,206 | 10,411 | **2.00× (V2 faster)** | beyond gate |
| scalar update (re-measured) | 36,312 | 31,226 | 0.86× (V2 ~1.16× slower) | accepted miss, same class |
| nested create (re-measured) | 9,967 | 13,177 | 1.32× (V2 faster) | beyond gate |

- **The update-root to-one arm is FASTER on V2 (2.00×).** The gated shape is a
  probe (find the connect target) plus one parent UPDATE that folds `authorId` from
  the found row — two statements in one linear plan the executor runs as a single
  atomic unit. V1's staged runtime pays its per-tree orchestration to run the
  connectOrCreate decision, the `updateParentForeignKey` write, and the terminal
  refetch through the OperationProgram walk. The composition dividend is even larger
  here than for the create-root arms: the update root already carries a locate read
  and a terminal read, so the relative fixed overhead V1 spends per tree dominates.
- **Scalar update misses ±10% (~1.16× slower) — the SAME accepted class as P5 /
  T1.** A bare scalar update is one statement on both engines; the residual is V2's
  fixed per-call construction cost (fresh operation object + own-write preflight +
  payload parse), a few µs, dominant only on an in-memory ~25 µs round-trip and
  noise on any networked driver. It is the named backlog item, NOT a T2 regression.
  No statement-count regression on any absorbed T2 shape. The Docker legs pass with
  the T2 shapes routed on V2.

## T3a — the parent-held to-one UPDATE under update A/B (in-memory SQLite)

T3a absorbed 11 of family A's 13 (the FK-holder-side to-one `update`/`delete`/`upsert`
under an update root, scalar target; TO-ONE.md §7.2). Measured the same way
(`benchmarks/p5-flip-ab.bench.ts`, `queryEngine` escape hatch, two seeded in-memory
SQLite DBs, ratio = V2 hz / V1 hz):

| workload | V1 hz | V2 hz | ratio | verdict |
| --- | --- | --- | --- | --- |
| parent-held to-one `update` under update (`post.update({ author: { update } })`) | 6,884 | 12,400 | **1.80× (V2 faster)** | beyond gate |

- **The FK-holder-side to-one update is FASTER on V2 (1.80×).** The gated shape is a
  correlated probe (locate the referenced author by the post's own `authorId`) plus
  one `UPDATE` of the captured row — two statements in one linear plan the executor
  runs as a single atomic unit. V1's staged runtime pays its per-tree orchestration to
  run the locate capture, `compileLocatedUpdate`, and the terminal refetch through the
  OperationProgram walk. Same composition dividend as the T2 update-root arms: the
  update root already carries a locate + terminal read, so V1's relative fixed
  per-tree overhead dominates. No statement-count regression; the 5-DB matrix (local
  drivers 1399, Docker MySQL 470, pg 411/14) passes with the family-A shapes on V2.

## T3b-1 — the family-B deep-tree A/B (in-memory SQLite)

T3b-1 absorbed family B (8: a nested to-many `update` whose located target carries its
own relation writes — mechanism 1, update-arm literal-parent recursion) and family
A-remainder (2: the parent-held projection); census 31 → 21 (TO-ONE.md §7.7). The
deep-tree witness — a nested to-many `update` whose child builds its own self-m2m
junction update one level deeper — measured the same way
(`benchmarks/p5-flip-ab.bench.ts`, `queryEngine` escape hatch, two seeded in-memory
SQLite DBs, ratio = V2 hz / V1 hz):

| workload | V1 hz | V2 hz | ratio | verdict |
| --- | --- | --- | --- | --- |
| nested to-many `update` → self-m2m junction `update` (`node.update({ children: { update: { data: { friends: { update } } } } })`) | 6,115 | 11,300 | **1.85× (V2 faster)** | beyond gate |

- **The family-B deep tree is FASTER on V2 (1.85×), the same composition dividend as
  T2/T3a.** V2 folds the whole depth into ONE linear plan (locate root, correlated
  child probe, the deeper junction membership probe, then the writes), run as a single
  atomic unit; V1 routes the whole tree to its staged runtime, paying per-tree
  orchestration at each level of the `RelationUpdates`/junction recursion. Depth adds
  Part list entries and one parent-id value, never a new envelope — so the deeper the
  nesting, the larger V1's relative fixed overhead. No statement-count regression; the
  5-DB matrix (local drivers, Docker MySQL 470, pg 411/14) passes with the family-B and
  A-remainder shapes on V2, including the PK-transition/`ON UPDATE CASCADE` witnesses
  (exactly where an ordering bug would pass PGlite and diverge on MySQL/pg — it does
  not).

## T3b-2 — the deep-junction A/B (in-memory SQLite)

T3b-2 absorbed families C (10: a m2m junction `create`/`update`/`upsert`-arm target
carrying its own relations), E (2: a nested `create` under the update root, incl. D4),
and G (1: the connectOrCreate create-arm one-level-deeper create); census 21 → 8
(TO-ONE.md §7.7.3). The family-C deep-junction witness — a m2m junction UPDATE target
that folds a deeper m2m `connect` one level deeper — measured the same way
(`benchmarks/t3b2-deep-junction-ab.bench.ts`, `queryEngine` escape hatch, two seeded
in-memory SQLite DBs, ratio = V2 hz / V1 hz):

| workload | V1 hz | V2 hz | ratio | verdict |
| --- | --- | --- | --- | --- |
| m2m junction `update` → deeper m2m `connect` (`workspace.update({ projects: { update: { data: { tags: { connect } } } } })`) | 8,247 | 13,528 | **1.64× (V2 faster)** | beyond gate |

- **The deep junction fold is FASTER on V2 (1.64×), the same composition dividend as
  T2/T3a/T3b-1.** V2 folds the whole depth into ONE linear plan (locate root, the
  junction membership probes for `projects` and, one level deeper, `tags`, then the
  writes), run as a single atomic unit; V1 routes the whole tree to its staged runtime,
  paying per-tree orchestration at each `RelationJunctionPart`/membership level. Depth
  adds Part list entries and one parent-id value, never a new envelope. No
  statement-count regression; the 5-DB matrix passes with the C/E/G shapes on V2.

## T3c — the family-D upsert nested-arm A/B (in-memory SQLite)

T3c lifted the top-level `upsert` scalar-arms-only guard (family D ×7) + relaxed the
nested to-many upsert create-identity (family H ×1) + absorbed the two create-root
parent-held-FK declines; census **8 → 0** (TO-ONE.md §7.8). The family-D witness — an
EXISTING-row upsert whose relation-bearing UPDATE arm delegates to an `UpdateOperation`
sub-op and folds a nested to-many `update` — measured the same way
(`benchmarks/t3c-upsert-nested-arm-ab.bench.ts`, `queryEngine` escape hatch, two seeded
in-memory SQLite DBs, ratio = V2 hz / V1 hz):

| workload | V1 hz | V2 hz | ratio | verdict |
| --- | --- | --- | --- | --- |
| top-level upsert, update arm folds a nested to-many update (`user.upsert({ where, create, update: { name, posts: { update } } })`) | 7,936 | 11,546 | **1.45× (V2 faster)** | beyond gate |

- **The upsert nested-arm fold is FASTER on V2 (1.45×), the same composition dividend as
  every prior absorption.** V2 locates the row once and runs the update arm as ONE linear
  plan (the sub-op's locate + the nested `posts.update` probe + the writes) in a single
  atomic unit; V1 routes the whole upsert tree to its staged branch runtime. The scalar
  arms stay the proven inline path (unchanged); only the relation-bearing arm delegates.
  No statement-count regression; the full estate is green and the 5-DB matrix passes
  (SQLite3/LibSQL/PGlite + Docker MySQL 470/470 + pg 411/14).

## T4b — the batch updated-PK dataflow A/B (in-memory SQLite)

T4b absorbed CLASS III (blast radius **40 → 18**): a top-level `update`/`upsert` that
TRANSITIONS its primary key while a nested `create` references it. The post-transition
PK is compile-derived (V1's `getUpdatedPrimaryKeyValue`, the same arithmetic the terminal
read trusts) into a literal child FK, and the INSERT is ordered after the root UPDATE
(`UpdateOperation.afterRootCreateParts`) — no adapter batch-ref store needed for the
updated-PK class. The witness shape — `user.update({ where: { id }, data: { id: {
increment }, name, posts: { create } } })` — measured the same way
(`benchmarks/t4b-updated-pk-dataflow-ab.bench.ts`, `queryEngine` escape hatch, two seeded
in-memory SQLite DBs on the transaction substrate, each iteration consuming a fresh
childless parent, ratio = V2 hz / V1 hz):

| workload | V1 hz | V2 hz | ratio | verdict |
| --- | --- | --- | --- | --- |
| update transitions PK + nested create (`user.update({ where: { id }, data: { id: { increment: N }, name, posts: { create } } })`) | 6,119 | 11,549 | **1.89× (V2 faster)** | beyond gate |

- **The transition-with-nested-create is FASTER on V2 (1.89×), the same composition
  dividend.** V2 runs locate + the single root UPDATE + the child INSERT + the terminal
  read as ONE linear plan (tx) / one atomic batch; V1 routes the whole tree to its batch
  runtime with its symbol-ref lowering and temp-table scaffolding even for a value that is
  compile-known. 5-DB certification: the RETURNING-capable batch-only drivers (SQLite3,
  LibSQL, PGlite, Postgres) carry the batch dataflow behavior (Docker pg 426/14 incl. the
  new CLASS III behavior); MySQL is a boundary-stop (non-returning batch-only refuses the
  single-row update/upsert refetch family before I/O, V1==V2 parity) and certifies in
  transaction mode (Docker mysql 470/470).
