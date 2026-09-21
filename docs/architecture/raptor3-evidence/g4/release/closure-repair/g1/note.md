# G1 — the two reds of the frozen gate

The repair prompt §1 (the shared FOUND-consumption rule) and its unit note
[`../u1/note.md`](../u1/note.md). Branch `closure-sfix` from the integration tip
`74f25f57f`, worktree `/private/tmp/viborm-sfix`, MySQL 8 (`raptor3_g2`,
REPEATABLE READ). Receipts: [`receipts/`](receipts/).

The integrator's one frozen gate on `74f25f57f` was green everywhere except two
cells that U1's discriminating runs did not cover. They are one cause and one
consequence of the same rule: the confirmation the rule takes is a statement
that U1 issued once per matched condition, and it is the statement an
interactive found arm now first CONTENDS on.

---

## 1. Red 1 — the conditional upsert's double confirmation

### The failing witness

`tests/raptor3/post-prep/selector-preparation.test.ts` › "reuses one upsert base
selector across both prepared condition probes", the fixed lane. Reproduced at
base in this worktree ([`receipts/01-red1-at-base.log`](receipts/01-red1-at-base.log),
**2 failed / 6 passed** — the cell in both projects it is registered in):

```
  [ 'SELECT', 'SELECT', 'SELECT', + 'SELECT', + 'SELECT', 'UPDATE', 'SELECT' ]
```

A root conditional `upsert` carrying BOTH `targetWhere` and `setWhere` on an
existing row issued TWO confirmations where the recorded expectation had none.
U1's own note records the reason as a cost ("one extra round trip per MATCHED
condition probe … two for an upsert that carries both") rather than as the
defect it is.

### The derivation

The rule is that the located row is re-taken under lock **over the requirements
the operation already owns**, before anything consumes it. When the choose
reaches `confirmFound`, every condition probe has MATCHED — the unmatched branch
returns before it (`case "choose"`, the skip) — so the requirements are: this
identity, this membership, and EVERY matched condition. They are requirements of
the SAME consumption of the SAME row, so they are ONE premise, and one premise
is one statement: the row is re-taken once under the CONJUNCTION of the probes
that matched it. A second confirmation asks a row this transaction already holds
under lock the same question again and pays a round trip for an answer it cannot
change — the duplication ELEGANCE §6/§1 forbids, at the owner
(`CommandExecution.confirmFound` / `Selection.confirm`).

The conjunction is `Queries.andSelectors` over the prepared selectors the probes
ALREADY carry (each is the locator's own base narrowed by its condition —
`Commands`' own decomposition), so nothing is prepared a second time and the one
base selector is reused a third time. Measured SQL of the dual-condition shape
([`receipts/02-confirmation-statements.log`](receipts/02-confirmation-statements.log)):

```
SELECT … WHERE ((("email" = ? AND "count" = ?) AND ("email" = ? AND "count" >= ?))
                AND "id" = ?) ORDER BY "id" ASC LIMIT ?
```

— the two premises the batch route states as two `requirePresent`s, conjoined,
and addressed by the located IDENTITY. The shared base term appears once per
premise because each premise is complete on its own; the alternative (a raw
condition selector kept beside each probe) would buy one repeated equality on
one statement for a new field on `Condition` and a second place that knows what
a condition's meaning is.

### What changed at the owner

`confirmFound` builds one selector and issues one read; `Selection.confirm`'s
second parameter becomes the prepared MEANING it proves (`PreparedSelector`)
rather than another `Selection`, because a conjunction of probes is not a
selection. One condition still confirms through that probe's own selector, with
no conjunction and no change of any kind: only the shape with two or more
matched conditions moves.

### The cost this pays, named

What one statement cannot do is say WHICH of two matched conditions a concurrent
commit took away. The failure raised is the first condition's — the same
ordering `case "choose"` already speaks with when it reports ONE unmatched probe
for the skip premise. So for an upsert carrying both conditions, where both
matched and only the second has since drifted, the sentence names `targetWhere`
where U1's two reads would have named `setWhere`. Everything else is unchanged
and exact: the failure class (`TransactionError`, V5001), its meta, the absence
of `raceable`, the refusal to switch arms or retry, and nothing written.

Exact per-field attribution in one statement would need the conditions evaluated
over the CONFIRMED row rather than inside its `WHERE` — a predicate projected
into the select list, or an in-engine evaluator over the returned row. No
adapter can project a predicate today and a second predicate evaluator is a new
mechanism, not a bounded repair; the diagnosing alternative (re-confirm per
condition after a miss) is worse than the cost it removes, because it takes
FURTHER locks after a miss and that is exactly what the guide's harmlessness
argument for a missing confirmation rests on not doing. A single matched
condition — every registered witness of a lost condition, native
(`mysql2-found-consumption`), local (`sqlite3-found-consumption`) and scripted
(`transitions/conditional-upsert.ts`) — keeps its exact sentence.

> **Addendum (repair prompt 2 §2, 2026-09-22, `closure-repair-2/t2`).** The cost
> above is now paid honestly instead of by a wrong name. The statement still
> cannot say WHICH of two matched conditions went, and it no longer says: where
> several conditions were conjoined the failure reports that a MATCHED
> REQUIREMENT changed and names them as a SET
> (`query-engine-v2 top-level upsert matched premise (targetWhere, setWhere)
> changed before the atomic batch.`), decided where the premises are built
> (`Choose["conditions"].matched`) so that `confirmFound` states no diagnosis of
> its own. The single-condition sentences this section promised are unchanged
> byte for byte, both spellings, and the single combined confirmation stands —
> no round trip was added to tell the conditions apart. §12's last bullet ("the
> attribution cost has no registered witness") is closed: three cells per
> transport, credential-free and native, now witness first-only, second-only and
> both conditions changing.

### The re-expressed cell, and why

The repaired contract changed the answer, so the cell's recorded expectation is
re-expressed and §1 is named at each place:

| pin | was | is |
| --- | --- | --- |
| statement sequence | `[SELECT, SELECT, SELECT, UPDATE, SELECT]` | `[SELECT, SELECT, SELECT, SELECT, UPDATE, SELECT]` |
| `andSelectors` calls | 2 | 3 |

Nothing is deleted or weakened: `prepareSelector` stays at **3** calls with the
same three arguments (the confirmation prepares nothing), both probe conjunctions
keep their identity assertions against the ONE base object, both keep their
`lowerSelector` pins, and the cell GAINS three — that the third conjunction's
operands are exactly the two probe selectors (the reuse the cell is named for),
that its result is the selector actually lowered, and the derived statement
sequence itself.

### Falsification

Restoring `confirmFound`'s per-condition loop (base copies of `execution.ts` and
`selection.ts`, restored by `cp`) turns the re-expressed cell RED in both
projects — `2 !== 3` at the conjunction pin, and the two extra SELECTs
([`receipts/06-falsification-engine-hunk.log`](receipts/06-falsification-engine-hunk.log)).

---

## 2. Red 2 — the competing-upserts schedule

### The failing witness, and its causal schedule

`tests/providers/docker/mysql2-writes-raw.test.ts` › "mysql2 atomic
non-returning mutation interleavings" › "competing upserts identify their
branches and refetch their own updates": `Test timed out in 30000ms` on native
MySQL. Reproduced at base while polling `performance_schema.data_lock_waits`
joined to `information_schema.innodb_trx`
([`receipts/03-schedule-probe.mjs`](receipts/03-schedule-probe.mjs),
[`receipts/21-red2-at-base-schedule.log`](receipts/21-red2-at-base-schedule.log)):

```
waiting_query : SELECT … FROM `atomic_mysql_items` AS `q0`
                WHERE (`q0`.`email` = 'upsert@test.com' AND `q0`.`id` = 'upsert')
                ORDER BY `q0`.`id` ASC LIMIT 1 FOR UPDATE
lock_type     : RECORD      lock_mode : X,REC_NOT_GAP
index_name    : PRIMARY     lock_data : 'upsert'
blocking_trx  : the first operation's, state RUNNING (parked in the test's hook)
vitest exit code 1  →  Test timed out in 30000ms
```

So the causal chain is exactly one link long. B's CONFIRMATION (identity +
locator selector, `FOR UPDATE`) queues behind A's record lock on the located
PRIMARY key. The cell's second driver latched on B's UPDATE — the statement
BEHIND that confirmation, which B reaches only once the lock is granted — and
the lock is released only when the test resolves `releaseFirst`, which it does
only after that latch. The schedule, not the database, was the deadlock: no
InnoDB deadlock is detected or reported, and the engine's single lock is a
RECORD lock on the row it located, not a gap lock.

### The engine is not the owner here

The brief's alternative — the engine takes a lock it must not — is refuted by
the same receipt. The lock is `X,REC_NOT_GAP` on the located row, and the shape
is a found arm whose probe withdrew its lock (`Selection.insertsWhenAbsent`), so
it is precisely the shape §1 requires a confirmation for: without it the UPDATE
spends an identity and a selector the operation was promised and no longer holds
(the control below measures exactly that loss). Nothing was repaired in the
engine for this red.

### The re-expressed cell, and the control beside it

The cell's hooks are re-expressed to plant after the unlocked observation and
before the confirmation, naming §1 at the cell: the second driver latches on
`isItemLock`, which is what its two neighbours in the same `describe` (a root
update and a root delete, whose locate lock has always been their contention
point) already do. Every assertion is kept — both branches identified, each
refetching its own update, no native upsert, connection affinity, different
connections — and the comment that said the contention point is the UPDATE is
corrected to what the receipt shows.

That latch resolves BEFORE the confirmation is dispatched, so it cannot by
itself prove the confirmation waited. The new cell beside it does, on a real
lock-HELD schedule: **"a competing upsert waits on the held row and consumes the
committed row, not the one it probed"**. A holds the row lock (parked after its
own locate) and rewrites the row's unique `email`; B's upsert probes unlocked,
finds it, and its confirmation queues; after a full second B has produced
neither answer nor failure, has sent exactly ONE locking read and no UPDATE;
A is then released and commits; B's confirmation answers over A's COMMITTED row
— which no longer carries the selector B found it under — and B fails with the
found arm's own sentence (`No item record found for update`), writes nothing,
creates nothing through its create arm and issues no native upsert. The final
state is A's. Its own schedule is recorded the same way
([`receipts/05-schedule-after-control.log`](receipts/05-schedule-after-control.log):
the same `X,REC_NOT_GAP` wait on `'held'`, `vitest exit code 0`).

The control's latch waits for B's first CONTENDING statement (a locking read or
an update) and the cell PINS which it was, so an engine that consumed the found
row without confirming it under lock fails the pin instead of hanging the
schedule. Falsified by removing `forUpdate` from `Selection.confirm`: the cell
goes red in 1.2 s on "expected [] to have a length of 1" — no locking read was
taken ([`receipts/07-falsification-confirmation-lock.log`](receipts/07-falsification-confirmation-lock.log)).

No `allSettled()`, no lowered timeout, no skip.

---

## 3. The continuing invariant, and its single owner

**Invariant (unchanged from U1, sharpened).** An unlocked positive observation
may select an arm; it protects nothing that arm consumes. Before any effect that
depends on it, the located row is re-taken under lock over the requirements the
operation already owns — **in one statement**, because those requirements are
one premise of one consumption of one row — and the row that read answers is the
authoritative binding every consumer then spends.

**Owner.** Unchanged: `CommandExecution.confirmFound`
(`src/query-engine/raptor3/commands/execution.ts`), issuing one query owner,
`Selection.confirm` (`commands/selection.ts`), called from the one place. No
second interpreter, no per-verb switch, no policy bit, no concurrency manager;
the batch route and a probe that kept its lock still ask for no read here.

## 4. What disappears

1. **The loop in `confirmFound`** and the `[Selection, DeferredFailure][]`
   requirement list it walked: one read, one failure, one materialization. The
   mutable `current` accumulator goes with it (the confirmation's answer IS the
   row it returns).
2. **`Selection.confirm`'s `Selection` parameter**: the confirmation proves a
   prepared MEANING, and a caller that conjoins two probes has no selection to
   hand it. One parameter, one kind.

No test, branch or check is deleted elsewhere; no sentence is added, changed or
removed.

## 5. A second applicable consumer

The conjoined confirmation is the same statement for every consumer U1 lists —
the parent-held and child-held `connectOrCreate`, the correlated to-many nested
`upsert`, the to-one nested `upsert`, the compound column-mapped reference,
borrowed execution — because they all reach it through the same call with ONE
requirement, where the conjunction is not built at all. The shape this unit
changes has two applicable consumers of its own, both already registered:
`tests/contracts/engine/query/nested-write-conformance-fk.test.ts` ("top-level
upsert targetWhere+setWhere match runs the update branch", with a nested write
under the found arm, 28 / 28) and
`tests/contracts/drivers/behaviors/nested-write-advanced-behavior.ts` (the
dual-condition guard, running on native MySQL in the red file itself and on
SQLite, PGlite, libSQL and PostgreSQL through their own files — 170 / 170 on
`sqlite3-nested-write`). The scripted corpus
`tests/raptor3/transitions/conditional-upsert.ts` covers both the matching pair
and the stale-premise failure, 44 / 44.

## 6. Capability change

**None.** No valid uncontended operation becomes a refusal: the dual-condition
upsert commits its ordinary result in the re-expressed fixed cell, in the
conformance cell and in the advanced-behaviour guard, and the interactive found
path loses one round trip rather than gaining one. The only behavioural
difference is the one named in §1: which of two matched conditions a lost-premise
sentence names. Missing-key probes stay unlocked; R2c's convergence and
no-replay policy are untouched (`mysql2-concurrency-policy` 11 / 11).

## 7. Registrations

| file | cells | project(s) |
| --- | --- | --- |
| `tests/contracts/drivers/behaviors/non-returning-mutation-atomicity-behavior.ts` | +1 cell (the lock-HELD control) | reaches `provider-mysql2` through `tests/providers/docker/mysql2-writes-raw.test.ts`, **92 → 93 cells** |
| `tests/raptor3/post-prep/selector-preparation.test.ts` | 4 (unchanged count; 1 re-expressed) | `raptor3` and `coverage-raptor3` — 8 executions |

`scripts/raptor3-manifest.mjs` is NOT edited: neither file is manifest-enumerated,
and no workspace entry changes (the behaviour file is imported by a registered
native file).

## 8. Runs

One Vitest at a time; one docker file per invocation; the connection string was
substituted into each command from its file and never printed.

| run | result | receipt |
| --- | --- | --- |
| `post-prep/selector-preparation.test.ts` (base) | **2 failed / 6 passed** (RED) | `01-red1-at-base.log` |
| `mysql2-writes-raw.test.ts` (base, the one cell) | **1 failed** — timed out (RED) | `21-red2-at-base-schedule.log` |
| `mysql2-writes-raw.test.ts` | **93 / 93** | `04-mysql2-writes-raw-green.log` |
| the lock-HELD control's own schedule | `X,REC_NOT_GAP` wait, exit 0 | `05-schedule-after-control.log` |
| falsification — per-condition loop restored | RED (`2 !== 3`) | `06-falsification-engine-hunk.log` |
| falsification — confirmation unlocked | RED (no locking read) | `07-falsification-confirmation-lock.log` |
| `mysql2-found-consumption.test.ts` | **12 / 12** | `11-mysql2-found-consumption.log` |
| `mysql2-concurrency-policy.test.ts` | **11 / 11** | `12-mysql2-concurrency-policy.log` |
| `sqlite3-found-consumption.test.ts` | **10 / 10** (5 cells × 2 projects) | `08-sqlite3-found-consumption.log` |
| the post-prep family (9 files, credential-free) | **96 / 96** (18 file executions) | `09-post-prep-family.log` |
| `transitions/conditional-upsert-{commands,legacy}` | **44 / 44** | `10-conditional-upsert-transitions.log` |
| `nested-write-conformance-fk.test.ts` (PGlite shard) | **28 / 28** | `13-nested-write-conformance-fk.log` |
| `providers/local/sqlite3-nested-write.test.ts` | **170 / 170** | `20-sqlite3-nested-write.log` |

## 9. Typecheck, census, Biome

- **Typecheck**: `node scripts/run-typecheck.mjs`, **0 diagnostics**
  ([`receipts/14-typecheck.log`](receipts/14-typecheck.log)), run once at the end
  of the unit.
- **Refusal census**: byte-for-byte the frozen gate's counts — invariant 22 / 21,
  internal 11 / 11, inherited 75 / 75, candidate 30 sites / 23 distinct, rethrow
  56, **194 total sites**
  ([`receipts/15-refusal-census.md`](receipts/15-refusal-census.md) against
  `closure-repair/gate/census.log`). No sentence is added, changed or removed:
  the one `throw failure()` is the same rethrow of a `DeferredFailure` the
  requirement owns.
- **Biome**: per changed file, against the base copies
  ([`receipts/16-biome-after.log`](receipts/16-biome-after.log),
  [`receipts/17-biome-base.log`](receipts/17-biome-base.log)) — **identical**: 17
  diagnostics, the same five rules (`noParameterProperties` ×5,
  `useTopLevelRegex` ×8, `organizeImports`, `useDefaultSwitchClause`,
  `noCommaOperator`), all pre-existing and none in a line this unit wrote.
  `selection.ts` carries a `format` diagnostic in its BASE copy, so the formatter
  was not run on it; the lines this unit wrote there are written the way Biome
  wants. The two test files carry no `format` diagnostic before or after.

## 10. Cost

| perimeter | reference | base (`74f25f57f`) | after | delta |
| --- | --- | --- | --- | --- |
| engine token lines (`scripts/query-engine-structure.mjs`) | 16,098 | 16,185 | **16,182** | **−3** |
| like-for-like | 19,956 | not re-measured here | — | **−3** (derived) |
| charged perimeter | 23,891 | not re-measured here | — | **−3** (derived) |

The engine row is MEASURED at both ends in this worktree, by swapping the two
base copies in and out
([`receipts/19-engine-structure-base.log`](receipts/19-engine-structure-base.log),
[`receipts/18-engine-structure-after.log`](receipts/18-engine-structure-after.log)).
The other two rows carry only this unit's DELTA, not an absolute: both `src/`
files it touches are engine files inside both perimeters, so the same −3 applies
to whatever the integration tip's totals are — which this unit does not
re-derive, because the units before it moved them. Against the review's 16,098
denominator the repair round now stands at **+84** (it was +87 at the gate tip);
the integrator's own reader run on the final tree is the measurement.

`git diff --numstat` (tracked files):

```
 26   0  src/query-engine/raptor3/AGENTS.md
 54   0  docs/architecture/raptor3-evidence/g4.md
 40  28  src/query-engine/raptor3/commands/execution.ts
 10   8  src/query-engine/raptor3/commands/selection.ts
124   9  tests/contracts/drivers/behaviors/non-returning-mutation-atomicity-behavior.ts
 28   2  tests/raptor3/post-prep/selector-preparation.test.ts
```

Round trips: an interactive conditional upsert carrying both `targetWhere` and
`setWhere` loses one statement per execution against the gate tip (7 → 6 in the
measured fixed cell); every other shape is unchanged.

## 11. The guide

`src/query-engine/raptor3/AGENTS.md` gains one dated addendum beside the
paragraph it corrects (U1's "one extra round trip per MATCHED condition probe …
two for an upsert that carries both `targetWhere` and `setWhere`"): the cost is
ONE extra round trip whatever the arm's requirement is, with the conjunction,
the failure ordering and the attribution cost named, plus the consequence for a
concurrency test — it may not latch on the effect behind the confirmation, and a
correct locking repair is proved by a lock-HELD schedule.

## 12. Unverified

- The full `provider-mysql2` and `provider-pg` projects, the fixed/parity/
  conformance lanes and the G2 campaigns: no wide runs by a unit. The one frozen
  gate is the integrator's.
- PostgreSQL: no cell of either red is PostgreSQL-shaped, and no PostgreSQL file
  was run by this unit. The conjoined confirmation is provider-neutral (it is one
  prepared selector through the existing `Queries.select`), and the PGlite shard
  above exercises it on the Postgres dialect.
- Hosted Neon/D1 remain outside this checkpoint.
- The attribution cost in §1 has no registered witness, because no cell in the
  tree loses ONE of two matched conditions: stating it would mean adding a cell
  that pins the inexact sentence.

## 13. Blockers

None.

---

## Commit message draft

```
fix(raptor3): one confirmation carries every matched condition, and the schedule that waits for it latches on the lock

The frozen gate's two reds are one rule's statement and the statement an
interactive found arm now first contends on.

`CommandExecution.confirmFound` re-took the located row once per MATCHED
condition probe. Every matched condition is a requirement of the same
consumption of the same row, so they are ONE premise and one statement: the
probes that matched are conjoined through `Queries.andSelectors` over the
prepared selectors they already carry — the locator's base among them, reused,
nothing prepared again — and the row is re-taken once under that conjunction,
addressed by its identity and held through the effect. `Selection.confirm`'s
second argument becomes the prepared meaning it proves rather than another
selection, and the loop, its requirement list and its accumulator are gone. A
single condition is unchanged in every respect. What one statement cannot do is
name which of two matched conditions a concurrent commit took away, so the
failure is the first condition's, as the skip premise already reports one
unmatched probe; the fixed cell re-expresses its statement sequence and its
conjunction count to the derived ones and gains three pins for the reuse it is
named for.

The competing-upserts interleaving timed out because it latched on the UPDATE
behind that confirmation: `performance_schema` shows the second operation's
`SELECT … FOR UPDATE` queued on an `X,REC_NOT_GAP` lock on the located PRIMARY
key, so the statement the latch waited for could not be sent until the test
released the holder it was waiting to release. The engine takes no lock it must
not — one record lock on the row it located, on the one shape the rule requires
it for — so the cell latches on the locking read instead, as its root-update and
root-delete neighbours already did, and a lock-HELD control beside it proves the
waiter queues on the holder's lock and then answers over what the holder
COMMITTED: a row that no longer carries the selector it was probed under, which
the found arm refuses with its own sentence, having written nothing.

Engine 16,185 -> 16,182 token lines. Typecheck 0; refusal census byte-for-byte
the gate's; Biome identical to the base copies.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

> **Integrator's note (after the review, ACCEPT with one minor).** The reviewer asked for a registered witness of the one behaviour this unit changes — a dual-condition upsert that loses only its SECOND matched condition — beside `tests/providers/local/sqlite3-found-consumption.test.ts:275`, pinning the class, that no write was sent, and the unchanged row. Not added in this checkpoint: it is recorded here as an owed witness of a documented attribution cost (the sentence names the first condition's field), so the next reviewer can take it or the next unit can add it with its own falsification.
