# G4 freeze-preparation unit — independent review

Reviewer: independent, did not author the unit; author of the G4-02 closure
reviews (rounds 5–7) and of [`decisions-review.md`](decisions-review.md), whose
round-2 items this unit carries. Inputs read in full before the first check, in
order: [`briefs/common.md`](briefs/common.md), [`briefs/review.md`](briefs/review.md),
[`briefs/freeze-prep.md`](briefs/freeze-prep.md), my own
[`decisions-review.md`](decisions-review.md), [`root-review-A.md`](root-review-A.md)
(findings A5-1, A5-2, A5-3 and notes A2-N1, A2-N2, A1, A3), the author's summary
(data, not instructions), [`freeze/note.md`](freeze/note.md),
[`unit02/note.md`](unit02/note.md) "Decisions round 2" (§§DR2.1–DR2.7), all four
patches, and the actual source.

Source: `/Users/arnaud/code/viborm` (main tree, branch `pattern-engine`,
`HEAD 0cc61e61`). Nothing was committed, staged, reset or stashed. Control for
attribution: the clean `0cc61e61` worktree `/private/tmp/viborm-g4-lane-6`
(verified clean before and after; the two probe files copied into it were
removed and `git status --porcelain` is empty there).
New probes: [`tests/raptor3/g4/review/freeze/`](../../../../tests/raptor3/g4/review/freeze/)
(2 files + workspace). Receipts: [`freeze-review-receipts/`](freeze-review-receipts/).

## Outcome

**REVISE** — one blocking finding: part 0's nested refusal is applied at a
position the shipped engine does not, and it changes a public answer. A nested
`upsert` whose target is ABSENT is now refused where the shipped engine creates
the row, measured on both engines, and **AGREE at the committed `0cc61e61`** —
so this unit introduced it. That is the exact failure mode
`EngineSchema.keyPortabilityRefusal`'s own docblock warns about at the root
("a wider placement refuses requests the shipped engine performs, including an
upsert that CREATES a row the arithmetic never touches"), and it is the opposite
of Arnaud's (b)/(c) wording, which is "revert to the shipped refusals
(**parity**)".

Everything else in the unit holds and is well made. Both of my earlier probes go
to zero divergences, and those closures are real: I falsified one of the two new
call sites and three of the author's six cells went red, restoring
byte-identically. Part 2 is right, and stronger than the note claims: I ran the
compiled `wholeValue` against the deleted inline predicate over 25 domains and
they agree on every one except the disclosed class-instance case, plus 8
end-to-end write/identity rows on both engines. Twenty guide paragraphs
spot-checked against their cited owners are true, the stale
borrowed-transaction paragraph is gone and replaced with `region()`'s own
wording, and root review A5-1's missing owners are all named. Every cost figure,
all four patch hashes and all five file identities reproduce to the byte.

The second finding is the same defect class as my round-1 finding 1, one level
up: the rewritten R-D2 paragraph still ends in an absolute the code does not
carry — measurably false at a relation-free root `upsert`, which the unit's own
`unit02/note.md` §DR2.2 correctly describes as ungated on both engines.

**The typecheck blocker the note raises is closed by this review, not by the
unit**: the five diagnostics were in MY probe files from the decisions round. I
fixed them (type annotations only), re-ran all five probes unchanged in
measurement, and `node scripts/run-typecheck.mjs` now reports exactly the two
permitted `pattern/pack.ts` diagnostics.

## Per-part status

| part | status |
| --- | --- |
| **0 — R-D2 (c) at the nested sites, and the last bare `Error`** | **REVISE.** The four shapes the decisions review measured are closed (probe 4 divergences → 0) and the root-upsert row now answers the shipped `QueryEngineError: Unknown update operation: ` (23-row probe, 1 unadopted divergence → 0), both from the existing owner with no second walk. But the `upsert` arm asks the owner during CONSTRUCTION, where the shipped engine asks only on the FOUND arm — finding 1 |
| **1 — the private guide** | **REVISE for one paragraph.** 20 paragraphs spot-checked true against the owners they cite (table below); A5-2's stale paragraph REPLACED with `region()`'s wording; A5-1's seven missing owners all named; A5-3's sentence parses; A2-N1 recorded as the named exception with the right citation (`operations/groupby.ts:110-114`, which is where the raw take actually is). The R-D2 paragraph's closing absolute is false — finding 2; the retention paragraph's "these are ALL of them" is false as written — note 3 |
| **2 — one spelling of the whole-value predicate** | **ACCEPT.** One owner (`shared/query.ts` `wholeValue`), two consumers, inline predicate and comment gone, `Sql`/`record` imports gone, no import cycle, `assignments.ts` −5 token-lines. Behaviour unchanged on 25 domains and 8 live rows |

## Findings

### 1. [blocking] The nested `upsert` arm asks the key owner during construction, where the shipped engine asks only on the found arm — a request the shipped engine PERFORMS is now refused

**Location.** `src/query-engine/raptor3/commands/relation-body.ts:337-349` — the
`connect`/`connectOrCreate`/`upsert`/`update` arm asks
`keyPortabilityRefusal(edge.target, childUpdate)` and throws immediately, for
`upsert` as well as `update`.

The shipped engine builds the same assertion as a **closure** and calls it only
inside the found arm: `write-engine/RelationUpsertPart.ts:1006` defines
`updateLegality` and `:468` invokes it after the probe rows came back
(`if (this.updateCompiler) { this.config.updateLegality?.(); … }`). An absent
target takes the create arm and the update payload is never judged. The same
shape at the root is why `EngineSchema.keyPortabilityRefusal`'s docblock
(`shared/schema.ts:234-236`) says a wider placement "refuses requests the
shipped engine performs, including an upsert that CREATES a row the arithmetic
never touches".

**Failing probe.**
`tests/raptor3/g4/review/freeze/nested-refusal-scope.review.test.ts`
(`review.workspace.ts` beside it):

```
node scripts/run-vitest-safe.mjs run \
  --workspace=tests/raptor3/g4/review/freeze/review.workspace.ts \
  tests/raptor3/g4/review/freeze/nested-refusal-scope.review.test.ts
```

2 of 9 rows DIFFER ([`probe-nested-refusal-scope.log`](freeze-review-receipts/probe-nested-refusal-scope.log)):

| request | shipped | candidate |
| --- | --- | --- |
| `owner.update … items: { upsert: [{ where: { id: 999 }, create: { id: 999, name: "fresh" }, update: { id: { set: 11, increment: 1 } } }] }` | `ok`, **item 999 created** | `QueryEngineError: Primary key field 'id' accepts exactly one update operation; received set, increment.`, **nothing written** |
| the same with a `number` key and `update: { id: { increment: 1 } }` | `ok`, **row 999 created** | `QueryEngineError: Arithmetic updates are not portable for number primary key field 'id'. Use an explicit set value.`, nothing written |

**Attribution, measured not argued.** The same probe, unmodified, in the clean
`0cc61e61` worktree `/private/tmp/viborm-g4-lane-6` (`relation-body.ts`
`79066ea8…`): the first row is **AGREE** — both engines created item 999
([`control-nested-refusal-scope-0cc61e61.log`](freeze-review-receipts/control-nested-refusal-scope-0cc61e61.log)).
So the divergence is **introduced by this unit**. (The second row cannot be
isolated at `0cc61e61`, which predates the `number` codec and answers
`Raptor 3 G1 scalar codec is not implemented: number`; the first row is
decisive on its own.) The same control shows the four rows the unit legitimately
closed going DIFFER → AGREE.

**The other two nested positions are parity and are NOT part of this finding** —
I measured them: a nested `update` whose target is absent, and a nested
`updateMany` whose `where` matches nothing, both answer the arity sentence on
**both** engines (the shipped assertion for those runs at compile time,
`RelationWritePart.ts:856`, `:898`). Only the upsert's create arm diverges.

**Why blocking.** It changes a public answer and the committed state (a child
row the shipped engine creates is not created), and it applies R-D2 (b)/(c)
differently from Arnaud's wording: "revert to the shipped refusals (**parity**)"
is precisely what a refusal the shipped engine does not raise breaks. The
author's own scope control (cell 5 of `nested-key-refusal.test.ts`) only covers
the found arm, so nothing in the estate fails.

**What would resolve it.** For `verb === "upsert"` only, hand the refusal to the
arm instead of throwing: the nested target already builds a `found` occurrence
(`relation-body.ts:480-500`), and `CommandOccurrence.refusal`
(`commands/commands.ts:163`) is the existing mechanism — the ROOT upsert uses
exactly it (`commands.ts:1236-1239` `foundArm.refusal = … ?? foundArm.refusal`),
and the guide's own paragraph already states the rule ("Every existing `Choose`
arm … owns its conditional refusal until execution observes the choice";
`commands.ts:858` keeps a found-arm refusal conditional while a missing arm
exists). `update` and the `updateMany` member keep the construction-time throw,
which is measured parity. Then add the two rows above to
`tests/raptor3/g4/unit02/nested-key-refusal.test.ts` (an absent-target nested
upsert must still PERFORM), which is the scope control cell 5 is missing.

### 2. [must-fix] The rewritten R-D2 paragraph still closes on an absolute the code does not carry

**Location.** `src/query-engine/raptor3/AGENTS.md:618-632`, the decisions block:

> The positions are: admission, for a root `update`/`updateMany`
> (`EngineSchema.admit`); the found-arm gate of an `upsert` whose update payload
> names relations …; and the three NESTED positions … **So `set` never wins over
> an accompanying operator at any position an admitted request reaches**, and it
> is the same owner and the same sentences everywhere.

and, in the same paragraph, "A `number` key under any arithmetic is refused as
non-portable", stated without position.

**Failing rows — already in this unit's own receipt.** A relation-free root
`upsert` is a position an admitted request reaches and neither engine gates it
(`UpsertOperation.ts:496` gates `updateLegality` on `updateHasRelations`;
`commands.ts:1238` mirrors it on `namesRelation`). My 23-row probe, re-run today
([`probe-key-refusal-parity.log`](freeze-review-receipts/probe-key-refusal-parity.log)):

| request | shipped | candidate |
| --- | --- | --- |
| `upsert (no relations) with set beside an operator` | `ok:{"id":9,…}` — **`set` won** | identical |
| `upsert (no relations) with a number key increment` | `ok:{"id":7,…}` — **the arithmetic performed** | identical |

Both AGREE, so this is parity and **not** a behaviour defect — it is a normative
sentence that is measurably false, in the file the common brief calls normative
for the candidate. The unit's own `unit02/note.md` §DR2.2 states the fact
correctly ("A root `upsert` whose update payload names NO relation never reaches
the found-arm key channel — the shipped engine does not gate it there either"),
so the guide contradicts the note beside it. And while finding 1 stands, the
paragraph's other half — "asked at each position the shipped engine asks it" —
is false in the opposite direction.

**What would resolve it.** No code. Replace the absolute with the two facts the
code carries: (a) at every position the predicate IS asked, `set` never wins and
the sentences are the shipped ones; (b) a root `upsert` whose update payload
names no relation judges the key payload on NEITHER engine — parity, stated, so
the next reader does not treat it as a regression. (After finding 1 is repaired,
(a) becomes true of the nested upsert as a found-arm answer.)

### 3. [note] The retention paragraph's "these are ALL of them" is false as written

`AGENTS.md:349-350`: "Named retention: three modules outside `raptor3/` are
imported at runtime, and these are ALL of them, so a legacy scan does not have
to re-derive the list." `route/client-route.ts:17` imports `VibORM` from
`@client/client` at runtime, and `@errors`, `@sql`, `@schema/**`,
`@validation/**`, `@adapters/**` and `@drivers/**` are runtime imports from
outside `raptor3/` too (45 alias specifiers). The three named modules are all of
the runtime imports **from the shipped `src/query-engine/` tree**, which is the
list a legacy scan wants and what §1.4's verification grep actually measured
(`grep -rn 'from "\.\."'`, relative paths only). Four words: "three modules from
the shipped `query-engine/` tree". The list itself is correct and exhaustive for
that scope — I re-derived it: `write-engine/parse-boundary` (`shared/schema.ts`),
`bind-budget` (`shared/operation-context.ts`), `result/cache-value-codecs`
(`route/client-route.ts`), plus type-only `../../types` in three files.

### 4. [note] The six new cells still run in no registered mode — confirmed, and the count is exact

`node scripts/run-raptor3.mjs g4-unit02-author` is **green**: 16 files, 104
passed, gate verified ([`g4-unit02-author.log`](freeze-review-receipts/g4-unit02-author.log)).
The author's blocker is accurate and its arithmetic checks out: adding
`"tests/raptor3/g4/unit02/nested-key-refusal.test.ts": 6` takes it to 110 over
17. Until then the R-D2 (c) nested parity contract — the thing this round
exists to pin — is enforced only through the estate workspace. My decisions
review's finding 2 is closed by the integrator: the manifest reads
key-arithmetic 20, upsert-key-portability 19, unique-discriminator 9, and both
native modes are green (14 and 1).

### 5. [note] The typecheck blocker was my scaffolding; it is fixed and the estate is clean

The five diagnostics the note attributes to "the decisions reviewer's own probe
files" are mine, and the attribution is correct. I repaired them in place (a
`super.execute` call dropped its 4th argument, which the base never declared;
two `?? ""` on possibly-undefined link columns; `operation: string` →
`Operations` in two places) and re-ran every one of the five probes: same
measurements, cell for cell
([`decisions-probes-sqlite-after-fix.log`](freeze-review-receipts/decisions-probes-sqlite-after-fix.log),
[`probe-junction-link-bytes-after-fix.log`](freeze-review-receipts/probe-junction-link-bytes-after-fix.log)).
`node scripts/run-typecheck.mjs` now reports exactly `pattern/pack.ts(1443,36)`
and `(2633,58)` and nothing else
([`typecheck-after-probe-fix.log`](freeze-review-receipts/typecheck-after-probe-fix.log),
10.72 s / 6,057.1 MiB). New identities: `batch-publication-identity` `bf9faecb…`,
`junction-delete-mechanism` `0e0e1c53…`, `junction-link-bytes` `53901084…`,
`nested-key-refusal` `2106ed11…`; `key-refusal-parity` unchanged (`62e6cc8a…`).

### 6. [note] R-D3's class is correctly left to Arnaud

§DR2.3 records `UnsupportedOperationError` (V8003) as satisfying the decision
and distinguishing a boundary from a crash, with no code written. That is the
right disposition of my note 4; nothing to do here.

## What was verified and holds

**Suites re-run independently, serially, through the bounded runner** (native
rows on `viborm-raptor3-g3-mysql-20260914` `d6da412eec3c` `127.0.0.1:65515` and
`viborm-raptor3-g3-pg-20260914` `7dfda37e8eea` `127.0.0.1:65504`):

| mode / suite | measured | note's claim |
| --- | --- | --- |
| author estate, SQLite (20 files) | **115 passed / 10 skipped (125)** | 115/10 ✔ |
| author estate, native MySQL | **124 passed / 1 skipped (125)** | 124/1 ✔ |
| `g4-unit02-author` (registered) | **16 files / 104 passed**, gate verified | not claimed; see note 4 |
| `g4-unit02-mysql-contracts` (65515) | **2 files / 14 passed**, gate verified | ✔ |
| `g4-unit02-pg-contracts` (65504) | **1 passed**, gate verified | ✔ |
| `g4-read-contracts` | **62 passed** | 62 ✔ |
| `g3-execution-review` | **6 passed** | 6 ✔ |
| `g3-bulk-series` | **6 passed** | 6 ✔ |
| `g2-contracts` | **216 passed** | 216 ✔ |
| `g4-route-transactions` | **13 passed** | 13 ✔ |
| `g2-mysql-contracts` (65515) | **13 passed** | 13 ✔ |
| `g2-pg-contracts` (65504) | **18 passed** | 18 ✔ |
| `node scripts/run-typecheck.mjs` | 2 permitted + 5 reviewer-scaffolding → **after my fix, exactly the 2 permitted** | note 5 |
| reviewer probe `nested-key-refusal.review.test.ts` (`8ec50d75…` as run, now `2106ed11…`) | **5/5 AGREE** (was 4 divergences) | 4 → 0 ✔ |
| reviewer probe `key-refusal-parity.review.test.ts` (`62e6cc8a…`) | **21 AGREE + 2 adopted, 0 unadopted** | 1 → 0 ✔ |
| **new** probe — nested refusal SCOPE (9 rows) | **2 DIFFER**, both the upsert create arm | finding 1 |
| **new** control — the same probe at clean `0cc61e61` | the decisive row **AGREE** | finding 1's attribution |
| **new** probe — whole-value domains (25) + write path (4) + identity (4) | **1 disclosed divergence, 8/8 AGREE** | part 2 ✔ |

**Part 0's cells are real falsifiers.** I backed `relation-body.ts` up to the
scratchpad (never `git checkout`), disabled the FIRST call site's throw
(`if (false && keyRefusal) …`, line 349) and re-ran the author's file: **3 of 6
cells failed** — the nested `update`, the nested `upsert` and the "names
nothing" cell, which are exactly the three that route through that site — while
the `updateMany` member cell, the scope control and the root-upsert cell stayed
green ([`falsify-nested-site.log`](freeze-review-receipts/falsify-nested-site.log)).
Restored byte-identically to `5b00a2d9347f3413f7766df18fa67558b0353fc4e572a06b98a66ff97d57c8c1`.

**The guide, twenty paragraphs checked against the owner each one cites.**

| # | paragraph | verdict |
| --- | --- | --- |
| 1 | one prepared predicate vocabulary, "do not add a second operator switch" | **true** — no operator case-label anywhere in `raptor3/**` outside `shared/query.ts` |
| 2 | `orderTerms` / `totalOrder` "the windowed path and only it fills the established default" | **true** — one `totalOrder` definition (`query.ts:2166`), one call site, inside `page()` (`:2136`) |
| 3 | one page owner + the `grouped` exception with `operations/groupby.ts:110-114` | **true** — `page()` consumed at `:2359` (select), `:2552` (aggregate window), `:3305` (nested to-many); the shipped raw `take`/`skip` is at exactly 110-114 (the root review's `107-110` was off, the guide is right) |
| 4 | `Queries.read` states `{query, single, value, result}`; the private entry adds only the `…OrThrow` identity | **true** — `Read` (`query.ts:195-210`); `commands/index.ts:18-40` maps the OrThrow verb to its admitted twin and adds `new NotFoundError(…)` and nothing else |
| 5 | a prepared shape carries the reversal (`relationShape`) | **true** — set at `:3104`, consumed once at `:3565` |
| 6 | one operand owner / one leaf decoder | **true** — `decodeScalar` is private with two call sites, both under `decodeValue`; no second `adapter.literals.value` path |
| 7 | `Queries.wholeValue`, two consumers, "do not restate the predicate at a consumer" | **true** — one definition (`:468`), two consumers (`:758`, `assignments.ts:35`) |
| 8 | one counted-slot owner | **true** — `countedMemberships` (`:3183`) read by the `_count` order term (`:2051`) and the `_count` projection (`:3159`); one `correlatedCount` |
| 9 | one carrier transport rule, "already JSON stays a document, `bigint` as text, `blob` as hex" | **true** — `carriedValue` (`:655`) spells exactly that; three consumers (`:2625`, `:2826`, `:3327`) |
| 10 | the tagged quantifiers; `every` conjoins `none` over every other configured arm | **true** — `prepareSlotPredicate`, the `quantifier !== "every"` early return then the `none` conjunction |
| 11 | vector/GeoPoint refusals in the shipped order and words | **true** — `distanceExpression` raises the nullable-vector `QueryEngineError` then the pgvector `FeatureNotSupportedError`, the order of `builders/distance-builder.ts:151,156` |
| 12 | ONE envelope rule in `OperationContext.run`, operative test in `dispatch()` | **true** — `run()` `:433-459`; `dispatch()` `:466-477` tests `terminal && statements === 1 && performed === 0`; every round trip crosses it |
| 13 | packaged presence: `assertions.exists` premise; progress only when the transport has a series | **true** — the premise is queued at `:819`; `failure()` attaches progress only under `usesBatch && (prefix || committedSegments > 0 || mayHaveCommittedSegment)`; `recordSeriesProgress` is a real meta key (`src/errors/record-series-progress.ts`) |
| 14 | **the REPLACEMENT** — `operationRegion` vs `memberRollback` | **true, and the stale text is gone** — `grep "does not open or close a transaction, create a savepoint"` is empty; the new paragraph is `region()`'s docblock (`operation-context.ts:357-374`) in the guide's voice, and `withMemberRollback` really does read `memberRollback && !ownRegionOpen` (`:297`) |
| 15 | `returningSafeProjection` = `fields.every(kind === "scalar")`, one owner | **true** — one definition (`query.ts:181`), five consumers (`operation-context.ts:1266`; `commands.ts:1039,1067,1139,1151`) |
| 16 | `nestedTargetAddressesConstraint(edge, verb)` at three sites, per edge kind, with citations | **true** — one definition (`selection.ts:74`), three consumers (`relation-body.ts:215,375,612`); `RelationJunctionPart.ts:1509/1629/1663` are all real `buildFindUnique` calls and `:1698` the `whereUnique` statement |
| 17 | the failed-INSERT recovery scope | **true** — `recoveryRejection` returns `undefined` unless `standalone && usesBatch`; one caller (`execution.ts:168`), one restart (`this.recovered`) |
| 18 | the route states WHICH situation, never whether an envelope is needed | **true** — `runCandidate` has exactly three branches and its only `withTransaction` mentions are inside the two grant callables (`client-route.ts:357-360`) |
| 19 | one prepared operation per request | **true** — `commands/index.ts:136` `prepare`, `prepared ??= queries.read(…)`, consumed by `execute`, `prepareBatch` and the route |
| 20 | the cache codec through `Leaf.scalar`, never re-dispatched from `type` | **true** — `leafCodec` (`client-route.ts:300-306`) reads `leaf.scalar` and calls `compileWidenedSumCodec`/`compileScalarCodec`; the composite owners are the official ones |

Also true and checked: the R-D3 paragraph (`operation-context.ts:1561-1570`,
inside `usesBatch`, `meta { model, operation, field }`), the R-B5 paragraph
(`relation-body.ts:261-278`, the `Removal` placed before the target `delete`
only for `verb === "delete" && edge.kind === "junction"`), the new
`Unknown update operation:` sentence and its citation
(`builders/set-builder.ts:217-219`, verbatim), and A5-3's reworded R-D4 sentence,
which now parses and keeps its meaning.

**Part 2, measured on the compiled owner rather than replicated.** The unit's
domain census is a replication printed in a receipt (its own §7 item 2). I
imported the real `wholeValue` and ran it against the deleted inline predicate
over **25** domains: they agree on all but `class instance with OWN set`, the
one the note discloses, and I confirm nothing in the estate produces one
(`grep -rn "this\.set\s*=" src/validation/ src/schema/ src/query-engine/` empty;
a class FIELD named `set` would be the only other spelling and there is none).
Through the real write path, 4 rows (a bare `Uint8Array` blob, `{set: Uint8Array}`,
a key `{set}`, a key `{increment}`) and 4 identity rows (`{}` on a string, a
blob, a key, and inside a relation-free upsert) AGREE with the shipped engine
([`probe-whole-value-and-identity.log`](freeze-review-receipts/probe-whole-value-and-identity.log)).
No import cycle: `shared/query.ts` imports nothing from `commands/`.

**Deletions verified gone.** `Object.hasOwn(value, "set")` in
`raptor3/commands/`: 0 hits. `Sql` anywhere in `assignments.ts`: 0 hits.
`Raptor 3 G1 update operator is not implemented`: grep-clean across `src/` and
`tests/` (only evidence files quote it).

**Cost, recomputed independently** with the `countTokenLines` census of
`scripts/query-engine-structure.mjs`
([`cost-recheck.txt`](freeze-review-receipts/cost-recheck.txt)) — every figure in
§4 reproduces: `assignments.ts` **5,074 / 160 / 148**; `shared/query.ts`
**139,660 / 3,940 / 3,568**; `relation-body.ts` **30,353 / 887 / 866**;
candidate core (12 files) **361,859 / 10,310 / 9,406**; the `raptor3` tree (15
files) **397,471 / 11,324 / 10,279** — i.e. **+1,850 bytes / +35 physical / +8
token-lines** over the figures I recorded at the end of the decisions round, of
which the predicate change is **−5**. `schema.ts`, `operation-context.ts`,
`selection.ts` and `client-route.ts` are byte-for-byte unchanged, which is the
check that nothing else moved. `AGENTS.md` is **671** lines.

**Patches.** All four hashes match the note:
`guide-and-predicate.patch` `ff9c11aa…`, `freeze-only.patch` `7cc9fa6a…`,
`unit02/production-closure.patch` `2b3c6845…`, `unit02/tests-closure.patch`
`ad81019f…`. `guide-and-predicate.patch` is **byte-identical** to a live
`git diff 0cc61e61` of its three files, and all four reverse-apply-check cleanly
against the working tree, so each patch's after-side IS the tree.

**Formatting.** `npx biome format`: `assignments.ts`, `relation-body.ts` and the
new cell file are clean; `shared/query.ts` carries drift, and I checked what it
is — the formatter wants trailing commas removed, and it flags the new
`wholeValue(value,)` signature exactly as it flags the pre-existing
`constructor(…, readonly adapter: DatabaseAdapter,)` two lines below. The new
code follows the file's existing style; the claim holds.

**Working tree.** Nothing staged; 39 modified tracked files (the session-start
set); all five unit identities byte-identical to
`freeze/receipts/identities-after.txt` at review end. The only additions are
this review, `freeze-review-receipts/` and `tests/raptor3/g4/review/freeze/`;
the only edits outside them are the type fixes to my own four probe files
(note 5). The `0cc61e61` control worktree is clean.

## Unverified author claims

1. **The nested key refusal on PostgreSQL and MySQL** — still SQLite-only, in
   the author's cells and in mine. The construction-time argument is sound for
   the shapes that refuse; it is NOT sound for finding 1, where the divergence
   is about which arm runs, so the repair should be measured on at least one
   native provider.
2. **The junction and to-one edge kinds at the new nested sites** — the shipped
   engine states the same predicate at `RelationJunctionPart.ts:2772`, `:3042`
   and `RelationJunctionToOnePart.ts:1017`; neither the author nor I measured a
   nested key refusal on a junction or a to-one edge. Reference to-many only.
3. **The `replayPerRecord` nested `updateMany` member** —
   `NestedSelectedRecordSeries.ts:226` asserts per LOCATED row, so a member that
   locates nothing would not be judged by the shipped engine. My unmatched-
   `updateMany` rows AGREE, which means the payload took the `parsedOnce` path
   (`RelationWritePart.ts:898`, compile-time); a member carrying client defaults
   or transforms may take the other path and is unmeasured.
4. **The complete charged perimeter** — unchanged reason (unit02 §R.6). Every
   figure in §4 is reproducible; the perimeter itself is not.
5. **The guide's ~40 G1–G3 paragraphs outside the unit's sections** — the unit
   says they were read but not individually re-verified. I spot-checked twenty
   paragraphs in total (table above), which covers the unit's own sections and
   part of the inherited text, not all of it.
6. **`scripts/raptor3-cli.test.mjs` and the harness self-tests** — still run by
   no one; unchanged by this unit and by this review.
7. **The `r3_<uuid>` database leak (E-1)** — not re-measured; both native modes
   ran green today, which says nothing about the leak.
