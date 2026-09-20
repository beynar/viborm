# FC-03 (predicate half) — share prepared set predicates

Branch `fc03`, worktree `/private/tmp/viborm-fc03`, base `29a7bf9d8`.
The unexecuted concurrency half of the handoff's FC-03 section is the separate
`fcpg` lane and is **not** in this unit.

## The witness

The closure review's executed failure, "review: internal captured-set
predicates with NOT field"
(`docs/architecture/raptor3-evidence/g4/release/closure-review/probes.test.ts.txt`):
a valid model that declares a scalar named `NOT` performs a captured delete
with a relation projection through the public client on a batch-only
transport.

- **At the base (red):** `EngineInvariantError: Raptor 3 filter operator is not
  implemented: OR`. Re-executed here by restoring each synthetic bag in a
  backup copy (`receipts/falsify-a-requireCapturedSet-bag.log`,
  `receipts/falsify-b-requireNoAddedMember-bag.log`): bag A red on 6 of the
  new cells, bag B red on the nested cell — the same sentence in both. Both
  receipts were captured against the eight-cell file; the ninth cell, added in
  the repair round below, discriminates neither bag — it pins the OWNER's
  empty-set branch, which is what the deleted short-circuit became.
- **After (green):** the delete publishes
  `{ id: 2, NOT: 20, OR: "drop", boxId: 1, box: { id: 1, label: "one" } }`, the
  row is gone and its siblings are not, and the complement premise really ran
  (one guard statement, naming the captured key once inside its `NOT (…)`).
  `receipts/pin-prepared-set-predicates.log`, 8 / 8 — 9 / 9 after the repair
  round (`receipts/repair-pin-prepared-set-predicates.log`).

## The fact and its owner

**Fact:** the complement of a captured identity set — "this row is not one of
the rows the engine read".

**Owner:** `Queries` (`src/query-engine/raptor3/shared/query.ts`), which already
owns prepared identities (`identitySelector`, `lowerIdentity`), conjunction
(`andSelectors`) and the one logical-combinator owner (`combine`). The new
`Queries.excludeIdentities(model, identities)` composes the complement from the
captured identities' own equalities through `identityPredicate` — a private
helper `identitySelector` now shares — under `combine`, so the premise is
prepared meaning and only its SQL is spelled.

Why it could not stay where it was: N4 makes a DECLARED field win the
combinator key (`combinator(model, key)`, pinned by
`tests/raptor3/g4/parity/combinator-named-scalar.test.ts`), so a hand-built
public payload `{ NOT: { OR: [identities] } }` is read as that model's own
scalar named `NOT`, then dies on scalar operator `OR`. Public field-name
precedence is preserved: nothing reserves `NOT`/`OR`/`AND`, no error class
changed, no parser mode was added.

## The hunk

Three files, 66 insertions / 22 deletions (the guide addendum in
`src/query-engine/raptor3/AGENTS.md` apart).

- `src/query-engine/raptor3/shared/query.ts` — `identitySelector` delegates to
  the new private `identityPredicate`; the new public `excludeIdentities`
  composes `NOT(OR(identity…))` through `combine`, with `facts.exact = false`
  for a non-empty set (a negated set pins no equality, exactly as the
  combinator walker recorded it) and **no predicate at all** for an empty one.
- `src/query-engine/raptor3/commands/execution.ts` —
  `requireNoAddedMember(series, membership, rows)` calls
  `ctx.queries.excludeIdentities(model, rows.map(row => ctx.schema.identity(model, row)))`.
  Its `keys` parameter and the inline identity rebuild are gone.
- `src/query-engine/raptor3/shared/operation-context.ts` — one line in
  `requireCapturedSet`: `q.excludeIdentities(model, identities)`.

Both hunks are local to the function each unit owns (FC-02A edits other regions
of the same two files).

## The rules deleted

1. `CommandExecution.requireNoAddedMember()`'s synthetic public selector bag
   (base `execution.ts:951-957`) **and** its `rows.length === 0` special case,
   which is now the owner's empty-set truth.
2. `OperationContext.requireCapturedSet()`'s synthetic public selector bag
   (base `operation-context.ts:2558`).
3. The inline identity rebuild `Object.fromEntries(keys.map(…))` beside (1),
   replaced by `Schema.identity`, its existing owner; the `keys` parameter
   disappears with it.

No refusal, test, assertion or integrity requirement was deleted, skipped or
weakened. No policy boolean, no mode branch, no second reader, no cache.

## The second consumer / placement

`OperationContext.requireCapturedSet` (root selected bulk `updateMany` /
`deleteMany` on a batch-only transport) and `CommandExecution.requireNoAddedMember`
(the nested selected-series capture, through a to-many edge) are two genuinely
different placements of the one fact, and both are exercised by the new pin:
cells 1–7 reach the first (cell 4 as an empty capture, which the root consumer
answers before it asks the owner), cells 8 and 9 the second — cell 9 with an
EMPTY captured set, the one placement that reaches the owner's empty-set branch.
The two bag falsifications prove the placements are independent — restoring one
bag leaves the other's cells green.

**Policies were not merged.** A limited capture still claims no complement
(`requireCapturedSet`'s `if (limit !== undefined) return;`, pinned by "a LIMITED
capture claims no complement; the unlimited one does", which asserts that the
limited call emits no complement statement and the unlimited one emits exactly
one). `requireNoAddedMember` keeps its membership scope, its parent premise
ahead of the complement and its own raceable sentence; `requireCapturedSet`
keeps its per-identity presence premises, its guard order and its
`TransactionError` sentence.

## Capability change

One family recovered: every captured-set operation — root selected bulk
`updateMany`/`deleteMany` without RETURNING, a root captured `delete`/`update`
with a relation projection, and a nested captured series deletion — on a model
that legally declares a scalar or relation named `NOT`, `OR` or `AND`. No new
public language, no numerical-semantics change, no new recovery authority, no
new adapter capability. Nothing previously accepted is now refused.

## Registrations (the integrator applies; `scripts/raptor3-manifest.mjs` untouched)

- `G4_PARITY_COUNTS`: `"tests/raptor3/g4/parity/prepared-set-predicates.test.ts": 9`.

Until it is registered the file runs in the `extended-local` project only, which
is where every run below executed it.

## Runs (file → counts)

| File | Result |
| --- | --- |
| `tests/raptor3/g4/parity/prepared-set-predicates.test.ts` (new) | 9 / 9 passed (3.41 s, 511.6 MiB); 8 / 8 at the first round (3.44 s, 524.3 MiB) |
| `tests/raptor3/g4/parity/batch-captured-bulk.test.ts` (owner pin, `requireCapturedSet`) | 7 / 7, twice (`raptor3`, `coverage-raptor3`) |
| `tests/raptor3/g4/parity/integration-staleness.test.ts` (owner pin, `requireNoAddedMember`) | 5 / 5 |
| `tests/raptor3/g4/parity/combinator-named-scalar.test.ts` (N4 precedence, neighbour) | 4 / 4, twice |
| `tests/raptor3/g4/parity/captured-identity-domains.test.ts` (neighbour) | 9 / 9, twice |

The four existing files ran in one launcher invocation: 7 files, 45 / 45 passed
(6.46 s, 653.6 MiB) — `receipts/owner-pins.log`.

Falsifications (backup copy, restored by `cp`, never `git checkout`):

| Falsification | Result |
| --- | --- |
| bag A restored in `requireCapturedSet` | 6 failed / 2 passed, all six `EngineInvariantError: Raptor 3 filter operator is not implemented: OR` |
| bag B restored in `requireNoAddedMember` | 1 failed / 7 passed, the nested cell, same sentence |
| after both restores | 8 / 8 green again (`receipts/pin-after-restore.log`) |
| the owner's empty-set branch removed (the complement combined unconditionally) | 1 failed / 8 passed — the ninth cell alone, on the vacuous `NOT (0)` it then states (repair round, `receipts/repair-falsify-c-empty-set-branch.log`) |

No wide run, no fixed lane, no `g1`/`g2` comparison, one vitest at a time.

## Typecheck

`node scripts/run-typecheck.mjs` → exit 0, **0 diagnostics**: the repair round's
run at 5.66 s / 5119.3 MiB (`receipts/repair-typecheck.log`), the first round's
at 6.02 s / 5012.0 MiB (`receipts/typecheck.log`).

## Census

`node scripts/raptor3-refusal-census.mjs` → public refusals **23**, total sites
192. Unchanged; no refusal or error class was touched. `receipts/census.log`.

## Biome

Per changed file, current tree vs `git show HEAD:<file>`, identical counts
(`receipts/biome.txt`):

| File | base | now |
| --- | --- | --- |
| `shared/query.ts` | 15 errors, 1 info | 15 errors, 1 info |
| `commands/execution.ts` | 4 errors | 4 errors |
| `shared/operation-context.ts` | 6 errors | 6 errors |
| `tests/raptor3/g4/parity/prepared-set-predicates.test.ts` | (new file) | 0 |

The new test file was formatted with `node_modules/.bin/biome format --write`,
as the rules allow for a new file; no base file carrying a `format` diagnostic
was formatted. `receipts/biome.txt` was regenerated in the repair round: its
first-round copy recorded 2 errors for the test file because it was captured
before that file's `format --write` and its `lint/style/useImportType` fix, and
it contradicted this table.

## LOC

`node scripts/query-engine-structure.mjs` token lines (parser-owned tokens,
comments and blanks excluded): **16,036 → 16,059, +23**.
Physical lines: `commands/execution.ts` 1226 → 1218 (−8),
`shared/query.ts` 5007 → 5059 (+52, of which 21 are comment lines).
`receipts/structure-before.json`, `receipts/structure-repair.json` (the tree as
delivered); `receipts/structure-after.json` is the first round's 16,067, before
the inert `positive` parameter was dropped.

## Unverified

- Only SQLite (in-process, both the batch-only and the live route) was executed.
  The complement's SQL on PostgreSQL and MySQL is unexercised by this unit; it
  is the same lowering path every other selector takes.
- The `NOT (…)` / `COLLATE` spelling the new cells match is SQLite's adapter
  vocabulary; the cells that count excluded key columns are adapter-specific by
  construction.
- The whole-estate typecheck reported 0 diagnostics, i.e. not even the two
  historical Pattern `TS2345` errors the common brief permits; that is the
  base's behaviour on this worktree, not a change of this unit.

## Blockers

None. No public-contract change, no new recovery authority and no
numerical-semantics change was needed.

## Repair round (2026-09-21)

The independent reviewer's three findings, all applied; none declined.

**1. The owner's empty-set branch was unpinned (minor).** The reviewer probed it:
a `throw` at the head of `Queries.excludeIdentities` for an empty set left the
eight cells green, because cell 4's root `deleteMany({ where: { OR: "absent" } })`
returns at `operation-context.ts:2437` before `requireCapturedSet` is ever
called. The claim that the pin covered "empty and non-empty captures" was true
of the CONSUMERS' behaviour and false of the owner's empty-set truth.

A ninth cell now reaches the owner with an empty set, at the placement the
reviewer named — the nested series, the only production caller that can pass one
(`CommandExecution.requireNoAddedMember`, whose caller invokes it at
`execution.ts:1056` whether or not the capture is empty): on the default batch transport,
after the same `AND` connect as cell 8,
`box.update({ where: { id: 1 }, data: { AND: { deleteMany: { OR: "absent" } } } })`.
It asserts that the series' guard still rides the batch (one batch call, one
distinct `__viborm_assert__` statement over `fc03_items`), that `complements()`
is empty — the guard states the membership and the filter and NO `NOT (`
condition — and that all three items survive.

Falsified: with the branch removed, so that the complement is combined
unconditionally, the guard states the vacuous `NOT (0)` of an empty `OR` and
that cell alone goes red (1 failed / 8 passed,
`receipts/repair-falsify-c-empty-set-branch.log`); restored by `cp` from the
backup, md5 of the file verified equal to the pre-falsification copy. The
deleted `rows.length === 0` short-circuit is therefore pinned by its
replacement, and the note's and the ledger's "empty and non-empty captures" now
name both consumers' empty captures: the root one, which returns before the
owner, and the nested one, which reaches the owner's branch.

**2. `identityPredicate`'s `positive` parameter selected no behaviour (minor).**
Dropped, exactly as requested: `positive = true,` at `query.ts:1243` and the
`false,` / `positive,` arguments are gone, leaving the base call shape
`this.prepareScalarPredicate(model, field, value, facts)`, and
`excludeIdentities` calls `this.identityPredicate(model, identity, facts)`. An
identity's values are literals, so every one of them takes `prepareOperations`'
shorthand path to the `equals` arm, which never reads `positive`; the only
consumers of the flag — the `distance` probe marker and the relation-slot arms —
are unreachable from a scalar equality. −8 engine token lines (16,067 → 16,059).

**3. `receipts/biome.txt` contradicted this note (minor).** The receipt recorded
2 errors for the new test file while the table above claimed 0. Regenerated
against the tree as delivered, all four files, with the method stated in its
header: the test file is clean (Biome prints no `Found` line for a clean file),
and the three engine files match their base counts unchanged.

### Runs of the repair round (only the affected files, one vitest at a time)

| File | Result |
| --- | --- |
| `tests/raptor3/g4/parity/prepared-set-predicates.test.ts` (9 cells) | 9 / 9 passed (3.41 s, 511.6 MiB) — `receipts/repair-pin-prepared-set-predicates.log` |
| the same file, empty-set branch removed in a backup copy | 1 failed / 8 passed — `receipts/repair-falsify-c-empty-set-branch.log` |
| `integration-staleness`, `batch-captured-bulk`, `captured-identity-domains` (the two owner pins and the identity neighbour, one invocation, re-run because `query.ts` changed) | 5 files / 37 passed (6.71 s, 632.0 MiB) — `receipts/repair-owner-pins.log` |

`node scripts/run-typecheck.mjs` → exit 0, 0 diagnostics, once
(`receipts/repair-typecheck.log`). Biome per changed file, regenerated
(`receipts/biome.txt`). No census re-run: no refusal, error class or message was
touched in this round. No wide run, no fixed lane, no `g1`/`g2` comparison.

## Commit message draft (the integrator commits)

```
fix(raptor3): a captured set's complement is prepared meaning, not public syntax (FC-03)

The closure review's second executed failure: a valid model that declares a
scalar named `NOT` could not perform a captured delete with a relation
projection — `EngineInvariantError: Raptor 3 filter operator is not
implemented: OR`.

Two owners manufactured the PUBLIC payload `{ NOT: { OR: [identities] } }` for
an internal premise — `CommandExecution.requireNoAddedMember()` and
`OperationContext.requireCapturedSet()` — and N4 makes a declared field win the
combinator key, so the engine read its own premise as that model's scalar.

`Queries.excludeIdentities` now owns the complement of a captured identity set,
composed from those identities' own equalities under the one combinator owner
and through `identityPredicate`, which `identitySelector` now shares. Both
consumers ask it for the answer; both synthetic bags are deleted, together with
one caller's empty-set special case and its inline identity rebuild, which is
`Schema.identity`.

Public field-name precedence, empty-set truth, complete compound identities,
alias binding, membership scope, guard ordering, each consumer's error identity
and the limited capture's distinct policy are unchanged. Nothing reserves
`NOT`/`OR`/`AND`, no error class changed, no parser mode was added.

New credential-free pin tests/raptor3/g4/parity/prepared-set-predicates.test.ts
(9 cells, public client, in-process SQLite): the review case with results and
effects, the legal scalars `NOT`/`OR` and the relation `AND`, both consumers,
each consumer's empty capture and the non-empty ones, the compound complement,
the limited capture's absent complement, and the row that joins a
combinator-named selection after the capture. Falsified three times in backup
copies — one synthetic bag at a time, then the owner's empty-set branch.

Typecheck 0, census public 23, Biome unchanged per touched file, engine token
lines 16,036 → 16,059.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
