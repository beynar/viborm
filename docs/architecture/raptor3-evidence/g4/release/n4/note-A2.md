# N4 group A2 — the refusal census in `commands/`

Worktree `/private/tmp/viborm-n4`, branch `n4`, base `bf7ac30b4`.
Write targets: `src/query-engine/raptor3/commands/{commands,execution,relation-body,index}.ts`.
Rows: 37–47 and 28 (`docs/architecture/raptor3-evidence/g4/release/plan/refusals-map.md`).

## The truth this unit states

A refusal is a sentence a caller reaches with an ADMITTED payload. None of the
eleven sentences in these four files is one. Ten name a state an earlier owner
already forecloses; they are now invariants, told from refusals BY CLASS — the
census reads `EngineInvariantError` (not a `VibORMError`) and never a message.
The eleventh (row 28) is an execution fact at the provider boundary and is kept
exactly as it is.

Two of the ten stop existing at all, because the representation now says what
the sentence said:

- **The client's operation vocabulary is closed** (`Operations`, 16 members).
  `admittedOperation`'s switch enumerates all sixteen, so its `default` arm has
  a value of type `never` and `unreachable` makes the compiler state it. The
  function returns `Operation`, not `Operation | undefined`, and `resolve` —
  which existed only to turn that `undefined` back into a sentence — is gone.
  There is no operation this engine does not implement.
- **The relation-write vocabulary is closed too, and it is owned right here.**
  `mutationOrder` and `collectionMutationOrder` are what RUN a payload's verbs;
  nothing can be a verb without being in one of them. They become `as const`
  and `RelationVerb` is derived from them (one authority, not a second list).
  `RelationBody.relation` takes that type, so its eleven-case switch is
  exhaustive and its `default` is `unreachable(verb, …)`. The `string` → verb
  step happens once, where the admitted payload is destructured, with the fact
  named: validation's strict nested-write object schemas admit no other key.

The invariant owner already existed and this group imported it, creating
nothing: `src/query-engine/raptor3/shared/invariant.ts` —
`EngineInvariantError`, `assertInvariant(condition, message)`,
`unreachable(value: never, message)`. **Agreed name for the integrator: that
file, that class, those two functions.**

## Per row

| # | site (now) | disposition | what changed | the fact it rests on |
|---|---|---|---|---|
| 37 | `commands.ts:1204` `visitPrecedingWrites` | ASSERT | `throw new Error("Command occurrence is missing from its parent")` → `assertInvariant(false, "an occurrence's parent lists that occurrence")` | `bindTree` (`commands.ts:1055`) sets `occurrence.parent = parent` while walking `parent.children`, so an occurrence that HAS a parent is one of that parent's children and the loop returned above |
| 38 | `commands.ts:578` `seriesCaptureTarget` | ASSERT | kind check → `assertInvariant` | the one caller is `CommandExecution.run`'s `case "captureSeries"` arm (`execution.ts:602`); the switch established the kind one line earlier |
| 39 | `commands.ts:1356` `expandSeries` | ASSERT | `!owner` throw → `assertInvariant(this.seriesOwner(occurrence), …)` (the value was never used past the guard) | a series is either placed inside a record's body (`RelationBody`'s `updateMany`/`deleteMany` arm) or is the root series whose template IS the update record (`Commands.plan`), so `seriesOwner` resolves for every series analysed |
| 40 | `commands.ts:1363` `expandSeries` | ASSERT | already-expanded throw → `assertInvariant(this.seriesMembers(occurrence).length === 0, …)` | expansion happens once per occurrence: `captureSeries` returns early once the attempt holds this capture, and a recovery re-plans onto a NEW occurrence tree (`commands/index.ts` body; `operation-context.ts` `batchAttempt`/`regionAttempt` re-enter `body()` from a `catch`), never re-entering this one |
| 41 | `commands.ts:583` `seriesCaptureTarget` | ASSERT | missing-target throw → `assertInvariant(target, …)` | `materializePlacement` resolves every `captureSeries` child's target before `analyze`/`analyzeSeries` returns the tree this reads |
| 42 | `commands.ts:444` `materializePlacement` | ASSERT | kind/undefined throw → one `assertInvariant(resolved && isSeriesOccurrence(resolved), …)` (it narrows: the assignment below requires `CommandOccurrence<SeriesOccurrence>`) | `requireSeriesCapture` places a capture in the SAME body as the series it names, so the target is one of this parent's recipe children and has a replacement in the map; a replacement carries its source's COMMAND, so it keeps the kind `SeriesCapture.target` already states |
| 43 | `index.ts:53` `admittedOperation` | **TYPE-LEVEL PROOF** | `default: return undefined` → `unreachable(operation, "client operation")`; return type `Operation`; `resolve` and its sentence `Raptor 3 G1 operation is not implemented: ${operation}` deleted | `Operations` (`src/client/types.ts:44`) is closed at 16 members and the switch enumerates all 16; the `default` arm's value is `never` |
| 44 | `execution.ts:887` `captureSeries` | **TYPE STRENGTHENED** | the missing-origin throw is gone: `SelectedSeries["mutation"]`'s delete arm now carries `readonly origin: Origin` (`commands.ts:200`), supplied at the one construction site (`relation-body.ts:717`), and the member is built with `origin: series.mutation.origin` | the only construction of a delete series is `RelationBody`'s `deleteMany` arm, which had the origin in scope and was already assigning it to `selection.origin` seven lines above; the state "a delete series with no origin" can no longer be spelled |
| 45 | `execution.ts:723` / `:950` | **one site TYPE STRENGTHENED, one ASSERT** | `captureSeries` now RETURNS the `PreparedSeries` it set (and its early exit returns the entry it found), so `series()` reads the value instead of re-reading the map — that throw is deleted. `executeSeries`, which is also reached from `run`'s `case "selectedSeries"`, keeps the map read with `assertInvariant(prepared, …)` | the command attempt is replaced only by `spendRecovery()`, called from the two `catch` arms in `operation-context.ts` (`regionAttempt`, `batchAttempt`), so no normal return from `captureSeries` can land in a swapped attempt; and `requireSeriesCapture` places the `captureSeries` command ahead of the series in the same body |
| 46 | `execution.ts:958` `executeSeries` | ASSERT | `!located` throw → `assertInvariant(located, "a series member names its captured row")` | every member `captureSeries` built names the row it captured: a `Deletion` carries `located` by type, and an update member is `Commands.update(located, …)` on that same captured selection |
| 47 | `relation-body.ts:744` `relation` | **TYPE-LEVEL PROOF** | `verb: string` → `verb: RelationVerb`; `default:` → `unreachable(verb, "relation verb")`; sentence `Raptor 3 G1 relation operation is not implemented: ${verb}` deleted | the union is made at its owner — `mutationOrder` + `collectionMutationOrder` in this same file, now `as const`, with `RelationVerb` derived from them — and the payload's keys are read at that type once, at `expand`'s entries loop, because validation's strict nested-relation-write schemas admit no other key |
| 28 | `commands.ts:1531`, `:1597` (`rootUpsert`'s `missing`, `rootCreate`) | **KEPT — INTEGRITY** | nothing | `INSERT did not produce the required record` is an execution fact at the provider's trust boundary, not payload validation: a single-row INSERT that reports success and returns or locates zero rows is a driver anomaly, and no payload shape controls it. ELEGANCE §5 keeps existence/affected-row checks exactly. It is also already one sentence across its three real consumers (two here, one in `operation-context.ts`), which is what §9 asks; it is NOT an invariant, because the state it names is produced outside this code |

## Hunks

`git diff` on the four files, base `bf7ac30b4` (+103 / −47 lines; **+6 net
non-comment code lines**, the rest are the comments that name each fact):

- `commands.ts` (+32 lines, +9 code): import `assertInvariant`; `SelectedSeries.mutation` delete arm gains `origin`; rows 42, 38, 41, 37, 39, 40.
- `execution.ts` (+9 lines, +1 code): import `assertInvariant`; `type PreparedSeries` derived from `CommandAttempt["series"]`; `captureSeries` returns it; rows 44, 45, 46.
- `relation-body.ts` (+14 lines, +3 code): import `unreachable`; the two order arrays `as const` + `RelationVerb`; `order: readonly string[]` for `indexOf`; the entries loop reads the payload's keys at `RelationVerb`; `relation(verb: RelationVerb)`; row 47; row 44's `{ kind: "delete", origin }`.
- `index.ts` (+1 line, **−7 code**): import `unreachable`; `admittedOperation` returns `Operation` with an `unreachable` default; `resolve` deleted.

## Falsification record

No new test cell: no row of this group changes an answer a caller can observe
(no executed capability boundary here). What the unit DOES claim is that two
switches are now proved by the compiler and two states can no longer be
spelled — so the falsification is the compiler's, run both ways through
`node scripts/run-typecheck.mjs` (whole estate).

Three mutations, applied to the CURRENT files → all three caught:

```
src/query-engine/raptor3/commands/index.ts(52,26): error TS2345:
  Argument of type '"count"' is not assignable to parameter of type 'never'.
src/query-engine/raptor3/commands/relation-body.ts(712,17): error TS2322:
  Property 'origin' is missing in type '{ kind: "delete"; }' but required …
src/query-engine/raptor3/commands/relation-body.ts(745,21): error TS2345:
  Argument of type '"connectMany"' is not assignable to parameter of type 'never'.
```

The SAME three mutations, applied to the four files restored to `bf7ac30b4`
(`git show bf7ac30b4:<file>` into the paths, then restored from a scratch copy
— never `git checkout`): **silent, all three.** At the base, dropping
`case "count":` compiles because the `default` returned a value; a twelfth verb
at the vocabulary's owner compiles because `verb` was `string`; and
`{ kind: "delete" }` with no origin IS the base text. That is the unit's point:
at the base these three were runtime sentences that a census counted as
refusals; they are now facts the build cannot get wrong.

Mutations used, for replay:
1. delete the line `    case "count":` from `admittedOperation`;
2. append `"connectMany",` to `collectionMutationOrder`;
3. spell the delete series as `{ kind: "delete" }`.

## Runs

All under `TMPDIR=/private/tmp/viborm-n4-A2-tmp`, one vitest process at a time.

| command | result |
|---|---|
| `node scripts/run-vitest-safe.mjs run tests/raptor3/g4/parity/series-member-premise.test.ts` | 8/8 pass (2 files) |
| `… tests/raptor3/g4/parity/{lane-x-set-mutations,ordered-observation,lax-to-one}.test.ts` | 102/102 pass (4 files) |
| `… tests/raptor3/transitions/{staleness,variant-removals,junctions}-commands.test.ts` | 86/86 pass (6 files) |
| `… tests/raptor3/{candidate,gate,fixed}.test.ts` | 112/112 pass (6 files) |
| `… tests/raptor3/transitions/{conditional-upsert,junction-identity,keys,singular-lattice,supplier-continuations}-commands.test.ts` | 190/190 pass (10 files) |
| `… tests/raptor3/g4/parity/{integration-staleness,integration-membership-race,lane-x-route-seam}.test.ts` | 11/11 pass (3 files) |
| `… tests/raptor3/ownership/commands.test.ts` | **2 failed / 10 passed — NOT this group's**, see below |
| `… tests/raptor3/g4/parity/{series-member-premise,lane-x-set-mutations,integration-staleness}.test.ts` (re-run at the end, after other groups' edits landed) | 22/22 pass (4 files) |
| `node scripts/run-typecheck.mjs` | clean for this group's files; two other groups' test files red, see below |

## Still red (not this group's files, not fixed by this group)

1. `tests/raptor3/ownership/commands.test.ts:376` — `Type '"atomic-array"' is
   not assignable to type '"borrowed-transaction" | "standalone"'`, and the
   case `refuses atomic-array binding before admission or provider work` fails
   at runtime (`UniqueConstraintError` where it expected `TransactionError`).
   Cause: another group's in-progress edit to
   `src/query-engine/raptor3/shared/operation-context.ts`, which deletes the
   `"atomic-array"` `ExecutionBinding` variant and its sentence (map row 31,
   disposition DELETE). That row's owner also owns the recorded expectation
   the ruling changed; this group did not touch the test.
2. `tests/raptor3/g4/parity/batch-captured-bulk.test.ts` — six diagnostics
   (TS2352 / TS2322 / TS2769) in a NEW, untracked test file another group is
   writing for the executed capability boundaries (map rows 23/25). Not this
   group's file and not this group's rows.
3. Transient, already resolved: `src/query-engine/raptor3/shared/storage.ts:95`
   and `:124` (`TS2554: Expected 4 arguments, but got 3`, `variantMember`) were
   red in a mid-session typecheck while another group (map rows 48/49) was
   mid-edit; the final run is clean there. Recorded so the receipt is not
   misread as a flake.

None of the three is touched here, and no diagnostic in any run named one of
this group's four files.

## Biome (`npx biome check <file>`, fixed BY HAND, formatter never run)

| file | before | after |
|---|---|---|
| `commands.ts` | 2 errors (`noParameterProperties`, `noParameterAssign`) | same 2, unchanged |
| `execution.ts` | 4 errors (`organizeImports`, `noParameterProperties`, `useDefaultSwitchClause`, `noCommaOperator`) | same 4, unchanged |
| `relation-body.ts` | 5 errors (`noUnusedVariables`, 5× `noParameterProperties`) + 1 info | same, unchanged |
| `index.ts` | 1 `format` diagnostic (the `missing` ternary at :174–177) | same 1, unchanged — confirmed present in `git show e19b20759:…/index.ts` too, so the formatter was NOT run on this file |

No diagnostic was added and none was removed; every new line was written to
the house format by hand (one `type PreparedSeries` line was re-joined by hand
after biome printed its preferred single line).

## LOC

| file | base lines | now | Δ lines | Δ non-comment code lines |
|---|---|---|---|---|
| `commands.ts` | 1816 | 1848 | +32 | +9 |
| `execution.ts` | 969 | 978 | +9 | +1 |
| `relation-body.ts` | 1079 | 1093 | +14 | +3 |
| `index.ts` | 309 | 310 | +1 | **−7** |
| **total** | | | **+56** | **+6** |

`src/query-engine/raptor3/shared/invariant.ts` (29 lines) is the shared owner;
it already existed when this group started and is charged to whichever group
created it, once.

## Unverified

- The claim that **validation's strict nested-relation-write schemas admit no
  key outside the eleven verbs** is taken from the map's row 47 and from
  `AGENTS.md`'s account of the nested-write vocabulary; this group did not
  re-derive it from `src/schema/validation/model/args/**`. It is the fact the
  one `as RelationVerb` at `expand`'s entries loop rests on. If it is ever
  false, `unreachable` still throws `EngineInvariantError` at runtime — an
  invariant failure, which is the correct class for it — so the failure mode
  is stated, not silent.
- Row 39's fact (`seriesOwner` always resolves) is established from the two
  construction sites reachable today (`Commands.plan`'s root series and
  `RelationBody`'s nested series). It was not proved against a future third.
- The estate typecheck was run with two other groups' edits in the tree; the
  "clean for this group's files" claim is that no diagnostic named one of this
  group's four files, not that the estate is green.
