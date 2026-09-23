# Release unit "followups" — independent review

Reviewer worktree: `/private/tmp/viborm-followups` (branch `followups`, HEAD
`4a3a989a9`, base `383f830c`). Scope: the follow-ups' own commits `b1ea227b9`
and `4a3a989a9`, excluding the merged `ci`/`d46` work and the g4 evidence
trees. Receipts under `receipts/` are the author's/integrator's; receipts
under `review-receipts/` are mine, produced in this pass with
`TMPDIR=/private/tmp/viborm-followups-tmp-r`.

## Verdict: REVISE

No patchwork, no weakened or deleted-to-go-green tests, and no undisclosed
behaviour change were found. The work is substantively sound and every
numeric claim I could reproduce, reproduced. What's below are five concrete,
minimal-resolution gaps — one real classification bug in the F-3 test split,
two documentation/accounting completeness issues, one stale-figures issue,
and two dangling references in the committed package.json/tsconfig.json
(for which a correct uncommitted fix already sits in the worktree) — plus
informational notes on pre-existing, unrelated failures a reader would
otherwise trip over. None of them touch behaviour, none lower a floor to fit
the wrong tests, and none require re-opening the "no patchwork" question.

## Findings

### 1. [F-3, MODERATE] `RAPTOR3_RUNNER_ONLY_TESTS` misclassifies one file that isn't runner-only

`scripts/raptor3-manifest.mjs`'s own doc comment states the split's premise:
"the RUNNER-ONLY files … need the mode runner's environment … and fail under
a bare project run." The brief's own check is the same: "the nine
runner-only files are exactly the ones that fail under a bare project run."

That's not quite true. `RAPTOR3_RUNNER_ONLY_TESTS` is built from
`CS02_STRUCTURE_MEASUREMENT_TESTS` (1 file) + `CS03_EXTENSION_CAMPAIGN_TESTS`
(1) + `CS03_EXTENSION_SUPPORT_TESTS` (2: `extension-recipes.selftest.test.ts`
and `extension-campaign.selftest.test.ts`) + six G3/G4 generation-campaign
constants (6) = **10 files**, not 9. Independently reproducing the bare
`--project=raptor3` run (`review-receipts/raptor3-project-plain-review.log`,
matches the committed `receipts/raptor3-project-plain.log` exactly: 9 failed,
160 passed of 169) shows `extension-recipes.selftest.test.ts` passing cleanly
(5/5 tests, line 99 of both logs) — it does not need the runner. Only
`extension-campaign.selftest.test.ts` (its `CS03_EXTENSION_SUPPORT_TESTS`
sibling) actually fails.

Effect: `extension-recipes.selftest.test.ts` is excluded from
`RAPTOR3_DETERMINISTIC_TESTS` and therefore from the `coverage-raptor3`
project, even though it could safely run there. This doesn't invalidate the
measured floors (87.38/91.1/90.48/87.38, reproduced below) since they're
accurately measured over what they include — it just means the "exactly the
ones that fail" invariant the module documents and the brief checks is false
by one file, and the true deterministic coverage estate is very slightly
under-registered.

**Resolution:** split `CS03_EXTENSION_SUPPORT_TESTS`'s two members —
`extension-campaign.selftest.test.ts` stays in
`RAPTOR3_RUNNER_ONLY_TESTS`, `extension-recipes.selftest.test.ts` moves to
`RAPTOR3_DETERMINISTIC_TESTS`. Re-run `pnpm test:coverage:query-engine-core`
(the number can only hold or rise, never fall) and correct the doc comment's
"six seeded campaign files and three structural-measurement files" (now
6 + 2, or whatever the corrected tally is) in `scripts/raptor3-manifest.mjs`.

### 2. [F-1, LOW] Census headline is stale relative to the merged tree

`note.md`'s F-1 figures (charged-engine 15,472 token lines; charged total
23,245; like-for-like 15,472/46,021 = 0.336 and 19,305/49,887 = 0.387) exactly
match `receipts/census-f1-after.json`, timestamped 00:50 on 18 September —
**before** the `d46` branch ("the array route's upsert") was merged into this
unit at `92625457f`. Re-running `node scripts/measure-raptor3-baseline.mjs`
on the actual HEAD that ships (`review-receipts/census-review.json`) gives:

| | charged files | charged token lines | charged-engine | like-for-like (÷46,021) |
| --- | ---: | ---: | ---: | ---: |
| note's figure (pre-d46) | 63 | 23,245 | 15,472 | 0.336 |
| this review (HEAD, post-d46) | 63 | 23,344 | 15,605 | 0.339 |

I cross-checked `charged-engine` against a second, independent method —
`node scripts/query-engine-structure.mjs`'s direct `src/query-engine/**`
census, which also reports 15,605 tokenLines over the same 38 files — so
"charged-engine" and "`src/query-engine/**`" are confirmed to be the same
set, and the drift is real, not a methodology mismatch. It's a small drift
(~0.9%) caused entirely by code the followups unit didn't author, but the
note states these as *the* figures without noting they predate the merge.

**Resolution:** re-run the census on the merged tree (mechanical) and update
`note.md`'s F-1 table and both like-for-like figures.

### 3. [F-5, LOW-MODERATE] Two of the original 19 unreachable files are undisclosed retentions

`receipts/reachability-f5-before.json` lists 19 unreachable files;
`receipts/reachability-f5-after.json` shows 4 remaining unreachable after
F-5's deletions: `src/query-engine/raptor3/program/{index,program}.ts` (the
one exception the brief names and the note discloses), plus two more the
note never mentions:

- `src/migrations/push/executor.ts` — still on disk, still unreachable from
  any package entry point, but imported directly by
  `tests/unit/migrations/sqlite-recreation-indexes.core.test.ts` and
  `tests/unit/migrations/decimal-sqlite-integrity.test.ts`, neither of which
  has this file as its sole subject (both exercise broader migration/DDL
  behaviour). Deleting it would force rewriting those tests, not just
  dropping a cell — retaining it is defensible, but it's an F-5 exception the
  brief's "if retained, say by whom" never got answered for.
- `src/standard-schema-spec.d.ts` — correctly retained: it's a `declare
  module "@standard-schema/spec"` augmentation providing `StandardSchemaOf`,
  which 8 production scalar files (`src/schema/scalars/{bigint,datetime,
  number,decimal,json,string,int}/...`) import by name, and every
  `tests/types/*/tsconfig.json` pulls in via `tests/types/tsconfig.layer.json`'s
  `files` array — invisible to an import-graph reachability tool because
  TypeScript module augmentation isn't an import edge. Deleting it would
  break 8 production files' typechecking. Also correctly retained, also
  unmentioned.

`note.md`'s F-5 section reads as a complete accounting ("Deleted, none
reachable… Kept: `raptor3/program/{index,program}.ts`…") and doesn't flag
either exception, so a reader following the brief's own file-by-file check
would reasonably conclude no other exceptions exist.

**Resolution:** add two lines to `note.md`'s F-5 section naming both files
and the reason each is retained (test-only production dependency for the
first; ambient module augmentation for the second).

### 4. [F-3, LOW] Two "normative" docs still state the superseded interim floors

The integrator's second commit correctly updated `scripts/coverage-policy.mjs`,
`scripts/coverage-policy.test.mjs`, `scripts/raptor3-manifest.mjs`,
`vitest.workspace.ts`, and the root `AGENTS.md` (56.5/76.5/72/56.5 → 87/91/90/87,
three parts → four parts including `coverage-raptor3`). It missed two files
the first commit had also touched with the interim numbers:

- `src/query-engine/AGENTS.md:231-244` — explicitly the "normative" guide for
  this layer per `briefs/common.md` rule 1 — still says "runs three parts:
  `layer-query-engine`, `coverage-write-engine-core` and
  `coverage-write-engine`" and "RE-MEASURED on that tree (56.5 / 76.5 / 72 /
  56.5 …)", and still claims "no coverage project" runs the `tests/raptor3/**`
  campaigns — the exact claim the second commit's `coverage-raptor3`
  registration made false.
- `tests/README.md:116-117,159,197-199` — same superseded
  `56.5/76.5/72/56.5` figure and "merges three single-thread parts" phrasing.

**Resolution:** apply the same edit the second commit made to the root
`AGENTS.md` to these two files (87/91/90/87; four parts, naming
`coverage-raptor3`; drop the now-false "no coverage project" claim).

### 5. [F-3/F-5, LOW] Committed tree carries two dangling references; an uncommitted fix for both already sits in this worktree

The COMMITTED HEAD (`4a3a989a9`, verified with `git show HEAD:<path>`, not
the working tree) has two loose ends F-3 and F-5 left behind:

- `package.json` still lists `"test:coverage:write-engine": "node
  --max-old-space-size=768 scripts/run-coverage.mjs write-engine"`, but
  `scripts/coverage-policy.mjs`'s `definitions` no longer has an `id:
  "write-engine"` entry (F-3 merged it into `query-engine-core`).
  `coverageSubsystem(id)` (`scripts/coverage-policy.mjs:383-387`) throws
  `Unknown coverage subsystem: write-engine` for any unrecognized id, so
  running this committed script as written crashes immediately.
- `tsconfig.json` still has `"@standard-schema": ["./src/standardSchema.ts"]`
  in `compilerOptions.paths`, pointing at the file F-5 deleted. Nothing
  currently imports the bare `@standard-schema` specifier (checked; only
  `@standard-schema/spec`, the npm package, is used), so this doesn't break
  typechecking today, but it's a dangling path mapping to a nonexistent file.

Neither defect affects any verification command I ran (`test:coverage`,
`test:coverage:policy`, the whole-estate typecheck) since none of them
invoke the `test:coverage:write-engine` npm script by name or reference the
bare `@standard-schema` alias. Low blast radius, but real.

Notably, **this exact worktree already has an uncommitted, correct,
minimal fix for both** — `git status` shows `M package.json` and `M
tsconfig.json`, and `git diff` (against HEAD) is exactly the two matching
one-line deletions, nothing else. This predates my review (it was already
dirty at the very first `git status` I ran). I did not touch, stage, or
commit it, per instructions, but the integrator should simply commit it —
it's the correct fix, already written.

**Resolution:** commit the two pending one-line deletions already sitting
in the worktree (`package.json` line 162, `tsconfig.json` line 48).

### 6. Cosmetic — not actionable

`note.md`'s F-2 table describes the parse-boundary rename as "(rename, 97%
similar: the header names its new home)". The file's header/docblock doesn't
name its new home anywhere — only a relative import path (`../types` →
`../../types`) and a stale test-filename mention (`parse-boundary-gate.test.ts`
→ `.core.test.ts`) changed. Harmless, not worth a resolution beyond wording
if the note is touched anyway.

## Informational — not this unit's fault, but undisclosed

**`pnpm test:coverage` (the full aggregate) does not pass on HEAD**, but not
because of F-1–F-6:

- The "schema" subsystem, which the author's own receipts
  (`receipts/coverage-schema-after.log`, and the control run
  `receipts/coverage-schema-at-head-control.log` measured on the base commit
  to prove pre-existence) show failing at 99.93% against a 100% floor
  (`src/schema/validation/validator.ts:237-241` uncovered), is now **fully
  green (100%)** on this HEAD (`review-receipts/coverage-schema-review.log`).
  None of the responsible files were touched by followups; the fix is
  incidental, presumably from the merged `ci`/`d46` branches.
- The run then stops at the very next subsystem, **"validation"**
  (statements 98.73%, branches 99.4%, functions 99.57%, lines 98.73%, floor
  100% throughout — `src/validation/builder.ts` 59.33%,
  `src/validation/parse-failure.ts` 62.5%,
  `src/validation/scalars/json.ts` 80.55%;
  `review-receipts/test-coverage-all-review.log`,
  `review-receipts/coverage-validation-review.log`). I confirmed this
  predates `383f830c` itself: none of the three responsible files (nor any
  test importing them) appear in `git diff` between `383f830c` and HEAD.

`note.md`'s Verification section cites the schema receipt without noting it
fails, and never mentions `pnpm test:coverage` end-to-end at all. Both facts
are true and unrelated to this unit's changes, but the brief lists "`pnpm
test:coverage` green" as part of "the minimum," and a reader taking the note
at face value would hit an unexplained failure. Worth one disclosure line;
not blocking.

**`pnpm test:core` is now fully green** (400/400 files, 8374/8374 tests,
`review-receipts/test-core-review.log`) — including
`contract-matrix.core.test.ts`'s "inventories every executable test by owner
and boundary" cell, which `brief.md` pre-registers as a known pre-existing
red owned by another lane. followups never touched this test file
(`git diff --stat` is empty for it across both commits); the pass is
incidental, likely from the merged branches or from F-2/F-5's own cleanup
correcting the inventory. Good news, nothing to action.

**Biome**: `note.md` claims "every touched file carries no more diagnostics
than its base." The two receipts don't actually cover the same scope
(`receipts/biome-check-1.txt` checked all 30 touched-and-still-existing files
right after the first commit — 27 errors across `relation-body.ts`,
`measure-raptor3-baseline.mjs`, `schema.ts`; `receipts/verify-biome.log`
checked only the 4 files the *second* commit touched). I closed the gap
myself: diffing base-commit copies of `relation-body.ts`,
`measure-raptor3-baseline.mjs`, and `schema.ts` against biome
(`review-receipts/biome-base-copies.log`) reproduces the identical diagnostic
set (same rules, same or line-shifted locations) as the current tree
(`review-receipts/biome-4files-head.log`), and the `vitest.workspace.ts`
import-order diagnostic biome flags on HEAD is also present at `92625457f`
before the second commit touched it. The claim holds — these are genuinely
pre-existing, not newly introduced, and nothing needed fixing by hand that
wasn't already broken. (`result-shape.ts`'s one diagnostic *was* fixed, by
the way — its import reorder in the F-2 rename happens to also be sorted.)

## Reproduced (`review-receipts/`)

- `census-review.json` — F-1 census on HEAD (see finding 2)
- `qec-coverage-review.log` — `pnpm test:coverage:query-engine-core`:
  **87.38/91.1/90.48/87.38 against floors 87/91/90/87**, exact match to
  `note.md` and `receipts/coverage-qec-with-raptor3-2.log`
- `coverage-policy-review.log` — `pnpm test:coverage:policy`: green, 33/33
  (11+16+6) across the three chained checks
- `typecheck-review.log` — `node scripts/run-typecheck.mjs`: **0
  diagnostics**
- `mode-g2-baseline-review.log` — `node scripts/run-raptor3.mjs g2-baseline`:
  216/216
- `mode-cs01-extension-a-review.log` — `node scripts/run-raptor3.mjs
  cs01-extension-a`: 6/6
- `test-package-review.log` — `pnpm test:package`: 9/9
- `package-lint-review.log` — `pnpm package:lint`: green
- `test-core-review.log` — `pnpm test:core`: 400/400 files, 8374/8374 tests
- `raptor3-project-plain-review.log` — bare `--project=raptor3` run: 9
  failed / 160 passed (169), independently confirms finding 1
- `coverage-schema-review.log`, `test-coverage-all-review.log`,
  `coverage-validation-review.log` — see Informational section
- `biome-base-copies.log`, `biome-4files-head.log`, `biome-review-full.log`
  — see Biome note above

All eleven F-6 documentation citations (`capability-matrix-2026-07.md`,
`engine-compression-audit.md`, `engine-unification/DESIGN.md`,
`pr20-comment-triage.md`, `prisma-parity-v2-plan.md`,
`query-performance-plan.md`, `raptor3-engine-shapes-review.md`,
`raptor3-first-principles-blind.md`, `raptor3-parity-plan.md`,
`residual-write-limitation-lift-plan.md`, `upstream-defect-closure-2026-08.md`)
were checked by hand and resolve to `docs/architecture/retired/write-engine-{ATOM,README}.md`.
The two F-2 renames, their importers (`raptor3/shared/schema.ts`,
`result/result-shape.ts`), the `parse-boundary-gate`/`dead-symbol-gate`
contract tests (assertions kept, one gate genuinely *strengthened* — an
exact-listing check became a directory-non-existence check), and F-4's
`meta.raceable` read (`operation-context.ts:1283`, inside `submit()`,
confirmed by grep and by reading the surrounding code) were all verified by
direct inspection and check out. No unauthorized import of any of the
fourteen fully-deleted files (12 scalar shells + `standardSchema.ts` +
`migrations/push/index.ts`/`storage/index.ts`) was found anywhere in `src/`
(directory-style import search across the whole tree, zero hits); the
scalar-exports and migration test re-points keep their original assertions
and only change import paths.

## Unverified

- The note's claim that suites excluded from the query-engine/drivers
  coverage lanes "all execute, and pass, in `pnpm test:all`" — not
  independently reproduced (would need the gated Docker MySQL/Postgres
  containers; out of scope for this pass).
- Exhaustive per-file audit of the ~360 `excluded-shared-boundary` files in
  the census — I verified the totals and the specific charged-engine /
  like-for-like figures (finding 2) but did not re-derive every
  classification bucket from scratch.
- `g2-contracts` mode (mentioned in `brief.md`'s own verification list) was
  not run by me; my instructions specified `g2-baseline` and
  `cs01-extension-a` specifically, both of which are green.

## Re-check: ACCEPT

Top commit `52a22c2cd` ("wip(followups): review resolutions"), parent
`4a3a989a9` (the commit this review was originally written against). Checked
with a fresh `TMPDIR=/private/tmp/viborm-followups-tmp-r2`.

**Scope of `git diff 4a3a989a9..52a22c2cd`** (unfiltered, all 27 changed
files inspected): exactly the five described resolutions —
`scripts/raptor3-manifest.mjs`, `docs/.../followups/note.md`,
`src/query-engine/AGENTS.md`, `tests/README.md`, `package.json`,
`tsconfig.json` — plus their supporting new receipts
(`receipts/census-f1-after-d46.json`, `.log`, `receipts/repair-policy.log`,
`receipts/repair-typecheck.log`), plus this reviewer's own `review.md` and
`review-receipts/*` from the prior pass, swept into the commit unmodified
(diffed byte-for-byte against my in-progress working copy before writing
this section — identical). No `src/` or `tests/` behavior file, and nothing
outside the five resolutions, changed. Two untracked files remain in the
worktree (`receipts/repair-qec.log`, `receipts/REPAIR-QEC-COMPLETE`) —
evidence, not code; left untouched.

**Resolution 1 — CS03 split.** `RAPTOR3_DETERMINISTIC_TESTS` now includes
`extension-recipes.selftest.test.ts` literally;
`RAPTOR3_RUNNER_ONLY_TESTS` replaces the `CS03_EXTENSION_SUPPORT_TESTS`
spread with only `extension-campaign.selftest.test.ts`, commented as to why.
Verified two ways: `node --input-type=module` against the live module gives
deterministic 160 unique / runner-only 9 unique, zero overlap, union 169
(matching the coordinator's numbers exactly); an independent bare
`node scripts/run-vitest-safe.mjs run --project=raptor3` re-run
(`review-receipts` not re-saved this pass, ran ad hoc) reproduces the same 9
failing files as before the repair, with `extension-recipes.selftest.test.ts`
now passing inside the deterministic set (line 99, 5/5 tests) rather than
being excluded from it. **Confirmed.**

**Resolution 2 — census with D-46.** Re-ran
`node scripts/measure-raptor3-baseline.mjs` myself: charged files 63, charged
token lines 23,344, charged-engine 15,605 — byte-for-byte matching both my
own fresh run and the committed `receipts/census-f1-after-d46.json`. The
note's updated ratios check out arithmetically: 15,605/46,021 = 0.339;
(15,605+3,759+74)/49,887 = 0.390. **Confirmed.**

**Resolution 3 — F-5 disclosure.** `note.md`'s F-5 section now names both
previously-undisclosed retentions (`src/migrations/push/executor.ts`,
reached by two migration unit tests; `src/standard-schema-spec.d.ts`, named
by `tests/types/tsconfig.layer.json` and the coverage policy) with the same
facts I'd independently verified in the original pass. **Confirmed.**

**Resolution 4 — stale floors replaced.** `src/query-engine/AGENTS.md` now
says "four parts" and states 87/91/90/87 (measured 87.38/91.1/90.48/87.38);
`tests/README.md`'s table and inline comment carry the same numbers and drop
the now-false "no coverage project runs the raptor3 campaigns" claim. Both
match the root `AGENTS.md`'s already-correct figure from the prior commit.
**Confirmed.**

**Resolution 5 — package.json/tsconfig.json fixes committed.**
`git show HEAD:package.json` no longer contains `test:coverage:write-engine`;
`git show HEAD:tsconfig.json` no longer contains the `@standard-schema` path
alias. `git status` is clean for both files (the dirty state from the prior
pass is gone, properly committed, not just locally patched). **Confirmed.**

**Re-run receipts, independently reproduced:**
- `pnpm test:coverage:policy` → exit 0, 33/33 tests pass (11+16+6), matching
  `receipts/repair-policy.log`.
- `node scripts/run-typecheck.mjs` → exit 0, **0 diagnostics**, matching
  `receipts/repair-typecheck.log`.
- `pnpm test:coverage:query-engine-core` → exit 0, **87.38 / 91.1 / 90.48 /
  87.38 against floors 87 / 91 / 90 / 87**, matching `receipts/repair-qec.log`
  and the original review's own figure. The report's "part 4/4:
  coverage-raptor3" section runs and passes
  `tests/raptor3/core-structure/measurement/extension-recipes.selftest.test.ts`
  (5 tests), confirming it is now inside the measured coverage estate as
  resolution 1 claims — not just inside the manifest constant.

All five of the original REVISE findings are resolved precisely, with no new
regressions, no behavior changes, and no scope beyond what was asked.
Findings 5's informational notes (the pre-existing, unrelated
`validation`-subsystem coverage gap and the now-incidentally-fixed `schema`
subsystem) were about `pnpm test:coverage`'s full aggregate, not part of the
five resolutions, and remain accurate/unaffected — they were never blocking.

**Verdict: ACCEPT.**
