# FC-01b — the six fixed-lane cells FC-01's placement repair changed

Branch `fc01b` in `/private/tmp/viborm-fc01b`, from `7c3c33a4e` on
`pattern-engine`. Node `v24.21.0`, Vitest `3.1.4`. Nothing committed, staged or
formatted; `benchmarks/**` and `scripts/raptor3-manifest.mjs` untouched; no
`src/` file changed (`git status --porcelain src/` empty, `shasum` re-checked
against the backups after every falsification).

**Outcome: (a).** The composition is VALID and, executed in the order FC-01's
rule gives it, legitimately violates a unique constraint. The old
`NestedWriteError` was the avoidable refusal FC-01 removed. The six cells are
re-expressed to the executed answer, with FC-01 named at the cell. No engine
change; FC-01 has no defect in this shape.

## The witness

The scenario is one: `s2-changed-dependency`
(`tests/raptor3/scenarios/contracts/instances.ts:115`), read in six cells —
`tests/raptor3/fixed.test.ts`, `tests/raptor3/candidate.test.ts` (both × the
two `G0_PROFILES`) and `tests/raptor3/candidate-ordering.test.ts` (× the two
profiles, which runs the scenario's assertion twice more, once on a payload
whose two relation keys are swapped). Every cell runs in two vitest projects
(`raptor3` and `coverage-raptor3`), so six cells are twelve executions.

**At the base (red).** The working copy of `instances.ts` replaced by
`git show HEAD:tests/raptor3/scenarios/contracts/instances.ts` (preserved and
restored by `cp`, shasum-checked): `fixed.test.ts` + `candidate.test.ts`
filtered to the scenario **8 failed**, `candidate-ordering.test.ts` **4
failed** — twelve, all the same assertion:

> `AssertionError: expected 'UniqueConstraintError' to equal 'NestedWriteError'`
> at `instances.ts:255`

which is the integrator's fixed-lane run
(`scratchpad/fc/wave1-fixed.log`, six cells, one project) reproduced here.
Receipts: `receipts/base-red-fixed-candidate.log`,
`receipts/base-red-candidate-ordering.log`.

**After (green).** **8 passed** and **4 passed** on the same two invocations.
Receipts: `receipts/after-fixed-candidate.log`,
`receipts/after-candidate-ordering.log`.

**Falsified against the engine.** With FC-01's own hunk inverted in a backup
copy of `commands.ts` (the `expanded` field, its set in `expandSeries`, and
`depend` reading it instead of `execution.started(ancestor)` — FC-02A and FC-03
left in place), the re-expressed cells go RED the other way: *expected*
`UniqueConstraintError`, *received* `NestedWriteError`. The new expectation is
therefore tied to FC-01's repair and to nothing else. Receipt:
`receipts/falsify-fc01-reverted.log`; the inverse hunk is written out in
`receipts/instrumentation.patch.txt`.

## The derivation

The payload (unchanged):

```js
shelf.update({ where: { id: 1 }, data: {
  label: "before-series",
  bins: { updateMany: { data: { targets: {
    connectOrCreate: { where: { id: 99 }, create: {} },
    set: [{ id: 2 }],
  } } } },
} })
```

Seed: shelves 1, 2; bins 10 and 11 on shelf 1, bin 12 on shelf 2; **targets 2
and 8**; membership (12, 8). `target.id`'s default is the fixture's own counter:
`1` until the capture cut `s2-selected-members-captured` fires, then `1` for the
first draw after it and `2` for every draw after that — the fixture's declared
`control: { initialDefault: 1, selectedMemberDefaults: [1, 2] }`.

**1. The physical order is the engine's canonical relation order, not the
payload's key order.** `relation-body.ts`'s `collectionMutationOrder` puts
`connectOrCreate` (index 4) ahead of `set` (index 5) for a to-many body. That is
exactly what the "relation key order" cell pins, and it still holds: the
reordered payload produces a statement-for-statement identical trace and an
identical observation (`receipts/trace-after-fc01.log`, the `original` and
`reordered` blocks).

**2. Under FC-01's rule, per selected bin B:**

| # | command | statement |
| --- | --- | --- |
| 1 | `connectOrCreate` lookup | `SELECT id FROM s2_targets WHERE id = 99 LIMIT 1` → no row |
| 2 | its missing arm | `INSERT INTO s2_targets ("id") VALUES (<default draw>)` |
| 3 | its link | `INSERT INTO s2_bin_targets (binId, targetId) VALUES (B, <that id>) ON CONFLICT DO NOTHING` |
| 4 | `set`'s target lookup | `SELECT id FROM s2_targets WHERE id = 2 LIMIT 1` |
| 5 | `set`'s clear | `DELETE FROM s2_bin_targets WHERE binId = B` |
| 6 | `set`'s link | `INSERT INTO s2_bin_targets (binId, targetId) VALUES (B, 2) ON CONFLICT DO NOTHING` |

Step 4 is the ordered observation. It is an observation only when step 2's
proposed id can be 2; the dependency pass decides that per member, by value.
Instrumented at `depend` and at `CommandExecution.run`
(`receipts/placement-instrumentation.log`, hunks in
`receipts/instrumentation.patch.txt`):

- **bin 10** (draws **1**): the create's literal `1` is disjoint from the
  lookup's exact `id = 2`, so `visitPrecedingWrites` never reaches `depend` at
  all. The lookup keeps `placement=before` and runs first — correct, and
  observed (`[FC01B run] kind=lookup placement=before` ahead of the choose).
- **bin 11** (draws **2**): the create proposes exactly the row the `set` looks
  up, so `depend` is entered with `follows=false`, `consumed=false`,
  `started(ancestor)=false`, and moves the reader:
  `0:choose/after | 1:link/after | 2:lookup/after<<MOVED | 3:remove/after |
  4:choose/after | 5:link/after` — behind the create arm and its link, ahead of
  the `set`'s own clear. That is precisely the schedule in the table above. At
  the base this same pair was the ONE `depend` call of the whole operation and
  it REFUSED (`receipts/trace-before-fc01.log`).

**3. What executing it produces.** Bin 10 completes: target 1 created, link
(10,1) created, the clear removes it again, link (10,2) created — bin 10 ends
holding exactly target 2 and target 1 is left orphaned. Bin 11's create arm is
`INSERT INTO s2_targets ("id") VALUES (2)`, and `s2_targets` already holds row 2
from the seed, so SQLite raises the table's PRIMARY KEY violation →
`UniqueConstraintError` V3001, `meta.columns: ["s2_targets.id"]`.

**4. No order avoids it.** Nothing in this payload removes or renames a
`s2_targets` row — the only deletion is `DELETE FROM s2_bin_targets`, a
membership — and `connectOrCreate`'s `where: { id: 99 }` matches no row in any
order, so the create arm runs for every member with the model's own id default.
Row 2 is therefore present whenever that INSERT runs. The reordered payload
confirms it empirically (identical trace, identical outcome). This is the same
answer the neighbouring lane already records for the same shape:
`tests/raptor3/g4/parity/lane-x-set-mutations.test.ts:369` ("spends the
recovery allowance once: a second consecutive race propagates") ends in
`UniqueConstraintError` for a `connectOrCreate` whose create arm collides after
the allowance is gone, and `:396` ("a connectOrCreate whose target a different
earlier entry creates observes and adopts it") pins the other arm — a second
entry's lookup, placed behind the first entry's create, adopting the created
row.

So this is not outcome (b): no member sits in the wrong position. The move is
the one the rule prescribes, and the violated constraint is on a table no
command in the payload deletes from. It is not the third outcome either: the
composition is unambiguous — had row 2 been free, bin 11 would have created it,
linked it, cleared its links and linked it again, which is one well-defined
state.

**5. Per profile.**

- `sqlite-interactive` (`replaysInPlace === false`): the operation opened the
  region, so its rejection aborts it and the recovery is the region owner's. It
  spends its one recovery and re-runs the whole operation. On the second attempt
  the template's commands are reused (no fourth template draw) while both
  members are rebuilt, and the generator now answers `2` to every draw, so bin
  10 collides too; the budget is spent and the violation surfaces. Draws
  `[1, 1, 2, 2, 2]`; final state = initial (both attempts rolled back).
  `CommandExecution.recover` is not involved — instrumented, it returns at
  `if (!this.context.replaysInPlace) return false`.
- `sqlite-atomic-batch` (segment atomicity): the root segment and bin 10's
  segment commit; bin 11's fails. `recover` is entered but
  `recoveryRejection(error)` classifies nothing (the proposed id 2 is not the
  choice's selected key 99, so the `connectOrCreate` race recovery does not
  apply) and it returns false. Draws `[1, 1, 2]` — unchanged from the base, so
  FC-01 did not move when defaults are drawn. Final: shelf 1 labelled
  `before-series`, targets 1, 2, 8, memberships (10,2) and (12,8).

## The fact, and its owner

The fact is the scenario's recorded ANSWER, and its owner is the scenario
definition — `changedDependency.assert` in
`tests/raptor3/scenarios/contracts/instances.ts`, the single place all six cells
read it from (`fixed.test.ts` calls it directly; `candidate.test.ts` and
`candidate-ordering.test.ts` reach it through `verifyG0Pair`). There is no
second copy of the expected answer: the corpus `candidate.test.ts` writes
(`adjudicated-instance-admission-corpus.json`) is emitted only when
`VIBORM_RAPTOR3_EVIDENCE_DIRECTORY` is set and is never read back as an
expectation, and `tests/raptor3/contracts.ts` carries the scenario's ID and
contract tags, not its outcome. So the re-expression is one hunk in one owner.

## The hunk

`tests/raptor3/scenarios/contracts/instances.ts` — `changedDependency.assert`
only (+90 / −23 lines, no other export touched):

- `~` the failure identity: `NestedWriteError` / `V7001` / the "depends on an
  earlier 'connectOrCreate' target write … Split these operations into separate
  queries." sentence → `UniqueConstraintError` / `V3001` / "Unique constraint
  violation".
- `+` `assert.deepEqual(…meta.columns, ["s2_targets.id"])` — the violated
  constraint is the target table's own key, so the cell now names WHICH row
  collides, which the refusal could not.
- `~` the `sqlite-atomic-batch` segment record: `phase` `"planning"` →
  `"member"`, `committedSegments` 1 → 2, `committedWriteMembers` 1 → 2,
  `completedMembers` 0 → 1. The located pair `{ memberPath: [1], totalMembers: 2 }`
  is UNCHANGED and stays unconditional: the failing member is the same one, and
  the retired-adjudicator comment that justifies pinning it here is kept.
- `~` `defaults`: now per profile — `[1, 1, 2, 2, 2]` interactive (the region
  owner's single replay), `[1, 1, 2]` batch (unchanged from the base).
- `~` `final`: interactive is now `initial` exactly (it was `initial` with the
  shelves branch); batch spells out the committed segments instead of
  `{ ...initial, shelves }`.
- `+` the comment block that names FC-01 at the cell, states the canonical
  relation order, the two members' draws, why no order avoids the collision, and
  that the placement itself is pinned by
  `tests/raptor3/g4/parity/fresh-member-placement.test.ts`.

## The rule deleted

None — this unit deletes no rule and adds none. What it deletes is a RECORD that
FC-01 falsified: the cell asserted a refusal the engine no longer issues, and
one guard clause of the old expectation (`final` = `{ ...initial, shelves }`,
which spelled "nothing else moved") stated something that is no longer true of
the batch route and is now written out in full rather than by spread.

The refusal sentence itself is not lost — but be exact about which part of it
survives where. The V7001 template is still constructed at `commands.ts:912`,
and the sentence is carried in sixteen test files, eight of which ASSERT it with other verb fills (e.g. the 'delete' fill at fresh-member-placement.test.ts:346); the other eight carry it only in retirement comments of the 'N1 (D-51): pinned DESIGN §6.2's veto …' form
(`grep -rln "Split these operations into separate queries" tests/` → 16 files,
`instances.ts` no longer among them), e.g. the `'delete'` fill in FC-01's own
pin file: `tests/raptor3/g4/parity/fresh-member-placement.test.ts:346` asserts
"Nested operation 'connect' on relation 'author' depends on an earlier 'delete'
target write …". The `'connectOrCreate'` fill is the one this cell carried, and
after this unit NO test asserts it: that wording survives only in comments
recording the veto's retirement
(`tests/contracts/engine/query/nested-write-conformance-m2m.test.ts:166` and
`:408`, `tests/raptor3/g4/parity/lane-x-set-mutations.test.ts:398`, each of the
form "N1 (D-51): pinned DESIGN §6.2's veto (…); now …"). That is expected
rather than dropped coverage: FC-01 made that fill unreachable for this shape.
The public refusal census is unchanged (23 sentences at 30 sites, 192 total).

## The second placement

The re-expressed assertion is exercised on a SECOND payload shape, not only on
more profiles: `candidate-ordering.test.ts` builds `reorderedDependency` by
swapping the two relation keys and runs the same `assert` on it, then compares
the two observations through `assertEquivalentRunObservations`. That comparison
is what makes the cell a key-order claim, and it now carries real content for
the first time: at the base both key orders REFUSED, so the comparison was
vacuous; now both key orders EXECUTE and the claim is that the engine's
canonical order — not the object's key order — decides, which I verified
statement by statement (`receipts/trace-after-fc01.log`). The same assertion is
additionally read under the second engine entry point (`candidate.test.ts`'s
`createCommandEngine` comparison plus its three tape replays) and in two vitest
projects.

## Capability change

None in the engine. The cell's coverage changes: it recorded a refusal and now
records an execution. What it stops witnessing is the V7001 dependency sentence
under a series member — its other verb fills are carried by the sixteen files
above, and its `'connectOrCreate'` fill, as "The rule deleted" records, keeps no
asserting witness anywhere; FC-01's own pin carries the placement. What it
starts witnessing, and did not before: that a member's `connectOrCreate` create
arm whose id default collides with an existing row raises
`UniqueConstraintError` on the target's own key; that the interactive
region owner spends exactly one replay on it and commits nothing; that the batch
route commits the earlier member's segment and publishes `phase: "member"` with
two committed segments and one completed member, at the same located pair; and
that swapping the two relation keys changes nothing about any of it.

## Registration

None. No test file was added or removed, so `scripts/raptor3-manifest.mjs` needs
no edit and no cell count changes: `fixed.test.ts` and `candidate.test.ts` keep
24 cells each, `candidate-ordering.test.ts` keeps 2.

## Runs (no wide runs; one vitest at a time)

| File | Filter | Cells | Result | Receipt |
| --- | --- | --- | --- | --- |
| `tests/raptor3/fixed.test.ts` + `tests/raptor3/candidate.test.ts` (base copy of `instances.ts`) | `-t "s2-changed-dependency"` | 8 | **8 failed** | `base-red-fixed-candidate.log` |
| `tests/raptor3/candidate-ordering.test.ts` (base copy of `instances.ts`) | — | 4 | **4 failed** | `base-red-candidate-ordering.log` |
| `tests/raptor3/fixed.test.ts` + `tests/raptor3/candidate.test.ts` | `-t "s2-changed-dependency"` | 8 | passed | `after-fixed-candidate.log` |
| `tests/raptor3/candidate-ordering.test.ts` | — | 4 | passed | `after-candidate-ordering.log` |
| `tests/raptor3/fixed.test.ts` (FC-01's veto restored in `commands.ts`) | `-t "s2-changed-dependency"` | 4 | **4 failed** (the falsification) | `falsify-fc01-reverted.log` |
| `tests/raptor3/fixed.test.ts` | `-t "s2-distinct-defaults"` | 4 | passed | `control-sibling-scenario.log` |
| `tests/raptor3/g4/parity/fresh-member-placement.test.ts` | — | 32 | passed | `control-fc01-pin.log` |
| `tests/raptor3/g4/parity/lane-x-set-mutations.test.ts` | — | 10 | passed | `control-neighbour-set-mutations.log` |

Cell counts are executions: every `tests/raptor3/*.test.ts` file above is in both
the `raptor3` and `coverage-raptor3` projects, so a two-profile cell counts four
times. Controls chosen: the OTHER scenario exported by the module I edited
(`s2-distinct-defaults`), FC-01's own pin (the owner whose repair this unit
records), and the neighbour family that already pins both halves of this answer
for the same shape (`lane-x-set-mutations`). Not run, by program rule: the frozen
gate, the fixed lane in full, the G0 campaign, `g1-compare`, `g2-baseline`.

Derivation receipts, produced with a temporary probe under
`--config vitest.config.ts` and then deleted from the tree (its source is kept as
`receipts/trace-probe.test.ts.txt` and `receipts/trace-probe-instrumented.test.ts.txt`):
`trace-before-fc01.log`, `trace-after-fc01.log`, `placement-instrumentation.log`.

## Typecheck

`node scripts/run-typecheck.mjs` → **exit 0**, whole estate, native, 8.27 s,
5254.8 MiB peak sampled RSS, run on the final tree. Receipt: `receipts/typecheck.log`.

## Census

`node scripts/raptor3-refusal-census.mjs` → **public refusals: 23 distinct
sentences at 30 sites**, 192 total sites — unchanged, as the brief expects (no
refusal or error class touched). Receipt: `receipts/census.log`.

## Biome

`tests/raptor3/scenarios/contracts/instances.ts`, base copy
(`git show HEAD:<file>`, checked at the real path so the file's own config
applies) vs after:

| | base | after |
| --- | --- | --- |
| `lint/suspicious/noMisplacedAssertion` | 13 | **14** |
| `format` | 0 | 0 |

**The one difference is honest and is reported, not suppressed.** Every
assertion in these scenario modules carries `noMisplacedAssertion` (the fixture's
`assert(observation)` method is not an `it()` body); the count went up by exactly
one because the re-expression ADDS one assertion, the constraint identity
(`meta.columns`). No new rule, no `biome-ignore`, and the file is format-clean on
both sides — one added assertion was re-wrapped by hand to keep it so, since the
base carries no `format` diagnostic and the formatter was not run. Receipt:
`receipts/biome.log`.

## LOC

`node scripts/query-engine-structure.mjs` measures the engine perimeter, and no
`src/` file changed, so before = after: **16,064 token lines**, 20,430 lines,
1,097 functions, 2,563 branch nodes. Receipt: `receipts/loc.json`. The unit's own
size is +90 / −23 lines in one test fixture, of which 49 are comment lines that
state the derivation at the cell.

## Unverified

- **The moved read is never TAKEN in this scenario.** The placement is verified
  by instrumentation (the member's `children` after the move) and by the base's
  refusal at the same pair, but bin 11's create arm fails before the reader runs,
  so no assertion here observes its answer. The reader's answer is pinned in
  `lane-x-set-mutations.test.ts:396` for the same `connectOrCreate` shape and in
  FC-01's pin file for series members generally. This cell no longer exercises
  the dependency contract it was named for (`C07`/`C10`); it exercises the
  collision that the refusal used to hide. The scenario's declared
  `contracts: ["C07","C08","C10","C13"]` tags were left as they are — retagging a
  fixed-lane case is an inventory decision, not this unit's.
- No native PostgreSQL, MySQL, Docker or hosted provider; both profiles are
  real SQLite through `better-sqlite3`, and `sqlite-atomic-batch` is the
  harness's restricted transport model, not D1.
- The G0 campaign (`runG0Campaign`, other seeds) and `gate.test.ts`'s specimen
  lane were not run; the campaign re-reads this same `assert` at other seeds, and
  the scenario's generator state is rebuilt per `prepare`, so seeds should not
  change it — asserted by construction, not measured.
- No performance measurement: the six cells now execute statements where they
  used to refuse during planning.
- `meta.model` / `meta.operation` differ between the profiles (`target`/`update`
  interactive, `shelf`/`update` batch). Observed, not pinned and not explained
  here.

## Blockers

None. No public-contract change, no new recovery authority, no numerical
semantics, no engine hunk.

## Repair round (2026-09-21)

Two reviewer findings, both minor, both documentary; both applied. No assertion
changed, no engine file touched, no test added, removed, skipped or weakened,
manifest untouched, census untouched.

**1 — the derivation comment stated one execution order where two run**
(`tests/raptor3/scenarios/contracts/instances.ts`). The cell said "per selected
bin … INSERT the create arm's target …, link it, take `set`'s target-2 lookup
…, then `set`'s clear and its link to target 2", i.e. the target-2 lookup after
the create. That is bin 11's schedule only. The finding is correct, and my own
receipts carry the refutation: `receipts/trace-after-fc01.log`
(`original sqlite-interactive`) runs 04 `SELECT … s2_targets … id = ?`
params `[2,1]` BEFORE 05 `id = 99` and 06 `INSERT`, and
`receipts/placement-instrumentation.log` shows one `depend` on the first attempt
(line 8, moving one reader to index 2 of that member's children, line 9) with
`kind=lookup placement=before` still running ahead of the `choose` (lines 12/14)
— bin 10's unmoved lookup. Two `depend` calls appear only on the replay (lines
36–39), when both members draw 2. The comment now states both orders: the
canonical relation order is unchanged (`collectionMutationOrder`,
`connectOrCreate` before `set`); bin 10's create resolves to the literal 1,
statically disjoint from the 2 `set` looks up, so that reader never reaches
`depend`, keeps placement `before` and runs FIRST, ahead of the connectOrCreate
lookup, the create, its link, the clear and the final link; only bin 11, whose
create proposes exactly 2, has its lookup MOVED behind the create arm and its
link and ahead of the clear, where it is never taken because the create arm
fails first. The paragraph is rewritten as one block (through the old
lines 266–277) so the moved-reader sentence is stated once and no fact of the
old text is lost: bin 10 completes, bin 11 draws 2 against the seeded row 2, the
PRIMARY KEY violation, "no order avoids that", and the pointer to
`tests/raptor3/g4/parity/fresh-member-placement.test.ts`.

**2 — the survival claim named two witnesses that do not carry it** (this
note's "The rule deleted", its back-reference under "Capability change", the
commit draft below, and the ledger record in `g4.md`). Verified against the
tree: `grep -rn "connectOrCreate' target write" tests/` returns four hits, all
comment lines (`nested-write-conformance-m2m.test.ts:166`/`:408`,
`lane-x-set-mutations.test.ts:398`, and this unit's own re-expression comment at
`instances.ts:257`); `grep -rln "Split these operations into separate queries"
tests/` returns 16 files, `instances.ts` no longer among them, and FC-01's pin
asserts the `'delete'` fill ("Nested operation 'connect' on relation 'author'
depends on an earlier 'delete' target write …",
`fresh-member-placement.test.ts:346`), not the `'connectOrCreate'` one. The
claim is now stated as the true coverage fact: the V7001 template is still
constructed at `commands.ts:912` and carried in sixteen test files, eight of which ASSERT it with other verb fills (e.g. the 'delete' fill at fresh-member-placement.test.ts:346); the other eight carry it only in retirement comments of the 'N1 (D-51): pinned DESIGN §6.2's veto …' form, while the `'connectOrCreate'` fill of the sentence keeps no
asserting witness after this unit and survives only in retirement comments —
expected, since FC-01 made that fill unreachable for this shape. The census
statement is unchanged as the finding requires (23 sentences at 30 sites, 192
total), and so is g4.md's separate sentence that the PLACEMENT is asserted in
`fresh-member-placement.test.ts` and `lane-x-set-mutations.test.ts`, which is
about the placement, not about the V7001 fill.

Runs of record for this round (receipt: `receipts/repair-round-runs.log`):

| File | Filter | Cells | Result |
| --- | --- | --- | --- |
| `tests/raptor3/fixed.test.ts` + `tests/raptor3/candidate.test.ts` | `-t "s2-changed-dependency"` | 8 | passed |
| `tests/raptor3/candidate-ordering.test.ts` | — | 4 | passed |

`node scripts/run-typecheck.mjs` → **0 diagnostics**, whole estate, native,
7.89 s, 4980.7 MiB peak sampled RSS; the runner passes `tsc`'s own code through
and emitted no `error TS…` line and no stop reason (receipt:
`receipts/repair-round-typecheck.log`). Biome on the one changed file is
unchanged from the note's table: `biome check` → 14
`lint/suspicious/noMisplacedAssertion`, `biome format` clean (comments are not
reflowed by the formatter, and the rewritten block stays inside the file's
existing 80-column width). Census not re-run: no refusal or error class touched,
and the corrected sentences do not change what is constructed. LOC unchanged
(comment lines are not token lines).

## Commit message draft (the integrator commits)

```
test(raptor3): the fixed lane's changed-dependency cell records the execution FC-01 unblocked (FC-01b)

`s2-changed-dependency` recorded `NestedWriteError` V7001 "Nested operation
'set' on relation 'targets' depends on an earlier 'connectOrCreate' target
write in the same nested write." FC-01 deleted the operation-global veto that
raised it, so the composition now executes, and the integrator's one run of the
fixed lane found the six cells that read this scenario red.

Derived rather than copied. The schedule is the engine's own
`collectionMutationOrder` — `connectOrCreate` before `set`, whatever order the
payload's keys are in — and per selected bin it is: look for target 99 (absent),
INSERT the create arm at `target.id`'s default, link it, take `set`'s target-2
lookup, clear the bin's links, link target 2. Bin 10 draws 1 and completes; its
lookup is statically disjoint from the create and never reaches `depend`. Bin 11
draws 2, which is exactly the row `set` looks up, so `depend` moves the reader
behind the create arm — and the create arm is `INSERT INTO s2_targets (2)` into
a table that already holds row 2, which violates its PRIMARY KEY. No order
avoids that: this payload deletes only `s2_bin_targets` rows, and `where: {id:
99}` matches nothing in either key order, so the reordered payload produces a
statement-for-statement identical run.

The six cells are re-expressed to that answer with FC-01 named at the cell, and
are strengthened: the violated constraint is now identified
(`meta.columns: ["s2_targets.id"]`), the batch route's committed segments are
spelled out instead of spread from `initial`, and the interactive region owner's
single replay is pinned in the default draws. The published segment record moves
from `phase: "planning"` with one committed segment to `phase: "member"` with
two committed segments and one completed member, at the same located pair
(`memberPath [1]`, `totalMembers 2`). No engine file changed; the V7001 sentence
is still constructed at commands.ts:912 and carried in sixteen test files, eight of which ASSERT it with other verb fills (e.g. the 'delete' fill at fresh-member-placement.test.ts:346); the other eight carry it only in retirement comments of the 'N1 (D-51): pinned DESIGN §6.2's veto …' form (the 'delete' fill in fresh-member-placement.test.ts:346),
while its 'connectOrCreate' fill now survives only in retirement comments —
expected, since FC-01 made that fill unreachable for this shape. The public
refusal census is unchanged at 23 sentences / 30 sites.

Red at 7c3c33a4e with this expectation (expected UniqueConstraintError, received
NestedWriteError) once FC-01's veto is restored; red the other way with the base
copy of the fixture; green here.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
