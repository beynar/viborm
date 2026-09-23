# Release unit "coverage" — author note

**Unit.** `coverage` — close every coverage scope's gap under its floor with
real unit cells at the owners, or with deletions of unreachable blocks, until
`pnpm test:coverage` exits 0.
**Brief.** [`brief.md`](brief.md) (with
[`g4/briefs/common.md`](../../briefs/common.md), the twelve rules).
**Base.** `54a34e059` (branch `coverage`, worktree
`/private/tmp/viborm-coverage`, `TMPDIR=/private/tmp/viborm-coverage-tmp`).
**Evidence.** [`receipts/`](receipts/).

**Outcome.** Three scopes closed to 100 % (`validation`, `errors`, `adapters`)
and one brought back over its floors (`drivers`). `pnpm test:coverage` does NOT exit 0: two
scopes are blocked on facts this unit may not decide — `query-engine-core`
measures 10,451 statements whose suites run in a project the lane does not run
(§5.1), and `write-engine` aborts on a test that was already failing at the
base commit (§5.2). Both are recorded as blockers with reproducers.

---

## 0. Decision-elimination gate (written before the first production edit)

### 0.1 Required behavior

None changes. Every cell below asks an EXISTING refusal of the schema or the
boundary that already owns it; the three deletions remove guards whose arm no
admitted payload and no caller can reach, so nothing observable moves.

### 0.2 Current owner, and the smallest change

| Block | Owner | Change |
| --- | --- | --- |
| `validation/model/args/aggregate.ts:865` `if (!Array.isArray(by)) return undefined;` | `groupByCollisions`, the `refuse` of the one `groupBy` args object | delete the guard |
| `validation/model/args/mutation.ts:73` `if (!Array.isArray(rows)) return undefined;` | `refuseDefaultOnlySkipDuplicates`, the `refuse` of all four `createMany` spellings | delete the guard |
| `validation/parse-failure.ts:24,27` the `typeof`/`null` test and the `try/catch` | `readValidationFailureCause`, read by three call sites | delete both; the parameter becomes `object` |

Everything else in this unit is a TEST-only addition.

### 0.3 The decisions that disappear

| Decision | Mechanism | Consumers | Replacing invariant | Falsifier |
| --- | --- | --- | --- | --- |
| "Might a `refuse` callback be handed a `by` that is not a column set?" | an `Array.isArray` re-test inside `groupByCollisions`, after `v.object` already validated the key | none — `groupByCollisions` is the `refuse` of exactly one object (`aggregate.ts:915`) | **The object schema admits the shape.** `by` is `v.union([v.array(scalarSchema), v.shorthandArray(scalarSchema)])` under `atLeast: ["by"]`, and `v.object` answers `Missing required field: by` (`primitives/object.ts:730-739`) before any `refuse` runs, so `refuse` only ever sees an array | **registered**: `aggregate-args.core.test.ts` "output: a missing by is refused before the collision question" fails if the required-key rule stops answering first |
| "Might a `refuse` callback be handed a `data` that is not a row list?" | an `Array.isArray` re-test inside `refuseDefaultOnlySkipDuplicates` | none — all four registrations (`mutation.ts:128`, `relations/create.ts:173`, `relations/update.ts:433`, `relations/polymorphic/collection-mutation.ts:294`) spell `atLeast: ["data"]` over `data: v.array(...)` | same invariant, same owner | **registered**: `mutation-args.core.test.ts` "runtime: a missing data array is refused before skipDuplicates is asked" fails if the required-key rule stops answering first |
| "Might the retained parse cause be read off something that is not a parse result?" | a `typeof`/`null` test and a `try/catch` around `Reflect.get`, inside `readValidationFailureCause` | the three call sites (`query-engine/cache-flow.ts:116`, `:242`, `write-engine/parse-boundary.ts:52`), each passing a `ParseResult` **that `parse` itself built** | **The type states it.** The parameter is `object`; the whole-estate typecheck proves every caller passes one, and a symbol read off a plain object the library constructed cannot throw | **registered**: `parse-boundary.core.test.ts` pins the two arms that remain (a retained sanitized cause, and `undefined` for an ordinary refusal); the typecheck fails if any caller starts passing a non-object |

**Not claimed.** No floor moved, no ignore comment was added to silence a
coverage gap, and no existing test was deleted, weakened or skipped. The only
`biome-ignore` added is `lint/style/useThrowOnlyError` on two deliberate
non-Error throws, the convention this estate already uses
(`tests/unit/schema-json/serialize.core.test.ts:283`).

---

## 1. `validation` — 98.73 / 99.4 / 99.57 / 98.73 → 100 / 100 / 100 / 100

Receipts: [`receipts/validation-before.txt`](receipts/validation-before.txt),
[`receipts/validation-after.txt`](receipts/validation-after.txt),
[`receipts/validation-after-summary.json`](receipts/validation-after-summary.json).

| Block | Class | What was done |
| --- | --- | --- |
| `builder.ts:61-65` + branch 60 — the registry proxy's `does not exist` refusal | **b** — reachable (`createSchemaRegistry(s).proxy.ghost`, and `client/schema-introspection.ts:120`), pinned by no test at all. It was a gap before this program too. | `tests/unit/validation/registry.core.test.ts` "a property that is not a registered model is refused by name" — asserts the registered issue and `source`, for a missing name and for a symbol key |
| `builder.ts:126-182` — the whole `SchemaRegistry.validate` method | **a** — reached from `validateOperationPayload` / `renderOperationResultType` (`src/client/schema-introspection.ts:151`, `:186`), which the **client** lane measures, not this one | six cells in the same file: the normalized happy path, the unknown-model refusal, the unknown-operation refusal, a field issue's dotted path, a whole-object refusal's empty path, and the two containment arms for a validator that throws an Error / a non-Error |
| `index.ts` branches 107, 109 — the two malformed-result arms of `parse` | **b** — reachable from the public `parse` with any foreign StandardSchema; only the `null`-result arm was pinned (`decimal.core.test.ts:475`) | `tests/unit/validation/parse-boundary.core.test.ts` — "issues that are not an array", "neither issues nor a value", plus the positive control that `{ value: undefined }` is a success and not malformed |
| `parse-failure.ts:11` + branch 10 — the non-Error throw arm | **b** — reachable whenever a foreign schema throws a non-Error; the Error arm was pinned (`object.core.test.ts:739`), this one was not | same file — "a non-Error thrown by a foreign schema is normalized into one" |
| `parse-failure.ts:22-30` — `readValidationFailureCause` | **a** for its two live arms (exercised from `cache-flow.ts` and `write-engine/parse-boundary.ts`, both outside this scope), **c** for the `typeof` test and the `try/catch` | two cells for the live arms; the two dead guards deleted (§0.3) |
| `scalars/json.ts:132-192, 209, 225-226` — the JSON string-path grammar, its six refusals and the portability rule | **a** — pinned end to end by `tests/contracts/engine/query/parity-admission.core.test.ts:229-261`, which runs in `layer-query-engine` | `tests/unit/scalars/json-scalar-schemas.core.test.ts` → `describe("filter path grammar")`: one cell per refusal sentence (asserting the exact registered sentence, grammar clause included), plus the two accepting controls (`$` alone, `$.a.b[0][12].c`), the non-string/array operand, and the portability rule in both spellings |
| `scalars/json.ts:270-278` — the inert-`mode` refusal | **a** — pinned by `parity-admission.core.test.ts:275-292` | same file → `describe("filter mode")`: governed, inert, inherited-by-`not`, sentinel-`not` (inherits nothing), and `mode: "default"` |
| `model/args/aggregate.ts:872-873` — the grouped-column / aggregate collision | **b** — reachable (a model field named `_count`), pinned nowhere: the duplicate-`by` half is pinned in `parity-admission.core.test.ts:294`, this half is not, because no fixture schema there declares a field named after an aggregate | `aggregate-args.core.test.ts` → `describe("GroupBy Args - aggregate name collisions")`: `test.each` over all five aggregate keys plus the negative control |
| `model/args/aggregate.ts:865` | **c** | deleted (§0.3), with its ordering falsifier |
| `model/args/mutation.ts:80` — the default-only `skipDuplicates` refusal | **a** — pinned at all four spellings by `parity-admission.core.test.ts:301-363` | `mutation-args.core.test.ts` → `describe("CreateMany Args - default-only rows")`: the refusal, the legitimate default-only row without `skipDuplicates`, explicit rows with it, and `skipDuplicates: false` |
| `model/args/mutation.ts:73` | **c** | deleted (§0.3), with its ordering falsifier |

## 2. `errors` — branches 98.71 → 100

Receipts: [`receipts/scopes-before.txt`](receipts/scopes-before.txt),
[`receipts/scopes-after.txt`](receipts/scopes-after.txt).

All eight arms were in `src/errors/validation.ts` and all eight were the same
fact: **every** `ValidationError` in the lane was built with two arguments, so
the third — `{ cause, diagnostics, meta }` — was never read. Class **a**: the
registry and the write parse boundary both pass it
(`validation/builder.ts:139`, `write-engine/parse-boundary.ts:52`), from lanes
that are not this one.

One cell at the owner of the neighbouring cells,
`tests/contracts/public-client/errors/public-helpers.core.test.ts` — "carries
validation options into the source, the meta and the cause": a string
operation source whose `meta.model` names the model (the `{ model }` arm and
the `{ ...meta, operation }` arm), a `meta.model` that is not a string (the
narrowing arm), and a non-operation source with meta (the `{ ...meta }` arm).

## 3. `adapters` — 99.7 / 100 / 99.51 / 99.7 → 100 on every metric

Two uncovered functions in `src/adapters/constraint-identity.ts`: the NAMED
dialects' `unique` and SQLite's `primaryKey`. Class **b** — both are reached by
the drivers' error mapping, but the cell that owns the seam
(`tests/contracts/adapters/internals-and-geo.core.test.ts:172`, "owns exact
provider constraint names without a public property") asked only the other
diagonal of the matrix.

The same cell now asks all four: a named dialect identifies a unique key by
CONSTRAINT, SQLite identifies a primary key by qualified COLUMNS (asserted with
a two-column key, so the mapping is the fact and not one column's spelling).

## 4. `drivers` — 95.94 / 92.41 / 96.1 / 95.94 (floors 96 / 92.5 / 96 / 96)

The lane was **5 statements and 3 branches** short. Two blocks, both class
**b**:

- `shared/driver-options.ts:87-91` — the `namespace` option's narrowing
  refusal. Reachable from all seven driver constructors and the seven
  convenience wrappers; the file's owner test
  (`tests/contracts/drivers/namespace-options.core.test.ts`) pinned the system
  name and the grammar refusals but not the type one. What the narrowing
  uniquely buys is that `namespace: 5` cannot be DROPPED into PostgreSQL's
  `public` default — that is what the new cell asserts, by its exact message.
- `execution-context.ts:148-151`, `:174-177` — the `?? snapshotExternal…` arm
  of `deriveStatementExecutionContext` and `bindExecutionTransactionPhases`.
  An untrusted caller context is the ORDINARY case at both call sites
  (`client/array-transaction.ts:313` binds phases on `context ?? {}`;
  `raptor3/shared/operation-context.ts:392` derives from the caller's own
  object), but both callers are measured by other lanes. Two cells in
  `tests/contracts/drivers/shared-driver-boundaries.core.test.ts` assert that
  the snapshot is a NEW frozen context carrying exactly the public fields, that
  the derived one re-attributes the model, and that the phases are readable
  only through the owner and never attached to the caller's own object.

96.05 / 92.58 / 96.1 / 96.05 against floors 96 / 92.5 / 96 / 96 — over on every metric (`receipts/verify-scope-drivers.log`)

Also added in this scope, omitted above: `tests/contracts/drivers/pinned-session-condemned.core.test.ts` — one cell asserting the exact event order of a condemned pinned session (a real ordering assertion, read by the reviewer).

## 5. Blockers — `pnpm test:coverage` does not exit 0

### 5.1 `query-engine-core` measures a tree its lane does not run

Measured on the untouched base tree (receipt:
[`receipts/scopes-before.txt`](receipts/scopes-before.txt), breakdown:
[`receipts/query-engine-core-breakdown.json`](receipts/query-engine-core-breakdown.json)):

```
query-engine core thresholds: statements 55.12% (floor 98%), branches 75.78%
(floor 97.9%), functions 70.19% (floor 98%), lines 55.12% (floor 98%)
```

This is not a set of gaps. The scope is `src/query-engine/**` minus
`write-engine/` — **13,684 statements**, of which **10,451 are
`src/query-engine/raptor3/**`**, the candidate engine. The lane runs two
projects, `layer-query-engine` (32 explicit contract files) and
`coverage-write-engine-core` (4), and **neither runs `tests/raptor3/**`** —
the raptor3 engine's own suite estate, which lives in the `raptor3` project
and which the G4 rules forbid running during unit work ("Never run the full
G3/G4 campaigns"). Measured slices:

| Slice | Covered / total statements | % |
| --- | ---: | ---: |
| whole scope | 7,543 / 13,684 | 55.12 |
| `raptor3/**` | 5,448 / 10,451 | 52.13 |
| everything else | 2,095 / 3,233 | 64.80 |

So the rest of the scope is 33 points short too, and for the same reason: its
biggest uncovered modules have their runtime owners in OTHER lanes.
`result/result-shape.ts` (342/369 uncovered), `result/result-column.ts`
(52/55) and `result/result-aggregate-leaf.ts` (22/23) are imported at runtime
by `src/client/typescript-type-renderer.ts` alone — the **client** lane.
`result/cache-result-codec.ts` (205/205) has **no runtime importer at all**:
`cache-flow.ts:25` and `pending-operation.ts:32` both import it
`import type`, so nothing in `src/` constructs it.

**Why this is a decision and not work.** Closing it means answering "which
suites measure `src/query-engine/**`", and the one owner of that answer is
`scripts/coverage-policy.mjs`. Every candidate answer changes what CI runs, or
deletes production modules this unit does not own:

1. give `src/query-engine/raptor3/**` its own coverage subsystem, with the
   raptor3 projects and its own floor (CI then runs the campaigns under
   coverage — hours, and the G4 rules forbid it here);
2. add the raptor3 project(s) to the `query-engine-core` lane (same cost);
3. re-own the `result/**` modules by the lanes that import them (client), and
   decide whether `cache-result-codec.ts` is dead after the retirement
   (`g4/pattern-retirement/note.md` kept `result/` at "exactly the 7 files
   `cache-flow.ts`, `pending-operation.ts`, `client/typescript-type-renderer.ts`
   and `raptor3/route/client-route.ts` import" — two of those seven are kept by
   TYPE-only edges, which is the case this unit cannot decide alone).

Recorded for Arnaud. Nothing in this unit touched the lane.

### 5.2 `write-engine` aborts on a test that was already failing

The lane never reaches a threshold line: its part 2/2 fails first. Receipt:
[`receipts/write-engine-neon-failure.log`](receipts/write-engine-neon-failure.log).

```
FAIL |coverage-write-engine| tests/contracts/engine/write/neon-committed-segments-capability.test.ts
  > generated scalar create and upsert return from one native Neon request
TransactionError: Driver "neon-http" does not support callback transactions and
this transaction contains operations that cannot be batched atomically.
```

Measured on the untouched base tree at 00:56, before this unit's first edit;
the other 11 cells of the same file pass. The test drives
`client.$transaction([upsert, create])` on a driver with no callback
transactions and expects one native batch of two `INSERT … RETURNING`
statements. What raises the refusal is
`client/array-transaction-native.ts:92`, because the route's
`prepareBatch` answered `undefined` for the **upsert**: somewhere on the
upsert path the candidate reaches a dispatch that raises
`OperationContext.incompletePreparation`
(`raptor3/shared/operation-context.ts:884`, `:1084`, `:1786`, `:2091`) instead
of folding to one statement.

That is an engine parity question in `src/query-engine/raptor3/**`, a tree
this unit does not own, and the answer ("may an upsert be batched atomically
on a batch-only driver?") is an observable compatibility choice — a decision
for Arnaud, not a repair to improvise. **Requested change, for the raptor3
owner:** make the upsert fold to a single `INSERT … ON CONFLICT … RETURNING`
during batch preparation (the statement the test asserts), or, if it cannot,
retire the cell with a recorded ruling — it must not be weakened or skipped.
This unit did neither.

Note the exposure: the file is in `WRITE_ENGINE_EXTENDED_COVERAGE_TESTS` only,
so `pnpm test:core` never runs it and only the coverage lane sees the red.

## 6. Verification

The author's session ended before this section; the integrator ran the
verification on the delivered tree (`receipts/VERIFY.log`, `verify-*.log`)
and the independent reviewer reproduced it (`review-receipts/`):

| check | result |
| --- | --- |
| `pnpm test:coverage:validation` | 100 / 100 / 100 / 100 (`verify-scope-validation.log`) |
| `pnpm test:coverage:errors` | 100 / 100 / 100 / 100 (`verify-scope-errors.log`) |
| `pnpm test:coverage:adapters` | 100 / 100 / 100 / 100 (`verify-scope-adapters.log`) |
| `pnpm test:coverage:drivers` | 96.05 / 92.58 / 96.1 / 96.05 against 96 / 92.5 / 96 / 96 (`verify-scope-drivers.log`) |
| `pnpm test:coverage:policy` | green (`verify-policy.log`) |
| `node scripts/run-typecheck.mjs` | 0 diagnostics (`verify-typecheck-2.log`) |
| `npx biome check` on the touched files | one banned `{}` type in a new cell, fixed by the integrator; clean after (`verify-mutation-args.log` 63/63) |
| `pnpm test:coverage` (all scopes) | NOT green on this tree: the two §5 blockers, resolved elsewhere (the query-engine-core scope definition in the follow-ups unit; the Neon upsert defect as D-46) |


## 7. Cost

`git diff --numstat 54a34e05 -- src tests`: src +20 / −14 (three guard deletions and their comments), tests +677 / −3; net +680.
