# Release unit "S" — delete the dead comparison specimen `program/` (note)

Integrator: Fable, in the worktree `/private/tmp/viborm-n4` on branch `n4` from
`e19b20759` (N1's commit). The unit S of
`docs/architecture/raptor3-nesting-and-refusals-plan.md` §1 "What disappears",
under rulings D-51/D-52 noted at N1. Receipts under `receipts/`.

## 1. The truth

`src/query-engine/raptor3/program/` was the G1-01 comparison specimen: the
scoped relational program that the checkpoint compared with structured commands
on the same S1–S4 public recipes. The checkpoint selected `commands/` as the
sole expansion path, and `VibORM`'s constructor has built `createCandidateRoute`
for every client since the C-01 cutover, so the specimen was reachable from no
public API — only from three test files. It carried a third copy of the
nested-write dependency refusal (`program.ts:398`, the `NestedWriteError`
"depends on an earlier … target write in the same nested write") and two more
sentences no shipped path could reach: "Raptor 3 program has a cyclic
produced-field dependency" (`:356`, about the specimen's own analysis pass) and
"Raptor 3 G1 source-held update supply is not implemented" (`:239`).

ELEGANCE: "An active comparison specimen stays outside the shipped graph, never
as a hidden fallback." This one was no longer active — it had not been a
selectable alternative since C-01 and no gate compared the two candidates any
more, it only re-ran the winner's fixtures a second time under a second engine.
And: "Delete superseded mechanisms and obsolete implementation-only pins, but
retain behavioral witnesses and historical evidence." So the specimen goes, the
cells that exercise the COMMAND engine stay, and the G0/G1 receipts that record
the comparison stay untouched as history.

The decisions that disappear: one engine, one vocabulary of its own
(`Expression` / `Projection` / `Block` / `Node` / `Analysis`, the `mutationOrder`
list, the `admittedOperation` verb subset), one third copy of the dependency
refusal, and one adjudicator whose whole job was to strip the one recorded
difference between two engines before comparing them. The replacing invariant is
the one the guide already states: `commands/` is the sole expansion path and the
route is the one operation owner behind the public API. The falsifier is
`node scripts/run-raptor3.mjs g1-compare`, which counts the cells of every
comparison file against `scripts/raptor3-manifest.mjs`.

## 2. Per file — what was deleted, what was kept

**`src/query-engine/raptor3/program/program.ts` (575 lines) — DELETED whole.**
The specimen's `Program` class: its dataflow nodes, its own analysis pass, its
own refusal copies. Nothing outside `program/` imported it.

**`src/query-engine/raptor3/program/index.ts` (61 lines) — DELETED whole.**
`createProgramEngine`, the specimen's five-verb `admittedOperation` subset, and
its single read entry through the shared `Queries.read` owner. Every `shared/`
symbol it consumed (`OperationContext`, `EngineSchema`, `isReadOperation`,
`entries`, `record`, `bindMembership`, `Membership`, `Arguments`, `Input`,
`ExecutionBinding`) has at least one live consumer in `commands/`, `route/` or
`shared/` itself, so the deletion orphaned no shared owner. Checked symbol by
symbol before deleting.

**`tests/raptor3/candidate.test.ts` — the specimen's half deleted, the witness
kept.** The file ran the twelve fixed scenarios at two profiles through TWO
candidates. KEPT: the `commands` candidate against the harness baseline
(24 cells: 12 scenarios × 2 profiles), the three-replay determinism loop inside
each cell, `assertFixedInventory`, and the G0 replay corpus written under
`VIBORM_RAPTOR3_EVIDENCE_DIRECTORY` — its `records` are unchanged, because
they were only ever pushed on the `commands` pass and only for
`s2-distinct-defaults` and `s2-changed-dependency`; the file's embedded
`captureRaptor3Identity()` fingerprints `src`, `tests/raptor3` and `scripts`,
all three touched here, so the file itself is not byte-identical. DELETED: the `program`
candidate entry (24 cells), the `candidates` record and the loop over it, and
the three `name === "commands"` / `name === "program"` conditionals that existed
only to tell the two candidates apart — with one candidate, `candidateName:
"commands"` is unconditional and the pair check is always `verifyG0Pair`.

**`tests/raptor3/candidate-ordering.test.ts` — the specimen's half deleted.**
KEPT: the reordered-relation-key fixture unchanged, and the `commands` cells at
both profiles (2), including the baseline `verifyG0Pair(original, reordered)`
that shows key order does not move the observation at all. DELETED: the
`program` candidate (2 cells) and the same two-candidate conditionals.

**`tests/raptor3/candidate-pagination.test.ts` — the specimen's half deleted.**
KEPT: both pages ("take one", "skip one and take one"), their full expected-row
assertions, and the `commands` cells at both profiles (4). The commands arm
never passed `candidateName`, and it still does not — the record stamp is
unchanged. DELETED: the `program` candidate (4 cells) and the candidate loop.

**`tests/raptor3/scenarios/contracts/instances.ts` — the specimen's adjudicator
deleted, the scenarios kept.** DELETED: `verifyProgramEnginePair` (its only two
callers were the two specimen halves above) with its documentation, and the two
helpers that died with it, `withoutMemberPath` and `copyWithPrototype`, plus the
three imports that then had no user (`assertEquivalentRunObservations`,
`OperationOutcome`, `ObservedWorld`). KEPT: every scenario in the file, every
assertion in them, and `isRecord`, which the scenarios use on their own.
CHANGED, and STRENGTHENED rather than weakened: inside `s2-changed-dependency`'s
`sqlite-atomic-batch` arm the located pair was pinned under
`if (memberPath !== undefined)` — that guard existed because the specimen
published the same segment record WITHOUT `memberPath`/`totalMembers`, which was
the one difference the adjudicator stripped. Every engine that remains publishes
the pair, so the pin is now unconditional. Falsified (`receipts/`): change the
expected `memberPath` to `[9]` and two cells redden, in `candidate.test.ts` and
in `candidate-ordering.test.ts` — the pin executes and carries weight.

**`scripts/raptor3-manifest.mjs` — three cell counts corrected.**
`candidate.test.ts` 48 → 24, `candidate-ordering.test.ts` 4 → 2,
`candidate-pagination.test.ts` 8 → 4. `candidate-handoff.test.ts` stays at 6: it
never imported the specimen and is untouched. Nothing else in the manifest moved.

**`src/query-engine/raptor3/AGENTS.md` — four sentences re-stated as history.**
The G1-01 paragraph now says the comparison happened (past tense) and that
`shared/`'s charging rule has one payer; the retention sentence now records that
the specimen was deleted at unit S, why (636 lines, no public API, a third copy
of the dependency refusal, no longer an ACTIVE comparison) and where to read it
(`e19b20759`); the `Queries.read` consumer list names the specimen's read entry
as the deleted one; and the ownership-model sentence keeps its rule while noting
that the specimen it was written about is gone. No other guide change.

**Untouched, deliberately.** `tests/raptor3/candidate-handoff.test.ts` (never
imported the specimen). The historical G0/G1 receipts under
`docs/architecture/raptor3-evidence/` that mention `program/` — they are
evidence, and evidence of a comparison that really happened stays exactly as it
is.

## 3. Requested changes in files this unit does not own

Two files outside the brief's list still name the specimen. Both are prose, both
are now false, and neither reddens a gate — recorded here rather than edited.

1. `tests/contracts/engine/write/parse-boundary-gate.core.test.ts:14`. The
   scope comment reads "the route has `commands/`, `program/`, `route/` and
   `shared/` under it". Requested: drop "`program/`, ". The gate itself is
   unaffected — `engineFiles()` walks the route recursively and both ratchets
   are `toBeLessThanOrEqual`, so removing two files can only shrink the counts;
   it is green (`receipts/test-all-raptor3-fixed.log`). Note that the same
   comment's "The route's own 15 files" was already ambiguous before this unit
   (the route held 17 `.ts` files, 16 besides the boundary); it holds 15 now.
2. `scripts/measure-raptor3-baseline.mjs:221` and `:223`. The scope sentence
   says "program remains the S1–S4 comparison specimen" and the candidate map is
   `["commands", "program"]`. Requested: drop `"program"` from the list and
   re-state the sentence as "commands is the sole expansion path". Nothing
   invokes this script from a gate or a package script; run by hand today it
   would report a "program" candidate whose own language cost is zero. Not
   edited, and not run as part of this unit.

## 4. Falsification record

All runs in `/private/tmp/viborm-n4` with `TMPDIR=/private/tmp/viborm-n4-tmp`,
one vitest process at a time, Node v24.21.0.

- `node scripts/run-typecheck.mjs` — **zero diagnostics**, 5.08 s wall,
  4996.2 MiB peak sampled RSS (`receipts/typecheck.log`). Not even the two
  historical Pattern TS2345 errors the common brief permits: they are not in
  this tree.
- `pnpm test:all --only "Raptor 3 fixed"` — **766 / 766 passed, 69 files**,
  10.44 s wall, 818.0 MiB peak sampled RSS
  (`receipts/test-all-raptor3-fixed.log`). 796 − 30: the deleted specimen cells
  are 24 (`candidate.test.ts`) + 2 (`candidate-ordering`) + 4
  (`candidate-pagination`).
- `node scripts/run-raptor3.mjs g2-baseline` — **216 / 216**, 16 files, 4.30 s
  wall, 703.2 MiB peak sampled RSS (`receipts/g2-baseline.log`).
- `node scripts/run-raptor3.mjs g2-contracts` — **216 / 216**, 16 files, 5.36 s
  wall, 737.0 MiB peak sampled RSS (`receipts/g2-contracts.log`).
- `node scripts/run-raptor3.mjs g1-compare` — **36 / 36**, 4 files, 3.36 s wall,
  671.3 MiB peak sampled RSS (`receipts/g1-compare.log`). This is the mode that
  checks the corrected counts cell by cell; run because it is the direct
  falsifier of the manifest edit.
- Falsifier of the manifest edit: set `candidate.test.ts` to 25 and the same
  mode fails with "Missing candidate/profile/scenario cell in
  tests/raptor3/candidate.test.ts — 24 !== 25"
  (`receipts/falsify-manifest-count.log`). Restored from a scratch copy, byte
  identical.
- Falsifier of the strengthened pin: expect `memberPath: [9]` and
  `candidate.test.ts > … > s2-changed-dependency` and
  `candidate-ordering.test.ts > … > sqlite-atomic-batch` both redden
  (`receipts/falsify-located-pair-pin.log`). Restored from a scratch copy, byte
  identical; the final green above was run after both restores.
- `npx biome check`, per touched file, against a scratch copy of its
  `e19b20759` version, category by category (`receipts/biome-base.txt`,
  `receipts/biome-after.txt`): `candidate.test.ts` 0 → 0;
  `candidate-ordering.test.ts` `noMisplacedAssertion` 1 → 1;
  `candidate-pagination.test.ts` `noMisplacedAssertion` 6 → 6; `instances.ts`
  `noMisplacedAssertion` 13 → 13; `raptor3-manifest.mjs`
  `noMisplacedAssertion` 69 → 69 and `useTopLevelRegex` 1 → 1. No new category
  anywhere, no category worse. The deleted specimen took four pre-existing
  diagnostics with it: `useDefaultSwitchClause` 2, `noParameterProperties` 1,
  `useImportType` 1, all in `program.ts`
  (`receipts/biome-deleted-specimen.txt`). `AGENTS.md` is Markdown; Biome checks
  no file for it. Formatting by hand; no formatter was run on any file.

## 5. Cost

`git diff --numstat e19b20759 -- src tests scripts`
(`receipts/source.patch`): **+121 / −861, net −740 lines.**

- Production: `program/index.ts` −61 and `program/program.ts` −575 = **−636
  lines**, the whole of them. No production line was added anywhere.
- Guide: `AGENTS.md` +21 / −12.
- Tests: `candidate.test.ts` +35 / −55, `candidate-ordering.test.ts` +14 / −30,
  `candidate-pagination.test.ts` +39 / −52, `instances.ts` +9 / −73 = **−113
  net**. The add counts are re-indentation: removing the candidate loop dedents
  each body.
- Scripts: `raptor3-manifest.mjs` +3 / −3 (three integers).

`node scripts/query-engine-structure.mjs` over `src/query-engine`, base
(`e19b20759`, exported with `git archive`) → after
(`receipts/structure-base.json`, `receipts/structure-after.json`):

| measure | base | after | delta |
| --- | --- | --- | --- |
| files | 39 | 37 | −2 |
| lines | 19,667 | 19,031 | −636 |
| token lines | 16,154 | 15,528 | −626 |
| functions | 1,096 | 1,046 | −50 |
| parameters | 1,661 | 1,584 | −77 |
| branch nodes | 2,588 | 2,499 | −89 |
| files over 300 lines | 14 | 13 | −1 |

The §7 questions against this diff: the mechanism removed is a second write
engine and the adjudicator that compared it, its consumers were three test files
and nothing in `src`, the replacing invariant is the one already in force
(`commands/` is the sole expansion path behind one route), and the falsifier is
`g1-compare` plus the fixed suite's exact cell count. Nothing was consolidated
INTO another owner — this is a deletion, so no owner grew.

## 6. Still red / unverified

- **Still red:** nothing. The three falsifiers the brief names are green, and so
  is the fourth (`g1-compare`) that directly checks the manifest edit.
- **Unverified:** the provider lanes (PGlite, PostgreSQL, MySQL, D1) and the
  seeded G3/G4 campaigns were not run — unit work never runs them, and nothing
  in this diff reaches a provider: the specimen was never on a provider path.
- **Unverified:** `scripts/measure-raptor3-baseline.mjs` was not executed, so
  its post-deletion output is a reading of the source, not a measurement.
- **Unverified:** the claim that no consumer outside the enumerated files
  existed rests on `grep -rn` over `src tests scripts benchmarks` for
  `createProgramEngine`, `verifyProgramEnginePair`, `raptor3/program` and
  `program/`, plus the whole-estate typecheck. A consumer reaching the specimen
  through a computed path would not have been found by either.
