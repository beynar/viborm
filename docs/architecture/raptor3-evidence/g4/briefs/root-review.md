# G4-04 root integrated review — independent reviewer briefs

Read `common.md`, `review.md`, `g4/root-review-checklist.md` and the ledger
`g4.md` (unit records, decisions tables). The tree under
`/Users/arnaud/code/viborm` is the frozen G4 candidate: every unit is accepted
and the decisions unit is verified (`g4/decisions-review.md`). Three
independent reviewers each own one checklist area; the integrator owns B
(regression modes, run through the runner) and E (launch conditions). Each
reviewer writes `g4/root-review-<area>.md` with Outcome (ACCEPT / REVISE /
BLOCK), one row per checklist line with the receipt or the finding, and the
structured summary `review.md` requests. Read-only on production and tests:
probes go under `tests/raptor3/g4/review/root/<area>/` and are removed or
left as named review evidence, never in a registered mode. Never commit,
stage, reset, stash or delete archives.

## Area A — source and ownership

1. Combined diff against `0cc61e61` (`git diff 0cc61e61 -- src scripts
   tests vitest.workspace.ts` plus `git status --porcelain` for the untracked
   `src/query-engine/raptor3/route/`, `tests/raptor3/g4/`, `tests/types/raptor3/`):
   every changed file is inside the declared ownership of an accepted unit
   (G4-01 `shared/query.ts`, `shared/schema.ts` read owners; G4-03 route,
   `client.ts`, `query-engine.ts`, `pending-operation.ts` seams; G4-02
   `commands/*`, `shared/operation-context.ts`, `shared/storage.ts`,
   adapters' `integerDivide`, `database-adapter.ts`; witness/harness
   `scripts/*`, `tests/raptor3/**`, `vitest.workspace.ts`); no staged files;
   the known unrelated dirty files `CONTEXT.md`, `memory.md`,
   `tests/pattern/pack/program-dump.ts` are untouched by G4 (compare their
   diff against the session-start snapshot in `g4/environment/`).
2. One authority per fact (checklist A line 2): for each named fact, find the
   owner by reading, then grep for a second implementation; a second one is a
   finding with both locations.
3. No legacy import or fallback in `src/query-engine/raptor3/**` and `route/`:
   grep `write-engine`, `builders/`, `result/`, `operations/`, `pattern/`;
   only `parse-boundary` and the official cache codec owners in
   `result/cache-value-codecs.ts` (B-1c, accepted) are allowed — list every
   hit with its justification.
4. Deletions verified gone (checklist A line 4); each name grepped.
5. Private guide `src/query-engine/raptor3/AGENTS.md`: every paragraph states
   a fact the code carries (spot-check ten by reading the code); every unit's
   proposed paragraphs (unit notes' "private guide" sections) are present.

## Area C — contracts and decisions

1. Public API: `src/client/client.ts`, `src/query-engine/query-engine.ts`,
   `pending-operation.ts` diffs add only the private route parameter and its
   plumbing; no exported type, argument, result shape or error class changed
   (`tests/types/raptor3/` and the shipped type tests still pass under
   `node scripts/run-typecheck.mjs`).
2. Refusal wordings: for every refusal the candidate raises (grep `throw` in
   `raptor3/**`), the sentence is the shipped sentence or a recorded
   registered identity; list the registered identities (R-D3 and the existing
   G3 ones) and confirm each has a pin.
3. Decisions: the six decisions in `g4.md` are applied exactly as worded
   (read `g4/decisions-review.md`, then re-check two by running the cells);
   the integrator decisions listed in checklist C are each justified in the
   ledger; no decision still owed to Arnaud is hidden in a unit note's
   blockers (grep `needs Arnaud` / `Arnaud's decision` across `g4/**/note.md`
   and the reviews; every hit must be in the ledger's tables).
4. Recorded diagnostic-meta differences (RF-15 in the inventory) are listed,
   none silent: compare the meta of five refusals on both engines.

## Area D — evidence and cost

1. Identity: `captureRaptor3Identity` on the frozen tree equals the identity
   named by the newest receipts of every unit (`receipts/*/identity-after.json`
   or the note's identity line); list any receipt whose identity is older and
   whether the unit re-ran after its last edit.
2. Census on the frozen tree with `scripts/query-engine-structure.mjs`'s
   `countTokenLines` (the same method as `g4/unit02/note.md` §R6.7): candidate
   core (the 12 files), whole raptor3 tree, and the complete charged perimeter
   using the G3 charged file list in
   `g3/structure-correction/qualified-final/support/source-cost.json`
   (`privateCandidates.candidates.commands`: language 7, shared 5, retained
   18) plus every G4 addition outside `raptor3/` that the plan §7 charges
   (route file, adapter seams, client/query-engine/pending-operation deltas as
   charged deltas). Report token-lines / physical / bytes against the G3
   closure (core 6,927 / complete 11,849 token-lines) and against the shipped
   engine's charged perimeter (53,787 token-lines, 171 files). Write the
   result to `g4/root-review-D-census.json` and the per-unit cumulative
   deltas reconciled against each unit note's cost section.
3. Failed attempts kept: every review file's REVISE round has its receipts
   directory; nothing under `g4/**/receipts` was deleted (compare with the
   ledger's round list).
4. Bundle fixtures: record what `scripts/measure-raptor3-baseline.mjs
   --bundle` needs (do not run it against the dirty tree if it refuses); the
   candidate-only package measurement belongs to the cutover-measurement
   unit — state which numbers this review could not produce.

## Exit

Structured summary per `review.md`. REVISE only for a finding that changes a
public answer, error identity, committed state, breaks a stated invariant, or
shows a second authority for a fact; nits are notes.
