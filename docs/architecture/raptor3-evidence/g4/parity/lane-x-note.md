# Lane X — execution, membership, races, route seam

Author: lane X agent, 2026-09-17. Worktree `/private/tmp/viborm-parity-x`
(branch `parity-x`, base `356254a2`), TMPDIR `/private/tmp/viborm-parity-tmp-x`.
Plan: `docs/architecture/raptor3-parity-plan.md` (decisions D-17..D-24 accepted).
Units in order: U6.1, U6.2, U6.3, U6.4, U6.5, U6.6, U5.5, U7.1, U7.2, U7.3,
U7.4, U8. Receipts: `docs/architecture/raptor3-evidence/g4/parity/receipts/lane-x/`.

Every gate below was written BEFORE the unit's first edit.

---

## U6.1 — junction orientation by slot

**Decision-elimination gate (written before the first edit)**

- **Required behaviour.** A junction membership view for slot `(model, name)`
  binds the junction's two sides to that slot's own direction. On a
  self-referential many-to-many (`User.follows` / `User.followedBy`) both
  endpoints name the same model, so the model cannot decide the direction;
  only the slot can. `u1.follows.connect([u2,u3])` must read back as
  `u2.followedBy === ['u1']`.
- **Current owner.** `src/query-engine/raptor3/shared/storage.ts:164`
  `const forward = topology.source.model === source;` — verified in the
  worktree. On a self relation this is `true` for BOTH legs, so
  `followedBy` is bound with `follows`'s sides and answers the rows the parent
  follows (none). The same function already gets the FK case right by slot at
  `:151` (`edge.owner.source === source && edge.owner.field === name`), and
  `opposite` at `:138-141` already computes the slot identity.
  `resolveOrdinaryPair` (`src/schema/validation/relation-resolution.ts:654-659`)
  builds `endpoints = [first.node.slot, second.node.slot]` and
  `resolveJunctionEdge` (`:797-812`) builds `topology.source` from
  `first.node.slot.source` and `topology.target` from `second.node.slot.source`,
  so `endpoints[0] ↔ topology.source` and `endpoints[1] ↔ topology.target` by
  construction.
- **Proposed change.** One expression: `const forward = opposite === edge.endpoints[1];`
- **Invariant.** A junction side is chosen by the asking SLOT, never by the
  model: a self junction names one model on both sides and only its two fields
  tell the directions apart.
- **Falsifier.** `sqlite3-nested-write` › many-to-many write behavior ›
  `self-referential many-to-many round trip`
  (`tests/contracts/drivers/behaviors/many-to-many-behavior.ts:580-617`):
  `u1.follows === ['u2','u3']`, `u2.followedBy === ['u1']`, and after
  `disconnect {id:'u2'}` `u1.follows === ['u3']`.

**Receipt.** `receipts/lane-x/u6.1-self-m2m-sqlite3.log` — 1 passed. The other
84 cells of the file are vitest's `-t` filter, not `.skip`. The full-file run
before the edit had 11 failures including this cell; after it, 10 (all family-5,
U6.2/U6.3, and the lane-Q JSON-envelope cells).

---

## U6.2 — a nested set mutation is one correlated statement

**Decision-elimination gate (written before the first edit)**

- **Required behaviour.** A nested `updateMany`/`deleteMany` whose `data`
  carries no nested relation write is ONE correlated set statement, at its own
  position in the declared body order, so `{ posts: { update: {…}, updateMany:
  { where: { title: "Queued" } , … } } }` updates the sibling the earlier
  `update` did not move, and `{ posts: { delete: {…}, deleteMany: {…} } }`
  removes only this parent's remaining children. A relation-bearing
  `updateMany` still captures, and a genuine feedback loop still refuses.
- **Current owner.** `commands/relation-body.ts:536-601` (verified): EVERY
  nested `updateMany`/`deleteMany` member opens a plan-time `lookup` plus a
  `SelectedSeries` and a `captureSeries`; `commands/execution.ts:305-309`
  (verified) then runs ALL `capture` children before ALL `after` children, so
  the capture reads BEFORE the earlier sibling verb's write. `readTarget`
  (`commands/commands.ts:568-645`) is honest about the read it is shown and
  refuses (`:634-645`). The old engine compiled the same shapes as one
  correlated statement with no read at all: `RelationWritePart.ts:100-102`,
  `:484-504` (`buildUpdateMany`, chosen at `:353-355` when
  `updateManyParsed.relations.length === 0`), `:674-693` (`buildDeleteMany`,
  always, for the child-held-FK family), and `OwnWriteSteps.ts:186-191` /
  `:422-444` append the write footprints and assert NO read (only the JUNCTION
  `deleteMany` asserts one, `:426-439`). Both old builders pass
  `getTableName(childScope.model)` as the correlation alias.
- **Proposed change.** (1) A new command kind `set` in `commands/commands.ts`
  — a write with no read — placed by `RelationBody` at the member's own origin
  order when the edge is row-held (`kind === "reference"`, which covers a
  variant row carrier) and, for `updateMany`, the admitted `data` names no
  relation. It carries the bound membership, the parent's `Assignments`, the
  prepared member selector and the admitted scalar values. (2)
  `OperationContext.mutateMembers` composes ONE statement from the existing
  owners — `Queries.memberWhere` for the membership (the one membership
  predicate owner), `Queries.lowerMutationLimit` for the member filter (the one
  mutation-selector owner, which lane Q's U2.1 is repairing in place),
  `Queries.updateAssignment` for each value (the one update interpreter) — and
  hands it to the existing `effect()` seam, which queues it in batch mode and
  dispatches it otherwise. (3) ~~`CommandExecution.run`'s record arm runs its
  non-`before` children in ONE pass~~ — **tried, measured, REVERTED; see "the
  phase pass stays" below.**
  (4) `readTarget` and `recoveryRejection` are untouched; the new write is
  registered in `visitDirectWrites` exactly as the old `appendTarget(unknown)`
  footprint was, so a LATER read on the same model still refuses.
- **Invariant.** A nested relation mutation creates a planning read only when
  its physical form cannot express the operation as one correlated statement;
  every planning read runs at its own position in the declared body order; the
  dependency refusal fires exactly when a planning read that does exist follows
  a sibling write it cannot be proven disjoint from.
- **Falsifiers.** (a) `nested write behavior › update and updateMany keep child
  mutations parent-correlated` and (b) `… delete and deleteMany …`
  (`tests/contracts/drivers/behaviors/nested-write-behavior.ts:283-367`) on
  sqlite3 and pg; (c) a NEW statement-count pin: the nested `updateMany` emits
  ONE `UPDATE` and no `SELECT` of the members; (d) a NEW constructed feedback
  loop (a relation-bearing nested `updateMany` whose filter names a field an
  earlier nested `update` writes) still raises the registered
  `NestedWriteError`; (e) the whole `sqlite3-nested-write` and
  `pg-nested-write-races` files stay at or below their base red set.

---

## U6.3 — same-operation `connectOrCreate` duplicates

**Decision-elimination gate (written before the first edit)**

- **Required behaviour.** ATOM.md §12 "Same-operation duplicate" (read at
  `git show ff5e77ca:src/query-engine/write-engine/ATOM.md`, lines 732-737):
  "If an earlier sibling already created the target, connect-or-create applies
  first-create-wins locally. The later entry adopts that row. It emits no found
  guard and no missing race pin because the producer is inside the same
  operation." So `connectOrCreate: [{where:{id:"t9"},create:{id:"t9",name:"tag-9"}},
  {where:{id:"t9"},create:{id:"t9",name:"tag-9b"}}]` leaves ONE `t9` named
  `tag-9` and ONE association.
- **Current owner.** `commands/relation-body.ts:329-530` — the loop expands
  every entry, so the second entry opens its own decision `lookup` (`:448-468`);
  `commands/commands.ts:568-645` `readTarget` then sees that read follow the
  first entry's create and refuses. Nothing in `Commands` recognises a
  same-operation duplicate. Old owner: `OwnWriteSteps.ts:646-689`
  (`prepareConnectOrCreateItems`: `createdTargets` + `classifyTargetConstraintOverlap
  === "equal"` ⇒ `continue`).
- **Proposed change.** In that one loop, remember each entry whose `create`
  PROVABLY produces the row its `where` addresses, and skip a later entry whose
  addressed row is one of them. The two facts already exist and are already
  used together by `CommandExecution.matchesSelectedConstraint`
  (`commands/execution.ts:127-141`): `PreparedSelector.uniqueValues` (the strict
  unique selector's exact field values, compound keys expanded) and
  `Assignments.known(field)` returning a `literal`. No new analysis, no ledger,
  no change to `readTarget`.
- **Invariant.** Within one relation body, a `connectOrCreate` entry whose
  target an earlier entry provably creates is that earlier entry's association:
  first-create-wins locally, and the later entry adopts the row rather than
  deciding about it again.
- **Falsifiers.** (a) `many-to-many write behavior › duplicate connectOrCreate
  targets collapse to one association`
  (`tests/contracts/drivers/behaviors/many-to-many-behavior.ts:485-503`);
  (b) a NEW cell: two entries with DIFFERENT targets where the first's create
  satisfies the second's `where` still raises the registered `NestedWriteError`.

**Changes (U6.2).**
- `src/query-engine/raptor3/commands/commands.ts:134-154` — new `SetMutation`
  command; `:202` dependency-write union; `:231` `Command` union; `:395-401`
  `origin()`; `:733-741` `visitDirectWrites`; `:617-620`, `:641-644`, `:662-666`
  `readTarget` (the set mutation has no located row, so nothing proves a later
  read disjoint from it — the shipped `unknownConstraint` footprint).
- `src/query-engine/raptor3/commands/relation-body.ts:554-593` — the
  set-oriented branch for a row-held membership whose payload names no relation.
- `src/query-engine/raptor3/commands/execution.ts:517-527` — the `set` arm;
  `:305-320` keeps the TWO passes and now carries the measurement below.
- `src/query-engine/raptor3/shared/operation-context.ts:2306-2311`
  (`updateAssignments`, now shared with `updateMany`) and `:2312-2352`
  (`mutateMembers`).

**Changes (U6.3).**
- `src/query-engine/raptor3/commands/relation-body.ts:63-76` (`sameTarget`),
  `:333-336` (`createdTargets`), `:417-440` (the first-create-wins arm).

**Receipts.**
- `receipts/lane-x/u6.2-u6.3-sqlite3-nested-write.log` — 8 failed | 77 passed
  (was 11 failed | 74 passed at the lane's base). The three family-5 cells of
  this file are green; the 8 that remain are NOT this lane's: 7 are the
  `Unknown update operation` / envelope cells of lane Q's U4
  (`commands/assignments.ts`), and 1 is the nested default-only
  `skipDuplicates` refusal of lane Q's U1.4 (hand-over below).
- `receipts/lane-x/u6.2-u6.3-falsifiers.log` — the six new cells of
  `tests/raptor3/g4/parity/lane-x-set-mutations.test.ts`, all passing. The file
  is registered by the estate's own walk in the `extended-local` project
  (`scripts/credential-free-test-manifest.mjs:219-253`: every
  `tests/**/*.test.ts` that is not a `.core.test.ts`, not under
  `tests/providers/`, not under `tests/raptor3/g4/review/` and not named in
  `extendedLocalExclusions`). No raptor3 manifest count moved.

**The phase pass stays — measured, against §U6.2(2) of the plan.**
The plan asks for a second change beside the set-oriented compilation: run each
series' capture at its own body position instead of hoisting every capture ahead
of every effect. I made it, and it REDDENED a green cell in a way that matters:
`tests/raptor3/post-prep/g29-dependency-boundaries.test.ts` › "refuses an actual
member lookup that conflicts with an earlier sibling write". A capture FLUSHES
(`execution.ts` `captureSeries` → `OperationContext.flush`), and on the batch
route a flush COMMITS everything queued before it — so a capture placed after a
sibling effect commits that effect, and the planning refusal the capture then
raises can no longer undo it. Measured on the `sqlite-atomic-batch` profile:
with the passes merged, the earlier sibling `create` was durable
(`committedSegments: 1`, the ticket row present in the final database) before
the refusal; the interactive profile dispatched the INSERT it must not dispatch.
The hoist is therefore not a misreading of rule 6 — it is what makes "prepare
all captured members before effects" hold across a body whose captures commit.

And it is not needed for this unit: the four family-5 cells are green on change
(1) ALONE, because a set-oriented nested `updateMany`/`deleteMany` has no
capture left to hoist. Sibling order is restored where it was actually inverted
— by compiling the set mutation as one statement — not by moving the captures
that remain. The revert is recorded in the code
(`commands/execution.ts:305-320`) so the next reader does not re-try it. A
relation-bearing nested `updateMany` therefore still captures ahead of its
siblings' effects; if Arnaud wants THAT order changed too, the flush question
has to be answered first, and it is a decision, not a repair.

**Follow-up (U6.3, no witness).** The shipped rule had a SECOND half I did not
port: `assertConnectOrCreateDecision` (`OwnWriteSteps.ts:696-724`) judged a
merely REPEATED selector (one whose earlier equal-target entry does NOT provably
create the row — an autogenerated key, say) against a ledger forked to exclude
that equal-target lineage, so it did not refuse. The candidate still refuses
that shape. No red cell names it, and the fix is a lineage exclusion inside
`visitPrecedingWrites` — a second decision about the analyser. Recorded, not
guessed.

---

## U6.4 — the one-recovery allowance belongs to the owner that opens the region

**Decision-elimination gate (written before the first edit)**

- **Required behaviour (D-18).** Two clients racing the same missing key
  converge to ONE row on a transaction-capable provider: the loser's exact
  failed INSERT, with nothing acknowledged, restarts the operation ONCE in a
  FRESH transaction with the same attribution and correlation id, so the
  re-plan reads committed state and takes its adopt arm. A SECOND consecutive
  race still propagates. A missing winner never authorises a new INSERT.
- **Current owner.** `shared/operation-context.ts:967` (verified):
  `recoveryRejection` answers `undefined` unless
  `ownership === "standalone" && this.usesBatch`, and `usesBatch` is
  `batch-preparation || (standalone && !driver.supportsTransactions)`
  (`:300-302`). On PostgreSQL `supportsTransactions` is true, so
  `CommandExecution.recover` (`commands/execution.ts:167-194`) is never reached
  and the loser's `UniqueConstraintError` escapes. The attribution ALREADY
  exists on the non-batch path — `insert()` records
  `attempt.rejectedInsert = { error, producer }` at `:1798-1803` — so only the
  transport-mode gate is in the way. `recover` also cannot be the owner in
  transaction mode: it replays inside the region the rejection already aborted
  (`:596-607` → `withinRegion` `:548-563`). The shipped owner was ABOVE the
  executor: `write-engine/routing.ts:180-208` re-ran the whole operation once,
  in a fresh scope, guarded only by `hasCommittedRecordSeriesProgress` (`:197`).
- **Proposed change.** (1) `recoveryRejection` asks about ownership,
  ATTRIBUTION and PROGRESS only — `committedSegments === 0`,
  `!mayHaveCommittedSegment`, `!memberAdmissionStarted` — and never about
  `usesBatch`. Both batch attribution sites (`:846-857`, `:906-914`) already
  require exactly those three, so the batch arm's answer is unchanged by
  construction. (2) The owner that opens the region spends the allowance:
  `run` wraps `withinRegion` and, on an `insert` rejection, replaces both
  attempt regions synchronously and re-enters the region once. (3) The
  interpreter keeps the ONE replacement method (guide: "One recovery method
  replaces both regions synchronously, without callbacks or an await between
  installations"): `CommandExecution` installs it on the context at
  construction and it answers `undefined` once the allowance is spent. (4) The
  in-place arm stays, and is available only when this operation opened no
  region of its own — an aborted transaction cannot answer another statement.
- **Invariant.** The recovery allowance is an attribution-and-progress fact,
  not a transport fact; it is spent once per operation, by the owner that
  opened the region the rejection destroyed. (This SUPERSEDES the guide
  sentence "it answers `undefined` unless the ownership is standalone AND the
  route is the physical batch"; see the lane X section of
  `raptor3/AGENTS.md`.)
- **Falsifiers.** (a) the four family-13 cells in
  `tests/providers/docker/pg-nested-write-races.test.ts` (both `(tx)` and
  `(batch)` arms converge); (b) a NEW cell: a SECOND consecutive race still
  propagates a `UniqueConstraintError` (one recovery only); (c) the
  `expectedAttempts` pins of `tests/raptor3/transitions/unique-races-live.ts`
  — that harness runs `"atomic-batch"` only (`:219`, `:530`), and the batch
  arm's answer is unchanged, so no pin and no registered raptor3 count moves.

**Changes (U6.4).**
- `src/query-engine/raptor3/shared/operation-context.ts:962-977`
  (`recoveryRejection`: ownership + attribution + progress, no `usesBatch`);
  `:637-643` (`restart` takes the replacement region); `:644-651`
  (`attachRecovery`); `:652-661` (`replaysInPlace`); `:662-700`
  (`regionAttempt`); `:606`, `:613` (`run` enters through it).
- `src/query-engine/raptor3/commands/execution.ts:29-47` (the constructor
  installs the ONE replacement method, `replaceRegions`); `:180-212` (`recover`
  replays in place only where this operation opened no region, and spends the
  same allowance).

**Receipts (U6.4).**
- `receipts/lane-x/u6.4-pg-nested-write-races.log` — 7 failed | 88 passed,
  against the round-3 base receipt for the same file
  (`g4/cutover-execution-review-round3-receipts/pg-nested-write-races.log`:
  13 failed | 82 passed). All four family-13 cells are green, and so are the
  two family-5 cells and both `(batch)` twins; the five
  `batch-only batch primary-key dataflow` cells were red at that base too and
  are NOT this lane's (no unit in the plan names them).
- `receipts/lane-x/u6.2-u6.3-falsifiers.log` gains two cells that pin the
  allowance deterministically on a transaction-capable driver: a planted
  create-branch race converges with `transactionCalls === 2` (a FRESH region,
  never a replay inside the aborted one), and a race planted on EVERY attempt
  propagates its `UniqueConstraintError` with `transactionCalls === 2` (one
  recovery, not a loop).
- `tests/raptor3/transitions/unique-races-live.ts` runs `"atomic-batch"` only
  (`:219`, `:530`) and its `expectedAttempts = 1` pins the REFUSED recovery
  (wrong-insert provenance), which is an attribution question this unit does
  not touch. No pin edited, no registered raptor3 count moved.

---

## U6.5 — the complement guard on a captured member set — BLOCKED, not shipped

**Decision-elimination gate (written before any edit)**

- **Required behaviour.** Rule 5, "never cache observed absence": a captured
  member set is an assertion about every row that is NOT in it. On a batched
  selected series with a membership edge, one raceable `requireAbsent` over
  "connected ∧ filter ∧ key ∉ captured" must ride the same batch, so a member
  added after the plan-time read aborts the unit; the retry then re-plans
  against the larger set and converges (`m2m-deletemany-staleness-behavior.ts:100-166`:
  `batchErrors.length >= 1` AND the operation SUCCEEDS).
- **Current owner.** `commands/execution.ts:640-748` (`captureSeries`) emits no
  complement guard, and `:749-776` (`executeSeries`) guards only the parent.
  The absence owner exists: `shared/operation-context.ts:808-817`
  (`requireAbsent`), used with `meta.raceable = true` at `:2226` and `:2140`.
- **Why it is NOT shipped.** The guard alone cannot make the cell green, and
  ON ITS OWN it converts a silent wrong-row-set into a hard failure where the
  shipped engine converged — a NEW observable, not parity. Two facts block the
  convergence half, both of them registered decisions rather than defects:
  1. **The restart attribution is refused once member admission has started.**
     `submit` marks `atomicAssertionRejection` only when
     `committedSegments === 0 && !memberAdmissionStarted && !mayHaveCommittedSegment`
     (`shared/operation-context.ts:906-914`), and `captureSeries` sets
     `memberAdmissionStarted` through `prepareMembers` (`:362-364`) BEFORE the
     guard could be queued. The guide states this as a contract: "Only a proven
     atomic rejection before committed progress or dynamic member admission may
     restart once." So no recovery is attributed, and
     `CommandExecution.recover`'s assertion arm (which also requires a
     `conditionalSkips` entry, `execution.ts:186-191`) is never reached.
  2. **A series occurrence cannot be expanded twice.** `Commands.expandSeries`
     throws `Selected series occurrence was already expanded`
     (`commands/commands.ts:979-980`) when its occurrence already carries member
     children, and the command TREE survives an attempt replacement (only the
     `CommandAttempt` and `TransportAttempt` are replaced). A re-run of the body
     after a captured series therefore cannot re-derive its members at all.
  A third, smaller hazard: with the body now running in declared order (U6.2),
  a sibling `connectOrCreate` (order 4) or `set` (order 5) queues its junction
  link BEFORE a `deleteMany` (order 7) guard, while the plan-time capture read
  dispatches immediately and cannot see it — so the guard as specified would
  abort on this operation's OWN new member unless it also excludes the links
  this operation queued.
- **What it needs (for Arnaud).** (a) A raceable assertion rejection that
  survives member admission — i.e. the restart rule becomes "before committed
  progress", the shipped `hasCommittedRecordSeriesProgress` gate
  (`write-engine/routing.ts:197`), with member admission no longer part of it;
  (b) a series occurrence that may be re-expanded after a restart (reset its
  member children rather than refusing); (c) the guard excluding the memberships
  this operation itself queued. All three are decisions about the candidate's
  restart lifetime, not repairs.
- **Reproducer.** `tests/providers/docker/pg-nested-write-races.test.ts`
  › `pg filtered m2m deleteMany staleness › a member added after the plan-time
  read aborts the guard, then the retry converges` — still red, for the reason
  above; receipt `receipts/lane-x/u6.4-pg-nested-write-races.log`.

---

## U5.5 — a `createMany` count is the operation's, not the provider's opinion

**Gate.** Required: a driver that acknowledges FEWER rows than were submitted
has not written the request, so the operation refuses instead of publishing the
shortfall (`operation-context.ts:1528-1532` trusted the sum). Owner:
`shared/operation-context.ts` `createMany`'s parse closure. Change: sum the
window's `rowCount` once and compare it with `rows.length` before publishing,
with `skipDuplicates` the one admitted shape whose shortfall IS the answer.
Invariant: an affected-row count is execution semantics (rule 4), stated by the
operation that submitted the rows. Falsifier: a driver acknowledging 1 of 2 is
refused; a driver acknowledging 2 of 2 publishes `{ count: 2 }`.

**Measured boundary.** The refusal is a SHORTFALL (`written < rows.length`), not
an inequality: `query-interceptors-array.core.test.ts` › "preserves single,
multi-statement, guard, and raw result windows" hands a 2-row `createMany` a
window that reports 5 and pins `{ count: 5 }` — a provider may legitimately
report more (MySQL's duplicate clause counts two per replaced row). Pinning
`!==` reddened that cell; the shortfall rule keeps it green and still catches
the hazard the deleted `bulk-create-plan` cell protected.

**Changes.** `src/query-engine/raptor3/shared/operation-context.ts:1601-1625`.

---

## U7.1 — the driver's prepared-statement provenance survives both copies

**Gate.** Required: a deferred statement transform runs for every candidate
statement on an observed client. Owner: `shared/operation-context.ts:355-358`
(`queue`) and `:1160-1165` (`preparedBatch`) both spread the driver's prepared
query into a fresh object, so `readPreparedStatement` answers `undefined` and
`materializeTrustedBatchQuery` (`drivers/driver-instrumentation.ts:544-560`)
silently skips the transform. Change: wrap both with `transferPreparedStatement`
(`drivers/prepared-statement-provenance.ts:10-18`, written for exactly this and
with no query-engine caller since the cutover). Invariant: the DRIVER owns a
prepared query's identity; an internal snapshot carries it. Falsifier:
`query-interceptors-array.core.test.ts` › "orders native statement onions before
transforms and submits nothing on failure" (`driver.events === []`).

**Changes.** `src/query-engine/raptor3/shared/operation-context.ts:355-368`,
`:1230-1237`, import at `:8`.

---

## U7.2 — a standalone region publishes its own commit certainty

**Gate.** Required: a direct composed write whose transaction fails after
`readyToCommit` publishes `may-have-committed` and carries `commitCertainty` on
the error; one that fails after `committed` publishes `committed`; a listener
failure is retained beside the operation's own. Owner: `region()`
(`shared/operation-context.ts:534-546`) passed the raw attribution with no phase
binding, and `route/client-route.ts:214-232` published on success only. Change:
the five steps of the shipped `runTransactionScope`
(`write-engine/OperationExecutor.ts:1130-1187`) in the context, because only the
context opens the region: bind `readyToCommit`/`committed` with
`bindExecutionTransactionPhases`, map phase → certainty on failure, attach it
with `attachCommitCertainty`, notify the matching seam through the existing
`stateWriteOutcome` (which composes with `retainOutcomeFailure`), and notify
`committedSegment` on success. The route's `!outcome.published` fallback is
untouched. Invariant: the owner that opens a region is the owner that states
what its phases proved. Falsifiers: both `query-interceptors-integration`
write-outcome cells, with the phase-blind-driver cell still green.

**Changes.** `src/query-engine/raptor3/shared/operation-context.ts:534-563`
(`region`), `:564-570` (`regionPhase`/`openRegionPhase`), `:571-625`
(`withinRegion`), imports at `:7-11`, `:16`.

---

## U7.3 — a one-statement write publishes its single package (D-20)

**Gate.** Required: the array owner parses a one-statement write through its own
`parseResult` seam and interceptor onion, not through the batch. Owner:
`commands/index.ts:208-214` — `prepareSingle` answers `undefined` for every
non-read verb. Change: build the plan (the `single` admissibility `Commands.plan`
already states), and for a one-statement plan run the same preparation
`prepareBatch` runs and publish the package it produces. Preparation reaches no
driver and queues synchronously, so the package is in hand when `prepareSingle`
returns; `PendingOperation.#resolveSinglePackage` keeps its own
`queries.length === 1` check. Invariant: one preparation answers both arms.
Falsifiers: the two `query-interceptors-array` native-array cells (the
five-error aggregate and the `["provider","outcome","parse","post-work"]`
timeline).

**Changes.** `src/query-engine/raptor3/commands/index.ts:209-246`.

---

## U7.4 — one pre-dispatch capability gate on the construction path

**Gate.** Required: a driver with neither transactions nor batch refuses a write
that cannot be one statement BEFORE any provider work (the `upsert` decision
read reached the provider and surfaced `QueryError: Query execution failed`),
and a batch-only non-returning driver refuses `update`/`delete`/`upsert` with
its registered sentence and zero connection attempts. Owner: nothing — the
shipped gate was `write-engine/routing.ts:104-164`
(`assertRoutedAtomicResolution`), deleted with the routing table. Change: ONE
gate, `OperationContext.requireAtomicUnit`, asked from `run` exactly when the
physical-envelope rule has already ruled the form out of one statement
(`!single`) and this operation is `standalone` — the construction path, before
the first statement. One class (`TransactionError`), one `meta { driver,
operation }`, and the two registered sentences. Invariant: a capability a form
NEEDS is asked once, before any statement, by the owner that knows the form.
Falsifiers: the three `select-mode-capability-matrix` cells (all
`TransactionError`, `meta.operation`, and no provider dispatch — the planning
fixture's `execute` throws a different sentence) and the mysql2
`rejects artificial batch-only non-returning writes before provider access`
cell against an unreachable host.

**Changes.** `src/query-engine/raptor3/shared/operation-context.ts:57-66`
(`ATOMIC_RESOLUTION_OPERATIONS`), `:604` (`run` asks it), `:684-722`
(`requireAtomicUnit`).

---

## U8 — pins and names

- `tests/contracts/engine/query/select-mode-capability-matrix.core.test.ts:66-85`
  now asserts the SURVIVING driver seam's sentence —
  `Driver "<name>" supports neither transactions nor atomic batch execution.`,
  the wording `drivers/driver-transaction-base.ts:790`/`:979` and
  `client/array-transaction-native-batch.ts:51-61` still raise — instead of the
  deleted engine's `'`-quoted spelling. `meta.driver` and `meta.operation` are
  unchanged and now come from U7.4's gate. No production change.
- The restored `bulk-create-plan` short-window cell is a ONE-SIDED pin in
  `tests/raptor3/g4/parity/lane-x-route-seam.test.ts`: the deleted cell asserted
  the deleted engine's `"is unresolved"`; what it protected is that a truncated
  provider result window RAISES instead of reporting a smaller count, which this
  engine states as `Driver '<name>' omitted the prepared result for operation
  '<op>'.`

**Receipts.** `receipts/lane-x/u7-public-client.log` (110 passed across the
three public-client files, from 5 red cells at the base),
`receipts/lane-x/u5.5-u7-falsifiers.log` (11 passed across both new parity
files).

---

## U6.6 — a skipped INSERT is not a skipped membership

**Protocol note, honestly.** This unit's gate was written into the note AFTER
its edits, not before: U6.5's investigation ran long and I went straight from
reading the shipped route into the change. The analysis below is the one the
edits were made from, and every claim in it was verified in the worktree; the
ordering rule was still broken, and I am recording that rather than backdating.

- **Required behaviour.** With `skipDuplicates`, a `createMany` member whose
  target row already exists is not written again — but the MEMBERSHIP it
  declared is. On a SINGULAR junction that membership is a transfer:
  `connect eu/111 to left`, then `createMany [eu/111, eu/111]` on `right` with
  `skipDuplicates` ⇒ exactly `['t1/right/eu/111']`, one membership row.
- **Current owner.** `shared/operation-context.ts:396-416`
  (`executeSkippableMember`) wraps the member's WHOLE subtree in the rollback
  region and `commands/execution.ts:566-576` then skips it, so the junction
  write is rolled back with the target insert and the membership stays with the
  old owner. And `commands/relation-body.ts:897-918`: a `JunctionCapture` is
  built only when the target was LOCATED (`target.kind === "choose"`), so a
  createMany member on a singular junction captures no current owner and could
  not transfer even if it ran. The shipped engine routed exactly this row to
  `joinWhenTargetExists` (`junction-create-many-routing.ts:95-113` →
  `JunctionStatements.ts:134-155`) and wrapped the junction insert in the
  singular transfer, whose address for a spelled key is
  `JunctionTransferAddress.values` (`junction-singular-transfer.ts:40-52`).
- **Change.** (1) `JunctionCapture.address` becomes optional: a capture whose
  values are literals addresses the slot directly and waits for no located row
  (`commands/commands.ts:85-97`, `commands/execution.ts:320-330`). (2) A
  createMany series member on a target-unique junction that SPELLS its target
  key captures the current owner at ITS OWN body position
  (`commands/relation-body.ts:918-945`), so a later member naming the same
  target observes the membership the earlier one already moved and its link is
  the exact-pair no-op `OperationContext.link` already implements. (3) A
  suppressed member runs its non-`before` children — its membership writes —
  against the existing row instead of discarding them
  (`commands/execution.ts:596-616`, `adoptSuppressed`).
- **Invariant.** A suppressed INSERT suppresses the ROW, not the membership the
  member declared: a member that spells its target key names an existing row,
  and its declared membership is written against that row.
- **Falsifiers.** `polymorphic collection writes › duplicate singular createMany
  targets transfer once` on sqlite3 AND mysql2 (both green), with the rest of
  both polymorphic suites unchanged.

**Follow-up (not shipped).** The shipped junction write for this row is an
INSERT-SELECT (`buildJunctionInsertWhenTargetExists`,
`builders/many-to-many-utils.ts:252-311`), which writes NOTHING when the target
key is absent — the case where `skipDuplicates` suppressed the row on a
DIFFERENT unique constraint and the row this member names does not exist. This
lane writes the membership from the member's own spelled key, so that shape
would raise a foreign-key failure where the shipped engine silently wrote no
membership. Making it exact needs either an insert-select arm on
`OperationContext.link` or a constraint-identity check on the suppressed error
(the machinery `CommandExecution.matchesSelectedConstraint` already has). No
cell names it.

---

## Hand-overs to lane Q

1. **U1.4's batch-seam half needs a file lane Q may not edit.** The empty
   `createMany` refusal belongs on the batch-preparation seam —
   `commands/index.ts` `prepareBatch`, which is lane X's file. I did NOT apply
   it, because U1.4 is lane Q's unit and two gates for one refusal is two
   owners. The exact change, if Arnaud wants it from this lane instead: in
   `prepareBatch`, before `body(context)`, `if (operation === "createMany" &&
   Array.isArray(args().data) && args().data.length === 0) throw new
   QueryEngineError("No data to insert for createMany.")`. The direct path must
   keep Prisma's `{ count: 0 }`. Red cell:
   `tests/contracts/engine/query/bulk-insert-row-shapes.core.test.ts` › "empty
   createMany rejects during batch preparation".
2. **The nested default-only `skipDuplicates` refusal stays on the physical
   owner** (`shared/operation-context.ts` `suppressionRefusal` /
   `UnsupportedOperationError` at `createMany`) until lane Q's admission arm
   lands. Red cell: `nested write behavior › rejects nested default-only
   duplicate skipping before the parent write` (sqlite3 and pg). Nothing in
   this lane touched it, and the physical copy must NOT be deleted before the
   admission arm is merged, or root `createMany` loses the refusal too.
3. **`official-cache-swr` and the four polymorphic read cells stay red for
   D-17** (the adapter/driver result-parser chain, lane Q's U5.2/U5.4). This
   lane's U6.6 fixed the polymorphic WRITE cell in the same files; the read and
   refusal cells beside it are untouched.

## Follow-ups (no cell names them)

- U6.3's second half: a merely REPEATED `connectOrCreate` selector whose earlier
  equal-target entry does not PROVABLY create the row is still refused here,
  where the shipped engine forked the ledger to exclude that lineage
  (`OwnWriteSteps.ts:696-724`).
- U6.6's alternate-key case: a suppressed member that spells its row key but
  conflicted on a DIFFERENT unique would now raise a foreign-key failure where
  the shipped insert-select wrote no membership.
- U6.5 is blocked on two decisions (see its section).
- `tests/contracts/architecture/contract-matrix.core.test.ts` was already red at
  the base because `tests/inventory.ts` classifies no file under
  `tests/raptor3/`; this lane's two new files join ~100 others in that set and
  the assertion still fails on the same first file
  (`tests/raptor3/candidate-handoff.test.ts`).

## Verification (final state)

| suite | base | now |
| --- | --- | --- |
| `provider-sqlite3` (whole lane) | 61 failed (round-3 `provider-local-cutover.log`) | 56 failed |
| `tests/providers/docker/pg-nested-write-races.test.ts` | 13 failed (round-3 receipt) | 7 failed |
| `tests/providers/docker/mysql2.test.ts` | 13 failed (round-3 `mysql2-cutover-2.log`) | 11 failed |
| `layer-client` + `layer-query-engine` + `layer-write-engine` + `layer-drivers` | 11 failed (round-3 `core-lane-final.log`) | 3 failed |
| raptor3 probe (12 recovery / envelope / dependency / series suites) | — | 69 passed, 0 failed (`final-raptor3-probe.log`) |
| whole-estate typecheck | — | **0 diagnostics** (`final-typecheck.log`) |

No cell that was green at the base is red now. Every remaining red cell in the
files this lane touched belongs to lane Q (U1.4, U2.4, U3, U4, U5.2, U5.4), to
the environment (the four MySQL namespace-containment cells and the five pg
`batch-only batch primary-key dataflow` cells, all red at the base and named by
no unit), or to U6.5's blocker.

Receipts, all under `receipts/lane-x/`: `u6.1-self-m2m-sqlite3.log`,
`u6.2-u6.3-sqlite3-nested-write.log`, `u6.2-u6.3-falsifiers.log`,
`u6.4-pg-nested-write-races.log`, `u6.6-baseline-sqlite3-polymorphic-batch.log`,
`u7-public-client.log`, `u5.5-u7-falsifiers.log`, `u7.4-mysql2.log`,
`final-provider-sqlite3.log`, `final-pg-nested-write-races.log`,
`final-mysql2.log`, `final-core-layers.log`, `final-falsifiers.log`,
`final-typecheck.log`.

---

# Round 2 — the independent review's two resolutions

Review: `docs/architecture/raptor3-evidence/g4/parity/lane-x-review.md` (verdict
REVISE, 2026-09-17). Two items, applied EXACTLY as written and nothing more.
The review's §5 notes N1–N4 are recorded as "no action required" by the review
itself; N2 (the superseded `recoveryRejection` sentence at `AGENTS.md:587-592`)
belongs to the merge owner, and the lane section still says it supersedes it, so
this round does not rewrite that other section.

## Gate R1 — a suppressed member replays its MEMBERSHIP, not every child

*(written before the first edit of this round)*

- **Required behaviour.** `skipDuplicates` suppressed this member's target row
  because that row already exists. The membership the member declared is still
  written against the existing row (U6.6's invariant); its nested RECORD
  children are NOT performed against that pre-existing row. The shipped engine
  never performed them: `joinWhenTargetExists` is the leaf route and is reached
  only by a NON-relation-bearing row — `junction-create-many-routing.ts:76-84`
  (verified at `ff5e77ca`) sends `relationBearing || disposition === "suppress"`
  to a series — and a skipped root in a series abandoned the rest of the member
  (`OperationExecutor.ts:894` `if (execution.skippedRoot) return true`, under
  `assertProgressiveRootConflictEligibility`'s "a skipped root must strand
  nothing", `:2388-2416`). Replaying a nested record write against a row this
  operation did not create also breaks the idempotence `skipDuplicates` claims.
- **Current owner.** `src/query-engine/raptor3/commands/execution.ts:633-640`
  (`CommandExecution.adoptSuppressed`): `for (const child of record.children) if
  (child.placement !== "before") await this.run(child, command);` — every
  non-`before` child, which includes nested `RecordCommand`s. Measured by the
  reviewer in this worktree: a suppressed `createMany` row carrying
  `notes: { create: … }` wrote the note against the pre-existing row; at the
  lane base it wrote nothing.
- **Proposed change.** Restrict the replayed children to the membership kinds
  the invariant names — `link`, `remove`, `junction`, `membership` — exactly the
  hunk in review §4 R1. No other behaviour moves.
- **Invariant.** A suppressed INSERT suppresses the ROW; the member still writes
  the MEMBERSHIP it declared against the existing row, and nothing else. A
  nested record write belongs to the row that was not created.
- **Falsifier.** New cell `lane X — nested set mutations › writes a suppressed
  member's membership but not its nested record children`
  (`tests/raptor3/g4/parity/lane-x-set-mutations.test.ts`, `extended-local`):
  a junction `createMany` member whose target row exists and which carries a
  nested `notes: { create }` must leave the target's `notes` empty and its label
  untouched while the new membership row exists. Red before this hunk, green
  after. Unchanged pins: `duplicate singular createMany targets transfer once`
  (sqlite3, mysql2 — the membership half), `suppression-replay`,
  `suppression-retry-contract`, `bulk-series-contract`.

## Gate R2 — the Biome error U6.4's edit introduced

- **Required behaviour.** `npx biome check` reports nothing on
  `commands/execution.ts` that the base did not already report (the brief: fix
  by hand what your edits introduce).
- **Current owner.** `src/query-engine/raptor3/commands/execution.ts:196-201`,
  the `recover` guard. Removing `this.recovered ||` from its head (U6.4) left
  `!a || !b || !c`, which `lint/complexity/useSimplifiedLogicExpression` reports
  at `:200:7`; the other 19 diagnostics on the lane's nine files are present at
  `356254a2` byte for byte.
- **Proposed change.** The negated conjunction of review §4 R2 — same predicate,
  same short-circuit order, no behaviour change.
- **Invariant.** Formatting only; the recovery predicate is unchanged.
- **Falsifier.** `npx biome check src/query-engine/raptor3/commands/execution.ts`
  reports only the four pre-existing diagnostics, and
  `lane-x-set-mutations.test.ts` (which owns both recovery cells) stays at 8 (now
  9) passed.

## Round 2 — what changed

Two hunks in ONE file, plus one new cell and one guide sentence. Nothing else
moved; no other review note was acted on.

1. `src/query-engine/raptor3/commands/execution.ts` — `adoptSuppressed` replays
   only the membership children (`link`, `remove`, `junction`, `membership`),
   exactly the hunk of review §4 R1, with the docblock stating the two shipped
   facts that make it the shipped behaviour
   (`junction-create-many-routing.ts:76-84`, `OperationExecutor.ts:894`, both
   read at `ff5e77ca` and quoted in the gate above).
2. `src/query-engine/raptor3/commands/execution.ts` — the `recover` guard is the
   negated conjunction of review §4 R2.
3. `tests/raptor3/g4/parity/lane-x-set-mutations.test.ts` — one new cell,
   `writes a suppressed member's membership but not its nested record children`,
   with the junction world it needs (`board` ⇄ `card`, `card` → `note`). The
   file is already in the `extended-local` walk; no `scripts/raptor3-manifest.mjs`
   count moves, because the manifest registers no file under
   `tests/raptor3/g4/parity/`.
4. `src/query-engine/raptor3/AGENTS.md` — one sentence appended to the lane's own
   U6.6 paragraph ("The MEMBERSHIP, and only it…"). No other section touched;
   N2's stale `recoveryRejection` sentence at `:587-592` is left for the merge
   owner, as the review asks.

## Round 2 — receipts

| check | command scope | result | receipt |
| --- | --- | --- | --- |
| R1 falsifier, engine MUTATED back to the wide replay | `extended-local`, the one file | **1 failed / 8 passed** — the new cell, and only it | `round2-falsifier-mutation.log` |
| R1 falsifier + route seam, engine as shipped here | `extended-local`, 2 files | 12 passed | `round2-falsifiers.log` |
| `suppression-replay`, `suppression-retry-contract`, `bulk-series-contract` | `raptor3` | 13 passed | `round2-falsifiers.log` |
| `unique-races` + `recovery-boundaries` + `junction-races` (live pg 55729) | `raptor3-live-provider` | 8 passed | `round2-falsifiers.log` |
| whole `provider-sqlite3` lane | project | 56 failed / 699 passed / 1 skipped | `round2-provider-sqlite3.log` |
| `pg-nested-write-races.test.ts` | `provider-pg` (Docker 55729) | 7 failed / 88 passed | `round2-pg-nested-write-races.log` |
| `mysql2.test.ts` | `provider-mysql2` (Docker 55730) | 11 failed / 73 passed / 1 skipped | `round2-mysql2.log` |
| layer-client + query-engine + write-engine + drivers | 4 projects | 3 failed / 2049 passed | `round2-core-layers.log` |
| the 12-file raptor3 probe (envelope, dependency, series, suppression) | `raptor3` | 69 passed | `round2-raptor3-probe.log` |
| whole-estate typecheck | `node scripts/run-typecheck.mjs` | **0 diagnostics, exit 0** | `round2-typecheck.log` |
| `npx biome check` on the two files this round touched | — | 4 errors, all four present at `356254a2` byte for byte | `round2-biome.log` |

The failing-cell NAMES of `provider-sqlite3`, `pg-nested-write-races`, `mysql2`
and the four core layers were diffed (`comm`/`diff` on the sorted `FAIL` lines)
against round 1's receipts: **the sets are identical in all four**. The five
repaired sqlite3 cells, the six pg cells, the two mysql2 cells and the eight
core-layer cells of round 1 are all still green, and nothing new is red.

The R2 hunk is verified by Biome, not by assertion: `execution.ts` now reports
`organizeImports`, `noParameterProperties`, `useDefaultSwitchClause` and
`noCommaOperator` — the exact four the base reports, confirmed by running
`biome check` on `git show 356254a2:…/execution.ts`. The
`useSimplifiedLogicExpression` error U6.4 introduced is gone.

**Environment note (honest).** The first three `provider-pg` attempts failed
wholesale (50/95, then 95/95) with PostgreSQL `53300 too_many_connections` and
`MigrationError: The locked push requested a different set of resolutions` —
lane Q was pushing its own schema into the same `raptor3_g2` database at the
same time. `pg_stat_activity` showed 6/100 connections once it cleared, and the
fourth attempt reproduced the review's exact 7 failed / 88 passed. The failures
were the shared-container collision the brief warns about, not this lane's
change; the receipt kept is the clean run.

**Falsification exercise.** The R1 mutation (the wide replay restored) was
applied to a copy backed up to the scratchpad, run, and restored; the file was
verified byte-identical afterwards by MD5 (`2c780bafce2f2d1df9ed7dd7b14d0c3f`).
