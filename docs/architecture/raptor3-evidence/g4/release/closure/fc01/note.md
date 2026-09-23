# FC-01 — dependency placement local to fresh occurrences

Branch `fc01` in `/private/tmp/viborm-fc01`, from `29a7bf9d8` on `pattern-engine`.
Node `v24.21.0`, Vitest `3.1.4`. Nothing committed, staged or formatted beyond
the new test file; `benchmarks/**` and `scripts/raptor3-manifest.mjs` untouched.

## The witness

`tests/raptor3/g4/parity/fresh-member-placement.test.ts` (new, registered below;
credential-free, in-process SQLite through the public client, two routes ×
eight cells = **16**). The first cell is the closure review's executed failure
(`closure-review/probes.test.ts.txt`, "review: ordered observation through
updateMany"), strengthened to assert the returned count as well as the effects.

**At the base (red).** Both engine files restored to `29a7bf9d8`
(`git show HEAD:<file> > <file>`, the working copies preserved in `$TMPDIR` and
restored by `cp`): **14 failed / 2 passed**, every placement cell refused with

> `NestedWriteError: Nested operation 'delete' on relation 'edited' depends on an
> earlier 'update' target write in the same nested write. Split these operations
> into separate queries.`

(and the choice cells with the `'update' on relation 'nodes' … membership write`
and `'deleteMany' on relation 'tags' … 'connectOrCreate' target write` forms of
the same sentence). The two green cells are the consumed-parent cycle control.
Receipt: `receipts/base-red.log`. Because the two restored files differ from the
repaired tree **only** in the global bit and its docblock, this run is also the
falsification the brief asks for: restore the bit, the new cells go red, the
cycle control stays green.

**After (green).** **16 passed**, 4.23 s wall, 525.4 MiB peak sampled RSS,
teardown verified. Receipt: `receipts/after-green.log`.

The eight cells: the review case under root `updateMany` (the returned count
and the deleted row — the delete addresses that row by the slug the member's
earlier write set, so the rename is what the deletion proves); the same
payload under a nested
`updateMany`; two sequential series in one operation (the second expansion does
not inherit the first's); a member's parent-held choice that moves behind the
member's own write; the opposite arm of one choice (`connectOrCreate` missing →
created, found → connected, the dependent capture moving behind either arm); a
deeper expansion — a nested series expanded inside an already-running member;
and the retained cycle control (a read the member's own write consumes keeps the
inherited refusal, and nothing commits).

## The fact

Whether a read may still be taken at its consumer's execution point is a fact
about **the occurrence whose `children` hold it**: a placement *is* a position
in that array, so it may change while that ancestor has not begun dispatching
them. It is not a fact about whether any series in the operation has expanded.

A template is a recipe: `analyze`/`analyzeSeries` place the TEMPLATE's
occurrences. `captureSeries` then builds each member afresh from the admitted
payload, and a fresh member's own reads have never been placed by anyone —
which is why the same payload executed under `user.update` and was refused
under `user.updateMany`.

## The owner

Placement stays with `Commands.depend` (the existing occurrence/dependency
owner). The execution position is `CommandExecution`'s — `run` is the only
thing that enters an occurrence — and it answers one question,
`CommandExecution.started(occurrence)`. The analysis pass already consults the
execution owner (`Commands.activeRefusal` reads `this.execution.attempt.rows`);
this is the same shape, one question further.

## The hunk

`src/query-engine/raptor3/commands/commands.ts`

- `-` the field `private expanded = false` and its comment (`:292-293`).
- `-` `this.expanded = true` in `expandSeries` (`:1433`).
- `~` `depend`: `if (consumed || this.expanded)` → `if (consumed ||
  this.execution.started(ancestor))` (`:1029`).
- `~` the `depend` docblock: the false template justification replaced by the
  execution-position rule and by the pairs the limit covers.

`src/query-engine/raptor3/commands/execution.ts`

- `+` `private readonly entered = new Set<CommandOccurrence>()`, one
  `this.entered.add(occurrence)` at the top of `run`, and the reader
  `started(occurrence)` with its docblock.

`src/query-engine/raptor3/shared/operation-context.ts`

- `~` comment only: the member-boundary paragraph quoted the deleted slogan as
  its authority. It now names what actually holds that claim up —
  `Commands.isSeriesMember` stops the SIBLING scan at the series in both
  pairing walks (they still continue above it), so no member's read is ever
  placed against another member's write.

`src/query-engine/raptor3/AGENTS.md`

- `+` an addendum beside (not a rewrite of) the N1 paragraph whose last
  sentences stated the deleted rule.

## The rule deleted

The operation-global `Commands.expanded` latch, in all three of its parts — the
field, its set at the top of `expandSeries` (before the members even exist) and
its use as a refusal reason in `depend` — together with its justification, "Once
members are expanded nothing moves any more; a read placed by construction is
already behind every template write it may depend on", in the docblock, in the
guide and in `OperationContext`'s member-boundary comment. Moving the assignment
below the first loop was explicitly ruled insufficient and is not what was done:
no flag is set anywhere, and a second expansion inherits nothing, because the
question is asked of the ancestor, per pair, at the moment of the move.

No analysed template state is copied into admitted members; `expandSeries` still
builds each member from the admitted payload and still asserts that a series
occurrence is expanded exactly once.

## The second placement

One rule, now applied at every construction site the owner already has, each
with its own cell: the initial whole-tree analysis (unchanged — `update`), a
ROOT series expansion, a NESTED series expansion inside a running record, a
SECOND series expansion in the same operation, and a series expansion inside an
already-running member. The consumed-parent refusal, the branch arms and the
first-failure attribution are exercised in the member position by the same
cells.

## The limit that remains, and its coverage

`started(ancestor)` covers the pairs an expansion makes against the tree AROUND
the series (corrected in the repair round below): the per-member analysis walks
past the series to the enclosing record's own write and to the siblings ahead of
it, and `expandSeries`'s second pass pairs a member's writes with the reads
FOLLOWING the series — in either the consumer can sit in a phase the enclosing
record has already run, and re-placing it would reorder a `children` array that
`run` is consuming. In the shipped shapes that pair was already judged at
`analyze` time against the template's identical write, so the reader moved
before anything ran: **the limit is never reached by any executed test**
(measured, see `unverified`). It is kept because it is the only thing standing
between a future member write the template lacks and a schedule rewritten
mid-dispatch; the docblock says so at the cell.

## Capability change

Previously refused, now executed: an ordered observation inside a series member
— under root `updateMany`, under a nested `updateMany`/`deleteMany`, in the
second of two series, and in a series expanded inside a running member, on the
live and the batch-only route alike. Nothing new is refused. Unchanged:
admission and the replan scope, the consumed-parent refusal, cross-member
visibility (a member still claims the boundary the earlier member earned),
prepare-all-before-execute timing, acknowledged progress, recovery authority,
and the public refusal census.

## Registration (not applied — `scripts/raptor3-manifest.mjs` is not mine)

Add to `G4_PARITY_COUNTS`:

```js
  "tests/raptor3/g4/parity/fresh-member-placement.test.ts": 16,
```

Until it is added the file is discovered only by the `extended-local` project
glob: `receipts/after-green-raptor3-project.log` shows the `raptor3` project's
explicit include list, which does not contain it (0 tests collected there).

## Runs (no wide runs; one vitest at a time)

| File | Cells | Result | Receipt |
| --- | --- | --- | --- |
| `tests/raptor3/g4/parity/fresh-member-placement.test.ts` (base source) | 16 | 14 failed / 2 passed | `base-red.log` |
| `tests/raptor3/g4/parity/fresh-member-placement.test.ts` | 16 | passed | `after-green.log` |
| `tests/raptor3/g4/parity/ordered-observation.test.ts` | 39 | passed | `controls-n1.log` |
| `tests/raptor3/post-prep/g29-member-dependency.test.ts` | 14 (×2 projects) | passed | `controls-n1.log` |
| `tests/raptor3/post-prep/g29-dependency-choices.test.ts` | 10 (×2) | passed | `controls-n1.log` |
| `tests/raptor3/post-prep/g29-dependency-boundaries.test.ts` | 4 (×2) | passed | `controls-n1.log` |
| `tests/contracts/engine/query/nested-write-conformance-root-dependency.test.ts` | 30 | passed | `controls-root-dependency.log` |
| `tests/contracts/engine/write/parent-held-lookup.test.ts` | 56 | passed | `controls-write-contracts.log` |
| `tests/contracts/engine/write/supplier-continuation.test.ts` | 21 | passed | `controls-write-contracts.log` |
| `tests/contracts/engine/write/shared-pk-update-root.test.ts` | 71 | passed | `controls-write-contracts.log` |
| `tests/raptor3/g4/parity/lane-x-set-mutations.test.ts` | 10 | passed | `controls-series-neighbours.log` |
| `tests/raptor3/g4/parity/series-member-premise.test.ts` | 4 (×2) | passed | `controls-series-neighbours.log` |
| `tests/raptor3/g4/parity/member-boundary-packaging.test.ts` | 5 (×2) | passed | `controls-series-neighbours.log` |
| `tests/raptor3/g4/parity/blind-premise-attribution.test.ts` | 1 (×2) | passed | `controls-series-neighbours.log` |
| `tests/raptor3/core-structure/structural-reference.test.ts` | 10 (×2) | passed | `controls-core-structure.log` |
| `tests/raptor3/core-structure/member-scope.contract.test.ts` | 8 (×2) | passed | `controls-core-structure.log` |

Totals: 95 + 30 + 148 + 30 + 36 green cells in the controls, 16 green in the new
pin. The five files that ran in two vitest projects are counted once per project
by the runner. The four PGlite-family files ran one at a time through the
sanctioned shared-family launcher (2560 MiB isolated-provider ceiling); the
four-file batch under the ordinary 1536 MiB ceiling exceeded it and produced no
result — kept as `receipts/controls-conformance-rss-exceeded.log`.

How the controls were chosen: every test file that mentions both a bulk verb
and the `depends on an earlier …` sentence, plus the N1 owner's own pin file,
the `root-dependency` member of the six-file nested-write conformance family,
the four files named in the brief's grep list that are directly runnable, and
the g4 series/member neighbour family. The remaining grep hits are scenario
modules (`tests/raptor3/transitions/*.ts`, `tests/contracts/engine/write/*-behavior.ts`,
`tests/raptor3/scenarios/**`) that the mode runner composes, not files.

## Typecheck

`node scripts/run-typecheck.mjs` → **exit 0**, whole estate, native, 6.54 s,
5023.9 MiB peak sampled RSS. Receipt: `receipts/typecheck.log`.

## Census

`node scripts/raptor3-refusal-census.mjs` → **public refusals: 23 distinct
sentences at 30 sites**, 192 total sites — unchanged. Receipt: `receipts/census.log`.

## Biome

Per changed file, base copy (`git show HEAD:<file>`) vs after — identical
diagnostic sets, nothing introduced, nothing suppressed; the new test file is
clean (it was formatted with `node_modules/.bin/biome format --write`, which the
common rules allow for new files). Receipt: `receipts/biome.log`.

| File | base | after |
| --- | --- | --- |
| `commands/commands.ts` | 1 noParameterAssign, 1 noParameterProperties | identical |
| `commands/execution.ts` | 1 organizeImports, 1 noCommaOperator, 1 noParameterProperties, 1 useDefaultSwitchClause | identical |
| `shared/operation-context.ts` | 1 organizeImports, 4 noParameterProperties | identical |
| `g4/parity/fresh-member-placement.test.ts` | (new) | none |

## LOC

`node scripts/query-engine-structure.mjs`, whole engine perimeter:

| | before | after | delta |
| --- | --- | --- | --- |
| token-bearing lines | 16,036 | 16,039 | **+3** |
| lines | 20,333 | 20,361 | +28 |
| functions | 1,094 | 1,095 | +1 |
| branch nodes | 2,562 | 2,562 | 0 |

Honest accounting: this repair does not compress. It removes a two-line global
latch and spends five token lines on the fact that replaces it (a set, one
insertion, one reader) — net +3 token lines, +1 function, no new branch. The
remaining +25 lines are the docblocks that state the rule where it is enforced.
The capability bought is the whole ordered-observation family under every bulk
verb.

## Unverified

- **The limit `started(ancestor)` has no executed witness.** Instrumented
  (`console.error` on `!consumed && started(ancestor)`) across the new pin,
  `ordered-observation`, the three `g29-dependency-*` files and the two
  `core-structure` files: **zero hits**. Replacing the reader with `false`
  leaves all of those suites, plus `lane-x-set-mutations`, the g4 series
  neighbours, `nested-write-conformance-root-dependency` and
  `parent-held-lookup` green. The limit is kept on the argument stated in the
  docblock and above (the template pass covers the surrounding tree today;
  nothing else would stop a mid-dispatch reorder tomorrow). A reviewer who
  wants it gone should say so explicitly — it is a deliberate, named, currently
  unreached guard, not an accident.
- No native PostgreSQL or MySQL run, no Docker, no hosted provider. The
  "batch-only" route is the in-process `BatchOnlyDriver`, not a native batch
  transport. The PGlite control files ran on real PGlite.
- The frozen gate, the fixed lane, `g1-compare`, `g2-baseline` and the other
  five nested-write conformance files were not run (program rule: the
  integrator runs the gate once).
- No performance measurement: operations that used to refuse now execute, and
  their statement counts were not compared against the single-record verb.
- The in-place replay path (`CommandExecution.recover` → `complete`'s loop)
  re-runs the same tree; `entered` is never cleared, which can only make a
  replay more conservative. Not exercised by these files.
- `tests/raptor3/g4/parity/ordered-observation.test.ts` is itself not in any
  manifest count list (checked); that is pre-existing and not this unit's.

## Blockers

None. No public-contract change, no new recovery authority, no numerical
semantics touched.

## Repair round — 2026-09-21 (the reviewer's three findings)

Three findings, all COMMENT/DOC text: no engine behaviour, no test payload, no
cell count and no receipt of the first round is changed. The section sits here
rather than at the very end so the commit-message draft stays the note's last
section (program rule).

1. **`commands/commands.ts:957` — the `depend` docblock named one expansion
   pass; both expansion passes reach the limit's decision point.** Confirmed by
   reading the walk: `visitPrecedingWrites` (`:1266-1284`) recurses to the
   parent and runs `visitDirectWrites(parent, …)` BEFORE its
   `isSeriesMember(parent, target)` return (`:1278`), so the PER-MEMBER
   analysis pass (`expandSeries`'s first loop → `analyzeOccurrence` →
   `analyzeRead`) also pairs a member's read with the enclosing record's own
   write and with the siblings standing ahead of the series — an ancestor
   `CommandExecution.run` has already entered. The sentence now names both
   passes ("the pairs an expansion makes against the tree AROUND the series")
   instead of only `expandSeries`'s second, and the note's own section "The
   limit that remains, and its coverage", which repeated the same claim, was
   corrected with it. The rest of the paragraph, and the fact that no executed
   cell reaches the limit, are unchanged — the reviewer's own instrumentation
   found `follows` true at every one of those decision points, i.e. nothing
   fired.

2. **`shared/operation-context.ts:520` and `AGENTS.md:1098` — "stops both
   pairing walks at the series" stated a mechanism the code does not have.**
   `isSeriesMember` guards only the SIBLING loop of each walk (`:1278` in
   `visitPrecedingWrites`, `:1409` in `visitFollowingReads`); both walks then
   continue ABOVE the series (`visitPrecedingWrites` recurses into the parent,
   `visitFollowingReads` assigns `current = parent`). Both places now read
   "stops the SIBLING scan at the series in both pairing walks (they still
   continue above it)". The conclusion each sentence draws is untouched and
   still holds: no member's read is ever paired with another member's write, so
   the member that OBSERVES still claims the earlier member's boundary. The
   hunk list above, which quotes that comment, was corrected to match, and the
   three following lines of the `OperationContext` paragraph were re-wrapped
   because the replacement sentence has a different length (no text change).

3. **`note.md` and the ledger record claimed an assertion no cell makes.**
   True. In every placement cell the renamed row IS the row the member's later
   delete removes: the review case
   (`tests/raptor3/g4/parity/fresh-member-placement.test.ts:155-166`) asserts
   `{ count: 1 }` and `[["p2", "b"]]`, so no slug of the renamed row is read.
   Of the two remedies the finding offers, the REWORD was taken, in the note
   and in the g4 ledger record: "the returned count and the deleted row — the
   delete addresses that row by the slug the member's earlier write set, so the
   rename is what the deletion proves". The other remedy was not taken because
   it cannot be had without changing a payload — the delete is precisely what
   removes the renamed row, so a surviving renamed slug would need a second
   renamed post, and cell 1 would stop being the closure review's executed
   failure verbatim (cell 2 would stop being "the same payload"). What the cell
   proves is unchanged: the delete addresses the row by the NEW slug and would
   raise `NotFound` had the member's earlier write not been observed. The
   brief's "the post's slug" is met in that sense only, and is named here
   rather than papered over.

### Runs of the repair round

Comment-only, so only the one affected file was re-run (no control was
re-run, no wide family, no census — no refusal or error class was touched).

| File | Cells | Result | Receipt |
| --- | --- | --- | --- |
| `tests/raptor3/g4/parity/fresh-member-placement.test.ts` | 16 | passed (7.08 s wall, 506.3 MiB peak RSS) | `receipts/repair-after-green.log` |

`node scripts/run-typecheck.mjs` → **exit 0**, whole estate, native, 7.00 s,
4172.2 MiB peak sampled RSS, run after the LAST TypeScript change of this round
(only Markdown changed afterwards). Receipt: `receipts/repair-typecheck.log`.
The pin re-run above is on the final tree.

Biome, per re-touched file, base copy (`git show HEAD:<file>`) vs after —
identical diagnostic sets: `commands/commands.ts` 1 noParameterAssign +
1 noParameterProperties; `shared/operation-context.ts` 1 organizeImports +
4 noParameterProperties. Both working copies restored by `cp` and shasum-
checked against the copies taken before the comparison.

LOC, re-measured with `node scripts/query-engine-structure.mjs`: token-bearing
lines **16,039, unchanged**; physical lines 20,361 → **20,363** (the two extra
comment lines in `commands.ts`; `operation-context.ts` nets 0); functions 1,095
and branch nodes 2,562 unchanged. The round-1 LOC table above reports the
physical-line figure before this round.

## Commit message draft (the integrator commits)

```
fix(raptor3): place a fresh member's ordered observations, not an operation-global freeze (FC-01)

`Commands.expanded` was set at the top of `expandSeries`, before the members
existed, and `depend` read it as a reason to refuse an otherwise movable
observation — so the nested payload that executes under `user.update` was
refused under `user.updateMany` with "depends on an earlier … Split these
operations into separate queries". Its justification was false of the members:
template analysis places the TEMPLATE's occurrences, and `captureSeries` builds
each member afresh from the admitted payload, so a member's own reads had never
been placed by anyone.

The latch and its justification are gone. A placement is a position in
`ancestor.children`, so `depend` now asks the execution owner whether that
ancestor has begun dispatching them (`CommandExecution.started`, recorded where
`run` enters an occurrence). A freshly expanded member has not started and is
placed like any other subtree; a retained record already running its children is
not rescheduled underneath itself. Nothing is copied from the template into the
members, no flag is set, and a second expansion inherits nothing.

Unchanged: admission and replan scope, the consumed-parent refusal,
cross-member visibility, prepare-all-before-execute timing, acknowledged
progress and recovery authority. Public refusal census 23 sentences at 30 sites.

Pins: tests/raptor3/g4/parity/fresh-member-placement.test.ts (16 cells, live and
batch-only) — 14 red at 29a7bf9d8, all green here, the cycle control green on
both sides. Register it in G4_PARITY_COUNTS with 16.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
