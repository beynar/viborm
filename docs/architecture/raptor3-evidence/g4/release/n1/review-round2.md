# Independent re-check — release unit "n1" (D-51, the ordered observation)

Reviewer: independent (second round), worktree `/private/tmp/viborm-n1` (branch
`n1`, base `e772741eb`, HEAD still `e772741eb`, nothing staged). Nothing under
`src/`, `tests/`, `scripts/` or `docs/` was edited except this file; the note
was read, not touched; nothing was committed, staged, stashed or checked out;
the main tree was neither written nor run in. Scratch:
`/private/tmp/viborm-n1-recheck-tmp` (TMPDIR for every run; probes and Biome
roots under it), one vitest process at a time, no lock refusal.

## Verdict: **ACCEPT**

The four findings of `review.md` are resolved, each by the narrowest change that
closes it, and the one that mattered is closed at the mechanism and pinned. The
placeholder `@RECHECK@` in §4 of `note.md` closes as: *re-check (Opus,
`review-round2.md`): ACCEPT — the major defect is repaired and covered by a pin
that provably exercises it; the three minors are resolved; no new defect found.*

---

## (1) The move, the walks, and the new pin — **resolved, and the pin bites**

`commands.ts:1227-1274`. The three recursive walks iterate a snapshot —
`for (const child of [...occurrence.children])` at the `record` (`:1235`),
`choose` (`:1259`) and `series` (`:1264`) arms — and the record arm carries the
comment that names why ("`depend` moves a dependent child within this array
while the walk is on it, and a sibling that shifts into the vacated slot must
still be analysed (N1)"). The refusal-propagation loop (`:1237-1255`) still
reads the live array *after* all children are analysed, which is correct and was
not to be changed; `selectedSeries` resolves its template by `find` before
recursing; `expandSeries` (`:1346`) already iterates a computed array. The three
spreads are the whole of the change to the pass.

Nothing else about the move changed: `depend` (`:880-975`) is the code
`review.md` quoted — the `writeAt` walk to the membership carrier, the
`producer`/`consumer` split, `follows` via `runsBefore`, the `consumed` guard,
then `splice` out, `placement = "after"`, the `landing` predicate
(`index <= producerIndex || candidate.placement !== "after"`, then
`order >= own`) and the re-insertion at `landing < 0 ? (producer ?
producerIndex + 1 : children.length) : landing`; and `place` (`:376-400`) still
sorts `parent.body` by `(origin.order, placement)`. Repo-wide, the only
mutations of `CommandOccurrence.children` are `depend`'s own splice pair
(`:954`, `:964`) and the two wholesale construction sites (`:423` recipe
children, `:1336` `expandSeries`), neither of which runs during the analysis
pass — so the snapshot can never analyse a child that has been removed.

The new cell — `tests/raptor3/g4/parity/ordered-observation.test.ts:511`, *"a
sibling behind a moved parent-held choice is still analysed: its own dependent
read observes on every route"* — **is my F2 shape**: one root `node.update`
whose own write is `containerId: 20`; the first parent-held to-one
(`container: { update: { nodes: { update … } } }`) is the choice that moves
behind that write (the cell above pins the move itself); the second
(`owner: { create: { …, first: { create: { id: 5, code: "X" } }, second: {
connect: { code: "X" } } } }`) is the subtree that carries the dependent read,
`second.connect` observing `first.create`. It is declared after the mover, so it
is the sibling that shifts into the vacated slot.

Its expectations are the contract's, on all three routes: the returned root row
`{ id: 1, label: "after", containerId: 20, ownerId: "o9" }` and
`owner.findMany() === [{ id: "o9", name: "Nine", firstId: 5, secondId: 5 }]` —
i.e. the connect resolved to the row the sibling create had just made, which is
exactly D-51's "they keep one result". The cell sits inside the three-route loop,
so live, batch-only and batch-only-without-index each assert it.

Two independent measurements that the pin is a real falsifier, not a
green-by-construction cell:

- **My probe F, re-run under `$TMPDIR` against the repaired engine** (round 1's
  file verbatim, its own schema `f_*`, plus the no-index route added): F1 (the
  subtree alone) and F2 (the same subtree behind the moving choice) now answer
  **identically on all three routes** — `firstId=5, secondId=5`, nothing thrown.
  At round 1 F2 rejected on the batch route with `Cannot connect relation
  'second': target record was not found.` while the live route resolved; that
  divergence is gone.
- **Prototype-wrapper instrumentation over the pin file** (setupFile under
  `$TMPDIR`, no source edited): the new cell is the **only** cell in the file
  whose move grows an index —
  `MOVED|… a sibling behind a moved parent-held choice …|choose idx 0->1 place
  before->after|siblings=record/before,choose/after` on each of the three routes
  (every other cell's move is `idx n->n`), which is the same line round 1
  printed for the defect; and the run reports **zero** `SKIPPED` children. So
  the cell exercises the exact mechanism, and the repair is what makes it green.

## (2) `flush`'s degenerate path — **resolved, and the final shape is the right one**

`operation-context.ts:1080-1092`. On the degenerate branch (`!usesBatch ||
queued.length === 0`) an **absence** premise is now checked there by its own
read and thrown as its own failure — `if (premise && !premise.present && (await
this.read(premise.query, true)).length > 0) throw premise.failure();` — which is
character for character what `requireAbsent` (`:1129-1137`) does when there is
no batch, i.e. the fact is checked by the same owner's own rule. A **presence**
premise is answered by the observation itself, and that is not a gap but an
identity: when nothing is passed in and the selection is required,
`runSelection` (`execution.ts:264-278`) builds that premise from
`selection.query()` — the same expression it hands `flush` as the projection —
so the premise's read *is* the projection's read, and an empty answer falls into
`if (!found) { if (selection.required) throw selection.required(); }`, the same
error the premise would have carried (`failure: required`). Nothing is dropped
and nothing is read twice.

That makes the fallback follow the fact rather than the capability, and it makes
`execution.ts:494`'s surviving `if (requirement && !premised)` sound:
`premised` (`:437-440`) is `requirement !== undefined && ctx.usesBatch &&
command.lookup.dependent === true`, which is exactly the condition under which
`runSelection` takes the `flush` branch and hands it the absence premise
(`outsideMembership`, `present: false`); and `flush` then either queues it as a
batch premise (`flushQueued`, `:1108-1110`) or checks it directly. Both paths, one
fact. The JavaScript check it retires is the equivalent one under a unique
selector (`inspectMembership` non-empty ⟺ `outsideMembership` empty for a
selector that names at most one row).

The integrator reports that the first shape — checking BOTH kinds on that path —
added a second read of the row the observation was already reading and broke the
CS-01 observation-count cells. I did not re-measure that red, but the cells
explain it and the code makes it inevitable: `CS-01 Selection observation
identity versus occurrence identity`
(`tests/raptor3/core-structure/structural-reference.test.ts:433`) asserts the
*statement sequence* (`["SELECT", "INSERT"]`) for one Selection placed twice, so
any extra read of the same row is a failure by construction. They are green on
the final shape (measured: 20 / 20 across the two projects). So the asymmetry is
not taste — it is the observation-identity contract: one observation, one read;
a premise the observation cannot answer gets its own.

## (3) The membership rule's literal disjointness — **resolved, and the wording licenses exactly the code**

`commands.ts:566-652` (the comment at `:570-580`). In the pairs loop the
write is marked `touchesMember` first and only then does
`if (command.fields.operation !== "create") continue;` skip the disjointness
test — so an UPDATE of a member-side key is always observed, and only a CREATE
can be disjoint. (Placing that `continue` before
`touchesMember = true` would have made an update of a member-side key not touch
the membership at all, the inverse defect; that is the misplacement
`receipts/probe7` caught, and the final code does not have it.) The
discriminator branch is guarded the same way (`if (command.fields.operation ===
"create")`). Since `Assignments.operation` is `"create" | "update" | "select"`
and the outer guard already requires `writtenFields().length > 0` for a
non-create, "UPDATE" is the only non-create the sentence has to name.

The comment and the guide sentence
(`AGENTS.md`: "a CREATE whose written literal for the member-side key … is null
or another parent's key makes no member of this parent and is disjoint, while an
UPDATE of that key may take a member out and is observed whatever it writes")
say precisely that, and the conservatism `review.md` measured is intact: the
disjoint arm still needs a literal (`literalOf`) *and* a known parent key
(`key !== undefined && !Object.is(value.value, key)`).

## (4) The pin file and the note's Biome sentence — **resolved**

- No inline regex remains: the two literals are top-level constants
  `MOVE_NODE` and `SELECT_CONTAINERS` (`:119-120`), used at `:403`/`:406`.
  `npx biome check tests/raptor3/g4/parity/ordered-observation.test.ts` →
  **"Checked 1 file in 9ms. No fixes applied."**, exit 0 (round 1: 2
  `lint/performance/useTopLevelRegex`).
- `receipts/biome.txt` is **correct**. I rebuilt the comparison myself — HEAD
  copies (`git show e772741eb:…`) and working copies of the seven changed source
  files at identical relative paths in two scratch roots with the project's
  `biome.jsonc`, `--max-diagnostics=500` — and my per-file, per-category counts
  are identical to the receipt's, line for line, and identical between HEAD and
  work for all seven files (see the table below). The note's §4 sentence now
  points at that receipt and says "seven", which matches
  `git diff --name-only e772741eb -- src` (7 `.ts` files + `AGENTS.md`).
- §4's one-line summary of the two moved cells now names both and names them
  right — the shared-PK batch cell from the V7006 floor to the correlated
  sentence through the ladder's blind premise, the transition-arm cell from the
  internal class to `NotFoundError` — which is what
  `receipts/estate/cells-vs-n3-head-final.txt:42-43` records and what §5 says.

## (5) `operation-context.ts` carries only the unit's hunks — **confirmed**

`git diff e772741eb --numstat` reports **71 / 7**, and `git diff -w` reports the
**same 71 / 7**: there is no whitespace-only line in the file's diff, so the
accidental whole-file format run is fully undone. The six hunks are exactly the
unit's: `ObservationPremise` (`@@ -142`), the `flush` overloads (`@@ -1035`), the
`flush` body with its comment and the degenerate-path check (`@@ -1051`),
`flushQueued`'s premise assertion (`@@ -1067`), the `mayCollide` extraction
(`@@ -1231`) and the blind-premise attribution (`@@ -1244`). Second, independent
confirmation from the formatter itself: the file's pre-existing `format`
diagnostic is still there, in both my HEAD and my working copy (1 `format`, 1
`assist/source/organizeImports`, 4 `lint/style/noParameterProperties`) — a
reformatted file would have lost it. (For the record, `commands.ts` 365/37 vs
338/10 and `execution.ts` 54/15 vs 49/10 under `-w` are re-indentations of
refusal-message blocks that moved into new structures, not churn; the other five
files are identical under both.)

## (6) The working tree — **exactly the unit**

`git status --untracked-files=all --porcelain -- src tests scripts` lists 8
`src` entries (the seven `.ts` files and `AGENTS.md`), 22 modified `tests` files
and the one untracked pin `tests/raptor3/g4/parity/ordered-observation.test.ts`;
**no `scripts/` entry at all**. Over the whole tree the only additions are
`docs/architecture/raptor3-evidence/g4.md`,
`docs/architecture/raptor3-nesting-and-refusals-plan.md` and the unit's own
`docs/architecture/raptor3-evidence/g4/release/n1/` (160 files, receipts
included, this one among them). `CONTEXT.md`, `memory.md`, `exa-results/`, the root
`transport-*-corpus.json` and every pre-G4 evidence archive are untouched;
nothing is staged; `HEAD` is still `e772741eb`.

---

## Two notes, neither blocking

1. **A precision in the note, not in the code.** §4 says "`flush`'s degenerate
   path (nothing queued) ignored the premise while the choose case trusted the
   capability — the premise is now checked directly on that path, by the same
   fact". Only the ABSENCE premise gets a direct check there; the PRESENCE
   premise is *answered by the observation* (same query, same failure), which is
   why the CS-01 counts survive. The code comment states this exactly; the note's
   sentence reads as if both were checked. Worth one clause if the note is
   touched again — it is not worth a round on its own.
2. **`runSelection`'s early return** (`execution.ts:246`, `if
   (attempt.rows.has(selection)) return;`) would skip both the premise and the
   retired JavaScript check when `premised` is true. I could not reach it and do
   not believe it is reachable: no path binds a `Choose`'s own `lookup`
   Selection before the choose runs (the only `rows.delete` is a *series
   member's* `located`, `:951`), and recovery installs a whole new
   `CommandAttempt` (`:47`), so rows never survive an attempt. Read from the
   code, not measured — the same disposition round 1 gave the `consumed` guard's
   missing `record` clause.

---

## What I ran

All runs in `/private/tmp/viborm-n1` with
`TMPDIR=/private/tmp/viborm-n1-recheck-tmp`, one vitest process at a time.

| # | Command | Expected | Measured |
| --- | --- | --- | --- |
| 1 | `node scripts/run-vitest-safe.mjs tests/raptor3/g4/parity/ordered-observation.test.ts` | 39 / 39 | **39 passed (39)**, 1 file, `RUN … /private/tmp/viborm-n1` |
| 2 | `pnpm test:all --only "Raptor 3 fixed"` | 796 / 796 | **796 passed (796)**, 69 files |
| 3 | `node scripts/run-typecheck.mjs` | 0 | **exit 0** |
| 4 | `node scripts/run-vitest-safe.mjs tests/raptor3/core-structure/structural-reference.test.ts` | green (the CS-01 cells) | **20 passed (20)** — 10 cells × `raptor3` + `coverage-raptor3` |
| 5 | `npx biome check` on the pin file | clean | **Checked 1 file. No fixes applied.**, exit 0 |
| 6 | Biome, my own HEAD-vs-work scratch roots, all 7 changed source files, `--max-diagnostics=500` | identical, and equal to `receipts/biome.txt` | **identical category by category**, and the receipt's counts reproduce exactly |
| 7 | Probe F re-run under `$TMPDIR` against the repaired engine, 3 routes | F1 == F2 on every route | **6 passed (6)**; `firstId=5, secondId=5` on live, batch-only and no-index |
| 8 | Prototype-wrapper instrumentation over the pin file (`$TMPDIR` setupFile) | the new cell moves a child by index; nothing skipped | **`choose idx 0->1 … siblings=record/before,choose/after`** on all three routes (the only index-growing move in the file); **0 SKIPPED** |
| 9 | `run-shared-family` (worktree-scoped copy) `…/nested-write-conformance-membership.test.ts` | 30 / 30 | **30 passed (30)** |
| 10 | same, `…/nested-write-conformance-m2m.test.ts` | 34 / 34 | **34 passed (34)** |
| 11 | `git diff e772741eb --numstat` / `git diff -w …` on `operation-context.ts` | 71 / 7 both | **71 / 7 and 71 / 7** |
| 12 | `git status --untracked-files=all --porcelain` (scoped and whole-tree) | only the unit | **only the unit**; nothing staged; `HEAD = e772741eb` |

### Run 6 — Biome, head vs work (my own measurement, matching `receipts/biome.txt`)

| file | HEAD | work |
| --- | --- | --- |
| `commands/assignments.ts` | 5 `style/noParameterProperties` | same |
| `commands/commands.ts` | 1 `style/noParameterAssign`, 1 `style/noParameterProperties` | same |
| `commands/execution.ts` | 1 `assist/source/organizeImports`, 1 `complexity/noCommaOperator`, 1 `style/noParameterProperties`, 1 `style/useDefaultSwitchClause` | same |
| `commands/relation-body.ts` | 1 `correctness/noUnusedVariables`, 5 `style/noParameterProperties` | same |
| `commands/selection.ts` | 1 `format`, 4 `style/noParameterProperties` | same |
| `shared/operation-context.ts` | 1 `assist/source/organizeImports`, 1 `format`, 4 `style/noParameterProperties` | same |
| `shared/query.ts` | 1 `assist/source/organizeImports`, 1 `format`, 4 `complexity/useSimplifiedLogicExpression`, 3 `correctness/noUnusedFunctionParameters`, 1 `correctness/noUnusedVariables`, 4 `style/noParameterProperties`, 2 `style/useDefaultSwitchClause` | same |

---

## Unverified

- I did **not** re-falsify the pin file at `e772741eb` this round (round 1 did:
  27 red / 9 green of 36). The new 13th cell's falsification is carried by run 7
  (the same payload, measured divergent at round 1, identical now) and run 8
  (the move it depends on), not by a base run.
- The note's other re-verification numbers were **not** re-measured here: the
  generated transitions 94 / 94, four of the six conformance files
  (root-dependency 31, transitive 28 / 30, `-fk` 27 / 28, to-one 19) and the
  touched SQLite files 211 / 211. I re-ran only membership (30) and m2m (34).
- The whole-estate comparison (`receipts/estate*`,
  `cells-vs-n3-head-final.txt`) was read, not re-run; the two moved cells were
  checked against the receipt's own lines, not re-measured.
- No Docker lane (MySQL 3307 / PostgreSQL 5434), no Neon HTTP, no D1 — the
  round-1 gap, which D-53 makes a per-driver claim.
- Coverage thresholds (`query-engine-core` 88.06 / 91.21 / 91.06 / 88.06) not
  re-run.
- Reachability of the two code-read observations above (`runSelection`'s early
  return; round 1's `consumed` guard missing `record` clause, `literalOf` under a
  `Choose` arm): still read from the code, not measured.
- The three cells the note leaves red in the touched files (`create root
  barrier` ×2, `createMany duplicate PK …`) were taken from the note's receipts;
  not re-measured at the base.
