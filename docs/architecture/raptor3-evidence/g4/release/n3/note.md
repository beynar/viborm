# Release unit "n3" — the ladder's attribution and the premise's position (note)

Integrator: Fable, in the main tree on `eca417a4e` (commit 22). Unit N3 of
`docs/architecture/raptor3-nesting-and-refusals-plan.md` (§3, split by the
external review into attribution and recovery eligibility). Receipts under
`receipts/`; the two probes that placed the facts under `receipts/probes/`.

## 1. What the probes showed

- **The raceable premise was attributed; the recovery was refused by
  progress.** "deleteMany when a member is added after planning" on a
  batch-only PGlite: the ladder re-probed and attributed the raceable
  membership premise, but the fixture's batch carries no statement index,
  so "rejected before any write" could not be established, the batch was
  marked as possibly committed, and D-25's gate refused the one recovery
  (`probes/probe-membership-added.log`).
- **A member removed after planning was deleted anyway**: the deletion
  asserted no membership on the batch route (`probes/probe-membership-removed.log`).
- **A premise placed after the parent's own UPDATE forfeits the recovery on
  a weak batch** (`probe-pin-recovery-gate.log`: premises at 0 and 2, the
  UPDATE at 1 — a rejection at 2 cannot claim that no write was dispatched).
- **The un-attributable abort leaked the internal class** (`m8-race-retry`).

## 2. The rule, and its owners

*A premise about an observation is asserted where the observation is taken,
before any write of the unit, never where it is consumed.*

- **`commands/relation-body.ts`:** a LAX disconnect or delete target's
  `retained` is the raceable membership race (`membershipRaceFailure`, one
  sentence owner in `commands.ts`, shared with `requireNoAddedMember`),
  asserted by `runSelection` right after the capture; `required` keeps saying
  what an empty slot means (N2). The STRICT form, which names a row by its
  selector, keeps the non-raceable identity sentence `requireLookup` supplies
  from `required` (unchanged): the first Opus review measured that a
  raceable premise there let the one recovery re-read the selector and
  delete a different row that had taken it (D-34; `lax-to-one`'s "the strict
  form keeps its identity" cell). Initial absence and loss after observation
  are the two facts D-32 named.
- **`commands/execution.ts`, the series:** each captured `deleteMany` member's
  presence is asserted at capture, beside `requireNoAddedMember`; the
  deletion and removal commands assert nothing (the three shapes that tried
  to assert there — at the deletion, at the removal, by edge kind — each
  broke a fixed-stage cell or a conformance cell, because the plan's own
  earlier statement had consumed the membership; they are in the receipts as
  `unit2`…`unit5`).
- **`shared/operation-context.ts`, the ladder:** attribution first — the
  provider's index, else the re-probe (the sole-guard fallback folded into
  the same walk), and where the provider said where it stopped that position
  decides `rejectedBeforeAnyWrite`; where only the re-probe did, its answer is
  a fresh-state sentence, not a statement about the past (a premise found
  false now may have held when the batch ran — DESIGN §7.3 step 4; the first
  review measured a batch whose own committed write falsified an earlier
  premise being read as "no write dispatched"), so the claim is bounded by
  the LAST premise in the batch (`lax-to-one`'s "a raceable premise ahead of
  a write, with a later premise behind that write" cell: bounded, the
  rejection keeps its uncertainty in one batch; unbounded, the recovery is
  granted — the cell dies at its expected rejection when the bound is
  removed, `receipts/round2/falsify-unbounded.log`. The review's own
  after-write counter-example is the end-to-end pin "a premise placed after
  a write keeps its uncertainty"; it does not discriminate the bound,
  because on the atomic fixture the attributed premise IS the last one);
  then the uncertainty; then, for a raceable premise, the recovery mark;
  and, when nothing is attributed, the typed floor (`NestedWriteError`, code
  V7006, cause the driver's error, one attempt), the retired
  `batch-error-attribution` floor restated.

  What the bound cannot see — an ordinary statement arriving as the
  assertion class behind the last premise, with writes ahead of it — rests
  on the shipped index-free transports' atomicity (D1's batch, Neon HTTP's
  transaction: nothing survives the abort; on D1 the uncertainty is also
  gated by its ordered committed segments, so Neon HTTP is the transport
  where the bound decides anything). The round-2 review's optional refusal
  of the claim wherever an ordinary statement could collide
  (`batchMayContainAssertionCollision`, today the sole guard's gate only)
  was declined: on PostgreSQL its signature is any `/` or `%` in the SQL
  text, so a division in ordinary SQL (the adapter's arithmetic) would
  forfeit the recovery on Neon HTTP to protect a class of transport that
  does not ship (neither atomic nor indexed); that class owes its own
  witness under D-53, and the two-line refusal belongs to that unit.

## 3. Hunks

`commands.ts` (`membershipRaceFailure`), `execution.ts` (the series'
per-member presence at capture; `requireNoAddedMember` uses the shared
sentence), `relation-body.ts` (`retained` on the disconnect/delete lookup for the LAX
form only: the payload names no selector, the loss is a membership fact and
the raceable race is its premise; the STRICT form keeps `requireLookup`'s
non-raceable identity sentence — sentence and raceability both unchanged,
D-34. The first shape marked both forms, and the first Opus review measured
the one recovery re-reading the selector and deleting a different row),
`operation-context.ts` (the ladder), `AGENTS.md` (one paragraph); the pins:
`tests/raptor3/g4/parity/lax-to-one.test.ts` (the re-parented-member cell
on three transports; the strict form's identity kept under the same race;
the review's after-write counter-example kept as an end-to-end pin; the
position bound's own discriminating cell, on the transport without a
statement index),
`series-member-premise.test.ts` (a junction set: every member deleted; a
member removed after the plan-time read not deleted and the operation
converging), `batch-only-drivers.ts` (the shared planting batch-only SQLite
driver — an ATOMIC batch, one transaction rolled back on the first failure,
the property D1's batch and Neon's transaction have and the position rule
depends on — and its variant that maps an aborted batch to the assertion
class WITHOUT a statement index, so the ladder's re-probe attribution and
position bound are measured deterministically);
`tests/raptor3/transitions/staleness.ts` (the `g2-key-captured-restored`
expectation re-expressed from the internal class to the typed floor, naming
DESIGN §7.3 step 4 and `m8-race-retry` — a recorded G2 expectation that
pinned the leak).

**The coverage scope had never seen the parity pins.** The deterministic
raptor3 list (`RAPTOR3_DETERMINISTIC_TESTS`, the engine's coverage project)
is a union of named groups, and no `g4/parity` pin — D-46's, D-50's, N2's —
was in one: they ran only in the credential-free walk's extended-local
shards, so the query-engine-core floor was measured without them. The four
SQLite pins are now the group `G4_PARITY_TESTS` (`scripts/raptor3-manifest.mjs`),
in the deterministic list, the fixed stage and the extended-local exclusions
(`scripts/credential-free-test-manifest.mjs`), so each runs once, where the
engine's coverage is measured: the fixed stage is 796 / 796 (758 + 38: 6 + 1 + 27 + 4) and
the scope 88 / 91.19 / 90.9 / 88 over 87 / 91 / 90 / 87.

## 4. Verification

- `m8-race-retry` 4 / 4 (from 3); `nested-m2m-parent-pk-dataflow` 6 / 6
  (from 4: added → converges, removed → not deleted); the lax pin 27 / 27 on
  three transports; the series pin 4 / 4; `uncertain-outcome-meta`
  unchanged; the raptor3 fixed stage with the parity pins registered and the
  re-expressed G2 cell (`receipts/repair/`, the figure there is the one).
- The membership and m2m conformance files by CELL identity and message
  (`compare-cells.py`, the instrument N3c's review asked for): no newly red
  cell; one membership cell moved from the leaked internal class to the
  typed floor (its own attribution, a not-found for an update member, is
  still missing and stays red).
- The core lane 8,434 / 8,434 (the inventory cell counts the new files); the
  query-engine-core floors held with the pins in scope; the coverage policy
  green (`receipts/final/`).
- The whole extended-local estate per shard on the recomposed shards (the
  pins left them), the provider stages, three modes, typecheck, the core
  lane and the floors, under the REPAIRED unit, compared with the N2 head by
  CELL identity and message: no cell newly red; three newly green (the m8
  floor, the two stale-membership cells); three moved, all from the leaked
  internal class to the typed floor (`legality-transition-arm` "allows
  primary-key arithmetic transition with cascade upsert", `membership` "self
  to-many inverse …", `shared-pk-update-root` "update publishes the target's
  post-update key …" on the PGlite atomic batch) — each still red for its
  own attribution, now with the public class; the thirteen ordinary shards
  green; core 8,434 / 8,434; query-engine-core 88 / 91.19 / 90.9 / 88 over
  87 / 91 / 90 / 87 (`receipts/regress/`, `receipts/regress/cells-vs-n2-head.txt`,
  the instrument `compare-cells.py.txt`; the first, blocked shape's
  witnesses under `receipts/` as `unit*`-era logs are the note's history,
  the repaired shape's under `receipts/repair/`):

```
ordinary 1/13 exit=0  Test Files 3 passed (3)
ordinary 2/13 exit=0  Test Files 3 passed (3)
ordinary 3/13 exit=0  Test Files 2 passed | 1 skipped (3)
ordinary 4/13 exit=0  Test Files 1 passed | 2 skipped (3)
ordinary 5/13 exit=0  Test Files 3 skipped (3)
ordinary 6/13 exit=0  Test Files 2 passed | 1 skipped (3)
ordinary 7/13 exit=0  Test Files 3 passed (3)
ordinary 8/13 exit=0  Test Files 3 passed (3)
ordinary 9/13 exit=0  Test Files 3 passed (3)
ordinary 10/13 exit=0  Test Files 3 passed (3)
ordinary 11/13 exit=0  Test Files 3 passed (3)
ordinary 12/13 exit=0  Test Files 2 passed | 1 skipped (3)
ordinary 13/13 exit=0  Test Files 3 passed (3)
shared-family 1/8 exit=1  Test Files 3 failed | 12 passed (15)
shared-family 2/8 exit=1  Test Files 4 failed | 10 passed (14)
shared-family 3/8 exit=1  Test Files 2 failed | 12 passed (14)
shared-family 4/8 exit=1  Test Files 2 failed | 12 passed (14)
shared-family 5/8 exit=1  Test Files 6 failed | 8 passed (14)
shared-family 6/8 exit=1  Test Files 3 failed | 11 passed (14)
shared-family 7/8 exit=1  Test Files 6 failed | 8 passed (14)
shared-family 8/8 exit=1  Test Files 3 failed | 11 passed (14)
imported-pglite 1/2 exit=0  Test Files 5 passed | 12 skipped (17)
imported-pglite 2/2 exit=1  Test Files 2 failed | 6 passed | 2 skipped (10)
raptor3-provider exit=0  Tests 3 passed (3); Tests 2 passed (2); Tests 1 passed (1); Tests 2 passed (2); Tests 3 passed (3); Tests 2 passed (2);
g2-baseline exit=0  Tests 216 passed (216)
g2-contracts exit=0  Tests 216 passed (216)
g3-transaction-array exit=0  Tests 4 passed (4)
typecheck exit=0 errors=0
core exit=0  Tests 8434 passed (8434)
coverage:query-engine-core exit=0 All files | 88 | 91.19 | 90.9 | 88 | 
coverage:policy exit=0

failing cells before 140 after 137 | newly red 0 | newly green 3 | same cell, different message 3
  GREEN  : m8-race-retry.test.ts > M8 race-retry classification > an un-attributable planned abort surfaces the typed non-rac
  GREEN  : nested-m2m-parent-pk-dataflow.test.ts > planned m2m delete parent-PK dataflow > deleteMany retries when a member is added to a non
  GREEN  : nested-m2m-parent-pk-dataflow.test.ts > planned m2m delete parent-PK dataflow > deleteMany retries without deleting a member remov
  MOVED  : relation-key-update-legality-transition-arm.test.ts > relation-key update legality > allows primary-key arithmetic transition with cas | AssertionError: expected { …(2) } to deeply equal { name: 'UniqueConst -> AssertionError: expected { name: 'NestedWriteError', …(1) } to deeply 
  MOVED  : nested-write-conformance-membership.test.ts > nested-write conformance: update membership root (tx vs batch) > self to-many in | AssertionError: expected { …(3) } to deeply equal { name: 'NestedWrite -> AssertionError: expected { name: 'NestedWriteError', …(2) } to deeply 
  MOVED  : shared-pk-update-root.test.ts > Package E shared-PK update root (PGlite atomic batch) > update publishes the tar | NestedWriteAssertionError: Nested write assertion failed: a batch prec -> NestedWriteError: Nested write assertion failed: a batch precondition 
failing cells before 2 after 2 | newly red 0 | newly green 0 | same cell, different message 0
```

**Round 2 (after the re-check's REVISE).** The position bound's own
discriminating cell (`lax-to-one`, the no-index transport: a raceable
premise ahead of a write, with a later premise behind that write). With the
bound removed from `operation-context.ts` (the file copied first and
restored byte-identical afterwards), exactly that cell fails in both
projects and the 52 other cells stay green
(`receipts/round2/falsify-unbounded.log`); with the bound, the lax pin
27 / 27 (54 across the two projects), the series pin 4 / 4,
`uncertain-outcome-meta` 8 / 8 unchanged, `m8-race-retry` 4 / 4, the fixed
stage 796 / 796 (758 + 38), typecheck 0, Biome on `operation-context.ts`
identical to HEAD's six diagnostics (the import-order assist, four
`noParameterProperties`, the pre-existing format diagnostic) and
`lax-to-one.test.ts` clean; query-engine-core 88 / 91.19 / 90.9 / 88 (unchanged) over 87 / 91 / 90 / 87,
the coverage policy green (`receipts/round2/`). Round 2 changed no source
beyond the ladder's comment (R5; the optional R6 declined, §2): the estate
comparison above stands, and the new cell is red only where the bound is
absent.

## 5. Still red, unverified, blockers

Still red: the rest of the gate. Not this unit's: the update-member premise
(non-raceable not-found at the record, unchanged). Unverified: no Docker
lane re-run. The `raceable` mark on the lax lookup and the ladder's bound
are route-independent in REACH (every batch transport, PostgreSQL and MySQL
included) even though they fire only on the batch route — the first shape's
strict-form defect would have reproduced there. The repaired shape narrows
behaviour the unit itself introduces, measured on the PGlite and SQLite
pins, so nothing green at HEAD on those lanes can depend on it: an argument,
not a receipt; D-53's per-driver transport witnesses remain owed. Blockers:
none.
