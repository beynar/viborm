# Independent review — G4-02 D-7 "a lone statement leaves the batch"

Reviewer: independent (did not author the unit; same reviewer as
[`g4/regression-review.md`](regression-review.md) and
[`g4/regression-review-followup.md`](regression-review-followup.md)). Brief:
[`g4/briefs/d7-lone-statement.md`](briefs/d7-lone-statement.md) with
[`briefs/common.md`](briefs/common.md) and [`briefs/review.md`](briefs/review.md).
Author note: [`g4/regression/note.md`](regression/note.md) "D-7 round"
(§D.1–D.10). Source read and run in the main tree `/Users/arnaud/code/viborm` at
`HEAD 0cc61e61` with the unit's uncommitted diff in place.

Reviewed identity — `captureRaptor3Identity` production fingerprint
**`0a0a7e9b6cc0f701aa8d2d935cc400de9a4332087371cd2de120a59191e9cdf9`**,
byte-for-byte the author's
[`receipts/d7/identity-after.json`](regression/receipts/d7/identity-after.json),
so what I ran is what the author recorded, and it is the value AFTER every
falsification was restored from a scratchpad copy (never `git checkout`). The
harness fingerprint differs (`29a03e1e…` against `3f579a1a…`) for exactly one
reason, verified by mtime: the only files under `tests/raptor3`, `scripts` or
`benchmarks` changed since the author's capture are this review's three probe
files.

| File | sha256 | matches note |
| --- | --- | --- |
| `src/query-engine/raptor3/shared/operation-context.ts` | `8689fe663ae0fd2e0296c4002c769e4ed3d44f1829523fffecf63a250254983c` | yes |
| `src/query-engine/raptor3/AGENTS.md` | `18164d0ed1ebd07132b44608c7a79fd93c42dd4450a799bd6f7dc432b961f93b` | yes |
| `src/query-engine/raptor3/route/client-route.ts` | `976bbf85f9bf8248813a56d9b101b9c5ffb03d772877b6efcbb2dd1b09527af1` | yes — untouched this round |
| `tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` | `ea5cc3b999e68086ff4bfabfae5cfc9e0516412dc0e3d4ee7834306e67d26f49` | yes |
| `tests/raptor3/g4/unit02/lone-statement-transport.test.ts` | `8b849837576e612e3906ac365f964f3f5ce89a82645d41370b0357ea3df9430d` | yes |
| `tests/raptor3/post-prep/g29-result-progress.test.ts` | `8518e40652ae696cf472bc286285a07961f6983d0343cb9ef2f4f4e0ff5a63eb` | yes |
| `tests/raptor3/post-prep/g29-result-progress-pglite.test.ts` | `085573539c581831fb3676ac7da8d2a1c64a511fc9041419a46b33834ede8312` | yes |
| `tests/raptor3/g3/generation/transport-plans.ts` | `e331824c984f9cd4b8a56399e5ff5ec4dacfbcf3aa48cf5a2f0432cae63911e1` | yes — restored after my own probe of the requested diff |

Receipts: [`g4/d7-review-receipts/`](d7-review-receipts/). Probes (31 cells in
three files, whole-estate typecheck clean, in no registered mode):

- `tests/raptor3/g4/review/regression/d7-lone-statement.review.test.ts`
  (`02f4b225…`, **12 new cells D1–D12**);
- `tests/raptor3/g4/review/regression/uncertain-outcome-neighbours.review.test.ts`
  (`fcd23eb6…`, 11 cells — **P1, P4, P5, P6 and P8 inverted** to the D-7
  expectation, each with a docblock saying so and naming the round that recorded
  the pre-D-7 measurement);
- `tests/raptor3/g4/review/regression/seam-followup.review.test.ts`
  (`aa46ff16…`, 8 cells — **S6 inverted** the same way).

Run with
`node scripts/run-vitest-safe.mjs run --config docs/architecture/raptor3-evidence/g4/d7-review-receipts/vitest.review-regression.config.ts`.
[`prior-probes-before-inversion.log`](d7-review-receipts/prior-probes-before-inversion.log)
is kept as it fell: it is the pre-inversion state of the two older files
(6 failed / 13 passed), reproducing the author's `review-probes.log` exactly and
confirming that every one of those six reds is a probe that pinned a divergence
D-7 removes.

---

## Outcome: **REVISE**

The transport rule is right, is stated once in the physical owner, is exactly the
shipped condition for every shape that can reach it, and is load-bearing: I
falsified it and watched `g2-generated` seed 2122, the four new transport rows,
`uncertain-outcome-meta` cell 1 and the G2.9 atomic-batch specimen all go red,
then restored the file byte-identically. The blocker is genuinely closed
(`g2-generated` **52/52**), the bulk verbs are covered as the review asked, the
exact failed-INSERT recovery is untouched in reach as well as in result
(`g2-mysql-contracts` 13/13 on the live container, plus the structural reason),
the frozen fast-path counts did not move, and both closure patches round-trip to
19/19 byte-identical files from the recorded base. D-7.1 is correctly raised,
correctly reasoned and pinned as measured; my P1 reproduces it independently.

One defect stops this from being an ACCEPT. The plain path composes the cache
listener's failure with the **untranslated internal** decoding error, so a root
write whose result is malformed publishes `TypeError: Invalid provider integer`
as its primary where the shipped engine publishes the registered malformed-scalar
`QueryEngineError` (finding 1, measured on both engines). That is a published
error identity, on a code path this round introduced, and the registered refusal
it breaks is the very one the G2.9 specimen exists to protect. The fix is one
expression at one site.

Everything else below is a note. Nothing I found changes committed state, an
invalidation count, a fast-path count, or the recovery scope, and no second
authority was created.

---

## Per-item status against the brief

| Brief item | Status | Evidence |
| --- | --- | --- |
| 1. The rule, once, in the physical owner; exactly the shipped condition; covers the root fold and the relation-free bulk verbs | **verified** | verified 1–4; cells 1–4 green; P4/P5/P6 inverted and green; D7 |
| 1. Frozen fast-path counts must not increase | **verified** | `g4-unit02-author` 110/110, 17 files, gate verified |
| 1. Exact failed-INSERT recovery (RF-12) keeps its contract; state what a lone INSERT does now | **verified** | verified 5; `g2-mysql-contracts` 13/13 |
| 2. G2.9 re-expressed on the transport the fold uses; shipped answer; a real series keeps its progress; counts unchanged | **verified, with note 5** | `g29-result-progress` 2/2, PGlite twin 1/1, D5, D6, row 6, `malformed-result-cuts` 1b |
| 3. Cells: positive contract, three bulk verbs, neighbour probes green; falsifier | **verified** | 7 green cells; falsification receipts |
| 4. Guide: rule + D-7 decision | **verified, with note 6** | `AGENTS.md:402-416` |
| 5. Checks, receipts, patches, identity, cost | **verified** | suites table; patch round-trip; cost; identity |
| Added item: primary-retaining wrapper (S6/S7 parity) | **partly — finding 1 and note 2** | D8 green; D9 red; D12 red |

---

## Verified (no finding)

1. **The rule is one expression in the one method that chooses the transport.**
   `shared/operation-context.ts:1069-1073` — `lone = statements.length === 1 &&
   this.attempt.pending.length === 0 && this.continuations.length === 0`, and the
   only changed condition is `if (this.usesBatch && !lone)`. There is no per-verb
   branch, no driver table, no flag: a grep of `usesBatch` over
   `src/query-engine/raptor3` shows `setMutations` is still the single site that
   chooses between `_execute` and `_executeBatch` for a set mutation, and
   `_executeBatch` appears in exactly one place in the engine (`submit()`,
   `:699`). D6 measures `batches === 0` for the folded root write on a batch-only
   driver.
2. **It is the shipped condition for every shape that can reach it.** Shipped
   excludes three things from `canExecuteDirectly`
   (`OperationExecutor.ts:240-247`): an `onUniqueConflict` write,
   `statementHasReferences`, and `stepUsesInsertIdScratch`. The candidate's
   `lone` names none of them, and each is structurally unreachable at
   `setMutations`:
   * `onUniqueConflict: "skip"` is set only when
     `skipDuplicatesStrategy === "recoverableUniqueError"`
     (`CreateManyOperation.ts:123-126`, `:173`), i.e. MySQL — and that dialect
     takes the candidate's per-row `recoverableSkip` branch
     (`operation-context.ts:1211-1214` and the per-row loop it opens), never
     `setMutations`. SQLite and
     Postgres are `"sql"`, so the leaf carries the semantics and shipped's own
     step has no effect either. **Measured**: D7 runs a one-statement
     `createMany({ skipDuplicates: true })` on a batch-only SQLite driver and
     both engines answer identically.
   * references and insert-id scratch exist only on statements `insert()` queues
     (`:1663`, `:1691`, `:1700`), and queueing makes `attempt.pending.length > 0`,
     so `lone` is already false.
   Each of the three conjuncts is separately load-bearing, and none is redundant:
   `pending.length` covers `requireAbsent`/`requirePresent` and any queued member,
   `continuations.length` covers the generated-output guard that must precede the
   mutation.
3. **The blocker is closed, with the reach the review asked for.**
   `g2-generated` is **52/52** on both profiles
   ([`g2-generated.log`](d7-review-receipts/g2-generated.log)), against 1 failed /
   51 passed in both previous rounds. My P4/P5/P6 — the three relation-free bulk
   verbs that round 1 added to the blocker's surface — now show the candidate
   answering `statementIndex: undefined` exactly as shipped does, and
   `assert.deepEqual(candidate.failure.meta, shipped.failure.meta)` passes with
   nothing excluded. P2, P3 and P9.1–P9.3 (a nested write, an array member, and a
   relation-bearing root create faulted after 1/2/3 dispatched statements) stay
   green, so multi-statement parity including the index is intact, and author
   cell 5 pins the two-statement batch keeping `statementIndex: 1`.
4. **Falsification: the rule is what produces the agreement.** Restoring the
   batch envelope for the lone statement (`&& !lone` dropped; mutation applied to
   the working file and restored from a scratchpad copy —
   `operation-context.ts` is `8689fe66…` before and after) reddens exactly what
   the note says and nothing else:
   * `g2-generated` → 1 failed / 51 passed, the single failure being seed 2122
     `sqlite-atomic-batch`
     ([`falsification-1-g2-generated.log`](d7-review-receipts/falsification-1-g2-generated.log));
   * `lone-statement-transport` rows 1–4 red, `uncertain-outcome-meta` cell 1
     red, `g29-result-progress` `sqlite-atomic-batch` red, rows 5 and 6 and cells
     2–7 green
     ([`falsification-1-author-cells.log`](d7-review-receipts/falsification-1-author-cells.log));
   * of my probes, P1/P4/P5/P6/P8 flip back and D3, D4, D6, D7, D8 flip too
     ([`falsification-1-probes.log`](d7-review-receipts/falsification-1-probes.log)).
5. **The exact failed-INSERT recovery is untouched in reach, not only in
   result.** `g2-mysql-contracts` **13/13** and `g2-mysql-baseline` **13/13** on
   the live container (port 65515). Structurally: `attempt.insertProducers` is
   written in exactly three places, all inside the record route's `insert()`
   batch branch (`:1663`, `:1691`, `:1700`), each immediately after a
   `this.queue(...)`; `submit()` drains and clears the map (`:676-677`). So a
   `setMutations` call can only see a non-empty producer map while
   `attempt.pending.length > 0`, which makes `lone` false — the author's claim is
   exact. `recoveryRejection` (`:797-806`) additionally gates on
   `this.usesBatch`, and its only consumer is the record route's `recover`
   (`commands/execution.ts:168`), which never reaches `setMutations`.
6. **The plain path mirrors `runBorrowedStatementAtomic` call for call.** I read
   `OperationExecutor.ts:1558-1645` against `dispatchSetMutations`
   (`:1102-1140`): notify `writeMayBeVisible` when the statement throws and the
   class does not prove rollback, then rethrow; decode into an outcome; notify
   `committedWriteSegment` whether or not the decode succeeded; retain the
   operation's failure if the listener throws; then throw the outcome's failure.
   Same order, same arms. The `owned` gate
   (`ownership === "standalone" && !ownRegionOpen`, `:1110`) is correct and
   load-bearing: **D11** measures a two-statement write inside the operation's own
   region and finds shipped 0 / candidate 0 invalidations, and dropping the gate
   makes the candidate 1 against shipped 0
   ([`falsification-2-owned-gate-dropped-d11.log`](d7-review-receipts/falsification-2-owned-gate-dropped-d11.log)).
   No registered suite and no author cell reaches it (note 3).
7. **The restatement of `retainWriteOutcomeFailure` is faithful and its
   justification is true.** `stateWriteOutcome` (`:1154-1174`) builds
   `AggregateError([primary, ...listenerErrors], "Query execution and
   write-outcome publication both failed.", { cause: primary })` and rethrows the
   listener's failure alone when there is no primary — character for character
   `src/extensions/query.ts:858-871` plus shipped's `throw outcomeFailure` arm.
   The import really is unavailable: `@extensions/query:2` imports
   `@query-engine/write-engine/routing`, which imports every shipped operation
   class (`routing.ts:18-…`). The candidate's own `isReadOperation` comes from
   `./schema`, not from that module.
8. **The seam's public numbers are at parity everywhere I could reach.** D1/D2
   (a root `update` matching no row, on both transports), D3 (a lone statement
   that fails after the provider ran it — shipped 1 / candidate 1), D4 (a unique
   rejection — 0 / 0), D8 (a throwing listener on the uncertain arm), D10 (a lone
   `deleteMany` matching nothing), plus the older S1–S5, S7, S8 and P7: same
   failure, same invalidation count, same committed rows on both engines.
9. **A real record series still reports.** `g3-bulk-series` 6/6,
   `g3-suppression-retry` 2/2, `g3-transaction-array` 4/4, `g2-contracts`
   216/216, author cell 2 and row 6 green, and the registered
   `g4/unit02/malformed-result-cuts.test.ts` cell 1b still pins
   `{phase:"result", committedSegments:1, committedWriteMembers:1}` for a split
   trace — so the progress half keeps a **registered** falsifiable pin after
   leaving the G2.9 specimen.
10. **The G2.9 re-expression tells the truth on both profiles.** D5 and D6 run
    the same malformed-row cut through the shipped engine and the candidate on a
    transaction-capable and on a batch-only driver: identical published failure
    and identical committed state (`[{id:1,label:"written"}]` on both). So the
    specimen's changed `sqlite-interactive` expectation (`[]` → one row) is the
    shipped answer for that request, not a weakened assertion — see note 5 for
    what it now stops covering.
11. **Registered counts and estate discipline.** `g4-unit02-author` 110/110 over
    17 files with the gate verifying each registered file's exact cell count;
    `physical-envelope` 10, `packaged-array` 5, `prepared-operation` 5 unchanged.
    `scripts/raptor3-manifest.mjs` (20:00) and
    `scripts/credential-free-test-manifest.mjs` (17:13) predate the round, so no
    manifest edit. `HEAD` is still `0cc61e61`, nothing is staged, and the only
    files under `src/` modified inside the round's window are
    `operation-context.ts` and `AGENTS.md`. The two new unit02 files are adopted
    by the `extended-local` lane (the walk excludes only
    `tests/raptor3/g4/review/` and the exact registered paths,
    `credential-free-test-manifest.mjs:244-261`) and are **green** there, so the
    author's withdrawal of the exclusion request is correct and no
    `*.red.test.ts` remains.
12. **Patches round-trip.** Both sha256s match the note
    (`57c69fd1…`, `9994a5ea…`). Reverse-applying both onto a copy of the 19
    touched files reproduces the recorded closure base exactly —
    `query.ts 5143b7b36f6711dc0605ee534b8ef28d351f278ebebbed2354e1955c22352715`,
    `operation-context.ts 8b25f6fea73cfe2a1a50ac2558aeb01c3b2bd7563217e5266a89c22ee10451b6`
    — and forward-applying reconstructs **19/19 files byte-identically**
    (7 production, 12 tests: 7 modified + 5 created, the renamed blocker file
    among the creations).
13. **Cost reproduces exactly, including token-lines.** `operation-context.ts`
    79,053 bytes / 2,127 physical / **1,849 token-lines**; core (12 files,
    `commands/` + `shared/`) 372,703 / 10,508 / **9,475**; whole
    `src/query-engine/raptor3` (15 files) 409,608 / 11,544 / **10,357** — every
    figure of §D.8, recomputed with the census's own `countTokenLines` walk
    (JSDoc and EOF excluded). The +5,071 / +105 / +53 increment follows from the
    seam round's pre-figures, which I verified last round.
14. **The requested harness diff is exact.** `g3-generated-transport-smoke` is
    red on the reviewed tree with precisely
    `Wrong transport form: g3-c08-8020-1:bulk — 'execute' !== 'batch'`; applying
    `receipts/d7/requested-harness-change-transport-plans.patch` turns it
    **1 passed (1), gate verified**
    ([`probe-harness-change-transport-smoke.log`](d7-review-receipts/probe-harness-change-transport-smoke.log)),
    and I restored `transport-plans.ts` to `e331824c…` from a scratchpad copy.
    (The patch's `+++` line omits the `b/` prefix, so `git apply -p1` needs the
    path normalised — a packaging nit, note 7.)
15. **D-7.1 is real, correctly bounded and correctly escalated.** My P1,
    rewritten to the measurement, shows shipped publishing `statementIndex: 0`
    for a root `update` rejected before dispatch and the candidate publishing
    none, with every other field equal. The stated cause checks out:
    `packagedPresence` emits a guard STATEMENT only for
    `ownership === "batch-preparation"` (`:859`), so a standalone root
    `update`/`delete` is one statement with the `published` postcondition, while
    the shipped fold batches `[presence guard, mutation … RETURNING]`. None of
    the three remedies the note lists is inside this brief.
16. **§7 gate, against this diff.** No second public-syntax walker, per-verb
    codec, duplicated result-shape preparation, recreated lifecycle, projection
    rebuilt for a decoder, JavaScript arithmetic beside SQL, defensive
    re-validation, policy-boolean bag, per-feature interpreter, fixture-named
    flag, legacy import, fallback, cached absence, or public-contract change.
    The one deliberate restatement (`stateWriteOutcome`) is justified above and
    is used at all four call sites. `failure()` is untouched;
    `mayHaveCommittedSegment` and `committedSegments` are still written in
    exactly one place each.

---

## Findings

### 1. must-fix — the plain path publishes the UNTRANSLATED decoding failure when a cache listener throws

* **Where:** `src/query-engine/raptor3/shared/operation-context.ts:1125-1136`
  (`dispatchSetMutations`: `decoded = { failure: error }` at `:1129`, then
  `stateWriteOutcome(this.writeOutcome?.committedSegment, decoded.failure)` at
  `:1131-1135` and `throw decoded.failure` at `:1136`).
* **Probe:** `tests/raptor3/g4/review/regression/d7-lone-statement.review.test.ts`
  cell **D9**, receipt
  [`probes-d9-d12-detail.log`](d7-review-receipts/probes-d9-d12-detail.log).
* **Measured** — a root `create` under `cache: { autoInvalidate: true }` on a
  batch-only driver, provider returns a malformed `id`, cache driver's `clear`
  throws:

  | route | published failure | invalidations | rows |
  | --- | --- | --- | --- |
  | shipped | `AggregateError("Query execution and write-outcome publication both failed.")`, `errors[0]` / `cause` = **`QueryEngineError` V9001** `{driver, operation, scalarType}` | 1 | seed + written |
  | candidate | the same `AggregateError`, `errors[0]` / `cause` = **`TypeError: "Invalid provider integer"`** | 1 | seed + written |

* **Why it happens:** `InvalidScalarResult` is an internal validation object that
  this engine translates in exactly two places — `failure()` (`:373-380`) and
  `run()`'s catch (`:508-518`). The plain path hands the raw object to
  `stateWriteOutcome` as `primary` and, when the listener throws, the resulting
  `AggregateError` is not an `InvalidScalarResult`, so `run()`'s catch no longer
  recognises it and no translation ever happens. The count, the composition, the
  message, the committed state and the invalidation are all correct; only the
  identity of the primary is wrong.
* **Why must-fix and not a nit:** the malformed-scalar refusal is a registered
  refusal (G2.9) and "refusals are contracts". This publishes an internal class
  with an internal sentence to the caller. The §D.2 claim that the wrapper
  "keeps the OPERATION's own failure primary" is true of the object it holds but
  not of the failure the operation would have published. The path is new in this
  round: under the falsification the same request answers
  `CacheConfigurationError` alone — different, also divergent, but never an
  untranslated internal error.
* **Resolution:** translate once before composing and throwing, e.g.
  `const failure = this.failure(error, "result")` where `decoded` is built, then
  use it for both `stateWriteOutcome`'s `primary` and the throw. On this path
  `failure()` is a pure translation (`usesBatch && (prefix || committedSegments
  > 0 || …)` is false, so it attaches no progress — D5/D6 stay green), and
  `run()`'s catch then simply passes the already-public error through. Add the
  missing cell: `uncertain-outcome-meta` has cell 5 (malformed result, listener
  fine) and cell 6 (listener throws, uncertain arm) but no cell for the two
  together; D9 is that cell.

### 2. note (measured; pre-existing, untouched by this round) — the batch transport's committed arm still lets the listener's failure replace the operation's

* **Where:** `shared/operation-context.ts:691-696` (`acknowledged()` calls
  `stateWriteOutcome(this.writeOutcome?.committedSegment)` with **no** primary,
  because at that moment the operation has not failed) together with
  `:1073-1084` (the batch arm parses **after** `submit()` returns, so the decode
  failure and the listener failure are never in scope together).
* **Probe:** cell **D12** — the two-statement form of D9's request.
* **Measured:** shipped publishes
  `AggregateError([QueryEngineError V9001, CacheConfigurationError])`; the
  candidate publishes `CacheConfigurationError` alone (carrying, correctly, the
  committed-window `recordSeriesProgress`). Invalidation count and committed rows
  are equal.
* **Why only a note:** this arm is byte-identical to the pre-D-7 tree — the
  round neither created nor widened it, and the same shape answered the same way
  before. But it bounds the round's claim: the wrapper is at all four call sites,
  yet the *property* "the operation's own failure stays primary when a listener
  throws" holds on three of the four situations, not four. §D.2, §D.9 answer 3
  and `AGENTS.md:432-437` all state it without that bound.
* **Resolution:** either fix it with finding 1 (the batch arm would have to hold
  the decode failure while it acknowledges, which is what shipped's
  `runAtomicBatch` does) or record it as a named candidate divergence in the
  freeze, with D12 as the pin.

### 3. note — the `owned` gate has no cell; D11 is its falsifier

Dropping `ownership === "standalone" && !this.ownRegionOpen` (`:1110`) leaves
`g4-route-cache` 7/7, `g4-route-transactions` 13/13 and `g4-unit02-author`
110/110 all green
([`falsification-2-*.log`](d7-review-receipts/falsification-2-g4-route-cache.log)),
so nothing registered notices a `committedSegment` announced from inside an open
transaction that then rolls back. My **D11** does (candidate 1 against shipped 0
with the gate dropped, 0/0 with it). §D.10's unverified list mentions the
transaction-capable *failure* half; it does not mention the own-region case.
Adopt D11, or an equivalent author cell, so the gate is falsifiable by colour.

### 4. note (statement) — "the shipped condition, taken exactly" is true by reachability, not by spelling

`lone` does not name shipped's three exclusions
(`onUniqueConflict`, `statementHasReferences`, `stepUsesInsertIdScratch`). I
verified all three are unreachable at `setMutations` (verified 2) and measured
the only one that is dialect-dependent (D7), so the rule is exact **for this
engine's plan shapes** — but that is a property of where producers, scratch and
the recoverable-skip route live, not of the condition itself. §D.1 and §D.9
would be accurate with one sentence saying so, and it is the sentence a future
reader needs if a set-oriented statement ever gains a conflict clause on a
`"sql"` dialect outside `createMany`.

### 5. note — the G2.9 sqlite specimen no longer covers the rolled-back form of its own cut

Before this round the `sqlite-interactive` profile asserted `finalDatabase ===
[]`: the `^SELECT` cut fell on a statement inside a transaction, and the
specimen witnessed "a malformed result rolls the write back". After the
re-expression both profiles are statement-atomic and both assert one committed
row. D5 confirms the new expectation is the shipped answer, so nothing untruthful
is pinned — but the property that moved is covered now only by
`g4/unit02/malformed-result-cuts.test.ts` cell 1 (the split trace on a provider
without RETURNING). §D.3's table records what the cut measures, not what the
specimen stopped measuring; one line naming cell 1 as the rolled-back form's home
would close it, next to the line that already names row 6 as the progress half's.

### 6. note (statement) — the guide still calls the committed-window progress "the G2.9 atomic-batch pin"

`src/query-engine/raptor3/AGENTS.md:425-426` says a committed window "still
reports, which is the G2.9 atomic-batch pin" — but after this round the G2.9
atomic-batch cell publishes **no** progress; the pin is
`malformed-result-cuts.test.ts` cell 1b (registered) and
`lone-statement-transport.test.ts` row 6. Same sentence, wrong witness. (Also
cosmetic: the paragraph's last edit leaves one 102-character line at `:436`,
one of only two lines over 84 characters in the whole file.)

### 7. note (packaging) — the requested harness patch needs a path fixup to apply

`receipts/d7/requested-harness-change-transport-plans.patch` has `--- a/tests/…`
but `+++ tests/…` (no `b/`), so `git apply` fails with
`error: raptor3/g3/generation/transport-plans.ts: No such file or directory`. It
applies cleanly after `sed 's|^+++ tests/|+++ b/tests/|'`, and with it the mode
is green (verified 14). Worth regenerating with `git diff` so the integrator can
apply it directly.

### 8. note (integration) — counts to register

`tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` = **7** cells (was 4)
and `tests/raptor3/g4/unit02/lone-statement-transport.test.ts` = **7** cells,
both green and both currently unregistered (measured together: 14 passed / 14).
`g29-result-progress` stays at **2** and the PGlite twin at **1**, as the note
says; the manifest is untouched. If my probes are kept, the three files under
`tests/raptor3/g4/review/regression/` hold **31** cells (11 + 8 + 12), of which
29 are green and 2 (D9, D12) are the findings above.

---

## Suites re-run (bounded runner, serial, one mode per invocation, after the last edit)

| Mode / file | Result | Wall / peak RSS | Receipt |
| --- | --- | --- | --- |
| `g2-generated` | **52 passed (52)** — D-7 closed | 4.98 s / 780.3 MiB | [`g2-generated.log`](d7-review-receipts/g2-generated.log) |
| `g29-result-progress` | 2 passed (2), gate verified | 4.01 s / 545.5 MiB | [`g29-result-progress.log`](d7-review-receipts/g29-result-progress.log) |
| G2.9 PGlite twin | 1 passed (1) | 5.14 s / 1,563.8 MiB (over the 1,536 MiB ordinary ceiling, as in the author's run) | [`g29-pglite.log`](d7-review-receipts/g29-pglite.log) |
| `g4-unit02-author` | 110 passed (110), 17 files | 5.74 s / 776.4 MiB | [`g4-unit02-author.log`](d7-review-receipts/g4-unit02-author.log) |
| `g4-route-cache` | 7 passed (7) | 3.99 s / 535.2 MiB | [`g4-route-cache.log`](d7-review-receipts/g4-route-cache.log) |
| `g4-route-transactions` | 13 passed (13) | 4.27 s / 532.5 MiB | [`g4-route-transactions.log`](d7-review-receipts/g4-route-transactions.log) |
| `g3-transaction-array` | 4 passed (4) | 4.78 s / 525.2 MiB | [`g3-transaction-array.log`](d7-review-receipts/g3-transaction-array.log) |
| `g3-suppression-retry` | 2 passed (2) | 4.11 s / 508.5 MiB | [`g3-suppression-retry.log`](d7-review-receipts/g3-suppression-retry.log) |
| `g3-bulk-series` | 6 passed (6) | 4.12 s / 542.1 MiB | [`g3-bulk-series.log`](d7-review-receipts/g3-bulk-series.log) |
| `g2-contracts` | 216 passed (216), 16 files | 7.07 s / 815.8 MiB | [`g2-contracts.log`](d7-review-receipts/g2-contracts.log) |
| `g1-transport` | 44 passed (44) | 4.50 s / 728.4 MiB | [`g1-transport.log`](d7-review-receipts/g1-transport.log) |
| `g2-transport` | 16 passed (16) | 4.61 s / 720.0 MiB | [`g2-transport.log`](d7-review-receipts/g2-transport.log) |
| `g3-generated-transport-smoke` | **1 failed (1)** — the harness plan's transport expectation only (§D.7), not a candidate answer | 3.98 s / 540.7 MiB | [`g3-generated-transport-smoke.log`](d7-review-receipts/g3-generated-transport-smoke.log) |
| `g2-mysql-contracts` (port 65515) | **13 passed (13)**, 4 files — RF-12 holds | 4.98 s / 681.5 MiB | [`g2-mysql-contracts.log`](d7-review-receipts/g2-mysql-contracts.log) |
| `g2-mysql-baseline` (port 65515) | 13 passed (13), 4 files | 4.40 s / 661.7 MiB | [`g2-mysql-baseline.log`](d7-review-receipts/g2-mysql-baseline.log) |
| `g2-pg-contracts` (port 65504) | 18 passed (18), 6 files | 5.55 s / 694.8 MiB | [`g2-pg-contracts.log`](d7-review-receipts/g2-pg-contracts.log) |
| author cells (2 unregistered files) | 14 passed (14) | 4.31 s / 576.2 MiB | [`author-cells.log`](d7-review-receipts/author-cells.log) |
| review probes (31 cells, unregistered) | **29 passed / 2 failed** — D9 (finding 1) and D12 (note 2) | 3.16 s / 625.4 MiB | [`probes-final.log`](d7-review-receipts/probes-final.log) |
| whole-estate typecheck (with probes) | only the two permitted `pattern/pack.ts` TS2345 (`:1443`, `:2633`) | 8.58 s / 6,004.5 MiB | [`typecheck.log`](d7-review-receipts/typecheck.log) |

Provider ports confirmed this round: `docker port viborm-raptor3-g3-mysql-20260914
3306` → `127.0.0.1:65515`, `docker port viborm-raptor3-g3-pg-20260914 5432` →
`127.0.0.1:65504` — the author's values.

Falsification receipts (each mutation restored from a scratchpad copy; the file's
sha256 is `8689fe66…` before and after every one):
[`falsification-1-g2-generated.log`](d7-review-receipts/falsification-1-g2-generated.log),
[`falsification-1-author-cells.log`](d7-review-receipts/falsification-1-author-cells.log),
[`falsification-1-probes.log`](d7-review-receipts/falsification-1-probes.log),
[`falsification-2-owned-gate-dropped-probes.log`](d7-review-receipts/falsification-2-owned-gate-dropped-probes.log),
[`falsification-2-owned-gate-dropped-d11.log`](d7-review-receipts/falsification-2-owned-gate-dropped-d11.log),
[`falsification-2-g4-route-cache.log`](d7-review-receipts/falsification-2-g4-route-cache.log),
[`falsification-2-g4-route-transactions.log`](d7-review-receipts/falsification-2-g4-route-transactions.log).

## Unverified author claims

1. **Discharged by this review:** the transport rule's exactness against
   shipped's three exclusions (verified 2 + D7); the failed-INSERT recovery's
   reach (verified 5); the plain path's cache notification on a
   transaction-capable driver's **failure** half (D3 measures the batch-only
   half, D2 the not-found half on a transaction-capable driver, and D5 the
   committed half there); the requested harness diff (verified 14); the
   committed-state claim of the re-expressed `sqlite-interactive` specimen (D5).
2. **Still unverified, correctly labelled:** every generated seed beyond
   `g2-generated`'s 52 (the G3/G4 campaigns are forbidden during unit work); the
   ordered-commit D1 driver, where `acknowledged()` runs inside the driver's own
   callback and a throwing listener would propagate mid-batch (not reachable in
   the credential-free estate); whether any shape other than root
   `update`/`delete` loses an index shipped keeps — I added the three bulk verbs,
   `upsert`, a nested write, an array member and a three-depth relation-bearing
   create to the measured set and found none.
3. **Newly labelled by this review:** a write inside the operation's OWN region
   still notifies nothing where shipped's `runTransactionScope` notifies by
   transaction phase. §D.10 records the gap; D11 now measures that both engines
   publish **zero** invalidations for the rollback case, so the gap is not
   observable on that shape — the phase notifications on a *successful* own-region
   write remain unmeasured.
4. **Unchanged from the followup review:** the candidate's uncertain-outcome
   class test excludes only `UniqueConstraintError` where shipped also excludes
   `SkippedRecordSeriesMember` and `isRetryableRace`
   (`OperationExecutor.ts:1029-1053`). This round restates that same narrower
   sentence at a second site (`:1121`), mirroring shipped's own duplication
   across `runAtomicBatch` and `runBorrowedStatementAtomic`. S8 and D4 are the
   only shapes of the difference measured, and neither diverges.
