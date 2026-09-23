# U2 — nested membership, carried through the effect

Repair prompt §2. Branch `closure-se` from `bc18b4e23` (base for this unit is
the tree U1 left), worktree `/private/tmp/viborm-se`, native PostgreSQL 16
(`raptor3_g2` server, this file's own `fcpg_closure` database) and native
MySQL 8 for the premise-shape check. Receipts: [`receipts/`](receipts/).

**The fixture is the repository's forced batch profile, not stock pg and not a
hosted driver.** `PgWindowedBatchDriver` / `PgCapturingBatchDriver` run real
multi-connection PostgreSQL with `supportsTransactions = false`,
`supportsBatch = true` and (where the cell needs it) RETURNING switched off —
the MySQL/PlanetScale capability profile executed against native PostgreSQL.
PostgreSQL's own route answers a selected bulk mutation with RETURNING and
never captures, so it cannot witness this contract at all.

## 1. The failing witness

`tests/providers/docker/pg-captured-set-concurrency.test.ts`, run on the
unchanged production source of this unit's base
([`receipts/01-pg-captured-set-red-at-base.log`](receipts/01-pg-captured-set-red-at-base.log),
**7 failed / 18 passed**). Five are the defect; two are re-expressed pins (§7).

| falsifier | red at base |
| --- | --- |
| a member reassigned between the last premise and its OWN write is not deleted | `expected [ 'm3' ] to deeply equal [ 'm2', 'm3' ]` |
| lock held: a reassignment the member's own requirement waits behind | `expected [ 'm3' ] to deeply equal [ 'm1', 'm3' ]` |
| lock held: a captured UPDATE member's requirement waits behind it | `expected 'undefined' to be 'Cannot update relation \'members\': t…'` |
| lock held: a REFERENCE member's requirement waits behind it | `expected 'undefined' to be 'Cannot update relation \'teams\': tar…'` |
| default native route: the junction the member is consumed through is held too | `expected 'undefined' to be 'Cannot delete relation \'members\': a…'` |

After the repair the file is **25 / 25**
([`receipts/02-pg-captured-set-green.log`](receipts/02-pg-captured-set-green.log)).

The review's own placement — the reassignment of `m1` at
`between-premises-and-writes` — is registered as the FIRST row above, moved to
`m2`, and the reason is the reason §1 gives for its own hooks: with the repair,
`m1`'s membership is already held for `m1`'s write when that window opens, so
a hook that waits there waits for this unit. `m2`'s own write is still ahead,
and it is the position the claim is actually about — "the requirement a member
owes AT THE POSITION IT IS CONSUMED". `m1`'s version is registered as the
lock-HELD schedule instead (row 2), which is strictly stronger: it needs no
hook at all, and it covers both orders of the race.

## 2. The continuing invariant, and its single owner

**Invariant.** A batch is one transaction, not one statement. Under READ
COMMITTED every statement takes its own snapshot, so a premise's answer expires
at the next statement of the same transaction: it OBSERVES a requirement, it
does not protect it. A captured member's continuing requirement — its own row,
and the membership it is consumed through — is therefore re-taken at the
position the member is consumed, as a read that HOLDS what it proves for the
rest of the transaction, on the row that STORES the membership.

**Owner.** One rule, one method: `CommandExecution.holdMember`
(`src/query-engine/raptor3/commands/execution.ts`), called from exactly one
place — `executeSeries`, inside the `executeMember` body, beside the parent
requirement that site already restates per member and immediately before
`run(child)`. One query owner per substrate fact, both already in the tree:
`Selection.captured(…, held)` for the member's own row, and
`Queries.junction(edge, values, true)` — the read owner
`OperationContext.captureMembership` already uses for a singular junction slot
— for the junction row. There is no second interpreter, no per-verb switch, no
new rollback and no concurrency manager.

**Why the row that stores the membership, and not the member row.** Measured on
native PostgreSQL, all three with B's reassignment held UNCOMMITTED while A runs
([`receipts/13-substrate-probe.log`](receipts/13-substrate-probe.log), script
beside it):

```
[held identity-only]       A waited=true  outcome=deleted m1                        members=m2
[held exists-predicate]    A waited=true  outcome=deleted m1                        members=m2
[held junction-forupdate]  A waited=true  outcome=REQUIREMENT LOST — nothing written members=m1,m2
[A first, junction-forupdate] B waited=true                                         members=m2
```

The middle row is the repair prompt's own warning executed: the membership
carried into the effect as SQL waits for the racer, wakes, and re-evaluates
against a STALE cross-table snapshot — PostgreSQL re-checks a blocked write's
qualification against the updated TARGET row, but subqueries over other tables
keep the original snapshot. The last row is the other order: once this unit
holds the junction row, the racer waits for it, which is what "lasts through
the effect" means.

## 3. The hunk

```
 src/query-engine/raptor3/commands/execution.ts           |  81 +      (holdMember + its call)
 src/query-engine/raptor3/commands/selection.ts           |  16 / -1   (captured's `held`)
 src/query-engine/raptor3/AGENTS.md                       |  44 +      (two addenda)
 tests/providers/docker/pg-captured-set-concurrency.test.ts | 557 / -7 (8 new cells, 3 re-expressed)
```

- `selection.ts`: `captured(condition, membership, take)` becomes
  `captured(condition, membership, take, held = false)`, `held` reaching
  `forUpdate` on the same `Queries.select` call. One argument; no new query.
- `execution.ts`: `holdMember(member, located, membership)`. Nothing when the
  series has no membership. On the BATCH route it states the member's own
  requirement as a HELD premise (`captured(undefined, membership, 1, true)`)
  and marks the selection `attempt.retained`, so the located record's own
  premise (`run`'s `case "record"`) does not state the same query a second time
  without the hold; then, for a junction edge, the junction row under its own
  lock. On the INTERACTIVE route the capture already read the member rows
  `FOR UPDATE`, so only the junction row is taken — as a read whose miss raises
  the member's own failure.
- The failure is the one the member already owned, unchanged: the captured
  series' `membershipRaceFailure(…, "removed")` for a deletion (raceable), and
  the located target's `Cannot <verb> relation '<edge>': target record was not
  found for this parent.` for an update (not raceable — a re-plan would re-read
  that selector and act on whatever answers it now, D-34).

Route summary — the same requirement, the substrate's own mechanism:

| membership | batch route | interactive route |
| --- | --- | --- |
| reference (the member's own column) | one held premise over the member row | the capture's `FOR UPDATE` already holds it |
| junction (a row of its own) | the held member premise **and** the junction row under lock | the junction row under lock |

## 4. What disappears

**One statement per captured UPDATE member.** `run`'s `case "record"` states
`located.captured(undefined, membership, 1)` for a series member unless the
selection is already `attempt.retained`. `holdMember` states the same query
WITH the hold and adds the selection to that set, so the unlocked one is no
longer issued: the premise is replaced, not doubled. No source branch is
deleted — the `case "record"` premise is the general located-record premise and
keeps every non-series consumer it already had.

**Not deleted, with its unique coverage named.** The capture-position premise
in `captureSeries` (`requirePresent(located.captured(undefined, membership, 1),
membershipRaceFailure(…))`, delete members) stays. Its coverage that
`holdMember` does not give: a member ALREADY lost when the unit begins aborts
the WHOLE unit before any write, so the one recovery re-plans and converges
instead of reporting a committed segment. That claim has its own cell — "a
LATER member reassigned before the unit's premises aborts it before any write,
and the retry converges" — which moves the reassignment to `m2`: delete the
capture-position premise and `m1` is deleted first and `m2` refused afterwards,
with a segment committed and no recovery.

## 5. A second applicable consumer

Beyond the deleteMany the review measured, the same rule answers for:

- the captured **updateMany** member, whose premise already stood at its
  consumption position and lacked only the hold. Witness: "lock held: a
  captured UPDATE member's own requirement waits behind the reassignment it
  must observe" — red at base, and its committed-change sibling ("… is not
  UPDATED for the parent that no longer holds it") was already green at base
  and is kept as the control that says so.
- a **REFERENCE** membership one depth up, where the substrate stores the
  membership in the member's own row: an org's captured series over its teams,
  each team carrying a captured series of its own. Witnesses: the held cell
  (red at base) and "a REFERENCE member reassigned in the window is not written
  as this parent's, and the series it carries never runs", which also pins the
  **second depth** — the refused member's own nested series never runs.
- the **interactive** route, where the junction row is the only thing the
  capture's `FOR UPDATE` does not reach. Witness: "the capture's FOR UPDATE
  holds the member ROW, and the junction it is consumed through is held too",
  whose racer touches the junction ROW alone (an ordinary `disconnect` locates
  the member first, and its own lock would make the capture wait and re-read).

## 6. Capability change

**None for a valid uncontended operation.** Every existing cell of the file
keeps its answer, including the two D-65 bound controls (a future joiner stays
outside the worklist; the initial filter is not re-asked at a member's own
write) and both routes' controls. What changes for a CONTENDED one is the
concurrency profile of the batch route, in the direction of the interactive
route it now matches: while a captured series holds a member for its own write,
a concurrent change to that member's row or to the junction row that makes it a
member WAITS for this unit instead of interleaving with it. That is what the
interactive route's capture-time `FOR UPDATE` has always done.

Cost: **+1 statement per captured member** (reference membership, and the
member's own held premise on the batch route) and **+2** for a junction
membership on the batch route; **+1** per member on the interactive route for a
junction membership. The unit's shape in the file's own pins moves from `[7, 6]`
to `[9, 8]`. No error sentence is added, changed or removed.

The locks are taken in the capture's own key order (`orderBy` keys ascending),
and the premise never locks an absence — it is addressed by a located identity
and a junction pair the capture read. A miss raises the member's own failure
and takes nothing further, so D-67's deadlock policy is untouched: a real
deadlock is still a visible failure with no replay.

## 7. Registrations

| file | cells | project(s) |
| --- | --- | --- |
| `tests/providers/docker/pg-captured-set-concurrency.test.ts` | **25** (was 17; 8 new) | `provider-pg` (glob `tests/providers/docker/pg*.test.ts`; no workspace or manifest edit) |

`scripts/raptor3-manifest.mjs` is NOT edited: the file is not in a
manifest-enumerated project, and no file is added.

### The re-expressed cells, and why

Three existing cells changed, none deleted, skipped or weakened (repair prompt
§2, named at each cell):

| cell | was | is |
| --- | --- | --- |
| the initial filter is not re-asked at each member's own write | the filter change lands on `m1` | it lands on `m2` — `m1`'s row is held for `m1`'s write by then, so a change to it would wait for this unit; `m2`'s own write is still ahead, which is where the claim is measured. Every assertion is kept. |
| a member added after that boundary stays outside the worklist | `driver.shape` `[7, 6]` | `[9, 8]` |
| control: a truly irrelevant concurrent change | `driver.shape` `[7, 6]` | `[9, 8]` |

## 8. Runs

One Vitest at a time; one docker file per invocation; each connection string
substituted from its file into a single command and never printed.

| run | result | receipt |
| --- | --- | --- |
| `pg-captured-set-concurrency.test.ts`, unchanged source (native PostgreSQL) | **7 failed / 18 passed** — 5 defects + 2 re-expressed pins | `01-…` |
| `pg-captured-set-concurrency.test.ts` (native PostgreSQL) | **25 / 25** | `02-…` |
| `series-member-premise`, `integration-membership-race`, `integration-staleness`, `transitions/series-staleness-commands` | 6 files, **24 / 24** | `03-…` |
| `batch-captured-bulk`, `correlated-membership`, `exclusive-member-cardinality`, `prepared-set-predicates`, `ordered-observation`, `fresh-member-placement`, `atomic-unit-batch.core` | 14 files, **150 / 150** | `03-…` |
| `providers/local/pglite-nested-writes.test.ts` (batch route) | **126 / 126** | `04-…` |
| `providers/local/sqlite3-nested-write.test.ts` (interactive conformance) | **170 / 170** | `05-…` |
| `nested-write-conformance-membership` | **30 / 30** | `06-…` |
| `nested-write-conformance-m2m` | **34 / 34** | `07-…` |
| the premise shapes and the junction lock on native MySQL | both parse; the junction premise holds its row (a second session times out) | `12-…` |
| the substrate probe (why a predicate is not protection) | 4 schedules | `13-…` |

The hold is proved by SCHEDULES, not by a moved hook: four of the five
falsifiers are lock-HELD schedules with no driver hook at all — B holds the
membership change uncommitted, A's own requirement waits behind it, and the
harness releases B only once it has observed A waiting (`heldRowLockSchedule`'s
`blocked`, asserted in every one of them).

### Falsification — each half's unique coverage

Applied to a backup copy in `$TMPDIR` and restored by `cp`; `git checkout` was
not used and nothing was staged
([`receipts/14-falsification.log`](receipts/14-falsification.log)).

| removed | red | green |
| --- | --- | --- |
| the JUNCTION half (the locked junction read) | the three junction lock-HELD cells (deleteMany, updateMany, the interactive route) + the two shape pins | both REFERENCE cells, and the committed-change reassignment — which the member premise's own membership conjunct still catches, because that statement takes its own snapshot |
| the member premise's HOLD (`held = false`, junction half kept) | the REFERENCE lock-HELD cell, and only it | everything else |

So neither half is redundant and each one's coverage is nameable: the member
premise is what a REFERENCE membership needs (its storage IS that row) and what
proves the row is still there; the junction read is what a JUNCTION membership
needs (its storage is a row no lock on the member reaches).

## 9. Typecheck, census, Biome

- **Typecheck**: `node scripts/run-typecheck.mjs` — **0 diagnostics, exit 0**
  ([`receipts/08-typecheck.log`](receipts/08-typecheck.log)).
- **Census**: `node scripts/raptor3-refusal-census.mjs`, exit 0
  ([`receipts/09-refusal-census.md`](receipts/09-refusal-census.md)). Every
  class is byte-identical to U1's — invariant 22 / 21, internal 11 / 11,
  inherited refusals 75 / 75, candidate refusals 30 sites / 23 distinct —
  except **rethrow 55 → 56** and therefore **total sites 193 → 194**: the one
  new site is `holdMember`'s interactive `throw failure()`, which raises a
  `DeferredFailure` the member already owns and is classified exactly as the
  premise it mirrors. No sentence is added, changed or removed.
- **Biome**: per changed file, against the base copies
  ([`receipts/10-biome-after.log`](receipts/10-biome-after.log),
  [`receipts/11-biome-base.log`](receipts/11-biome-base.log)). **Identical**: 9
  errors, the same four rules (`noParameterProperties` ×5,
  `useDefaultSwitchClause`, `noCommaOperator`, `organizeImports`), all
  pre-existing and none in a line this unit wrote, and the one `format`
  diagnostic is `selection.ts`'s, which its base copy already carried — so the
  formatter was NOT run on it and the lines added to it are written the way
  Biome wants. `execution.ts` was format-clean at base and is format-clean now.
  `pg-captured-set-concurrency.test.ts` was format-clean at base, so it was
  formatted, and the file was re-run green afterwards.

## 10. Cost

| perimeter | reference | after U1 | after U2 | U2's delta |
| --- | --- | --- | --- | --- |
| engine token lines (`scripts/query-engine-structure.mjs`) | 16,098 | 16,139 | **16,176** | **+37** |
| like-for-like | 19,956 | 19,997 | 20,034 (derived) | +37 |
| charged perimeter | 23,891 | 23,932 | 23,969 (derived) | +37 |

The two perimeter rows are DERIVED, not measured: both `src/` files this unit
touches are engine files inside both perimeters, so the same +37 applies. The
integrator's own reader run on the final tree is the measurement.

`git diff --numstat bc18b4e23` (tracked files, U1 and U2 together):

```
68	0	docs/architecture/raptor3-evidence/g4.md
122	3	src/query-engine/raptor3/AGENTS.md
182	12	src/query-engine/raptor3/commands/execution.ts
21	28	src/query-engine/raptor3/commands/relation-body.ts
37	8	src/query-engine/raptor3/commands/selection.ts
102	71	tests/providers/docker/mysql2-concurrency-policy.test.ts
557	7	tests/providers/docker/pg-captured-set-concurrency.test.ts
```

U2's own share: `execution.ts` 81 / 0, `selection.ts` 16 / 1, `AGENTS.md`
44 / 0, `pg-captured-set-concurrency.test.ts` 557 / 7. No negative engine LOC
was promised and none is claimed. `scripts/`, `benchmarks/`,
`vitest.workspace.ts` and `shared/operation-context.ts` are untouched by this
unit; no `src/` file outside the two this unit names is touched.

## 11. Unverified

- **The found-consumption premises of the batch route keep their unlocked
  form.** This unit's necessary fact — a premise's answer expires at the next
  statement of the same transaction — applies to them too
  (`Selection.retained` in `runSelection`, the located record's own
  `requirePresent`, the condition premises). `OperationContext.captureMembership`'s own junction premise on the batch
  route is the same unlocked window — the same junction-membership fact
  `holdMember` holds interactively — and is likewise unrepaired here.
  The bound of the hold itself, stated once: `holdMember`'s `FOR UPDATE` lasts
  to the end of the atomic unit that carries the premise (the transaction on
  the interactive route), so a member whose consuming statement is flushed
  into a LATER unit is outside it; no cell measures that shape. No schedule in this tree measures
  that window for them and nothing here claims it closed; the guide addendum
  beside the §1 paragraph says so. Closing it is the same one-argument change
  (`Selection.captured`'s `held`) at those three sites, and it would move the
  recorded premise SQL of several registered files, which is why it is reported
  rather than made inside a unit scoped to §2.
- **`driver.shape` is now `[9, 8]` for a two-member junction series.** The
  statement cost is stated at §6 and measured only through those two pins; no
  performance cell was re-measured, and none of this unit's statements is on a
  read path the protocol measures.
- **Hosted drivers are not exercised.** The batch route's MySQL profile
  (PlanetScale) is covered only by the premise-shape and lock check at
  `12-…`; SQLite and D1 omit `FOR UPDATE` at the adapter
  (`sqlite-adapter.ts:703-705`), so the same premise is issued there without a
  locking clause and the protection is the substrate's single-writer serialism,
  not a lock this engine takes. Neither is a new fact of this unit — it is the
  batch route's existing `forUpdate` story — but no cell measures it.
- **Not measured here**: the performance cells, the bundle footprint, the full
  native MySQL and PostgreSQL inventories, and every other registered project.
  This unit ran only what discriminates; the frozen gate is the integrator's.
- **The repair prompt and the review witnesses are absent from the worktree.**
  Both were read read-only from the main checkout
  (`docs/architecture/raptor3-local-closure-repair-prompt.md` and
  `g4/release/closure-review-bc18b4e23/`). The integrator should bring both
  into the commit.

## 12. Blockers

None.

## 13. Commit message draft

```
fix(raptor3): a captured member's membership is HELD through the write that consumes it

D-65 bounds the nested worklist at the capture and says what survives that
bound: what each member owes AT THE POSITION IT IS CONSUMED — its identity,
its parent's, and its relation membership — is unchanged and still enforced.
It was enforced by premises that only OBSERVED it. A batch is one transaction,
not one statement: under READ COMMITTED every statement takes its own snapshot,
so a membership change committed after a premise answered is visible to the
write behind it. The closure review measured it — a member moved to another
parent between the unit's last premise and its own ID-addressed DELETE was
still deleted for the parent that no longer held it.

`CommandExecution.holdMember` re-takes that requirement where the member is
consumed, beside the parent requirement `executeSeries` already restates there,
as a read that HOLDS what it proves for the rest of the transaction — which is
where the effect is. It is taken on the row that STORES the membership: a
REFERENCE membership is a column of the member's own row, so one held premise
over that row proves it, holds it and proves the row is still there; a JUNCTION
membership is a row of its own that no lock on the member reaches, and it is
taken under its own lock through `Queries.junction`, the read owner the
singular junction capture already uses. A locking read of the member alone
would not do, and neither would the membership carried into the effect as SQL:
PostgreSQL re-evaluates a blocked write's qualification against the updated
target row but keeps the original snapshot for subqueries over other tables, so
that write waits for the racer, wakes, reads a stale junction and writes
anyway — measured both ways under the unit's receipts.

Nothing reselects, retries or replays: a lost requirement raises the failure
that member already owned — the captured series' membership race for a
deletion, the located target's own identity sentence for an update — and
whatever segment the unit already acknowledged stands and is reported. The
interactive route holds the member rows already, so only the junction row is
left to take there. The located record's own premise is no longer issued for a
member `holdMember` has stated, so a captured UPDATE member trades an unlocked
premise for a held one rather than gaining a second. D-65's bound is untouched:
the filter that selected the worklist is still not re-asked at a member's own
write, and a future joiner stays outside it.

Witnesses: `tests/providers/docker/pg-captured-set-concurrency.test.ts`, 17
cells to 25 — the reassignment at the member's own write, four lock-HELD
schedules with no hook at all (deleteMany, updateMany, a reference membership
one depth up whose own nested series never runs, and the interactive route's
junction), the capture-position premise's own coverage, and the D-65 controls
unchanged. Engine 16,139 → 16,176 token lines.

Repair prompt §2.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
