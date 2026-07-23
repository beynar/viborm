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

## T3 — the final surface *(measured, not curated; family F absorbed in T3-r2; 11 of family A absorbed in T3a, 42 → 31)*

**T3 was chartered as the last absorption phase — drive the fallback-carrying
decline surface to ZERO, then P6 deletes V1. Its first act instead exposed that the
number the previous phases were driving to zero was a fiction.** The gate carried
`FALLBACK_CARRYING_RESIDUAL` as "exactly one entry" (the inverse-side to-one upsert
arm). T3 MEASURED the real surface — a full `nested-write-conformance` run with
`setV1FallbackDisabled(true)`, counting every scenario V2 declines
(`declinedToV1`) — and found **43 scenarios across EIGHT decline families**, not
one. This is the T2 "theater replay" lesson made structural: the census is a run of
the full suite fallback-off, never a hand-maintained pin list. **T3-r2 then absorbed
family F, driving the surface 43 → 42; T3a absorbed 11 of family A's 13, driving it
42 → 31.**

- **The measured surface (the phase's contract).**

  | family | decline site | count |
  | --- | --- | --- |
  | A. parent-held to-one `update`/`delete`/`upsert` under update | **ABSORBED (T3a): 11 of 13** — native parent-held correlated writes; 2 nested-relation-target-data shapes pinned (family-B projection) | ~~13~~ → 2 |
  | B. nested relation writes in a nested to-many `update` | `RelationWritePart.scalarData` | 8 |
  | C. nested relation writes in an m2m nested `create`/`update` (incl. deep-nested-update) | `RelationJunctionPart.scalarData` | 10 |
  | D. top-level `upsert` with nested-relation arms | `UpsertOperation` scalar-arms guard | 7 |
  | E. nested `create` under update carrying relations / D4 | depth guard | 2 |
  | F. inverse-side to-one `upsert` (the sole pre-T3 pin) | **ABSORBED (T3-r2)** — native `buildInverseToOneUpsertPart` | ~~1~~ → 0 |
  | G. `connectOrCreate` create-arm one level too deep | depth guard | 1 |
  | H. to-many `upsert` create-then-update identity | — | 1 |

- **THE GATE delivered (the P6 premise, machine-checked at last).**
  `FALLBACK_OFF_RESIDUAL` (tests/query-engine-v2/fallback-off-residual.ts) pins the
  now-31 `group > scenario` keys. The `VIBORM_FALLBACK_OFF=1` conformance harness (env-
  gated, inert on normal runs, wired into `pnpm test:gates`) enforces it
  bidirectionally: a pinned scenario MUST decline on both substrates; a non-pinned
  one MUST run natively on V2 with the fallback OFF. The decline-surface gate pins
  the census SIZE (31) against silent trimming and re-proves one representative
  construct-time decline (now the family-A residual: a parent-held update whose
  target data carries a nested relation). Falsified: drop one census entry → gate red
  → restored; re-add one absorbed key → its fallback-off scenario runs native
  (`declinedToV1 === false` where `true` is pinned) → gate red → restored. The `declinedToV1`
  measure (a V2 `UnsupportedOperationError` anywhere in seed/act) is stricter than
  pass/fail — it caught the 43rd scenario, a reject-parity shape ("to-one update
  (FK-holder side) with nothing connected rejects") whose reject-bool coincidentally
  matched V1 and which the 42-count run missed.

- **T3-r2 absorbed family F (43 → 42), fully certified.** The inverse-side
  (child-held) to-one `upsert` is a correlated present-or-create keyed on `fk =
  parent` (no unique `where`, the FK correlation is the whole locator). V2 now
  handles it natively via `buildInverseToOneUpsertPart` in `RelationWritePart`: the
  correlated probe decides at plan time — found → UPDATE the correlated child (the
  already-certified inverse-side to-one update leaf, pinned in batch by the
  upsert-family `exists` premise guard, in tx by the upsert-vanished affected-rows
  expectation); absent → INSERT with `fk = parent`, no `racePin` and no found guard
  (V1's `missingPin: none`). Scalar arms only — a relation-carrying arm still routes
  the whole tree to V1 (a documented narrower boundary, outside the conformance
  census). Certified byte-identical to V1: the `VIBORM_FALLBACK_OFF=1` conformance
  run (F now runs natively on both tx and batch), a two-parent correlation witness in
  the decline-surface gate, typecheck, Biome, the full estate, and the 5-database
  matrix.

- **T3a absorbed 11 of family A's 13 (42 → 31), fully certified.** The FK-holder-side
  (parent-held) to-one `update`/`delete`/`upsert` under an update root now run
  natively on V2 whenever the located target's own mutation is scalar — new
  `ParentHeldTarget` kinds in `UpdateOperation`: `update` locates the referenced
  target by the parent's FINAL FK value and mutates it by captured PK (empty capture
  = V1's "target record was not found for this parent"); `delete: true` nulls the
  parent FK then bulk-deletes the target; `upsert` decides found→update /
  absent→create+parent-FK-rebind at compile. A same-root FK rebind moves the target
  (V1's post-update `parentValues` correlation); the parent's own FK columns live in a
  separate locate-field set so a self-relation FK rebind does not spuriously reorder
  the root UPDATE after a sibling child write (which would race an unfreed UNIQUE
  inverse-holder value). Certified byte-identical: the `VIBORM_FALLBACK_OFF=1`
  conformance run (11 native on both substrates), three absorbed positive tests each
  with a multi-parent correlation witness, typecheck, Biome, the full estate, and the
  5-database matrix. The route-inventory tripwire moved **62 → 65** (3 finer parent-
  held boundaries). T3a's dual-run also proved the two T1 create-root declines
  (connect-by-non-referenced-unique; shared-PK edge) are **accept-and-execute in V1,
  not reject-parity** — separate create-root plan-shape units, left documented.
- **The remaining families (31 scenarios) stay pinned.** The **2** unabsorbed family-A
  shapes are the parent-held `update`/`upsert` whose located target's DATA carries a
  nested relation write — the parent-held projection of family B. Families B–E, G, H
  are each a comparable or larger composite-absorption unit demanding its own dual-run
  oracle, correlation witness, staleness injection, and 5-DB certification. **P6
  remains blocked — V1 is reachable behind 31 shapes and is NOT deletable — and the
  gate turns green only when a real absorption removes a family (or a certified slice
  of one), never when the pin list is curated down.**

- **What the next absorbing phase inherits.** A truthful, falsifiable spec: the 31
  remaining named scenarios (F absorbed in T3-r2; 11 of A in T3a), their decline
  sites, and a gate that fails the instant a family is claimed-absorbed without the
  scenarios passing fallback-off natively. The 2 unabsorbed family-A shapes are the
  parent-held update/upsert with nested-relation **target data** — they land WITH
  family B (both are the same `compileLocatedUpdate` recursion). Order of least-risk
  next: D (7, `UpsertOperation` arms reusing create/update trees), then B/C/E/G (the
  nested-relation-depth recursion — which also closes family A's 2 residual shapes),
  H last. F's absorption moved the route-inventory tripwire 59 → 62, T3a's moved it
  62 → 65 (three finer parent-held boundaries), the same finer-boundary bookkeeping
  T1/T2 did; `OperationFragment.ts` stayed unchanged — the vocabulary freeze held.

### T3b — recursion/depth group measured; hypothesis rendered; mechanism 1 delivered in T3b-1 (census 31 → 21)

T3b scoped the 23-key recursion/depth group (families **A-rem 2, B 8, C 10, E 2, G 1**;
D 7 and H 1 are later) and ran T3's load-bearing first act on it — **measure the decline
SITE of every residual key**, capturing each `UnsupportedOperationError` message under
`VIBORM_FALLBACK_OFF=1`. The 31-key site tally is **exactly** the ATOM §7.6 / TO-ONE
§7.6 table, so the group boundary is a measured fact, not a reading of intent.

- **Hypothesis** ("the 23 close through ONE generalization — recursive Part composition,
  the `RelationUpsertPart.buildArmChildParts` machinery P1 proved"). **Verdict: one
  architecture, three mechanisms.** The architecture holds (the `Part` interface and V1
  builders are reused; `OperationFragment.ts` untouched; scalarData/scalarOnly throws
  exist only because nested targets were built scalar-only). The 23 split by linearity
  precondition: (1) **update-arm literal-parent recursion** (B, A-rem, C `update`/`upsert`)
  — target located by `where` PK → `literalParentId` — **plus** porting the root's
  `reorderRootUpdateAfterChildren` + `ON UPDATE CASCADE` to depth for the B
  PK-transition/self-m2m scenarios; (2) **create-arm fresh-parent recursion** (E, G, C
  `create`) — the create-context composition threaded into a fresh nested target;
  (3) **create-arm depth-guard relaxation** (G). The own-write preflight already walks
  the whole tree, so every rejects/succeeds pair's reject half is free.
- **T3b measured and rendered the verdict; T3b-1 DELIVERED mechanism (1).**

### T3b-1 — mechanism 1 landed: family B + A-remainder (census 31 → 21)

Mechanism (1) — **update-arm literal-parent recursion** — is landed and 5-DB certified.
`buildNestedTargetChildParts` (`nested-target-parts.ts`) is the reusable depth-recursive
child-Part builder: a **located-by-PK** target folds its data relations into deeper Parts
through the SAME per-kind builders the root's `interpretRelation` uses, parameterized only
by `ParentIdSource` — `literalParentId(pk)` for a child-held nested `update`
(`RelationWritePart`), `plannedParentId(probe, pk)` for a parent-held one
(`UpdateOperation.parentHeldUpdateData`, family A-remainder's projection, its captured PK
exposed as a firstRowField). The obligation P1 never carried is ported per Part: a target
whose SET rewrites its own PK emits its self-UPDATE **after** its child edges, the FK's
`ON UPDATE CASCADE` carrying the vacated id (`reorderRootUpdateAfterChildren` at depth).
Two literal-parent seams the root never needed — a junction membership read
(`RelationJunctionPart.parentRef`) and an inverse-side to-one probe
(`RelationWritePart.correlationFilters`) — inline the literal even at planning; the
planned-parent root paths are byte-identical.

- **`FALLBACK_OFF_RESIDUAL_COUNT` 31 → 25 → 21.** −6 child-held family-B shapes (m2m
  junction / to-many createMany grandchildren, incl. the `nested identity transition`
  PK-transition/cascade witness `sourceId` 1→4), then −4 (family B's 2 parent-held
  membership-root shapes + family A-remainder's 2, incl. the 3-level
  container→to-many-update→inverse-to-one-upsert chain). The `VIBORM_FALLBACK_OFF=1`
  census runs all 10 natively on both substrates byte-identical to V1; route-inventory
  65 → 74 (9 finer boundary routes, none removed); the decline-surface gate carries 3
  native + falsification witnesses. Falsified: drop a census entry → gate red; re-narrow
  the recursion → the native witness throws.
- **5-DB certified.** typecheck, Biome, full estate (6107/0/895), sqlite3/libsql/pglite
  in-estate, Docker MySQL 470, pg 411/14 (serial) — the PK-transition/`ON UPDATE CASCADE`
  shapes pass on MySQL/pg, not only PGlite. A/B: the family-B deep tree is **1.85×
  faster on V2** (PERF.md).
- **P6 stays blocked** — 21 shapes remain (C ×10, D ×7, E ×2, G ×1, H ×1),
  `OperationFragment.ts` untouched. Next drive: mechanism (2), create-arm fresh-parent
  recursion (C's create, E, G), then mechanism (3), the create-arm depth-guard relaxation.

### T3b-2 — mechanisms 2 + 3 landed: families C + E + G (census 21 → 8)

Mechanisms (2) **create-arm fresh-parent recursion** and (3) **create-arm depth-guard
relaxation** are landed. All 13 remaining recursion/depth keys run natively fallback-off;
only D ×7 + H ×1 (T3c) remain.

- **Family C (×10)** — `RelationJunctionPart.buildJunctionParts` lifts the m2m scalarOnly
  boundary: a junction `create`/`update`/`upsert`-arm target whose data carries its own
  relations folds them one level deeper through the SAME `buildNestedTargetChildParts` seam
  (a located update/upsert-update target by its `where` PK — mechanism 1 reuse; a fresh
  create/upsert-create target by its explicit `create` PK — mechanism 2, ATOM §4 elision).
  Slots carry per-target child Parts; `planning` plans the superset; `compile` emits the
  taken arm's writes; `nestedBuilder` threaded at all three call sites.
- **Family E (×2)** — `UpdateOperation.interpretChildHeldCreate` routes a child-held to-many
  `create`/`createMany` under the update root to the literal-parent create leaf, its FK the
  `where`-pinned PK or a **D4** root-SET-rewritten column (create-only relations add no
  referenced column to `locateFields`, so reorder stays FALSE and the root UPDATE precedes
  the fresh INSERT).
- **Family G (×1)** — `RelationUpsertPart.buildArmChildParts` accepts a child-held `create`
  one level deeper on the connectOrCreate create arm: a fresh grandchild INSERT folding a
  single parent-held to-one `connect`, mirroring V1's accepted depth exactly.
- **Named reorder obligation closed** — `buildNestedTargetChildParts` routes a deeper edge
  whose FK references a NON-PK column of the located target to V1 (the literal/planned parent
  id carries only the target's PK per-field, so a D4-style deep non-PK reference cannot be
  injected and would miss the PK-only depth reorder); the PK-only reorder check is therefore
  complete. Witness `nested-update-d4-deep-nonpk-reference.test.ts`.
- **`FALLBACK_OFF_RESIDUAL_COUNT` 21 → 11 → 9 → 8.** −10 family C, −2 family E, −1 family G.
  Route-inventory 75 → 87 (12 finer boundary routes, none removed). The census edit is
  falsified twice (the count pin catches a wrong count; re-pinning an absorbed key fails the
  fallback-off gate — absorption is real). Family-C dual-run/multi-parent/raw-junction-A/B
  witnesses (`nested-junction-target-recursion.test.ts`); the D4-deep guard witness +
  falsification.
- **P6 stays blocked** — 8 shapes remain (D ×7, H ×1 — T3c), `OperationFragment.ts`
  untouched. Next drive: family D (top-level `upsert` with nested-relation arms) + family H.

### T3c — the drive to ZERO: census 8 → 0, P6 UNBLOCKED (TO-ONE.md §7.8)

The final 8 census keys run natively fallback-off; the fallback-carrying decline surface
is EMPTY. The V1 fallback arm holds no reachable accept-and-execute conformance behavior.

- **Family D (×7) — the top-level `upsert` scalar-arms-only guard, LIFTED.** The create /
  update arms compose the root machinery: a **scalar** arm stays inline (its proven
  INSERT-with-`racePin` / `UPDATE … [RETURNING]` path); a **relation-bearing** arm delegates
  to a `CreateOperation` (mechanism 2, fresh-parent elision / the create-root traversal
  barrier) / `UpdateOperation` (mechanism 1, `buildNestedTargetChildParts` + reorder/cascade)
  sub-op that SHARES the upsert's `StepScope`, plans its whole superset (ATOM §3 technique 2 —
  only the taken arm's writes compile), and DEFERS its own-write barrier to the enclosing
  per-arm compile (V1 checks each arm's barrier inside its own branch — the create arm's is
  the D4/D5 create-branch insert barrier, the update arm's the D6 found-branch barrier). The
  update arm's sub-op drops its locate not-found postcondition (absent → the upsert's create
  decision). The probe-decided arm selection, the setWhere/targetWhere skip pins, and the
  create-branch racePin all compose with each arm's own child Parts. The D7 witness (an
  existing-row upsert whose update arm transitions the PK and writes a self-m2m) exercises the
  reorder/cascade at the root.
- **Family H (×1)** — the nested to-many upsert create-identity over-restriction is relaxed to
  match V1's `input.create`-verbatim absent arm (which pins on `input.where`, never validating
  a `create.id = where.id`): `assertMatchingCreateIdentity` now fires ONLY when the create arm
  folds grandchildren (which correlate to the fresh row through `where`'s PK).
- **The two create-root parent-held-FK declines** T1 deferred (outside the pre-T3c census),
  ABSORBED with coverage: (1) a to-one `connect` by a NON-REFERENCED unique resolves through
  V1's verbatim `buildConnectSubqueryForField` lookup subquery; (2) a SHARED-PRIMARY-KEY edge
  for its compile-time-literal fold (a direct connect / literal-id create) threaded into the
  record identity by `resolveSharedPkIdentity` — the non-literal sub-cases (subquery /
  generated / connectOrCreate) route to V1 as documented finer boundaries. New conformance
  group "create-root FK declines (tx vs batch)" runs both natively, byte-identical to V1
  (dual-run-proven by reverting the create-src changes and re-running against V1).
- **`FALLBACK_OFF_RESIDUAL_COUNT` 8 → 0.** Route-inventory **88 → 87** (family D's guard
  deleted; no new upsert route — a shape neither root owns throws inside the delegated sub-op's
  already-audited surface) **→ 86** (non-referenced connect throw deleted; shared-PK throw
  reworded). The census edit is falsified (re-pinning an absorbed key fails the fallback-off
  gate). `VIBORM_FALLBACK_OFF=1` conformance census **172/172 native** on both substrates.
- **The final accounting** (route-inventory scope note): with the census empty, every one of
  the 87 remaining `new UnsupportedOperationError` throw sites is (i) a parity refusal (V1 also
  rejects, byte-identical), (ii) the one deliberate refusal (createManyAndReturn skipDuplicates
  non-returning), or (iii) a documented finer boundary one level deeper than an absorbed
  family's proven surface, reached by NO conformance scenario.
- **The P6 readiness probe (the closing statement).** The census — the machine-checked
  deletion gate — is EMPTY, so P6's stated census precondition holds. But the ORIGINAL
  blast-radius probe over the FULL local estate with the V1 fallback DISABLED is NOT
  clean-green: ~82 non-conformance tests reach the documented category-iii finer boundaries
  (V1-accepted shapes V2 routes to V1) plus routing-documentation and parity-refusal-message
  tests — none a T3c regression (the full estate is green with the fallback ON). So P6's
  V1-runtime deletion carries a nonzero blast radius the finer-boundary surface must reconcile
  (absorb, retarget, or keep targeted V1 handlers). Recorded honestly, not a green light over
  the full estate; the T3c report's `p6Readiness` holds the accounting.

## T3d — the finer boundaries (the last absorption drive; 83 → 43 + the gate)

T3c's census was ZERO but its full-estate blast-radius probe surfaced 83 failures —
the finer boundaries reached only by NON-conformance estate tests. T3d absorbed the
two machinery-complete classes, wired the probe as a committed falsifiable gate, and
boundary-stopped the rest with design notes and an exact list.

- **CLASS I — `select`/`include` on `delete`/`update`/`upsert` (ABSORBED; the largest
  chunk).** `DeleteOperation` demanded exactly `{where, select}` and the update/upsert
  ops rejected `include`, so a plain `delete({where})`, any `*-with-include`, and — the
  surprise — the WHOLE `staleness-injection` suite (its scenarios do plain no-select
  deletes) all routed to V1 and blew up fallback-off. All three ops now accept an
  optional `select` (defaulting the scalar projection, V1's no-select shape) and an
  `include` riding alongside (`create`'s surface), forcing the terminal-read path over a
  scalar RETURNING fold; delete drops `FOR UPDATE` on the include read (the PK locate
  already locked; `FOR UPDATE` + join is Postgres `0A000`). Full normal-mode estate
  stayed green (6119/0/895); throw-site count unchanged at 87.
- **CLASS VII — nested `createMany skipDuplicates` default-only (ABSORBED, parity
  refusal).** A default-only-row nested `skipDuplicates` createMany is inexpressible; V1
  rejects before the parent write. `foldCreateMany` runs V1's own guard
  (`buildValueGroups` on the pre-injection user rows → `assertPortableCreateManySkip`),
  raising V1's byte-identical `QueryEngineError` at construction. Non-default-only stays
  a documented finer boundary.
- **THE GATE (P6 Stage 0 made a passing test).** `pnpm test:gates:blast-radius` runs the
  full estate with the V1 fallback globally disabled (`vitest.blast-radius.config.ts` +
  `tests/query-engine-v2/blast-radius.setup.ts`) and asserts the observed failure set
  equals the documented residual (`tests/query-engine-v2/blast-radius-residual.ts`)
  EXACTLY — bidirectionally, so a NEW decline behind the fallback OR a listed class
  absorbed-but-not-delisted both turn it RED. It shrinks toward EMPTY as the subsystems
  land, and is EMPTY the day V1 is deletable. Falsified: re-introducing one decline
  surfaces an unexpected failure → gate RED → restored.
- **The 43 boundary-stopped (design-noted, exact list in `blast-radius-residual.ts`).**
  (III) **batch generated/updated-PK dataflow** (22) — a nested create whose FK
  references a PK the same atomic batch transitions needs an internal adapter
  batch-reference store (batch-primary-key-dataflow-plan.md), unbuilt; (IV+V) the
  **relation-key / referential-action legality engine** (15) — the mission's
  pre-sanctioned boundary stop plus its runtime-branch-gated `updateMany`-nested-relation
  companion (occupied-slot / cascade / setNull / restrict staging, no-op-transition
  detection, empty-slot race pin, validate-only-the-taken-branch); (VI) **deep
  create-context grandchildren** (3) — a create under a runtime-captured target id, one
  step past `buildNestedTargetChildParts`; plus (b) three routing-doc tests that assert
  the V1-fallback route itself (rewritten when V1 dies at P6). Honest outcome: two
  classes were machinery-complete this drive; three remain as subsystems, one of which
  (the referential engine) the mission pre-sanctioned. None a regression — the full
  estate is green with the fallback ON.

**P6-readiness (T3d closing statement).** The census-deletion gate is GREEN (172/172
native fallback-off). The full-estate blast-radius gate is GREEN-BY-ALLOWLIST: the only
fallback-off estate failures are the 43 enumerated, design-noted boundaries + 3
V1-seam meta-tests. P6's Stage 0 is now a committed, falsifiable test, not a probe. The
remaining light is AMBER, not green: P6's V1-runtime deletion must first land the three
boundary subsystems (batch-PK dataflow store; the referential-action legality engine;
deep create-context id-threading) — or keep targeted V1 handlers for them — and rewrite
the three V1-seam meta-tests. The exact remaining list is `BLAST_RADIUS_RESIDUAL`.

**T4a — CLASS VI absorbed (blast radius 43 → 40).** The first and smallest of the three
final subsystems is landed: **deep create-context grandchildren**, a nested `create` whose FK
carries a captured parent id one step past `buildNestedTargetChildParts`' literal-parent reach
(refs point backward — the ATOM depth-recursion mechanism). Three keys, one family: (1) a
`create` under a PLANNED parent-held `update` target — its FK inlined at compile from the
located planning row (`buildPlannedParentCreatePart`, nested-target-parts.ts); (2) a `create`
on the UPDATE arm of a to-many upsert — correlated to the found row's literal PK
(`RelationUpsertPart` accepts a child-held create on both arms); (3) a root-`create` nested
`createMany skipDuplicates` — composing `buildCreateManyPlan`'s skip leaf / recoverable
`onUniqueConflict` effect (`CreateOperation.foldCreateMany`). A `createMany` one step past the
planned create leaf, and a relation-carrying grandchild, stay documented finer boundaries
(measured-not-curated; the decline-surface gate's representative is retargeted to the
`createMany`-under-planned shape). Certified: dual-run oracle per key (V1 vs V2-tx vs V2-batch,
byte-identical, engine V2) + multi-parent grandchild isolation (keys 1 & 2) + falsification
(`nested-create-context-grandchild.test.ts`); the three keys leave `BLAST_RADIUS_RESIDUAL` in
lockstep (43 → 40, gate green bidirectionally + falsified); throw-site count unchanged at 87
(net-zero swap). `OperationFragment.ts` untouched; V1 frozen. **P6 stays AMBER** — the two
larger subsystems (III batch PK-dataflow; IV+V referential-action legality) remain.

**T4b — CLASS III absorbed (blast radius 40 → 18).** The batch **updated-PK dataflow**: a
top-level `update`/`upsert` that TRANSITIONS its primary key (literal rename, `{ set }`, or
portable int·bigint arithmetic) while a nested `create`/`createMany` references it. The plan
doc (`docs/architecture/batch-primary-key-dataflow-plan.md`) envisioned an adapter batch-ref
STORE for the computed PK; the delivered V2 reconciliation (§T4b there) is leaner and more
faithful: the updated PK is **compile-derived** from the where-pinned pre-transition value by
V1's exact `getUpdatedPrimaryKeyValue` arithmetic — the SAME derivation `buildTerminal` already
trusts (JS==SQL, guarded by `assertPortablePrimaryKeyUpdateInput`) — so the child FK is a
construction LITERAL, no batch-ref store needed. The one new mechanism is ORDERING:
`UpdateOperation.afterRootCreateParts` emits the transitioned-PK create AFTER the root UPDATE in
both reorder branches (a NO-ACTION FK does not cascade). The generated-PK class is untouched (it
still uses `adapter.batchRefs.storeLastInsertId`, unchanged). Certified: 22 keys native
fallback-off; a multi-row/multi-entry wrong-row witness + falsification
(`batch-updated-pk-dataflow-witness.test.ts`); 5-DB coverage on the RETURNING-capable batch-only
drivers (SQLite3, LibSQL, PGlite, Postgres) plus SQLite3 tx mode, with MySQL a documented
boundary-stop (non-returning batch-only refuses the whole single-row update/upsert refetch
family, V1==V2 parity — transaction mode only). `BLAST_RADIUS_RESIDUAL` 40 → 18, gate green
bidirectionally + falsified; `OperationFragment.ts` untouched; V1 frozen. **P6 stays AMBER** —
only IV+V (referential-action legality, 15 keys) and the (b) V1-fallback-route doc tests (3)
remain.

**T4c — CLASS IV+V absorbed, the FINAL absorption (blast radius 18 → 3).** The referential-action
legality engine + its runtime-branch-gated `updateMany` companion — the pre-sanctioned
"maybe subsystem-sized" boundary stop. Reuse WAS the strategy: V1's legality is ANALYSIS plus one
runtime guard. The pure-analysis verdicts (`assertRelationKeyUpdatesAreCompilable`,
`assertUpdateManyRelationsAreCompilable`) became visibility-only exports of frozen `RelationUpdates`
and are wired into V2 construction/compile, so every typed rejection is byte-identical because it
is V1's own function; only `compileRelationKeyGuards`' occupied guard — execution-coupled to V1's
step vocabulary — was ported to V2's guard/probe vocabulary. Accepted shapes execute native: a
child-held transition upsert classifies cascade (DB re-point) / no-op / real-non-cascade at compile
(the where-pinned pre-value + `getUpdatedPrimaryKeyValue`, both literals), emitting the occupied
guard (tx compile-throw off the locked probe; batch raceable `notExists` guard for the empty-slot
race) and rerouting the empty-slot create to a POST-transition-FK leaf after the root UPDATE (T4b
`afterRootCreateParts`); the nested-update recursion runs the reused analysis at every child-part
level; the top-level upsert's parent-held-to-one update arm plans its superset against an
OPTIONAL-firstRowField locate (an absent create-arm parent → `undefined`, never a planning abort)
and rejects only when the found branch is taken (V1's whenTrue timing). All 15 keys native
fallback-off; every verdict path falsified once; V2 suite 437/437. `BLAST_RADIUS_RESIDUAL` 18 → 3.
The blast radius holds at 3 (`BLAST_RADIUS_ROUTING_DOC` V1-seam meta-tests, which assert the
fallback route itself and are rewritten at P6). P6's Stage 0 blast-radius gate is GREEN at its
irreducible floor.

**T4c-fix — the occupied guard was upsert-only (a corruption the T4c "every reachable behavior is
native" claim MISSED).** T4c wired V1's occupied guard into `interpretTransitionedChildUpsert` — the
inverse-to-one **upsert** alone — but V1's `compileRelationKeyGuards` is kind- AND cardinality-
agnostic (it loops every non-M2M relation). So a child-held, non-cascade relation under a referenced-
PK transition rejects an occupied slot for `update` / `delete` / `disconnect` / `create` and the
whole **to-many** family too; those reached NO guard and diverged accept-where-V1-rejects (UPDATE
orphaned + applied the write, DELETE lost the child) — a corruption / data-loss class the blast-radius
gate could not see (no estate test). The T4c round-1 fixer moved the guard to the RELATION level
(`interpretReferencedKeyTransition`, once per relation, mirroring V1's loop): a single-PK where-pinned
non-cascade transition emits V1's byte-identical occupied guard; the correlated / literal-parent-
create kinds stay native, the to-one upsert reroutes unchanged. Two narrower boundaries route to V1
(category-iii, unreached): an **adopt** kind (connect / connectOrCreate / set + to-many upsert), and a
**`pastSurface`** reference (compound / non-PK D4 / unpinned) where only create/createMany proceed.
`relation-key-update-legality` +12 dual-run parity cases; falsified (guard→upsert-only → the 8 new
occupied cases fail); V2 suite 437/437, blast-radius GREEN@3, route-inventory net ±0. **The reachable
referential-action CORRUPTION is gone; every reachable accept-and-execute shape is native, every
rejection is V1's own message, and the remaining adopt/`pastSurface` transitions route to V1 correctly
— documented narrower boundaries, not corruption. The P6 deletion premise holds at its honest floor
(blast radius 3, GREEN bidirectional). P6 is GREEN — unblocked.**

## P6 — Deletion and the honest audit *(delivered)*

V1's operation/execution root is deleted; there is one runtime. The plan held:
keep what V2 consumes (builders, `result/`, `context/`, `operations/`,
`operation-program` vocabulary, `TargetConstraint`, `mutation-identity`, the
own-write preflight, `RelationMutationPlan`/`RelationProgramValues`/
`ManyToManyStatements`), extract the five pure leaves V2 called through V1 hosts,
retire the routing seam + fallback harness + the oracle's V1 arm (the oracle
survives as V2's tx-vs-batch conformance suite), and gate the absence with the
dead-symbol check.

**The measured table (WHY §6 accounting — irreducibles counted as kept, not saved).**

| | files | lines (raw) | code (comments stripped) |
|---|---|---|---|
| **Deleted** — V1's write engine (Stage 3) | 15 | 5 831 | ~4 400 |
| **Kept-as-earned** — the WHY §6 irreducibles V2 consumes: `TargetConstraint`, the `OwnWrite*` preflight, `mutation-identity`, `RelationMutationPlan`, `RelationProgramValues`, `ManyToManyStatements`, `RelationMembership`, builders + `result/` | — | — | (unchanged, shared by both engines from day one) |
| **Extracted leaves** — the 5 pure functions V2 reached through V1 hosts, now standalone: `relation-key-legality`, `unique-conflict-target`, `many-to-many-statement`, `skippable-write`, `batch-error-attribution` | +5 | 249 | ~200 |
| **V2 engine** (`query-engine-v2/*.ts`) — the single runtime | 26 | 13 984 | 10 623 |
| **`query-engine/` (kept)** — facade + shared builders/context/operations/result + preflight cluster | 79 | 16 069 | 12 947 |

**Runtimes: 2 → 1.** `PendingOperation` no longer holds an
`OperationCompiler`/`OperationResults`/`OperationRuntime` arm; the client has no
`queryEngine: "v1"` escape hatch; `engine.build()` runs through the V2 read path.
`query-engine/` root `.ts` files: 33 → 23 (−15 deleted, +5 extracted leaves).

**The PLAIN verdict (no dressing).** V2 did **not** shrink the volume. WHY §6's
theoretical prize was "10.8k operation/execution root → ~3–4k"; V2's engine is
13 984 raw / 10 623 code — **≈1.3–1.6× V1's write root, larger, not smaller**. The
maintainer knows this and it is the right trade: what compressed is **structure,
not lines**. V1 was 23 nouns for one verb (five orthogonal axes — kind × direction ×
arity × substrate × depth — promoted from data to file families). V2 is one fixed
step vocabulary (`OperationFragment`: read/write/guard steps + `Ref`) that every verb
flows through, one runtime, no cross-product: the axes are back to being *data*. The
line count is the price of making each verb explicit as its own operation class and
Part; the win is that the day someone adds `RelationUpsert.ts` + `M2MUpsert.ts` +
`BatchUpsert.ts` the structural gates fail (WHY §7's standing rule, now machine-checked
by `architecture-gates` + `dead-symbol-gate`). Benchmark sanity (PERF.md): the
composition-heavy deep junction fold is **1.64× FASTER** on V2 — the structural
dividend shows up where V1's cross-product was densest — while the simple-path A/B stays
within the recorded gate.

**Post-P6 backlog (the boundaries V2 declines, absorption ordered).**
1. **FIRST — lift the nesting-depth limit.** The category-(iii) declines are all
   *one level deeper* than an absorbed family's proven surface (a nested `createMany`
   under a `planned` parent-held target; a compound-PK child at depth; a create-context
   grandchild; a deeper edge referencing a non-PK unique — witnessed by
   `nested-update-d4-deep-nonpk-reference` / `nested-update-pk-transition-cascade` /
   the decline-surface-gate representative). Each needs the depth builder to carry a
   non-literal parent identity; the contract extension + fixed-expectation oracles are
   the first post-P6 unit.
2. **`createManyAndReturn` + `skipDuplicates` on a non-returning driver** — the one
   maintainer-authorized deliberate refusal (no portable `ON CONFLICT DO NOTHING` that
   also reports the inserted rows). Needs an in-batch skipped-row-count port.
3. The child-held PK-transition-under-NO-ACTION edge (routed for correctness, not
   inexpressibility) — absorb once the depth builder orders the self-UPDATE after a
   cascade-safe edge.

---

## X1 — the depth lift *(delivered — the first post-P6 contract extension)*

**The measurement rewrote the premise.** The backlog framed the depth limit as a global
cliff; it was not. The engine's construction-time recursion has no architectural depth
constraint, and never did: a child-held `create` OR `update` chain on a self-referential
model already folds to arbitrary depth (measured green at 5 / 8 / 12 levels, tx and batch —
`x1-depth-stress.test.ts`), and the validation layer's `v.lazy` relation schemas recurse
lazily with no cap (a naive "cap at 6" reading was a probe artifact — a chain schema only 7
models deep, not a validator limit). The depth "limits" were a finite set of SPECIFIC shapes
one level past a located target's proven surface (route-inventory category iii), each a
distinct mechanism.

**What X1 lifts (the marquee): the create-context grandchild at depth.** A nested `create`
under a located target (a child-held nested `update`, a parent-held planned `update`, an
after-root upsert create arm — all three leaves share the code) may now carry its OWN nested
`create` / `createMany` relations, to arbitrary depth. The fresh child's primary key is a
construction-time literal, so it is a `literalParentId` for its grandchildren — the SAME
`buildNestedTargetChildParts` seam, one level deeper, NO counter and no one-more-level special
case (`buildFreshCreateGrandchildParts` in `nested-target-parts.ts`). The two `... nested
relation writes in the create data … one level deeper` throws are DELETED; five finer-boundary
throws replace them (census **87 → 90**), each a real seam difference (route-inventory §
"87 -> 90"), not a moved cliff. Delivered with: a fixed-expectation oracle (tx vs batch
byte-identical, native V2) with a multi-parent witness at the deepest level and a standing
falsification (`x1-depth-lift.test.ts`); a depth-stress proof to 12 levels; and semantic-
stability witnesses proving own-write ("Split these operations…") and validation fire
byte-identically at depth (`x1-semantic-stability.test.ts`).

**The genuine remaining ceilings (recorded honestly — a follow-up backlog, not a cliff):**
- parent-held-FK to-one at depth (`nested-target-parts` line ~175) — needs child-SET folding
  (the located target rewrites an FK in its own SET); a distinct mechanism, not a counter.
- `createMany skipDuplicates` at depth — needs the depth leaf to compose `buildCreateManyPlan`'s
  skip (as the root `foldCreateMany` does since T4a).
- compound-PK / D4-non-PK / generated-PK grandchildren, and the adopt family (connect/
  connectOrCreate/upsert/set) under a fresh create — each needs a mechanism (`literalParentId`
  is single-field; a generated PK needs a backward Ref; the adopt family needs
  `CreateOperation`'s GLOBAL fresh-parent elision, not this seam's correlated probe).
- **The TS type-instantiation ceiling is real and separate.** The engine folds deeper than
  the compiler comfortably infers a deeply-nested literal payload type; that is a DX ceiling
  measured on the client input types, NOT an engine limit. Recorded, not "lifted" — the
  runtime accepts what the type system strains to express.

Bench — a create-context chain grafted under a located update target, PGlite, ms per graft
(mean of 40, absolute; no V1 to A/B against): d1 1.47, d2 1.44, d3 1.64, d4 1.86, **d5 1.83**,
d6 2.02, d7 2.20, d8 2.32. The per-level curve is LINEAR (≈ +0.12 ms/level — each level adds
one INSERT step and one FK inline), no superlinear blow-up (a superlinear curve would be the
conflict signal that depth had become an axis instead of a list splice).

---

## X2 — one home for validation *(delivered — the typed parse boundary; the deletion; the gate)*

**The premise, audited first.** With V1 deleted, a user payload becomes a validated value in
exactly one way: the schema layer. An audit classified every defensive guard in
`src/query-engine-v2` and found ZERO schema gaps — the write schemas validate the whole tree
recursively inside the constructors (`object.ts:392` fails non-objects, strict mode rejects
unknown keys, `singleOrArray` validates + normalizes elements), so every in-engine payload
shape-check is runtime-unreachable, shadowed by the schema layer.

**Deliverable 1 — the typed parse boundary.** `parse-boundary.ts` exports the single
`parseValidated(schema, value, operation, path): InferOutput<S>`, replacing FIVE local
`parseRecord`/`validateCreateArgs`/`validateUpdateArgs` copies (each with its own hardcoded
operation name + its own dead `isRecord(result.value)` re-check). It raises V1's byte-identical
`ValidationError` and returns the schema's INFERRED output type instead of erasing it to
`Record<string, unknown>`; its lone `as InferOutput<S>` is the ONLY assertion inference cannot
reach. Census **90 → 89** (only `CreateManyOperation`'s post threw
`UnsupportedOperationError`).

**Deliverable 2 — the deletion (census 89 → 82, net −7, NO route removed).** Every deleted site
is unreachable at runtime; its pre-P6 "route to V1" disposition is moot (no conformance shape
reaches it). The seven: the four pre-validate KEY GATES
(`assertCreateKeys`/`assertDeleteKeys`/`assertUpdateKeys` — each shadowed by the whole-args
`parseValidated` that ran right after it; `assertUpsertKeys` — upsert had NO whole-args parse,
so X2 added `parseValidated(parentSchemas.args.upsert, …)` as its one home, the update arm's
DEEP legality still deferred via `deferArmLegality`); the two `requireRecord` shape helpers those
parses made dead (delete, upsert); and the dead-CAPABILITY guard `RelationJunctionPart`'s
`!input.nestedBuilder` (T3b-2 threads `nestedBuilder` at all three callers, so X2 made its type
non-optional and tsc proves the throw unconstructible; the `foldKind` param that fed only it went
too). **The one authorized behavior change:** a malformed top-level payload now raises the
schema's precise per-key `ValidationError` instead of the gate's coarse
`UnsupportedOperationError`. No estate test pinned the old class (verified — the suite never fed
a malformed top-level payload); the upsert one-home change is dual-run-oracle byte-identical.

**Deliverable 4 — the gate** (`parse-boundary-gate.test.ts`, in `test:gates`). Five falsified
assertions: `parseValidated` and the whole-tree cast live in one home; each write op validates
its whole args through the boundary (delete the upsert parse → fails); no `assert*Keys` /
`arguments require` pre-validate gate returns (re-add `assertUpsertKeys` → fails); and a growth
RATCHET on the shape-check surface (payload `as Record<string, unknown>` + `requires a … object`
throws may only shrink → add one → fails).

**The honest residue (deliverable 2 scope boundary).** The remaining
`requireRecord`/`normalizeSingle`/`normalizeItems`/`isRecord` narrowings on payload paths are
runtime-unreachable too, but they are `unknown -> Record` TYPE narrowings: a dynamic
`data[relationName]` / `spec.create` widens to `unknown`, and the engine ALSO carries ~38
`as Record<string, unknown>` casts (most on driver-result rows — no schema promises those —
KEEP). Removing the payload narrowings without an `as` (forbidden outside the boundary) needs the
precise per-relation parsed type threaded through `interpretRelation` and every Part builder — a
type refactor deferred past X2, not a mechanical deletion. The gate's ratchet locks in the
current floor so the residue can only shrink, and any RE-INTRODUCTION of a re-validation branch
fails loudly — the invariant the deliverable asked for, at the honest surface X2 reached.

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
