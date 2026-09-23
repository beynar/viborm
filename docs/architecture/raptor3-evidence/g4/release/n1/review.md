# Independent review — release unit "n1" (D-51, the ordered observation)

Reviewer: independent, worktree `/private/tmp/viborm-n1` (branch `n1`, base
`e772741eb`). Nothing under `src/`, `tests/`, `scripts/` or `docs/` was edited
except this file; nothing was committed, staged or checked out; the main tree
was neither written nor run in. Scratch: `/private/tmp/viborm-n1-review-tmp`
(TMPDIR for every run), probes under `…/probe/`, never under `src/` or `tests/`.

## Verdict: **REVISE**

The rule is the right one and the unit states it well: one owner per fact
(`Commands.depend`), no second reader (`flush` IS the barrier, and the
`withholdPremises` reading that justifies it is correct), no policy boolean in
the consumers, and the refusal that survives names an execution fact no order
satisfies. The pins falsify at the base (27 of 36 red, every red the sentence
the unit reverses). The re-expressed expectations are derived, not copied.

One **confirmed correctness defect** blocks acceptance as landed: the move that
`depend` performs mutates the array that `analyzeOccurrence` is iterating, and a
sibling is silently dropped from the dependency pass. It produces a wrong answer
on the batch route for an ordinary admitted payload **and makes the two routes
disagree** — the one thing D-51 says must not happen ("They keep one result").
The fix is three characters per loop and is verified below to close the defect
while keeping the pins green.

---

## Findings

### F1 — CONFIRMED, major. `depend`'s move skips a sibling of the dependency pass

`src/query-engine/raptor3/commands/commands.ts:949-966` splices `consumer` out
of `ancestor.children` and re-inserts it at `landing`, while
`analyzeOccurrence` (`:1227`, `:1250`, `:1254`) is iterating **that same array**
with `for…of`. When the re-insertion index is greater than the index the
consumer occupied, the element that shifts into the vacated slot is never
yielded: it is never passed to `analyzeOccurrence`, so neither it nor its whole
subtree ever runs `analyzeRead`. Its dependent reads are never marked
`Selection.dependent`, so on the batch route they take the raw
`OperationContext.read` and race the queued writes.

*How the index grows.* `place` (`:376-398`) sorts `parent.body` by
`(origin.order, placement)`, so a moved read normally lands back on its own
index — its same-origin `"after"` consumer sits immediately behind it and
satisfies the `landing` predicate. It does **not** when the moved child has no
same-origin `"after"` partner at that level: a parent-held to-one
(`relation-body.ts:901`, `edge.owner === "source"` ⇒ `"before"`) whose subtree
reads what the ancestor's own write changes. Then `producer` is `undefined`,
`landing` is `-1`, and the insertion index is `children.length`.

*Reproduction* (`/private/tmp/viborm-n1-review-tmp/probe/probeF.test.ts`, schema
in the file: `node` holds `containerId` and `ownerId`, `person` holds `firstId`
and `secondId`):

```ts
// F1 — the dependent subtree alone
client.node.update({ where: { id: 1 }, data: { owner: ownerPayload } })
// F2 — the SAME subtree behind a parent-held choice that moves
client.node.update({ where: { id: 1 }, data: {
  containerId: 20,
  container: { update: { nodes: { update: { where: { id: 1 }, data: { label: "after" } } } } },
  owner: ownerPayload,
} })
// ownerPayload = { create: { id: "o9", name: "Nine",
//   first:  { create: { id: 5, code: "X" } },      // the write
//   second: { connect: { code: "X" } } } }         // the dependent read
```

Measured on the unit:

| cell | live | batch-only |
| --- | --- | --- |
| F1 (subtree alone) | resolves, `firstId=5, secondId=5` | resolves, `firstId=5, secondId=5` |
| F2 (same subtree, moved sibling ahead) | resolves, `firstId=5, secondId=5` | **rejects** `Cannot connect relation 'second': target record was not found.`, nothing written |

Instrumentation (a prototype wrapper loaded as a vitest `setupFile`, no source
edited) prints for F2:
`MOVED choose idx 0->1 place before->after siblings=record/before,choose/after`
and `SKIPPED child record/before under record`.

At the base `e772741eb` both F1 and F2 refuse uniformly on both routes (the
§6.2 sentence), so **the route divergence is introduced by this unit**, not
inherited.

*Scope.* The same instrumentation over the whole `tests/raptor3/**` estate
(2 162 cells) reports **zero** skips, and over
`ordered-observation` + `g29-*` + `selector-dependencies` + `lane-x-set-mutations`
(87 cells, 109 `depend` calls) every move keeps its index. The estate simply
does not contain the shape; `cells-vs-n3-head-final.txt`'s "newly red 0" is
therefore consistent with this defect existing.

**Exact minimal resolution.** In `Commands.analyzeOccurrence`, iterate a
snapshot in the three recursive loops, so a move inside a child's analysis
cannot skip a sibling:

```ts
// commands.ts:1227, :1250, :1254
for (const child of [...occurrence.children]) this.analyzeOccurrence(child);
for (const record of [...occurrence.children]) this.analyzeOccurrence(record);
```

(The second loop at `:1228-1246`, refusal propagation, reads the array after all
children are analysed and needs no change. `expandSeries` already iterates a
computed array.)

**Verified.** Simulating exactly that ("no child of an analysed parent is
skipped", `probe/instrument-fix.ts`): F2 on the batch route becomes identical to
F1 and to the live route, and `ordered-observation` + `g29-*` +
`selector-dependencies` + `lane-x-set-mutations` stay **87/87**.

**Also add a pin.** F2 belongs in
`tests/raptor3/g4/parity/ordered-observation.test.ts`: two parent-held to-one
relations on one root, the first one moving, the second's subtree carrying a
dependent read — asserted identical on all three routes. Without it the shape
stays uncovered.

### F2 — PLAUSIBLE, minor. A found requirement can be dropped when the barrier degenerates

`OperationContext.flush` (`shared/operation-context.ts:1080`) short-circuits to
a plain `read` when `!this.usesBatch || this.queued.length === 0`, and on that
path the new `premise` argument is **silently ignored** — `flushQueued`, which
asserts it (`:1097-1098`), is never reached. For the presence premise this is
harmless: `runSelection` still throws `selection.required()` in JavaScript. For
the upsert's found requirement it is not: `execution.ts:494` now reads
`if (requirement && !premised)`, and `premised` is computed from
`ctx.usesBatch && command.lookup.dependent` (`:437-441`) — not from whether the
premise was actually asserted. A dependent upsert lookup reached with an empty
queue would therefore have its found requirement checked **neither** in the
batch **nor** in JavaScript.

I could not construct a reaching query inside this review's budget (after every
flush `restorePremises` normally re-fills `pending`, and the root's own
`requirePresent` is queued ahead of the after-phase), so this is reported as
latent, not measured.

**Exact minimal resolution.** Make the fallback follow the fact rather than the
capability: have `flush` report whether it asserted the premise (or assert the
premise on the degenerate path too), and gate `execution.ts:494` on that, e.g.

```ts
// operation-context.ts:1080 — the degenerate path owes the same premise
if (!this.usesBatch || this.queued.length === 0) {
  if (premise) await this.assertOutsideBatch(premise); // present ? read+throw-if-absent : requireAbsent
  …
}
```

so that "capability is not authority": `usesBatch` may make the barrier
available, but only the assertion actually made may retire the JavaScript check.

### F3 — CONFIRMED, minor (soundness of a stated rule). The membership-field literal disjointness is one-directional

`readMembership` (`commands.ts:600-625`) declares a write disjoint when the
literal it states for a member-side field "cannot be this parent's key —
another parent's key, or null", and the comment justifies it "as the target
overlap is". The two are not equivalent. For the *target* overlap, disjoint
means "not the same row". For a *membership*, a write that puts the member's
foreign key to `null` or to another parent's key does not leave the membership
unchanged — it **removes** the row from it, which is exactly a change a later
membership read must observe. The rule is sound only in the "this write cannot
ADD the row to this membership" direction.

The engine happens to be saved here by other owners: the reference-edge
`disconnect` and `set` paths reach `depend` through `readTarget`'s
`link`/`remove`/`set` arms instead, which I measured — `posts: { disconnect:
[{id:p1}], update: { where: {id:p1} } }` answers `target record was not found
for this parent.` identically on both routes, and `set`/`updateMany` answer per
the canonical verb order (probe D, four cells × two routes). And a nested
`update` payload does not admit the relation's own scalar, which closes the
obvious direct route. So I record a **stated-rule** defect, not a measured wrong
answer.

**Exact minimal resolution (documentation-only is acceptable).** Restrict the
sentence in `commands.ts:600-606` and in the guide paragraph
(`AGENTS.md`, "unless the written literal … is null or another parent's key,
which is disjoint as the target overlap is") to what it actually licenses: *a
write that cannot make this row a member of this parent is disjoint for a read
that asks whether it became one; a write that can take it OUT of the membership
is observed through the target overlap.* If that second half is not in fact
guaranteed for every member-side field write, the `null` / other-key branch
should simply be dropped — an observation costs a placement, not a refusal,
which is this unit's own argument for the junction rule.

### F4 — CONFIRMED, minor. Two factual inaccuracies in the note

- §4 says "the pin file clean". `npx biome check
  tests/raptor3/g4/parity/ordered-observation.test.ts` reports **2 errors**,
  both `lint/performance/useTopLevelRegex` (`:363:31`, `:366:19`). The sibling
  pin `lane-x-set-mutations.test.ts` is at 0, so this is not house noise. Hoist
  the two literals or correct the sentence.
- §4's Biome counts for the source files do not match: measured
  `commands.ts` 2, `execution.ts` **3** (note: 4), `operation-context.ts` **4**
  (note: 6), `selection.ts` **4** (note: 5), `assignments.ts` 5. The
  load-bearing claim — *identical to HEAD, category by category* — **holds** for
  all seven changed source files (see the table below); only the numbers are
  wrong.
- §4 lists "six touched source files"; `git diff --name-only e772741eb -- src`
  names **seven** `.ts` files (`relation-body.ts` and `query.ts` included).

---

## The seven questions

**(1) Is the execution-point computation in `depend` correct for every shape the
pins name, and what shape would break it?**
The computation is correct: `runsBefore` (phase, then index) is exactly the
order `CommandExecution.run` executes (`execution.ts:292-366`: `before`
children, the record's write, `capture`, `after`); `writeAt`'s walk to the
membership carrier is the right execution point for a published key; and the
`follows`/`landing` arithmetic keeps a moved read behind its producer and ahead
of the first `after` effect of its own or a later mutation. Measured: 36/36
pins, and 109 `depend` calls across 8 suites in which every move preserved its
array index. **What breaks it is not the computation but the move's side effect
on the array being iterated — F1**, whose smallest witness is a root with two
parent-held to-one relations where the first one's subtree reads what the
root's own write changes.
One asymmetry I could not reach and therefore only record: the `consumed` guard
(`commands.ts:933-937`) asks `ancestor.command.fields.consumes(consumer.command.fields)`
only when `consumer.command.kind === "choose"`. A parent-held nested **record**
create whose key the ancestor's own write consumes is not covered by that
clause; a `create` body admits no verb that produced such a dependency in my
probes (a nested `connect`'s lookup is `membershipOnly` and `readTarget`
returns), so I did not reach it. If it is reachable it is the same class of
defect as the sentence the unit deliberately keeps.

**(2) Does the barrier keep the premises that protect the queued writes?**
**Yes — the note's claim holds.** `TransportAttempt.withholdPremises`
(`shared/transport-attempt.ts:60-66`) walks back from the END of `pending` while
the statement is a premise and splices off only that trailing run; anything
stated ahead of a queued write stays in the dispatch with it. The observation's
own premise is queued *inside* `flushQueued`, after `withholdPremises` has
already run and before the projection, so it is never trailing and always rides.
`flush` is therefore the right barrier and no second reader is needed; the
plan's §1 refinement is correct. The one caveat is F2 (the degenerate
empty-queue path ignores the premise argument).

**(3) Is the ladder's blind-premise attribution sound, and when could it
attribute the wrong premise?**
Sound under its two guards. It runs only for an *unindexed* `NestedWriteAssertionError`,
only when the re-probe cleared every premise, only when `!mayCollide`, and only
when exactly one premise stands behind the first non-premise statement; the
position claim below it is separately bounded by the **last** premise
(`operation-context.ts:1316-1329`), so a batch with writes ahead of the
attributed premise is never read as "dispatched no write". Premises stated ahead
of the writes are genuinely re-probable (the rollback restores exactly the state
they saw), which is what makes the elimination legitimate.
The window in which it names the wrong premise: **an ahead-of-writes premise
that did fire and whose subject was put back between the abort and the re-probe**
— a concurrent writer that reverted, or a continuation guard
(`operation-context.ts:1155-1163`, guards are registered as premises too) whose
row was deleted and re-inserted. That is the same window the pre-existing
`soleGuard` inference already accepts, and the ≥2 case still falls to the floor,
so I do not call it a defect. One naming caveat: `firstWrite` is computed as
"the first statement that is not a premise", which is a *write* in every batch
shape the engine builds today but is not checked to be one; a batch whose first
non-premise statement were a read would make every later premise "blind".

**(4) Is the membership-field rule's literal disjointness safe — when does
`literalOf` answer a literal that is not the executed value?**
`literalOf` (`commands.ts:966-996`) is conservative in the cases I could reach:
it follows `assignment.producer` only through **ancestors** of the write's
occurrence, so a producer that is a sibling (a nested create publishing a key
upward) yields `undefined` and the pair stays non-disjoint — I measured this
(probe D1, `author: { create }` publishing `userId` at the root: no literal, so
the read is ordered). Its two risky answers are (a) `located.facts.equals`,
which is the row the producer *will be located by* rather than a written value —
correct only because `exact` is required — and (b) a producer whose record
occurrence is an arm of a `Choose`, where the arm that runs is decided at
execution; I did not reach that case.
The real issue is not `literalOf` but the rule it feeds: the disjointness is
one-directional — **F3**.

**(5) Does a mutation's per-entry origin change any ORDER the retired contracts
pinned?**
Not the *execution* order, by construction: `run` filters children by placement
phase, and the per-entry renumbering changes only how the phases interleave
inside `parent.body`, never the within-phase index order (entry 1's `before`
still precedes entry 2's `before`, entry 1's `after` still precedes entry 2's
`after`). What it does change — intentionally — is the array-index order that
`visitPrecedingWrites` walks, which is how a later entry's read now sees an
earlier entry's write at all.
Two pinned orders did genuinely move, both because of the new *rules* rather
than the renumbering, and both are re-expressed with a derivation: the
sixteen-cell G3P-05 variant ordering (`variant-collection-order.test.ts` now
separates *existence guards* — which still precede every clear — from
*membership observations*, which follow the clear and the link of their own
junction and precede the effects), and the transitions' bodies
(`singular-lattice.ts` drops the `own-write` outcome for a named
`delete-adopt-modify` end state). Confirmed by `Raptor 3 fixed` 796/796 and the
two shared-family files 34/34 and 30/30.

**(6) The 102 re-expressions — spot-check for expectations independent of the
candidate.**
I read 12+ cells across the three rounds and cross-checked them against the
actual diffs: round 1 root-dependency ("after-parent self connectOrCreate
observes the current insert", "missing top-level upsert observes its
create-branch insert", "root id transition frees the old id", "root id
transition is observed under its new id", "payload update is observed by a
recursive m2m deleteMany filter", "nested to-many update frees its old
selector", "nested to-one update executes its child identity transition",
"overlapping update array applies both members in order", "overlapping upsert
array applies both members in order"); round 3 (`vacate-substrates` E6.5 both
substrates, `supplier-continuation` "delete + connect + update" both substrates,
`create-junction-upsert` M7 both items); plus the m2m diff cells ("string-selector
array connects the found member and creates the unknown one", "overlapping set
and deleteMany", "connectOrCreate then deleteMany", "explicit delete then
deleteMany", "disconnect then deleteMany"), `member-scope.contract.test.ts`'s
surrounding-read scenario and `singular-lattice`'s new outcome.
**No cell copies the measured state.** Each names the rule (canonical verb
order, per-entry mutation, rule 3's correlated refusal, rule 4's consumed read,
the barrier) and derives an end state from it; the "before" expectation is
quoted; a derivation that disagreed with the measurement was filed as a
disagreement and became a defect. Every changed test file carries at least one
`N1 (D-51)` rationale comment (22 files, 5–16 each). The rounds also flag their
own limits honestly, including one that matters for anyone re-running the work:
`scripts/bounded-process.mjs` never reads the `cwd` it is handed, so the
scratchpad `run-shared-family.mjs` runs wherever the shell is — my own runs
print `RUN … /private/tmp/viborm-n1`, so they measured this worktree.

**(7) The two "moved" cells and the N3c class.**
The note's §5 account is right. `receipts/estate/cells-vs-n3-head-final.txt`
line 42-43 shows exactly two moved cells, both red at the N3 head and still red:
`shared-pk-update-root` (PGlite atomic batch) moved from the V7006 floor
("Nested write assertion failed: a batch precondition …") to the correlated
`Cannot update relation 'chits': target record was not found` — that **is** the
ladder's blind-premise attribution doing what §2 claims — and
`relation-key-update-legality-transition-arm` moved from `NestedWriteError` to
`NotFoundError`, i.e. the child-held lookup now answers "not found" at the root.
Both routes now agree on the wrong answer, and the note says so and leaves the
class to the next unit, which is the honest disposition. One precision nit: §4's
one-line summary ("two moved … from the V7006 floor to the correlated sentence
through the ladder's blind premise") describes only the first of the two; the
second is a floor-free `NotFoundError`. §5 states it correctly.

---

## What I ran

All runs with `TMPDIR=/private/tmp/viborm-n1-review-tmp`, one vitest process at
a time, in `/private/tmp/viborm-n1` unless stated.

| # | Command | Expected | Measured |
| --- | --- | --- | --- |
| 1 | `node scripts/run-vitest-safe.mjs tests/raptor3/g4/parity/ordered-observation.test.ts` | 36/36 | **36 passed (36)** |
| 2 | `pnpm test:all --only "Raptor 3 fixed"` | 796/796 | **796 passed (796)**, 69 files |
| 3 | `run-shared-family` (worktree-scoped copy) `…/nested-write-conformance-m2m.test.ts` | 34/34 | **34 passed (34)**, `RUN … /private/tmp/viborm-n1` |
| 4 | same, `…/nested-write-conformance-membership.test.ts` | 30/30 | **30 passed (30)** |
| 5 | `node scripts/run-typecheck.mjs` | 0 | **exit 0** |
| 6 | FALSIFY: pin file copied into a detached worktree of `e772741eb` (`pnpm install --frozen-lockfile --prefer-offline`; `better_sqlite3.node` already present) | pins red at base | **27 failed / 9 passed (36)** |
| 7 | Biome, head-vs-work scratch copies of all 7 changed source files, category by category | identical | **identical, category by category** |
| 8 | Probes A–F under TMPDIR (own vitest config, aliases only) | — | F1/F2 divergence (finding F1); D1–D4 no defect; A/B2 a *pre-existing* `membershipOnly` blind spot, identical at the base |
| 9 | Prototype-wrapper instrumentation over `tests/raptor3/**/*.test.ts` (2 162 cells) | — | **0 skipped children** |
| 10 | Simulated fix (snapshot iteration) over pins + `g29-*` + `selector-dependencies` + `lane-x-set-mutations` | green | **87/87**, and F2 batch == F2 live |

### Run 6 — how the pins fail at the base

27 of 36 red. Every red is the sentence the unit reverses:

| reason at `e772741eb` | cells |
| --- | --- |
| `'delete' on relation 'edited' depends on an earlier 'update' target write` | 13 |
| `'update' on relation 'nodes' depends on an earlier 'update' membership write` | 3 |
| `'set' on relation 'posts' depends on an earlier 'connectOrCreate' target write` | 3 |
| `'deleteMany' on relation 'tags' depends on an earlier 'connectOrCreate' target write` | 3 |
| `'connect' on relation 'editor' depends on an earlier 'create' target write` | 3 |
| `Nested write assertion failed: a batch precondition …` (the un-premised found requirement, batch routes) | 2 |

The 9 green at the base are the shapes the unit does not change: the kept
refusal ×3, the disjoint capture ×3, the array route (live), and the found
requirement on live and on the ordinary batch-only driver. Note that the found
requirement cell only falsifies on the **no-index** transport — on the two other
routes it is green at the base, so one of its three route instances is not a
falsifier of the premise claim.

### Run 7 — Biome, head vs work

`biome.jsonc` + `node_modules` symlink in a scratch root, HEAD and working
copies of each file at identical relative paths.

| file | head | work |
| --- | --- | --- |
| `commands/assignments.ts` | 5 `style/noParameterProperties` | same |
| `commands/commands.ts` | 1 `style/noParameterAssign`, 1 `style/noParameterProperties` | same |
| `commands/execution.ts` | 1 `complexity/noCommaOperator`, 1 `style/noParameterProperties`, 1 `style/useDefaultSwitchClause` | same |
| `commands/relation-body.ts` | 1 `correctness/noUnusedVariables`, 5 `style/noParameterProperties` | same |
| `commands/selection.ts` | 4 `style/noParameterProperties` | same |
| `shared/operation-context.ts` | 4 `style/noParameterProperties` | same |
| `shared/query.ts` | 4 `complexity/useSimplifiedLogicExpression`, 3 `correctness/noUnusedFunctionParameters`, 1 `correctness/noUnusedVariables`, 4 `style/noParameterProperties`, 2 `style/useDefaultSwitchClause` | same |

The pin file is **not** clean: 2 `performance/useTopLevelRegex` (finding F4).

---

## Against ELEGANCE and the twelve rules

- **One owner per fact.** Kept. The overlap is still computed in one place and
  now spent in one place (`depend`). `CommandOccurrence.placement` becoming
  mutable is the honest cost and is documented at the field.
- **No policy boolean.** Kept in the consumers: `runSelection` branches on
  `selection.dependent`, a fact about the read, not a mode. `Commands.expanded`
  is the closest thing to a mode flag; it records "execution has begun", is
  per-plan (`commands/index.ts:183,200,257` construct a fresh `Commands`), and
  earns its place — but it is the one place a reviewer should look again if the
  refusal it gates ever fires in practice.
- **No second reader.** Kept, and *proved* rather than asserted: the
  `withholdPremises` reading is correct and the plan's "not `flush`" is rightly
  withdrawn.
- **Capability is not authority.** Violated once, narrowly: `execution.ts:437`
  retires the JavaScript found-requirement check on `ctx.usesBatch` (a
  capability) rather than on the premise having been asserted (the fact) —
  finding F2.
- **An observation is not a lasting requirement.** Kept: the junction rule
  refuses to compute the overlap finer than the table precisely because a
  placement is cheap, and the note says so.
- **Removing a refusal makes previously unreachable paths reachable.** Taken
  seriously — the eight-agent re-expression is the right instrument and it
  produced a real defect list. F1 is the class it did not catch, because no
  recorded expectation covers two parent-held to-ones on one root.

---

## Unverified

- No Docker lane (MySQL 3307 / PostgreSQL 5434) run; no Neon HTTP, no D1. The
  note records the same gap; D-53 makes the transport claims per-driver.
- The committed-segment behaviour of a dependent read on a genuinely batch-only
  *driver* is measured only on the SQLite/PGlite batch-only fixtures.
- F2's reachability: I could not construct a query that reaches `flush` with
  `queued.length === 0` while `premised` is true. The hole is read from the
  code, not measured.
- The `consumed` guard's missing `record` clause (question 1): read from the
  code, not reached.
- `literalOf` following a producer that is an arm of a `Choose`: not reached.
- The three cells the note leaves red in the touched files (`create root
  barrier` ×2, `createMany duplicate PK …`) were taken from the note's own
  receipts; I did not re-measure them at the base.
- The whole-estate comparison (`receipts/estate*`) was read, not re-run; my
  independent estate evidence is runs 1–5 and 9 only.
- Coverage thresholds (`query-engine-core` 88.06/91.21/91.06/88.06) not re-run.
