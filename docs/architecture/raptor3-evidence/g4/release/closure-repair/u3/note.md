# U3 — the operation's answer is settled before the listener failure is released

Repair prompt §3. Branch `closure-se` from `bc18b4e23` (the base for this unit
is the tree U2 left), worktree `/private/tmp/viborm-se`, native PostgreSQL 16
(`raptor3_g2` server, this file's own `fcpg_closure` database). Receipts:
[`receipts/`](receipts/).

**The fixture is the repository's forced batch profile, not stock pg and not a
hosted driver** — the same statement U2's note makes, for the same reason:
`PgWindowedBatchDriver` runs real multi-connection PostgreSQL with
`supportsTransactions = false`, `supportsBatch = true` and RETURNING switched
off, which is the MySQL/PlanetScale capability profile executed against native
PostgreSQL. PostgreSQL's own route answers a selected bulk mutation with
RETURNING and never captures, so it cannot witness this contract at all.

## 1. The failing witness

The review's two public `onWriteOutcome` probes, converted into registered
cells of `tests/providers/docker/pg-captured-set-concurrency.test.ts` and run
on the unchanged production source of this unit's base
([`receipts/01-pg-outcome-red-at-base.log`](receipts/01-pg-outcome-red-at-base.log),
**2 failed / 26 passed**):

| falsifier | red at base |
| --- | --- |
| a held write-outcome listener failure does not take the captured DELETE's cardinality answer with it | `expected QueryError: Extension "failing-outcome" w… to be an instance of AggregateError` |
| a held write-outcome listener failure does not take the captured UPDATE's cardinality answer with it | `expected QueryError: Extension "failing-outcome" w… to be an instance of AggregateError` |

That is the review's measurement, in this tree's own words: the listener's
`QueryError` was the whole published failure. The cardinality sentence and the
`atomicity: "segment"` progress that says what committed were both lost — the
review saw them as `expected 'Extension "review-failed-outcome" wri…' to
contain 'deleteMany selected-row cardinality c…'` and `expected undefined to
match object { atomicity: 'segment', … }`.

The third new cell — a listener that fails beside a captured answer that
SUCCEEDED — is the **control**, and it is green at base and after: that
combination already published the listener's failure alone, and it still does.

After the repair the file is **28 / 28**
([`receipts/02-pg-outcome-green.log`](receipts/02-pg-outcome-green.log)).

## 2. The continuing invariant, and its single owner

**Invariant.** A settlement region contains every judgement that can still turn
this operation's answer into a failure — not only the decode. The batch
transport acknowledges BEFORE it has decoded anything, so a write-outcome
listener that fails while it acknowledges is HELD until the operation's own
answer to that batch is known; that answer includes the captured mutation's
cardinality, because transport success is not result success.

**Owner.** `OperationContext.settleSubmitted`, unchanged — the same hold, the
same single release, the same one composition (`retainWriteOutcomeFailure` at
`@errors`). What moved is WHERE the captured mutation's answer is stated:
`capturedMutation` now takes the caller's own answer and states it INSIDE that
region. There is no parallel accumulator, no new error class or sentence, no
public metadata protocol, no replay, and the composing sites stay **four**
(`submit`'s dispatch-failure catch, the carried value's decode catch,
`settleSubmitted`, `stateWriteOutcome`) — the region grew, no fifth composition
was added.

**Why the caller keeps its own answer.** The cardinality sentence belongs to
the verb: `updateMany` and `deleteMany` each build their own `changed()` and
already owe it to `requireCapturedSet` as well. `capturedMutation` owns the
POSITION at which the answer is stated, not its content. An earlier shape of
this repair moved the comparison into a private `capturedAnswer(response,
captured, changed)` helper; it was measured and rejected, because the census
then read `throw this.failure(changed(), "result")` as a sentence-less rethrow
(its `changed` is a parameter there) and the two registered cardinality
sentences DISAPPEARED from the refusal table — candidate refusals 30 sites / 23
distinct → 28 / 21, rethrow 56 → 57. The shipped shape keeps the throw in the
verb that owns the sentence, so the census is unchanged (§9).

## 3. The hunk

```
 src/query-engine/raptor3/shared/operation-context.ts       |  38 / -16
 src/query-engine/raptor3/AGENTS.md                         |  23 +      (one addendum)
 tests/providers/docker/pg-captured-set-concurrency.test.ts | 254 +      (3 new cells + their helpers)
 tests/providers/local/sqlite3-captured-answer-settlement.test.ts | 405 +  (NEW, repair round: 4 cells)
```

`capturedMutation(statement, context)` returning `Promise<QueryResult<unknown>>`
becomes `capturedMutation(statement, context, answered)` returning
`Promise<void>`:

- on the **batch** route, `answered(response)` is called inside the
  `settleSubmitted` closure that already extracted the response, so a failing
  answer takes the catch that composes it with the held failure and a
  succeeding one lets the held failure be published alone;
- on the **interactive** route, `answered(...)` is called on the dispatched
  response exactly where the caller's own check stood. There is no hold to
  release there (`heldOutcomeFailure` is set only in `submit`'s `acknowledged`),
  so nothing about that route changes;
- both callers pass the check they already had, verbatim, as a closure:
  `(response) => { if (response.rowCount !== identities.length) throw
  this.failure(changed(), "result"); }`.

## 4. What disappears

**The position at which the answer could be judged late.** `capturedMutation`
no longer hands a `QueryResult` back, so the two `const response = await
this.capturedMutation(…)` bindings and the two statements that followed them
are gone: the method's type now says that its answer is complete when it
returns, and a future caller cannot re-judge it one statement too late. That is
the defect's cause removed, not a wrapper around it.

**No check is deleted.** The row-count comparison is the same comparison, in
the same verb, with the same sentence and the same `result` phase — it moved
inside the settlement region. Its unique coverage is unchanged and still
named: a captured row the effect did not match is a row the operation was asked
to change and did not.

**Falsified both ways**
([`receipts/06-falsification.log`](receipts/06-falsification.log), applied to a
backup copy in `$TMPDIR` and restored by `cp`; `git checkout` was not used and
nothing was staged):

| removed | red | green |
| --- | --- | --- |
| A — the whole hunk (this unit's base source) | the two combined-failure cells | the other 26, including the four D-65 cardinality answers and the successful-answer control |
| B — the same answer, stated one statement AFTER `settleSubmitted` returns | the same two cells, and only them | everything else |

B is the one that matters: it proves the repair is the POSITION inside the
settlement region, not the relocation into `capturedMutation`.

## 5. A second applicable consumer

- **The captured `updateMany`.** The same position answers for the other verb,
  with its own sentence and its own read-back behind the answer: cell 2 above,
  red at base and green after, asserting that `n1` keeps its label, `n2` has
  the committed one and no result was published for either.
- **The interactive route**, where the same `answered` closure states the
  answer after `dispatch` and there is no hold to release. The capturing
  interactive shape is EXERCISED by `captured-identity-domains.test.ts` (18
  cells, an interactive SQLite driver with RETURNING off), green
  ([`receipts/05-…`](receipts/05-interactive-captured-arm.log)) — but none of
  those cells loses a captured row, so they do not pin the answer this unit
  moved. The repair round adds the cell that does: `interactive route: a
  captured row that stops matching before the write is answered by the
  cardinality sentence`, in the new credential-free file of §7, which goes red
  when the interactive `answered(...)` call is deleted (§13, falsification C).
- **D-58's carry decoding.** The other judgement that already sits in a
  released region and composes in its own catch: `one-write-outcome-composition`
  cell 2 — a HELD listener failure beside the carried value's decode failure,
  the primary keeping its progress — is the existing witness that this rule is
  not new, only incompletely applied. Green
  ([`receipts/03-…`](receipts/03-settlement-consumers.log)).

## 6. Capability change

**None for a valid uncontended operation.** Every existing cell of every file
run keeps its answer.

What changes is the failure a caller sees for ONE combination — a captured
mutation whose answer failed while a write-outcome listener also failed. It was
the listener's `QueryError` alone; it is now the estate's standard composition:
an `AggregateError` with the message `Query execution and write-outcome
publication both failed.`, the operation's own failure as `cause` and
`errors[0]` by identity (carrying `atomicity: "segment"`, `phase: "result"`,
`committedSegments: 1`), and the listener's `QueryError` retained at
`errors[1]` with its `meta.method`, its `meta.commitCertainty` and its cause.
That is the shape `retainWriteOutcomeFailure` already states everywhere else,
so no sentence, class or protocol is added — the combination simply stops
losing half of itself. The two mixed cases keep their behaviour exactly: a
successful answer beside a failed listener publishes the listener's alone
(cell 3, green at base and after), and a failed answer beside a successful
listener is the unchanged D-65 answer (four cells, green throughout).

No statement is added or removed on any route, so there is no statement-count
or lock-profile change to report: this unit changes when a judgement is made,
not what the database is asked.

## 7. Registrations

| file | cells | project(s) |
| --- | --- | --- |
| `tests/providers/docker/pg-captured-set-concurrency.test.ts` | **28** (was 25; 3 new) | `provider-pg` (glob `tests/providers/docker/pg*.test.ts`; no workspace or manifest edit) |
| `tests/providers/local/sqlite3-captured-answer-settlement.test.ts` (NEW, repair round) | **4** | `provider-sqlite3` (glob `tests/providers/local/sqlite3*.test.ts`, `vitest.workspace.ts:212`) and `coverage-drivers` (`scripts/driver-test-manifest.mjs:31-41` reads `tests/providers/local` FROM DISK) |

`scripts/raptor3-manifest.mjs` is NOT edited, and neither is
`vitest.workspace.ts`: both projects that pick the new file up do so by a glob
or by a disk read, and `scripts/coverage-policy.test.mjs:306-320` derives its
expectation the same way, so no fixed count is disturbed. No cell is deleted,
skipped, weakened or re-expressed by this unit — every cell named here is an
addition, and the pg file's existing 25 keep every assertion they had.

**The credential-free counterpart exists.** The first draft of this note
declined it, and the closure review refuted the reason: the two natural
EXISTING homes (`one-write-outcome-composition.test.ts`,
`batch-captured-bulk.test.ts`) are indeed manifest-enumerated with fixed cell
counts, but a NEW `tests/providers/local/sqlite3-*.test.ts` is glob-registered
and needs no manifest edit — U1 of this lane had already added one. The repair
round adds it (§13). The review's own schedule — the D-65 UPDATE/DELETE window
on the forced batch profile — remains where the probes were MEASURED, and the
pg cells stay the native pin; the credential-free file is what makes the §3
regression reachable without Docker.

## 8. Runs

One Vitest at a time; one docker file per invocation; the connection string
substituted from its file into a single command and never printed.

| run | result | receipt |
| --- | --- | --- |
| `pg-captured-set-concurrency.test.ts`, unchanged source (native PostgreSQL) | **2 failed / 26 passed** — the two converted probes | `01-…` |
| `pg-captured-set-concurrency.test.ts` (native PostgreSQL) | **28 / 28** | `02-…` |
| the settlement rule's other consumers: `one-write-outcome-composition` (incl. D-58 carry decoding), `uncertain-outcome-meta`, `author-execution-regressions` | 6 files (two projects), **30 / 30** | `03-…` |
| the captured mutation's own pins: `batch-captured-bulk`, `prepared-set-predicates`, `upsert-arm-referenced-edge` | 5 files, **50 / 50** | `04-…` |
| the interactive (non-batch) arm: `captured-identity-domains`, `malformed-result-cuts` | 4 files, **44 / 44** | `05-…` |
| falsification A and B | the two cells red in each, everything else green | `06-…` |
| `sqlite3-captured-answer-settlement.test.ts` (NEW, repair round; credential-free, two projects) | **8 / 8** (4 cells × 2 projects) | `11-…` |
| falsification C and D on that file (repair round) | C: the interactive cell alone red; D: the two batch composition cells alone red | `12-…`, `13-…` |

## 9. Typecheck, census, Biome

- **Typecheck**: `node scripts/run-typecheck.mjs` — **0 diagnostics, exit 0**
  ([`receipts/07-typecheck.log`](receipts/07-typecheck.log)).
- **Census**: `node scripts/raptor3-refusal-census.mjs`, exit 0
  ([`receipts/08-refusal-census.md`](receipts/08-refusal-census.md)).
  **Every class is identical to U2's** — invariant 22 / 21, internal 11 / 11,
  inherited refusals 75 / 75, candidate refusals 30 sites / 23 distinct,
  rethrow 56, total sites 194 — and the only differences in the whole document
  are line numbers and the header's uncommitted-file count. Both registered
  cardinality sentences are still read at their throw sites
  (`shared/operation-context.ts:2340` and `:2431`). No sentence is added,
  changed or removed. §2 records the shape that would have lost two of them and
  why it was rejected.
- **Biome**: per changed file, against the base copies
  ([`receipts/09-biome-after.log`](receipts/09-biome-after.log),
  [`receipts/10-biome-base.log`](receipts/10-biome-base.log)). **Identical**: 6
  errors, all in `operation-context.ts`, all pre-existing — `organizeImports`,
  four `noParameterProperties` (lines 384-397, untouched by this unit) and the
  file's own `format` diagnostic, whose diff has the same 61 lines and the same
  span (highest line 2146) before and after, so it does not reach a line this
  unit wrote and the formatter was NOT run on that file.
  `pg-captured-set-concurrency.test.ts` is clean, as its base copy was: its new
  lines are written the way Biome prints them, and its assertion helpers report
  facts for the cells to assert rather than calling `expect` outside a `test`
  (`noMisplacedAssertion`, which an earlier draft tripped nine times).

## 10. Cost

| perimeter | reference | after U2 | after U3 | U3's delta |
| --- | --- | --- | --- | --- |
| engine token lines (`scripts/query-engine-structure.mjs`) | 16,098 | 16,176 | **16,185** | **+9** |
| like-for-like | 19,956 | 20,034 | 20,043 (derived) | +9 |
| charged perimeter | 23,891 | 23,969 | 23,978 (derived) | +9 |

Both figures were MEASURED on this tree by the reader: 16,176 with this unit's
base copy of `operation-context.ts` in place, 16,185 with its final one. The
two perimeter rows are DERIVED, as U2's were: the one `src/` file this unit
touches is an engine file inside both perimeters, so the same +9 applies; the
integrator's own reader run on the final tree is the measurement.

`git diff --numstat bc18b4e23` (tracked files, U1, U2 and U3 together):

```
184	0	docs/architecture/raptor3-evidence/g4.md
145	3	src/query-engine/raptor3/AGENTS.md
182	12	src/query-engine/raptor3/commands/execution.ts
21	28	src/query-engine/raptor3/commands/relation-body.ts
37	8	src/query-engine/raptor3/commands/selection.ts
38	16	src/query-engine/raptor3/shared/operation-context.ts
102	71	tests/providers/docker/mysql2-concurrency-policy.test.ts
811	7	tests/providers/docker/pg-captured-set-concurrency.test.ts
```

U3's own share: `operation-context.ts` 38 / 16, `AGENTS.md` 23 / 0,
`pg-captured-set-concurrency.test.ts` 254 / 0, plus the repair round's new
untracked test file `tests/providers/local/sqlite3-captured-answer-settlement.test.ts`
(405 lines; untracked files do not appear in `git diff --numstat`, as U1's and
U2's new files do not either). No negative engine LOC was promised and none is
claimed. The engine figures above are UNCHANGED by the repair round: it touches
no `src/**` file except the `AGENTS.md` prose the review corrected, which the
reader does not count. `scripts/`, `benchmarks/`, `vitest.workspace.ts` and
every other `src/` file are untouched by this unit.

## 11. Unverified

- **No hosted batch transport witnesses the combination.** The hold exists only
  where the transport acknowledges before it decodes, which is the batch route;
  on the interactive route there is nothing to compose, and no cell claims
  otherwise. Two fixtures measure it — native PostgreSQL under the forced batch
  profile (§1) and, since the repair round, the credential-free batch-only
  SQLite transport (§13) — and Neon HTTP, D1 and PlanetScale are batch
  transports that are NOT exercised by either. The rule is the
  transport-independent one `settleSubmitted` already owned.
- **The credential-free file is not a concurrency suite.** One better-sqlite3
  connection carries the whole unit, so its drift is applied from a statement
  hook on the operation's OWN connection rather than committed by a second
  writer. What it reproduces is the POSITION the settlement owns — a shortfall
  the premises cannot see, discovered by the row count after the transport
  acknowledged. The concurrent schedule is the pg file's, and only the pg file's
  (`driver.schedule` asserts it there).
- **The listener's thrown message is not asserted.** This estate's diagnostics
  redact a wrapped cause's message by design (`sanitizeErrorCause` →
  `Underlying error details redacted`), so the cells assert the retained
  failure's class, sentence, `meta.method`, `meta.commitCertainty` and the
  PRESENCE of its cause, which is what the existing error model exposes.
- **`committedSegments: 1` is this fixture's number**, as the prompt says: it is
  asserted where the schedule makes it true (one acknowledged segment), not as
  a general claim about every captured mutation.
- **Not measured here**: the performance cells, the bundle footprint, the full
  native MySQL and PostgreSQL inventories, PGlite, and every other registered
  project. This unit ran only what discriminates; the frozen gate is the
  integrator's.
- **The repair prompt and the review witnesses are absent from the worktree.**
  Both were read read-only from the main checkout
  (`docs/architecture/raptor3-local-closure-repair-prompt.md` and
  `g4/release/closure-review-bc18b4e23/`). The integrator should bring both into
  the commit, as U2's note also asks.

## 12. Blockers

None.

## 13. Repair round (2026-09-21)

The independent review returned three MINOR findings on this unit, all of them
about what the unit SAID rather than what it does. No production behaviour is
changed by this round: `operation-context.ts` is byte-identical to the reviewed
copy, and the only `src/**` edit is the guide prose the review corrected.

**Finding 1 — the durable guide described the REJECTED shape.** The U3 addendum
at `src/query-engine/raptor3/AGENTS.md:619-621` named a private method
`capturedAnswer` that exists nowhere in the tree and said `capturedMutation`
"takes the captured count and the caller's own sentence", which the shipped
signature does not: it takes `answered: (response: QueryResult<unknown>) => void`
(`shared/operation-context.ts:2578-2582`), and both callers close over their own
`identities.length` and `changed` (`:2338-2341`, `:2429-2432`) — neither the
count nor the sentence crosses that boundary. Those three lines now read
"`capturedMutation` takes the caller's own answer as `answered` — the verb keeps
its own sentence — and states it INSIDE `settleSubmitted`'s region". No other
edit; §2 of this note keeps its account of the rejected shape, where the name
`capturedAnswer` is correct because that is what the rejected draft called it.
`grep -rn capturedAnswer src/ tests/ docs/…/u3/` now returns that one §2 line.

**Findings 2 and 3 — one file answers both.** The review showed that this note's
second-consumer claim for the INTERACTIVE arm did not discriminate (deleting the
interactive `answered(...)` call left every cited cell green), and that §7's
reason for declining a credential-free counterpart was incomplete: the two
EXISTING homes do have fixed manifest counts, but a NEW
`tests/providers/local/sqlite3-*.test.ts` is glob-registered and needs none —
U1 of this lane had already added one. Both were taken the strong way rather
than the documentary way, because the brief prefers credential-free where
honest: **`tests/providers/local/sqlite3-captured-answer-settlement.test.ts`**,
405 lines, **4 cells**, registered by glob in `provider-sqlite3` and by the
from-disk read in `coverage-drivers`. No manifest, workspace or policy edit.

| cell | what it pins |
| --- | --- |
| batch route, captured DELETE | the held listener failure and the cardinality answer compose: `AggregateError`, primary by identity with `CHANGED("deleteMany")` and `atomicity: "segment"` / `phase: "result"` / `committedSegments: 1`, listener retained with its `meta.method`, `meta.commitCertainty` and cause; exact committed state (the drifted row survives by D-65's selector, the matching row is gone) |
| batch route, captured UPDATE | the same for the other verb and its own sentence; n1 keeps `one`, n2 has `renamed`, no result published |
| batch route, control | a listener failing beside an answer that SUCCEEDED is still published ALONE — not an aggregate, no progress, the write durable |
| interactive route | a captured row that stops matching between the capture and the write is answered by the cardinality sentence, published alone (there is no hold on that arm) |

The drift is the same fact the pg cells buy with a second connection, placed at
the same position by a statement hook: `CapturingSQLite3Driver.execute` fires it
immediately before the first `UPDATE`/`DELETE` against the table — on the batch
route that is after every premise `requireCapturedSet` queued has answered
INSIDE the batch, and on the interactive route `requireCapturedSet` answers by
returning (`if (!this.usesBatch) return;`), so the capture is the only read that
precedes it. `CapturingBatchOnlyDriver` is the batch half: no interactive
transaction, an atomic native batch, and `supportsOrderedCommittedSegments`
false, so `submit` acknowledges as soon as the batch returns
(`operation-context.ts:1361`) and a listener that failed there is HELD.

**Falsified, on a backup copy in `$TMPDIR` restored by `cp` — `git checkout` was
not used and nothing was staged:**

| falsification | red | green |
| --- | --- | --- |
| **C** — the interactive `answered(...)` call deleted from `capturedMutation` | the interactive cell ALONE, and it fails by PUBLISHING two rows for a DELETE that removed one ([`receipts/12-…`](receipts/12-falsification-c-interactive-answer.log)) | the three batch cells |
| **D** — the same batch answer stated one statement AFTER `settleSubmitted` returns | the two batch composition cells ALONE, with the review's own red — `expected QueryError: Extension "failing-outcome" w… to be an instance of AggregateError` ([`receipts/13-…`](receipts/13-falsification-d-late-answer.log)) | the control and the interactive cell |

C is what the review asked for: the interactive `answered` call is now
load-bearing, and its absence is not merely unpinned but publishes rows the
write never touched. D is falsification B of §4 reproduced without credentials,
red in the same words as the base measurement of §1.

**Runs, typecheck, Biome (repair round).** One Vitest at a time.
`sqlite3-captured-answer-settlement.test.ts` **8 / 8** (4 cells × 2 projects),
exit 0 ([`receipts/11-…`](receipts/11-sqlite3-captured-answer-green.log));
falsifications C and D as above; `node scripts/run-typecheck.mjs` **0
diagnostics, exit 0**
([`receipts/15-…`](receipts/15-typecheck-repair-round.log)); Biome on the new
file, exit 0, no diagnostics
([`receipts/14-…`](receipts/14-biome-new-file.log)) — it is a NEW file, so it
was written to the formatter's own output. No other file was re-run, because no
other file is affected: nothing under `src/**` changed except guide prose. The
census is not re-run for the same reason — no sentence, class or throw site
moved.

**Unverified, this round.** The credential-free file's own limits are in §11:
one connection, so no concurrent schedule is claimed, and no hosted batch
transport is exercised by either fixture.

## 14. Commit message draft

```
fix(raptor3): a captured mutation's own answer is settled before its listener failure is released

The batch transport acknowledges BEFORE it decodes anything, so a write-outcome
listener that fails while it acknowledges is HELD until the operation's own
answer to that batch is known — `settleSubmitted` composes them, the operation's
failure primary and the listener's retained beside it. A captured mutation's
answer was not in that region: `capturedMutation` settled the DECODE and handed
the response back, and each verb compared its row count against the captured set
one statement later, after the hold had already been released. Transport success
is not result success. The closure review measured what that costs: on both
verbs the listener's failure was the whole published failure, and the registered
cardinality sentence and the `atomicity: "segment"` progress that says what
committed were lost together.

`capturedMutation` now takes the caller's own answer and states it INSIDE
`settleSubmitted`. The verb keeps its own sentence — it owes the same one to
`requireCapturedSet` — and what this owns is the position. A failing answer
therefore takes the catch that composes it with the held failure; a succeeding
one lets the held failure be published alone, exactly as before. Nothing is
replayed, nothing is retried, no accumulator or public metadata protocol is
added, and the composing sites stay four: the region grew, no fifth composition
was added. The method no longer returns its response, so the late judgement it
allowed is gone by type rather than by convention.

Witnesses: the review's two public `onWriteOutcome` probes, registered in
`tests/providers/docker/pg-captured-set-concurrency.test.ts` — the D-65
UPDATE/DELETE window with a throwing listener — asserting the composition by
identity, the cardinality sentence and its progress on the primary, the retained
listener failure through the existing error model, the exact committed state and
that nothing was re-planned; plus the control that a listener failing beside an
answer that SUCCEEDED is still published alone. 25 cells to 28, red before and
green after, and falsified by stating the same answer one statement after the
settlement returns. The same three shapes, plus the interactive arm's own
answer, are registered credential-free in the new
`tests/providers/local/sqlite3-captured-answer-settlement.test.ts` (4 cells,
glob-registered, no manifest edit), so the regression is reachable without
Docker and the interactive `answered` call is load-bearing: deleting it
publishes rows the write never touched. Engine 16,176 → 16,185 token lines;
census unchanged in every class.

Repair prompt §3.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
