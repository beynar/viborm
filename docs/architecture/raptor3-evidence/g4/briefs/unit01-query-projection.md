# G4-01 brief — complete query and projection semantics

Read `common.md` first. You are the sole production author for this unit.

## Where you work

Isolated worktree **`/private/tmp/viborm-g4-unit01`** (detached at
`0cc61e61`, dependencies installed, better-sqlite3 binding built). All your
edits and test runs happen there. The main tree `/Users/arnaud/code/viborm` is
read-only for you (other streams edit it concurrently). The workspace lock is
shared with the main tree, so test runs serialize automatically.

Evidence directory (absolute, shared): 
`/Users/arnaud/code/viborm/docs/architecture/raptor3-evidence/g4/unit01/`.
Write `note.md`, `handoff.md`, receipts and your final `production.patch`
(`git diff` of your worktree, production files only) there. Do not write
evidence into the worktree.

## Files you own (in the worktree)

- `src/query-engine/raptor3/shared/query.ts` (primary).
- `src/query-engine/raptor3/shared/schema.ts` (`Arguments`, `admit`, new
  admitted operations; keep `EngineSchema` factory-scoped and immutable).
- `src/query-engine/raptor3/commands/index.ts` (read-verb dispatch; writer
  transferred to you for this unit; keep the private `execute`/`prepareBatch`
  boundary shape).
- `src/query-engine/raptor3/commands/selection.ts` and `commands/commands.ts`
  only where a read-semantic fact (prepared selector/projection facts) must
  be consumed; no write-semantic changes.
- `src/query-engine/raptor3/shared/operation-context.ts` is **not** yours.
  If `read`/`finishOne`/`finishMany`/`finishValue` need a change, write the
  exact request in `note.md` and, if it is small and unavoidable for a read
  to execute at all, make it and flag it prominently in your handoff for the
  G4-02 writer transfer.
- Focused tests you author go under `tests/raptor3/g4/unit01/` in the worktree
  (these are author checks; the independent witness author owns
  `tests/raptor3/g4/*.test.ts` in the main tree and will not see yours).

## Outcome

Complete C01/C12 through the existing shaped/correlated query owners so that
every inventory row below executes through `createCommandEngine(...).execute`
on real SQLite (and, where lowering differs, produces the adapter-spelled SQL
for PostgreSQL and MySQL adapters even though you cannot run native providers):

- OP-R01 `findUnique` (+ `findUniqueOrThrow` absence → the established
  not-found error identity used by the shipped engine), OP-R03 `findFirst`
  (+ `OrThrow`), OP-R05 `findMany` with `distinct` and `cursor`, OP-R06
  `count` (number and selected `{ _all, field }` object), OP-R07 `exist`,
  OP-R08 `aggregate`, OP-R09 `groupBy` full (`having` AND/OR/NOT with scalar
  and aggregate predicates, aggregate ordering, paging).
- Q-W01–Q-W10 filters: string `contains`/`startsWith`/`endsWith` with `mode`
  and escaping, `notIn`, list `equals/has/hasEvery/hasSome/isEmpty`, JSON
  path/sentinel/string/array predicates, GeoPoint equality/within/distance
  tiers per adapter capability, to-one shorthand plus `is`/`isNot` with slot
  nullability, collection `some/every/none`, tagged variant predicates.
- Q-O01–Q-O04 ordering: `{ sort, nulls }`, to-one relation paths (≤ 8 hops,
  to-many refused by validation), collection `_count` order, vector/GeoPoint
  distance order with unambiguous output names.
- Q-P01–Q-P03 paging: cursor + signed take + skip at root; `distinct` before
  windowing; every to-many nested node with its own where/orderBy/take/skip/
  cursor/distinct/select/include/omit scoped per parent.
- Q-S01–Q-S03 projection: select/include/omit shapes, `_count` (true or
  per-collection with `where`), variant `{ only?, variants }` arms.
- Q-A01–Q-A02 aggregate shapes and refusals as the validation owner admits.
- Q-R01: provider rows, carriers and public arrays decoded once through a
  strict decoder that rejects malformed rows with the established error
  identities; fresh public containers (no shared/reused arrays or objects
  between results).
- SC-01–SC-14 and SL-01–SL-10 at the read side (filter operand lowering,
  projection/result decoding, cursor/order operands) using the existing
  codec owners. Keep `Queries.updateValue` the sole scalar-update owner; do
  not add arithmetic there in this unit (G4-02 completes multiply/divide).
- The recursive-read fit (`Queries.recursive`) must keep passing
  `tests/raptor3/prep/recursive-read-fit.test.ts` and must gain the fuller
  projection/codec vocabulary you add (depth-as-edges, path-local cycle stop,
  pruning and separate overlapping occurrences preserved).

Root `delete` (OP-W03) and write-side codec crossings for `data` values
belong to G4-02; do not implement them, but make sure `fieldValue`/`value`
remain the single value-lowering owner they can extend.

## Method

1. **Reconcile first (bounded).** Read `shared/query.ts` completely, `shared/
   schema.ts`, `commands/index.ts`, `operation-context.ts` `read`/`finish*`,
   the registered read tests (`tests/raptor3/candidate*.test.ts`,
   `tests/raptor3/post-prep/projection-preparation.test.ts`,
   `selector-preparation.test.ts`, `tests/raptor3/prep/recursive-read-fit.test.ts`),
   and for each inventory row the cited shipped evidence file(s) to learn the
   exact public contract (SQL shape is the adapter's business; semantics,
   result shape, error identity and refusal are the contract). Learn how the
   shipped engine reaches the adapter for each construct (grep
   `src/adapters/` for the capability names) so you reuse the same adapter
   vocabulary. Do not port the shipped builders.
2. **Write `note.md`** (decision-elimination gate) before the first edit. Name
   the duplicated ladders you will collapse (`lowerValuePredicate` versus
   `prepareScalarOperations`; `grouped()` shape assembly versus
   `prepareProjection`; the `findUnique` `take: 1` entry special case), the
   invariant that replaces each, and a falsifier.
3. **Freeze the handoff early.** Within your first two hours produce
   `handoff.md` revision 1 for G4-02: the `Query` value contract (sql, shape,
   expected cardinality, decoder ownership), how relation carriers are
   physically realized and which adapter capabilities decide it, what a
   provider must supply for each scalar codec, how cursor/distinct/`_count`/
   distance lower, what G4-02 must add for root `delete`, arithmetic and native
   recursive lowering, and executable examples plus falsifiers (a wrong-result
   specimen that must fail). Revise it if a later finding changes it and bump
   the revision.
4. **Implement by extension.** Extend the one prepared predicate, order,
   page, projection and decoder owners. Keep `prepareSelector` alias-free and
   `lowerSelector` alias-binding. Keep SQL and dependency facts in one
   traversal. Pure reads must not allocate write machinery. Grouped values
   use the projection shape without invented record keys. Nested pagination
   is the ordinary page operator inside the parent's correlation scope.
   Provide `findFirst`/`findUnique`/`count`/`exist`/`aggregate` as cardinality
   and shape decisions over the same select owner; do not create an aggregate
   engine or a separate nested-read engine.
5. **Check as you go.** Run your focused author tests and the existing
   registered read/projection/selector/recursive-fit suites through
   `node scripts/run-vitest-safe.mjs run <files>` in the worktree. Run
   `node scripts/run-typecheck.mjs` in the worktree before you hand off.
   Save receipts (JSON reporter output, bounded-runner resource line) under
   the evidence directory with the worktree identity from
   `captureRaptor3Identity()` (run it from the worktree root).
6. **Cost.** Run `node scripts/query-engine-structure.mjs` from the worktree
   and compute incremental core / complete charged LOC, tokens and bytes
   against the G3 figures using the same charged file lists as
   `docs/architecture/raptor3-evidence/g3/structure-correction/qualified-final/support/source-cost.json`.
   Explain growth honestly; new query semantics may add necessary code, but
   name every added rule and every removed decision.
7. **Hand off.** Write `production.patch`, finalize `note.md` (four §7
   questions answered against the diff), `handoff.md` (final revision),
   proposed private-guide (`raptor3/AGENTS.md`) paragraph text for the root
   to merge, requests for other owners, blockers, and unverified claims.

## Exit and return value

Return a JSON-like structured summary with: unit, worktree path, patch path,
note path, handoff path and revision, list of inventory rows implemented /
partial / not started with reasons, list of registered suites run with
pass/fail counts and receipt paths, typecheck result, cost figures
(incremental and cumulative core and complete charged LOC / tokens / bytes),
removed decisions, added rules, requests to other owners, blockers, and
unverified claims. No prose beyond those fields.
