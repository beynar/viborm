# Raptor 3 — central implementation plan

Status updated 2026-09-14. **The shared-occurrence foundation is accepted;
G3 is next, followed by G4 and separately authorized cutover.** This document
owns future implementation order, acceptance gates and autonomous-work limits.
It contains current instructions, not completed-stage assignments.

Start from the accepted [CS-04 checkpoint](raptor3-evidence/core-structure/cs04-root-acceptance.md):
production `36103eff…`, harness `87bc63c2…`, Node 24.21.0, **6,598 core /
10,672 complete charged code-bearing LOC**. These are the frozen checkpoint
figures, not an assertion that later working-tree changes share its identity.
The measured 426-line premium over the equivalent flat reference was accepted
for ownership gains; no marginal extension-cost, bundle or runtime saving was
demonstrated.

The [private architecture guide](../../src/query-engine/raptor3/AGENTS.md)
describes the implemented owners. The [feature inventory](raptor3-evidence/g3-prep-inventory.md)
is the coverage source; its original candidate-status column is a baseline,
not a current completion percentage. Reconcile it with accepted slices before
assigning remaining work. Completed experiments, compatibility decisions and
receipts remain in the [evidence ledger](raptor3-evidence/core-structure.md)
and linked records. Earlier plan text remains in Git history.

Distinguish **hard adoption requirements**, **size targets**, and **limits on
autonomous experimentation**. Keep frozen measurements and decisions unchanged.
A missed target remains missed even when Arnaud accepts the trade-off.
Changing a hard requirement needs a separate decision. Completed checkpoints
do not waive future exits or authorize public cutover.

## 1. Outcome and hard boundaries

Replace the complete query/write engine with a smaller system language that
expresses the same required behavior through composition and derivation.
Nothing in the current engine is entitled to survive. An owner may be reused
only when its responsibility is independently necessary and its cost remains
visible. The objective is fewer independently maintained semantic rules, less
code, a smaller shipped engine, and no material performance regression—not
shorter names, denser formatting, or a tiny interpreter hiding a large compiler.

Preserve:

- The public query and fluent schema APIs, inferred types, aggregate `s`
  ergonomics, zero user code generation, and current supported capabilities.
- Correct targets, complete compound keys, mapped fields, variants, scalar
  codecs, effects, public results, admission/refusal behavior, and errors.
- Validation/default timing, selected-arm behavior, exact generated outputs,
  transaction and segment guarantees, bounded retries, and committed progress.
- Extensions, raw SQL, result ownership, caching boundaries, parameterization,
  SQL qualification, scalar/bulk fast paths, and provider support claims.

Do not broaden this into a schema API redesign, dependency-pruning project,
migration rewrite, new public execution API, or release. The deferred
[recursive-query feature](../../features-docs/recursive-query.md) is a design
witness, not an additional feature to ship during replacement. Do not weaken
existing refusals without a separately approved compatibility decision.

The old engine remains the public route throughout G3/G4 verification. The
candidate has a private test entry and its own compiler, lowering, runner, and
projection path. No fallback to the old engine for an unsupported candidate
case: it must fail the gate visibly. Do not mix old and new execution inside
one public operation.

## 2. Shared laws before implementation form

The accepted representation is structured commands with exact producer
references, one placement-owned occurrence structure, composed execution
owners and ordinary recursion. Construction records admitted meaning;
targeted analysis derives only facts construction cannot establish.
These laws govern extensions:

1. Scoped queries produce shaped values; only addressable record occurrences
   carry row/reference identity. Association views supply shared correlation.
2. Record changes collect assignments and publish successful outputs.
3. Association edits translate through row-reference or junction storage.
4. Exact producer references derive demands, availability, and dependencies.
5. Alternatives, body instantiation, ordered repetition, and scopes express
   choice and time without a compiler per position, member, or depth.
6. Requirements state which observations must remain true at use; physical
   lowering enforces them through actual provider capabilities.

Public verbs expand once per admitted body instance. Storage and execution
consume that expansion; they do not reconstruct `connectOrCreate`, `upsert`,
or other public algorithms.
Any required analysis consumes the same semantic structure that executes, not
a second walk over public mutation syntax. Construction may establish a fact
directly; do not derive and store it again in a mandatory analysis pass. The
runner has a state machine for execution/recovery, not one per relation verb.

**Reuse the body, not its evaluated occurrences.** Repetition binds each selected
occurrence to the same body construction. The existing admission owner evaluates
that instance at the contractually required time, then construction, analysis
and execution use its exact trusted values. A template's earlier dependency
answer cannot authorize an instance whose defaults differ. Retry does not imply
fresh admission: retain evaluated values wherever the existing contract does.
This is ordinary scoped instantiation, not a `SeriesCompiler`, second parser,
template VM, or per-member handler. Preserve inspectable deferred structure where
batch admission needs it; opaque callbacks cannot hide future effects.

**An output shape is not a record identity.** Query expressions own their output
fields/expressions, cardinality, codecs and correlation scope. Grouped values
use that shape without fake record keys; per-parent pagination is the ordinary
page operator inside each parent's correlation scope. Addressable records add
the exact row/reference meaning required by mutation. Do not force every value
through an all-optional universal binding or create an aggregate-only engine.
Pure reads use the same query/projection owners without allocating write work.

These distinctions must reduce independent rules. When a witness breaks the
design, first identify the fact the current owner lacks and extend or compose
that owner. Demonstrate the repaired law in another applicable position or
storage orientation. A new concept needs a requirement that existing owners
cannot express coherently; a new test case alone does not earn a node, flag,
subclass, registry, pass, or handler. Inspectable structure is necessary where
planning needs it, but a universal graph or arbitrary constraint solver is not.
Legitimate choice, storage and provider-capability branches remain with their
single owners; **the ban is on duplicated semantic algorithms, not branching**.

### 2.1 One broad context, composed classes

Use **one `OperationContext` per logical public operation**, injected once into
its collaborators. This is deliberately a broad owner: components can reach
schema facts, prepared commands, physical capabilities, and execution services
without forwarding them through every function call.

Use the implemented owners, not speculative class placeholders. Keep cohesive
responsibilities together until a demonstrated boundary requires a change.
No worker receives a new class merely to enable parallelism.

| Owner | Responsibility |
| --- | --- |
| `OperationContext` | Per-call execution binding, transport, progress and provider mutation lowering |
| `Commands` | Command construction, occurrence materialization and same-structure dependency analysis |
| `RelationBody` | One parent's admitted relation recipes, resolved slot and supplier continuation |
| `Assignments` / `Selection` | Symbolic field contributions and demands / stable selection instructions and requirements |
| `CommandExecution` | Recursive interpretation of command occurrences |
| `CommandAttempt` / `TransportAttempt` | Replaceable observations and bindings / pending statements and dispatch evidence |
| `Queries` | Prepared selectors, dependency facts, projection, adapter-composed SQL and decoding |
| `EngineSchema` | Factory-lifetime schema admission and immutable resolved schema views |

Query/effect nodes remain closed, inspectable typed values where their consumers
need structure. A class may own construction or interpretation; a node does not
need a class solely because it has a name. Ordinary local functions remain
available. No preliminary template/instance class hierarchy is prescribed.

Composition is the default. Use inheritance only for actual substitutable
implementations sharing a demonstrated invariant. Resolved storage and
orientation remain schema facts, not a reason to create a relation-storage
class hierarchy. Do not build a subclass for each public verb × storage ×
fresh/selected × provider combination, or a universal base merely for `ctx`.

Methods still take their actual operands: a query, record occurrence, or change.
The preference is **no infrastructure-parameter cascade**, not “zero parameters
at any cost.” Do not replace meaningful operands with ambient `currentModel`,
`currentParent`, or `currentResult` fields.

### 2.2 One context does not mean one lifetime

The context owns these regions through composition. They are not additional
parameter bags to thread down the tree.

| Region                | Survives                                        | Must not contain                                                      |
| --------------------- | ----------------------------------------------- | --------------------------------------------------------------------- |
| Prepared operation    | Retries of that operation                       | Accidental default re-evaluation, a mutable copy of relation topology |
| Execution attempt     | Only its permitted replay region                | Acknowledged progress from previous commits                           |
| Record/scope frame    | Its lexical record or scoped body               | A process-wide or sibling-wide current-parent cursor                  |
| Acknowledged progress | Attempt replacement; until operation completion | Guesses that an unacknowledged commit did not happen                  |

Read shared facts by reference. Mutations go through the owning component's
methods, not arbitrary writes from every child. Preserve the existing explicit
dispatch, rejection and acknowledged/uncertain-progress facts; do not impose
another universal attempt-status enum or a Cartesian product of policy flags.
Retry eligibility is derived at its current owner from error, scope and outcome.

Stable does not mean eager: preserve the current validation and default boundary
for each record/member, including deferred series preparation and required
validation of both conditional arms. Retain values once that boundary evaluates
them; do not pre-evaluate a later member simply to fill the context. Compose
collaborators when their responsibility is needed, rather than allocating an
unused subsystem for every read. Measure the resulting allocation cost.

Committed segments are not reset when an attempt is discarded. A pending
completion belongs to the attempt that dispatched it; it cannot publish into
a successor. Do not begin a successor while an unresolved old dispatch could
still mutate the same replay region. Apply the existing transport's proven
cancellation/settlement rules, or report the unresolved outcome.

Nested construction holds its own record occurrence, not a temporarily changed
global cursor. Concurrent public calls have separate contexts. Operations in
an array/callback transaction borrow its real transaction owner but do not share
scratch state. They do not independently commit a borrowed transaction. No
context pool or singleton mutable context is authorized.

Required falsifiers: sibling interleaving, two concurrent public calls, nested
failure/unwind, retry after capture, late completion, observer re-entry, and a
failed segment after an acknowledged prefix. Context convenience is accepted
only with these lifetime boundaries intact.

### 2.3 Validate at admission; trust the engine's arguments

**The engine consumes validated payloads. Its internal arguments and constructed
program values are trusted, not treated as hostile input at every call.** Reuse
the existing validation owner at the highest applicable admission boundary,
before work enters the trusted subtree. Do not add another parser just because
the candidate has a new entry point, class, or execution phase.

Preserve the existing timing of deferred member preparation and defaults: each
member becomes trusted when its owning admission boundary prepares it. "Validate
high in the tree" does not mean eagerly evaluating all later members or parsing
an already transformed value again. Resolved schema facts are likewise trusted;
consumers do not rescan or revalidate the schema.

**Adjudicated admission contract (2026-09-08): one evaluation per admitted
input.** Arnaud explicitly chose this over preserving the shipped update path's
observed duplicate scalar-transform calls. An actual member occurrence still
owns its deferred admission, but replaying that occurrence does not admit it
again. Keep the old engine's measured ledger as baseline evidence and pin the
new ledger independently; do not hide the difference in a global comparator or
change the shipped engine as part of this private rewrite.

**Adjudicated recovery contract (2026-09-08): exact failed-INSERT ownership.**
Arnaud chose to reject recovery when another nested branch merely shares the
failed unique constraint. Native PostgreSQL evidence shows the shipped engine
repeating that unrelated missing lookup and failing INSERT. Preserve its exact
two-attempt baseline trace; require one attempt from the candidate. Only the
actual failed producer may justify recovery, within the existing lifetime and
commit boundaries. The shipped engine remains unchanged.

Inside that trusted region:

- Accept the existing parsed types and access their fields directly. Do not
  repeat object/array/type/property checks, key-presence assertions, or schema
  parsing to defend against arguments that violate the caller's contract.
- Trust the builder's program, the parent's arguments, and the context's owned
  state. No blanket `validateProgram`, `validateContext`, or per-helper argument
  validator. Put a real invariant in its single owner, preferably establish it
  through construction/control flow, and let consumers use that fact.
- Do not add empty fallbacks, optional-chaining cascades, or catch-and-return
  behavior to accommodate impossible internal shapes. Bugs must remain visible.
- Ordinary branching over valid alternatives is still necessary. A switch on
  an admitted operation or a legitimate optional value is semantic dispatch,
  not defensive validation. Do not enforce this policy with a blanket syntax
  ban on `typeof`, `Array.isArray`, or conditionals.

**Localized TypeScript assertions are allowed.** Use `as` or a non-null assertion
when an upstream admission rule, constructor, or control-flow invariant already
establishes the fact but TypeScript cannot retain the correlation. Keep strict
typing; make the assertion narrow and its justification evident from the owner
or a brief note when non-obvious. Do not introduce runtime checks, wrapper
classes, or elaborate generic machinery solely to avoid an honest assertion.
An assertion does not establish a missing fact or turn external `unknown` into
validated data. This explicit instruction supersedes the older blanket
"no type assertions" guidance for the candidate.

The distinction is **input shape versus facts not established by input
validation**. Provider rows/errors are a new external boundary and are admitted
once by their existing result/error owner; decoded values are trusted below
that point. Database existence, membership, occupancy, uniqueness, affected-row
expectations, transaction outcomes, and concurrency premises are execution
semantics, not redundant payload checks. Keep their necessary enforcement in
the single semantic owner. Existing raw/extension trust-boundary protections
remain at their actual boundaries, not copied into every engine helper.

Every work-unit review rejects duplicated validation in trusted code: name the new trust boundary or the
independent invariant a check owns, or remove it. This is a review rule, not a
new runtime validation framework or an assertion-registry subsystem.

## 3. Evidence artifacts — extend the existing harness

Extend the existing `tests/raptor3/` harness and bounded runners. Do not
recreate the recorder/replayer, overwrite the Pattern experiment, or treat
historical receipts as proof for changed source.

| Artifact                                     | Required content                                                                                                                                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/raptor3/contracts.ts`                 | Stable witness IDs; public inputs; initial world; required result/state/error/order properties; relevant profiles; source witnesses; earliest milestone                                                                                                                   |
| `tests/raptor3/profiles.ts`                  | Admitted real capability profiles, supported/refused cases, oracle lane, and release-required versus preview classification                                                                                                                                               |
| `tests/raptor3/harness/`                     | Public-call entry for each engine, outcome recorder/comparator, deterministic scheduler, transport fixtures, replay and shrink support                                                                                                                                    |
| `tests/raptor3/scenarios/`                   | Handwritten witnesses and independent, seeded scenario generation                                                                                                                                                                                                         |
| `tests/raptor3/regressions/`                 | Minimized counterexamples, expected failures/properties, and replay metadata                                                                                                                                                                                              |
| `scripts/raptor3-manifest.mjs`               | Exact test admission, campaign seed ranges, required cases/faults/profiles, and resource bounds                                                                                                                                                                           |
| `docs/architecture/raptor3-evidence/g0.json` | Baseline identities, source-accounting manifest, tool versions, package fixtures, performance workloads, frozen targets and adoption budgets                                                                                                                              |
| `docs/architecture/raptor3-evidence/gN.md` | G3/G4 unit and milestone results: identities, witnesses, decisions, costs, failures and exact replay evidence; retain historical receipts unchanged |

The baseline identity includes the exact source revision and a content-hash
manifest of any explicitly included working-tree changes. Preserve unrelated
work. Do not freeze “whatever happens to be HEAD later,” stash user changes, or
silently bless a dirty baseline as a clean benchmark revision. Do not include
environment secrets in archives or reports.

Complete each milestone's remaining test/cell classification before widening
implementation. Use the accepted inventory and source-bound evidence, not
completed-stage labels alone.
For mixed tests, record the extracted invariant and its replacement witness;
retain the old pin until that replacement detects the relevant fault. The old
engine is a differential oracle, **not an infallible specification**. A suspected
old-engine bug is a disputed contract row: stop that row, demonstrate it, and
seek a decision. Do not teach the new engine the bug or silently correct it.

Compare the shipped engine ownership closure, not a raw directory count.
The accepted [source-accounting report](raptor3-evidence/core-structure/cs04-qualification/support/query-engine-cost.json)
charges 52,986 code-bearing lines to the shipped engine. Experiments, tests,
and unchanged external boundaries are not compression credit. Count retained
owners, integration, new dependencies and moved code under the same scope.

## 4. Contract matrix: what must become executable

Each row below is a family, not one test. Retain the existing witness IDs; the
evidence owner enumerates the remaining cells before their milestone expands.
A cell is an input/world/profile/property combination, not a
SQL-field difference. Explicitly mark impossible combinations with their
schema/capability reason; an unexpected runtime skip does not satisfy a cell.

| ID  | Required family and distinguishing witnesses                                                                                                            | Remaining obligation | Existing evidence to start from                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01 | Root/nested reads; NULL/absence/multiplicity; mapped and compound fields; nested selection of the same model                                            | Complete in G4 | [Read contracts](../../tests/contracts/engine/query/operation-equivalence-oracles.core.test.ts)                                                                                                                                                                         |
| C02 | Fresh/selected roots; create/update/connect/COC/upsert; found/missing/foreign target; both FK orientations and junctions                                | Retain; qualify G3/G4 composition | [Upsert arms](../../tests/contracts/engine/write/parity-b-upsert-arm.core.test.ts), [untaken-arm legality](../../tests/contracts/engine/write/upsert-untaken-arm-legality.test.ts)                                                                                      |
| C03 | One final root assignment; conflicting contributions; no transient NULL; single and compound reference tuples                                           | Retain; qualify G3/G4 composition | [Assignment contract](../../tests/contracts/engine/write/final-root-assignment.core.test.ts)                                                                                                                                                                            |
| C04 | Generated output is successful, exact, and destination-decoded; input values cannot impersonate stored output                                           | Complete transport composition in G3 | [Output boundary](../../tests/contracts/engine/write/generated-output-boundary.core.test.ts), [continuation race](../../tests/contracts/engine/write/generated-output-continuation-race.test.ts)                                                                        |
| C05 | Before/after row and reference keys; cascade/restrict; a decoy takes the former unique key                                                              | Retain key-transition regressions | [Key transition](../../tests/contracts/engine/write/compiled-key-transition.test.ts), [stale capture](../../tests/contracts/engine/write/staleness-injection-upsert-capture.test.ts)                                                                                    |
| C06 | Singular transfer, disconnect, delete, set, clear/refill, required/optional membership, fixed/variant storage                                           | Retain membership-transition regressions | [To-one lattice](../../tests/contracts/engine/write/parity-h-to-one-lattice.core.test.ts), [transition contract](../../tests/contracts/engine/write/parity-d-transition.core.test.ts)                                                                                   |
| C07 | Supply before modify; earlier own effects invalidate proofs; equal expressions are not automatically equal stored values                                | Retain dependency/admission regressions | [Own-write linearization](../../tests/contracts/engine/write/own-write-linearization.test.ts), [nested-write contract](../content/docs/client/nested-writes.mdx)                                                                                                        |
| C08 | Scalar bulk stays set-oriented; relation-bearing bulk preserves ordered bodies, counts, default timing, bind limits, and result reads                   | Complete in G3 | [Create-many](../../tests/contracts/engine/write/parity-j-create-many.core.test.ts), [series defaults](../../tests/contracts/engine/write/update-many-relation-series-behavior.ts), [series result](../../tests/contracts/engine/write/series-result-read.core.test.ts) |
| C09 | Skip owns its subtree; already supplied prerequisites cannot leak; exact permitted unique-race recovery only                                            | Complete in G3 | [Junction adoption/skip](../../tests/contracts/engine/write/junction-skip-adoption.test.ts), [generated-output segment](../../tests/contracts/engine/write/generated-output-segment-contract.core.test.ts)                                                              |
| C10 | Atomic callback/array transaction versus committed segments; failure after dispatch, after commit, and during decode; cleanup preserves primary failure | Complete in G3/G4 | [Transactions](../content/docs/client/transactions.mdx), [D1](../content/docs/drivers/sqlite/d1.mdx), [progressive row key](../../tests/contracts/engine/write/progressive-parent-rowkey.test.ts)                                                                       |
| C11 | Self-relations, nested recursion, ancestor re-entry, repeated occurrences, current dependency refusals                                                  | Complete in G3 | [Compatibility](../content/docs/client/compatibility.mdx), [recursive-query proposal](../../features-docs/recursive-query.md)                                                                                                                                           |
| C12 | Full filters/order/page/group/aggregate/projection; malformed provider rows; fresh public containers and exact scalar codecs                            | Complete in G4 | [Parser contract](../../tests/contracts/engine/query/result-parser-contracts.core.test.ts), [read traversal](../../tests/contracts/engine/query/read-traversal-byte-pins.core.test.ts)                                                                                  |
| C13 | Validation/transform/default phases, request/query/statement/observer lifecycle, cache/raw exclusions, contextual public types                          | Complete in G4 | [Boundary contracts](../../AGENTS.md), [extensions](../content/docs/extensions/index.mdx), [public typing gate](../../tests/types/client/contextual-typing-gate.core.types.ts)                                                                                          |

Cross-cutting dimensions: one/many and optional/required slots, fixed/variant
targets, both FK orientations/junction storage, fresh/selected source,
single/compound/mapped keys, found/missing/foreign targets, selected/unselected
arms, known/generated/opaque values, and real transport capabilities. Do not
assert that every combination is legal. Do not use only all-found/all-missing
worlds: seed competing rows and unrelated memberships that must remain untouched.

## 5. DST is the main exploration method; TDD supplies pinned witnesses

Here DST means **deterministic simulation testing**, not merely seeded payload
generation. It controls the nondeterministic boundaries of the code under test,
records the schedule, injects admissible failures, and reproduces the same run.
FoundationDB's testing design combines actual implementation code, controlled
time/I/O/randomness, workload assertions, and fault injection; its paper also
states simulation's limits for performance and outside dependencies.
[FoundationDB, §4](https://www.foundationdb.org/files/fdb-paper.pdf)

For this ORM, do not recreate a database server in the test harness. Use the
three lanes below and state exactly what each proves. TDD is complementary:
write a failing contract witness for each feature or minimized DST failure,
then keep it as a fast regression. Do not spend the rewrite testing private
methods one by one.

### 5.1 Harness acceptance before engine acceptance

Database-state correctness uses real isolated SQL execution and independent
state/result expectations. Compile equality, scripted responses or synthetic
rows cannot substitute for that oracle.

Prove the harness for the claims being made, then extend it with the engine.
The same recorder, comparator and replay format serve every stage; this is not
a preliminary harness that will be replaced by a general one.

| Due before acceptance                               | Required harness evidence                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retained harness regression | Retain old-versus-old calibration worlds through public admission and real SQLite, including success, refusal and rollback on interactive/restricted-batch profiles. Controlled defaults and sequence state remain observable. Independently injected wrong-row/missing writes, changed values/errors, and a rolled-back effect leak fail the assembled gate. |
| Retained harness regression | Each saved success/failure schedule replays three times; an uncontrolled-event specimen fails. Zero-case selection, missing required profile/case, timeout, harness exception, swallowed failure and stale evidence fail the command. A split/atomic specimen proves §5.4's fault-cut classification.                                                      |
| Retained harness regression | Independent seeded operation/world choices within fixed schema families and bounded shrinking work. A padded failure shrinks, retains its property and replays; keep the original. Untaken-branch publication, stale attempt publication and nonterminating recovery are detected before their candidate guarantees are accepted.                          |
| Before accepting the corresponding G3/G4 capability | Add composed falsifiers for skipped-subtree publication, acknowledged-prefix replay, commit/ack ambiguity and missing lifecycle events. Extend fault generation/shrinking to these same observations. By G4 every §5.4 family has its applicable self-test and real-provider evidence.                                                                     |

Mutate test specimens or the observed test world, never tracked production
files. A malformed internal program is not a harness specimen. No required cell
may be skipped, and SQL differences cannot filter execution. Unknown transport
responses/events fail rather than producing `[]` or `rowCount: 1`. A capability
whose oracle is not ready remains unverified; a staged harness is not a waiver.

Malformed user payloads enter through public admission; malformed provider rows
enter through the provider-result boundary. Do not manufacture invalid internal
programs, demand graceful shape errors from trusted helpers, and then add
defensive validators just to satisfy those tests. Internal composition is
checked through its real behavior and the owning invariant's witness.

### 5.2 Three evidence lanes

| Lane                                    | Run                                                                                                                                                                            | Proves / does not prove                                                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — deterministic transport simulation  | Real candidate runner; seeded completion queue, virtual clock, explicit response/fault fixtures for legal transaction/batch/progress protocols                                 | Attempt/progress/ownership/error/liveness logic. Does **not** prove SQL predicates, constraints, or PostgreSQL/MySQL isolation. Every response must be explicit.                                           |
| B — end-to-end boundary DST             | Each engine's real public path, SQL lowering, execution and parsing over real in-process SQLite; schedule driver completions and admitted external mutations deterministically | Actual row effects, constraints and results for the SQLite profile, plus controlled ORM scheduling. No mock SQL evaluator. Does **not** simulate arbitrary DB-internal interleavings or hosted transports. |
| C — real-provider conformance and races | Public operations against the actual providers; barrier-controlled races and provider errors; isolated equivalent initial worlds                                               | Actual dialect/storage/transport contracts. These are controlled integration tests, **not** claimed to be fully deterministic simulations.                                                                 |

In B, start with a connection-owned SQLite world and serialize transaction
leases correctly. Never interleave an unrelated request's SQL into another
request's transaction merely because the harness has one connection. External
mutations can run between committed observations and the later batch; races
requiring simultaneous live transactions belong in C. Batch-only and
ordered-acknowledgement SQLite wrappers must execute real atomic batches and
are labeled **restricted transport models**, not D1 provider evidence.

Use the installed SQLite provider; no new database/parser/testing dependency
without a separate decision. Run real PostgreSQL evidence through the existing
PGlite estate and real concurrent PostgreSQL connections where needed. MySQL
must execute on MySQL. Required hosted provider lanes must execute before
cutover; an unavailable credential/service blocks that gate, it does not grant
a simulation-based waiver. Keep existing preview qualifications.

The independent oracle is a set of named contract properties and small
fixture-specific outcome models, not another full ORM. It must not import the
candidate's recipes, analyses, lowering, or projection to manufacture expected
answers. The legacy engine is an additional check. Sharing seeded inputs and
wire encoders is acceptable; sharing the disputed semantic implementation is
not independent evidence. Keep test-infrastructure LOC visible separately.

Seed and inspect authoritative persisted state through fixture-owned raw SQL
on the provider, outside both engines' query/projection paths. Include complete
keys, decoys and untouched memberships. Public reads remain outputs under test,
not their own storage oracle. A write/read pair sharing the same wrong mapping
must not make a run pass. This is a small fixture boundary, not a SQL interpreter.

### 5.3 What is compared

Record and assert:

- Public values, counts, ordering/multiplicity, scalar runtime types, and
  affected **and untouched** database rows/memberships.
- Error class, code, required message/metadata and attribution, precedence,
  failure timing, and primary/secondary failure preservation.
- Required causal effects: final FK assignment, supply before modify,
  clear/refill, chosen-arm effects, output publication and subtree suppression.
- Transaction rollback, exact acknowledged progress, unresolved commit status,
  legitimate retry scope and termination, defaults/transforms evaluation count.
- Contractual extension lifecycle and result ownership/aliasing behavior.

SQL bytes, private step IDs, temporary aliases, and the total number of private
steps are diagnostic unless a contract specifically observes them. Physical
statement changes still require review for triggers, constraints, statement
transforms, locking, and promised round trips. Do not sort away observable order
or normalize real generated keys. Alpha-renaming is permitted only for proven
private identifiers using a bijection that preserves their relationships.

In a race, two correct implementations can have different legal winners. Check
each history against the **same admitted outcomes and provider isolation
contract**, not one engine's accidental winner or universal serializability.
For deterministic single-operation cases, require exact semantic equality.

### 5.4 Scenario and schedule protocol

Generate world/public-operation/schedule choices independently of either
engine's internal program, starting within fixed schema families. Add general
schema generation only when repeated concrete fixtures justify it; it is not a
prerequisite for another foundation stage. Keep fixed adversarial witnesses beside generated cases.
Valid mode must reach the intended admitted capability; invalid mode
must fail at the required boundary. Validation rejection of a supposedly valid
case is a generator failure, not a successful fuzz run.

Bound generated worlds to 1–4 models, at most 3 relation slots per model,
1–3 key fields, at most 8 initial rows per model, nested depth 0–4, and nested
fan-out 0–3, subject to each milestone's admitted shapes. Explicit bulk/bind-limit
and depth-32 witnesses run separately from those random bounds. These limits
bound test cost, not the public API. Server-clock or nondeterministic SQL
expressions outside harness control require a named invariant-based provider
test; do not count them as deterministic replays by erasing their returned values.

A replay artifact contains: baseline/candidate/harness hashes, schema and
initial rows including sequence state, public inputs, controlled clock/random
tapes, capability profile/provider version, actor/event schedule, injected
faults, raw diagnostic traces, normalized observations, and failed witness ID.
Only generated non-secret fixtures go into checked-in regressions.

Use scenario-level barriers such as “A observed target K; B moves that target;
A resumes,” not “throw on statement 7 in both engines.” Physical lowering can
change or remove boundaries. Define the required semantic property once, then
identify each implementation's eligible fault cuts from its actual trace and
provider semantics. Record a cut as reached, unexpectedly missing, or absent
because an evidenced atomic strategy prevents that interleaving. The last case
requires the concrete strategy/trace and the same property checked at its legal
surrounding cuts; statement count alone proves nothing about isolation.

An unexpectedly missing cut fails coverage. An eliminated cut is not counted as
an injected interleaving, and cannot waive the property's acceptance. Test this
once in the harness with equivalent split/atomic specimens and an intentionally
missing eligible barrier. Do not add per-verb exemptions, an engine `isAtomic`
flag, or fake legacy steps. Extra physical cuts use the same contract oracle.

Minimum fault families, wherever admitted by the profile:

- Capture-to-use staleness, conflicting insert with exact constraint evidence,
  unrelated unique failure, timeout/deadlock, and disconnect.
- Failure before dispatch, after an effect but before commit, after actual
  commit but before reliable acknowledgement, and after acknowledgement before
  decoding. The provider outcome and the client's knowledge are separate facts.
- Guard failure, malformed/truncated provider results, primary plus cleanup
  failure, late completion from a discarded attempt, and nested skip failure.
- Multiple faults followed by a healthy suffix: stop injecting and fairly
  release pending work, then require success **or the specified terminal error**
  within the existing retry limit. No invented infinite eventual-success promise.

Shrinking removes operations, actors, nested branches, rows/decoys, scalar
complexity, and schedule/fault events while retaining admission and the failed
property. Try the small counterexample through a real provider when it concerns
SQL, constraints, or isolation. No SQL compiler is added to the simulator.

### 5.5 Finite campaign budgets

These are minimum exploration budgets in addition to mandatory witness/fault
coverage. A seed count is not a correctness proof.

| Gate                     |           New seed IDs per admitted lane/profile | Operations per scenario | Scheduled completions limit |
| ------------------------ | -----------------------------------------------: | ----------------------: | --------------------------: |
| G3 scopes/bulk           |                                           10,000 |                    1–32 |                      10,000 |
| G4 final                 |                                           25,000 |                    1–32 |                      10,000 |

The seed axis controls scenario generation and event choices. For G3/G4, at
least 20% of generated scenarios have two logical actors and at least 20%
contain a legal fault. Required multi-fault/healthy-suffix witnesses run explicitly regardless
of random frequency. Campaign counts apply to A/B, not 25,000 hosted-provider
requests; C runs the complete required provider contracts and named races.

Freeze disjoint ranges per gate in the manifest. Replaying an old seed does not
count as a new seed. Required scenario properties must all be checked and every
eligible fault cut reached; eliminated cuts need §5.4's evidence. A timeout,
event-limit exhaustion, or unexpectedly missing eligible barrier fails the gate;
it is not trimmed from the denominator. Reduce and diagnose it.

Use finite serial batches of at most 100 seeds per child process, a 120-second
wall limit per batch, and the existing verification resource policy. Fail on an
incomplete batch and record its completed IDs. Long campaigns may resume from
verified receipts, but only receipts with matching code/manifest hashes count.
Changing code requires rerunning the affected gate, not resuming stale success.

## 6. Work packages and exact milestone exits

Every milestone report contains the source hashes, completed witness IDs,
required/executed/skipped counts, mutation/replay results, production/test LOC,
bundle/performance evidence available at that stage, unresolved divergences,
structural evidence, and the explicit decision. Report hard requirements as
pass/fail/blocked and size targets as met/missed. A target miss requires review
under §8; it cannot be hidden inside an overall green result.

### G3 — Scopes, series, recursive composition

Each G3 unit applies §7's **decision-elimination gate** before implementation
and at independent review. Extend the accepted structure; this gate does not
authorize another foundation checkpoint or reset any repair/redesign budget.

Complete C08–C11 by extending the accepted CS-04 source, including its
preparation, dependency, terminal-result and mutation-limit slices. Preserve
their source-bound regression evidence; do not restart from an earlier G2.7
or G3-preparation snapshot. `EngineSchema` remains factory-scoped; each call
receives one `OperationContext`; admitted command definitions and operation facts remain
outside the replaceable command/transport attempts. Do not add another schema
factory, context lifetime, attempt journal, owner hierarchy, or interpreter.

The current production owners are exact:

- `src/query-engine/raptor3/commands/commands.ts`, `relation-body.ts`,
  `assignments.ts`, and `selection.ts` own construction, same-tree analysis,
  ordinary relation bodies, field provenance, and stable selections.
- `src/query-engine/raptor3/commands/execution.ts` owns recursive command
  execution, the shared selected series, and exact failed-INSERT recovery.
  `src/query-engine/raptor3/shared/operation-context.ts` owns the selected
  driver, physical dispatch, batch scratch, acknowledged segments, progress,
  and provider mutation lowering. Its `query.ts` and `transport-attempt.ts`
  siblings retain their current roles. There is no candidate `SqlLowerer.ts` or
  `Execution.ts` to create.
- `src/client/client.ts`, `src/client/array-transaction.ts`,
  `array-transaction-legacy.ts`, `array-transaction-native.ts`, and
  `array-transaction-native-batch.ts`, plus
  `src/query-engine/transaction-operation.ts` and `pending-operation.ts`, remain
  the public transaction, capability, scope-identity, pre-admission, result, and
  `TransactionWriteOutcomes` owners.
  G3 exercises those contracts through private test wiring; it does not route
  the shipped client to Raptor 3 or duplicate those owners.

Execution meaning stays separated. Omitted binding is standalone:
`usesBatch` may select its qualified segmented route and preserve its existing
acknowledgement/progress facts. A plain borrowed binding executes on the exact
supplied transaction driver with no implicit lifecycle, savepoint, disconnect,
or replay. `atomic-array` remains a pre-admission refusal until the array owner
can consume an inspectable, fully composable package; removing that refusal is
not permission to run an operation's standalone segmented route inside an
indivisible array.

Interactive array fallback retains the existing one outer transaction and
sequential `TransactionOperationOwner.executeWith` timing; do not force it
through a speculative prepare-all phase. A native array must prove every member
fully packageable before dispatch, with exact statement/result windows, guard
attribution, and operation-local scratch identities. An unsupported member
refuses before provider work while preserving the existing array admission
order. No array retry may replay a sibling.

Suppression is orthogonal to borrowing. A separately admitted exact-root
rollback region may use the existing transaction driver's rollback/savepoint
mechanism when required to absorb only its annotated root conflict. A
descendant unique failure still aborts the operation. A plain borrowed binding
grants neither suppression nor savepoint authority; do not infer arbitrary
nested recovery from it or turn its zero-savepoint contract into a blanket ban
on an admitted suppression region. If the existing owner cannot provide the
required rollback boundary at a placement, preserve its current refusal.

Extend the existing root/nested selected-series path rather than rebuilding it.
Preserve its distinct admission boundaries and its nested timing: publish the
parent prefix before collection capture and per-member admission, then
prepare/analyze all captured members before the first member executes. Preserve
captured complete row and membership keys and publication of every demanded
value across an acknowledged prefix. Scalar bulk adds the existing set-oriented
public behavior; relation-bearing bulk instantiates ordinary record bodies in
order. Counts, default timing, bind limits, result reads, and provider set-
orientation come from the existing C08 witnesses, not a second selected-series
or per-bulk interpreter.

Reuse the existing public behavior owners: the
[create series](../../tests/contracts/engine/write/create-many-relation-series-behavior.ts),
[update series](../../tests/contracts/engine/write/update-many-relation-series-behavior.ts),
[suppression](../../tests/contracts/engine/write/junction-skip-adoption-behavior.ts),
[progress/retry](../../tests/contracts/engine/write/generated-output-segment-contract.core.test.ts),
[array packaging](../../tests/contracts/public-client/array-transaction-legacy-batch-boundaries.core.test.ts),
[nested scope](../../tests/contracts/public-client/nested-transaction-contract.core.test.ts),
and [driver scope](../../tests/contracts/drivers/transaction-scope-scheduler.core.test.ts)
witnesses. Add candidate composition cases only for gaps these shipped-engine
witnesses and G2.7's direct-binding tests do not prove.

The first G3 witness inventory must falsify these composition errors before
their production expansion:

1. Two candidate operations use one caller-owned transaction driver and share
   its visibility without candidate lifecycle/replay; concurrent transaction
   compositions with distinct drivers never cross bindings. Reuse G2.7's direct
   binding facts rather than restating them as a new scope type.
2. A closed or escaped transaction driver is refused by the existing scope
   owner before provider work. A late completion cannot publish a successor or
   a `TransactionWriteOutcomes` fact after its enclosing scope failed.
3. After preserving the existing admission order, a native array with an
   unsupported or incompletely packageable member refuses before provider
   dispatch. Two packaged operations cannot intermediately commit, collide in
   scratch, consume each other's result window, or borrow each other's
   guard/error attribution.
4. Only the exact suppressible root conflict removes one subtree. A descendant
   unique failure aborts; a healthy suffix still runs after a legal suppression;
   a skipped root leaks no target, join, generated output, or prerequisite.
5. Retry is never inferred from `usesBatch`. Wrong-producer constraint errors,
   unknown commit outcomes, and failures after an acknowledged prefix do not
   replay. The existing exact failed-INSERT producer/constraint recovery remains
   bounded to its approved scope and transforms/defaults run once per admitted
   occurrence.
6. Conditional skip-to-match replanning is pinned to the existing upsert
   [contract](../../tests/contracts/engine/write/upsert-family.test.ts) as one
   classified scope, not generalized into blanket retry. Existing error-
   compatibility decisions remain frozen.

Run actual supported batch/progress providers and native transaction/array
composition; transport simulation remains a supplement. Each final receipt must
name fresh source and harness identities. G3 makes no bundle, package, whole-
engine reduction, or performance-qualification claim.

Extend the shared body-instantiation law to root, nested and series
positions; do not introduce a second series preparation/analysis pipeline. Fixed
recursion witnesses use depths 1, 2, 8, and 32 where the existing public contract
admits them; these are test depths, not a new API limit. Include self-relations,
variant slots, compound keys, and a later sibling consuming a changed binding.
No unbounded eager traversal of the schema graph.

Recursive reads are a near-term follow-up after Raptor 3, so G3P-05 owns an
executable private fit gate rather than only a design sketch. G3 inherits that
accepted result as a regression while completing C08–C11. Seed real SQLite
rows, run recursive provider traversal, and assemble the typed projected tree
end to end. Ordinary recursive command/tree construction is not runtime
recursive SQL: finite nested-include unrolling or one query per record/depth is
not a pass. Record statement counts and growth with depth against the fixed
traversal description and output volume; count any retained private engine code.

Extend the current `Queries` correlation, `memberWhere`, `bindMembership`,
projection, relation-projection, and decode owners. `ResolvedRelationIndex`
owns the self target and complete reference pairs; `EngineSchema.keys()` and
`getModelKeyCatalog` own complete row-key identity; `Queries` and
`physicalField` own mapped physical column names and codecs. Do not scan raw
getters, assume a first pair, or derive row identity from relation topology.
Attach results under the actual slot name with its object/null or array
cardinality. Hidden identity, parent, and root-occurrence provenance must
survive when public projection omits key fields. The same SQL row reached from
two seed occurrences or paths is two returned occurrences, never one globally
deduplicated primary-key object.

The G3 fit set covers downward collection and upward singular self-FK traversal,
two seeds reaching the same row, mapped compound keys omitted from projection,
empty branches, explicit depth/cycle termination, and filters, ordering, and an
ordinary nested include applied per level. Use only G3's admitted scalar/filter
subset; fuller C12 projection/codecs remain G4 work. Fixture choices must state,
without settling public policy, depth-zero/root inclusion, cycle/truncation
behavior versus the draft's 1000 cap, traversal pruning versus output filtering,
and per-parent sibling ordering/pagination. Success requires a finite acyclic
public graph with no leaked carrier fields.

The bounded G3 experiment executes real SQLite recursive SQL and documents the
PostgreSQL/MySQL lowering constraints. Representative native PostgreSQL and
MySQL execution is required by G4 before Raptor 3 qualification closes, but
neither stage claims full conformance of the future public feature. Existing
adapter recursive-CTE syntax is not semantic/provider proof. Add no public
feature now, and keep every SQL-specific branch inside the adapters. Add no
`recurse` schema, types, cache/instrumentation behavior, recursive-query engine,
filter/codec parser, or general graph framework now. Any necessary recurrence
meaning stays with the current query/projection owners and the same G3-01/02
production writer. If the fit requires a parallel engine, copied semantics, or
narrow identity assumptions, stop and revise the shared owner under §8 before
advancement.

Hard exit: G3 contracts/profiles/faults and 10,000 new seeds pass; no acknowledged
prefix is replayed; skipped roots publish no descendants; no per-depth or
per-series-member compiler family; scalar bulk keeps its set-oriented path. The
accepted G3P-05 recursive-read fit must remain green through G3, without
shipping its public API. A revise verdict pauses advancement under §8 until the
shared owner is corrected and requalified.
Source checkpoint: target **≤14,000** cumulative charged production token-LOC,
or a recorded shortfall decision.

Each stable G3 unit is written by a Sol 5.6/high author and then reviewed by an
independent Sol 5.6/high adversary. The root starts its final global review on
the frozen implementation and focused evidence **before** G3-04 full
qualification, then closes that same review against the resulting receipts.
Use the sequence in §6.3; validation remains serial on stable source.

### G4 — Complete the envelope; qualify the replacement

Each G4 unit applies the same §7 decision-elimination gate. New query or codec
semantics may require new code; they must not multiply execution, admission,
dependency, or lifecycle interpretations across their consumers.

Complete C01/C12/C13 and all remaining matrix cells: the full read language,
projection/parser ownership, scalar codecs, raw and extension boundaries,
public typing, provider capabilities and existing fast paths. Run the complete
behavior/type/package estates through the candidate. Private implementation
pins do not disappear until their public replacement witness is verified.
Carry the recursive-read fit through fuller C12 projection/codecs and execute
its representative native PostgreSQL/MySQL lowering before qualification; this
is engine-fit evidence, not implementation or conformance of the queued feature.

Hard exit: every required contract/provider lane passes with zero unapproved
divergences or skips; 25,000 new seeds pass; §7 performance/adoption requirements
pass; no legacy fallback/import; no extra public import burden or feature loss.
The §7 whole-cost and structural review must support adoption; Arnaud explicitly
decides any size-target shortfall. Prepare the candidate-only package and
cutover diff, but do not delete user work or publish a release as an incidental
verification step.

G4-04 follows the same §6.3 sequence: root code review first, full qualification
second, evidence/acceptance closure last. Required focused native-provider
witnesses still run during the units that need them to establish behavior.

### 6.1 Assignable work units

Each row is a remaining assignable outcome with prerequisites, owned artifacts
and a verifiable finish. Name exact files before work starts. A unit may contain
several cohesive classes; it is not an instruction to create a class per row.
Completed foundations are prerequisites, not assignments to repeat.

The **integrator** owns the shared contracts, composition entry, manifest,
milestone report, and final validation. Workers propose changes to those owners;
they do not independently add context fields, parallel value types, or new
execution protocols to unblock themselves. Integrator is a coordination role,
not another production class.

#### Remaining work units

| Unit | Starts after | Sole-owned output | Done when |
| --- | --- | --- | --- |
| **G3-01 — bulk and scoped composition semantics**          | Accepted CS-04; accepted G2.9 exit; accepted G3-prep exit; inventory accepted from G3P-01 | Same production writer across G3-01/02: `src/query-engine/raptor3/commands/commands.ts`, `relation-body.ts`, `assignments.ts`, `selection.ts`, and necessary `shared/schema.ts` changes                                               | Ordinary record bodies compose into ordered members and set-oriented bulk without new per-position interpreters. Handoffs distinguish borrowed ownership, suppression region, current attempt, and acknowledged prefix.                                                                                                                                                      |
| **G3-02 — bulk and scope execution**                       | G3-01 handoff accepted                                                                   | Same production writer: `src/query-engine/raptor3/commands/execution.ts`, `shared/operation-context.ts`, `shared/query.ts`, `shared/transport-attempt.ts`; exact adapter/driver seam only if an accepted provider witness requires it | Bind partitioning, output transport, suppression and progress satisfy actual substrates; acknowledged effects cannot replay and skipped prerequisites cannot leak. Array packaging composes through existing transaction owners without changing the shipped route.                                                                                                          |
| **G3-03 — depth, recurrence and failure witnesses**        | Accepted CS-04; accepted G2.9 exit; accepted G3-prep exit; applicable cells classified by G3P-01 | G3 scenarios/regressions, same-harness fault/shrinking extensions, and private transaction/array composition wiring; the accepted G3P-05 recursive fit remains a regression                                                           | Depth/occurrence, bulk counts, binding isolation, closed-scope/late-completion refusal, atomic packaging, skip leakage, wrong retry, committed-prefix replay, healthy suffixes and commit ambiguity are checked independently. G3 extends the accepted prep slices and does not redesign the recursive fit or ship its feature. Witness work may proceed alongside G3-01/02. |
| **G3-04 — integrated composition checkpoint**              | G3-01/02/03 and their focused reviews accepted                                    | Integrator: §6.3 root code review, qualification, manifest and `g3.md`                                                                                                                                                                                            | Root pre-qualification code review passes; G3 provider/contracts and 10,000 new seeds pass on one fresh identity; structural recursion, the recursive-read fit verdict, and whole-cost evidence justify advancement or produce an explicit review. The shipped client still uses the current engine.                                                                                                                    |
| **G4-01 — complete query and projection semantics**        | G3 exit                                                                                  | `src/query-engine/raptor3/shared/query.ts`, necessary `shared/schema.ts` and command selection/analysis changes; shared contracts through integrator                                                                                                                        | Complete C01/C12 by extending the accepted shaped/correlated output owners. Classify remaining cells and prove each handoff extension; no new aggregate/nested/recursive engine.                                                                                                                                                                                      |
| **G4-02 — complete physical/provider envelope**            | G4-01 read/projection handoff accepted                                                   | `src/query-engine/raptor3/shared/operation-context.ts`, `shared/query.ts`, `commands/execution.ts`, and exact assigned adapter/driver seams                                                                                                                                                       | All required profiles and existing fast paths implement that handoff; required provider behavior is executed. Can run alongside the remaining G4-01 implementation after the handoff.                                                                                                                                                                                        |
| **G4-03 — client lifecycle and public type integration**   | G3 exit; any shared handoff change through integrator                                    | Assigned client/extension/cache boundary files, C13/type tests and corresponding harness falsifiers; not shared core files                                                                                                            | Classify remaining C13 cells; public admission, extension/raw/cache behavior and inferred types use the candidate without duplicated lifecycle. Missing events fail the oracle. Can proceed alongside G4-01/02 on verified interfaces.                                                                                                                                       |
| **G4-04 — qualification and adoption review**              | G4-01/02/03                                                                              | Integrator: §6.3 root code review, candidate/package qualification, manifest and `g4.md`                                                                                                                                                                        | Root pre-qualification code review passes; all G4 hard requirements and 25,000 seeds pass; complete size/performance/structural evidence supports the adoption recommendation; Arnaud decides any target shortfall.                                                                                                                                                                                                     |
| **C-01 — candidate-only cutover verification**             | G4 qualification, resolved adoption reviews, and authority to perform the engine cutover | Integrator: exact client route, legacy deletion targets, architecture documentation and candidate-only evidence                                                                                                                       | §9 candidate-only gates pass without a legacy fallback; public API stays intact; rollback reference is recorded. No automatic release or unrelated cleanup.                                                                                                                                                                                                                  |

G3 intentionally keeps the coupled semantic changes under one owner. Parallel
work there is independent witness development and, after each semantic handoff,
physical enforcement—not separate implementations of every relation verb.

### 6.2 Handoffs, parallel execution, and integration rules

These contracts permit a split only after executable evidence; they are not
additional production frameworks or reasons to create more owners:

| Handoff                                 | Single owner                                                            | Must be concrete before dependent streams start                                                                                                                                                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness exchange | Existing contract, profile and harness owners | Add only missing scenario/fault observations; preserve independent oracles, controlled I/O, source identities and exact replay |
| Selected semantic structure and context | Current construction, query and execution owners; integrator coordinates changes | Identify established facts versus new requirements, exact occurrence/producer identity and admission/attempt/progress lifetimes |
| Lowering/execution obligations | Current execution/query owner and exact adapter seam | Show legal interactive/batch behavior, complete packageability, output publication, rollback and failure attribution without downstream public-verb reinterpretation |

Each handoff has a revision, concrete examples, and falsifiers. Freeze only what
the next slice needs. If a consumer finds a missing distinction, send the
counterexample to the integrator; revise one owner, update its falsifiers, and
rebase affected consumers before continuing. No silent local `ContextWithX`,
parallel output vocabulary, or catch-all callback to bypass the shared contract.

Operational rules:

1. Use **one integrator plus up to three worker streams**. This is a maximum,
   not a reason to invent work. Keep coupled production interfaces under one
   author, with independent witness work and completed-unit adversarial review.
   Use Sol 5.6/high for implementation and independent review; the root performs
   final global review. Start only satisfied prerequisites.
2. Assign disjoint files. Shared command/query/context owners, the entry,
   manifest and milestone record have one writer. When a later unit takes over
   a collaborator file, explicitly hand it off after its earlier writer stops.
   Parallel editing of different functions in the same file is not isolation.
3. Do not create worktrees, branches, tasks or agents merely by reading this
   plan. When implementation is authorized, use available project coordination
   and preserve the user's dirty work; no reset/stash/cleanup shortcuts.
4. Authors can inspect and write independently. **Validation is serial** under
   the existing workspace lock/resource policy. Pause writers or use an explicit
   immutable source snapshot for the entire imported graph. Never validate
   while another worker mutates code that the run can load.
5. A handoff includes owned diff/artifacts, contract revision, completed witness
   IDs, actual check results, unverified claims, and blockers. A worker's green
   private tests do not mark a milestone complete. The integrator inspects the
   diff, applies §2's single-owner laws and §2.3's trusted-argument rule, and runs
   the assembled hard gate on the recorded snapshot. Do not multiply validation across worker boundaries
   or require runtime checks merely to avoid justified TypeScript assertions.
6. Stop dependent streams when their shared contract changes. Unaffected units
   can continue. A hard semantic failure cannot be hidden by keeping the rest
   of the rewrite busy. Missing a size target follows the review policy, not
   an automatic cancellation of every worker or automatic expansion of scope.
7. Do not launch next-milestone implementation until the current exit and any
   required advancement review are resolved. Independent current-milestone
   evidence work is allowed while a bounded bug is being repaired.

**Readiness boundary:** G3 starts from the accepted structure. Resolve the
next unit's missing behavior and handoff through bounded witnesses, not another
open-ended architecture investigation. Later units remain outcome-shaped;
their boundaries must remove independent reasoning, not create interfaces to
keep workers busy.

### 6.3 Review before full qualification; avoid repeated work

This sequence changes work order, not required coverage, source identity,
resource ceilings or §8 stop rules. It applies to G3 and G4; completed CS-04
qualification is not reopened merely to apply the new workflow.

1. **Implement and check the unit.** One Sol 5.6/high author owns coupled
   production interfaces. As soon as the behavior contract is frozen, an
   independent witness author develops expected outcomes and cases in disjoint
   files, alongside production work. Run the failing witness, affected families
   and cross-position checks; add type/interface and native-provider checks
   when the changed boundary requires them. Do not run the entire milestone
   campaign after each local edit. Focused success is not milestone acceptance.
2. **Review the completed unit.** An independent Sol 5.6/high reviewer examines
   stable source and the focused evidence, including §7's decision-elimination
   gate. Batch actionable findings in one report. The author repairs them;
   verification targets those repairs and their affected consumers. Do not
   expand review into unrelated polish. New consequential defects still surface
   and use the existing bounded repair rules. Reuse the current author/context
   across coupled units instead of repeatedly reconstructing the investigation.
3. **Freeze and begin the root's final global review.** After implementation
   units and their reviews pass, freeze the integrated source, imported harness,
   registrations and dependencies. The root reviews the combined code, semantic
   ownership/deletions, focused witnesses, cost and qualification inventory
   before expensive full campaigns. Resolve code findings and revalidate affected
   paths, then record the exact approved source identity. This is the code phase
   of one final review, not a new unit or another architecture experiment.
4. **Qualify that identity once.** Verify evidence output paths/reporters with
   an existing short check first. Run the full milestone inventory serially and
   save raw reports as each command executes. No imported-source or harness edits
   during validation. A necessary later change invalidates affected acceptance
   claims: review the delta and run the required source-bound requalification.
   Never relabel old receipts or trade required coverage for fewer reruns.
5. **Close the same root review and integrate.** Audit actual source identities,
   counts, provider results, raw artifacts, costs and checksums; verify integration
   matches the qualified source. This is not a second from-scratch code/design
   review. An evidence-only packaging correction does not rerun unchanged code
   when the original raw proof is retained; missing required proof is obtained,
   not inferred. A code defect returns to step 3 under the remaining budget.

Extend the existing runners only where evidence capture is missing. Save exact
command/runtime/source identity, raw results, resources and teardown together;
derive archive labels from recorded modes, not manually paired directory lists.
Use existing compact reports and required replay corpora. Do not introduce an
artifact framework, dashboard or manual reconstruction of terminal summaries.

G3/G4 extend the accepted representation. Do not repeat CS-03's dual-architecture
extension experiment, create another reference implementation, or reopen a
foundation merely because a new feature is being added. A concrete falsifier
that requires changed ownership follows §2 and §8; this scheduling policy grants
no additional redesign round. Differential checks against the shipped engine
remain required where specified.

Record implementation, review/repair, validation and packaging time in the
existing milestone report, separating elapsed time from summed parallel effort
where available. Note repeated work and its cause. Use those observations to
improve scheduling; promise no unmeasured speedup and add no timing veto.

## 7. Whole-cost compression and performance gates

### Accounting rules

Use [the existing structure census](../../scripts/query-engine-structure.mjs)
and its parser-token line definition; extend the ownership manifest, not the
definition of LOC. Freeze the formatter. Report physical lines, token-bearing
lines, source bytes, runtime bytes, declaration bytes, and test/harness lines.
Token-LOC here counts lines containing parser tokens, **not LLM tokens**.

The charged candidate includes recipes, classes/context, program types,
analyses, runtime tables, SQL lowering, execution, parsing, integration glue,
retained engine helpers, and task-added code moved outside the candidate folder.
Existing unchanged external boundaries used identically by both engines have
one explicit exclusion list. Charge any rewritten/moved semantic responsibility
that leaves those boundaries. No proportional credit for the convenient half
of a retained monolithic owner. No credit for removing non-shipped experiments,
comments, unrelated dependencies, or tests.

Reuse the frozen comparable engine and full public PostgreSQL client
bundle fixtures. Measure their actual bundles separately: gzip sizes are not
additive. Use the same bundler/minifier/compressor versions, settings, target,
driver versions, schema, query use, and externalization on both sides. Do not
turn feature imports or dependency exclusion into the apparent rewrite gain.

### Size targets and hard adoption requirements

| Measure                                                                       | Target or requirement                                         | Classification                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------- |
| Complete charged production token-LOC                                         | **≤60%** of frozen baseline: at least 40% reduction           | Target; a miss requires review, not abandonment         |
| Complete charged production physical LOC                                      | **≤70%** of frozen baseline, with the same formatting         | Target                                                  |
| Comparable engine bundle, minified + gzip                                     | **≤75%** of frozen baseline                                   | Target                                                  |
| Full public PostgreSQL client bundle, minified + gzip                         | **≤100%** of baseline for every frozen representative fixture | Target; growth requires an explicit trade-off decision  |
| G3 cumulative complete charged production guidepost | 14,000 code-bearing LOC | Review trigger, not an automatic stop-loss verdict |
| Legacy engine imports/fallbacks; duplicated downstream public-verb algorithms | **0**                                                         | Required architectural property of this candidate       |
| Required contract divergences and required skipped cases                      | **0**                                                         | Hard adoption requirement                               |

A 60% token-LOC reduction remains a stretch objective, not a promised outcome.
Forecast revisions must follow implemented slices and the remaining semantic
owners. A forecast is not evidence of reduction and does not change targets
or adoption requirements. A candidate that misses 40% can still be adopted for
demonstrated overall gains. A candidate that reaches 40% does not qualify
merely because it is smaller.

### Structural evidence and shortfall review

#### G3/G4 decision-elimination gate

The author and independent reviewer must answer:

> Which existing decisions become unnecessary with this representation?
> Exactly what disappears, and which invariant makes it unnecessary?

"Never needed again" means **while that named invariant holds**, not a promise
about unknown future requirements. Moving a branch to a helper, renaming state,
or changing file boundaries is not deletion of a decision.

Before coding, add a short note to the existing unit report: the required
behavior, its current semantic owner, and the proposed change. At completed-unit
review, resolve these four questions against the actual diff and witnesses:

1. **Necessary decision or representation repair?** Does each added rule express
   database behavior, a real boundary, or a measured execution requirement; or
   does it reconcile two representations of the same fact? Remove the duplicated
   authority rather than adding another synchronization rule. A derived view is
   allowed; independently maintained semantic state needs a distinct invariant.
2. **Exact deletion and replacement obligation?** Name the removed decision,
   mechanism and consumers, the invariant that replaces it, and a falsifier of
   that invariant. Verify no equivalent mechanism moved elsewhere. If the unit
   only adds genuinely new behavior, say "no deletion" and justify its owner;
   do not manufacture a refactor to claim savings.
3. **One rule across uses?** Exercise a second applicable placement or consumer
   through the same owner. Distinguish unavoidable differences from accidental
   forks. A shared function name, common context, or passing isolated fixture
   does not establish shared semantics.
4. **What actually grew?** Report net core and complete charged LOC separately,
   including moved/new code and newly retained whole owners. Distinguish added
   semantic rules from representation support and integration. Compare with the
   unit's expectation and explain deviations. Tests/evidence remain separately
   counted; neither feature counts nor LOC alone prove completion or elegance.

The accepted representation removes copied-history publication/synchronization,
positional expansion and suffix restoration, mirrored dependency branch topology,
membership-owner history searches, and attempt reset journals. Their replacement
invariants are one occurrence structure, placement-derived ancestry and effect
ownership, and replaceable attempt state. Derived branch paths, local capture
binding, dependency comparisons and fresh database observations still have jobs;
do not delete them merely because their names resemble retired machinery.

G3 reviewers specifically reject per-verb suppression/cleanup policies, another
root/nested/series interpreter, and operation-owned array composition or borrowed
transaction lifecycle. Set mutations versus ordered records, distinct admission
boundaries, physical phases, and explicit rollback authority remain necessary.

G4 reviewers specifically reject separate public-predicate walkers for SQL and
dependency meaning, per-operation codec implementations, duplicate result-shape
preparation, and recreated cache/extension/transaction lifecycles. Extend the
current query/projection/decoder and existing external owners. New scalar or
query behavior should not require unrelated relation/execution policy changes
unless a concrete cross-cutting requirement is demonstrated. Provider result
decoding remains a real trust boundary; trusted-input rules do not remove it.

This is part of the existing author/reviewer handoff, not a new checklist system,
runtime registry, extra review stage, or automatic percentage veto. Green tests
do not excuse reintroduced semantic duplication. Return such findings to the
owning unit under the existing bounded repair/redesign rules. Honest net growth
for necessary behavior may pass with explicit ownership and cost evidence;
changed invariants or exhausted budgets follow §8, not a renamed checkpoint.

#### Milestone evidence

At G3/G4, record these alongside the size measurements:

- A before/after ownership map for assignment reconciliation, exact producer
  publication, membership storage, premise protection, and attempt/progress
  state. Show which former independent interpretations actually disappear.
- Traces of the same rule through root, nested, conditional, and series use
  where that milestone admits them. One context property or common method name
  is not evidence that the semantic implementations are shared.
- For each counterexample-driven amendment, name the missing fact, its single
  owner and another case the same rule now handles. Count newly introduced
  rules/state/passes and the old reasoning removed. A fixture-named flag or
  handler is a failed design review, even when every fixture is green. This is
  a short part of the milestone report, not a registry or runtime rule engine.
- A concrete maintenance example: identify the semantic owners that a relevant
  rule change would affect in each engine. Verify with a bounded test-only edit
  experiment if the impact is uncertain; do not ship a new public feature for
  this exercise. Count independent rules, not only edited files or arguments.
- Remaining complexity and its location, including lowerers, context mutation
  protocols, hidden state, retained glue, and the testing burden. Explain real
  trade-offs rather than converting them into an invented aggregate score.

For a missed size target, present the actual whole-system measurements, proven
structural gains, remaining risks, and cost of another revision. Recommend
**continue/adopt**, **revise**, or **abandon**, with the evidence that would
justify the choice. Arnaud decides. An accepted shortfall is recorded against
the exact scope and revision; it is not a blanket waiver for future growth.

Do not keep rewriting solely to hit a percentage when the next contraction
would damage clarity or correctness. Do not keep a rewrite solely because work
has already been spent on it. A smaller-than-target gain can be worthwhile;
"better coded" without a concrete ownership/change-impact example is not proof.
Correctness, compatibility, and the agreed performance budgets still block
adoption when they fail; extra LOC savings cannot compensate for them.

### Performance adoption budgets

**Stage-specific policy:** G3 is bounded architecture work, not production
qualification. Record measured costs,
including regressions and uncertainty, but do not stop those experiments to
resolve small timing variation or satisfy the adoption percentages. Their
purpose is to prove correct behavior and semantic compression. Performance
optimization and complete comparable qualification are required at G4 and again
on the candidate-only package before adoption. The existing 5% time and 10%
peak-memory adoption budgets are not waived by this scheduling decision.
Correctness, public contracts, architectural requirements and safe process
resource limits remain hard gates at every applicable stage. This is a general
stage boundary, not a waiver for one noisy query or a claim that it passed.

Use the frozen representative workloads and the installed
[operation-pipeline benchmark](../../benchmarks/operation-pipeline-compare.mjs):
simple reads, scalar mutation, relation read, nested conditional write,
transition, scalar bulk, relation series, and parsing large nested results.
Include cold construction and steady-state preparation; measure provider
latency separately from engine preparation. Add a narrowly required missing
workload, not a new benchmark framework.

Preserve strict SQL/parameter/count comparison for unchanged-SQL work.
For this rewrite, check repeatable physical witnesses **within** each engine;
compare public outcomes, authoritative state and causal contracts **between**
engines. Retain raw SQL/counts as evidence and apply the explicit budgets below.
Do not erase SQL differences, weaken correctness checks, or add per-query waivers.

Use narrow test-only phase adapters where internal entry shapes differ. They
must bracket equivalent work, including input/default preparation and decoding;
moving work across an artificial timing boundary is not an improvement. If a
phase cannot be isolated comparably, measure the common enclosing boundary and
retain end-to-end evidence. No production compatibility layer is required.
Retain falsifiers showing an equivalent changed-SQL specimen passes and a
wrong-result specimen fails, together with old-versus-old calibration.
Before G4 qualification, establish comparable measurements that distinguish
noise from the fixed budgets. Lengthen useful measured work or fix the fixture
then if needed; record the revised protocol before its qualification runs and
retain earlier receipts. Do not quietly raise budgets to hide a noisy baseline.

At G4 and candidate-only qualification, for each lower-is-better workload metric,
run five alternating fresh-process
samples per side against explicit clean revisions. Let `B`/`N` be the baseline/
candidate medians and `E = 2 × max(MADbaseline, MADcandidate)`. For preparation
time, operation latency, and parser time, require `(N - B) + E ≤ 0.05 × B`;
for peak memory require `(N - B) + E ≤ 0.10 × B`. If uncertainty straddles the
limit, repeat the full series once; if still unresolved, the gate is
**inconclusive and blocks adoption**, not passed. An early-stage report instead
records this result as deferred performance qualification, without blocking its
bounded architecture work. Claims of improvement additionally
require improvement greater than `E`. No outlier removal after looking at data.

For frozen scalar/bulk fast-path fixtures, physical statement and round-trip
counts must not increase. More efficient statement shapes elsewhere require
the causal-contract checks in §5.3. Do not substitute a mocked latency number
for real-provider performance. Existing resource ceilings remain hard bounds.

## 8. Stop, revise, abandon: exact rules

There are three different decisions: **block adoption**, **pause autonomous
investment for review**, and **abandon the candidate by explicit decision**.
Finding a bug or missing a size target does not automatically imply the third.

| Trigger                                                                                                                                          | Immediate action                                                                                                                                                                   | Condition to resume or abandon                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any contract failure: wrong target, leak, progress/retry error, wrong result/failure/lifecycle                                                   | **STOP the affected milestone.** Save and minimize the reproducer; do not widen feature coverage to work around it.                                                                | Fix and rerun the witness plus its affected family/campaign. The same minimized failure surviving **two attempted repairs** is a blocked candidate: return to Arnaud before more implementation.                                                                                                                             |
| False-green harness, nondeterministic replay, missing required cell, or swallowed harness failure                                                | **STOP all acceptance claims** using that harness revision. Invalidate affected receipts.                                                                                          | Repair and pass all harness self-tests, then rerun affected campaigns. Two failed repair attempts block the rewrite before more engine work.                                                                                                                                                                                 |
| Required distinction needs downstream public-syntax recovery, a legacy fallback, duplicated semantic interpretation or a fixture-specific bypass | **STOP feature expansion; revise the shared law in its owner under §2.** Record the smallest counterexample and another applicable use of the repaired law.                        | At most **two autonomous language redesign rounds per milestone**. If another round is needed or the witness still fails, **pause for Arnaud's decision**. A necessary query/effect distinction or provider lowering is not itself duplication. Recommend abandonment only from semantic/cost evidence, not the round count. |
| The G3 source guidepost or a final size target is missed                                                                                       | **PAUSE milestone advancement for a §7 shortfall review.** Keep the target result visible.                                                                                         | Arnaud may accept the measured trade-off, authorize bounded refinement, or abandon. No compulsory two-round attempt to force the percentage; no automatic discard of a useful engine.                                                                                                                                        |
| An agreed performance/adoption budget is missed, or timing evidence remains inconclusive                                                         | **G3: record the cost or uncertainty and continue bounded architecture work. G4/cutover: BLOCK qualification and adoption.** Do not report missing or noisy evidence as a pass. | Resolve performance qualification before adoption. At that stage allow at most **two autonomous bounded performance revisions**; after that, return for a decision. Adoption still requires meeting the existing budget or an explicitly agreed new performance contract.                                                    |
| Passing would require dropping a feature/provider, changing a public contract, or removing a correctness guarantee                               | **STOP and request a decision.**                                                                                                                                                   | No automatic waiver. Without explicit new scope, this candidate does not qualify. Record any changed scope separately; do not call the original contract preserved.                                                                                                                                                          |
| Required correctness/provider/source-and-size baseline evidence is unavailable, or safe resource enforcement fails                               | **BLOCK the gate that requires that evidence**, preserve work. Timing qualification follows the separate stage-specific rule above.                                                | Resume only when required evidence can be obtained within the fixed policy. Missing infrastructure is not proof that the language is bad and not permission to cut over.                                                                                                                                                     |

A redesign round changes semantic representation/ownership to address a recorded
counterexample. A compression/performance revision has a frozen metric, a named
change, and a complete retest of the same scope. Compression revision budgets
come from the shortfall decision; they are not mandatory work before accepting
a trade-off. Ordinary bug fixes do not spend a language-redesign round unless
they change the language. Count rounds in the milestone report; splitting a
change across commits does not reset the count. At the review boundary, do not
silently start another round under a different label.

G3 inherits the repair/redesign history in the [G2.9 ledger](raptor3-evidence/g29.md)
and [shared-structure ledger](raptor3-evidence/core-structure.md). The accepted
structural checkpoint consumes its recorded G3 redesign round. Carry all prior
expenditures and compatibility decisions forward; deleting completed-stage
instructions, renaming a unit or starting a worktree resets no budget.
Keep comparison evidence outside the shipped graph, never as a fallback.

An unresolved shortfall is `needs-review`, not `failed-correctness` and not
`passed`. The strict gate reports these dimensions separately and does not issue
an adoption/advancement receipt until all hard requirements pass and the exact
shortfall has a recorded decision. At G4, evidence must support a net engineering
benefit even if every numerical target is met. There is no automatic adoption
by percentage and no automatic abandonment by percentage or attempt count.

**Abandonment procedure, after Arnaud's decision:** mark the candidate/report
`abandoned`, preserve the source and minimized counterexamples, state which
premise failed, and stop
implementation. Leave the working engine as the public implementation. Do not
delete the candidate, reset the worktree, revert unrelated work, or automatically
start another design. Abandoning this representation is not a proof that Raptor
3 compression is impossible; the failed witness and complete cost are the
useful result.

## 9. Verification plumbing and cutover

Use the repository's explicit admission and bounded runners. Add the new
provider-free contracts to the correct manifest/project; put SQLite-backed DST
and other live-provider work in explicitly admitted extended/provider lanes,
not the fast core by changing a suffix or widening a glob.

Use `node scripts/run-raptor3.mjs <mode>` for registered gates and
`node scripts/run-raptor3.mjs replay <corpus.json>` for saved replay. The
existing manifest owns exact mode, campaign and profile admission. All gate
modes remain strict; diagnostic output cannot issue a passing milestone receipt.
Persist raw results, exact command/source/runtime identity and resource/teardown
evidence during the run, not just a terminal summary reconstructed afterwards.

Existing commands, to run at the relevant gate and **sequentially**:

```sh
node scripts/query-engine-structure.mjs
pnpm test:layer:query-engine
pnpm test:layer:write-engine
pnpm test:types
pnpm test:all
pnpm test:providers
pnpm test:package
pnpm bench:operation-pipeline:describe
pnpm bench:operation-pipeline
```

The existing [resource policy](../../AGENTS.md) and
[bounded runner](../../scripts/bounded-process.mjs) remain authoritative:
ordinary Vitest uses a 768 MB heap and the standard process-group RSS ceiling
is 1,536 MiB. The isolated live-PGlite allowance and whole-estate native-typecheck
allowance belong only to their existing named stages, not to the new harness.
Verify teardown and take the existing workspace lock. Never overlap a test,
benchmark, typecheck, or package run to finish a campaign faster.

After G4, prepare one reviewable cutover change that:

1. Routes the public client to the new engine without a public switch or an
   import-per-feature requirement; updates the durable architecture guidance.
2. Removes the old production path and temporary bridges from the shipped
   graph. Preserve unrelated experimental/user work; identify exact deletion
   targets and retain the frozen oracle outside the package when still useful.
3. Repeats contract, type, real-provider, package, source-accounting and
   representative size/performance gates against the **candidate-only package**.
   A green side-by-side test entry alone is insufficient.
4. Records the last verified old-engine revision and release rollback route.
   No schema migration is part of this rewrite. Publication follows the
   existing [release runbook](../../RELEASING.md), under separate authorization.

Never shadow-execute writes twice against a user's database. Differential worlds
are isolated test worlds. Never retry a failed new-engine operation through the
old engine when effects may have committed.

If final integration fails, do not release; repair within the remaining gate
budget or return for a decision. If a released replacement later needs rollback,
switching code back does not undo committed effects: preserve failure evidence
and assess data separately. No automatic destructive repair or replay.

## 10. Current handoff

The accepted checkpoint and its [independent review](raptor3-evidence/core-structure/cs04-qualification/independent-review.md)
qualify the current private foundation. The [architecture guide](../../src/query-engine/raptor3/AGENTS.md)
owns its durable implementation rules. The [evidence ledger](raptor3-evidence/core-structure.md)
retains previous qualification, approved deviations and consumed repair budgets;
this plan does not repeat completed assignments or superseded design hypotheses.

**Next:** G3-01 owns bulk/scoped-composition semantics. G3-03 independent witness
work may run alongside it once its contract is frozen. G3-02 follows the accepted
semantic handoff; G3-04 qualifies the integrated result. G4 follows the G3 exit.
Each completed unit receives independent Sol 5.6/high review; the root performs
one final global review, beginning with code before full qualification and
closing on its evidence under §6.3. No new foundation stage is authorized by
this handoff.

Preserve these established facts throughout:

- A record occurrence is not a row key; row, reference and membership identity
  remain distinct.
- Selection instructions, positive observations and requirements at consumption
  are separate. Never cache observed absence.
- Admitted values survive retry; observations/bindings do not; acknowledged
  progress cannot be undone by replacing an attempt.
- Borrowed transport grants no lifecycle, suppression or replay authority.
  `usesBatch` identifies a physical route, not those permissions.
- Scalar sets and ordered record series have distinct physical needs, but do
  not own separate admission, assignment or relation languages.

G3/G4 and cutover retain their existing gates. The shipped client remains on
the current engine until separately authorized candidate-only cutover.

## Sources and planning verification

Repository links identify the inspected contract and harness evidence. The
[FoundationDB paper, §4](https://www.foundationdb.org/files/fdb-paper.pdf)
informed controlled nondeterminism, composed fault workloads, replay, and the
explicit separation between simulation and external-system/performance evidence.
The proposed budgets, object ownership, SQLite strategy, and milestone policies
are decisions for this project, not claims made by that paper.

Plan edits are verified by source, document, link and diff checks; they are
not evidence of a new engine, provider or performance qualification.
