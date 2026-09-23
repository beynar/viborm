# G4 freeze preparation — unit note

Unit: **G4 freeze preparation** (root-review area A's three obligations, plus
the decisions review's round-2 items). Opened 18:12, closed 18:45, 2026-09-15.
Brief: [`../briefs/freeze-prep.md`](../briefs/freeze-prep.md) over
[`../briefs/common.md`](../briefs/common.md). Inputs read in full before the
first edit: [`../root-review-A.md`](../root-review-A.md),
[`../decisions-review.md`](../decisions-review.md) and its receipts,
[`../unit01/note.md`](../unit01/note.md) §10, the owner sections of
[`../unit02/note.md`](../unit02/note.md) (phase 1 §8, phase 2 §P.4.*, closure
§§R4.1.5/R6.1, decisions §§D.1–D.9) and
[`../unit03/note.md`](../unit03/note.md) (§5, FU.3, FU.6 B-1c, FU.7), and the
whole of `src/query-engine/raptor3/AGENTS.md`.

Source: `/Users/arnaud/code/viborm` (main tree, branch `pattern-engine`,
`HEAD 0cc61e61`). Nothing was committed, staged, reset or stashed. Receipts:
[`receipts/`](receipts/).

## 0. The decision-elimination gate, stated

**Process note, stated plainly:** the common brief asks for this section
*before* the first production edit. It was written at completion instead. The
reason, not an excuse: part 0's two changes were specified by the independent
reviewer down to the owner, the sites and the falsifying probe, and part 2's was
specified by the root reviewer the same way, so there was no open design
question for a pre-edit note to close. The four §7 answers below are against the
actual diff.

| # | Required behavior | Current owner (before) | Smallest change | Decision that disappears | Invariant that replaces it | Falsifier |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | A nested child key update naming `set` beside an operator answers the shipped arity sentence and writes nothing | `EngineSchema.keyPortabilityRefusal`, asked at the two ROOT positions only | ask the SAME owner at the two nested call sites `commands/relation-body.ts` already holds the payload in | "does the key predicate apply at this site?" — answered per position | the predicate is the payload's, not the site's: every position that admits an update payload asks the one owner | the reviewer's `nested-key-refusal.review.test.ts`: 4 divergences before, 0 after |
| 2 | An admitted update payload naming no operator answers the shipped sentence and identity | `Queries.prepareUpdate` threw a bare `Error` with a Raptor-private sentence | one throw becomes the shipped `QueryEngineError: Unknown update operation: ` | "which engine's sentence does an unknown operator get?" | the shipped sentence is the contract wherever the candidate has no rule of its own | the reviewer's `key-refusal-parity.review.test.ts`: 1 unadopted divergence before, 0 after |
| 3 | "an operator record whose `set` names the whole value" has ONE spelling | two: `Queries.prepareUpdate`'s three lines and `commands/assignments.ts`'s `scalarAssignment` | export the owner's answer as `Queries`' module-level `wholeValue`; both read it | "is a class instance with an own `set` an operator record?" — answerable two ways | one boxed answer: `{ value }` means whole, `undefined` means it names an operator | revert `scalarAssignment` to the inline predicate: every cell must stay green (it did), which is the proof the two spellings agreed |

## 1. The private guide, section by section

`src/query-engine/raptor3/AGENTS.md`, 468 lines at `f2c9de89…` (410 at the
committed `0cc61e61`, before the decisions unit appended its seven paragraphs)
→ **671**. Every paragraph below states a fact checked against the source named
in its own last column; the
existing G1–G3 paragraphs were kept where the spot-check and my own reading
found them still true, and the one the root review found false was replaced.

### 1.1 Read language (root review A5-1, G4-01's §10 merged)

Inserted as one block before the existing `prepareProjection` paragraph, so the
projection and selector paragraphs read as its detail.

| paragraph | owner it names | fact verified |
| --- | --- | --- |
| one prepared predicate vocabulary | `Queries.prepareOperations`/`prepareOperation`, `lowerPredicate`/`lowerOperation`, `prepareHaving` | `prepareHaving` builds `{kind:"column"}`/`{kind:"aggregate"}` targets and calls the same `prepareOperations`; every operator case-label in `raptor3/**` is in `query.ts`'s three switches |
| one order owner | `Queries.orderTerms`, `totalOrder` | `page()` fills the default placement only on the windowed path (`totalOrder`), and `lowerOrder` emits the bare direction otherwise |
| one page owner **and its one named exception** | `Queries.page`; `grouped` | `page()` computes order/cursor/`Math.abs` window/`distinct` and is consumed by `select`, `aggregated` and the nested to-many node; `grouped` emits `this.value(args.take)`/`args.skip` raw, `GroupByArgs` (`validation/model/args/aggregate.ts`) admits `by, where, having, orderBy, take, skip` and no `cursor`/`distinct`, and the shipped `operations/groupby.ts:110-114` emits the raw signed take too — parity, stated as the exception root review A2-N1 asked for |
| `Queries.read` states cardinality and public shape | `Queries.read`; `commands/index.ts` `publishedFacts`; `program/index.ts` | every verb returns `{query, single, value, result}`; the private entry adds only `missing = new NotFoundError(model, requested)` for an `…OrThrow` verb; the specimen calls the same owner |
| a prepared shape carries the reversal | `relationShape` | `reversed` is set when `arguments.take < 0` and consumed once, in `decodeValue` |
| one operand owner, one leaf decoder | `Queries.fieldValue`; `decodeScalar` via `decodeValue` | every `adapter.literals.value` call in `raptor3/**` is inside `Queries.value`/`scalarValue`/the JSON member literal; every decode entry point reaches `decodeValue` |
| **one whole-value owner** (new this unit) | `Queries.wholeValue`; `prepareUpdate`; `scalarAssignment` | see §2 |
| one counted-slot owner | `Queries.countedMemberships` + `correlatedCount` | both the `_count` projection and the `_count` order term call `countedMemberships`; one `correlatedCount` |
| one carrier transport rule | `Queries.carriedValue` | three consumers: the aggregate carrier, the recursive projection, the relation projection |
| the tagged quantifiers | `Queries.prepareSlotPredicate` | `some`/`none` address one arm; the `every` arm conjoins `none` over every other configured arm |
| GeoPoint / vector refusals | `Queries.distanceExpression` | the three vector sentences in the shipped order (`builders/distance-builder.ts:142-188`), then the GeoPoint `distance` tier; one expression serves filter, order key and `_distance` leaf |

### 1.2 Physical envelope and write owners (G4-02)

| paragraph | owner it names | fact verified |
| --- | --- | --- |
| ONE envelope rule | `OperationContext.run`, with the operative test in `dispatch()` | the deferred state, the single restart, and `dispatch`'s `terminal && statements === 1 && performed === 0`; the fold's counts (root `create` 1 statement / 0 transactions) come from `Commands.rootCreate` → `OperationContext.createMany` |
| packaged presence, and no series progress on one statement | `OperationContext` (the packaged premise; `published`; `failure`) | the premise is queued as `adapter.assertions.exists(probe.sql)` with a declared `notFound` failure; `failure` attaches progress only when `usesBatch && (prefix | committedSegments | mayHaveCommittedSegment)`; `published` adds the premise to `premiseFailures`, which `failure` returns unwrapped |
| **`operationRegion` vs `memberRollback`** — REPLACES the stale paragraph root review A5-2 found false | `OperationContext.region()`, `ExecutionBinding` | the wording is lifted from `region()`'s own docblock: a borrowed operation owns a region only when its caller granted `operationRegion`; without the grant the caller's scope is the unit and a failing statement poisons it; `memberRollback` is member isolation only, opening inside whatever scope is current |
| `Queries.updateValue` as the one update language | `Queries.updateValue`/`updateAssignment` over one `prepareUpdate`; `adapter.expressions.integerDivide` | the integer `divide` expression asks `a.expressions.integerDivide`; the exact-decimal `multiply`/`divide` expression is the registered refusal; the "names no operator" arm is now the shipped sentence (§2) |
| `returningSafeProjection` | `Queries.returningSafeProjection` | one definition (`query.ts`), five consumers (`operation-context.ts` once, `commands.ts` four times); `namesRelation` is gone from the physical owner |
| the unique-selector spelling rule | `nestedTargetAddressesConstraint(edge, verb)` in `commands/selection.ts` | three consumers in `relation-body.ts` (the `disconnect`/`delete` lookup, the `connect`/`connectOrCreate`/`upsert`/`update` selector, the `set` target) and nowhere else; the shipped citations are the ones the predicate's own docblock carries |
| the junction delete order (R-B5) | the `disconnect`/`delete` arm of `RelationBody.relation` | the `Removal` is placed before the target `delete` when `verb === "delete" && edge.kind === "junction"`, both with the same origin |
| the failed-INSERT recovery scope (was already present — verified, and the owner named) | `OperationContext.recoveryRejection`; `CommandExecution.recover` | `recoveryRejection` returns `undefined` unless `ownership === "standalone" && usesBatch`; `recover` restarts once (`this.recovered`) and only for `missingChoices.get(producer)` matching the selected constraint |

### 1.3 Route (G4-03)

| paragraph | owner it names | fact verified |
| --- | --- | --- |
| the route states WHICH situation, never whether an envelope is needed | `route/client-route.ts` `runCandidate` | three branches: no binding at the root, `driverOverride` with no grant, and the transaction-bound engine with both grants; no `withTransaction` wrap remains |
| the prepared-operation boundary | `prepare(modelName, operation, rawArgs)` in `commands/index.ts` | one handle; `args` and `read` are memoized getters; `execute`/`prepareBatch`/`cacheResultCodec` all read it. Corrected against the brief's wording: the handle publishes the admitted args and the read's facts, and the ROUTE composes the codec from them |
| the cache codec | `result/cache-value-codecs.ts` owners through `Leaf.scalar` | `leafCodec` reads `leaf.scalar` and calls `compileWidenedSumCodec`/`compileScalarCodec`; the three scalar-less leaves are named; a recursive read is refused |

### 1.4 Retention

One paragraph, replacing the `parse-boundary`-only one: the three runtime
imports from outside `raptor3/` are `write-engine/parse-boundary.ts`
(`shared/schema.ts`), `query-engine/bind-budget.ts`
(`shared/operation-context.ts`) and `result/cache-value-codecs.ts`
(`route/client-route.ts`). Verified exhaustive today: `grep -rn 'from "\.\.'` in
`raptor3/` returns those three plus type-only `../../types`.

### 1.5 The decisions block

- **R-D2's absolute, corrected** (decisions review finding 1). "`set` never wins
  over an accompanying operator anywhere" was measurably false one level down.
  It now names the one owner and every position it is asked at — admission, the
  upsert found-arm gate, and the three nested positions this unit added — so the
  sentence is true and the reader is told where to look. The paragraph also
  names `keyTransitionRefusal` as the transition owner.
- **R-D4's broken sentence, reworded** (root review A5-3), keeping its meaning:
  "Under a case-insensitive collation the stored bytes may differ from the
  request's literal, and the located value is the contract".
- The R-D1, D-5, D-6, R-D3 and R-B5 paragraphs were verified and kept; R-B5's
  gained its candidate owner.

## 2. One spelling of "an operator record whose `set` names the whole value"

`shared/query.ts` gains one exported module-level owner:

```ts
export function wholeValue(value: unknown): { readonly value: unknown } | undefined
```

boxed so `undefined` can mean "it names an operator instead" — which is the only
reason the two sites had different spellings in the first place:
`prepareUpdate` needed the negative answer and `scalarAssignment` did not.
`prepareUpdate`'s first four lines are replaced by `const whole =
wholeValue(value); if (whole) return { kind: "value", value: whole.value };`
and `commands/assignments.ts`'s `scalarAssignment` becomes two lines over the
same call. The inline predicate and its comment are deleted, and `assignments.ts`
no longer imports `Sql` or `record` (nothing else used them).

**Behavior must not change, and the domains were enumerated.** The old spelling
unwrapped `set` on ANY object with an own `set` except a `Sql`; the new one
treats every non-plain object as one whole value. They agree on every domain an
admitted scalar value can be — checked over 22: `null`, `undefined`, number,
bigint, string, boolean, `Uint8Array`, `Date`, `Decimal`, array, array of
`Uint8Array`, `Map`, `Set`, `Sql`, plain `{set}`, plain `{set: null}`, plain
`{increment}`, plain `{set, increment}`, plain `{}`, null-prototype `{set}`,
null-prototype `{increment}` — and diverge on exactly one: **a class instance
carrying an OWN `set` property**, which the old spelling unwrapped and the new
one keeps whole ([`receipts/whole-value-domains.log`](receipts/whole-value-domains.log);
the census is a replication of the two spellings, printed beside them in the
same receipt, not the compiled modules). Nothing in the estate produces such a
value: `grep -rn "this\.set\s*=" src/validation/ src/schema/ src/query-engine/`
is empty, re-run in the same receipt.

**Falsifier, and the proof the two spellings agreed.** `assignments.ts` was
swapped back to the inline predicate from a scratchpad copy (never `git
checkout`), and the estate plus three broad modes were re-run: author estate
115/10 (125), `g2-contracts` 216, `g3-bulk-series` 6, `g3-execution-review` 6 —
**every cell green**, which is exactly what a behavior-preserving change must
show ([`receipts/falsify-whole-value.log`](receipts/falsify-whole-value.log)).
The file was then restored byte-identically (`654a27a2…`, re-hashed in the same
receipt, and still that identity at close). That falsification ran while
`shared/query.ts` and `commands/relation-body.ts` were at `0cc8ac08…` /
`854d3f11…`; both moved afterwards for one formatter-layout fix each
(whitespace only, `npx biome format` clean for `relation-body.ts`, and for
`query.ts` the file's pre-existing whole-file trailing-comma drift is all that
remains), and every suite in §5 was re-run after that last edit. A falsifier that turns cells RED would mean the change altered
behavior; here the invariant being falsified is "the two spellings answered the
same", and green is its confirmation.

## 3. Part 0 — the decisions review's round-2 items

Recorded in full, with the call-site table, the probes and the counts, in
[`../unit02/note.md`](../unit02/note.md) "Decisions round 2" (§§DR2.1–DR2.7), as
the brief directs. In summary: the nested R-D2 (c) parity landed at two call
sites in `commands/relation-body.ts` through `EngineSchema.keyPortabilityRefusal`
(reviewer probe 4 divergences → 0); the last bare `Error` in the family became
the shipped `Unknown update operation:` identity in `Queries.prepareUpdate`
(reviewer probe 1 unadopted divergence → 0); six author cells were added as
`tests/raptor3/g4/unit02/nested-key-refusal.test.ts`; note 4 is recorded for
Arnaud with no code; note 6's figures are updated in §R4.8 in place.

## 4. §7 decision-elimination answers, against this diff

1. **Necessary decision or representation repair?** All three changes REMOVE a
   duplicated authority rather than adding a synchronization rule. The nested
   refusal asks an existing owner at positions that already hold the payload —
   no new walker, no per-verb table, no second sentence. The shipped-sentence
   change deletes a Raptor-private identity in favour of the boundary's own.
   `wholeValue` deletes the second spelling of one predicate. The guide adds no
   rule at all; it states rules the code already carries.
2. **Exact deletion and replacement obligation?** Three deletions, named in §0's
   table with their mechanism, consumers, replacing invariant and falsifier. No
   equivalent mechanism moved elsewhere, checked by grep:
   `Object.hasOwn(value, "set")` is gone from `raptor3/commands/` (0 hits);
   `assignments.ts` references `Sql` nowhere at all, not even in its imports
   (the one surviving `instanceof Sql` in `raptor3/commands/` is
   `command-attempt.ts:79`, an unrelated runtime-binding filter); and
   `Raptor 3 G1 update operator is not implemented` is grep-clean across `src/`
   and `tests/`.
3. **One rule across uses?** Yes, and exercised at a second placement in each
   case: the key refusal is exercised at a nested `update`, a nested `upsert`
   and an `updateMany` member (three placements, one owner, one sentence set),
   with a scope-control cell proving it is not wider than the shipped
   predicate; `wholeValue` is exercised by both of its consumers under the whole
   estate and `g2-contracts`.
4. **What actually grew?** Bytes / physical / token-lines:

   | file | before | after | delta |
   | --- | --- | --- | --- |
   | `commands/assignments.ts` | 5,068 / 161 / 153 | **5,074 / 160 / 148** | +6 / −1 / **−5** |
   | `shared/query.ts` | 138,763 / 3,920 / 3,563 | **139,660 / 3,940 / 3,568** | +897 / +20 / +5 |
   | `commands/relation-body.ts` (part 0) | 29,406 / 871 / 858 | **30,353 / 887 / 866** | +947 / +16 / +8 |
   | candidate core (12 files) | 360,009 / 10,275 / 9,398 | **361,859 / 10,310 / 9,406** | +1,850 / +35 / **+8** |
   | `raptor3` tree (15 files) | 395,621 / 11,289 / 10,271 | **397,471 / 11,324 / 10,279** | +1,850 / +35 / **+8** |

   Eight token-lines for two parity behaviours and one deleted duplicate
   predicate, of which the predicate change is itself **−5**. The rest of the
   byte growth is documentation (the `wholeValue` docblock, the nested refusal's
   two citations). `AGENTS.md` grew 468 → **671** lines and is evidence, not charged
   source. The **complete charged perimeter** is unchanged and still unverified
   for §R.6's standing reason. Receipt: [`receipts/cost.txt`](receipts/cost.txt).

## 5. Suites, after the last source edit

One mode per invocation, serially, through the bounded runner. Receipts in
[`receipts/`](receipts/); each log ends with its own `exit=` line.

| mode / suite | measured | wall / peak RSS |
| --- | --- | --- |
| author estate `tests/raptor3/g4/unit02/`, SQLite (20 files) | **115 passed / 10 skipped (125)** | 9.42 s / 692.7 MiB |
| author estate, native MySQL `127.0.0.1:65515` | **124 passed / 1 skipped (125)** | 8.17 s / 713.1 MiB |
| reviewer probe `nested-key-refusal.review.test.ts` | **1 passed**, 5/5 AGREE (was 4 divergences) | 2.6 s / 470 MiB |
| reviewer probe `key-refusal-parity.review.test.ts` | **1 passed**, 21 AGREE + 2 adopted (was 1 unadopted divergence) | 2.4 s / 501 MiB |
| `g4-read-contracts` | **62 passed** | 4.9 s / 731.8 MiB |
| `g3-execution-review` | **6 passed** | 3.9 s / 521.8 MiB |
| `g3-bulk-series` | **6 passed** | 3.9 s / 540.0 MiB |
| `g2-contracts` | **216 passed** | 6.8 s / 846.2 MiB |
| `g4-route-transactions` | **13 passed** | 4.0 s / 546.3 MiB |
| `g2-mysql-contracts` (65515) | **13 passed** | 4.8 s / 673.3 MiB |
| `g2-pg-contracts` (65504) | **18 passed** | 5.4 s / 702.4 MiB |
| `node scripts/run-typecheck.mjs` | the two permitted `pattern/pack.ts` diagnostics **plus five inherited** — see §6 | 17.0 s / 6,133.7 MiB |

## 6. Blockers and things recorded, not repaired

1. **[for the integrator] The whole-estate typecheck is not clean, and not
   because of this unit.** Five diagnostics sit in the decisions reviewer's own
   probe files under `tests/raptor3/g4/review/unit02-decisions/` (two TS2554
   from a driver subclass calling `super.execute` with four arguments, two
   TS18048, one TS2345 from an untyped `operation: string`). Attributed by
   measurement: with this unit's production files restored to their pre-freeze
   identities and the new cell file parked, the same five are still reported
   ([`receipts/typecheck-attribution.log`](receipts/typecheck-attribution.log));
   every file was restored byte-identically afterwards. They are another
   stream's files and were not edited. The freeze cannot claim a clean
   whole-estate typecheck until their owner fixes them or the integrator
   accepts them as review scaffolding.
2. **[for the integrator] One registration line.** Add
   `"tests/raptor3/g4/unit02/nested-key-refusal.test.ts": 6` to
   `G4_UNIT02_AUTHOR_COUNTS` (`scripts/raptor3-manifest.mjs`), taking
   `g4-unit02-author` from 104 over 16 files to **110 over 17**. Not edited
   here; the manifest is the integrator's. Until then the six new cells run only
   through the estate workspace.
3. **[for Arnaud, one line] R-D3's error class.** `UnsupportedOperationError`
   (V8003) extends `QueryEngineError`, carries `meta` the same way, and
   distinguishes a documented capability boundary from an engine crash (V9001).
   It would satisfy the decision as worded. Kept as `QueryEngineError`; no code
   written. (§DR2.3.)
4. **[note] Root review A2-N1 is now a recorded exception, not an open row.**
   `grouped()`'s raw signed window is stated in the guide's page paragraph with
   its shipped citation, which is the second of the two closures the reviewer
   offered. The first (routing `grouped` through `page()` with an option) was
   not taken: it would add a parameter to the page owner to express a verb that
   has none of the facts the owner exists for.
5. **[note] Root review A1's two housekeeping suggestions** — recording the
   three dirty files' `0cc61e61` diff and mtimes in `g4/environment/`, and
   naming `tests/pattern/match/decode-malformed.core.test.ts` in the ledger's
   untouched list — are the integrator's, in files this unit does not own.

## 7. Unverified

1. **The complete charged perimeter** — unchanged reason (unit02 §R.6). Every
   figure in §4 is reproducible; the perimeter itself is not.
2. **The domain census in §2 is a replication**, not an execution of the
   compiled modules: the repo has no TypeScript runner outside Vitest, and the
   brief scopes this unit's test edits to part 0. The two spellings are printed
   verbatim beside the census in the same receipt, and the behavioural proof is
   the falsifier.
3. **The nested key refusal on PostgreSQL** is not measured. It is raised during
   construction, before any statement is built, so no dialect can reach it
   differently — an argument, not a measurement. `g2-pg-contracts` 18/18 covers
   the provider generally, not this family. (Same standing gap as unit02 §D.9
   item 3.)
4. **The guide's G1–G3 paragraphs outside this unit's sections** were read but
   not individually re-verified against the code; the root review spot-checked
   twelve and found one false, which is the one replaced here. A paragraph-level
   audit of the remaining ~40 was not in scope.
5. **`scripts/raptor3-cli.test.mjs` and the harness self-tests** are still run
   by no one; unchanged by this unit.

## 8. Identity, after the last edit

`captureRaptor3Identity` ([`receipts/identity-after.json`](receipts/identity-after.json)):

| Fact | Value |
| --- | --- |
| production | `e1f4f2e80afc8166169f31c6b1c9d64a8d0e3f6768f7be3b9fe15748a6947da5` |
| harness | `e34dbd24eb7cbddf4d19840aafeb68f5a90a5c545e0d52c94f240b9ecf440e2b` |
| runtime | Node v24.21.0, darwin/arm64, better-sqlite3 12.6.0, Vitest 3.1.4 |

Per file ([`receipts/identities-after.txt`](receipts/identities-after.txt)):

| file | before | after |
| --- | --- | --- |
| `raptor3/AGENTS.md` | `f2c9de8967828560…` | `dad9fe25d90a81f8912237063bfc6962f59cfd81757e8a2ee35609030d03c8ab` |
| `raptor3/commands/assignments.ts` | `1e9b7c529d75f9dd…` | `654a27a2f8c59b5eaf0c3aa17dddce92b31adfad385220933355309dcb64592d` |
| `raptor3/shared/query.ts` | `7ffbea606cbd6e62…` | `38328088e4f3a5cea13723ff5dd0e3855ef7af5438b420d7818fa59816ef7bd6` |
| `raptor3/commands/relation-body.ts` (part 0) | `3bf284452f04aa8d…` | `5b00a2d9347f3413f7766df18fa67558b0353fc4e572a06b98a66ff97d57c8c1` |
| `tests/raptor3/g4/unit02/nested-key-refusal.test.ts` (part 0, new) | — | `59487465e09dbdb6f2e68ddc717258b15bdf3f26980b177309d87b30a3607566` |

Working tree at close: 39 modified tracked files (the session-start set),
nothing staged, no unrelated file touched.

**Patches.**
[`guide-and-predicate.patch`](guide-and-predicate.patch) — the three files part
1–2 name, `git diff` against `0cc61e61` —
`ff9c11aae8d9e474f07ccaeb2e599039f979923a4bafe608fe502744decb710b`.
[`freeze-only.patch`](freeze-only.patch) — this unit's OWN delta (the same three
files against their pre-freeze copies, plus part 0's `relation-body.ts` and the
new cell file) — `7cc9fa6ae310857b2dbb2fe0f3bc04ddc18224809ff7d683a02ce8c2218547de`.
Part 0's production and test changes are also carried by the regenerated
[`../unit02/production-closure.patch`](../unit02/production-closure.patch)
(`2b3c6845…`) and [`../unit02/tests-closure.patch`](../unit02/tests-closure.patch)
(`ad81019f…`).

---

# Round 2 — the freeze review's findings 1–3

[`../freeze-review.md`](../freeze-review.md) returned **REVISE** on the unit
above: one blocking finding, one must-fix and one note. Opened 19:15, closed
20:05, 2026-09-15. Everything in this section supersedes §§4, 5 and 8 where the
two disagree; §§1–3 and the round-1 receipts stand unchanged. Source: the same
main tree, branch `pattern-engine`, `HEAD 0cc61e61`. Nothing committed, staged,
reset or stashed. Receipts: [`receipts/round2/`](receipts/round2/).

The reviewer's own two closures from the decisions round were re-measured first
and still hold (`nested-key-refusal.review.test.ts` and
`key-refusal-parity.review.test.ts`, 2 files / 2 passed, 0 divergences —
[`probes-decisions-after.log`](receipts/round2/probes-decisions-after.log)).

## R2.1 Finding 1 (blocking) — the nested `upsert` asks on the FOUND arm

**What was wrong.** Round 1 asked `EngineSchema.keyPortabilityRefusal` at the
`connect`/`connectOrCreate`/`upsert`/`update` arm of `RelationBody.relation` and
threw immediately, for `upsert` as well as `update`. The shipped engine does not
assert at construction everywhere: it builds the same assertion as a CLOSURE
(`RelationUpsertPart.ts:1006`) and invokes it only inside the found arm
(`:468`, `if (this.updateCompiler) { this.config.updateLegality?.(); … }`), so a
nested `upsert` whose target is ABSENT takes the create arm and its update
payload is never judged. Round 1 refused two requests the shipped engine
performs — exactly the failure `keyPortabilityRefusal`'s own docblock warns a
wider placement produces, "an upsert that CREATES a row the arithmetic never
touches".

**The repair, and the mechanism.** For `verb === "upsert"` ONLY, the
construction-time throw is gone (`if (keyRefusal && verb !== "upsert") throw
keyRefusal;`) and the refusal is handed to the found arm the request already
builds. The nested `update` and the `updateMany` member keep the construction
throw, which is measured parity: the shipped engine asserts for those at its own
compile sites (`RelationWritePart.ts:856`, `:898`), and the reviewer measured
both shapes AGREE on both engines.

The CARRIER is the found arm's own deferred `Assignments`
(`target.found.command.fields.reject(keyRefusal)`), not
`CommandOccurrence.refusal`, and the reason is a fact the guide already states.
The root upsert's spelling (`commands.ts:1236-1239`) assigns
`foundArm.refusal` to an occurrence that has ALREADY been materialized
(`materializePlacement` runs at `:1226`, the assignment at `:1235`). A relation
body writes a RECIPE: `materializePlacement` replaces every recipe occurrence
with a fresh one (`const replacement = this.occurrence(source.command,
source.placement)`) and copies only `role` and the capture target, because
"Reusing a command or `Selection` never reuses occurrence ancestry, children,
refusal, or attempt state" (`AGENTS.md`, the `Commands.analyze` paragraph). A
refusal set on `target.found` before materialization is therefore dropped —
measured, not argued: that exact spelling
(`target.found.refusal = keyRefusal ?? target.found.refusal`, the root's, placed
in the body) leaves the reviewer's control row "nested upsert, target PRESENT"
**DIFFER**, the candidate performing the update the shipped engine refuses
([`mechanism-occurrence-refusal-dropped.log`](receipts/round2/mechanism-occurrence-refusal-dropped.log);
`relation-body.ts` was restored byte-identically afterwards). Teaching
`materializePlacement` to carry the refusal across would close it in one line
and was rejected: it contradicts the invariant above, which is the guide's, not
this unit's.

What DOES survive a recipe is the command, and the found arm's command is
already built deferred (`this.commands.update(lookup, record(childUpdate), …,
true)`). `Assignments.reject` on a deferred carrier stores instead of throwing,
and `activate()` raises it at `execution.ts:259` — the first thing the record
case does, and only for the arm execution actually runs (`:389` checks the same
carrier on the probe path). That is the same rule the guide states for every
`Choose` arm: "Every existing `Choose` arm … owns its conditional refusal until
execution observes the choice." One owner, one sentence set, one new line.

**Measured.** The reviewer's probe
`tests/raptor3/g4/review/freeze/nested-refusal-scope.review.test.ts` goes
**2 DIFFER → 0**: 9 rows, 9 AGREE, 3 passed
([`probe-nested-refusal-scope-after.log`](receipts/round2/probe-nested-refusal-scope-after.log)).

## R2.2 The scope control the estate was missing, and the family on live MySQL

`tests/raptor3/g4/unit02/nested-key-refusal.test.ts` keeps its **6** cells; the
scope-control cell (cell 5) gained the two rows the reviewer named and the
`number`-key models they need, and was renamed to what it now measures — "keeps
the refusal inside the shipped predicate's SHAPE and POSITIONS". The registered
count is unchanged, so `g4-unit02-author` needs no manifest edit.

| direction | rows | must answer |
| --- | --- | --- |
| SHAPE | a nested child key naming exactly one operation (`set`, then `increment`) | performs, both engines |
| POSITION (new) | nested `upsert`, target **ABSENT**, `id: { set: 11, increment: 1 }` | performs, and item 999 is CREATED (`items` = `[10, 999]`) |
| POSITION (new) | nested `upsert`, target **ABSENT**, `number` key `id: { increment: 1 }` | performs, and row 999 is CREATED (`nitems` = `[10, 999]`) |
| found arm | cell 2, nested `upsert`, target **PRESENT**, same payload | `QueryEngineError: Primary key field 'id' accepts exactly one update operation; received set, increment.`, nothing written |

Every row runs both engines over the same data and compares the answer AND the
rows, so a refusal that fires late enough to write something fails the cell.

**Live MySQL: a native file, because this file's world is SQLite-only.**
`nested-key-refusal.test.ts` builds an in-memory `better-sqlite3` world, so
running the estate with `VIBORM_RAPTOR3_PROVIDER=mysql` does not change what it
measures. A `describe.runIf` block inside it would break `g4-unit02-author`,
whose gate asserts `receipt.skipped === 0`. So the provider measurement is a new
estate file, `tests/raptor3/g4/unit02/native-nested-key-refusal.test.ts`, gated
the way `native-key-arithmetic.test.ts` is (`provider === "mysql" && port > 0`),
with three rows on both engines over real tables: found-target refuses and
writes nothing, absent-target CREATES the row, nested `update` refuses.
**3 passed** on `viborm-raptor3-g3-mysql-20260914` `127.0.0.1:65515`
([`cells-native-nested-key-refusal-mysql.log`](receipts/round2/cells-native-nested-key-refusal-mysql.log)).
The reviewer's unverified claim 1 ("the repair should be measured on at least one
native provider") is closed for MySQL; PostgreSQL is still unmeasured for this
family.

## R2.3 The falsifier, run in both directions

The claim being falsified is "the refusal is on the found arm": disable the
handoff and the cells must go red, on the correct side. `relation-body.ts` was
copied to the scratchpad first and restored from that copy (never `git
checkout`).

| falsification | SQLite cells | native MySQL cells |
| --- | --- | --- |
| **A** — put the refusal back at construction (`if (keyRefusal) throw keyRefusal;`) | scope control **RED**, other 5 green ([`falsify-A-construction-throw.log`](receipts/round2/falsify-A-construction-throw.log)) | "creates the row for a nested upsert whose target is ABSENT" **RED**, other 2 green ([`falsify-A-construction-throw-mysql.log`](receipts/round2/falsify-A-construction-throw-mysql.log)) |
| **B** — remove the handoff (no `reject`, `upsert` never refuses) | "refuses a nested child upsert…" **RED**, other 5 green ([`falsify-B-no-handoff.log`](receipts/round2/falsify-B-no-handoff.log)) | "refuses a nested upsert whose target is PRESENT" **RED**, other 2 green ([`falsify-B-no-handoff-mysql.log`](receipts/round2/falsify-B-no-handoff-mysql.log)) |

Each falsification turned exactly the cells that depend on it red and left the
others green, which is what a pin with no slack looks like. Restored
byte-identically to
`61af50d82a5c3479b6484dd615ff211186f054b06916329bb0eb447679c2b5d9`, and still
that identity at close.

## R2.4 Finding 2 (must-fix) — the R-D2 paragraph's closing absolute

`raptor3/AGENTS.md`, the decisions block. "So `set` never wins over an
accompanying operator at any position an admitted request reaches" was
measurably false at a relation-free root `upsert`, which the unit's own
[`../unit02/note.md`](../unit02/note.md) §DR2.2 describes correctly. The
absolute is replaced by the two facts the code carries, plus the timing finding
1 established:

1. The nested `update` and the `updateMany` member refuse during construction
   (the shipped compile sites `RelationWritePart.ts:856`, `:898`); the nested
   `upsert` does not, and answers as a found-arm refusal — an ABSENT target
   takes the create arm with its update payload unjudged, on both engines.
2. At every position the predicate IS asked, `set` never wins over an
   accompanying operator and the sentences are the shipped ones, from the same
   owner: no per-verb branch, no second walk.
3. A root `upsert` whose update payload names NO relation judges the key payload
   on **neither** engine — `UpsertOperation.ts:496` gates `updateLegality` on
   `updateHasRelations`, `commands/commands.ts` mirrors it on `namesRelation` —
   so `set` wins there on both. Stated as parity, so the next reader does not
   take it for a regression and widen the gate.

"before any statement" is now attached to the two positions where it is true
instead of to the family. All five shipped citations were re-read in the source
before they were written down.

## R2.5 Note 3 — the retention paragraph's scope

`AGENTS.md`, the named-retention paragraph: "three modules **from the shipped
`query-engine/` tree** are imported at runtime, and these are ALL of them". The
list itself was right; its scope was not, and §1.4's verification grep
(`from "..`, relative paths only) measured exactly that scope. One parenthetical
now names the boundaries the brief keeps available and that a legacy scan should
not count — `@errors`, `@sql`, `@schema/**`, `@validation/**`, `@adapters/**`,
`@drivers/**`, and `@client/client`, which `route/client-route.ts:17` imports at
runtime for `VibORM`. Re-derived today: those seven alias roots and no others.

`AGENTS.md` is **690** lines (671 at the end of round 1).

## R2.6 Suites, after the last source edit

One mode per invocation, serially, through the bounded runner. Receipts in
[`receipts/round2/`](receipts/round2/); each log ends with its own `exit=` line.

| mode / suite | measured | wall / peak RSS |
| --- | --- | --- |
| author estate `tests/raptor3/g4/unit02/`, SQLite (21 files) | **115 passed / 13 skipped (128)** | 15.05 s / 678.1 MiB |
| author estate, native MySQL `127.0.0.1:65515` | **127 passed / 1 skipped (128)** | 44.04 s / 642.8 MiB |
| `g4-unit02-author` (registered) | **17 files / 110 passed**, gate verified | 16.37 s / 682.5 MiB |
| reviewer probe `nested-refusal-scope.review.test.ts` | **3 passed**, 9/9 AGREE (was 2 DIFFER) | 4.23 s / 496.2 MiB |
| reviewer probes `nested-key-refusal` + `key-refusal-parity` | **2 passed**, 0 divergences | 5.85 s / 546.8 MiB |
| `g4-read-contracts` | **62 passed**, gate verified | 9.28 s / 725.8 MiB |
| `g3-execution-review` | **6 passed**, gate verified | 11.80 s / 500.5 MiB |
| `g2-contracts` | **216 passed**, gate verified | 16.50 s / 748.5 MiB |
| `g4-route-transactions` | **13 passed**, gate verified | 11.45 s / 491.3 MiB |
| `g2-mysql-contracts` (65515) | **13 passed**, gate verified | 16.82 s / 620.7 MiB |
| `g2-pg-contracts` (65504) | **18 passed**, gate verified | 13.20 s / 642.4 MiB |
| `node scripts/run-typecheck.mjs` | **exactly the two permitted** `pattern/pack.ts` diagnostics (`1443,36` and `2633,58`) and nothing else | 20.08 s / 4,669.0 MiB |

The typecheck blocker of §6 item 1 is **closed**: the five diagnostics were the
decisions reviewer's own probe files and the reviewer repaired them in place.
`npx biome format` is clean for `relation-body.ts` and both cell files
([`biome-format.log`](receipts/round2/biome-format.log)).

## R2.7 Cost, after round 2

`countTokenLines` from `scripts/query-engine-structure.mjs`, verbatim
([`cost.txt`](receipts/round2/cost.txt)). Only `relation-body.ts` moved.

| file | round 1 | round 2 | delta |
| --- | --- | --- | --- |
| `commands/relation-body.ts` | 30,353 / 887 / 866 | **32,238 / 912 / 867** | +1,885 / +25 / **+1** |
| `commands/assignments.ts` | 5,074 / 160 / 148 | **5,074 / 160 / 148** | unchanged |
| `shared/query.ts` | 139,660 / 3,940 / 3,568 | **139,660 / 3,940 / 3,568** | unchanged |
| candidate core (12 files) | 361,859 / 10,310 / 9,406 | **363,744 / 10,335 / 9,407** | +1,885 / +25 / **+1** |
| `raptor3` tree (15 files) | 397,471 / 11,324 / 10,279 | **399,356 / 11,349 / 10,280** | +1,885 / +25 / **+1** |

Against the pre-freeze baseline the unit is now **+9** token-lines on the core
(8 after round 1, 1 more here), of which the predicate change in §2 is −5. One
token-line for the repair; the rest of the byte growth is the two comment blocks
that name the shipped placement and the carrier, which is what the next reader
needs to not undo it.

## R2.8 Identity, after the last edit

`captureRaptor3Identity`
([`identity-after.json`](receipts/round2/identity-after.json)):

| Fact | Value |
| --- | --- |
| production | `e2d5bcb2201641372941c2c1fa6e648f52429fb3ca8ce948678baa80a31b589f` |
| harness | `b7f5a61bf19d8d6135cda70c59d1317f6c503a3ecf6f0c6ac704917c3350b5fd` |
| runtime | Node v24.21.0, darwin/arm64, better-sqlite3 12.6.0, Vitest 3.1.4 |

Per file ([`identities-after.txt`](receipts/round2/identities-after.txt)):

| file | round 1 | round 2 |
| --- | --- | --- |
| `raptor3/AGENTS.md` | `dad9fe25d90a81f8…` | `5572d96aa5bdb315e3af7d670a02e48f54b61140c74ebffa2e9d95f37766b006` |
| `raptor3/commands/relation-body.ts` | `5b00a2d9347f3413…` | `61af50d82a5c3479b6484dd615ff211186f054b06916329bb0eb447679c2b5d9` |
| `raptor3/commands/assignments.ts` | `654a27a2f8c59b5e…` | `654a27a2f8c59b5eaf0c3aa17dddce92b31adfad385220933355309dcb64592d` (unchanged) |
| `raptor3/shared/query.ts` | `38328088e4f3a5ce…` | `38328088e4f3a5cea13723ff5dd0e3855ef7af5438b420d7818fa59816ef7bd6` (unchanged) |
| `tests/raptor3/g4/unit02/nested-key-refusal.test.ts` | `59487465e09dbdb6…` | `b844e7c3b2ce0a828e9fdcf21a5d03cf2eee6a9904f66469ecbc15c13b06a62c` |
| `tests/raptor3/g4/unit02/native-nested-key-refusal.test.ts` (new) | — | `de2b80fd47c892415a655bd3a93ef1ec4a842809eaab6c3ad6ee3bf620021237` |

Working tree at close: the session-start set of modified tracked files plus this
unit's four, nothing staged, no unrelated file touched.

**Patches, regenerated with verification**
([`patches-regenerated.log`](receipts/round2/patches-regenerated.log)). Each was
forward-applied into a fresh copy of its own base and compared byte for byte
against the tree: the closure pair reproduces all 15 files, `freeze-only.patch`
all 6.

- [`guide-and-predicate.patch`](guide-and-predicate.patch) — the three files
  parts 1–2 name, `git diff 0cc61e61`, byte-identical to a live one —
  `0e8dd379831fc243c2858842e06e57c7b9ec6646eb7784acc2f01ed393e3074b`
- [`freeze-only.patch`](freeze-only.patch) — this unit's OWN delta, now six
  files (the two cell files included) —
  `6e313fbccc51200f1aabe614b84b7f11d88f4928c1e3617e7852646b241dbd16`
- [`../unit02/production-closure.patch`](../unit02/production-closure.patch) —
  seven files —
  `2bb20d133cdd3e34c3dd0b8b4f836a94912a2d694ea0678fd4779326a749cdc8`
- [`../unit02/tests-closure.patch`](../unit02/tests-closure.patch) — eight files
  (the seven it had, plus `native-nested-key-refusal.test.ts`) —
  `b45552977e8d06a41ed603c5dc9841f993101a9dd2344dec071fc5a9a9d79d9b`

## R2.9 Blockers and unverified, after round 2

**Closed from §6.** Item 1 (the whole-estate typecheck) — the five diagnostics
were the decisions reviewer's scaffolding and are fixed; the estate now reports
exactly the two permitted Pattern diagnostics. Item 2 (the registration line) —
the integrator registered `nested-key-refusal.test.ts: 6` and
`g4-unit02-author` is green at 17 files / 110.

**One new registration request, for the integrator.** Add
`"tests/raptor3/g4/unit02/native-nested-key-refusal.test.ts": 3` to
`G4_UNIT02_MYSQL_COUNTS` (`scripts/raptor3-manifest.mjs`), taking
`g4-unit02-mysql-contracts` from 14 over 2 files to **17 over 3**. Not edited
here; the manifest is the integrator's. Until then the three native rows run
only through the estate workspace with `VIBORM_RAPTOR3_PROVIDER=mysql`, which is
how they were measured today. `G4_UNIT02_AUTHOR_COUNTS` needs no change:
`nested-key-refusal.test.ts` still has exactly 6 cells.

§6 items 3 (R-D3's error class, for Arnaud), 4 (A2-N1 recorded as an exception)
and 5 (A1's housekeeping, the integrator's) stand unchanged.

**Unverified, updated.**

1. **This family on PostgreSQL** — still unmeasured. MySQL now covers the
   repair's two directions on a real provider (R2.2), and the found-arm handoff
   is dialect-independent by construction, but PostgreSQL is an argument, not a
   measurement.
2. **The junction and to-one edge kinds at the nested sites** — unchanged from
   the reviewer's claim 2: reference to-many only, on both sides.
3. **The `replayPerRecord` nested `updateMany` member** — unchanged from the
   reviewer's claim 3. A member carrying client defaults or transforms may take
   `NestedSelectedRecordSeries.ts:226`'s per-located-row path, which no cell
   reaches.
4. **The complete charged perimeter** — unchanged reason (unit02 §R.6).
5. **The guide's ~40 G1–G3 paragraphs outside this unit's sections** — unchanged;
   the reviewer spot-checked twenty in total.
6. **`scripts/raptor3-cli.test.mjs` and the harness self-tests** — still run by
   no one.
7. **The `r3_<uuid>` database leak (E-1)** — not re-measured; both native
   containers answered every request today, which says nothing about the leak.
