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

- **P2a — update family, FK edges**: root `update` and root `delete`; nested
  connect/disconnect; postconditions live (`notFound` on missing root row;
  `affectedRows` contracts); batch-mode `affectedRows` adapter assertions
  (ATOM §8.1 note (b)'s deferral comes due). *Gate:* oracle parity for every
  P2a shape incl. error classes and messages; structural gates green
  untouched; **technique #1's positive witness** (the P1 disposition comes
  due): at least one correlated nested read whose probe SQL contains a `Ref`
  to an earlier planning step's output, proven by an emitted-planning-fragment
  inspection test — not by the validator merely accepting the shape.
- **P2b — upsert + connectOrCreate**: probe-first per ATOM §2/§4. The Pin Rule
  applied with its **exact scope** — pinned `exists` premises
  (`raceable: false`); same-model-INSERT missing premises by constraint +
  `racePin`, never guarded; and the **retained** `notExists` pins kept:
  targetWhere/setWhere skip, orphan guards — nothing here says "always".
  `ON CONFLICT` only per ATOM §4's narrow door (top-level scalar-arm), and
  only with a written parity disposition — otherwise probe-first everywhere.
  **Create-arm nested writes inside an upsert** (ATOM §8.1's P1 deferral —
  the fresh-parent adopt family) land here: the typed P1 rejection is
  replaced by the composed shape, elision rule applied.
  *Gate:* oracle + race convergence (Docker, two connections, convergence
  assertions — dual-run cannot see races); the P0 race test extended to
  connectOrCreate; the create-arm depth scenarios join the depth oracle.
- **P2c — nested update/updateMany/delete/deleteMany/set + createMany**: set's
  departing-rows orphan guard (a retained pin); `createMany` incl. the SQLite
  multi-statement summed-count plan and the skipDuplicates disposition
  (savepoint-wrapped executor effect in tx mode — not a plain SQL leaf);
  `producedRows` shapes as planning-time inlined sets. *Gate:* oracle grown to
  the full conformance scenario set for FK shapes; behavior suites green
  through the routing flag on all drivers, Docker named.

*Kill signal (all of P2):* the executor or frozen vocabulary needs an
operation-specific branch; or a kind cannot express itself as
probe-widened planning + linear steps. That is "rebuilding V1 under new
names" — stop, design note, deliberate decision.

## P3 — M2M, compound keys, the long tail of shapes

Junction part (two FK edges + join-row leaf); membership semantics as leaves —
symmetric-difference `set`/`deleteMany` with **materialized-set pins,
`raceable: true`** (Pin Rule class 3); self-referential M2M; compound keys
(per-field refs); mapped columns; multi-item and mixed inputs.
*Gate:* oracle + Docker staleness scenario (concurrently-added member aborts
the batch and retry converges); the M2M behavior suites through the routing
flag, every driver class.
*Kill signal:* an `M2M*` file family forming, or a membership set needing to
cross a write boundary at runtime (ATOM §3's stated boundary).

## P4 — Reads and the remaining surface

`find*`(+OrThrow), `count`, `aggregate`, `groupBy`, `exist`: genuinely
single-statement operations wrapping V1 builders — this part *should* be
boring, and its kill signal is any read needing more than one step. Explicitly
**not** boring, budgeted here by name: the `*AndReturn` variants on
non-returning drivers (`mutation-identity` pre/post reads and the
`requiresAtomicResolution` typed refusal kept as contract per ATOM §7) and
`updateMany`/`deleteMany` `rowCount` results.
*Gate:* full behavior-suite matrix through the routing flag for every migrated
operation, all driver classes, Docker named.

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
