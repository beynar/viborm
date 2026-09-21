# The integrated repair round — the consumption-boundary repairs

The round that follows the ONE integrated adversarial review of
`git diff bc18b4e23` on `closure-s`, before the frozen gate. The unit notes are
its siblings (`../u1/` … `../u5/`); this note records only what the integrated
review's findings changed.

> **Where this file lives.** The round's brief spells the directory
> `closure-sepair/integrated/`; the tree's directory — the one holding `u1`…`u5`
> and named by every unit note, the ledger and the guides — is
> `closure-repair/`. The brief's spelling is the workflow script's own
> `-r` → `-s` rename artefact (its `meta.name` and its reference to
> `raptor3-local-closure-sepair-prompt.md`, a file that exists nowhere, carry
> the same substitution), so the note is beside the units it belongs to.

## Integrated repair round (2026-09-21)

**Five findings — one major, four minor. All five applied; none declined.**
**No production source changed in this round**: `git status` lists two test
files, four documents (`AGENTS.md`, `src/query-engine/raptor3/AGENTS.md`,
`g4.md`, `../u1/note.md`) and this note's directory, and
`src/query-engine/raptor3/commands/execution.ts` is byte-identical to the tip
(`git diff --stat` on it is empty) after both falsifications were restored by
`cp` from `$TMPDIR/backup/`. The engine measures **16,185** token lines
(`scripts/query-engine-structure.mjs`,
[`receipts/06-engine-structure.log`](receipts/06-engine-structure.log)) —
the tip's own number, unmoved by this round; `src/query-engine/raptor3/AGENTS.md`
is 6 added / 6 deleted, so not even its line count changes.

### 1 (major) — the batch route does not state the third property

`src/query-engine/raptor3/AGENTS.md:1854` claimed the BATCH route "states these
same requirements as PREMISES", where "these" reaches back to a paragraph that
defines three properties, the third being that the effect spends the CURRENT
reference binding. That one is not stated there: `confirmFound` returns
`captured` untouched when `ctx.usesBatch`, and a PARENT-held `connectOrCreate`
binds through `folded`, which returns its argument unchanged for a
`connectOrCreate` origin (no found command is built for it, because
`RelationBody.association`'s `conditionalParentBinding` is undefined when the
SOURCE owns the reference). Confirmed by reading the three call sites; no
batch-route schedule was executed.

**Applied — the narrowing branch.** The sentence now states the identity, the
membership and the matched condition, the three the premises actually state,
and claims nothing about the fourth line of the rule. The batch-route schedule
is NOT added. The unverified half is recorded where the finding asked, as a new
entry in [`../u1/note.md`](../u1/note.md) §11, naming the route, the reason no
registered cell measures it, and the two files that would have to carry such a
cell.

### 2 (minor) — the D-65 initial-filter control's `driver.shape` pin

At `bc18b4e23` the cell "the initial filter selected the worklist and is not
re-asked at each member's own write" pinned `expect(driver.shape).toEqual([7, 6]);`
(base line 1162); the tip had dropped it, while U2's re-expression table says of
that cell "Every assertion is kept".

**Applied — the restoration branch** (`../u2/note.md` is untouched). The pin is
back at the base's position, immediately before the state assertions, at its
re-expressed value: `expect(driver.shape).toEqual([9, 8]);`
(`tests/providers/docker/pg-captured-set-concurrency.test.ts:1479`), the same
value its two siblings carry. The file is **28 / 28** green on native
PostgreSQL with it
([`receipts/03-pg-captured-set-green.log`](receipts/03-pg-captured-set-green.log)),
so the pin re-expresses rather than merely disappearing.

### 3 (minor) — the paste artefact in the gate-inventory paragraph

`AGENTS.md:714` read "asserted by no cell.core.test.ts\`. A stage's" — a
duplicated fragment of the file path on the line above and an unbalanced
backtick. Replaced by "asserted by no cell. A stage's", exactly as asked;
nothing else in the paragraph is touched.

### 4 (minor) — the cell count of `pg-captured-set-concurrency.test.ts`

`src/query-engine/raptor3/AGENTS.md:279` said "The file is 25 cells"; U3 added
three after that addendum was written and the file is 28. Changed to
"28 cells", and the run above measures 28 on the tree.

**One consequential word in the same sentence.** It continues "the two
`driver.shape` pins are `[9, 8]`". Finding 2 restores a third pin with that same
value, so the clause became false as a direct result of applying finding 2; it
now reads "the three `driver.shape` pins are `[9, 8]`". The two statements it
names (the first member's held requirement and its junction row) are unchanged.

### 5 (minor) — the coverage of `execution.ts:547`

`this.attempt.materialize(lookup.fields, row)` — the confirmation's re-binding
of the LOCATED selection — had no cell that distinguished it: deleting it left
the owner file 11 / 11 green.

**Applied — the naming branch. The deletion branch is refuted by measurement.**
The re-binding is not redundant with the `current` the same method returns;
they are two different bindings with two different consumers, and the one that
reads the located binding is reachable on exactly the route where `confirmFound`
runs:

- `OperationContext.update` returns `{}` before it reads anything back when the
  payload writes no column (`if (Object.keys(values).length === 0) return {}`),
  so the found record's own binding is empty;
- `Commands.update` builds that record's `Assignments` with
  `captured = located.fields`, so every value its children then read resolves
  through `CommandAttempt.read`'s `captured` fallback — the located binding;
- which is precisely the binding line 547 replaces with the confirmed row.

The cell that names it, added to the owner file beside the other placements and
key shapes: **"a found arm that writes no column of its own spends the CURRENT
reference through its child"**. A root `badge.upsert` whose `where` is the
unique `slug` probes unlocked and FINDS `b1(slug=chosen, code=G)`; its update
arm is a relation only (`holders: { create: { id: "h9" } }`), so it writes no
column of its own; B commits `b1.code = 'M'` and creates the decoy
`b2(slug=unselected, code=G)` in the one window both trees have — planted by the
file's existing `plantAfterUnlockedRead`, before the first statement after the
unlocked read that is not itself another unlocked read of that table. The
holder must carry `M`, the badge's current key, and no holder may carry `G`.

Falsified both ways, on a `cp` backup restored by `cp`:

| tree | the owner file | the new cell |
| --- | --- | --- |
| line 547 deleted | **1 failed / 11 passed** ([`receipts/01-materialize-falsification.log`](receipts/01-materialize-falsification.log)) | RED: `expected { id: 'h9', badgeCode: 'G' } to match object { badgeCode: 'M' }` — `h9` attached to the row that ACQUIRED `G` after the probe read it off `b1`, which is cell 1's defect reached through the other binding |
| unchanged tip | **12 / 12** ([`receipts/02-mysql-found-consumption-green.log`](receipts/02-mysql-found-consumption-green.log)) | green |

So the cell is the line's unique coverage — it is the only one of the twelve
that moves — and deleting the line would have reopened repair prompt §1.3 ("Spend
the authoritative current reference binding for that same identity") on a path
no cell covered. Under falsification the interactive-route neighbours stayed
green as well, which is what makes the coverage unique rather than merely
present: `sqlite3-found-consumption` 10 / 10, `sqlite3-nested-write` 170 / 170,
and the four write contracts `shared-pk-connect-or-create` 29,
`upsert-arm-referenced-edge` 18, `junction-upsert-arm-probe` 10,
`parent-held-lookup` 56 (console readings taken during the falsification pass;
not captured to receipt files).

**The counts the added cell moves**, updated so no record contradicts the tree:

| record | was | is |
| --- | --- | --- |
| `../u1/note.md` §7, the registration table | 11 | 12 (11 at that round, +1 here) |
| `../u1/note.md` §1 | 11 / 11 with its receipt | the same receipt, plus a sentence that the final tree is 12 cells |
| `../u1/note.md` §8, the runs table | 11 / 11 | 11 / 11 (12 / 12 after this round's cell) |
| `../u1/note.md` §14, the commit message draft | "11 cells: …" | "12 cells: …", the new witness named in the enumeration |
| `docs/architecture/raptor3-evidence/g4.md`, the U1 record's pins | "new, 11 cells, 11 / 11" | "new, 12 cells, 12 / 12", the new witness named |

`scripts/raptor3-manifest.mjs` is NOT edited: the file is registered in
`provider-mysql2` by the existing `tests/providers/docker/mysql2*.test.ts`
glob, so the twelfth cell registers itself.

## Runs

One Vitest at a time; one docker file per invocation; each connection string
was substituted into its own command from its file and never printed.

| run | result | receipt |
| --- | --- | --- |
| `mysql2-found-consumption.test.ts`, line 547 deleted (native MySQL) | **1 failed / 11 passed** — the new cell only | [`01-…`](receipts/01-materialize-falsification.log) |
| `mysql2-found-consumption.test.ts`, unchanged source (native MySQL) | **12 / 12** | [`02-…`](receipts/02-mysql-found-consumption-green.log) |
| `pg-captured-set-concurrency.test.ts` with the restored pin (native PostgreSQL) | **28 / 28** | [`03-…`](receipts/03-pg-captured-set-green.log) |
| `node scripts/run-typecheck.mjs` | **0 diagnostics, exit 0** | [`04-…`](receipts/04-typecheck.log) |
| `npx biome check`, the two changed `.ts` files | 2 files checked, **no diagnostics at all**, exit 0 — so none is new against the base copies | [`05-…`](receipts/05-biome-after.log) |
| `node scripts/query-engine-structure.mjs` | 16,185 engine token lines, unmoved | [`06-…`](receipts/06-engine-structure.log) |

No refusal census: this round changed no production source, so no refusal
sentence and no error class can have moved.

## What did not move

- **No production source.** `execution.ts` is byte-identical to the tip; both
  falsifications were applied to a `cp` backup and restored by `cp`. `git checkout`
  was not used, and nothing was staged, committed or formatted.
- **No test deleted, skipped, weakened or made permissive.** One assertion is
  RESTORED (finding 2) and one cell is ADDED (finding 5); every other cell,
  assertion and message is as the tip had it.
- **`../u2/note.md` is untouched**: finding 2's two branches are exclusive and
  the restoring branch was taken, which leaves that note's "Every assertion is
  kept" true again.
- **No second owner, no policy bit, no new mechanism.** The added cell reuses
  the file's own `plantAfterUnlockedRead` hook, its schema and its recording
  driver; the guide edits remove claims rather than adding rules.

## Unverified

1. **The CURRENT-reference half of the rule on the BATCH route** — the finding-1
   entry now in `../u1/note.md` §11. Nothing on this tree measures it; the guide
   no longer claims it.
2. **The registered inventory grows by one cell** in `provider-mysql2`
   (`mysql2-found-consumption.test.ts`, 11 → 12). The integrator derives the
   repaired tree's actual total at the frozen gate, as the repair prompt §5
   requires; `../u5/note.md`'s "771 if they pass" is the review's arithmetic on
   the REVIEWED tree and is not a claim about this one.
3. **Not run here**: every other registered project, the performance cells, the
   bundle footprint and the native inventories. This round re-ran only the files
   its findings touch, plus the interactive-route neighbours under falsification.

## Blockers

None.

## Commit message draft

The integrator squashes; these hunks belong with U1's and U2's commits, so this
is the sentence to fold in rather than a commit of its own.

```
fix(raptor3): the located binding's re-binding gets its witness, and the guides say only what the tree states

The integrated review of the consumption-boundary repairs returned five
findings. The batch route does not state the third property of the shared FOUND
rule — `confirmFound` returns the captured bytes there and a parent-held
`connectOrCreate` folds them into its holder's INSERT unchanged — so the guide's
batch sentence now names the three requirements the premises do state (identity,
membership, matched condition) and the current-reference half is recorded as
interactive-only in U1's note. The D-65 initial-filter control gets its
`driver.shape` pin back, re-expressed at `[9, 8]` like its two siblings, so the
cell keeps every assertion it had at `bc18b4e23`. Two counts that the tree
falsified are corrected (28 cells, three pins), and a paste artefact in the
gate-inventory paragraph is removed.

The fifth finding asked for `CommandExecution.confirmFound`'s re-binding of the
LOCATED selection to be covered or deleted, and measurement decided it: deleting
it reopens the reference-reuse defect through the other binding. A found arm
whose payload is a relation only writes no column, so `OperationContext.update`
returns before it reads anything back and every value its children spend
resolves through `Assignments.captured` — the located binding. The new cell
plants B's rekey and decoy in the file's one shared window and requires the
holder to carry the badge's CURRENT key; without the re-binding it carries the
key the decoy acquired, and it is the only one of the file's twelve cells that
moves.

Witness: `tests/providers/docker/mysql2-found-consumption.test.ts` 12 / 12 on
native MySQL 8 (1 failed / 11 passed with the re-binding deleted);
`tests/providers/docker/pg-captured-set-concurrency.test.ts` 28 / 28 on native
PostgreSQL with the restored pin. No production source changed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

The trailer follows this session's own attribution instruction, which differs
from the `Claude Fable 5.1` spelling in the lane's common rules — the same
discrepancy `../u5/note.md` §4 flagged. The integrator squashes; normalise to
whichever spelling the other units carry.
