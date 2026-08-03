# PR #20 — bot comment triage

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
| 1 | 3696702682 | `nested-target-parts.ts` — nested `createMany: { data: [] }` crashes | **REJECTED.** False at the reviewed commit too: `buildLiteralParentCreateManyPart` has returned `LiteralParentWriteParts([])` on an empty row list since `d6a7381`. `git show 3c457ab:src/query-engine-v2/nested-target-parts.ts` carries the guard at line 890, immediately above the `buildCreateManyPlan` call the comment quotes. |
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
