# Release unit "S" — independent review

Reviewer: independent, in `/private/tmp/viborm-n4` (branch `n4`, base
`e19b20759`, uncommitted). Every command below was re-run by me with
`TMPDIR=/private/tmp/viborm-n4-review-tmp`, one vitest process at a time. No
file in the worktree was written except this one; nothing was committed,
staged, reset, stashed, pushed or checked out.

## Verdict: REVISE

The deletion itself is correct, minimal and faithful to the brief. Every
falsifier the brief names reproduces exactly, the biome parity claim reproduces
category by category, and the structure receipt reproduces to the integer. No
behavioral witness was lost.

Three prose defects stand between this and ACCEPT. Two of them are false
present-tense sentences left inside the guide this unit owns; one is an
overstated claim in the note. None of them reddens a gate and none requires a
re-run.

## What I measured

| # | Command | Result | Reconciliation |
| --- | --- | --- | --- |
| 1 | `node scripts/run-typecheck.mjs` | **zero diagnostics**, 5.20 s wall, 5018.5 MiB peak sampled RSS (ceiling 8192), teardown verified | matches the note (5.08 s / 4996.2 MiB); not even the two historical Pattern TS2345 errors the common brief permits — they are not in this tree |
| 2 | `pnpm test:all --only "Raptor 3 fixed"` | **766 / 766 passed, 69 files**, 10.43 s wall, 823.4 MiB peak sampled RSS | exactly the note's number. 796 − 30. The 796 / 69-file baseline is corroborated by N1's own receipt at this base (`g4/release/n1/receipts/estate/fixed.log:72`). The 30 are 24 + 2 + 4, and the per-file lines in my run print `candidate.test.ts (24 tests)`, `candidate-ordering.test.ts (2 tests)`, `candidate-pagination.test.ts (4 tests)` |
| 3 | `node scripts/run-raptor3.mjs g2-baseline` | **216 / 216**, 16 files, 4.30 s wall, 704.2 MiB peak RSS, gate verified | matches |
| 4 | `node scripts/run-raptor3.mjs g2-contracts` | **216 / 216**, 16 files, 5.40 s wall, 741.9 MiB peak RSS, gate verified | matches |
| 5 | `node scripts/run-raptor3.mjs g1-compare` | **36 / 36**, 4 files, 3.38 s wall, 669.7 MiB peak RSS, gate verified | the direct falsifier of the manifest edit; 24 + 6 + 2 + 4 |
| 6 | `biome check --max-diagnostics=1000`, per touched file, base vs after | **identical everywhere** | see below |
| 7 | `node scripts/query-engine-structure.mjs` | live output **equals `receipts/structure-after.json` on every numeric field** | files 37, lines 19,031, tokenLines 15,528, functions 1,046, parameters 1,584, branchNodes 2,499, filesOver300Lines 13 — and each is the receipt's base minus the note's stated delta |

**Cell counts, counted by hand rather than taken from the note.**
`fixedScenarios` = 6 conditional + 2 instances + 2 grouped + 2 correlated = 12;
`G0_PROFILES` = 2. `candidate.test.ts` is one `describe` over
`describe.each(G0_PROFILES)` over the 12 scenarios = **24**.
`candidate-ordering.test.ts` is one `it.each(G0_PROFILES)` = **2**.
`candidate-pagination.test.ts` is 2 pages × `it.each(G0_PROFILES)` = **4**.
`candidate-handoff.test.ts` is untouched at 6. The three integers in
`scripts/raptor3-manifest.mjs` are therefore right, and `g1-compare` agrees.

**Biome, base vs after** (I did not trust the default diagnostic cap: at
`--max-diagnostics=20` the manifest reports 19 + 1 and looks like a regression.
At 1000 it reports the real numbers.) I rebuilt each file's `e19b20759` version
into a mirror tree outside the worktree with the repo's own `biome.jsonc`,
`.gitignore` and `node_modules`, and confirmed the mirror reproduces the
in-repo "after" numbers exactly before comparing:

| file | base | after |
| --- | --- | --- |
| `tests/raptor3/candidate.test.ts` | 0 | 0 |
| `tests/raptor3/candidate-ordering.test.ts` | noMisplacedAssertion 1 | 1 |
| `tests/raptor3/candidate-pagination.test.ts` | noMisplacedAssertion 6 | 6 |
| `tests/raptor3/scenarios/contracts/instances.ts` | noMisplacedAssertion 13 | 13 |
| `scripts/raptor3-manifest.mjs` | noMisplacedAssertion 69, useTopLevelRegex 1 | 69, 1 |

No new category, none worse, and **no `format` diagnostic on any touched
file** — the by-hand formatting is clean. The deleted specimen's own four
pre-existing diagnostics are confirmed against its base content:
`program.ts` useDefaultSwitchClause 2, noParameterProperties 1, useImportType 1;
`program/index.ts` none.

**LOC.** `git diff --numstat e19b20759 -- src tests scripts` is **+121 / −861**
(3+21+0+0+14+39+35+9 / 3+12+61+575+30+52+55+73), production **−636** with no
production line added. Negative in production, as the brief requires.

## What I verified by reading, not by running

- **Nothing under `src/query-engine/raptor3/program` remains.** The directory is
  gone. `grep -rn "program" src/query-engine/raptor3 --include='*.ts'` returns
  nothing, and case-insensitively the only hits anywhere in the route are in
  `AGENTS.md`. Repo-wide, `createProgramEngine`, `verifyProgramEnginePair`,
  `raptor3/program`, `withoutMemberPath` and `copyWithPrototype` survive in no
  file under `src`, `tests`, `scripts` or `benchmarks`.
- **No behavioral witness was deleted.** I read all four test diffs line by
  line. Every `commands` cell survives with its assertions intact: the
  three-replay determinism loop and `assertFixedInventory` in
  `candidate.test.ts`; the baseline `verifyG0Pair(original, reordered)` and the
  reordered-key fixture in `candidate-ordering.test.ts`; both pages with their
  full expected-row assertions in `candidate-pagination.test.ts`; every scenario
  and every assertion in `instances.ts`. The commands arm of the pagination file
  never passed `candidateName` and still does not, so its record stamp is
  unchanged. The one semantic change is a **strengthening**: the
  `s2-changed-dependency` / `sqlite-atomic-batch` located-pair pin lost its
  `if (memberPath !== undefined)` guard. I read both falsification receipts —
  `falsify-manifest-count.log` (`24 !== 25`) and `falsify-located-pair-pin.log`
  (two cells redden on `memberPath: [9]`, in `candidate.test.ts` and
  `candidate-ordering.test.ts`) — and they are genuine, unrelabeled failures;
  my own green runs above prove both restores landed.
- **No shared owner was orphaned.** The specimen imported only
  `@errors`, `@schema/model` and `../shared/{operation-context,schema,storage}`.
  I checked each named symbol myself: `OperationContext` 19, `EngineSchema` 19,
  `isReadOperation` 5, `bindMembership` 16, `Membership` 67, `Arguments` 36,
  `Input` 184, `ExecutionBinding` 5, `EngineConfig` 3 live references in
  `commands/`, `route/` or `shared/`; `entries` and `record` are imported and
  called in `commands/commands.ts` and `commands/relation-body.ts`. The
  "TWO modules from the shipped tree" retention sentence is unaffected — the
  specimen imported neither `bind-budget.ts` nor `cache-value-codecs.ts`.
- **The refusal is not lost.** The five live `depends on an earlier …` sites
  in `commands/commands.ts` remain; only the dead third copy went.
- **The harness kept no specimen vocabulary.** `CandidateEngineFactory` still
  has many consumers, and `sqlite-world.ts`'s `candidateName?: "commands"` was
  already one-valued before this unit, so nothing there went stale.
- **Nothing else moved.** `git status` is exactly the eight files plus the
  untracked `g4/release/s/` evidence directory. `candidate-handoff.test.ts` is
  untouched and stays at 6. The historical G0/G1 receipts that mention the
  specimen are untouched.
- **The two out-of-scope references are correctly recorded, not edited.**
  `tests/contracts/engine/write/parse-boundary-gate.core.test.ts:14` and
  `scripts/measure-raptor3-baseline.mjs:221`/`:223` still name the specimen;
  both are prose or an unrun script, neither reddens a gate (the boundary gate
  ran green inside measurement 2, and nothing in `package.json` or any script
  invokes `measure-raptor3-baseline.mjs`). Note §3 is the right place for them.
  Its incidental observation is also correct: the route now holds exactly 15
  `.ts` files, which makes that gate's `:92` comment newly accurate.

## Findings

### 1. Two present-tense specimen sentences survive in the guide this unit owns — MODERATE

`src/query-engine/raptor3/AGENTS.md` still asserts, in the normative guide, that
the comparison specimen exists and that there are two candidates:

- `:365` — "The latter imports no command types and also serves the comparison
  specimen."
- `:387` — "Both candidates may import the two unchanged; charge the complete
  file and its engine-owned type dependencies to both."

Both are false after unit S. The brief enumerated four sentences (`:22`, `:28`,
`:104`, `:398`) and the implementer restated exactly those four; these two were
not in the brief's list. But they describe `program/` as a live specimen in the
same way the four did — the enumeration was incomplete, not exclusive — and the
note's §2 closes with "No other guide change" without recording them as known
stale, so nothing downstream knows they are wrong. A future agent reading
`:387` will look for a second candidate.

**Exact minimal resolution** (two clauses, no restructuring):

```
:365  The latter imports no command types; it also served the comparison
      specimen deleted at unit S.

:387  The candidate may import the two unchanged; charge the complete file
      and its engine-owned type dependencies to it.
```

Re-wrap each to the paragraph's own width, and add one sentence to note §2's
`AGENTS.md` paragraph saying these two were restated as well. If the brief's
"no other guide change" is instead read strictly, the acceptable alternative is
to leave both sentences and record them verbatim in note §3 as known-stale
sentences in a file this unit owns — but silence is not an option.

### 2. The replay-corpus claim is overstated — MINOR

Note §2 says the G0 replay corpus's "content is unchanged", and the structured
report says it is "byte-unchanged". The corpus file embeds
`identity: captureRaptor3Identity()`, which fingerprints `sourceFiles(root,
"src")`, `sourceFiles(root, "tests/raptor3")` and `sourceFiles(root,
"scripts")` — all three touched by this unit — so the FILE cannot be
byte-identical.

I checked this empirically rather than by argument. Comparing the corpus my
`g1-compare` run wrote against the last stored one
(`docs/architecture/raptor3-evidence/g4/rulings/verification/fixed/g1-compare.receipt/adjudicated-instance-admission-corpus.json`):

- `records` — **byte-identical**, 2 records both sides. The substantive claim
  holds exactly, and for the stated reason.
- `identity.production` and `identity.harness` — **differ**
  (`d4c0aa8a…` vs `d5c3f9e9…`).

Nothing consumes the corpus (no gate reads
`adjudicated-instance-admission-corpus.json`), so this is an accuracy defect in
the evidence, not a behavior change.

**Exact minimal resolution.** In note §2, replace the clause "its content is
unchanged" and extend its reason, so the sentence ends:

```
… and the G0 replay corpus written under `VIBORM_RAPTOR3_EVIDENCE_DIRECTORY` —
its `records` are unchanged, because the records were only ever pushed on the
`commands` pass and only for `s2-distinct-defaults` and `s2-changed-dependency`;
the file's embedded `captureRaptor3Identity()` fingerprints over `src`,
`tests/raptor3` and `scripts` necessarily change, as they do for any source edit.
```

Make the same correction in the structured report's `kept` entry for
`candidate.test.ts`: "the corpus content is byte-unchanged" becomes "the
corpus's recorded `records` are byte-unchanged".

### 3. A hand-reflow slip in the guide — LOW

`src/query-engine/raptor3/AGENTS.md:112` is the 14-character line
`deriving them;` inside an otherwise ~80-column hard-wrapped paragraph
(`:110` is 79, `:111` is 73, `:113` is 79). The brief asks for formatting by
hand; this one paragraph was not re-wrapped after the edit.

**Exact minimal resolution.** Re-wrap `:110`–`:113` to the paragraph's own
width, e.g.:

```
Consumers read those published facts (`commands/index.ts` `publishedFacts`; the
deleted `program/` specimen's single read entry was the other) instead of
deriving them; there is no second `findMany`/`findUnique`/`groupBy` dispatch. A
prepared shape carries every fact the decoder needs, including the direction of
```

## Not verified

- The provider lanes (PGlite, PostgreSQL, MySQL, D1) and the seeded G3/G4
  campaigns. I did not run them and agree they are out of scope: the specimen
  was never on a provider path and this diff reaches none.
- `scripts/measure-raptor3-baseline.mjs` was not executed by me either. Its
  post-deletion output remains a reading of the source.
- The `796` fixed-stage baseline at `e19b20759`. I did not check the base out —
  forbidden — so I corroborated it from N1's own receipt at this base rather
  than by re-running it, and reconciled 796 − 30 = 766 against per-file cell
  counts I derived myself.
- The "no consumer reached the specimen through a computed path" claim. My
  greps and the whole-estate typecheck would both miss one, exactly as the note
  says.

## What does not need re-running

All three resolutions are prose in `AGENTS.md` and `note.md`. Neither file is
read by a gate — `AGENTS.md` is Markdown, which Biome does not check, and
`note.md` is evidence. The four green falsifiers above stand unchanged after
them.
