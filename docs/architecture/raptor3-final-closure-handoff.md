# Raptor 3 — adversarial review and final implementation plan

This is the single handoff document for the next agent. It contains the review,
its evidence and limits, the ELEGANCE assessment, concrete LOC-reduction
opportunities, the low-refusal objective, implementation units and final
acceptance conditions. It supersedes the conversational summaries. Supporting
logs and test sources remain preserved evidence, not separate instructions the
reader must assemble into a plan.

## Review verdict

**The architectural direction is sound; the claim that engineering is complete
is not supported by the current behavior.** The review found concrete defects
at existing ownership boundaries, not a reason to rewrite the engine again.

The following gains should be preserved:

- The occurrence structure gives analysis and execution a shared composition
  without forcing their different orders into one traversal.
- Composed execution owners, ordinary recursion and the broad operation context
  remain appropriate. The failures below are not evidence that those principles
  were wrong.
- D-58 puts scratch lifetime at the dispatched unit, and carries produced values
  across segment boundaries. Its held-listener regression witness is valuable.
- P1 removes real decoder work. Its saved measurements support the improvement;
  this review established no correctness regression in that hunk. It still
  allocates `Object.keys(shape.fields)` per document, so the claim that it never
  rebuilds a key list is too strong.

### Findings and their evidence level

| Finding | Evidence from this review | Required disposition |
| --- | --- | --- |
| A dependent nested write works under `update` but is refused under `updateMany` | Reproduced through the public client; matching control passes | FC-01: place fresh member occurrences through their own dependency boundary, not an operation-global freeze |
| A cascaded key is current for the mutation but stale for non-RETURNING readback | Reproduced on real SQLite with RETURNING disabled; RETURNING control passes | FC-02A: consume current attempt values consistently; qualify on native local MySQL |
| Internal captured-set predicates break legal fields called `NOT` | Reproduced through the public client; equivalent `flag` field passes | FC-03: compose prepared identity predicates instead of fabricating public syntax |
| Noncanonical SQLite TEXT DateTime keys lose their address after capture | Existing source and tests explicitly record the unrepaired T3 residual; not newly executed here | FC-02B: preserve internal physical addressability and public Date output |
| Found `connectOrCreate` can silently disconnect when the referenced value is NULL | Existing N5 report and the narrow plain-connect guard; not newly executed here | FC-02C: enforce the shared reference-representability requirement |
| Captured-set checks may expire before the consuming mutation under concurrency | Source-derived concern, not an executed PostgreSQL result | FC-03: establish the precise contract and falsify it with a local native schedule |
| “23 public refusals” is a message-newness metric, not a capability count | Census implementation and its own 71 inherited sentences; indirect failure origins are missed | FC-00/04/06: inventory refused valid behaviors and repair the bounded census gap |
| Single-statement write building has contradictory recorded contracts | D-14, current synchronous preparation, current read-only build route and changelog disagree | FC-00/04: apply an explicit public-contract decision |
| Final release claims exceed or contradict their evidence | P1 requires a committed-tree comparator; D-16 status and batch-count documentation conflict | FC-06: produce one accurate, source-bound current verdict |

The executed paired probes yielded **3 passing controls and 3 failing valid
operations**, exit 1, on Node **24.21.0** / Vitest **3.1.4**. The final run took
**3.33 seconds**, peaked at **461.0 MiB** sampled process-group RSS and verified
teardown. All use real in-process SQLite. Capability-forced non-RETURNING
execution is not a native MySQL receipt. The root ran validation serially;
independent read-only reviews covered correctness, compression and release
evidence. No production code was changed by this review. No full qualification,
native-provider run, typecheck or performance benchmark was rerun for it.

### ELEGANCE assessment and concrete compression opportunities

The main weakness is **several consumers disagreeing about a fact that already
has an owner**. Fix those conflicts and remove their bookkeeping; do not merely
extract large methods into more files.

| Necessary fact / ELEGANCE principle | What should disappear | Rightful owner and proof |
| --- | --- | --- |
| A fresh occurrence can be placed before it starts; a template is not its evaluated instance (§3–4) | The global `expanded` veto and the false assumption that template placement proves every member | Existing occurrence/dependency owner; root, nested and repeated series witnesses |
| A mutation must consume current values, distinct from its original observation (§1, §4, §6) | Passing a current address beside a contradictory stale row; any need to synchronize a second current-row mirror | Existing attempt binding reader; cascades, arithmetic, final identity and nested consumers |
| Identity-set exclusion has one prepared meaning (§2, §9) | Both synthetic `{ NOT: { OR: … } }` constructions and their repeated public parsing | `Queries`; root and nested capture, legal combinator field names and compound keys |
| A primary failure plus listener failures has one composition rule (§8–9) | `OperationContext.retainOutcomeFailure()` duplicating the existing `retainWriteOutcomeFailure()` | Existing error-composition owner, after import-graph verification; dispatch and acknowledged-result failures |
| Carrying one scalar expression needs its physical shape and codec, not an entire user projection (§2, §7, §10) | The single-caller `referenceProjection()` / `lowerProjectionValues()` generic pipeline | Existing query/scalar owners; generated INSERT keys and computed UPDATE values across segments |

These are actual deletion targets, not a promise that moving code reduces its
cost. Each must pass behavioral witnesses and a whole-perimeter recount.
**Net LOC savings have not yet been measured.** Do not invent a reduction
percentage. The repairs may add necessary distinctions; any net growth needs
an explicit account of which capability or ownership conflict justified it.

Further decoder enumeration changes are bounded, measured opportunities, not
mandatory redesign. Logical versus physical ordering, original observations
versus current bindings, and dispatch versus result failure timing are necessary
distinctions; merging them would violate ELEGANCE rather than compress the engine.

### The combined goal

Correctness, LOC/token reduction, ELEGANCE adherence and fewer refused valid
operations are all required review dimensions. The low-refusal goal supplements
the original request; it does not replace the compression work. Measure supported
behavioral families, not renamed or reclassified error sentences. Keep necessary
integrity failures and expressly approved capability limits.

**Remote/hosted drivers are out of this checkpoint.** Local native PostgreSQL
and MySQL remain relevant to shared-engine behavior. The plan below defines a
finite local closure, not an assurance that every future feature is already
expressible or every line of the engine has been proven optimal.

## Prompt for the implementing agent

Continue the `pattern-engine` work from its actual current tree. Implement this
bounded closure plan, using the established `/workflows` process if available,
with an implementation author and an independent adversarial reviewer. The
previous release report is context, not proof that the job is finished.

Arnaud wants Raptor 3: a smaller language that makes the required ORM behavior
ordinary composition. Correctness, very few refused valid operations,
maintainability, source compression and low extension cost are simultaneous
goals. Do not achieve one by concealing a regression in another.

**Remote/hosted driver qualification is deferred.** Do not request Neon secrets,
provision services, or make hosted Neon/D1 evidence a blocker. This does not
waive common-engine correctness that local SQLite, PostgreSQL and MySQL can
prove. Do not push, open a PR, publish, delete historical evidence, or alter
unrelated work.

Completion means a qualified local public engine with no known avoidable
refusal in the agreed closure inventory. It does not mean zero possible future
bugs, every conceivable ORM feature, or a newly designed recursive-query API.

## Baseline, measurements and repository references

Review baseline: `320c898f1f97965f9ad411945e545f12bbaa3499`, Node **24.21.0**.
If the branch has moved, inspect the intervening diff and refresh the baseline;
do not reset or overwrite it. Preserve unrelated `CONTEXT.md`, `memory.md`,
historical untracked corpora and the retained old-engine perf worktree.

This document contains the complete review and follow-up instructions. Read the
applicable `AGENTS.md` files and use these repository sources to verify exact
contracts before changing code; do not substitute historical summaries for the
implementation units below:

- [ELEGANCE.md](../../ELEGANCE.md), in full.
- [Current engine guide](../../src/query-engine/raptor3/AGENTS.md), checked
  against source where historical appendices contradict current rules.
- [Central plan](raptor3-implementation-plan.md), current qualification gates
  and consumed repair/redesign budgets.
- [Original hard-won rules](raptor3-g4-claude-handoff.md#rules-we-learned-the-hard-way).
- [Current rulings ledger](raptor3-evidence/g4.md), particularly D-14, D-16,
  D-28–D-30, D-51, D-55–D-63. Later explicit rulings prevail over stale status
  paragraphs; reconcile them instead of inventing consent.
- [N5 residuals](raptor3-evidence/g4/release/n5/note.md),
  [D-58](raptor3-evidence/g4/release/d58/note.md),
  [P1](raptor3-evidence/g4/release/p1/note.md), and the
  [existing refusal census](raptor3-evidence/g4/release/n4/census.md).

Supporting evidence, already summarized above: the exact
[paired-probe output](raptor3-evidence/g4/release/closure-review/paired-probes.log)
and [executed test source](raptor3-evidence/g4/release/closure-review/probes.test.ts.txt).
For diagnostic replay, restore that source to
`tests/raptor3/g4/parity/closure-review-probes.test.ts` in a task-local checkout
and use the logged command. The preserved `.txt` remains outside ordinary test
discovery; permanent repair witnesses belong in the registered suites.

Only P1's decoder hunk changed production between `36c87710a` and the review
baseline. It does not repair the other findings. Three public-client failure
pairs were executed against the baseline: **three controls pass, three valid
operations fail**. Preserve their red evidence and turn the failed behaviors
into successful registered tests; do not turn them into approved refusals.

Recorded size is **16,036 parser-token-bearing LOC** for the complete engine
perimeter, versus **46,021** in the comparable old engine. With the same
integration files it is **19,896 versus 49,887**; another **3,935** shared LOC is
reported separately in the existing accounting. These are different
denominators from early private-core counts. Recount the current whole perimeter,
including shared/moved code, rather than comparing the latest engine with an
old partial slice. See the
[source report](raptor3-evidence/g4/release/perf/source-size-release.json).

## Non-negotiable design contract

- Keep one broad `OperationContext`, composed behavioral owners, inspectable
  command values, an occurrence structure and ordinary recursion. No second
  interpreter, fallback to the retired engine, generic scheduler, scope
  framework, per-placement executor or policy-boolean collection.
- A template is a recipe, not proof about every admitted occurrence. Logical
  order and physical phases are distinct traversals, not duplicate facts to
  flatten into one total order.
- Preserve original observations where choices need them; consume current
  bindings where effects need current values. Keep durable progress, admitted
  values and transaction ownership outside attempt replacement.
- Queries own prepared predicates, projection and scalar meaning. Adapters own
  dialect SQL; drivers own transaction mechanisms and provider errors. Never
  rebuild internal predicates as public input merely to reuse a parser.
- Validate at the existing admission boundaries and genuine provider boundaries.
  Do not add downstream shape checks or repeat defaults/transforms to conceal
  an ownership mistake. Preserve the exact approved occurrence/replan admission
  scope; do not replace it with an inaccurate operation-wide "once" slogan.
- Borrowing does not grant lifecycle or recovery authority. No broader replay,
  implicit savepoints, uncertain-outcome retries, or deletion of progress gates.
- Existence, membership, reference representability and provider result checks
  are real requirements. Removing them is not reducing unsupported operations.
- For every change, name the necessary fact, its existing owner, the rule or
  mechanism deleted, and a second applicable consumer or placement. "No
  deletion" is an honest answer for new meaning; a wrapper is not compression.

## FC-00 — Freeze a behavioral closure inventory

Do this once, then implement against it. Do not start another open-ended
architecture investigation.

The current **23** figure counts candidate error sentences not matched in the
old-engine corpus. It excludes 71 inherited sentences, includes malformed
provider results and integrity failures, and misses some indirect errors. It
does **not** count 23 unavailable operation families. Reclassification from a
public error to `EngineInvariantError` does not enable a request; the review's
legal `NOT` model reaches precisely such an invariant.

Build a compact, source-linked table from the public entry points, validation
surface, failure owners and registered tests. Include old and new limitations,
not just the unmatched messages. One row should describe:

`admitted behavior → placement/result mode → mechanism/authority needed →
current outcome → owning rule → witness → action or explicit ruling`.

Separate:

1. Supported valid operations.
2. Avoidable refusal or incorrect failure of an already-admitted operation.
3. A necessary integrity/concurrency/provider-result failure.
4. An explicitly accepted capability limit.
5. A genuinely new feature or changed public contract requiring a decision.
6. A deferred hosted qualification claim.

Review successful neighbors as well as negative pins. Include root/nested
placement, selected series, repeated series, choice arms, compound identities,
returning/count results, standalone/borrowed/array authority and relevant
interactive/batch mechanisms. Do not manufacture a full Cartesian test matrix
where cases exercise the same fact.

The target is **no known avoidable refusal in this agreed local surface**.
Every remaining valid-operation refusal needs the unavailable fact or guarantee,
its owner, a concrete witness, the nearest accepted neighbor, and its ruling.
Inherited refusal text is not an exemption. Conversely, existing approval to
keep D-55, D-56 and D-59 remains binding unless Arnaud changes it. Do not erase
those output-identity/rounding limits to make the count attractive.

Reconcile D-16 by current family status. The ledger says both "all 115 repaired"
and "families still awaiting Arnaud"; do not reopen 115 resolved cells or put
unrepaired approved work back on the user. List only actual remaining decisions.

**Public build decision:** D-14 promises reads and folded single-statement
writes through `buildStatement()` / `QueryEngine.build()`. The later changelog
documents every write as refused. Current `commands/index.ts` already prepares
eligible writes synchronously, so the old "all writes need asynchronous
preparation" rationale no longer resolves the discrepancy. Recommend restoring
the eligible single-statement contract through the existing preparation owner.
Arnaud was asked to choose this versus an explicit read-only build contract;
apply his answer. If unanswered, continue independent work and leave only this
bounded public-contract choice pending. Do not silently choose either policy.

**Exit:** reviewer accepts the finite inventory, approved limits, remaining
decisions, source identity and the red controls. Each unsupported family has an
owner and an action; no renamed sentence counts as delivered functionality.

## FC-01 — Make dependency placement local to fresh occurrences

**Executed failure:** the same nested payload works under `user.update` and
fails under `user.updateMany`: an earlier `posts.update` changes `slug` to `x`,
then `edited.delete({ slug: "x" })` must observe that write.

At the review baseline, `Commands.expandSeries()` sets the global `expanded`
flag before materializing and analyzing fresh members. `depend()` treats that
flag as a reason to refuse an otherwise movable observation. Template analysis
moved template occurrences; fresh members are reconstructed from admitted
payload and do not inherit those evaluated placements.

Repair the existing occurrence/dependency owner:

- Fresh, unexecuted member subtrees may receive their ordinary physical
  placement before any member executes.
- Retained surrounding or already-started execution cannot be moved backward.
- Preserve consumed-parent cycles, branch activation, first-failure attribution,
  prepare-all-before-execute timing and existing progress boundaries.
- Delete the operation-global `expanded` prohibition and its false template
  justification. Derive the boundary from the occurrence's actual construction
  and execution position; do not replace the bit with scattered permission bits.
- Moving `expanded = true` below the first loop is insufficient: the second
  expansion would still inherit the first one's freeze. Do not copy analyzed
  template state into admitted members either.

Prove the review case, nested selected-series placement, two sequential series,
opposite choice arms and a deeper nested expansion. Retain genuine cycle and
untaken-failure controls. Verify effects and results, not only lack of a throw.

**Exit:** previously valid ordered composition executes in each applicable
placement through the same owner; the global special case is gone, with no
change to admission, acknowledged progress or recovery authority.

## FC-02 — Establish the correct identity/reference value at consumption

These are related boundaries, not permission to merge original observations,
physical addresses and public output into one ambiguous row object. Repair each
through its existing semantic owner.

### A. Cascaded current identity

**Executed failure:** update a card whose PK is its cascading account FK,
change the related account ID from `a1` to `moved`, also change the card's
`label`, then select the card. RETURNING succeeds; the non-RETURNING path
updates the correct row but reads it back at the obsolete `a1` identity.

`CommandExecution` materializes the cascade in `CommandAttempt.bindings`, then
passes `attempt.rows.get(command.located)` to `OperationContext.update()`.
The latter uses the old capture for demanded arithmetic and final identity.

Have the existing attempt binding reader supply the current pre-write values
after cascade materialization. Use that meaning consistently for the address,
arithmetic and final identity. Preserve the original observation for conditional
skip/choice consumers. Seek to remove the contradictory `where` plus stale
`captured` parameter combination; do not introduce a synchronized row mirror or
MySQL-specific correction. Replacing only readback's `captured` with `where`
misses non-key arithmetic inputs.

Prove scalar and compound cascades, the holder's own scalar/arithmetic write,
descendant consumers, nested placement and missing/found choice controls.
Qualify the non-RETURNING behavior on **local native MySQL**, not only the
capability-forced SQLite falsifier.

### B. Captured TEXT DateTime identities — the recorded T3 residual

`captured-identity-domains.test.ts` currently expects valid noncanonical ISO
spellings to fail. SQLite may store the admitted spelling verbatim, whereas
capture decodes it to `Date` and rebinding uses `toISOString()`. Logical instant
equality does not reconstruct the physical key's original bytes.

Keep an internally captured identity provider-addressable through the shared
capture/codec boundary while preserving public `Date` results. Reuse existing
internal value/shape facilities first. Do not rewrite existing data, normalize
all user inputs as an unapproved contract change, add per-verb conversions, or
make two distinct stored keys accidentally compare equal. If an irreducible
representation change is needed, state the conflict and review it before use.

Turn the existing residual failure pins into success assertions. Cover ISO
strings with and without milliseconds and offsets, equal instants with distinct
stored spellings, compound and omitted keys, a relation consumer, and existing
canonical/numeric-storage/date/bigint/decimal controls where applicable.

### C. A found target must represent the requested relation

N5 records that a found `connectOrCreate` target with a NULL referenced value can
write NULL and disconnect the holder. The current check covers only parent-held
plain `connect`.

Locate the shared relation/reference-value requirement. Enforce it where a
concrete reference becomes a relation, across plain `connect`, the found arm of
`connectOrCreate`, equivalent supplier paths and applicable junction/compound
placements. Do not spread verb-specific guards or reject all nullable-key
schemas. A nullable scalar that is never consumed as such a reference remains
valid. Do not invent stricter semantics for an actually ambiguous placement;
surface that particular compatibility question.

Prove that a representable target connects, an unrepresentable found reference
does not silently disconnect, and rejection preserves the documented atomicity
and original failure, including a sibling scalar write. On an interactive local
transaction no sibling write may remain committed. On a segmented fixture use
its approved progress contract, not an invented rollback promise.

**Exit:** one current-value reader, an addressable captured identity, and one
reference-representability rule serve their real consumers. Required integrity
errors remain; valid cases do not acquire new blanket refusals.

## FC-03 — Share prepared set predicates and prove requirement lifetimes

**Executed failure:** a valid model with a scalar called `NOT` cannot perform a
captured delete with relation projection. Internally constructed
`{ NOT: { OR: identities } }` is parsed as that declared field, then fails on
scalar operator `OR`.

Both `CommandExecution.requireNoAddedMember()` and
`OperationContext.requireCapturedSet()` manufacture this public syntax.
`Queries` already owns prepared identities, selectors and logical predicates.

- Compose identity-set exclusion there from typed prepared meaning; both
  consumers reuse it. Delete both synthetic public selector bags.
- Preserve public field-name precedence. Reserving `NOT`/`OR`, changing the
  error class or adding a special parser mode is not the repair.
- Preserve empty-set truth, complete compound identities, alias binding,
  membership scope, guard ordering and each consumer's error identity.
- Do not merge callers' distinct policies: a limited capture does not claim
  there are no other matching rows; root selection and nested membership do not
  automatically impose identical lasting predicates.

Prove root selected bulk mutations and nested captured deletion, legal scalar
and relation combinator names, empty/nonempty captures, compound identities,
limited capture and actual added/removed membership.

There is also an **unexecuted concurrency concern**, not a proven result from
this review. Ordinary EXISTS premises followed by an ID-only mutation do not
alone prove the relevant membership still holds when the effect executes.
Use a local native PostgreSQL schedule through existing transaction/batch
owners: another transaction changes a predicate/member while holding a row
lock; let capture/premises observe the old committed row; release the lock as
the mutation proceeds. Establish the correct expected result from the specific
operation contract first. Also test a truly irrelevant concurrent change.

Keep the required condition protected until its consumer using the substrate's
actual guarantees. Do not prescribe blanket `FOR UPDATE` (it is not phantom
protection), global serializable isolation, or a post-commit count check as
rollback. A selected series' initial collection filter may be an observation,
not a requirement on every later member; preserve that distinction. If a
stronger public guarantee or authority is truly necessary, request that bounded
decision instead of silently weakening correctness or refusing a whole family.

**Exit:** both predicate constructions disappear, legal models execute, and
local evidence establishes the claimed consumption-time requirements. No
hosted connection is required and no new transaction protocol is introduced.

## FC-04 — Remove the remaining avoidable capability restrictions

Use FC-00's finite inventory after the shared repairs; do not start a fresh
feature hunt. Check which restrictions are now unnecessary because the needed
fact is already owned by the occurrence, prepared query, current binding or
execution boundary. Execute the supported composition through that owner and
delete its obsolete special refusal. A historical inherited restriction is
still a candidate when existing meaning can express the behavior.

For each retained limit, explain precisely what is missing and why composing
current owners cannot supply it under the existing authority/contract. A
hand-wave such as "too complex", an old red pin, or an unhelpful error name is
not a reason. A genuinely new public language, changed numerical semantics,
expanded recovery or unavailable substrate guarantee is a decision, not a
license to build a subsystem. Keep D-55/D-56/D-59 unless expressly revised.

If Arnaud selects the D-14 build contract, expose an already-owned synchronous
one-statement prepared write through the existing public build boundary. Reuse
the exact prepared `Sql`; do not execute a provider, rebuild the mutation,
change the synchronous API, or repeat defaults/transforms. Pin representative
single-statement create/update/delete/set-bulk writes, a read control and a
genuinely multi-statement refusal through the public methods. Cover the existing
extension and preparation lifecycle. If the read-only contract is selected,
record it as an accepted capability restriction, not a recovered feature.

Every enabled family needs its former red case, a successful neighbor, another
placement/result mode and a failure-timing/progress control. Count enabled
behavioral families separately from removed failure sites or renamed sentences.

**Exit:** no known avoidable restriction remains in the agreed inventory. Any
pending public-contract decision is named explicitly, not described as finished.

## FC-05 — Make the demonstrated semantic deletions

This is bounded consolidation, not a third broad preparation-performance
campaign. D-60 already accepts the measured preparation bracket and D-62 the
full-write cell. Neither proves that every future simplification is impossible.

Prioritize these audited opportunities:

1. **One write-outcome error composition.**
   `OperationContext.retainOutcomeFailure()` duplicates the existing exported
   `retainWriteOutcomeFailure()` in `src/extensions/query.ts`. Verify the current
   import graph, then use the existing owner; if necessary move that same pure
   rule to the appropriate shared boundary rather than introducing a second
   error service. Count moved code. Preserve primary identity, cause, ordered
   listener failures and the operation's answered/progress marking. Exercise
   dispatch failure and successful dispatch followed by scratch/decode failure
   while a listener failure is held. Retain D-58's regression witness.
2. **One scalar scratch projection.**
   `OperationContext.referenceProjection()` has one production caller,
   `carryScratch()`, which always asks for one field.
   `Queries.lowerProjectionValues()` exists only for that helper. Compose the
   needed scalar-expression query at `Queries` using existing scalar shape,
   physical value and decode owners. Remove the generic select/map/assertion
   detour. Prove generated INSERT keys and computed UPDATE integers, widths,
   malformed provider values and values crossing sessionless fixture segments.
   Keep scratch lifetime and statement count unchanged.
3. **The predicate and current-value duplications repaired above.**
   Count those deletions once. A necessary distinction between an original
   observation and a current value is not duplication; two independent current
   answers are.

Do not merge all result catches: dispatch failure, acknowledged result-decoding
failure, listener failure and cardinality rejection have different timing.
Do not flatten logical/physical ordering or coalesce scratch SELECTs simply to
claim fewer lines; aliasing, codec bindings and bind budgets could cost more
machinery than they remove.

P1's remaining per-row `Object.keys` and two polymorphic enumeration sites are
**measured-experiment candidates**, not mandatory fixes. First correct the claim
that no key list is allocated. Only retain a further change if existing prepared
shape ownership removes work without a second decoder, mutable shape mirror or
unmeasured framework. Test carried JSON/bigint/blob leaves through relation
windows and output ordering if that decoder boundary is changed. Do not reopen
the whole performance campaign or promise a LOC percentage in advance.

**Exit:** reviewer verifies actual deletions at rightful owners and no
equivalent machinery elsewhere. Report production LOC/token/byte deltas and
independent rules removed. Small residual provider branches are not a failure.

## FC-06 — Close evidence, documentation and the local release verdict

### Accurate current claims

- Fix the census's bounded indirect-origin blind spot, including errors carried
  by a local variable/factory into the existing failure owner. Add harness
  self-tests for the actual shapes. Do not turn this into a general program
  analyzer or infer reachability from the error class. Label the syntax counts
  accurately and keep the behavioral inventory authoritative for capability.
- Reconcile D-16 and every open local item by current evidence. Retain sealed
  historical receipts; add a dated superseding verdict rather than rewriting
  old failures into passes.
- Correct the drivers guide's claim that `create`/`update` with all nested work
  is always one batch, and its one-batch-per-relation-bearing-createMany-row
  promise. Packaging follows dependencies and authority, not the verb name.
  Explain partial progress only for routes that actually permit it.
- Distinguish hosted evidence from local Workers-pool tests: D1 test source
  exists, but source presence is not a current passing receipt. Hosted Neon/D1
  stays deferred and does not delay this local checkpoint.
- Consolidate contradictory active engine-guide rules; keep history in the
  ledger. Update the occurrence boundary, identity/observation distinction,
  scratch lifetime and exact P1 claim. Do not rewrite the constitution or
  remove original ELEGANCE principles.
- Reconcile the duplicate harness registration and stale
  `reference-instrumentation.patch` through their existing owners. A stale
  benchmark patch must fail verification, not silently produce a new baseline.

### One frozen qualification

Review the integrated implementation before the expensive runs. Freeze
production and test harness identities, then run the applicable current
registered closure inventory serially: fixed, comparison/replay, generated and
transport contracts; affected client/extension/codec suites; local SQLite and
PGlite; native local PostgreSQL/MySQL; harness self-tests; full typecheck; build
and package checks. Use the active manifest and plan, not stale deleted test
commands. Add the new regressions to the appropriate registered suite.

Do not rerun all historical multi-day campaigns after every tiny unit. Focused
checks and independent review close units; the active complete local gate runs
once on frozen source, with targeted revalidation after any repair and explicit
invalidation of affected receipts. Honor current campaign/replay budgets and
source identity requirements; absence of native local evidence leaves a claim
unqualified. Typecheck must be **zero**, not the obsolete allowance for two
Pattern errors.

P1's saved calibration after-cells support CPU ratios about **0.655/0.649** and
**847 B/row**, but its own note says they are not valid standard-protocol release
reports. Run the existing committed-tree comparator for the repaired parse cell
and its full-read consumer, with its required controls. Preserve the original
calibration receipts. Do not relabel dirty-base measurements as final-tree
qualification, and do not repeat unaffected benchmarks without a reason.

Recount the complete like-for-like engine and broader retained/shared perimeter,
including all moved production responsibility. Report parser-token-bearing LOC,
physical lines, source bytes and separately measured bundles. Separate new
meaning, actual duplicate-rule removal, cosmetic edits and retired comparison
code. A net increase needs an explicit ownership/capability trade-off review;
there is no invented automatic percentage veto and no unmeasured bundle claim.

Create the task-scoped local Conventional Commit with only audited work. If the
standard benchmark requires a committed tree, freeze that source checkpoint
first and attach later evidence with exact production/harness hashes; a
documentation-only evidence commit does not mean the benchmark ran at its later
hash. Use an isolated matching clean checkout when unrelated working-tree
changes would prevent that protocol; do not stash or commit user work to satisfy
its clean-tree check. Preserve user changes and do not push.

## Workflow, stop rules and final acceptance

Continue the established Opus implementation/independent-review workflow. One
production author owns coupled engine interfaces. Independent witness design,
inventory review and evidence inspection may run in parallel once their
contracts are fixed; no concurrent shared-file edits or validation runs. Each
unit is reviewed on stable source. The root performs one final integrated
review rather than trusting agent summaries.

Use the repository launchers and locks. Current ordinary validation ceilings are
768 MiB V8 heap / 1,536 MiB RSS; the separately permitted isolated PGlite and
native-typecheck ceilings remain those of the active plan. Do not delete a
live lock or run expensive jobs beside another validation/perf lane.

For each unit report: witness and result, fact established, semantic owner,
deleted rule/mechanism, second placement, capability change and complete cost
delta. Keep reports concise; keep proof in the evidence directory.

Preserve consumed repair/redesign budgets. Two unsuccessful repairs of the same
minimized failure, an exhausted language-redesign budget, a second interpreter,
expanded recovery, or a changed public contract requires Arnaud's decision.
Renaming a unit or moving a failure does not reset the budget. Ordinary scoped
repairs proceed without repeated permission questions.

Accept only when:

- The three executed failures are repaired and their controls stay green.
- T3 and the found-NULL reference issue have explicit, witnessed dispositions;
  known valid requests are not left broken behind green failure pins.
- The local concurrency concern is resolved by a contract-correct witness and,
  if needed, an owner-level repair.
- Every agreed avoidable capability restriction has been removed; remaining
  limits are explicit, necessary/approved and behaviorally witnessed.
- The public build contract is settled and code, tests and docs agree.
- Claimed structural deletions are present and no new interpreter, scattered
  permission logic or duplicated current-value owner replaced them.
- Final local qualification, source-bound performance attestation, honest cost
  accounting and the integrated independent review are complete.

The final report must distinguish **Outcome**, **Validation** and **Risks**.
Include the actual supported-family gains and the remaining approved limits,
not merely a smaller error-sentence count. State hosted qualification as
deferred. Do not say "nothing engineered remains" while a known local valid
operation still fails. Stop after this reviewed checkpoint: no speculative
cleanup or promise that future engine work can never add complexity.
