# `relation-series-2` — classification of the cutover contract divergence

Read-only diagnostic. Nothing in `/Users/arnaud/code/viborm` was executed,
staged, committed or modified outside this file and its receipts directory.
Both engines were measured in the isolated worktrees
`/private/tmp/viborm-g4-perf-baseline` (`e67b511b`, shipped) and
`/private/tmp/viborm-g4-perf-candidate` (`9086ad81`, the frozen identity-2
cutover), each against its **own** `benchmarks/operation-pipeline-fixtures.mjs`
and its own `dist/`. Node v24.21.0, better-sqlite3 12.6.0, darwin/arm64.

## Verdict

**(a) — the already-adjudicated default-evaluation difference.** The persisted
child ids differ *only* because the workload's generated default is a counter
(`series_child_${++childSequence}`, `operation-pipeline-fixtures.mjs:318`) and
the shipped engine consumes that counter twice per admitted member where the
candidate consumes it once. No member is skipped, no default is evaluated for
the wrong row, and the nested create is not replayed: both engines insert
exactly one child per located parent, with the same `parentId` and the same
`label`, in the same member order, and both answer `{ count: 2 }`.

The divergence is the **updateMany/captured-member instance of the same shipped
double admission** that Arnaud adjudicated on 2026-09-08 (`g2.md:136-141`,
plan §2.3 "Adjudicated admission contract (2026-09-08): one evaluation per
admitted input"). It is measured here on a *generated default* rather than on a
scalar transform, which is why — for the first time in this program — the
adjudicated cardinality difference becomes visible in **persisted data** and not
only in the admission ledger.

It is **not** a bounded parity repair, because the only way to make the
candidate's ledger match is to reintroduce the second per-member parse that the
adjudication explicitly rejected, and the same record forbids changing the
shipped engine.

## 1. What was reproduced

`series-probe.mjs` runs the contract's exact invocation
(`generatedParent.updateMany({ where: { id: { in: [5000, 6000] } }, data: { children: { create: { label: "series-child" } } } })`)
through the public client on a fresh core fixture, recording every provider
statement in order, every `generatedChild.id` evaluation with a source-mapped
stack, and the persisted rows.

Both sides reproduce
[`receipts-stage2/relation-series-2-divergence.json`](receipts-stage2/relation-series-2-divergence.json)
and [`receipts-stage2b/relation-series-2-identity2.json`](receipts-stage2b/relation-series-2-identity2.json)
exactly — 5 defaults / 7 statements shipped, 3 defaults / 3 statements candidate,
same SQL, same parameters, same persisted rows. Receipts:
[`probe-shipped.json`](relation-series-2-classification/probe-shipped.json),
[`probe-candidate.json`](relation-series-2-classification/probe-candidate.json).

| | statements | defaults | persisted children |
| --- | ---: | ---: | --- |
| shipped | 7 | 5 (`series_child_1`…`_5`) | `series_child_3` → 5000, `series_child_5` → 6000 |
| candidate | 3 | 3 (`series_child_1`…`_3`) | `series_child_2` → 5000, `series_child_3` → 6000 |

Both: `{ count: 2 }`, two rows inserted, `label` `series-child`, one per located
parent, and every other table byte-identical to the initial state.

## 2. The mechanism

### 2.1 The one evaluation both engines share

The first evaluation (`series_child_1`, discarded by both) is the operation's
public admission, and it happens before any statement on both sides:

- shipped — `write-engine/UpdateManyRecordSeries.ts:127` (`validate(...)`, the
  bulk envelope under the public name `updateMany`) → `query-engine/validator.ts:94`.
- candidate — `raptor3/shared/schema.ts:192` (`admitArguments`) →
  `write-engine/parse-boundary.ts:42`.

With a filter that matches **no** row, this is the *entire* ledger on both sides:
1 default, 1 statement, `{ count: 0 }`, nothing written (`roots-0-single`, §3) —
the two engines agree exactly, modulo the prepared text's table alias. The head
is not the divergence.

### 2.2 The shipped engine: two parses per admitted member

`OperationExecutor.runRecordSeries` (`OperationExecutor.ts:423`) builds every
member before the first member runs a statement, via
`UpdateManyRecordSeries.compileMembers` (`UpdateManyRecordSeries.ts:183-185`),
which constructs one `UpdateOperation` per located root with
`capturedRoot: { data: this.rawData, … }`. That constructor parses the member's
raw `data` **twice**, and both parses traverse the nested `children.create`
payload, so the generated `id` default fires in both:

1. `UpdateOperation.ts:132` —
   `parseValidated(parentSchemas.core.update, captured.data, "updateMany", "data")`
   (the captured member's whole-`data` parse). Its relation copy is **discarded**.
2. `UpdateOperation.ts:164` —
   `parseValidated(relationSchemas.update, relationPayload.payload, "update", "data.<relation>")`,
   re-parsing the **raw** payload (`data` at `UpdateOperation.ts:144` is
   `captured.data`, not the output of parse 1 — so the two parses are independent
   applications, never compounded). Its result is what
   `buildRelationMutationProgram` writes, so this is the value that is persisted.

Measured attribution (`probe-shipped.json`): defaults #2 (`:132`) and #3 (`:164`)
belong to member 5000, #4 (`:132`) and #5 (`:164`) to member 6000 — and the
persisted ids are `series_child_3` and `series_child_5`, i.e. the second parse of
each member.

The source comment at `UpdateOperation.ts:128-129` — "Relation payloads are then
transformed exactly once at their existing relation sites" — does not describe the
measured behaviour: the core parse at `:132` already transforms the relation
payload, so a captured member transforms it twice.

### 2.3 The candidate: one parse per admitted member

`Execution.captureSeries` (`raptor3/commands/execution.ts:684`) admits the
members inside `OperationContext.prepareMembers`
(`raptor3/shared/operation-context.ts:292-295`), calling, once per located row,
`ctx.schema.update(selection.model, series.mutation.raw, true)`
(`execution.ts:709`) → `raptor3/shared/schema.ts:421`:

```ts
parseValidated(schemas.core.update, source, "updateMany", "data")
```

That is **the same call the shipped engine makes at `UpdateOperation.ts:132`** —
same schema (`core.update`), same operation name (`updateMany`), same issue path
(`data`). The candidate keeps the shipped engine's *first* per-member parse and
drops its *second*. Nothing else about member admission moved: `prepareMembers`
completes for every member before the first effect, exactly as
`OperationExecutor.ts:420-423` requires ("Every member is BUILT before the first
one runs a statement").

### 2.4 The same duplicate on the single-record `update` path

`shapes-*.json` measures the shape the G2 record actually adjudicated, with a
generated default substituted for the scalar transform:

| shape | shipped | candidate |
| --- | --- | --- |
| `generatedParent.update` + nested create | 2 defaults (`UpdateOperation.ts:141` then `:164`), persists `series_child_2` | 1 default (`schema.ts:192`), persists `series_child_1` |
| `generatedParent.create` + nested create | 1 default, persists `series_child_1` | 1 default, persists `series_child_1` (**identical**) |

The duplicate is specific to the shipped **update** path, precisely as
`g2.md:137` states ("not the shipped update path's observed double call"), and
`relation-series-2` is that same duplicate replicated across `n` captured
members.

## 3. The law, and the five falsifications of (b)

`series-scaling.mjs`, same fixture, varying the number of located roots `n` and
the number of nested create inputs `k`
([`scaling-shipped.json`](relation-series-2-classification/scaling-shipped.json),
[`scaling-candidate.json`](relation-series-2-classification/scaling-candidate.json)):

| case | `n` | `k` | shipped defaults | candidate defaults | shipped stmts | candidate stmts | rows created | row set identical? |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `roots-0-single` | 0 | 1 | 1 | 1 | 1 | 1 | 0 | yes (byte-identical) |
| `roots-1-single` | 1 | 1 | 3 | 2 | 4 | 2 | 1 | yes, ids differ |
| `roots-2-single` | 2 | 1 | 5 | 3 | 7 | 3 | 2 | yes, ids differ |
| `roots-3-single` | 3 | 1 | 7 | 4 | 10 | 4 | 3 | yes, ids differ |
| `roots-2-array-2` | 2 | 2 | 10 | 6 | 9 | 5 | 4 | yes, ids differ |

shipped `= k + 2nk`; candidate `= k + nk`; the difference is exactly `nk`, one
duplicate per admitted member-input. Statements: shipped `1 + n(2 + k)` (it
re-locates each parent before and after its inserts); candidate `1 + nk`.

This rules out every shape of (b) named in the brief:

1. **No member skipped.** `{ count: n }` and exactly `n` parents receive a child
   in all five cases, including `n = 3`.
2. **No default evaluated for the wrong row.** In `roots-2-array-2` the
   candidate's per-member pairs are `(3, 4)` → 5000 and `(5, 6)` → 6000, in the
   payload's own `a`, `b` order; the shipped's are `(5, 6)` → 5000 and
   `(9, 10)` → 6000. Each engine's inserted id is the id its own parse produced
   for that member.
3. **The nested create is not replayed per located row.** Both engines insert
   `nk` children total. It is the *shipped* side that repeats work — two extra
   `SELECT … WHERE id = ? LIMIT 1` per member, and one extra parse per member.
4. **Nothing is persisted that the other side does not persist.** Every other
   column, every other table and the parent rows are identical; only the id
   *string* differs, and only where the counter advanced differently.
5. **No refusal was dropped with the second parse.** A malformed nested payload
   (`create: { label: 42 }`) and an unknown nested key (`create: { …, nope: 1 }`)
   produce byte-identical `ValidationError` messages, identical default counts
   (1 and 0) and zero statements on both engines
   ([`shapes-*.json`](relation-series-2-classification/shapes-shipped.json)).

## 4. What a user observes

The ids of the created children — and nothing else.

`generatedChild.id` is `s.string().id().default(nextChildId)` where the fixture's
`nextChildId` is a monotonic counter. The value a counter returns is a function
of how many times it has been called, so halving the call count shifts every
subsequent id. With an order-independent generator (cuid2/uuid/nanoid — what a
real schema uses) both engines would mint one fresh id per created row and the
persisted state would be indistinguishable; the only remaining difference would
be the invocation count of the user's own function.

So the user-visible surface is: **a default factory that is not a pure function
of its call site — a counter, a sequence, an id pool, anything with a side
effect — is called `k + 2nk` times by the shipped engine and `k + nk` times by
the candidate for one `updateMany` with a nested write, and the row the shipped
engine stores is the one its *second* call produced.** The returned value
(`{ count }`), the number of rows, their association and all other columns are
unchanged.

## 5. The prior record: what it covers and what it does not

**Matches — mechanism and direction.**

- `docs/architecture/raptor3-implementation-plan.md` §2.3, lines 211-217:
  "**Adjudicated admission contract (2026-09-08): one evaluation per admitted
  input.** Arnaud explicitly chose this over preserving the shipped update path's
  observed duplicate scalar-transform calls. … Keep the old engine's measured
  ledger as baseline evidence and pin the new ledger independently; do not hide
  the difference in a global comparator or change the shipped engine as part of
  this private rewrite."
- `docs/architecture/raptor3-evidence/g2.md:136-141`, the same decision recorded
  in the G2 evidence, with its explicit limits ("not permission to ignore
  defaults globally, re-admit a member during retry, or change the shipped
  engine").
- `docs/architecture/raptor3-g4-claude-handoff.md:136`: "Defaults/transforms run
  once per admitted input, not on replay. Preserve actual member admission
  timing." The candidate satisfies both halves: one per admitted input, and
  every member admitted before the first effect.
- `tests/raptor3/generation/transitions.ts:163-168` states the same contract in
  code ("The approved Raptor 3 contract is one evaluation per admitted input")
  and line 488 sets `primaryAdmissions = 1` when a candidate factory is present,
  so **the two engines' ledgers are pinned separately** (`:646-653`), legacy at
  2 and candidate at 1.

The candidate's 3 decomposes as 1 public admission + 1 per admitted member — the
adjudicated contract, exactly. The shipped's 5 is that same 3 plus one duplicate
per member.

**Does not cover — two things.**

1. **The harness's stripping rule does not transfer to this workload.**
   `tests/raptor3/generation/campaign.ts:53-66` removes
   `baseline.defaults.slice(baselineLength - candidateLength)` — a *prefix* —
   and then requires value-for-value equality. That works in G2 because the
   recorded "default" there is an identity `transform` on a supplied literal
   (`transitions.ts:174-179`), so its value is invariant to the call count and
   the extra calls sit at the front. Here the extra calls are **interleaved**
   (positions 2 and 4 of 5, one per member) and the value **is** the call count,
   so the prefix slice yields `[series_child_3, _4, _5]` against the candidate's
   `[series_child_1, _2, _3]` — unequal. The G2 rule cannot be reused verbatim,
   and `assertEquivalentRunObservations`
   (`benchmarks/operation-pipeline-semantics.mjs`) also compares `final`, which
   differs here where in G2 it never did.
2. **No prior record decides the persisted-value consequence.** Every existing
   pinned default ledger avoids this cell: the three other benchmark contract
   workloads assert `defaults == []`
   (`operation-pipeline-contract-workloads.mjs:82`, `:171`); the G3 bulk scenario
   pins a counter ledger only for `createMany` and `[]` for `updateMany`
   (`tests/raptor3/g3/generation/bulk-scenario.ts:330-341`) — and `create` is a
   path where the two engines already agree exactly (§2.4). `relation-series-2`
   is the only place in the frozen corpus where a *count-dependent* default is
   evaluated under the *update* path, which is why it is the only cell where the
   adjudicated difference reaches the database.

**And the frozen contract contradicts §2.3's instruction.**
`benchmarks/operation-pipeline-contract-workloads.mjs:216-278` pins **one**
ledger for both engines — five defaults, `series_child_3`/`series_child_5`, and
two `afterStatement` cut assertions that hard-code `defaults.length === 1` and
`=== 5`. That is a global comparator carrying the shipped count, which §2.3
tells the program not to build. Note also that the *causal* property those cuts
defend is satisfied by the candidate: the first cut's "selected members were
admitted before capture completed" holds with 1 on both sides, and
"series effects started before every member was admitted" holds on the candidate
with 3 (= 1 + 2 members, all admitted before the first `INSERT`, verified in
`probe-candidate.json`). Only the shipped-specific constant 5 fails.

## 6. Recommendation

**Record it as a decision for Arnaud, with both answers pinned.** Do not repair
the candidate.

The decision to put to him is narrow, because the cardinality itself is already
decided:

> The 2026-09-08 admission adjudication makes the candidate call a generated
> default `k + nk` times where the shipped engine calls it `k + 2nk` times. For a
> default whose value depends on its call count, that changes the value stored.
> `relation-series-2` stores `series_child_2`/`series_child_3` instead of
> `series_child_3`/`series_child_5`. Confirm that this is the accepted
> consequence, and that the benchmark contract should pin one ledger per engine.

The pin, if he confirms, is the shape `transitions.ts` already uses — the
workload's `verify`/`afterStatement` take the engine side, asserting on both:

- engine-independent, asserted identically on both sides: `{ count: n }`;
  exactly one child per located parent with the right `parentId` and `label`;
  every other table unchanged; the roots captured before any member is admitted
  (first cut, `defaults.length === 1` on both); every member admitted before the
  first effect (second cut, `defaults.length === 1 + n` candidate / `1 + 2n`
  shipped, expressed as the engine's own constant, not as a literal 5).
- shipped: 5 defaults `series_child_1…_5`, children `series_child_3` → 5000 and
  `series_child_5` → 6000, 7 statements.
- candidate: 3 defaults `series_child_1…_3`, children `series_child_2` → 5000
  and `series_child_3` → 6000, 3 statements.

A second, cheaper option exists and should be offered alongside it: make the
fixture's generated id **order-independent** (for example derive it from the
parent row rather than from a counter) so the persisted state is engine-neutral
and only the ledger length differs — the G2 situation. It is smaller than a
two-sided pin, but it is still Arnaud's call, because `benchmarks/**` is inside
`captureRaptor3Identity`'s *harness* fingerprint
(`scripts/raptor3-manifest.mjs:954-960`) and `RAPTOR3_WORKLOAD_VERSION`/the
protocol hashes bind the exact recipe: either change re-freezes the G4
measurement identity and invalidates the stage-2b receipts that were taken
against it.

**Owner, if a change is authorised:** the G4 cutover measurement unit that owns
`benchmarks/operation-pipeline-*.mjs` and the frozen protocol — the same unit
that produced [`note.md`](note.md) and
[`protocol.md`](protocol.md) — not a production-engine owner. **No `src/` change
is warranted by this finding on either side**, and §2.3 forbids the shipped-side
one outright.

Until then `relation-series-2/full` correctly stays "blocks adoption — required
contract divergence" in the stage-2b verdict table: it is a *frozen-contract*
blocker, not an engine defect, and it is the only one of the 20 cells whose
blocker is not a performance number.

## 7. Limits of this diagnostic

- SQLite (`better-sqlite3`, `:memory:`) only, `transactional` substrate,
  `unextended` arm — the providers and substrate the workload itself declares
  (`operation-pipeline-catalog.mjs:415`). pglite/mysql2 were not measured.
- The probes drive the public client directly with the frozen contract's
  assertion absent; they do not re-run `run-raptor3` or any registered mode.
- Stacks are source-mapped from each worktree's own `dist/` build via
  `--enable-source-maps`; line numbers therefore refer to that worktree's `src/`.
- `probe-shipped.json` / `probe-candidate.json` re-measure the candidate's
  physical statement count (3) that `receipts-stage2b` had carried forward
  unmeasured; it is confirmed.
- Whether any *other* frozen cell hides the same difference was checked only by
  reading the three remaining contract workloads (all assert `defaults == []`)
  and the G3 bulk ledger; it was not measured for the non-contract workloads,
  which publish no default ledger.

### Receipts

[`relation-series-2-classification/`](relation-series-2-classification/) —
`series-probe.mjs`, `series-scaling.mjs`, `series-shapes.mjs`,
`single-update-stacks.mjs` and their outputs (`probe-*.json`, `scaling-*.json`,
`shapes-*.json`). Each JSON records the worktree root it was produced from.
