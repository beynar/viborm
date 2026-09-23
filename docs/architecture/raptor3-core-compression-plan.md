# Raptor 3 shared structure and extension-cost checkpoint

Date: 2026-09-14. Status: **CS-00, CS-01, and the repaired CS-02 unit are
accepted after independent review. The shared CS-03 peer-member scope unit is
accepted. The isolated CS-03 A, B, and A+B comparison is complete; the
occurrence-structure candidate is selected, integrated, and accepted after
complete CS-04 qualification and global review. G3 is next and must extend the
accepted slices rather than rebuild them; public adoption remains separate.** Governed by the
[central plan](./raptor3-implementation-plan.md) §7 and §8. This checkpoint
finishes G2.9 qualification before it changes structure. It then compares one
qualified reference with one bounded structural candidate before G3-01.

## 1. Question and accounting

The checkpoint asks whether construction, dependency analysis, and execution
can consume one ordered occurrence structure without the synchronization
machinery required by parallel command, flattened-history, and observation
representations. It does not assume that the candidate wins.

The pre-qualification references are 6,030 code-bearing lines in the twelve
files under `src/query-engine/raptor3/commands/` and `shared/`, and 10,104
code-bearing lines across the broader 28-owner retained census, using the
existing parser-token-line definition. The final G2.9 identity measures 6,031
and 10,105 respectively; the exact +1 is the reviewed same-owner clearability
condition, not a new abstraction or a compression claim.
The Raptor core is the primary engine-size metric. The broader retained census
stays separate and prevents code movement from becoming false compression.

For the qualified foundation, extension A, extension B, and their composition,
report:

- code-bearing Raptor-core lines;
- actual parser token count and source bytes for the same core, with each
  denominator reported separately from code-bearing lines;
- the separate broader retained-owner code-bearing-line, parser-token-count,
  and source-byte census;
- semantic owners, rules, and exceptions added, removed, or changed;
- actual traversal work at depth and width 1, 2, 8, and 32.

There is no fixed percentage target or automatic veto. File splitting,
minification, moving work outside the count, deleting the comparison specimen,
or removing guarantees is not compression. A larger result is an explicit
trade-off review, not a hidden success.

## 2. Preserved behavior and boundaries

The qualified G2.9 behavior is the reference. Preserve exact admitted values,
template/member admission separation, prepare-all-before-execute timing, first
member and first error priority, logical versus physical order, branch-local
activation, uncached absence, exact membership protection, published-parent
scope, failed-INSERT recovery ownership, acknowledged and uncertain progress,
result identity, concurrent-call isolation, and the existing atomic-array
refusal.

Physical hoisting and execution order remain deliberate. Every captured member
is admitted before any member executes, and the first member and first error
remain authoritative. No arbitrary `conservativePrefix` flag or equivalent
policy switch may replace those facts.

The published-parent exclusion remains exact; it does not become a blanket
permission for member writes. Captured observations and attempt values keep
their existing lifetimes. No public route, API, driver flag, retry policy,
legacy import, new interpreter, universal scheduler, policy-boolean bag, or
downstream admission layer is authorized.

## 3. CS-02 structural candidate

The candidate uses one ordered occurrence identity for each distinct command
placement. Reusing one `Selection` does not merge occurrences, and the same
command object at two placements remains two ordered occurrences. Existing
`Choose` arms own their conditional children. A selected series owns its stable
expansion site. Logical dependency traversal and physical execution traversal
consume the same operation body without pretending their orders are identical.

After reconciliation, each immutable command recipe retains the finalized
publication descriptor: carrier, edge, member, identity, origin, and branch.
The `DependencyWrite` that contains it names the sole current placement
occurrence; the symbolic contribution does not duplicate that runtime owner.
Incremental analysis compares only the necessary new relationships:

- old writes against new reads;
- new writes against new reads;
- new writes against later retained reads.

Cursor or ancestry state may express traversal position, but it cannot become a
second history, scheduler, or registry. The candidate must remove the current
range splice, suffix detach/restore, mirrored branch observations, actual
sibling history copies, and repeated owner scans. Ancestor-prefix copying and
full-root reanalysis were candidate-development mistakes removed before the
qualified comparison; they are not credited as reference deletions. The
candidate must not move any removed mechanism behind another class or closure.

The hard cases include root and nested series, one-arm and two-arm choices,
repeated command placements, generated keys, membership requirements, exact
published-parent behavior, missing rows, acknowledged-prefix failures, and
dynamic member admission. All captured members are admitted before any member
executes. An untaken arm remains inert, and absence remains reobservable.

## 4. CS-03 fair extension comparison

The qualified reference and structural candidate each receive the same
extensions in isolated flat-reference and candidate worktrees. Neither result
may use a production flag, share a hidden second interpreter, or omit the hard
composition cases. Each alternative implementation runs 100 deterministic
seeds per applicable profile for A, B, and A+B.

### Extension A — terminal relation `updateMany` selection

A private relation-bearing root `updateMany({ select })` returns terminal rows
only after every selected member effect completes. Results use final member
keys and reuse the existing `createMany` terminal-reader owner. Qualify compound
and omitted keys, missing rows, progress, and nested choice/series composition.
Do not add scalar-return selection, `omit`, `include`, relation projection, or a
public route.

### Extension B — mutation limits

Qualify scalar set `updateMany`, relation-bearing count `updateMany`, and scalar
set `deleteMany`. A zero limit executes no statement and admits no member, while
ordinary operation admission still occurs. Reuse the adapter's mutation-limit
capability or a complete-key capped subquery. Limit relation capture before
member admission. Do not add a driver flag, public `orderBy`, or legacy-engine
implementation.

### Composition

Limit plus terminal selection, including nested choices and series, must use the
same two extension owners. A third composition path is a failure.

### Comparison outcome

Both alternatives preserve the frozen contracts and replay corpus. The
candidate has no lower marginal extension cost: A+B adds 109 core lines versus
100 on the reference. The final same-owner cleanup and placement repair,
relative to the already scope-corrected candidate, nets 0 lines, -89 parser
tokens, and -81 bytes; the structural foundation still has a 417-line premium
over the scoped reference foundation.
Its complete endpoint is 6,598 core lines versus 6,172, and 10,672 broader
retained-owner lines versus 10,246, a 426-line gap in both scopes. Selection is
instead based on one placement-owned occurrence topology,
the removal of the reference owner scan and administrative history copies, and
the measured reduction in repeated dependency work. Candidate construction,
publication, and navigation overhead remains explicit evidence; it is not
reported as compression or a runtime speedup.

## 5. Units and order

| Unit | Starts after | Outcome | Exit |
| --- | --- | --- | --- |
| **CS-00 — qualified reference freeze** | Accepted G2.9-03 | Record the approved malformed-result/progress contracts and exact cost decision; complete G2.9 qualification; recount the core and broader census | One reviewed G2.9 identity and complete evidence package; no structural production change |
| **CS-01 — witness freeze** | Accepted CS-00 | Freeze existing and missing combined structural witnesses, extension A/B/composition contracts, metrics, and isolated-worktree recipe | Independent review accepts the red-capable contracts and fair comparison boundary |
| **CS-02 — one occurrence structure** | Accepted CS-01 | Implement the bounded structural candidate and delete the named synchronization mechanisms | Candidate preserves the frozen behavior, reports exact work/count changes, and passes independent review, or is rejected without weakening the reference |
| **CS-03 — isolated extension comparison** | Accepted CS-02 | Implement A, B, and A+B independently on the qualified reference and candidate; run 100 deterministic seeds per applicable profile on each | Comparable semantics, code, owner, and traversal evidence supports a choice; no production switch |
| **CS-04 — qualification and decision** | Accepted CS-03 | Qualify the selected private implementation and extension slices, update the G3 handoff, and record the rejected alternative | Full providers, campaigns, replay, types, structure, cost, archive, independent review, and root review pass before a scoped local commit; no push |

Do not begin CS-01 until CS-00 passes independent review. Do not begin CS-02
production work until its witnesses freeze. Do not integrate an extension
during the comparison. A selected candidate and its extension slices count as
partial G3 work; G3 public integration and cutover remain separate.

## 6. Qualification and stop rules

CS-00 and CS-04 use the complete G2.9 inventory: local fixed and comparison
gates, isolated PGlite lanes, native PostgreSQL/MySQL modes, all four campaigns,
fresh saved replay, historical compatibility probes, harness and CLI self-tests,
typecheck, structure, cost, source-bound archive, independent review, and root
review under the existing Node 24.21.0 resource ceilings.

The existing repair and redesign budgets carry forward; unit labels do not
reset them. CS-02 consumes the next existing G3 structural round. A new public
contract, recovery rule, compatibility decision, additional architectural
representation, exhausted repair budget, missing required evidence, or the same
minimized failure after two repairs stops for Arnaud. A failed candidate leaves
the qualified reference and its evidence intact. Only real mechanism deletion
and fair measured extension cost can justify selection.
