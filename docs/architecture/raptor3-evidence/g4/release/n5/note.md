# Release unit "N5" — the rest of the gate (note)

Integrator: Fable, in the worktree `/private/tmp/viborm-n5` on branch `n5` from
`96ae14d7f` (N4). Plan §5 of `docs/architecture/raptor3-nesting-and-refusals-plan.md`.
Three waves of Opus groups, tests-only first, then the mechanisms at their
owners with disjoint file ownership, then two single owners for the facts that
span files; the integrator merging, registering the pins, applying the
test-side hunks the groups could not (each named below) and re-measuring.
Briefs, the groups' structured reports (verbatim JSON) and the cell
inventories are under `receipts/`.

## 1. The truth

The gate — `pnpm test:all` end to end — runs the retired engine's PGlite
contract suites against the shipped engine. After N1 it had 99 red cells in
25 files (`receipts/red-cells.md`), classified by the gate triage
(`g4/release/gate/`): a cell that pins a RETIRED physical detail (A), a
registered refusal that now answers where the retired engine executed
(B, ruled), a MECHANISM defect at an owner in `src/` (C), or a retired
internal's name (D). The unit's rule for every cell was the N1 discipline:
derive the answer from the contract and the rulings BEFORE measuring; a
measured state that contradicts the derivation is the defect, never a new
expectation. A and B and D cells are re-expressed with the ruling named at the
cell; a C cell goes green by its repair alone, and only where the derivation
says the recorded expectation itself changed is a contract file edited.

**Wave 1 (tests only, four groups by triage family).** 52 of the 99 cells
re-expressed with the ruling named (D-15 and §7.2's `q0` alias for the plans,
G3P-04 and D-46 for the ruled refusals, D-50 / D-52 for the retired
polymorphic `set` sentence, D-51 for the width-overlap oracle, the retired
internals' names), 47 left red: 45 class-C cells with their mechanism and
owner named (`receipts/owners-w2.md`), the runner-only CS-02 measure and one
G3P-04 cell whose body lives in a shared behaviour module — both closed by
the integrator's test-side hunks in wave 2 (54 re-expressed in all).

**Wave 2a (four owners with disjoint src files).** Fourteen mechanisms at their owners, 39 gate cells closed by repair alone (no contract file edited for them), six pins red at the base: `operation-context.ts` — one captured pair is one slot transition (`link` vacates once, both routes), the attribution ladder skips the premise it cannot re-probe, a member's boundary is taken by the OBSERVING member exactly where a later member must see an earlier member's effect (`OperationContext.answer` with `TransportAttempt.holdsOtherMemberWrite`, the repair round's form; `executeMember` only defers the packaging boundary while an enclosing write waits — a nested `createMany` of literals rides its parent's segment and a duplicate key rolls the operation back on the batch route as on the interactive one); `execution.ts` — a skipped INSERT is not a skipped membership and the adopted row is LOCATED by what the payload spells, generated keys included (`adoptSuppressed` / `locateSuppressed`, 8 cells), and a target whose membership is stored once cannot be handed to several rows an `updateMany` captured (`exclusiveMemberMove` restates V1's two registered sentences where the captured count is first known — not ahead of every write: on the batch route a capture's flush has already committed an enclosing parent's own segment, so the two routes answer alike and differ only in what stands committed behind the refusal (D-51's succession, pinned by the repair round's new cell) — 7 cells and the public-client crash); `commands/` — a parent-held `connect` carries its target's presence into the write (`lookup.retained`), a correlated arm locates its target by the parent's FINAL value and restates the parent's assignment (`Assignments.restate`, `correlationParent`), a membership asks whether the producer's create SUPPLIES the referenced field (`writesField`), 7 cells; tooling — the runner-only CS-02 measure excluded from the credential-free lists at the one list that owns it, the width-overlap and series-choice recipes re-expressed to D-51's executed end state (the measure verified in its instrumentation-patched environment, 28 cases / 60 replays). Two mechanisms were blocked on facts outside a group's file and passed to wave 2c with exact hunks; one repair turned a Raptor-3-era pin red for the right reason (`lane-x-set-mutations`, re-expressed by the integrator with a sibling cell for the half still true) and one made the generated transport corpus's script a stale model (passed to wave 2c).

**Wave 2b (one owner across `commands/`).** The shared-primary-key transition's published key — the N3c class the plan's §5 named "six cells, one owner": a correlated arm's value is one its parent HOLDS (`Assignments.hold` / `moved`, `assignMembership`'s binding), the observation the operation holds of the row is re-addressed once every `before` child has run (`CommandExecution.run`), every member of a compound key published; PLACEMENT, not verb, decides which key a correlated lookup names (`RelationBody.correlationParent`: `edge.owner !== "source" || verb === "update"` where a verb-specific branch stood since `b2daea115`); a membership read through a field an arm already moved is an ordered observation (`readMembership`'s publication branch). All 13 shared-PK cells and the legality transition-arm cell green on every substrate, no test edited; pin `published-key` (10 cells as wave 2b landed it, 12 after the repair round; 6 red at the base). Net +40 code lines, 22 of them replacing a duplicated sentence built once.

**Wave 2c (one owner across `execution.ts`, `operation-context.ts`,
`query.ts`).** The residuals whose facts span files, plus a regression wave 2a introduced: the ladder's skip is the FACT (a premise stated over the batch reference scratch this unit produced, `AssertedPremise.readsBatchReference`), not a position — wave 2a's positional skip had turned an N1 cell red; the value a parent-held `connect` writes is read where it is spent (`Queries.locatedValue`, a scalar sub-select bound by `CommandExecution.folded`); a located target whose referenced field is NULL refuses by name before any write (a parent-held `connect`, the only folded arm after the repair round); a created member re-pins its parent in every later segment, declared at the INSERT (`Continuation.declaring`, `membershipParent`); a `dateTime` or `date` identity captured from a row crosses the admission boundary again (`admittedTemporal`) — the N4-recorded defect, measured over every key domain first; a probe's malformed-scalar decode names the operation's own verb (a class-A/D re-expression, not a `failure()` repair: the engine keeps one operation identity per client call); and the generated transport corpus's script re-derived from the packaging rule (`repeatedRecurrenceReplies` deleted, 400 seeded recipes replayed). Every cell on its list closed; pin `captured-identity-domains` (6 cells, 3 red at the base).

**The census.** N5 adds no public sentence: 23 public / 21 invariant / 11 internal / 72 registered / 190 sites on the final tree (`census.md`), from N4's 23 / 21 / 11 / 71 / 188 — the two sentences N5 re-added (V1's exclusive-member refusal and the located-NULL refusal) are registered, not public — the located-NULL sentence by the census (it matches the shipped corpus), the exclusive-member pair by the corpus itself (`0cc61e61f:src/query-engine/relation-key-legality.ts:145`, `:149`), because the census reads no sentence that is built into a variable and thrown through `ctx.failure` (a blind spot recorded as open below) — and Arnaud's D-55 to D-57 (recorded in the ledger) keep #16 and #13 and execute #26 / #33 in a later unit.

## 2. Per mechanism

| wave | owner | the fact | pin (red at the base) | cells closed |
|---|---|---|---|---|

| 2a opctx | `src/query-engine/raptor3/shared/operation-context.ts` | ONE captured pair is ONE slot transition | tests/raptor3/g4/parity/singular-slot-transition.test.ts | 1 |
| 2a opctx | `src/query-engine/raptor3/shared/operation-context.ts` | A premise stated BEHIND the unit's own writes is NOT re-probable after the rollback (the guide, AGENTS.md:1051-1058: "At the ladder, a premise stated BEHIND the unit's own writes … is not re-probable after the rollback; when every | tests/raptor3/g4/parity/blind-premise-attribution.test.ts | 1 |
| 2a opctx | `src/query-engine/raptor3/shared/operation-context.ts` | A member's boundary is the MEMBER's, and a dispatch commits the WHOLE queue | tests/raptor3/g4/parity/member-boundary-packaging.test.ts | 1 |
| 2a opctx | `BLOCKED` | A generated-output continuation re-pins only the created record's own identity; nothing re-pins the PARENT row whose referenced value the continuation's membership correlates BY VALUE, so on a batch-only driver with supportsOrdere | NONE | 0 |
| 2a opctx | `BLOCKED` | A malformed-scalar decode is attributed to the ENCLOSING operation instead of to the statement whose row failed to decode: a planning probe's typed-parse failure reads `… for operation "update"` where the derived answer is `Driver | NONE | 0 |
| 2a exec | `src/query-engine/raptor3/commands/execution.ts` | A skipped INSERT suppresses the ROW, not the membership: the membership the member declared is written against the row its payload NAMES, and that row is LOCATED, never assumed | tests/raptor3/g4/parity/suppressed-membership-target.test.ts | 8 |
| 2a exec | `src/query-engine/raptor3/commands/execution.ts` | A target whose membership is stored ONCE — a junction row unique on the target side (`edge.uniqueSide === 'target'`, which only a variant-junction carrier arm can be: FK004 makes an ordinary to-one/to-many pair a foreign key), or  | tests/raptor3/g4/parity/exclusive-member-cardinality.test.ts | 7 |
| 2a exec | `tests/contracts/engine/write/junction-produced-identity-behavior.ts` | G3P-04: root-conflict suppression is admitted only where the operation owns the member rollback region, and the batch route owns none, so a borrowed `createMany skipDuplicates` is refused in the command analysis pass, before the e | the gate cell it closes | 1 |
| 2a cmds | `src/query-engine/raptor3/commands/relation-body.ts` | A `connect` whose located value the PARENT's own SET spends carries that row's presence into the write: the premise is proved inside the atomic unit that carries the write it protects (D-29), so a target that vanishes between the  | tests/raptor3/g4/parity/correlated-membership.test.ts > N5 | 1 |
| 2a cmds | `src/query-engine/raptor3/commands/relation-body.ts` | A correlated arm (a nested `update` or `upsert` under an updating parent) locates its target by the parent's FINAL membership value — "the parent's FK value is its FINAL value", the delegated fold's pinned semantics (M1, tests/con | tests/raptor3/g4/parity/correlated-membership.test.ts > N5 | 2 |
| 2a cmds | `src/query-engine/raptor3/commands/commands.ts` | A membership asks whether the producer's create SUPPLIES the referenced field, never whether its value is a construction-time literal | tests/raptor3/g4/parity/correlated-membership.test.ts > N5 | 4 |
| 2a tooling | `scripts/credential-free-test-manifest.mjs` | One list owns "runner-only": `scripts/raptor3-manifest.mjs` `CS02_STRUCTURE_MEASUREMENT_TESTS` (:315-319), spread into `RAPTOR3_RUNNER_ONLY_TESTS` (:1435) | The gate cell it closes, plus the manifest's own falsifier run with a backup copy | 1 |
| 2a tooling | `src/query-engine/raptor3/commands/commands.ts `analyze` / `analyzeSeries`, UNDER the sealed instrumentation` | The root's occurrence, write and `attempt/0/unconditional` activation are bound by the instrumented `analyze`, which reads `hooks.identities.commandId(root)` — the root COMMAND the harness binds in `bindCreateTree`/`bindOverlapTre | The gate cell, run in its intended environment | 1 |
| 2a tooling | `tests/raptor3/core-structure/measurement/structural-recipes.ts `overlapRecipe`` | D-51 (AGENTS.md "A dependent read is an ordered observation (N1, D-51)"): the readers' membership lookups are nested lookups an earlier write of the same operation can change, so each is taken at its consumer's execution point, be | The gate cell itself, run in its intended runner-only environment. Proving command | 1 |
| 2a tooling | `FOUND, DERIVED AND VERIFIED BUT NOT LANDED` | The same D-51 ruling kills the 16 `series-choice` cases too, a fourth cause no triage saw (it was hidden behind causes 1 and 2, which abort earlier, and neither wave-1 agent had the patched environment) | The gate cell in its runner-only mode. Proving command, run on the isolated patched copy w | 0 |
| 2b | `src/query-engine/raptor3/commands/commands.ts:488 assignMembership` | A membership value is HELD by the row that carries it when it rides on the arm's own write: a CORRELATED arm's target is the row this row's membership already names, so a write of the referenced key moves this row with it (ON UPDA | tests/raptor3/g4/parity/published-key.test.ts | 5 |
| 2b | `src/query-engine/raptor3/commands/relation-body.ts:1151 RelationBody.correlationParent` | PLACEMENT, not verb, decides which key a correlated arm's lookup names | tests/raptor3/g4/parity/published-key.test.ts > "a child-held arm placed after the parent' | 1 |
| 2b | `src/query-engine/raptor3/commands/commands.ts:770-780 readMembership` | A membership read THROUGH a field an earlier arm already MOVED on this parent is an ordered observation of that arm's write (N1): the arm's target update carried this row's own foreign key with it, so the key the read was planned  | tests/raptor3/g4/parity/published-key.test.ts > "a before-child's transition publishes the | 1 |
| 2c | `src/query-engine/raptor3/shared/operation-context.ts` | REGRESSION REPAIR (item G) | tests/raptor3/g4/parity/ordered-observation.test.ts | 3 |
| 2c | `src/query-engine/raptor3/shared/query.ts `Queries.locatedValue`` | Item B, cmds requested change 1 | tests/contracts/engine/write/parent-held-lookup.test.ts > E1 U1 | 1 |
| 2c | `src/query-engine/raptor3/commands/execution.ts `CommandExecution.folded`` | Item C, cmds requested change 2 | tests/contracts/engine/write/parent-held-lookup.test.ts | 2 |
| 2c | `NO src OWNER` | Item D, opctx mechanism 5 | the gate cell itself | 1 |
| 2c | `src/query-engine/raptor3/shared/query.ts` | Item E, owners-from-n4 item 1 | tests/raptor3/g4/parity/captured-identity-domains.test.ts | 1 |
| 2c | `src/query-engine/raptor3/shared/operation-context.ts `insert`` | Item A, opctx requested change 2 / mechanism 4 | tests/contracts/engine/write/supplier-continuation.test.ts | 2 |
| 2c | `tests/raptor3/g3/generation/transport-plans.ts` | Item F | tests/raptor3/g3/generation/generated-transport-smoke.test.ts | 1 |

| repair | src/query-engine/raptor3/shared/operation-context.ts + shared/transport-attempt.ts | T1 (major, transport finding 1): Repaired at one owner (OperationContext) | tests/raptor3/g4/parity/member-boundary-packaging.test.ts | 2 |
| repair | tests/raptor3/g4/parity/member-boundary-packaging.test.ts | T7 (minor, transport finding 7): Re-expressed as the reviewer asked: the control's parent now writes a scalar of its own, and a third cell uses a create whose parent row is itself the pending write | same file; cells at  | 2 |
| repair | src/query-engine/raptor3/shared/operation-context.ts | T2 (major, transport finding 2): Repaired at one owner | tests/raptor3/g4/parity/singular-slot-transition.test.ts | 4 |
| repair | src/query-engine/raptor3/shared/query.ts | T3 (major, transport finding 3): Option (b): claim narrowed, residual recorded and PINNED | tests/raptor3/g4/parity/captured-identity-domains.test.ts | 3 |
| repair | src/query-engine/raptor3/shared/operation-context.ts | C2 (major, contracts finding 2): Repaired entirely at my owner; NO hunk is needed in membershipParent or anywhere else in the other owner's files | tests/raptor3/g2-transport.test.ts (unmodified | 5 |
| repair | src/query-engine/raptor3/shared/operation-context.ts | T5 (minor, transport finding 5): Derived the same way, at ONE owner | none added | 0 |
| repair | tests/raptor3/g4/parity/blind-premise-attribution.test.ts | T4 (minor, transport finding 4): Header rewritten to the shipped fact: the ladder skips exactly the premise that binds the batch reference scratch (AssertedPremise.readsBatchReference) and re-probes every other one wherever it … | the file itself; 1/1 per project, unchanged | 0 |
| repair | src/query-engine/raptor3/shared/query.ts | M6 (minor, commands finding 6): Repaired by hand (no formatter run on any file) | the reviewer's own recipe | 0 |
| repair | src/query-engine/raptor3/commands/execution.ts CommandExecution.folded | M1 (major, commands finding 1 = contracts finding 1): REPAIRED AT OWNER — folded scoped to the arm the shipped sentences already name: a connect on a parent-held reference | tests/raptor3/transport.test.ts (G1 explicit transport replies | 5 |
| repair | tests/raptor3/core-structure/measurement/extension-a-scenario.ts — afterStatement's … | M2 (major, commands finding 2 / contracts finding 2): RE-EXPRESSED WITH THE RULING NAMED (D-51), in the scenario recognizer — the extra premise IS the derived answer | tests/raptor3/core-structure/measurement/extension-campaign.selftest.test.ts > … | 1 |
| repair | src/query-engine/raptor3/commands/assignments.ts | M3 (major, commands finding 3): REPAIRED AT OWNER — the hold now carries its HOLDER and moved() takes the run-time question as an argument | tests/raptor3/g4/parity/published-key.test.ts > a correlated arm that took its … | 2 |
| repair | src/query-engine/raptor3/commands/execution.ts exclusiveMemberMove's doc | M4 (major, commands finding 4): NARROWED CLAIM (no mechanism change) + NEW CELL | tests/raptor3/g4/parity/exclusive-member-cardinality.test.ts > an enclosing … | 2 |

The rows are the groups' own words, shortened; their full reports (fact,
hunk, pin, base result, cells) are `receipts/w2a-results.json`,
`receipts/w2b-results.json`, `receipts/w2c-results.json` and, for the repair
round the review demanded (§7), `receipts/repair-results.json`.

## 3. Re-expressed expectations (wave 1, the ruling named at each cell)


- `tests/contracts/engine/write/combined-depth-stress.test.ts` — 1 cell(s), class B-ruled, ruling G3P-04.
- `tests/contracts/engine/write/compound-junction.test.ts` — 2 cell(s), class B-ruled, ruling G3P-04.
- `tests/contracts/engine/write/create-many-skip-depth.test.ts` — 2 cell(s), class B-ruled, ruling G3P-04.
- `tests/contracts/engine/write/nested-create-context-grandchild.test.ts` — 1 cell(s), class B-ruled, ruling G3P-04.
- `tests/contracts/engine/write/polymorphic-collection-write-family.test.ts` — 3 cell(s), class A/B-ruled, ruling G3P-04 and D-50 / D-52 (the retired `set requires one atomic unit` sentence Raptor 3 does not register).
- `tests/contracts/public-client/batch-transaction.test.ts` — 3 cell(s), class B-ruled, ruling D-46.
- `tests/contracts/engine/query/nested-write-conformance-root-dependency.test.ts` — 2 cell(s), class B-ruled, ruling D-51.
- `tests/contracts/engine/write/junction-produced-identity.test.ts` (cell defined in `junction-produced-identity-behavior.ts:339`) — 1 cell(s), class B-ruled, ruling G3P-04.
- `tests/contracts/engine/write/supplier-continuation.test.ts` — 1 cell(s), class D, ruling D.
- `tests/contracts/engine/write/nested-semantic-stability.test.ts` — 2 cell(s), class D, ruling D, D-51.
- `tests/contracts/engine/write/nested-error-attribution.test.ts` — 1 cell(s), class D, ruling D-15.
- `tests/contracts/engine/write/parent-held-lookup.test.ts (cell defined in parent-held-lookup-behavior.ts:612)` — 2 cell(s), class D, ruling D.
- `tests/contracts/engine/write/parent-held-lookup.test.ts` — 1 cell(s), class D, ruling D.
- `tests/contracts/engine/write/inverse-to-one-update-depth.test.ts` — 2 cell(s), class D, ruling D.
- `tests/contracts/engine/write/mutation-projection-cte-fold.test.ts` — 16 cell(s), class A, ruling D-15.
- `tests/contracts/engine/write/progressive-parent-rowkey.test.ts` — 7 cell(s), class A, ruling D, D-51, §7.2.
- `tests/contracts/engine/query/starts-with-prefix-plan.test.ts` — 5 cell(s), class A, ruling D, §7.2.
- `tests/unit/instrumentation/namespace-attribute-segment.test.ts` — 1 cell(s), class D, ruling D-15.
- `tests/raptor3/core-structure/measurement/cs02-structure-measure.test.ts` — 1 cell(s), class D, ruling D.

Plus the integrator's test-side hunks the groups requested (each verbatim from
its report): `tests/raptor3/g3/generation/transport-plans.ts` (the fanout
members ride the root chain's segment — the opctx group's `fanout > 0` delegation first, then wave 2c's derivation, which deleted `repeatedRecurrenceReplies` altogether),
`tests/raptor3/g4/parity/lane-x-set-mutations.test.ts` (a suppressed member
that declares a nested record write strands whole, join included; a sibling
cell keeps the half that is still true), the repair round's
`tests/raptor3/core-structure/measurement/extension-a-scenario.ts` (the CS-03
A statement recognizer: a child-held correlated `upsert`'s batch premise is
not the choice's locate — D-51, one cell, the commands owner's derivation in
`receipts/repair-results.json`), the tooling group's series-choice
D-51 patch (`structural-recipes.ts`, `cs02-structure-measure.test.ts`,
`measurement-selftest.test.ts`), `junction-produced-identity-behavior.ts`
(G3P-04 on the atomic-batch leg, applied by the exec group for the legality
group), and `scripts/raptor3-campaign-receipts.test.mjs` (the runner-only
CS-02 measure in neither credential-free list). No test was deleted, skipped
or weakened.

## 4. Hunks

`git diff --numstat 96ae14d7f` on the final tree, production first:

| file | +/− | what |
|---|---|---|
| `shared/operation-context.ts` | +268 / −37 | `link` vacates once (`spendSlot`, a value tree); `statePremise` + `readsBatchReference` (derived for guards too); the ladder's skip; the member boundary taken by the observing member (`answer`, `executingMember`) and deferred, never dropped, by `executeMember`; `Continuation` / `MembershipParent`, the parent premise at the INSERT; the progress gates ask for a committed prefix |
| `commands/execution.ts` | +276 / −25 | `adoptSuppressed` / `locateSuppressed`; `exclusiveMemberMove`; `folded` (the located value and the located-NULL refusal, scoped to a parent-held `connect`); `membershipParent`; the re-addressed observation, arm-conditional (`carried`) |
| `commands/relation-body.ts` | +109 / −19 | `lookup.retained` for a parent-held connect; the correlated arm's `correlation` + `correlationParent` (placement) |
| `commands/commands.ts` | +77 / −23 | `assignMembership`: `writesField`, the hold vs contribute binding; `readMembership`'s publication branch; the `dependency` sentence built once |
| `shared/query.ts` | +86 / −4 | `locatedValue`; `admittedTemporal` and the two temporal arms (the claim narrowed to what is measured) |
| `commands/assignments.ts` | +58 / −0 | `restate`; `hold` / `moved(holder)` / `movesField` |
| `shared/transport-attempt.ts` | +40 / −2 | `holdsWrite`, `holdsOtherMemberWrite`; `AssertedPremise.readsBatchReference` |
| `AGENTS.md` | +123 / −11 | the N5 paragraph, the ladder's fact, the suppressed-INSERT paragraph corrected, the fold gate's spelling |
| `scripts/raptor3-manifest.mjs` | +8 | the eight pins registered |
| `scripts/credential-free-test-manifest.mjs`, `raptor3-campaign-receipts.test.mjs` | +8, +2 | the runner-only CS-02 measure in neither credential-free list, and its standing pin |
| tests, new | +2,123 | eight pins under `tests/raptor3/g4/parity/` (63 cells after the repair round) |
| tests, modified | +1,324 / −605 | 19 contract files re-expressed (wave 1), 4 measurement files (D-51), the transport-plan model, 2 behaviour modules, `lane-x-set-mutations` |

Engine code lines (non-blank, non-comment, `src/query-engine/raptor3`): 11,683 at
N4 → **12,041**, +358 for fourteen repaired mechanisms, two re-added
registered refusals and the repair round — the groups' own accounting: opctx
≈ +60 code, exec ≈ +110 (`locateSuppressed` and the cardinality refusal),
cmds ≈ +35, 2b +40 net (22 of them a duplicated sentence built once), 2c
≈ +150 (`folded` 36, `membershipParent` 33, `locatedValue` 36,
`admittedTemporal` 31, the continuation's parent premise 26), the repair
round +46 (the observing member's boundary and the slot tree +26, `carried`
and the arm-conditional hold +20). The module's seven `.ts` files carry +914
raw added lines against −110 deleted; the difference from the code count is
the doc comments that name each fact's owner. Biome per production file
identical to its `96ae14d7f` copy (every group checked its files three ways;
the formatter was never run on a file whose base copy carries a `format`
diagnostic).

## 5. Verification

The whole estate was measured twice: once on the tree the review read
(`scratchpad n5/estate-r1/`: every shard, PGlite stage, provider stage, mode
and the core suite green, the 99 gate cells closed, but the fixed lane
831 / 836 and the query-engine-core coverage lane red on four unmodified
transport files — the review's BLOCK, §7), and again on the repaired tree,
which is the run the table reports.

| run | result |
|---|---|
| `node scripts/run-typecheck.mjs` (whole estate) | 0 diagnostics |
| `pnpm test:all --only "Raptor 3 fixed"` | 850 / 850 (787 + the 63 new deterministic pin cells) |
| the eight pins (`tests/raptor3/g4/parity/`, new) | 63 / 63 inside the fixed lane (the durable-state cell and `blind-premise-attribution` also run alone, three times, green) |
| the 25 contract files of the gate (14 ordinary shards, 8 shared-family shards, 2 imported-PGlite shards) | all 24 stages exit 0, 2,193 cells passed, 393 skipped (the provider-gated files, by name), none failed (`scratchpad n5/estate/`) |
| the extended-local estate vs the N1 head, by cell identity and message (`compare-cells.py`) | **99 failing cells → 0: 99 newly green, 0 newly red, 0 moved** (14 ordinary shards, 8 shared-family shards, 2 imported-PGlite shards, the provider stage) |
| `node scripts/run-raptor3.mjs g1-compare`, `g2-baseline`, `g2-contracts`, `g3-transaction-array`, `g3-generated-transport-smoke` | gate verified, 216 / 216, 216 / 216, 4 / 4, gate verified |
| `pnpm test:core` | 8,434 / 8,434 |
| coverage floors (`test:coverage:query-engine-core`, `:policy`) | 88.09 / 91.81 / 90.82 / 88.09, policy lane green (floors 87 / 91 / 90 / 87; N4: 87.81 / 91.37 / 90.54 / 87.81) — the estate script's own coverage stages met the runner's lock while a reviewer's vitest held it and were re-run alone |
| the runner-only CS-02 measure in its instrumentation-patched environment (`node scripts/run-raptor3.mjs cs02-structure-measure` on the tooling group's isolated copy) | verified — 28 cases, 60 replays, 0 skipped, `qualifying: true` (`receipts/integrator-verify-a.txt`) |
| the census (`census.md`) | 23 public / 21 invariant / 11 internal / 72 registered / 190 sites, the public set identical to N4's |

Falsification, per mechanism, is in each group's report (`receipts/w2a-results.json`,
`w2b-results.json`, `w2c-results.json`, and the repair round's
`repair-results.json`): every pin red at the base or without the fact it
pins, by the backup-copy recipe, and the reviewers' own falsifications in
`review1-results.json`.

## 6. Still red, unverified, blockers, open for Arnaud

**Rulings received during the unit (Arnaud, 2026-09-21).** D-55 keeps #16, D-56
keeps #13, D-57 executes #26 / #33 as one unit after the D-53 transport
witnesses (the ledger's record). N4's open question on #16 / #13 is closed.

**Open for Arnaud.** The refusal census reads no sentence that is built into a variable and thrown through `ctx.failure` (`exclusiveMemberMove`'s two sentences are counted as a rethrow at `execution.ts`); the tool's next extension is to follow the argument of `ctx.failure` / `failure()` to its construction, so a public sentence at such a site cannot slip in unread. `tests/raptor3/core-structure/measurement/extension-campaign.selftest.test.ts`
sits in both `RAPTOR3_RUNNER_ONLY_TESTS` and `RAPTOR3_FIXED_LOCAL_TESTS`, so
"runner-only implies in neither credential-free list" is not an invariant the
manifest holds today (the tooling group left it alone; the new standing pin
covers the CS-02 measure only). `tests/raptor3/core-structure/measurement/reference-instrumentation.patch`
is stale (21 of 29 hunks no longer apply; the live instrumentation is
`docs/architecture/raptor3-evidence/g4/qualified/structure/instrumentation.patch`).
The premise segment's linear growth (N4 §6) is untouched; nothing measured
reached a transport's per-request limit.

**Unverified — the repair round's residuals.** A member boundary claimed at
an observation makes the enclosing record's own write and the earlier members'
writes durable, so an observing series that fails AFTER its observation leaves
a committed prefix on the batch route where the interactive route rolls the
whole operation back (the round-2 review's measurement: `board.create` with an
observing `createMany` whose third row duplicates the first — interactive
nothing written, batch-only the board, the first post and the author durable);
D-51's "one result" holds for the answer, not for what stands committed behind
it, and the pin now carries that cell for both routes. After the `folded`
narrowing the located-NULL refusal covers only the arm the sentences name — a
parent-held `connect`; a parent-held `connectOrCreate` whose FOUND row's
referenced column reads NULL writes that NULL and disconnects the holder, the
pre-N5 behaviour, with no cell. `readsBatchReference` derived for continuation
guards answers `false` in every measured case (no cell distinguishes the
derivation from the assertion it replaced). The arm-conditional hold's cell
reaches its shape on SQLite with `foreign_keys` off; no provider without
foreign keys was run. The derivation that `exclusiveMemberMove` cannot be
stated ahead of the parent's write is argued from the published-key fact, not
measured. The `blind-premise-attribution` pin answered `QueryError` twice during
the round-2 review while a second vitest process (the estate's coverage lane)
ran in the same worktree — the one-process-at-a-time rule the runner's lock
enforces, which the reviewer's retry wrapper had stepped around — and green on
every run since, alone; recorded, not repaired.

**Unverified.** On a TEXT-stored `dateTime` key, a payload spelled with a UTC offset or with fewer than three fractional digits is kept byte for byte by the adapter and is still NOT addressable from a capture, which re-binds `toISOString`'s spelling (review 1, transport finding 3): measured and pinned as a residual in `tests/raptor3/g4/parity/captured-identity-domains.test.ts`, NOT repaired — capturing identities undecoded would move the spelling's owner and reaches `commands/{commands,selection,execution}.ts`, outside the owner this repair had. No MySQL or Docker `pg` lane was run: `Queries.locatedValue`'s
derived-table wrap (MySQL ERROR 1093) is derived from `hideMutationTarget`'s
one condition and exercised only on its false branch; the `date` identity
repair is measured on SQLite only (PostgreSQL and MySQL bind the same
`YYYY-MM-DD` the payload path binds); the `*-docker.test.ts` twins of the
shared-PK and skip-duplicates families are unmeasured. The seeded transport
campaign was replayed for 400 of its 10,000 seeds (batches 8000–8300). The
exec group dropped V1's "unnameable unique index dominates" suppression of the
adopt route because existence subsumes the two cells that exercised it; no
cell measures the dropped test on its own. `membershipParent` re-pins the one
parent whose fields the created record's contributions read; a member with a
second membership of a different kind re-pins only the first (unchanged
behaviour, no cell). The width-overlap and series-choice recipes' executed end
states are measured on the instrumentation-patched copy the runner-only mode
uses, not in a credential-free lane (by design: that lane must not run them).

**Still red, not this unit's.** None of the 99 gate cells; the six generation
campaigns whose seed corpora are absent from a fresh worktree; the runner-only
CS-02 measure when run UNPATCHED in a credential-free lane (red by design —
its frozen matrix needs the instrumentation patch, which is why the tooling
group took it out of both credential-free lists; verified green in its
patched environment, §5).

## 7. Review

**Round 1 — BLOCK on all three lenses** (`receipts/review1-results.json`).
The transport lens: the member boundary had been gated on the wrong question
(an enclosing write's pendency), so a later member's observation of an
earlier member's row was lost on the batch route — green at the base,
`UniqueConstraintError` on the tree the review read; the vacate-once slot key
used `JSON.stringify` (a `bigint` key crashed); `admittedTemporal` claimed
more than it measured (a TEXT-stored `dateTime` keeps the payload's own
spelling). The commands lens: `folded` was scoped by `membershipOnly`, which
also catches `connectOrCreate` / `update` / `upsert`, and turned the explicit
G1 transport world red; `correlationParent`'s placement rule made a CS-03 A
recognizer cell red; `Assignments.hold` was bound at plan time from the found
arm and re-addressed the parent when the missing arm ran; the claim that
`exclusiveMemberMove` fires "before anything is queued" was false on the
batch route. The contracts lens: the parent premise's progress attribution
turned seven `g2-transport` cells red; thirteen red cells in four unmodified
files were undisclosed and both standing lanes exited 1; plus the
documentation minors (the AGENTS.md hunk row, the "+857" figure, 53 vs 54,
D-50 / D-52 missing from the ruling inventories, the census's `ctx.failure`
blind spot, the fold gate's `sentinel` spelling, a §3 row's file).

**The repair round** (two Opus owners on disjoint files,
`receipts/repair-results.json`): the boundary is taken by the OBSERVING member
(`OperationContext.answer`, when another member's write waits —
`holdsOtherMemberWrite`) and only deferred, never dropped, by `executeMember`
(two alternatives falsified and recorded at the site); the spent slots are a
value tree (`spendSlot`, SameValueZero, no serialisation), a `bigint` world
pinned; `admittedTemporal`'s claim narrowed to what is measured and the
residual pinned (three spellings) and recorded below; the two progress gates
ask "has this operation a committed prefix" instead of "are there
continuations" (`g2-transport` 32 / 32); `readsBatchReference` derived for
guards at the one owner; `folded` scoped to the arm the shipped sentences
name (a parent-held `connect`; the explicit G1 world's `coc-found` script is
the contract), `transport.test.ts` 88 / 88; the CS-03 A recognizer
re-expressed under D-51 (falsified in isolation: the parent premise was not a
cause of that cell, whichever lens said so); the hold carries its holder and
`moved()` asks whether that arm ran (`carried`), the missing-arm shape pinned;
the three "before anything is queued" sentences corrected to where the count
is first known, both routes' durable states pinned. Both lanes green: the
fixed stage 849 / 849 and the query-engine-core coverage lane 1,717 / 1,717
with the floors at 88.09 / 91.81 / 90.82 / 88.09. The documentation minors
applied. **Round 2 — REVISE on all three lenses, nothing refuted; one major**
(`receipts/review2-results.json`): the repair round's own residuals were not
in §6 — the located-NULL refusal now covering only the folded arm, the
unexercised guard derivation, the `foreign_keys`-off shape, the unmeasured
`exclusiveMemberMove` derivation, and (the transport lens's measurement) an
observing series that fails after its observation leaving a committed prefix
on the batch route where the interactive route rolls back — all recorded in
§6, the last one also pinned as a cell for both routes and the guide's
sentence narrowed to it; the member-boundary pin's header still stated the
withdrawn rule (rewritten); the pin-cell count (62, now 63) and the ledger's
half-updated record; four repair rows with worktree-absolute paths
(regenerated); `blind-premise-attribution` answering `QueryError` twice while
a second vitest ran in the worktree (recorded in §6; green alone since).
**Round 3 — REVISE on four documentation numbers, every code resolution
confirmed** (the fifth cell's falsification reproduced, the guide's narrowed
sentence, the residuals, the repo-relative rows, `blind-premise-attribution`
green three times alone, typecheck 0, Biome clean on the two edited pins):
§4's new-tests row (63 cells, +2,123 lines), the `AGENTS.md` hunk row
(+123 / −11), §5's gate-stage cell count (2,193 passed, 393 skipped by name —
`ordinary-5` is three provider-gated files that skip whole), and the ledger's
lagging pin count — all applied. **Round 4 — ACCEPT**: the four numbers re-measured against the tree (the
eight pins 2,123 lines and 63 cells, `AGENTS.md` +123 / −11, the 24 gate
stages 2,193 passed / 393 skipped, the ledger's count).
