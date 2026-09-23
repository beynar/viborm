# Rulings unit — D-28, D-29, D-32 (author note)

Author: rulings unit agent, 2026-09-17. Worktree `/private/tmp/viborm-rulings`,
branch `rulings` from `5ac39cfd`. `TMPDIR=/private/tmp/viborm-rulings-tmp` on
every run, one run at a time. Nothing committed, staged, reset, stashed or
pushed; `/Users/arnaud/code/viborm` and every other worktree untouched.

Worked in the briefed order — D-32, D-29, D-28 — each with its falsifier and a
falsification record taken by reverting the named hunk in the live tree and
restoring from a byte-exact scratchpad copy (`shasum` re-checked after every
restore).

---

## Gate (written before the first production edit)

| ruling | required behaviour | current owner | smallest change | decisions that disappear |
| --- | --- | --- | --- | --- |
| **D-32** | A premise that states the LOSS of a membership this operation observed is raceable: the unit aborts, the operation re-plans once from the admitted values, and converges — or propagates its registered sentence when the race repeats. | `shared/operation-context.ts` `captureMembership`: one sentence, two arms; only the `requireAbsent` arm carried `meta.raceable`. | State the mark ONCE, where the sentence is built, for both arms. | "Is THIS arm raceable?" — the sentence answers it, not the arm. |
| **D-29** | A premise queued during planning is dispatched inside the atomic unit that carries the write it protects, never in an earlier planning batch. | `shared/operation-context.ts` `flush` — the place planning reads become batches — submitted the whole queue, premises included. | The unit's trailing premises step aside for a planning read; a planning read with nothing else waiting is a read. | "Which batch proves this premise?" — the unit that carries its write, and no caller chooses. |
| **D-28** | One consumer for `DriverResultParser.parseResult`, at the one place a terminal window becomes a decoded result, on the live route and the prepared/batch route. | nothing in `src/` called it; `Queries` already held the driver's `DriverResultParser` for `parseField` (D-17). | `Queries.decodeResult` — the same provider chain as `providerValue`, one level up — asked once per operation at the terminal boundary. | "Does this route parse results?" — one boundary answers for all of them. |

---

## D-32 — the never-raceable capture premises, marked, with witnesses

### The truth

`submit` arms the batch re-plan only for a premise whose owner marked
`meta.raceable === true` (`shared/operation-context.ts:1251-1267` in the final
file, the repair round's R1b). `captureMembership` builds ONE sentence for two arms and marked
only the absent one, so the arm that says *the captured membership is gone*
stopped arming the re-plan at the repair round and had no registered witness
either way.

Arnaud's ruling: both `captureMembership` premises are raceable — loss after
observation re-plans once from fresh values like the other races. The reason is
IDENTITY, not observation: the two rows a singular-junction transfer connects
are the ones the arguments spelled, and the membership row is state the plan
DISCOVERED, so a fresh plan cannot land on another identity. That is what
separates it from the captured ROW's own presence and from the series' parent
premise, which are the caller's own identities.

### (1) Every queued premise, with its raceable status

Batch route only; a direct-route premise is a read plus a JavaScript throw.
"Gated" = this premise armed the re-plan before the repair round's raceability
gate and no longer does.

| # | site | premise | sentence | raceable | gated | ruling |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `commands/execution.ts:128` | `requireAbsent` | `Cannot update relation 'X' with onUpdate('restrict') while the current relation is occupied.` | **yes** (`:127`, under `usesBatch`) | no | unchanged |
| 2 | `commands/execution.ts:264` | `requirePresent(selection.captured(), selection.retained())` — the captured ROW's own presence | the selection's own retained error | no | **yes** | stays unmarked: the captured row IS the identity the operation was asked for, so a re-plan would retry against whatever row now answers the selector — the one thing `transitions/conditional-upsert.ts` forbids (`g2-upsert-skip-replaced` / `-deleted`) |
| 3 | `commands/execution.ts:287` | `requirePresent(located.captured(…))` — a record command's located row | the located row's `NotFoundError` / its own requirement | no | **yes** | stays unmarked: same identity argument as #2 |
| 4 | `commands/execution.ts:360` | `requireAbsent(…, command.failure())` — an unclearable set's absence | `Cannot set relation 'X' because foreign key field(s) … are required: rows removed from the set cannot be disconnected. Delete them instead.` | no | **yes** | stays unmarked, and DISCLOSED below: the sentence is a capability refusal addressed to the CALLER, not a loss after observation — and structurally so, because its excluded identities are the rows the caller spelled in `set` (`commands/relation-body.ts:755-766`), never rows this plan observed, which is exactly what separates it from `requireNoAddedMember` at `:744`, whose exclusion IS the plan-time read |
| 5 | `commands/execution.ts:429` | `requirePresent(lookup.captured(…), conditions.missingRow)` — conditional upsert's captured row | the missing-row error | no | **yes** | stays unmarked: identity (#2) |
| 6 | `commands/execution.ts:433` | `requireAbsent(lookup.captured(unmatched…), unmatched.skip)` — the conditional skip | the skip error | **yes** (`commands/commands.ts:1218`) | no | unchanged |
| 7 | `commands/execution.ts:443` | `requirePresent(lookup.captured(condition…), condition.match)` — the `setWhere` match | the match error | no | **yes** | stays unmarked: identity (`g2-upsert-setwhere-match-replaced`) |
| 8 | `commands/execution.ts:744` | `requireAbsent` — `requireNoAddedMember`, a captured set's complement | `Cannot <verb> relation 'X': a member was added after the plan-time read; retry to converge.` | **yes** (`:743`) | no | unchanged |
| 9 | `commands/execution.ts:833` | `requirePresent(parentRequirement…)` ahead of the complement | `Cannot <verb> relation 'X': parent record changed across a committed segment.` | no | no (added BY the repair round) | stays unmarked: its own comment says why — a raceable answer here would retry against ANOTHER parent's members, which is the defect R1c fixed (`g2-series-parent-reference-reused`) |
| 10 | `commands/execution.ts:902` | `requirePresent(parentRequirement…)` per member in `executeSeries` | the same sentence as #9 | no | **yes** | stays unmarked: same reason as #9 |
| 11 | `shared/operation-context.ts:2584` | `requirePresent(junction(edge, captured), failure)` — the captured membership | `Concurrent membership change on the singular polymorphic member of relation 'X': the captured membership is gone; retry to converge.` | **yes — THIS RULING** | yes | marked |
| 12 | `shared/operation-context.ts:2585` | `requireAbsent(query, failure)` — a slot read empty | `… another owner holds the target; retry to converge.` | **yes** (already) | no | the mark moves to the sentence both arms share; behaviour unchanged |
| — | `shared/operation-context.ts:1408` | the PREPARED presence guard (`packagedPresence`) | rebuilt `NotFoundError` | `raceable: false`, stated in the guard record | n/a (array preparation) | unchanged: it is the packaged form of #3 |

### (2) The change

`shared/operation-context.ts` `captureMembership` (one hunk, `:2571-2585` in the
final file): the mark is stated once, where the sentence is built, and the `else`
block collapses. No new field, no branch on the arm, no boolean.

Every line reference in this section is stated against the FINAL file, restated
in the repair round (the D-29/D-32 review's resolution 3): the numbers first
recorded here were taken before D-28's insertions above `captureMembership` and
were about a hundred lines low.

### (3) Witnesses

`tests/raptor3/g4/parity/integration-membership-race.test.ts` (new, 3 cells) —
a real SQLite database, a batch-only transport that PROVES its rollback, and a
competing commit planted in the exact window the premise exists for:

1. the captured membership is replaced → two plans, two capture premises, the
   operation converges, and the slot still holds exactly one membership row,
   the adopter's;
2. every attempt races → the allowance is spent once and the registered
   sentence propagates, with the last racing writer still holding the target;
3. a slot read EMPTY is taken → the absent arm aborts, the re-plan captures the
   new holder's pair and transfers it.

### Falsification record

`receipts/d32-falsification.log`. With the hunk reverted in the live file, cells
1 and 2 redden (`planted`/`members` disagree: the operation propagates instead
of converging) and cell 3 stays green — which is the precise unique coverage of
the hunk: the PRESENT arm. File restored from
`scratchpad/backup/operation-context.ts.d32`, sha re-checked.

### Registered pins this ruling moved, and why the outcome did not move everywhere

- `tests/raptor3/transitions/junction-races-live.ts` (`g2-junction-held-capture-race`,
  `g2-junction-captured-owner-replaced`): two `meta.raceable` expectations said
  `undefined`, one of them with the sentence "The non-raceable captured-row
  guard must not request re-adoption". Re-expressed under the ruling: the mark
  is `true`. With D-32 ALONE every OUTCOME assertion stayed green
  (`winners === ["s1"]`, `reachedCuts`, the final rows), measured cause: on this
  pg transport the failing batch carried members over a transport that cannot
  prove its rejection rolled them back, so the operation held committed
  progress and the allowance was refused BEFORE raceability was consulted
  (probe: `committedProgress: true, mayHave: true, segments: 0, raceable: true`).
  `g2-pg-contracts` 18/18 at that point
  (`receipts/d32-g2-pg-contracts-after.log`). D-29's progress companion then
  removed that refusal, and the `replaced` outcome moved too — third item
  below.
- `tests/contracts/drivers/behaviors/nested-write-concurrency-behavior.ts`
  "an adopter whose captured owner was replaced …": with D-32 ALONE this cell
  was untouched (`receipts/d32-pg-nested-write-races.log`, the same 6 reds as
  the baseline). It flipped only once D-29's progress companion let the same pg
  batch prove it had written nothing. Re-expressed under both rulings: the
  adopter aborts, re-plans once and converges; `batchErrors.length >= 1` is
  KEPT and is what still falsifies the removal of the in-batch captured-owner
  premise (without the premise there is no batch error at all, the same final
  rows reached without proving anything).
- `tests/raptor3/transitions/junction-races-live.ts`
  `g2-junction-captured-owner-replaced`, the live twin of that cell, for the
  same reason and re-expressed the same way: `winners` is now `["s2", "s1"]`,
  the final holder is the adopter that finished last, no operation failed, and
  the first attempt's ABORT is pinned through `batchFailures` (an indexed
  `NestedWriteAssertionError`) — which is what separates convergence from a
  plan that proved nothing. The `winners.length === 1` law is kept for the
  SIMULTANEOUS held race, which still has one winner (`g2-junction-held-capture-race`
  green, unchanged). The registered sentence the cell used to observe is still
  pinned twice: in this file's own `NestedWriteError` branch, and verbatim in
  `integration-membership-race.test.ts` cell 2.

### Alternatives rejected

- **Mark only the present arm, leaving the absent arm's assignment where it is.**
  Two statements of one fact about one sentence; the ruling is about the
  sentence, so the mark belongs where the sentence is built.
- **Gate the mark on "the target is now free" so the replaced case still
  refuses.** A policy boolean, and a per-feature interpreter for one premise.
  Rejected under the no-patchwork rule.
- **Mark `commands/execution.ts:360` too** (the second premise the repair
  review's finding 3 named). Its sentence is a capability refusal that tells
  the CALLER to change the request ("Delete them instead"), not a loss after
  observation of anything this plan read; marking it would spend the operation's
  one recovery allowance on a refusal that is not a race. DISCLOSED as an open
  question for Arnaud rather than decided here: the ledger scopes D-32 to "the
  two `captureMembership` premises", and `commands/execution.ts:128` — the same
  family of occupancy refusal — IS marked raceable, so the two are arguably
  inconsistent today. No cell moves either way.

---

## D-29 — a queued premise rides the atomic unit it protects

### The truth, measured (not assumed)

The red cell is `pg filtered m2m deleteMany staleness › a member added after the
plan-time read aborts the guard, then the retry converges`, failing at
`batchErrors.length >= 1` — the guard never fired.

Measured on pg with a probe on the harness driver
(`PgBeforeFirstBatchDriver.executeBatch`, every batch printed, restored
byte-exact afterwards): the operation's FIRST batch is

```
[ SELECT 1 / CASE WHEN EXISTS (… "m2m_posts" … id = $1 AND id = $2 …) … "__viborm_assert__",
  SELECT "q0"."id" FROM "public"."m2m_posts" AS "q0" WHERE "q0"."id" = $1 ]
```

— a PLANNING batch carrying a PREMISE. The premise is the root record's located
presence (`commands/execution.ts:287`), queued during planning; the read is
`captureSeries`'s parent projection, which needs a round trip before the plan
can continue. `flush` submitted the whole queue, so the premise rode the
planning batch. The harness's window opens before the first batch, i.e. before
the plan-time membership read, so the captured set already contained the
competing member and the complement excluded it (`NOT ((id = $3 OR id = $4))`,
two excluded keys). The guard was correct and the window was closed before it
opened.

The same shape on SQLite has the same planning batch, which is why
`integration-staleness.test.ts` had to plant before the first MUTATION batch.

### The change

| file | hunk | what |
| --- | --- | --- |
| `shared/transport-attempt.ts:53-95` | `withholdPremises` / `restorePremises`, and `drainAssertedPremises` keeping a withheld premise's own failure | the queue's TRAILING premise run steps out of a dispatch and leads the next one, in the order it was stated |
| `shared/operation-context.ts:995-1018` | `flush` | the unit's premises step aside for a planning read; a planning read with nothing else waiting is a read, through `read`; the queued arm moves to `flushQueued` unchanged |
| `shared/operation-context.ts:1158-1180` | `submit`'s progress arm | its companion: a batch that rejected BEFORE its first write has nothing to roll back, and the provider said where it stopped — every statement ahead of the rejected one being a premise is that proof |

One owner decides when statements become batches, and it is the one the brief
named. No policy boolean: `withholdPremises` reads the premise map its own owner
already fills (`assertPremise`), and the progress proof reads the same map plus
the statement index the provider gave.

The progress companion is not decoration. Without it the guard fires and the
operation propagates `a member was added after the plan-time read; retry to
converge` instead of converging (`receipts/d29-falsification-progress.log`),
because `mayHaveCommittedSegment` is set for any failing batch with members on a
transport that does not advertise ordered committed segments — which is every
provider except D1. D-29's rule makes the unit reject AT a premise, ahead of its
own first write, so the inference is now provably wrong exactly where it matters.

**Its assumption, stated.** The proof reads the statement index the provider
gave, so it assumes a batch surfaces its FIRST failure and does not continue
past it. That assumption is not new: the same arm has exempted
`UniqueConstraintError` since the shipped engine, which is only sound on the
same reading, and the whole assertion mechanism — a statement that raises on
purpose — depends on the provider aborting the batch. The proof is also strictly
narrower than the exemption: it fires only when the rejected statement AND every
statement ahead of it are premises, so a rejection at a WRITE keeps the
uncertainty it always had, whatever its position
(`g4/unit02/uncertain-outcome-meta.test.ts` cell 2 is that pin, and it is what
narrowed the proof from "nothing before it" to "at a premise").

**Its consequence, stated.** Once a pg batch can prove it wrote nothing, D-32's
mark is finally consulted there, and the captured-membership race CONVERGES on
pg as it does on the witness transport. That is the ruling being realised on a
second transport, not a side effect of this unit's convenience — but it is what
moved `g2-junction-captured-owner-replaced` and the pg driver-contract adopter
cell, and it is the one thing in this unit Arnaud may want to weigh again. The
exact alternative, if he does: drop the progress conjunct and the D-29 pg cell
stays red (the guard fires, the retry is refused), while the pg junction race
keeps the outcome it had before this unit.

**How the scope was found, and it was found by a red cell, not by argument.**
The proof was first written for any rejection with nothing written ahead of it.
Measured: `g4/unit02/uncertain-outcome-meta.test.ts` cell 2 reddened (a
pre-dispatch rejection at index 0 with no statements ahead of it is not a
rejection AT a premise), which narrowed it to "the rejected statement is itself a
premise". Measured again: `g2-pg-series-parent-reference-reused` reddened on
Docker pg, because an operation that had already ACKNOWLEDGED a segment stopped
reporting `mayHaveCommittedSegment` for a later batch — and that cell exists to
state that the acknowledged prefix and the weak-native uncertainty are distinct
facts. So the proof is asked only where it can DECIDE the allowance
(`committedSegments === 0`): with a segment acknowledged, D-25 refuses the
recovery on progress alone and the proof could buy nothing, so it says nothing.
Both cells are green with the scope; neither was weakened to get there.

### Falsifier and falsification record

- The new local pin, `integration-staleness.test.ts` "proves every premise
  inside the unit that carries its write": exactly ONE dispatched batch carries
  a premise, that batch also carries a mutation, and it is the operation's first
  batch. Reverting the `flush` hunk reddens it at `proving.length` (2 batches
  prove premises) while the file's other three cells stay green —
  `receipts/d29-falsification-flush.log`. It reddens the Docker **pg** cell too,
  at `batchErrors.length >= 1` (the D-29/D-32 reviewer measured that arm; a
  hand-off sentence of mine said the local pin only, which is wrong and is
  corrected here).
- Reverting the progress conjunct alone leaves the local pin green and reddens
  the pg cell — `receipts/d29-falsification-progress.log`.
- `tests/raptor3/g4/parity/integration-staleness.test.ts` 4/4;
  `tests/providers/docker/pg-nested-write-races.test.ts` 90 passed / 5 failed,
  the D-29 cell GREEN and the five remaining reds the pre-existing `batch
  primary-key dataflow` ones (6 failed / 89 passed at the baseline,
  `receipts/baseline-pg-nested-write-races.log` →
  `receipts/rulings-pg-nested-write-races.log`).
- `g2-transport` 16/16: no transport script, replay corpus or statement-count
  pin moved. Nothing was re-recorded.

### Round trips and statements, before and after

Measured with a recording SQLite driver on the two shapes the brief named, on
both routes, with the production files at `5ac39cfd` and then with this unit's
(same harness, same seed data, `driver.roundTrips` / `driver.statements`):

| shape | route | before | after |
| --- | --- | --- | --- |
| `fixed-collection-rowref-20` | live | 1 statement / 1 round trip | 1 / 1 |
| `fixed-collection-rowref-20` | batch-only | 1 / 1 | 1 / 1 |
| `nested-conditional-found` | live | 4 / 4 | 4 / 4 |
| `nested-conditional-found` | batch-only | 17 statements / 10 round trips | 17 / 10 |

No write gains a round trip. The rule moves a statement BETWEEN dispatches; it
never opens one, because a planning read that finds the queue empty is a read
and a planning read that finds the unit being dispatched still travels with it.

### Alternatives rejected

- **`captureSeries` reads its parent projection with `read` instead of `flush`.**
  One line, and wrong: the flush is load-bearing for a series under a freshly
  created parent — it dispatches the queued parent INSERT so the projection can
  read the row (the repair round's R1c relies on it explicitly). The rule had to
  keep "travels with the unit when the unit is being dispatched".
- **Dispatch planning reads through `read` unconditionally.** N independent
  reference projections (the `nested-conditional-found` shape) would become N
  round trips where they are one. The brief calls that a blocker, not a repair.
- **A second `_executeBatch` caller for planning reads.** `submit` is the one
  owner of "statements become a batch"; a second dispatcher would duplicate
  preparation, attribution and progress accounting.
- **Declaring the pg batch-forced test fixture `supportsOrderedCommittedSegments`.**
  It would make the pg cell converge by re-describing a transport instead of
  fixing an inference, and the flag also decides who acknowledges committed
  segments.

---

## D-28 — the driver `parseResult` middleware, wired as a result consumer

### The truth

`DriverResultParser.parseResult?(raw, operation, next)`
(`src/drivers/driver-instrumentation.ts:93-98`) is a public driver contract. Its
shipped consumer died with the result engine; D-17 restored only `parseField`.
Measured before this unit: **zero** callers in `src/`, and the middleware asked
zero times on every route (`receipts/d28-falsification.log` is that state).

### The change

| file | hunk | what |
| --- | --- | --- |
| `shared/query.ts:621-656` | `Queries.decodeResult` | the ONE owner of the result chain: driver `parseResult` → adapter `parseResult` → this engine's decoder, the mirror of `providerValue` one level up |
| `shared/operation-context.ts:886-926` | `answer` + `publishedTerminal` | the dispatcher both readers share, and the terminal boundary — asked once per operation, never per statement or member |
| `shared/operation-context.ts:934-941, 956-964` | `publish`, `publishPrepared` | the live and the prepared read route through the same boundary (rule 7) |
| `shared/operation-context.ts:1434-1463` | `decodeTerminalResults`, `finishTerminals`' live arm | the batch/prepared and live terminal windows, raw rows collected then decoded once |
| `shared/operation-context.ts:1893-1905, 1972-1990, 2051-2069` | `createMany`'s fold, `updateMany`, `deleteMany` | the three set-mutation publications that answer through RETURNING — the path a root `create`/`update` takes, which is one `INSERT … RETURNING` with the root projection folded in |

A terminal or a grouped insert split across several windows is a BIND-BUDGET
split of ONE projection (`seriesQueries`), so every window decodes against the
same shape and the operation still has one result. A set mutation that publishes
an affected-row COUNT is not asked: a row count is a fact of the transport, not
a result window — stated in the hunk and in the guide.

### Falsifier and falsification record

`tests/raptor3/g4/parity/driver-result-parser.test.ts` (new, 4 cells):

1. exactly one call per operation, in order, each naming its own verb, for
   `findMany`, `findUnique`, `count`, `aggregate`, `create`, `update` — live
   route;
2. the same six on the prepared route (`$transaction([…])` on a batch-only
   transport);
3. `raw` is the provider's own answer, above the row-value chain: a SQLite
   boolean arrives as the stored integer (`1n`/`0n`) and is published as a
   boolean;
4. `next(transformed)` is honoured — a middleware that reshapes the provider's
   answer reshapes the published one, which is the mechanism the SQLite family's
   count/exists normalisation is written against.

Reverting the boundary (restoring `operation-context.ts` to its pre-D-28 state)
reddens all four, with the middleware asked **zero** times — the measured
pre-unit state. Restored, sha re-checked.

### The SQLite count/exists normalisation, and its one owner

`sqliteResultParser.parseResult` (`src/drivers/shared/sqlite-utils.ts:46-53`)
normalises a `count`/`exist` answer through `normalizeCountResult`, which
recognises a single-column row whose key is `0viborm_count_result` or begins
`count(`. Raptor 3 asks for `_count` and the providers preserve the alias, so
`extractCountValue` answers `undefined` and the arm passes through: the
normalisation's fact — "which column carries the count" — is owned by the
engine's own projection alias, and the driver arm is the recovery for a provider
that does not preserve it. Measured, not assumed: the pin's cells 1 and 2 count
one `count` call per operation and the answer is `2`, and
`provider-sqlite3` / `provider-libsql` / `provider-pglite` are green with the
consumer live (receipts below).

I did NOT delete the driver arm. Its unique coverage is nameable (a provider
that answers `COUNT(*)` as the column name), no provider in the estate needs it
today, and removing a public driver-owned normalisation is a decision for
Arnaud, recorded below. **Corrected in the repair round (the D-28 review's F4):**
the identity such a deletion would change is
`SQLite3Driver.canonicalDriverParseResult` (`src/drivers/sqlite3/index.ts:75-77,
221`) and bun-sqlite's, not `pglite`'s `hasCanonicalProducerSurface` question —
PGlite reads its OWN `result` (which is `undefined`) and its adapter's identity
(`src/drivers/pglite/index.ts:227-235`), and nothing in this unit rebinds
either. The conclusion is unchanged; the reason named the wrong file.

### The cache-SWR cell: still red, and exactly why

`tests/contracts/public-client/official-cache-swr.core.test.ts:550` expects
`hostileJsonReadsAtCoreBoundary === 1`. The boundary is now REACHED on the cache
route — measured with a probe on the cell's own driver, restored byte-exact:

```
D28PROBE findMany false 0      ← the first, fresh read
D28PROBE findMany false 0      ← another scenario's read
D28PROBE findMany true  0      ← the background revalidation, hostile publishing ON
```

One call per operation, on the revalidation too. What is still `0` is
`hostileJsonGetterReads`: the cell's hostile object is produced by the `json()`
field's user schema, and **no read path invokes a `json()` field's user schema**,
so the object is never built and never read. That is the second fact the
integration note §1c measured (`validate` invoked zero times in the whole file)
and it is a separate decision — invoking a user schema on the read path changes
read-path validation for every `json().schema(…)` field on every provider.
Raised as a blocker, not attempted. D-28 as briefed (a consumer for the
middleware) is complete and pinned; this cell needs the other decision.

### Alternatives rejected

- **The boundary inside `read()`, keyed off its `terminal` flag.** `finishTerminals`
  passes `terminal` only when there is exactly one query, so a bind-budget split
  would be asked per window — "per statement", which the ruling forbids.
- **The boundary inside `published()`.** It is the owner of the published
  CARDINALITY and receives rows already decoded; moving the decode into it would
  have made the fold's `finishTerminals` path ask twice.
- **Wrapping each `decodeProjection` call site.** Six call sites, four of them
  internal binding reads — patchwork, and the internal reads are not the
  operation's result.

---

## Registration of the two new files

`tests/raptor3/g4/parity/integration-membership-race.test.ts` and
`driver-result-parser.test.ts` sit beside `integration-staleness.test.ts` and are
collected the same way: `EXTENDED_LOCAL_TESTS`
(`scripts/credential-free-test-manifest.mjs`) is a file walk over `tests/` that
excludes `.core.test.ts`, `tests/package/`, `tests/providers/`,
`tests/raptor3/g4/review/` and a named exclusion set — none of which covers
`tests/raptor3/g4/parity/`. So both run in the `extended-local` project and in
the credential-free estate lane without a manifest edit, which is why every run
above reports them under `|extended-local|`.

## Guide

`src/query-engine/raptor3/AGENTS.md`, at the paragraphs that own each invariant:
the D-17 row-boundary paragraph gains the RESULT boundary and its four callers
(D-28); the recovery paragraph's raceability sentence gains the identity/observation
distinction, both `captureMembership` arms, and the fact that the mark alone
never authorises an attempt (D-32); the captured-member-set paragraph gains the
premise/planning-batch rule, its owner, and the progress companion (D-29).

## Verification

One file or one registered mode per call, `TMPDIR` exported, never two at once.
Receipts under `receipts/`.

| target | result |
| --- | --- |
| `tests/raptor3/g4/parity/integration-membership-race.test.ts` (new) | **3/3** |
| `tests/raptor3/g4/parity/integration-staleness.test.ts` | **4/4** (3 + the new D-29 pin) |
| `tests/raptor3/g4/parity/driver-result-parser.test.ts` (new) | **4/4** |
| `tests/raptor3/g4/parity/lane-x-set-mutations.test.ts` | **9/9** |
| `tests/raptor3/g4/parity/lane-x-route-seam.test.ts` | **3/3** |
| `tests/contracts/engine/query/parity-{admission,assignments,decoding,lowering,preparation}.core.test.ts` | **75 / 6 / 9 / 20 / 36**, all green |
| `g2-baseline` | **216/216** |
| `g2-contracts` | **216/216** |
| `g2-transport` | **16/16** |
| `cs01-extension-a` | **6/6** |
| `g3p03-contracts` | **6/6** |
| `g2-pg-contracts` (Docker pg 55729) | **18/18** |
| `tests/providers/docker/pg-nested-write-races.test.ts` (Docker pg) | **90 passed / 5 failed** — baseline was 89/6; the D-29 cell green, the five reds pre-existing |
| `g4-unit02-author` | **131/131 tests**, gate exit 1 on a PRE-EXISTING manifest count (below) |
| `tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` | **8/8** — the pin that narrowed D-29's progress proof |
| `--project=layer-drivers` (the `tests/contracts/drivers/**` contracts, D-28's falsifier) | **969/969** |
| `--project=layer-write-engine` | **50/50** |
| `--project=layer-query-engine` | **642 passed / 1 failed** — the pre-existing `contract-matrix` inventory cell |
| `--project=layer-client` | **535 passed / 1 failed** — the cache-SWR cell (blocker 1) |
| `--project=provider-sqlite3` | **755 passed / 1 skipped** (the skip is at `HEAD` too) |
| `--project=provider-libsql` | **9 passed / 663 skipped** (no libsql credentials here) |
| `--project=provider-pglite` through the credential-free lane (`--only "provider-pglite: <file>"`, the only path with PGlite's raised ceiling), all five files, each also re-run with the production files restored to `5ac39cfd` where it was red | `pglite-reads` **141/141**; `pglite-vector` **7/7**; `pglite-bulk-writes` **138 passed / 9 failed — the same 9 at the base**; `pglite.test.ts` **124 passed / 5 failed / 1 skipped — the same 5 at the base**; `pglite-nested-writes` **122 passed / 4 failed**; `pglite-scalars` **302 passed / 5 failed** (enum-comparison `42883` and a json-null decode: PGlite's own gaps) |
| `--only pglite` (the credential-free lane's three PGlite stages) | `g29-result-progress-pglite` **1/1**; `imported-pglite` shard 1 **104 passed / 227 skipped**; shard 2 **136 passed / 2 failed** — `operations.test.ts › refuses a child-held connect across more than one matched row` and `cs02-structure-measure`, **both verified identical at the pristine base** |
| `node scripts/run-typecheck.mjs` (whole estate, native) | **0 diagnostics, exit 0**, ~5.0 GiB peak |

### Formatting

`npx biome check` on every touched file, never `--write`. The two new files and
`transport-attempt.ts`, `integration-staleness.test.ts` and
`nested-write-concurrency-behavior.ts` are clean. `operation-context.ts` and
`query.ts` keep their pre-existing diagnostics (parameter properties, import
order, unrelated rules) and NONE falls on a line this unit wrote — measured by
intersecting the diagnostic lines with the diff's added ranges.
`junction-races-live.ts` measured IN PLACE at both revisions: **39 diagnostics
before, 39 after**, no new rule; one pre-existing `noMisplacedAssertion` moved
onto the `meta.raceable` line this unit rewrote (the file asserts inside
`fixture.assert`, which that rule has always flagged).

### Requested change, owned by the integrator (not made here)

`scripts/raptor3-manifest.mjs:566` —
`"tests/raptor3/g4/unit02/key-arithmetic.test.ts": 20` should be `21`. Commit 7
(`5ac39cfd`, the V8003 whole-value pin arm) added a cell to that file without
bumping its count, so `g4-unit02-author` fails its own registration gate
("Missing candidate/profile/scenario cell … 21 !== 20") with all 131 tests
green. Pre-existing at this unit's base; neither file is touched here.

## Still red, each with its reason

1. `tests/contracts/public-client/official-cache-swr.core.test.ts` › *contains
   provider, snapshot, set, and cleanup failures* — D-28's consumer is live and
   reached on the cache route (measured above); the cell also needs a read-path
   invocation of a `json()` field's user schema, which is a separate decision.
   **Blocker.**
2. `tests/providers/docker/pg-nested-write-races.test.ts` › the five `pg
   batch-only batch primary-key dataflow` cells (`Raptor 3 G1 atomic output
   requires exact identity scratch or segmented RETURNING`) — red at the
   pre-parity base, named by no unit of the plan, untouched here.
3. `tests/contracts/architecture/contract-matrix.core.test.ts` › *inventories
   every executable test by owner and boundary* — pre-existing: `tests/inventory.ts`
   classifies no file under `tests/raptor3/`. This unit's two new files join
   ~100 others in that set.
4. `provider-pglite`: nine cells in `pglite-bulk-writes.test.ts` (the
   generated-PK-in-batch family, the local twin of still-red 2), five in
   `pglite.test.ts`, four in `pglite-nested-writes.test.ts` and five in
   `pglite-scalars.test.ts` — every one of the four files re-run with the
   production files restored to `5ac39cfd` and measured IDENTICAL (9/5/4/5), so
   all pre-existing.
5. `tests/contracts/public-client/operations.test.ts` › *updateMany refuses a
   child-held connect across more than one matched row* — pre-existing, measured
   at the pristine base: the operation does not throw, so the cell reads
   `.message` of `undefined`.
6. `tests/raptor3/core-structure/measurement/cs02-structure-measure.test.ts` ›
   both cells — pre-existing: the mode measures through
   `g4/structure/instrumentation.patch`, which this worktree does not have
   applied, so `activationIds` comes back empty. Identical at the base.
7. `g4-unit02-author`'s registration gate — the pre-existing manifest count for
   `key-arithmetic.test.ts` (requested change above). All 131 tests pass.

## Blockers

1. **The cache-SWR cell's second half** (above): a read-path invocation of a
   `json()` field's user schema. Observable for every `json().schema(…)` field
   on every provider; not attempted.
2. **`commands/execution.ts:360`, the unclearable-set premise** — left
   unmarked, disclosed under D-32's alternatives. It armed the re-plan before
   the raceability gate, it has no witness either way, and the neighbouring
   occupancy refusal (`:128`) IS marked. A decision, not a repair.
3. **`sqliteResultParser.parseResult`'s count/exists arm** — inert for this
   engine's alias. Deleting it is a public driver-surface change (it also
   decides `SQLite3Driver.canonicalDriverParseResult`'s identity — corrected in
   the repair round, see F4 there); kept, disclosed.
4. **D-29's progress companion is a new observable compatibility choice** —
   added to this list in the repair round (the D-29/D-32 review's resolution 2),
   stated in full at "Repair round › D-29 resolution 2" below, with the two
   public observables it changes and the two registered cells it moved.

## Unverified claims

- The registered modes I did not run (I ran `g2-baseline`, `g2-contracts`,
  `g2-transport`, `cs01-extension-a`, `g3p03-contracts`, `g2-pg-contracts`,
  `g4-unit02-author`); no campaign or replay was re-qualified.
- MySQL: `g2-mysql-contracts` and `tests/providers/docker/mysql2*.test.ts` were
  not run. The changed owners are provider-neutral but the MySQL container's
  own reds are unmeasured here.
- `provider-pglite` ran one file at a time through the credential-free lane; the
  whole project cannot run under the bounded per-file runner at all, because
  PGlite's Wasm boot alone samples ~1.67 GiB against the ordinary 1536 MiB
  ceiling (4.4 s, before any test).
- `provider-postgres`, hosted-driver, migration and package projects.
- The perf figures above are STATEMENT and ROUND-TRIP counts from a recording
  driver, not the CPU protocol under `g4/`: no A/B benchmark was taken (the
  worker needs a `dist` build this worktree does not have).
- That D-32's mark changes no OUTCOME on any transport that cannot prove its
  rollback: shown for the two pg shapes measured, argued from `submit`'s
  progress arm for the rest.

## LOC delta (round 1; the unit's current figures are in §Repair round)

`git diff --numstat 5ac39cfd -- src tests` plus the two untracked files:

| file | + | − |
| --- | --- | --- |
| `src/query-engine/raptor3/AGENTS.md` | 45 | 2 |
| `src/query-engine/raptor3/shared/operation-context.ts` | 143 | 34 |
| `src/query-engine/raptor3/shared/query.ts` | 36 | 0 |
| `src/query-engine/raptor3/shared/transport-attempt.ts` | 36 | 2 |
| `tests/contracts/drivers/behaviors/nested-write-concurrency-behavior.ts` | 20 | 17 |
| `tests/raptor3/g4/parity/integration-staleness.test.ts` | 32 | 0 |
| `tests/raptor3/transitions/junction-races-live.ts` | 38 | 18 |
| `tests/raptor3/g4/parity/integration-membership-race.test.ts` (new) | 250 | 0 |
| `tests/raptor3/g4/parity/driver-result-parser.test.ts` (new) | 208 | 0 |
| **total** | **808** | **73** |

Production source, comments included: **+215 / −36** across three files
(`operation-context.ts`, `query.ts`, `transport-attempt.ts`); about 120 of those
added lines are comment. The guide is +45/−2. Tests and evidence are counted
separately, as the gate requires.

## The §7 questions, against the actual diff

1. **What decision disappeared?** Three: whether a capture arm is raceable (the
   sentence answers it), which batch proves a premise (the unit that carries its
   write, and no caller chooses), and whether a route parses results (one
   boundary answers for every route).
2. **Is any fact now stated twice?** No. `meta.raceable` moved from an arm to the
   sentence; `withholdPremises` reads the premise map `assertPremise` already
   fills; `Queries.decodeResult` is the only implementation of the result chain
   and `publishedTerminal` its only shape adapter for terminals.
3. **Did a new interpreter, context, scope or policy bag appear?** No new class
   and no boolean bag. Two methods on the existing `TransportAttempt`, one on
   `Queries`, two private helpers on `OperationContext` (`answer`,
   `publishedTerminal`) and one extracted arm (`flushQueued`).
4. **What is the replacing invariant, and what falsifies it?** Stated in the
   guide at the three paragraphs that own these facts; falsified by the three
   pins named above, each demonstrated by reverting its hunk.

## Write discipline

Production files touched: three, all under `src/query-engine/raptor3/shared/`,
plus the guide. Test files touched: two re-expressed under the rulings they name
and one extended with a new cell; two new files. Every falsification restored
its file from a byte-exact scratchpad copy with `shasum` re-checked; two
temporary probes (one in `src`, one in a test fixture, one in the cache cell)
were removed and their files restored the same way. `/Users/arnaud/code/viborm`
carries no change from this unit. Nothing committed, staged, reset, stashed or
pushed; no test deleted, weakened or skipped.

---

## Repair round

Second pass over the same unit, after the two independent reviews. It applies
exactly the resolutions they asked for — `review-d28.md` F1–F4 (REVISE) and
`review-d29-d32.md` resolutions 1–3 (REVISE) — and repairs the regression the
integrator's whole fixed-group run found on this tree. Nothing else changed: no
new decision, no new owner, no re-recorded evidence. Receipts for this round are
under `receipts/repair/`.

### The regression, and its bisection

The integrator's run of the whole fixed group on this tree
(`verification/fixed/g3-execution-review.log`,
`g3-author-execution-regressions.log`) found four cells in two registered modes
failing with `QueryEngineError: Raptor 3 createMany final read returned
inconsistent row counts.`, all green at `5ac39cfd`:

| mode | cell |
| --- | --- |
| `g3-execution-review` | *reads a supported incremented key when the public result omits it* |
| " | *reads through a supported compound key transition with omitted result keys* |
| " | *partitions non-returning terminal reads by bind count and preserves input order* |
| `g3-author-execution-regressions` | *keeps prepared cardinality independent of terminal query chunking* |

Bisected in a scratch copy (`git worktree add --detach e821cd21a`,
`/private/tmp/viborm-rulings-bisect`) by reverting ONLY `decodeTerminalResults`
and `finishTerminals`' live arm to their `5ac39cfd` bodies, with every other
D-28, D-29 and D-32 hunk in place: both modes go green again — **6/6** and
**3/3** (`receipts/repair/bisect-terminal-hunk-reverted-g3-execution-review.log`,
`…-g3-author-execution-regressions.log`). So the regression is the
terminal-window half of D-28 and nothing else, which is the D-28 review's F1,
reproduced here independently.

**The defect.** `publishedTerminal` concatenated every terminal window's raw
rows and decoded the whole set once through `decodeQuery(queries[0], …)`. The
note's premise — every window decodes against the same shape — is true, but
`shape` is not the only fact a window carries: `selectSeries`
(`shared/query.ts:3140-3183`) stamps each bind-budget window with its OWN
identity count and its own registered refusal, and `decodeQuery` is where that
contract was enforced. Asked once against `queries[0]`, it compared the SUM of
all windows with window 0's count, so every multi-window terminal read-back
refused a legitimate operation with an internal-invariant message — and the
per-window refusals (`createMany`'s "could not read back one of the created rows
at the primary key it reported", `updateMany`'s "could not read back one of the
updated rows at its final primary key") could no longer fire in the split they
were written for. Production reach: `createMany`/`updateMany` with `select` on a
provider without RETURNING (MySQL), and every nested member read-back on every
provider once it exceeds the driver's bind budget.

### F1 — the row-count contract keeps its window, the middleware keeps its operation

The fix is the review's own resolution, verbatim in substance: one owner for the
row count, asked where the window is still known; one ask for the operation,
over the concatenation, decoded against the shared shape.

| file | hunk | what |
| --- | --- | --- |
| `shared/query.ts:4184-4205` | `assertExpectedRows` extracted from `decodeQuery`, both branches verbatim | the ONE owner of a query-level row-count requirement. `decodeQuery` asks it (unchanged for its single-statement callers: `read`, `flushQueued`) |
| `shared/operation-context.ts:906-922` | `publishedProjection` | the boundary's one shape: driver `parseResult` → adapter `parseResult` → this projection's decoder, asked once per operation |
| `shared/operation-context.ts:923-946` | `publishedTerminal(queries, windows)` | one window per terminal statement: `assertExpectedRows` per window on the rows the PROVIDER answered, then ONE `publishedProjection` over `windows.flat()` against the shared shape, which carries no row-count check |
| `shared/operation-context.ts:961, 984` | `publish`, `publishPrepared` | one window each |
| `shared/operation-context.ts:1463-1492` | `decodeTerminalResults`, `finishTerminals`' live arm | both already looped; they now collect `Input[][]`, one entry per window, in dispatch order |
| `shared/operation-context.ts:1923-1927, 1999-2004, 2073-2078` | `createMany`'s fold, `updateMany`, `deleteMany` | F3, below: the three publications read the one boundary |
| `AGENTS.md` | the result-boundary paragraph, and the projection paragraph | the count half of the claim, which the paragraph omitted, and the row-count owner by name |

Two notes on the shape of it. The count is decided BEFORE the middleware is
asked anything, because a middleware that legitimately replaces the operation's
rows must not be judged against a physical window count — that is the same
reading `next(transformed)` already had (pin cell 4). And `windows[index]!` is a
non-null assertion, not a fabricated window: one window per terminal query is
the callers' own loop invariant, and the file states index invariants the same
way (`statements[error.meta.statementIndex]!`).

**Falsification.** In the scratch worktree at `e821cd21a` (the pre-repair
boundary), the new chunked cell reddens with exactly the estate's message —
`QueryEngineError: Raptor 3 createMany final read returned inconsistent row
counts.` — and the pin's other four cells stay green
(`receipts/repair/falsification-f1-chunked-pin-at-e821cd21a.log`). That is also
F2's own proof, below. No file in this worktree was mutated for a falsification
this round; both falsifications ran in the detached scratch copy.

### F2 — a pin for the caller that broke

`driver-result-parser.test.ts` gains one cell, *"sees a chunked terminal's rows
once, in input order, on both routes"*, and the header names the fifth fact. It
drives `createMany` + `select` (four rows, input order NOT key order, the
addressed key omitted from the public result) on a driver with no RETURNING and
`maxBindParametersPerStatement = 7`, which answers the read-back in two windows
of two, on the live arm (`finishTerminals`) and on the batch arm
(`decodeTerminalResults`) — the two callers the old pin never reached. It pins:
the terminal really spanned two windows (counted at the provider, not from the
recorded batch composition, which records a batched window twice); the
middleware was asked exactly once, naming `createMany`; it was handed the
OPERATION's four rows in input order, not one window's two; and the published
cardinality is the input's, whatever the budget was.

### F3 — one publication, not three readers of it

`operation-context.ts:1999-2004` (`updateMany`) and `:2073-2078` (`deleteMany`)
were textually identical, and `createMany`'s fold was the same call over
accumulated rows. `publishedProjection` is now the one reader, and
`publishedTerminal` is stated over it. No behaviour change; the "four callers"
smell the guide recorded is gone, and the count sentence ("a row count is a fact
of the transport, not a result window") is stated once, at the boundary, instead
of twice at the call sites.

### F4 — the note's wrong driver sentence

Corrected in place, in "The SQLite count/exists normalisation, and its one
owner": the identity a deletion of `sqliteResultParser.parseResult` would change
is `SQLite3Driver.canonicalDriverParseResult` and bun-sqlite's, not `pglite`'s
`hasCanonicalProducerSurface` question. Blocker 3 restated with it. The
conclusion (keep the arm; deleting a public driver surface is Arnaud's call) is
unchanged.

### D-29 resolution 1 — the progress companion's own deterministic pin

The companion had only a Docker-gated falsifier, and it silences a second
observable the note did not name. `integration-staleness.test.ts` gains one
cell, *"reports no progress for a batch rejected at a premise, and keeps it for
one rejected at a write"*, on the only transport that can reach that arm:

- fixtures. `PlantingBatchSQLiteDriver` now holds what both transports share
  (the competing commit, planted before a batch that mutates, and the batch
  composition) — extracted from `StaleBatchSQLiteDriver` with no behaviour
  change, which keeps its rollback proof and its own loop. `WeakBatchSQLiteDriver`
  is the new one: it leaves `supportsOrderedCommittedSegments` at the driver
  default (`false`), keeps NO loop of its own — the base loop
  (`driver-transaction-base.ts:748-765`) is what attaches the `statementIndex`
  the proof reads, and a fixture that loops itself attaches none — and can
  reject AT the batch's first write. `RecordingCache` over `MemoryCache` counts
  what the client's cache rail was asked to drop, the pattern
  `g4/unit02/uncertain-outcome-meta.test.ts` cell 3 uses for this seam.
- the premise arm. A repeated race (`plantsLeft = 2`) on the filtered m2m
  `deleteMany` shape: the allowance is spent once, the registered sentence
  propagates, and the refusal carries **no** `recordSeriesProgress` and drops
  **nothing** from the cache. Both are the companion's own answers: the unit
  rejected at a premise with nothing but premises ahead of it, so it wrote
  nothing, there is no progress to report and nothing to invalidate. The cell
  also pins that the allowance was spendable at all (`planted === 2`), which is
  what an operation told it may have written never gets (D-25).
- the write arm. The same operation with the batch's first write rejected
  instead: `recordSeriesProgress.mayHaveCommittedSegment === true` and exactly
  one invalidation — the uncertainty a rejection at a WRITE always had.
- falsification. With `!rejectedBeforeAnyWrite` dropped in the scratch copy, the
  cell reddens at the progress fact and prints the exact meta the reviewer
  measured at `5ac39cfd`: `{ atomicity: 'segment', phase: 'member',
  committedSegments: 0, completedMembers: 0, committedWriteMembers: 0,
  mayHaveCommittedSegment: true, memberPath: [0], totalMembers: 1 }`
  (`receipts/repair/falsification-d29-companion-conjunct-dropped.log`). The
  file's four other cells stay green.

### D-29 resolution 2 — the companion, as a blocker

Added to the Blockers list above as item 4; stated here in full.

**The choice.** D-29's ruling moves WHERE a premise is dispatched. Its
companion (`submit`, `shared/operation-context.ts:1176-1201`) changes what a
rejection PROVES: a batch that rejected at a premise, with nothing but premises
ahead of it, is no longer `may-have-committed`. It is correct, it is narrowly
scoped, and it is load-bearing for the pg cell the brief demanded green — but it
goes beyond the ruling's words, so it is Arnaud's to weigh.

**What it changes, publicly.** On a weak native batch transport
(`supportsOrderedCommittedSegments === false`) whose rejection carries a
`statementIndex` — any driver using the base `executeBatch` loop — a premise
race that propagates publishes, at `5ac39cfd`,
`meta.recordSeriesProgress = { atomicity: "segment", phase: "member",
committedSegments: 0, completedMembers: 0, committedWriteMembers: 0,
mayHaveCommittedSegment: true, memberPath: [0], totalMembers: 1 }` and notifies
the client's `writeMayBeVisible` rail; with the companion it publishes no
`recordSeriesProgress` at all and notifies nothing. Both are the right answers
under the ruling (the unit wrote nothing), and both are now pinned by the cell
above — that half of the change was unstated until this round.

**The two registered cells it moved** (not D-32, which was measured separately):
`tests/raptor3/transitions/junction-races-live.ts`
`g2-junction-captured-owner-replaced`, and the pg driver-contract adopter cell in
`tests/contracts/drivers/behaviors/nested-write-concurrency-behavior.ts` ("an
adopter whose captured owner was replaced aborts, re-plans once, and converges").
**The exact alternative if Arnaud declines it:** drop the conjunct and the D-29
pg cell stays red (the guard fires, the retry is refused), while the pg junction
race keeps the outcome it had before this unit.

### D-32 resolution 3 — the line references

Every line reference in the D-32 section is restated against the final file: the
gate is `:1251-1267`, the hunk `:2571-2585`, table rows 11 and 12 `:2584` and
`:2585`, and the prepared guard's `raceable: false` `:1408`. Row 4's disclosure
also gains the reviewer's stronger reason: its excluded identities are the rows
the CALLER spelled in `set` (`commands/relation-body.ts:755-766`), never rows
this plan observed, which is the structural difference from
`requireNoAddedMember`. The decision stands as disclosed.

### Verification (this round)

One file or one registered mode per call, `TMPDIR=/private/tmp/viborm-rulings-tmp`,
never two at once. Receipts under `receipts/repair/`.

| target | result |
| --- | --- |
| `g3-execution-review` (the regression) | **6/6**, gate verified |
| `g3-author-execution-regressions` (the regression) | **3/3**, gate verified |
| `tests/raptor3/g4/parity/driver-result-parser.test.ts` | **5/5** (4 + the chunked terminal) |
| `tests/raptor3/g4/parity/integration-staleness.test.ts` | **5/5** (4 + the companion pin) |
| `tests/raptor3/g4/parity/integration-membership-race.test.ts` | **3/3** |
| `tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` | **8/8** (the pin that narrowed the proof) |
| `g3-bulk-result-boundary` | **5/5**, gate verified |
| `g3-bulk-series` | **6/6**, gate verified |
| `g3-transaction-array` | **4/4**, gate verified |
| `g2-transport` | **16/16**, gate verified — no recorded plan or statement-count pin moved |
| `g2-baseline` | **216/216**, gate verified |
| `g2-contracts` | **216/216**, gate verified |
| `cs01-extension-a` | **6/6**, gate verified |
| `g3p03-contracts` | **6/6**, gate verified |
| `--project=layer-query-engine` (includes `parity-{admission,assignments,decoding,lowering,preparation}.core.test.ts`, 75/6/9/20/36) | **642 passed / 1 failed** — the pre-existing `contract-matrix` inventory cell (still-red 3) |
| `--project=layer-drivers` (D-28's driver contracts) | **969/969** |
| `--project=layer-write-engine` | **50/50** |
| `--project=layer-client` | **535 passed / 1 failed** — the cache-SWR cell (blocker 1) |
| `--project=provider-sqlite3` | **755 passed / 1 skipped** |
| `node scripts/run-typecheck.mjs` (whole estate, native) | **0 diagnostics, exit 0**, ~5.3 GiB peak |

Every number above is identical to this unit's first round except the four cells
the repair fixed and the two cells it added. Formatting: `npx biome check` is
clean on both touched test files (two formatter complaints fixed by hand: a
one-line type import and a one-line signature). `operation-context.ts` and
`query.ts` keep their pre-existing diagnostics; measured by formatting each file
through `biome format --stdin-file-path` and intersecting the resulting hunks
with this round's added ranges: **no overlap** in `operation-context.ts`, and in
`query.ts` the only overlap is a pre-existing hunk whose trailing CONTEXT lines
reach the first line of the new doc comment. The one formatter complaint that
did fall on a line this round owns — the trailing comma on the refusal string
`assertExpectedRows` now holds — is fixed by hand; the sentence itself is
verbatim.

### Not re-run in this round (unverified here)

- Docker **pg** and **MySQL**. This round's production change is D-28's terminal
  boundary and the row-count owner, both provider-neutral, plus test fixtures in
  one SQLite-only local file; D-29's and D-32's production hunks are untouched,
  so the pg evidence of the first round (the D-29 cell green, 90/5 on
  `pg-nested-write-races.test.ts`, `g2-pg-contracts` 18/18) stands unchanged and
  unremeasured.
- `provider-pglite`, `provider-libsql`, `provider-postgres`, hosted-driver,
  migration and package projects, and the credential-free estate lanes — the
  integrator's runs.
- The per-window `expectedRows.missing` refusals are restored to per-window
  evaluation by construction (the repair asks the count where the window is
  known), but no cell stages a window that answers SHORT: the upper bound throws
  first in every split I could build without a synthetic fault, which is the
  same limit the reviewer recorded.
- No CPU protocol run: the repair adds one array concatenation per published
  terminal (`windows.flat()`) and one `assertExpectedRows` call per window,
  against a decode that maps every row and every field. Not measured.

### LOC delta

`git diff --numstat e821cd21a -- src tests` (this round alone):

| file | + | − |
| --- | --- | --- |
| `src/query-engine/raptor3/AGENTS.md` | 18 | 7 |
| `src/query-engine/raptor3/shared/operation-context.ts` | 55 | 44 |
| `src/query-engine/raptor3/shared/query.ts` | 18 | 4 |
| `tests/raptor3/g4/parity/driver-result-parser.test.ts` | 131 | 2 |
| `tests/raptor3/g4/parity/integration-staleness.test.ts` | 226 | 31 |
| **total** | **448** | **88** |

`git diff --numstat 5ac39cfd -- src tests` (the unit, both rounds):

| file | + | − |
| --- | --- | --- |
| `src/query-engine/raptor3/AGENTS.md` | 58 | 4 |
| `src/query-engine/raptor3/shared/operation-context.ts` | 154 | 34 |
| `src/query-engine/raptor3/shared/query.ts` | 54 | 4 |
| `src/query-engine/raptor3/shared/transport-attempt.ts` | 36 | 2 |
| `tests/contracts/drivers/behaviors/nested-write-concurrency-behavior.ts` | 20 | 17 |
| `tests/raptor3/g4/parity/driver-result-parser.test.ts` | 337 | 0 |
| `tests/raptor3/g4/parity/integration-membership-race.test.ts` | 250 | 0 |
| `tests/raptor3/g4/parity/integration-staleness.test.ts` | 258 | 31 |
| `tests/raptor3/transitions/junction-races-live.ts` | 38 | 18 |
| **total** | **1205** | **110** |

Production source, both rounds, comments included: **+244 / −40** across three
files. The guide is +58/−4. `integration-staleness.test.ts`'s larger figure is
the fixture extraction moving two blocks, not new claims: base to now, the file
goes from 15 to 27 `it(`/`assert.` lines, with five cells where it had four —
no cell, assertion, `it` or `describe` was removed, weakened or skipped, and
nothing is `.skip`/`.only`.

### Write discipline (this round)

Files written: two production files, the guide, two test files, this note, and
`receipts/repair/`. Nothing else in this worktree; nothing in
`/Users/arnaud/code/viborm` or in any other worktree, and neither reviewer's
file or receipts were touched. Nothing committed, staged, reset, stashed or
pushed. Both falsifications ran in a detached scratch copy
(`/private/tmp/viborm-rulings-bisect`, `git worktree add --detach e821cd21a`), so
no file here was mutated and restored; the scratch worktree is left in place
(removing it writes to the shared git directory) and the integrator can drop it
with `git worktree remove --force /private/tmp/viborm-rulings-bisect`.
