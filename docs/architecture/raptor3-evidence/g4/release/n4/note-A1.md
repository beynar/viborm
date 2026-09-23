# N4 group A1 — the refusal census in `shared/query.ts` and `route/client-route.ts`

Worktree `/private/tmp/viborm-n4`, branch `n4`, base `bf7ac30b4`.
Write targets: `src/query-engine/raptor3/shared/query.ts`,
`src/query-engine/raptor3/route/client-route.ts`.
Rows: 1–22 (query.ts) and 50–52 (client-route.ts) of
`docs/architecture/raptor3-evidence/g4/release/plan/refusals-map.md`.

## The truth this unit states

Twenty-five sentences live in these two files. **Five** of them named a state
the code cannot be in when it is right; they are now invariants, told from
refusals BY CLASS (`EngineInvariantError`, deliberately not a `VibORMError`),
never by message text. **Eleven** belong to the private recursive-read fit and
are untouched under D-54. **Nine** are execution facts or capability
boundaries and are kept, each naming the one boundary it alone owns.

One of the five had a type that could say it, and now does: the aggregate
vocabulary `AGGREGATES` — which this file already owned and admission already
enumerates — became a TYPE (`Aggregate`), the prepared target carries it, and
`aggregateExpression`'s `default` is `unreachable(aggregate, …)`, proved by the
compiler. The one narrowing of a payload key into that vocabulary is
`isAggregate`, at the single call site that reads a key (`groupOrderTerms`).

The other four could not be closed by a type and must not be. `operator`,
`predicate.operator` and `predicate.quantifier` are payload KEY NAMES: closing
them would require a second enumeration of the admitted vocabulary inside the
lowerer, which is precisely what AGENTS.md forbids ("Do not add a second
operator switch") and what ELEGANCE §1 calls a second authority. `Leaf.type` is
a `string` because it also carries every declared scalar's type name. For those
four the class carries the distinction and the sentence text is unchanged.

The invariant owner already existed; this group imported it and created
nothing: `src/query-engine/raptor3/shared/invariant.ts` —
`EngineInvariantError`, `assertInvariant(condition, message)`,
`unreachable(value: never, message)`. **Agreed name for the integrator: that
file, that class, those two functions.** `assertInvariant` is not used in these
two files: every site here is a `switch` `default:` arm or a terminal `else`,
where `throw new EngineInvariantError(…)` is the honest spelling and
`assertInvariant(false, …)` would be a circumlocution. `unreachable` is used at
the one site the type now closes.

### Row 13 — the measurement changed the answer, and the map was wrong

The map and the function's own doc comment both said the reachable shape of
`Raptor 3 cannot name the updated value of 'X.f' under 'multiply' / 'divide'`
was a decimal RELATION key. **Measured, at the base, it is not.** A relation key
written beside a mutation of that relation must be a literal
(`Assignments.requireLiteral`, `commands/relation-body.ts:127`), so no operator
survives to be named and the registered `NestedWriteError` answers first.

The sentence IS still reachable, by a shape nobody had named: a decimal PRIMARY
key on an **upsert's found arm whose update payload names no relation**.
`EngineSchema.admit` states `keyPortabilityRefusal` for `update` / `updateMany`
only; the found arm carries it only when the update payload names relations
(`commands/commands.ts:1743`, the shipped gate). The payload therefore arrives
at `OperationContext.updatedIdentity` → `Queries.updateValue`.

Plan §4 rules this one "executed through N1's ordered observation". **The
measurement refines that.** What `updatedIdentity` needs is not a value a
dependent consumes — it is the row's ADDRESS after a write that moved its
primary key. No ordering of reads supplies it: the old key no longer matches
and the new one is the provider's rounded result, which is exactly what the
engine cannot name. Only the provider can say it, and it already does where it
can: **the same payload succeeds on a driver with RETURNING** (600 → 1200).
The sentence is therefore a TRANSPORT boundary, kept, and the execution that
would remove it is D-50's scratch read at the column's DECLARED type — plan §4's
third capability bullet, the same widening `G1 atomic output` (#16) needs.

**Its owner is not in my files.** Requested change, for the
`shared/operation-context.ts` group or the integrator:

> `OperationContext.updatedIdentity` (`shared/operation-context.ts:2285-2296`,
> called from `:2146` and `:2584`) names the post-update key in SQL through
> `Queries.updateValue`. On a provider without RETURNING and for a key the
> engine cannot name (an exact decimal under `multiply` / `divide`), obtain the
> post-update key from the provider instead: the D-50 CTE store reading the key
> column back at its declared type, or a follow-up read addressed by a value
> the statement returned. `Queries.updateValue` then never sees the shape and
> its sentence becomes an invariant. Do not change `query.ts` for this — the
> refusal there is correct while the read-back still has to name the key.

## Per row

Line numbers are current (post-edit) in this worktree.

| # | sentence | site | disposition | the fact |
|---|---|---|---|---|
| 1 | A recursive shape requires occurrence rows | query.ts:4337 | **LEFT (recursive, D-54)** | see "the eleven" below |
| 2 | A recursive traversal requires at least one seed | query.ts:3238 | **LEFT (recursive, D-54)** | see "the eleven" below |
| 3 | `GeoPoint distance is not supported by this provider.` (`FeatureNotSupportedError("point", "distance ${usage}", …)`) | query.ts:2238 | **KEEP** | A provider limit: the adapter's GeoPoint tier declares no `distance` operator, and AGENTS.md is explicit that the engine "never emulates a tier in JavaScript". It alone owns "this adapter cannot spell a great-circle distance" for all three consumers (filter, `orderBy`, projection) in one sentence. Nothing upstream establishes the tier, so an assertion here would establish a missing fact (ELEGANCE §5). |
| 4 | Invalid provider collection | query.ts:4369 | **KEEP** | An execution fact at the row boundary (D-17/D-28: "transport asked about a value exactly once, at the row boundary"): the JSON-aggregated carrier for a to-many projection is not an array. It alone owns "the driver returned a shape for this column that the statement cannot have produced". No other owner re-checks provider row shape. |
| 5 | Invalid provider recursive collection | query.ts:4322 | **LEFT (recursive, D-54)** | integrity, once wired |
| 6 | Invalid provider recursive occurrence | query.ts:4286 | **LEFT (recursive, D-54)** | integrity, once wired |
| 7 | Invalid provider recursive parent occurrence | query.ts:4318 | **LEFT (recursive, D-54)** | integrity, once wired |
| 8 | Invalid provider recursive path | query.ts:4290 | **LEFT (recursive, D-54)** | integrity, once wired |
| 9 | Invalid provider recursive row | query.ts:4305 | **LEFT (recursive, D-54)** | integrity, once wired |
| 10 | Invalid provider recursive seed | query.ts:4294 | **LEFT (recursive, D-54)** | integrity, once wired |
| 11 | Invalid provider row | query.ts:4380, 4387 | **KEEP** | Same boundary as #4, the to-one document arm: `null` on a carrier the statement always builds, or a value that is not an object. Two sites, one sentence, one rule — ELEGANCE §9. |
| 12 | Raptor 3 aggregate is not implemented: `${aggregate}` | query.ts:3189 | **INVARIANT — type strengthened** | `AGGREGATES` is the closed vocabulary this file owns and admission enumerates (`validation/model/args/aggregate.ts`). It is now a type, `Aggregate`; `PreparedTarget`'s aggregate variant, `aggregateLeaf` and `aggregateExpression` carry it; the only construction site already filtered `AGGREGATES` and the only payload-keyed site narrows once through `isAggregate`. The `default` arm is `unreachable(aggregate, …)` — the compiler states the invariant. Sentence text unchanged. |
| 13 | Raptor 3 cannot name the updated value of `'X.f'` under `'op'` | query.ts:1112 | **KEEP (capability), measured** | See §"Row 13" above. Reachable — upsert found arm, decimal PRIMARY key, no relation named, no RETURNING. Not an invariant (it succeeds with RETURNING). Owner of the execution is `operation-context.ts`, not mine; requested change recorded. Doc comment corrected to the measured shape. |
| 14 | Raptor 3 createMany final read returned inconsistent row counts. | query.ts:4252 | **KEEP** | Concurrency and cardinality: the OR'd identity read-back matched MORE rows than were submitted, which means a key moved or collided between the capture and the read. Exactly ELEGANCE §5's "affected-row requirements are execution facts". It alone owns "the set I captured is no longer the set I am reading". |
| 15 | Raptor 3 filter operator is not implemented: `${operator}` | query.ts:2068 | **INVARIANT — assertion (class only)** | Each per-scalar filter file admits only keys mapping into this exact set, and `prepareOperation` carries the key it admitted. A closed union here would need a second operator enumeration in the lowerer — the thing AGENTS.md forbids — so the type cannot say it and the class does. Text unchanged. |
| 16 | — | operation-context.ts | not mine | — |
| 17 | Raptor 3 G3P-05 relation filter is not implemented: `${quantifier}` | query.ts:2290 | **INVARIANT — assertion (class only)** | Quantifiers arrive as payload key names (`Object.entries`), admitted by validation's relation-filter schemas, which refuse a payload naming none of them in their own registered sentence. Same reason as #15 for not closing the type. Text unchanged; the class changes from bare `Error`. |
| 18 | Raptor 3 JSON filter operator is not implemented: `${operator}` | query.ts:2193 | **INVARIANT — assertion (class only)** | Same upstream owner as #15: the JSON document operator set is enumerated once at admission (Lane Q). Text unchanged. |
| 19 | Raptor 3 recursive traversal relation `'X'` is not self-referential | query.ts:3251 | **LEFT (recursive, D-54)** | see "the eleven" below |
| 20 | Raptor 3 recursive traversal requires one ordinary relation: `${relation}` | query.ts:3246 | **LEFT (recursive, D-54)** | see "the eleven" below |
| 21 | the value is not a binary value | query.ts:4841, 4852 | **KEEP** | A decode-time provider-value fact (D-17 row boundary): the raw value for a `blob` column matches none of the recognized binary spellings. It alone owns "the driver returned something this column cannot have stored". Two sites, one sentence. |
| 22 | the value is not an array of finite numbers | query.ts:4601 | **KEEP** | The same boundary for a `vector` column. Provider value domain, not payload validation. |
| 50 | The Raptor 3 route cannot encode a cached `'${leaf.type}'` result: the leaf publishes no declaring scalar. | client-route.ts:375 | **INVARIANT — assertion (class only)** | Every scalar-less `Leaf` this engine constructs is `_count` (int), `exist` (boolean), or the number a non-decimal `_avg` / `_distance` publishes — all three handled by the branches above. The state is the route's own, established by `Queries`' leaf builder. `Leaf.type` is a `string` because it also carries declared scalar type names, so the compiler cannot close it here; the class carries the distinction. The public `meta` is dropped with the public class — an invariant has no caller to inform. |
| 51 | The Raptor 3 route cannot encode a cached result for `'op'` on model `'M'`: the verb publishes no prepared read. | client-route.ts:213 | **KEEP (capability)** | The map left this "UNSURE"; traced. The caller IS pre-scoped — `withCache` → `createCachedProxy` calls `validateCacheableOperation` (`query-engine/cache-flow.ts:223`) before the pending operation exists, and `readPendingCacheResult` is module-private with one call site (`client/client.ts:716`). But the fact rests on THREE independently-maintained vocabularies in three layers: `CACHEABLE_OPERATIONS` (cache-flow.ts, 9 names, both `…OrThrow` included), `READ_OPERATIONS` (`routed-operations.ts`, 9), and the engine's own `READ_OPERATIONS` (`raptor3/shared/schema.ts`, **7** — no `…OrThrow`), reconciled only by `admittedOperation`'s normalization. No type ties them and no single upstream owner establishes it, so an assertion would establish a missing fact (ELEGANCE §5). It alone owns "the cache layer asked this engine to encode a verb this engine publishes no read for", across a seam (`RoutedCandidateOperation`) consumed outside raptor3 — so the class stays public. Kept, as plan §4 rules. Rationale recorded at the site. |
| 52 | The Raptor 3 route cannot encode a cached result for `'op'`: a recursive read's published depth is not a fixed shape. | client-route.ts:333 | **KEEP / LEFT (recursive, D-54)** | Integrity once wired: a recursive read publishes a depth the prepared shape does not bound, so no fixed codec describes it, and refusing keeps a half-encoded entry out of the store. It is the eleventh recursive sentence and is untouched. |

### The eleven recursive-read sentences — left, listed, and why

`query.ts` rows 1, 2, 5, 6, 7, 8, 9, 10, 19, 20 and `client-route.ts` row 52.
Lines: 4337, 3238, 4322, 4286, 4318, 4290, 4305, 4294, 3251, 3246, and
client-route.ts:333.

D-54 keeps the recursive-read fit private, so these stay exactly as they are.
Beyond the ruling there is a reason not to convert the four the map called
INVARIANT (#1, #2, #19, #20): they are not invariants an upstream owner
established — they are the ADMISSION the feature does not yet have. Nothing
upstream checks that a traversal has a seed, or that its relation is ordinary
and self-referential, because no public argument builds a `RecursiveTraversal`
at all. Turning them into `EngineInvariantError` would be ELEGANCE §5's
forbidden move — an assertion establishing a missing fact — and would have to
be reverted the day D-54 wires the verb, at which point each becomes a real
public refusal. The map's own wording says as much ("would become a real
admission fact once wired"). Left untouched; counted apart in the census.

## Hunks

`src/query-engine/raptor3/shared/query.ts` (+50 / −14):

1. `:58` — import `EngineInvariantError`, `unreachable` from `./invariant`.
2. `:319` — `PreparedTarget`'s aggregate variant: `aggregate: string` → `Aggregate`.
3. `:468-481` — `type Aggregate = (typeof AGGREGATES)[number]` and
   `isAggregate(name): name is Aggregate`, the one narrowing, beside the set.
4. `:1074-1095` — row 13's doc comment corrected to the measured reachable
   shape, the foreclosed one named, and the execution that would answer it
   located at its owner.
5. `:2061-2068` — row 15's `default`: class → `EngineInvariantError`, with the
   upstream owner named.
6. `:2189-2193` — row 18's `default`: same.
7. `:2285-2290` — row 17's `default`: same (was a bare `Error`).
8. `:3152` — `aggregateLeaf(aggregate: Aggregate, …)`.
9. `:3167` — `aggregateExpression(aggregate: Aggregate, …)`.
10. `:3188-3189` — its `default` → `return unreachable(aggregate, "Raptor 3
    aggregate is not implemented")` (same text the sentence had).
11. `:4207` — `AGGREGATE_NAMES.has(name)` → `isAggregate(name)`.

`src/query-engine/raptor3/route/client-route.ts` (+23 / −3):

12. `:41` — import `EngineInvariantError` from `../shared/invariant`.
13. `:196-209` — row 51's KEEP rationale at its site (the three vocabularies).
14. `:354-362` — `leafCodec`'s doc: the three scalar-less leaves exhaust the
    set, so the last arm is an invariant, and why `Leaf.type` cannot say it.
15. `:373-376` — row 50: `UnsupportedOperationError` → `EngineInvariantError`
    (the public `meta` goes with the public class). Text unchanged.

No sentence text changed anywhere in this group. No test was deleted, skipped
or weakened.

## Falsification record

No new pin: every change here is a classification (an assertion needs no cell,
per the brief) or a documentation correction, and row 13 keeps its behaviour —
its existing cell `tests/raptor3/g4/unit02/key-arithmetic.test.ts` ("refuses to
name an exact decimal under multiply, with its registered identity") is green.
What had to be falsified instead were the CLAIMS, and each was measured against
**base source** (`git archive bf7ac30b4 src tests`, aliased in a scratch vitest
workspace under `TMPDIR`), so no other group's in-flight edit could be mistaken
for the fact. Verbatim:

```
N4A1F C1  upsert decimal PK {multiply}, NO RETURNING
  answer = QueryEngineError: Raptor 3 cannot name the updated value of
           'ledger.code' under 'multiply': the provider owns that operator's
           rounding inside its own assignment.
  rows   = [{"code":60000}]            (nothing written)
  updateValue seen = ["code={\"multiply\":\"2\"}"]

N4A1F C1b same, {divide}  →  the same sentence, nothing written

N4A1F C2  the SAME payload WITH RETURNING
  answer = ok:{"code":"1200","label":"l"}
  rows   = [{"code":120000}]
  updateValue seen = []                (never consulted)

N4A1F C3  decimal RELATION key {multiply} beside a nested connect
  answer = NestedWriteError: Cannot update relation key field 'code' with a
           non-literal operation while mutating relation 'dependents'.
           Use a literal value or '{ set: ... }'.
  updateValue seen = []                (foreclosed upstream)
```

C1/C1b falsify "the sentence is dead after N1"; C2 falsifies "it is an
invariant" (it is a transport boundary); C3 falsifies the map's and the doc
comment's claim that the decimal RELATION key is the reachable shape.

Earlier instrumented runs (same method, current worktree) also recorded: a
referenced-key `multiply` with **no** relation named builds no transition at all
and the database answers `ForeignKeyError`; and a decimal PK under `update` /
`updateMany` / `upsert`-naming-a-relation is refused first by
`keyPortabilityRefusal` ("Arithmetic updates are not portable for decimal
primary key field 'code'"), which is why only the relation-free upsert arm
reaches row 13.

**Attribution of the reds**, by the backup-copy recipe (my two files copied to
`TMPDIR`, base copies put in place, suite run, my files restored and md5-verified
identical both times): the `raptor3` project fails **10 cells in 9 files with my
two files at base, and the identical 10 with my changes in**. None is mine.

## Still red (not mine)

- `node scripts/run-typecheck.mjs` — **three** errors, whole estate, none in a
  file this group owns and none in `src/`:
  - `tests/raptor3/ownership/commands.test.ts(376,55): error TS2322: Type
    '"atomic-array"' is not assignable to type '"borrowed-transaction" |
    "standalone"'.` Caused by the in-progress edit to
    **`src/query-engine/raptor3/shared/operation-context.ts`** (row 31's DELETE
    of the `atomic-array` binding variant); that group still has to re-express
    the recorded expectation at
    `tests/raptor3/ownership/commands.test.ts:333-376`.
  - `tests/raptor3/g4/parity/batch-captured-bulk.test.ts(126,7)` and `(145,7)`:
    `error TS2769: No overload matches this call` — a `PendingOperation` passed
    where a `Promise` is required. This file is **untracked and brand new**; it
    appeared in the worktree between my two typecheck runs (it is another
    group's pin for row 25, alongside
    `tests/raptor3/g4/parity/postgres-declared-type-scratch.test.ts` for row 16).
  Not fixed here. (The two historical Pattern `TS2345` errors at
  `src/query-engine/pattern/pack.ts` did not appear in either run.)
- `tests/raptor3/g4/unit02/key-arithmetic.test.ts` — 2 cells, "R-D3 refuses a
  number key increment / multiply under a batch with its registered identity":
  the refusal is now answered `ok`. Owner: **`shared/operation-context.ts`**
  (row 23, the capability executed under N1). Red with my files at base too.
- `tests/raptor3/ownership/commands.test.ts` — "refuses atomic-array binding
  before admission or provider work". Same owner and same cause as the
  typecheck error.
- `tests/raptor3/core-structure/measurement/cs02-structure-measure.test.ts` —
  the frozen CS-02 structural work matrix. Every group's line changes move it;
  the integrator re-freezes it once.
- Six generation campaigns (`g3/generation/{sqlite,transport}-campaign`,
  `g4/generation/{sqlite,transport,write,write-transport}-campaign`) — all fail
  with `AssertionError: Missing generated G4 first seed`: the generated seed
  corpora are absent from this worktree. An environment condition, not an edit.

## Unverified

- The `…OrThrow` asymmetry between `CACHEABLE_OPERATIONS` (9) and the engine's
  `READ_OPERATIONS` (7) is read from source, not executed: I did not build a
  cached `findUniqueOrThrow` to prove `admittedOperation` normalizes before
  `isReadOperation`. It is the KEEP argument for row 51, not a behaviour claim.
- Row 3 (GeoPoint `distance`): the map's reachable payload is taken as read; I
  did not run a provider whose GeoPoint tier lacks `distance`.
- Rows 4, 11, 14, 21, 22: kept on their stated execution facts, not executed —
  each needs a misbehaving driver or a genuine race to observe.
- Row 13's `update.kind === "list"` disjunct (a list-typed key under
  `push`/`unshift`): not measured. `KEY_UPDATE_OPERATIONS` has no list operator,
  so `keyPortabilityRefusal` answers "accepts exactly one update operation;
  received none" for every verb it guards — but the same relation-free upsert
  arm that reaches the decimal case would bypass it, and I did not establish
  whether a list field can be a primary key at all.
- I did not run the `raptor3-provider`, `raptor3-live-provider` or any Docker
  provider project; and `pnpm test:all` was not run (the integrator runs the
  estate).

## LOC

| file | +/− | code-only |
|---|---|---|
| `shared/query.ts` | +50 / −14 | — |
| `route/client-route.ts` | +23 / −3 | — |
| **total** | **+73 / −17 (net +56)** | **+16 / −13 (net +3)** |

Of the 73 added lines, 57 are comment: the measured reachable shape for row 13,
the KEEP rationale for rows 50 and 51, and the upstream owner named at each
converted `default` arm. The executable change is three net lines.

Biome (`npx biome check <file>`), before → after:

| file | before | after |
|---|---|---|
| `shared/query.ts` | 15 diagnostics (1 `format`, 1 `assist/source/organizeImports`, 4 `lint/complexity/useSimplifiedLogicExpression`, 3 `lint/correctness/noUnusedFunctionParameters`, 1 `lint/correctness/noUnusedVariables`, 4 `lint/style/noParameterProperties`, 2 `lint/style/useDefaultSwitchClause`) | **identical, 15** |
| `route/client-route.ts` | clean | **clean** |

`query.ts` already carried a `format` diagnostic at `e19b20759`/`bf7ac30b4`, so
the formatter was never run on it; every hunk was written by hand to the file's
existing style and the diagnostic set is unchanged.
