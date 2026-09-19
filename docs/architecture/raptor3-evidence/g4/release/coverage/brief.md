# Release unit "coverage" — close the coverage gaps under the 100 % floors (brief)

Integrator: Fable. Worktree `/private/tmp/viborm-coverage`, branch `coverage`
from `54a34e05` (the CI lane's branch: the inventory rule, the isolation
registration and the validator fold are already in this tree).
`TMPDIR=/private/tmp/viborm-coverage-tmp`, always exported. Note, review and
receipts under `docs/architecture/raptor3-evidence/g4/release/coverage/`.

## The situation

`pnpm test:coverage` (what CI runs) stops at the first scope under its
floor. Measured on this tree: `public`, `schema`, `sql`, `instrumentation`
are at 100 %; `validation` is at 98.73 / 99.4 / 99.57 / 98.73 % against a
100 % floor; the remaining scopes (`extensions`, `errors`, `adapters`,
`cli`, `query-engine-core`, `write-engine`, `drivers`, `client`, `cache`,
`migrations`) are being measured by the integrator — run each yourself
(`pnpm test:coverage:<scope>`, focused mode writes
`coverage/<scope>/coverage-summary.json` and `coverage-final.json`) and
close every scope that is under its floor.

The validation gaps, from `coverage/validation/coverage-final.json`:

| file | lines | branches | uncovered statement lines |
| --- | --- | --- | --- |
| `src/validation/builder.ts` | 59.3 % | 90.9 % | 61-65, 127-161 and more (read the json) |
| `src/validation/parse-failure.ts` | 62.5 % | 50 % | 11, 23-30 |
| `src/validation/scalars/json.ts` | 80.5 % | 81 % | 133, 150-151, 164-192, 209, 225-226, 272-278 |
| `src/validation/model/args/aggregate.ts` | 99.4 % | 97.3 % | 872-873 |
| `src/validation/model/args/mutation.ts` | 99.4 % | 95.2 % | 80 |
| `src/validation/index.ts` | 100 % | 87.5 % | (branch arms) |

Why they exist: the parity program moved admission facts into
`src/validation` (the empty-filter refusals, the JSON string-path grammar
with its six refusals, `groupBy.by`, the default-only `skipDuplicates`
rule; `docs/architecture/raptor3-parity-plan.md` U1 and
`g4/parity/lane-q-note.md`) and pinned them with CONTRACT tests under
`tests/contracts/engine/query/parity-*.core.test.ts`, which run in the
`layer-query-engine` project — outside the `validation` coverage scope,
which measures only `tests/unit/validation/**`. Some blocks may instead be
dead since the retirement (`g4/pattern-retirement/note.md`): a block no
test reaches from any entry point is deleted, not covered.

## Required, per uncovered block

1. Say what it is: (a) an admission fact pinned by a contract test outside
   the scope — write the UNIT cell(s) in `tests/unit/validation/**` that
   exercise it directly, in the file that owns the neighbouring cells,
   same style, one cell per refusal or branch arm, asserting the registered
   message/class where one exists (never a made-up sentence); (b) reachable
   from an entry point but pinned nowhere — write the unit cell AND say so
   in the note (it was a gap before this program too); (c) unreachable from
   every entry point — delete it (rule: one guard per invariant; a check
   whose unique coverage cannot be named goes), with the reachability
   argument in the note and the typecheck proving nothing referenced it.
2. The scope reaches 100 % on every metric; `pnpm test:coverage:policy`
   stays green (a new test file may need registration — read
   `scripts/coverage-policy.mjs` and the policy test to find the one owner
   of the scope's file list).
3. Then the next scope, until `pnpm test:coverage` (all scopes) exits 0.
   Scopes whose floor is below 100 % and already met need nothing.
4. Never lower a floor; never add an ignore comment; never delete or
   weaken an existing test.

## Rules (binding)

The twelve rules of `docs/architecture/raptor3-evidence/g4/briefs/common.md`.
No patchwork. `npx biome check` on touched files, fixed by hand. The
whole-estate typecheck at zero (`node scripts/run-typecheck.mjs`). One
scope run at a time.

## Deliverables

- The unit tests (and deletions) at their owners.
- `docs/architecture/raptor3-evidence/g4/release/coverage/note.md`: per
  scope, per block: class (a/b/c), the cell(s) written or the deletion with
  its reachability argument, the before/after thresholds with receipts;
  the final `pnpm test:coverage` exit 0 receipt; LOC delta
  (`git diff --numstat 54a34e05 -- src tests`).
- The reviewer writes `.../release/coverage/review.md`: re-runs
  `pnpm test:coverage` whole, reads every new cell for a real assertion
  (not a smoke that merely executes the line), checks every deletion's
  reachability argument, and that no floor moved and no test weakened.
- Never commit, stage, reset, stash or push; never write outside the worktree.

## Scope notes added by the integrator (00:55, after measuring every scope)

Measured on the `ci` tree: `public`, `schema`, `sql`, `instrumentation`,
`extensions`, `cli` at 100 %; **red**: `validation` (above), `adapters`
(statements 99.7 %, functions 99.51 %), `errors` (branches 98.71 %),
`query-engine-core` (statements 55.12 % / branches 75.78 % / functions
70.19 % / lines 55.12 % against floors 98 / 97.9 / 98 / 98) and
`write-engine` (red; its root holds one file since the retirement);
`drivers`, `client`, `cache`, `migrations` still measuring — run them.

`query-engine-core` and `write-engine` are not unit-cell gaps: the scope's
test list still names the engine that was deleted, while the Raptor 3
engine's own tests live in `tests/raptor3/**` (the `raptor3` vitest
project, registered by `scripts/raptor3-manifest.mjs`; the parity pins in
`tests/raptor3/g4/parity/`). The fix is the scope DEFINITION, at its one
owner in `scripts/coverage-policy.mjs` (read the policy test for the
registration rules): the query-engine-core scope measures
`src/query-engine/**` through the engine's real test tree; the
write-engine scope, whose estate is one file, is folded into it or retired
with the reason stated. Then re-measure; if the measured coverage with the
real tests is still under the floor, close the remaining blocks as unit
cells or deletions as above — never by lowering the floor. Dead exceptions
that cite deleted files (`result-count-parser.ts`, `result-row-parser.ts`)
go. The parallel unit "followups" (F-3 in its brief) was told to leave the
floors and scope definitions to this unit and only report its measured
numbers; the integrator reconciles both at merge.

## Final scope table from the integrator's run (00:56)

| scope | result | figures |
| --- | --- | --- |
| public, schema, sql, instrumentation, extensions, cli | green | 100 % |
| client | green | 96.26 / 94.26 / 96.42 / 96.26 against 96 / 94 / 96 / 96 |
| cache | green | 99.92 / 99.74 / 100 / 99.92 against 98 |
| migrations | green | 98.69 / 97.33 / 100 / 98.69 against 98 / 97.3 / 98 / 98 |
| validation | **red** | 98.73 / 99.4 / 99.57 / 98.73 against 100 |
| adapters | **red** | 99.7 / 100 / 99.51 / 99.7 against 100 |
| errors | **red** | 100 / 98.71 / 100 / 100 against 100 |
| drivers | **red** | 95.94 / 92.41 / 96.1 / 95.94 against 96 / 92.5 / 96 / 96 |
| query-engine-core | **red** | 55.12 / 75.78 / 70.19 / 55.12 against 98 / 97.9 / 98 / 98 (scope definition, see above) |
| write-engine | **red** | one-file estate (scope definition, see above) |

Receipts of this run: `/private/tmp/viborm-ci/docs/architecture/raptor3-evidence/g4/release/ci/receipts/scope-*.log`
(read-only for you; copy what you cite into your own receipts).
