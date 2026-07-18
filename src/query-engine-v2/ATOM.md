# The Atom

> Companion to [`README.md`](./README.md) (the hypothesis),
> [`WHY-V1-GREW.md`](./WHY-V1-GREW.md) (the post-mortem), and
> [`PLAN.md`](./PLAN.md) (the phased path). This document is normative for the
> primitive: **if `Sql` was the wrong atom for an operation, what is the right
> one — what builders return, how SQL composes, and where the model's boundary
> is.**

The short version:

> **`Sql` stays the atom of *text*. The `Step` becomes the atom of
> *composition*. The bridge is that a `Ref` — a value that isn't known yet — is
> just an ordinary entry in `Sql.values`.**

Clause building does not change. Traverse-the-payload-and-build-SQL is correct
and survives untouched *within one statement*. It fails at exactly one place:
the **statement boundary**, where a value must flow from one statement's
*result* into another statement's *parameters*. Without a symbolic value there
are only two escapes, and V1 took both: inline a subquery (works only when the
value is re-derivable), or defer building statement 2 until statement 1 has run
(closures/context — the `Captures`/`ProgramValues` factories, and the reason
tx and batch became two runtimes: batch cannot defer). The `Ref` is the third
escape: everything is built upfront in both modes; only *materialization*
differs.

The existence proof that every supported shape fits this model: V1's own batch
runtime already executes decision reads up front against committed state, pins
premises with guards, linearizes the taken branches, and lowers generated ids
through scratch references. V2 does not have to prove linearization is
*possible* — V1's `OperationBatchRuntime` proves it daily. V2 has to prove it
can be the *only* mode, with the branch decisions hoisted into compile-time JS.

---

## 1. The shapes

```ts
/** A promised value: "whatever step X produced under name Y". A plain marker. */
interface Ref {
  readonly kind: typeof REF;      // unique symbol — cannot collide with user data
  readonly step: string;          // producing step id, e.g. "user.create"
  readonly output: string;        // which declared output, e.g. "id"
}

/** The composition atom. What an operation is a list of. */
interface Step {
  readonly id: string;                              // allocated by the scope (see below)
  readonly kind: "read" | "write";
  readonly statement: Sql;                          // values may contain Refs
  readonly produces: Readonly<Record<string, Source>>;
  /** Statement postcondition — what constitutes success (README §6). */
  readonly expects?: Postcondition;
  /** Write steps whose unique-constraint violation is the raceable signal
   *  carry their pinned target so retry classification can match the violated
   *  constraint (V1's UniqueConflictPin, reusing TargetConstraint). */
  readonly racePin?: TargetConstraintPin;
}

type Source =
  | { kind: "rows" }
  | { kind: "rowCount" }                            // updateMany/deleteMany/count
  | { kind: "insertId" }
  | { kind: "firstRowField"; field: string };

type Postcondition =
  | { kind: "exactlyOneRow"; failure: Failure }     // planning lookup, terminal read
  | { kind: "affectedRows"; expected: number | { min: number }; failure: Failure };

interface Failure {
  readonly kind: "nestedWrite" | "notFound" | "query";  // full V1 taxonomy
  readonly message: string;
  readonly relation?: string;
  readonly raceable: boolean;                       // per the Pin Rule classes
}
```

- **Step ids are allocated by the scope** (a counter, V1's `stepId()`
  precedent) — two same-model children under one parent must not collide.
- **Fragment outputs may name multiple sources** (an ordered list of refs whose
  rows concatenate) — `createManyAndReturn` on non-returning drivers, and
  SQLite `createMany` which compiles to several statements whose result is a
  *summed* `rowCount`.
- Postconditions are enforced where the substrate allows: tx mode checks the
  provider result before commit; batch mode lowers them to adapter-owned
  assertions inside the atomic unit.

Three deliberate asymmetries, each load-bearing:

**`needs` is never declared.** Dependencies are *derived* by scanning
`statement.values` (and guard `premise.statement.values`) for `Ref`s. Declared
lists rot; scanned ones cannot.

**`produces` must be declared.** Where a value comes from is capability
knowledge (`RETURNING` vs `insertId`); declaring outputs gives every value a
**stable address** consumers use identically under both capabilities.

**Order is the list, not a solver.** Refs induce a *partial* order; real
ordering constraints exist with no value flow (user-supplied FK values,
children-deleted-before-parent). The emitter owns total order; the checkable
invariant is only: **refs point backward.**

---

## 2. Probes: a read structurally chained to its pin

A **probe** is a planning read *plus* the premise its decision creates. This
pairing is structural, not conventional — it is how the Pin Rule (unification
design §5.5, the most expensive lesson in this repository) stays
machine-checkable when branch decisions move into opaque compile-time JS:

```ts
interface Probe {
  readonly read: Step;                       // the planning read (locked in tx mode)
  /** What pins the premise per outcome, decided at construction: */
  readonly pin: {
    readonly whenFound: GuardStep | "none";           // existing-row premises: pinned, raceable: false
    readonly whenMissing: GuardStep | "constraint" | "none";
    //  "constraint": the branch INSERTs into the same model under unique key K —
    //  the DB constraint enforces the premise; its violation is the raceable
    //  signal (racePin on the write step). Emitting a notExists guard here is
    //  the production-FATAL class. NEVER pin these.
  };
}
```

`compile(known)` consumes the probe's rows and emits the taken branch **through
the probe**, which contributes the correct pin (or none) automatically. A
decision made without a probe, or a probe whose pin was dropped, is a validator
error — the Pin Rule as an invariant, not a code-review hope.

Retained `notExists` pins (the Pin Rule's own exceptions — do not "optimize"
them away): the `targetWhere`/`setWhere` skip premise (no INSERT exists for a
constraint to fire on), the `set` departing-rows orphan guard, and the
materialized-set symmetric-difference guards (M2M `deleteMany`/`set`), which
are `raceable: true`.

---

## 3. The two flattening techniques

V1's batch runtime linearizes via a *staged, conditional* walk: it awaits each
decision read, then recurses into only the taken branch. The flat
`planning → compile` lifecycle closes that gap with exactly two techniques —
both mandatory knowledge for anyone writing a Part:

1. **Planning steps may `Ref` earlier planning steps.** The planning fragment
   is itself linear steps run by the same executor: a parent-locating read
   feeds a correlated child probe by ref. One batchable round-trip, versus
   V1-batch's sequential awaits.
2. **Probes are widened to unconditional supersets.** Where V1 runs a probe
   only on one branch, or a narrower probe per branch, V2 runs one
   unconditional read fetching the row *including the columns the decision
   needs* (e.g. its FK), and decides the three-way
   (correlated / uncorrelated / absent) in `compile(known)` JS — which may
   **throw typed errors** (the uncorrelated-exists arm; branch-selected
   legality). The emitted pin remains the narrow, correlated premise.

Corollary: `PlanningValues` carries **rows**, and row *sets* are
**planning-time only** — a membership set read at planning is inlined into the
final SQL at compile time (IN-lists of runtime cardinality). The batch scratch
mechanism threads **single scalars** (insertId) forward, never row sets. A Part
that needs a runtime row set to cross a write boundary has found the model's
boundary, not a missing feature.

Two dissolutions worth recording as evidence *for* the atom: V1's
`FallbackValue` (branch-dependent value defaulting) disappears entirely under
compile-the-taken-branch, and `DerivedValue` (arithmetic over an updated PK for
the post-update read) becomes ordinary adapter SQL wrapped around a ref at the
interpolation site — the same destination-aware pattern as ref casts.

---

## 4. The boundary (and its guardian)

Flat plan-then-compile is semantics-preserving **iff no decision depends on the
operation's own earlier writes**. That is not a hope — it is a *statically
checked precondition*, and its guardian is irreducible:

> **The own-write independence preflight.** Before planning, walk the payload
> tree recording each write's target/predicate/membership footprint; any
> decision read overlapping a prior same-operation write is **rejected** with
> the typed "split these operations into separate queries" error. This is
> V1's `OwnWriteLedger` analysis (≈1.2k lines of legality semantics, normative
> in the unification design §6.2) — it is *not* deleted plumbing; it is the
> soundness theorem of the whole architecture, and it defines the atom's edge:
>
> **A shape whose decision cannot be widened to an unconditional planning read
> is rejected, not linearized.**

One elision rule rides on it: a correlated probe under a parent that this same
operation *creates* is statically empty (fresh parent — no child can be
correlated to it yet); the probe reduces to its uncorrelated part or vanishes.
Write this down wherever it is used; it is the only case where planning
appears to need a produced value in its filter, and it dissolves statically.

**ON CONFLICT is a narrow door, not a default — and the door is drawn by
*semantics*, not syntax.** `INSERT … ON CONFLICT DO UPDATE` inherently means
"global lookup by constraint, adopt-and-update." It is therefore legal exactly
where that *is* the specified semantic:

- **top-level scalar-arm upserts** with an expressible conflict target — legal,
  but observably divergent from probe-first execution (sequence burn on the
  update path, MySQL `LAST_INSERT_ID` semantics, the pinned-abort error class
  disappearing), so it needs a written disposition against the oracle;
- **nested upsert under `create`** (the contract extension, PLAN P−1.2) —
  legal *because* adopt is the specified behavior there; per-dialect
  capability caveats (identity on non-returning drivers) still apply;
- **nested upsert under `update`** — **never**: the contract there is
  correlated (found-uncorrelated → typed error), and `ON CONFLICT DO UPDATE`
  on a child carrying `fk = parent` would silently adopt a foreign parent's
  child instead of throwing. Probe-first, always;
- **to-one upsert** — never: the decision is FK-slot occupancy, not a unique
  conflict; no conflict target exists.

---

## 5. Where "concatenation" happens

| Level | Unit | How it composes |
| --- | --- | --- |
| expression | `Sql` | template interpolation, exactly as today — clause builders unchanged |
| statement | `Step` | **never concatenated** — separate protocol units inside the tx/batch envelope |
| operation | `Step[]` | array concatenation, in emitter-chosen order, values linked by `Ref`s |

Two INSERTs were never going to be one string. They *sequence*, and what ties
them together is not text — it is a `Ref`.

---

## 6. The worked trace (a legal shape)

```ts
client.user.create({
  data: {
    name: "henry",
    posts: { connectOrCreate: { where: { id: 1 }, create: { id: 1, title: "post" } } },
  },
  select: { name: true, posts: true },
})
```

(`connectOrCreate` is chosen for the trace because it is the simplest member
of the adopt family. Its sibling, upsert-under-create — global lookup,
adopt-and-update — is a deliberate contract extension with identical step
anatomy plus an update payload on the found branch; see PLAN P−1.2.)

```ts
// PLAN: one unconditional probe (locked in tx mode) — decides connect vs create
probe = { read: read("post.find", buildFindUnique(post, { where, forUpdate: txMode }),
                     produces: { rows }),
          pin: { whenFound: guard.exists(raceable: false),
                 whenMissing: "constraint" } }         // Pin Rule: never a guard

// COMPILE(found): ONE linear list; refs carry the dataflow
steps = [
  write("user.create", buildInsert(user, { name: "henry" }),
        produces: { id: insertId /* or firstRowField — same address */ }),

  found
    ? write("post.connect",                            // connect = adopt: set the FK
        buildUpdate(post, { where, data: { userId: ref("user.create", "id") } }),
        expects: affectedRows(1, notFound))
    : write("post.create",
        buildInsert(post, { id: 1, title: "post", userId: ref("user.create", "id") }),
        racePin: uniqueTarget(post, ["id"])),          // violation = raceable signal

  read("user.select",
        buildFindUnique(user, { where: { id: ref("user.create", "id") }, select }),
        produces: { result: rows }, expects: exactlyOneRow),
]
```

The recursion is visible and cheap: a parent hands a nested Part only
`ref(parentStepId, pkField)` and a position (from FK direction). Depth adds
list entries, never vocabulary. Clause builders beneath
`buildInsert`/`buildUpdate`/`buildFindUnique` never learn `Ref` exists —
interpolation carries the marker through `Sql.values`.

---

## 7. Materialization: the substrate seam

```ts
materializeLinearSql   // tx: replace each Ref with the concrete prior result
materializeBatchSql    // batch: lower each Ref to adapter batch-reference SQL
```

~24 lines combined, already in the executor. This does not delete every line of
batch handling — guard attribution, postcondition assertions, the atomic
envelope remain — but **no semantic decision is ever implemented twice**. One
compile path; the substrate is a resolve function.

Batch caveats that are contract, not detail: after an atomic batch rolls back,
the scratch table is gone — post-hoc guard attribution must **skip premises
whose probes embed scratch reads** (re-probing them would error, not attribute).
And result parsing happens after commit, so operations whose public result
cannot be produced without post-commit reads on non-returning drivers keep
V1's typed refusal (`requiresAtomicResolution`) unless a deliberate design
note lifts it.

---

## 8. Vocabulary census — every V1 program primitive, dispositioned

The freeze (PLAN P1) is legal only when this table has no `TBD`. Each row is a
V1 `operation-program.ts` concept and where it lives in V2:

| V1 primitive | V2 disposition |
| --- | --- |
| `ProducedValue` | `Ref` + declared `produces` |
| `ProducedRows` (multi-row capture) | planning-time read, set inlined at compile; never crosses a write boundary |
| `DerivedValue` (PK arithmetic) | adapter SQL wrapped around a `Ref` at emit time |
| `FallbackValue` | dies — compile emits only the taken branch |
| `CapturedRead` / planning statements | planning fragment steps (may ref each other) |
| `BranchStep` + `whenTrue/whenFalse` | dies — decided in `compile(known)` JS via widened probes |
| `BranchStep.pin` / `NoBranchPin` / `UniqueConflictPin` | `Probe.pin` (§2) + `Step.racePin` |
| `expectedCardinality` / `affectedRows` contracts | `Step.expects` postconditions (tx: result check; batch: adapter assertion) |
| `ProgramFailure.kind` (`nestedWrite`/`notFound`/`query`) | `Failure.kind` — full set, day one |
| `failure.raceable` | `Failure.raceable`, values per Pin Rule class |
| `onUniqueConflict: "skip"` (createMany skipDuplicates) | an executor *effect* (savepoint-wrapped write in tx mode), not a plain SQL leaf — dialect leaf only where semantics match exactly |
| own-write independence analysis (`OwnWriteLedger`) | the preflight (§4) — ported, not deleted |
| `requiresAtomicResolution` refusal | kept as typed contract (§7) unless a design note lifts it |
| multi-statement results (SQLite createMany, AndReturn refetch) | fragment outputs as ordered source lists (§1) |

### 8.1 P1 disposition — the freeze closes with no `TBD`

At the end of P1 (composition: the `Part`, the preflight, the create+upsert and
update+upsert slices, the **recursive-composition depth gate**
`update > upsert > upsert`, the `PendingOperation` contract) every row above is
either **live in code** or carries an explicit *consumer-arrives-at-phase-X*
note. The fragment type surface (`OperationFragment.ts`) was **unchanged** by
P1, so the P0 snapshot + executor token gate remain the freeze mechanism.

The depth gate is what proves README Question 2 (compose *recursively* without a
universal IR): a `RelationUpsertPart` whose found+correlated arm splices its own
child parts, correlated to its (literal, located-by-PK) primary key. Recursion
adds list entries and one parent-id value — never a Part method, a step kind, or
a parent reference (WHY §4.2). Create-arm nested writes (a fresh child, ATOM
§4's elision case) are the one deferral: they carry the fresh-parent adopt
family and land in P2 — so a nested relation mutation inside an upsert's
`create` payload is a typed rejection in P1, and depth composes only on the
found arm, which the depth-gate dual-run oracle certifies at three levels.

| V1 primitive | P1 status |
| --- | --- |
| `ProducedValue` | **live** — the create slice's child FK is `ref(user.create, id)` |
| `ProducedRows` (multi-row capture) | inert — single-row probes only; multi-row inlining arrives P2c (`createMany`) |
| `DerivedValue` (PK arithmetic) | inert — no PK arithmetic in P1; arrives P4 (`*AndReturn` refetch) |
| `FallbackValue` | **gone** — `compile(known)` constructs the taken arm (build-don't-select); no pre-frozen pair |
| `CapturedRead` / planning statements | **live** — the update slice plans a locate read + a widened probe; the depth gate plans one read per level (locate + two probes). Their cross-read dependency is realized at the compile-data boundary (`known`). Technique #1's SQL-level planning→planning `Ref` is **inert** (no positive witness in P1) — see design note **(a)**: the upsert family structurally cannot construct one; it arrives with a hard-correlation nested read (P2a) |
| `BranchStep` + `whenTrue/whenFalse` | **gone** — the three-way (correlated / uncorrelated / absent) is `compile(known)` JS |
| `BranchStep.pin` / `UniqueConflictPin` | **live** — `Probe.pin` (found: exists guard `raceable:false` / batch, lock / tx) + `Step.racePin` (missing arm) |
| `expectedCardinality` / `affectedRows` | **live in tx** (executor result check: update-arm `affectedRows(1, notFound)`, terminal `exactlyOneRow`). Batch-mode adapter assertion arrives P2a. See design note **(b)**: P1's missing-root notFound is decided at compile from the locate read on both substrates, so batch parity holds without the assertion |
| `ProgramFailure.kind` | **live** — `nestedWrite` (V7001, verbatim), `notFound`, `query` |
| `failure.raceable` | **live** — Pin-Rule values (found `false`, missing arm enforced by constraint) |
| `onUniqueConflict: "skip"` | inert — arrives P2c (`createMany` skipDuplicates, savepoint effect) |
| own-write independence | **live** — `OwnWritePreflight` wraps V1's `assert{Create,Update}OwnWriteSafety` verbatim; the same-child-unique upsert pair rejects typed |
| `requiresAtomicResolution` refusal | inert — arrives P4 (non-returning `*AndReturn`) |
| multi-statement results (ordered source lists) | type live; consumer arrives P2c/P4 |

**Design note (a) — technique #1 (SQL planning→planning `Ref`) is inert in P1,
and the upsert family cannot witness it.** PLAN P1.1(b) *designed* the parity
slice to force a child probe carrying a SQL-level `Ref` to the locate read. The
delivered slice discovered that intent to be unreachable for the *upsert*
family, at any depth, for two independent structural reasons:

1. **V7001 observability.** A correlated upsert must observe a
   *found-uncorrelated* child to throw the typed V7001. That requires the probe
   to stay **uncorrelated** (technique #2's widened superset); a correlating
   `WHERE fk = ref(parentRead)` returns empty on the foreign row instead of
   exposing it, so the error can never fire.
2. **Absent-parent resolution.** The child probe runs at *planning*, before any
   arm is chosen. If the parent read found nothing (missing root, or a
   to-be-created middle child), a `firstRowField` ref into its rows is
   unresolvable — it would throw at planning instead of yielding the clean
   compile-time `notFound` / create-arm.

Both hold at depth: the depth gate's grandchild probe is likewise uncorrelated,
and its parent id is a compile-time literal (the located-by-PK middle child's
key), never a SQL ref. So **every** P1 upsert shape decides correlation at the
compile-data boundary (`known`, invariant 3's sanctioned crossing) — technique
#1 has **no positive witness in P1**, and the census disposition above is
*inert*, not "live via the validator." The architecture still *permits* a
planning→planning `Ref` (invariant 2 accepts a backward one), but permission is
negative space; the positive witness is a **hard-correlation nested read** — a
child filtered by `WHERE fk = ref(parentRead)` as an existence test with *no*
found-uncorrelated arm (nested `connect`/`update`, P2a). That shape genuinely
needs the ref, and it is where technique #1 ships proven. *(P1 refinement of
reality: PLAN P1.1(b)'s premise was wrong for upsert; corrected there.)*

**P2a update (a) — the witness shipped.** The nested **disconnect** on a to-many
FK edge (`UpdateOperation` → `RelationLinkPart`) reads the child `WHERE unique
AND fk = ref(user.locate.id)` — a *planning* read whose `Sql.values` literally
carries a backward `Ref` to the locate planning step, and whose existence test
has **no** found-uncorrelated arm (disconnecting a foreign child is V1's verbatim
`Cannot disconnect … for this parent`, not an adopt). The absent-parent hazard of
note (a) point 2 is closed structurally: the locate read now carries the
`notFound` postcondition, so a missing root aborts at planning *before* the
correlated probe dereferences the located id. An emitted-planning-fragment
**inspection** test asserts the `Ref` marker is present in the probe statement's
`values` (not merely that the validator accepts the shape). Technique #1 is now
positively witnessed.

**Design note (b) — missing-root is a compile-time decision in P1.** The root
`update` carries the `notFound` postcondition (tx: executor result check). Its
batch-mode adapter assertion is P2a work (staleness). P1 needs no such assertion
because the locate planning read observes the root's absence *before* any write,
so `compile` throws `NotFoundError` on both substrates with no partial mutation —
the same fail-closed outcome the postcondition would give, minus race coverage
(which the single-threaded P1 oracle cannot exercise anyway; P2a adds it).

**P2a update (b) — the batch assertion shipped without a vocabulary change.**
Root `update`/`delete` in batch mode emit an adapter-owned **`exists` assertion**
on the located row's unique key (`presenceGuard`, `raceable: false`, `notFound`
failure), hoisted ahead of every write inside the atomic unit — the
affectedRows/notFound postcondition *lowered to the guard vocabulary that already
existed* for the found-upsert premise, reusing `adapter.assertions.exists`. No
`OperationFragment` type changed: the P0 fragment-surface snapshot and executor
token gate stayed green, so the **freeze held** (no vocabulary change, hence no
design-note-to-amend-the-freeze). The one generic executor change is that guard
attribution now honours `failure.kind` (a `notFound` guard yields `NotFoundError`
via the shared `failureError`, not always `NestedWriteError`) — taxonomy already
in the census, not an operation-specific branch. Per-premise-class
staleness-injection tests (the before-batch driver hook) prove each existing-row
premise — root presence, upsert-found, connect-target, disconnect-correlation —
aborts the batch typed; the assertion and the injection were each falsified once
(removed → the staleness test fails → restored).

---

## 9. Invariants (the executable contract)

An operation is valid iff:

1. step ids are unique (scope-allocated);
2. every `Ref` in any statement **or guard premise** points backward to a
   declared `produces` entry — and refs are **fragment-local** (a ref into
   another fragment is a validator error, not a runtime surprise);
3. within a fragment, no raw JS value crosses a statement boundary by any
   channel other than a `Ref`. (Planning outputs entering `compile(known)` as
   data is the sanctioned crossing — that is the architecture's mechanism, and
   it happens *between* fragments, before the final fragment exists);
4. every fragment output resolves to produced values at parse time (never a
   `Ref`, never `Sql`);
5. every branch decision is consumed through a `Probe`, and every probe's pin
   disposition obeys the Pin Rule: existing-row premises pinned
   `raceable: false`; same-model-INSERT missing premises enforced by
   constraint + `racePin`, never guarded; materialized-set premises pinned
   `raceable: true`;
6. the preflight (§4) has proven every planning read independent of every
   same-operation write — or the operation was rejected with the typed error.

These are compiler-output checks, cheap enough to assert in tests and (for 2
and 4) in the executor. They are the whole safety story of the atom;
everything else is ordinary SQL the builders already know how to write.
