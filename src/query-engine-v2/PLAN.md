# V2 Migration Plan — From Proof Slice to the Only Engine

> Companion to [`README.md`](./README.md) (hypothesis), [`WHY-V1-GREW.md`](./WHY-V1-GREW.md)
> (post-mortem), [`ATOM.md`](./ATOM.md) (the normative primitive). This is the
> executable path between them. Each phase has a goal, the work, a gate that
> must be green at merge, and a **kill signal** — the observation that means
> stop and reconsider rather than push through.

Standing rules, all phases:

- **The oracle is the instrument.** Parity is proven by *dual-running* real
  client payloads through V1 and V2 and comparing persisted state, results,
  and error classes — using the existing conformance technique
  (`tests/query-engine/nested-write-conformance.test.ts`): a **fresh database
  instance per arm per scenario**, deterministic ids (no `now()`/uuid
  defaults), stable-order table dumps. Fixed-expectation behavior tests are
  necessary but are not parity evidence.
- **Gates name their databases.** "Green on all five" means the Docker-gated
  mysql2/pg runs included, explicitly, every time (the mysql/pg suites are
  env-var-gated skips otherwise).
- **V1 freezes per operation at *routing*, not at absorption** — a V1 bug
  found before its operation routes to V2 still ships to users and gets fixed
  in V1; after routing, V2 only.
- **Leaf, never axis** (WHY §7). A new step kind, Part method, or runtime
  requires two concrete operations that need it **and** a design note in this
  directory.
- **Reuse V1's earned mass.** Builders, `ResultParser`, `TargetConstraint`,
  `mutation-identity`, the own-write preflight analysis, error mapping,
  `batchRefs` adapters, drivers: inputs, not rewrite targets. V2 replaces the
  operation/execution root (~10.8k lines), nothing else.

---

## P−1 — Prerequisites (cheap, and they de-risk everything after)

Not a phase; blockers to starting one.

1. **Commit the baseline.** The V1 root being strangled is currently
   *untracked working-tree code* on a branch 60 commits past `main` (and the
   previously committed engine is deleted in the working tree). "V1 frozen"
   and "oracle green at merge" are unenforceable against code that is not in
   git. Land or explicitly bless the V1 state first.
2. **Legitimize the slice's shape as a deliberate contract extension.**
   Maintainer decision: nested `upsert` under a top-level `create` — global
   child lookup, adopt-and-update on the found branch — **is supported**.
   V1's rejection is judged a contract hole, not a contract: under `create`,
   `connect` and `connectOrCreate` already perform global lookup-and-adopt;
   upsert completes that family ("connectOrCreate plus updates when found"),
   and the correlated reading is meaningless under a parent that cannot have
   children yet. The current *implementation* of the shape remains a defect to
   fix, and the extension carries named work:
   - a first-class create-input validation schema with an `upsert` member
     (`validation/relations/create.ts`) — the update-schema smuggling in
     `CreateOperation` dies;
   - an **extension-scenario class** in the oracle: the V1 arm asserts the
     known typed rejection, the V2 arm asserts pinned expected state (these
     shapes certify by fixed expectation, not parity — there is no V1
     behavior to be equal to);
   - a compatibility-docs entry recording the deliberate Prisma superset
     (this repo pins expected differences explicitly, never silently);
   - the feature *lights up* only when its tree class routes to V2 — before
     that, users keep getting V1's rejection, so no mid-migration flicker.
   Scope note: this decision covers upsert under **create**. Nested upsert
   under **update** keeps its correlated contract (found-uncorrelated → typed
   error) — there a correlated scope exists and is Prisma's semantics; say
   the word if adopt-on-update is wanted too, but that would change behavior
   the parity oracle currently certifies.
3. **Maintainer sign-off on ATOM.md** — it is now the normative vocabulary,
   including the census (§8) the freeze depends on.

---

## P0 — Make the atom normative (contract before features)

**Goal:** the starter obeys ATOM.md; known defects gone; seams stop leaking.
**No vocabulary freeze yet** — P0 *changes* the vocabulary to its census shape.

1. **Pin Rule compliance**: delete the `notExists` guard on the create branch;
   keep the `exists` guard on the found branch with `raceable: false`.
2. **Vocabulary to census shape** (ATOM §1, §8): `Failure.kind` full set
   (`nestedWrite`/`notFound`/`query`) + `raceable`; `Source` gains `rowCount`;
   `Step.expects` postconditions; `Step.racePin` (reusing `TargetConstraint`)
   so retry can match the violated constraint instead of retrying every unique
   violation; fragment outputs as ordered source lists; scope-owned step-id
   allocator.
3. **Executor split + inversion**: the executor stops importing
   `CreateOperation`; it splits into **compile-to-entries** and
   **execute-entries** halves (the `$transaction([...])` array path *pulls*
   entries out of operations and merges them into one driver batch — the
   executor cannot own its envelope privately). It receives operations through
   the internal contract: `{ mode, planning(), compile(known), parse() }`.
4. **Fragment validator** (ATOM §9): unique ids; backward, fragment-local refs
   (statements *and* guard premises); outputs resolvable; probe/pin pairing
   present for every decision.
5. **Structural gates land now, as tests** (not at P6, and not byte-diffs —
   byte-identity gets waived on the first legitimate bug fix and then protects
   nothing): executor contains no operation-kind/relation-kind token and
   imports no concrete operation; adapters never construct a `Step`; the
   fragment module's exported *type surface* matches a checked-in snapshot;
   vocabulary is exactly `{read, write, guard}` + the census types.
6. Trivia: dedupe `getStepModelName`/`isRecord`; drop `forUpdate: true` from
   the stored batch guard probe.

*Gate:* re-cut slice tests (legal shapes — see P1) green on all five databases
including Docker, tx and forced batch; a deterministic **race test** (the
existing before-batch driver-hook technique): the create-branch loser surfaces
a `UniqueConstraintError` matching the `racePin`, never a guard abort; guard
flags unit-asserted per premise class.
*Kill signal:* none — obligation, not experiment.

## P1 — Composition: build-don't-select, the Part, the preflight, then freeze

**Goal:** the composition mechanism exists, validated on both contract
classes; the vocabulary census closes; **then** the freeze begins.

1. **Two slices, one per contract class**: (a) the existing extension slice —
   `create` + nested `upsert` (global lookup, adopt-and-update) — kept, but
   made honest: it validates through its new first-class create-input schema
   (P−1.2), never the update schema; (b) the **canonical parity slice** — `update`
   located by a **non-PK unique** (`where: { email }`; this is deliberate — the
   located parent id is then a *produced planning value*, not a compile-time
   literal, so its provenance is exercised at the compile-data boundary.
   [Correction: P1.1(b) originally justified the non-PK locate as forcing
   flattening technique #1 — a SQL-level probe→locate `Ref`. The delivered
   slice discovered the upsert family cannot construct one at any depth
   (V7001 observability + absent-parent resolution); see ATOM §8.1 design note
   (a). Technique #1's positive witness moves to P2a's hard-correlation nested
   reads. The non-PK locate still earns its place: it proves planning-value
   provenance, which a PK locate would inline away.]) +
   **correlated** nested to-many upsert by child unique, an atomic
   `increment` in the update arm, a deep terminal select. Exercises:
   planning-value provenance; probe-widening with the compile-time three-way
   incl. the typed uncorrelated-exists error; constraint + `racePin` on the
   missing arm; `exists` pin (`raceable: false`) on the found arm; `notFound`
   postcondition (run the missing-root sibling); planning-value vs
   produced-`Ref` provenance in the terminal read. Cheap negative sibling,
   same schema: two upserts targeting the same child unique — the preflight's
   typed "split these operations" rejection, so the *boundary* gets a witness
   too. Both slices must pass; (b) is the one the dual-run oracle certifies.
2. **`compile(known)` constructs the taken fragment** — the pre-frozen
   existing/missing pair dies. O(N) decisions, shared steps emitted once.
3. **The Part** — two functions, an interface, no hierarchy:
   `planning(scope): Step[]`, `compile(scope, known): Step[]`. Planning steps
   may ref earlier planning steps; probes are consumed through the
   `Probe` pairing (ATOM §2). The root part splices children around its own
   write by FK direction.
4. **The own-write preflight** is a named component of the scope: parts
   register write footprints during the build fold; overlapping decision reads
   reject with V1's typed "split these operations" error (ATOM §4). Ported
   from `OwnWriteLedger`'s analysis, not reinvented.
5. **The PendingOperation runtime contract**: a V2 operation implements
   `execute(driverOverride)`, `prepare()`, `prepareBatch(driver, sharedBatchContext)`,
   `parseResult()` — the seams the client's callback-transactions, caching
   flow, and array batching actually call. Built now so P2's oracle can drive
   V2 through a real client proxy.
6. **Census closes; freeze begins.** Every row of ATOM §8 dispositioned, no
   TBD — including the recursive-composition depth gate `update > upsert >
   upsert` (delivered: the middle upsert's found arm splices its correlated
   child parts) and technique #1's SQL planning→planning `Ref` (dispositioned
   *inert*, with its positive witness scheduled for P2a — a valid non-TBD
   disposition, not a deferred gate). From here, the fragment type-surface
   snapshot and executor token gate are the freeze — mechanically checked,
   amendable only with a design note.

*Gate:* both slices green everywhere (Docker named) — the extension slice
through its real schema, the parity slice through the dual-run oracle; two
same-model children under one parent (id-allocator proof); `upsert: [a, b]`
(either context) — plan snapshot shows shared steps once (the O(N) proof);
depth chain `update > upsert > upsert` (a depth gate with actual planning
reads — `create > create > create` has none and tests nothing); preflight
rejection scenarios green (the V1 conformance suite already contains them).
*Kill signal:* Part needs a third method; a part needs its parent
(`new Child(this)`); or a census row cannot be dispositioned without new
vocabulary — write the design note *before* the workaround.

## P2 — The write family, in three gated sub-phases

Each sub-phase extends the **dual-run oracle** (V1 arm vs V2 arm, fresh
instance per arm) and, from P2a, routes **per-tree**: if V2's validator accepts
the whole payload, V2 executes it (test/canary flag first); otherwise V1. Trees
route whole — one client call must never mix engines inside one atomic unit.
Three shared work items live in P2a because everything depends on them:
the **V2-backed client proxy** for oracle `act(client)` callbacks; the
**message catalog** — V1's typed error messages adopted verbatim (the behavior
suites assert byte-identical messages; every current V2 message differs); and
**staleness-injection tests** per premise class (the before-batch hook), since
the single-threaded oracle cannot observe raceability.

- **P2a — update family, FK edges** *(delivered)*: root `update` (generalized —
  any unique `where`, scalar data, with/without nested) and root `delete`; nested
  `connect`/`disconnect` on FK edges (to-many child-held as `RelationLinkPart`s;
  to-one parent-held folded into the root SET), composed as Parts; postconditions
  live (`notFound` on missing root row; `affectedRows` contracts); batch-mode
  `affectedRows` enforcement via an adapter-owned `exists` assertion inside the
  atomic unit (ATOM §8.1 note (b)'s deferral came due — reusing the existing
  guard vocabulary, **no fragment change**, freeze held). The three shared
  instruments landed here: the **V2-backed client proxy** (per-tree routing —
  supported tree → V2, else the real V1 path; one call never mixes engines), the
  **message catalog** (`messages.ts` — V1-verbatim strings sourced from V1's own
  builders), and the **staleness-injection** hook (per premise class). *Gate
  (met):* dual-run oracle parity for every P2a shape incl. error classes AND
  messages, fresh instance per arm; routing asserted by a route spy; structural
  gates + fragment snapshot untouched; **technique #1's positive witness** — the
  correlated disconnect probe carries a SQL `Ref` to the locate step, proven by
  an emitted-planning-fragment inspection test; per-premise-class staleness
  aborts typed, with the batch assertion and the injection each falsified once;
  all five DBs incl. the Docker mysql2/pg legs (pg serial).
- **P2b — upsert + connectOrCreate** *(delivered)*: probe-first per ATOM §2/§4.
  Root (top-level) `upsert` (`UpsertOperation`) locates by any unique `where`;
  absent → the create arm (constraint + `racePin`, never a guard); present →
  the update arm, unless a `targetWhere`/`setWhere` conditional does not match,
  in which case V1's silent no-op skip fires — pinned by the **retained
  `notExists`** guard (`raceable: true`, `absenceGuard`). Nested
  `connectOrCreate` (the update-less member of the adopt family, ATOM §6's
  worked trace) is delivered under `update` and as a create-arm child, reusing
  `RelationUpsertPart` with a `family` discriminator (found → pure connect,
  absent → create). The Pin Rule holds with its **exact scope** — pinned
  `exists` premises `raceable: false`; same-model-INSERT missing premises by
  constraint + `racePin`, never guarded; the retained `notExists`
  targetWhere/setWhere skip pins `raceable: true`. **Create-arm nested writes
  inside an upsert** (ATOM §8.1's P1 deferral) land here: the typed P1 rejection
  is replaced by the composed shape; the fresh child adopts globally (ATOM §4's
  elision), restricted to `connectOrCreate` one level deeper (V1's runtime
  rejects a nested `upsert` under a create payload as found-uncorrelated).
  **Dispositions (recorded, P2b report):** (1) the `ON CONFLICT` narrow door is
  **NOT** taken — root upsert is probe-first everywhere (no sequence burn, the
  pinned-abort error class is retained), so no oracle divergence to disposition.
  (2) `targetWhere`/`setWhere` scalar skip is an **extension scenario** (PLAN
  P−1.2), certified by fixed expectation + staleness + falsify, NOT V1 dual-run:
  V1's scalar-only upsert takes its `ON CONFLICT` fast-path where the skip does
  not reproduce (targetWhere no-match silently updates, setWhere no-match raises
  V9001); V2 implements V1's *intended* branch-runtime skip contract. (3) A V1
  defect was found and RECORDED (not fixed here, pre-routing): `upsert` with an
  atomic `increment` in the update arm generates ambiguous `ON CONFLICT` SQL
  (postgres 42702); V2's probe-first plain UPDATE handles it correctly, so the
  oracle uses plain `set` and the behavior suites prove V2's increment capability.
  *Gate (met):* dual-run oracle parity (create/update branches, connectOrCreate
  connect/create, create-arm create/adopt); the P0 race pattern extended to
  connectOrCreate (before-batch hook, deterministic convergence — loser surfaces
  the racePin-matched `UniqueConstraintError`, winner's row survives);
  per-premise-class staleness (connectOrCreate found premise, targetWhere/setWhere
  skip pins) each aborting typed, the targetWhere skip pin falsified once; per-tree
  routing spy-asserted for `upsert`; create-arm depth scenarios joined the depth
  oracle; structural gates + fragment snapshot untouched; all five DBs incl. the
  Docker mysql2/pg legs (pg serial).
- **P2c — nested update/updateMany/delete/deleteMany/set + createMany**
  *(delivered)*: the write family closes. Nested `update`/`delete` (correlated
  existence probe + leaf write, technique #1's `Ref` to the located parent) and
  `updateMany`/`deleteMany` (correlated bulk write, no probe) compose as
  `RelationWritePart`s — one write part, leaves differ (WHY §4.1); `set`'s
  departing-rows orphan guard is the **retained `notExists` pin**
  (`RelationSetPart`, `raceable: true`), its departing set a planning-time read
  inlined at compile (never crossing a write boundary — §3 corollary).
  `UpdateOperation` now composes multiple mutation kinds per relation.
  `createMany` (`CreateManyOperation`) is single-statement where dialects allow,
  the multi-statement **summed** `rowCount` via ordered fragment output source
  lists elsewhere (the SQLite plan), with `skipDuplicates` a plain SQL leaf on
  `sql`-strategy dialects and the savepoint-wrapped executor effect
  (`onUniqueConflict: "skip"`, reusing V1's `executeSkippableWrite`) on
  `recoverableUniqueError` dialects (MySQL) — the ONE dispositioned vocabulary
  row goes live (design note + snapshot + census, ATOM §8.1). **Batch
  disposition (recorded):** the skip effect has no atomic-batch lowering and
  fails closed there; MySQL runs it in tx mode, the `sql`-strategy batch path is
  proven on PGlite/SQLite/LibSQL. *Gate (met):* dual-run oracle grown to the FK
  conformance scenario set for nested update/updateMany/delete/deleteMany/set
  (V1-vs-V2, fresh instance per arm, state+result+error+message) and root
  createMany; staleness injection for the set orphan pin (a concurrently added
  required-FK child aborts the batch typed, the pin falsified once); per-tree
  routing spy-asserted (`createMany` and the nested trees to V2; a non-Unsupported
  V2 rejection recorded as a V2 route); structural gates green with the one
  deliberate `StatementStep` snapshot update; all five DBs incl. the Docker
  mysql2/pg legs (pg serial).

*Kill signal (all of P2):* the executor or frozen vocabulary needs an
operation-specific branch; or a kind cannot express itself as
probe-widened planning + linear steps. That is "rebuilding V1 under new
names" — stop, design note, deliberate decision.

## P3 — M2M, compound keys, the long tail of shapes *(delivered)*

Junction part (two FK edges + join-row leaf); membership semantics as leaves —
symmetric-difference `set`/`deleteMany` with **materialized-set pins,
`raceable: true`** (Pin Rule class 3); self-referential M2M; compound keys
(per-field refs); mapped columns; multi-item and mixed inputs.

**Delivered:** one `RelationJunctionPart` — junction as ordinary Parts, never an
`M2M*` file family (WHY §4.3) — serves every membership kind under a root
`update` (connect/disconnect/set/delete/deleteMany/update/updateMany, incl.
multi-item and mixed kinds under one relation), composing V1's frozen junction
SQL (`ManyToManyStatements`/`many-to-many-utils`) as its leaves. Membership reads
are planning-time and inlined at compile (`deleteMany`'s connected set never
crosses a write boundary; §3 corollary); its added/removed difference guards are
the retained materialized-set `notExists` pins (`raceable: true`). Self-ref A/B
direction reuses `getManyToManyJoinInfo` (raw junction-row inspection test).
Nested `create`/`connectOrCreate`/`upsert` under a M2M target keep V1's
create-through-junction runtime (typed `UnsupportedOperationError` → whole tree
routes to V1). Compound keys are per-field: root `update`/`delete`/`upsert` by
compound where-unique (every PK field a `firstRowField` produce), compound child
FK connect/disconnect writing every column per-field; compound-FK
`set`/`update`/`delete`/`upsert` route to V1. Mapped columns ride through the
reused builders. **No vocabulary change — the fragment snapshot + executor token
gate stayed green (freeze held); see ATOM §8.1 P3 update.**
*Gate (met):* dual-run oracle parity (V1-vs-V2, fresh instance per arm,
state+result+error+message) for the M2M scenario set (`m2m-mutation.test.ts`),
the self-ref direction test, and the compound-key set (`compound-key.test.ts`);
the Docker-shaped staleness scenario (a concurrently-added member trips the
`deleteMany` materialized-set pin typed+raceable, a rerun converges — falsified
once); per-tree routing spy-asserted (M2M/compound trees to V2, the
create-through-junction shapes to V1); structural gates + fragment snapshot
untouched; PGlite tx + forced batch both substrates; full suite green.
*Kill signal (none tripped):* an `M2M*` file family forming, or a membership set
needing to cross a write boundary at runtime (ATOM §3's stated boundary).

## P4 — Reads and the remaining surface *(delivered)*

`find*`(+OrThrow), `count`, `aggregate`, `groupBy`, `exist`: genuinely
single-statement operations wrapping V1 builders — this part *should* be
boring, and its kill signal is any read needing more than one step. Explicitly
**not** boring, budgeted here by name: the `*AndReturn` variants on
non-returning drivers (`mutation-identity` pre/post reads and the
`requiresAtomicResolution` typed refusal kept as contract per ATOM §7) and
`updateMany`/`deleteMany` `rowCount` results.
*Gate:* full behavior-suite matrix through the routing flag for every migrated
operation, all driver classes, Docker named.

**Delivered:** every read is one `ReadOperation` (empty planning + one read step
reusing the V1 read builders + `ResultParser`); the kill signal never tripped.
`OrThrow` is a typed `notFound` surfaced from the result (byte-identical to V1's
`NotFoundError`, carrying the original `…OrThrow` operation name). Root
`updateMany`/`deleteMany` return `{ count }` via the `rowCount` source
(`BulkCountOperation`, one write step). `createManyAndReturn`/`updateManyAndReturn`
(`ManyAndReturnOperation`, one file, two leaves — WHY §4.1) make the census's
**ordered source list whose rows concatenate** live (per-row `INSERT … RETURNING`
on returning drivers; interleaved `INSERT`+`lastInsertId()`-refetch on
non-returning MySQL — the mutation-identity technique) and the `DerivedValue`
disposition live (`updateManyAndReturn` non-returning re-reads by the post-update
PKs). The `requiresAtomicResolution` refusal is **kept as contract** (ATOM §7):
byte-identical `TransactionError` on a batch-only non-returning driver, proven by
running V1 and V2 through one engine; `createManyAndReturn skipDuplicates` on a
non-returning driver is the one inexpressible sub-shape and is an honest per-tree
route to V1 (distinct from the refusal).

**Delivered-scope corrections (reality vs. plan text):**
1. *Driver reality narrows the non-returning surface.* Only MySQL is
   non-returning **and** it supports transactions, so the mutation-identity
   refetch always runs linearly in a transaction; the `requiresAtomicResolution`
   refusal is only reachable on a batch-only non-returning driver (D1/neon-http
   class), which the natural matrix never routes to V2. It is proven by a
   constructed batch-only-MySQL driver (no I/O — the refusal precedes it).
2. *`createManyAndReturn skipDuplicates` on non-returning routes to V1.* A skipped
   INSERT would refetch a pre-existing row, which the linear-steps model cannot
   express; V2 declines the shape (`UnsupportedOperationError` → V1). Returning
   drivers keep it (the skip is a `RETURNING`-empty SQL leaf).
3. *Reads dual-run on ONE seeded database.* Because a read has no side effect,
   the V1 and V2 arms read a single seeded instance (a stricter check than two
   copies, and the only shape that works for shared-database drivers). The
   forced-batch read arm binds a batch-mode driver to the same database.
4. *No vocabulary change.* The `OperationFragment.ts` snapshot + executor token
   gate stayed green; `StatementStep.onUniqueConflict` remains the only executor
   effect annotation (the orchestrator's watch-item — no second one formed).

## P4.5 — absorbing the last routes *(delivered)*

**Goal:** absorb the remaining V1-routed write shapes so that after this phase
exactly ONE deliberate route to V1 remains — pinned by a test, not prose, for the
P6 deletion accounting.

**Delivered:** the two write-shape routes the P4 report tracked as remaining
(`routedToV1StillRemaining`) are gone. No vocabulary change (the `OperationFragment.ts`
snapshot + executor token gate stayed green — the **freeze held**; see ATOM §8.1
P4.5 update); no new file family (WHY §4.3's `M2M*` kill signal never tripped).

1. **M2M create/connectOrCreate/upsert through the junction** join
   `RelationJunctionPart` as three more kinds (create/connectOrCreate/upsert),
   composing V1's frozen junction SQL (`ManyToManyStatements`/
   `ManyToManyMemberships` leaves) exactly as the P3 membership kinds do:
   - *create* — INSERT child (scalar-only) + INSERT join row; no probe.
   - *connectOrCreate* — an uncorrelated global probe (technique #2): found →
     idempotent join (pinned `raceable: false`, V1's `Record was replaced …`);
     absent → create + join (constraint + `racePin`, never a `notExists` guard).
   - *upsert* — a membership probe + a global probe decide the correlated
     three-way (V1's `ManyToManyMutations.upsert`): member → update
     (membership `exists` guard, `raceable: false`); globally-existing non-member
     → V1's verbatim V7001; absent → create + join.
   Duplicate array targets deduplicate **at compile** (an earlier item's created
   target makes a later same-target item adopt/update it) — V2's flat realization
   of V1's sequential branch-ledger merge (DESIGN §6.2), so the "dedupe" oracle
   scenario flips to V2. The join row's child PK is a compile-time literal the
   create data carries; an auto-generated M2M child identity stays V1's (a
   documented bound, routed at construction, never reached by a current schema).
2. **Compound-FK nested writes** (`set`/`update`/`updateMany`/`delete`/
   `deleteMany`/`upsert`/`connectOrCreate` on a child-held compound FK, and a
   **D4-style** edge referencing a non-PK unique) are the per-field
   generalization of P3's `RelationLinkPart` precedent, shared by
   `RelationWritePart`/`RelationSetPart`/`RelationUpsertPart` through one
   `parent-reference.ts` value resolver: every child FK column is
   written/correlated from its index-aligned parent referenced column.
   `UpdateOperation`'s locate read now selects and exposes every referenced column
   (PK, a PK subset, or a non-PK unique) as a `firstRowField` output, so the D4
   edge's non-PK reference resolves like any other. The P3 compound-arity routes
   are removed.
3. **Route flips + new oracle scenarios.** The two `route: "v1"` M2M oracle
   scenarios flip to V2 (byte-identical state+result+error); new dual-run
   scenarios cover M2M create/connectOrCreate/upsert (single, multi, mixed,
   mapped columns, implicit junction, the V7001 reject) and compound-FK
   set/update/delete/upsert/connectOrCreate + D4 connect/update. Two new adopt
   premises (connectOrCreate found, upsert member — Pin Rule class 1) each get a
   before-batch staleness-injection test, each falsified once; the V7001 throw
   falsified once.
4. **Route inventory.** `route-inventory.test.ts` runs every previously-routed
   shape through V2 construction and asserts the set that still routes is EXACTLY
   `['createManyAndReturn skipDuplicates on non-returning drivers']`.

**Delivered-scope corrections (reality vs. plan text):**
- *Duplicate connectOrCreate/upsert targets are expressible, not a route.* The
  work order flagged the "dedupe duplicate targets" scenario to flip; the reality
  is that V2 CAN produce V1's dedup result via a compile-time merge (mirroring
  V1's branch-ledger sequencing), so it flips to V2 rather than staying a route.
- *Auto-generated M2M child identity is a narrow documented bound.* M2M
  create-through-junction where the child PK is NOT carried in the create data
  (an auto-increment/ULID identity) needs a produced value for the join row —
  still V1's runtime. No current test schema hits it (all M2M targets carry
  provided PKs), so the route inventory over the reachable corpus is exactly one;
  the bound is documented, not counted as a reachable route.

*Gate (met):* dual-run oracle parity (fresh instance per arm, tx + forced batch,
state+result+error class+message) for every absorbed shape; per-tree routing
spy-asserted (all absorbed trees to V2); the route-inventory assertion; two new
staleness pins each falsified once, plus the V7001 throw; structural gates +
fragment snapshot untouched; full matrix incl. the Docker mysql2/pg legs.

## P5 — Default flip and the parity soak

The seam has existed since P2a; P5 is turning it on for everyone and proving
nothing regressed. Preserved-by-test, explicitly: callback
`$transaction`/`executeWith` driver threading; the cache flow's `prepare()`
single-statement seam; `$transaction([...])` array batching through the shared
batch-context protocol (one merged driver batch, shared scratch setup, guard
index re-attribution); instrumentation shape; error taxonomy incl.
`meta.raceable`; write-race retry above the executor, matching violations
against `racePin`.
*Gate:* entire estate green with routing defaulted ON — full local suite, all
Docker suites, concurrency suites; benchmarks within noise of V1 (numbers
recorded either way, PERF.md precedent).
*Kill signal:* any behavior contract weakened to route — adoption-standard
failure by definition.

### P5 delivered — seam ON, soak surfaced conflicts (NOT clean-green)

The routing seam is built into production and default-ON: `client.ts` dispatches
through `PendingOperation.createRouted` → `routing.ts` (`constructRoutedOperation`
+ `executeRoutedOperation`) → the V2 `OperationExecutor`, obeying the P2a proxy's
routing law. The single migration-temporary escape hatch is the **`queryEngine:
"v1" | "v2"`** client option (default `"v2"`); it exists only for the soak's A/B
and the rollback story and is **scheduled for deletion in P6** (when V1's
operation/execution root is removed and routing becomes unconditional). The write-
race retry lives above the executor (`executeRoutedOperation`), byte-for-byte V1's
one-retry policy. `race-retry.ts` ports V1's `markRetryableRace`/`isExplicitProgramRace`.

The six preserved contracts pass and are falsified (`p5-flip-contract.test.ts`):
callback-tx + `executeWith` driver threading with rollback; the cache
single-statement `prepare()` seam; `$transaction([...])` one-merged-batch +
mid-array abort; instrumentation event shape A/B; error taxonomy incl.
`meta.raceable`; write-race retry both directions. The V2 oracle is 325/325 and
the structural gates are green — the freeze held (no `OperationFragment.ts`
change).

**The gate ("entire estate green … benchmarks within noise") is NOT met.** The
parity soak — the first full run of the V1 conformance corpus against V2 — found
genuine divergences, recorded as conflicts (never softened, never routed away,
never pinned-to-V1-to-hide): returning-driver nested-write edges (PK-transition
FK mis-order; disjoint-decision over-rejection), a split-witness race-safety gap,
the batch-only non-returning `requiresAtomicResolution` refusal (message), and
several invalid-payload rejection message/coverage gaps. Real MySQL is 467/468,
Docker Postgres is at its 407/14 baseline — V2 is behaviorally close on real
drivers; divergences concentrate in the PGlite conformance/internals corpus, and
a subset of those assert V1-internal statement mechanics rather than observable
behavior. Benchmarks (PERF.md P5) show a write-path regression (upsert 1.84×,
scalar update 2.37× slower) from plan-then-execute's extra round-trips. See the
P5 report and ATOM §8.1 P5 note for the itemized conflict list. **P5 stops at the
phase boundary with the oracle green: the divergences and the regression must be
closed before the default flip is declared production-clean.**

### P5 fix round 1 — safety gap + tractable behavior conflicts closed

Adversarial review flagged the split-witness race as a **blocking** safety
regression in the default engine, plus behavior divergences and the write-path
regression. Round 1 closes the safety gap and the tractable behavior conflicts
with no vocabulary change (freeze held; V2 oracle 337/337, gates green):

- **Split-witness race-safety — CLOSED.** V1's captured-PK+selector correlation
  ported into every nested targeted mutation (`RelationWritePart` /
  `RelationSetPart` / `RelationJunctionPart`): the write addresses the captured
  PK, and the batch guard requires selector ∧ captured-PK on one row, so a
  concurrent selector-move fails closed instead of acting on the replacement.
- **Non-PK referenced-key arithmetic — CLOSED** (V1's `assertRelationKeyUpdates-
  AreCompilable` ported into `UpdateOperation`).
- **Non-returning no-op count acceptance — CLOSED** (exact-affected is a
  returning-driver check; existence proven by the locked locate).
- **Nested/top-level PK-arithmetic message parity — CLOSED** (V1's
  `assertPortablePrimaryKeyUpdateInput` run at construction; float-PK /
  divide-by-zero byte-identical).
- **Batch-only non-returning refusal — REBUTTED, not a clean fix.** A blanket
  constructor refusal breaks 31 batch-execution behavior tests (MySQL 467→437):
  V2 deliberately executes non-returning upsert/update/delete in a forced batch
  (result via an in-batch terminal `SELECT`), unlike `*AndReturn` which genuinely
  refuses. Adopting V1's blanket refusal regresses those contracts — the kill
  signal. Recorded as a conflict (report `fixRound1.rebuttals`); MySQL back to
  467/468.

Still open for a dedicated round (named in the P5 report and ATOM §8.1): the
RETURNING fast path (perf), the non-returning upsert omitted-generated-PK
capture, two returning-driver nested-write edges (PK-transition + self-M2M order;
child-held `connectOrCreate` dedup), the batch-only-refusal conflict, and a
residue of V1-internal statement-mechanics/message assertions the minimized atom
does not reproduce. **The default flip remains not production-clean** until the
perf fast path and the returning-driver edges close.

### P5 fix round 3 — the RETURNING fold, the routed-layer refusal, captured-PK convergence

Round 3 closed the write-path regression's mechanism and four more conflicts, all
by convergence (no vocabulary growth; freeze held; V2 oracle 337/337; gates 22/22):

- **RETURNING fold (finding 4) — DONE.** A simple scalar `update` (no nested
  relation mutation, scalar-only projection, returning driver, tx mode) folds
  locate+mutate+terminal into ONE `UPDATE … WHERE selector RETURNING select`
  (V1's `compileDirect`) — statement-atomic, no envelope. `upsert`'s update arm
  folds its terminal refetch into `UPDATE … RETURNING` too, keeping the
  probe-first locate (ATOM §4 keeps `ON CONFLICT` off the table). The executor
  runs a statement-atomic op directly (`statementAtomicPlan`/`runStatementAtomic`).
  **Reads and `updateMany` are now at ±10% parity** (the P5 report's read
  regression was single-run noise); **`scalar update` (≈1.2×) and `upsert`
  (≈1.4×) still miss ±10%** — the statement-count gap is closed, the residual is
  V2's eager per-call construction (and, for upsert, the ATOM §4 locate). Honest
  miss, mechanistically explained, PERF.md P5 round 3.
- **Batch-only non-returning refusal (finding 3b) — CLOSED at the routed layer.**
  `constructRoutedOperation` (public client path only) throws V1's byte-identical
  `requiresAtomicResolution` `TransactionError` for `update`/`delete`/`upsert` on
  a batch-only non-returning driver. The executor keeps the in-batch capability
  the 31 direct-executor batch contracts depend on — the round-1 rebuttal's
  concern — because those construct the operation directly, never through the
  router. **Docker MySQL 467→468/468.** Falsified.
- **Omitted-generated-PK capture (finding 3c part 2) — CLOSED.** `defaultSelect`
  uses `getDefaultScalarFieldNames` (respects `.omit()`), so a non-returning
  upsert create branch returns the public shape without the internal generated PK.
- **Top-level update/delete address the captured PK — CONVERGED.** The non-fold
  tx-mode root `update`/`delete` mutate by the PK captured at the FOR UPDATE
  locate (V1's `WHERE id`), not the original alternate-unique `where`; batch mode
  keeps the `where` so the write and its presence guard pin one row.
- **Executor prose neutralized.** The statement-atomic fast-path comments were
  reworded operation-neutral (the token gate is right: the executor stays
  semantics-free in prose too); gates back to 22/22.

**Still open, honestly (6 local tests) — NONE weakened, skipped, or pinned:**
one **frozen-vocabulary boundary** (`maximumAffectedRows` — V2 rejects a
malformed >1 affected-row count only by growing the FROZEN postcondition
vocabulary, which is *the* kill signal; physically unreachable on a `WHERE`-PK
write, so V2's observable behavior is correct); two **returning-driver
nested-write edges** (PK-transition + self-M2M write order; child-held
`connectOrCreate` first-create-wins dedup — both need cross-part write-ordering
the one-part-per-item shape lacks); one **disconnect-array dedup** (V2 emits one
statement per target vs V1's deduped set — observably idempotent); and two
**validation message/ordering** ports (`deleteMany`-on-to-one needs
validate-whole-args-before-parse like V1; empty batch `createMany` needs
execution-context awareness). The estate is 6008 passed / 6 failed local, Docker
MySQL 468/468, Docker Postgres 407 passed. **The gate ("entire estate green") is
not literally met**; the residue is a documented architectural boundary
(vocabulary freeze) plus deep cross-part coordination, recorded rather than
forced. V2 converged on V1's *behavior*; the misses are statement-mechanics,
frozen-vocabulary, and two returning-driver ordering edges.

### P5 fix round final — the gate is MET (four fixes, two maintainer decisions)

The closing round shut the four remaining V2 behavior/validation divergences by
convergence (freeze held; `OperationFragment.ts` untouched; gates 22/22; V2 oracle
337/337), and the maintainer recorded two decisions that resolve the residue
honestly rather than by growing the frozen surface. **The estate is now entirely
green under the default V2 flip: full local suite 0 failures, Docker MySQL
468/468, Docker Postgres 407 passed (serial). The gate — "entire estate green with
routing defaulted ON" — is MET.**

The four fixes (each falsified):

- **PK-transition + self-M2M write order — DONE.** When a root `update`'s SET
  rewrites a child-referenced column (a PK transition `id: 2`, or a literal on a
  non-PK referenced unique), the root parent UPDATE is emitted AFTER the child
  edge writes. The child edges are written against the parent's pre-transition id,
  and the FK's `ON UPDATE CASCADE` carries them to the new value; emitting the
  root UPDATE first stranded a self-M2M junction row on the vacated id
  (`ForeignKeyError`). Correlation of existing membership stays on the
  pre-transition value — the row holds the old FK until the cascade fires
  (`UpdateOperation.reorderRootUpdateAfterChildren`).
- **`connectOrCreate` first-create-wins dedup — DONE.** A fixed-order compile-time
  ledger over the sibling items' target PKs (the child-held analogue of the M2M
  junction's runtime `created` set): a duplicate connectOrCreate item adopts the
  earlier create (idempotent reparent, no found guard) instead of re-inserting its
  PK (`RelationUpsertPart.duplicateOfEarlier`).
- **`deleteMany`-on-to-one ordering/message — DONE.** `UpdateOperation` now runs
  V1's whole-args `args.update` validation BEFORE `separateData`'s relation
  parser, so an unknown nested key rejects "Unknown key: deleteMany" (V1's
  message, before the parent mutation) instead of V2's later "not supported for
  to-one relation".
- **empty batch `createMany` — DONE.** An `assertBatchPreparable` hook on the
  executor's batch-preparation seams (never the direct linear path) lets an empty
  `createMany` throw V1's byte-identical "No data to insert for createMany." when
  lowered into a `$transaction([...])` array, while a DIRECT empty `createMany`
  stays Prisma's documented `{ count: 0 }` no-op — execution-context awareness.

**Maintainer decisions (this session — each authorizes precisely what it names).**
Two tests assert V1-internal mechanics rather than observable behavior, and
reproducing them in V2 would grow the frozen surface. The maintainer authorized
retargeting each to the frozen V1 runtime (`queryEngine: "v1"`), with an
authorization comment at the site; both **die with V1 at P6**:

- **Class B(1) — `maximumAffectedRows` (frozen-vocabulary boundary).**
  `non-returning-mutation-atomicity` "rolls back malformed single-mutation
  affected-row counts" asserts V1's defensive rollback of a *physically
  unreachable* `count > 1` on a `WHERE`-PK write ("expected at most one"). V2
  rolls the batch back too (observably correct); reproducing V1's exact message
  needs a `maximumAffectedRows` postcondition — growing the FROZEN vocabulary,
  which PLAN "what failure looks like" names as *the* kill signal. Retargeted to
  V1, not absorbed.
- **Class B(2) — disconnect-array statement count.**
  `nested-single-mutation-identity` "explicit disconnect arrays lock and update
  every captured PK separately" asserts V1's deduped statement count (2 UPDATEs,
  not 3, for a repeated target). V2's shape is observably idempotent with
  identical final state; the deduped count needs cross-part coordination the
  one-part-per-item atom lacks. Retargeted to V1.

- **Class C — write-path perf misses ACCEPTED (deliberate trade-off, deferred).**
  The maintainer accepts `scalar update` (~1.37×) and `upsert` (~1.39×) exceeding
  the ±10% A/B gate as a deliberate trade-off for now. Mechanism: after the P5
  round-3 RETURNING fold closed the statement-count gap (reads and `updateMany`
  are at parity), the residual is V2's fixed per-call construction cost
  (`buildUpdate` + own-write preflight + schema parse) — dominant only on
  in-memory SQLite's ~20 µs round-trip, noise on any networked driver; `upsert`
  additionally keeps its probe-first locate (ATOM §4 keeps `ON CONFLICT` off the
  table). Recorded in PERF.md P5. **Optimization is deferred as a named backlog
  item ("V2 per-call construction cost on in-memory drivers"), NOT part of the P5
  gate.**

The kill signal held throughout: no behavior contract weakened, no test skipped
or pinned-to-V1-to-hide a divergence, messages byte-identical, `OperationFragment.ts`
frozen (snapshot + token gates green), the 36-throw-site route tripwire unchanged,
no new effect annotation. The `queryEngine: "v1"` escape hatch is still scheduled
for deletion in P6.

## P6-prerequisite — the create family

**Why this phase exists (the blind spot).** The first P6 attempt correctly
BLOCKED before any deletion: its premise — "exactly ONE route to V1 remains" —
was false. The **`create` family, the largest write family, was never migrated**.
It fell back to V1 by *omission* from `routing.ts` `ROUTED_OPERATIONS`, and the
route-inventory pin could not see it: that pin counts `UnsupportedOperationError`
throw-sites, and a family that falls back to V1 by omission produces no throw.
`CreateOperation.ts` was the P0/P1 nested-upsert **proof slice** (it threw unless
the payload was exactly `create` + one nested to-many `upsert`); every real
`create` ran V1's `OperationRuntime`/`OperationCompiler`/`WriteOperations` — the
Stage-3 delete targets. Deleting V1's root would have broken every create and
80+ test files. Both P6 reviewers demanded this phase plus a positive
full-surface routing assertion; the P6 fix-round-1 commit added the assertion
(`DOCUMENTED_V1_FALLBACK = {create}`) and made emptying it the P6 precondition.

**What closed it.** `CreateOperation` is generalized to the full surface (root
scalars/defaults/generated + known PKs, select/include, the `INSERT … RETURNING`
fold; the whole nested tree — nested `create`/`createMany` via
`buildCreateManyPlan`, `connect`, `connectOrCreate`, the P−1.2 `upsert` superset,
M2M through the junction, parent-held to-one `connect`, compound-FK children,
self-relations, depth). `create` is added to `ROUTED_OPERATIONS` +
`constructOperation` (production **and** the oracle proxy). Fresh-parent elision
(ATOM §4) is the central technique and is now positively witnessed (ATOM §8.1
P6-prerequisite update); the only non-elided pins are the two `connect`-target
premises, each falsified once. The dual-run oracle (`create-family.test.ts`,
21/21) certifies V1 == V2-tx == V2-batch byte-identical over the surface plus the
extension-scenario class (V1 rejects `upsert`-under-create; V2 adopts).

**The full-surface routing assertion (the reviewers' demand).**
`route-inventory.test.ts` now enumerates all 18 client operation families with a
compile-time completeness guard, asserts each either constructs on V2 or is a
listed `DOCUMENTED_V1_FALLBACK` (now **EMPTY**), and proves `create` constructs on
V2 by construction. Falsified: removing `create` from `ROUTED_OPERATIONS`
re-opens the by-omission hole and fails both the emptiness and the
by-construction assertions. **P6's deletion precondition is now MET** — no family
falls back to V1 by omission.

**Adoption-standard conflicts from the full-estate soak (recorded, not hidden).**
The first full-suite run of the V1 corpus against V2-routed `create` surfaced 14
divergences. Six were genuine bugs, fixed to convergence (empty default
projection → `{}`; heterogeneous nested `createMany` grouping; the V7006
un-attributable-abort floor; shared-PK connect and M2M upsert-under-create routed
to V1 at construction). Eight were **SYNTHETIC-DRIVER or V1-INTERNAL-mechanics**
tests, each retargeted to the frozen V1 runtime (`queryEngine: "v1"`) with an
inline authorization comment — the Class-B pattern established at P5:

- **`m3-create-family-interpreter` (3)** — spies on `RelationMutations.compileCreate`;
  asserts create compiles through V1's `OperationProgram`. V2 owns create and
  never calls `compileCreate`. Tests V1's frozen compiler; dies at P6.
- **`batch-transaction` (3)** — merges a GENERATED-ID create (insertId scratch)
  into a SHARED cross-operation `$transaction([...])` on a synthetic batch-only
  driver. No real backend is batch-only (`$transaction` runs in tx mode on all of
  them, where V2 create is certified); V2's shared-batch protocol does not thread
  insertId scratch across the operation-merge offset.
- **`non-returning-mutation-returns` (1)** — a generated-PK create on a synthetic
  Postgres-forced-non-returning driver that surfaces NEITHER `RETURNING` nor
  `result.insertId`. No production driver is such (real non-returning MySQL
  surfaces insertId; V2 passes Docker MySQL 468/468). V1 refetches by
  `adapter.lastInsertId()`; only that works on this fabricated driver.
- **`result-contract-regressions` (1)** — asserts V1's batch-refetch cardinality
  META (`expectedRowCount`/`actualRowCount`) on a synthetic malformed-batch
  fault-injection driver; expressing that meta would grow the FROZEN `Failure`
  vocabulary (the kill signal).

No behavior contract was weakened, no test skipped or pinned-to-V1 to *hide* a
divergence: real drivers pass (Docker MySQL 468/468, Postgres 407), the retargets
assert V1's exact mechanics on fabricated drivers, and all die with V1 at P6. The
`OperationFragment.ts` surface stayed frozen (snapshot + token gate green); the
one generic executor change (the V7006 floor) is census taxonomy, not a branch.

## P6-prerequisite 2 — the decline surface

**Why a SECOND prerequisite, and why two blocked P6s were needed to see it.** The
"precondition is now MET" claim above is true only at the FAMILY level: every
client operation is in `ROUTED_OPERATIONS`, so nothing falls back to V1 *by
omission*. Both P6-deletion attempts nonetheless blocked at Stage 0, on a hole the
family-level assertion structurally **cannot see**: a family constructs on V2 for
the shapes V2 owns and declines the rest with `UnsupportedOperationError` (a route
to V1 *by decline*). 49 such throw sites remain, and a large subset route
**accept-and-execute** shapes — payloads V1 runs correctly today. Family-level
routing is a coarse instrument; the decline is a *shape*-level fact, and only a
shape-level probe finds it. **The probe:** disable the router's V1 fallback and
run the nested-write conformance estate — **56 tests fail, 49 on the
accept-scenario `expected true to be false` pattern.** That is reachable client
behavior living behind the fallback: V1 is executing it now, and is **not
deletable**.

**What this prerequisite delivered (and where it deliberately stopped).**

- **Absorbed (clean, certified): child-held one-to-one `create`.** Direction, not
  arity, is what the create tree keys on — a child holding the FK INSERTs after
  the parent with `fk = parent`, so a to-one is the arity-1 case of the
  already-certified child-held path (the one-to-many-only type guard widened to
  one-to-one). The create-family oracle certifies V1 == v2-tx == v2-batch; the
  mixed-directions conformance scenario now executes on V2.

- **A documented boundary, NOT absorbed (kill signal, with a falsified proof):
  parent-held to-one `create`.** Its before-parent-write ordering is expressible in
  the atom in isolation (the target INSERTs first, its identity flows into the
  parent FK by a backward `Ref`). But absorbing it standalone *weakens an
  accept-and-execute contract*: in `record.create({ primary: { create: { id: 2 } },
  secondary: { connect: { id: 2 } } })` the sibling `connect` must observe the
  just-created target, which V1's staged runtime does and V2's flat plan-then-
  compile (probe runs at planning, before the write) cannot — and V1 *accepts* the
  shape, so V2 rejecting it would also diverge. This is the ATOM §4 own-write
  boundary; closing it needs the own-write before-parent ledger (modeling a nested
  create's target as a write a sibling read may depend on) — P-phase-sized, and
  converting the shape to a refusal is the kill signal. It stays routed.

- **The invariant: `decline-surface-gate.test.ts` (in `test:gates`).** It runs the
  absorbed create shapes with the V1 fallback DISABLED (`setV1FallbackDisabled`, a
  hook inert in production) and they pass on V2 (falsified once by re-narrowing the
  guard); and it pins `FALLBACK_CARRYING_RESIDUAL` — the reachable accept-and-
  execute shapes still declining (parent-held to-one `create`/`connectOrCreate`,
  inverse-side to-one ops, nested-relation upsert arms). This is P6's premise made
  machine-checkable: **P6 may bulk-delete V1 only when that residual is empty.**

**The residual is the write migration P6 waits on.** The 56 fallback-disabled
failures concentrate outside `create`: inverse-side to-one ops
(connect/connectOrCreate/update/upsert/disconnect/delete on a child-held to-one
through the parent), parent-held to-one `create`/`connectOrCreate` under both
create and update roots, top-level and nested-relation upsert arms, and the
own-write "disjoint decision" family under update roots. Each needs the own-write
before-parent ledger and/or the inverse-side/nested-arm composition the atom
permits but has not yet grown a consumer for. No `OperationFragment.ts` change, no
new step kind / Part method / executor branch was made here (the freeze held); the
absorption is a widened type predicate and the gate is an executor-neutral test
hook. **V1 is not deletable; P6 stays blocked pending this residual.**

## T1 — the to-one family under create roots *(delivered)*

The migration is ordered FINISHED (V1 dies at P6). The ~55 to-one relation-write
scenarios that reach V1 only through the decline fallback are being absorbed in
three threads (T1 create roots, T2 update roots, T3 upsert arms + D4 + parity
refusals + the full-estate gate). **T1 closes the create-root portion — including
the recorded P6-prereq-2 kill-signal incident.** The design note `TO-ONE.md`
(written and committed *before* any absorption code) is normative for the to-one
write model; this section records the delivery.

**The absorption unit is the tree class, not the throw site** (the P6-prereq-2
cautionary tale). The coupled unit is "parent-held to-one arms under a create
root": `create`, `connect`, `connectOrCreate`, and every same-record sibling
combination, landed **together** — because a sibling `connect` observing a
before-parent `create` cannot be absorbed one arm at a time without wrong sibling
semantics.

- **Parent-held to-one is a before-parent write** (TO-ONE.md §1.1): the target
  INSERTs first, its identity `Ref`d backward into the record FK — ATOM §6 with the
  FK direction reversed. `create` / `connect` / `connectOrCreate` all construct on
  V2. Depth (a before-parent target with its own child-held children), self-
  referential parent-held, generated and provided target PKs are covered.

- **The incident is closed by a construction-time coverage ledger** (TO-ONE.md §2),
  the "own-write before-parent ledger" P6-prereq-2 named. A before-parent `create`
  is unconditional and its target key is a compile-time literal, so a sibling
  `connect` observing it is decided by reading the payload — a `Set`, not a staged
  DB read. A covered connect is a pure FK assignment (no probe, no guard, no pin;
  existence is our own write inside the atomic envelope), order-insensitive,
  matching V1. `to-one-create-family.test.ts` carries the incident as a **named
  regression witness** (forward + reversed order), V1 == v2-tx == v2-batch.

- **The create-root ledger is scoped to `CreateOperation`.** V1 accepts the sibling
  create-then-connect under `create` (group-0 `currentHoldsFk` analysis) but
  **rejects** it under `update` (one undivided own-write group); that split already
  flows through `OwnWritePreflight` (create vs update), so T1 does **not** port the
  ledger to `UpdateOperation` — T2 inherits the reject. Porting it would convert a
  V1 rejection into acceptance (a kill signal).

- **Pins** (TO-ONE.md §3): `connectOrCreate` FOUND = existing-row `presenceGuard`
  (`raceable: false`); MISSING = constraint + `racePin` (`raceable: true`); a
  before-parent `create` = none. Each falsified once (found-arm staleness;
  missing-arm concurrent-create retry-and-adopt; the coverage ledger disabled → the
  incident's "target record was not found").

- **Gate accounting moved together.** `parent-held to-one create` left
  `FALLBACK_CARRYING_RESIDUAL` for the decline-surface gate's absorbed slice
  (fallback OFF); the residual is the remaining UPDATE/UPSERT-root to-one surface
  (T2/T3), still non-empty. Route-inventory tripwire 49 → 51 (the single "supports
  only 'connect'" decline removed; shared-PK / non-referenced-unique / wrong-kind
  boundaries stay documented routes — a to-one `connect` by a non-referenced unique
  and a shared-PK parent-held edge remain V1's, deliberately). The
  `OperationFragment.ts` surface was **unchanged** — the freeze held, no new step
  kind / Part method / executor branch (the ledger is a plain `Map` in the Part
  constructor). **V1 stays reachable; P6 waits on T2/T3.**

## T2 — the to-one family under update roots *(delivered)*

**T2 closes the update-root portion.** The design note `TO-ONE.md §7` (written and
committed *before* the absorption code) is normative; this section records the
delivery. The absorption unit is again the tree class ("to-one arms under an update
root"), but the coupling that made T1's arms inseparable is **absent** here — the
own-write preflight and per-tree routing enforce coherence, not a coverage ledger.

- **The one structural difference is that the parent EXISTS** (located first,
  FOR-UPDATE). §4's fresh-parent elision does not apply, and the parent-held FK
  write is the **root parent UPDATE**, not an INSERT fold (TO-ONE.md §7.0). A
  parent-held `create`/`connectOrCreate` writes the target ahead of the root UPDATE
  (`UpdateOperation`'s new `beforeRootWrites` phase) and the UPDATE's SET absorbs the
  FK — a `Ref` (create / connectOrCreate-missing) or a compile-decided literal
  (connectOrCreate-found). This is V1's `updateParentForeignKey`. Scalar-only target
  creates land; a nested-relation target create is V1's `appendCreate` recursion (a
  documented route).

- **The coverage ledger is NOT ported** (TO-ONE.md §7.0.3). V1 gives `update` one
  undivided own-write group, so a sibling `connect` observing a sibling `create` is a
  rejected own-write — porting the ledger would flip that rejection into acceptance
  (a kill signal). Each parent-held arm is independent; the sibling create-then-connect
  under update is a REJECT-parity oracle witness, disjoint create+connect an
  ACCEPT-parity one.

- **The inverse-side one-to-one is the arity-1 child-held path** (TO-ONE.md §7.0.1).
  The child-held type guard widens from `oneToMany` to `oneToOne` (the same widening
  T1 made for create), reusing `RelationLinkPart` / `RelationWritePart` /
  `RelationUpsertPart` verbatim, plus an **optional** unique `where` on
  `RelationWritePart` for the correlated to-one `update` (correlation is the whole
  locator). `connect` / `connectOrCreate` / `disconnect: true` / `delete: true` land;
  steal/orphan is the DB unique constraint's (V1's call). The nested `upsert` arm
  stays routed (T3).

- **Pins** (TO-ONE.md §7.1): parent-held connectOrCreate FOUND = existing-row
  `presenceGuard` (`raceable: false`), MISSING = constraint + `racePin`
  (`raceable: true`); parent-held `create` = none; inverse-side correlated `update` =
  the split-witness `presenceGuard` (`fk = parent ∧ pk = capturedPk`). Each falsified
  once (found-arm deleted-before-batch → FK never lands; missing-arm concurrent create
  → retry-and-adopt; correlated child reparented before batch → update never lands).

- **Gate accounting moved together.** `parent-held connectOrCreate under update` and
  `inverse-side to-one update` left `FALLBACK_CARRYING_RESIDUAL` for the
  decline-surface gate's absorbed slice (fallback OFF); the residual is now **exactly
  one** entry — the inverse-side to-one `upsert` arm (T3) — still non-empty. Route-
  inventory tripwire 51 → 59 (8 finer-grained boundary routes, the same classes T1
  drew under create roots). The dual-run oracle (`to-one-update-family.test.ts`, 16
  scenarios + 3 pin falsifications) certifies V1 == v2-tx == v2-batch. The
  `OperationFragment.ts` surface was **unchanged** — the freeze held. **V1 stays
  reachable; P6 waits on T3.**

## T3 — the final surface *(measured, not curated; NO absorption landed)*

**T3 was chartered as the last absorption phase — drive the fallback-carrying
decline surface to ZERO, then P6 deletes V1. Its first act instead exposed that the
number the previous phases were driving to zero was a fiction.** The gate carried
`FALLBACK_CARRYING_RESIDUAL` as "exactly one entry" (the inverse-side to-one upsert
arm). T3 MEASURED the real surface — a full `nested-write-conformance` run with
`setV1FallbackDisabled(true)`, counting every scenario V2 declines
(`declinedToV1`) — and found **43 scenarios across EIGHT decline families**, not
one. This is the T2 "theater replay" lesson made structural: the census is a run of
the full suite fallback-off, never a hand-maintained pin list.

- **The measured surface (the phase's contract).**

  | family | decline site | count |
  | --- | --- | --- |
  | A. parent-held to-one `update`/`delete`/`upsert` under update | `interpretParentHeldToOne` | 13 |
  | B. nested relation writes in a nested to-many `update` | `RelationWritePart.scalarData` | 8 |
  | C. nested relation writes in an m2m nested `create`/`update` | `RelationJunctionPart.scalarData` | 8 |
  | D. top-level `upsert` with nested-relation arms | `UpsertOperation` scalar-arms guard | 7 |
  | E. nested `create` under update carrying relations / D4 | depth guard | 2 |
  | F. inverse-side to-one `upsert` (the sole pre-T3 pin) | `interpretInverseToOneKind` | 1 |
  | G. `connectOrCreate` create-arm one level too deep | depth guard | 1 |
  | H. to-many `upsert` create-then-update identity | — | 1 |

- **THE GATE delivered (the P6 premise, machine-checked at last).**
  `FALLBACK_OFF_RESIDUAL` (tests/query-engine-v2/fallback-off-residual.ts) pins the
  43 `group > scenario` keys. The `VIBORM_FALLBACK_OFF=1` conformance harness (env-
  gated, inert on normal runs, wired into `pnpm test:gates`) enforces it
  bidirectionally: a pinned scenario MUST decline on both substrates; a non-pinned
  one MUST run natively on V2 with the fallback OFF. The decline-surface gate pins
  the census SIZE (43) against silent trimming and re-proves one representative
  construct-time decline. Falsified: drop one census entry → gate red (`expected 42
  to be 43`) → restored. The `declinedToV1` measure (a V2 `UnsupportedOperationError`
  anywhere in seed/act) is stricter than pass/fail — it caught the 43rd scenario, a
  reject-parity shape ("to-one update (FK-holder side) with nothing connected
  rejects") whose reject-bool coincidentally matched V1 and which the 42-count run
  missed.

- **NO family was absorbed, and that is the honest disposition — not a failure to
  try.** Calibration (TO-ONE.md §7.6): even family F (the single pre-T3 pin) is a
  new correlated Part with no unique `where` — an inverse-side present-or-create
  keyed on `fk = parent`, byte-identical to V1 across tx/batch and five databases.
  Each of A–H is a comparable or larger composite-absorption unit demanding its own
  dual-run oracle, correlation witness, staleness injection, and 5-DB certification.
  Eight such units exceed one phase's honest capacity; a rushed, half-verified
  absorption is exactly the theater the charter forbids ("a smaller true census
  beats a rushed absorption"). T3 therefore STOPS at a coherent boundary: the
  surface is measured, machine-checked, and pinned; TO-ONE.md §7.2's "documented
  boundary" is re-labelled a **migration target**; the route-inventory throw-site
  count (59) and `OperationFragment.ts` are unchanged (freeze held). **P6 remains
  blocked — V1 is reachable behind 43 shapes and is NOT deletable — and the gate now
  turns green only when a real absorption removes a family, never when the pin list
  is curated down.**

- **What the next absorbing phase inherits.** A truthful, falsifiable spec: the 43
  named scenarios, their eight decline sites, and a gate that fails the instant a
  family is claimed-absorbed without the scenarios passing fallback-off natively.
  Order of least-risk first: F (1, the adjacent Part), then A (13, §7.6's parent-
  held correlated write), then D (7, `UpsertOperation` arms reusing create/update
  trees), then B/C/E/G (the nested-relation-depth recursion), H last.

## P6 — Deletion and the honest audit

Bulk-delete V1's operation/execution root once unreachable; keep what V2
consumes (builders, `result/`, `TargetConstraint`, `mutation-identity`, the
preflight analysis, error mapping). The structural gates have been running
since P0; P6 only adds the dead-symbol check (deleted V1 names stay dead) and
retires the routing seam and the oracle's V1 arm (the oracle itself survives
as V2's tx-vs-batch conformance suite).
*Gate:* everything green; the **nouns-per-verb audit** written into this file
as a measured table under WHY §6's accounting (irreducibles counted as kept,
not saved). If the structure did not compress materially, this file says so —
the unification set that precedent and it held.

---

## What failure looks like (so it can be seen early)

Every kill signal above is a variant of one sentence: **the vocabulary, the
Part, or the executor had to grow to absorb one more case.** Three step kinds,
two Part methods, one executor, one census with no TBD rows. The boundary is
stated, not discovered: *a shape whose decision cannot be widened to an
unconditional planning read is rejected, not linearized* — and the preflight
is what makes that rejection a typed contract instead of a silent semantic
change. The day the sentence above is false and the falsifying change merged
without a design note, V2 has begun re-deriving V1 — and the correct response
is the one V1 never had available: stop at the phase boundary, with the oracle
green, and think.
