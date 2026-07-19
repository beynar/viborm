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
materialized-set symmetric-difference guards (M2M `deleteMany`), which are
`raceable: true`. (M2M `set` needs none: it is an unconditional delete-all plus
probed inserts — no materialized set survives to go stale.)

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

**P2b update — the upsert family, and the create-arm deferral come due.** Root
`upsert` (`UpsertOperation`) is **probe-first**: a locate read decides create-vs-
update at planning, the `ON CONFLICT` narrow door (§4) deliberately **not** taken
(no vocabulary change; recorded disposition, not a design-note-to-the-freeze,
because the fragment surface was untouched). Three P2b facts land against the
census with **no new vocabulary**:

1. **`connectOrCreate` is the update-less adopt member (§6's trace), not a new
   Part.** It reuses `RelationUpsertPart` with a `family` discriminator: found →
   pure connect (empty update data → reparent only), absent → create (constraint
   + `racePin`). Its found premise is the same `exists` guard (`raceable: false`),
   carrying V1's verbatim `Record was replaced …` message. WHY §4.1 (one write
   part, leaves differ) holds — no `RelationConnectOrCreate.ts` was born.
2. **The `targetWhere`/`setWhere` skip pins are the RETAINED `notExists` pins of
   §2, now live.** Planning decides the located row does not match the
   conditional → silent no-op (V1's contract); batch pins that it still does not
   match with an `absenceGuard` (`notExists`, `raceable: true`). The validator's
   invariant-5 residue accepted them because the raceability is `true` (the
   materialized-condition class). Falsified once (guard removed → the staleness
   test passes with a stale skip → restored).
3. **Create-arm nested writes (ATOM §8.1's one P1 deferral) compose now.** A
   nested upsert's CREATE arm splices its own child parts under the freshly-
   inserted child; the elision rule (§4) makes correlation statically empty, so
   they adopt globally, correlated to the fresh child's compile-time literal PK.
   Bounded to `connectOrCreate` one level deeper (V1's runtime rejects a nested
   `upsert` under a create payload as found-uncorrelated, so V2 does not silently
   diverge). Recursion still adds only list entries and one parent-id value.

The `OperationFragment.ts` type surface was **unchanged** by P2b, so the P0
fragment-surface snapshot + executor token gate stayed green — the **freeze held**.

**P2c update — the write family closes, and the one dispositioned vocabulary row
goes live.** Nested `update`/`updateMany`/`delete`/`deleteMany`/`set` on a
child-held-FK to-many relation, and root `createMany`, land. Four facts against
the census:

1. **The correlated-mutation family is one write Part, leaves differ (WHY §4.1).**
   `RelationWritePart` serves nested `update`/`delete` (a *correlated* existence
   probe carrying technique #1's `Ref` to the located parent, then `UPDATE …
   SET`/`DELETE … WHERE unique`, pinned in batch by an exists guard; absent →
   V1's verbatim `Cannot {op} … for this parent`) and nested
   `updateMany`/`deleteMany` (one correlated bulk write `WHERE fk = parent AND
   filter`, no probe, zero rows a silent success). It reuses the exact shape of
   `RelationLinkPart`'s connect/disconnect — no new vocabulary, no new step kind.
   `UpdateOperation` now composes **multiple** mutation kinds on one relation
   (`{ delete, deleteMany }`, `{ update, updateMany }`) as several Parts in one
   linear fragment.

2. **`set` is membership as leaves, and the departing-rows orphan guard is a
   RETAINED `notExists` pin (§2), now live.** `RelationSetPart` reads the
   departing set at *planning* (correlated by a `Ref`) and inlines it into the
   final SQL at compile (`fk = parent AND NOT (unique … )`) — the row set is
   **planning-time only** and never crosses a write boundary at runtime (§3
   corollary, `ProducedRows` disposition). A required FK cannot be nulled, so a
   non-empty departing set is rejected at compile (V1's verbatim orphan message)
   and, in batch, pinned by a `notExists` guard (`raceable: true`) — the
   materialized-condition Pin-Rule class the validator's invariant-5 residue
   already accepts. A nullable FK nulls the departing set with one correlated
   bulk update. The pin was falsified once (guard removed → the staleness test
   passes with a stale set → restored).

3. **`createMany` consumes the multi-statement ordered-source-list output, and
   `onUniqueConflict: "skip"` becomes the ONE live vocabulary row.** The bulk
   insert is one INSERT where the dialect allows; where explicit row shapes
   differ it is several statements whose `rowCount`s **sum** through a fragment
   output source list (§1) — the SQLite multi-statement plan, but the rule is
   dialect-agnostic. `skipDuplicates` is a plain SQL leaf on `sql`-strategy
   dialects (`ON CONFLICT DO NOTHING`, `INSERT OR IGNORE` — the leaf carries the
   semantics, lowers to batch unchanged) and the **savepoint-wrapped executor
   effect** (`onUniqueConflict: "skip"`) on `recoverableUniqueError` dialects
   (MySQL), reusing V1's `executeSkippableWrite` verbatim. **Batch disposition
   (recorded):** the skip effect has no atomic-batch lowering — a batch is one
   indivisible unit, so per-row rollback is inexpressible — and a batch-mode step
   carrying it **fails closed**. MySQL runs transactions in production, so the
   effect always executes in tx mode; the `sql`-strategy batch path is proven on
   PGlite/SQLite/LibSQL.

**Design note — the P2c vocabulary change (the freeze's sanctioned path, not a
kill signal).** P2c adds exactly one field to `StatementStep`:
`readonly onUniqueConflict?: "skip"`. This is the realization of a census row
already dispositioned in P0 (§8's `onUniqueConflict: "skip"` = *an executor
effect, not a plain SQL leaf*), so it is a **vocabulary change made the
sanctioned way**: design note (here) + census row (already present, now marked
live) + the P0 fragment-surface snapshot updated deliberately. It is **not** a
kill signal: the executor handles it as a *generic* effect (any write declaring
it runs behind a savepoint; no operation-kind, relation-kind, or `createMany`
token enters the executor — the structural gate stays green), and no row set
crosses a write boundary at runtime. The step vocabulary is still exactly
`{read, write, guard}` and the exported type-name set is unchanged, so gate (d)
holds; only the `StatementStep` field snapshot moved, with this note attached.

**P3 update — M2M and compound keys, with NO vocabulary change (freeze held).**
Many-to-many is not special (WHY §4.3): the junction is two FK edges plus a
join-row write **leaf**, and every membership kind under a root `update`
(connect/disconnect/set/delete/deleteMany/update/updateMany) is one
`RelationJunctionPart` — a *file*, never an `M2M*` file family. It composes V1's
frozen junction SQL (`ManyToManyStatements.materialize` + `many-to-many-utils`,
the sanctioned reuse) as its leaves, so junction identity, mapped columns, and
self-referential A/B direction come from `getManyToManyJoinInfo` unchanged
(proven by a raw junction-row inspection test). Two census rows go **live**
without adding a primitive:

- **`ProducedRows` (multi-row capture)** — a M2M `deleteMany` reads the
  connected∧filter target set at *planning* (correlated to the located parent by
  a SQL `Ref`, technique #1) and inlines it into the final junction/​child SQL at
  compile. The set is **planning-time only** and never crosses a write boundary
  at runtime (§3 corollary) — the disposition, now witnessed by a live consumer.
- **materialized-set `notExists` pins (`raceable: true`, Pin Rule class 3)** —
  the `deleteMany` added/removed symmetric-difference guards (§2's retained
  pins). Falsified once (guards removed → the Docker-shaped staleness test with a
  concurrently-added member passes with a stale under-delete → restored); a plain
  rerun converges.

Compound keys are **per-field** everywhere in the new shapes: the root
`update`/`delete`/`upsert` locate and terminal reads carry every PK field
(each a `firstRowField` output of the locate — the census's multi-field
produces), the terminal read wraps them into the compound where-unique
(`buildPrimaryKeyWhereUnique`), and a compound child FK edge
(`RelationLinkPart`, connect/disconnect) writes/correlates every column from its
index-aligned referenced parent column. `set`/`update`/`delete`/`upsert` on a
compound FK child, and nested `create`/`connectOrCreate`/`upsert` under a M2M
target, stay V1's surface (typed `UnsupportedOperationError` → whole tree routes
to V1). The `OperationFragment.ts` type surface was **unchanged** by P3, so the
P0 fragment-surface snapshot + executor token gate stayed green — the **freeze
held**, no design-note-to-amend-the-freeze required.

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
