# Lane X — independent review, round 2

Reviewer: independent agent, 2026-09-17. Worktree reviewed:
`/private/tmp/viborm-parity-x` (branch `parity-x`, base `356254a2`), TMPDIR
`/private/tmp/viborm-parity-tmp-x`. Read in full before touching anything: the
parity plan (`docs/architecture/raptor3-parity-plan.md`, D-17..D-24),
`g4/briefs/common.md` (the twelve rules), the worktree's
`src/query-engine/raptor3/AGENTS.md`, round 1's review
(`lane-x-review.md`) and the lane note's Round 2
(`lane-x-note.md:622-751`).

**Verdict: ACCEPT.** Both round-1 REVISE items are applied byte for byte and
nothing else moved. R1's restriction is pinned by a new cell that I falsified in
BOTH directions (wide replay reddens the nested-children half; no replay reddens
the membership half), R2 is verified by Biome against the base file rather than
by assertion, and every cell the lane repaired in round 1 is still green in my
own runs. Whole-estate typecheck: 0 diagnostics, exit 0.

---

## 1. The two resolutions, applied exactly

**R1** — `CommandExecution.adoptSuppressed`
(`/private/tmp/viborm-parity-x/src/query-engine/raptor3/commands/execution.ts:654-662`)
is now the hunk review §4 R1 prescribed, character for character:

```ts
    for (const child of record.children)
      if (
        child.placement !== "before" &&
        (child.command.kind === "link" ||
          child.command.kind === "remove" ||
          child.command.kind === "junction" ||
          child.command.kind === "membership")
      )
        await this.run(child, command);
```

The docblock above it now states the two shipped facts the restriction rests on
(`junction-create-many-routing.ts:76-84`, `OperationExecutor.ts:894`), both of
which I re-read at `ff5e77ca` in round 1. The change only ever NARROWS round 1's
replay toward the lane base, so it cannot introduce a behaviour round 1 did not
already have, and the two U6.6 provider falsifiers still pass (below).

**R2** — the `recover` guard (`execution.ts:199-206`) is the negated conjunction
review §4 R2 prescribed:

```ts
    if (
      !(
        choice &&
        error instanceof UniqueConstraintError &&
        this.matchesSelectedConstraint(choice, error)
      )
    )
      return false;
```

De Morgan-equivalent to round 1's disjunction with the same short-circuit order,
so `matchesSelectedConstraint` is still never reached without a `choice`.
Verified by Biome, not by assertion: `npx biome check` on the lane's
`execution.ts` reports exactly `assist/source/organizeImports`,
`lint/style/noParameterProperties`, `lint/style/useDefaultSwitchClause`,
`lint/complexity/noCommaOperator` — the same four rules `biome check` reports on
`git show 356254a2:src/query-engine/raptor3/commands/execution.ts` (only the
line numbers shift). The `lint/complexity/useSimplifiedLogicExpression` error
U6.4 had introduced is gone. The two new parity test files are Biome-clean.

**The new cell** — `writes a suppressed member's membership but not its nested
record children` (`tests/raptor3/g4/parity/lane-x-set-mutations.test.ts:416-463`)
asserts both halves: `existing.notes === []` and `note.findMany() === []` (the
children that must NOT be replayed) and `existing.boards === [1, 2]` (the
membership that must be). Registered: I evaluated
`scripts/credential-free-test-manifest.mjs` — `EXTENDED_LOCAL_TESTS` has 187
files and both `tests/raptor3/g4/parity/*.test.ts` are in it.
`scripts/raptor3-manifest.mjs` registers no file under `tests/raptor3/g4/parity/`
and `scripts/` is byte-identical to the base, so no manifest count moves.

**The guide** — `src/query-engine/raptor3/AGENTS.md` gains its sentence inside
the lane's OWN U6.6 paragraph ("The MEMBERSHIP, and only it: … replays the
membership kinds alone (`link`, `remove`, `junction`, `membership`)"). The whole
diff of that file is a pure append (`@@ -746,3 +746,121 @@`, 118 added / 0
removed): no other section was rewritten.

## 2. What I reproduced (my own runs, not the author's receipts)

| suite | project / scope | result | round-1 reviewed value |
| --- | --- | --- | --- |
| `tests/raptor3/g4/parity/lane-x-set-mutations.test.ts` | `extended-local` | **9 passed** | 8 passed (+1 new cell) |
| `tests/raptor3/g4/parity/lane-x-route-seam.test.ts` | `extended-local` | 3 passed | 3 passed |
| `suppression-replay` + `suppression-retry-contract` + `bulk-series-contract` | `raptor3` | 13 passed | 13 passed |
| `tests/raptor3/prep/native-suppression-replay.test.ts` | `raptor3-live-provider` (pg 55729) | 4 passed | not run in round 1 |
| `unique-races` + `recovery-boundaries` + `junction-races` (commands) | `raptor3-live-provider` (pg 55729) | 8 passed | 10 passed incl. staleness |
| `tests/providers/local/sqlite3-polymorphic-batch.test.ts` | `provider-sqlite3` | 7 failed / 142 passed / 1 skipped, `duplicate singular createMany targets transfer once` GREEN | identical |
| `tests/providers/local/sqlite3-nested-write.test.ts` | `provider-sqlite3` | 8 failed / 77 passed | identical |
| `tests/providers/docker/mysql2.test.ts` | `provider-mysql2` (Docker 55730) | 11 failed / 73 passed / 1 skipped, mysql2 transfer cell GREEN | identical |
| `select-mode-capability-matrix.core.test.ts` | `layer-query-engine` | 3 passed | 3 passed |
| whole-estate typecheck | `node scripts/run-typecheck.mjs` | **0 diagnostics, exit 0** | 0 |

The mysql2 failing-cell NAMES were compared line by line (`sort` + eyeball of
both lists) against the author's `round2-mysql2.log`: the eleven are the same
eleven (2 GeoPoint + 1 spatial-index + 4 polymorphic read + 4 namespace
containment) — all lane Q's U2.4/U4/U5.4 or the environment, none this lane's.
The sqlite3 residue is the same shape: empty-select and `by`-membership (lane Q
U3), polymorphic reads (U5.4/D-17), the JSON write envelope (U4), the nested
default-only `skipDuplicates` refusal handed to lane Q's U1.4.

I did not re-run the whole `provider-sqlite3` lane or `pg-nested-write-races`
this round: R1 and R2 are provider-independent, the two files inside that lane
that the R1 mechanism can reach (`sqlite3-polymorphic-batch`,
`sqlite3-nested-write`) reproduce round 1's numbers exactly, and the U6.4
recovery pins R2 rewrites are green on live PostgreSQL. The author's
`round2-provider-sqlite3.log` (56 failed / 699 passed / 1 skipped) and
`round2-pg-nested-write-races.log` (7 failed / 88 passed) stand as their
receipts; this is stated as a scope choice, not as something I verified.

## 3. Falsification — the new cell is a real pin in both directions

Both mutations were applied to `execution.ts` after copying it to the scratchpad
(`cp`, never `git checkout`), run, then restored from the backup; the file is
byte-identical afterwards, MD5 `2c780bafce2f2d1df9ed7dd7b14d0c3f` before and
after, and `git diff --numstat` is back to `101 21`.

| mutation | result |
| --- | --- |
| R1 reverted to the wide replay (`if (child.placement !== "before")`) | **1 failed / 8 passed** — only the new cell, failing on `existing.notes` with the `{ id: 90, body: 'stranded', cardId: 60 }` row the review measured |
| `adoptSuppressed` made a no-op (`if (record) return;`) | **1 failed / 8 passed** — only the new cell, failing on the `boards` membership assertion |

So the cell fails for the right reason on each side: it pins the membership
write U6.6 needs AND the nested record write R1 forbids, and it is the only cell
in the estate that does.

## 4. Nothing else moved

- `git status` is the same 8 modified files plus the untracked
  `tests/raptor3/g4/parity/` directory that round 1 reviewed; nothing staged,
  no commit, the main tree untouched.
- `git diff --numstat 356254a2` is now 668+/66- against round 1's 641+/63-. The
  six files round 2 must not touch are unchanged at
  `commands.ts 46/7`, `index.ts 23/3`, `relation-body.ts 104/1`,
  `operation-context.ts 261/32`, `storage.ts 5/1`,
  `select-mode-capability-matrix.core.test.ts 10/1` — 449+/45-, exactly round
  1's total minus what `execution.ts` + `AGENTS.md` may hold. The +3 deletions
  are accounted for in full by R2 rewriting three lines that round 1 left as
  context, and the +27 insertions by R1 (+7), the docblock (+8), R2 (+5) and the
  guide sentence (+7). No other hunk can exist inside those totals.
- File mtimes agree: only `execution.ts` (12:11:58), `AGENTS.md` (12:11:28) and
  `lane-x-set-mutations.test.ts` (12:05:11) changed after round 1's final
  receipts; the other five source files last changed at 11:42–11:44, when round
  1's own falsification exercise restored them, and their content still matches
  what that review verified (spot-checked `storage.ts`'s
  `forward = opposite === edge.endpoints[1]`, `index.ts`'s `prepareSingle`,
  `operation-context.ts`'s `attachRecovery`/`replaysInPlace` with no `usesBatch`
  in `recoveryRejection`, and the U8 sentence against
  `drivers/driver-transaction-base.ts:790/:979`).
- No test was deleted or weakened this round: the diff adds no `.skip`, `.only`
  or `todo(`, and the only removed test line in the whole lane is still U8's
  replaced sentence. The `1 skipped` in the two provider files is present at the
  base.

## 5. Notes (no action required this round)

- **N2 stands.** `AGENTS.md:587-592`'s "answers `undefined` unless the ownership
  is standalone AND the route is the physical batch" is still false after U6.4.
  The lane's own section carries an explicit "(This SUPERSEDES the earlier
  sentence …)", which is the right interim answer under "do not rewrite other
  sections", but the merge owner should still strike or annotate the original.
- **The `membership` arm of the R1 filter is unreachable.** Its one construction
  site (`relation-body.ts:146-150`) places it `"before"`, which the first
  conjunct already excludes, and its execution arm is a bare `return`. Harmless,
  prescribed verbatim by review §4 R1, and NOT worth another round — but if the
  estate's "no redundant guards" rule is applied at merge, `link`, `remove` and
  `junction` are the kinds that actually occur.
- **Import placement.** Round 1's `import type { TransportAttempt } from
  "../shared/transport-attempt";` sits after `./assignments`, against the file's
  `../shared/*`-then-`./*` order. `assist/source/organizeImports` already failed
  on this file at the base, so no diagnostic count moved and Biome cannot see
  the difference; a tidy-up belongs to whoever fixes that assist.
- **N1 (round 1) is unchanged**: `prepareSingle`'s floating `plan.run()` is still
  safe by construction, not by check.
- U6.5 remains an honest blocker, its reproducer red at the base as well, and the
  hand-overs to lane Q (U1.4's batch seam, the nested default-only
  `skipDuplicates` refusal, D-17's read cells) are still recorded as unshipped.

## 6. What must not change

The nine cells of `lane-x-set-mutations.test.ts`, the three of
`lane-x-route-seam.test.ts`, the sqlite3 and mysql2 `duplicate singular
createMany targets transfer once` cells, the 13 suppression/bulk-series cells,
the 12 live-pg cells (8 races + 4 native suppression replay) and the three
`select-mode-capability-matrix` cells are this lane's receipt at ACCEPT. The
estate typecheck is exit 0 with zero diagnostics; keep it there.
