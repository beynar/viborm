# U5 — qualification and provenance (§5's evidence half)

Base `bc18b4e23`. Worktree `/private/tmp/viborm-sv`, no database, no engine
change. This unit owns §5 "Qualification and provenance" of
`docs/architecture/raptor3-local-closure-repair-prompt.md`; §5's
ELEGANCE/duplication half is lane E's.

## The failing witness, red at base

The frozen gate enumerated its native MySQL lane with a shell glob
(`frozen-gate-r.sh` line 35: `tests/providers/docker/mysql2*.test.ts` plus
`tests/unit/migrations/mysql*docker*.test.ts`) and then reported the result as
the project's. Expanded on the reviewed tree that glob reaches **11** files;
`vitest.workspace.ts` registers **13** in `provider-mysql2`. The two it never
reaches are exactly the two the review named:

- `tests/contracts/engine/query/decimal-wide-arithmetic-docker.test.ts`
- `tests/unit/migrations/decimal-list-defaults-mysql-docker.test.ts`

At base nothing in the repository could answer "what does this project
register": the gate's list was the only enumeration and it was hand-written.
**After:** `node scripts/closure-final-inventory.mjs providers` prints
`provider-mysql2 … 13 file(s)` with both files in it, derived from the
workspace's own include patterns, and `… plan` prints the whole gate with a
file list for every stage that would otherwise be globbed. Receipts:
`receipts/witness-gate-glob-vs-project.txt`, `receipts/inventory-providers.txt`,
`receipts/inventory-plan.txt`.

## The continuing invariant and its single owner

**Invariant.** What a gate stage must run is what the Vitest project
registers — `vitest.workspace.ts`'s include patterns expanded against the test
tree — and never a second list written somewhere else.

**Owner.** `scripts/closure-final-inventory.mjs`. It parses the include arrays
out of `vitest.workspace.ts` and the `vitest.d1.config.ts` it names, resolves
`...MANIFEST_LIST` spreads to the manifest modules that own those lists, and
expands the literal patterns over `tests/**/*.test.ts`. It declares no path of
its own. Its one stated fact that no other file holds is which projects need a
connection string, and the environment variable is named, never read or
printed — the command runs nothing and needs no credentials.

**Second applicable consumer.** Two, both exercised:

1. `scripts/closure-final-index.mjs` §5 imports `inventory()` and `gatePlan()`;
   the index's per-project counts and the CLI's are one answer, falsified in
   `receipts/falsifications.log` mutation D (a mutation in the inventory moves
   the index's `provider-mysql2` row from 13 to 10 and back).
2. `provider-pg`, the other native lane, is derived by the same code path with
   no per-project special case (6 files, `receipts/inventory-plan.txt`).

The same module answers a second question the prompt asks: **executions are
not cases.** A file registered in two projects executes twice, so it reports a
stage's project executions and its declared cells in separate columns.

## The corrections

1. **Cost classification** (`closure-final/release-verdict.md`, a dated note
   under **Cost.**, no existing sentence rewritten). The parenthetical "the
   MySQL introspector repair is charged-integration" is wrong:
   `receipts/source-size-final.json` classifies
   `src/migrations/drivers/mysql/introspect.ts` as
   **`excluded-shared-boundary`** (371 token lines) and `recount.json` puts
   R2a's diff of it in that same bucket. Its cost is kept visible on its own:
   **+110 / −49** over `61c745f49..50ad4fac4`, inside the 202/89 the recount
   reports for that unit's six excluded-shared-boundary files. 16,098 / 19,956
   / 23,891 are unchanged — the parenthetical mis-named a class, it did not
   enter a sum. Receipt: `receipts/introspector-classification.txt`.
2. **The native MySQL lane's coverage** (dated note beside the validation
   block). 735 passed / 1 skipped is accurate for the eleven executed files and
   is not the whole registered project. No new total is asserted: the next
   gate derives its own inventory and reports what it executed. The review's
   35 + 1 cells for the two absent files are quoted as the review's, not
   re-measured here (this unit opened no database).
3. **Parity 527.** It is executed cells across **55 project executions** of
   **31** files, not 527 declared cases: 24 of those files are registered in
   both `raptor3` and `coverage-raptor3`, 7 in one project only. The distinct
   declared cases are **300** — the 227 `G4_PARITY_COUNTS` declares for the 24
   files it names plus 73 in the 7 files no declared-cell map covers. Both
   readings come from the retained `logs/parity-{1,2,3}.log` and are
   cross-checked by the inventory's independent count of the same 31 files and
   55 executions. Nothing was rerun. Receipt:
   `receipts/parity-execution-derivation.txt`.
4. **Provenance** (`closure-final-index.mjs` §1). The index now records the Git
   TREE object ids of the commit and of `src`, `tests`, `scripts` and
   `benchmarks`; the sha256 of `package.json`, `pnpm-lock.yaml`,
   `tsconfig.json`, `tsdown.config.ts`, `biome.jsonc`, `vitest.config.ts`,
   `vitest.workspace.ts` and `vitest.d1.config.ts`; and the identity of every
   retained `closure-review-*` directory (file count plus a sha256 over its
   sorted (path, file sha256) pairs). Each digest is printed with its own
   scope AND algorithm, and the markdown says in words that a SHA-1 Git object
   id and a sha256 over file bytes are not one harness identity. Tree equality
   is what supports "the squash changed nothing under those paths"; the
   manifest digest does not reach a native entry file or an imported fixture
   and no longer pretends to. Verified against `git rev-parse` independently
   in `receipts/falsifications.log`; the review-directory line was exercised by
   copying the retained review into the worktree, assembling, and removing the
   copy (`retainedReviews`: 9 files,
   `2cbd489547248af7711362bf3430e07862801336b8dc99e0d10b3a029309f7ce`).

## What disappeared

**No deletion in the tree.** The check that disappears is the integrator's
hand-written MySQL glob, which lives in the gate script outside the repository;
its replacement inside the repository is step 0 of the checkpoint README
(`node scripts/closure-final-inventory.mjs plan` / `providers`). One
duplication the new module would otherwise have created was removed instead of
shipped: `MANIFEST_MODULES` is exported by the inventory and imported by
`closure-final-index.mjs`, which no longer keeps its own copy of that list.

## Cost

No file under `src/` is touched, so nothing charged moves.

| reading | before | after |
| --- | --- | --- |
| `node scripts/query-engine-structure.mjs` `queryEngine.tokenLines` | 16,098 | **16,098** |
| like-for-like (integration) | 19,956 | **19,956** (untouched) |
| charged perimeter | 23,891 | **23,891** (untouched) |

`git diff --numstat bc18b4e23` (`receipts/numstat.txt`): `AGENTS.md` +15,
`raptor3-evidence/g4.md` +46, `closure-final/README.md` +25,
`closure-final/release-verdict.md` +52,
`scripts/closure-final-index.mjs` +236 / −13; new
`scripts/closure-final-inventory.mjs` (556 lines) and this unit's directory.
`scripts/**` and `docs/**` are excluded non-production roots in the
measurement file's own accounting, so none of this enters the charged
perimeter.

## Runs

| run | result |
| --- | --- |
| `node scripts/closure-final-inventory.mjs providers` | exit 0; `provider-mysql2` **13**, `provider-pg` **6**, `provider-postgres` 4, `provider-pglite`/`sqlite3`/`libsql` 6 each, `provider-neon-http` 2, `provider-planetscale` 1, `provider-transaction-options` 1, `provider-bun` 2, `provider-d1` 1 |
| `node scripts/closure-final-inventory.mjs plan` | exit 0; **16 stages**; `parity` 31 files / 55 project executions, `conformance` 6, `pglite-provider` 3, `native provider-mysql2` 13, `native provider-pg` 6; **83** tree files in no project, every one of them under `tests/raptor3/g4/review/` — the review-scratch directory `scripts/credential-free-test-manifest.mjs` deliberately excludes, so the list is currently all signal-free and any new entry is a real omission |
| `node scripts/closure-final-inventory.mjs credential-free` | exit 0; the three unkeyed file stages with their lists |
| `node scripts/closure-final-index.mjs --gate …` (dry run over the retained gate directory, output written outside the repository) | exit 0; 38 stages, 0 summary stages without a log, 663 manifest-named test files (664 after the repair round's one registration) |
| `pnpm test:coverage:policy` | exit 0; 11 + 16 + 6 + 7 = **40 passed / 0 failed** |
| Falsifications (`receipts/falsifications.log`) | 4 mutations, each moves the answer, each restored by `cp` from `$TMPDIR` |

No test file was added, deleted, weakened or skipped; no vitest run and no
database were used by this unit.

**Typecheck.** `node scripts/run-typecheck.mjs` exit 0, **0 diagnostics**
(`receipts/typecheck-after.log`).

**Census.** Not run and not required: this unit changes no refusal sentence and
no error class.

**Biome.** `npx biome check` over each changed source file, exit 0
(`receipts/biome-after.txt`). The base copy of `closure-final-index.mjs`
carried no `format` diagnostic, so it was safe to format; the inventory module
is new. The three Markdown files are outside Biome's configured scope.

## Guide

Two addenda, each beside the paragraph it corrects, plus one durable rule:

- `AGENTS.md`, after the manifest-admission paragraph: a qualification gate
  enumerates a Vitest project BY THE PROJECT, never by a shell glob; the
  inventory commands; the executions-are-not-cases rule.
- `closure-final/README.md` item 1: the addendum naming the tree ids, the
  config digests, the review identity and the scope/algorithm rule.
- `closure-final/README.md` item 5: the addendum explaining that section 5 now
  leads with per-project registration and the gate plan, and why a manifest
  list count and a project file count are different numbers.
- `closure-final/README.md` "Producing it": a step 0 that runs the inventory
  before the gate.

## Unverified / for the integrator

1. **The two omitted files are still unexecuted.** This unit proves they are
   registered and were not run; it did not run them (no database in this lane).
   The 35 + 1 cells and the arithmetic "771 if they pass" are the review's.
2. **The new falsifier files** of lanes M and the updated
   `pg-captured-set-concurrency.test.ts` are not in this worktree. They need no
   change here: `tests/providers/docker/mysql2-found-consumption.test.ts`
   matches `provider-mysql2`'s existing `tests/providers/docker/mysql2*` pattern
   and will appear in `plan` and `providers` automatically once it exists. A
   falsifier placed OUTSIDE every include pattern will appear in the plan's
   "no workspace project registers" list rather than pass unnoticed — the
   integrator should read that list before freezing.
3. **`scripts/raptor3-manifest.mjs` was not edited** (the brief forbade it).
   Registrations at the first round: none. The repair round adds exactly one,
   in `scripts/query-engine-test-manifest.mjs` —
   `tests/contracts/architecture/gate-inventory-census.core.test.ts`, 2 cells;
   see the Repair round section.
4. **Commit attribution.** The trailer below follows this session's own
   attribution instruction (`Claude Opus 5 (1M context)`), which differs from
   the `Claude Fable 5.1` spelling in the lane's common rules. The integrator
   squashes; normalise to whichever spelling the other units carry.
5. **`benchmarks/**` untouched**, as required; `scripts/closure-final-recount.mjs`
   untouched; no protocol path changed.

## Blockers

None.

## Repair round (2026-09-21, after the independent review of this unit)

Three minor findings, all applied. No engine file, no database, no test
deleted, weakened or skipped.

### 1. `closure-final-index.mjs:325` — the retained-review line found nothing

**Red at base.** `REVIEW_PREFIX` was `"closure-review-"`. The directory tracked
at `bc18b4e23` is the bare
`docs/architecture/raptor3-evidence/g4/release/closure-review` (tree
`177502466495c5702113ab560f0ce900378f5d1b`, 3 files), so the trailing hyphen
excluded it and section 1 printed "No retained review directory sits beside
this checkpoint" while the directory it was about sat two levels above the gate
being indexed — the one sentence in the provenance section that was not true of
the tree.

**After.** `REVIEW_PREFIX = "closure-review"`, which is the prefix both
spellings share, and the rest of the block is unchanged. The index now prints
`docs/architecture/raptor3-evidence/g4/release/closure-review`, 3 files,
`49e0aee0876882eb68c6ec6f64102b4b31a872c88c0ac6e33b53943c05ec0762`. The
`closure-final/README.md` item 1 addendum said "each retained
`closure-review-*` directory", a pattern with the same hole, and now names both
spellings. Receipt: `receipts/repair-round-retained-review.txt` (base copy's
sentence, repaired table, and the `git ls-tree` the two are checked against).

### 2. `closure-final-inventory.mjs` — the symmetric omission was unreported

**Red at base.** `plan` listed the files NO project registers and nothing else,
so the failure class this unit exists to prevent — a file a project DOES
register and no stage runs, which is exactly the eleven-of-thirteen lane — was
still invisible for every project outside the two native ones.

**After.** `stageCoverage(current, plan)` derives, per project, which stages
cover its registered files and how many none covers, from `projectsByFile`
minus the union of the stages' file lists; `reportPlan` prints it beside the
unregistered list. It restates no path: 868 registered files, 124 covered, 744
not; `provider-mysql2` 13 covered by `native provider-mysql2`, 0 uncovered;
`provider-pg` 6 and 0; `raptor3-provider` 8 with 3 covered by
`pglite-provider` and 5 by no stage this plan enumerates — the
`G1_PROVIDER_TESTS` / `G1_PROVIDER_BASELINE_TESTS` files the review named,
which `scripts/run-credential-free-tests.mjs` runs under labels of their own
that the gate's `--only "Raptor 3 fixed"` filter does not select, so a witness
appended to either list would be registered, printed here, and run by no gate
stage.
Receipt: `receipts/plan-stage-coverage.txt`.

Two things were needed to keep the new list true, and nothing else was added:

- A `command` stage that NAMES its owner has its coverage resolved from that
  owner's list — the `fixed` stage already carried
  `scripts/credential-free-test-manifest.mjs RAPTOR3_FIXED_LOCAL_TESTS`, and
  the symbol is resolved through the same manifest modules the include spreads
  use (`inventory()` now returns its `lists` map for that). Without it the
  report would have said 89 files the gate demonstrably runs are covered by
  nothing, which is the same class of false sentence as finding 1.
- A `runner-mode` stage's files stay owned and count-asserted by
  `scripts/run-raptor3.mjs`'s mode table, which this module still does not
  restate, so the section says in words that those files are counted as covered
  by no enumerated stage rather than implying the gate skips them.

A stage whose owner symbol stops resolving is not silently absorbed: its
coverage drops to zero in the same printout that names the symbol on the
stage's own line (falsification R5).

### 3. A registered cell, so the repaired invariant is not a manual receipt

`tests/contracts/architecture/gate-inventory-census.core.test.ts` (**2 cells**),
admitted in `scripts/query-engine-test-manifest.mjs`'s `QUERY_ENGINE_CORE_TESTS`
beside the other architecture censuses:

1. `provider-mysql2`'s registered file set contains
   `tests/contracts/engine/query/decimal-wide-arithmetic-docker.test.ts` and
   `tests/unit/migrations/decimal-list-defaults-mysql-docker.test.ts`.
2. every entry of `inventory().unregistered` starts with
   `tests/raptor3/g4/review/`.

**Where it is admitted, and the one part of the finding not followed
literally.** The finding asked for a `tests/contracts/architecture/*.core.test.ts`
admitted through `scripts/credential-free-test-manifest.mjs`. Those two cannot
both hold in this estate: that module's walk excludes every `.core.test.ts`
(`EXTENDED_LOCAL_TESTS`), and `core-taxonomy-census.core.test.ts` enforces that
each `.core.test.ts` lands in exactly ONE `layer-*` project while
`scripts/coverage-policy.test.mjs` ("query coverage admits every core contract
exactly once") requires the architecture directory's core files to equal
`QUERY_ENGINE_CORE_TESTS` exactly. Admitting the file anywhere else would turn
both of those red. The finding's actual constraint is met: the cell is
credential-free and is NOT a raptor3 mode cell (`scripts/raptor3-manifest.mjs`
is untouched, as the brief requires). `pnpm test:core` runs it, and
`pnpm test:all` runs `test:core`, so the gate's credential-free half executes
it with no flag.

### Falsifications (`receipts/repair-round-falsifications.log`)

| # | mutation | result |
| --- | --- | --- |
| R1 | base copy of `closure-final-index.mjs` (`"closure-review-"`) | index §1 prints "No retained review directory"; repaired copy prints the directory, 3 files, its sha256 |
| R2 | drop `decimal-wide-arithmetic-docker.test.ts` from `providerProject("mysql2", …)` | both cells red; cell 1 names the missing registration, cell 2 names the now-unregistered file |
| R3 | a witness added where no project registers it (`tests/providers/docker/zz-unregistered-probe.test.ts`) | cell 2 red and names it; cell 1 stays green |
| R4 | a native stage that runs all but one of its project's files | `provider-mysql2` 12 covered / 1 uncovered, `provider-pg` 5 / 1, total 122 |
| R5 | the `fixed` stage's owner symbol misspelled | `raptor3` drops to `parity 24`, 169 uncovered, total 59 |

Each mutation was made on a copy kept in `$TMPDIR` and restored by `cp`; the
probe file of R3 was removed. `git status` after the round shows only this
unit's own files.

### Runs (repair round)

| run | result |
| --- | --- |
| `--project=layer-query-engine gate-inventory-census.core.test.ts core-taxonomy-census.core.test.ts contract-matrix.core.test.ts` | exit 0, **11 passed** (2 + 4 + 5); `receipts/repair-round-cells.log` |
| `pnpm test:coverage:policy` (the manifest changed) | exit 0, 11 + 16 + 6 + 7 = **40 passed / 0 failed**; `receipts/coverage-policy-repair-round.log` |
| `node scripts/closure-final-inventory.mjs plan` / `providers` / `credential-free` / `json` | exit 0; the per-project counts are unchanged except `layer-query-engine` 32 → **33** |
| `node scripts/closure-final-index.mjs --gate <retained gate> --out <outside the repository>` | exit 0; retained review table present; "test files a manifest names" 663 → **664** |
| `node scripts/run-typecheck.mjs` | exit 0, **0 diagnostics**; `receipts/typecheck-repair-round.log` |
| `npx biome check` on each changed file | exit 0; `receipts/biome-repair-round.txt` |

**Cost.** Still no file under `src/`: `queryEngine.tokenLines` 16,098, the
like-for-like 19,956 and the charged perimeter 23,891 are untouched, and
`scripts/**` and `tests/**` are excluded non-production roots in the
measurement file's own accounting. Against `bc18b4e23` the unit now stands at
`AGENTS.md` +21 (+6 this round), `raptor3-evidence/g4.md` +59 (+13),
`closure-final/README.md` +27 (+2), `closure-final/release-verdict.md` +52,
`scripts/closure-final-index.mjs` +240 / −13 (+7 / −3),
`scripts/query-engine-test-manifest.mjs` +1 (new this round), the new
`scripts/closure-final-inventory.mjs` at 639 lines (556 + 83) and the new
66-line `tests/contracts/architecture/gate-inventory-census.core.test.ts`.

**Census.** Still not required: no refusal sentence and no error class changed.

**Blockers.** None.

## Commit message draft

```
chore(raptor3): the gate enumerates its projects, and the provenance says what each digest covers

The final local closure's gate globbed its native MySQL lane by hand and ran
eleven of `provider-mysql2`'s thirteen registered files, then reported 735
passed as the project's result. A second list of the same fact is what made
that possible, so this adds none.

`scripts/closure-final-inventory.mjs` derives what a gate must run from the
files that already declare it: the include patterns in `vitest.workspace.ts`
and the D1 config it names, with `...MANIFEST_LIST` spreads resolved to the
manifest modules that own them, expanded over the test tree. `providers`
prints each provider project's registered list, `plan` every stage with its
files, `credential-free` the unkeyed file stages. It runs nothing, needs no
credentials and names the connection-string variables without reading them.
It also lists test files no project registers, so a witness placed outside
every include pattern is visible instead of quietly unrun.
`closure-final-index.mjs` imports it for section 5 — one answer, not two — and
gives up its own copy of the manifest-module list.

Provenance: the index records the Git TREE ids of the commit and of `src`,
`tests`, `scripts` and `benchmarks`, the sha256 of the config and lockfiles,
and the identity of each retained `closure-review-*` directory, each with its
own scope AND algorithm stated. A SHA-1 Git object id and a sha256 over file
bytes are not one harness identity, and tree equality — not the narrower
manifest digest, which reaches no native entry file or imported fixture — is
what supports "the squash changed nothing under those paths".

Dated corrections to the closure verdict, beside the paragraphs they correct,
rewriting nothing: the MySQL introspector is `excluded-shared-boundary`, not
`charged-integration`, its cost kept visible at +110/-49 over R2a; 735 passed
/ 1 skipped is the eleven executed files, not the registered project; and
parity 527 is executed cells across 55 project executions of 31 files, whose
distinct declared cases are 300.

The review of this work found three more, all applied. The retained-review
prefix carried a trailing hyphen, which excluded the tracked bare
`closure-review` directory and printed "No retained review directory sits
beside this checkpoint" over it. `plan` reported which files no project
registers but not the symmetric omission, so it adds one derived list: per
project, which stages cover its registered files and how many none covers (867
registered, 124 covered, both native projects complete), with a `command`
stage's coverage resolved from the owner symbol that stage already names and
the runner modes' own mode table left unrestated and said to be uncounted. And
the repaired invariant stopped resting on a printout a human reads:
`tests/contracts/architecture/gate-inventory-census.core.test.ts`, two cells
admitted in `QUERY_ENGINE_CORE_TESTS`, asserts that `provider-mysql2` registers
both files the glob missed and that every unregistered test file is review
scratch — a witness landed outside every include pattern now turns it red.

No engine change: `queryEngine.tokenLines` stays 16,098, the like-for-like and
charged perimeters are untouched. Typecheck 0 diagnostics, coverage-policy
40/40, the new cell and its two neighbouring censuses 11/11, nine
falsifications in all (four in the first round, five in the repair round), each
moving the answer and each restored.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```
