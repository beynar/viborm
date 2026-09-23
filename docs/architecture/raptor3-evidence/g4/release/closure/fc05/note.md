# FC-05 — the demonstrated semantic deletions

Unit FC-05, branch `fc05` from `7c3c33a4e`, worktree `/private/tmp/viborm-fc05`.
Bounded consolidation: two audited duplications deleted at their rightful
owners, the wave-1 deletions counted once, and P1's over-strong key-list claim
corrected. No performance campaign, no public-contract change.

## Decision-elimination gate (written before the first production edit)

### (1) One write-outcome error composition

- **Required behavior.** When an operation's own failure coincides with a write
  outcome listener's failure, ONE composition answers: the operation's failure
  stays primary (`errors[0]` and `cause`), every listener failure is retained
  beside it in registration order, and the composed failure is marked as this
  operation's own answer.
- **Current owner.** `retainWriteOutcomeFailure` (`src/extensions/query.ts:859`),
  already consumed by `src/client/client.ts:1043`, `src/client/raw.ts:554,571`,
  `src/client/array-transaction.ts:387` and
  `src/query-engine/pending-operation.ts:105`.
- **The duplicate.** `OperationContext.retainOutcomeFailure`
  (`shared/operation-context.ts:2054`) restates the same rule for the candidate
  engine, at FOUR call sites (`:1384`, `:1611`, `:1640`, `:2038` — the brief says
  three; the count is corrected here).
- **Import-graph verification (the brief's condition).** `src/extensions/query.ts`
  imports `@query-engine/routed-operations` at runtime (`:2`), so the extensions
  layer already depends on the query-engine directory. An engine→extensions
  runtime import therefore closes a directory-level cycle, and measured it would
  add two files to the engine's runtime closure (181 → 183:
  `src/extensions/query.ts` and `src/query-engine/routed-operations.ts`). The
  condition fires: the ONE pure rule moves to the shared boundary instead.
- **The shared boundary.** `@errors` (`src/errors/query.ts`, published through
  `src/errors/index.ts`). Both layers already import it at runtime — it is in
  BOTH closures today — and `src/errors/**` imports nothing outside itself, so
  the move adds zero files to either closure. The precedent is
  `src/errors/record-series-progress.ts`: a pure errors-layer composition helper
  consumed by the client and by the engine.
- **Smallest change.** Move the twelve-line function verbatim into
  `src/errors/query.ts`; re-point the five existing import sites (four
  production, one test) from `@extensions/query` to `@errors`; delete
  `OperationContext.retainOutcomeFailure` and its docblock and call the shared
  owner at all four sites.
- **What disappears.** One independent rule: the engine's private restatement of
  the AggregateError composition, and the standing obligation to keep the two
  texts in step. `src/extensions/query.ts` also stops owning a rule that is not
  its own — publication stays there, composition does not.
- **Falsifier.** Change the shared owner's `cause`/order and the new pin's four
  cells go red; the existing client pins
  (`tests/contracts/public-client/query-interceptors.core.test.ts`) go red too.

### (2) One scalar scratch projection

- **Required behavior.** A value this unit PRODUCED is read back at the unit's
  boundary as `SELECT <expression> AS <field>` and decoded through that field's
  own codec, so the next unit binds it as a literal (D-58).
- **Current owner.** `Queries` — `fieldValue` (the one destination-aware operand
  owner), `scalarShape` (the memoised decode leaf) and `decodeQuery`.
- **The detour.** `OperationContext.referenceProjection` (`:1148`) builds a
  `{ field: true }` select bag, asks `prepareProjection` for a whole user
  projection, and hands it to `Queries.lowerProjectionValues` (`query.ts:4193`),
  whose only caller it is and which casts every prepared field back to the scalar
  arm it already knew it was. One caller (`carryScratch`), always one field.
- **Smallest change.** `Queries.scalarQuery(model, field, value)` composes the
  Query directly from those three existing owners — exactly the composition
  `grouped()` and `junction()` already state for every scalar they publish —
  and `carryScratch` calls it. `referenceProjection` and `lowerProjectionValues`
  are deleted.
- **What disappears.** The select bag, the prepared-projection round trip (field
  array, per-field freeze, sentinel arm, `_count`/`_distance`/relation arms none
  of which a produced scalar can reach), the `.map` over prepared fields and the
  `as Extract<…, { kind: "scalar" }>` assertion that stood in for the fact the
  caller already had.
- **Second placement.** The same three-owner composition is already placed twice
  in `Queries`: `grouped()` (`query.ts:4290`-ish) and `junction()` build
  `{ kind: "object", fields }` from `scalarShape` and alias a lowered value with
  `identifiers.aliased`. The new method is the third instance of a placed
  composition, not a new mechanism.
- **Falsifier.** Drop the alias, or the leaf, and the carry pins go red.

### (3) The wave-1 deletions, counted once

FC-01, FC-02A and FC-03's predicate and current-value deletions are counted in
§"Deletions" from their own notes. Not redone, not re-measured.

---

## The witness

`tests/raptor3/g4/parity/one-write-outcome-composition.test.ts`, 4 cells,
public client on real in-process SQLite (`better-sqlite3`), batch-only
transport, the official cache as the write-outcome listener.

| cell | what it states |
| --- | --- |
| 1 | the dispatch fails while the listener fails: the OPERATION's failure is `errors[0]` **and** `cause`, **by identity**; the listener's failure is retained beside it in its own class; one invalidation; nothing written |
| 2 | the batch acknowledges FIRST, HOLDS the listener's failure, and the operation then fails to decode the value it carries across its own boundary: same composition, primary is the malformed-scalar refusal, and the primary still carries `recordSeriesProgress { segment, result, 1, 2, 1 }`; ONE batch; the row is durable |
| 3 | a listener that fails beside an answer that SUCCEEDED is published **alone** — no aggregate whose `cause` is an operation failure that does not exist |
| 4 | the produced key is read back as ONE aliased scalar (`SELECT (CAST((SELECT "ref_value" … ) AS INTEGER)) AS "id"`, no FROM), it binds the child row as a literal, and the scratch lifetime is unchanged: write window of 7 statements, 6 naming the scratch, the read-back sixth and the cleanup seventh; the terminal read is its own window and names no scratch |

**At the base: 4 / 4 green. After: 4 / 4 green.** That is the correct result and
it is stated plainly: this unit deletes duplication, it does not change
behaviour, so a red-at-base witness would mean the deletion had moved something.
Its discrimination is shown by falsification instead — each deleted rule's NEW
owner is broken in a backup copy and the pins go red:

| falsifier | mutation | result |
| --- | --- | --- |
| **F1** | `@errors`' `retainWriteOutcomeFailure`: `[primary, ...suppressed]` → `[...suppressed, primary]`, `cause: primary` → `cause: suppressed[0]` | **5 failures / 3 distinct cells**: this pin's cells 1 and 2, and the client contract's own *"retains one or many listener failures behind the execution failure"* in each of its three projects ([`falsifier-F1-composition-order.log`](receipts/falsifier-F1-composition-order.log)) |
| **F2** | `Queries.scalarQuery`: the `identifiers.aliased(…, field)` wrapper dropped | **11 failures**, including all three D-58 cells of `transport-witnesses.test.ts` and this pin's cells 2, 3 and 4 ([`falsifier-F2-readback-alias.log`](receipts/falsifier-F2-readback-alias.log)) |
| **F3** | `Queries.scalarQuery`: `this.scalarShape(model, field)` → a hand-written nullable `string` leaf | **5 failures**: this pin's cells 2, 3 and 4 and N5's `published-key.test.ts` *"a child-held arm placed after the parent's write names the key that write published"* ([`falsifier-F3-decode-leaf.log`](receipts/falsifier-F3-decode-leaf.log)) |

Every falsification was applied to a `cp` backup and restored by `cp`; the eight
production files were `cmp`-checked against the pre-falsification copies after
each one, and after the base/after swaps used for the Biome and census
comparisons.

---

## Deletion (1) — one write-outcome error composition

**The fact.** An execution failure that coincides with write-outcome listener
failures composes into ONE `AggregateError`: the execution failure is `errors[0]`
and `cause`, the publication owner's aggregate is flattened, every listener
failure is retained in registration order, and the result is marked as this
operation's own answer.

**The owner.** `retainWriteOutcomeFailure`, moved **verbatim** (13 token lines)
from `src/extensions/query.ts:859` to `src/errors/query.ts`, published through
the existing `@errors` barrel.

**Why it moved rather than being imported where it stood.** The brief's
condition — *"the engine must not import the extensions layer if that inverts a
dependency"* — fires on a MEASUREMENT, not on a cycle. Two facts, both checked
in the tree. First: the candidate engine takes **no** `@extensions` import
anywhere today — grep over `src/query-engine/raptor3/**` returns zero import
statements (the four textual hits are this addendum and two prose references).
Second, measured: importing the publication owner would add exactly two files
to `shared/operation-context.ts`'s runtime closure, **181 → 183**
(`src/extensions/query.ts` and, through its `:2`,
`src/query-engine/routed-operations.ts`). What the move does **not** avoid is a
directory cycle: `src/query-engine/pending-operation.ts:15` already imports the
VALUE `executePreparedQuery` from `@extensions/query` and calls it at `:288`
and `:611`, so the `src/query-engine` ↔ `src/extensions` runtime cycle exists
at the base commit `7c3c33a4e`, for the shipped path — and this unit's own diff
leaves that import three lines below the `@errors` import it added.
`@errors` is the boundary both layers already import at runtime — it is in BOTH
closures today — and `src/errors/**` imports nothing outside itself, so the move
adds **zero** files to either closure. The precedent is
`src/errors/record-series-progress.ts`: a pure errors-layer composition helper
consumed by the client and the engine alike.

**The hunk.**

- `src/errors/query.ts` **+13 token lines**: the function, verbatim, with a
  docblock that names the three consumer layers and the cycle.
- `src/extensions/query.ts` **−13 token lines**: the same function. The
  publication owner keeps `publishWriteOutcomes` and
  `decomposeWriteOutcomePublicationFailure` (which needs its `publicationFailures`
  WeakMap); it stops owning a composition rule that is its callers', not its own.
- `src/query-engine/raptor3/shared/operation-context.ts`: the private
  `retainOutcomeFailure` and its docblock deleted; `retainWriteOutcomeFailure`
  imported from `@errors` and called at all four sites — `:1384` (`submit`'s
  dispatch-failure catch, with an acknowledged listener failure), `:1611` (the
  carried value's decode catch, releasing the hold), `:1640` (`settleSubmitted`)
  and `:2038` (`stateWriteOutcome`). `this.answered(…)` still wraps every one of
  them, so the answered/progress marking is untouched.
- Four import re-points, mechanical, each into an `@errors` import the file
  already had: `client/client.ts`, `client/raw.ts`, `client/array-transaction.ts`,
  `query-engine/pending-operation.ts`, plus the test that pins the rule
  (`tests/contracts/public-client/query-interceptors.core.test.ts`).

**The brief's count corrected.** The brief says three call sites; there are
**four** (`:1384`, `:1611`, `:1640`, `:2038`). All four survive: the handoff's
"do not merge the result catches" applies to the catches, not to the composition
they share, and their timings remain distinct.

**The rule deleted.** The engine's private restatement of the AggregateError
composition — and with it the standing obligation to keep two texts in step, and
the docblock paragraph that justified the restatement with a hazard C-01 had
already removed.

**Second consumer.** Five, all pre-existing: `client.ts:1043`, `raw.ts:554` and
`:571`, `array-transaction.ts:387`, `pending-operation.ts:105`. The rule was
already shared by three layers before this unit; it now has one owner instead of
one owner plus one copy.

---

## Deletion (2) — one scalar scratch projection

**The fact.** A value this unit PRODUCED is read back at the unit's boundary as
`SELECT <expression> AS <field>` and decoded through that field's own codec, so
the next unit binds it as a literal (D-58).

**The owner.** `Queries` — `fieldValue` (the one destination-aware operand
owner), `scalarShape` (the memoised decode leaf) and `decodeQuery`. The new
`Queries.scalarQuery(model, field, value)` composes them.

**The hunk.**

- `shared/query.ts`: `lowerProjectionValues` deleted (14 physical lines);
  `scalarQuery` added (14 code lines + 16 docblock lines).
- `shared/operation-context.ts`: `referenceProjection` deleted (13 physical
  lines); `carryScratch` calls `this.queries.scalarQuery(publication.model,
  publication.field, publication.expression)`; two `{@link}` references updated.

**The rule deleted.** The generic select/map/assertion detour, in all its parts:
the `Object.fromEntries(Object.keys(values).map(…))` select bag; the
`prepareProjection` round trip (its field array, its per-field freeze, its
sentinel arm and its `_count` / `_distance` / relation / variant arms, none of
which a produced scalar can reach); the `.map` over prepared fields; and the
`as Extract<PreparedProjectionField, { kind: "scalar" }>` cast that stood in for
a fact the caller already had. `sql.join` over a one-element array goes with it.

**Second placement.** The composition `scalarQuery` states is already placed
twice in `Queries`, and is unchanged by this unit: `grouped()` builds
`{ kind: "object", fields }` from `scalarShape` and aliases each lowered column
with `identifiers.aliased`, and `junction()` does the same for every junction
column it publishes. `scalarQuery` is the third instance of a placed
composition, not a new mechanism — which is why nothing was added to `Queries`
beyond one method.

**What was NOT done, deliberately.** The scratch SELECTs are not coalesced, the
result catches are not merged, logical/physical ordering is untouched, and no
adapter capability was added. Statement counts and scratch lifetime are pinned
unchanged by cell 4 and by `transport-witnesses.test.ts`.

---

## Deletion (3) — the wave-1 deletions, counted once

Read from their notes; not redone and not re-measured.

| unit | rule deleted | token lines |
| --- | --- | ---: |
| FC-01 | the operation-global `Commands.expanded` latch — the field, its set at the top of `expandSeries` and its use as a refusal reason in `depend` — with the false template justification in the docblock, the guide and `OperationContext`'s member-boundary comment | **+3** |
| FC-02A | the update path's second source of truth: the stale observed row passed beside a current address, and the `captured = where` default that papered over a missing capture | **+2** |
| FC-03 | both synthetic `{ NOT: { OR: … } }` public-selector bags (`requireNoAddedMember`, `requireCapturedSet`), the `rows.length === 0` special case they needed, and the inline `Object.fromEntries(keys.map(…))` identity rebuild with its `keys` parameter | **+23** |

The three repairs are net **+28** token lines: they added necessary
distinctions, exactly as the handoff said they might. FC-05 returns **−24**.

---

## Capability change

**None.** No public verb, argument, result shape, error class or refusal
sentence changed. No refusal was added, deleted, reworded, skipped or weakened.
No integrity or provider-result requirement was removed. The census is identical
at the base and after: **public 23 distinct sentences at 30 sites, 192 total
sites** (`receipts/census-base.md.gz`, `receipts/census-after.md.gz`). The move
of `retainWriteOutcomeFailure` is internal, and the evidence covers the **new**
location: `src/index.ts:120-148` re-exports a NAMED list from `./errors.js`
which does not contain it, `package.json`'s `exports` map has no `./errors`
subpath, and `src/drivers/exports.ts:9-19` (the `viborm/driver` entry)
re-exports a named error list that excludes it too. Had any of those three been
an `export *`, the move would have made the function public surface.

---

## Runs

One vitest at a time, in this worktree, through the bounded runner. No wide run,
no fixed lane, no `g2-baseline` / `g1-compare`.

| file | cells | result | receipt |
| --- | ---: | --- | --- |
| `tests/raptor3/g4/parity/one-write-outcome-composition.test.ts` (new) | 4 | **4 / 4** | [`run-new-pin.log`](receipts/run-new-pin.log) |
| the same file, against the BASE production tree (restored by `cp`) | 4 | **4 / 4** | [`run-new-pin-at-base.log`](receipts/run-new-pin-at-base.log) |
| `tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` + `tests/raptor3/g3/author-execution-regressions.test.ts` | 8 + 3, two projects each | **22 / 22** | [`run-composition-owners.log`](receipts/run-composition-owners.log) |
| `transport-witnesses` + `published-key` + `increment-key-width` | 7 + 12 + 1, two projects each | **40 / 40** | [`run-carry-owners.log`](receipts/run-carry-owners.log) |
| `tests/contracts/public-client/query-interceptors.core.test.ts` (the moved owner's own pins) | 43, three projects | **129 / 129** | [`run-interceptors.log`](receipts/run-interceptors.log) |
| neighbours: `g4/parity/generated-key-reach` + `contracts/engine/query/pending-operation-contracts.core` | 7 + 27 | **68 / 68** | [`run-neighbours.log`](receipts/run-neighbours.log) |
| final confirmation in the DELIVERED tree: the new pin + `uncertain-outcome-meta` + `transport-witnesses` | 4 + 8 + 7 | **34 / 34** | [`run-final-confirmation.log`](receipts/run-final-confirmation.log) |

Falsifier runs: `falsifier-F1-composition-order.log` (5 failed / 128 passed),
`falsifier-F2-readback-alias.log` (11 failed / 7 passed),
`falsifier-F3-decode-leaf.log` (5 failed / 25 passed).

**Registration (not edited — reported).** `scripts/raptor3-manifest.mjs` needs
one line beside the other `g4/parity` entries:

```
  "tests/raptor3/g4/parity/one-write-outcome-composition.test.ts": 4,
```

Until it is added the file is discovered by the `extended-local` project only,
which is where the runs above executed it.

---

## Typecheck, census, Biome, LOC

- **Typecheck.** `node scripts/run-typecheck.mjs` → **0 diagnostics, EXIT=0**,
  6.85 s wall, 5,294 MiB peak sampled RSS ([`typecheck.log`](receipts/typecheck.log)).
  Not even the two historical Pattern `TS2345` errors the common brief permits —
  that is this worktree's base behaviour, not a change of this unit.
- **Census.** `node scripts/raptor3-refusal-census.mjs`, run at the base AND
  after: byte-comparable headline, **public 23 at 30 sites, 192 total**.
- **Biome.** Per changed file, the base copy restored in place and measured with
  the same command, then the working copy: **`diff` of the two reports is
  empty** ([`biome-base.txt`](receipts/biome-base.txt),
  [`biome-after.txt`](receipts/biome-after.txt)). `operation-context.ts` keeps
  its 6 (1 organizeImports, 4 noParameterProperties, 1 `format`), `query.ts` its
  15 + 1 info (1 organizeImports, 4 useSimplifiedLogicExpression, 3
  noUnusedFunctionParameters, 1 noUnusedVariables, 4 noParameterProperties, 2
  useDefaultSwitchClause, 1 `format`), `client.ts` its 1 organizeImports; the
  other five files stay clean. Both base copies carry a `format` diagnostic, so
  the formatter was never run on them; the new test file is new and IS formatted
  (`biome format --write`) and checks clean.
- **LOC**, `node scripts/query-engine-structure.mjs`
  ([`structure-base.json`](receipts/structure-base.json),
  [`structure-after.json`](receipts/structure-after.json)):

| metric (`src/query-engine/**`) | base | after | Δ |
| --- | ---: | ---: | ---: |
| **token-bearing lines** | 16,064 | **16,040** | **−24** |
| physical lines | 20,430 | 20,417 | −13 |
| functions | 1,097 | 1,093 | −4 |
| parameters | 1,656 | 1,651 | −5 |
| branch nodes | 2,563 | 2,562 | −1 |
| files, import-cycle components | 38, 1 | 38, 1 | 0 |

  Outside the measured perimeter, token lines: `errors/query.ts` 275 → 288
  (**+13**, the moved rule), `extensions/query.ts` 778 → 765 (**−13**, the same
  rule), `client/client.ts` 1,032 → 1,030 (−2), `raw.ts` and
  `array-transaction.ts` unchanged — **net −2**.

  **Whole production: −26 token lines**, which the diff confirms exactly:
  **44 code lines added, 70 deleted (−26); 45 comment/blank added, 20 deleted
  (+25)**. Bytes **+615** across the eight files, all of it docblock prose
  (`errors/query.ts` +1,292 and `query.ts` +884 are the new docblocks;
  `operation-context.ts` −1,075 and `extensions/query.ts` −486 are the removals).
  Moved code: **13 token lines, verbatim, between two files both outside the
  engine perimeter** — it is not counted as an engine saving.

  Against the release baseline the four closure units together are
  16,036 → 16,040, **+4**.

---

## Unverified

- **Only in-process SQLite was executed** by this unit. Neither deletion has a
  provider-specific arm — the composition never touches SQL, and `scalarQuery`
  lowers through the same `fieldValue` / `identifiers.aliased` / `clauses.select`
  vocabulary every other `Queries` method uses — but no PostgreSQL, MySQL,
  PGlite or hosted run was made here. `postgres-identity-scratch.test.ts` and
  `postgres-declared-type-scratch.test.ts` exercise the same read-back on
  PGlite and were **not** run (they need the provider project; the integrator's
  frozen gate covers them).
- **No performance measurement was taken.** The detour removed per carried value
  is one `prepareProjection` call, one select bag and one array `.map`; its cost
  is not measured, and no cell is claimed to have improved. The protocol's
  committed-tree comparator is not available to a dirty worktree.
- **The `:1372` arm has no witness in this unit's set.** `submit`'s
  dispatch-failure catch composing with an ACKNOWLEDGED held listener failure —
  a batch that acknowledged a committed segment whose listener threw, and then
  failed to dispatch — is reachable only on a driver declaring
  `supportsOrderedCommittedSegments` (`src/drivers/d1/index.ts:158`), and no
  cell this unit ran uses one: the new pin's cell 1 reaches `stateWriteOutcome`
  (`:2027`) and its cell 2 the carried value's decode catch (`:1599`). The
  review round's falsification confirms the gap — deleting the composition at
  `:1372` leaves the new pin 4 / 4, `uncertain-outcome-meta` 8 / 8,
  `author-execution-regressions` 3 / 3 and `transport-witnesses` 7 / 7 green,
  while the same deletion at `settleSubmitted` (`:1628`) DOES redden
  `uncertain-outcome-meta` cell 9. That site's call-target swap is verified by
  **reading only**.
- **The `AggregateError` flattening of MANY listener failures** is pinned by the
  client contract test at unit level, not by a two-listener run through the
  public client; this unit added no second write-outcome registration.
- **The runtime-closure figures (181 → 183)** come from a task-local tracer over
  runtime imports with the repo's path aliases, deleted after use — not from a
  bundler. The single load-bearing fact behind them,
  `src/extensions/query.ts:2`'s runtime import of
  `@query-engine/routed-operations`, is readable in one line of source.
- **Doc-name drift left for FC-06, not rewritten here** (historical receipts
  stay sealed): `docs/architecture/raptor3-nesting-and-refusals-plan.md:343` and
  `docs/architecture/raptor3-evidence/post-g3-fact-ownership.md:72` still name
  `referenceProjection`. The ledger rows, `g4/d7-review-followup.md` and the
  `core-structure` patches name the old functions as the record of when they
  existed and are correct as receipts.

---

## Blockers

**None.** No public-contract change was needed, no new recovery authority, no
numerical-semantics change. No minimized failure survived two repairs: the only
two failures encountered were the new pin's own literal expectations (the cache
listener's class/message and the batch count), corrected against what the
engine actually does, and one `TS2741` on a test helper's return annotation
(`Promise<unknown>` → `PromiseLike<unknown>`, because `PendingOperation` is a
thenable and not a `Promise`).

---

## Repair round (2026-09-21) — the reviewer's five findings

All five applied as requested; none declined. Nothing but the requested text
changed: no expectation, no production statement, no import, no test.

**1 (major) — the stale import reason, in all five places.** The claim "an
engine→extensions edge would close a directory cycle" was false: the
`src/query-engine` ↔ `src/extensions` runtime cycle already exists at
`7c3c33a4e`. `src/query-engine/pending-operation.ts:15` imports the VALUE
`executePreparedQuery` from `@extensions/query` and calls it at `:288` and
`:611`, while `src/extensions/query.ts:2` imports the value `isReadOperation`
from `@query-engine/routed-operations` (used at `:646`) — and this unit's own
diff leaves that import three lines below the `@errors` import it added. The
sentence is replaced everywhere by the two facts that ARE true and measured:
the candidate engine takes no `@extensions` import at all today (grep over
`src/query-engine/raptor3/**`: four textual hits, all prose, zero import
statements), and importing the publication owner would add
`src/extensions/query.ts` and `src/query-engine/routed-operations.ts` to
`shared/operation-context.ts`'s runtime closure, **181 → 183** — with the
pre-existing edge named so no reader mistakes the placement for cycle-breaking.
Rewritten at `src/query-engine/raptor3/AGENTS.md` (the FC-05 addendum),
`src/errors/query.ts` (the moved function's docblock),
`shared/operation-context.ts` (`stateWriteOutcome`'s docblock), this note (the
"Why it moved" paragraph and the commit-message draft) and `g4.md` (the FC-05
ledger record). All five are comment/prose edits.

**2 (minor) — the `:1372` arm's missing witness.** Recorded as a new bullet in
**Unverified** above: `submit`'s dispatch-failure catch composing with an
ACKNOWLEDGED held listener failure is reachable only on a driver declaring
`supportsOrderedCommittedSegments` (`src/drivers/d1/index.ts:158`), no cell this
unit ran uses one, and that site's call-target swap is verified by reading only.

**3 (minor) — the ledger's four-site list.** `g4.md` justified "the four
composing sites stay four" with the handoff's list of result CATCHES (which
includes cardinality rejection, a site that composes nothing). Replaced with the
four sites the sentence is actually counting, the same four this note gives:
`submit`'s dispatch-failure catch, the carried value's decode catch,
`settleSubmitted` and `stateWriteOutcome`.

**4 (minor) — the capability-change evidence covered the OLD location.**
Replaced with evidence for `@errors`, verified here: `src/index.ts:120-148`
re-exports a NAMED list from `./errors.js` that excludes
`retainWriteOutcomeFailure`; `package.json`'s `exports` map has no `./errors`
subpath; `src/drivers/exports.ts:9-19` (the `viborm/driver` entry) re-exports a
named error list that excludes it too. The conclusion is unchanged — the move
adds no public surface — but it is now supported for the location it is about.

**5 (minor) — the last in-tree pointer to the old home.** Taken as the
comment-only repair rather than as another doc-drift line:
`tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts:493-494` (cell 6) now
reads ``retainWriteOutcomeFailure`` (`@errors`, `src/errors/query.ts` — FC-05
moved it out of `extensions/query.ts`). No expectation, assertion, title or
helper touched; the file's Biome diagnostics are identical to its base copy
(4 `lint/suspicious/noMisplacedAssertion` + 1 `format`, before and after).

**Re-runs (one vitest, the affected files only).**

| file | cells | result | receipt |
| --- | ---: | --- | --- |
| `tests/raptor3/g4/parity/one-write-outcome-composition.test.ts` | 4 | **4 / 4** | [`run-repair-round.log`](receipts/run-repair-round.log) |
| `tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` (the edited comment) | 8, two projects | **16 / 16** | same |
| `tests/raptor3/g3/author-execution-regressions.test.ts` | 3, two projects | **6 / 6** | same |

**26 / 26**, 5 test files, no skipped cell. Typecheck re-run once at the end of
the round: **0** ([`typecheck-repair-round.log`](receipts/typecheck-repair-round.log)).
Biome re-checked on the three files this round changed, against their base
copies: `src/errors/query.ts` errors=0 format=0; `shared/operation-context.ts`
errors=6 format=1 (1 `assist/source/organizeImports`, 4
`lint/style/noParameterProperties` — unchanged from
[`biome-after.txt`](receipts/biome-after.txt)); the test file as above. No
census re-run: no refusal or error class was touched this round. LOC unchanged
— every production edit is inside a docblock, so the token-line counts of the
LOC section stand.

`receipts/production-and-test.diff` is the FIRST round's diff and is left
sealed: it still shows the three repaired docblocks in their pre-repair wording,
which is what it is a record of. `git diff 7c3c33a4e` on the worktree is the
current text.

**Left alone deliberately (outside the requested changes), corrected after the re-check.** The four call-site line numbers quoted in this note's Deletion (1) and in the `g4.md` record (`:1384`, `:1611`, `:1640`, `:2038`) are the BASE commit's `this.retainOutcomeFailure(…)` sites (`git show 7c3c33a4e:src/query-engine/raptor3/shared/operation-context.ts`), correct as written because Deletion (1) and the record describe the pre-deletion state; `:1372`, `:1599`, `:1628` and `:2027` are the same four sites after the move and are what the Unverified bullet uses. No edit is needed in either place.

---

## Commit message draft (the integrator commits)

```
refactor(raptor3): one owner for the write-outcome composition and one for the scalar read-back (FC-05)

`OperationContext.retainOutcomeFailure` restated the exported
`retainWriteOutcomeFailure` at four sites, and `referenceProjection` prepared a
whole user projection to read one produced scalar back. Both duplications are
deleted at their rightful owners.

The composition moves to `@errors` (`src/errors/query.ts`) rather than being
imported where it stood, for a measured reason and not a cycle: the candidate
engine takes no `@extensions` import anywhere today, and importing the
publication owner would add `src/extensions/query.ts` and
`src/query-engine/routed-operations.ts` to `operation-context.ts`'s runtime
closure (181 to 183). The engine to extensions runtime edge is pre-existing --
`pending-operation.ts` already holds it for the shipped path -- so a directory
cycle is not what the move avoids.
`@errors` is the boundary all three consumer layers already import, and it
imports nothing outside itself. Thirteen token lines move verbatim; the client,
`raw`, the array transaction, `pending-operation` and the engine now reach one
function. The four composing sites stay four -- dispatch failure, the carried
value's decode failure, `settleSubmitted` and `stateWriteOutcome` have different
timing -- and `this.answered(...)` still marks each result.

`Queries.scalarQuery(model, field, value)` composes the read-back from
`fieldValue`, `scalarShape` and `decodeQuery`, which is what `grouped` and
`junction` already compose for every scalar they publish;
`Queries.lowerProjectionValues`, which existed only for the old helper, goes
with it, and so does the cast back to the scalar arm the caller already knew it
had. Statement count, scratch lifetime and batch shape are unchanged.

New pin `tests/raptor3/g4/parity/one-write-outcome-composition.test.ts` (4
cells, registration reported, the manifest not edited) states what C-01 left
unwitnessed: the operation's failure is `errors[0]` and `cause` by identity at
both timings, the listener's failure is retained beside it, a listener that
fails beside a successful answer is published alone, and the produced key is
read back as one aliased scalar that binds the child row. Green at the base and
after -- a consolidation must not move behaviour -- with three falsifications
showing it discriminates.

Engine token lines 16,064 -> 16,040 (-24), functions -4, branch nodes -1; whole
production -26 code lines and +25 comment lines. Typecheck 0, census public 23
at 30 sites unchanged, Biome unchanged per changed file. P1's claim that the
decoder no longer materialises a key list is corrected in a dated addendum to
its note; the further decoder change stays a measured-experiment candidate.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
