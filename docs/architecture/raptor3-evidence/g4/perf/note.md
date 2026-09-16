# G4 performance pass — the safe fixes (G4-02 author)

Brief: [`../briefs/perf-safe-fixes.md`](../briefs/perf-safe-fixes.md) (Arnaud,
10:10 2026-09-16). Base: the committed G4 tree `0f25637b`. Scope: **no
behaviour change, no prepared-shape cache**; the seven items in the brief's
order, each with its falsifier measured.

Diagnosis this pass applies: [`../cutover/perf-diagnosis.md`](../cutover/perf-diagnosis.md)
(causes 1a, 1b, 2's `EngineSchema.scalars` site, 3's Change A) and
[`../cutover/relation-series-2-classification.md`](../cutover/relation-series-2-classification.md)
(D-8).

**Headline.** The candidate's preparation regression is largely gone and its
nested-write wall regression has become an improvement, with no observable
change anywhere: `scalar-find-unique/prepare` **2.02× → 1.37×** CPU,
`fixed-collection-rowref-20/prepare` **1.78× → 1.27×**,
`bulk-update-returning-100/prepare` **1.76× → 1.27×**,
`nested-conditional-found/full` wall **1.00× → 0.80×** — while the shipped side
moves by −0.34…+0.24 µs/op on the three preparation cells. None of this closes
the §7 5 % budget on the preparation cells; the formal verdict is the frozen
20-cell series, not these numbers.

---

## 0. Decision-elimination gate (written before the first production edit)

Plan §7 asks four questions of the diff; §8 answers them against the actual
diff. This section states, per item, the required behavior, the current owner,
the smallest change, and the decisions that disappear.

### Item 1 — lazy control-flow sentinels

- **Required behavior.** Two per-operation control-flow values, compared only by
  identity, that mean "this preparation cannot be completed statically"
  (`incompletePreparation`) and "this operation needs its physical envelope"
  (`requiresEnvelope`). Neither is ever surfaced to a caller.
- **Current owner.** `shared/operation-context.ts:158-160` and `:183-185`, two
  `readonly` class fields initialised with `new Error(...)` in the field block
  that runs on **every** `new OperationContext(...)` — one per read, one per
  write, prepared or executed (`commands/index.ts:180`, `:192`).
- **Smallest change.** Keep the two values, their classes, their messages and
  their identity semantics **exactly**; build each on first use. Two
  `undefined`-initialised private fields plus two private getters that
  materialise once (`??=`). Every use site keeps its byte-identical spelling
  (`throw this.incompletePreparation`, `error !== this.requiresEnvelope`).
- **Why lazy `Error` and not a branded stack-less object.** The brief allows
  either and asks for the `catch` survey first. The survey (§1.2) finds one
  path — `execution.ts:382`, a batch-preparation `flush` failure attributed
  with phase `"prefix"` — where the sentinel reaches
  `attachRecordSeriesProgress` (`src/errors/record-series-progress.ts:26-28`),
  which wraps a non-`VibORMError` and attaches the original **only when it is
  an `Error`** (`error instanceof Error ? { cause: error } : undefined`). A
  branded object would silently drop that `cause`; a lazy `Error` cannot. The
  measured gain is the same one the diagnosis's own rebuilt instrument
  produced, because that instrument was lazy getters (§4.1 "Independent
  confirmation from source").
- **Decisions that disappear.** The per-operation question "has this operation
  already paid for its two failure objects?" disappears: there is nothing to
  pay until a sentinel is actually raised. **Mechanism:** field initialiser →
  first-use getter. **Consumers:** the five `throw` sites and the two identity
  comparisons, unchanged. **Replacing invariant:** the sentinel is materialised
  by the getter before any comparison or throw can observe it, so identity is
  established at the first use in every order. **Falsifier (round 2):**
  `tests/raptor3/g4/unit02/prepared-operation.test.ts` cell 6 — `prepareBatch`
  answers `undefined` for an unpackageable operation, four times, interleaved
  with a packageable read; a getter that dropped the memo makes it red and is
  invisible to every other registered suite (§12.2). The A/B on
  `scalar-find-unique/prepare` falling by 8–11 µs CPU/op while the shipped side
  stays inside its own spread, with `g4-unit02-author`, `g4-route-*` and
  `g2-contracts` byte-identical, measures the COST claim — the round-1 reviewer
  correctly refused it as a falsifier for the identity invariant.

### Item 2 — plan-time `NestedWriteError`s become thunks

- **Required behavior.** Seven nested-write failures whose SENTENCE is fixed at
  construction time but which are raised only where a lookup finds nothing, a
  retained row is gone, a membership requirement fails, or an absence
  requirement is violated.
- **Current owner.** `commands/relation-body.ts:218`, `:451`, `:460`, `:479`,
  `:561`, `:639`, `:678`, carried by `Selection.required` /
  `Selection.retained` (`commands/selection.ts`),
  `MembershipRequirement.failure` and `AbsenceRequirement.failure`
  (`commands/commands.ts:78-82`, `:90-95`). Each runs the whole `VibORMError`
  constructor (two stack captures, two metadata sanitisations) at PLAN time.
- **Smallest change.** The four carriers hold `DeferredFailure = () => Error`
  instead of `Error`; the seven constructors move inside a thunk, unchanged;
  each consumer calls the thunk at the one place it raises or attributes the
  value. No message, no class, no `meta`, no relation name changes.
- **Decisions that disappear.** "Which failure object does this plan own?"
  becomes "which failure does this plan know how to build?" — the plan no
  longer owns error objects at all, so there is no plan-time cost, no plan-time
  stack, and no question about whether a plan's unraised failure is a live
  object. **Mechanism:** eager value → deferred construction at the raise site.
  **Consumers:** `execution.ts` (four sites), `relation-body.ts:609`,
  `commands.ts` (`lookup`, `capture`, two root `NotFoundError` sites).
  **Replacing invariant:** the sentence is a pure function of construction-time
  facts, so building it at the raise site produces a byte-identical error.
  **Falsifier:** the estate's nested-write cells and `g2-contracts` /
  `g2-generated` must keep every refusal sentence, class and `meta` identical;
  a deliberate one-word mutation of one thunk must turn a cell red (§2.3).

### Item 3 — statement-scoped SQL aliases

- **Required behavior.** Table aliases unique within the statement being built,
  and the SAME logical query must emit the SAME text every time.
- **Current owner.** `shared/query.ts:479-486`, one counter per `Queries`
  instance. `OperationContext` builds a fresh `Queries` per operation, so write
  statements already restart at `q0`; the READ owner in `commands/index.ts:127`
  is engine-lifetime ("One engine-lifetime query owner for the prepared read"),
  so the prepared read's text drifts `q0, q1, … q10000`
  (`../cutover/protocol.md` §7.2, `receipts-stage2/prepared-sql-alias-drift.json`).
- **Smallest change.** One owner, `Queries.rootAlias`, called by the six
  methods that assemble a COMPLETE statement (`select`, `aggregated`,
  `grouped`, `selectSeries`, `recursive`, `junction`) as the first alias of
  that statement. `lower…` fragments keep sharing the statement's counter,
  because a mutation statement is assembled from several of them in
  `OperationContext` and two fragments of ONE statement must not both start at
  `q0`.
- **Decisions that disappear.** "Which operation minted this alias?" disappears
  — an alias is a fact of its statement, not of the engine's history — and with
  it the protocol's obstacle for `verifyCrossStageSemantics`. **Mechanism:**
  instance-lifetime counter → statement-lifetime counter. **Consumers:** every
  alias minter; the two `alias()` calls in `operation-context.ts:1998-1999`
  stay outside any scope and keep continuing the operation's counter, which is
  what their single statement needs. **Replacing invariant:** within one
  statement build the counter only increases, because a nested build is a
  subquery and mints a plain `alias()`. **Falsifier:** two successive identical
  `findUnique` calls on one client publish byte-identical `prepareBatch()` SQL,
  pinned in the estate; reverting the scope must turn that pin red.

### Item 4 — allocation trim with no behaviour change

- **Required behavior.** `EngineSchema.scalars(model, admitted)` answers the
  admitted payload's scalar fields, in the model's own scalar order.
- **Current owner.** `shared/schema.ts:518-524`,
  `Object.fromEntries(names.filter(…).map(…))` — three intermediates per call.
- **Smallest change.** One loop into one object. The per-model memo the brief
  names is already upstream: `model["~"].scalarFieldNames` is memoised on the
  model itself (`src/schema/model/model.ts:568-569`, `_scalarFieldNames ??=`),
  so nothing here is recomputed per call except the three intermediates.
- **Decisions that disappear.** None semantically; this is a pure reuse. The
  key order, the prototype and the value identity are unchanged.
  **Falsifier:** an isolated before/after of the two implementations on the
  same input, byte-equal output; and the estate unchanged.

### Item 5 — R-D3 class (decided: `UnsupportedOperationError`, V8003)

- **Required behavior.** The batch-only expression publication of a non-`int`
  field is a registered identity naming the model, the field and the operation,
  raised before any statement of that update is dispatched (private guide, the
  R-D3 sentence).
- **Current owner.** `shared/operation-context.ts:1835`, `new QueryEngineError`
  (V9001 INTERNAL_ERROR).
- **Smallest change.** One class name. `UnsupportedOperationError extends
  QueryEngineError` (`src/errors/query.ts:401-419`) and carries `meta` the same
  way, so the message, the `meta` and every `instanceof QueryEngineError` check
  are unchanged; only `code` (V8003) and `constructor.name` move.
- **Decisions that disappear.** "Is this refusal a crash or a boundary?" — a
  consumer can now tell, by class, without reading the sentence.
  **Falsifier:** the two pins naming the class.

### Item 6 — D-8 in the benchmark contract (benchmark files only)

- **Required behavior.** `relation-series-2` must assert the engine-independent
  facts on both engines and pin each engine's own default ledger, instead of
  one ledger carrying the shipped count (plan §2.3 forbids the latter).
- **Current owner.** `benchmarks/operation-pipeline-contract-workloads.mjs:216-278`.
- **Smallest change.** Two recorded ledgers keyed by their own per-member
  admission count, with everything else derived from the selected row; the
  hard-coded `defaults.length === 1` / `=== 5` cuts become the engine-neutral
  cut (`=== 1`) and the engine's own constant (`1 + n × admissionsPerMember`).
- **Decisions that disappear.** "Which engine's ledger is the contract?" — both
  are, separately, and a third answer is refused. **Falsifier:** the shipped
  arm and the candidate arm both run green against the same bytes; the OLD
  contract fails on the candidate; a mutated ledger row is refused.

### Item 7 — D-7.1 (decided: accept)

No code. One sentence in the private guide's envelope paragraph and one row
here; `lone-statement-transport.test.ts` row 7 stays as the recorded
difference.

---

## 1. Item 1 — lazy control-flow sentinels

### 1.1 The change

`src/query-engine/raptor3/shared/operation-context.ts`. Two `readonly` fields
became two `undefined` fields plus two private getters:

```ts
private incompletePreparationSentinel?: Error;
private get incompletePreparation(): Error {
  return (this.incompletePreparationSentinel ??= new Error(
    "Raptor 3 operation requires dynamic execution"
  ));
}
```

and the same shape for `requiresEnvelope`. **Every use site is unchanged, to
the character** — `throw this.incompletePreparation` at `:579`, `:682`,
`:1318`, `:1600`, `throw this.requiresEnvelope` at `:554`,
`error !== this.requiresEnvelope` at `:525`, `error === this.incompletePreparation`
at `:1064`.

### 1.2 The invariant, and the `catch` survey the brief asked for

The invariant: **a sentinel is materialised by its getter before any comparison
or throw can observe it**, so identity holds in every order — the throw site
reads the getter, and so does the comparison; there is no window in which one
side sees a different object.

Every `catch` on the two sentinels' paths, read before choosing the
representation:

| Catch | Sees a sentinel? | What it does with a non-`VibORMError` |
| --- | --- | --- |
| `operation-context.ts:305` `prepareMembers` (`phase: "planning"`) | yes, in batch preparation | `failure()` returns it unchanged (`usesBatch` is true but `committedSegments === 0`, `mayHaveCommittedSegment` unset and the phase is not `"prefix"`) |
| `:320` `executeMember` (`"member"`) | yes | same — unchanged |
| `:524` `run`'s deferred arm | `requiresEnvelope` by identity | compares and rethrows |
| `:529` `run`'s outer arm | yes | `instanceof InvalidScalarResult` is false; `usesBatch` is false on every path that can raise `requiresEnvelope` (a region exists only when `!usesBatch`), so it rethrows |
| `:735` `submit` | no — `dispatch` cannot raise `requiresEnvelope` on the batch route (`region()` returns `undefined` when `usesBatch`, so `envelope` never becomes `deferred`) | — |
| `:1191`, `:1202` `dispatchSetMutations` | no — the envelope check runs in `dispatch`, outside both `try`s | — |
| `execution.ts:215` `recover` | yes | `recoveryRejection` answers `undefined` unless `usesBatch`; `conditionalSkips.get(error)` is a `WeakMap` read (undefined, never throws); `instanceof UniqueConstraintError` false → rethrown |
| `execution.ts:382` `choose`'s prefix flush (`phase: "prefix"`) | **yes, in batch preparation** | `failure()` DOES reach `attachRecordSeriesProgress`, which wraps a non-`VibORMError` in a `QueryEngineError` and attaches the original as `cause` **only if it is an `Error`** |
| `execution.ts:388` `choose`'s capture (`"capture"`) | yes | unchanged (`usesBatch` false on that path, or the phase is not progress-bearing) |
| `execution.ts:744` `executeSeries` (`"planning"`) | yes | unchanged |
| `commands/index.ts:203` `prepareBatch` | yes, the sentinel's one reader | `isIncompletePreparation` → `undefined` |
| `route/client-route.ts:236`, `:249` | no (cache-codec composition) | — |

The one row in bold is why this pass chose the **lazy `Error`** over a branded
stack-less object: on that path a branded object would lose the `cause` link
the current behaviour attaches. That path already loses the sentinel's identity
today (it is wrapped either way), so nothing else about it changes.

### 1.3 Falsifier — measured

`scalar-find-unique/prepare`, candidate: **25.59 → 16.93 µs CPU/op (−8.66)**,
inside the diagnosis's predicted 8–11 µs band; shipped **12.70 → 12.36
(−0.34)**, i.e. unmoved. Full table in §7. The estate is byte-identical:
`g4-unit02-author` 127/127, `g4-route-lifecycle` 8/8, `g4-route-admission` 7/7,
`g4-route-cache` 7/7, `g4-route-transactions` 13/13, `g2-contracts` 216/216.

**The invariant's own falsifier is the registered cell** added in round 2
(`prepared-operation.test.ts`, cell 6). Dropping the `??=` leaves every suite
named above green — measured by the round-1 reviewer (perf-review finding 2) —
and turns that one cell red, measured here (§12.2). The numbers above measure
the cost, not the identity.

A second, cheaper falsifier is recorded in the A/B itself: the instrument counts
`Error.captureStackTrace` calls inside the measured loop. On
`nested-conditional-found/full` it falls from **1.000 to 0.000 per operation**,
which is item 2's plan-time `NestedWriteError` disappearing (the two sentinels
capture implicitly, inside `new Error`, and are not counted there).

## 2. Item 2 — plan-time failures become thunks

### 2.1 The change

A named carrier type in `commands/selection.ts`:

```ts
export type DeferredFailure = () => Error;
```

`Selection.required`, `Selection.retained`, `MembershipRequirement.failure` and
`AbsenceRequirement.failure` hold it; `Commands.lookup`'s third parameter takes
it. The seven `relation-body.ts` constructors moved inside `() => …` with
their message expressions untouched, and the consumers call the thunk exactly
where the value was used before:

| Consumer | Before | After |
| --- | --- | --- |
| `execution.ts:242` lookup found nothing | `throw selection.required` | `throw selection.required()` |
| `execution.ts:248` retained row, batch route | `requirePresent(…, selection.retained)` | `requirePresent(…, selection.retained())` |
| `execution.ts:276-281` located-row presence guard | `command.requirement?.failure ?? command.located.required ?? new NotFoundError(…)` | the same choice, then one call: `missingRow ? missingRow() : new NotFoundError(…)` |
| `execution.ts:357` absence requirement | `requireAbsent(…, command.failure)` | `requireAbsent(…, command.failure())` |
| `execution.ts:427` found-arm membership | `throw requirement.failure` | `throw requirement.failure()` |
| `execution.ts:716` series member requirement | `failure: selection.required!` | unchanged — the thunk travels |
| `relation-body.ts:609` | `lookup.retained ??= lookup.required` | unchanged — both are thunks |

Two root `NotFoundError`s in `commands.ts` (`:1259`, `:1288`) and the two
`core-structure` structural specimens became thunks for the same carrier; see
§9 for the cross-stream note.

### 2.2 The invariant

Each sentence is a pure function of construction-time facts — the verb and the
relation name, both captured by the closure — so building it at the raise site
produces a byte-identical error, with the same class, the same `relation` meta
and the same code. Nothing consumes a plan-time failure OBJECT (no identity
comparison, no `WeakMap` key, no marking); every consumer either throws it or
hands it to an assertion that raises it later.

### 2.3 Falsifier — measured

One word changed in the `:451` thunk's sentence (`for this parent` → `for THIS
parent`) turns `g2-contracts` red: **2 failed / 214 passed**, at
`tests/raptor3/transitions/supplier-continuations.ts:249` with the exact
sentence diff ([`receipts/falsify-item2-thunk-sentence.log`](receipts/falsify-item2-thunk-sentence.log)).
Restored from the scratch copy; `relation-body.ts` back to
`e3f6e9e9b96a20c03c4876d5dfd9d367e22cfe65c6f40402c2d9d3e5f5648ff6` before the
next run. With the sentence restored: `g2-contracts` 216/216, `g2-generated`
52/52, `g4-unit02-author` 127/127 (including `unique-discriminator`,
`nested-key-refusal`, `key-arithmetic`, `upsert-key-portability`),
`g4-unit02-mysql-contracts` 17/17.

And directly: `nested-conditional-found/full` performs **1.000 explicit stack
captures per operation before, 0.000 after**, with CPU −16.53 µs/op and wall
−26.63 µs/op.

## 3. Item 3 — statement-scoped SQL aliases

### 3.1 The change

`shared/query.ts`: one new private owner beside `alias()`:

```ts
private rootAlias(): string {
  this.nextAlias = 0;
  return this.alias();
}
```

called as the first alias of each of the **six** methods that assemble a
complete statement — `select`, `aggregated`, `grouped`, `selectSeries`,
`recursive`, `junction`. Its docblock states the rule and its two halves (who
may call it, and why a `lower…` fragment may not).

### 3.2 The invariant

Within one statement build the counter only increases: a nested complete
statement is a subquery of its parent and mints a plain `alias()`
(`lowerRelationProjection`, `correlatedCount`, `cursorCondition`,
`membershipWhere`, `relationOrderTerm`, `lowerMutationLimit`), and no statement
owner is entered while another statement is being built —
`this.select`/`this.aggregated`/`this.grouped` are called only from `read`,
which dispatches to exactly one of them per verb, and `selectSeries`,
`junction` and `recursive` are only entered from outside `Queries`. Mutation
statements assembled in `OperationContext` from `lowerMutationLimit` +
`lowerProjection` keep sharing the operation's counter, which is exactly what
they need.

### 3.3 Falsifier — measured

New pin `tests/raptor3/g4/unit02/prepared-statement-stability.test.ts`, 3 cells,
green ([`receipts/prepared-statement-stability.log`](receipts/prepared-statement-stability.log)):
two successive identical `findUnique` calls on one engine publish byte-identical
`prepareBatch()` SQL, and still do after twenty more of the same call with other
operations minting aliases in between; one statement's aliases are one
contiguous run from `q0` with no duplicate; a limited `deleteMany`'s capped
subquery shares its statement's scope.

Removing the reset (`rootAlias` returning `this.alias()`) turns 2 of the 3 cells
red with the drift visible in the diff — `q0/q1/q2` against `q3/q4/q5`
([`receipts/falsify-item3-alias-scope.log`](receipts/falsify-item3-alias-scope.log)).
Restored from the scratch copy.

The drift is also visible in the A/B's own witness checksum, which sums each
prepared statement's SQL length: over 20 000 `scalar-find-unique` preparations
it is **3 585 364 before and 3 124 000 (= 20 000 × 156.2, constant) after**.

### 3.4 Alias pins in the harness

Searched repo-wide for pins of a numbered alias (`q0`…`q9`, `AS "qN"`):

| Pin | Verdict |
| --- | --- |
| `tests/raptor3/post-prep/projection-preparation.test.ts:147`, `:152` and `selector-preparation.test.ts:88`, `:105` (`queries.alias()` → `"q0"`, then `"q1"`) | **pin the counter value and still hold.** They prove `prepareProjection` / `prepareSelector` mint NO alias; both call `alias()` directly, which never resets, and no statement owner runs between them. Not updated. `post-g3-projection-preparation` 4/4 and `post-g3-selector-preparation` 4/4, green. |
| `tests/raptor3/g4/review/harness-reconciliation/lookup-recognizer.test.ts:46-58` (`AS "q1"`, `"q4"`, `"q0"` inside expected SQL) | **not counter pins.** They are verbatim samples from the unit's two frozen recorder tapes, used as INPUT to a recognizer regex; nothing re-derives them. Not updated. |

No other alias-numbered pin exists in `tests/`, `benchmarks/` or `scripts/`.

## 4. Item 4 — the `EngineSchema.scalars` trim, and what was NOT taken

`shared/schema.ts`: `Object.fromEntries(names.filter(…).map(…))` became one loop
into one object. Same keys, same order, same values, same prototype.

**Measured in isolation** ([`receipts/micro-scalars.json`](receipts/micro-scalars.json),
300 000 reps, two alternating samples each, the same consumer on both sides):
**0.277 / 0.262 µs per call before, 0.107 / 0.104 µs after** — about
**−0.16 µs per call** net of the shared consumer, and byte-equal output
(`equal: true`).

The per-model memo the brief names is already provided upstream:
`model["~"].scalarFieldNames` is memoised on the model
(`src/schema/model/model.ts:568-569`), so there is nothing left to memoise here
— only the intermediates, which is what the loop removes.

**Not taken, recorded as the next candidates** (no measurement, so no change):

1. `Queries.projectedColumn` re-derives `physicalField(schema, model, field).scalar["~"].state`
   for every field on every lowering, although `prepareProjection` already
   walked the same descriptors. The pure reuse would be to carry the scalar
   state on the prepared field descriptor and read it in `lowerProjection`.
   It is a change to the prepared shape's contents, so it needs its own
   before/after µs/op — this pass measured none and did not take it.
2. `Queries.lowerProjection` builds three parallel arrays (`columns`,
   `entries`, `names`) per call; the diagnosis attributes 2 052 B/op to it.
   Only the consumer that asks for `entries`/`names` needs them, so a
   caller-selected shape is a candidate — again, unmeasured here.
3. `commands/execution.ts:637` builds a `NestedWriteError` eagerly in
   `captureSeries` for the parent-membership requirement on every selected
   series with a membership. It is the same defect as item 2 but outside the
   brief's seven sites, and the value is needed immediately on one of its two
   paths, so it is a smaller and less obvious win.
4. `commands/execution.ts:248` calls `selection.retained()` unconditionally on
   the batch route, so a `connectOrCreate` still pays ONE `NestedWriteError`
   construction per operation there — unchanged by this pass, and outside the
   four measured cells. Recorded by the round-1 reviewer (perf-review §7); it
   matters when the remaining residual on the batch route is re-attributed.
5. Not a performance candidate, recorded beside them because item 2 created it:
   `commands/execution.ts:718` now stores `failure: selection.required!` — a
   THUNK behind a non-null assertion. It is unreachable (`child.requirement` is
   only set when a membership exists, and every series selection with a
   membership is built at `relation-body.ts:562` with a required thunk), but
   the `!` now hides a `TypeError` where it used to hide `throw undefined`
   (perf-review §7).

## 5. Item 5 — R-D3 gets its decided class

`shared/operation-context.ts:1868`: `new QueryEngineError(` → `new
UnsupportedOperationError(`. The message and `meta { model, operation, field }`
are unchanged and the raise point is unchanged (before any statement of that
update is dispatched). `UnsupportedOperationError` extends `QueryEngineError`,
so `instanceof QueryEngineError` still holds; `code` becomes V8003
UNSUPPORTED_OPERATION instead of V9001 INTERNAL_ERROR.

The two pins that name the class:

| Pin | Change | Verified |
| --- | --- | --- |
| `tests/raptor3/g4/unit02/key-arithmetic.test.ts` (2 cells + the R-D3 docblock) | the answer string's class name, plus a new `instanceof UnsupportedOperationError` assertion beside the retained `instanceof QueryEngineError` one | `g4-unit02-author` 127/127 — the cell count is unchanged (20) |
| `tests/raptor3/g4/review/unit02-decisions/batch-publication-identity.review.test.ts` (1 cell over three domains + its header) | the same | **not executed**: `tests/raptor3/g4/review/**` is excluded from every lane by `scripts/credential-free-test-manifest.mjs:260`, so no runner reaches it. Its `number` case is the same assertion the registered `key-arithmetic` cell makes, which is green. Recorded as an unverified claim. |

The guide's R-D3 sentence already says "a registered `QueryEngineError` naming
the model, the field and the operation … never let it degrade to a bare
`Error`", which the subclass satisfies; the class is named in the code comment
at the refusal site.

## 6. Item 6 — D-8: one ledger per engine in the benchmark contract

`benchmarks/operation-pipeline-contract-workloads.mjs` only. Two frozen rows,
`RELATION_SERIES_2_LEDGERS`, each naming its engine, its admissions per admitted
member, its statement count and its two persisted children; `seriesAdmissions`
turns a row into `1 + n × admissionsPerMember`; `seriesLedger(observed)` returns
the ONE row that explains an observed ledger and fails if that is not exactly
one row.

Asserted identically on both engines: `{ count: n }`; one child per located
parent with the right `parentId` and `label`; every other table unchanged; the
roots captured before any member is admitted (first cut, `defaults.length === 1`
on both); and — replacing the hard-coded `=== 5` — that every member was
admitted before the first effect.

**Corrected in round 2.** As first written that last fact was NOT asserted:
`admissionsBeforeFirstEffect` was reassigned on every statement where a child
was visible, so it always held the FINAL count and was compared with itself,
and the cut's own `assert.equal(defaults.length, seriesAdmissions(ledger))` was
tautological by `seriesLedger`'s construction. The round-1 reviewer found both
(perf-review finding 1), and I reproduced the LOST DETECTION by measurement —
see §12.1. The sentence above describes the repaired contract.

Pinned per engine: shipped 5 defaults `series_child_1…_5`, children
`series_child_3`→5000 and `series_child_5`→6000, 7 statements; candidate 3
defaults `series_child_1…_3`, children `series_child_2`→5000 and
`series_child_3`→6000, 3 statements.

**Measured, same bytes, both engines** (scratch trees, §7's instrument;
receipts `relation-series-2-{after,before}-{shipped,candidate}.json`):

| Arm | shipped | candidate |
| --- | --- | --- |
| after (this contract) | **verified** — 5 defaults, 7 statements, `series_child_3`/`_5` | **verified** — 3 defaults, 3 statements, `series_child_2`/`_3` |
| before (the frozen single-ledger contract) | verified | **FAILS** — `series effects started before every member was admitted … 3 !== 5` ([receipt](receipts/relation-series-2-before-candidate-assertion.json)) |

And the new contract refuses a third answer: with the candidate row's
`admissionsPerMember` set to 4 in the scratch tree, the candidate run fails with
*"relation-series-2 evaluated the generated default 3 times, which is neither
recorded engine ledger (shipped=5, candidate=9)"*
([receipt](receipts/relation-series-2-falsify-third-answer.json)); the scratch
file was then restored and compared byte-identical to the repo's.

**`RAPTOR3_WORKLOAD_VERSION` does not have to change; the protocol hash does,
mechanically.** The version (`operation-pipeline-catalog.mjs:463`) selects the
frozen workload set and binds the measured RECIPE: the public invocation, the
fixture, the substrate and the stages are unchanged to the byte, and
`verify`/`afterStatement` run only inside the untimed semantic observation, so
no timed stage moved. What changed is the file's bytes, and
`benchmarks/operation-pipeline-contract-workloads.mjs` is one of the 24
`PROTOCOL_PATHS` (`operation-pipeline-protocol.mjs:8-32`), so
`protocolSha256` changes and `operation-pipeline-compare.mjs:1242-1252` requires
coordinator, baseline and candidate to carry the same bytes. **Both the
candidate-only cutover worktree and the baseline overlay must take this file at
the next measurement**, and the stage-2/2b receipts taken under the old protocol
hash are superseded for this cell — which the re-qualification re-takes anyway.

## 7. The A/B measurement

Two scratch trees, never the perf worktrees:
`…/scratchpad/perf-safe/ab/{before,after}`, each `git archive HEAD`
(`0f25637b`) of `src/ benchmarks/ scripts/ package.json tsconfig.json
tsdown.config.ts vitest.*`, plus the committed
[`../cutover/phase-adapter.patch`](../cutover/phase-adapter.patch) so the
measured cell is the package seam both engines publish (protocol §2.1), built
with `pnpm package:build` (`tsdown`, 177 files each). The AFTER tree carries
this pass's seven candidate files and the contract workload; every other byte is
identical (verified file by file). One instrument, **identical in both trees**:
the package entry re-exports `createCandidateClient` and the core fixture builds
the measured client with it when `VIBORM_BENCH_ENGINE=candidate`, so "both
engines" is the shipped route and the candidate route over the same schema,
driver and fixture — which is what the cutover makes default. **The switch
reaches the `core` fixture only**: it is applied at the two `coreFixture`
client constructions and not at the `wide` or `variant` fixtures, and all four
cells reported below are `core` cells (`operation-pipeline-catalog.mjs:367`,
`:386`, `:406`, `:449`), so no number reported here is affected — but a later
reuse of this instrument on a `wide-*` or `variant-*` cell would silently
measure the shipped engine in BOTH arms until the switch is extended (round-1
review note 5).

3 alternating fresh-process pairs per (cell, engine, arm), medians, SQLite
(better-sqlite3 12.6.0), Node v24.21.0, darwin/arm64, ambient desktop load.
Driver [`receipts/ab-stage.mjs`](receipts/ab-stage.mjs), schedule
[`receipts/ab-run.sh`](receipts/ab-run.sh), 48 raw samples
[`receipts/ab-samples.jsonl`](receipts/ab-samples.jsonl), summary
[`receipts/ab-summary.json`](receipts/ab-summary.json).

| Cell | Engine | CPU µs/op before → after | wall µs/op before → after |
| --- | --- | --- | --- |
| `scalar-find-unique/prepare` | shipped | 12.70 → 12.36 (−0.34) | 5.82 → 5.52 |
| | **candidate** | **25.59 → 16.93 (−8.66)** | **15.85 → 8.64 (−7.21)** |
| `fixed-collection-rowref-20/prepare` | shipped | 19.81 → 20.05 (+0.24) | 10.59 → 10.78 |
| | **candidate** | **35.29 → 25.46 (−9.83)** | **21.01 → 13.10 (−7.91)** |
| `bulk-update-returning-100/prepare` | shipped | 25.98 → 25.75 (−0.23) | 17.83 → 17.70 |
| | **candidate** | **45.62 → 32.58 (−13.03)** | **30.70 → 21.59 (−9.12)** |
| `nested-conditional-found/full` | shipped | 198.00 → 194.95 (−3.05) | 127.63 → 125.83 |
| | **candidate** | **158.34 → 141.81 (−16.53)** | **127.33 → 100.70 (−26.63)** |

Ratios (candidate ÷ shipped), before → after:

| Cell | CPU | wall |
| --- | --- | --- |
| `scalar-find-unique/prepare` | 2.015 → **1.370** | 2.723 → **1.565** |
| `fixed-collection-rowref-20/prepare` | 1.781 → **1.270** | 1.984 → **1.215** |
| `bulk-update-returning-100/prepare` | 1.756 → **1.265** | 1.722 → **1.220** |
| `nested-conditional-found/full` | 0.800 → **0.727** | 0.998 → **0.800** |

The diagnosis predicted 1.35× for the first cell and a wall improvement on the
last; both land. The shipped side moves by −0.34…+0.24 µs/op on the three
preparation cells — nothing — and by −3.05 µs/op (1.5 %) on the nested write,
which is ambient noise at 3 samples.

**These numbers are attribution, not a verdict.** They are 3 alternating pairs
under ambient load, not the frozen 20-cell protocol with its MAD-based `E`, and
they do not bring any preparation cell inside the plan §7 5 % budget.

## 8. Plan §7's four questions, against the actual diff

1. **What decision does this diff eliminate?** Four. Whether an operation has
   paid for its two control-flow failure objects (it never pays until one is
   raised). Whether a plan owns its unraised failures (it owns recipes, not
   objects). Which operation minted an alias (an alias belongs to its
   statement). And, in the benchmark, which engine's ledger is "the" contract
   (both are, separately).
2. **What replaces it?** One invariant each: first-use materialisation before
   any observation; a sentence that is a pure function of construction-time
   facts; a counter that only increases within one statement build and is
   opened by the six statement owners; and a closed set of two recorded
   ledgers that must explain the observation exactly once.
3. **Who else had to change?** Nobody's semantics. Four carrier types and their
   raise sites, six first-alias calls, one class name, one benchmark contract.
   No public contract, no refusal sentence, no `meta`, no statement text except
   the alias NUMBERS, no fast-path statement or transaction count.
4. **What would falsify it?** Stated and measured per item in §§1.3, 2.3, 3.3,
   4, 5, 6 — each one run and each one seen to fail when the change is undone.

**Cost.** Candidate core (13 files under `src/query-engine/raptor3/` excluding
the retained `program/` specimen), same `countTokenLines` census as
`scripts/query-engine-structure.mjs`
(`censusFunctionSha256 15889231a22297fcf001ae22ca01e6e8c9cd7489dd635c60529dfdc0ac06461e`),
bytes / physical / token-lines:

| | before (`0f25637b`) | after |
| --- | --- | --- |
| `commands/commands.ts` | 46,751 / 1,311 / 1,225 | 46,817 / 1,312 / 1,226 |
| `commands/execution.ts` | 25,846 / 760 / 754 | 25,921 / 762 / 756 |
| `commands/relation-body.ts` | 32,238 / 913 / 867 | 32,420 / 920 / 874 |
| `commands/selection.ts` | 6,505 / 202 / 162 | 7,254 / 215 / 163 |
| `shared/operation-context.ts` | 84,054 / 2,229 / 1,892 | 85,925 / 2,262 / 1,898 |
| `shared/query.ts` | 139,660 / 3,941 / 3,568 | 141,398 / 3,970 / 3,572 |
| `shared/schema.ts` | 19,305 / 527 / 410 | 19,845 / 538 / 411 |
| **candidate core (13 files)** | **393,877 / 11,022 / 9,774** | **399,098 / 11,118 / 9,796** |
| core + retained specimen (15) | 414,609 / 11,660 / 10,400 | 419,830 / 11,756 / 10,422 |

**+22 charged token-lines** (+5,221 bytes, +96 physical — the bytes are mostly
docblocks stating the three new invariants). Per-file JSON:
[`receipts/cost.json`](receipts/cost.json).

Whole `src/query-engine/**` (`node scripts/query-engine-structure.mjs`, run in
each tree): files 181 → 181, physical lines 86,631 → 86,727, token-lines
**68,606 → 68,628 (+22)**, functions 3,846 → 3,854, branch nodes 8,983 → 8,986,
runtime import-cycle components 2 → 2, files over 300 lines 76 → 76.
Receipts: [`receipts/query-engine-structure-before.json`](receipts/query-engine-structure-before.json),
[`receipts/query-engine-structure-after.json`](receipts/query-engine-structure-after.json).

## 9. Files, patches, identity

**Files this pass edited** — the complete diff over `0f25637b` is
[`perf-pass.patch`](perf-pass.patch)
(`ad2ab9e5b3deba834ec51355e1e769ccefc3c3d9dfb18ab93269e21a87772c0a`, 1 043
lines, **15 files** after round 2), verified to reproduce every one of them
byte-identically by applying it to a fresh `git archive 0f25637b` and `cmp`-ing
each path (§12.4):

| File | Item |
| --- | --- |
| `src/query-engine/raptor3/shared/operation-context.ts` | 1, 5 |
| `src/query-engine/raptor3/shared/query.ts` | 3 |
| `src/query-engine/raptor3/shared/schema.ts` | 4 |
| `src/query-engine/raptor3/commands/selection.ts` | 2 (the carrier type) |
| `src/query-engine/raptor3/commands/commands.ts` | 2 |
| `src/query-engine/raptor3/commands/relation-body.ts` | 2 (the seven sites) |
| `src/query-engine/raptor3/commands/execution.ts` | 2 (the raise sites) |
| `src/query-engine/raptor3/AGENTS.md` | 7 (and item 3's rule is stated in the code) |
| `benchmarks/operation-pipeline-contract-workloads.mjs` | 6 |
| `tests/raptor3/g4/unit02/key-arithmetic.test.ts` | 5 |
| `tests/raptor3/g4/unit02/prepared-operation.test.ts` (5 → **6** cells) | round 2, item 2 — the sentinel falsifier |
| `tests/raptor3/g4/unit02/prepared-statement-stability.test.ts` (new, 3 cells) | 3 |
| `tests/raptor3/g4/review/unit02-decisions/batch-publication-identity.review.test.ts` | 5 |
| `tests/raptor3/core-structure/measurement/cs02-structure-measure.test.ts` | 2 — **cross-stream, see below** |
| `tests/raptor3/core-structure/structural-reference.test.ts` | 2 — **cross-stream, see below** |

**Cross-stream touch, declared.** The two `core-structure` structural specimens
construct `Commands.lookup(...)` with a literal `NestedWriteError` /
`NotFoundError`, so item 2's carrier type made them the only two TS2345
diagnostics outside `pattern/pack.ts`. The change is mechanical — `new X(…)`
→ `() => new X(…)` at three call sites, no assertion and no expectation touched
— and it was made rather than reported because the alternative was leaving the
whole-estate typecheck red. `cs01-structural-reference` 10/10 green.
`cs02-structure-measure` needs its base-identity artifact under the runner and
its matrix cell is red when the file is run directly — **measured as
pre-existing**: the same two cells fail identically with the file restored to
its `0f25637b` content, which matches the ledger's standing B-R1 note ("CS-02's
matrix cell remains a pre-existing registration defect"). The file was restored
byte-identically from the scratch copy afterwards.

**Closure patches, regenerated in place** against the recorded round-4 base:

- [`../unit02/production-closure.patch`](../unit02/production-closure.patch) —
  seven files — round 1 `c3df20e2…`, **regenerated in round 2** (`query.ts`'s
  docblock moved) — `4f07351d171b005d4bb61cecdb5a73b6144e9dacb06e760767734724323924a1`
- [`../unit02/tests-closure.patch`](../unit02/tests-closure.patch) — thirteen
  files (the twelve it had, plus this pass's `prepared-statement-stability.test.ts`)
  — `4b509c385d654c5c2719932e09affffe52b9e83c5eb95525ed27fe5dd14cde07`,
  **unchanged in round 2**: none of its thirteen files moved. Round 2's test
  edit is `prepared-operation.test.ts`, which this closure set has never named;
  it is carried by `perf-pass.patch`, the complete diff, and was deliberately
  not added to the unit02 closure set (that would change the set, which is not
  one of the review's resolutions).

The base was reconstructed by reverse-applying the previous pair onto
`git show HEAD:<path>` for every file they name. It reproduces the six round-4
base identities the unit02 note records — `5143b7b3…` (`query.ts`), `07b3df1a…`
(`schema.ts`), `f4ecd7ad…` (`commands.ts`), `874dc5ec…` (`selection.ts`),
`79066ea8…` (`relation-body.ts`), `82ba9c9e…` (`client-route.ts`) — exactly, and
the files the pair creates from `/dev/null` are absent from it. Forward-applying
the regenerated pair onto that base reproduces **every current file
byte-identically**, and reverse-applying it reproduces the base byte-identically.

**One limit, recorded rather than papered over.** The previous pair is already
stale at `0f25637b` for two files: two hunks of `operation-context.ts` and the
whole of `uncertain-outcome-meta.test.ts` no longer match, because later
committed units (D-7, the harness reconciliation) edited the same regions after
the pair was last regenerated. The reconstructed base therefore keeps `0f25637b`'s
text in those two regions
([`receipts/operation-context-stale-hunks.rej`](receipts/operation-context-stale-hunks.rej)),
and `uncertain-outcome-meta.test.ts` is created from `/dev/null` by the new
pair as the old one did. The round-trip property above is exact; the lineage
claim "reverse-applying lands on the round-4 base" holds for the six files
above and is approximate for `operation-context.ts`.

**Identity after the last edit of round 1** (`captureRaptor3Identity`,
[`receipts/identity-after.json`](receipts/identity-after.json)):

- production `4fe5bd3dff280d2a498746733ed3f723872c0fb4c3dafb27bb817cf35f7457e4`
- harness `239c40dcd0f5fc1e7bf627841108296c1fc2b475f87b15d564da16c5cf37e24e`
  (recomputed by the round-1 reviewer with his own four probe files excluded)
- runtime: node v24.21.0, darwin/arm64, better-sqlite3 12.6.0, vitest 3.1.4

**Identity after the last edit of round 2** — see §12.5.

## 10. Checks

One mode per call, each with a bounded runner line; logs under
[`receipts/`](receipts/). Docker ports from `docker port …`: MySQL 65515,
PostgreSQL 65504.

| Mode | Result | Wall / peak RSS |
| --- | --- | --- |
| `g4-unit02-author` | **127 passed** (19 files) | 6.20 s / 785.6 MiB |
| `g4-unit02-mysql-contracts` (65515) | **17 passed** | 5.25 s / 693.1 MiB |
| `g4-unit02-pg-contracts` (65504) | **1 passed** | 3.63 s / 531.3 MiB |
| `g4-read-contracts` | **62 passed** | 4.75 s / 728.6 MiB |
| `g4-route-lifecycle` | **8 passed** | 4.06 s / 530.7 MiB |
| `g4-route-admission` | **7 passed** | 4.03 s / 541.0 MiB |
| `g4-route-cache` | **7 passed** | 3.94 s / 536.1 MiB |
| `g4-route-transactions` | **13 passed** | 3.96 s / 540.0 MiB |
| `g4-lifecycle-events` | **3 passed** | 4.10 s / 522.0 MiB |
| `g4-lifecycle-admission` | **4 passed** | 4.10 s / 521.7 MiB |
| `g3-execution-review` | **6 passed** | 3.90 s / 543.1 MiB |
| `g3-bulk-series` | **6 passed** | 3.88 s / 532.9 MiB |
| `g3-transaction-array` | **4 passed** | 3.94 s / 542.9 MiB |
| `g3-suppression-retry` | **2 passed** | 3.96 s / 522.4 MiB |
| `g2-contracts` | **216 passed** (16 files) | 7.04 s / 838.0 MiB |
| `g2-generated` | **52 passed** | 4.69 s / 790.6 MiB |
| `g1-transport` | **44 passed** | 4.49 s / 712.2 MiB |
| `g2-transport` | **16 passed** | 4.44 s / 735.5 MiB |
| `g3-generated-transport-smoke` | **1 passed** | 4.35 s / 522.5 MiB |
| `g29-result-progress` | **2 passed** | 4.12 s / 507.6 MiB |
| `g2-mysql-contracts` (65515) | **13 passed** | 5.13 s / 715.9 MiB |
| `g2-mysql-baseline` (65515) | **13 passed** | 4.59 s / 651.7 MiB |
| `g2-pg-contracts` (65504) | **18 passed** | 5.36 s / 690.4 MiB |
| `node scripts/run-typecheck.mjs` | **only the two permitted `pattern/pack.ts` TS2345 diagnostics** | 6.87 s / 6,186.4 MiB |

Run in addition, because this pass could have moved them:

| Mode / file | Result |
| --- | --- |
| `post-g3-projection-preparation` | **4 passed** (the `q0`/`q1` counter pins) |
| `post-g3-selector-preparation` | **4 passed** (the `q0`/`q1` counter pins) |
| `cs01-structural-reference` | **10 passed** |
| `tests/raptor3/g4/unit02/prepared-statement-stability.test.ts` | **3 passed** (the new item-3 pin) |

`g2-mysql-contracts` is 13/13: the RF-12 unique-race regression the ledger
recorded at 12:05 on 2026-09-15 is repaired on this tree and did not return.

**Frozen fast-path counts did not move.** They are pinned by
`physical-envelope.test.ts` (10 cells), `root-delete.test.ts` (6),
`root-member-cut-trace.test.ts` (4), `malformed-result-cuts.test.ts` (4),
`lone-statement-transport.test.ts` (7) and `packaged-array.test.ts` (5) — all
inside `g4-unit02-author`, all green, and no statement or transaction count in
them changed.

**Cell counts, for the integrator (no manifest edit was made).** Round 2 adds
one cell; the rows below are the state AFTER round 2.

| Suite / file | Registered count | Actual now |
| --- | --- | --- |
| `g4-unit02-author` | 127 over 19 files | **128 over 19 files** — every cell green; the mode exits 1 ONLY on its registered-count check (see §12.2) |
| `tests/raptor3/g4/unit02/prepared-operation.test.ts` | 5 (`scripts/raptor3-manifest.mjs:601`) | **6** — request: `5` → `6` there, and the lane total moves 127 → 128 |
| `tests/raptor3/g4/unit02/key-arithmetic.test.ts` | 20 | **20 — unchanged** |
| `tests/raptor3/g4/unit02/prepared-statement-stability.test.ts` | **not registered** | **3** — request: add `"tests/raptor3/g4/unit02/prepared-statement-stability.test.ts": 3` to `G4_UNIT02_AUTHOR_COUNTS` (`scripts/raptor3-manifest.mjs:589-609`) and drop it from `extendedLocalExclusions` handling exactly as the other unit02 files are handled. Until then it runs in `extended-local` and was run directly here. |

## 11. Blockers and unverified claims

**Blockers: none.** No stop rule was reached; nothing needed a public-contract
change, a legacy fallback or duplicated semantic interpretation.

**Unverified claims.**

1. The A/B is attribution, not a verdict: 3 alternating fresh-process pairs per
   arm under ambient desktop load, SQLite only, not the frozen 20-cell protocol
   with its MAD-based `E`. No §7 cell is declared passed or failed here, and no
   preparation cell is claimed to be inside the 5 % budget.
2. The candidate arm of the A/B and of item 6 is `createCandidateClient` over
   the same fixture, not the cutover tree's default route. The two differ only
   in which call installs the route (`cutover.patch`'s `client.ts` hunk); this
   was reasoned from that patch, not measured against a built cutover tree.
3. ~~`tests/raptor3/g4/review/unit02-decisions/batch-publication-identity.review.test.ts`
   was edited for item 5 but not executed.~~ **Verified by the round-1
   reviewer: 2 cells green** (perf-review §1). No lane includes
   `tests/raptor3/g4/review/**`, so it still runs only when named directly.
4. ~~The item-3 safety rule ("no statement owner is entered while another
   statement is being built") is established by reading every caller, not
   measured.~~ **Measured by the round-1 reviewer** (perf-review §3.1): 18 read
   and write shapes, an instrumented depth counter on all six owners, no
   re-entry (`maxDepth === 1`), no statement declaring an alias twice, and
   byte-identical SQL over three passes with other operations minting aliases in
   between. He also measured the failure mode if it were ever violated: the
   collision is SILENT, not a provider error — which is why the docblock's
   claim is now scoped to what the mechanism enforces (§12.3).
5. Item 3's statement-cache benefit (PostgreSQL named statements, `mysql2`'s
   prepare cache, D1/PlanetScale) is reasoned from the drivers, as in the
   diagnosis; only the SQLite text stability is measured.
6. The closure-patch lineage claim is exact for the six files listed in §9 and
   approximate for `operation-context.ts` and `uncertain-outcome-meta.test.ts`,
   whose recorded hunks are stale at `0f25637b`.
7. `cs02-structure-measure`'s red matrix cell is attributed to the pre-existing
   B-R1 registration defect by measurement (same failure with the file restored
   to `0f25637b`), not by reading its cause.
8. Peak RSS in the A/B is `process.resourceUsage().maxRSS` of the measuring
   process, which includes fixture setup; it is recorded in the samples but no
   claim is made from it.

---

## 12. Round 2 — the independent review's resolutions, applied

Review: [`../perf-review.md`](../perf-review.md) (REVISE, 11:47 2026-09-16).
Scope, as briefed: **exactly the reviewer's resolutions, nothing more.** No
engine behaviour changed in round 2 — the only production edit is a docblock
clause. Receipts: [`receipts/round2/`](receipts/round2/).

| Review item | Resolution | Where |
| --- | --- | --- |
| finding 1 (must-fix) | the benchmark cut asserts the fact it names | §12.1 |
| finding 2 (must-fix) | the sentinel's memo gets a registered falsifier | §12.2 |
| note 3 | the D-7.1 row written into the unit02 note | [`../unit02/note.md`](../unit02/note.md) §P.0 |
| note 4 | `perf-pass.patch` regenerated with a proper `diff --git` header | §12.4 |
| note 5 | the A/B instrument's reach stated | §7, first paragraph |
| note 6 | the `rootAlias` docblock clause softened | §12.3 |
| note 7 | the two `execution.ts` observations recorded | §4, next candidates 4 and 5 |

### 12.1 Finding 1 — the benchmark now asserts "every member was admitted before the first effect"

`benchmarks/operation-pipeline-contract-workloads.mjs`, three lines:

- `:355` records the ledger **once**, at the first statement where a child is
  visible: `admissionsBeforeFirstEffect ??= defaults.length;`
- `:314-318` adjudicates it against the FINAL ledger:
  `assert.equal(admissionsBeforeFirstEffect, seriesAdmissions(seriesLedger(defaults.length)), "series effects started before every member was admitted")`
- the tautological `assert.equal(defaults.length, seriesAdmissions(ledger))` at
  the cut is gone; `seriesLedger`'s own call stays, and its "neither recorded
  engine ledger" guard still carries the third-answer refusal.

**Green on both engines** (reviewer's method: `createWorkloadHarness("relation-series-2", "full", 2, "sqlite3", …)` on the
A/B `after` tree, whose candidate arm is `VIBORM_BENCH_ENGINE=candidate`):

| Engine | defaults | statements | children | receipt |
| --- | --- | --- | --- | --- |
| shipped | 5 (`series_child_1…_5`) | 7 | `series_child_3`→5000, `series_child_5`→6000 | [`round2-series2-after-shipped.json`](receipts/round2/round2-series2-after-shipped.json) |
| candidate | 3 (`series_child_1…_3`) | 3 | `series_child_2`→5000, `series_child_3`→6000 | [`round2-series2-after-candidate.json`](receipts/round2/round2-series2-after-candidate.json) |

**Falsified, and the falsification DISCRIMINATES.** A late admission — one
member admitted after the first effect — cannot be produced by mutating either
engine, so it is simulated at the observation: the count visible at the first
effect statement is one short while every later statement sees the full ledger
(`effectStatements === 1 ? defaults.length - 1 : defaults.length`). The SAME
simulation was run against the round-1 contract and the round-2 contract, on
both engines
([`round2-series2-late-admission-discriminating.jsonl`](receipts/round2/round2-series2-late-admission-discriminating.jsonl),
mutated copies [`late-admission-new.mjs`](receipts/round2/late-admission-new.mjs) /
[`late-admission-old.mjs`](receipts/round2/late-admission-old.mjs)):

| Contract | shipped | candidate |
| --- | --- | --- |
| **round 2** (this one) | **FAILS** — `series effects started before every member was admitted … 4 !== 5` | **FAILS** — `… 2 !== 3` |
| round 1 (as reviewed) | verified — **the late admission is invisible** | verified — **the late admission is invisible** |

That is the reviewer's finding measured rather than argued: the round-1
assertion could not see the fact it named, and the round-2 assertion sees it,
on both engines, with that sentence. The third-answer refusal is unchanged —
with the candidate row's `admissionsPerMember` set to 4 in the scratch copy the
run still fails with *"relation-series-2 evaluated the generated default 3
times, which is neither recorded engine ledger (shipped=5, candidate=9)"*
([`round2-series2-third-answer-refusal.json`](receipts/round2/round2-series2-third-answer-refusal.json)).
Every scratch mutation was restored from a copy and compared byte-identical to
the repository's file (`eb664786…`).

`RAPTOR3_WORKLOAD_VERSION` still does not have to change, for §6's reason: no
timed stage moved, only the untimed contract observation. The protocol hash
changes mechanically again, and the same instruction stands — the cutover
worktree and the baseline overlay both take this file at the next measurement.

### 12.2 Finding 2 — the sentinel's memo now has a registered falsifier

The reviewer's cell 1 of `tests/raptor3/g4/review/perf/sentinel-and-scalars.review.test.ts`
is now the sixth cell of `tests/raptor3/g4/unit02/prepared-operation.test.ts`,
the file that already owns the `prepareBatch` boundary and is already inside
`g4-unit02-author`: `prepareBatch` answers `undefined` for an unpackageable
nested write four times, interleaved with a packageable read that still
packages, in both orders. A getter that returned a fresh `Error` per read would
make `prepareBatch` throw its own control-flow sentence at the caller instead —
which the reviewer showed no registered suite could see.

**Falsified on this tree, not assumed.** The getter's body at
`operation-context.ts:175-177` was replaced with
`return new Error("Raptor 3 operation requires dynamic execution");` (the memo
dropped, nothing else changed) and the file was run through the bounded runner:
the five pre-existing cells stay green and **only the new sixth cell goes red**,
with the sentinel's own control-flow sentence leaking to the caller —
*"Error: Raptor 3 operation requires dynamic execution"*
([`falsify-sentinel-memo-prepared-operation.log`](receipts/round2/falsify-sentinel-memo-prepared-operation.log)).
`operation-context.ts` was then restored from its scratch copy, sha256
`53acb07c45ebd4efdd67435071a34d6335f697eb5026cd885cc8797149f12277` (the same
hash the round-1 reviewer recorded for his own restore), the file re-ran
**6/6 green**
([`prepared-operation-after-restore.log`](receipts/round2/prepared-operation-after-restore.log)),
and the production identity re-verified unchanged.

`g4-unit02-author`: **19 files, 128 cells, all green**, and the mode exits 1
ONLY on its registered-count check — *"Missing candidate/profile/scenario cell
in tests/raptor3/g4/unit02/prepared-operation.test.ts / 6 !== 5"*
([`g4-unit02-author.log`](receipts/round2/g4-unit02-author.log)). **No manifest
edit was made**, as briefed. The integrator's edit is one line:
`scripts/raptor3-manifest.mjs:601` `5` → `6`, which moves the lane total to 128.

### 12.3 Note 6 — the `rootAlias` docblock says what the mechanism enforces

`src/query-engine/raptor3/shared/query.ts:490-493`. "every statement starts at
`q0`" became "a statement whose first alias is minted by one of the six owners
named below starts at `q0`". A statement whose first alias comes from a `lower…`
fragment starts wherever the counter is; the reviewer could construct no shape
where that is observable (18 shapes, §3.1 of the review), and the rest of the
docblock already stated the real rule. Comment only — no behaviour, no token
lines: the census moves by exactly one physical line (86 727 → 86 728) and
`tokenLines` stays **68 628**, functions **3 854**, branch nodes **8 986**, files
over 300 lines **76**
([`query-engine-structure-round2.json`](receipts/round2/query-engine-structure-round2.json)).

### 12.4 Note 4 — `perf-pass.patch` regenerated

The new file's hunk now carries `diff --git a/… b/…`, `new file mode 100644`
and an `index 00000000..<blob>` line, so every consumer counts the same
**15 files**. One correction to the reviewer's note 4, measured on the round-1
patch: `git apply --stat` and `--numstat` TOLERATED the headerless section and
counted 14, not 13; what counted 13 was any consumer that keys on `diff --git`
(`grep -c '^diff --git'` → 13 while the note said 14). The defect and the fix
are the same either way. Regenerated as
`git diff 0f25637b -- <14 tracked paths>` plus a correctly headed section for
the one untracked file, blob id from `git hash-object` (nothing was staged and
no object was written). Verified: applied to a fresh `git archive 0f25637b`, it
reproduces **all 15 paths byte-identically** (`cmp` on each).
`ad2ab9e5b3deba834ec51355e1e769ccefc3c3d9dfb18ab93269e21a87772c0a`, 1 043 lines.

`production-closure.patch` was regenerated for the same reason the docblock
moved, and both closure patches `git apply -R --check` cleanly against the
working tree, so their `+` side IS the current tree. Forward-applying the new
production closure onto the recorded round-4 base reproduces all seven files
byte-identically, and reverse-applying it reproduces the base byte-identically.

### 12.5 Round-2 checks and identity

One mode per call, through the bounded runner
([`receipts/round2/`](receipts/round2/)):

| Mode | Result | Wall / peak RSS |
| --- | --- | --- |
| `g4-unit02-author` | **128 passed** (19 files); exit 1 on the registered-count check only | 6.35 s / 777.1 MiB |
| `g2-contracts` | **216 passed** (16 files) | 7.22 s / 821.0 MiB |
| `g2-generated` | **52 passed** | 5.35 s / 740.7 MiB |
| `g4-route-cache` | **7 passed** | 4.35 s / 529.0 MiB |
| `g4-route-transactions` | **13 passed** | 4.28 s / 534.3 MiB |
| reviewer's `tests/raptor3/g4/review/perf/` workspace | **14 passed** (3 files) | 2.85 s / 533.6 MiB |
| `node scripts/run-typecheck.mjs` | **only the two permitted `pattern/pack.ts` TS2345 diagnostics** | 6.86 s / 6,146.7 MiB |

**Identity after the last round-2 edit**
([`identity-after-round2.json`](receipts/round2/identity-after-round2.json)):

- production `2e92354bafaaccb7cab5f54041992b552664a7865fb69370be70ebccb63a1975`
  (moved from `4fe5bd3d…` by the docblock clause, and by nothing else)
- harness `e8436e5e2aeb75b8d75ec6c251b310a6acb3ae375fb2bd0b61bef26a8cd991f7`
  as captured, which now INCLUDES the reviewer's four probe files under
  `tests/raptor3/g4/review/perf/`; recomputed with those four excluded, for
  comparability with the round-1 figure, it is
  `05040249b9550adadb546fe74f85d546ab47e51fe8d3e25fd4056d482f68f9d4`
  ([`identity-harness-excluding-review-perf.json`](receipts/round2/identity-harness-excluding-review-perf.json))
- runtime: node v24.21.0, darwin/arm64, better-sqlite3 12.6.0, vitest 3.1.4

**No new A/B was run in round 2** and none is claimed: the only production edit
is a comment, so §7's numbers stand as measured in round 1 and reproduced
independently by the reviewer (perf-review §4).

**Blockers after round 2: none.** Unverified claims 3 and 4 of §11 are now
verified/measured by the reviewer and struck through there; claims 1, 2, 5, 6,
7 and 8 stand unchanged.
