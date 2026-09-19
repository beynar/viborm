# Release unit "followups" — F-1 to F-6 (note)

Author of the code: the Opus author, whose session ended on the account's
weekly limit on 18 September before a note was written (D-45). Author of this
note and of the F-3 scope work: the integrator (Fable), reconstructing every
claim from the diff (`git diff 383f830c`) and the author's receipts under
`receipts/`. Worktree `/private/tmp/viborm-followups`, branch `followups` from
`383f830c`; the CI branch and the D-46 branch are merged into it (they touch
`scripts/coverage-policy.mjs`'s expectations and the engine's upsert path,
which F-3's measurement needs).

## 0. Decision-elimination gate

Nothing behavioural changes in F-1, F-2, F-4, F-5 and F-6: they re-base a
measurement, move two files, close a stale note, delete files nothing
reaches, and move two retired design documents. F-3 changes what CI
MEASURES (the engine's own deterministic test tree joins the query-engine
coverage subsystem) and therefore the floors; the ruling that owns it is the
integrator's (recorded in `g4.md`, "Integrator decision", 00:50 on 18
September): never a lowered floor to fit a scope that measures the wrong
tests.

## F-1 — the census counts the engine

`scripts/measure-raptor3-baseline.mjs` `classify()` returned
`excluded-experiment` for `src/query-engine/raptor3/`; since the C-01 cutover
that tree IS the shipped engine. The branch is deleted, with the reason
stated in its place, and the typed parse boundary is no longer listed as a
charged file of its own (F-2 moved it under `raptor3/shared/`, where it is
counted once).

Measured (`receipts/census-f1-before.json`, `census-f1-after.json`):

| | charged files | charged token lines | of which `charged-engine` |
| --- | ---: | ---: | ---: |
| before F-1 | 48 | 11,733 | 3,960 |
| after F-1 | 63 | 23,245 | 15,472 |
| after F-1, with D-46 merged (the tree the review measured) | 63 | 23,344 | 15,605 |

The tool's headline after F-1 (23,245 against the frozen 49,887 = 0.466)
still includes the `charged-g3-prep-shared` class (3,940 token lines of
driver, adapter and schema-rule files the G3 preparation charged and the
frozen baseline never did). The like-for-like figures the ledger carries
stay the truth to quote, on the tree with D-46 merged
(`receipts/census-f1-after-d46.json`): `src/query-engine/**` 15,605 against
the old engine's 46,021 = **0.339**; with the client and adapter integration
files the baseline also charged, 19,438 against 49,887 = **0.390**.

## F-2 — the last boundaries under `raptor3/`

| moved | from | to | importers updated |
| --- | --- | --- | --- |
| the typed parse boundary | `src/query-engine/write-engine/parse-boundary.ts` | `src/query-engine/raptor3/shared/parse-boundary.ts` (rename, 97 % similar: the header names its new home) | `raptor3/shared/schema.ts` |
| the grouped-read field helper | `src/query-engine/operations/groupby-fields.ts` | `src/query-engine/result/groupby-fields.ts` (rename, identical) | `result/result-shape.ts` |

`src/query-engine/write-engine/` and `src/query-engine/operations/` are
gone. Documentation paths naming them were updated in eleven plans under
`docs/architecture/` and in `src/query-engine/AGENTS.md`, `README.md`,
`raptor3/AGENTS.md` and `tests/README.md`. Falsifier: the whole-estate
typecheck (a stale import or path fails it) and
`tests/contracts/engine/write/parse-boundary-gate.core.test.ts` and
`dead-symbol-gate.core.test.ts`, re-pointed at the new homes with their
assertions kept.

## F-3 — the coverage floors and the subsystem that owns the engine

What the author did: folded the `write-engine` coverage subsystem (its
estate was one file after the retirement) into `query-engine-core`, whose
`exceptRoot` for `write-engine/` went with it; carried its three coverage
projects over so nothing it measured stops being measured; removed the
branch exception naming `result-count-parser.ts` and `result-row-parser.ts`
(deleted at D-15); removed `src/standardSchema.ts` from the policy's
exclusions (F-5 deletes it). The author then set the floors to the measured
56.5 / 76.5 / 72 / 56.5, against the integrator's instruction — that
measurement ran the deleted engine's contract lists, not the engine's tests.

What the integrator did: `scripts/raptor3-manifest.mjs` now states the
`raptor3` vitest project once and splits it into its DETERMINISTIC half
(`RAPTOR3_DETERMINISTIC_TESTS`, 51 lists, runs under plain vitest) and its
RUNNER-ONLY half (`RAPTOR3_RUNNER_ONLY_TESTS`: the six seeded campaign files
and the three structural-measurement files, which need `run-raptor3.mjs`'s
environment and fail under a bare project run — measured,
`receipts/raptor3-project-plain.log`: 9 files red, 160 green in 21 s; the
CS03 support pair is split at file level, its campaign self-test with the
runner and `extension-recipes.selftest.test.ts` in the deterministic half —
the review caught the first cut listing both as runner-only);
`vitest.workspace.ts` builds the `raptor3` project from the union and a new
`coverage-raptor3` project from the deterministic half; the query-engine
subsystem lists that project as its fourth part, and the policy test expects
it. The floors are then the measured coverage with the engine's own tests,
rounded down to the half-point: **statements 87.38 → floor 87, branches 91.1 → 91, functions 90.48 → 90, lines 87.38 → 87** (`receipts/coverage-qec-with-raptor3-2.log`).
The measurement only completes once D-46 is in the tree (the subsystem's
third part carries the Neon upsert cell that D-46 repairs), which is why
that branch is merged here.

## F-4 — `meta.raceable` is read again

The retirement note's F-4 said the bit was written and never read. Since the
rulings unit's repair round, `OperationContext.submit`'s attribution arm reads
it (D-32: only a premise its owner marked raceable arms the batch re-plan).
The comments that still said the route "retries nothing" or that the bit is
never read were restated (`raptor3/AGENTS.md`, `raptor3/commands/relation-body.ts`,
`raptor3/shared/operation-context.ts`, `raptor3/shared/schema.ts`). Closed.

## F-5 — the unreachable files

Deleted, none reachable from any package entry point (the retirement note's
`reachability-before.json` listed them; the typecheck and `pnpm test:package`
prove nothing referenced them):

- the twelve `src/schema/scalars/*/index.ts` re-export shells (bigint, blob,
  boolean, datetime, decimal, enum, int, json, number, point, string,
  vector);
- `src/standardSchema.ts` (and its policy exclusion);
- `src/migrations/push/index.ts`, `src/migrations/storage/index.ts`.

Kept: `src/query-engine/raptor3/program/{index,program}.ts`, the retained
G1-01 comparison specimen the retirement note names; and two of the note's
nineteen that are unreachable from the package entry points but reachable
from the test estate — `src/migrations/push/executor.ts` (its
`generateDDLStatements` is imported by two migration unit tests) and
`src/standard-schema-spec.d.ts` (named by `tests/types/tsconfig.layer.json`
and the coverage policy) — retained for that reason, disclosed here. Tests re-expressed for
the deleted shells: `tests/unit/scalars/exports.core.test.ts` (the shells'
export cells removed with the shells; the scalar builders' own exports still
pinned), `tests/unit/migrations/utility-surface.core.test.ts` and the seven
migrations tests that imported through the deleted index files
(re-pointed at the modules themselves, assertions kept).

## F-6 — the retired design documents

`src/query-engine/write-engine/ATOM.md` and `README.md` described the
deleted engine and carried a RETIRED header. Moved to
`docs/architecture/retired/write-engine-ATOM.md` and
`write-engine-README.md`; the eleven plans citing `ATOM.md` now cite the new
path. The `write-engine/` directory is gone with F-2.

## Verification

- typecheck: 0 diagnostics (`receipts/typecheck-integrator.log`, on the
  author's tree; re-run on the merged tree: 0 diagnostics, `receipts/verify-typecheck.log`).
- the dead `test:coverage:write-engine` script in `package.json` and the
  dangling `@standard-schema` path alias in `tsconfig.json` (the author's
  fixes, committed with the review's resolutions);
- coverage: schema scope re-measured after F-1/F-5 (`receipts/coverage-schema-after.log`);
  query-engine-core with the engine's project: 87.38 / 91.1 / 90.48 / 87.38 against 87 / 91 / 90 / 87, green (`receipts/verify-qec.log`); `pnpm test:coverage:policy`: green (`receipts/verify-policy.log`).
- `pnpm test:package` 9/9, `pnpm package:lint` green (`receipts/verify-package*.log`).
- raptor3 modes `g2-baseline` 216/216, `g2-contracts` 216/216 (`receipts/verify-mode-*.log`).
- biome on the touched files: `receipts/biome-check-1.txt` (the author's
  run); after the integrator's edits every touched file carries no more diagnostics than its base (`receipts/verify-biome.log`; the 71 counted are `raptor3-manifest.mjs`'s pre-existing set).

## Cost

`git diff --numstat 383f830c -- src tests` on the author's tree: 64 files,
+340 / −2,226 (the twelve shells, the two index files, the two design
documents and the parse boundary's old home account for the deletions).

## Open

- The `raptor3/program` specimen: retained as the note says; whether it
  stays past the release is Arnaud's call.
- The census headline versus the like-for-like figure (F-1 above): the tool
  could report the frozen baseline's perimeter beside its own; not done here.

## Repair round (after the Sonnet review, REVISE → applied)

Five resolutions, all applied: the CS03 support pair split at file level
(160 deterministic + 9 runner-only, disjoint, union 169); the census
re-measured on the tree with D-46 merged (above); the two retained
unreachable files disclosed (F-5 above); the stale interim floors in
`src/query-engine/AGENTS.md` and `tests/README.md` replaced by the measured
ones; the author's `package.json`/`tsconfig.json` fixes committed. Re-run:
policy, typecheck, query-engine-core (below).

