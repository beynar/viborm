# PR #20 — bot comment triage

> **Superseded relation spellings.** This document is a historical record. Its
> relation declarations use the retired six-factory API, and its diagnostics and
> internal type names may name owners that no longer exist. The shipped language
> is two factories, `s.toOne` and `s.toMany`, whose argument states the target
> domain; pairing, foreign-key ownership, uniqueness, junction topology and slot
> emptiness are all derived by one schema-wide resolver. See
> [`./global-relation-cardinality-plan.md`](./global-relation-cardinality-plan.md) for the unified language and
> the deliberate verdict changes it made. The measured history below is
> deliberately not rewritten into a new-API history.

**Evaluated at** `82fb413` (six commits past `f43d71f`), 2026-08-03. Input: the 23 inline
review comments left on PR #20 by `coderabbitai[bot]` (22) and `devin-ai-integration[bot]`
(1). Every claim was checked against the code at that commit, not against the commit the
bot reviewed. Nothing was posted to GitHub.

**The shape of the result.** Twenty-one of the 23 were already answered by commits that
landed after the reviews — most of them by the six between `f43d71f` and `82fb413`, which
were themselves written against this comment set. One was false when it was written. One
was a live defect, and it is the only code change this triage produced.

## Disposition

| # | id | Site | Disposition |
| --- | --- | --- | --- |
| 1 | 3696702682 | `nested-target-parts.ts` — nested `createMany: { data: [] }` crashes | **REJECTED.** False at the reviewed commit too: `buildLiteralParentCreateManyPart` has returned `LiteralParentWriteParts([])` on an empty row list since `d6a7381`. `git show 3c457ab:src/query-engine/write-engine/nested-target-parts.ts` carries the guard at line 890, immediately above the `buildCreateManyPlan` call the comment quotes. |
| 2 | 3696712673 | `capability-matrix-2026-07.md:172`, `compatibility.mdx:40` — stale N6 selector text | ALREADY-ADDRESSED (`05cdf30`). The matrix row states the relation half and names the link selectors as the only strict ones; the mdx splits them out. |
| 3 | 3696712674 | `nested-write-boundaries-plan.md` — four markdownlint findings | ALREADY-ADDRESSED in part / **REJECTED** in part. No MD040 opener without a language remains in the file, and the quoted MD038 span is gone. The MD028 blank line stands: it separates the N7-U-A and N7-U-B update records, which are two dated verdicts; the remedy markdownlint wants would print them as one. No markdownlint runs in this repo's scripts or CI. |
| 4 | 3696712676 | `nested-write-boundaries-plan.md:1526` — obsolete audit-only claim | ALREADY-ADDRESSED. The bot's own thread says so (`9cb32fc`..`47b0847`); the lines now carry the ATOM §4.1 amendment. |
| 5 | 3696712678 | `ATOM.md:311` — fence without a language | ALREADY-ADDRESSED. The mutation-order block is ```` ```text ````. |
| 6 | 3696712679 | `RelationUpsertPart.ts` — guard an `undefined` captured PK | ALREADY-ADDRESSED as a **documented refusal**. `capturedPk`'s doc block states the measured reason: a row with no primary key makes the pin and the write address `pk = <undefined>`, which the unique-`where` builder refuses outright, so the operation already fails closed on both. Adding the check would be a second guard on one invariant — the AGENTS.md ban. |
| 7 | 3696712680 | `shared.ts` — `sameScalarValue` compares bigint/number by string | ALREADY-ADDRESSED (`82fb413`), and the suggested fix declined on a stronger measurement than the bot's. `String()` is lossy well below `1e21` (`String(18014398509481992)` prints `…990`), so the bot's threshold was wrong; the branch is nonetheless unreachable from the public client, because the typed parse boundary refuses a number wherever a bigInt field is addressed and vice versa, in `where` and `data` alike. The note names the one change that would break this and what the compare must become then. |
| 8 | 3696712684 | `pg.test.ts:719` — the two `runBooleanNoOpArmBehavior` pg suites leak drivers | ALREADY-ADDRESSED (`b0eb8db`), at the shared helper rather than per registration. |
| 9 | 3696712687 | `boolean-noop-arm-behavior.ts:177` — suite-level drivers never closed | ALREADY-ADDRESSED (`b0eb8db`): `afterAll` disconnects the client and, when they differ, the subject driver. |
| 10 | 3696712692 | `inverse-to-one-create.test.ts` — a `PGliteDriver` per `construct` call | ALREADY-ADDRESSED. One module-scope engine now serves every construction witness, with the measured cost named: `PGliteDriver` defers `initClient` to the first query, so what the old form actually built fourteen times was the registries, not fourteen databases. |
| 11 | 3696712694 | `inverse-to-one-create.test.ts:228` — the control does not test what the comment claims | ALREADY-ADDRESSED (`2978f8a`): the comment now says the control is a to-ONE `create`, why the to-many claim is not expressible against this fixture, and which test carries the claim instead. |
| 12 | 3696712697 | `located-parent-ref.test.ts` — `runOracleArm` never disconnects `opClient` | ALREADY-ADDRESSED, and the suggested second `$disconnect` declined on measurement: both clients wrap the same `PGlite` instance, and closing it twice raises `ConnectionError` and fails seven oracle scenarios. What was missing was the `finally`, and that is what shipped. |
| 13 | 3696712699 | `own-write-linearization-behavior.ts`, `produced-identity-depth-behavior.ts` — `setup()` leaks on a fixture failure | ALREADY-ADDRESSED in both files: the fixture work is wrapped, `dispose()` runs, the error rethrows. |
| 14 | 3696712702 | `post-transition-adopt.test.ts:187` — unguarded `findIndex` results | ALREADY-ADDRESSED in half, and the other half declined in place: `rootIndex >= 0` is asserted; a second assertion for `adoptIndex` would guard nothing, because `writes[adoptIndex]?.params` on the next line is already unsatisfiable at `-1`. One guard per invariant. |
| 15 | 3696712706 | `produced-identity-provenance.test.ts:259` — `rejects.toThrow()` pins nothing | ALREADY-ADDRESSED: the refusal is matched by its exact message, and the state is asserted empty for both the squad and the drill. |
| 16 | 3699898781 | `query-performance-plan.md:63` — a partial index is not FK-index coverage | ALREADY-ADDRESSED, in code and in the record. `serializer.ts` filters `declaredIndexColumns` through `isTotalIndex`, and the doc carries *"Correction from review — a partial index is not coverage"* (Phase 2 delivery record) which supersedes the Phase 1 prescription the comment quotes. |
| 17 | 3699898789 | `query-performance-plan.md:407` — base the null-placement removal on nullability | ALREADY-ADDRESSED, and the plan text explicitly retracted: the Unit 5.1 delivery record states that the plan's *NOT NULL **and** placement-matches-native* conjunction cannot hold, and that nullability alone decides it. That is what `buildNormalizedOrderBy` implements. |
| 18 | 3699898791 | `query-performance-plan.md:661` — fence without a language | ALREADY-ADDRESSED. No MD040 opener remains in the file. |
| 19 | 3699898795 | `located-parent-ref.test.ts:544` — cleanup skipped when an assertion fails | ALREADY-ADDRESSED: both tests hold their body in `try` and disconnect in `finally`. |
| 20 | 3699898798 | `route-inventory.test.ts:802` — the record contradicts itself | ALREADY-ADDRESSED: the survival is in the past tense (*"survived THAT wave"*), followed by *"It does not survive today — N7-U-C DELETED it"*. One verdict. |
| 21 | 3700286414 | `sqlite/index.ts` — `getCurrentTable` resurrects a dropped foreign key | ALREADY-ADDRESSED (`1a0d79b`): all four index/FK operations are replayed, with the live count (`1, 2, 3` identical FKs over three idempotent pushes) recorded in the plan's second correction from review. |
| 22 | 3700286417 | `serializer.ts` — generated FK index name collides; `uniqueConstraints` read while it grows | **Split.** The name half is ALREADY-ADDRESSED (`3cc4bf8`): the automatic index falls back to `<table>_<cols>_fkey_idx` and yields entirely when the schema holds both names. The ordering half was **live, and is FIXED here** — see below. |
| 23 | 3700286419 | `superseded-index-ordering.test.ts:279` — clients not disconnected on assertion failure | ALREADY-ADDRESSED: `try`/`finally`, with the reason only one `$disconnect` is correct (both clients wrap one driver handle) written down. |

## The one fix — comment 22's second half

The comment asked whether two relations on one model can share foreign-key columns, and
said that if they can, the unique constraints must be collected before the foreign-key
index pass. **They can, and the output diverged.** Measured through `serializeModels` on a
model carrying both a `manyToOne` and a `oneToOne` over `ownerId`:

| Declaration order | `indexes` | `uniqueConstraints` |
| --- | --- | --- |
| `many` then `one` | `child_ownerId_idx(ownerId)` | `child_ownerId_key(ownerId)` |
| `one` then `many` | *(none)* | `child_ownerId_key(ownerId)` |

The coverage scan reads `uniqueConstraints` from inside the relation loop, and the 1:1
branch appends to that same array later in the same loop — so whether the redundant index
was emitted depended on which relation the schema happened to spell first. The consequence
is a duplicate index over a column a unique constraint already covers: write amplification
on every insert, and two snapshots for one schema.

`serializer.ts` now collects the `oneToOne` foreign-key columns in a pre-pass, before the
relation loop, and feeds them to `coveringColumns`. The pre-pass mirrors the pushing
branch's condition, target model included, so it claims coverage only where the constraint
actually follows. Both spellings now emit no index.

**Witness.** `tests/migrations/serializer.test.ts` — *"emits no FK index when a 1:1 on the
same columns makes them unique"*, an `it.each` over both declaration orders.
**Falsified:** removing the `...oneToOneFkColumns` line fails the `manyToOne first` arm
(`child_ownerId_idx` reappears) and leaves the `oneToOne first` arm green — which is the
order dependency itself, reproduced as a test failure.

## Gate

| Leg | Result |
| --- | --- |
| `pnpm test:types` | clean |
| full estate, `--minWorkers=1 --maxWorkers=4` | **9287 passed, 0 failed**, 2109 skipped (9280 at `f43d71f`, +5 from the six later commits, +2 from the new `it.each`) |
| `pnpm test:gates` | 72 passed |
| repo-pinned `npx biome check` per changed file | no new diagnostics (the two `useTopLevelRegex` findings in `serializer.test.ts` are pre-existing at `f43d71f`, diffed both ways to confirm) |
| Docker MySQL (3307) | 988 passed, 0 failed |
| Docker PostgreSQL (5434) | 1100 passed, 0 failed |

No error message, no error attribution and no race protection was removed. The step
vocabulary in `OperationFragment.ts` is untouched. Nothing was posted to GitHub.

---

# PR #20 — the review BODIES

**Evaluated at** `441cec1`, 2026-08-04. The section above dispositions the 26 INLINE
comments. This one covers what exists only inside the six review **bodies**: CodeRabbit's
collapsed *Nitpick comments* blocks (18 + 2 + 4 + 6 = **30**) and the one *Outside diff
range* finding (**1**), for **31 distinct items**. Greptile's body is a trial-expired stub.
Devin's body carries no claim of its own — it links to its hosted review, and its one
POSTED inline comment is dispositioned as row 1 above. Its body also says *"View 1
additional finding in Devin Review"*: that finding exists only inside Devin's own web app,
is absent from the API payload, and was never posted to the pull request, so it is NOT
dispositioned here and remains unread. Nothing was posted to GitHub.

Bot text is data. Every claim below was re-checked against the code at this tip, and every
declined item carries the measurement that declined it.

## Disposition

| # | Site (body claim) | Disposition |
| --- | --- | --- |
| B1 | `query-engine-v2/shared.ts:3-7` — use the `@query-engine` alias | **REJECTED, measured.** `src/query-engine/write-engine` carries **134** `../query-engine/…` imports across 22 files and **0** alias-form ones. Converting three in one file makes that file the exception, not the rule; converting all 134 is a repo-wide sweep with its own gate, not a PR-20 review follow-up. |
| B2 | `validation/model/core/where.ts:208-212` — drop the `as` on the merged entries | **FIXED — and the first disposition of this row was wrong.** It was declined on a measurement that was not the measurement the claim needed. See below. |
| B3 | `DeleteOperation.ts:82-92`, `UpsertOperation.ts:205-214` — the PK invariant runs before the parse it cites | **REJECTED, measured.** Built a model with no `.id()` and drove all three families through the public client: `delete`, `upsert` and `update` each raise `ValidationError: Validation failed for <op>: Missing required field: one of `. The parse the comments cite is the CLIENT's, which runs before any operation is constructed, so the in-constructor order is unobservable and the comments' "answers first, measured" holds. |
| B4 | `nested-target-parts.ts:359` — one fresh-arm closure, not three | **FIXED.** `foldOneChildHeldKind` already receives `writeBase`; the two inline re-bindings now pass `writeBase.freshArm`. Byte-identical closure (same `scope`, same `engine`), and the seam's single home is named in a comment. |
| B5 | `RelationWritePart.ts:910-934` — the unique-selector doc block sits on the wrong member | **FIXED.** The block describing `uniqueSelectorConjuncts` now documents `optionalWhereFilters`, which is the member that calls it; the W4-U3 block stays on `targetFilters`. |
| B6 | `boolean-noop-arm.test.ts:12-30` (+2 files) — three identical `BatchOnlyPGliteDriver` declarations | **REJECTED, measured.** The class is declared **48** times across the test estate (and `RecordingPGliteDriver` 8 times) with an identical body. The bot saw the three inside its diff. Consolidating 3 of 48 leaves the estate less uniform than it is now; consolidating 48 is a separate change with its own gate. |
| B7 | `boolean-noop-arm.test.ts:52-94` (+2 files) — clients released on the success path only | **FIXED in part, REJECTED in part.** The two `boolean-noop-arm` public-client tests released their PGlite instance **never** — not on failure, on every pass — so each run held a live database for the worker's lifetime. Those are wrapped in `try`/`finally` now. The other two sites disconnect as their last statement, which leaks only on a run that is already red; 39 of the 46 `tests/query-engine-v2` files that build a client disconnect it, and rewriting the trailing form estate-wide is not this PR's work. |
| B8 | `depth-seam-behavior.ts:202` — spell `TARGET_NOT_FOUND` in full | **FIXED.** `/Cannot update/` also matched the occupied-slot rejection — the hazard the sibling `depth-seam.test.ts:240` names in its own comment while spelling its matcher out. The matcher now names the two relations the four arms target. **Falsified:** renaming the alternation fails exactly those four arms on the SQLite3 transaction leg and nothing else. |
| B9 | `inverse-to-one-create.test.ts:251-263` — `PARSE_BOUNDARY_REJECTION` too broad | **FIXED.** `/valid\|expected\|boolean/i` cannot separate a parse rejection from an engine route, which is the whole claim of the test. The matcher is the `ValidationError` class now — raised by `parseValidated` and by nothing in the engine — so the day the surface widens (`disconnect`/`delete` become `boolean \| where`, the gap the file names), the test fails instead of passing on the engine's refusal. |
| B10 | `extended-where-unique-behavior.ts:1281` (+3) — assert the class beside the message | **REJECTED.** The message already names the relation *and* the operation (`Cannot update relation 'logins'`), which is a stronger pin than the class; a class assertion beside it is the "belt and suspenders test assertion beside a falsifying pin" AGENTS.md bans by name. The bot also does not know which class it is — it asserts the old one was `ValidationError`, which this refusal is not. |
| B11 | `located-parent-ref.test.ts:23-41` (+3) — PGlite drivers copied across files | **REJECTED** — same measurement as B6 (48 and 8 copies estate-wide). |
| B12 | `boolean-noop-arm-behavior.ts:143-152` — `as any` → `Model<any>` | **REJECTED, measured.** The estate carries **202** `as any` and **259** `as never` in tests; the widening exists because `createClient` / `UpdateOperation` do not accept a heterogeneous fixture schema. The proposed change swaps one assertion for another (`as unknown as Model<any>`) — two assertions where there was one. |
| B13 | `produced-identity-provenance.test.ts:105` — drop the `schema` cast | **REJECTED** — same convention measurement as B12; the indirection is one cast serving three sites, and removing it relocates the assertion rather than removing it. |
| B14 | `produced-identity-race-pin.test.ts:212-219` — `.every()` over a possibly-empty list | **FIXED.** `Array.prototype.every` answers `true` for an empty array, so an update arm that stopped emitting a write satisfied the pin claim without compiling one. The non-empty check names that failure, following the sibling guard at `unique-where-relation-filter-plan.test.ts:304`. |
| B15 | `own-write-linearization.test.ts:73-86` — the `as unknown as RelationInfo` stand-in | **ALREADY-ADDRESSED as a documented refusal.** The two lines above the cast already say why: *"The plan reads relation METADATA only, so a structural stand-in is enough here; building a real `RelationInfo` would add nothing this test asserts."* |
| B16 | `post-transition-adopt-behavior.ts:167-187` (+1) — remove the double assertions | **REJECTED** — same convention measurement as B12. |
| B17 | `update-family.test.ts:367-373` — reuse the `planningEngine` helper | **FIXED.** The local rebuild was identical to the helper; the call site uses it. |
| B18 | `mysql2.test.ts:407-522` — extract a batch-driver factory | **REJECTED.** Cosmetic (no defect either way), and the file is Docker-gated: without a live MySQL on 3307 the whole suite skips, so the edit would ship uncertified by any leg this pass can run. |
| B19 | `UpdateOperation.ts:1009-1016` — guard on `afterRootWrites`, not `afterRootParts` | **REJECTED.** The bot states it itself: *"No current family produces that shape."* The two families that populate `afterRootParts` are T4b's transitioned-PK create leaves (an INSERT) and N5-U1's guarded adopt family (a reparent UPDATE) — each emits a write by construction, so the two conditions are the same condition, and narrowing the check removes a fail-closed assertion for a shape nothing builds. |
| B20 | `staleness-injection.test.ts:940-987` — collapse the two mid-batch runners | **REJECTED.** The collapse trades 15 lines of explicit duplication for a seventh positional parameter with a defaulted schema, on a helper already taking six. `runCompoundUpdateMidBatch`'s JSDoc already names the relationship (`{@link runUpdateMidBatch} against {@link compoundRootSchema}`). No defect either way. |
| B21 | `serializer.ts:206-218` (**outside diff, Major**) — resolve index columns through `getFieldName().sql` | **ALREADY-ADDRESSED.** `serializer.ts` maps `indexDef.fields` through `model["~"].getFieldName(field).sql` and feeds that same list to `declaredIndexColumns`. The bot's own later review (B26) observes the fix in place. |
| B22 | `migrations/utils.ts:183-191` — a unique constraint takes an index name too | **REJECTED, and the attempt is the measurement.** The change was written, witnessed and falsified — then the estate refused it. See below. |
| B23 | `differ.ts:81-88` — make `IndexDef.unique` optional so the normalization is type-visible | **REJECTED, measured.** The value that is `undefined` at runtime arrives as `any`: `model["~"].state.indexes` is untyped, and `indexDef.options.unique.nopeNotAProperty` type-checks clean at the assignment. No change to `IndexDef` makes anything visible at the site that produces the `undefined`; it only drops the requirement that the literal construction sites state `unique` at all. `normalizeIndexUnique` stays load-bearing regardless: migration snapshots are persisted to disk, and one written before the field existed has no key to read. |
| B24 | `fk-index-behavior.ts:226-238` — `as never` on `createClient`/`push` | **REJECTED** — same convention measurement as B12 (259 `as never` estate-wide, 29 of them in the sibling `index-ddl-behavior.ts`). |
| B25 | `fk-index-behavior.ts:520-524` — the negative plan assertions can pass for the wrong reason | **FIXED.** Measured on both legs: the PostgreSQL plan reads `Bitmap Heap Scan on fk_plan_posts t1` and never contains `SCAN t1`; the SQLite plan reads `SEARCH t1 USING INDEX …` and never contains `Seq Scan on …`. One of the two assertions was therefore always vacuous. Each now runs only on its own dialect, and the SQLite alias is read off `included.sql` instead of hard-coded. **Falsified:** pointing the alias regex at a renamed table fails the test on `expect(childAlias).toBeDefined()`. |
| B26 | `serializer.ts:214-224` — build the default index NAME from SQL columns too | **REJECTED**, on the cost the bot itself names: the names round-trip through introspection, so this is cosmetic, and changing them renames every auto-named index on a model that uses `.map()` — a spurious drop+create in the next migration of every such schema. No collision is possible either way: a model cannot hold two fields of the same name, and the name is table-prefixed. |
| B27 | `cursor-condition.ts:177-181` — move `rowValue` into the adapter | **REJECTED.** `(a, b)` is ANSI row-constructor syntax, spelled identically on PostgreSQL, MySQL and SQLite (≥3.15) — three adapter implementations would be three copies of one spelling, the opposite of one home. The second half is answered in `standard-sql.ts`: `subqueries.scalar` is `` sql`(${query})` `` in the ONE shared `createSubqueries`, i.e. a parenthesisation with no single-column contract, and the live cursor-pagination legs on all three dialects are the evidence it admits a row-valued select. |
| B28 | `delete-fold.test.ts:478-584` — close the drivers | **REJECTED** — the B7 line: these drivers are constructed for planning and statement recording, and `PGliteDriver` defers `initClient` to the first query (measured in row 10 above), so a driver that never queries holds no database to close. |
| B29 | `index-ddl-behavior.ts:263-268` — replace `as never` with generics | **REJECTED** — same convention measurement as B12/B24. |
| B30 | `ordering-plan-behavior.ts:112-118` — reduce the client assertions | **REJECTED.** The bot's own text concedes it: *"The sibling behavior suites use the same pattern, so this is a suite-wide convention rather than a defect in this file."* |
| B31 | `DeleteOperation.ts:158-203` — build the locate only when the fold declines | **REJECTED, measured.** The WHOLE `DeleteOperation` constructor — parse, locate, fold, guard — costs **4.7 µs**; one round trip on PGlite, the cheapest substrate in the estate, costs **140 µs**, and the fold removes four of them. The locate `Sql` is a fraction of 4.7 µs against a ~560 µs saving. Paying for it means turning a total `readonly locate: StatementStep` into `… \| undefined`, which `compile()`'s non-fold path then needs either a `!` (banned) or a second existence guard (banned) to read. |

## B2 — a rejection that rested on a measurement nobody took

The row above first read **REJECTED**, on this sentence:

> Deleting the assertion and letting the spread infer produces `TS2322` … The suggested
> remedy — "a helper type alias or a typed local so the compiler checks the merge" — is
> exactly what fails.

Only the first clause was measured. Deleting the assertion outright does raise `TS2322` — but
that is not what the bot asked for, and the second clause was never run. The bot asked for the
merge to be *annotated* rather than *asserted*, and that form compiles.

Seven runs of `npx tsc --noEmit` at `bb8ddcd` — the whole project, `src` + `tests`, which is
EXIT=0 with zero diagnostics unmutated — each one mutation of the merge in
`getWhereUniqueExtendedSchema`:

| Merge written as | Spread | `tsc --noEmit` |
| --- | --- | --- |
| neither annotated nor asserted | both halves | **EXIT=2** — `TS2322` at `where.ts(216,3)` |
| `as Omit<…> & WhereUniqueEntries<…>` (the form that shipped) | both halves | EXIT=0 |
| annotated local (the bot's remedy) | both halves | EXIT=0 |
| `as` form | `...discriminators` dropped | EXIT=0 |
| annotated local | `...discriminators` dropped | EXIT=0 |
| `as` form | `...where.entries` dropped | EXIT=0 |
| annotated local | `...where.entries` dropped | **EXIT=2** — `TS2322` at `where.ts(208,9)` |

The last two rows are the finding. The annotation is **strictly stronger** than the assertion:
dropping the filter half of the merge is a compile error under the annotation and is accepted
in silence under the `as`. Neither form catches dropping the discriminator half — those entries
overwrite `where` entries that are optional there, so the shorter object stays assignable — so
the checking the bot wants is *partial*, not total. Partial at zero cost is still more than the
assertion bought, and the annotated form is already this file's own convention: `discriminators`
five lines above the site, and the sibling `getWhereUniqueSchema`, both build their merge that
way. The `as` was the file's lone exception.

So the merge type is named once, `WhereUniqueExtendedEntries<M, F>`, which
`WhereUniqueExtendedSchema` and the local now both spell; the local is annotated with it. The
emitted JavaScript is unchanged — annotation and assertion both erase.

**Falsified:** dropping `...where.entries` from the annotated local fails `tsc` with `TS2322` at
`where.ts(220,9)`. Under the `as` this file shipped, the same deletion compiled clean.

This is the second time in this pass that a sentence written as a measurement was not the
command that ran (`a221a14` certified a Biome leg it had not re-run). The rule holds either
way: if a row says *measured*, the measurement in it is the one that was executed.

## B22 — written, then refused by the estate

The bot's premise is that a unique constraint is an index under its own name, so a batch
that drops index `X` and adds constraint `X` must free the name first.
`supersededIndexDrops` builds its "keeps the early slot" set from `createIndex` alone, and
**the order it produces for that pair is indeed add-then-drop** — reproduced through
`sortOperations` at `441cec1`:

| Batch | Order |
| --- | --- |
| `dropIndex(posts_slug_key)` + `addUniqueConstraint(posts_slug_key)` | `addUniqueConstraint`, `dropIndex` |

So the premise's first half checks out. The fix — `addUniqueConstraint` contributing its
constraint name to the same set — was implemented, given a witness in
`superseded-index-ordering.test.ts`, and falsified (removing the branch failed that test
and only that test: 1 failed, 11 passed).

**Then the driver legs failed it.** `tests/migrations/sqlite-unique-constraint.test.ts` —
*"heals a database the old standalone-index add wrote"* — pins the OPPOSITE order, and says
why two lines above the assertion:

> The add rebuilds the table with the constraint inline; the stale index is re-created by
> the rebuild and then dropped by the same batch.

On SQLite `addUniqueConstraint` is a **table recreation**. It drops the table (taking the
stale standalone index with it), rebuilds it with the constraint inline, and step 6 of the
recreation re-creates every index still in the introspected definition — the stale one
included. The same-name `dropIndex` is what removes it, and it can only do that AFTER the
rebuild has put it back. Freeing the name first, as the bot asks, leaves the recreation to
resurrect the index with nothing left to remove it, and the healing push stops converging:

```text
expected [ 'dropIndex', 'addUniqueConstraint' ] to deeply equal
         [ 'addUniqueConstraint', 'dropIndex' ]
```

The hazard is therefore **not dialect-blind**, and `sortOperations` has no dialect to be
blind with — it is one comparator shared by all three migration drivers. On SQLite the add
frees and retakes the name itself, and the ordering the bot calls a bug is the ordering
that heals. Against that, the MySQL 1061 / Postgres 42P07 half is unreproduced: the
collision the SQLite driver's `generateAddUniqueConstraint` doc block records was closed at
the other end (shape matching, so the misfiling never happens), and no live push on either
dialect was made to fail.

**Disposition: not fixed, and now on the record.** Closing it needs a dialect-aware
ordering seam — a design change with its own measurement, not a set-membership edit.
`src/migrations/utils.ts` is unchanged by this pass.

## Gate

| Leg | Result |
| --- | --- |
| `pnpm test:types` (tsc 5.9.3) | clean |
| `pnpm test:gates` | **72 passed** (5 files) |
| `tests/query-engine-v2` (63 files) | **1163 passed, 0 failed** |
| `tests/migrations` + sqlite3 + pglite + libsql driver legs (17 files) | **3435 passed, 0 failed** — the single failure in the first run is the B22 attempt above, and it is what reverted it |
| repo-pinned `npx biome check` (2.3.11), per changed file | no new diagnostics — **this row was wrong when written; see the correction below** |

**Correction (`ceaf0b9`).** The Biome row above was written without the check having been
re-run on `tests/query-engine-v2/boolean-noop-arm.test.ts` after that file was re-indented.
The try/finally wrapper `a221a14` added moved the `item.create` call four columns right,
past the 80-column print width, and repo-pinned biome 2.3.11 wanted it split across three
lines: `npx biome check` on that file reports `Formatter would have printed the following
content` at `a221a14` and is clean at `441cec1`, so the diagnostic is one this pass
introduced, not one it inherited. `ceaf0b9` re-wraps the call — formatting only, no
assertion or value moved — after which the check is clean on all eight TypeScript files
this branch changes, and the file still passes 38/38 with `test:gates` at 72/72.

No error message, no error attribution and no race protection was removed. The step
vocabulary in `OperationFragment.ts` is untouched. Nothing was posted to GitHub.
