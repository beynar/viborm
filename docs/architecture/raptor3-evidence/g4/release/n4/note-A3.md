# N4 group A3 — `shared/operation-context.ts` (rows 16, 23–27, 29–36)

Worktree `/private/tmp/viborm-n4`, branch `n4`, base `bf7ac30b4`. Written
files: `src/query-engine/raptor3/shared/operation-context.ts` and three new
pins under `tests/raptor3/g4/parity/`. `shared/transport-attempt.ts` was read
and needed no change: it holds no refusal sentence — the premise machinery the
executed rows use (`assertPremise` / `withholdPremises`) already fits.

## 1. The truth this group states

Four of its sentences were not what the census map says they are, and the
measurement is the unit's main product:

- **Two sentences guard states nothing constructs** (rows 31, 32). Both are
  deleted with their dead owners. Row 32's disposition in the map was
  "EXECUTE if reachable"; the measurement found a third answer — the shape is
  already implemented, at `remove`, and `clear` is its dead twin.
- **One executes exactly as the ruling says** (row 23), and restores the
  shipped engine's row answer that unit02 recorded as an accepted divergence.
- **One executes through the premises the ruling names** (row 25).
- **One does not execute, because the ruling's premise about it is wrong**
  (row 16). Measured and pinned, with the design and the blocker below.
- **Nine are integrity facts kept** (rows 24, 26, 27, 29, 30, 33–36), each
  named below with the one execution fact it owns.

The invariant owner `src/query-engine/raptor3/shared/invariant.ts`
(`EngineInvariantError`, `assertInvariant`, `unreachable`) already existed when
this group started; no row of this group needed an assertion, so it is imported
nowhere here. The name is agreed as written.

## 2. Per row

| # | sentence | disposition | what changed | the fact |
|---|---|---|---|---|
| 16 | `Raptor 3 G1 atomic output requires exact identity scratch or segmented RETURNING` | **MEASURED, not executed** — blocker | no production change; a new boundary pin `tests/raptor3/g4/parity/postgres-declared-type-scratch.test.ts` (3 cells, live PGlite) | The ruling's shape — "a produced field that is not one increment key" — is **unreachable**. A referenced field that is not the parent's key is refused first, by the create's own parent-id resolver ("referenced field 'code' is neither this record's primary key nor a knowable value in its own create data"), and a key field that is not generated is never absent from an admitted payload. So one produced field is always one increment key, which D-50 already carries. What DOES reach the guard is **more than one** produced field — a composite primary key whose two parts are both `increment` — which needs a **multi-column** store, not a width rule (§4). |
| 23 | `Cannot publish the updated value of 'X.f' for operation "op" inside an atomic batch …` | **EXECUTED** | `update()`'s batch arm collects the demanded fields the scratch cannot carry into `observed` instead of refusing, and after the UPDATE is queued takes an ORDERED OBSERVATION through the existing barrier (`flush`) at the row's post-update identity (`updatedIdentity`). `UnsupportedOperationError` import removed. | Under N1 a value an earlier write of this operation produces is read behind that write in the same native batch; the consumer's own write follows in the next (D-51's succession). The answer is the shipped engine's row, computed by the provider instead of in JavaScript. The array-preparation route keeps stating "this operation requires dynamic execution" (`incompletePreparation`, D-46) — its own control-flow value, not a caller-visible refusal. |
| 24 | `deleteMany selected-row cardinality changed during its locked mutation.` | **KEPT** | the literal sentence stays at its site; it is now also the failure the batch-route premises carry (row 25) | It owns one execution fact: the captured set's cardinality at the moment the mutation ran. Under row 25 the premise states the same fact earlier; the row count remains the detection, because a batch that reports a different count than the capture named is a fact only the provider can report. |
| 25 | `Driver 'X' cannot atomically capture selected ${operation} rows.` | **EXECUTED** | `captureMutationIdentities` drops the refusal, takes `FOR UPDATE` only where a session holds it, and on the batch route reads through `flush` — the capture is a segment of its own. New `requireCapturedSet` states the premises inside the MUTATION's batch; new `capturedMutation` runs the mutation in that same batch and answers its own row count by its own position. | A batch-only transport holds no lock across two statements, so the capture is an observation, not a lasting truth (rule 5/6). The premises are the same two the series capture already uses: every captured identity still present and still a member (`requirePresent` with the selector), and — for an unlimited capture — no row joined it (`requireAbsent` of `selector ∧ key ∉ captured`). A stale observation aborts the unit before anything is written. |
| 26 | `Driver 'X' cannot locate one selected createMany row after insertion.` | **KEPT** | nothing | A provider limit: a non-RETURNING driver (MySQL) that cannot name an inserted row because the model's generated identity is not one trackable `increment` field. No other owner states it, and no mechanism on that transport answers it. |
| 27 | `Driver 'X' omitted the prepared result for operation 'op'.` | **KEPT** (two sites) | nothing | One transport fact: the prepared-batch protocol's caller returned fewer results than the operation queued. Nothing else checks the returned array's length against what was queued, and it is not reachable from a query payload at all. |
| 29 | `INSERT did not produce the required record identity` | **KEPT** | nothing | One provider fact: a driver that reports a successful auto-increment INSERT and supplies no last-insert-id. It is the only place that fact is observable. |
| 30 | `INSERT RETURNING did not produce the required record` | **KEPT** | nothing | The segmented-RETURNING arm's own cardinality fact: the identity segment read back zero rows for the row it just produced. Distinct from #28 (the folded fast path) because it is the only owner of the segment boundary. |
| 31 | `Raptor 3 atomic-array execution is not implemented.` | **DELETED** (variant + guard) | the `{ kind: "atomic-array" }` member of `ExecutionBinding` and the constructor guard are gone | Established upstream by the route: `grep -rn 'atomic-array' src/` now returns **zero TypeScript hits** (one prose line remains in `AGENTS.md`, §5d). `route/client-route.ts` constructs only `"borrowed-transaction"` or leaves the binding absent, and the public `$transaction([...])` runs through the client's own array owner. The compiler now states what the guard stated at runtime. |
| 32 | `Raptor 3 G1 set requires junction storage` | **DELETED** (the whole dead method) | `OperationContext.clear` removed | Reachability was established first, and the answer is stronger than "unreachable": `clear` has **no caller at all** (`grep -rn '\.clear(' src tests` finds only `batchRefs.clear`). A set's clear is placed by `relation-body.ts:clearMembership` as `{ kind: "remove", keep: [] }` and executed by `OperationContext.remove`, which handles a NON-junction edge by nulling its `clearability.columns` — the mechanism the sentence called unimplemented. `clear` was `remove`'s junction arm, duplicated and orphaned (ELEGANCE §9/§10). Nothing was refused at the schema to move a sentence. |
| 33 | `Raptor 3 interactive output requires RETURNING or one generated increment field` | **KEPT** | nothing | A provider limit, and the interactive twin of #16: a `create` demanding a generated field on a driver without RETURNING whose identity is not one `increment` key. Nothing on that transport can name the row. |
| 34 | `UPDATE did not produce the required record` | **KEPT** (and now also the observation's own cardinality, row 23) | nothing (its site is unchanged; row 23's observation reuses the same sentence) | One concurrency fact: the row this update just wrote is gone by the follow-up read. Row 23's ordered observation is the same read in the batch route's shape, so it states the same sentence — one semantic rule across its consumers, not a second one. |
| 35 | `UPDATE RETURNING did not produce the required record` | **KEPT** | nothing | The RETURNING variant of #34: zero rows for a captured identity the statement itself addressed. A separate owner because the statement, not a follow-up read, is what answered. |
| 36 | `updateMany selected-row cardinality changed during its locked mutation.` | **KEPT** | as #24 | The update variant of #24, same class, same two consumers after row 25. |

## 3. Hunks (`src/query-engine/raptor3/shared/operation-context.ts`, +166 / −104, 2993 → 3055 lines when this note was written; +174 / −104, 2993 → 3063 on the final tree — see the addendum)

- imports: `UnsupportedOperationError` removed (row 23).
- `ExecutionBinding`: the `"atomic-array"` member removed (row 31).
- constructor: the 13-line `atomic-array` guard removed (row 31).
- `updateMany` captured arm: the cardinality sentence becomes a shared
  `changed()` factory; `requireCapturedSet` before the mutation;
  `capturedMutation` replaces the direct `_execute` (row 25).
- `deleteMany` captured arm: the same three changes (row 25).
- `captureMutationIdentities`: the refusal removed; `forUpdate: !usesBatch`;
  the capture reads through `flush` on the batch route (row 25).
- new `requireCapturedSet` (premises) and `capturedMutation` (the mutation in
  its premises' batch, answered by its own index) (row 25).
- `update()` batch arm: `observed` replaces the refusal; the ordered
  observation after `effect` (row 23).
- `clear()` deleted (row 32).

## 4. Row 16 — the design, and why it is a blocker here

The store never depended on WHICH column it carried; only the read did
(`CastType` `"integer"` / `"bigint"`). Two things are needed, and only the
first is a width rule:

1. **One cast owner**: the scratch read casts at the column's DECLARED type
   (`ScalarType` → `CastType`). Contained in this file — but by itself it buys
   nothing, because a single produced field is always an `int`/`bigint`
   increment key (§2 row 16). Adding it now would be generality for an
   imagined consumer (ELEGANCE §10), so it is NOT added.
2. **A multi-column store**: `storeReturning` / `storeInsertedKey` take ONE
   `(key, column)` pair and wrap the INSERT, so they cannot be called twice for
   one statement. Carrying a composite generated key needs
   `storeReturning(batchId, insert, refs: readonly {key, column}[])`, spelled
   on PostgreSQL as one CTE with one `SELECT … UNION ALL SELECT …` outer
   INSERT.

**Blocker.** (2) changes the adapter seam
(`src/adapters/adapter-core-types.ts`, `src/adapters/shared/batch-refs.ts`,
`src/adapters/databases/postgres/postgres-adapter.ts`) and re-expresses the
D-50 contract cells that call those two functions positionally
(`tests/contracts/adapters/internals-and-geo.core.test.ts:244-307`, and the
`dialect-vocabulary` cast cell) — all outside this group's files. The D-50
note already recorded "widening the scratch to every produced column is a
follow-up for a ruling". The ruling that came (plan §4) named a shape that
does not reach the guard, so **row 16 needs a corrected ruling**, not a patch.
The pin records the boundary so that whoever executes it re-expresses one cell.

## 5. Requested changes in files this group does not own

**(a) `tests/raptor3/ownership/commands.test.ts:333-386`** — required: it is
the one whole-estate typecheck error left by this unit
(`error TS2322: Type '"atomic-array"' is not assignable to
type '"borrowed-transaction" | "standalone"'` at `:376`). The recorded
expectation ("refuses atomic-array binding before admission or provider work")
is what row 31's ruling deleted; re-express it as the compile-time fact that
replaced it rather than dropping it:

```ts
  it("constructs no atomic-array binding: the union has two kinds", () => {
    // N4 (plan §4, D-52): the `"atomic-array"` variant was a capability
    // refusal guarding a state nothing constructs — `route/client-route.ts`
    // builds only `"borrowed-transaction"` or leaves the binding absent, and
    // the public array form runs through the client's own array owner. The
    // variant and its refusal are deleted; the compiler states the fact the
    // constructor used to state at runtime, which is strictly stronger.
    const kinds: ExecutionBinding["kind"][] = [
      "borrowed-transaction",
      "standalone",
    ];
    assert.equal(kinds.length, 2);
    // @ts-expect-error — the variant no longer exists.
    const gone: ExecutionBinding = { kind: "atomic-array" };
    assert.equal((gone as { kind: string }).kind, "atomic-array");
  });
```

(with `import type { ExecutionBinding } from "@query-engine/raptor3/shared/operation-context";`
added, and the now-unused `rawArgs` / counter scaffolding of the old cell
removed with it). The three other `"atomic-array"` strings in
`tests/raptor3/g3/generation/**` are the recipe's own COMPOSITION vocabulary,
not this binding kind, and must not be touched.

**(b) `tests/raptor3/g4/unit02/key-arithmetic.test.ts:531-556`** — the two
R-D3 cells. Row 23's ruling changed the answer, and the new answer is the one
the file itself records as the shipped engine's:

- `increment`: `answer` becomes `ok:{"id":7,"label":"a"}` and `rows` becomes
  `[{ id: 7, label: "a" }]`;
- `multiply`: `answer` becomes `ok:{"id":12,"label":"a"}` and `rows` becomes
  `[{ id: 12, label: "a" }]`;
- the `raised instanceof UnsupportedOperationError` / `meta` assertions go with
  the refusal, and the describe block's prose becomes "the batch publication
  gap is closed by an ordered observation (N4 row 23)". The divergence note in
  the block comment ("the shipped engine computed the value in JavaScript and
  answered the row") should say that the candidate now answers the same row,
  computed by the provider. **This file is also the query.ts group's (row 13
  lives at `:470`), so the integrator should apply (b) once.**

**(c) `tests/raptor3/g4/review/unit02-decisions/batch-publication-identity.review.test.ts:127-191`**
— the probe cell "names every non-int domain with the same registered identity,
and dispatches nothing". All three domains (decimal, bigint, number) now answer
their row and DO dispatch their write. Re-express as "publishes every non-int
domain through the ordered observation". Not part of any registered project
(its own `review.workspace.ts`), so it is not estate-red.

**(d) `src/query-engine/raptor3/AGENTS.md:402-404`** — "An `atomic-array`
binding is a capability refusal and must throw `TransactionError` before
raw-argument admission or provider work — it is raised in the constructor,
before `admit`." Replace with: "There is no `atomic-array` binding: the private
boundary takes `"borrowed-transaction"` or no binding at all, and the public
array form is the client's own array owner (N4, plan §4)." The paragraph on
`OperationContext.clear` — if any — goes with row 32.

**(e) `scripts/raptor3-manifest.mjs`** — register the two deterministic pins in
`G4_PARITY_COUNTS` (`"tests/raptor3/g4/parity/batch-observed-publication.test.ts": 10`,
`"tests/raptor3/g4/parity/batch-captured-bulk.test.ts": 6`) and the live one in
`D50_PROVIDER_TESTS` (`"tests/raptor3/g4/parity/postgres-declared-type-scratch.test.ts"`).
N1's own pin (`ordered-observation.test.ts`) is unregistered too, so the
integrator should do all of them in one edit.

## 6. Falsification record

Method (memory rule "falsify with a backup copy"): `cp` the working file to
the scratchpad, `git show bf7ac30b4:<file>` over it, run, `cp` back, `diff` to
prove the restore. Never `git checkout`.

| pin | at `bf7ac30b4` | with this unit |
|---|---|---|
| `tests/raptor3/g4/parity/batch-observed-publication.test.ts` | **4 / 10 red** — the four batch-only cells raise `UnsupportedOperationError: Cannot publish the updated value of 'numKey.id' … 'id' is a number field.` / `… 'bigKey.id' … is a bigint field.`; the six live-route cells were already green (the live route always observed). Receipt: `receipts-A3/falsify-row23-base.log` | 10 / 10 |
| `tests/raptor3/g4/parity/batch-captured-bulk.test.ts` | **5 / 6 red** — `TransactionError: Driver 'sqlite3' cannot atomically capture selected deleteMany / updateMany / delete rows.`; only the live-route control was green. Receipt: `receipts-A3/falsify-row25-base.log` | 6 / 6 |
| `tests/raptor3/g4/parity/postgres-declared-type-scratch.test.ts` | green at the base by construction — it pins the boundary row 16 did NOT move. Its second cell is the falsifiable one for whoever executes row 16. | 3 / 3 |
| row 31 | proof is a grep, not a cell: `grep -rn 'atomic-array' src/` = 1 hit, the `AGENTS.md` prose of §5d; 0 in TypeScript (was 3, all in `operation-context.ts`). | |
| row 32 | proof is a grep: `grep -rn '\.clear(' src tests` finds only `batchRefs.clear` (no `OperationContext.clear` caller ever existed). | |

## 7. Runs

All under `TMPDIR=/private/tmp/viborm-n4-A3-tmp`, one vitest at a time,
through `scripts/run-vitest-safe.mjs` (SQLite) or the scratchpad's
`run-shared-family.mjs` (PGlite). Logs in `receipts-A3/`.

| run | result |
|---|---|
| the three pins | 19 / 19 |
| `tests/raptor3/g4/parity` (8 existing files: ordered-observation, staleness, membership-race, lane-x set mutations, lax-to-one, series-member-premise, upsert-array-route, increment-key-width) | 132 / 132 |
| `tests/raptor3/g4/unit02` | 280 tests, **4 red** — `key-arithmetic.test.ts`'s two R-D3 cells × two projects (§5b) |
| `tests/raptor3/g4/unit01` + `review/unit02-decisions` + `review/cutover` | 166 / 166 (the review probe suite's own workspace is separate, §5c) |
| `tests/raptor3/g4/*.test.ts` (top level) | 124 / 124 |
| `tests/raptor3/ownership` + `tests/raptor3/post-prep` | **1 red** — `ownership/commands.test.ts` atomic-array cell (§5a); the rest green |
| `tests/raptor3/transitions` (two halves) | 868 / 868; 12 files not run (`raptor3-live-provider`: "Required live provider is pg or mysql", Docker not up) |
| `tests/raptor3/expanded` + `prep` + `polish` + `core-structure` | **1 red** — `core-structure/measurement/cs02-structure-measure.test.ts` (below); the rest green |
| `review/unit02-decisions/batch-publication-identity.review.test.ts` (own workspace) | 1 red / 1 green (§5c) |
| `node scripts/run-typecheck.mjs` (whole estate) | **1 error**, `tests/raptor3/ownership/commands.test.ts(376,55)` — §5a. No other diagnostic, including none from the other groups' in-progress edits at the time of the run. |
| `npx biome check` on the written files | `operation-context.ts`: the SAME 6 diagnostics as its `bf7ac30b4` copy (1 `format`, 1 `organizeImports`, 4 `noParameterProperties`), line numbers shifted only — the formatter was NOT run on it, per the brief. The three new test files: clean (they are new, so `biome check --write` was applied to them). `transport-attempt.ts`: clean, unchanged. |

**`cs02-structure-measure.test.ts` is not this group's.** It was re-run with
ONLY `operation-context.ts` reverted to `bf7ac30b4` and stayed red (2 / 2),
with the same `activationIds: []` vs
`['activation:structure/depth-create/1:attempt/0/unconditional']` diff. At the
time of the run the shared worktree also carried other groups' edits to
`commands/commands.ts`, `commands/execution.ts`, `commands/index.ts`,
`commands/relation-body.ts`, `route/client-route.ts`, `shared/query.ts` and
`shared/storage.ts`; CS-02 measures command/activation structure, which is
their surface. Integrator: attribute it there or to the N1/N3 commits, not
here.

## 8. LOC

`operation-context.ts` 2993 → 3055 (+166 / −104, net +62) when this note was written; 3063 (+174 / −104, net +70) on the final tree. Deletions:
row 31 −14, row 32 −24 (38 lines of dead owner and its sentence). Additions:
row 23 +31, row 25 +78 (of which 65 are the two new methods and their
reasoning), minus 33 lines of replaced call-site code. New tests: 532 lines in
three files, counted separately.

## 9. Still red · unverified · blockers

**Still red** (all named above, all with an exact requested change):
`tests/raptor3/ownership/commands.test.ts` (1 cell + the estate's one
typecheck error), `tests/raptor3/g4/unit02/key-arithmetic.test.ts` (2 cells ×
2 projects), `batch-publication-identity.review.test.ts` (1 cell, unregistered
suite). Red and NOT this group's:
`tests/raptor3/core-structure/measurement/cs02-structure-measure.test.ts`.

**Unverified.**
- MySQL and Docker `pg` were not run (no containers up on this machine): the
  `raptor3-live-provider` files and every `*-docker.test.ts` are unmeasured.
  Row 25's execution is measured on a SQLite stand-in with
  `supportsReturning` forced false (PlanetScale-shaped); the real MySQL batch
  transport is unmeasured.
- Row 25's complement premise (`no row joined the selection`) has its unique
  coverage only where the capture's selector is NOT unique — a bulk
  `updateMany`/`deleteMany` on a non-RETURNING batch transport. That is
  exactly the fixture above, and the cell exercises it; on a RETURNING batch
  transport only the root `delete`/`update` shape reaches the capture, whose
  selector is unique, so the complement is vacuous there. Named here because
  a guard whose unique coverage cannot be named is banned.
- `tests/contracts/engine/write` could not be run: the `coverage-write-engine`
  project exceeds the runner's 1536 MiB ceiling on this machine even with
  three files. Not attempted further.
- Row 23 changes ATOMICITY on the batch route for the shapes it executes: the
  update's segment now commits before the consumer's write, which is D-51's
  stated succession but is a real change for a caller who assumed one batch.
  Worth Arnaud's eye.
- Coverage (`coverage:query-engine-core` floors) was not measured.

**Blockers.** Row 16, §4: the ruling's premise is contradicted by
measurement, and the reachable shape needs an adapter-seam change plus two
D-50 contract cells outside this group. Needs a corrected ruling.

## Integrator's addendum (after the Opus review)

- **Row 25.** `capturedMutation` now declares its statement as the operation's
  set window (`this.setWindow = member`, as `setMutations` does), so a write
  the provider rejects reports no record-series progress — the review found it
  publishing `recordSeriesProgress` for a merely uncertain outcome; a seventh
  cell in `batch-captured-bulk.test.ts` pins it. It indexes the response by the
  queue position alone (`submit` slices its guards off; the `continuationCount`
  term was inert today and wrong the day a continuation precedes a captured
  mutation) and states #27's omitted-result fact where its siblings do. Two
  disclosures the review measured: a DateTime primary key on this route answers
  the provider's bind error (`Queries.scalarValue`'s datetime arm binds the
  decoded `Date` as given — a pre-existing defect the refusal stood in front
  of, reachable at the base on the live non-RETURNING capture; recorded for N5
  in the unit note §6), and the premise segment is N + 2 statements for N
  captured rows.
- **Row 23.** The fifth `throw this.incompletePreparation` site in the
  demanded-field loop is deleted: `submit` states the fact when the observation
  is flushed, and no cell distinguished the earlier throw.
- **§3 / §8.** On the final tree `operation-context.ts` is +174 / −104, 2993 → 3063 lines (net +70): the +166 / −104 and 3055 above were measured before the integrator's and the review's resolutions landed.
