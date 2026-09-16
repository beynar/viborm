# G4 performance pass 2 — independent review

Reviewer: independent (did not write the unit). Unit: **G4-02 author — Raptor 3
performance pass 2 (allocation shape and reuse)**.
Brief: [`briefs/perf-pass-2.md`](briefs/perf-pass-2.md) under
[`briefs/common.md`](briefs/common.md)'s twelve rules, re-affirmed verbatim.
Author's note: [`perf2/note.md`](perf2/note.md). Patch:
[`perf2/perf-pass-2.patch`](perf2/perf-pass-2.patch). Base: `ff5e77ca`; the main
tree carries the pass.

Probes: `/Users/arnaud/code/viborm/tests/raptor3/g4/review/perf2/`
(untracked, registered in a review workspace only; the manifest was not
touched). Review receipts and scratch trees:
`/private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/review-perf2/`.

---

## Outcome — **REVISE**

The production change is sound and I could not break it. Items 1, 2 and 4 hold
their invariants under attack, the no-behaviour-change claim survives a
57-scenario cross-tree comparison I built myself, the A/B reproduces, and every
cost, identity, patch and Biome figure in the note reproduces exactly. Item 3's
"not taken" decision is correct against the brief's own gate, and my own
measurement independently confirms its condition (a).

What blocks acceptance is not the mechanism: it is that **the whole-estate
typecheck is red**, with a third diagnostic that this pass introduced, and that
the note reports the opposite of its own receipt. `common.md` permits exactly
two diagnostics. One line of the new test file fixes it; no production file
needs to change.

---

## 1. Findings

### Finding 1 — must-fix. The pass leaves the whole-estate typecheck red, and the note says it does not

**Severity:** must-fix (blocking for the integrator, who is asked to register
this very file).
**Location:** `/Users/arnaud/code/viborm/tests/raptor3/g4/unit02/prepared-projection-reuse.test.ts:32`
(the `import { type PreparedPredicate, Queries } from "@query-engine/raptor3/shared/query";`
block at lines 31-34); `shared/query.ts:270` declares `type PreparedPredicate`
without `export`.
**Probe:** `node scripts/run-typecheck.mjs` in the main tree.

```
src/query-engine/pattern/pack.ts(1443,36): error TS2345: …   (permitted)
src/query-engine/pattern/pack.ts(2633,58): error TS2345: …   (permitted)
tests/raptor3/g4/unit02/prepared-projection-reuse.test.ts(32,8): error TS2459:
  Module '"@query-engine/raptor3/shared/query"' declares 'PreparedPredicate'
  locally, but it is not exported.
```

This is not a disagreement about my environment: it is in the **author's own
last receipt**, [`perf2/receipts/typecheck.log`](perf2/receipts/typecheck.log)
(17:37:19, after the last source edit at 17:36:46), as the third line of the
file. `note.md` §6 records that same run as *"only the two permitted
`pattern/pack.ts` TS2345 diagnostics"*, and §9 repeats the clean claim. The
receipt and the note contradict each other, and the receipt is right.

`common.md`: *"Only the two historical Pattern TS2345 errors … are permitted;
any other diagnostic is yours to fix or report."* It was neither fixed nor
reported.

**Resolution (apply verbatim; touches no production file).** In
`tests/raptor3/g4/unit02/prepared-projection-reuse.test.ts`, replace

```ts
import {
  type PreparedPredicate,
  Queries,
} from "@query-engine/raptor3/shared/query";
```

with

```ts
import { Queries } from "@query-engine/raptor3/shared/query";
```

and insert, immediately above `function findIn(`:

```ts
/** The prepared predicate type, read from the one owner that publishes it. */
type PreparedPredicate = NonNullable<
  ReturnType<Queries["prepareSelector"]>["predicate"]
>;
```

Then correct `note.md` §6's typecheck row and §9's Biome/typecheck paragraph to
the re-run result, and re-capture
[`perf2/receipts/typecheck.log`](perf2/receipts/typecheck.log).

I verified the replacement compiles and names the same type, by putting exactly
those two edits in a file of my own and running the whole-estate typecheck: the
TS2459 from my copy does not appear, and `findIn` still narrows to
`Extract<…, { kind: "operation" }>` with a frozen `operands` list —
`tests/raptor3/g4/review/perf2/resolution-check.review.test.ts` (1 cell, green).

### Finding 2 — note. `receipts/cost.json` declares the wrong base

**Severity:** note (label only; the numbers are right).
**Location:** `/Users/arnaud/code/viborm/docs/architecture/raptor3-evidence/g4/perf2/receipts/cost.json`,
field `"base": "0f25637b"`.
**Probe:** `wc -c` on the four files in a `git archive ff5e77ca` tree against
the `before` column of `cost.json`.

`cost.json` says the census baseline is `0f25637b` — the commit *before* this
pass's base — while `note.md` §8 labels the same figures "before (`ff5e77ca`)".
The figures are ff5e77ca's: operation-context 85,925 B, query 141,465 B, schema
19,845 B, transport-attempt 689 B, all matching the archive byte for byte. It is
a stale field carried from pass 1, not a mismeasurement.

**Resolution:** set `"base": "ff5e77ca"` in `receipts/cost.json`.

### Finding 3 — note. `EngineSchema.adapterScope` is an unnamed generic store on a class the guide asks to own *named* views

**Severity:** note (no live defect; one caller today).
**Location:** `/Users/arnaud/code/viborm/src/query-engine/raptor3/shared/schema.ts:511-531`.

```ts
private readonly adapterViews = new WeakMap<object, object>();
adapterScope<T extends object>(adapter: object, create: () => T): T {
  let scope = this.adapterViews.get(adapter) as T | undefined;
  …
}
```

`src/query-engine/raptor3/AGENTS.md:54-59` names what `EngineSchema` owns:
"lazy immutable factory-lifetime views for physical field descriptors, ordered
stored fields, exact model/slot/variant membership orientation, and slot
clearability", and constrains their content. The content constraint is
respected (see §3 below). What is new in kind is the *shape*: a generic
`WeakMap<object, object>` keyed only by the adapter, with an `as T` cast. A
second caller asking `adapterScope(adapter, createSomethingElse)` for the same
adapter silently receives the first caller's object, typed as its own — the
cast is what makes that unobservable. `Queries` is the only caller, so nothing
is wrong today; the hazard is that the escape hatch is easier to reach than the
named views beside it.

**Resolution (optional, author's call):** either name the accessor for its one
fact — `queryViews(adapter: DatabaseAdapter): QueryViews`, with `QueryViews`
and `createQueryViews` reachable from `schema.ts` — or key the store by
`(adapter, create)` so two shapes cannot collide. If neither is taken, say so
in `note.md` §3.1 and name the invariant that keeps it single-caller.

### Finding 4 — note. Four of the brief's six item-2 memo candidates have no decision-elimination answer

**Severity:** note.
**Location:** `note.md` §3 (item 2) and §0.4 (the ranked rows).

The brief's item 2 names six things to memoise: `projectedColumn`,
`scalarShape`/leaf, `table`/`column`, `identityOrder`, `totalOrder`, and the
default projection. Two were taken. `projectedColumn` gets one sentence in §3.3
("LOWERING is per operation and this item does not touch it") — reasonable,
since it binds a statement alias, though the brief explicitly offered "per
(model, field, alias)" as a key. `table`/`column`, `identityOrder` and
`totalOrder` get nothing at all, and do not appear in §0.4's ranked rows either,
so a reader cannot tell whether they were measured and found small or were not
looked at. §4 does this properly for item 3; §3 should do the same.

**Resolution:** add one paragraph to `note.md` §3 naming each of the four
untaken candidates with its measured µs/op and B/op from
`receipts/profile-base/` (or "below the profile's floor"), and the reason it is
not memoised.

### Finding 5 — note. The de-freeze is shallow, and that is now the invariant

**Severity:** note (no change requested).
**Location:** `/Users/arnaud/code/viborm/src/query-engine/raptor3/shared/query.ts:1285-1288`,
`:1296-1301`, `:1348-1376`.

`Object.freeze` on the enclosing predicate is shallow. After this pass
`predicate.operands` is frozen (a member cannot be *replaced*) but each member's
`value` is writable again. I checked the claim that this is unobservable and it
holds: `PreparedOperand` is declared locally in `shared/query.ts` and appears at
exactly four sites — the type, the two fields of a scalar predicate,
`prepareOperand`, and `lowerOperation`'s `bind`, which reads `kind`, `scalar`
and `value` and writes nothing. A repo-wide search finds no cell observing a
prepared operand's frozen-ness (`Object.isFrozen` in `tests/raptor3/` hits only
`post-prep/schema-view-reuse.test.ts`, the author's own new cell 5 — which pins
the predicate and the LIST, both still frozen — and a witness cell about
provider rows). My own probe lowers one admitted 3-member list four ways
(`in`, `notIn`, insensitive `in`, insensitive `equals`), twice under one alias
and once under another, and gets identical text, identical parameters and no
lost member every time.

Recorded so the invariant is written down rather than implied: **the immutability
of a prepared operand is now the enclosing predicate's, and it holds only while
the builder and the reader stay inside `shared/query.ts`.** If a prepared
predicate is ever handed outside that file, the per-member freeze returns or the
outside reader is read-only by construction.

---

## 2. The §7 gate, answered against the actual diff

`git diff ff5e77ca` touches five files: four production files under
`src/query-engine/raptor3/shared/` and one new test. I read every hunk.

1. **What decision does it eliminate?** Three, and all three are real.
   *Whether an operation pre-pays for write machinery* — eight `OperationContext`
   fields and three `TransportAttempt` collections now exist from their first
   writer. *Which operation prepared this model's default projection, and whose
   leaf this is* — neither is a fact of an operation. *Whether each operand box
   is independently immutable* — stated once per predicate.
2. **What replaces it?** One invariant each, and each is falsifiable — I broke
   all three and watched registered cells go red (§5).
3. **Who else had to change?** Nobody's semantics. I verified this rather than
   accepting it: 57 scenarios, byte-identical across the two trees (§4).
4. **What would falsify it?** Stated per item and, in three cases, reproduced by
   me independently.

**Nothing on the §7 prohibition list appears in the diff.** No second
public-syntax walker (`prepareProjection` is still the one projection owner and
`EngineSchema.admit` is untouched); no per-verb codec; no duplicated
result-shape preparation (the memo *removes* one); no recreated lifecycle; no
projection rebuilt to obtain a decoder; no JavaScript arithmetic beside SQL; no
defensive re-validation; no policy-boolean bag; no per-feature interpreter; no
fixture-named flag; no legacy import or fallback; **no cached absence** — a
missing `defaultProjections` entry means "not computed yet", never "there is no
projection"; and no public contract change.

**Rule 5 — nothing observed or admitted lives in any memo.** I inspected both
memos' keys and values. `leaves: WeakMap<AnyModel, Map<string, Leaf>>` holds a
leaf built from the field's declared scalar, its nullability and the adapter's
`dateTime`/native-type answer. `defaultProjections: WeakMap<AnyModel,
PreparedProjection>` holds a projection whose `selected` is
`model["~"].scalarFieldNames` minus `model["~"].state.omit`. I read every
`args.` access in `prepareProjection` and confirm the author's claim: exactly
two, `args.select` and `args.include`. Neither `_count`, `_distance` nor a
relation can enter the default path, because each needs a named
`select`/`include`. The one remaining way an admitted value could reach the memo
is an operation-level `omit`, and it cannot: `src/validation/model/args/omit.ts`
is explicit that *"`omit` never reaches the query engine"* — `withOmitProjection`
deletes the key and substitutes `select` at the parse boundary, and client-level
`omit` is merged into that same value before validation
(`src/client/client.ts:591` `applyClientOmit`). Both halves are pinned: by the
author's cell 3 through real admission, and by my own client-seam probe.

**Rule 1, rule 3, rule 4, rule 7, rule 12.** One authority each; no read/write
subclass, no policy boolean, no second context class; admission, defaults and
transforms still run once per input (untouched, and exercised through the real
path by my digest's `omit`, default-bearing and nested-write scenarios); a pure
read allocates none of the write machinery (probe below); and the new
`TransportAttempt` accessors are not wrapper-only — `record*` owns the `??=`,
`drain*` owns the copy-then-clear that used to live inline in `submit`, and
`hasAssertedPremises` is a non-materialising probe. Finding 3 is my one
reservation, and it is about shape, not about a crossed rule.

**Every reader of a now-lazy field is guarded.** I enumerated all 24 uses of the
seven renamed `OperationContext` fields and all 10 uses of the three
`TransportAttempt` collections. Every emptiness reader goes through `?.`, `?? 0`,
`?? NO_QUEUED_STATEMENTS`, `?? NO_CONTINUATIONS`, `continuationCount`, or
`hasAssertedPremises`; every writer materialises with `??=` before it can be
observed. `restart()` still installs a fresh attempt and
`restartRejectedInsert` still installs the recovery's, so attempt identity
across a rejected-insert restart is unchanged.

---

## 3. What I reproduced

### 3.1 Suites — 19 registered modes, every count matching the author's receipt

| Mode | Result | Author's receipt |
| --- | --- | --- |
| `g4-unit02-author` | **131 passed, 20 files** | 131 / 20 |
| `g4-read-contracts` | **62 passed, 8 files** | 62 / 8 |
| `g2-contracts` | **216 passed, 16 files** | 216 / 16 |
| `g2-generated` | **52 passed, 2 files** | 52 / 2 |
| `g1-transport` | **44 passed** | 44 |
| `g2-transport` | **16 passed** | 16 |
| `g29-result-progress` | **2 passed** | 2 |
| `g4-route-cache` | **7 passed** | 7 |
| `g4-route-transactions` | **13 passed** | 13 |
| `g4-route-lifecycle` | **8 passed** | 8 |
| `g3-bulk-series` | **6 passed** | 6 |
| `g3-transaction-array` | **4 passed** | 4 |
| `g3-suppression-retry` | **2 passed** | 2 |
| `g3-execution-review` | **6 passed** | 6 |
| `post-g3-projection-preparation` | **4 passed** | 4 |
| `post-g3-schema-views` | **1 passed** | 1 |
| `g2-pg-contracts` (55729) | **18 passed, 6 files** | 18 / 6 |
| `g2-mysql-contracts` (55730) | **13 passed, 4 files** | 13 / 4 |
| `g4-unit02-mysql-contracts` (55730) | **17 passed, 3 files** | 17 / 3 |

One mode per call, through `scripts/run-raptor3.mjs`; logs under the review
scratch directory. `g4-unit02-author` runs exactly 20 files, confirming that the
new 5-cell file is still outside the lane and that the integrator action in
`note.md` §6 is the right one — `G4_UNIT02_AUTHOR_COUNTS`
(`scripts/raptor3-manifest.mjs:589-609`) exists with the 20 entries the note
describes, and the manifest is unmodified in the diff.

`node scripts/run-typecheck.mjs`: the two permitted Pattern diagnostics **plus
finding 1's TS2459**, and nothing else once my own probes are typed correctly.

### 3.2 Behaviour — a cross-tree digest I built, 57 scenarios, byte-identical

The author's no-behaviour-change evidence is 16 package-seam dumps. I built an
independent one and ran it under **both trees**: a `git archive ff5e77ca`
checkout and the main tree, same fixture, same driver recorder, dumping for each
scenario the statement text, the parameter list, the published value, the
failure class, the failure sentence, the failure `meta` (correlation ids
masked), the control statements, the transaction count and the batch count.

**57 scenarios, byte-identical** (`cmp` on the two JSON files). 27 of them run
**through the candidate** (`createCommandEngine(...).execute`), 6 through the
packaged seam (`prepareBatch`, including guards), and 24 through the default
client route as a control. They cover: default / selected / omitted /
included / nested-select reads, `findFirst` with a descending order,
`count`, `aggregate`, `groupBy`, `findUniqueOrThrow` on a missing row,
`update`, `updateMany` with an `in` list, `update`/`delete` on a missing row, a
root unique conflict, nested creates, a nested create that conflicts mid-series,
both `upsert` arms, `createMany`, `deleteMany`, `connect`, a nested `update`,
and a nested `update` whose target is missing. Failures reproduced identically
by class and sentence: `NotFoundError` ×3, `UniqueConstraintError` ×2 (with
`columns`, `driver`, `providerCode`), `NestedWriteError`. The packaged `delete`
publishes the same single `exists` guard with the same
`Raptor 3 delete located no 'account' row for its unique where.` message and
`queryIndex: 0`.

Files: `…/review-perf2/before2.json`, `…/review-perf2/after2.json`,
generator at `…/review-perf2/digest.test.ts`.

### 3.3 The A/B — reproduced, 3 alternating fresh-process pairs, both engines, both arms

I first verified the measurement trees rather than trusting them: in
`…/scratchpad/perf2/ab/`, the four production files of `before/` are
byte-identical to `ff5e77ca` and those of `after/` are byte-identical to the
main tree; the two arms' `benchmarks/` are identical to each other and differ
from the repo only by the committed `cutover/phase-adapter.patch`; `src/index.ts`
is identical on both arms and adds only the `createCandidateClient` re-export;
and `attemptStore` appears in `after/dist` and in no file of `before/dist`. Then
I re-ran the author's instrument myself, 72 fresh processes.

Candidate ÷ shipped, before → after (author's 5-pair figures in brackets):

| Cell | CPU | wall |
| --- | --- | --- |
| `scalar-find-unique/prepare` | 1.367 → **1.097** [1.363 → 1.117] | 1.544 → **1.211** [1.581 → 1.285] |
| `fixed-collection-rowref-20/prepare` | 1.348 → **1.201** [1.277 → 1.222] | 1.290 → **1.117** [1.241 → 1.175] |
| `fixed-collection-rowref-1000/prepare` | 1.023 → **0.973** [1.005 → 0.932] | 1.079 → **1.019** [1.068 → 1.020] |
| `bulk-update-returning-100/prepare` | 1.229 → **1.128** [1.351 → 1.122] | 1.177 → **1.053** [1.226 → 1.050] |
| `nested-conditional-found/full` | 0.729 → **0.633** [0.722 → 0.697] | 0.786 → **0.721** [0.793 → 0.768] |
| `scalar-find-unique/full` | 0.977 → **0.815** [0.934 → 0.792] | 1.010 → **0.870** [0.967 → 0.856] |

Every direction and every magnitude reproduces. The shipped arm moves
−0.7…+0.2 µs/op on the five small cells; on `nested-conditional-found/full` my
shipped arm drifted +14.8 µs/op on a 200 µs cell, which is ambient load, and the
candidate's own delta there (−10.5) is the measurement.

**This independently confirms item 3's stop condition (a).**
`fixed-collection-rowref-1000/prepare` measures **0.973 CPU / 1.019 wall** on my
run — at or under parity, not over budget — so the cell the brief names for
reuse is not over budget after items 1–2, and the item is correctly not taken.
Condition (c) is also verifiable by reading: `prepareOperation` stores the
admitted value inside the `PreparedPredicate` (`query.ts:1285-1305`) and
`lowerOperation`'s `bind` reads `member.value` to build the literal
(`query.ts:1630-1633`), so there is no value-free form of the predicate and
reuse would need the second representation the brief names as its stop.

Raw: `…/review-perf2/ab-review.jsonl` (72 samples),
`…/review-perf2/ab-review-summary.json`.

### 3.4 Falsification — the author's three, re-run by me in a scratch copy

In a fresh `git archive ff5e77ca` + `perf-pass-2.patch` tree (which is how I
verified the patch, §3.5), never in the repo:

| Break | Result |
| --- | --- |
| `const shared = args.select === undefined && args.include === undefined` → `const shared = true` | **2 of 5** author cells red, including *"an omit received the default projection"* |
| `adapterScope` ignores the adapter (`adapter = this`) | author cell 4 red (*"a second adapter read the first one's memo"*) **and** my own cross-dialect cell red |
| `this.committedMemberSet?.size ?? 0` → `this.committedMemberSet!.size` | `uncertain-outcome-meta.test.ts` cell 2 red with *"TypeError: Cannot read properties of undefined (reading 'size')"* |

All three match the author's claims exactly. The scratch tree was restored from
a pristine copy between each; the repo was never mutated (production identity
below is unchanged).

### 3.5 Patch, identity, cost, Biome

- **Patch.** `git apply --check` then `git apply` onto a fresh `ff5e77ca`
  archive succeeds, and all **5 of 5** paths come out byte-identical to the
  working tree. `sha256 dcbac090337dd306084f609720c2852c11addcf52d379694f469c70ec48a4cd9`,
  957 lines, 5 `diff --git` headers — exactly as `note.md` §9 states.
- **Identity.** `captureRaptor3Identity()` in the main tree:
  production `3edf66d242d39e1921834360909d2a9c12f31ead9a39bb2f4d85c5cc0762a4cc`
  and, with my review probes parked, harness
  `7562c23fcfd81da87a5e0d70937b2902757313671526797918985a62bd162e54` — both
  matching `receipts/identity-after.json` exactly.
- **Cost.** `node scripts/query-engine-structure.mjs` run in both trees:
  files 181 → 181, lines 86,728 → 86,914, **tokenLines 68,628 → 68,710 (+82)**,
  functions 3,854 → 3,862, branch nodes 8,986 → 8,995, runtime import-cycle
  components 2 → 2, runtime files in cycles 14 → 14, files over 300 lines 76,
  over 600 lines 33. Every figure in `note.md` §8 reproduces. The four per-file
  byte counts in §8's table also match the ff5e77ca archive and the main tree.
- **Biome.** `biome lint` over the four production files reports the same **19**
  diagnostics in both trees — 9 `style/noParameterProperties`,
  4 `complexity/useSimplifiedLogicExpression`,
  3 `correctness/noUnusedFunctionParameters`,
  2 `style/useDefaultSwitchClause`, 1 `correctness/noUnusedVariables` — `diff`
  of the two sorted counts is empty, and the new test file reports none.
- **Scope.** The diff outside the four production files and the new test is the
  pre-existing dirt `common.md` names (`CONTEXT.md`, `memory.md`,
  `tests/pattern/pack/program-dump.ts`) plus `g4.md`, all of which were already
  modified when this review opened. `benchmarks/**`, the shipped engine and
  `scripts/raptor3-manifest.mjs` are untouched.

---

## 4. Adversarial probes I added

`tests/raptor3/g4/review/perf2/` — 12 cells, all green, run through
`node scripts/run-vitest-safe.mjs run --workspace=tests/raptor3/g4/review/perf2/review.workspace.ts tests/raptor3/g4/review/perf2/`.

**`memo-isolation.review.test.ts` (5)** — the keys the author's cells do not
separate. A second `EngineSchema` over the **same model objects and the same
adapter object** does not read the first one's memo (the two-clients-over-one-
schema-module shape). Two schemas whose models share a NAME but not a field list
never publish each other's columns, in either order, after both memos are warm.
A **model-level `.omit()`** — the one omission that never travels in the args and
therefore cannot be desugared — stays out of the shared default projection on the
first call and on the memoised second. One shared projection lowered under `q0`,
`q1` and `q0` again yields alias-correct, repeatable SQL and leaves the shared
value untouched and still the memo's answer. Two real dialects
(`SQLiteAdapter`, `PostgresAdapter`) get their own projection and their own leaf.

**`lazy-machinery.review.test.ts` (6)** — rule 7 from outside. A `findUnique`
that **executes** leaves `attemptStore`, `committedMemberSet`,
`memberAttributionMap`, `continuationList`, `preparedGuardList` and
`answeredFailureSet` all `undefined`, with one statement and no transaction; the
unattributed context mints one correlation id (the program specimen's shape,
because its statement needs an execution context), and the **client route's
shape** — a caller-supplied trusted context, which is what every measured cell
and every real client operation uses — mints **none**, which is what the pass's
`crypto.randomUUID` claim actually rests on. The id is a UUID, stable across
reads, distinct per operation. A packaged unique `delete` publishes exactly one
`exists` guard at `queryIndex: 0` while a packaged read publishes **no `guards`
key at all**. Two identical default reads publish byte-identical SQL and
parameters; the same structure with a different value publishes the same text
with `[2]` instead of `[1]` (the brief's item-3 falsifier, now a memo
falsifier). At the client seam, warming the memo then issuing an `omit` never
serves the shared projection, and the default is still the default afterwards.
One admitted `in` list lowers identically in four modes, twice under one alias
and once under another, losing no member.

**`resolution-check.review.test.ts` (1)** — finding 1's replacement alias.

**`digest.test.ts`** — the cross-tree generator of §3.2 (skips unless
`VIBORM_REVIEW_DIGEST` is set).

Registered in `tests/raptor3/g4/review/perf2/review.workspace.ts` only. **The
manifest was not edited.**

---

## 5. Author claims I could not verify

1. **The A/B build.** I did not run `pnpm package:build` on trees of my own. I
   verified the author's `ab/{before,after}` against `ff5e77ca` and the main
   tree file by file, verified the two arms' benchmarks are identical, verified
   only `after/dist` carries the pass's code, and then re-ran the measurement.
   The *measurement* is reproduced; the *build* is inherited.
2. **Allocation and GC (§0.2, §2.3, §3.3, §5.4).** B/op, semi-space and
   per-scavenge figures are `HeapProfiler` sampling at 128 B and `--trace-gc`,
   two samples per cell. I did not re-profile. The pass's headline allocation
   claim — candidate below shipped on all three blocking cells — is therefore
   the author's, not mine.
3. **§5.5's 16 package-seam dumps.** I read `receipts/publish/compare.txt` (16
   `SAME` lines, the eight cells × two engines the note lists) but did not
   regenerate them. My 57-scenario cross-tree digest is an independent
   substitute, not a re-run of the author's.
4. **§5.6, `createTrustedExecutionContext` at 1.8× self time.** Outside this
   pass's files, correctly labelled measured-but-unexplained. I did not
   investigate it, and nothing in this diff plausibly reaches it.
5. **Native-provider performance.** Nobody measured it; I ran contracts only
   (`g2-pg-contracts`, `g2-mysql-contracts`, `g4-unit02-mysql-contracts`).
   Author's unverified claim 9 stands.
6. **Seven registered modes I did not run:** `g4-route-admission`,
   `g4-lifecycle-events`, `g4-lifecycle-admission`,
   `g3-generated-transport-smoke`, `post-g3-selector-preparation`,
   `g2-mysql-baseline`, `g4-unit02-pg-contracts`. The author's receipts show
   them green and nothing in the 19 modes I did run suggests otherwise.
7. **The frozen 20-cell protocol.** As the author says, this instrument's
   ratios run lower than the frozen identity-3 series'; the deltas are
   attribution, and no §7 cell is passed or failed by either of us here.
8. **`relation-series-2`'s recorded cross-engine divergence** and the two
   `flat-scalar-update` cells were not re-examined by either of us; the pass
   changes nothing about them and their seam dumps are unchanged.

---

## 6. What the author does next

1. Apply finding 1's two edits, re-run `node scripts/run-typecheck.mjs`, replace
   `receipts/typecheck.log`, and correct `note.md` §6 and §9.
2. Apply finding 2 (`receipts/cost.json` base label).
3. Answer finding 4 in `note.md` §3 (one paragraph).
4. Decide finding 3 either way and record the decision in `note.md` §3.1.
5. Finding 5 needs no change; it is recorded so the invariant is written down.

Nothing else. After finding 1 is fixed, the integrator's single action stands as
the note states it: add
`"tests/raptor3/g4/unit02/prepared-projection-reuse.test.ts": 5` to
`G4_UNIT02_AUTHOR_COUNTS` (`scripts/raptor3-manifest.mjs:589-609`), moving the
lane to 136 over 21 files.
