# R3 — the bounded D-65 contract, implemented at the two owners it names

Unit R3 of the final local closure (decided handoff §5, implementing §1's two
D-65 decisions). Author: Fable, worktree `/private/tmp/viborm-r13`, branch
`closure-r13` from `cdd787ac8`. Same production author as R1, per handoff §7;
R1's files are left as R1 reported them except the two owners this unit shares
with it (`commands/execution.ts`, one comment; `AGENTS.md`, two addenda).

---

## 1. The failing witness

FCPG measured the window on real PostgreSQL and recorded it as GREEN cells,
because at `cdd787ac8` the engine's answer WAS the positional one. D-65 changes
the answer, so those two cells are the failing witness of this unit: run them
against the repaired engine and they reject.

| cell (FCPG's wording) | at `cdd787ac8` | with D-65 implemented |
|---|---|---|
| *batch route: the same schedule deletes a row that had stopped being a member before the write executed* (B holds a row lock; A's ID-only DELETE waits on it) | passes — n1 deleted although `active = false` when the DELETE ran, row count matched, operation reported success | **fails**: `deleteMany selected-row cardinality changed during its locked mutation.` |
| *batch route: a captured row that stops matching between the last premise and the first write is still deleted* (the window made exact by the split-batch hook) | passes — same silent effect | **fails**: the same sentence |

`receipts/pg-fcpg-cells-under-d65.log` is that run: **2 failed / 8 passed**, and
the eight that stayed green are the interactive route, the joiner cells, the
live abort guard and both controls — the repair moves exactly the two answers
D-65 decides and nothing else. Both cells are re-expressed in this unit (§5),
naming D-65 at the cell, per the common rules' "a recorded expectation is
re-expressed only where the decided contract changed the answer".

After: **16 / 16 green** (`receipts/pg-captured-set-concurrency-final.log`).

---

## 2. The fact, and its one owner

**The fact.** A captured root mutation is about the rows the capture NAMED and
that still satisfy the selector it captured them BY. The identity set alone
addresses a row by a key that *was* in the selection; the selector is what that
row must still satisfy for the statement to be about it.

**The owner.** `OperationContext.capturedTarget`
(`src/query-engine/raptor3/shared/operation-context.ts`) — one private method
that composes the prepared meaning at `Queries` and lowers it through the same
owner the ordinary (uncaptured) bulk path already uses:

```ts
q.lowerMutationLimit(
  model,
  q.andSelectors(model, [selector, q.includeIdentities(model, identities)]),
  undefined
).where
```

`Queries.includeIdentities` is FC-03's `excludeIdentities` turned positive: the
disjunction of the captured rows' own identity equalities, composed under the
one combinator owner (`combine`), never spelled as a public `{ OR: … }` payload
— N4 lets a model declare a scalar named `OR`, which is the executed failure
FC-03 repaired. Both set owners now read one private `capturedSet`, so the rule
"a captured set is its identities' disjunction, and a set pins no equality"
exists once.

**The second consumer.** `deleteMany`'s captured branch. `updateMany`'s captured
branch is the first; both call `capturedTarget` with their own selector and
their own captured identities, and neither spells the addressing rule itself.
The nested captured series is the OTHER half of D-65 and deliberately consumes
nothing here (§4).

**Not restated at the write:** the `limit`. The capture already took that slice
(`captureMutationIdentities`'s `take`), so the identity set IS the bound —
pinned by the limited-capture cell, whose unit is `[2 statements, 1 premise]`
and whose newly eligible row is untouched.

**Measured consequence, stated because it is a change in emitted SQL.** The
effect's identity equalities now go through `prepareScalarPredicate` like every
other prepared comparison, so a text key is compared case-sensitively
(`COLLATE BINARY` on SQLite, the dialect's equivalent elsewhere) — exactly the
comparison the complement premise beside it already used. The write and the
premise now speak about the same set; before, the premise was case-sensitive
and the effect was not.

---

## 3. What was deleted

| deleted | where |
|---|---|
| The effect's addressing rule, spelled twice: `adapter.operators.or(...identities.map((identity) => q.lowerIdentity(model, identity)))` in `updateMany` **and** in `deleteMany` | replaced by the single `capturedTarget` call in each |
| `excludeIdentities`' own copy of "map the identities to predicates and mark the facts inexact" | now the shared private `Queries.capturedSet`, read by both set owners |
| The stale promise in `requireCapturedSet`'s doc comment ("every captured row is STILL PRESENT and STILL A MEMBER … A stale observation aborts the atomic unit before anything is written") and the two `FOR UPDATE` sentences that claimed phantom exclusion (`captureMutationIdentities`, `requireNoAddedMember`, and the guide's "an interactive transaction needs none of this") | corrected in place, §6 |

No owner was deleted: the premises, the cardinality check and `Queries.lowerIdentity`
(five other callers) all stay. **Deletion is small and honest; the unit's cost
is net positive (§7)** — the behaviour D-65 requires is a predicate the
statement did not carry before.

---

## 4. The two D-65 bounds, as implemented

**Root selected UPDATE/DELETE — effect-time selection.** The consuming
statement carries the complete captured identity set AND the prepared selector.
A captured row that stopped matching is not mutated. The existing premises stay
where they were (they answer as the unit BEGINS, and still abort a unit whose
capture was already stale — pinned). The existing cardinality check stays where
it was, in each verb, and is what turns the shortfall into the registered
sentence rather than a silent success over the captured rows.

**Failure and commit stay separate facts.**
- On an operation-owned interactive transaction the owner rolls back; nothing
  in this unit touches transaction ownership or recovery authority.
- On a batch that has already ACKNOWLEDGED, what it committed stands. The
  sentence is now raised through the existing failure owner
  (`throw this.failure(changed(), "result")`), so it carries
  `atomicity: "segment"`, `phase: "result"` and `committedSegments` — asserted
  in four cells against the real committed table state. Nothing is replayed, no
  progress is erased, and no post-dispatch check pretends to be a rollback.
- The recovery allowance is untouched: a captured row's presence guard is
  `raceable: false` and `submit` already refuses a recovery to an operation
  holding committed progress.

**Nested captured series — a bounded worklist.** Capture once, prepare all,
execute in order: unchanged. `requireNoAddedMember` and its one permitted
recovery: unchanged and pinned (a member added BEFORE that premise still aborts
the unit and the recovery converges). A member that qualifies AFTER it stays
outside the worklist — no enlargement, no second recovery. The initial filter is
not re-asked at each member's own write, which is what lets an earlier member
legally change what a later one was selected by (pinned on the default native
route). What each member owes AT THE POSITION IT IS CONSUMED — its identity, its
parent's, its relation membership — is unchanged and still enforced: the
reassignment cell shows a member moved to another parent is NOT deleted for the
parent that no longer holds it. **No engine change was needed for this half**;
its work was the bound's statement (comments, guide) and its witnesses.

---

## 5. The witnesses

`tests/providers/docker/pg-captured-set-concurrency.test.ts`, **10 → 16 cells**,
all green on native PostgreSQL 16.14 over two and three real connections. The
schedules are FCPG's (the split-batch hook and the held-row-lock schedules,
unchanged); the contract they assert is D-65's. Default native routes are kept
apart from the capability-forced non-RETURNING profile, in the header and in the
cells.

Consumer 1 (root selected bulk mutation):

| # | cell | asserts |
|---|---|---|
| 1 | default native route, lock held | no capture, no premise: the one RETURNING statement removes only the row it still matches, publishes it, and the other survives |
| 2 | interactive forced-capture route, lock held | `FOR UPDATE` re-reads B's committed version: the row that stopped matching was never captured (unchanged FCPG cell) |
| 3 | batch route, lock held | **re-expressed (D-65)**: the captured row that stopped matching survives, the sentence is raised, the row that still matched is committed, and the failure reports `segment`/`result`/`committedSegments: 1` |
| 4 | batch route, exact window, DELETE | **re-expressed (D-65)**: same, with `[4 statements, 3 premises]` and the ordered schedule |
| 5 | batch route, exact window, UPDATE | new: the same contract for the other verb, and the non-RETURNING read-back never runs behind the cardinality answer — n1 keeps its label, n2 has the committed one |
| 6 | batch route, joiner in the window | unchanged answer, D-65's words: the captured set IS this statement's set |
| 7 | batch route, LIMITED capture + newly eligible row | new: `[2, 1]` (no complement), the slice is deleted, the joiner is untouched |
| 8 | batch route, COMPOUND identity | new: both key components carried; only the row that still matches is deleted; the other survives with the sentence |
| 9 | batch route, captured row removed before the premises | unchanged: the premise aborts the unit and nothing is written |
| 10 | control | unchanged: an irrelevant change in the window is irrelevant |

Consumer 2 (nested captured series under a membership):

| # | cell | asserts |
|---|---|---|
| 11 | member added before the premises | unchanged: the complement aborts raceably, the one recovery converges |
| 12 | member added after that boundary | **re-expressed (D-65)**: outside the bounded worklist; the operation succeeds and claims nothing about it; `[7, 6]` |
| 13 | captured member stops matching the filter in the window | **re-expressed (D-65)**: the filter selected the worklist and is not re-asked at the member's write |
| 14 | required membership reassigned before the premises | new: the member moved to another parent is NOT deleted; the recovery re-plans against the parent's current members |
| 15 | default native route, an earlier member's own write flips the filter's field | new: both captured members are written; the prepared worklist is not invalidated by an admitted sibling |
| 16 | control | unchanged |

**Falsification** (backup copy in `$TMPDIR`, mutate, run, restore by `cp`; the
engine is byte-identical afterwards, checked by digest):

| mutation | result | receipt |
|---|---|---|
| `capturedTarget` composes the identity set ALONE (drops the selector) | **4 red**: cells 3, 4, 5, 8 — the effect-time half is load-bearing and each verb, the compound key and the lock schedule each catch it; every control stays green | `receipts/falsify-a-selector-dropped.log` |
| `capturedTarget` composes the selector ALONE (drops the identity set) | **2 red**: cells 6 and 7 — the boundedness half is load-bearing (the joiner and the limited slice) | `receipts/falsify-b-identities-dropped.log` |

The cardinality check's own coverage is what cells 3, 4, 5 and 8 assert as a
SENTENCE (not merely as a surviving row), and it remains the only check on the
interactive route, where no premise is stated at all.

---

## 6. Comments and guide corrected

- `requireCapturedSet`: the promise about the effect is gone. It now says what
  the premises claim (the unit's beginning), that they claim nothing about the
  effect, and that the window between the last premise and the write belongs to
  the write's own selector (D-65).
- `captureMutationIdentities`: `FOR UPDATE` holds the rows it READ; a row that
  JOINS afterwards is a different guarantee no row lock gives, and it is not
  this statement's row.
- `capturedMutation`: one fact at two positions, and the separation of failure
  from commit.
- `CommandExecution.requireNoAddedMember`: the premise BOUNDS THE WORKLIST; a
  later joiner neither enlarges it nor earns a second recovery; the filter is
  not a per-member predicate; what each member owes at its consumption point is
  unchanged. Its `FOR UPDATE` sentence ("its member set cannot grow underneath
  it") was false and is corrected.
- `src/query-engine/raptor3/AGENTS.md`: two addenda, each beside the paragraph
  it corrects — one after the FC-03 captured-set addendum (the full D-65
  contract, both halves), one after the nested-series paragraph (the row-lock
  correction).

---

## 7. Runs, cost and checks

| run | result |
|---|---|
| `tests/providers/docker/pg-captured-set-concurrency.test.ts` (`--project=provider-pg`, one file per invocation) | **16 / 16**, twice on the final tree (`receipts/pg-captured-set-concurrency-final.log`, `…-first-green.log`) |
| the same file at the start, against the repaired engine and FCPG's original cells | 2 failed / 8 passed — the failing witness (`receipts/pg-fcpg-cells-under-d65.log`) |
| `g4/parity/batch-captured-bulk` + `prepared-set-predicates` (the owner pins) | 32 / 32, both projects (`receipts/consumers-batch-captured-bulk-and-prepared-set.log`) |
| `g4/parity/member-boundary-packaging` + `published-key` | 34 / 34 (`receipts/consumers-member-boundary-and-published-key.log`) |
| `g4/parity/transport-witnesses` + `one-write-outcome-composition` + `g3/author-execution-regressions` (the D-58 / FC-05 outcome pins) | 28 / 28 (`receipts/d58-fc05-outcome-pins.log`) |
| `g3/bulk-series-contract` + `g4/parity/integration-staleness` + `captured-identity-domains` (the neighbour family) | 53 / 53 (`receipts/neighbour-family.log`) |
| `g4/parity/integration-membership-race` + `exclusive-member-cardinality` | 31 / 31 |
| `g4/unit02/key-arithmetic` + `g4/parity/generated-key-reach`; `g3/bulk-result-boundary` + `g4/unit02/malformed-result-cuts` | 56 / 56 and 18 / 18 |
| `core-structure/measurement/cs02-structure-measure` | 1 failed — the SAME pre-existing matrix-registration failure R1 recorded, byte-identical text (`receipts/cs02-structure-measure.log`); not this unit's |
| `node scripts/run-typecheck.mjs` (whole estate, once, at the end) | **0 diagnostics** (`receipts/typecheck.log`) |
| `node scripts/raptor3-refusal-census.mjs` | **identical to `cdd787ac8`**: 23 candidate sentences at 30 sites, 75 inherited, 21 invariant, 11 internal, **193 sites** (`receipts/census-after.md`; normalised diff against R1's census is empty) |
| Biome, per changed file against its base copy | identical rule sets and counts (query 16, operation-context 7, execution 5 — all pre-existing, the formatter was NOT run on them). The pg suite's base copy is clean and so is the rewritten file (`receipts/biome.txt`) |

**Cost.** Engine token-bearing LOC **16,040 → 16,073 (+33)**; physical 20,482 →
20,579 (+97, the rest docblock); functions 1,095 → 1,096; parameters 1,653 →
1,659; branch nodes 2,566 → 2,566 (`receipts/structure-before.json`,
`structure-after.json`). R3-only diffs: `shared/query.ts` +47 / −9,
`shared/operation-context.ts` +73 / −25, `commands/execution.ts` +12 / −1
(comment only). Non-engine: `src/query-engine/raptor3/AGENTS.md` +41 / −0,
`tests/providers/docker/pg-captured-set-concurrency.test.ts` +428 / −74 (the
guide figure is this unit's two addenda; `git diff cdd787ac8` reports +78 for
`AGENTS.md` because R1's addenda are in the same file).

The growth is the behaviour D-65 asks for: a predicate the statement did not
carry, stated once at `Queries` as prepared meaning and composed once in the
context. No abstraction was added to improve this report.

**One deviation worth its own paragraph.** The first shape folded the row-count
check INTO `capturedMutation`, passing the sentence factory as a parameter. The
tree's own census then read the throw as a rethrow — the sentence stood behind
a parameter instead of a local factory — and the public candidate count moved
**23 → 21** with sites 193 → 192, although both sentences were still thrown
verbatim. That is an instrument regression caused by code shape, so the fold was
reverted: each verb throws its own sentence where it builds it, now through the
failure owner (`throw this.failure(changed(), "result")`), which is what carries
the segment progress. The census is identical to the base again. The duplicated
two-line count check is the price, and it is named here rather than hidden.

---

## 7b. Registrations (the manifest was NOT edited)

**None owed.** `scripts/raptor3-manifest.mjs` carries no `tests/providers/docker/**`
row at all — the provider projects are registered by glob in
`vitest.workspace.ts` (`providerProject("pg", ["tests/providers/docker/pg*.test.ts"])`),
so `pg-captured-set-concurrency.test.ts` joined `provider-pg` by its name when
FCPG created it and its cell count (10 → 16) is not a manifest value. No
credential-free list names it either: the file is gated by
`PG_TEST_CONNECTION_STRING` like every sibling. The manifest row R1 owes
(`reference-representability` 12 → 26) is unchanged by this unit and is reported
in R1's note.

## 8. Unverified

- **Native MySQL was not exercised for this change.** Its assigned container was
  not running at this unit's time and the MySQL lane belongs to R2, which is
  repairing it in parallel; my brief names only the PostgreSQL witnesses. MySQL
  is the adapter that declares `supportsReturning: false`, so this route is its
  DEFAULT path: the composed target goes through exactly the same
  `lowerMutationLimit(model, selector, undefined)` owner the uncaptured bulk
  path already uses there, including the mutation-target hiding MySQL needs
  (ERROR 1093), and the identity equalities are the same prepared comparisons
  the premises beside them already emit. Expected, not measured.
- The consumer-1 cells reach the capture route through a **capability-forced**
  non-RETURNING pg driver. The concurrency, the locks, the statements and the
  provider are native; the capability profile is not. This is not a native MySQL
  or hosted-driver receipt, and the file says so in its own header.
- The batch route is **simulated over PostgreSQL** (no interactive transaction,
  one native atomic batch in one real transaction). Whether D1, PlanetScale or
  Neon expose the same premise→effect window over their own batch protocols is
  not measured here.
- The hook splits one atomic batch into two `executeBatch` calls on the same
  connection and transaction, so statement-index attribution inside a split
  batch is not the shipped one; no cell asserts an attribution, and the cell
  that asserts a rejection at a premise uses the unsplit placement.
- `fc06/note.md` and `fc06/release-verdict-draft.md` still describe D-65 as
  pending with "nothing is implemented". They are SEALED historical unit
  records and were left untouched; the current release verdict and behavioural
  inventory belong to unit **R4**, which must now reflect this adoption.

## 9. Blockers

None. The contract is implemented within the boundaries: no capability flag, no
second interpreter, no concurrency framework, no new recovery scope, no
`FOR UPDATE` claim about phantoms, no isolation change, no blanket lock and no
scheduler; transaction ownership and recovery authority are untouched; no test
was deleted, skipped or weakened.

**Environment note for the integrator.** The lane's assigned PostgreSQL
container was gone when this unit began (nothing listening on its port). It was
re-created from the assigned connection string alone — `postgres:16` on the
same port, same user and database, `POSTGRES_HOST_AUTH_METHOD=trust` because
that string carries no password — as `viborm-r13-pg-g3`; the string itself was
never printed, logged or copied, and it was substituted into one command at a
time. The suite creates and uses its own database (`fcpg_closure`) and drops
only its own `fcpg_`-prefixed tables, so no lane shares state with it. Version
measured: **PostgreSQL 16.14** (FCPG's receipts were taken on 16.4).

---

```
feat(raptor3): the captured set's selector belongs to its effect, and the nested worklist is bounded (D-65)

D-65 is adopted from the decided closure handoff §1 and implemented at the two
owners it names.

Root selected UPDATE/DELETE over a captured set now carries both facts into its
own statement: the complete captured identity set and the prepared selector the
capture ran. OperationContext.capturedTarget composes them once at Queries —
the positive counterpart of FC-03's complement, Queries.includeIdentities, under
andSelectors and the same lowerMutationLimit owner the uncaptured bulk path
uses — so both verbs share one addressing rule and neither respells public where
syntax. A captured row that no longer satisfies that selector is not mutated,
and the existing cardinality check turns the shortfall into the registered
sentence instead of a silent success publishing the captured rows. The premises
requireCapturedSet states ahead of the write are unchanged; a limit is not
restated at the write, because the capture already took that slice.

Failure and commit stay separate facts. An operation-owned interactive
transaction rolls back at its owner. A batch that already acknowledged keeps
what it committed and now reports it through the existing failure owner
(atomicity: "segment", phase: "result", committedSegments): nothing is
replayed, no progress is erased, and no post-dispatch check pretends to be a
rollback.

The nested captured series is the other half of the decision and is bounded, not
enlarged: the initial filter selects the worklist and is not a permanent
per-member predicate, a member that qualifies after the complement premise stays
outside it with no second recovery, and what each member owes at the position it
is consumed — identity, parent, relation membership — is unchanged and still
enforced. No engine change was needed there; the comments that promised stronger
locking, membership or rollback than the code provides are corrected, FOR UPDATE
included: it holds the rows the read returned, which is not phantom exclusion.

Witnesses: tests/providers/docker/pg-captured-set-concurrency.test.ts 10 -> 16
cells on native PostgreSQL, the default route kept apart from the forced
non-RETURNING profile, both root verbs, compound identities, the limited
capture, the acknowledged-batch progress report, the membership reassignment and
the sibling-filter cell. Falsified both ways: dropping the selector turns four
cells red, dropping the identity set turns two. Engine token-bearing LOC 16,040
-> 16,073; census, Biome and typecheck unchanged (0 diagnostics, 23 candidate
sentences at 193 sites).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
