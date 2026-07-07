# Nested-Write Engine Unification — THE Design

Status: **decided**. Anchor: branch `prisma-parity`, commit `2fa49b6`.
This document supersedes the four candidate designs in this directory
(`design-total-ir.md`, `design-one-interpreter.md`, `design-type-driven.md`,
`design-strangler.md`). Those documents remain as the record of the argument;
implementers work from **this** document. The six `map-*.md` files are the
ground truth this design is checked against; where this document cites an
invariant (I1–I11), a divergence (D1–D9 or a named `DIVERGENCE-*`), or a
section (e.g. map-shared §D.5), it refers to those maps.

Acceptance oracle, unchanged and non-negotiable:
`tests/query-engine/nested-write-conformance.test.ts` (identical scenarios
through both execution modes on PGlite, byte-identical persisted state) and
`tests/drivers/*-behavior.ts` (per-driver Prisma-parity contract). Green at
every milestone. The oracle is *widened* at M0 (§11) — it currently contains
exactly four scenarios, all FK-direction create/connectOrCreate (verified at
anchor), which is far too little to gate this migration.

---

## 0. Problem statement, from first principles

A nested write (`create`/`update`/`upsert` with relation mutations) is a
**plan over uncertain state**: an ordered sequence of row mutations whose
values depend on

- (a) **execution-generated values** — DB-assigned ids a later statement must
  reference,
- (b) **reads that decide branches** — upsert existing?, connectOrCreate
  found?, targetWhere/setWhere matched?, correlated child present?,
- (c) **invariants that must hold at commit** — target exists, child belongs
  to this parent, FK is nullable, departing rows would not be orphaned,

and which must commit **atomically** — all-or-nothing, ordered, on one
connection.

Today this plan is implicit. It exists only as the control flow of two
engines (6,598 lines in `src/query-engine/operations/nested-writes/`,
counted at anchor) that reconstruct it twice:

- the **tx engine** threads JS values between `await`ed statements and
  branches at runtime inside `driver.withTransaction`;
- the **batch engine** threads `BatchValueRef` symbols, decides branches at
  plan time against committed state, and pins each decision with a SQL
  assertion guard, emitting one statement list for `driver._executeBatch`.

Every feature lands twice; several shipped bugs were divergences between the
two (which is why the conformance suite exists). The maps prove the two
engines already share their entire *semantic* layer — `getFkDirection`,
`planRelationMutationSteps`, `splitRelationMutationsByFk`,
`planExistingUpsertBranch`, `buildScalarSqlValue`, the junction builders, the
not-found taxonomy — and differ **only in substrate**.

### 0.1 The single axis of variation

The code reduces the substrate difference to **one capability bit**:

> **`canObserveOwnWrites`** — can a read issued mid-operation see writes this
> same operation has already issued but not yet committed?

`true` for interactive-transaction drivers; `false` for batch-only drivers
(D1, Neon-HTTP). Every entry in the maps' divergence tables is a consequence
of this bit, along exactly two axes (design-strangler's framing, adopted):

- **Axis A — how a produced value is carried.** Live: `await`, read the JS
  value, thread it. Deferred: a symbol, lowered to a
  `batchRefs.store`/`read()` round-trip through the scratch table.
  *Already unified at the leaf*: `buildScalarSqlValue`
  (`src/query-engine/builders/values-builder.ts:113`) accepts
  `unknown | Sql | BatchValueRef` and lowers all three (verified at anchor).
- **Axis B — when a read-driven branch is decided and how its premise is
  enforced.** Live: read at execution, branch in JS, premise held by the
  open transaction's locks/serialization (or checked by rowCount). Deferred:
  read at plan time against committed state, branch in JS, premise **pinned
  by a SQL guard** that aborts the atomic unit if stale.

Four facts, verified in code, make the unification shape obvious:

1. **The value substrate is one thing** (`BatchResolvableValue`, lowered at
   `buildScalarSqlValue`). The `fk.ts` duplication is at the
   assignment-orchestration layer, not the value layer (map-shared §B.1).
2. **The reads are one thing** (`record-access.ts` fetch helpers; both
   engines call the identical functions; only *when* the read fires differs —
   map-shared §C.2).
3. **The atomic guarantee is one thing with two implementations**
   (`withTransaction` / `_executeBatch`: all-or-nothing + ordered + one
   connection — map-batch-refs §6.1).
4. **The step/guard model is already shared data** (`semantic-plan.ts`:
   `NestedWriteStep`, `NestedWriteGuard`, `planExistingUpsertBranch`).

### 0.2 The verdict

**One semantics-full interpreter, parameterized by a two-implementation
`Mode` capability object, emitting write effects over an `Expr` value
language into a mode-owned atomic scope.**

The base is `design-one-interpreter.md`. The two-backend shapes
(`design-total-ir.md`, `design-strangler.md`) and the straight-line
compile-then-lower shape (`design-type-driven.md`) are rejected as
architectures (reasons in §12), but each contributes load-bearing pieces
grafted in (provenance in §1.1). The decisive argument for the
single-interpreter shape:

- A **backend split** — however thin — leaves every effect kind with a *pair*
  of realizations to write and keep in sync, and (worse) leaves the branchy
  parts — arm selection, guard emission, probe timing — as the pairing
  surface. Those are exactly where the historical double-bugs lived. A
  **mode split** makes a second copy of any *semantic* decision structurally
  impossible: there is one interpreter body; the mode is consulted only
  through a handful of narrow, substrate-mechanical methods. What still pairs
  up is precisely the substrate surface (§8.4 enumerates it), and a grep gate
  holds that line.
- The emit-sink formulation lets the live path stay read-driven and
  allocation-light (no forced plan materialization), which a compile-to-IR
  pipeline cannot offer. The IR survives as the interpreter's **emit
  vocabulary**; only the planned mode collects it into a statement list.
- The type-driven design's "no runtime branch, compile inside the
  transaction" collapses under scrutiny: to preserve today's tx semantics
  (a probe for step N observes step N−1's writes), its compile and execute
  phases must interleave per step — at which point it *is* this interpreter,
  with extra bookkeeping. Its own self-doubt (§13 there) concedes this.

### 0.3 The adversarial record, and what it forced

All four candidates were independently attacked (three attackers each; all
four averaged 7/10). The record shaped this synthesis materially:

- **One formal FATAL** was proven, against design-total-ir, and it is a
  *live bug in production today*, not merely a design flaw: the batch
  engine's `uniqueMissing` guard is emitted **before** the create-branch
  INSERT (`batch-plan.ts:397-399`, verified). Under a concurrent race for a
  missing key, the loser's guard aborts *first*, surfaces as
  `NestedWriteAssertionError` (`error-mapping.ts:94-102`), which
  `isWriteRaceLoserError` (`transaction-flow.ts`, verified: accepts only
  `UniqueConstraintError` | DEADLOCK | SERIALIZATION_FAILURE) does **not**
  accept — so the write-race retry never fires and batch drivers hard-fail
  where tx drivers converge. Any design that rewraps guard aborts into typed
  not-found errors makes this worse. This synthesis resolves it **by
  construction** with the Pin Rule (§5.5): raceable-create-branch premises
  are not pinned at all; the DB unique constraint is the enforcer and its
  violation is the already-retryable signal (exactly the coupling map-oracle
  D7 demands be preserved).
- **The migration plans of all four candidates were broken the same way**
  (verified: `update.ts:72` injects `executeRelationCreate`;
  `transaction-flow.ts:523` and `many-to-many.ts:488` call
  `executeNestedCreate`): the old engines are one mutually-recursive
  organism; per-kind file deletion mid-migration is impossible, and a
  migrated kind cannot host an unmigrated nested kind because the value
  substrates don't interoperate. Fixed by whole-tree routing and an honest
  deletion schedule (§11).
- **The conformance oracle is nearly empty** (verified: 4 scenarios, all
  FK create/connectOrCreate; zero upsert/set/disconnect/delete/updateMany/
  PK-change/M2M). Every candidate's "oracle green at every milestone" was
  close to vacuous for most milestones. Fixed: M0 widens the oracle across
  **all** kinds, not just M2M (§11).
- The remaining surviving weaknesses are dispositioned one-by-one in §1.2.

---

## 1. Synthesis provenance and flaw disposition

### 1.1 What was taken from where

| Piece | Source | Where here |
|---|---|---|
| Single interpreter + `Mode` (narrow methods), emit sink, `selectMode`, flat atomic scope | one-interpreter | §3, §8 |
| Guard-as-data carrying its typed error, in **both** modes; error parity by construction | total-ir §4.5 + one-interpreter §4 + strangler §2.3 | §5, §7 |
| `requireAffected` as first-class effect data (fused guard) | total-ir §4.2 + type-driven §5.2 + strangler §2.3 | §5.3 |
| Symbol-origin capability taxonomy; single legality gate, single throw site | type-driven §2.2/§6.3 (branding dropped, §1.2 S3) | §4.1, §6.3 |
| `set` member premises unified: skip decided once from the probe record, pinned in planned mode; rowCount contract kept | type-driven §4.9 intent, repaired per its attacker (§1.2 A13) | §5.3, §9 |
| D4 closed by rebinding every downstream-read column, decided once, statically over-approximated | one-interpreter §5 + type-driven §4.10 + attacker refinement | §6.2, §9 |
| Abort-attribution ladder for planned-mode guard failures | strangler §4.3 + type-driven §7 | §7.3 |
| The Pin Rule (pin what live locks; let constraints enforce what live cannot lock) | new — forced by the FATAL | §5.5 |
| Whole-tree routing seam; deletion deferred to unreachability | strangler intent + attacker proof of coupling | §11 |
| M0 = oracle hardening first; per-milestone gates; grep gates; "LOC must drop or the abstraction failed" | total-ir §10 + strangler §7/§10 | §11 |
| Race-retry above the interpreter; planned mode gains converge-on-rerun | one-interpreter §4 + map-oracle B.5/D7 | §7.4 |
| Zero new adapter primitives | type-driven §10 | §8.5 |
| Axis A / Axis B framing | strangler §1.2 | §0.1 |

### 1.2 The surviving attacks: fixed or rebutted

Each entry names the attack (F = the fatal, A = attacker weakness,
S = self-doubt), the verdict, and the mechanism.

**F1 [total-ir FATAL; latent in one-interpreter M6/M7 and strangler §6 —
FIXED, by construction].** Guard-abort→typed-error rewrap destroys the
write-race retry: the `notExists` pin fires before the create INSERT, its
abort is (today) non-retryable, and rewrapping it into `recordNotFoundError`
keeps it non-retryable — batch drivers hard-fail where tx drivers converge.
Fix: the **Pin Rule** (§5.5). A premise of the form "no row with unique key
K" guarding a branch that INSERTs into the same model is **not pinned** in
planned mode — the DB unique constraint over K enforces it at exactly the
point of consumption, and its violation is a real `UniqueConstraintError`,
which `isWriteRaceLoserError` already accepts and map-oracle D7 explicitly
demands be the signal. The guard that caused the fatal is deleted, not
rewrapped. Bonus: the pin was *stricter than live semantics* (live never
re-asserts the missing-premise after its probe; FOR UPDATE cannot lock an
absent row), so dropping it also improves parity in the edge where the
create payload does not carry the probed key. This fixes a **shipped bug**:
today a concurrent connectOrCreate/upsert of a missing key on D1/Neon-HTTP
aborts hard instead of converging.

**A1 [one-interpreter: "teach `isWriteRaceLoserError` to accept the
assertion error and non-raceable failures get retried too; no plumbing
carries the per-guard raceable bit across the driver boundary" — FIXED].**
The raceable bit never crosses the driver boundary and is never parsed from
error text. It lives in the planned scope's own side table
(`statement position → GuardFailure`), populated as guards are appended
(§7.3). The abort is attributed *in the query-engine layer* (index or
post-hoc re-probe), and the rethrown typed error carries `raceable` only if
the attributed `GuardFailure` had it. Blanket acceptance of
`NestedWriteAssertionError` is explicitly rejected (§12.14). After the Pin
Rule, the only raceable guard failures left are the filtered-M2M-deleteMany
staleness pins (§9); correlation/orphan/existing-row guards are non-raceable
and never loop.

**A2 [one-interpreter: "guard-read isolation varies within PlannedMode;
which error surfaces depends on dialect/isolation" — DEFUSED].** After the
Pin Rule there is no pin racing the INSERT, so the isolation question
("does the guard see the concurrent commit before the INSERT violates?")
disappears for the raceable path: the only signal is the constraint
violation, identical on every dialect. For the remaining (non-raceable) pins
the surfaced error is the same typed error regardless of which statement
aborts, because attribution maps it back to the one `GuardFailure` (§7.3).

**A3 [one-interpreter + total-ir + strangler: per-kind migration is
illusory; old engines are mutually recursive; create.ts is un-deletable at
its own milestone; no Expr↔parentData interop seam exists — FIXED].**
Routing is **whole-tree**: a top-level operation goes to the interpreter iff
*every* nested kind and relation class in its (statically walkable, pure —
`semantic-plan.ts` has no I/O) tree is migrated; otherwise the *entire* tree
runs on the untouched old engines. No mixed trees ⇒ no interop seam ⇒ the
Expr↔parentData boundary never exists. Deletion is scheduled by
**reachability**, not by milestone vanity: the old engines are deleted in
bulk at M9, when no tree can reach them (§11). The cost — a window where
old engines and interpreter coexist — is stated, with a bug-fix policy
(§11, "coexistence rules").

**A4 [type-driven attacker: the conformance oracle has 4 scenarios; "green
at every milestone" is vacuous for M2+ — FIXED].** M0 adds head-to-head
scenarios for **every** mutation kind (upsert incl. targetWhere/setWhere
skips, set incl. orphan/no-op/partial, disconnect, delete, deleteMany,
update-with-PK-change incl. computed increment, updateMany, all M2M kinds,
D4, cross-step fail-closed) — not only M2M (§11 M0). If any new scenario
fails on the *existing* engines, a shipped divergence has been found and is
fixed first, as its own scoped change.

**A5 [one-interpreter: "M4 removes a functioning savepoint mechanism and
asserts equivalence without proof" — FIXED, with the proof].** Verified at
anchor: the driver's `SavepointQueue` (`driver.ts:706,820-827`) is real and
stays (it serves user-level nested `withTransaction`). But **no nested-write
code path catches an error from a nested executor and continues** — there is
not a single `try`/`catch` in `create.ts`, `update.ts`, `upsert.ts`,
`relation-mutation.ts`, or `many-to-many.ts` (verified by grep at anchor);
the only catch is the top-level retry wrapper, which re-runs after a *full*
rollback. Savepoint partial-rollback is therefore unobservable inside a
nested write; collapsing to one flat scope changes mechanism, not observable
behavior. M4's gate pins this with a spy (exactly one `withTransaction` per
operation) plus the multi-level rollback scenario.

**A6 [total-ir attacker: M2M filtered-deleteMany guards convert a silent
divergence into an abort-vs-success divergence — FIXED, two-part].**
(i) The symmetric-difference guards (§9) close the plan-time→execution
staleness window *fail-closed*. The residual window — between the guard
statements and the DELETEs inside one atomic unit — is the **same window
class the tx engine itself has** (verified: tx m2m deleteMany is also
`fetchConnectedTargetPks` then `DELETE … IN (pks)`, two adjacent
statements), governed by DB isolation, not by the engine. So the guards
restore *window-class parity*, which is the honest maximum.
(ii) The guards' failures are **raceable**: the retry re-plans against fresh
membership and converges to the live outcome. Sustained churn surfaces the
typed error — fail-closed, never silent (§7.4).

**A7 [total-ir attacker: two capability flags under-model the driver matrix
(supportsReturning, supportsUpsertWhere, lastInsertId dialects) — REBUTTED,
with a boundary statement].** `Mode` captures exactly the one nested-write-
specific axis (own-writes visibility). Orthogonal driver/adapter features
remain where they live today and are consulted by the *realizations*, not
modeled in `Mode`: `supportsReturning` inside the live insert realization
(`executeSimpleInsert`'s contract, kept), `supportsUpsertWhere` at the
executor entry that routes upserts into this engine (map-oracle §B.4,
untouched), dialect `lastInsertId`/assertion SQL behind the adapter (I9).
Folding them into `Mode` would couple unrelated capability surfaces; leaving
them out keeps `Mode` the minimal seam. If a *nested-write semantic* ever
branches on one of them, that branch lives in the interpreter — one place.

**A8 [total-ir attacker: the symbol taxonomy has no case for a single
DB-default generated non-increment PK (e.g. `gen_random_uuid()`), so a
future feature mis-mints or errors — REBUTTED as designed behavior, with
the lift path recorded].** Such a PK is `opaqueGenerated` (§4.1): live mode
reads it back via RETURNING; planned mode rejects with the existing typed
"known before execution" message at the single gate. Not silent, not
mis-minted. Lifting it later = teaching the planned emit a RETURNING-based
store for dialects that support `INSERT … RETURNING` into the scratch table
— a scoped, test-first change that touches only `planned-mode.ts` and the
gate. Today app-generated uuid/ulid values are client-supplied literals and
unaffected (verified: `values-builder.ts` throws "not yet implemented" for
DB-generated non-increment, so no live behavior exists to preserve).

**A9 [type-driven attacker: `Guard.onFail{errorKind, relationName, op}` is
too poor to reconstruct bespoke messages like the set-orphan field list —
FIXED by shape].** `GuardFailure.error` is a **closure**, not a kind tuple
(§4.2), precisely so the set-orphan message ("foreign key field(s) postId
are required: rows removed from the set cannot be disconnected…"), the
FK-required message, and the "deleted during upsert" message are produced
byte-identically in both modes. No mode file contains an error message.

**A10 [type-driven attacker: D4's "statically decidable" claim is entangled
with read-decided branches — FIXED by over-approximation].** The decision
"emit the before-image/after-image read; rebind this updated column" is a
**static over-approximation** over the args tree and schema: a downstream
consumer *in any branch arm* counts, whether or not that arm is later taken.
The consumed-column set is computable without I/O (it is the union of
`fkDir.pkFields` / junction source fields over nested relations — schema
facts). Cost of over-approximation: at most one unneeded read; never a wrong
value. Both modes make the same decision because it is interpreter code.

**A11 [total-ir attacker: the `set` one-ordering claim needs an
all-or-nothing proof — PROVIDED].** Both substrates are atomic units; any
mid-sequence failure (guard, rowCount, constraint) aborts the whole unit, so
the *internal* order of DELETE-vs-check is unobservable on failure. On
success the effects are disjoint by construction (departing set ∩ member set
= ∅: departing = connected ∧ NOT(member), member connects are keyed by
unique inputs), so any serial order yields the same end state. The
interpreter fixes one order (assert-members → handle-departing → connect)
for determinism, not for correctness.

**A12 [one-interpreter attacker: the retry-gap fix is mislabeled; it is a
pre-existing production bug and a new capability — ACCEPTED, relabeled].**
Correct. §7.4 and M8 are labeled a **bug fix plus new concurrent suite**,
not behavior preservation. The suite is the load-bearing gate and runs on
the Docker-gated multi-connection drivers (PGlite is single-connection).

**A13 [type-driven attacker: `requireAffected:false` on set-connect loses
live mode's detection of a set member vanishing between the existence read
and the connect UPDATE — a correctness regression its §4.9 denied — FIXED,
without porting the MySQL workaround as a mode split].** The set member
premise is unified as: (i) member existence = probe(required, `kind:target`,
select:record) — typed immediately in both modes; (ii) the interpreter
computes already-connected from the probe record **in both modes** and skips
the connect UPDATE for those members, emitting instead a pinned
`exists(unique ∧ fkMatch)` guard ("still connected"), per Pin Rule 1 —
live realizes it as a no-op, planned as an assertion; (iii) non-skipped
members keep `requireAffected: correlated` (live: rowCount — today's
behavior preserved, and the MySQL no-change-0-rows false positive cannot
fire because already-connected rows were skipped; planned: a preceding
exists-assert — today's batch shape). Net: live behavior is unchanged;
planned becomes *less* silent than today (it currently rewrites all members
with no vanish detection at all). The irreducible residues are documented:
planned's one-statement skew between assert and write (§5.1, common to all
write-coupled premises) and live's unlocked-skip window (present today;
unchanged).

**S1 [one-interpreter self-doubt: "guards are no-ops in live mode" would
drop non-probe-backed premises — FIXED].** The three-source premise taxonomy
(§5.1): probe-backed premises realize as no-ops in live mode *only because*
the probe ran in the same scope; write-coupled premises realize as rowCount
checks; standalone premises realize as SELECT-then-throw. `LiveMode` tracks
which premises arrived via `ProbeResult`; anything else executes.

**S2 [one-interpreter self-doubt §8: uniform rejection of compound-generated
PKs — REBUTTED, gap kept as typed].** "Succeeds on Postgres, throws typed on
D1" is not silent divergence; it is the maintainer's sanctioned outcome
("identical observable behavior … **or a clear typed error**", codified as
map-oracle invariant 11). Uniform rejection would delete a working live
capability to serve a symmetry nothing demands. The gap is raised by the
single legality gate (§6.3), so the two modes can never disagree on where
the line is.

**S3 [type-driven `assertBatchLowerable` needs `as Plan<BatchLowerable>` —
FIXED by replacement].** The project bans type assertions (AGENTS.md
Rule 2). The capability contract is runtime-checked data with one throw site
(§6.3); the generic branding is dropped. Nothing observable is lost — the
type parameter never made a runtime input legal; the gate did.

**S4 [strangler self-doubt: compile-both-arms CPU cost — AVOIDED].** The
interpreter takes branches in ordinary control flow; only the taken arm is
ever interpreted, in both modes (probes run live in live mode, at plan time
in planned mode). The orchestrator's two-arm `Branch` node is rejected
(§12.6).

**S5 [total-ir self-doubt: state-equivalence, not plan-equivalence, is the
provable property — ABSORBED, stated].** True of any design on these
substrates: a one-shot batch cannot carry an unresolved branch. The
single-interpreter shape minimizes the residue — decision function and arm
bodies are one code path; only probe *timing* differs, and the staleness
contract (§6) converts timing skew into fail-closed aborts. The residue is a
stated contract, not an accident.

---

## 2. The model

**A nested write is an ordered sequence of *effects* (row writes) over
*expressions* (values that may not be known yet), interleaved with *probes*
(reads that decide) whose conclusions are *guarded* per the Pin Rule
(premises re-asserted inside the atomic unit exactly where live-mode
locking would have held them), the whole committing atomically.**

One interpreter owns all semantics: FK direction, step order, correlation,
existence rules, branch decisions, guard attachment, error kinds, result
shape. It consults a `Mode` for exactly the substrate mechanics: how a
symbol resolves to SQL, when a probe runs and against what state, how a
produced value is captured, how a guard/requireAffected is realized, and
what the atomic scope is. `LiveMode` and `PlannedMode` are the only two
implementations, because there is only one capability bit.

```
                       validated args
                             │
              ┌──────────────▼───────────────┐
              │  assertPlanExecutable(mode)  │  static legality, whole tree,
              │  (§6.3 — one throw site)     │  BOTH modes, before any effect
              └──────────────┬───────────────┘
                             │
                 mode = selectMode(driver)          (§8.1 — the ONLY capability fork)
                             │
              mode.scope.run(async (emit) => {
                             │
              ┌──────────────▼───────────────┐
              │      INTERPRETER (one)       │  semantics live here, once:
              │  separateData · getFkDirection│  splitRelationMutationsByFk,
              │  planRelationMutationSteps    │  planExistingUpsertBranch,
              │  probes → guarded decisions   │  correlation builders, m2m
              │  emit(effect) over Exprs      │  junction builders — reused
              └──────────────┬───────────────┘  verbatim
                             │
        ┌────────────────────┴────────────────────┐
        ▼ LiveMode                                 ▼ PlannedMode
   emit executes now on txDriver;            emit appends lowered Sql to the
   probes read live (see own writes);        statement list; probes ran at
   guards: no-op / rowCount / read-throw;    plan time (committed state);
   symbols become JS literals;               guards: adapter.assertions;
   one driver.withTransaction                symbols: batchRefs store/read;
                                             one driver._executeBatch
```

---

## 3. Core abstractions

Six abstractions. Each carries its justification inline; anything that could
not finish its "exists because…" sentence from a concrete need in the maps
was cut (§12 lists the casualties).

### 3.1 `Expr` — a value that may not be known yet

**Exists because** a nested write threads values across statement boundaries
where the value is (a) a literal known now, (b) a pre-built SQL fragment
(connect target-PK subquery), or (c) produced by an earlier statement of this
very operation. The code already has this union (`BatchResolvableValue`,
`batch-references.ts:30`) and already lowers it at one leaf
(`buildScalarSqlValue`). We name it and make it the one value type the
interpreter speaks. The maps' invariant "the value crossing every phase
boundary is always a primary key read from a persisted row" (map-tx-create
§13.2) is why `sym` suffices: a symbol is always a PK-or-scalar column
value, never a row.

Deliberately **not** a general expression language: no `and`/`or`/`eq`, no
arbitrary arithmetic node, no distinct null node (`lit(null)` already lowers
to `adapter.literals.null()` — verified; the required-FK obligation is
enforced by the legality gate, not by a value shape). PK arithmetic
(`increment` on a PK) is the single computed case and is confined to a
symbol *origin* (§4.1). WHERE/correlation predicates remain adapter-built
`Sql` from the existing shared builders (`buildFkMatchCondition`,
`combineWithParentCorrelation`, `buildDepartingRowsCondition`,
`buildWhereUnique`, the junction builders) — already substrate-agnostic
because every value inside them routes through `buildScalarSqlValue`.
Reifying predicates into the IR would rebuild a working shared layer as a
second query language: rejected (§12.7).

### 3.2 `WriteSymbol` — a promised value, with its provenance

**Exists because** both engines must represent "produced but not yet known",
and *how* the value becomes known is exactly the capability contract: the
planned substrate can defer only a single auto-increment
(`storeLastInsertId`) or an adapter-arithmetic computation
(`store(computedSql)`); the live substrate can read anything back. Recording
the origin on the symbol makes legality a property of data, checked at one
gate (§6.3), instead of a property of which engine file you are in (D3,
map-batch-refs invariant 11).

### 3.3 `Effect` — a write, as data

**Exists because** the interpreter must emit an ordered sequence of side
effects both modes execute identically once values resolve. Effects are
write-only: no branching, no deciding reads. The kinds mirror exactly the
statements both engines emit today: insert, insertMany, update, delete,
guard.

### 3.4 `Probe` / `ProbeResult` — a read that decides, structurally chained to its pin

**Exists because** every branch both engines take is a function of a read
(upsert exists?, connectOrCreate found?, correlated child present?,
targetWhere matched?, uncorrelated row exists?), and the recurring bug class
the maps warn about is *a plan-time branch whose premise is not pinned*
("dropping a guard = silent divergence", map-batch-refs invariant 5).
`mode.probe()` returns a `ProbeResult` that **carries the pin the caller
must emit** — a branch without its pin is unrepresentable in the
interpreter's own code, and the Pin Rule (§5.5) decides *which* outcomes
carry a pin at all. Probes also subsume the `fetchRequired*` family: a probe
with `required` set throws the typed error immediately in both modes (the
batch planner already throws typed errors at plan time today).

### 3.5 `Guard` + `GuardFailure` — a premise that must hold at commit, carrying its typed error

**Exists because** (i) a plan-time decision opens a staleness window that
must fail closed (I2, I3), and (ii) the worst observable divergence in the
system today is D1: the tx path throws `NestedWriteError`/
`recordNotFoundError` with pinned messages while the batch guard surfaces a
raw dialect abort normalized to a generic `NestedWriteAssertionError` — the
behavior suite literally branches on `driver.supportsTransactions` to assert
two different messages. Making the guard carry the domain error it stands
for (`failure`, a **closure** — §1.2 A9) is what lets both modes surface the
**same typed error with the same message** (§7). The guard *vocabulary* is
the existing `NestedWriteGuard` union (`semantic-plan.ts`) plus
arbitrary-`Sql` premises — the shapes `assertions.ts` already lowers.

### 3.6 `Mode` — the capability object (the load-bearing seam)

**Exists because** the one real axis of variation (§0.1) manifests as five
coordinated behaviors that must stay consistent — symbol resolution, probe
timing+pinning, produced-value capture, guard/rowCount realization, atomic
scope. Scattered `if (canObserveOwnWrites)` checks would let them drift
apart; a backend split would duplicate the ~90% that is identical. Two
implementations exist because two substrates exist in reality — this is not
the banned interface-with-one-implementation, and no third mode is
contemplated or provided for. Orthogonal driver features
(`supportsReturning`, `supportsUpsertWhere`, dialect SQL) are **not** in
`Mode` (§1.2 A7).

---

## 4. TypeScript specification

Location: `src/query-engine/operations/nested-writes/`. New files: `expr.ts`,
`effects.ts`, `mode.ts`, `live-mode.ts`, `planned-mode.ts`, `legality.ts`,
`interpreter.ts`, plus the temporary `routing.ts` (deleted at M10). Kept
files: `semantic-plan.ts`, `fk.ts` (condition builders only),
`record-access.ts`, `assertions.ts`, `planned-mutation.ts` (folded into
`legality.ts`), and `../builders/many-to-many-utils.ts`. Everything else in
the directory is deleted per §11.

All types follow the project's no-assertion rule: discriminated unions +
narrowing, never `as`.

### 4.1 Values (`expr.ts`)

```ts
import type { Sql } from "@sql";
import type { Model } from "@schema/model";

/** A value that flows through a nested write. Closed; does not grow.
 *  IR-creep guard: adding a case requires a producer in the interpreter. */
export type Expr =
  | { readonly kind: "lit"; readonly value: unknown }    // known now (null included)
  | { readonly kind: "sql"; readonly sql: Sql }          // pre-built fragment (connect subquery)
  | { readonly kind: "sym"; readonly sym: WriteSymbol }; // produced during execution

/** A record identity that is partly known, partly deferred —
 *  the unified successor of BatchRecordRef.primaryKey. */
export type IdentityExprs = Readonly<Record<string, Expr>>;

/** A promised value. Identity + provenance; never holds the value itself. */
export interface WriteSymbol {
  readonly id: string;                    // "sym_N", monotonic per operation
  readonly model: Model<any>;
  readonly field: string;                 // the column this symbol stands for
  readonly origin: SymbolOrigin;
}

/** How the symbol's value becomes known. This IS the capability contract,
 *  per symbol (§6.3). Exactly the three sources the code has today. */
export type SymbolOrigin =
  /** Single auto-increment produced by the insert that lists this symbol in
   *  `produces`. Live: RETURNING/lastInsertId. Planned: storeLastInsertId
   *  immediately after the insert. Planned-legal. */
  | { readonly kind: "generatedPk" }
  /** Adapter arithmetic over a known before-value (PK increment family).
   *  Live: computed/read back. Planned: batchRefs.store(valueSql).
   *  Planned-legal. */
  | { readonly kind: "computedPk"; readonly valueSql: Sql }
  /** Any other generated identity (compound generated PK, DB-default
   *  non-increment PK). Live-only; the legality gate (§6.3) rejects it for
   *  planned mode with the existing typed message. Lift path: §1.2 A8. */
  | { readonly kind: "opaqueGenerated"; readonly reason: string };
```

### 4.2 Effects, guards, probes (`effects.ts`)

```ts
import type { Sql } from "@sql";
import type { Model } from "@schema/model";
import type { NestedWriteError, NotFoundError } from "../../types";

/** The typed error a failed premise surfaces as — identical in both modes.
 *  A CLOSURE so bespoke messages (set-orphan field lists, FK-required,
 *  "deleted during upsert") reconstruct exactly (§1.2 A9).
 *  `raceable` feeds the write-race retry classification (§7.4); after the
 *  Pin Rule it is true ONLY for the filtered-M2M-deleteMany staleness pins. */
export interface GuardFailure {
  readonly error: () => NestedWriteError | NotFoundError;
  readonly raceable: boolean;
}

/** A premise that must hold at the point this guard sits in the effect
 *  order. `where` is adapter-built Sql from the shared builders. */
export interface Guard {
  readonly premise:
    | { readonly kind: "exists"; readonly model: Model<any>; readonly where: Sql }
    | { readonly kind: "notExists"; readonly model: Model<any>; readonly where: Sql };
  readonly failure: GuardFailure;
}

/** Zero-affected-rows contract for a correlated write (§5.3).
 *  `false` = set-based/lax (deleteMany, disconnect:true, set-connect). */
export type RequireAffected = false | GuardFailure;

export type Effect =
  | {
      readonly kind: "insert";
      readonly model: Model<any>;
      readonly data: Readonly<Record<string, Expr>>;
      /** Symbols this insert produces (generated PK). The mode captures them
       *  atomically with the insert — the storeLastInsertId ordering law
       *  (map-batch-refs §5.2) is enforced by construction, not discipline. */
      readonly produces: readonly WriteSymbol[];
      readonly skipDuplicates?: boolean;   // createMany / junction idempotency
    }
  | {
      readonly kind: "insertMany";
      readonly model: Model<any>;
      readonly rows: ReadonlyArray<Readonly<Record<string, Expr>>>;
      readonly skipDuplicates?: boolean;
    }
  | {
      readonly kind: "update";
      readonly model: Model<any>;
      readonly set: Readonly<Record<string, Expr | { readonly op: Sql }>>;
      readonly where: Sql;                 // already correlated by the interpreter
      readonly requireAffected: RequireAffected;
      /** computedPk symbols this update produces (PK arithmetic). */
      readonly produces: readonly WriteSymbol[];
    }
  | {
      readonly kind: "delete";
      readonly model: Model<any>;
      readonly where: Sql;
      readonly requireAffected: RequireAffected;
    }
  | { readonly kind: "guard"; readonly guard: Guard };

/** A read that decides a branch and/or supplies an identity. */
export interface Probe {
  readonly model: Model<any>;
  readonly where: Sql;
  readonly select: "record" | "exists";
  readonly forUpdate?: boolean;           // top-level upsert live probe
  /** If set: absence throws this typed error immediately, in both modes
   *  (unifies fetchRequired*). */
  readonly required?: GuardFailure;
  /** Pin specs per outcome, per the Pin Rule (§5.5). `whenMissing` is
   *  ABSENT for raceable create branches (constraint-enforced premise);
   *  `whenFound` is absent only for the enumerated pin-free probes (§6.2). */
  readonly pin?: {
    readonly whenFound?: Guard;
    readonly whenMissing?: Guard;
  };
}

export type ProbeResult =
  | { readonly found: true;  readonly record: Readonly<Record<string, unknown>>; readonly guard: Guard | undefined }
  | { readonly found: false; readonly guard: Guard | undefined };
// `guard` is the instantiated pin for the outcome that occurred (undefined
// when the Pin Rule assigns none). The interpreter destructures `guard` and
// emits it when present; an unused `guard` binding is a lint error
// (noUnusedLocals), keeping "probe without pin" visible in review.
```

### 4.3 Mode (`mode.ts`)

```ts
export interface Mode {
  readonly canObserveOwnWrites: boolean;   // Live: true; Planned: false

  /** Axis A: lower a symbol into SQL for a consuming statement.
   *  Live: the captured JS literal via buildScalarSqlValue.
   *  Planned: batchRefs.read(...) via buildScalarSqlValue (already handles
   *  it, including the mandatory TEXT-round-trip cast-back). */
  resolveSymbol(ctx: QueryContext, model: Model<any>, field: string, sym: WriteSymbol): Sql;

  /** True iff the symbol already has a concrete value (Live after capture).
   *  Used by the Probe Independence Rule (§6.2) and identity rebinding. */
  isResolved(sym: WriteSymbol): boolean;

  /** Axis B: run a deciding read.
   *  Live: now, on the tx driver (sees own writes; honors forUpdate); the
   *  returned guard realizes as a no-op (§5.1).
   *  Planned: now, on the base driver (committed state, plan time); the
   *  returned guard MUST be emitted and realizes as an assertion statement.
   *  Planned enforces the Probe Independence Rule (§6.2). */
  probe(ctx: QueryContext, p: Probe): Promise<ProbeResult>;

  /** The atomic scope: all-or-nothing + ordered + one connection. */
  readonly scope: AtomicScope;
}

export interface AtomicScope {
  run<T>(body: (emit: Emit, mode: Mode) => Promise<NestedWriteResult>): Promise<T>;
}

/** The effect sink. Live: executes the effect immediately (capturing
 *  `produces` via RETURNING/lastInsertId/refetch — executeSimpleInsert's
 *  contract, including the translateRowToFieldNames choke point — and
 *  enforcing requireAffected via rowCount). Planned: lowers and appends
 *  (insert → [insertSql, ...storeLastInsertId per produced symbol];
 *  requireAffected → a preceding exists-assert; guard → adapter.assertions;
 *  update-with-computedPk → [updateSql, ...store(valueSql)]). */
export type Emit = (effect: Effect) => Promise<void>;

/** What the interpreter body returns to the scope: the final identity and
 *  the Prisma-parity result contract (§8.2/§8.3). */
export interface NestedWriteResult {
  readonly finalWhere: IdentityExprs;      // post-update PK, possibly symbolic
  readonly refetch: boolean;               // true iff select/include present
  readonly selectInclude?: Record<string, unknown>;
  /** Live mode already holds the record when refetch=false. */
  readonly record?: Readonly<Record<string, unknown>>;
}
```

`selectMode` (§8.1) is the only place driver capabilities are consulted.
There is no `Backend` interface, no plugin registry, no third mode.

---

## 5. The premise system (guards, probes, requireAffected, the Pin Rule)

This section is normative. It exists because the historical bug class is
"the two engines enforced the same premise differently, or one forgot" —
and because the one proven FATAL (§0.3) was a premise pinned where it must
not be.

### 5.1 Where premises come from — three sources, one taxonomy

| Source | Carried as | Live realization | Planned realization |
|---|---|---|---|
| **Probe-backed** — a branch/identity read ran | `ProbeResult.guard`, emitted by the interpreter at the head of the chosen branch's effects | **no-op** (the probe ran inside the open tx; read and write are serialized/locked) | `adapter.assertions.exists/notExists` statement at that position |
| **Write-coupled** — "this correlated UPDATE/DELETE must hit ≥ 1 row" | `requireAffected: GuardFailure` on the effect | rowCount === 0 → `throw failure.error()` (today's `throwIfNoCorrelatedRowsAffected`) | a **preceding** exists-assert built from the same `where` (a batch cannot observe rowCount mid-list — map-oracle §C.2) |
| **Standalone** — a premise with no probe and no coupled write (m2m connect target-exists; set member-exists; set departing-rows-must-not-exist on required FK) | an explicit `guard` effect | SELECT-then-throw (today's `fetchRequired*` / `assertNoDepartingRows` shape) | assertion statement |

The interpreter chooses the *source*; the mode chooses the *realization*.
Neither mode ever chooses which premise applies — that is semantics.

### 5.2 Every guard carries its typed error

`GuardFailure.error()` produces exactly the error the tx engine throws today
(`recordNotFoundError({relationName, operation, kind})` with the pinned
`target` / `correlated` / `nested-write` messages — map-shared §C.1 —, the
set-orphan message with its field list, the FK-required message, the
"deleted during upsert" message). The kind is chosen by the interpreter from
FK direction + correlation, preserving the direction-dependent error-kind
invariant (parent-holds-FK connect ⇒ `target`; child-holds-FK connect ⇒
`correlated`; map-tx-create §5, invariant 6).

### 5.3 `requireAffected` truth table (the true-vs-explicit asymmetry, pinned)

| Operation | requireAffected |
|---|---|
| `disconnect: true`, `delete: true` | `false` (lax) |
| explicit `disconnect: {where}` / `delete: {where}` / correlated `update` | `GuardFailure(kind: correlated)` |
| child-holds-FK `connect` | `GuardFailure(kind: correlated)` |
| `deleteMany`, `updateMany` | `false` (set-based, never rows-required) |
| **`set` member connect** (non-skipped members) | `GuardFailure(kind: correlated)` — live keeps today's rowCount detection of a vanished member. Already-connected members are **skipped by the interpreter in both modes** (decided from the member probe's record) and replaced by a pinned `exists(unique ∧ fkMatch)` guard, so the MySQL no-change-0-rows false positive that motivated the tx-only skip cannot fire, and the skip decision is one code path, not a mode split (§1.2 A13; resolves DIVERGENCE-SET-MEMBER-SKIP / map-shared §D.5). |

### 5.4 Structural enforcement

- A deciding probe cannot lose its pin: `mode.probe` instantiates the guard
  from `Probe.pin` for the outcome that occurred and hands it back; the
  interpreter emits it. Pin-free outcomes are exactly those the Pin Rule
  (§5.5) and §6.2 enumerate.
- Symbol capture cannot be forgotten or reordered: `produces` rides on the
  effect, and the planned emit materializes `[insert, ...stores]` as one
  append — nothing can interleave another INSERT between an insert and its
  `storeLastInsertId` (the silent-corruption class of map-batch-refs §2 is
  eliminated by construction).
- The live guard no-op is **conditional**: `LiveMode` tracks which premises
  arrived via `ProbeResult` in the current scope; a guard effect whose
  premise was not probe-established realizes as SELECT-then-throw. This is
  what keeps live mode from silently dropping standalone premises (§1.2 S1).

### 5.5 The Pin Rule (normative; resolves F1)

> **Pin what live locks; let constraints enforce what live cannot lock.**
>
> 1. A premise about an **existing row** (upsert existing-branch
>    `uniqueExists`; `uniqueWithWhereExists/Missing` for targetWhere/
>    setWhere; correlated existence; connectOrCreate found-branch) **is
>    pinned** in planned mode. Live mode holds these rows under the open
>    transaction (top-level upsert even under `FOR UPDATE`), so a concurrent
>    modification cannot slip between decision and write there; the pin is
>    the planned substrate's moral equivalent of that lock — it aborts,
>    typed, instead of waiting. These failures are **non-raceable** (live's
>    own behavior for the one reachable case — deleted-during-upsert — is a
>    hard typed error, not a retry).
> 2. A premise of the form "**no row with unique key K exists**" guarding a
>    branch that INSERTs into the same model (connectOrCreate missing
>    branch, upsert create branch, nested-upsert absent branch, m2m
>    connectOrCreate missing branch) **is not pinned**. Live cannot lock an
>    absent row either — its compensation is the write-race retry. The DB
>    unique constraint over K enforces the premise at exactly the point of
>    consumption; its violation is a real `UniqueConstraintError`, already
>    typed, already accepted by `isWriteRaceLoserError`, and the retry then
>    converges — the precise coupling map-oracle D7 orders preserved.
>    Emitting the pin would double-enforce the constraint AND preempt the
>    retryable signal with a non-retryable abort (the FATAL, live in
>    production today at `batch-plan.ts:397-399`). It was also *stricter
>    than live semantics* in the edge where the create payload does not
>    carry K.
> 3. A premise that is a **materialized set**, not a re-checkable predicate
>    (filtered M2M deleteMany membership), is pinned by the
>    symmetric-difference guards (§9), whose failures are **raceable**
>    (retry re-plans membership and converges — §1.2 A6).

Consequences: the only `notExists` pins left in the system are the
targetWhere/setWhere `uniqueWithWhereMissing` skips, the set
departing-rows-orphan guard, and the deleteMany symmetric-difference
guards. Rule 2 is scoped to where-unique keys (always constraint-backed;
where-unique inputs require non-null unique values, so partial-index NULL
semantics cannot void the constraint).

---

## 6. Branch resolution and the staleness contract

### 6.1 The branch rule

> **Every branch is a function of a `ProbeResult`. The interpreter takes the
> branch in ordinary control flow — once, in one code body — and emits the
> probe's pin (when the Pin Rule assigns one) at the head of the chosen
> branch's effects.**

- Live mode: the probe ran at that exact point in execution order, inside
  the transaction (with `forUpdate` on the top-level upsert probe, exactly
  as today). Pins realize as no-ops. Read-after-write holds: a probe for
  step N observes step N−1's writes.
- Planned mode: the probe ran at plan time against committed state. The
  chosen branch's effects are appended with the pin at their head; if a
  pinned premise goes stale between plan and execution, the atomic batch
  aborts — fail-closed, never a silent wrong branch. If an *unpinned*
  (Rule 2) premise goes stale, the branch's own INSERT raises the
  constraint violation — fail-closed and retryable.

Branch *decision logic* is never mode code: `planExistingUpsertBranch`
(targetWhere/setWhere), the connectOrCreate found/missing choice, the
to-many-upsert three-way (correlated → update; uncorrelated-exists → typed
`correlated` error; absent → create), and the M2M-upsert three-way are all
interpreter code, written once. The M2M upsert stops being an inline
duplicate (map-shared §D.10 — "highest divergence risk") and becomes the
same function body as the relation upsert, specialized only by membership
predicate (junction membership vs FK match).

### 6.2 The Probe Independence Rule (generalizing three ad-hoc rules)

> **In planned mode, a probe reads committed state and therefore must not
> depend on this operation's own writes — neither through data flow (a
> `where` referencing an unresolved symbol) nor through order (a premise
> the operation itself will establish or invalidate).**

Where an input would violate this, the interpreter does one of three
things, in preference order:

1. **Normalize it away.** `dedupeConnectOrCreateInputs` (first-create-wins)
   stays, reclassified from "divergence-avoidance shim" to the semantic rule
   it always was: within one connectOrCreate array, the second probe of the
   same key would depend on the first's write; deduping removes the
   dependence identically in both modes. (D8 resolved by promotion. Without
   the dedupe the second INSERT would unique-violate and converge via retry
   — correct but wasteful; the dedupe also fixes which create payload wins.)
2. **Reject it, typed, uniformly.** (a) The M2M
   deleteMany-combined-with-create/connect/connectOrCreate/set ban
   (`assertManyToManyStepCombinationIsSupported`) stays: deleteMany's
   plan-time membership read would deterministically miss the same
   operation's own junction writes, and with the §9 gap guards the combined
   form would deterministically abort on planned mode while succeeding on
   live — worse than the uniform typed error. (b) A probe whose `where`
   references a symbol not `isResolved` in planned mode throws the existing
   typed "requires primary key … known before execution" error. This
   generalizes the existing `appendJunctionDeleteMany` ref-parent rejection
   to the whole system and closes a latent hazard: a plan-time probe whose
   `where` embedded a `batchRefs.read` subquery would silently read an empty
   scratch table and return "absent".
3. **Fail closed at execution.** Residual cross-step dependencies no static
   rule can see (e.g. `posts.create[k]` followed by
   `posts.connectOrCreate[k]` across two steps of one relation) surface as
   a constraint violation or pinned abort on planned mode where live mode
   succeeds; raceable signals converge via retry. A conformance scenario
   (M0) pins the asymmetry so it is a contract, not an accident.

The two enumerated pin-free probe *shapes* (beyond Pin Rule 2's
missing-branch outcomes):

- **M2M filtered deleteMany / delete:true membership read** — its
  conclusion is a materialized PK *set*, not a re-checkable premise; it is
  pinned instead by the §9 symmetric-difference guards (planned mode), so
  it is no longer unguarded in effect — the `pin` field is simply the wrong
  shape for it.
- **The update before-image read when nothing downstream needs it** — the
  planned engine already skips this read when no PK change and no nested
  relations (map-batch-planner D8); the interpreter makes that a
  mode-independent decision: emit the probe iff a downstream consumer
  exists, computed as a **static over-approximation** (§1.2 A10 — any
  branch arm counts; the consumed-column set is a schema fact). Its
  staleness pin is the parent `uniqueExists` guard emitted regardless.

### 6.3 The legality gate — `assertPlanExecutable(ctx, operation, args, mode)` (`legality.ts`)

Runs **before any effect, in both modes**, walking the whole tree (adopting
the batch engine's deeper validation uniformly — D5 closed: live mode now
also rejects before writing anything). It is the union of today's static
checks plus symbol-origin legality:

1. `separateData` parse validation (already shared; parse errors are
   engine-independent).
2. `assertNoPlannedNestedMutationExecution` (create / upsertCreate branches:
   only create/createMany/connect/connectOrCreate legal — I6).
3. `assertNestedUpdatePlanIsExecutable` + `assertUpdateManyDataHasNoRelations`.
4. `assertManyToManyStepCombinationIsSupported` (I8).
5. FK-nullability static checks (`assertFkCanBeSetNull` for disconnect /
   parent-holds-FK delete; `set`-on-FK-holder rejection).
6. **Symbol-origin legality** (planned mode only): every identity the plan
   must defer must have origin `generatedPk` (single column) or
   `computedPk`; `opaqueGenerated` → the existing typed messages ("cannot
   propagate generated compound primary keys", "requires primary key field
   '…' to be known before execution"). Also: PK update values must be
   literal/`{set}`/numeric-op (`assertSafePrimaryKeyUpdateValue` family).
7. **Probe independence** (planned mode only): rejects the statically
   detectable symbol-dependent probes (§6.2.2b).

This is the **single throw site** for the capability contract. Gates 1–5
are semantic invariants (both modes); gates 6–7 are mode-scoped by the
`mode` parameter — one function, one place, so the two modes can never
disagree about where the line is (§1.2 S2).

---

## 7. Error taxonomy and normalization

### 7.1 The taxonomy (unchanged surface, single source)

| Error | Raised for | Notes |
|---|---|---|
| `NestedWriteError` | correlation/existence/orphan/fk-required/unsupported-combination/capability-gap failures | messages pinned by the behavior suites; produced from `GuardFailure.error()` or the legality gate; gains an optional `raceable` meta flag (§7.4) |
| `NotFoundError` | top-level update/upsert target absent | unchanged |
| `QueryEngineError` | routing/atomicity impossibility ("supports neither callback transactions nor atomic batch"), internal invariant breaches | d1-http keeps its loud rejection |
| `UniqueConstraintError`, DEADLOCK, SERIALIZATION_FAILURE | real constraint races | passed through **unwrapped** so the retry wrapper classifies them (load-bearing per the Pin Rule) |

The `kind → message` mapping (`target` / `correlated` / `nested-write`,
plus the set-orphan and FK-required messages) lives only in
`record-access.ts::recordNotFoundError` and the guard constructors. No mode
file contains an error message.

### 7.2 Live mode

Throws `failure.error()` directly at the failing premise (probe-required
miss, rowCount, standalone guard read). Identical to today's tx surface.

### 7.3 Planned mode — the abort-attribution ladder (D1 closed)

`PlannedMode.scope.run` wraps `driver._executeBatch`, holding a side table
`statement position → GuardFailure` populated as guards and
requireAffected-asserts are appended (this is where the `raceable` bit
lives — in the query-engine layer, never parsed from driver error text;
§1.2 A1). On rejection:

1. **Pass-through:** `UniqueConstraintError` / DEADLOCK / SERIALIZATION →
   rethrow unchanged (already the right typed error; the race signal per
   the Pin Rule and map-oracle D7).
2. **Index attribution:** if the driver reports the failing statement
   index, map it through the side table and throw `failure.error()`.
3. **Post-hoc re-probe:** otherwise re-evaluate registered guard premises
   read-only (SELECT-1s, in order) against current state; the first failing
   premise's `failure.error()` is thrown. Error-path-only cost.
   *Scope limit:* only symbol-free premises are re-probeable (after abort +
   rollback the scratch table is gone, so a premise embedding a
   `batchRefs.read` cannot be re-evaluated); symbolic-premise guards are
   skipped and fall through.
4. **Typed fallback:** if no premise fails (state moved on between abort and
   re-probe, or only symbolic premises remain), throw the generic-but-typed
   `NestedWriteError("Nested write assertion failed…")`, non-raceable.

This is strictly better than today (typed at worst, message-identical in
the common cases) and its ceiling is stated: on drivers that report neither
an index nor stable errors, step 4 is the floor. The behavior suites'
`supportsTransactions` message branches (nested-write-behavior 518-528,
721-731) are deleted at milestone M7 — a **deliberate, reviewed oracle
change** that increases parity (map-oracle D1 calls the split "purely an
artifact of the two substrates"), isolated to one milestone so it is
consciously landed.

### 7.4 Write-race retry — one wrapper, both modes

`executeWithNestedWrites` keeps its shape (catch → classify → re-run once).
Because it sits **above** `selectMode`, planned-mode drivers gain the
converge-on-rerun behavior they lack today (map-batch-planner D2 closed —
**a bug fix plus a new concurrent suite, not behavior preservation**;
§1.2 A12).

Classification, precisely:

- `isWriteRaceLoserError` accepts, in addition to today's set
  (`UniqueConstraintError` | DEADLOCK | SERIALIZATION_FAILURE), a
  `NestedWriteError` whose `raceable` flag is set — which the attribution
  ladder sets only from a `GuardFailure{raceable:true}`, i.e. only the
  filtered-M2M-deleteMany staleness pins. `NestedWriteAssertionError` (the
  step-4 fallback) is **never** raceable.
- Applicability: `hasRaceableCreateBranch` (upsert always; create/update iff
  the tree contains connectOrCreate/upsert) **or** the caught error itself
  carries `raceable` (self-authorizing: the flag was set by the interpreter,
  which had full context). This extends retry coverage to filtered M2M
  deleteMany without teaching the args-walk schema knowledge.

Why this cannot loop on non-races: after the Pin Rule, correlation/orphan/
existing-row failures are non-raceable typed errors; the create-branch race
signal is the constraint violation, retryable on every dialect and
isolation level identically (§1.2 A2). A rerun re-probes from clean
committed state (full rollback preceded it — idempotent-on-retry,
map-tx-update invariant 10).

### 7.5 What is *not* an error

targetWhere/setWhere no-match on upsert is a silent no-op returning the
existing record (pinned by `uniqueWithWhereMissing` in planned mode) —
map-oracle §C.3 semantics, unchanged.

---

## 8. Mode contracts and the dispatch/caller seams

### 8.1 `selectMode` — the only capability fork

```ts
function selectMode(driver: AnyDriver, shared?: BatchPreparationContext): Mode {
  if (driver.supportsTransactions) return new LiveMode(driver);
  if (driver.supportsBatch) return new PlannedMode(driver, shared);
  throw new QueryEngineError(/* existing "cannot execute atomically" message, meta.strategy:"unsupported" */);
}
```

Capability precedence preserved exactly: a driver supporting both takes
`LiveMode` (map-oracle §A). d1-http falls to the throw (capability honesty,
map-batch-refs §6.2). This subsumes `runNestedWriteOperation`'s fork and
`atomic-runner`'s defensive mis-routing throw — there is no second path to
mis-route into. Grep gate (M10): no `supportsTransactions|supportsBatch`
reads anywhere in `nested-writes/` outside `selectMode` and the two mode
files.

### 8.2 LiveMode

- `scope.run(body)` = `driver.withTransaction(tx => body(liveEmit(tx), this))`.
  **One flat scope per top-level operation.** Recursion threads the same
  `emit`/scope — no nested `withTransaction`, ever. This replaces the tx
  engine's per-recursion-level `runNestedMutationAtomically` and its
  "nested withTransaction is a savepoint" mechanism. Observable-equivalence
  proof: no nested-write path catches a child failure and continues
  (verified — §1.2 A5), so savepoint partial rollback is unobservable here;
  the driver's `SavepointQueue` remains for user-level nested transactions.
  M4 gates this with a spy asserting exactly one `withTransaction` per
  operation.
- `emit`: executes each effect immediately on the tx driver. `insert` with
  `produces` reads RETURNING (or lastInsertId/refetch on non-returning
  adapters — exactly `executeSimpleInsert`'s contract today, including the
  `translateRowToFieldNames` choke point) and binds the symbols to concrete
  values. `requireAffected` → rowCount check. `guard` → per §5.1/§5.4.
- `probe`: executes now on the tx driver (own writes visible; `forUpdate`
  where the interpreter asks).
- Result: `refetch:false` → return the record it already holds (scalars
  only, Prisma parity); `refetch:true` → `buildFindUnique(finalWhere,
  select/include)`.

### 8.3 PlannedMode

- Wraps a `PlanState` (today's shape: `statements`, `setupStatements`,
  `cleanupStatements`, `BatchReferenceStore`, `batchId`), **shared across
  operations of one `$transaction([...])`** via
  `BatchPreparationContext.nestedWriteState` exactly as today
  (`getSharedPlanState`), so value-ref namespaces and setup/cleanup stay
  monotonic and shared (map-oracle §B.2/§B.3 preserved).
- `emit`: lowers via the adapter and appends. Symbol lowering is
  `buildScalarSqlValue` — unchanged, including the mandatory TEXT
  round-trip cast-back (`castBatchRefValue` / `getScalarCastType`). Lazy
  setup preserved: the scratch table materializes only on first symbol
  allocation (invariant 10; a fully-literal plan emits zero scaffolding).
- `probe`: executes now (plan time) on the base driver; enforces the Probe
  Independence Rule.
- `scope.run`: body builds the list; the single-op path executes
  `driver._executeBatch(collectPlanStatements(state))` and parses by the
  setup offset (I10 result-window math unchanged); the `prepareBatch` path
  returns the `PreparedBatchOperation { queries, setupQueries,
  cleanupQueries, parseResult }` shape unchanged. `prepareBatch → undefined`
  stays the "cannot batch atomically" signal.
- Abort mapping: §7.3.

### 8.4 Honest accounting of what still pairs up

Each mode implements: `resolveSymbol`, `isResolved`, `probe`, the emit
realizations for five effect kinds (+ produces-capture, + requireAffected),
guard realization, scope, result assembly. That is the entire pairing
surface (~200–300 lines each), and it is **substrate mechanics**: no mode
file may import `semantic-plan.ts`, `fk.ts`, or `relation-data-builder.ts`,
or contain a relation/step/branch decision. Grep gate at M10. If a change
touches both mode files *and* encodes a rule about relations, the design
has been violated — that rule belongs in the interpreter.

### 8.5 Adapter surface

**Zero new adapter primitives.** `batchRefs` (6 methods), `assertions` (2),
`expressions.*`, `literals.*`, `mutations.*`, `lastInsertId` are exactly
the lowering surface (I9, Golden Rule). All dialect SQL stays behind
`ctx.adapter.*`; the interpreter builds structure, the adapter builds
syntax.

### 8.6 Upward seams (unchanged shapes — map-oracle §B, invariant 10)

`metadata.execute` → `executeWithNestedWrites` → retry wrapper →
`assertPlanExecutable` → `selectMode` → interpreter. `metadata.prepareBatch`
→ same pipeline with a shared `PlannedMode`. `hasNestedWrites` / `prepare` /
`prepareBatch` gating in `createPreparedOperation`: untouched. The upsert
`targetWhere`/`setWhere` fallback and non-returning-upsert refetch entries
continue to route here (map-oracle §B.4).

---

## 9. Per-mutation-kind interpretation (normative table)

Notation: `dir = getFkDirection(ctx, rel)` (sole direction oracle, verbatim,
including m2m-throws-before-inverse-scan and
`pkFields = inverse.references ?? PK`). Step order =
`planRelationMutationSteps` (fixed — I5). FK split =
`splitRelationMutationsByFk` (currentHoldsFk before the parent insert;
relatedHoldsFk + m2m after — I4). `P`=parent, `C`=child, `J`=junction,
`sym(x)` = a `WriteSymbol`. Premises per §5; pins per the Pin Rule §5.5;
probes per §6.

| Kind / direction | Interpreter emission (order) | Premises | Notes / invariants pinned |
|---|---|---|---|
| **create**, parent holds FK (before-parent) | resolve child per step (create → `insert(C) produces sym(cpk)`; connect → standalone guard(target `exists`) + FK from `buildConnectFkValues` (lit or `sql` subquery); connectOrCreate → probe+branch); bind child PK `Expr`s into parent FK fields of `scalarData` | connect: guard `exists`, `kind:target` | child-before-parent; PK → parent FK (C.0) |
| **create**, child holds FK / to-many (after-parent) | `insert(P) produces sym(ppk)`; per child `insert(C)` with FK = `sym(ppk)` | — | parent-before-child |
| **createMany** | one `insertMany` with FK stamped per row; `skipDuplicates` honored | — | related-holds-FK only (FK-holder ⇒ typed error); rejected on m2m (typed, both modes) |
| **connect**, parent holds FK (after timing) | probe(required, `kind:target`, select:record) for target identity → `update(P){fk} requireAffected: correlated` by parent-PK match | probe.required target; requireAffected correlated | direction-dependent error kind preserved |
| **connect**, child holds FK | `update(C){fk = parentPk} where unique, requireAffected: correlated` | requireAffected correlated | no pre-read (today's rowCount contract, now data) |
| **connect**, m2m | standalone guard(target `exists`, `kind:target`) + `insert(J){source: parentExpr, target: buildTargetPkSubquery}` `skipDuplicates` | guard target | idempotent; unrelated FKs untouched |
| **connectOrCreate** (all shapes) | deduped inputs (first-create-wins, §6.2.1); probe(pin: found→`exists` (kind by direction); missing→**no pin**, Pin Rule 2); found → connect branch; missing → create branch (recursively interpreted) | found pinned; missing constraint-enforced | staleness of "missing" surfaces as `UniqueConstraintError` → retry converges (F1 fix); create payload ignored when found (Prisma parity); recursive nested writes legal in the create branch |
| **disconnect**, parent holds FK | (legality: FK nullable) `update(P){fk: lit(null)} requireAffected: correlated`; **rebind** the parent identity's FK `Expr`s to `lit(null)` for downstream steps | requireAffected correlated | kills DIVERGENCE-PARENTDATA-MUTATION: no JS record mutation; downstream correlation reads the rebound `Expr` in both modes |
| **disconnect**, child holds FK | `update(C){fk: null}`; `true` → where fkMatch, lax; explicit → correlated where, `requireAffected: correlated` | per §5.3 | true-lax / explicit-strict asymmetry |
| **disconnect**, m2m | `delete(J)` by source (+ target-in per item); boolean `disconnect:true` on m2m → typed reject (unchanged) | — | child survives |
| **delete** | parent-holds-FK: null parent FK first (as disconnect) then `delete(C)`; else `delete(C)`; `true` lax / explicit `requireAffected: correlated` | per §5.3 | FK-null-before-child-delete ordering |
| **delete / deleteMany**, m2m | membership probe (pin-free shape, §6.2) → `delete(J)` junction-first (incl. self-ref source side via `buildJunctionDeleteCondition`) → `delete(C)` by PK-in / by own where-unique (MySQL self-subquery rule preserved) | per-item connected-guard (`exists`, correlated) for `delete: unique` | junction-first FK safety |
| **deleteMany**, m2m **filtered** (planned mode) | legality: parent PK literal (else typed error); membership+filter probe materializes `pks`; **two staleness guards, `raceable:true`**: `notExists(target: filter ∧ membership ∧ pk NOT IN pks)` and `notExists(target: pk IN pks ∧ NOT(filter ∧ membership))`; then junction+child deletes | the symmetric-difference pin (§1.2 A6) | the last silent gap **closed** fail-closed; retry converges under churn; residual window = the tx engine's own SELECT-then-DELETE window class; live mode evaluates the filter live as today |
| **set** (FK relations) | (legality: not on FK-holder; parent PK present) per member: probe(required, `kind:target`, select:record); departing = `buildDepartingRowsCondition` (COALESCE 3VL fix, shared); required FK → guard(`notExists` departing, orphan message with field list) / nullable → `update{fk:null} where departing` (lax); per member: already-connected (from probe record) → pinned guard(`exists`, unique ∧ fkMatch, correlated); else `update(C){fk=parentPk} where unique, requireAffected: correlated` | member probes; orphan guard; connected-pins | **one order** for both modes: probe-members → handle-departing → connect (all-or-nothing proof: §1.2 A11); no-op set succeeds; orphan reject only when rows depart; skip unified per §5.3/§1.2 A13 |
| **set**, m2m | `delete(J)` all source rows → per member guard(`exists`) + `insert(J)` via subquery | member guards | wholesale replace |
| **update** (to-one / to-many) | locate: to-one `buildFkMatchCondition`, to-many `unique ∧ correlation`; before-image probe **iff** a downstream consumer exists (static over-approximation, §6.2); scalar `update` (`requireAffected: correlated`); post-update identity = literals overlaid with updated-PK `Expr` (lit or `sym(computedPk)`), **and every updated column a downstream correlation could read is rebound** | probe.required correlated; requireAffected correlated | scalars-before-relations; after-image (inv 4); **D4 closed** — the overlay rule is decided once, not per-substrate; non-literal PK update → typed error (legality) |
| **updateMany** | (legality: scalar-only data) `update(C){set} where parentFk ∧ filter, requireAffected: false` | — | set-based; to-one rejected |
| **upsert**, top-level | probe(where, select:record, forUpdate in live; pin: found→`exists` (staleness = "deleted during upsert", non-raceable); missing→**no pin**, Pin Rule 2); found → targetWhere/setWhere probes (pinned `uniqueWithWhere*`) → `planExistingUpsertBranch` → skip (guard only, return pkWhere) or update branch (scalar update + nested relations); missing → create branch (legality: upsertCreate) | per branch | targetWhere/setWhere no-op skip; `finalWhere` from updated PK; the concurrent-delete case throws the **same typed error in both modes** (DIVERGENCE-UPSERT-EXISTING-WHERE closed); the concurrent-create case converges via retry in both modes (F1 fix) |
| **upsert**, to-one relation | probe(fkMatch slot occupied?); found → update branch; missing → create with FK-direction timing (parent-holds-FK: create child then `update(P){fk}`) | found pinned; missing per Pin Rule 2 | |
| **upsert**, to-many relation | probe(unique ∧ correlated); found → update; missing → probe(unique, uncorrelated); exists-uncorrelated → throw `correlated` (typed, immediate, both modes); absent → create (**no pin**, Pin Rule 2) | found pinned | Prisma rule: cannot upsert-create over a foreign parent's unique key; staleness of "absent" → constraint violation → retry → re-plan throws the typed `correlated` reject, converging with live |
| **upsert**, m2m | same three-way as to-many, membership = `buildConnectedUniqueWhere` (junction membership); create branch = child insert + junction insert | found pinned | single decision body; map-shared §D.10 duplication eliminated |
| **m2m create** | `insert(C) produces sym(cpk)` → `insert(J){source: parentExpr, target: sym(cpk)}` `skipDuplicates` | — | child-then-junction; single-column PKs both sides (join-info invariant) |
| **unsupported m2m step** | typed error (`createMany` on m2m etc.) | — | identical rejection, both modes (map-shared §D.11) |

Result assembly for all kinds: `NestedWriteResult` per §4.3/§8.2/§8.3 —
scalars-only without select/include, refetch by final (possibly symbolic)
PK otherwise; mapped columns translated to field names at the read boundary
(`translateRowToFieldNames` choke point, kept).

---

## 10. Divergence disposition (complete)

| Divergence (maps) | Disposition |
|---|---|
| D1 error type/message (incl. set-orphan, correlation reject) | **Closed** — `GuardFailure` closures + attribution ladder (§7.3); behavior-suite `supportsTransactions` branches deleted at M7 |
| D2 branch timing | **Absorbed** — one decision body; mode owns probe timing; Pin Rule pins (§6.1) |
| D3 value substrate / capability gap | **Absorbed / typed** — `Expr`+`WriteSymbol`; origin legality at one gate (§6.3); gap stays a typed error (§1.2 S2) |
| D4 updated-parent overlay (non-PK correlation column) | **Closed** — rebind every potentially-downstream-read column, static over-approximation, decided once (§6.2, §9); M0 adds the missing scenario |
| D5 (oracle map: tx-only fast paths) | **Dropped pending benchmark** — §13 Q1; observable state identical either way |
| D5 (batch map: validation depth) | **Closed** — uniform whole-tree legality gate, both modes (§6.3) |
| D6 statement-count / setup-cleanup structure | **Inherent to planned mode** — preserved (setup offset, lazy setup, shared PlanState) |
| D6 (batch map: set skip-already-connected) | **Unified** — the skip is a mode-independent interpreter decision from the member probe, pinned in planned mode; rowCount contract kept on non-skipped members (§5.3, §1.2 A13) |
| D7 concurrency lock-vs-assertion; batch retry gap | **Unified, and the shipped batch bug fixed** — Pin Rule 2 makes the constraint violation the signal; retry above the interpreter covers both modes (§7.4); M8 concurrent gate |
| D8 connectOrCreate dedupe | **Promoted to rule** (first-create-wins) under the Probe Independence Rule (§6.2.1) |
| D8 (batch map: correlated-update read avoidance) | **Promoted** to a mode-independent "probe iff downstream consumer" decision (§6.2) |
| D9 dispatch entries / atomic-runner defensive throw | **Subsumed** by `selectMode`; the throw's message survives as `selectMode`'s rejection |
| DIVERGENCE-RECURSION-ATOMICITY | **Removed** — one flat scope (§8.2), with the no-catch-and-continue proof (§1.2 A5), spy-gated at M4 |
| DIVERGENCE-PARENTDATA-MUTATION | **Removed** — identity is `IdentityExprs`; FK-null is an `Expr` rebind (§9) |
| DIVERGENCE-UPSERT-EXISTING-WHERE (concurrent-delete error split) | **Closed** — one `GuardFailure` for the staleness case (§9 upsert row) |
| connectOrCreate found+after refetch discrepancy (map-tx-create §12.7) | **Unified** — the found branch returns the probe record; a post-link refetch happens only if a downstream consumer reads non-PK columns (same rule as D4); the sole historical consumer (`related` map) is deleted (§13 Q2) |
| M2M filtered-deleteMany silent staleness gap | **Closed fail-closed + raceable** — symmetric-difference guards; retry converges; residual window = tx's own window class (§1.2 A6) |
| M2M deleteMany-combination ban | **Kept** — uniform typed error; rationale updated (§6.2.2a) |
| compound-generated-PK gap | **Kept** as mode-scoped typed error at the single gate (§1.2 S2); DB-default-uuid lift path recorded (§1.2 A8) |
| `txCtx.createdRecords` / `generatedIds` | **Deleted, not ported** — dead on the create path; symbols and `IdentityExprs` replace the update path's use; the `related` map is dropped (§13 Q2) |
| TEXT round-trip + cast-back | **Preserved** (`buildScalarSqlValue` unchanged) |
| Capability honesty (d1-http), lazy setup, result window, shared PlanState | **Preserved verbatim** |

---

## 11. Migration plan (strangler; oracle green at every merge)

### The routing seam (dissolves the coexistence attacks — §1.2 A3)

`routing.ts` (temporary; deleted at M10) exposes one predicate:

```ts
/** Static, pure, no I/O (semantic-plan parsing only). True iff EVERY nested
 *  step kind AND relation class (fk | m2m) reachable in this operation's
 *  tree is in MIGRATED. Whole trees only — a mixed tree runs entirely on
 *  the old engines. */
function isTreeEligible(ctx: QueryContext, operation: Operation, args: Record<string, unknown>): boolean;
```

Consequences, stated honestly:

- **Coverage is by tree class, not by kind-file.** Create trees (whose legal
  closure is only create/createMany/connect/connectOrCreate — I6) without
  m2m relations route to the interpreter from M3. Update-family trees route
  from M5, upsert trees from M6, anything touching m2m from M9.
- **No old file is deleted until unreachable.** The old engines are one
  mutually-recursive organism (verified — §0.3); they are deleted in bulk at
  M9, then scaffolding at M10. Milestones M3–M8 deliver eligibility
  coverage and gates, not deletions.
- **Coexistence rules for the window (M3–M9):** the old engines are
  **frozen** — no feature lands in them. A bug found in a migrated tree
  class is fixed in the interpreter only. A bug found in an unmigrated tree
  class is fixed in the old engines only if it is release-blocking;
  otherwise its test is written, marked, and fixed by that class's
  milestone. This caps the triple-maintenance cost the coexistence window
  otherwise invites.
- Rollback for any milestone = remove its entries from `MIGRATED`.
  No milestone merges red.

**M0 — Oracle hardening (no engine change).**
Widen `nested-write-conformance.test.ts` from its current four scenarios to
head-to-head coverage of **every kind**: create (both directions, mixed),
createMany (+duplicate-PK atomicity), connect (both directions + missing →
state-unchanged), connectOrCreate (existing/missing/dedupe),
disconnect (true/explicit/non-nullable-reject state), delete + deleteMany
(correlation), update with PK change (literal and `increment` computed),
updateMany, set (no-op / orphan-reject / partial / nullable-departure),
upsert top-level (create / update / targetWhere-skip / setWhere-skip),
nested upsert to-one and to-many (incl. uncorrelated-exists → state
unchanged), and the full M2M family (connect+idempotency,
create-through-junction, connectOrCreate+dedupe, set, disconnect, delete,
deleteMany filtered + `true`, upsert connected/uncorrelated/create,
self-referential delete, deleteMany-combination rejection). Add the D4
scenario (non-PK correlation column changed mid-update) and the §6.2.3
cross-step scenario.
*Gate:* every new scenario passes on both **existing** engines unchanged.
Any failure = a shipped divergence, fixed first as its own scoped change
(this is de-risking working as intended, not a plan failure).

**M1 — Scaffolding.**
Land `expr.ts`, `effects.ts`, `mode.ts`, `live-mode.ts`, `planned-mode.ts`,
`legality.ts`, `routing.ts` (empty `MIGRATED`), and the interpreter entry
delegating 100% to the old engines.
*Gate:* full suite green; a capability-matrix unit test proves `selectMode`
routes every driver class identically to `runNestedWriteOperation` today,
including the d1-http rejection message.

**M2 — Uniform legality gate.**
Route all static validation (both modes) through `assertPlanExecutable`
before either old engine runs (fold `update-plan.ts` /
`planned-mutation.ts` logic in; files themselves die at M9/M10).
*Gate:* "unsupported nested create keys reject before parent mutation"
(0 rows) green in both modes; new test: an input live mode used to
begin-then-fail is now rejected up front (D5 closed); compound-generated-PK
message identical from the one gate.

**M3 — Create family (create, createMany, connect, connectOrCreate), FK-only trees, both modes.**
`Expr`/symbol substrate live; probe/pin pairing via `ProbeResult`;
produces-capture atomicity; Pin Rule 2 in force.
*Gate:* all create/connect/connectOrCreate conformance + behavior scenarios
green **through the interpreter** in both modes (assert routing with a
spy); atomicity oracle (duplicate-PK createMany → 0 users, 0 posts);
mapped-FK propagation; first-create-wins; error-kind-by-direction; a plan
snapshot test asserts the planned statement list contains **no**
`notExists` assertion before a create-branch INSERT (F1 regression guard).
*Deletions:* none (create.ts still feeds the old update/upsert/m2m — §0.3).

**M4 — One flat atomic scope (interpreter path).**
Recursion threads the same emit/scope.
*Gate:* multi-level nested rollback scenario green in both modes; a driver
spy asserts exactly one `withTransaction` per interpreter operation.

**M5 — Update family (update, updateMany, disconnect, delete, deleteMany, set), FK-only trees.**
Includes the D4 rebind rule, the unified set-member skip + connected-pin
(§1.2 A13), computed-PK symbols, departing-rows/orphan guards.
*Gate:* all correlation/parent-ownership behavior tests; set
no-op/orphan-only-when-departing/partial; M0's D4 and PK-change scenarios
identical end state in both modes.

**M6 — Upsert family (top-level, to-one, to-many) + targetWhere/setWhere, FK-only trees.**
`planExistingUpsertBranch` reused verbatim; `forUpdate` on the live
top-level probe; Pin Rule 1 pins on existing-row premises.
*Gate:* advanced-behavior upsert guard tests; M0 upsert conformance
scenarios; skip branches leave state untouched in both modes.

**M7 — One error surface.**
Attribution ladder wired; planned-mode aborts map to the same messages.
*Gate:* **the deliberate oracle change** — delete the
`driver.supportsTransactions` message branches in
`nested-write-behavior.ts` (518-528, 721-731 and siblings); both modes
assert the single typed message for correlation/orphan/target-missing
failures. (The branching tests exercise FK trees, eligible since M5/M6.)

**M8 — Race retry unification + the concurrent suite.**
`raceable` classification wired (§7.4); retry covers planned mode. New
concurrent suite (two real connections; lives with the Docker-gated
PG 5434 / MySQL 3307 driver tests — PGlite is single-connection):
concurrent upsert / connectOrCreate of a missing key converges to one
committed row in both modes.
*Gate:* the concurrent suite green on a tx driver and on a batch-forced
driver; the loser's surfaced pre-retry error is a `UniqueConstraintError`
(not an assertion abort) on the planned path; an unattributable abort
surfaces hard (driver stub reporting no index); a non-raceable guard
failure is proven un-retried (spy on attempt count).

**M9 — M2M through the interpreter; bulk deletion of the old engines.**
One upsert/membership decision body; junction effects; filtered-deleteMany
symmetric-difference guards (planned, raceable); combination ban kept.
*Deletions (now unreachable):* `create.ts`, `connect.ts`,
`connect-or-create.ts`, `update.ts`, `update-many.ts`, `upsert.ts`,
`disconnect.ts`, `delete.ts`, `delete-many.ts`, `set.ts`,
`relation-mutation.ts`, `many-to-many.ts`, `batch-plan.ts`,
`batch-relations.ts`, `batch-relation-links.ts`, `batch-many-to-many.ts`,
`batch-updated-primary-keys.ts`, `update-plan.ts`, `atomic-runner.ts`.
Keep `many-to-many-utils.ts`, `semantic-plan.ts`, `fk.ts` (condition
builders), `record-access.ts`, `assertions.ts` (adapter-lowering wrappers).
*Gate:* M0's M2M scenarios green head-to-head; per-driver
`many-to-many-behavior.ts` green on every driver class; a Docker scenario
proves the staleness guards abort (and the retry converges) on a
concurrently-added member instead of silently missing it; grep proves no
references to deleted modules remain.

**M10 — Teardown.**
*Deletions:* `routing.ts` + `MIGRATED`, `batch-references.ts` (store folds
into `planned-mode.ts`), `planned-mutation.ts` (folded into `legality.ts`),
`txCtx` types, the `canUseSubqueryOnly` fast path (pending §13 Q1), dead
exports.
*Gate:* full suite green; **grep gates** — (1) no
`supportsTransactions|supportsBatch` in `nested-writes/` outside
`selectMode`/mode files; (2) mode files import neither `semantic-plan.ts`
nor `fk.ts` nor `relation-data-builder.ts`; (3) no second implementation of
any mutation kind (grep for the deleted symbol names); (4) net LOC of the
directory down from the **M9 peak** (7,455) and free of the two-engine
substrate duplication.

**Gate (4) — LOC, honestly recorded (the "we say so" clause discharged).**
The original target for (4) was "net LOC of the directory materially down
(6,598 → target ≤ ~3,200 including kept shared builders); if the LOC does
not drop materially, the abstraction failed and we say so." **It was not
met, and here we say so.** Measured at M10, before the interpreter-simplification
follow-up (`nested-writes/` = **6,729 LOC**): a single `interpreter.ts` of
3,666 + `planned-mode.ts` 844 + `live-mode.ts` 505 + `legality.ts` 462 +
`semantic-plan.ts` 360 + `fk.ts` 247 + `effects.ts` 150 + `mode.ts` 148 +
`effect-lowering.ts` 147 + `record-access.ts` 106 + `assertions.ts` 57 +
`expr.ts` 37. That was **−726 vs the M9 peak (7,455)** but **+131 vs the
6,598 two-engine anchor**, and **2.1× over the ≤~3,200 target**. The §14
phrasing "6,598 lines → … materially smaller" is therefore **false as a raw
line count** and is corrected below.

Root cause, verified in code (not improvised around): the miss is entirely
the **~3,666-line interpreter body** — 83 functions, one per semantic case,
with the M2M-upsert consolidated onto the relation-upsert shape (§6.1
honored: no inline duplicate) and the small FK-expr helper families kept
distinct only because each carries a mandated byte-identical error message
(§5.2). This is genuine, irreducible per-kind semantic code, and it *alone*
exceeds the ≤~3,200 whole-directory target. The ≤~3,200 number was therefore
set without accounting for the consolidated semantic surface: the two old
engines each held roughly *half* the per-kind logic (live half in the
`*.ts` engines, deferred half in the `batch-*.ts` engines), so no single
copy of the semantics ever appeared in one place to be counted. Unifying
them collapses the *duplication* (two half-implementations → one) but
necessarily materializes the *whole* semantic surface once, and that whole
surface is larger than either half was. The ≤~3,200 estimate confused
"delete one of two copies" (which would land near 3,200) with "keep one
copy of the union of both copies' cases" (which is what correctness
requires and what the interpreter is).

**The navigability follow-up, now landed (2026-07-07).** The 3,666-line
`interpreter.ts` was split along mutation-family seams as pure moves plus one
bounded consolidation pass — it remains **ONE** interpreter (the seams are
file boundaries, not semantic ones; the families recurse into each other and
none consults a mode implementation, grep-gated). Post-split roster
(`nested-writes/` = **6,842 LOC**): `interpret-update-family.ts` 1,360 +
`interpret-m2m.ts` 941 + `planned-mode.ts` 844 + `interpret-create-family.ts`
628 + `live-mode.ts` 505 + `interpret-upsert-family.ts` 474 + `legality.ts`
462 + `semantic-plan.ts` 360 + `fk.ts` 247 + `interpret-shared.ts` 242 +
`effects.ts` 150 + `mode.ts` 148 + `effect-lowering.ts` 147 + `interpreter.ts`
(entry: dispatch + the `Interp` bundle) 134 + `record-access.ts` 106 +
`assertions.ts` 57 + `expr.ts` 37. The largest single file is now **1,360**
(down from 3,666); the entry is **134**. The split *added* **+113** (per-file
import headers and banners across six modules, net of the consolidation pass,
which removed the FK/m2m connected-child-update duplicate, three inlined
FK-expr helper copies, and four identical connectOrCreate-found pins — every
error message preserved byte-identically per §5.2). So the directory is
**6,842**: **−613 vs the M9 peak (7,455)**, **+244 vs the 6,598 anchor**. The
raw line count still did not fall below the anchor, and for the same root
cause above; the split buys navigability, not fewer lines.

**Revised target for gate (4):** the directory must be **below the M9
coexistence peak (7,455)** and must contain **exactly one implementation of
each mutation kind** (gate (3), machine-enforced) with **no `batch-*`/`tx`
substrate split** (gate (1)/(2), machine-enforced). Both hold: 6,842 < 7,455,
and the structural gates are green (now including gate 5: no
`interpret-*.ts` family module imports a mode implementation). The ≤~3,200
figure is **withdrawn** as an estimate made against the wrong baseline; it is
not reinstated at a new number because the load-bearing property was never
line count — it was "no second semantic surface" (§14's final bullet), which
is what gates (1)–(3) actually enforce.

**Did the abstraction fail?** By the design's own decisive test — "a feature
request touching nested-write semantics can be implemented without editing
either mode file" (§14) — no: the semantics live in one body (now one body
across family files, not one file), the modes hold only substrate mechanics,
and the historical double-bug class (a kind implemented twice and drifting)
is structurally impossible. What failed is the *prediction* that
consolidation would also shrink the raw line count below the two-engine
anchor; it did not, because the anchor counted two half-surfaces, not one
whole one. That prediction is corrected here rather than passed silently —
which is exactly what the "we say so" clause demands.
**Maintainer sign-off: ACCEPTED** (2026-07-06, "as long as unification
happened and duplication is gone" — the load-bearing property is the
structural one, enforced by gates (1)–(3)). A raw line-count target is not
reinstated. The navigability follow-up (splitting `interpreter.ts` along
mutation-family seams as pure moves) is **done** (2026-07-07) and did not
re-split the semantics or reintroduce the drift surface this whole design
exists to remove — the mode-import ban is now machine-enforced across every
family module (gate 5).

---

## 12. Rejected alternatives (do not relitigate without new facts)

1. **Two semantics-free backends over a total Plan IR** (total-ir,
   strangler). Rejected as architecture: every effect kind still needs a
   maintained pair; branch specialization makes the two plans
   non-node-identical anyway (total-ir concedes); the emit-sink single
   interpreter delivers the same guard/error/ordering guarantees with no
   second semantic surface. Its guard-as-data, symbol model, and milestone
   discipline were absorbed.
2. **Straight-line IR with no runtime branch; inline backend compiles inside
   its own transaction** (type-driven). Rejected: to preserve tx
   read-after-write ordering it must interleave compile and execute per
   step, at which point it is this interpreter with extra bookkeeping; done
   naively it would regress live semantics (probes stop seeing sibling
   writes).
3. **Type-parameter capability branding (`Plan<BatchLowerable>`)**
   (type-driven). Rejected: its narrowing gate requires a type assertion,
   banned by AGENTS.md Rule 2; runtime origin-legality at one throw site
   provides the identical guarantee for actual inputs.
4. **High-level macro effects (`ReplaceSet`, `UpsertInto`) interpreted by
   backends** (strangler). Rejected: moves set/upsert semantics into
   per-backend realizations — the drift surface itself.
5. **Uniform rejection of compound-generated PKs in both modes**
   (one-interpreter). Rejected: deletes a working live capability to serve
   a symmetry the value system does not demand; the sanctioned outcome for
   a capability gap is a clear typed error, centralized (§1.2 S2).
6. **Compiler resolves every branch / a `Branch` node carrying both compiled
   arms** (orchestrator frame, total-ir §4.6). Rejected: branch resolution
   without I/O is impossible and the I/O timing *is* the substrate
   difference; carrying both arms costs compile work and reintroduces a
   conditional the planned substrate cannot execute.
7. **Reifying WHERE/predicates into IR nodes.** Rejected unanimously by all
   four designs: the correlation builders are already shared and
   substrate-agnostic; a predicate IR is a second query language with no
   consumer (modes never inspect conditions).
8. **A general `Expr` language (arithmetic/boolean/null/column nodes).**
   Rejected: PK arithmetic is the only computed case, confined to
   `SymbolOrigin.computedPk`; `lit(null)` already lowers correctly; no
   caller produces a column-ref (the attackers confirmed `col`/`ColumnExpr`
   were ceremony in the candidates that carried them).
9. **Keeping the M2M filtered-deleteMany staleness gap as documented-only.**
   Rejected: it is the single *silent* divergence in the system and the
   maintainer's first value forbids exactly that. (Uniform rejection of
   filtered m2m deleteMany on batch drivers was also considered and
   rejected: it would break currently-working, behavior-covered
   functionality for the common uncontended case.)
10. **Lifting the M2M deleteMany-combination ban.** Rejected for now: with
    plan-time membership reads, the combined form would deterministically
    abort on planned mode (its own writes invalidate the premise) while
    succeeding on live — worse than the uniform typed error (§6.2.2a).
    Revisit only with a design that defers the membership read itself.
11. **Keeping per-substrate error messages / the `supportsTransactions`
    test branches.** Rejected: D1 is an artifact, not a contract
    (map-oracle D1 says so verbatim); the change lands isolated at M7.
12. **Porting `txCtx.createdRecords`/`generatedIds`, nested
    `withTransaction` re-entrancy, or the in-place `parentData` mutation.**
    Rejected: substrate artifacts, replaced by symbols, the flat scope
    (with the §1.2 A5 proof), and `Expr` rebinding.
13. **An N-backend/plugin `Mode` registry.** Rejected: exactly two
    substrates exist; speculative extensibility is ceremony. A genuinely
    new substrate implements `Mode` when it exists.
14. **Blanket-accepting `NestedWriteAssertionError` (or any
    guard-abort error class) in `isWriteRaceLoserError`.** Rejected: it
    would retry non-raceable correlation/orphan failures (re-running, and
    under concurrent state change potentially taking a different branch).
    Raceability is a per-guard fact set by the interpreter and carried in
    the planned scope's side table — never inferred from an error class
    (§1.2 A1).
15. **Pinning raceable create branches and rewrapping the abort as a typed
    raceable error** (total-ir §8.2 + the "raceable tag" repair). Rejected:
    even repaired, the pin double-enforces a constraint the DB already
    enforces, adds a per-dialect abort-attribution dependency to the *hot*
    race path, and remains stricter than live semantics. Deleting the pin
    (Pin Rule 2) is strictly simpler and preserves map-oracle D7's coupling
    verbatim.
16. **Per-kind routing with mixed old/new trees.** Rejected: the value
    substrates do not interoperate (concrete `parentData` vs `Expr`s), the
    old engines are mutually recursive, and a per-step interop shim would
    be a third semantics. Whole-tree routing costs slower coverage growth
    and buys the absence of an interop seam entirely (§1.2 A3).

---

## 13. Open questions (maintainer judgment required; everything else is decided)

**Q1 — The tx single-connect "subquery-only" fast path.**
`canUseSubqueryOnly` in `executeCreateWithNestedWrites` is largely dead
(`needsTransaction` returns true for any `connect` — map-tx-create §1
caveat), and the oracle cannot distinguish it. The upstream
`processConnectOperations` fast path in `executor.ts` is *outside* this
design's scope and untouched. Proposal: delete the transaction-flow fast
path at M10 and rely on `benchmarks/query-engine.bench.ts` as the gate;
reinstate as an interpreter peephole (fold a lone before-parent connect
`Expr` into the parent insert) only if the benchmark shows a regression you
care about. Needs your call: statement count on a hot path vs one less code
path.

**Q2 — Dropping the `related` map from `executeNestedUpdate`'s internal
return.** `txCtx.createdRecords` feeds a `related` map no public caller
consumes today (the top-level update path discards it). This design deletes
it. Confirm no external/planned consumer (e.g. a future include-on-mutation
shortcut) relies on it before M5 lands.

**Q3 — Concurrency suite placement and CI cost.** M8/M9's race gates need
two real connections, so they live with the Docker-gated driver tests
(PG 5434 / MySQL 3307), not PGlite conformance. Confirm you accept that the
race-parity guarantee is CI-gated only where Docker runs (it cannot run in
the default `pnpm test` path).

**Q4 — M0 discovery budget.** M0 will very likely surface at least one real
shipped divergence (the maps flag several latent candidates: D4, set
ordering edges, m2m upsert inline drift). The plan treats each as a scoped
pre-fix on the *old* engines before migration proceeds. Confirm you accept
that M0's calendar cost is open-ended by design — it is the price of making
"green at every milestone" mean something.

---

## 14. Definition of done

- One interpreter owns every semantic decision — as of the 2026-07-07
  navigability split, across the `interpret-*.ts` family modules
  (create/update/upsert/m2m + shared leaves) behind a small `interpreter.ts`
  entry, still ONE body (the families recurse into each other; no family
  module imports a mode implementation, gate-5-enforced); two mode files own
  only substrate mechanics; `selectMode` is the only capability fork
  (grep-gated).
- `nested-write-conformance.test.ts` (now covering every kind + M2M +
  divergence probes) and every `tests/drivers/*-behavior.ts` suite green,
  with the M7 single-message assertions.
- The concurrent suite proves converge-on-retry in both modes, and proves
  the planned-mode race signal is the constraint violation, not a guard
  abort.
- Every divergence in §10 is closed, absorbed, or preserved-with-rationale —
  none silent.
- 6,598 lines (two engines) → one interpreter (across family modules) + two
  modes + the kept shared builders; every §11 deletion is gone and no
  mutation kind exists twice. **The raw line count did not shrink below the
  two-engine anchor** — it landed at 6,729 pre-split, then 6,842 after the
  navigability split (−613 vs the M9 peak, +244 vs anchor, still well over
  the original ≤~3,200 estimate). That estimate was made against the wrong
  baseline and is withdrawn; the miss and its root cause (the irreducible
  ~3,666-line consolidated semantic surface, which the two half-engines never
  materialized in one place to be counted) are recorded in full at §11 M10
  gate (4). The abstraction did **not** fail by its own decisive test (next
  bullet); the *line-count prediction* failed, and we say so.
- A feature request touching nested-write semantics can be implemented
  without editing either mode file. That is the test of the whole design.
