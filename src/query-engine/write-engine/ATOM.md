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

## 0. Conventions (normative)

**Cross-cutting seam helpers live in ONE home.** A helper that mediates a boundary shared by
every operation — turning a user payload into a validated, typed value; lowering a result
across the statement boundary — is defined once and imported, never re-copied per operation
file. The absence of this norm is what let FIVE `parseRecord`/`validateCreateArgs`/
`validateUpdateArgs` copies drift apart (each with its own hardcoded operation name and its
own dead `isRecord(result.value)` re-check). X2's `parseValidated` (`parse-boundary.ts`) is
the enforced instance: the single typed parse seam, returning the schema's `InferOutput` and
carrying the ONLY `as` the engine needs (after the schema has proven the shape). A new
per-file copy of a seam helper is a regression — `parse-boundary-gate.test.ts` pins
`parseValidated` (and its whole-tree cast) to one home and fails loudly if a copy reappears.
The one deliberate exception, `assertUpsertKeys`, is documented in §8.1 (X2): upsert's
delegated arms re-parse the RAW payload, so it cannot flow through a single whole-args parse.

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

> **Naming note (W3-B, maintainer decision D-1).** `createManyAndReturn` and
> `updateManyAndReturn` are **internal names only** throughout this document and
> the engine. They were removed from the public client surface and replaced by
> IMPLICIT RETURNING: `createMany` / `updateMany` take an optional `select`, and
> its presence routes the tree to the row-returning arm these two names refer to
> (`src/query-engine/write-engine/routing.ts`, `returnsRows`). Every user-facing message
> spells the public form (`'createMany' with 'select'`); nothing below changes
> mechanically, only what the client is allowed to type.
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

**A pin comes from the DISCRIMINATOR, never from a filter (W4-U1).** Since
Prisma ≥ 4.5 a top-level unique `where` may carry non-unique scalar filters and
`AND`/`OR`/`NOT` alongside its unique discriminator. Those filters narrow which
row a statement touches; they name no row and no constraint, so nothing pinned
may read them. The split is structural rather than a convention: the extraction
function `getWhereUniqueEntries`
(`src/query-engine/builders/where-unique-builder.ts`) returns the discriminator
alone, and every pin site already went through it — `buildWhereUnique` is the
only thing that compiles both halves.

The rule extends past pins to the `racePin` itself. A `racePin` asserts *the
locate proved unique key K free*; under an extended `where` the locate proved
only that no row matches `K ∧ filters`, which is weaker. So an upsert whose
`where` carries filters emits **no** create-arm `racePin`: its violation is a
genuine conflict (a re-plan re-reads the same excluded row and creates again),
and retrying it would both waste a round-trip and mis-classify a
P2002-equivalent as raceable. Withholding a pin whose premise was not
established is the same discipline as never emitting one the constraint owns.

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

#### The first bullet's disposition, written (PLAN Decision 7.1, 2026-08-03)

The door is **TAKEN** for the top-level scalar-arm upsert. `UpsertOperation.-
buildOnConflictFold` emits one `INSERT … ON CONFLICT (target) DO UPDATE …
RETURNING` — empty planning, one step, no envelope — and everything outside its
seven conjuncts keeps the probe-first sequence byte-identically. "An expressible
conflict target" is one of those seven and is narrower than it sounds: a
`whereUnique` may name SEVERAL independent uniques at once, and only a selector
naming exactly ONE constraint has a target an index can match. The full record,
with the numbers, is the plan doc's Decision 7.1 section; what belongs *here* is
what the three divergences this section named turned out to be when measured.

- **"sequence burn on the update path"** — **REAL, and ACCEPTED.** The statement
  evaluates the INSERT's defaults before it detects the conflict, so a generated
  identity the create data omits consumes a value even when the row existed:
  PostgreSQL `last_value` 100 → 101, SQLite `sqlite_sequence` 2 → 3. Probe-first
  consumes none. Sequences are documented as non-gap-free on both dialects.
  Pinned as a test, not as prose, so it stays a number.
- **"MySQL `LAST_INSERT_ID` semantics"** — **does not arise, and could not have
  been made to.** The door is closed to MySQL by a capability,
  `supportsTargetedUpsert`, and closed for a stronger reason than identity
  reporting: `ON DUPLICATE KEY UPDATE` carries no conflict target and fires on
  ANY unique collision, so an unrelated collision would silently adopt a row the
  caller never named. That is a wrong answer, which is why it is a capability
  rather than an inference — and why it must not be collapsed into
  `supportsReturning`, whose per-adapter values happen to match today.
- **"the pinned-abort error class disappearing"** — **not observable.** The
  create arm's `racePin` never surfaced a class of its own; it classified a
  unique violation so the routed layer could retry ONCE and converge. The folded
  statement converges without retrying, to the same answer. The dual-run oracle
  found the thrown error's class, code and `meta` identical on every payload
  that throws at all, including both unrelated-collision shapes.

**And the guardian this section exists to protect is intact.** The elision that
makes the fold sound is not a new one: the door is only open where the operation
asks the database *nothing* before it writes, so there is no planning read whose
answer a write could invalidate. The Pin Rule has nothing to bind — which is the
same reason the folded step carries no `racePin` and the executor's
statement-atomic path accepts it. The race protection is discharged by the
database rather than removed; a competitor on its own connection taking the
contested key in the decision-to-write window is adopted by `DO UPDATE` in one
statement, where probe-first loses its INSERT and pays a full retry to converge.

### 4.1 The own-write linearization (N6-U3 — AMENDMENT, 2026-07-30)

The guardian above says "*earlier* same-operation write". It never said **in which
order** — and for as long as it did not, the engine answered the question twice.

**The fork, measured.** Two fixed orders existed. `RELATION_MUTATION_KEYS`
(`builders/relation-mutation-parser.ts`) ordered the parts the engine EMITS, at four
call sites through `getRelationMutationKinds`. `planRelationMutationSteps`
(`RelationMutationPlan.ts`) ordered the footprints the legality walk DERIVES, in its
own if-chain. They agreed on nine kinds and disagreed on the tenth pair: emission ran
`upsert` before `deleteMany`, derivation ran `deleteMany` before `upsert`. So the
soundness precondition of a shape was checked against a sequence the engine never
executed — over-refusing where derivation put a write first, and (on a many-to-many,
whose `deleteMany` reads) under-refusing in the other direction. **That is the forked
theorem the plan warned about, and it was not in the Parts. It was in the order.**

**The rule.** Sibling mutation kinds on one relation linearize in ONE fixed,
documented order, declared once as `RELATION_MUTATION_KEYS`, used by BOTH the emission
and the derivation. The legality walk runs over that ordered sequence exactly once, at
the boundary, before planning. No Part re-derives legality for its own kind; there is
one derivation and one order, so there is nothing to fork.

**Why it is sound now — the invariant, named.** Nothing about the preflight is
weakened: a decision read still may not depend on a write this operation performs
before it. What changed is that the order is now *chosen* so that the dependency does
not arise. The three stages, and the invariant that draws their boundaries:

| Stage | Kinds | Footprint |
| --- | --- | --- |
| 1 — named readers | `disconnect`, `delete`, `update`, `upsert`, `connectOrCreate` | read committed state; write **bounded** by the identity the payload spells |
| 2 — unbounded writers | `set`, `updateMany`, `deleteMany` | a whole-membership declaration or a filter — a footprint they cannot bound |
| 3 — pure adders | `connect`, `create`, `createMany` | no decision read at all |

> **The linearization invariant: every decision read is ordered before every write
> that could not be bounded, and every kind that reads nothing is ordered last.**

Given the invariant, what a rejection can still mean is exactly two things, and both
are honest: (i) two kinds name the **same row** with conflicting intents — a
contradiction in the payload, not a limit of planning; or (ii) an unbounded *reader*
(a many-to-many `deleteMany`, whose filter must be resolved against membership) sits
behind a sibling that writes the same model, which no ordering can fix because the
filter's result set cannot be bounded at compile. Measured across all 55 unordered
sibling pairs × {child-held to-many, many-to-many} × {disjoint identities, same
identity} plus the create root: **92 combinations rejected before, 41 after** — 33 of
class (i) and 8 of class (ii), with nothing left over. All eleven kinds at once on a
child-held to-many went from rejected to executing.

**The exact order** — and the state each adjacent pair therefore produces:

```text
disconnect → delete → update → upsert → connectOrCreate      (1: named readers)
          → set → updateMany → deleteMany                    (2: unbounded writers)
          → connect → create → createMany                    (3: pure adders)
```

* `delete` then `create` of the same identity — the row that remains is the **fresh**
  one. (Rejected before the amendment, in both spellings.)
* `set` then `create` — final membership is exactly **set ∪ created**. (Before, `create`
  ran first and `set` orphaned the row the same payload had just inserted.)
* `updateMany`/`deleteMany` then `create` — a filtered bulk kind **never** consumes a
  row this operation is about to add.
* `disconnect` and `connect` on distinct targets compose in either spelling.

**Divergence from Prisma, measured not assumed** (Prisma 7.9.1, `prisma-client`
generator, pg adapter, query log captured per shape). Prisma has **no** order: it
executes sibling kinds in the enumeration order of the JavaScript object literal.
`{ create, connect }` emits INSERT-then-UPDATE and `{ connect, create }` emits
UPDATE-then-INSERT; worse, `{ create, deleteMany }` **deletes the row it just
created** (`DELETE … WHERE id IN (770, 901)`, where 901 is the row the same payload
inserted) while `{ deleteMany, create }` keeps it. `{ create, delete }` on one identity
raises a unique violation where `{ delete, create }` succeeds. That is not a documented
contract — it is [prisma/prisma#16606](https://github.com/prisma/prisma/issues/16606),
open and labelled `bug/2-confirmed`, whose reporter states the behaviour "match[es] the
enumeration order of the JS object parameter". viborm's order is fixed, documented, and
independent of how the caller happened to spell the object; where Prisma's sane
spelling and ours differ, ours is the one that never destroys a row the same call
created. (Prisma also does not offer `createMany` on an implicit many-to-many at all —
a TypeScript error on the generated input type — so that arm has no Prisma order to
match; see N3-U1.)

**What this amendment does NOT license.** It does not linearize a decision that needs
a value only an earlier write produces. The guardian's sentence stands verbatim: *a
shape whose decision cannot be widened to an unconditional planning read is rejected,
not linearized.* Ordering removes dependencies; it never resolves one. A future unit
that wants case (ii) must widen the read (technique #2), not re-order — and must do it
in the one derivation, never per Part.

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

**P4 update — reads and the remaining surface, with NO vocabulary change (freeze
held).** The read family (`findUnique`/`findFirst`/`findMany` + their `OrThrow`
variants, `count`/`aggregate`/`groupBy`/`exist`) is genuinely single-statement:
each is one `ReadOperation` whose compiled fragment is **exactly one read step**
wrapping the same SQL the V1 read builders produce (`buildFind`/`buildFindUnique`/
`buildCount`/`buildAggregate`/`buildGroupBy`, reused not re-derived), parsed
through the same `ResultParser`. Planning is empty. `OrThrow` is a typed
`notFound` surfaced **from the result** (a `null` findUnique is a value, not a
postcondition), byte-identical to V1's `NotFoundError`. No read needed more than
one step, so the kill signal never tripped.

The named stragglers landed without a primitive, and the last two dormant census
dispositions went **live**:

- **`DerivedValue` (PK arithmetic)** — `updateManyAndReturn` on a non-returning
  driver captures the target PK set at *planning* (locked), then re-reads the rows
  by their **post-update** PKs, which `getUpdatedPrimaryKeyValues` computes by the
  same portable arithmetic V1 uses. The captured set is planning-time only and
  inlined at compile (§3 corollary), never crossing a write boundary.
- **multi-statement results (ordered source lists whose rows *concatenate*)** —
  `createManyAndReturn` is one `INSERT … RETURNING` per input row (returning
  drivers) or an interleaved `INSERT`+refetch per row (non-returning, via
  `getCreatedRowWhere` — the DB session `lastInsertId()` resolves each refetch),
  whose rows concatenate **in input order** through a fragment output source list.
  P2c made the *summed-`rowCount`* form live (`createMany`); P4 makes the
  *concatenated-rows* form live. Root `updateMany`/`deleteMany` return `{ count }`
  through the `rowCount` source (`BulkCountOperation`), one write step.

- **`requiresAtomicResolution` refusal — KEPT AS CONTRACT (§7).** On a
  non-returning driver in forced batch, a `*AndReturn` cannot resolve its returned
  identity atomically (result parsing happens after the atomic unit commits and
  cannot be rolled back). V2 refuses with V1's **byte-identical** typed
  `TransactionError`, thrown at construction before any I/O — **never** weakened
  into a route (an emitted-error inspection test runs V1 and V2 through one engine
  and asserts equal `name`+`message`). The one genuinely inexpressible sub-shape —
  `createManyAndReturn skipDuplicates` on a non-returning driver, where a skipped
  INSERT would refetch a pre-existing row — is an honest per-tree
  `UnsupportedOperationError` **route** to V1, distinct from the refusal.

The `OperationFragment.ts` type surface was **unchanged** by P4 — the P0
fragment-surface snapshot + executor token gate stayed green, the **freeze held**,
no design-note-to-amend-the-freeze required. `StatementStep.onUniqueConflict`
remains the only executor effect annotation (no second one formed).

**P4.5 update — the last routed write shapes absorbed, one route left, with NO
vocabulary change (freeze held).** Two of the three routes the P4 report tracked
(`routedToV1StillRemaining`) are gone; the third is now the *only* deliberate
route to V1.

- **M2M create/connectOrCreate/upsert through the junction** are ordinary
  members of `RelationJunctionPart` — no `M2M*` file family formed (WHY §4.3, the
  kill signal never tripped). `create` INSERTs the child then the join row (V1's
  `ManyToManyMemberships.create` leaves); `connectOrCreate` is an *uncorrelated*
  global probe (technique #2) whose found arm joins (pinned `raceable: false`,
  V1's `Record was replaced …` wording) and whose missing arm creates + joins
  (constraint + `racePin`, never a `notExists` guard — Pin Rule class 2);
  `upsert` is the correlated three-way (V1's `ManyToManyMutations.upsert`): a
  member updates (membership `exists` guard, `raceable: false`), a
  globally-existing non-member throws V1's verbatim V7001, an absent target
  creates + joins. Duplicate array targets are deduplicated **at compile** — an
  earlier item's created target makes a later same-target item adopt/update it —
  V2's flat realization of V1's sequential branch-ledger merge (DESIGN §6.2), so
  no member set crosses a write boundary and no own-write dependency is
  linearized. The child PK the join row needs is a compile-time literal the
  create data carries; an auto-generated M2M child identity is
  create-through-junction with a *produced* value and stays V1's (a documented
  bound, routed at construction — never reached by any current schema, whose M2M
  targets all carry provided PKs).
- **Compound-FK nested writes** (`set`/`update`/`updateMany`/`delete`/
  `deleteMany`/`upsert`/`connectOrCreate` on a child-held compound FK) are the
  **per-field generalization** of P3's `RelationLinkPart` precedent, now shared by
  every FK-edge Part through one `parent-reference.ts` value resolver: every child
  FK column is written/correlated from its index-aligned parent *referenced*
  column (ATOM §1's multi-field produces). A **D4-style** edge referencing a
  *non-PK* unique rides the same path — `UpdateOperation`'s locate read selects and
  exposes every referenced column (PK, a subset, or a non-PK unique) as a
  `firstRowField` output, so the per-field parts read or ref each one. No shape
  routes to V1 on account of compound arity any more.

The one route that survives is `createManyAndReturn skipDuplicates` on a
non-returning driver (a skipped INSERT would have to refetch a pre-existing row —
inexpressible as linear steps; ATOM §7's honest route, distinct from the
`requiresAtomicResolution` refusal). A **route-inventory** test pins it: it runs
every previously-routed shape through V2's construction and asserts the set that
still routes is EXACTLY that one. The `OperationFragment.ts` type surface was
**unchanged** by P4.5 — the P0 snapshot + executor token gate stayed green, the
**freeze held**, `StatementStep.onUniqueConflict` is still the only executor
effect. The two new adopt premises (connectOrCreate found, upsert member) are the
existing-row `presenceGuard` class (Pin Rule class 1, `raceable: false`), each
given a before-batch staleness-injection test and each falsified once.

**P5 update — the default flip is wired and default-ON, and the parity soak
found real divergences (freeze held; NO vocabulary change).** The per-tree
router (`routing.ts`) is built into the production dispatch
(`client.ts` → `PendingOperation.createRouted` → the V2 executor), obeying the
proxy's routing law: construct V2 for the whole payload; `UnsupportedOperationError`
→ V1; any other construction error propagates. One migration-temporary escape
hatch — `queryEngine: "v1"` — forces the frozen runtime for A/B and rollback,
scheduled for deletion in P6. The `OperationFragment.ts` surface was **unchanged**
by P5 (snapshot + token gate green).

The soak — the **first** full-suite run of the V1 conformance corpus against V2
(the P0–P4.5 oracle only ever certified V2's own scenarios) — surfaced behavior
divergences the oracle never exercised. They are **adoption-standard conflicts**,
recorded, not softened (KILL SIGNAL): none was routed away, no assertion loosened,
no test pinned to V1 to hide it.

- **One routing-completeness bug was fixed cleanly.** A nested relation write
  inside `update`/`updateMany` data threw its `UnsupportedOperationError` from
  `RelationWritePart.scalarData()` during `compile()` — *after* the planning read —
  so the construction-time router could not fall back, and V2's message surfaced
  where V1's was the contract. The payload-determined rejection now fires in the
  Part constructor (before any I/O). This is the general shape of the class: **a
  route decision must be made at construction, never deferred to compile.**
- **Genuine behavior divergences remain open (conflicts).** On *returning* drivers
  a handful of nested-write-conformance edges diverge (a PK-transition + self-M2M
  emits a mis-ordered write → `ForeignKeyError` where V1 succeeds; several
  "disjoint decision" scenarios are over-rejected). A concurrent selector-move
  ("split-witness") is not caught by V2's correlated guard the way V1's
  captured-PK+selector guard catches it — a race-safety gap. The batch-only
  non-returning `upsert`/`update` `requiresAtomicResolution` refusal is not
  reproduced (V2 fails at runtime as "Query execution failed" instead of V1's
  byte-identical typed refusal). Several invalid-payload rejections differ in
  message or are missing (`deleteMany` on a to-one; non-PK-referenced arithmetic;
  divide-by-zero / float-PK wording; empty `createMany`). Real MySQL is 467/468
  and Docker Postgres is at its 407/14 baseline, so V2 is **behaviorally close**
  on real drivers; the divergences concentrate in the PGlite conformance/internals
  corpus. A body of those failures assert V1's **non-returning statement mechanics**
  (lock-by-selector → capture PK → mutate/refetch by captured PK, statement counts)
  — V2's atom model produces correct behavior via different statements; those are
  V1-internal-mechanics assertions listed in the P5 report.
- **The flip carries a measured write-path performance regression** (PERF.md P5):
  V2 is 1.84× slower on `upsert` and 2.37× slower on a scalar `update`, because
  plan-then-execute issues locate+mutate+refetch where V1 folds `UPDATE … RETURNING`.

The seam is correct and its six preserved contracts pass and are falsified
(`p5-flip-contract.test.ts`). But the default-ON flip is **not** production-clean:
the behavior conflicts and the write-path regression must be closed first. This is
the "stop at the phase boundary, oracle green, and think" state — the V2 oracle is
green (325/325), the gates are green, and the divergences are named for the next
thread rather than papered over.

**P5 fix round 1 — the safety gap and three behavior divergences closed (no
vocabulary change; freeze held).** Adversarial review confirmed the split-witness
race as blocking. It and the tractable behavior conflicts are now fixed, each
without weakening a contract:

- **Split-witness race-safety (was blocking) — CLOSED.** V1's captured-PK+selector
  correlation is ported into every nested targeted mutation. The targeted
  `update`/`delete`/`set`/junction probe already captured the row's PK at
  planning; the write now addresses that captured PK (V1's `WHERE id` mechanics),
  and the batch presence guard requires the ORIGINAL selector AND the captured PK
  to still name the same row (`RelationWritePart`, `RelationSetPart`,
  `RelationJunctionPart` — child `SELECT` for adopt/set/connect, `membershipRead`
  where-filter for delete/update/upsert-member). A concurrent selector-move onto a
  replacement now leaves no row matching both, so the batch fails closed instead of
  mutating/linking the replacement. Closes the 5 split-witness witnesses + the
  captured-PK mechanics (`nested-single-mutation-identity`).
- **Non-PK referenced-key arithmetic — CLOSED.** `assertRelationKeyUpdatesAre-
  Compilable` (V1's, ported verbatim) now runs in `UpdateOperation`, rejecting a
  non-literal op on the parent column a child FK references, not only the
  parent-held FK.
- **Non-returning no-op count — CLOSED.** The root update's exact-affected
  postcondition is a returning-driver check only; on a non-returning driver the
  locked locate already proved existence, so a no-op UPDATE is accepted (V1's
  `affectedRows: unrestricted`).
- **Nested/top-level PK-arithmetic message parity — CLOSED.** V1's
  `assertPortablePrimaryKeyUpdateInput` (its shared validator's check) now runs at
  construction in `UpdateOperation`/`RelationWritePart`/`RelationUpsertPart`, so
  a non-portable float-PK, divide-by-zero, or stacked-op is rejected before I/O
  with V1's byte-identical message.

- **Batch-only non-returning refusal (ATOM §7) — REBUTTED, not a clean fix.** A
  blanket constructor refusal on `upsert`/`update`/`delete` (mirroring
  `ManyAndReturnOperation`) breaks **31** batch-execution behavior tests: V2
  DELIBERATELY executes a non-returning `upsert`/`update`/`delete` in a forced
  atomic batch — its public result comes from an **in-batch terminal `SELECT`**, so
  there is no post-commit parse to roll back (the `MySQL2BatchForcedDriver` wraps
  the batch in a real transaction; the tx-mode parse-failure rollback tests prove
  the safety). This is genuinely UNLIKE `*AndReturn`, whose generated identities
  require a post-commit read and which therefore does refuse. The single MySQL
  467/468 witness (an invalid-DB pre-access refusal) encodes V1's over-conservative
  blanket refusal; adopting it regresses 31 V2 capability contracts — the kill
  signal. Recorded as an adoption-standard conflict; the refusal, if wanted, is a
  routed-layer/design decision, not an operation-level fix.

**Still open after round 1 (named, not hidden):** the RETURNING fast path (the
write-path perf regression, PERF.md P5); the omitted-generated-PK capture in the
non-returning upsert create branch; two returning-driver nested-write edges
(PK-transition + self-M2M mis-order; child-held `connectOrCreate` first-create-wins
dedup — both need cross-part/write-order coordination); the batch-only-refusal
conflict above; and a set of message/statement-mechanics assertions the minimized
atom does not reproduce (V1's max-affected postcondition — inexpressible without
growing the FROZEN vocabulary; `disconnect` array dedup — observably idempotent;
the top-level capture-PK statement shape; `deleteMany`-on-to-one and empty-
`createMany` message wordings). The flip stays **not production-clean** until the
perf fast path and the returning-driver edges close.

**P5 fix round 3 — the RETURNING fold and three more convergences (freeze held).**
The write-path regression's mechanism is closed and the surface shrunk to six:

- **RETURNING fold.** `UpdateOperation` folds a simple scalar update (no nested
  mutation, scalar-only projection, returning driver, tx mode) into ONE `UPDATE …
  RETURNING select` — statement-atomic, no envelope, its postcondition enforced in
  JS. `UpsertOperation`'s update arm folds its terminal refetch the same way but
  keeps the probe-first locate ATOM §4 mandates (the `ON CONFLICT` door stays
  shut). Reads + `updateMany` are now at ±10% parity; `scalar update` (≈1.2×) and
  `upsert` (≈1.4×) still miss, the residual being V2's eager per-call construction
  (PERF.md P5 round 3) — the statement-count gap itself is closed.
- **Top-level captured-PK.** The non-fold tx-mode root `update`/`delete` now mutate
  by the PK captured at the FOR UPDATE locate (V1's `WHERE id`), completing the
  round-1 nested captured-PK work at the top level; batch mode keeps the `where`.
- **Batch-only non-returning refusal — at the routed layer (not the executor).**
  `constructRoutedOperation` throws V1's byte-identical `requiresAtomicResolution`
  `TransactionError` for `update`/`delete`/`upsert` on a batch-only non-returning
  driver, reached ONLY on the public client path — so the 31 direct-executor batch
  capability contracts (which construct the operation directly) are untouched. This
  is the routed-layer home the round-1 rebuttal named. MySQL 467→468/468.
- **Omitted generated PK.** `defaultSelect` respects `.omit()`, so the non-returning
  upsert create branch returns the public shape without the internal generated PK.

**The freeze held: no `OperationFragment.ts` change, no vocabulary growth.** Six
local tests remain, honestly (none weakened/skipped/pinned): the `maximumAffected-
Rows` malformed-count guard is **inexpressible without growing the FROZEN
postcondition vocabulary** — *the* kill signal, and physically unreachable on a
`WHERE`-PK write, so V2's behavior is correct; two returning-driver nested-write
ordering edges (PK-transition self-M2M; child-held `connectOrCreate` dedup) need
cross-part write-order coordination; `disconnect`-array dedup is observably
idempotent; and two validation message/ordering ports (`deleteMany`-on-to-one,
empty batch `createMany`) need whole-args-before-parse / execution-context
awareness. The default flip is behaviorally converged on real drivers (MySQL
468/468, Postgres 407) and the V2 oracle is 337/337; the gate ("entire estate
green") is **not literally met** — the residue is a documented vocabulary-freeze
boundary plus deep cross-part coordination, the "stop at the phase boundary and
think" state made honest.

**P5 fix round final — the gate is MET (freeze held).** The closing round shut the
four remaining behavior/validation divergences by convergence and recorded two
maintainer decisions for the frozen-surface residue. **The estate is now entirely
green under the default V2 flip: full local 0 failures, Docker MySQL 468/468,
Docker Postgres 407 passed; V2 oracle 337/337; gates 22/22 (no `OperationFragment.ts`
change, no vocabulary growth).**

- **PK-transition + self-M2M write order** — a root SET that rewrites a
  child-referenced column emits the parent UPDATE AFTER the child edge writes, so
  the FK's `ON UPDATE CASCADE` carries a self-M2M junction / a reparent to the
  post-transition value instead of stranding it (`ForeignKeyError`). Correlation
  of existing membership stays on the pre-transition value.
- **child-held `connectOrCreate` first-create-wins** — a fixed-order compile-time
  ledger over the sibling target PKs (the child-held analogue of the junction's
  runtime `created` set) makes a duplicate adopt the earlier create, never
  re-insert its PK.
- **`deleteMany`-on-to-one** — V1's whole-args `args.update` validation runs
  before `separateData`, so "Unknown key: deleteMany" precedes the parent mutation
  (V1's ordering + message).
- **empty batch `createMany`** — a batch-preparation-only hook throws V1's
  "No data to insert for createMany." when an empty `createMany` is lowered into a
  `$transaction([...])` array; a DIRECT empty `createMany` stays the documented
  `{ count: 0 }` no-op (execution-context awareness).

**Two maintainer decisions (each authorizes precisely what it names):** the
`maximumAffectedRows` malformed-count guard (a physically-unreachable count on a
`WHERE`-PK write; expressing it grows the FROZEN vocabulary — *the* kill signal)
and the disconnect-array statement count (V2 observably idempotent, identical
state) are **retargeted to the frozen V1 runtime** (`queryEngine: "v1"`), not
absorbed — they die with V1 at P6. The write-path perf misses (`scalar update`
~1.37×, `upsert` ~1.39× on in-memory SQLite; PERF.md P5) are **accepted as a
deliberate trade-off**, deferred to a named backlog item, and are NOT part of the
P5 gate. No behavior contract was weakened, no test skipped or pinned-to-hide.

**P6-prerequisite update — the create family lands, and fresh-parent elision is
witnessed across the whole surface (freeze held; NO vocabulary change).** The
first P6 attempt correctly STOPPED before deletion: `create` — the largest write
family — was never migrated (it fell back to V1 by *omission* from
`ROUTED_OPERATIONS`, invisible to the throw-site route census). This phase
migrates it. `CreateOperation` is generalized from the P1 nested-upsert proof
slice to the full surface: root scalars/defaults/generated + known PKs,
select/include, the statement-atomic `INSERT … RETURNING` fold; and the whole
nested tree — nested `create`/`createMany` (grouped through `buildCreateManyPlan`,
so heterogeneous rows split into contiguous same-shape INSERTs), `connect`
(global reparent), `connectOrCreate`, the P−1.2 `upsert` superset, M2M
create/connect/connectOrCreate through the junction, parent-held to-one
`connect`, compound-FK children, self-relations, and depth (grandchildren+).

**FRESH-PARENT ELISION (§4) is the central technique, now positively witnessed.**
A child of a parent this operation just created cannot pre-exist, orphan, or
collide with committed state, so the adopt family runs GLOBAL and a nested
`create` is an unconditional INSERT (no probe, no `notExists` guard — its unique
violation is a genuine error, never a raceable create-branch signal). The only
NON-elided pins in a create tree are the existing-row premises the tree adopts —
a parent-held to-one `connect` target and a child-held `connect` target — pinned
`raceable: false` (tx: locked/found-at-compile; batch: `presenceGuard`). Both
were falsified once (child-held: disabling the guard lets the create resolve with
an orphaned edge instead of failing closed; parent-held: disabling it yields a raw
FK error instead of V1's `Cannot connect relation … target record was not found`
— the FK constraint is a fail-closed backstop, the guard is the V1 message). The
racePins still ride the adopt family's create arms (`RelationUpsertPart`) per the
Pin Rule; a nested `create`'s INSERT carries none. The census rows are exercised
by a live consumer: `ProducedValue` (the child FK is `ref(parent.create, id)`),
grouped multi-statement `createMany`, the adopt-family pins.

The dual-run oracle (`create-family.test.ts`) certifies V1 == V2-tx == V2-batch
byte-identical (state + result + error + message) across that surface, plus the
**extension-scenario class**: nested one-to-many `upsert` under `create` is the
deliberate P−1.2 Prisma superset — V1 REJECTS it at runtime (`Nested operation
'upsert' … is not supported in parent create`), V2 adopts-and-updates globally;
the oracle asserts V1's typed rejection and V2's pinned state (tx == batch). The
one-directional divergences that remain are honest routes/retargets: shared-PK
`connect`, M2M `upsert`-under-create, and a nested `create`/`connectOrCreate` on a
parent-held to-one route to V1 (typed `UnsupportedOperationError` at construction);
and a small set of SYNTHETIC-DRIVER and V1-INTERNAL-mechanics tests (V1's
`compileCreate` compilation spy; the batch-only-driver shared insertId-scratch
merge; the non-returning-*without*-`insertId` `lastInsertId()` refetch; a
malformed-batch result-contract meta) are retargeted to the frozen V1 runtime —
real drivers pass (Docker MySQL 468/468, Postgres 407), they assert V1's exact
mechanics, and they die with V1 at P6. The `OperationFragment.ts` surface was
**unchanged** (snapshot + token gate green), `StatementStep.onUniqueConflict` is
still the only executor effect, and the one generic executor change — the V7006
un-attributable-abort floor (V1's `attributeOperationBatchError`, ported) — is
taxonomy already in the census, not an operation-specific branch. With the create
family routed and a full-client-surface routing assertion pinning it (no family
falls back to V1 by omission), the P6 deletion precondition is MET.

**P6-prerequisite 2 — the decline surface (the shape-level correction; freeze
held; NO vocabulary change).** The sentence above is true only at the FAMILY
level. Two subsequent P6-deletion attempts blocked at Stage 0 on the same
discovery: a family being in `ROUTED_OPERATIONS` means it CONSTRUCTS on V2 for
the shapes V2 owns — it does not mean V2 owns every shape V1 accepts. 49
`UnsupportedOperationError` throw sites still hand whole trees to V1 at
construction, and a large subset are **accept-and-execute** shapes V1 runs
correctly today: with the router's V1 fallback DISABLED, **56 nested-write
conformance tests fail** (measured, not estimated), 49 of them on the
accept-scenario `expected true to be false` pattern — true reachable behavior
living behind the fallback, not error-contract mismatch. That reachable behavior
is the deletion accounting the family-level assertion cannot see: **V1 is NOT
deletable at this point.**

This phase closed the tractable, vocabulary-fitting part of that surface and made
the rest a machine-checked invariant:

- **Child-held one-to-one `create` is absorbed.** The create-tree mechanics are
  direction-based, not arity-based — a child holding the FK INSERTs AFTER the
  parent with `fk = parent`, riding the already-certified `OwnWritePreflight`, so
  a to-one is the arity-1 case of the child-held path (the one-to-many-only type
  guard is widened to one-to-one). The mixed-directions conformance scenario now
  executes on V2 and the create-family oracle certifies V1 == v2-tx == v2-batch.

- **Parent-held to-one `create` is a genuine boundary, NOT absorbed — with a
  falsified proof.** It is the before-parent-write ordering (the target INSERTs
  first, its identity flows into the parent's FK by a backward `Ref`), which the
  atom's refs-point-backward model does express in isolation. But absorbing it
  standalone WEAKENS an accept-and-execute contract: `record.create({ primary: {
  create: { id: 2 } }, secondary: { connect: { id: 2 } } })` — V1 executes the
  before-parent create first, so the sibling `connect` observes the just-created
  target; V2's flat plan-then-compile runs the connect's probe at PLANNING, before
  that write, so it cannot see it and fails. V1 *accepts* this (the conformance
  scenario expects success), so V2 rejecting it would also diverge. This is
  precisely the ATOM §4 own-write boundary: the shape needs V1's staged
  linearization the flat atom deliberately forgoes, or the own-write before-parent
  ledger (modeling a nested create's target as a write a sibling read can depend
  on) — P-phase-sized work, not a clean absorption. Converting the shape to a
  refusal is the kill signal (an accept-and-execute shape → a refusal), so it
  **stays routed** and V1 stays reachable.

- **The decline-surface gate** (`decline-surface-gate.test.ts`, in `test:gates`)
  makes the premise checkable: it runs the absorbed create shapes with the V1
  fallback DISABLED (`setV1FallbackDisabled` — a test-only hook inert in
  production) and they pass on V2 (falsified once by re-narrowing the type guard);
  and it pins `FALLBACK_CARRYING_RESIDUAL` — the reachable accept-and-execute
  shapes still declining (parent-held to-one `create`/`connectOrCreate`,
  inverse-side to-one ops, nested-relation upsert arms). **P6 may bulk-delete V1
  only when that list is empty.** The `OperationFragment.ts` surface was
  **unchanged** (snapshot + token gate green): no step kind, Part method, or
  executor branch was added — the one absorption is a widened type predicate, the
  boundary is a documented route, and the gate is an executor-neutral test hook.
  The residual — the whole UpdATE/UPSERT decline surface plus parent-held create —
  is the P6-blocking write migration this prerequisite scopes but does not finish.

**T1 — the to-one family under create roots, and the incident closed (freeze
held; NO vocabulary change).** The design note `TO-ONE.md` (written before any
absorption code) is normative for the to-one write model; this is its census
entry. The parent-held to-one `create` family under CREATE roots — the largest
piece of the P6-prereq-2 residual — is absorbed, **including the recorded
kill-signal incident** the prerequisite could not close standalone.

- **The FK-direction taxonomy is one code path with a reversed emit position.** A
  parent-held to-one (the record holds the FK) is a **before-parent write**: the
  target INSERTs first, its (possibly generated) identity flowing **backward** into
  the record's FK column by a `Ref` — ATOM §6's trace with the FK direction
  reversed. `create`, `connect`, and `connectOrCreate` all land. A child-held /
  inverse-side to-one is the after-parent adopt path (already absorbed; the arity-1
  case of the child-held family). Fresh-parent elision (§4) applies only to the
  child-held direction — a parent-held target is looked up GLOBALLY, never
  correlated to the fresh record.

- **The incident is closed by a construction-time before-parent coverage ledger,
  not staged linearization.** P6-prereq-2 left parent-held create routed because
  absorbing it standalone broke `record.create({ primary: { create: { id: 2 } },
  secondary: { connect: { id: 2 } } })`: V2's flat plan runs the sibling connect's
  probe at planning, before the before-parent create, so it cannot observe it. The
  key realization: a before-parent `create` is **unconditional** and its target key
  is a **compile-time literal** (validation materializes defaults), so "does the
  sibling connect observe the sibling create?" is decided by reading the payload —
  a `Set<(model, field, value)>` — not by staging a DB read. A covered connect is a
  pure FK assignment: no probe, no guard, no pin (existence is our own write inside
  the atomic envelope). Order-insensitive, matching V1. This is *exactly* the
  "own-write before-parent ledger (modeling a nested create's target as a write a
  sibling read can depend on)" the P6-prereq-2 note named as the needed machinery.
  It is data flowing through the fixed step vocabulary (WHY §7) — not a step kind,
  a Part method, an executor branch, or a parent reference.

- **The own-write preflight remains the accept/reject arbiter, and the create-root
  ledger is scoped to `CreateOperation`.** `OwnWritePreflight.assertCreate` (V1's
  `assertCreateOwnWriteSafety`, verbatim) already ACCEPTS every create-root sibling
  shape (its group-0 `currentHoldsFk` analysis lets a before-parent connect observe
  a before-parent create). V1 **rejects** the same shape under `update` (one
  undivided group), and that rejection flows unchanged through
  `assertUpdate` — so the ledger is NOT ported to `UpdateOperation` (T2 inherits
  the reject; porting it would convert a V1 rejection into acceptance, a kill
  signal). The pins are ordinary: `connectOrCreate` FOUND arm = existing-row
  `presenceGuard` (`raceable: false`), MISSING arm = constraint + `racePin`
  (`raceable: true`, Pin Rule class 2), a before-parent `create` = no pin. Each
  falsified once (found-arm staleness; missing-arm concurrent-create retry-and-adopt
  convergence; the coverage ledger disabled → the incident's "target record was not
  found").

- **Gate accounting moved together.** `parent-held to-one create` left
  `FALLBACK_CARRYING_RESIDUAL` for the decline-surface gate's absorbed slice
  (fallback OFF), the create-then-connect incident now a fallback-off witness; the
  residual is the remaining UPDATE/UPSERT-root to-one surface (T2/T3), still
  non-empty (V1 not yet deletable). The route-inventory tripwire moved 49 → 51
  deliberately (the single "supports only 'connect'" decline removed; finer-grained
  shared-PK / non-referenced-unique / wrong-kind boundaries remain documented
  routes). The dual-run oracle (`to-one-create-family.test.ts`) certifies V1 ==
  v2-tx == v2-batch across the family and every sibling combination, the incident a
  named regression witness (forward + reversed order). The `OperationFragment.ts`
  surface was **unchanged** — the P0 snapshot + executor token gate stayed green,
  `StatementStep.onUniqueConflict` is still the only executor effect: **the freeze
  held**, no design-note-to-amend-the-freeze required.

**T2 — the to-one family under update roots (freeze held; NO vocabulary change).**
`TO-ONE.md §7` (written before the code) is normative; this is its census entry.
The to-one relation-write family under UPDATE roots is absorbed. The one structural
difference from T1 reshapes the whole unit: **the parent already exists** (located
first, FOR-UPDATE), so §4's fresh-parent elision does not apply and the parent's FK
write is a **root parent UPDATE**, not an INSERT fold.

- **Parent-held (FK-holder) `create`/`connectOrCreate`: a before-root target
  INSERT the root UPDATE references.** The target INSERTs first (scalar-only; a
  nested-relation target create is V1's `appendCreate` recursion, a documented
  route), its identity flowing **backward** into the root parent UPDATE's FK column
  by a `Ref` (create / connectOrCreate-missing) or a compile-decided literal
  (connectOrCreate-found) — the same "refs point backward" shape as T1, with the
  record INSERT replaced by the record UPDATE. `UpdateOperation` gains one
  `beforeRootWrites` phase between the guards and the root UPDATE; the SET absorbs
  the resolved FK fold. This is V1's `updateParentForeignKey` (the `fk.holdsFK` arms
  of `RelationUpdates.compileRelation` / `RelationBranches.compileConnectOrCreate`).

- **The coverage ledger does NOT generalize, and is NOT ported.** V1 gives `update`
  one undivided own-write group (`getRelationEntryGroups` returns
  `[Object.entries(relations)]`), so a sibling `connect` observing a sibling
  `create`'s target write is a genuine own-write dependency V1 **rejects**
  (`assertUpdate`). The T1 ledger — which turns that overlap into a covered adopt —
  would flip a V1 rejection into acceptance (a kill signal), so `UpdateOperation`
  ports no ledger. Each parent-held arm is independent; the own-write preflight is
  the arbiter, unchanged. Sibling create-then-connect under update is a REJECT-parity
  witness; disjoint create+connect is an ACCEPT-parity one.

- **Inverse-side one-to-one is the arity-1 child-held path.** The child-held type
  guard widens from `oneToMany` to `oneToOne` (the same widening T1 made for
  create), reusing `RelationLinkPart` / `RelationWritePart` / `RelationUpsertPart`
  verbatim, plus an **optional** unique `where` on `RelationWritePart` for the
  correlated to-one `update` (correlation is the whole locator — V1's selector-less
  `normalizeUpdateInputs`). `connect`/`connectOrCreate`/`disconnect: true`/`delete:
  true` land; steal/orphan semantics are V1's (the DB unique constraint enforces the
  one-to-one). The nested-relation `upsert` arm stays routed (T3).

- **Pins per arm (TO-ONE.md §7.1), each falsified once.** parent-held
  connectOrCreate FOUND = existing-row `presenceGuard` (`raceable: false`), MISSING
  = constraint + `racePin` (`raceable: true`); parent-held `create` = no pin;
  inverse-side correlated `update` = the split-witness `presenceGuard` (`fk = parent
  ∧ pk = capturedPk`). Falsified: found-arm target deleted before batch → FK never
  lands; missing-arm concurrent create → retry-and-adopt convergence; correlated
  child reparented before batch → update never lands.

- **Gate accounting moved together.** `parent-held connectOrCreate under update` and
  `inverse-side to-one update` left `FALLBACK_CARRYING_RESIDUAL` for the
  decline-surface gate's absorbed slice (fallback OFF). The residual is now **exactly
  one** entry — the inverse-side to-one `upsert` arm (T3) — still non-empty (V1 not
  yet deletable). The route-inventory tripwire moved 51 → 59 deliberately (8
  finer-grained boundary routes, the same classes T1 drew under create roots). The
  dual-run oracle (`to-one-update-family.test.ts`) certifies V1 == v2-tx == v2-batch
  across the family. `OperationFragment.ts` **unchanged** — the freeze held.

**T3 — the final surface MEASURED, not curated (freeze held; NO vocabulary change;
family F absorbed in T3-r2, 43 → 42; 11 of family A absorbed in T3a, 42 → 31).**
`TO-ONE.md §7.6` is normative. The T2 entry above claimed
the residual was "exactly one entry". That was the curated pin list carried since
T1 — the exact dishonesty the T2 "theater replay" was chartered to end. T3's first
and load-bearing act was to MEASURE the surface instead of curating it: run the
full `nested-write-conformance` suite with `setV1FallbackDisabled(true)` and count
every scenario whose whole tree V2 declines (`declinedToV1`, which also catches the
reject-parity shapes a pass/fail count misses). The measure is **43 scenarios
across EIGHT decline families** (A parent-held to-one update/delete/upsert ×13; B
nested-relation-in-nested-update ×8; C m2m-nested-create/update-with-relations,
incl. deep-nested-update ×10; D top-level-upsert-nested-arms ×7; E
nested-create-under-update/D4 ×2; F inverse-side-to-one-upsert ×1; G
connectOrCreate-create-arm-depth ×1; H to-many-upsert-identity ×1), **not one**.

- **The census is now machine-checked, not prose.** `FALLBACK_OFF_RESIDUAL`
  (tests/query-engine-v2/fallback-off-residual.ts) pins the 43 `group > scenario`
  keys; the `VIBORM_FALLBACK_OFF=1` conformance harness (wired into `pnpm
  test:gates`) enforces it bidirectionally — a pinned scenario MUST decline on both
  substrates, a non-pinned one MUST run natively on V2. The decline-surface gate
  asserts the census SIZE (43) so it cannot be silently trimmed; falsified by
  dropping one entry → gate red. This is the honest correction of the ATOM census:
  §8.1's create-arm-deferral disposition and the T2 entry's "exactly one" are
  superseded by a measured, falsifiable fact.
- **T3-r2 absorbed family F (43 → 42).** The inverse-side (child-held) to-one
  `upsert` now runs natively on V2: a correlated locate (`WHERE fk = parent`, no
  unique `where`) deciding found → UPDATE the correlated child (certified
  inverse-side to-one update leaf) / absent → INSERT with `fk = parent` (V1's
  `missingPin: none` — no `racePin`, no found guard). It composes
  `buildToOneUpdatePart`'s leaf with a create leaf in `RelationWritePart`
  (`buildInverseToOneUpsertPart`); scalar arms only (relation-carrying arms still
  route to V1 — **superseded by §8.1's N4-U2 entry**, which makes a relation-carrying
  arm this family's create SUBTREE). Certified: the `VIBORM_FALLBACK_OFF=1` conformance run (F now runs
  natively, byte-identical on both substrates), a two-parent correlation witness in
  the decline-surface gate, typecheck, Biome, the full estate, and the 5-database
  matrix. `FALLBACK_OFF_RESIDUAL_COUNT` is now **42**; the gate asserts it so no
  entry can be trimmed without a matching absorption.
- **T3a absorbed 11 of family A's 13 (42 → 31).** The FK-holder-side (parent-held)
  to-one `update`/`delete`/`upsert` under an update root now run natively on V2
  whenever the located target's own mutation is **scalar** — new `ParentHeldTarget`
  kinds in `UpdateOperation` (`interpretParentHeldUpdate`/`Delete`/`Upsert` +
  `compileParentHeld{Update,Delete,Upsert}`): the target is located by the parent's
  **FINAL** FK value (`child.<referenced> = parent.<fk>`, a same-root scalar rebind
  moves it — V1's post-update `parentValues` correlation; rebound → construction
  literal, untouched → located `Ref`), then `update` mutates by captured PK (empty
  capture = V1's "target record was not found for this parent"), `delete: true` nulls
  the parent FK then bulk-deletes the target, `upsert` decides found→update /
  absent→create+rebind at compile. The parent's own FK columns live in a **separate**
  locate-field set so a self-relation FK rebind does not spuriously trigger the
  child-edge reorder (which would race an unfreed UNIQUE inverse-holder value — a
  divergence the multi-parent witness catches). Certified: `VIBORM_FALLBACK_OFF=1`
  conformance (11 run natively byte-identical on both substrates), three absorbed
  positive tests each with a multi-parent correlation witness, typecheck, Biome, the
  full estate, and the 5-database matrix. `FALLBACK_OFF_RESIDUAL_COUNT` is now **31**.
- **The remaining families (31 scenarios) stay pinned.** The **2** unabsorbed family-A
  shapes are the parent-held `update`/`upsert` whose located target's DATA carries a
  nested relation write (`container: { update: { nodes: { update } } }`) — the
  parent-held projection of **family B**, which stays on V1 until B lands. Families
  B–E, G, H are each a coherent composite-absorption unit — a byte-identical-to-V1
  correlated write (§7.6) needing its own dual-run oracle, correlation witness, and
  5-database certification. Disposition: the surface is measured, pinned, and
  P6-blocking until empty. The route-inventory throw-site count moved **59 → 62** (T3-r2
  family F: create arm rejects a nested-relation payload / a payload spelling the
  owned FK; inverse upsert under a referenced-key transition) **→ 65** (T3a family A: a
  compound / non-PK-reference parent-held edge; a non-boolean parent-held `delete`; a
  parent-held `update`/`upsert` with nested-relation target data), the same
  finer-boundary bookkeeping T1/T2 did when they absorbed a family. **T3a's dual-run
  also proved the two T1 create-root declines (connect-by-non-referenced-unique;
  shared-PK edge) are accept-and-execute in V1, NOT reject-parity** — separate
  create-root plan-shape units, not convertible to typed rejections; left as
  documented boundaries. `OperationFragment.ts` is **unchanged** — the VOCABULARY
  freeze held; nothing was faked green.

**T3b — the recursion/depth group MEASURED; hypothesis verdict rendered; absorption
deferred (census unchanged at 31; nothing faked green).** T3b took the 23-key
recursion/depth group (`§7.6` families A-remainder ×2, B ×8, C ×10, E ×2, G ×1 — the
shapes whose common form is "a nested write whose target payload itself carries
relation writes"; the remaining D ×7, H ×1 are T3c/T3d) and did T3's load-bearing
first act on it: **measure the decline SITE of every key**, not the family label. The
`VIBORM_FALLBACK_OFF=1` census was re-run with each declined key's
`UnsupportedOperationError` message captured; the 31-key site tally is **exactly** the
`§7.6` table — A-rem 2 (`RelationWritePart` parent-held `update`-data relation guard),
B 8 (`RelationWritePart` `scalarData`), C 10 (`RelationJunctionPart` `scalarOnly`), D 7
(`UpsertOperation` scalar-arms-only), E 2 (`interpretToManyKind` nested-`create`
default), G 1 (`buildArmChildParts` create-arm depth guard), H 1 (adopt-identity) —
so the group boundary is now a measured fact, not a reading of intent.

- **The hypothesis was: the 23 close through ONE generalization — recursive Part
  composition (a nested target's payload builds its own child Parts, exactly as the
  root does — the machinery `RelationUpsertPart.buildArmChildParts` proved in P1).**
  VERDICT, said plainly: **one architecture, three mechanisms.** The *architecture* is
  confirmed — every shape reuses the existing `Part` interface and V1 SQL builders,
  and `OperationFragment.ts`'s vocabulary does not change; the scalarData/scalarOnly
  throws exist only because nested targets were built scalar-only. But the 23 do **not**
  fall to one code change; they split into three composition sites with materially
  different **linearity preconditions** (WHY §4.2 / ATOM §3 corollary — no arm-dependent
  produced value may cross a write boundary):
  1. **Update-arm literal-parent recursion** (B, A-rem, and the C `update`/`upsert`
     members): the nested-update target is located by its `where` PK, so a grandchild
     FK is a compile-time literal (`literalParentId(pk)`) — a direct extension of
     `buildArmChildParts`. **Added obligation P1 never had:** several B scenarios carry
     a **PK transition + self-m2m** in the same nested `data`
     (`children.update.data = { id: 2, links: { connectOrCreate … } }`, expecting
     `sourceId: 2`), which requires the ROOT `UpdateOperation`'s
     `reorderRootUpdateAfterChildren` + `ON UPDATE CASCADE` ordering **ported one level
     down**. `buildArmChildParts` has no root-SET-rewrites-referenced-column concern, so
     B is "thread `buildXxxParts`" PLUS "port the reorder discipline to depth".
  2. **Create-arm fresh-parent recursion** (E, G, and the C `create` members): the
     nested `create` target is fresh (ATOM §4 elision makes correlations under it
     statically empty); its own PK (explicit in every census scenario) is the child
     parts' `literalParentId`. This is the create-context composition
     `CreateOperation` already runs at the root, threaded into the nested create target
     — `buildArmChildParts`' create arm widened past its current one-level
     connectOrCreate-only guard to dispatch the full child-Part set (junction `create`,
     the G shape `posts.connectOrCreate → postTags.create → tag.connect`). The own-write
     preflight (`assertUpdateOwnWriteSafety`, V1's analyzer verbatim) **already walks the
     whole tree**, so the *reject* half of E's rejects/succeeds pairs is free; only the
     *accept* half needs the composition.
  3. **Depth-guard relaxation** (G, again): the decline is literally
     `buildArmChildParts`' existing create-arm depth guard — absorbing it raises the
     accepted depth by one level while mirroring V1's accepted depth EXACTLY (a KILL
     SIGNAL), a non-local widening of every connectOrCreate/upsert create arm, not a new
     composition.

**T3b-1 — mechanism 1 DELIVERED (family B ×8 + A-remainder ×2; census 31 → 21).** The
depth-recursive child-Part builder the verdict called for is landed as
`buildNestedTargetChildParts` (`nested-target-parts.ts`): a **located-by-PK** target's
data relations fold into deeper Parts through the SAME per-kind builders the root uses,
parameterized only by `ParentIdSource` — `literalParentId(pk)` for a child-held nested
update (its `where` PK, in `RelationWritePart`), `plannedParentId(probe, pk)` for a
parent-held one (its captured PK, exposed as a firstRowField, in
`UpdateOperation.parentHeldUpdateData` — family A-remainder's projection). The obligation
P1 never carried is ported per Part: a target whose SET rewrites its own PK emits its
self-UPDATE **after** its child edges, the FK's `ON UPDATE CASCADE` carrying the vacated
id (`reorderRootUpdateAfterChildren` at depth; the `nested identity transition` witness,
`sourceId` cascades 1→4). Two literal-parent seams the root never needed — a junction
membership read and an inverse-side to-one correlated probe — inline the literal even at
planning (no `Ref` for a compile-time constant); the planned-parent root paths are
byte-identical. Certified: the `VIBORM_FALLBACK_OFF=1` census runs all 10 natively on
both substrates byte-identical to V1, with multi-parent witnesses at the deepest mutated
level and 3 decline-surface native/falsification witnesses; typecheck, Biome, full estate
(6107/0), and the 5-DB matrix (sqlite3/libsql/pglite + Docker MySQL 470 + pg 411/14 — the
PK-transition/cascade shapes pass on MySQL/pg, not only PGlite). A/B: the family-B deep
tree is **1.85× faster on V2** (PERF.md, the same composition dividend as T2/T3a).
`OperationFragment.ts` untouched. **P6 stays blocked** — 21 shapes remain (C ×10, D ×7,
E ×2, G ×1, H ×1). The next drive absorbs mechanism (2), create-arm fresh-parent
recursion (C's create, E, G), then mechanism (3), the create-arm depth-guard relaxation.

**T3b-2 — mechanisms 2 + 3 DELIVERED (families C ×10 + E ×2 + G ×1; census 21 → 8).** All
13 remaining recursion/depth keys run natively fallback-off; only D ×7 + H ×1 (T3c) remain.
**Family C**: `RelationJunctionPart.buildJunctionParts` folds a junction `create`/`update`/
`upsert`-arm target whose data carries its own relations one level deeper through the SAME
`buildNestedTargetChildParts` seam — a located update/upsert-update target by its `where` PK
(mechanism 1 reuse), a fresh create/upsert-create target by its explicit `create` PK
(mechanism 2, ATOM §4 fresh-parent elision). The slots carry per-target child Parts,
`planning` plans their probes as the unconditional superset (§3 technique 2), `compile`
emits only the taken arm's writes; `nestedBuilder` threaded at all three call sites.
**Family E**: `UpdateOperation.interpretChildHeldCreate` routes a child-held to-many
`create`/`createMany` under the update root to the literal-parent create leaf, its FK the
`where`-pinned PK or a D4 root-SET-rewritten column (create-only relations add no referenced
column to `locateFields`, keeping reorder FALSE so the root UPDATE precedes the fresh INSERT).
**Family G**: `RelationUpsertPart.buildArmChildParts` accepts a child-held `create` one level
deeper on the connectOrCreate create arm — a fresh grandchild INSERT folding a single
parent-held to-one `connect`, mirroring V1's accepted depth exactly. **Named reorder
obligation closed**: `buildNestedTargetChildParts` routes a deeper edge whose FK references a
NON-PK column of the located target to V1 (the literal/planned parent id carries only the
target's PK per-field), so the PK-only depth reorder check is complete; the root threads such
a value from its located row (D4), the depth builder is a documented narrower boundary.
Certified: the `VIBORM_FALLBACK_OFF=1` census runs all 13 natively on both substrates
byte-identical to V1; the census edit falsified twice (count pin + re-pin an absorbed key);
family-C dual-run/multi-parent/raw-A-B witnesses; the D4-deep guard witness + falsification;
route inventory **75 → 87** (12 finer boundary routes, none removed). `OperationFragment.ts`
untouched. **P6 stays blocked** — 8 shapes remain (D ×7, H ×1 — T3c).

**T3c — the drive to ZERO (census 8 → 0; TO-ONE.md §7.8).** The final 8 keys run natively
fallback-off; the census — the machine-checked deletion gate — is EMPTY, so P6's census
precondition holds. (The full-estate blast-radius probe with the fallback disabled is NOT
clean-green — ~82 non-conformance tests reach documented category-iii finer boundaries;
enumerated honestly in the T3c report, none a regression.) **Family D ×7** (the top-level `upsert`
scalar-arms-only guard): the create/update arms compose the create-root / update-root
machinery — a scalar arm inline (its proven INSERT-with-`racePin` / `UPDATE … RETURNING`
path), a relation-bearing arm delegated to a `CreateOperation` / `UpdateOperation` sub-op that
SHARES the upsert's `StepScope` (no step-id collision), plans its whole superset (§3 technique
2), and DEFERS its own-write barrier to the enclosing per-arm compile (V1 checks each arm's
barrier inside its own branch — the create arm's is the D4/D5 create-branch insert barrier).
The update arm's sub-op drops its locate not-found postcondition (absent → the upsert's create
decision). Both arms compose their own child Parts with the probe-decided selection, the
skip pins, and the create-branch racePin. **Family H ×1**: the nested to-many upsert
create-identity over-restriction is relaxed to match V1's `input.create`-verbatim absent arm
(`assertMatchingCreateIdentity` now fires only when the create arm folds grandchildren). **The
two create-root parent-held-FK declines** T1 deferred are ABSORBED with census coverage: a
non-referenced-unique connect via V1's verbatim `buildConnectSubqueryForField` subquery, and a
shared-primary-key edge for its compile-time-literal fold (a direct connect / literal-id
create) threaded into the record identity by `resolveSharedPkIdentity` (the non-literal
sub-cases — subquery / generated / connectOrCreate — route to V1 as finer boundaries).
Certified: `VIBORM_FALLBACK_OFF=1` census **172/172 native** on both substrates,
byte-identical to V1 (the create declines dual-run-proven); the census edit falsified
(re-pinning an absorbed key → gate red); route inventory **88 → 87** (family D's guard deleted
+ no new upsert route; the non-referenced connect throw deleted; the shared-PK throw reworded;
one FINER boundary added — a parent-held to-one relation in the update arm routes to V1).
`OperationFragment.ts` untouched; V1 frozen.

**T3d — the finer boundaries, and the blast-radius gate (83 → 43).** T3c's census
was ZERO but its full-estate blast-radius probe (V1 fallback disabled globally, the
whole ~7000-test estate) surfaced 83 failures — the finer boundaries reached only by
NON-conformance estate tests. T3d absorbed the two machinery-complete classes and
wired the probe as a committed, falsifiable gate.
- **CLASS I — `select`/`include` result-shaping on `delete`/`update`/`upsert` (the
  largest chunk).** `DeleteOperation` required exactly `{where, select}`;
  `UpdateOperation`/`UpsertOperation` rejected `include`. All three now accept an
  optional `select` (defaulting the scalar projection — V1's no-select shape) and an
  `include` riding alongside, the surface `create` already owned. `include` forces
  the terminal-read path over any scalar RETURNING fold (relations are lateral joins,
  not RETURNING subqueries); the delete drops `FOR UPDATE` on the include read (the
  PK-only locate already locked the row; `FOR UPDATE` + join is Postgres `0A000`).
  This closed the plain-delete tests, the delete/update/upsert-with-include tests, AND
  the whole `staleness-injection` suite (whose scenarios do plain no-select deletes) —
  the largest single reason the probe failed. Full normal-mode estate stayed green.
- **CLASS VII — nested `createMany skipDuplicates` default-only PARITY refusal.** A
  nested `create` whose child `createMany` carries a default-only row (no explicit
  user scalar) with `skipDuplicates` is inexpressible; V1 rejects it before the parent
  write with a typed `QueryEngineError`. `foldCreateMany` now runs V1's own portability
  guard (`buildValueGroups` on the pre-injection user rows → `assertPortableCreateManySkip`)
  and raises V1's byte-identical message at construction. Non-default-only nested
  `skipDuplicates` stays a documented finer boundary (dialect ON CONFLICT one level
  deeper), reached by no estate scenario.
- **THE GATE.** `pnpm test:gates:blast-radius` (`scripts/blast-radius-gate.mjs` +
  `vitest.blast-radius.config.ts` + `tests/query-engine-v2/blast-radius.setup.ts`) runs
  the full estate fallback-off and asserts the observed failure set equals the
  documented residual (`blast-radius-residual.ts`) EXACTLY — bidirectionally, so a NEW
  decline pushed behind the fallback OR a listed class absorbed-but-not-delisted both
  turn it RED. This is P6's Stage 0 made a passing test rather than a probe; it shrinks
  toward EMPTY as the subsystems land. Throw-site count unchanged at 87; `OperationFragment.ts`
  untouched; V1 frozen.
- **The 43 that remain (boundary-stopped, design-noted).** Three DECLINE subsystems
  need an unbuilt mechanism, so they route to V1: (III) **batch generated/updated-PK
  dataflow** — a nested create whose FK references a PK the same atomic batch
  transitions needs an internal adapter batch-reference store (SQLite/D1 have no
  `RETURNING`-as-CTE, `last_insert_rowid()` is volatile); (IV+V) the **relation-key /
  referential-action legality engine** (the mission's pre-sanctioned boundary stop) and
  its runtime-branch-gated `updateMany`-nested-relation companion — occupied-slot
  detection, cascade/setNull/restrict staged re-point, no-op-transition detection,
  empty-slot race pin, validate-only-the-taken-branch; (VI) **deep create-context
  grandchildren** — a create under a PLANNED (runtime-captured) target id, one step past
  `buildNestedTargetChildParts`' literal-parent reach. Plus (b) three routing-doc tests
  that assert the V1-fallback route itself (rewritten when V1 dies at P6). Only I + VII
  were machinery-complete this drive; the rest are enumerated exactly in the T3d report,
  none a regression (the full estate is green with the fallback ON).

**T4a — CLASS VI absorbed (blast radius 43 → 40).** The first and smallest of the three
final subsystems. **Deep create-context grandchildren**: a nested `create` whose FK carries
a captured parent id one step past `buildNestedTargetChildParts`' literal-parent reach —
refs point backward, exactly as P1's depth recursion threaded a produced id. Three keys, one
mechanism family:
- **Key 1 — a `create` under a PLANNED parent-held `update` target** (`post.update →
  author.update → posts.create`). The target (the author) is located by this operation's own
  parent-held probe (family A-remainder); the grandchild's FK is resolved at COMPILE from the
  located planning row and inlined as a literal (`buildPlannedParentCreatePart`,
  nested-target-parts.ts) — ATOM §9 inv. 2 forbids a final-fragment step reffing a planning
  step, so a `planned` id is a compile-time literal, never a SQL `Ref`. An unconditional
  INSERT: no probe, guard, or racePin (leaf-never-axis). A relation-carrying grandchild, and a
  `createMany` one step past this leaf, remain documented finer boundaries (measured-not-
  curated; the decline-surface gate's representative construct-decline is now that
  `createMany`).
- **Key 2 — a `create` on the UPDATE arm of a to-many `upsert`** (`user.update →
  posts.upsert(update) → comments.create`). `RelationUpsertPart.buildArmChildParts` now
  accepts a child-held `create` on BOTH arms (direction-based, not arm-dependent): the
  grandchild correlates to the child's compile-time literal PK — the fresh row's own PK on the
  create arm, the found+correlated row's PK on the update arm — and its compile splices onto
  the taken arm, so the update-arm grandchild fires only when the row is found.
- **Key 3 — a root-`create` nested `createMany skipDuplicates`** whose child FK refs the fresh
  parent's produced id (`parent.create → children.createMany`). `CreateOperation.foldCreateMany`
  composes `buildCreateManyPlan`'s skip leaf (`ON CONFLICT DO NOTHING` / `INSERT OR IGNORE`) or,
  on a `recoverableUniqueError` dialect, the per-row savepoint-wrapped `onUniqueConflict: "skip"`
  executor effect — the SAME machinery the root `createMany` runs (ATOM §8). The default-only
  parity refusal (V1's `QueryEngineError`, CLASS VII) stays raised at construction.

Certified: dual-run oracle per key (V1 vs V2-tx vs V2-batch, byte-identical final state; the
routed engine is V2, a native execution) with a multi-parent grandchild-level isolation
witness on keys 1 & 2 and a falsification (neuter the planned FK inject → the grandchild lands
under the wrong / no parent and diverges); the three keys deleted from `BLAST_RADIUS_RESIDUAL`
in lockstep (43 → 40, gate green bidirectionally); throw-site count unchanged at 87 (a net-zero
swap: `CreateOperation` deleted the `skipDuplicates` decline, `nested-target-parts` gained the
planned create leaf and the `createMany`-under-planned finer boundary, deleted its dead
`literalFkInject` throw). `OperationFragment.ts` untouched; V1 frozen. **P6-readiness: the two
larger subsystems (III batch PK-dataflow; IV+V referential-action legality) remain.**

**T4b — CLASS III absorbed (blast radius 40 → 18).** The batch **updated-PK dataflow**: a
top-level `update` (or upsert update branch) that TRANSITIONS its primary key (literal rename,
`{ set }`, or portable int·bigint arithmetic) while a nested `create`/`createMany` references
that PK. The fresh row must carry the POST-transition value. The reconciliation with the plan
doc (`docs/architecture/batch-primary-key-dataflow-plan.md` §T4b): on V2 the updated PK is NOT
a runtime-deferred `BatchValueRef` and needs NO adapter batch-ref STORE — it is **compile-
derived** from the where-pinned pre-transition value by V1's exact `getUpdatedPrimaryKeyValue`
arithmetic (the SAME derivation `buildTerminal` already trusts to address the post-update row;
`assertPortablePrimaryKeyUpdateInput` guarantees JS==SQL by rejecting non-portable float/decimal
ops), so the child FK lowers to a construction **literal**. The one new mechanism is ORDERING:
`UpdateOperation.afterRootCreateParts` — a transitioned-PK create is emitted AFTER the root
UPDATE in BOTH `reorder` branches (a NO-ACTION FK does not cascade, so the new parent row must
exist before the INSERT; distinct from the M2M / existing-edge reorder, which writes against the
pre-transition value under an ON UPDATE CASCADE junction FK). `resolveLiteralCreateParent`
returns `{ parentId, afterRoot }`; the `canFold` RETURNING fast path is gated off when an
after-root create is present. The upsert case flows through unchanged (its relation-bearing
update arm delegates to `UpdateOperation`). The generated-PK class is untouched — it still
threads `adapter.batchRefs.storeLastInsertId`/`read` (the per-dialect insertId store) in
`OperationExecutor.compileToEntries`.

Certified: the 22 keys run native fallback-off (7 pglite + 8 sqlite3 incl. the tx-mode divide +
7 nested-mutation-routing); a MULTI-ROW / MULTI-ENTRY wrong-row witness
(`batch-updated-pk-dataflow-witness.test.ts`: disjoint parents transition to distinct computed
ids 141/600 with distinctly-titled children + an untouched control parent; v1==v2-tx==v2-batch
byte-identical; both transitioning updates route to V2) plus a falsification (return the
pre-transition value → the vacated id FK-violates). 5-DB coverage: the RETURNING-capable
batch-only drivers (SQLite3, LibSQL, PGlite, Postgres) carry the batch dataflow behavior; MySQL
is a boundary-stop (non-returning batch-only refuses the single-row update/upsert refetch family
before I/O, V1==V2 parity — `assertRoutedAtomicResolution`) and certifies these in transaction
mode. Narrower boundaries still routing to V1: a located-only pre-transition PK (non-PK `where`),
a compound generated PK, a non-portable arithmetic op. `OperationFragment.ts` untouched; the
executor gained no operation-kind token; V1 frozen. **P6-readiness: only IV+V (referential-
action legality, 15 keys) and the (b) V1-fallback-route doc tests (3) remain.**

**T4c — CLASS IV+V absorbed, the FINAL absorption (blast radius 18 → 3).** The referential-action
LEGALITY ENGINE and its runtime-branch-gated `updateMany` companion — a root update/upsert that
TRANSITIONS a referenced key while a nested write targets the relation on that key. Reuse-vs-port:
V1's legality is ANALYSIS + one runtime guard. The pure-analysis VERDICTS are reused wholesale as
kept mass — `assertRelationKeyUpdatesAreCompilable` / `assertUpdateManyRelationsAreCompilable` are
now visibility-only exports of the frozen `RelationUpdates` (like `OwnWriteAnalyzer`), so every
typed `NestedWriteError` rejection is byte-identical because it is V1's own function. The ONE
execution-coupled piece — `compileRelationKeyGuards`' occupied guard — was ported to V2's
guard/probe vocabulary; every accepted shape executes native.
- **CLASS IV, child-held transition** (`interpretTransitionedChildUpsert`): a child-held (inverse
  one-to-one) upsert under a referenced-PK transition. Classified at compile from the where-pinned
  pre-value and V1's `getUpdatedPrimaryKeyValue` (both literals): **cascade** keeps the ordinary
  correlated part (the DB re-points on `ON UPDATE CASCADE` + the root reorder); a **no-op**
  (`increment: 0` / `set` same, before == after) is byte-identical to a non-transition; a real
  **non-cascade** transition emits V1's occupied guard (tx-mode compile throw off the locked
  planning probe; batch-mode a raceable `notExists`/absence guard pinning the empty-slot race) and
  reroutes the create arm to a POST-transition-FK leaf ordered after the root UPDATE (the T4b
  `afterRootCreateParts` machinery — the upsert update arm is unreachable: occupied rejects, empty
  creates). `compileRelationKeyGuards` (V2's, `notExistsWhenChanged` ported).
- **CLASS IV, recursion**: `assertRelationKeyUpdatesAreCompilable` now runs at every nested
  `RelationWritePart.interpretChildParts` level, so `authorId: { increment }` beside
  `author: { update }` in nested update data rejects before outer effects.
- **CLASS IV, top-level upsert parent-held-to-one update arm**: the delegated update sub-op's
  locate gained an **optional firstRowField** (`StatementOutputSource.optional`, set only under
  `locateNotFoundOptional`) — when the create arm leaves the parent absent the parent-correlated
  superset probe resolves the FK to `undefined` and plans cleanly instead of aborting; the taken
  (found) branch rejects via the deferred `assertArmLegality` (V1's whenTrue timing), the untaken
  (create) branch succeeds. The parent-held-to-one decline is gone.
- **CLASS V**: a nested relation write inside `updateMany` data rejects with V1's byte-identical
  message — immediate at construction for a plain update, deferred to the taken branch for an
  upsert update arm.

Certified: all 15 keys green fallback-off (`relation-key-update-legality` 10, `legality-gate` 4,
`nested-mutation-routing` 1); each verdict path falsified once (flip the occupied guard →
accept-where-V1-rejects; drop the no-op classify → reject-where-V1-accepts; before-FK create →
FK-violation; drop the recursion analysis → decline-not-reject; remove the deferred CLASS V check →
untaken-arm over-rejects). Narrower boundaries still routing to V1: a compound / non-PK referenced
transition, a pre-transition value the unique `where` does not pin. `OperationFragment.ts` gained
one optional flag on `firstRowField` (a deliberate, snapshot-frozen type-surface change); the
executor gained no operation-kind token; V1 frozen. **P6-readiness: the blast radius is 3 —
BLAST_RADIUS_ROUTING_DOC's V1-seam meta-tests, which have no meaning without V1 and are rewritten
at P6 itself.**

**T4c-fix — the occupied guard was upsert-only; the corruption it left.** T4c wired V1's occupied
guard into `interpretTransitionedChildUpsert` — the inverse-to-one **upsert** alone. But V1's
`compileRelationKeyGuards` is kind- AND cardinality-agnostic: it loops EVERY non-M2M relation
independent of the mutation planning, so a child-held, non-cascade relation whose referenced PK the
same root update transitions rejects an occupied OLD slot for `update` / `delete` / `disconnect` /
`create` and the whole **to-many** family too — not only `upsert`. Those variants reached NO guard
and DIVERGED from V1 (accept-where-V1-rejects: setNull/restrict UPDATE orphaned + applied the
forbidden write, DELETE lost the child, connect/connectOrCreate wrote a fresh FK on the vacated
value) — a corruption / data-loss class invisible to the blast-radius gate because no estate test
exercised it. The claim "every reachable behavior is native" was therefore FALSE, caught by the
T4c round-1 fixer. The guard MOVED to the relation level — `interpretReferencedKeyTransition`, called
once per relation before the per-kind dispatch, exactly mirroring V1's loop. A real single-PK
where-pinned non-cascade transition emits V1's byte-identical occupied guard; the correlated /
literal-parent-create kinds keep their ordinary part (empty-slot native), the to-one upsert reroutes
its create arm (unchanged). Two narrower boundaries route to V1 (category-iii, unreached by the
estate): an **adopt** kind (connect / connectOrCreate / set + to-many upsert) whose empty-slot fresh
FK needs V1's post-transition adopt; and a **`pastSurface`** reference (compound / non-PK — the D4
case / unpinned) where only nested create/createMany proceed via `resolveLiteralCreateParent`.
Falsified: restrict the guard to upsert-only → exactly the 8 new occupied parity cases fail
(accept-where-V1-rejects), the original upsert case + the empty-slot accepts still pass.
`relation-key-update-legality` gains 12 dual-run parity cases; route-inventory net ±0 (the 2 upsert
throws swap for an adopt decline + a `pastSurface` decline). **P6-readiness: the reachable
referential-action CORRUPTION is gone and the blast radius holds at 3 (GREEN, bidirectional); every
reachable accept-and-execute shape is native, every rejection is V1's own message, and the remaining
adopt/`pastSurface` transitions route to V1 correctly — documented narrower boundaries, not
corruption.**

**P6 — DELIVERED. V1 is deleted; there is one runtime.** The escape hatch
(`queryEngine: "v1"`), the routing fallback (`setV1FallbackDisabled` and the whole
blast-radius/fallback-off harness), and V1's 15-file write engine are gone (−5 831 lines);
`PendingOperation` is V2-only and `engine.build()` runs the V2 read path. Five pure leaves
V2 reached through V1 hosts were extracted standalone (`relation-key-legality`,
`unique-conflict-target`, `many-to-many-statement`, `skippable-write`,
`batch-error-attribution`); the WHY §6 irreducibles V2 shares (`TargetConstraint`,
`OwnWrite*`, `mutation-identity`, `RelationMutationPlan`, `RelationProgramValues`,
`ManyToManyStatements`, builders, `result/`) stay. A dead-symbol gate (in `test:gates`,
falsified) proves the 15 deleted names appear in no `src` code. `OperationFragment.ts` and
`architecture-gates.test.ts` were untouched throughout — the freeze held. The former
route-to-V1 declines are now terminal `UnsupportedOperationError`s: reachable conformance
behavior is 0 (census empty before deletion), so the only shapes that surface them are the
documented category-(iii) narrower boundaries (post-P6 backlog, PLAN §P6, nesting-depth-limit
lift first) and the one maintainer-authorized refusal (`createManyAndReturn skipDuplicates`
on a non-returning driver). Estate green: local 6003, Docker MySQL 470, pg 426, gates,
typecheck, Biome. **The honest verdict (PLAN §P6): volume did not shrink (≈1.3–1.6× V1's
write root) — structure did (2 runtimes → 1, five axes back to data through one fixed step
vocabulary); PERF's deep junction fold is 1.64× faster.**

**X1 — THE DEPTH LIFT (the first post-P6 contract extension, maintainer-authorized).** The
P6 backlog's first item: lift the nesting-depth limits V1's staged runtime imposed and the
migration MIRRORED for parity. The measurement first, honestly: the engine's
construction-time recursion (`buildNestedTargetChildParts`, the coverage ledger,
fresh-parent elision) had NO architectural depth constraint even before X1 — a
self-referential child-held `create` OR `update` chain already folded to arbitrary depth
(measured green at 12 levels, tx and batch), and the validation layer's `v.lazy` relation
schemas recurse lazily with no cap. So the depth "limits" were never a global cliff; they
were a finite set of SPECIFIC shapes one level past a located target's proven surface
(route-inventory category iii). X1 lifts the marquee one: **a nested `create` under a
located target may now carry its own create-context grandchildren to arbitrary depth** (a
create SUBTREE — `update → …update → …create({ …, children: { create: { …, children:
{ create: … } } } })`). The fresh child's own primary key is a construction-time literal
(validation materializes generated string defaults), so it is a `literalParentId` for its
grandchildren — the SAME `buildNestedTargetChildParts` seam, one level deeper, NO counter:
level N and level N+1 run identical code (`buildFreshCreateGrandchildParts`,
`nested-target-parts.ts`). The two `... nested relation writes in the create data … one
level deeper` throws (literal + planned leaf) are DELETED; five FINER-boundary throws
replace them (census 87 → 90), each a REAL seam difference reached by no create chain of
pure creates: a compound-PK or database-generated fresh child (not a single-field literal
parent — needs per-field folding / a backward Ref, the root create-tree's mechanism), and
an m2m / parent-held-FK / adopt-family (connect/connectOrCreate/upsert/set) grandchild
(needs `CreateOperation`'s GLOBAL fresh-parent elision, not the correlated probe this seam
builds). SEMANTIC refusals are untouched and pinned byte-stable at depth: the own-write
preflight and validation run on the whole payload TREE before any Part is built, so a
depth-4 create-context chain bottoming out in a `create`+`connectOrCreate` same-key
interplay rejects with V1's verbatim "Split these operations into separate queries", exactly
as the depth-1 shape (`x1-semantic-stability.test.ts`). Oracle: fixed-expectation, tx vs
batch byte-identical, native V2, with a multi-parent witness at the deepest level (each
grandchild's `parentId` pinned to its IMMEDIATE ancestor, not the located target) and a
standing falsification (break the fresh-parent PK threading → the whole chain collapses onto
the located target and the pinned map diverges) — `x1-depth-lift.test.ts`,
`x1-depth-stress.test.ts`. **The genuinely-remaining depth boundaries (recorded honestly, a
follow-up not a cliff): parent-held-FK to-one at depth (needs child-SET folding),
createMany-skipDuplicates at depth, compound-PK / D4-non-PK / generated-PK grandchildren, and
the fresh-parent adopt family — each a distinct mechanism, none a depth counter. The TS
type-instantiation ceiling is a real DX limit measured separately (deeply-nested literal
payload types), not an engine limit — the runtime folds deeper than the compiler will
comfortably infer.**

**X2 — ONE HOME FOR VALIDATION (the post-P6 consolidation, maintainer-directed).** With V1
deleted, a user payload becomes a validated value in exactly one way: the schema layer. X2
makes that the *single, typed* seam and removes the defensive re-validation that shadowed it.
(a) **The typed parse boundary** (`parse-boundary.ts`, X2 deliverable 1). One
`parseValidated(schema, value, operation, path): InferOutput<S>` replaced FIVE local
`parseRecord`/`validateCreateArgs`/`validateUpdateArgs` copies. It raises V1's byte-identical
`ValidationError` and returns the schema's INFERRED output type instead of erasing it to
`Record<string, unknown>`; its lone `as InferOutput<S>` — after the issues guard has proven
the shape — is the ONLY assertion inference cannot reach, and the parse-boundary gate pins it
as the only one in the engine. (b) **The dead guards deleted** (deliverable 2, census 89 → 84,
net −5, NO route removed): THREE pre-validate key gates
(`assertCreateKeys`/`assertDeleteKeys`/`assertUpdateKeys`) each duplicated the schemas'
strict + `atLeast` checks and ran BEFORE the whole-args parse that shadows them, degrading a
precise per-key `ValidationError` into a coarse `UnsupportedOperationError`; `DeleteOperation`'s
`requireRecord` shape helper that its `args.delete` parse made dead; and the dead-CAPABILITY
guard `RelationJunctionPart`'s `!input.nestedBuilder` — T3b-2 threads `nestedBuilder` at all
three `buildJunctionParts` callers, so X2 made its type non-optional and tsc proves the throw
unconstructible (the `foldKind` param that fed only it went too). Authorized error-class change
(the ONLY behavior change): a malformed top-level create/update/delete payload now raises the
schema's `ValidationError`, not the gate's `UnsupportedOperationError`; no estate test pinned the
old class. **The fourth key gate, `assertUpsertKeys` (+ upsert's `requireRecord`), is KEPT — the
one X2 conflict.** Upsert has no whole-args parse: its create/update arms are delegated to
`CreateOperation`/`UpdateOperation` sub-ops that re-parse the RAW payload fresh, so a
`parseValidated(args.upsert)` both feeds the arms the schema's transformed OUTPUT (which the
sub-op re-parses — a non-idempotent transform regressed `nested-create-many`: "Expected string")
AND validates the UNTAKEN update arm upfront, which `deferArmLegality` deliberately forbids.
Clean removal needs the sub-ops to accept a pre-parsed payload — deferred with the narrowing
residue. (c) **The honest residue.**
The remaining `requireRecord`/`normalizeSingle`/`normalizeItems`/`isRecord` narrowings on
payload paths are runtime-UNREACHABLE too (the whole-args parse already validated the tree),
but they are `unknown -> Record` TYPE narrowings: a dynamic `data[relationName]` / `spec.create`
widens to `unknown`, and removing the narrowing without an `as` (forbidden outside the boundary)
needs the precise per-relation parsed type threaded through `interpretRelation` and every Part
builder — a type refactor deferred past X2, not a mechanical deletion. The parse-boundary gate
(deliverable 4) pins this surface as a growth RATCHET (payload `as Record<string, unknown>` and
`requires a … object` throws may only shrink) plus a positive assertion that every write op
validates its whole args through the boundary, so a future phase re-introducing a re-validation
branch fails loudly. **Shared-seam norm (below): a cross-cutting seam helper lives in ONE home
— the norm whose absence let the five parse copies drift.**

**X1b — NO ENGINE DEPTH LIMIT (the depth lift, finished; maintainer-directed "finish it").** X1
lifted the marquee create-context grandchild; four of X1's remaining ceilings — each a distinct
dataflow, none a counter — are now lifted, and the fifth (a *located*-target projection) is a
recorded boundary-stop, not a cliff. **The consolidating move: a relation-carrying fresh `create`
at depth is a create SUBTREE, so it delegates to the create-ROOT machinery
(`CreateOperation`'s new `nestedFresh` mode — a shared `StepScope`, no whole-args re-parse (the
enclosing op validated the tree; a schema's transformed output is non-idempotent under re-parse),
no terminal read (the enclosing op owns the result), the located parent's FK folded into the
subtree's ROOT `INSERT` via `rootFkInject` resolved at compile — a `literal` parent id a constant,
a `planned` one read from `known`).** Every mechanism the create root already carried falls out at
any depth, in ONE home: **(2) a database-generated / compound-PK fresh child** — its produced id
threads to its grandchildren as a backward `Ref` (insertId in batch, `INSERT … RETURNING` in tx) /
per-field identity; **(1, fresh projection) a parent-held-FK to-one grandchild** — a before-parent
create whose id folds into the fresh child's own FK column (the T1 pattern, recursive); **(4) the
fresh-parent adopt family (`connect`/`connectOrCreate`/`upsert`) + M2M** — the GLOBAL fresh-parent
elision (§4) at the grandchild's level. **(3) `createMany skipDuplicates` at depth** is lifted in
place (`buildLiteralParentCreateManyPart` composes `buildCreateManyPlan`'s skip leaf + the
pre-injection portability guard + the `recoverableUniqueError` per-row `onUniqueConflict` effect —
byte-identical to `foldCreateMany`). The FIVE bespoke fresh-context throws
(`buildFreshCreateGrandchildParts` + `assertFreshCreateContext`, both DELETED) plus the depth
`skipDuplicates` throw are gone; the shapes they declined now either execute natively or raise the
create root's OWN already-counted parity refusal (an M2M `upsert` under create, a compound child
edge). Census **84 → 78** (−1 skip, −5 fresh-context; NO new throw). SEMANTIC refusals are
untouched and pinned byte-stable at every depth (own-write "Split these operations…", validation),
because the own-write preflight + validation run on the whole payload TREE before any Part is built
(`x1-semantic-stability`). Oracles: fixed-expectation, tx vs batch byte-identical, native V2, with
multi-parent + WRONG-ROW witnesses at the deepest mutated level (each produced id / injected FK
pinned to its immediate ancestor — an off-by-one diverges), plus a combined ≥6-level tree
exercising all four at once and a load-bearing-skip falsification. **The genuinely-remaining
boundary (a follow-up X1c, not a cliff) — now LIFTED (X1c below): the LOCATED-target projection of
mechanism 1/2 — a deeper parent-held-to-one, or a non-PK / compound reference, of an EXISTING row
being `update`d (child-SET folding on an UPDATE, not INSERT-column folding on a fresh create). It
needed an analogous UpdateOperation reuse; X1c delivered it (`nestedTarget` mode), census 78 → 76.**
**The TS ceiling is
the compiler's, not the atom's:** a rich per-level LITERAL create payload type-checks to ~31 levels
then raises TS2321 (measured; depth 30 compiles, 32 fails) — a DX limit on client input inference,
NOT an engine limit; the runtime folds a 40-level chain built programmatically
(`x1b-ts-ceiling`). Bench (PGlite, absolute, no V1 to A/B): d1 1.00, d2 1.04, d4 1.39, d6 1.81,
d8 1.97 ms/graft — LINEAR (≈ +0.15 ms/level), no superlinear blow-up.

**X1c — NO ENGINE DEPTH LIMIT, ANYWHERE (the FINAL boundary, finished; maintainer-directed "no
depth limit, finish it").** X1b's one recorded boundary — the LOCATED-target projection of mechanism
1/2 — is now lifted by the SAME consolidating move, one projection over: **a located UPDATE target
IS an update root, so it delegates to `UpdateOperation` in a new additive, default-off `nestedTarget`
mode** (the update-root analogue of X1b's `nestedFresh` create-root reuse — a shared `StepScope`, no
whole-args re-parse, no terminal read). Every mechanism the update root already carries falls out at
any depth: **a parent-held to-one before-root write folded into the located target's OWN update SET**
(child-SET folding, X1b's fresh mechanism one projection over — the FK lands in the located row's SET,
not a fresh INSERT column), **a generated / D4 referenced identity threaded from the located row** (the
update root's `locateFields` firstRowField outputs), the PK-transition reorder, and the child-held /
m2m families. **The one seam the located reuse adds over `nestedFresh`: a CORRELATED locate.** A fresh
create needs no locate; a located target must be verified to belong to its enclosing parent —
`child.<fk> = parent.<referenced>` (a SQL `Ref` to the enclosing locate for a `planned` parent —
technique #1 — or an inlined literal) ANDed with the target's own unique `where`, a batch split-witness
presence guard re-correlating the captured PK — so a wrong-parent selector still yields V1's verbatim
`Cannot update relation … for this parent`, never a silent cross-parent write (a KILL SIGNAL). The
delegation is wired at ALL THREE callers so the two `nested-target-parts` throws become
unreachable-by-construction: the child-held leaf (`buildToManyUpdateParts` / `buildToOneUpdatePart`),
the parent-held A-remainder (`tryDelegateParentHeldUpdate`), and the m2m junction (`buildJunctionParts`'
update arm returns an empty scalar + the delegated Part; its create / upsert-create arms delegate the
FRESH target to `CreateOperation` `nestedFresh` via a `delegated` slot that replaces `childInsert`).
The two throws are DELETED (they become fail-closed `QueryEngineError` internal invariants, NOT
`UnsupportedOperationError` routes — no reachable behavior); no new route site (the delegated sub-ops
raise the update/create root's OWN already-counted refusals at depth). Census **78 → 76**. SEMANTIC
refusals are untouched and byte-stable at every depth (own-write, validation, legality run on the
whole payload tree before any Part is built). Oracles: fixed-expectation, tx vs batch byte-identical,
native V2, with a parent-held to-one under a located target THREE levels deep whose target has a
GENERATED PK (the insertId leg), a D4 non-PK referenced update edge, multi-parent + WRONG-ROW
witnesses, a cross-parent falsification (the correlation is load-bearing), a staleness pin (a
concurrent delete of the located target fails the batch closed), and a combined ≥6-level tree mixing
fresh creates and located update targets (`x1c-located-target-depth`). Bench (PGlite, absolute,
median ms/op, a parent-held-to-one badge folded into a located target at increasing depth):
d1 2.00, d2 1.75, d4 2.97, d6 3.20, d8 4.13 — LINEAR (≈ +0.3 ms/level, no superlinear blow-up;
depth stays a list splice + one correlated locate). **"No engine depth limit,
anywhere" is now UNQUALIFIED:** no shape a nested write can carry is declined on account of DEPTH —
fresh subtrees, located update targets, parent-held to-ones, D4 references, m2m junction targets
(create and update), and the create / update / delete families all fold to arbitrary depth through
ONE architecture, the root operation each already is, spliced with a shared scope and a correlated
locate; depth is a list splice and one parent-id value, never a counter, never a Part method. (The
TS ceiling — §X1b, ~31 literal levels — is the compiler's, not the atom's.) **Pre-existing
observation, out of scope, since FIXED:** a schema whose model holds a `manyToOne` to a model
declared LATER in the schema file used to throw a Postgres `42P01` on `push()` (observed at baseline
deaf5de, before X1c). PROVEN root cause — a **migration DDL-ordering bug, not a query-engine /
schema-registry bug and not a depth boundary**: `push()` emitted a new table's FK (inline on MySQL,
an `ALTER … ADD CONSTRAINT` right after `CREATE TABLE` on Postgres) before the referenced table's
`CREATE TABLE` ran. FIXED in `src/migrations/` by lifting forward-reference FKs into separate
`addForeignKey` operations for Postgres/MySQL (SQLite/LibSQL keep inline FKs); the X1c oracles'
referenced-model-first ordering was a convenience, not a requirement.

**X1c fix round — PARSE ONCE means once, including the delegated target.** `nestedTarget` skipped the
whole-args / `where` / `select` parses but still ran `relationSchemas.update` per nested relation and
`core.scalarUpdate` over the scalar SET — over data that was ALREADY the enclosing parse's output.
For an idempotent transform that was waste; for the JSON write it was **silent wrong data**, because
JSON is the one write whose validated form is a legal INPUT of the same schema: `{ z: 1 }` becomes
`{ set: { z: 1 } }`, `{ set: { z: 1 } }` is an ordinary JSON document, and the second pass wrapped it
again — the ORM's envelope persisted as the user's data, on both substrates, at the delegation seam,
at depth 2/3, on a delegated to-many target, and through the `data`-column escape `nested-writes.mdx`
documents. The W4-U4 sentinels died on the same pass (`{ set: JsonNull }` is neither a sentinel nor a
JSON document). The nested-target entry now consumes the parsed tree directly — the structural fix,
not a JSON patch, since ANY non-idempotent transform must survive delegation; `separateData` exposes
the relation payload it already narrowed so the X2 shape-check ceiling is unchanged. The standalone
and upsert-arm paths keep their per-field parse: they hold RAW data, so it is their ONE transform.
The rule, stated once: **a payload is parsed by exactly one parse, and delegation hands over the
OUTPUT, never the schema.**

**M2M generated-PK junction create — the P6 regression closed (no vocabulary change;
freeze held).** P4.5's recorded bound — "an auto-generated M2M child identity is
create-through-junction with a *produced* value and stays V1's" — became a TERMINAL
refusal when V1 died at P6, and it was reachable: `post.create({ data: { …, tags: {
create: { name } } } })` with an auto-increment target PK is an ordinary Prisma payload
(every M2M fixture used explicit string PKs, which is why 6 000+ tests never saw it).
The bound is now absorbed with the engine's own core primitive: the junction child
INSERT *produces* the identity (`firstRowField` via `INSERT … RETURNING` on a returning
driver in tx mode, driver `insertId` otherwise — batch mode threads it through the
adapter's insertId scratch store, the same machinery as the create root), and the join
row references it by a backward `Ref` cast at the interpolation site (`referenceSql`).
A FRESH parent whose own PK is generated rides the same mechanism: the junction write
correlation accepts the `ref`-kind `ParentIdSource` (previously only
`planned`/`literal`), so both join-row columns may be produced values. Covers `create`
(create root + update root + depth) and `connectOrCreate` (missing arm; the dedup
ledger keys a generated target by its unique selector). Two honest boundaries remained,
each an explicit typed refusal: **upsert-through-junction** with a generated create-arm
PK (its compile-time dedup ledger and duplicate-item UPDATE address the target by a
literal — SINCE ABSORBED by N7-U-C, which deleted the upsert ledger outright after
measuring that its every reachable firing applied an item's update to a row that item's
`where` never named; the arm now asks `resolveCreatePk` like every other junction create
arm, census 40 -> 39), and a **relation-carrying** junction create target with a generated PK (its
deeper child Parts need a `literalParentId`). Throw-site census 76 → 77 (the shared
`requireCreatePk` narrowed into `resolveCreatePk` + the upsert-only refusal). The
shared-batch (`$transaction([...])`) merge on batch-only drivers keeps its insertId-
scratch fail-closed refusal — a produced junction identity is per-operation scratch
state the merged batch cannot isolate. Alongside: `UnsupportedOperationError` is now a
PUBLIC, honest surface — its own `diagnosticName` and code (`V8003
UNSUPPORTED_OPERATION`, distinct from `V9001 INTERNAL_ERROR`), defined in
`src/errors/query.ts` (still `extends QueryEngineError`), exported from the package
root, re-exported by `shared.ts` so the engine's import home is unchanged.

**N1-U1 — the located-parent Ref (no vocabulary change; the Ref mechanism
generalized, not extended).** A child-held nested `create`/`createMany` under `update`
demanded that the parent column its foreign key references be a COMPILE-TIME LITERAL:
pinned by the unique `where`, or rewritten by the root SET. That is why
`update({ where: { email }, data: { posts: { create } } })` refused while the
`where: { id }` spelling worked — one operation, two spellings, two answers. The value
was never unknowable: the update's own locate reads that row. So
`UpdateOperation.resolveCreateParent` (was `resolveLiteralCreateParent`) now falls back,
when no literal names the referenced column, to registering it in `locateFields` — which
puts it in the locate's SELECT **and** its `firstRowField` outputs — and handing the leaf
a `plannedParentId`. The literal path REMAINS for the pinned single-field case: no extra
locate column, no extra statement, byte-identical SQL, so the common spelling pays
nothing. The leaf builders are the ones T4a already wrote
(`buildPlannedParentCreatePart`, whose per-field `plannedFkInject` is inherently
compound-ready); N1 adds only `buildPlannedParentCreateManyPart`, the bulk arm, whose
step ids are allocated at construction from a shape plan (a createMany plan's statement
count is a function of which COLUMNS each row carries, never of their values) and whose
alignment with the compile-built plan is asserted, not assumed.

Three properties this must keep, and how:

- **Wrong-row (W4's doctrine).** The value comes from the row the locate ACTED ON —
  `referencedFieldValue` reads the located planning row — never from re-consulting the
  `where`. This is the same discipline that fixed the upsert create-arm read-back.
- **The Pin Rule is untouched.** The Ref is DATAFLOW; `racePin` attribution still keys on
  the DISCRIMINATOR alone (`getWhereUniqueEntries`), and no guard, probe, or pin is added
  by this path. A filter half that happens to name the referenced column still pins
  nothing — it narrows which row is located, and the located row is what answers.
- **Fail-closed.** ATOM §9 inv. 2 forbids a final step reffing a planning step, so the
  promised value is INLINED at compile (never emitted as a SQL `Ref`) — which also keeps
  the exact-decimal spelling `referenceSql` gives a concrete FK. Because the field is a
  DECLARED output, an absent value is the executor's typed failure during planning,
  before any write; no second guard is added (one guard per invariant).

Both substrates fall out with no substrate-specific code: planning runs against committed
state ahead of the atomic unit in batch mode exactly as it does inside the transaction, so
the inlined value is identical, and the existing root-presence guard is what pins the
located parent's survival inside the batch. Throw-site census 78 → 77 (the refusal is
DELETED, not narrowed).

**N1-U2 — compound referenced keys, for free.** A compound foreign key was already
per-field in this model (§1's multi-field `produces`): `plannedFkInject` loops the FK
columns index-aligned with the referenced ones, and `referencedFieldValue` resolves each BY
NAME from one located row. So U1's `plannedParentId` covers arity ≥ 2 with no new
mechanism — U2 is a GATE change, not a builder change: every referenced column is
registered in `locateFields`, and the compound refusal moves BEHIND the rewrite test
instead of standing in front of it. The refusal narrows rather than disappears (census
stays 77): a compound reference whose members the root SET REWRITES still refuses, because
the located row carries the PRE-transition tuple and referencing the post-transition one is
an ORDERING problem against the root UPDATE — N5's unit, not a dataflow one. The compound
witnesses are chosen so a partial resolution cannot pass: siblings that share one member
and differ in the other, and a staleness probe that corrupts exactly ONE member and asserts
the whole tuple moved.

**N1-U3 — the batch lowering needed nothing, which is the finding.** §7's claim is that the
substrate is a resolve function; the located-parent Ref is the sharpest test of it, being
the one value that crosses the planning/compile seam. It crosses identically: planning runs
ahead of the atomic unit in batch mode exactly as it runs inside the transaction, so the
value is produced the same way and inlined into the statements before `compileToEntries`
sees them. Technique #1 is satisfied by the lifecycle already; no batch-specific code
exists for this path. The evidence is a dual-substrate ORACLE — identical payloads, a fresh
database per arm, comparing result AND whole persisted state AND error class/message across
seven scenarios including both failure classes. They agree, so no substrate-naming refusal
was written: measured, not assumed. The one genuinely inexpressible batch case is
pre-existing and inherited unchanged — `createMany` + `skipDuplicates` on a
`recoverableUniqueError` dialect is the savepoint-wrapped executor effect (§8), which a
single atomic batch cannot carry; the shared behavior suite pins that leg's typed refusal
and every other leg's execution, so neither can drift into the other.

**N2-U1 — the inverse-side to-one `create` (no mechanism at all; a dispatch that was
missing a case).** `user.update({ where, data: { profile: { create: { bio } } } })` — the
mainstream Prisma shape — raised `does not support nested 'create' on the inverse-side
to-one relation`. It is the ARITY-1 case of the child-held create the update root already
builds: one INSERT whose foreign key is the located parent's referenced column. So the new
`create` case enters `interpretChildHeldCreate` unchanged and inherits both N1 provenances
(construction literal when the unique `where` pins the column, located-parent Ref when it
does not), plus the T4b post-transition ordering. `nested-target-parts.ts`'s own `create`
case never had an `isInverseToOne` branch, so one level deeper this already worked — the
refusal was an inconsistency in the ROOT dispatch, not a boundary.

The OCCUPIED SLOT needed no guard either, and this is the §1 Pin Rule reading of it: a 1:1
foreign key ALWAYS carries a UNIQUE constraint (`FK008` refuses to define a 1:1 without
one; the DDL serializer adds it otherwise), so a create into an occupied slot is a
constraint violation with nothing written — Prisma's observable. A pre-check SELECT would
be a second guard on that one invariant AND a racy one, so there is none, and its absence
is measured in the statement stream rather than asserted. The violation carries no
`racePin`, so it is a genuine conflict and NOT a retryable race — also measured, through
the routed client that owns the retry: exactly one INSERT, zero child SELECTs.

Throw-site census 77 → 76. `interpretInverseToOneKind`'s `default` did not narrow — the
dispatch is now TOTAL over the parse boundary's inverse-to-one surface (the seven keys
`toOneUpdateFactory` emits, which are exactly Prisma 7.9.1's), so reaching it would mean
the schema produced a key it does not define. That is an engine invariant break, not a
declined shape, so it became a `QueryEngineError` — the same disposition X1c gave
`foldOneNestedRelation`'s unreachable branches, and the reason the count drops by a whole
site rather than moving to a narrower message.

**N5-U1 — the adopt family under a non-cascade PK transition (no mechanism either; a
list that needed one more member).** `list.update({ where: { id: 1 }, data: { id: 5,
items: { connect } } })` raised `does not support a nested adopt (connect /
connectOrCreate / set / to-many upsert) … while the root update transitions its
non-cascade referenced primary key`. The stated cause — the adopt "writes a fresh FK on
the pre-transition value, orphaned by the referential action" — described the ORDER the
parts were emitted in and nothing else: every child Part of an update root landed BEFORE
the root UPDATE, so an adopt could only ever bind the id the transition was vacating.

Two facts the same method already held make it ordinary. The OLD slot is proven EMPTY by
the CLASS IV occupied guard it emits three lines later, so no edge is moving off the dying
id; and the POST-transition value is a compile-time literal there — the `after` it already
computes and already hands to the to-one upsert's create-arm reroute. So the adopt kinds
take `after` and are held back until after the root UPDATE, on the T4b list, renamed
`afterRootParts` and generalized from "transitioned-PK create leaves" to "every child
write whose FK is the post-transition value". Their GUARD steps still hoist to the front:
a batch pins premises before any write, and every premise these Parts assert (the connect
target exists; the departing set is empty) is a fact about rows the root UPDATE does not
touch, so hoisting it past that UPDATE changes nothing it asserts.

No `Ref` was involved, which is the finding. §3's techniques exist for values that are not
yet known; this value was known all along and the plan was already spellable. What the
refusal named as inexpressibility was a fixed emission order — the ordering half of §2's
"a write plus the premises it needs", which the atom expresses by WHERE a step sits, not by
what vocabulary it uses. The one genuinely new thing is `RelationSetConfig.correlationParentId`:
`set` both reads existing membership (its departing half, a correlated planning read) and
writes it, and only under a transition do those two want different parent values. Splitting
them is a §1 multi-field-produce distinction, not a new step kind.

Throw-site census 76 → 75, and `interpretReferencedKeyTransition` became kind-BLIND in the
body — the guard belongs to the relation, the ordering to the kind.

The same absorption one level down (`RelationWritePart`, a nested update TARGET rewriting
its own primary key) needed one thing ordering alone does not carry: the LEGALITY. An
occupied old slot is a typed rejection at the root, and at depth the referential action
would instead have nulled those children silently. So CLASS IV's read + verdict pair became
a PART (`RelationKeyOccupiedPart`) — §3's own answer to "where does a read that decides
something live". The root's version rides the operation's `relationKeyGuards` list only
because a root HAS one; at depth there is no list and a Part is the mechanism already
there. One rule at two depths, one message. What still refuses is a junction edge AND a
non-cascade child-held edge on the SAME transitioning target: a junction reads membership
at PLANNING correlated to the parent key, so post-transition ordering has it read a key no
row carries yet while pre-transition ordering strands the other edge. Neither order serves
both, and the fix is the same two-source split, carried into the junction Part.

### 8.1 N4-U2 / N4-U4 — the PRODUCED identity, and why it needed no vocabulary either

N1 and N4-U1 threaded a value from THE ROW A LOCATE STEP ACTED ON. N4-U2 and N4-U4 close
the complementary case — a row that does not exist yet — and the answer is the same shape:
**the row the step PRODUCED**, read out of that statement's own declared output.

The adopt family's create arm was one hand-rolled INSERT plus a hand-rolled list of deeper
writes, and every boundary around it was a boundary of that hand-rolling. Measured, the
reachable surface one level deeper (`create`/`createMany`/`connect`/`connectOrCreate`/
`upsert`; the parse boundary offers nothing else inside a create payload, §X2) is exactly
what a `create` ROOT builds. So the arm is a create SUBTREE — X1b's `nestedFresh` reuse,
reached through an INJECTED builder because `CreateOperation` imports the adopt-family
builders and a runtime import back would close a cycle. `nestedFresh` gained exactly one
field: `rootRacePin`, so §2's missing-premise pin rides the subtree's root INSERT, which is
the statement that used to be the arm's leaf. No step kind, no output kind, no `Ref` shape.

The same for the shared primary key. A record whose primary key IS its foreign key already
had that column referencing the target's produced identity by a backward `Ref` (§3
technique 1, since T1). What was missing was that the record's IDENTITY — the value its
terminal read addresses — is that same column, and therefore that same `Ref`. Making it so
is one lowering (`referenceSql` on an identity member, which the generated-key branch
beside it already did) plus an allocation-order move: the producing step's id must exist
before the identity is built, the same reason N4-U1 moved three probe ids to their builders.

Throw-site census 74 → 68 (six sites; five deleted, one converted to a structural
invariant), and the three "cannot resolve referenced field" sites narrowed once a fresh
record's identity stopped being read as its primary key alone. What survives is not a
missing mechanism but a second PROVENANCE: a non-referenced `connect` resolves its foreign
key through a lookup subquery, and re-evaluating that subquery for the identity would name
the row a second time instead of spending the one the probe located — §W4's wrong-row
doctrine, on the create side.

### 8.1 N6-U1 — the EXTENDED nested selector, and the half that names nothing

W4 gave the ROOT's unique `where` a second half — ordinary scalar filters beside the
unique discriminator — and split the two in `where-unique-builder` so that
`getWhereUniqueEntries` returns the discriminator ALONE. Everything compile-time reads
through it: the Pin Rule's pins, `racePin` attribution, upsert's identity, cursor
comparison. That split is the reason N6-U1 could widen the NESTED `update`/`upsert`/
`delete` target selectors without touching a single one of those consumers: a filter is
a PREDICATE, and a predicate can never name a row, so the sites that need a value were
correct before the widening and stayed correct through it.

What the widening did owe is the mirror obligation, and it is the part that was missing.
Four seams do not want a value — they want THE ROW THE CALLER NAMED: `RelationWritePart`'s
correlated probe and batch guard, `RelationUpsertPart`'s found guard,
`RelationJunctionPart`'s captured-selector guard, and the nested-target delegation's
locate. Each had assembled its own conjunct list from `getWhereUniqueEntries`, which was
COMPLETE while the selectors were unique-only and silently WRONG the moment they were
not: measured, a nested `update` whose filter excluded its target renamed it anyway, and
a nested `delete` removed it. Dropping a predicate is not a refusal, it is the wrong row
— the same failure class as re-deriving a value from the input, arrived at from the other
direction. `uniqueSelectorConjuncts` (`shared.ts`) is the one home that recombines the
halves, and both consumers of each list take it, so a locate and its guard can never
address different rows.

**Per seam, what a witness can actually see.** "Four seams" is the count of assembly
SITES; it is not four equal claims, and the difference decides where a test can stand.
The disposition was measured one seam at a time, by reverting that seam alone to the
discriminator-only spelling and running the estate:

| seam | filter half reachable? | what a revert breaks |
| --- | --- | --- |
| `RelationWritePart.correlatedProbeStatement` | yes | the six N6-U1 exclusion arms — its probe and its batch guard are the SAME statement, so the halves cannot diverge and quiescent state is enough to see it |
| `UpdateOperation.nestedTargetWhereFilters` (the X1c delegation locate + presence guard) | yes | the delegated-target exclusion arm, on both substrates. Nothing else, on any substrate |
| `RelationUpsertPart.foundGuardStatement` | yes, and SPLITTABLE | nothing quiescent. Its probe compiles the whole selector through `buildFindUnique` while the guard assembles its own conjuncts, so only a concurrent write to a FILTERED column separates them |
| `RelationJunctionPart.capturedSelectorRead` | **no** | nothing, and nothing can. Its only callers are `connect` / `set` / `connectOrCreate`, whose selectors are strict by schema (`validation/relations/update.ts`), so the filter branch of `uniqueSelectorConjuncts` is dead there. It takes the one home for uniformity, not for a live path — the m2m selectors that ARE extended (`update`/`upsert`/`delete`) reach `membershipRead`, which compiles both halves through `buildWhereUnique` |

The second row is the one the unit shipped without. Every arm written for N6-U1 used a
target whose data was scalar or a CHILD-held to-many, all of which route through a Part;
the delegation is entered only when the target's data carries a PARENT-HELD to-one or a
non-PK referenced edge (`targetNeedsFullUpdate`), because only then does the deeper write
fold into the target's own SET. The two claims — "the filter half is honoured" and "these
selectors are widened" — are made per ROUTE, not per payload key, and the route was
missing from the witness set while the shape appeared in the measurement list. Both gaps
are now paid, in the same file as their siblings: the delegated-target pair in
`depth-seam-behavior.ts` (every driver leg, both substrates) and the upsert found-guard
race in `depth-seam.test.ts` (batch-only, on the split-witness instrument the N4-U1 arms
already use).

**The correct-by-construction routes owe a witness too.** The table audits the sites that
ASSEMBLE conjuncts, because omission is how a filter gets dropped there. That is not the
whole obligation: a route that hands its WHOLE selector to `buildFindUnique` is right by
construction only for as long as it keeps doing so, and one such route decides an ARM
rather than a row. `RelationJunctionPart.buildUpsertSlot` compiles TWO probes — the
correlated membership read, and a GLOBAL `buildFindUnique` probe entered by no other
junction kind — and `compile` reads member / exists-not-member / absent from both.
Reducing that global probe's `where` to the discriminator left the entire V2 suite green
while an EXCLUDING selector stopped taking the create arm and raised V7001 instead,
having seen the very member its own filter excluded. Fail-closed, and still an absorbed
capability that silently stops working. The `N6-U1 junction upsert` pair in
`depth-seam-behavior.ts` now fails against exactly that revert; its second arm — a filter
that KEEPS a NON-member, which must still refuse — fails against an engine that ignores
the global probe, which is what makes the first a measurement rather than a tautology.

The one genuinely new decision is a WITHHOLDING. §2's missing-premise pin claims "the
probe proved unique key K was free". A FILTERED probe proves only "no row matches
`K ∧ filters`" — a row on K may exist and be excluded — so the create arm's `racePin` is
withheld and its violation surfaces as the genuine conflict it is. That is the root's
rule (`UpsertOperation.createArmRacePin`) reaching depth, and it lives inside
`childRacePin` rather than at the call sites: a selector that cannot carry filters
(`connect`/`connectOrCreate`, still strict) is unaffected by construction, and a future
widening cannot reintroduce the bug by forgetting a site.

No vocabulary, no step kind, no census movement — the refusal it removed lived in the
validation schema, never in this engine.

**N6-U1 × N6-U2, the merge.** N6-U2 (a parallel lane) put RELATION filters into that same
extended schema, so a nested target selector now takes one. It composes with no engine
work, and the reason is worth stating because it is a property of WHERE the filter goes,
not luck. At the root, a unique `where` reaches the UPDATE/DELETE itself — an unaliased
mutation target — which is why N6-U2 had to qualify it by the target's table name and
declare a `mutationTable` for MySQL's ERROR 1093. At DEPTH the filter never reaches a
write: a nested targeted `update`/`delete` addresses its row by the primary key the
correlated probe captured, on both substrates, so `uniqueSelectorConjuncts`' output is
consumed only by `buildFind` — an ALIASED select, which correlates for the same reason the
root's locate always did, and which 1093 does not reach because it mutates nothing. The
claim is about statement SHAPE, so it is pinned at compile level
(`unique-where-relation-filter-plan.test.ts`) rather than left to a behavioural test that
would pass either way; folding a probe into its write is the change that would break it.

### 8.1 N7-U-A — the census stops counting the sites that refuse nothing

The N-waves' final acceptance row asked for a census "at its floor", every survivor a
genuine refusal with a measured justification. The floor audit tested that claim site by
site and found **25 of the 68 refusing nothing**: `unknown -> Record` narrowings behind a
whole-args parse, defensive type guards over a closed union, and `default:` arms of
switches TOTAL over the parse boundary's own key set. This unit applies to them the
disposition this engine had already used twice — N2-U1's `interpretInverseToOneKind`
`default` and X1c's two `foldOneNestedRelation` branches — and states it as a rule:

> **A branch unreachable BY CONSTRUCTION is a `QueryEngineError` internal invariant, never
> an `UnsupportedOperationError`.** The user-facing class means "this engine declines a
> shape you can write". A branch no payload can reach declines nothing, and counting it as
> a refusal makes the census a count of code rather than of capability.

**Why convert rather than DELETE**, given "one guard per invariant" bans redundant
defense: these are not guards, they are the type system's own requirements. The
`unknown -> Record` narrowings sit where a dynamically-keyed slot of a parsed payload
widens to `unknown` (X2 already recorded that removing them needs precise per-relation
types threaded through every Part builder — a refactor, not a deletion), and a `default:`
arm over a `string` kind is what makes the dispatch total for tsc. Deleting either would
mean casting instead of narrowing, which trades a fail-closed invariant for a silent one.
What was wrong was never that the branch exists — only the CLASS it threw, which claimed a
capability boundary where there is none.

23 of the 25 converted; census 68 → 45. **Nothing executes that did not execute before and
nothing refuses that did not refuse before** — the count moved because the metric got
honest, not because the engine did. Every conversion carries a witness in
`census-conversion-witnesses.test.ts`: a payload fed through the PUBLIC client surface,
asserting the `ValidationError` (or, for the mismatched-arity edge, the upstream
`NestedWriteError` the own-write analyzer raises) that answers FIRST. Four sites have no
public spelling at all — `UpdateOperation`'s missing-relation-schema and
impossible-relation-type guards, its depth twin in `nested-target-parts`, and
`ReadOperation`'s non-read-base guard — and are pinned by their structural invariant
instead, which is what the conversion law asks for when no payload exists.

TWO of the 25 failed re-verification, which is why the number is 45 rather than 43, and
each was caught a different way.

`CreateOperation`'s create-root relation-type guard called itself "a schema impossibility";
it is reachable. A `manyToOne` declared without `.fields()` has `holdsFK === false` and
`type === "manyToOne"`, lands on it, and is refused — while the SAME relation on the SAME
schema constructs under `update`, whose gate asks `isToOne || type === "oneToMany"` and
routes it down the very child-held path the create root withholds. Two sibling predicates
for one direction, one narrower than the other, and only the narrow one throws. A
purpose-built schema in the re-verification probe found it.

`RelationUpsertPart`'s to-many-upsert direction guard was filed "no reachable payload
identified", on the argument that every caller dispatches direction first. One does not:
`buildUpdateArmParts`, the grandchild fold on an upsert's UPDATE arm, dispatches on the
KIND alone, so a parent-held to-one `connectOrCreate` one level deeper arrives with
`type === "manyToOne"`. The ESTATE found this one — converting it turned
`upsert-family.test.ts`'s "depth-2 to-one grandchild refusal" red, a test that had been
standing in front of the site the whole time. **A reachability argument about "every
caller" is only as strong as the caller list**, and this is the shape of the mistake to
look for: a caller that dispatches on the kind instead of the shape.

Both stay in the census as capability gaps.

### 8.1 N1 residue — the batch ROOT address (amends P2a update (b))

P2a lowered the root `update`'s `notFound` postcondition to an `exists` guard "on the
located row's unique key". That phrasing hid an assumption: the unique key the caller
WROTE and the row the locate FOUND are the same address. They are, iff the `where`'s
DISCRIMINATOR names the primary key. Otherwise the discriminator is **reassignable** —
another row can take that value between the unlocked planning read and the atomic unit —
and the root's two batch statements, the guard (`findUnique(where)`) and the UPDATE
(`WHERE where`), could name a DIFFERENT row than every child edge, which addresses the
captured located row. One operation, two rows; the terminal read, which already addressed
the captured PK, then reported the row that was not mutated.

Both statements now address the capture, and the split is between them, not duplicated
across them:

- the **guard** conjoins the captured PK to the whole selector (filter half included) —
  the split-witness `RelationWritePart` / `RelationUpsertPart` / the X1c nested-target
  guard already use. It is the batch's ABORT mechanism: a reassigned discriminator leaves
  no `selector ∧ captured PK` row, so the unit aborts typed instead of mutating the
  replacement.
- the **root UPDATE** addresses the captured PK alone — the row the locate acted on (§the
  wrong-row doctrine), the row the children and the terminal already name. It is the row
  ADDRESS, not a second guard: an atomic batch is indivisible but **not serializable**, so
  a reassignment committed in the guard→UPDATE window is past the guard and only the
  address answers for it. Conversely the selector must NOT be re-copied into that WHERE:
  batch mode lowers no `affectedRows` postcondition, so the only thing a second copy could
  produce in that window is a SILENT zero-row root — a partial write with no error, which
  is strictly worse than the guard's typed abort. One guard for the premise, one address
  for the row (AGENTS.md: one guard per invariant).

Only ONE of the two is gated. The guard has arms; the address has none.

- The **guard** is gated on the selector's DISCRIMINATOR not naming the PK. Its question is
  "can this selector confirm some OTHER row?", and a pinned PK closes that outright: the
  conjunct would be a redundant copy of one the selector already carries (AGENTS.md). The
  two arms emit different SQL and a witness separates them, so the split is real.
- The **UPDATE** is not gated. It addresses the captured PK for every selector spelling —
  which is simply the bullet above with no exception carved out of it.

**CORRECTED TWICE** (two review rounds, each measured). Both dead ends are kept by name, so
the next lane does not re-derive either.

1. The first record gated BOTH halves on the selector naming the PK and called that "the
   entire hazard surface". True of the guard, false of the UPDATE, and measured false: a
   `where` can pin the PK and still carry a reassignable conjunct beside it. TWO spellings
   do it, and a check for either alone misses the other —
   - the **extended filter half** (`where: { id, count: 0 }`, Prisma >= 4.5) — not a
     discriminator, so `getWhereUniqueEntries` never sees it. With `count` moved off 0 in
     the guard→UPDATE window the root resolved UNINCREMENTED and the child INSERTed, no
     error;
   - a **compound unique containing the PK** (`where: { id_count: { id, count } }`) — wholly
     a discriminator, so there is no filter half at all and the flattened entries do cover
     every PK column. It emitted `UPDATE … WHERE (id = $2 AND count = $3)`.

   The pinned PK stops such a statement matching a DIFFERENT row, but not matching NO row,
   and batch mode lowers no `affectedRows` postcondition: the silent zero-row root the
   bullet above forbids, reached through the PK-named door. Narrower than wrong-row, the
   same class of split. **That correction stands** — it is why the address rule is
   unconditional rather than "unless the `where` names the PK".

2. The second record fixed (1) with a NARROWER escape hatch at the write site — leave the
   `where` alone when EVERY conjunct it contributes is a PK column — and justified keeping
   an escape hatch at all by the byte-identical `where: { id }` pin. That justification does
   not discriminate, and the hatch is now DELETED. For exactly the selectors it admitted,
   `buildPrimaryKeyWhereUnique` rebuilds the caller's own spelling (flat for a single PK,
   nested under the constraint name for a compound one) carrying the values the locate
   matched — so both arms emit the same string. MEASURED: deleting the branch outright
   leaves `tests/query-engine-v2` at 55 files / 1024 tests, 0 failed, and leaves the
   `where: { id }` byte-compare green either way. A check whose unique coverage cannot be
   named is what AGENTS.md bans, and the ban does not lapse because the check is an
   optimisation rather than a guard. The GUARD's split passes the same test that the
   hatch failed: force the guard to always conjoin the captured PK and
   "where:{id} issues the pre-change batch, statement for statement" turns RED.

`where: { id }` batches — the overwhelmingly common shape — are byte-identical to the
pre-change ones, pinned statement-for-statement in `located-parent-ref.test.ts`. For the
GUARD that pin is the gate's own witness. For the UPDATE it is a CONSEQUENCE of the rebuilt
spelling, not an exemption, and it cannot tell an address rule from an escape hatch — that
file's header says so, in place. The address is falsified in `staleness-injection.test.ts`
("batch root address"): the guard at a before-batch rename+reinsert, the address mid-batch
(inside the unit, between the guard and the UPDATE) in each of its three arms — reassignable
discriminator, extended filter half, compound-unique member — each with its own control.
Making the root UPDATE re-consult the selector reddens all three, plus the `where: { email }`
byte-compare arm. The compound-PK spelling of a PK-naming selector — the shape the deleted
hatch used to divert — is certified behaviorally on both substrates and every driver leg by
`located-parent-ref-behavior.ts` ("compound primary-key reference: both members come from
the located row").

`DeleteOperation` still addresses the original `where` in batch mode. Narrower — it has no
child edges to split against — but its captured read and its DELETE are two evaluations of
one selector, so it is a lane, not a non-issue.

### 8.2 N7-U-B — the arms that ask for nothing, and what a live oracle sees

U-A stopped counting the sites that refuse nothing. U-B took the sites that DO refuse and
measured them — not against Prisma's generated input types, which is what every earlier
wave compared to, but against **a running Prisma 7.9.1** (`prisma-client` generator +
`@prisma/adapter-pg`, on a scratch Postgres), payload by payload beside the same payload on
viborm. Census 45 → **40**, and the (c-iii) class — reachable refusals with no recorded
reason — is empty.

**The finding that matters is not a refusal.** A to-one `disconnect` / `delete` is
`v.boolean()` at the parse boundary, so `false` is the entire non-`true` surface, and Prisma
treats it as DO NOTHING. viborm refused it at four sites — and at two paths with NO census
site it silently did the disconnect anyway: `interpretToOneLink` nulled the FK without ever
reading the boolean, and the depth arm passed `isInverseToOne && kind === "disconnect" ?
true : …`. **A census of refusals is structurally blind to a wrong ACCEPT.** That is the
argument for measuring behavior rather than counting throws, and it cost this engine two
silent data-loss paths to make.

The fix is a rule about the vocabulary, not a fifth check: **a kind that asks for nothing is
not a kind.** `getRelationMutationKinds` is the ONE derivation of the kind list — every V2
dispatch and the own-write legality walk of §4 read it — so dropping a `false` arm there
means no arm is built, no legality footprint is derived, and no downstream site re-asks.
`UpdateOperation.interpretRelation` returns early on an empty list, which is also what makes
an empty relation payload (`{ profile: {} }`) the no-op Prisma makes it, while the
"two kinds on one to-one arm" refusal — a payload naming two conflicting intents — stands.
`RelationWritePart.isNoOpUpdate` is the same rule one level down: an `update`/`updateMany`
arm with no scalar assignment and no deeper write emits NO step, so it neither writes an
empty SET nor makes the target's existence a precondition — both measured behaviors.

**One vocabulary limit was measured rather than argued, and it is §1's.** The audit expected
a compound-PK CHILD in a nested targeted mutation to fall to "the per-field generalization
N1-U2 applied to FKs". It does not, because those are two different objects. N1-U2
generalized the FK ASSIGNMENT — values written INTO columns — and those structures are
already per-field. A nested targeted mutation needs the **produced identity a later step
ADDRESSES**, and that is single-column at the bottom of the vocabulary:
`StatementOutputSource`'s `firstRowField` carries `field: string`. There is no tuple form to
wire, which is why that family is inexpressible rather than unwired, and why closing it is a
§1 amendment (a multi-column produced output, then a tuple `capturedPk`) rather than a
wiring wave.

### 8.1 P8 — the CTE folds add no vocabulary, and the ladder is what they read

query-performance-plan Phase 8 folds two multi-statement shapes into one PostgreSQL
command each, and neither touches §1. A fold produces one `write` step where there were
several; every `Ref`, `Probe`, pin and postcondition it might have carried is what
DISQUALIFIES it. That is the whole disposition, and it is worth writing down because it
looks like it should have needed a vocabulary term and did not.

**8.1, the terminal read.** `WITH … AS (UPDATE/INSERT … RETURNING <every column>) SELECT
<the terminal read's own projection> FROM …`. One `write` step, `outputs: { result: rows }`,
the same `affectedRows(1, notFound)` / `exactlyOneRow` the unfolded step carried. The
projection is built by the READ path's builder over a real aliased `FROM`, so the include
is the include — this is the structural answer to the `RETURNING`-list correlation defect
(a bare outer column captured by the inner table), not a second correlation mechanism.

**8.2, the fresh tree.** The elision rule this document states in §4 — a correlated probe
under a parent this operation creates is statically empty — is what makes a whole nested
`create` tree ask the database nothing before it writes. §8.2 turns that from a licence
into a CHECK: the tree folds iff its planning fragment is empty, it emits no guard, and no
statement of it reads another statement's output. The third conjunct is the §9 invariant 3
seen from the other side — a `WITH` gives every arm the same snapshot, so an arm cannot be
the channel for a value another arm produced, and a tree that needed one (a
database-generated parent key) keeps its `Ref` and its statements. Falsified by deleting
it: the fragment validator then rejects the folded step for referencing itself, which is
invariant 2 catching what invariant 3 was supposed to prevent.

**8.2's FOURTH conjunct, added by review: what an arm reads is not all a merge decides.**
The three above are about the DATA crossing between statements. Merging also drops the
ORDER the executor ran them in — and PostgreSQL does not specify the order of a
data-modifying `WITH` arm whose output nothing reads (PG 16 runs them last-to-first). Note
that this is invisible to §9: the fragment is valid, the operation is statement-atomic, and
the answer is right, because the tree fold demands a scalar-only root projection. The
divergence is in persisted state — sibling `create` arms over a `serial` child key were
handed their sequence values backwards. The conjunct is that at most ONE arm may take a
value the database assigns, and the reason it can be stated so narrowly is a fact outside
this document: `assertApplicationGeneratedValues` materializes every `autoGenerate` but
`increment` application-side, so an absent auto-increment column is the whole of what this
engine leaves to the database. Arms are classified by walking the record tree; an arm a
`Part` produced is not classified, and an unclassified arm declines — which is why an M2M
`create` under a fresh root no longer folds.

**What both folds do NOT relax.** The Pin Rule has nothing to bind in either: 8.1's
statement runs no planning read, and 8.2's tree has none by construction, so there is no
premise a concurrent writer could invalidate between a read and a write. That is the same
argument §4's ON CONFLICT door records for the top-level upsert, reached from a different
direction.

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
