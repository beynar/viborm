# G2.9 — Before G3: one construction path, one dependency owner, seams for what comes next

Date: 2026-09-12. Status: **proposed, not started.** Governed by the
[central plan](./raptor3-implementation-plan.md); this document adds a
checkpoint, it does not change hard requirements, targets, or §8 stop rules.

## 1. Goal and sequencing

Two goals, in priority order:

1. **Repair the proven dependency gap.** Ordinary bodies, selected members and
   choice arms construct one command representation, and one analyzer decides
   dependencies over the exact admitted occurrences that execute, in their
   enclosing ordered scope, before any member effect.
2. **Shape the foundation so G3 families arrive as extensions, not siblings.**
   Bulk, array packaging, suppression and recursion each need a seam that does
   not exist today. Open those seams now, while the affected owners are small,
   instead of discovering them as redesign rounds inside G3.

Run after the current fact-ownership consolidation records its outcome and
before G3-01 or G3-03 begins. Do not interrupt or widen that run. Recheck every
finding below against its final source; several cite line numbers from the
G2.7 identity and will have moved.

This checkpoint changes no public API, supported route, or engine selection.
It does not reopen completed clearability, schema-view, selector, projection or
history work unless a regression is demonstrated. Preserve the historical
acceptance packages and the diagnostic evidence from prep commit `b2daea11`.

**Unit 0 is a freeze, not implementation.** §3 below names owners and shapes
against the G2.7 source. Before any unit is assigned, rewrite §3 against the
consolidation's actual history representation and API, then freeze that text.
A spec written against source that no longer exists is not an assignment.

## 2. Regression witnesses and preserved admission contract

Convert the diagnostic reproduction into maintained, source-bound witnesses.
The failing operation is a nested selected-series mutation whose members create
a ticket, followed by a sibling lookup/update of `"wanted"`.

| Template admission | Actual member admission | Required behavior |
|---|---|---|
| Creates `"wanted"` | Not reached | Existing dependency refusal before SQL |
| Creates `"other"` | Creates `"wanted"` | Refuse before member effects |
| Creates `"other"` | First member creates `"second"`; second creates `"wanted"` | Refuse before either member executes |
| Creates `"other"` | Creates `"other2"`; `"wanted"` exists independently | Successful execution |

The template/member difference **must come from a per-occurrence default or
transform**, the S2 mechanism. Two different raw inputs do not test
template-versus-member admission.

Row 1 freezes a deliberate asymmetry: a template-only conflict still refuses
early even though a real member might not conflict, while a template-only
disjointness result never authorizes a member. Record that as a decision in the
closure, not as an accident of ordering.

Add these witnesses; each names a fact the four rows above cannot:

- **Self-relation series.** Source and target are the same model, so a rule
  keyed on model equality cannot distinguish them. This is the sharpest test of
  "actual occurrence, not model name".
- **Series nested inside a member.** Proves the deferred-dependency retention
  rule: the inner series' relationship stays unresolved until its own capture
  boundary.
- **Member lookup depending on the parent's already-published prefix.** Must
  succeed. Published work is not a pending conflict.
- **Batch refusal after an acknowledged parent prefix.** A distinct public
  outcome from interactive rollback: exact acknowledged progress, no prefix
  replay, no member effect. Pin its progress facts, do not require zero SQL.

Preserve the observed admission contract:

- Template admission and member admission remain distinct where defaults or
  transforms require distinct occurrences.
- Publish the required parent prefix before collection capture and member
  admission.
- Admit and prepare every captured member before executing the first member.
- Construction, dependency analysis and execution share each occurrence's exact
  admitted values.
- Retry retains or replaces evaluated values under the existing contract; the
  repair introduces no extra admission.

## 3. Repairs and seams, by owner

**Keep `Commands` and its mutation constructors as the semantic owners.**
Execution owns capture, bindings, attempts and progress; it invokes the command
owner at the admission boundary and never derives a dependency rule itself.

### 3.1 Dependency analysis runs once over the whole ordered scope

The proven gap, at the G2.7 identity:

- Root analysis includes a template occurrence (`commands.ts:465`).
- Member construction calls `analyze(child)` with no enclosing history
  (`execution.ts:641`), inside the `rows.map` that constructs members one at a
  time. Member N cannot see member N+1, and later siblings were judged against
  the template.

Required shape, stated so it is not patched with a prefix argument: capture all
rows, construct all members, then **resume the enclosing scope's analysis once**
over preceding occurrences, the actual members in order, and following
occurrences. Actual members **replace** the template occurrence in that history.
Both directions are required. For a deferred nested series, retain the
unresolved relationship until that series reaches its own capture boundary.

Use the consolidation's history representation. Do not restore ancestor-prefix
copying, add another syntax walker, a template VM, or a continuation/compiler
framework. Branch-local histories stay local; untaken arms leak neither history
nor refusal; repeated occurrences keep ordering and identity.

### 3.2 Lifetime facts leave prepared commands

`prepareMembers` writes `memberPath` onto prepared command objects via
`Object.assign` and keeps `totalMembers` as an ambient series cursor
(`operation-context.ts:105-116`). Both are attempt/progress facts living in
the prepared-operation region, harmless only because recovery is refused once
member admission starts. Scoped retry inside a series makes both live bugs.
Move them into attempt-owned state keyed by occurrence. No new class.

### 3.3 Output transport is chosen once per operation

`insert`, `update` and `link` each branch three ways on interactive RETURNING,
batch scratch and re-read. Resolve one output strategy at context construction
and have the lowering methods consume it. This is the seam bulk `createMany`,
MySQL no-RETURNING output and array packaging all need; it also removes the
repeated branch structure. Do not add a strategy class hierarchy; a resolved
value with the three operations it supports is enough.

### 3.4 Constraint naming leaves execution

`matchesSelectedConstraint` re-derives `_pkey` / `PRIMARY` / `_key` names in
`execution.ts` and diverges from the shipped `unique-conflict-target.ts` on
name collisions. It gates the only retry the candidate performs. The adapter
owns dialect names; ask it.

### 3.5 One construction path, bounded

Selected members are constructed through the `schema.member` wrapper while roots
use `schema.update`; root and nested upsert build `Choose` in two places and
the interpreter branches on which shape it received. Unify **only what §3.1
touches**: member construction and the `Choose` builder. Remove competing
derivation encountered on that path. Anything further is §3.7.

### 3.6 Deletions that remove a duplicate

Charge and report each: `associate`/`clear` used only by the retired specimen;
junction side-to-field mapping in three places; root `updateMany` bypassing
`complete()`; identity/key selection in three owners. Consolidate helpers only
when the duplicate is a rule, not a line.

### 3.7 Bounded experiment, after acceptance: verbs as rows

`RelationBody.relation()` hand-writes nine verbs as sequences of the same four
primitives: select, require, assign, associate. Plan §10.1 item 5 admits this is
where compression is incomplete. After the checkpoint is accepted, run one
measured experiment expressing each verb as a row over those primitives, with
orientation and storage as operands. Keep it only if the fixed gates pass on
the result and the census shows the reduction. This is a language redesign
round under §8 and is counted as such. It is not an acceptance criterion.

### 3.8 Decision recorded, not implemented: decoding is a table

G4's first read witness must decode through a per-scalar-type table driven by
`Shape`, not per-type copies. Record this now so nobody ports the shipped
parser. No code in this checkpoint.

## 4. Validation and acceptance

Run the §2 matrix and witnesses on interactive SQLite and the supported batch
route. Add focused witnesses for:

- Earlier sibling writes conflicting with an actual member lookup.
- Conflicts introduced only by a later captured member.
- Found and missing choice arms, including an untaken arm.
- Nested series, empty captures, repeated occurrences, disjoint siblings.
- Retry or attempt replacement: default/transform counts unchanged, bindings
  isolated, no stale `memberPath`.
- Concurrent borrowed transactions and the atomic-array refusal, unchanged.
- Failure after parent publication on both routes.

Observe admission events, dispatched statements, failures and final raw state
through the fixture oracle, not through either engine.

Run representative PostgreSQL and MySQL witnesses through the existing native
harness. The SQLite batch model alone does not qualify those providers.

Then run the affected dependency, admission, choice, retry, progress and
composition suites, and the central plan's qualification inventory, on one
stable final source identity. Record the runtime identity; the G2.7 corpora no
longer replay on the current Node. Preserve resource limits.

**Closure requires an index JSON** like every prior checkpoint, with review
fields filled at acceptance. The G2.7 index still reads `pending`; fix that in
the same pass.

## 5. Completion, cost and stop rules

Accept only when the reproduced failures are repaired, the required scenarios
pass, and inspection confirms one construction path and one dependency owner
across the affected placements, plus §3.2 through §3.4 landed.

Report separately: competing rules and interpretation paths deleted; repeated
construction, analysis or copying eliminated; net charged LOC by the same owner
census before and after; preserved behavior, corrected behavior, remaining
limits. Promise no LOC reduction or speedup. Record runtime changes only with
comparable measurements.

Redesign rounds spent here, including §3.7, **count against G3's two-round
budget**. Splitting into units does not reset it. Stop the affected work on any
contract failure; the same minimized failure surviving two repairs returns to
Arnaud. If correction needs another semantic engine, downstream syntax
recovery, a public-contract change or a dropped guarantee, stop and present
the counterexample. Missing evidence blocks acceptance.

## 6. Units

| Unit | Starts after | Sole-owned outcome | Exit |
|---|---|---|---|
| G2.9-00 — freeze | Consolidation closure | Integrator: §3 rewritten against the actual history API; witness inventory classified | Text frozen; no source edits |
| G2.9-01 — witnesses | G2.9-00 | Independent author: §2 matrix and witnesses, legacy oracle green first | Every witness red on the candidate for the stated reason, or green with the reason named |
| G2.9-02 — analysis and construction | G2.9-01 red set | One production writer: §3.1, §3.5, `commands.ts`, `relation-body.ts`, `selection.ts` | Matrix and witnesses green; no prefix-argument patch |
| G2.9-03 — execution seams | G2.9-02 handoff | Same writer: §3.2–3.4, §3.6, `execution.ts`, `operation-context.ts`, adapter seam for constraint names | Lifetime, transport and naming witnesses green; deletions charged |
| G2.9-04 — qualification | G2.9-02/03 | Integrator: native PG/MySQL, suites, inventory, index JSON, census | One identity passes; review fields filled |
| G2.9-05 — verb-table experiment | G2.9-04 accepted | Same writer, separate identity | Kept only on green gates plus measured reduction; otherwise discarded and recorded |
