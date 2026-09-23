# Freeze preparation unit — close root-review area A's three obligations

Read `common.md`, `g4/root-review-A.md` (findings 1–3 and the notes), the
decisions review `g4/decisions-review.md`, and the unit notes named below.
You edit exactly three production files in `/Users/arnaud/code/viborm`:
`src/query-engine/raptor3/AGENTS.md`, `src/query-engine/raptor3/commands/assignments.ts`
and (an export only) `src/query-engine/raptor3/shared/query.ts`. No test
edits, no scripts, no other file. Never commit, stage, reset or stash.

## 1. Private guide (`raptor3/AGENTS.md`) — checklist line A5

Every paragraph states a fact the code carries, names its owner (file and
function), and is short. Merge, do not append blindly: place each paragraph
in the section it belongs to (read language, physical envelope, route,
retention), keep the existing G3 paragraphs that are still true, and delete
or rewrite the ones that are not.

- **G4-01 (read language):** merge `g4/unit01/note.md` §10 ("Proposed
  private-guide paragraph") as written, split into paragraphs; verify each
  sentence against `shared/query.ts` (`Queries.read`, `prepareSelector`,
  `page()`, `orderTerms`, `prepareProjection`/`lowerProjection`/`decodeScalar`,
  `fieldValue`, `carriedValue`, distance/GeoPoint capability refusals). Add
  the one named exception root review found: `grouped()` emits the raw signed
  `take`/`skip` without the page owner because `groupBy` admits no cursor and
  no `distinct` and the shipped `operations/groupby.ts:107-110` emits the raw
  signed take too (parity, not a divergence).
- **G4-02 (physical envelope and write owners):** from `g4/unit02/note.md`
  (phase 1 §8, phase 2 P.4.*, closure R4–R6, decisions D.*) write the
  paragraphs for: the one envelope rule in `OperationContext.run` (statement-
  atomic fast path, packaged presence, no series progress on a single
  statement; frozen counts 1 statement / 0 transactions for the root `create`
  fold); `operationRegion` versus `memberRollback` — lift the exact wording of
  `shared/operation-context.ts:362-374` (a borrowed operation owns a region
  only when its caller granted `operationRegion`; without the grant the
  caller's scope is the unit and a failing statement poisons it;
  `memberRollback` is member isolation only) and REPLACE the stale paragraph
  at `AGENTS.md:274-280` that says the candidate never opens a region inside a
  borrowed transaction; `Queries.updateValue` as the one update language with
  `expressions.integerDivide` as the adapter seam for the portable integer
  quotient and the decimal-key rounding rule per operator domain (R-D2);
  `returningSafeProjection` as the one owner of the "names a relation" fact;
  the counted-slot owner; the carrier transport rule; the tagged quantifiers;
  the unique-selector spelling rule (`nestedTargetAddressesConstraint(edge,
  verb)`, per edge kind, with the shipped citations); the junction delete
  order (link removal, then target; R-B5); the exact failed-INSERT recovery
  scope (already present — verify it is still true after phase 2).
- **G4-03 (route):** from `g4/unit03/note.md` (§5 binding mapping, FU.3/FU.7,
  B-1c) write: the route states WHICH situation (borrowed transaction, atomic
  array, standalone) and never whether an envelope is needed; the binding
  kinds and what each carries (`driver`, `memberRollback`, `operationRegion`);
  the prepared-operation boundary (`prepare(model, op, rawArgs)` admits once
  and publishes the admitted args, the read shape and the cache codec); the
  cache codec composed from the official owners in
  `result/cache-value-codecs.ts` through `Leaf.scalar`, never re-dispatched
  from a type name.
- **Retention paragraph:** the only imports from outside `raptor3/` are
  `write-engine/parse-boundary` (named retention), `bind-budget` (a pure Sql
  chunker shared by every engine; root review A note) and the official cache
  codec owners; list them once with the reason, so the next legacy scan does
  not re-derive it.
- Reword the R-D4 sentence root review A flagged as not parsing (decisions
  block), keeping its meaning: the stored bytes may differ from the request's
  literal; the located value is the contract.

## 2. One spelling of "an operator record whose `set` names the whole value" — checklist line A2

`commands/assignments.ts:28-38` (`scalarAssignment`) restates the predicate
`shared/query.ts:742-744` owns (`isOperatorRecord(value)` then
`Object.hasOwn(value, "set")`). Export the owner's answer from `shared/query.ts`
(export `isOperatorRecord`, or add a one-line `Queries.wholeValue(value)`
that returns the `set` operand or the value itself) and make
`scalarAssignment` call it; delete the inline predicate and its comment.
Behavior must not change: a `Sql` instance is non-plain, so both spellings
already answer the same; say so in the note with the domains checked
(`Uint8Array`, `Date`, `Decimal`, arrays, `Sql`, null-prototype objects).

## 3. Checks and record

Run, one per Bash call with a bounded timeout, in the main tree (the lock
is free once the decisions verifier has returned): the G4-02 author estate
on SQLite (`node scripts/run-vitest-safe.mjs run --workspace=tests/raptor3/g4/unit02/unit02.workspace.ts tests/raptor3/g4/unit02/`),
`node scripts/run-raptor3.mjs g4-read-contracts`, `g3-execution-review`,
`g3-bulk-series`, `g2-contracts`, `g4-route-transactions`, and
`node scripts/run-typecheck.mjs` (only the two Pattern diagnostics). Write
`g4/freeze/note.md` (what changed in the guide, section by section, with the
owner each paragraph cites; the predicate change with its falsifier: a
temporary revert to the inline predicate must leave every cell green, which
is the proof both spellings agreed — restore byte-identically from a backup
copy) and receipts under `g4/freeze/receipts/`. Recapture identity after the
last edit and print it.

## Exit and return value

Structured summary: unit, summary, location, notePath, patchPath (a `git
diff` of the three files against 0cc61e61 saved as `g4/freeze/guide-and-predicate.patch`),
repairs, suites, typecheck, cost (bytes / token-lines of `assignments.ts`
and `query.ts` before and after), blockers, unverifiedClaims.

## 0. First: the decisions review's round-2 items (`g4/decisions-review.md`, REVISE)

Read that review in full and its receipts. Then, before parts 1–3:

- **Finding 1 — R-D2 (c) at the nested sites (parity, same owner).** Four
  reachable nested shapes let `set` win beside an operator on a child key
  where the shipped engine refuses with the arity sentence and writes
  nothing: a nested child `update`, a nested child `upsert`, a nested
  `updateMany` member, and a nested child key naming nothing (candidate: bare
  `Error: Raptor 3 G1 update operator is not implemented: `; shipped: the
  arity sentence with `received none.`). Arnaud's decision (c) is "`set`
  beside an operator reverts to the shipped refusals"; parity at every site
  the shipped engine states it is that decision, not a new one. Apply the
  SAME owner (`EngineSchema.keyPortabilityRefusal`, the sentences it already
  states) from the relation body's nested update / upsert / updateMany key
  payload positions — one rule, one owner, no per-verb branch, no second
  walk: the relation body already holds each nested payload where it admits
  it. Pin the reviewer's four rows on both engines as author cells
  (`tests/raptor3/g4/unit02/key-arithmetic.test.ts` or a new
  `nested-key-refusal.test.ts` in the estate); the reviewer's probe
  `tests/raptor3/g4/review/unit02-decisions/nested-key-refusal.review.test.ts`
  must go 4 divergences → 0.
- **Note 3 — the last bare `Error` in the family.** A root `upsert` with no
  relation in the update payload and `update: { id: {} }` answers the bare
  `Raptor 3 G1 update operator is not implemented: ` where the shipped
  engine answers `QueryEngineError: Unknown update operation: ` — parity from
  the same owner (`Queries.updateValue` or the admission that reaches it):
  the shipped sentence and identity, before any statement. Pin it.
- **Note 4 — R-D3's class.** Keep `QueryEngineError` as Arnaud worded it;
  record in the note that `UnsupportedOperationError` (V8003) would satisfy
  the decision too and distinguishes a boundary from a crash — one line for
  Arnaud in the ledger, no code.
- **Note 6** — update the §R4.8 request row's figures in place (119 / 109 /
  118) or point it at §D.4.
- Then the guide (part 1) is written knowing the nested sites are covered:
  the R-D2 paragraph states the rule at the root owners AND the nested
  positions, with the owner named; no absolute the code does not carry.

Re-run for part 0 (in addition to part 3's list): the estate on live MySQL
(`VIBORM_RAPTOR3_PROVIDER=mysql VIBORM_RAPTOR3_PROVIDER_PORT=$(docker port viborm-raptor3-g3-mysql-20260914 3306 | head -1 | cut -d: -f2)` with the same `--workspace`), the reviewer's two probes
`nested-key-refusal.review.test.ts` and `key-refusal-parity.review.test.ts`
(their workspace file is beside them), `g2-mysql-contracts`, `g2-pg-contracts`.
The registered modes `g4-unit02-author`, `g4-unit02-mysql-contracts` and
`g4-unit02-pg-contracts` exist since 17:13 with counts the integrator
re-derives; if you add cells, report the new per-file counts (do not edit
the manifest). Regenerate `g4/unit02/production-closure.patch` and
`tests-closure.patch` with the new hashes and add a "Decisions round 2"
section to `g4/unit02/note.md`.
