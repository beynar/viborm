# Release unit "n1" — a dependent lookup is an ordered observation (D-51)

Worktree `/private/tmp/viborm-n1`, branch `n1` from `e772741eb` (N3). Owner
files: `commands/commands.ts` (the decision), `commands/execution.ts` (the
read at its point), `shared/operation-context.ts` (the barrier's
requirement), `commands/selection.ts` (the mark), `commands/assignments.ts`
(the consumption test), the guide. Pins:
`tests/raptor3/g4/parity/ordered-observation.test.ts` (13 cells × 3 routes).
Briefs: `brief-n1.md` (the integrator's), `brief-reexpress.md` (the eight
per-file agents').

## 1. The truth, and what the code did with it

The dependency pass (`checkPair` → `readTarget` / `readMembership`) computed
the overlap between a nested lookup and an earlier write of the same
operation — disjoint, equal, unknown — and spent every non-disjoint answer on
DESIGN §6.2's mode-independent veto: "depends on an earlier … write … Split
these operations into separate queries", 21 sites in the estate's pins,
inherited by both routes so that live and batch execution could never
disagree. D-51 drops that uniformity: any nesting executes, through the
mechanism each route has. Two facts, both measured before a line moved
(`receipts/probe1/`, the dependency map under `../plan/dependency-map.md`):

- On the live route the veto protected nothing: `CommandExecution.run`
  dispatches children in order, so a lookup placed behind the write it
  depends on already reads the written state inside the transaction.
- On the batch route the veto was load-bearing: `runSelection`'s raw
  `OperationContext.read` dispatches at once while the earlier write is still
  queued, so a dependent read raced ahead of it and answered a false
  absence (the relation body's "target record was not found").

## 2. The rule, and its owners

*A nested lookup whose answer an earlier write of the same operation can
change is taken at its consumer's execution point, after that write, with the
premises that protect the write riding the same unit.*

- **`Commands.depend`** (the three refusal sites now call it): the write's and
  the read's execution points are the two children of their nearest common
  ancestor on each path — the ancestor's OWN write when the write is the
  ancestor's or a membership its fields carry — in the run order of
  `CommandExecution.run` (`before` children, the record's write, the
  captures, the `after` children, each in body order). The read's point is
  the occurrence that RUNS it: its early `before` lookup or its `capture`
  when one is placed (`reader()`, matched through the materialized
  `captureTarget`), else the read's own occurrence. A read already behind its
  write is only marked `Selection.dependent`. A read that would run first
  moves to the `after` phase, to its consumer's execution point: behind the
  write, ahead of the first `after` effect of its own or a later mutation, by
  origin order (every effect carries its mutation's origin — see the repairs
  below for the two shapes that taught this). `CommandOccurrence.placement`
  is mutable for exactly this move. A mutation never depends on its own
  effects, which stand behind its read by construction. The one shape no order satisfies — a read
  the ancestor's own write CONSUMES (`Assignments.consumes`: a parent-held
  target's key) — keeps the inherited sentence, unchanged text and meta,
  which now names exactly that: an earlier write the read cannot follow (the
  retired engine's "vacate then supply" parent-held answer,
  `tests/contracts/engine/write/vacate-then-supply-parent-held-refused.test.ts`).
  Once members are expanded (`Commands.expanded`, set by `expandSeries`)
  nothing moves: a read placed by construction is already behind every
  template write it may depend on, and the expansion pass only marks.
- **`CommandExecution.runSelection(selection, member, premise?)`:** a
  dependent read on the batch route goes through `OperationContext.flush(query,
  member, premise)` — the barrier that submits the queued unit and reads in
  the same native batch, behind the writes. Nothing changes on the live route.
- **`OperationContext.flush(query, member, premise?: ObservationPremise)`:**
  what the consumer requires of the row — present (`selection.required`), or
  no row outside a membership (an upsert's found requirement) — is asserted
  INSIDE the batch, ahead of the projection (`requirePresent` / `requireAbsent`
  in `flushQueued`), so a target that is not what the consumer needs aborts
  the batch before anything commits and the correlated refusal surfaces with
  nothing durable — the live route's rollback, on the batch route. The plan's §1
  asked for "a barrier that submits the queued unit with its premises — not
  `flush`, whose premise-withholding is right for a planning read and wrong
  here"; reading `TransportAttempt.withholdPremises` settled it: the withhold
  steps aside only the TRAILING premises (those stated after the last queued
  statement, protecting writes not yet queued — D-29's own reason), while the
  premises stated ahead of the queued writes ride with them. That is exactly
  the observation's requirement, so `flush` is the barrier and no second
  reader exists; the plan's wording is refined here, not the mechanism.
- **The body order is the relation body's canonical verb order**, not the
  payload's key order — `collectionMutationOrder` for a to-many (`disconnect,
  delete, update, upsert, connectOrCreate, set, updateMany, deleteMany,
  connect, create, createMany`), `mutationOrder` for a to-one — relations in
  declaration order. "An earlier write" means earlier in THAT order: inside
  one to-many relation `delete` runs before `update`, so "update then delete
  by the written field" is not a dependency and refuses honestly ("not
  found"), while `posts.update` then `edited.delete` (a second relation on the
  same target model) is one. The pins say so in their comments.
- **The array route** keeps refusing a member that needs a dynamic read
  (D-46, `preparesBatch`; the pin's "does not support callback transactions").

**What the reachable paths demanded** (ELEGANCE "Removing a refusal makes
previously unreachable paths reachable"): eight Opus agents re-expressed the
recorded expectations one file group each (`brief-reexpress.md`, deriving
each cell's end state from the contract before measuring), and their
disagreements — a measured state that contradicted the derivation — were
this unit's defect list. Each was repaired at its owner; the pins gained a
cell per repair (§4):

- *A membership contribution executes with the record whose fields carry
  it.* A parent-held choice publishes the parent's key for the parent's own
  UPDATE, so the write's execution point is that record, not the publisher;
  `depend` walks to the carrier (`writeAt`). A parent-held choice whose
  subtree reads what the parent's own write changes now moves behind that
  write (the measured shape: a node moving containers while updating a node
  of the container it will reference).
- *The landing of a moved reader is its consumer's execution point.* Behind
  the write, ahead of the first `after` effect of its own or a later mutation
  — by origin order, which `Link` and `Removal` now carry (they had none, and
  "behind the write" alone landed a junction capture between a create arm and
  its link, and a set's target lookup behind the set's own clear). A set's
  target lookups share the set's origin (`setTargets(edge, selectors,
  origin)`), so the clear that keeps the row they name runs behind them; the
  measured defect was `NOT ("id" = NULL)`, a clear that kept nothing.
- *A junction membership is observed too.* `readMembership` returned on
  every junction edge, so a capture or a lookup reading a junction membership
  was neither refused nor placed and stayed ahead of the set, disconnect or
  link that changed it — a disconnect followed by a `deleteMany` destroyed
  the row the caller had only disconnected. Now any link, removal or member
  set of the same junction TABLE (either side, any parent; a self-referential
  inverse is the same rows) makes the read an ordered observation; the
  overlap is not computed finer than the table, because an observation costs
  a placement, not a refusal.
- *A membership is read through fields.* A record write of the member side's
  foreign key (a self-held key, a scalar rebind) or of the parent's
  referenced key (a key transition with a cascade) changes what a membership
  read observes, and `readTarget`'s selector overlap never sees those
  fields; `readMembership` now does.
- *A mutation never depends on its own effects*: a junction delete's link
  removal, a set's clear — placed behind the read by construction; the
  junction rule had made a delete's lookup follow its own removal.
- *The found requirement rides the observation's batch.* An upsert's
  found-but-not-a-member refusal was a raw read after the barrier, so on a
  batch-only transport the parent's own disconnect had already committed
  when the refusal came (the live route rolled it back). `ObservationPremise`
  replaces `flush`'s requirement thunk: a row present, or NO ROW OUTSIDE the
  membership (`Selection.outsideMembership`, `Queries.outsideWhere`) —
  NULL-safe, because a plain negation of the member predicate answers NULL
  for a member-side column the write just cleared and selects nothing; the
  choose case asks no second time when the premise rode.
- *The one premise the rollback hides.* A premise stated behind the unit's
  own writes (an observation's requirement the unit's own delete or
  disconnect falsified) is not re-probable after the rollback that preceded
  the ladder's re-probe: the row is back, and the ladder fell to the V7006
  floor while the live route gave the correlated V7001. When every premise
  ahead of the writes holds now and exactly one stands behind them, the
  ladder attributes that one — the sole guard's inference applied to the one
  premise the rollback hides (N3's owner, `operation-context.ts`). Two or
  more behind the writes stay the floor, honestly.

**Not repaired, recorded.** The live route's D-25 region recovery re-plans
ANY rejected insert once (the batch route's is bounded by member admission);
a plain nested create whose key duplicates a row is planned twice on the live
route, its members admitted again, and fails again — D-25's documented
asymmetry, not a defect; the g29 nested-series cell's id default is now
deterministic so both plans collide the same way. The inverse to-one
`connect` over an occupied unique slot does not vacate the incumbent (the
engine's general answer is the database's unique violation, measured on a
plain `station.update({ badge: { connect } })`); the cell that pinned the
veto for that shape now pins that integrity answer.

**Case 2 of the plan (the established producer)** is not landed as a
mechanism: an ordered observation answers every such shape correctly (the
read lands behind the producer and finds the row), the existing
producer-sourced selection keeps serving `connectOrCreate`'s
first-create-wins, and the scratch leg the plan sketched is an optimisation —
one read fewer on the batch route — whose cost it would have to justify by
measurement. Recorded as a plan refinement (§6), not a deferral of behaviour.

## 3. Hunks

`commands.ts` (`depend`, `reader`, `runsBefore`, `literalOf`; `placement`
mutable; `expanded`; `Link` and `Removal` carry `origin`; `origin()` covers
them; the three refusal sites call `depend` with their sentence;
`readMembership` gains the junction rule and the membership-field rule with
literal disjointness), `execution.ts` (`runSelection(selection, member,
premise?)`, the barrier for a dependent read; `member` threaded from `run`;
the choose case premises its found requirement and asks no second time),
`operation-context.ts` (`ObservationPremise`; `flush`'s `premise`, asserted
in `flushQueued` ahead of the projection; the ladder's blind-premise
attribution), `selection.ts` (`dependent`, `outsideMembership`), `query.ts`
(`outsideWhere`; `select`'s membership `outside`), `assignments.ts`
(`consumes`), `relation-body.ts` (one origin per payload entry, `entryOrigin`;
a set's targets share the set's; removals and links record their origin),
`AGENTS.md` (the contract paragraph replaces "`readTarget`'s refusal is
untouched" and "Do not merge the passes"); the pin file (12 cells × 3
routes); the re-expressed expectations (§4). Nothing deleted: the two
sentences stay for the cycle class; the `program/` specimen and its
comparison harness (`tests/raptor3/candidate*.test.ts`, 48 cells in the fixed
stage) are a separate commit — deleting them is not this unit's behaviour
change and touches the G0 replay harness.

LOC (`git diff --numstat e772741eb -- src`, `receipts/numstat-src.txt`):
commands.ts 365 / 37, operation-context.ts 71 / 7, execution.ts 54 / 15,
relation-body.ts 36 / 5, query.ts 33 / 2, selection.ts 22 / 0,
assignments.ts 6 / 0, the guide 73 / 14 — production +587 / −66 with no
deletion, the cost of one rule that replaced twenty-one recorded refusals
and the paths they hid; tests and scripts per `receipts/numstat-tests.txt`.

## 4. Verification

- The pins: 24 / 24 on three transports (`receipts/probe2/pins.log`); at
  HEAD (the file copied into the main tree and removed) 17 red / 7 green
  (`receipts/probe2/pins-at-head.log`) — the seven are the kept refusal, the
  disjoint capture and the array route, which the unit does not change.
- The pins: 39 / 39 (13 cells × 3 routes) — the eight contract cells, the
  four the repairs demanded (§2) and the one the review demanded (the
  sibling behind a moved parent-held choice).
- The recorded expectations the unit changes, re-expressed by Opus agents,
  one file group each, deriving the end state from the contract BEFORE
  measuring (`brief-reexpress.md`; `receipts/reexpress/round1.md`,
  `round2.md`, the structured reports as JSON): round 1, eight groups — 72
  cells re-expressed, 10 newly green, 4 disagreements that were this unit's
  defects (§2); round 2, four groups after the repairs — 12 re-expressed, 2
  newly green, 3 disagreements that were the last defect (the membership
  rule's disjointness); round 3, five groups after the whole-estate pass —
  13 re-expressed, 1 newly green, no disagreement: the retired engine's
  write contracts (`vacate-then-supply-substrates`, `-pair-lattice`,
  `supplier-continuation`, `create-junction-upsert`: "delete + connect +
  update" on a child-held to-one slot, the six vacate + supplier + modify
  triples, two upsert items on one relation, an upsert beside a
  connectOrCreate) and the generated-transition recipes (`coc-set-same`,
  `delete-update`, seed 2007, the exact admitted seed batch) — the retired
  engine's own refusals of shapes D-51 executes. The integrator re-expressed
  five more by hand: `g2-own-coc-set-same` (executes),
  `g2-own-filter-write-refused` (the database's unique answer), the g29
  nested-series live cell (a deterministic default, D-25's one re-plan), and
  the two lane X pins of U6.2 / U6.3 (a relation-bearing `updateMany`
  observes the sibling update; a connectOrCreate adopts the row an earlier
  entry happened to create). 102 cells in all; every
  pre-existing red cell of these files is reported per cell in the rounds'
  reports, and the fourth, fifth and sixth probes (`receipts/probe4-6/`)
  measured the repairs one by one until the touched files were green but for
  the three cells red at the base (`create root barrier` ×2,
  `createMany duplicate PK …`): the fixed stage 796 / 796, the pins 36 / 36,
  the six conformance files 30 / 30, 34 / 34, 28 / 30, 31 / 31, 27 / 28,
  19 / 19, the touched SQLite files 172 / 172, typecheck 0.
- The whole extended-local estate per shard, the provider stage, the three
  modes, typecheck, the core lane and the floors, compared with the N3 head
  by cell identity and message (`receipts/estate/` the first pass,
  `estate2` the two ordinary shards re-run with the lane X pins and the
  fourteenth shard the runner list had missed, `estate3` and `estate4` the
  shared-family shards that hold the round-3 files, the final comparison
  `receipts/estate/cells-vs-n3-head-final.txt`, the instrument
  `compare-cells.py.txt`): the shared-family estate 137 → 97 failing cells —
  40 newly green, NONE newly red, two moved (the N3c class, §5: the shared-PK
  batch cell from the V7006 floor to its correlated sentence through the
  ladder's blind premise, the transition-arm cell from the internal class to
  `NotFoundError`);
  the imported-PGlite shards 2 / 2 unchanged; the fourteen ordinary shards
  green; the provider stage, g2-baseline and g2-contracts 216 / 216,
  g3-transaction-array 4 / 4, core 8,434 / 8,434, typecheck 0;
  query-engine-core 88.06 / 91.21 / 91.06 / 88.06 over 87 / 91 / 90 / 87
  (part 4, the coverage-raptor3 project, red until round 3 re-expressed the
  generated-transition recipes), the coverage policy green.
- Biome on the seven touched source files: identical to HEAD, category by
  category (`receipts/biome.txt`, the categories per file before and after);
  the pin file clean.

**Independent review (Opus, `review.md`): REVISE** — one major and three
minor findings, each resolved here: (1) `depend` moves a child within
`ancestor.children` while `analyzeOccurrence` walks that array with
`for…of`, so a sibling shifting into the vacated slot was never analysed
and its dependent reads went unmarked (measured: a second parent-held
subtree behind a moving parent-held choice answered "not found" on the
batch route only) — the three walks iterate a snapshot, and the shape is a
pin; (2) `flush`'s degenerate path (nothing queued) ignored the premise
while the choose case trusted the capability — an absence premise is now
checked directly on that path, and a presence premise is the observation
itself (its query is the projection; an empty answer is the absence the
consumer refuses); (3) the membership rule's literal
disjointness was stated for every write while it holds only for a CREATE
(an update of the member-side key may take a member out) — restricted to
creates, in the code and the guide; (4) the note's Biome sentence counted
wrong and the pin file carried two inline regexes — hoisted, and the
receipt `receipts/biome.txt` replaces the counts. Re-verified after the resolutions
(`receipts/probe8/`): typecheck 0, the pins 39 / 39, the fixed stage
796 / 796, the generated transitions 94 / 94, the six conformance files as
before (30, 34, 31, 28 / 30, 27 / 28, 19), the touched SQLite files
211 / 211, Biome identical to HEAD on the seven source files and the pin
file clean (`receipts/biome.txt`). `receipts/probe7/` is the first run of
that chain, red from a misplaced `continue` and an accidental whole-file
reformat of `operation-context.ts`, both undone — the file rebuilt from HEAD
plus this unit's hunks — before the second run. **Re-check (`review-round2.md`): ACCEPT** — the four resolutions confirmed applied and re-verified (the F2 probe answers identically on the three routes; the observation-count cells green on the final shape of the degenerate path; the Biome receipt reproduced line for line).

## 5. Still red, unverified, blockers

Still red: the rest of the gate — among it the N3c class this unit was
expected to close and did not: the relation-key legality cells and the
shared-PK update root cells under a parent key transition (`relation-key-
update-legality-transition-arm` "allows primary-key arithmetic transition
with cascade upsert", `shared-pk-update-root` "update publishes the target's
post-update key"), where the child-held lookup names the parent's post-write
key and answers "not found" on BOTH routes now (the batch route's floor
became the correlated sentence through the ladder's blind premise, so the
two routes agree on the wrong answer); the observation lands behind the
parent's write, but the membership it is read with is the post-write
assignment of a key the cascade moves, and that value's timing is the
relation body's convention (N3c's withdrawn finding, `parent.fields` for the
nested update alone) — the next unit's fact, not this one's. And three cells
of the touched files that were red at the base and are not this unit's (`create root barrier` ×2 in
`nested-write-conformance-root-dependency`, `createMany duplicate PK rolls
back parent and prior children` in `-fk` — the batch-only atomicity gap the
gate triage recorded). Unverified: no Docker lane re-run (PGlite and SQLite
carry the pins; the observation's barrier and premises are SQL the batch
transports already dispatch); Neon HTTP and D1 keep no transport witness of
their own (D-53), so a dependent read's committed segment on a batch-only
transport is measured here on the SQLite and PGlite batch-only fixtures.
Known, by design: on a batch-only transport a dependent read commits the
segment before it, and a later integrity failure leaves that segment
durable, reported as the operation's progress (D-51's succession of
statements; the conformance oracle's byte-identical state holds where the
observation's premise aborts the batch, and the g29 nested-series batch cell
pins the durable segment). Blockers: none.

## 6. Plan refinements recorded here

1. §1's "not `flush`" — `flush` IS the barrier (its withhold is trailing
   premises only); the observation's `required` row rides the batch as a
   premise ahead of the read.
2. §1's "declared order" — the relation body's canonical verb order, then
   relations in declaration order; the pins and the guide say it.
3. §1's case 2 — an observation answers it; the scratch leg is an
   optimisation to be justified by measurement, not a behaviour.
4. "What disappears" — the two sentences are NOT deleted: they stay for the
   one shape no order satisfies (the parent-held key the own write consumes),
   the retired engine's own answer there; the dead specimen is a separate
   commit.
