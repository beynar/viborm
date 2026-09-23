# Nested-write dependency map — shipped engine (raptor3) vs. retired engine

Read-only mapping, branch `pattern-engine`, head `464705acc4069600ab84027a4f29e15564303756`.
Scope: how the shipped engine currently refuses a nested write whose later
member depends on an earlier member's write in the same nested write, and
what would have to change to execute it instead (live route and batch route),
per Arnaud's ruling that this must become supported (product differentiator
vs. Prisma).

---

## 1. Where the shipped engine reads — planning vs. execution, live vs. batch

There are **two structurally different "planning read" mechanisms** in the
shipped engine, and only one of them is about nested writes.

### 1a. The nested-write dependency read: `CommandExecution.runSelection`

This is the mechanism that actually matters for the ruling. A nested
`connect`/`connectOrCreate`/`upsert`/`update`/`disconnect`/`delete`/`set`
target becomes a `Selection` ("lookup") command, and in every case the
LOOKUP itself is placed at `"before"` via `RelationBody.requireLookup`
(`relation-body.ts:822-828`, `this.commands.place(parent, lookup, "before")`)
— see the lookup construction sites at `relation-body.ts:224-240` for
disconnect/delete (`requireLookup` call at `:240`), `:492-499` for
connect/connectOrCreate/upsert/update, `:637-648` for a captured
`updateMany`/`deleteMany` member, `:722-729` for `set`. (For disconnect/
delete, the *lookup* is `"before"` but the *removal/delete effect* that
consumes its result is a separate command placed `"after"`, `:262-294` —
the lookup still runs in the same `"before"` pass as every other nested
target lookup.) The `"before"` lookups run inside `CommandExecution.run`'s
`"record"` case, in the SAME pass that later performs the parent's own
insert/update:

```
src/query-engine/raptor3/commands/execution.ts:299-300
  for (const child of occurrence.children)
    if (child.placement === "before") await this.run(child, member);
```

A `"lookup"` occurrence dispatches through `runSelection`
(`execution.ts:342-344` → `:236-265`), which — unless the lookup's source is
a same-attempt `"producer"` (§4) — calls:

```
src/query-engine/raptor3/commands/execution.ts:250-255
  const rows = await this.context.read(
    selection.query(), true, false, selection.model
  );
```

`OperationContext.read` (`shared/operation-context.ts:894-910`) is a bare,
immediate round trip: `answer()` → `dispatch(1, terminal, () =>
this.transport._execute(...))` (`:911-927`, `:768-780`). It does **not**
consult any pending/queued statements — it is dispatched to the provider
exactly when `runSelection` is reached in the tree walk, on whichever
transport (`this.transport`) this operation currently holds.

**This read runs at *execution* time, interleaved with writes, on both
routes** — `CommandExecution` (`commands/execution.ts`) is the one
interpreter for both the live (callback-transaction / standalone
transaction-capable) and the batch (`usesBatch`) route; the difference is
what `ctx.insert`/`ctx.update` do when reached (§ below), not whether
`runSelection` exists.

- **Live route** (`ctx.usesBatch === false`, set at
  `shared/operation-context.ts:353-355`): `ctx.insert`/`ctx.update` dispatch
  their statement **immediately** via `this.dispatch(1, false, () =>
  this.transport._execute(...))` (`operation-context.ts:2283-2285` for
  insert; the analogous immediate dispatch for update surrounds
  `:2489-2491`/`:2478-2482`). Because `CommandExecution.run` awaits each
  child in declared order (before → own effect → capture → after,
  `execution.ts:299-339`), and siblings execute in their occurrence-tree
  order, a later sibling's `"before"` lookup — if not refused — would reach
  `runSelection` **after** an earlier sibling's insert/update has already
  been dispatched and awaited. The read would see it. Nothing about the live
  route's actual dispatch order is stale.

- **Batch route** (`ctx.usesBatch === true`: `ownership ===
  "batch-preparation"`, i.e. `prepareBatch`/array preparation, OR
  `ownership === "standalone" && !driver.supportsTransactions`):
  `ctx.insert` **queues** the statement (`this.queue(statement, ...)`,
  `operation-context.ts:2391`) instead of dispatching it, *unless* the
  insert demands a produced/generated field, in which case it forces an
  immediate `this.submit(true, member)` to capture the identity
  (`:2337-2346`, or the exact-identity-scratch path at `:2372-2389`).
  `ctx.update` similarly only reaches the provider through `this.queue(...)`
  for the batch scratch path (`:2457-2468`) and the statement itself is
  queued unless a `RETURNING` readback is demanded. Since `runSelection`'s
  `ctx.read` is a bare immediate `_execute` that never looks at
  `this.queued`/`this.attempt.pending`, **a dependent lookup that runs while
  an earlier sibling's write is still merely queued (not submitted) races
  ahead of it and answers a false absence** — this is exactly the staleness
  the `planningLocate` docblock warns about (§1b) and the concrete failure
  mode is `RelationBody`'s own "target record was not found for this
  parent" `NestedWriteError` (§2, relation-body.ts).

### 1b. The array/batch-preparation planning read: `OperationContext.planningLocate`

A **separate, narrower** mechanism, not about nested writes inside one
operation body: `OperationContext.planningLocate`
(`shared/operation-context.ts:881-893`):

```
890: async planningLocate(query: Query, model: AnyModel): Promise<Input[]> {
891:   const response = await this.answer(query, false, model);
892:   return this.queries.decodeQuery(query, response.rows, true);
893: }
```

Its docblock (`:881-889`) states it is "the ONE sanctioned direct read at
array-route preparation" — the sole caller is `Commands.rootUpsert`'s
probe-first fallback (`commands/commands.ts:1177-1198`, the read at
`:1181`), used when a **root** `upsert` cannot fold into one
`INSERT ... ON CONFLICT` statement and must locate-then-update instead. This
read runs during `prepareBatch`'s *construction* pass — before any array
member has executed — which is why "a connect to a row an earlier member
inserts" (a different **array member**, i.e. a different top-level
`$transaction([...])` operation, not a nested write inside one operation)
would see a false absence: `OperationContext.read` itself refuses to run
during `ownership === "batch-preparation"`
(`operation-context.ts:905-907`, `throw this.incompletePreparation`)
precisely because ordinary reads are not safe there; `planningLocate` is the
one exception, carved out for this one root-upsert decision, and it is
explicitly documented as unsafe for anything else. **This mechanism is
orthogonal to the ruling** (it concerns independent batched top-level
operations, not nested writes within one operation's relation body) but it
demonstrates the engine already distinguishes "read during construction/
preparation" (stale) from "read during execution" (§1a, not necessarily
stale on the live route).

---

## 2. The four refusal mechanisms

All four use the class `NestedWriteError` (`@errors`), but they are
different code, different timing, and different inputs.

### (i) `program/program.ts` — dead-code comparison specimen

`Program.analyzeDecisions` (`program/program.ts:369-411`), called from
`Program`'s own top-level analysis (`:365-368`) at **construction** time,
before `Program.run` executes anything:

```
program.ts:377-395 (abridged)
  for (const node of block.nodes) {
    if (node.kind === "choice") { this.analyzeDecisions(node.missing); collectWrites(node.missing); }
    if (node.kind !== "scan" || !node.intent) continue;
    for (const write of writes) {
      if (write.model !== node.model) continue;
      ...
      const known = fields.filter(field => write.values[field]?.kind === "literal" && typeof selector[field] !== "object");
      const literal = (field) => (write.values[field] as ...).value;
395:  if (known.some((field) => literal(field) !== selector[field])) continue;
      ...
397:  throw new NestedWriteError(
398:    `Nested operation '${node.intent.operation}' on relation '${node.intent.relation}' depends on an earlier '${write.origin!.operation}' target write in the same nested write. Split these operations into separate queries.`, ...);
```

**Inputs**: only `"insert"` nodes carrying an `origin` (a `connectOrCreate`
create arm — `origin?: { relation, operation: "connectOrCreate" }`,
`program.ts:26`) and only `"scan"` nodes carrying an `intent` (an
`updateMany`/`set`-style intent, `:32-35`). It compares **literal** field
values only (`known`), and if every literally-known selector field matches
the write's literal value it refuses; anything not staticaly literal-known
is silently treated as "not disjoint" only via the `some(...) !== ...`
negative check — i.e. it refuses only a subset of shapes and is a much
narrower check than commands.ts's.

**What fact it decides**: "does this `scan` (an intent-carrying
`updateMany`) target a model+literal-selector that an earlier
`connectOrCreate`-origin insert in the same program also names?"

**When it runs**: at `Program` construction (`analyzeDecisions` runs before
`schedule`/`run`, `:365-366`), for every relation body compiled through
`program/`.

**Which public shapes hit it**: none in production. Per
`src/query-engine/raptor3/AGENTS.md:21-29`, `program/` is the **retired
G1-01 comparison specimen** — `commands/` was selected as the sole
expansion path and `program/` is not reachable from the public API
(`VibORM`'s constructor never builds a `program/`-based route). This
refusal is dead code from the shipped engine's perspective, but it is live
source in the tree, competes for attention in review/grep, and encodes a
narrower (and different) idea of "conflict" than commands.ts's — a real
consolidation hazard if anyone edits nested-write semantics without
checking both.

### (ii)+(iii) `commands/commands.ts` — `checkPair` → `readMembership` / `readTarget`

The live mechanism. Both are called from one dispatcher:

```
commands.ts:869-873
  private checkPair(write: WriteVisit, read: ReadVisit): void {
    if (!this.compatible(write.branch, read.branch)) return;
    this.readMembership(write.write, read.read);
    if (read.read.target) this.readTarget(write.write, read.read);
  }
```

`checkPair` is invoked for every (preceding write, current read) pair found
by walking the occurrence tree: `analyzeRead` (`:843-868`) calls
`visitPrecedingWrites` (`:824-842`, ancestors' direct writes + earlier
siblings, recursively) for a normal read, and `expandSeries`
(`:1008-1020`) calls `visitFollowingReads`/`checkPair` symmetrically for a
selected-series member's own writes against reads that follow it. Both are
driven by `Commands.analyzeOccurrence` (`:886-927`), which is invoked from
`Commands.analyze`/`analyzeSeries` (`:479-490`) — the analysis runs **once**,
synchronously, at command-tree construction, and it is unconditional: it
never reads `context.usesBatch` anywhere in `checkPair`/`readMembership`/
`readTarget`/`visitPrecedingWrites`/`analyzeRead` (confirmed: no
`usesBatch` reference in `commands.ts` at all outside `rootUpsert`'s
unrelated `planningLocate` use). **It runs identically on the live route and
the batch route.**

**(ii) `readMembership`** (`commands.ts:536-578`): decides whether a
`REFERENCE`-kind membership a read observes conflicts with a **membership
write** (a `link`/`remove`, or a record's own membership-column
contribution, published via `MembershipPublication`, `:195-199`,
`:468-473`, `:778-781`). Inputs: the read's `Selection.membership()`/bound
`membership`, and the write's `MembershipPublication` (carrier model, same
edge scope, same or unscoped member, and — the disjointness escape hatch —
whether any of the read's **known-equal** fields is provably unequal to the
write's identity on a field the write does not itself write, `:557-568`).
Sentence + site:

```
573-577: `Nested operation '${operation}' on relation '${relation}' depends on an earlier '${earlier}' membership write in the same nested write. Split these operations into separate queries.`
607-619: (same sentence, `dependency: "membership"` meta) for mutation.kind === "link"/"remove" reached inside readTarget's scope walk
```

**(iii) `readTarget`** (`commands.ts:579-693`): decides whether a lookup
that "addresses a target" (`read.read.target === true` — set only for
`Choose`, `Deletion`, and `SelectedSeries` dependency reads, see
`dependencyRead` `:702-733`) conflicts with an earlier `record` (create or
written-field update), `delete`, `set`, `link`, or `remove` write on the
**same model**, again escaping only via a **literal-value** disjointness
check on the read's known-equal fields vs. the write's known/literal values
(`:641-666`) — an update's own *written* fields are excluded from the
disjointness probe (`:648-650`, so a field the write itself changes can't be
used to "prove" disjointness from it). Sentence:

```
676-690: `Nested operation '${origin.operation}' on relation '${origin.relation}' depends on an earlier '${operation}' target write in the same nested write. Split these operations into separate queries.`
```

**Which public shapes hit these**: every nested `connect`, `connectOrCreate`,
`upsert`, `update` (child selector), `disconnect`, `delete`, a captured
member of a nested `updateMany`/`deleteMany`, and `set` — i.e. every nested
target lookup relation-body.ts builds (§2iv) — whenever the static analysis
cannot prove it disjoint from an earlier sibling/ancestor write on the same
model/edge. This is genuinely the exact family of shapes named in the
ruling: "a connect/connectOrCreate/upsert/update whose target row an
earlier member creates or moves, a cross-scope upsert after a create, a
self-referential edge, a transition of a key an earlier member referenced."

### (iv) `commands/relation-body.ts` — the runtime "not found" refusal(s)

Distinct from (ii)/(iii): these are not a static conflict-proof; they are
the ordinary "no row satisfied the lookup" refusal `runSelection` raises
when the actual `read()` (§1a) comes back empty
(`execution.ts:256-259`, `if (!found) { if (selection.required) throw
selection.required(); return; }`), where `selection.required` is the
closure relation-body.ts installed when it built the lookup:

- disconnect/delete target, `relation-body.ts:224-238`:
  ```
  232-236: () => new NestedWriteError(`Cannot ${verb} relation '${edge.name}': target record was not found for this parent.`, edge.name)
  238:     outgoing.origin = origin;
  ```
- connect/update target, `relation-body.ts:492-499`:
  `Cannot ${verb} relation '${edge.name}': target record was not found${verb === "update" ? " for this parent" : ""}.`
- connectOrCreate "race" retained-row refusal, `:504-508`:
  `Record was replaced by another transaction during nested connectOrCreate`
- upsert found-membership requirement, `:524-528`:
  `Cannot upsert relation '${edge.name}': target record was not found for this parent.`
- nested `updateMany`/`deleteMany` member target, `:641-648`:
  `Cannot ${verb === "updateMany" ? "update" : "delete"} relation '${edge.name}': target record was not found for this parent.`
- `set` target, `:722-726`:
  `Cannot set relation '${edge.name}': target record was not found.`

**What fact it decides**: "did the actual SQL SELECT, issued right now,
return a row?" — a genuine runtime fact, not a static conflict guess.

**When it runs**: at execution time, inside `runSelection`, for whichever
lookup the (unrefused) tree reaches.

**Why it matters as a fourth *competing* mechanism**: if (ii)/(iii) were
loosened or made route-aware without also fixing the read timing (§1a/§5),
this is the mechanism that would fire instead — as a generic "not found"
error rather than the explicit "depends on an earlier write" sentence —
whenever a dependent lookup on the **batch route** actually races ahead of
a still-queued producing write. It is the reason the fix cannot be "just
delete the static check": the static check is currently the only thing
standing between a batch-route dependent connect and a misleading
NotFound-shaped failure instead of a correct read.

---

## 3. How the RETIRED engine executed the same shapes

Two distinct retired generations exist in history, and **both refused
same-operation dependencies**, though on different, narrowing terms — this
section corrects an initial assumption that the retired engine simply
"executed" what the shipped engine now refuses. It did not: DESIGN.md's
final, normative rule is at least as strict as the shipped engine's, by
deliberate design, not oversight.

### 3a. The earliest interpreter generation (git history only, deleted in `3611d48ec`)

The oldest nested-write interpreter lived at
`src/query-engine/operations/nested-writes/{interpreter.ts,semantic-plan.ts,
interpret-create-family.ts,interpret-update-family.ts,live-mode.ts,
planned-mode.ts,mode.ts,legality.ts}`, deleted wholesale in commit
`3611d48ec` ("V1 operation-program engine — the frozen migration
baseline"); last readable at its parent, `git show
d577f7c3ae6f108c39ac2632ff1eaf422aa79deb:src/query-engine/operations/nested-writes/<file>`.

- **Ordering**: each relation's mutation steps ran in a **fixed canonical
  kind order regardless of input order** — create → createMany → connect →
  connectOrCreate → disconnect → delete → set → update → updateMany →
  deleteMany → upsert (`semantic-plan.ts:146-217`,
  `planRelationMutationSteps`, per the parent commit). Across relation
  *names*, order followed `Object.entries(relations)` = declaration order
  (`interpret-update-family.ts:240,243-262`).
- **How a later op observed an earlier op's write**: purely symbolic/
  in-memory, never a re-query. `WriteSymbol`s carry `produces`; **live**
  mode captures produced values directly off the just-executed INSERT's own
  returned row (`live-mode.ts:235-236`, `this.values.set(symbol.id,
  record[symbol.field])`); **planned/batch** mode
  (`canObserveOwnWrites = false`, `planned-mode.ts:214`) instead embeds the
  symbol as a SQL reference resolved by the DB inside the same atomic batch
  (`mode.ts:20-22`, `batchRefs.read(...)`) — i.e. the shipped engine's
  `batchRefs`/`references.read` mechanism (§4) is a direct descendant of
  this exact design.
- **connectOrCreate same-operation duplicates**: `dedupeConnectOrCreateInputs`
  (`semantic-plan.ts:306-326`, verified directly via `git show
  d577f7c3ae6f:...semantic-plan.ts:300-326`) drops a later entry whose
  `where` JSON-matches an earlier entry's `where` in the SAME array — a
  **static, literal, pre-execution dedup**, not a read-based resolution;
  this is the direct ancestor of the shipped engine's
  `relation-body.ts:416-440` first-create-wins matching (§4).
- **The only same-operation dependency refusal found in this generation is
  m2m-specific and purely syntactic** — key co-occurrence, not any real
  overlap analysis: `assertManyToManyStepCombinationIsSupported`
  (`semantic-plan.ts:328-350`, verified directly) throws `NestedWriteError`
  whenever `deleteMany` co-occurs with `create`/`connect`/`connectOrCreate`/
  `set` on the **same many-to-many relation key**, with the stated reason
  "The tx engine executes connect/create/set before deleteMany, while the
  batch engine resolves deleteMany targets at plan time — combining them in
  one nested write would silently produce different end states per engine"
  (`semantic-plan.ts:328-331`). It bans the *combination by kind*, blindly —
  even on provably disjoint targets — and it exists **only for m2m**; this
  generation had **no dependency check at all for FK-held (to-one/to-many
  reference) relations** — a later FK-side connect/update targeting a row
  an earlier sibling just created was not statically refused and relied
  entirely on ordering + symbol resolution to be correct.

### 3b. `docs/architecture/engine-unification/DESIGN.md` — the normative unification design (still on disk, still cited as authoritative by `raptor3/AGENTS.md`)

This is a **later, distinct generation** (it discusses polymorphic
relations, absent from 3a) — the direct ancestor of the shipped engine's
dependency analysis, and it is explicit that the refusal is a **deliberate,
mode-independent policy**, not a limitation of either mode's actual
execution capability:

```
DESIGN.md:876-880 (§6.2 "Uniform own-write preflight and branch ledgers")
  > Before either mode performs a deciding read or emits an effect, preflight
  > proves that the decision is independent of every earlier possible write in
  > the same nested operation. The proof is semantic and mode-independent.
```

The ledger tracks exactly the three dimensions the shipped engine's
`readTarget`/`readMembership` implement (§2ii/iii): "Target existence",
"Target predicates", "Relation membership" (`DESIGN.md:882-889`). Crucially,
the design **explicitly overrides live mode's own ability to get it right**:

```
DESIGN.md:700-705 (the `Mode.probe` contract)
  /** Axis B: run a deciding read.
   *  Live: now, on the tx driver (sees own writes; honors forUpdate); ...
   *  Planned: now, on the base driver (committed state, plan time); ...
   *  Uniform preflight rejects same-operation dependencies first. */
```

i.e. live mode is documented as *capable* of seeing its own prior writes
(ordinary transaction visibility — the same fact §1a/§5 establishes for the
shipped engine's live route) but the design **deliberately** runs the
mode-independent preflight veto *before* that capability is ever used, so
that switching between live ($transaction(callback)) and planned (batch
array) execution can never silently change the operation's outcome
(`DESIGN.md:918-921`: "An actual target, predicate, or membership overlap
rejects during uniform preflight with the same `NestedWriteError` in both
modes, before any effect... it is not a same-operation escape hatch").
`DESIGN.md:939-950` (§6.3, the legality gate) confirms this runs "before
any effect, in both modes" as step 4 of one preflight surface, "including
independently forked nested alternatives" (connectOrCreate/upsert branch
ledgers, `:899-912`).

**What DESIGN.md's generation *loosened* relative to 3a**: it explicitly
replaces 3a's blunt, kind-only m2m ban with the same overlap analysis
applied uniformly to every relation kind — `DESIGN.md:914-917`: "This
replaces the old blanket M2M mixed-step rejection. Independent steps (for
example, connect one target and deleteMany a provably disjoint numeric or
boolean target) are legal." (also `:1217`: "M2M mixed relation steps |
Unified — the blanket ban is removed; exact target, predicate, and
membership overlap rejects in preflight, while disjoint steps execute in
the shared order (§6.2)"). So the historical trend across both retired
generations is: **more precise disjointness proofs, not fewer refusals in
the dependent case** — the shipped engine's `readTarget`/`readMembership`
(§2ii/iii) is this same generalized-overlap-ledger idea, reimplemented.

### 3c. `docs/architecture/retired/write-engine-ATOM.md` — read directly (1311 lines, still on disk)

This sits between 3a and 3b (its "Same-operation duplicate"/first-create-wins
wording is what `DESIGN.md §6.2`'s branch-ledger language formalizes, and
what `raptor3/AGENTS.md:984-990` and `relation-body.ts:348-350,416-422` cite
directly). Read first-hand at `docs/architecture/retired/write-engine-ATOM.md:704-770`:

```
734-738 (§12, "Same-operation duplicate"):
  If an earlier sibling already created the target, connect-or-create applies
  first-create-wins locally. The later entry adopts that row. It emits no found
  guard and no missing race pin because the producer is inside the same operation.

746-752 (§13, "OwnWrite legality"):
  Planning reads observe committed state before final writes. A read whose answer
  depends on an earlier sibling write cannot be made correct by a later guard.
  OwnWrite analysis rejects such one-operation feedback with the established
  "split these operations" failure.
```

§13 (`:763-770`) also states **legality timing**, which the shipped
engine's `Commands.analyze`/`analyzeOccurrence` (§2) matches almost exactly:
"standalone update runs it before planning; an enclosing create or update
tree analyzes nested ordinary updates once; an upsert found arm runs
deferred update legality only when found; a missing create arm does not
analyze the untaken update subtree. Do not run OwnWrite twice for a subtree
already covered by its enclosing tree." This is the same "construct once,
before any statement, analyze the whole tree" timing §1a/§2 establish for
`commands.ts`, and the same "found arm only" deferral the shipped engine
uses for upsert key-portability refusal (`AGENTS.md:704-713`) — i.e. this
exact ATOM.md paragraph is a direct textual ancestor of multiple shipped-
engine behaviors, not just the dependency refusal.

**Conclusion for §3**: neither retired generation "executed" a genuinely
dependent nested write (target/predicate/membership actually or
unprovably overlapping an earlier sibling's write) inside one nested-write
operation. The earliest generation refused only a narrow m2m-kind-
combination subset and was silently unguarded (not deliberately permissive)
for FK relations; the unification design that DESIGN.md documents
**explicitly, by name, forecloses** exactly the shape Arnaud's ruling now
asks for — and does so *because* of live mode's own-write visibility, not
in ignorance of it, in service of one non-negotiable design goal (mode-
independent, uniform observable behavior). Making the shipped engine accept
these shapes is therefore not a bug fix or a narrow gap-closing change: it
is an explicit reversal of `DESIGN.md §6.2`'s central invariant, which
`src/query-engine/raptor3/AGENTS.md` still calls normative. Any change
should say so plainly rather than presenting it as tightening an
over-conservative check.

---

## 4. Existing mechanisms that could carry a dependency without a new concept

| Mechanism | Where | Can it express "later member's lookup runs after earlier member's write"? |
|---|---|---|
| **`OperationContext.flush(query, member)`** | `shared/operation-context.ts:1036-1063`, `flushQueued` `:1065-1087` | **Yes, on both routes, already.** On the live route it degrades to a plain `read()` per query (`:1054-1058`, since `!this.usesBatch`). On the batch route, when `this.queued.length > 0`, it **queues the read alongside every currently-pending statement and submits them together** (`:1071-1072`, `this.queue(projection.sql)` then `this.submit(false, member)`), so the read's decoded rows reflect every write queued before it — this is exactly "a succession of statements with reads in between." It is **already used for this exact purpose** in two places: `Choose` execution's producer-sourced lookup (`commands/execution.ts:392-408`, flushing `attempt.references()` via `ctx.referenceProjection` before reading a same-attempt-produced value) and `captureSeries`'s parent re-read (`commands/execution.ts:778-786`). `runSelection`'s dependent-target read (`execution.ts:250-255`) does **not** use it — it calls the raw, non-flushing `ctx.read` instead. |
| **`batchRefs.storeInsertedKey` / `references.store` / `references.read`** (`OperationContext.insert`, `:2308-2394`, `:2453-2472` for `update`) | `shared/operation-context.ts` | **Yes, for one specific value shape**: a generated increment key (or an evaluated `int` update expression) produced by one statement in the batch, read back by name from the driver-owned scratch (PostgreSQL RETURNING-inside-CTE, D-50; SQLite/MySQL last-insert-id) by any *later* statement in the same batch. This is exactly the AGENTS.md-documented mechanism (`AGENTS.md:735-747`) for a single record's *own* produced fields; it is not currently reached from a *sibling's* dependent lookup, but the wiring (`references.read(scratchId, key)` as an expression usable inside any later queued statement's SQL) is the same shape a dependent connect's foreign-key value would need. |
| **`continuationList` / `supportsOrderedCommittedSegments`** (`:184-187`, `:1112`, `:1157-1160`, `:1230`, `:2363-2369`) | `shared/operation-context.ts` | Carries a **stored-row re-read requirement** forward (a query + model to re-verify after a segmented RETURNING insert), consumed inside `submit()` as an `exists` guard ahead of the next segment (`:1113-1122`). It is about proving an *already-produced* row is still there across segment boundaries, not about ordering a dependent read after a not-yet-submitted write — orthogonal to this ruling, but shows the engine already threads "read must happen after this batch segment" facts through `submit`. |
| **`captureSeries` / `Commands.expandSeries`** | `commands/execution.ts:757-880`, `commands/commands.ts:980-1020` | Handles **ordered peer series members observing earlier peers' effects** (AGENTS.md:214-219, "Ordered peer series members may observe effects from earlier peer members") via `flush()` (see row 1) plus `expandSeries`'s own `checkPair`/`visitFollowingReads` pass over the *captured* rows. This is the one place the engine already accepts "a later thing may see an earlier thing's write" as a designed case — but only for a selected series' own captured membership read, not for an arbitrary nested target lookup. |
| **`Choose` (upsert arms) / `conditionalSkips`** | `commands/execution.ts:392-479`, `command-attempt.ts:23`, `execution.ts:190,423-428` | `conditionalSkips` records a *skip-arm* atomic-assertion failure so `recover()` can retry it as a **match** instead (execution.ts:181-211) — this is race/recovery machinery (concurrent transactions), not intra-operation dependency ordering. The `"producer"`-sourced `Choose` path (execution.ts:392-408, `supplied`) **is** relevant: it is the one place a `Choose`'s own target lookup is resolved from a same-attempt produced value via `ctx.flush` instead of a raw read — see row 1. |
| **Membership publications** (`MembershipPublication`, `commands.ts:195-199`, `:468-473`/`publishMembership`, `:778-781`/`membershipPublications`) | `commands/commands.ts` | Purely an **analysis-time** fact (what a write will assert about a membership column) consumed by `readMembership` (§2ii) to decide the refusal — not an execution-time carrier. It does not itself run anything late; it is the input the refusal reads, not a mechanism that could replace the refusal. |
| **`recover()`** | `commands/execution.ts:181-211`, `shared/operation-context.ts` recovery methods (`spendRecovery`, `regionAttempt`, `batchAttempt`) | Handles **unique-constraint races against concurrent transactions** (a different physical write raced this operation) and **atomic-batch assertion failures**, re-planning or replaying from admitted values. Not designed for, and not currently reachable for, deterministic same-operation dependency ordering — it fires on a provider-reported conflict, not on a planning-read staleness the engine itself could have avoided. |

**Bottom line for §4**: `flush()` is the one existing, already-proven
mechanism (used twice already, for structurally analogous problems) that
directly answers "make a later read observe an earlier, still-queued write"
on the batch route; the live route needs no new mechanism at all because
its writes are never queued in the first place (§1a).

---

## 5. The smallest change

**Framing, given §3b**: this is not "the refusal is overprotecting a stale
read that could simply be deferred" as a neutral implementation gap — the
normative design (`DESIGN.md §6.2`, `:700-705`, `:918-921`) *knows* live
mode can see its own prior writes and *chooses* to veto anyway, to keep
live and batch execution observably identical. Arnaud's ruling tonight
explicitly drops that uniformity guarantee in favor of "accept any nesting,
execute it through whatever mechanism the route supports" — so the change
below is a deliberate, named reversal of `DESIGN.md §6.2`'s central
invariant, not a bug fix. With that said, the mechanical answer to "is the
refusal only protecting a planning read that could be deferred to execution
order" is: **yes, on the live route, mechanically** — the live route's
sequential dispatch already produces the correct answer today, the design
document itself says so, and it is refused anyway purely for cross-mode
uniformity. Given tonight's ruling explicitly abandons that uniformity
goal, the mechanical fix is as small as described below.

### Live route

`Commands.plan()` is called with a fully-constructed `OperationContext`
already in hand (`commands/index.ts:183-187`, `context` is the `Commands`
constructor argument used inside `plan()`/`analyze()`), so `context.usesBatch`
is available at the exact point `checkPair`/`readTarget`/`readMembership`
run — but `commands.ts`'s dependency analysis never reads it. The refusal
fires identically whether or not the physical route can actually go stale.

On the live route, sequential dispatch already makes a dependent lookup
correct **by construction**: `CommandExecution.run`'s children walk
(`execution.ts:299-339`) awaits every `"before"` child (including a target
lookup) after all earlier-declared siblings' own `ctx.insert`/`ctx.update`
calls have themselves already been awaited to completion (§1a — insert/
update dispatch immediately when `!usesBatch`). So: **the refusal in this
case is purely protecting a planning read that is not actually early** — it
is not deferred, it already runs at the moment the interpreter reaches it,
which is after the producing write. The smallest change is to make
`readTarget`/`readMembership` (or `checkPair`) **not raise** when
`context.usesBatch` is false — e.g. gate the `owner.refusal ??= new
NestedWriteError(...)` assignments at `commands.ts:573`, `:607`, `:676`
behind `if (this.context.usesBatch) { ... }` (`this.context` is already the
field `Commands.context`, set in the constructor and used throughout
`commands.ts`, e.g. `:1204`, `:1225`). No new mechanism, no CTE, no
reordering: the existing statement-by-statement dispatch order is already
the correct order. (The one thing to re-verify once this is loosened: the
`activeRefusal`/branch logic at `commands.ts:874-884`, and `Choose`'s own
found/missing legality — since removing the disjointness refusal makes
previously-unreachable branch combinations reachable, per `ELEGANCE.md`'s
"Removing a refusal makes previously unreachable paths reachable. Check
their result modes, empty cases, siblings, repeated placements and failure
boundaries.")

### Batch route

Here the refusal is currently load-bearing: a genuinely queued-but-
unflushed write would otherwise be raced by `runSelection`'s raw `ctx.read`
(§1a), landing on relation-body.ts's "target record was not found for this
parent" `NestedWriteError` (§2iv) instead of a correct read. The smallest
change that keeps correctness without a new concept is to route the
dependent lookup through the **already-existing** `ctx.flush(query, member)`
(§4, row 1) instead of the raw `ctx.read(...)` at
`execution.ts:250-255` — i.e. change `runSelection`'s
```
const rows = await this.context.read(selection.query(), true, false, selection.model);
```
to flush first (`ctx.flush` already no-ops to the same `read()` call when
`!usesBatch || queued.length === 0`, so this is safe on the live route too
and could replace the raw call unconditionally). This submits every
statement queued by earlier siblings (their `ctx.queue(...)`d inserts/
updates/links) before decoding the dependent read, exactly mirroring the
two places (`Choose`'s producer-sourced lookup, `captureSeries`'s parent
re-read) that already do this. For the narrower case where the dependency
is on a **produced** value (an earlier sibling's generated key) rather than
mere row existence, the existing `batchRefs`/`storeInsertedKey`/
`references.read` exact-identity scratch (§4, row 2; PostgreSQL via a
data-modifying CTE per D-50, SQLite/MySQL via last-insert-id) is the
mechanism to extend so a dependent connect's foreign-key column can read
the scratch reference directly instead of re-querying — this is closer to
"a data-modifying CTE" the ruling names explicitly, and is already wired
for a record's *own* produced fields; extending it to a *sibling's*
produced fields is a real (if bounded) change, not a trivial gate-flip like
the live-route fix. Once dependent lookups flush (or read the scratch)
instead of racing, `readTarget`/`readMembership`'s refusal on the batch
route should be narrowed from "cannot statically prove disjoint" to
"provably conflicts even after the dependency is resolved" — i.e. it stops
being a blanket refusal and starts being a real conflict detector (two
nested writes that genuinely fight over the same row/columns, which is a
different, still-legitimate refusal).

---

## What I could not determine

- Whether `docs/architecture/engine-unification/DESIGN.md`'s generation was
  ever actually implemented end-to-end and shipped (vs. `write-engine-ATOM.md`
  being a still-later, further-evolved rewrite of the same idea) — the
  background research pass found no `bindRelation`/`BoundRelation`/
  polymorphic vocabulary in the git-history interpreter it could read
  (`d577f7c3ae6f:src/query-engine/operations/nested-writes/*`), suggesting
  DESIGN.md and ATOM.md describe a later rewrite whose own source is not
  present anywhere in git history under an obviously-named path — I did not
  locate that implementation myself either. `raptor3/AGENTS.md:12-19`'s
  provenance note only promises the pattern-engine-era V1 files (readable at
  `e8114ed9`) — not this still-earlier interpreter generation — so treat the
  git-history file paths in §3a as independently discovered, not
  guide-sanctioned.
- Whether `flush()`'s `withholdPremises`/`restorePremises` pairing
  (`operation-context.ts:1052,1062`, tied to Arnaud's D-29 per the doc
  comment at `:1043-1051`) would interact safely with a *dependent nested
  lookup's* flush the way it already does for `captureSeries`'s — i.e.
  whether routing `runSelection` through `flush()` needs any change to that
  premise-withholding logic, or whether it "just works" because the
  mechanism is generic. Not executed/tested (this task is read-only and
  explicitly must not run tests).
- Whether every one of the six nested-target call sites in
  `relation-body.ts` (disconnect/delete, connect/update, upsert
  foundRequirement, connectOrCreate retained-row, updateMany/deleteMany
  member, `set`) would need the same `flush`-instead-of-`read` treatment,
  or whether some (e.g. the connectOrCreate "retained" re-check,
  `:504-508`, which is about a **race across the SAME lookup being read
  twice**, not a same-operation dependency) are a different problem that
  should not be touched by this fix. I flagged `:504-508` as likely
  out-of-scope for this ruling but did not fully trace `Selection.retained`
  end-to-end.
- Exact behavior of `Commands.rootUpsert`'s `planningLocate` fold (§1b) is
  documented as intentionally narrow and unsafe outside its one call site;
  I did not verify whether it ever participates in a *nested* (not root)
  dependency chain — from the code read, it does not (it is reached only
  from `commands.ts:1122-1199`, the **root** upsert fold, never from
  `relation-body.ts`).
