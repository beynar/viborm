# Raptor 3 — final local closure: decided implementation prompt

Implement this checkpoint. It replaces the remaining-work instructions in the
earlier final-closure handoff; it does not reopen its completed units.

The goal is a locally qualified engine with correct relation writes, a green
native MySQL lane, an explicit captured-set concurrency contract, and trustworthy
release evidence. **No new rewrite, no broad abstraction campaign.** Remote and
hosted driver qualification is deferred.

**Co-release update (2026-09-21):** Arnaud also requests public recursive queries
in the same release. Their [canonical implementation plan](../../features-docs/recursive-query.md)
owns that separate feature gate. This document still owns only local engine
closure: do not expand R1–R4 into recursive-query implementation. Overall release
acceptance requires both checkpoints on the same integrated source, with one
writer at a time for coupled engine interfaces. Neither plan authorizes publish.

## 1. Decisions: implement these, do not leave them pending

| Matter | Decision |
| --- | --- |
| NULL reference | An explicit connection must establish the requested relation. A NULL reference tuple cannot do that. Reject it through the shared reference-consumption requirement, regardless of which operation or direction supplied the tuple. Ordinary nullable scalar data and explicit disconnect remain legal. |
| MySQL | Native MySQL is part of local release qualification. “The same failures existed before” does not qualify it. Repair the bounded causes and exercise the previously blocked tests. Do not remove MySQL support or lower its advertised contract to close the gate. |
| MySQL deadlocks | Preserve native transaction-abort semantics. Do not introduce automatic whole-transaction replay, change global isolation, or retry borrowed work. Distinguish a genuine provider deadlock from the already-supported recoverable unique-key race. The latter must continue to converge under its existing rules. |
| D-65, root captured mutations | Choose effect-time selection: the consuming UPDATE/DELETE must carry both the complete captured identity set and the original prepared selector. It must not mutate a captured row that no longer satisfies that statement's selector. Keep the established cardinality check and truthful outcome/progress reporting. |
| D-65, nested captured series | Choose a bounded captured worklist, not a promise to consume every future joiner. The initial filter selects the worklist; it is not automatically a permanent per-member predicate. Actual identity, parent and relation-membership requirements remain enforced at their existing consumption boundaries. |
| D-64 | Keep the accepted read-only build contract. Register its regression witness in the normal gate. Do not restore write building. |
| Evidence | Produce a new source-bound local release record. Preserve historical receipts unchanged; do not relabel old runs as final-source qualification. |

These are the selected contracts for this handoff. Record their adoption and
provenance in the decision ledger; do not invent a separate quotation or ruling
from Arnaud. D-65 must not remain marked “pending” after implementation.

## 2. Starting point and boundaries

The reviewed checkpoint is `cdd787ac8bbd` on `pattern-engine`. Inspect the actual
tree before editing and preserve subsequent or concurrent work. At that
checkpoint the recorded engine cost is **16,040 token-bearing LOC**, and the
broader charged perimeter is **23,833**. They are different denominators.

Keep the accepted FC-01 occurrence repair, FC-02A current-value repair, FC-02B
physical DateTime identity work, FC-03 prepared predicates, FC-04 census repair,
FC-05 ownership consolidation, D-58 scratch lifetime and P1 decoder improvement.
Do not redo these projects or restart the original refusal inventory.

Read [ELEGANCE.md](../../ELEGANCE.md) and the applicable layer guides. Apply:

- One fact and one owner. Share the reference requirement, not per-verb guards.
- One broad operation context, composed owners and ordinary recursion.
- Validate admitted input once. Execution requirements are not another parser.
- Keep observations, current bindings and acknowledged progress distinct.
- SQL belongs to adapters; error normalization belongs to drivers.
- Keep transaction ownership and recovery authority unchanged.
- Seek real deletion where a shared rule replaces narrower rules. Do not move
  code, shorten names or add wrappers to manufacture compression.

Do not add capability flags, a second interpreter, a general concurrency policy
framework, reset journals, new recovery scopes, or a speculative extension API.
Do not request hosted credentials, provision remote services, push, open a PR,
publish, erase historical evidence, or alter unrelated dirty files.

## 3. Unit R1 — finish the shared reference requirement

The retained FC-02C probe demonstrates two remaining silent disconnects:

1. `connectOrCreate` takes its CREATE arm and produces a target whose referenced
   nullable unique field is NULL.
2. A child-held relation connects a child to a parent whose referenced field is
   NULL, writing NULL into the child's foreign key.

Start from `commands/execution.ts`, `commands/relation-body.ts` and the existing
assignment/reference owners. The current found-choice check in
`suppliedValues()` is a partial consumer, not the complete semantic boundary.

### Required implementation

Express this single rule where a concrete tuple becomes an explicit relation:
**all components needed to represent that connection must be present and
non-NULL**. Read the authoritative resolved edge and current values. Do not check
every projected or demanded field merely because it is available.

Apply the rule to found and produced values, both relation directions, and
single/compound references. Use the existing nested-write error model and useful
relation/field attribution. Reject an unrepresentable connection, not the model
declaration, the whole verb, or every nullable target.

Check at the earliest existing boundary with the actual values and authority.
Known NULL must not be knowingly written and discovered afterwards. A generated
value can only be checked once available, before its consuming connection. Do
not re-run admission, defaults or transforms to obtain it.

Remove superseded narrower checks when the shared owner supplies their complete
coverage. Do not leave both old and new guards enforcing the same fact.

### Witnesses and exit

Turn the two retained logging probes into registered red-before/green-after
assertions. Cover both directions, found/create arms, a compound reference with
one NULL component, root/nested placement and a sibling write.

Add controls for non-NULL connections, ordinary nullable scalar writes, explicit
disconnect, and a NULL field that is not part of the consumed reference.

Use SQLite and native PostgreSQL/MySQL. Prove operation-owned transaction
rollback, borrowed transaction ownership, and truthful progress if an earlier
segment was already committed. Never claim to roll back an acknowledged prefix.
On a borrowed failure, do not commit, replay or take over the caller's cleanup.

**Exit:** neither residual silently disconnects; the same requirement serves
the existing found arm and the two missing consumers; no repeated admission and
no new blanket capability refusal.

## 4. Unit R2 — qualify native MySQL, starting at the blocking owner

The last recorded lane was **589 passed / 160 failed / 1 skipped**. Of the 160
failures, 150 stopped at final schema fingerprint attestation. Fixing that setup
boundary is necessary to learn what those tests actually do.

### R2a — schema attestation and migration boundaries

Reproduce the expected/live fingerprint disagreement on an isolated local test
schema. Retain the exact differing facts before editing. Repair their existing
introspection, normalization or migration owner, as the evidence requires.

Do not disable final attestation, discard unexplained differences, hand-create
tables to bypass the normal caller path, or skip the blocked tests. Verify the
initial push, a repeated no-op push and an actual change. Preserve namespace and
constraint semantics. Fix the bounded namespace and migration-recovery failures
in this lane as well; do not redesign migrations.

Use the existing approved test fixtures. Never drop or destructively migrate
user data. A destructive operation outside those approved fixtures remains a
hard boundary, not something this prompt silently authorizes.

### R2b — execute and repair the exposed behavior

Run the formerly blocked tests, then resolve each remaining local failure:

- Descending to-many include ordering: preserve the requested order through the
  existing query/adapter collection owner, including a limiting control.
- DateTime-list membership: scalar admission, stored list values and filter
  operands must use the existing field-aware codec consistently. Cover `has`,
  `hasEvery`, `hasSome` and equality; add no operator-local Date converter.
- The createMany statement-count discrepancy: establish rows, values, count,
  ordering and required atomic/bind-budget behavior first. An old exact statement
  count is not a semantic contract by itself. Replace only an obsolete physical
  pin, with a witness that still catches lost results and per-row regressions.
- Any new failure exposed by repairing setup: fix its bounded cause in the
  relevant existing owner and add the missing discriminating witness.

### R2c — precise deadlock policy, not a green-test shortcut

A database-selected deadlock victim is a failed transaction, not successful
partial data and not an unsupported ORM operation. Preserve the normalized
provider failure and existing rollback/lifecycle semantics. Do not treat it as
an eligible unique-INSERT rejection or silently replay the operation.

For each of the four recorded concurrency failures, retain a controlled native
schedule and inspect the actual statements and locks. Remove gratuitous locking
or duplicated work if it causes the failure; do not remove a required lock.

Keep separate tests for:

1. Eligible unique-key races: existing upsert/connectOrCreate recovery succeeds,
   with exact producer ownership, one admission and the correct winner.
2. A deliberately forced native deadlock: the victim fails visibly, the
   transaction has no committed victim effects, and the survivor's state and
   provider error attribution are correct.
3. Borrowed execution: the caller retains transaction ownership; no hidden
   savepoint, retry or replacement transaction appears.

Do not replace the concurrency suites with permissive `allSettled()` assertions
that accept arbitrary errors or both operations failing. Change an unconditional
success expectation only for a demonstrated deadlock schedule, with the precise
failure and final state asserted. A non-deadlocking success control must remain.
Do not mark an avoidable engine regression “normal MySQL behavior” from its error
code alone; the independent reviewer must inspect the causal schedule.

**Exit:** the entire native MySQL inventory runs and passes its stated contracts.
Only pre-existing, explicitly justified inapplicable skips may remain. No newly
skipped failures, new xfails, missing setup coverage or “unchanged red” exemption.

## 5. Unit R3 — implement the bounded D-65 contract

The native PostgreSQL concurrency suite contains capability-forced batch
witnesses. Those are useful substrate tests, not proof of normal MySQL or hosted
driver behavior. Keep those distinctions in every report.

### Root selected UPDATE/DELETE: selector belongs to the effect

In the existing captured-mutation owner, compose the prepared selector with the
complete captured identity set for the consuming mutation. Share that prepared
meaning between update and delete; do not synthesize public `where` syntax or
parse it again. Preserve compound/mapped keys, limits and zero-result behavior.

Keep the existing premises and cardinality check. If a captured row ceases to
match, it must not be mutated merely because its key was captured earlier. Do
not silently return the original captured rows as a successful complete result
after fewer rows were affected.

**Failure and commit are separate facts.** The existing cardinality error is
still an error. On an operation-owned interactive transaction, let its owner
roll back. On an already-acknowledged atomic batch, report the acknowledged
effects and result-phase failure honestly; a JavaScript check after dispatch
cannot undo that batch. Do not replay it, erase progress, or claim that adding a
WHERE predicate made a post-commit check into rollback protection. Preserve the
primary failure and held listener failures through the existing failure owner.

### Nested series: selection is bounded, requirements are not discarded

Keep capture once, prepare all members, then execute the ordinary record bodies
in the established order. Keep the existing pre-unit added-member premise and
its already-permitted recovery. A qualifying member added after that checked
boundary does not enlarge the worklist or authorize another recovery.

Do not re-evaluate the original arbitrary filter before every member: an earlier
member may legally change facts that later members were selected by. This is
different from losing the actual relation membership or parent identity required
to consume that member. Preserve those requirements; D-65 is not permission to
delete another parent's member after it moves.

Do not claim that `FOR UPDATE` universally prevents new matching rows or new
junction edges. Row locks and phantom exclusion are different guarantees. Do
not add global serializable isolation, blanket locks or a new scheduler to close
the documented future-joiner window.

### Witnesses and exit

Update the existing controlled PostgreSQL schedules to assert the selected
contract, not the current implementation's answer:

- Root row stops matching between premise and write: it survives; cardinality,
  error phase, actual committed effects and result reporting are correct.
- A newly eligible row outside a limited captured set is not accidentally
  mutated; limits and complete compound identities remain correct.
- Nested addition before the premise retains existing abort/recovery behavior;
  addition after it remains outside the captured worklist.
- Loss or reassignment of required membership still prevents the wrong effect.
- An unrelated change is accepted. An admitted sibling changing only the initial
  selection filter does not invalidate the already-prepared worklist.

Exercise default native local routes separately from forced batch profiles.
Cover both root update and delete, including their non-RETURNING result path.
Preserve failure-after-acknowledgment and listener-failure witnesses.

**Exit:** D-65 has executable, accurately documented bounds, not a pending choice
or a new refusal of all captured mutations. Any comments promising stronger
locking, membership or rollback than the code provides are corrected.

## 6. Unit R4 — final evidence and release record

Make the following evidence repairs at their existing owners:

1. Move or register the D-64 read-only build witness in the normal test inventory.
   Do not count an excluded review file as gate coverage. Prove reads build and
   writes refuse without executing provider work.
2. Retain new final-gate raw logs, exit codes, test manifests, source/harness
   identities, runtime/dependency identity and resource/teardown results in a
   tracked checkpoint directory. A missing scratch path is not a retained
   receipt. Do not reconstruct old logs or edit sealed historical receipts.
3. Re-measure engine and public PostgreSQL fixture bundles on the final source
   with the existing tool and baseline. The older 0.646/0.735 ratios are historical
   until a new measurement supports them. Report source size separately.
4. Recount engine token-bearing LOC, bytes and the complete charged perimeter,
   including changes in shared drivers, adapters, codecs and migrations. Show
   each unit's change and actual removed rules. No arbitrary percentage veto;
   justify any growth with the behavior or ownership conflict it resolves.
5. Update the current behavioral inventory, release verdict, relevant guide,
   changelog and transport documentation to agree. Preserve dated historical
   claims as historical. Distinguish invalid connections, operational database
   failures and genuine capability refusals; “23 sentences” is not coverage.

Do not reopen the accepted D-60 preparation cost, D-62 bulk performance decision,
D-54 private recursive fit or D-55/D-56/D-59 capability limits. Retain the valid
P1 committed-source attestations. Re-run affected performance cells if these
repairs change their production path; do not rerun an unrelated optimization
campaign just to generate a newer date.

### One final frozen qualification

Use Node **24.21.0**, the pinned dependencies, existing resource ceilings and
resource-safe launchers. After integrated adversarial review, freeze production
source and the test harness, then run the existing registered local closure
inventory: fixed/comparison, saved replay, generated/transport, parity and
ownership regressions, PGlite, native PostgreSQL, native MySQL, all new residual
witnesses, harness self-tests, package build and whole-estate typecheck.

Run independent files/stages serially where the existing wall ceiling requires
it. Do not launch a second validator or benchmark beside the shared test lock.
The typecheck acceptance is **zero diagnostics**: historical Pattern errors are
not an allowance now that they have been repaired.

Keep the historical large-campaign receipts with their original identities and
scope; do not count them as campaigns run on this final tree. Use the active
closure's replay/regression obligations rather than restarting every historical
rewrite campaign. If source changes after a gate, invalidate the affected proof
and rerun it before finalizing the manifest.

**Exit:** one retained, internally consistent release index names the actual
qualified tree. Required local gates are green. Hosted qualification is clearly
deferred and does not block this local verdict.

## 7. Workflow, cost control and finish line

Use the established `/workflows` process if available: one production author
owns coupled query-engine interfaces; an independent adversarial reviewer checks
each completed unit on stable source. Parallelize MySQL schema diagnosis,
independent witness preparation and evidence auditing where files and resources
do not overlap. Serialize edits to shared engine owners and all validation.

R1 and R3 share execution concepts; coordinate them through the same production
author. Review real diffs and native outcomes, not only summaries. After repair,
the reviewer verifies the specific finding before the unit closes. Perform one
final integrated review before the expensive frozen gate.

For each unit record: the failing witness, the fact established, its owner, the
second applicable consumer, the actual deletion or “no deletion,” retained cost
and passing evidence. Do not add an abstraction merely to improve this report.

No further product questions are left in this prompt. Continue through ordinary
bounded repairs without asking for preference confirmations. Existing exhausted
repair/redesign budgets and destructive-operation boundaries still apply. If a
hard blocker makes the contract impossible within these boundaries, stop with
**NOT READY**, its minimized evidence and exact missing mechanism; do not invent
a broader architecture, silently reduce the contract or call partial work done.

Completion requires all four units, independent review, truthful concurrency
and progress semantics, registered witnesses, and the frozen local qualification.
Create one task-scoped local Conventional Commit containing only this checkpoint's
audited work. Preserve unrelated files and historical archives. Do not push.

The final report contains only **Outcome**, **Validation**, and **Risks**. State
the commit/source identity, local readiness, resolved behaviors, remaining
approved restrictions, actual cost changes and exact gate results. No pending
D-65 decision, unexplained MySQL reds, silent NULL disconnect or missing final
receipt may be described as engineering complete.

## Reference map — evidence and code, not additional work programs

- [ELEGANCE](../../ELEGANCE.md) and [engine ownership guide](../../src/query-engine/raptor3/AGENTS.md).
- [Current release verdict](raptor3-evidence/g4/release/closure/fc06/release-verdict-draft.md).
- [Rulings, including D-64/D-65](raptor3-evidence/g4.md).
- [NULL-reference repair and residual evidence](raptor3-evidence/g4/release/closure/fc02c/note.md), including `receipts/residual-probe.test.ts.txt` in that directory.
- [Native captured-set schedules](raptor3-evidence/g4/release/closure/fcpg/note.md) and [their test source](../../tests/providers/docker/pg-captured-set-concurrency.test.ts).
- [Provider triage](raptor3-evidence/g4/release/triage/note.md) and [MySQL M1 evidence](raptor3-evidence/g4/release/m1/note.md).
- [Current operation context](../../src/query-engine/raptor3/shared/operation-context.ts), [command execution](../../src/query-engine/raptor3/commands/execution.ts) and [relation construction](../../src/query-engine/raptor3/commands/relation-body.ts).

The earlier closure handoff and unit notes explain how this tree was reached.
Their completed tasks are history, not instructions to implement them again.
