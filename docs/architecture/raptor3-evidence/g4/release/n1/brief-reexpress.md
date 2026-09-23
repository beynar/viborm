# N1 — re-expressing the recorded expectations the ordered observation changes (brief for the per-file agents)

Worktree: `/private/tmp/viborm-n1` (branch `n1`, base `e772741eb`). The engine change is
FROZEN; you edit ONLY the test file(s) assigned to you. Never touch `src/`, `scripts/`,
other test files, or the main tree `/Users/arnaud/code/viborm`. Never commit, stage,
reset, stash, push, checkout. `export TMPDIR=/private/tmp/viborm-n1-<yourname>-tmp`
(mkdir -p it) for every run. One vitest process at a time on this machine: use
`node scripts/run-vitest-safe.mjs <file>` for a SQLite file and
`node /private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/run-shared-family.mjs <file>`
for a PGlite conformance file; on a lock refusal wait 20 s and retry. Formatting:
`npx biome check <file>`, fixed BY HAND (never run the formatter on a file that had
diagnostics before you touched it; compare with `git show HEAD:<file>` in a scratch copy).

## The contract you re-express against (read first)

- `src/query-engine/raptor3/AGENTS.md`, the paragraph "**A dependent read is an ordered
  observation (N1, D-51).**" and the one after it (the dependent capture).
- The unit's own pins: `tests/raptor3/g4/parity/ordered-observation.test.ts` (24 cells).
- `docs/architecture/raptor3-nesting-and-refusals-plan.md` §1 (N1) and §4 (the census
  dispositions); `ELEGANCE.md` "Apply the principles" (removing a refusal makes paths
  reachable: check result modes, empty cases, siblings, repeated placements, failure
  boundaries — and "Expected outcomes must be independent of candidate implementation").
- `docs/architecture/raptor3-evidence/g4/briefs/common.md`, the twelve rules (never
  delete, weaken or `.skip` a test; a recorded expectation is re-expressed only where a
  ruling changed the answer, naming it — here D-51 / D-52 through N1).

## The rule, in the words you derive with

1. Inside one nested write, mutations run in the relation body's CANONICAL verb order, not
   the payload's key order: a to-many relation runs `disconnect, delete, update, upsert,
   connectOrCreate, set, updateMany, deleteMany, connect, create, createMany`; a to-one
   runs `disconnect, delete, create, connect, connectOrCreate, upsert, update, set,
   updateMany`; relations run in the model's declaration order; a record's own write runs
   after its `before` children (parent-held targets) and before its `after` children.
2. A nested lookup whose answer an EARLIER write of the same operation can change reads
   the state AFTER that write (an ordered observation). A lookup nothing earlier can
   change reads where it always did. Two consumers of one target across a write take
   two observations.
3. A required target absent at its observation is the correlated refusal the relation
   body already registers ("Cannot <verb> relation '<edge>': target record was not
   found[ for this parent]." / the upsert's found requirement / "Cannot set relation …")
   and NOTHING of the operation commits: on the live route the transaction rolls back;
   on the batch route the presence premise aborts the batch before any write.
4. A read the parent's OWN write consumes (a parent-held target's key whose producer runs
   after that write) keeps the inherited sentence "Nested operation '<op>' on relation
   '<rel>' depends on an earlier '<op2>' … write in the same nested write. Split these
   operations into separate queries." — unchanged text, unchanged meta.
5. The database's own integrity answers stay what they are: a unique violation, a foreign
   key violation, a NOT NULL violation raised by an executed statement is the operation's
   failure (the engine's mapped error class and message), with the transaction rolled
   back on the live route and the batch aborted on the batch route.
6. The tx substrate and the batch substrate of the conformance harness must agree on the
   end state (the harness's parity check). A disagreement is a DEFECT, not something to
   pin.
7. The array route (`$transaction([…])` on a batch-only driver) keeps refusing a member
   that needs a dynamic read ("does not support callback transactions", D-46).

## Per cell

For every cell of your file(s) that fails under the frozen engine (run the file first
and list them):

a. Read the cell whole: seed, act, `expectReject` / `expectedError` / `expected` (or the
   transition's `expect` block), and what it pinned before (usually DESIGN §6.2's
   mode-independent veto, "depends on an earlier … write").
b. DERIVE the end state by hand from rules 1–7 — write the derivation down in one or two
   sentences per cell (which write runs first, what the dependent read observes, what
   follows). Do this BEFORE looking at what the engine produced.
c. MEASURE: run the cell. For a conformance cell, the harness stops at the rejected
   boolean; to see the produced state, temporarily set the cell's `expectReject` to the
   derived value and `expected` to your derived state, run, read the diff, then keep
   whatever the truth requires. Read the tx-vs-batch parity line too.
d. If measured == derived: re-express the cell — the name (keep its identity where the
   name still describes the shape; where the name says "rejects" and it now executes,
   rename to what it now pins, keeping the leading words so the cell can be found),
   `expectReject`/`expectedError`/`expected` (the FULL end state, at least as strong as
   before: rows AND memberships), and a one-line comment `// N1 (D-51): pinned DESIGN
   §6.2's veto ("…"); now …` naming what it pinned before. A cell whose refusal moved
   from the dependency sentence to rule 3/4/5's answer keeps `expectReject: true` with
   the new `expectedError` and the unchanged `expected` state.
e. If measured != derived: DO NOT re-express. Record the cell under "Disagreements" with
   the derivation, the measured state (both substrates), and your reading of which is
   right. That is the integrator's defect list.
f. Never delete a cell, never `.skip`, never loosen an assertion, never change a seed to
   make a cell pass.

## Report (your final message, structured)

- Per cell: name → (before: what it pinned) → (derived) → (measured) → (action: re-expressed /
  unchanged / disagreement), one line each.
- The file's final run: `Tests N passed (N)` or the remaining failures, verbatim.
- Biome: diagnostics before (HEAD copy) and after, category by category.
- Disagreements, with everything the integrator needs to reproduce.
- Anything you could not verify.
