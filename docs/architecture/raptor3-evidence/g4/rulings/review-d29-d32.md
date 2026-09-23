# Rulings unit — independent review of D-29 and D-32

Reviewer: independent reviewer (D-29, D-32 only; D-28 is a second reviewer's
scope). Worktree `/private/tmp/viborm-rulings`, branch `rulings`, diff base
`5ac39cfd`; the unit's work is carried by the integrator's wip commit
`e821cd21a` (author `beynar`, 2026-09-17 20:54), which also holds the one-number
manifest change that is not the author's. `TMPDIR=/private/tmp/viborm-rulings-tmp-rb`
on every run of this review, one run at a time. Nothing committed, staged,
reset, stashed or pushed; every file I touched for a falsification was restored
from a byte-exact copy under `/private/tmp/viborm-rulings-tmp-rb/backup/` and
re-checked with `shasum`; `git status` at the end of this review is the author's
state exactly (only the untracked `g4/rulings/` tree).

## Verdict

**REVISE.** Both rulings are implemented at the owner the brief named, with no
policy boolean, no second reader and no per-feature interpreter; every falsifier
I re-ran reproduces; both identity-pin families and the pg Docker cell are
green; the typecheck is zero. Three things are missing, none of them a
production change:

1. **D-29's progress companion has only a Docker-gated falsifier, and it
   silences a second observable that the note does not name.** Measured below.
   One deterministic local cell is needed (recipe given), and the note must name
   the observable.
2. **The companion is a new observable compatibility choice and belongs in the
   note's Blockers list**, not only in the D-29 prose.
3. **D-32's line references in the note are ~100 lines stale** (they were taken
   before D-28's insertions above `captureMembership`).

Graded separately, as the brief asks: **D-32 — ACCEPT.** **D-29's premise
placement (`flush`/`withholdPremises`) — ACCEPT.** **D-29's progress companion —
ACCEPT WITH DISCLOSURE**, conditional on resolutions 1 and 2; it goes beyond
D-29's words (it changes what a rejection PROVES, not where a premise is
dispatched), it is correct and narrowly scoped, it is load-bearing for the pg
cell the brief demanded green, and the author disclosed its consequence and the
exact alternative. It is not a BLOCK: it cannot authorise a write twice (proved
below), and it is falsifiable today — only on Docker.

## What I verified myself (not read — run)

One file or one registered mode per call, my own `TMPDIR`, never two at once.

| target | result |
| --- | --- |
| `tests/raptor3/g4/parity/integration-staleness.test.ts` | **4/4** |
| `tests/raptor3/g4/parity/integration-membership-race.test.ts` | **3/3** |
| `g2-transport` | **16/16**, gate verified (no recorded plan moved) |
| `g2-contracts` | **216/216**, gate verified — the JSON report shows `g2-upsert-skip-replaced`, `g2-upsert-skip-deleted` and `g2-upsert-setwhere-match-replaced` ran and passed |
| `g2-baseline` | **216/216**, gate verified |
| `g4-unit02-author` | **131/131**, gate verified, **exit 0** (the manifest count the integrator fixed); this is the registered statement/round-trip evidence for `fixed-collection-rowref-20` (`physical-envelope.test.ts`: 1 statement, 0 transactions) and for `uncertain-outcome-meta.test.ts` |
| `cs01-extension-a`, `g3p03-contracts` | gates verified |
| `tests/providers/docker/pg-nested-write-races.test.ts` (pg 55729) | **90 passed / 5 failed** — the five are the pre-existing `batch primary-key dataflow` family; baseline was 89/6 |
| the D-29 pg cell, by name | **green** (`a member added after the plan-time read aborts the guard, then the retry converges`) |
| the re-expressed adopter cell, by name | **green** (`an adopter whose captured owner was replaced aborts, re-plans once, and converges`) |
| `g2-pg-contracts` (pg 55729) | **18/18**, gate verified (includes `junction-races-live-commands` 3/3 and `staleness-live-pg-commands` 2/2, i.e. `g2-pg-series-parent-reference-reused`) |
| `node scripts/run-typecheck.mjs` | **0 diagnostics, exit 0** |
| `npx biome check` on `transport-attempt.ts`, both new parity files and `nested-write-concurrency-behavior.ts` | clean |
| `junction-races-live.ts` biome profile, measured IN PLACE at both revisions | **identical** (17 `noMisplacedAssertion`, 1 `useTopLevelRegex`, 1 `noVoid` before and after; no new rule) |

Falsifications, each mutated in the live file and restored byte-exact:

| falsification | result |
| --- | --- |
| D-32: the mark moved back inside the `else` (the present arm unmarked) | cells **1 and 2 redden**, cell 3 **green** — exactly the present arm's unique coverage, as the note claims |
| D-29: `flush` no longer withholds (base `flush` restored, including its `flushQueued` early return) | the new local pin reddens at `proving.length`; the file's other three cells stay green |
| the same revert, against Docker pg | the pg cell **also** reddens, at `batchErrors.length >= 1` — the original red. (The note does not claim otherwise; the author's hand-off summary sentence "reverting the flush hunk reddens the local pin only" is wrong and should not be repeated.) |
| D-29: the `!rejectedBeforeAnyWrite` conjunct dropped | the pg cell reddens with `NestedWriteError: … a member was added after the plan-time read; retry to converge` — the guard fires, the retry is refused, exactly the recorded receipt |
| the same revert, against the re-expressed adopter cell | reddens with the same sentence — confirming that the COMPANION, not D-32, moved that cell's outcome and `g2-junction-captured-owner-replaced` with it |

## D-29 — a queued premise rides the atomic unit it protects

### The owner, the rule, and no policy boolean

`flush` (`shared/operation-context.ts:987-1018`) is the place planning reads
become batches, which is the owner the brief named; `withholdPremises` /
`restorePremises` (`shared/transport-attempt.ts:50-95`) read the premise map
`assertPremise` already fills, so no new fact is stated and no boolean is
introduced. `queued` is the attempt's own `pending` array (`:168-171`), so
`queued.length === 0` after withholding is the same fact the withhold changed —
one reader, not two.

I checked the rule's assumption that the trailing premise run is exactly the set
whose writes have not been queued yet, by walking every premise site: all twelve
(`commands/execution.ts:128, 264, 287, 360, 429, 433, 443, 744, 833, 902` and
`operation-context.ts:2573, 2574`) queue the premise AHEAD of the mutation it
protects, and `packagedPresence` documents that discipline in words ("queued
ahead of the mutation"). So withholding the trailing run can never strand a
write whose premise stepped aside: the only statements dispatched without their
premise are ones queued BEFORE it. A re-plan discards the attempt entirely
(`restart()` installs a fresh `TransportAttempt`), so no withheld statement can
survive into another attempt, and the restored premise always rides the final
`submit`, because `finishTerminals`/`flush` test `queued.length` AFTER the
restore.

### No round trip was added — measured, before and after

`fixed-collection-rowref-20` is pinned by `physical-envelope.test.ts` (1
statement, 0 transactions) and that mode is green, so the frozen column did not
move. For the other two shapes I built my own recording driver (a temporary
probe under `tests/raptor3/g4/parity/`, deleted afterwards; `roundTrips =
statements − batched + batches`) and ran it with the three production files at
`5ac39cfd` and then at this unit's revision, same seed data:

| shape | route | base `5ac39cfd` | this unit |
| --- | --- | --- | --- |
| `nested-conditional-found` (`generatedParent.create` + `connectOrCreate` found + nested select) | live | 4 statements / 4 round trips | 4 / 4 |
| same | batch-only | 17 statements / 10 round trips | 17 / 10 |
| filtered m2m `deleteMany` (the shape the rule MOVES) | batch-only | 10 statements / **6** round trips, batches `[2,4,1]` | 10 statements / **6** round trips, batches `[5,1]` |

The third row is the one that matters and it is the rule working: the premise
that used to ride a 2-statement planning batch now leads a 5-statement atomic
unit, the planning read became a lone statement, and the totals are unchanged.
My `nested-conditional-found` numbers reproduce the author's table exactly.

I also confirmed by reading that the new `queued.length === 0` arm cannot turn
one batch of N planning reads into N round trips: the only site that passes an
ARRAY of projections (`commands/execution.ts:397`, the `choose` arm) is reached
only when `attempt.references()` is non-empty, which requires a queued INSERT,
so the queue is never empty there after withholding.

### The progress companion: what it proves, and what else it changes

The proof (`:1171-1185`) is sound as a fact this owner can state:

- it requires the rejected statement to BE a premise and every statement ahead
  of it to be a premise, so nothing that could write had run;
- `assertionFailures` includes the continuation guards that `submit` prepends,
  so the index space it tests is the dispatched array, the same one the
  pre-existing `insertProducers` lookup and the attribution arm use;
- it is asked only at `committedSegments === 0`, and `mayHaveCommittedSegment`
  is written in exactly one place (`:1185`) and never cleared — so **no
  acknowledged prefix and no earlier uncertain outcome can be erased by it**.
  An operation that acknowledged a segment still has `committedProgress === true`
  and is refused its recovery by D-25; an operation whose earlier batch set the
  uncertainty keeps it. The re-plan arm (`:1227-1247`) additionally requires
  `!committedProgress` and a raceable premise, so the companion cannot authorise
  a new INSERT on an uncertain outcome. Confirmed by reading and by
  `uncertain-outcome-meta.test.ts` 8/8 (cell 2 keeps `mayHaveCommittedSegment:
  true` for a series rejected before dispatch; cell 3 keeps the one
  invalidation).
- its "a batch surfaces its FIRST failure and continues past nothing" assumption
  is the one the estate already relies on: the pre-existing
  `!(error instanceof UniqueConstraintError)` conjunct on the same arm exempts a
  rejection at a WRITE with writes ahead of it, which is strictly more
  assumption than this proof takes.

**What the note does not say, and I measured.** The suppressed flag feeds two
more consumers besides the recovery allowance: the public failure meta
(`failure()` attaches `recordSeriesProgress` only for a prefix phase, a
committed segment, or this flag) and the write-outcome seam
(`stateWriteOutcome(this.writeOutcome?.mayBeVisible, error)` at `:1192`). On a
weak-native batch transport (`supportsOrderedCommittedSegments === false`) whose
batch rejection carries a `statementIndex` — that is, any driver using the base
`executeBatch` loop, `driver-transaction-base.ts:659-770` — a repeated premise
race on the filtered m2m `deleteMany` shape publishes:

- at `5ac39cfd`: `meta.recordSeriesProgress = { atomicity: "segment", phase:
  "member", committedSegments: 0, completedMembers: 0, committedWriteMembers: 0,
  mayHaveCommittedSegment: true, memberPath: [0], totalMembers: 1 }`
- at this unit: **no `recordSeriesProgress` at all** (`meta` is
  `{ relation, raceable }`), and the `mayBeVisible` seam is not notified.

Both are the RIGHT answers under the ruling (the unit wrote nothing, so there is
nothing to report and nothing to invalidate), which is why this is a disclosure
and not a block. But they are public observables of a registered refusal, and
nothing in the estate pins them: the author's own witness fixtures cannot reach
this arm, because `StaleBatchSQLiteDriver` and `RacingMembershipDriver` both
declare `supportsOrderedCommittedSegments = true` (the arm is skipped entirely)
and both override `executeBatch` with their own loop, which attaches no
`statementIndex` (so `rejectedIndex` is `undefined` and the proof cannot fire).
I verified that too: with a fixture that keeps its own loop, the meta is
identical at both revisions; only when the fixture delegates to the base loop
does the difference appear.

**Resolution 1 (minimal, ~30 lines, no production change).** Add one
deterministic cell beside the D-29 pin, on a batch-only SQLite driver that
declares `supportsOrderedCommittedSegments = false` and whose `executeBatch`
delegates to the base loop (`return this.transaction(client, (tx) =>
super.executeBatch(tx, queries))`), pinning the fact the companion states: a
batch rejected AT a premise with only premises ahead of it publishes no
`recordSeriesProgress`/`mayHaveCommittedSegment` and notifies no
`mayBeVisible`, while a rejection at a WRITE still publishes both. That is the
companion's own falsifier, off Docker, and it also pins the half of the change
the note currently leaves unstated.

**Resolution 2.** Move the companion into the note's **Blockers** list (it is
today only in the D-29 prose, "the one thing in this unit Arnaud may want to
weigh again"), and name there the two observables above beside the two cells it
moved. The common brief's stop rule asks for exactly that: a new observable
compatibility choice is recorded as a blocker, not as prose.

### Re-expressed cells: do they pin the ruled behaviour?

- `nested-write-concurrency-behavior.ts` "an adopter whose captured owner was
  replaced **aborts, re-plans once, and converges**". The abort clause
  (`batchErrors.length >= 1`) is KEPT and is now the whole discriminator: the
  final rows the cell expects (`["s2/b1"]`) are the same rows the unpinned
  adoption would leave, which the old comment named as the forbidden outcome. I
  checked the mutation the row still falsifies: with the in-batch captured-owner
  premise removed the loser writes and reports success with NO batch error, so
  the row reddens. The single-half mutations left the row green before this
  change too (its own comment said so), so nothing was lost. The refusal the row
  used to observe survives: the sentence is still pinned in
  `junction-races-live.ts`'s `NestedWriteError` branch (reached by the held
  race) and verbatim in `integration-membership-race.test.ts` cell 2.
- `junction-races-live.ts` `g2-junction-captured-owner-replaced`. `winners`
  moved from `["s1"]` to a deepEqual `["s2","s1"]`, which I checked against the
  fixture's own actor/peer/owner wiring: the actor is `s2` (captures `s0`,
  pauses), the peer `s1` completes its transfer, the actor's unit aborts at the
  captured-membership premise, re-plans, captures `s1`'s pair and transfers it —
  so both succeed and the last adopter (`s2`) holds the target, which the cell
  now asserts directly (`requested[0].holder === "s2"`, plus the unconditional
  `requested.length === 1`). The `winners.length === 1` law it stopped applying
  to this shape is replaced by a STRICTER exact assertion, and it is kept for
  the simultaneous held race, which still has one winner. The first attempt's
  abort is newly pinned through an indexed `NestedWriteAssertionError`.

Neither cell pins a wrong answer; both are re-expressions of a refusal the
rulings converted into convergence, and both still falsify the removal of the
premise they exist for. No test was deleted, weakened or skipped anywhere in the
diff (no `.skip`/`.only` added, no `it`/`test` removed; 8 assertion lines
removed, 39 added).

## D-32 — raceable capture premises, with witnesses

**ACCEPT.**

- **One owner, one statement of the fact.** `failure.meta.raceable = true` is
  stated once where the sentence is built (`:2571`) and the `else` collapses; no
  field, no branch, no boolean. The sentence is what carries raceability, which
  is the ruling's own words.
- **The table is complete and right.** I enumerated every `requirePresent` /
  `requireAbsent` in `src/`: twelve queued sites plus the prepared
  `packagedPresence` guard record — exactly the thirteen rows of the note. Every
  `meta.raceable` assignment in raptor3 is accounted for
  (`commands/commands.ts:1218`, `commands/execution.ts:127`, `:743`,
  `operation-context.ts:2571`, and `:1384`'s `raceable: false`); the one further
  mark at `operation-context.ts:2477` is the DIRECT route's JavaScript throw,
  correctly outside the table's stated scope. No premise the table calls
  unmarked carries a mark from its error builder. I confirmed row 9's provenance
  independently (`git log -S` → `d82c123be`, the repair round's R1c), so "added
  BY the repair round" is right.
- **Exactly the loss-after-observation premises are marked.** Both
  `captureMembership` arms carry it; the identity premises
  (`commands/execution.ts:264`, `:833`) do not, and their pins are live, not
  merely green: `transitions/conditional-upsert.ts:367-369` asserts
  `meta.raceable === undefined` under the sentence "Captured-row replacement or
  deletion must not permit a retry against another identity", and
  `g2-upsert-skip-replaced` / `-deleted` / `-setwhere-match-replaced` all ran and
  passed in `g2-contracts`.
- **A real witness per marked arm.** `integration-membership-race.test.ts`
  plants a competing commit (a real row move on the same SQLite database) in the
  window between the capture and the write batch, on a transport that proves its
  rollback: cell 1 is the present arm (re-plans once, converges, one holder),
  cell 3 is the absent arm (slot read empty, then taken), cell 2 is the
  allowance spent once with the registered sentence propagating and the racing
  writer still holding the target. This is the witness pattern the brief named.
- **The falsification reproduces exactly** (above): the present arm's unique
  coverage is cells 1 and 2, and cell 3 stays green.

Two notes, neither blocking:

- **Resolution 3 (documentation).** The D-32 line references are stale by about
  a hundred lines, because they were recorded before D-28's insertions above
  `captureMembership`. In the final file: the hunk is `:2560-2574` (not
  `:2461-2477`), `submit`'s raceability gate is `:1227-1241` (not
  `:1143-1177`), table rows 11 and 12 are `:2573` and `:2574` (not `:2473` /
  `:2476`), and the prepared guard's `raceable: false` is `:1384` (not
  `:1298-1320`). Restate them against the final file.
- **`commands/execution.ts:360` (the author's blocker 2) is disclosed correctly,
  and its argument can be made stronger than the sentence alone.** I read the
  premise's construction: its excluded identities are
  `targets.map((t) => t.lookup.fields)` (`commands/relation-body.ts:755-766`) —
  the rows the CALLER spelled in `set`, not rows this plan observed. That is the
  structural difference from `requireNoAddedMember` (`:744`), whose exclusion IS
  the plan-time read, and it is why the two look like one premise class but are
  not. Its only failure mode is a member appearing, for which the capability
  refusal remains the right answer on the fresh world, so leaving it unmarked is
  right for a reason the ruling itself states (identity/authorship, not
  observation). Worth adding that sentence; the decision can stand as disclosed.

## Unverified by this review

- MySQL (`g2-mysql-contracts`, `tests/providers/docker/mysql2*.test.ts`),
  `provider-pglite`, `provider-postgres`, hosted-driver, migration and package
  projects; the estate lanes and the whole fixed group (the integrator's runs).
- The layer projects (`layer-client`, `layer-drivers`, `layer-query-engine`,
  `layer-write-engine`) and the pglite files — I took the author's receipts for
  those; my scope re-ran the parity, transport, transitions and pg Docker
  evidence instead.
- CPU cost: like the author, I measured statements and round trips from a
  recording driver, not the `g4/` CPU protocol; no A/B benchmark was taken.
- My round-trip and meta measurements used temporary probe files under
  `tests/raptor3/g4/parity/` which I deleted; the recipes are in this review, but
  they are not registered cells (that is Resolution 1).
- Whether any consumer outside this repository reads
  `meta.recordSeriesProgress.memberPath` for an aborted (never-committed) batch;
  no registered cell does.
