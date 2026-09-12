# Raptor 3 — central implementation plan

Date: 2026-09-07; implementation status updated 2026-09-12. **G0–G2 complete;
G2.5 consolidation complete; G2.7 complete after independent acceptance and
final root review. The six-unit G3-preparation checkpoint is accepted. The
post-preparation fact-ownership checkpoint is active before G3-01 or G3-03;
all five units are independently accepted and final qualification is complete
on one frozen identity. Final root global review accepted the checkpoint. G3 is
not started.**
Structured commands passed the G2
gate and independent adversarial review; [the closure
report](raptor3-evidence/g2-closure.md) records
the executed scope and limits. Early timing precision remains deferred under
the approved stage-specific policy.
The [G2.5 closure](raptor3-evidence/g2-polish.md) records final-source gates,
verified archive and the reviewed 4,583-line cost; no public cutover occurred.
Size targets trigger review, not automatic abandonment. Work units are in §6.

This is the single owner of implementation order, acceptance gates, experiment
budgets, and the decision to continue or abandon this candidate. The
[clean-sheet language](./raptor3-clean-sheet-language.md) owns the design
derivation. The [reuse-first plan](./raptor3-language-and-build-plan.md),
[shape review](./raptor3-engine-shapes-review.md), and
[Pattern experiment](./pattern-engine-ideal-state.md) are historical evidence,
not competing implementation instructions.

Distinguish **hard adoption requirements**, **size targets**, and **limits on
autonomous experimentation**. Numerical targets are not measured forecasts or
claims about a theoretical minimum. Freeze the measurements, targets, and
decision policy at G0. A missed target stays reported as missed; Arnaud may
accept the measured trade-off without pretending the target was reached.
Changing a hard requirement needs an explicit separate decision, never a quiet
waiver. Arnaud authorized bounded implementation with independent adversarial
review. That authorization does not waive milestone exits or authorize cutover.

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

The old engine remains the public route throughout G0–G4 verification. The
candidate has a private test entry and its own compiler, lowering, runner, and
projection path. No fallback to the old engine for an unsupported candidate
case: it must fail the gate visibly. Do not mix old and new execution inside
one public operation.

## 2. Shared laws before implementation form

The scoped relational program began as a candidate, not a settled decomposition.
G1-01 compared it with structured commands containing shared query expressions;
the executed comparison selected commands, and G1 expansion passed. The
following preserves the original hypothesis and laws, not an undecided status.
**Original working preference, with moderate confidence:** structured commands with exact
producer references, recording local demands and order during construction;
targeted analysis handles facts construction cannot establish. This is a ranked
hypothesis as recorded before the experiment. References already form dependencies;
the question is whether a separate general graph/pass removes more reasoning
than it introduces. Cross-sibling overlap, conditional producers and restricted
batch execution are the strongest challenges to this preference. G0-01 costs
the hypothesis; both candidates must express these same laws:

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
schema facts, the program, physical capabilities, and execution services
without forwarding them through every function call.

The class names below illustrate the scoped-program candidate, not mandatory
files or a class count. G1-01 assigns the demonstrated owners for the selected
representation. Keep cohesive responsibilities together until a real boundary
appears; no worker receives a speculative class merely to enable parallelism.

| Owner                                                      | Responsibility                                                                                                    | Receives context                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `OperationContext`                                         | Composition root; stable request/schema/capability references; lifecycle ownership                                | Created once at the public-operation boundary  |
| `ProgramBuilder`                                           | Public recipes, recursive record blocks, query/projection construction                                            | Constructor                                    |
| `RelationStorage` implementations                          | Interpret the resolved association's storage mapping for reads and edits                                          | Constructor, with the bound slot               |
| `ProgramAnalysis`, only if a separate pass earns its place | Derive demands, dependencies, overlap consequences and scope requirements not already established by construction | Constructor; reads the same semantic structure |
| `SqlLowerer`                                               | Choose physical strategies and render through the adapter boundary                                                | Constructor                                    |
| `Execution`                                                | Attempts, provider dispatch, suppression/recovery, acknowledged progress                                          | Constructor                                    |
| `Projection`                                               | Required row shape, scalar/nested decoding, public container ownership                                            | Constructor                                    |

Query/effect nodes remain closed, inspectable typed values where their consumers
need structure. A class may own construction or interpretation; a node does not
need a class solely because it has a name. Ordinary local functions remain
available. No preliminary template/instance class hierarchy is prescribed.

Composition is the default. Use inheritance when it removes a shared invariant
across actual substitutes: `RowReferenceStorage` and `JunctionStorage` are the
first candidate pair for a `RelationStorage` base. Test the common contract
against both. Orientation is data within row-reference storage, not another
inheritance branch. Do not build a subclass for each public verb × storage ×
fresh/selected × provider combination. No universal base class is required just
to supply a `ctx` property.

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
methods, not arbitrary writes from every child. An attempt has explicit
`active`, `committed`, `aborted`, or `outcome-unknown` state; there is no Cartesian
product of unrelated `didCommit`/`didFail`/`canRetry` flags. Retry eligibility is
derived from the error, scope, and known outcome.

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
context pool or singleton mutable context in the first implementation.

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

G0 identifies these admission owners. G1 and every later work-unit review reject
duplicated validation in trusted code: name the new trust boundary or the
independent invariant a check owns, or remove it. This is a review rule, not a
new runtime validation framework or an assertion-registry subsystem.

## 3. Evidence artifacts — begin small, extend with the verified slice

Create `tests/raptor3/` for the new contract harness. G0 delivers fixed witnesses,
the baseline and a small trustworthy recorder/replayer; G1–G4 grow the same
harness as the exercised capabilities grow. Do not overwrite the
existing Pattern experiment or its dirty files. The following paths are
**planned artifacts**, not files or commands that already exist:

| Artifact                                     | Required content                                                                                                                                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/raptor3/contracts.ts`                 | Stable witness IDs; public inputs; initial world; required result/state/error/order properties; relevant profiles; source witnesses; earliest milestone                                                                                                                   |
| `tests/raptor3/profiles.ts`                  | Admitted real capability profiles, supported/refused cases, oracle lane, and release-required versus preview classification                                                                                                                                               |
| `tests/raptor3/harness/`                     | Public-call entry for each engine, outcome recorder/comparator, deterministic scheduler, transport fixtures, replay and shrink support                                                                                                                                    |
| `tests/raptor3/scenarios/`                   | Handwritten witnesses and independent, seeded scenario generation                                                                                                                                                                                                         |
| `tests/raptor3/regressions/`                 | Minimized counterexamples, expected failures/properties, and replay metadata                                                                                                                                                                                              |
| `scripts/raptor3-manifest.mjs`               | Exact test admission, campaign seed ranges, required cases/faults/profiles, and resource bounds                                                                                                                                                                           |
| `docs/architecture/raptor3-evidence/g0.json` | Baseline identities, source-accounting manifest, tool versions, package fixtures, performance workloads, frozen targets and adoption budgets                                                                                                                              |
| `docs/architecture/raptor3-evidence/gN.md`   | One report per milestone: G0 includes the costed blueprint below; G1 compares its slice forecast with measurement. Evidence IDs, hard-gate/target results, structural gains, failures and the explicit decision remain separate; large run output referenced by hash/path |

The baseline identity includes the exact source revision and a content-hash
manifest of any explicitly included working-tree changes. Preserve unrelated
work. Do not freeze “whatever happens to be HEAD later,” stash user changes, or
silently bless a dirty baseline as a clean benchmark revision. Do not include
environment secrets in archives or reports.

G0 assigns C01–C13 owners and classifies the fixed G1-01 witnesses. Complete each
milestone's test/cell classification before widening implementation into it,
rather than completing the entire estate before the first design experiment.
For mixed tests, record the extracted invariant and its replacement witness;
retain the old pin until that replacement detects the relevant fault. The old
engine is a differential oracle, **not an infallible specification**. A suspected
old-engine bug is a disputed contract row: stop that row, demonstrate it, and
seek a decision. Do not teach the new engine the bug or silently correct it.

Baseline the shipped engine ownership closure, not a raw directory count.
`src/query-engine/pattern/` and non-routed experimental code are not credit
against the current production baseline. The earlier directory census of
62,149 physical / 47,625 token-bearing lines excluding `pattern/` is only a
navigation aid; it still needs a production-ownership audit. Count retained
owners, glue, tables, new dependencies, and moved code under the same scope.

## 4. Contract matrix: what must become executable

Each row below is a family, not one test. G0 gives the seed cells IDs; the
evidence owner enumerates the remaining cells before their milestone expands.
A cell is an input/world/profile/property combination, not a
SQL-field difference. Explicitly mark impossible combinations with their
schema/capability reason; an unexpected runtime skip does not satisfy a cell.

| ID  | Required family and distinguishing witnesses                                                                                                            | First gate                                          | Existing evidence to start from                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01 | Root/nested reads; NULL/absence/multiplicity; mapped and compound fields; nested selection of the same model                                            | G1, completed G4                                    | [Read contracts](../../tests/contracts/engine/query/operation-equivalence-oracles.core.test.ts)                                                                                                                                                                         |
| C02 | Fresh/selected roots; create/update/connect/COC/upsert; found/missing/foreign target; both FK orientations and junctions                                | G1                                                  | [Upsert arms](../../tests/contracts/engine/write/parity-b-upsert-arm.core.test.ts), [untaken-arm legality](../../tests/contracts/engine/write/upsert-untaken-arm-legality.test.ts)                                                                                      |
| C03 | One final root assignment; conflicting contributions; no transient NULL; single and compound reference tuples                                           | G1                                                  | [Assignment contract](../../tests/contracts/engine/write/final-root-assignment.core.test.ts)                                                                                                                                                                            |
| C04 | Generated output is successful, exact, and destination-decoded; input values cannot impersonate stored output                                           | G1, transport completion G3                         | [Output boundary](../../tests/contracts/engine/write/generated-output-boundary.core.test.ts), [continuation race](../../tests/contracts/engine/write/generated-output-continuation-race.test.ts)                                                                        |
| C05 | Before/after row and reference keys; cascade/restrict; a decoy takes the former unique key                                                              | G2                                                  | [Key transition](../../tests/contracts/engine/write/compiled-key-transition.test.ts), [stale capture](../../tests/contracts/engine/write/staleness-injection-upsert-capture.test.ts)                                                                                    |
| C06 | Singular transfer, disconnect, delete, set, clear/refill, required/optional membership, fixed/variant storage                                           | G2                                                  | [To-one lattice](../../tests/contracts/engine/write/parity-h-to-one-lattice.core.test.ts), [transition contract](../../tests/contracts/engine/write/parity-d-transition.core.test.ts)                                                                                   |
| C07 | Supply before modify; earlier own effects invalidate proofs; equal expressions are not automatically equal stored values                                | G2                                                  | [Own-write linearization](../../tests/contracts/engine/write/own-write-linearization.test.ts), [nested-write contract](../content/docs/client/nested-writes.mdx)                                                                                                        |
| C08 | Scalar bulk stays set-oriented; relation-bearing bulk preserves ordered bodies, counts, default timing, bind limits, and result reads                   | G1 instantiation witness, completed G3              | [Create-many](../../tests/contracts/engine/write/parity-j-create-many.core.test.ts), [series defaults](../../tests/contracts/engine/write/update-many-relation-series-behavior.ts), [series result](../../tests/contracts/engine/write/series-result-read.core.test.ts) |
| C09 | Skip owns its subtree; already supplied prerequisites cannot leak; exact permitted unique-race recovery only                                            | G3                                                  | [Junction adoption/skip](../../tests/contracts/engine/write/junction-skip-adoption.test.ts), [generated-output segment](../../tests/contracts/engine/write/generated-output-segment-contract.core.test.ts)                                                              |
| C10 | Atomic callback/array transaction versus committed segments; failure after dispatch, after commit, and during decode; cleanup preserves primary failure | G1 basic, completed G3/G4                           | [Transactions](../content/docs/client/transactions.mdx), [D1](../content/docs/drivers/sqlite/d1.mdx), [progressive row key](../../tests/contracts/engine/write/progressive-parent-rowkey.test.ts)                                                                       |
| C11 | Self-relations, nested recursion, ancestor re-entry, repeated occurrences, current dependency refusals                                                  | G3                                                  | [Compatibility](../content/docs/client/compatibility.mdx), [recursive-query proposal](../../features-docs/recursive-query.md)                                                                                                                                           |
| C12 | Full filters/order/page/group/aggregate/projection; malformed provider rows; fresh public containers and exact scalar codecs                            | G1 shaped/correlated output witnesses, completed G4 | [Parser contract](../../tests/contracts/engine/query/result-parser-contracts.core.test.ts), [read traversal](../../tests/contracts/engine/query/read-traversal-byte-pins.core.test.ts)                                                                                  |
| C13 | Validation/transform/default phases, request/query/statement/observer lifecycle, cache/raw exclusions, contextual public types                          | G1 skeleton, completed G4                           | [Boundary contracts](../../AGENTS.md), [extensions](../content/docs/extensions/index.mdx), [public typing gate](../../tests/types/client/contextual-typing-gate.core.types.ts)                                                                                          |

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

The previous [M2 differential](../../tests/pattern/differential/execute.core.test.ts)
filters on compile equality, skips series, and synthesizes rows from selected
aliases. Its [driver](../../tests/pattern/sim/simulated-driver.ts) has scripted
responses; its cell store does not itself execute SQL. Preserve useful seeds,
but do not inherit this as a database-state correctness oracle.

Prove the harness for the claims being made, then extend it with the engine.
The same recorder, comparator and replay format serve every stage; this is not
a preliminary harness that will be replaced by a general one.

| Due before acceptance                               | Required harness evidence                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0 exit                                             | Fixed G1-01 worlds run old-versus-old through public admission and real SQLite, including success, refusal and rollback on interactive/restricted-batch profiles. Controlled defaults and sequence state remain observable. Independently injected wrong-row/missing writes, changed values/errors, and a rolled-back effect leak fail the assembled gate. |
| G0 exit                                             | Each saved success/failure schedule replays three times; an uncontrolled-event specimen fails. Zero-case selection, missing required profile/case, timeout, harness exception, swallowed failure and stale evidence fail the command. A split/atomic specimen proves §5.4's fault-cut classification.                                                      |
| G1 exit                                             | Independent seeded operation/world choices within fixed schema families and bounded shrinking work. A padded failure shrinks, retains its property and replays; keep the original. Untaken-branch publication, stale attempt publication and nonterminating recovery are detected before their candidate guarantees are accepted.                          |
| Before accepting the corresponding G2–G4 capability | Add composed falsifiers for skipped-subtree publication, acknowledged-prefix replay, commit/ack ambiguity and missing lifecycle events. Extend fault generation/shrinking to these same observations. By G4 every §5.4 family has its applicable self-test and real-provider evidence.                                                                     |

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
G0 prerequisite. Keep fixed adversarial witnesses beside generated cases.
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
| G0 fixed-witness harness | 100 schedule seeds, plus its required falsifiers |                     1–8 |                       2,000 |
| G1 slice                 |                                            1,000 |                     1–8 |                       2,000 |
| G2 transitions           |                                            5,000 |                    1–16 |                       5,000 |
| G3 scopes/bulk           |                                           10,000 |                    1–32 |                      10,000 |
| G4 final                 |                                           25,000 |                    1–32 |                      10,000 |

The seed axis controls scenario generation and event choices. For G1–G4, at
least 20% of generated scenarios have two logical actors and at least 20%
contain a legal fault. G0 uses its fixed witness set. Required
multi-fault/healthy-suffix witnesses run explicitly regardless
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

### G0 — Fixed evidence before a bounded representation experiment

Start G0-01 with the costed blueprint below and the fixed witness/exchange
contract. G0-02 freezes baseline ownership/identity, targets, adoption budgets
and initial measurement protocol; G0-03 supplies fixture-owned SQLite state inspection,
public old-versus-old execution, controlled completions, replay and §5.1's
falsifiers. Use existing launchers and adapt the existing benchmark under §7.
Do not build a general schema generator or shrinker before the design experiment.

#### G0-01 blueprint — anticipate compression before candidate code

The integrator records one bounded section in the existing planned
`docs/architecture/raptor3-evidence/g0.md`, not a second implementation plan.
Use the current source, contract witnesses and
[ORM audit](../../exa-results/raptor3-orm-pattern-audit-2026-09-07.md) to produce:

1. **Minimum shape and four traces.** Sketch only enough internal values and
   composed owners to trace S1–S4 from admission through effects and output.
   Begin with the command-first hypothesis; describe the competing program's
   additional or removed machinery on the same cases. Name what construction
   establishes and what still requires analysis. Paper traces explain the
   prediction; they are not executable conformance evidence or frozen APIs.
2. **Binding-time ownership.** For each decision in those traces, distinguish
   schema/driver-bound facts, known query-shape facts, actual admitted-occurrence
   values/defaults, and attempt-local database observations/outcomes. Show one
   owner for each. Reuse resolved topology by identity; do not cache an instance's
   values or dependency answer with a reusable body. Binding a branch earlier
   is not a LOC saving unless independently maintained reasoning disappears.
3. **Removal map and complete cost range.** Map current source paths/cohesive
   responsibilities to the shared rule replacing them, retained work, and new
   machinery required. Give each charged responsibility a token-LOC range and
   rationale, including types, construction, analysis, lowering, execution,
   projection/decoding, integration, retained code and runtime tables under §7.
   Count each owner once. Report the summed whole-engine range and corresponding
   reduction, plus the S1–S4 slice estimate separately; expose the largest
   uncertain allowances. Tests/harness work stays visible outside production
   LOC. Use cited current counts provisionally: G0-02 audits/freezes the
   denominator and G0-04 reconciles the forecast, preserving its first version.
4. **Prediction and falsifier.** State the preferred representation, confidence,
   assumptions and the exact case that could reverse that preference. Show
   where local construction could require broader reasoning; do not assert
   that a graph container alone solves it. Distinguish predicted size from
   measured size and §7's targets. Do not infer gzip or speed from source LOC,
   tune the estimate to 40%, or present the lower estimate as a theoretical limit.

**Blueprint completion:** a reader can follow all four cases, identify the
owners expected to disappear and their replacement costs, check the range's
arithmetic, and name the uncertainty G1 must resolve. Uncertainty gets a named
allowance and falsifier, not invented precision. Fully specify only S1–S4 and
their actual supported/refused cells now; assign C01–C13 future owners without
designing every later case. No third candidate, new framework, reference
interpreter or open-ended research phase. This remains part of G0-01, not an
additional milestone or permission to start candidate implementation.

**G0 exit:** §5.1's rows and 100 schedule seeds pass; the four G1-01 witness
families have fixed public inputs/properties and no unresolved contract disputes; the
blueprint is complete and its forecast reconciled to the frozen baseline; all
release-required profiles have a planned real-provider lane; baseline commands
reproduce and benchmark calibration is recorded. A forecast that misses a size
target is not a correctness failure or automatic abandonment. Initial timing
calibration may be inconclusive or incomplete: retain its measurements and
limitations, then defer performance qualification to G4. Resolving small timing
variation is not a prerequisite for the bounded architecture experiment. No
candidate is needed for G0. A failing fixed oracle is repaired before building
a broader harness; correctness and safe resource enforcement remain hard gates.

### G1 — Earn the representation, then expand the shared slice

**G1-01 is the first investment checkpoint, before production splits.** One
production owner compares two minimal representations under private test entries
in `src/query-engine/raptor3/`; one independent evidence owner can work alongside
it. Both enter through existing schema/admission semantics, not handwritten
programs that evade defaults or refusals. Neither executes legacy engine code.

| Representation                                          | Question to resolve, not a promised architecture                                                                                                                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scoped relational program                               | Does a separate analysis of inspectable queries/effects remove enough repeated reasoning to pay for its representation, passes and state?                                                                        |
| Structured commands containing shared query expressions | Can construction establish order, demands and scope facts directly, leaving only necessary deferred dependencies to resolve? Pure reads use direct query compilation through the shared query/projection owners. |

Use the same fixed witnesses in both. Do not build two feature-complete engines
or introduce a production selector between them. Shared semantic algorithms
must not be copied into the test oracle. Public preparation and unchanged
external boundaries can be shared, with their costs accounted consistently.

| Witness family                            | Small executable discriminator                                                                                                                                                                                                                                                                         | Law under test                                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 — conditional producer and association | Found/missing nested conditional target; one generated primary key feeds multiple consumers alongside a distinct admitted field; reverse the FK orientation; inject a failure and observe rollback/no unselected publication. Execute admitted work on interactive and restricted atomic-batch SQLite. | Exact producer-field demands and the same recipe/storage mapping determine successful value transport, dependency and recovery scope without a per-orientation algorithm. |
| S2 — repeated body instantiation          | Two selected roots each create a nested record with a fresh default. A controlled default change also turns a previously safe dependency into the existing required refusal, before the affected instance's effects.                                                                                   | Scoped admission supplies the exact instance that construction, dependency reasoning and execution share; no template-wide proof or materialized default is reused.       |
| S3 — shaped query output                  | `groupBy` with aggregate `having`, including empty input, returns the expected typed grouped values.                                                                                                                                                                                                   | Output shape/cardinality/codec are independent of addressable-record identity; no fabricated key or aggregate-specific execution language.                                |
| S4 — correlated projection                | Two parents each select their own ordered first related target; include a target shared by both parents through junction storage.                                                                                                                                                                      | Query correlation scopes page and assemble each occurrence using the same operators and projection owner, without global deduplication or a nested-page handler.          |

G0 freezes exact cases and baseline admission. S1 must include successful
conditional/generated-output work on both routes, not merely refusal of the
batch route. S2–S4 run their applicable cells on those same profiles. Start from
the [series-default witnesses](../../tests/contracts/engine/write/update-many-relation-series-behavior.ts),
[changed-default dependency witness](../../tests/contracts/engine/write/update-many-relation-series.test.ts),
and [query-output witnesses](../../tests/contracts/engine/query/read-traversal-byte-pins.core.test.ts).
These are four discriminating families, not the full C02/bulk/read cross-product.
As C04 expands on PostgreSQL/MySQL, use the existing
[produced-field witness](../../tests/contracts/engine/write/fresh-produced-field-behavior.ts)
to distinguish a generated primary key from another database-produced field
and compare returned fields with a legal focused read. Preserve its actual
provider cells; do not require its non-primary increment shape on SQLite.

Before handing off: trace each shared law from public input to actual effects
and output; count all construction, analysis, lowering, execution, projection,
glue and test effort for both candidates. Compare measured S1–S4 cost with the
blueprint's same-scope estimate; explain unexpected owners and revised assumptions
without substituting the slice's LOC for a whole-engine forecast. Keep the
initial forecast visible. Compare necessary rules/passes/state, not opcode count
or the interpreter alone. Prefer the coherent passing shape
with fewer independently maintained rules and lower whole-slice cost; record
trade-offs without an invented score. If they converge, keep one representation
and one owner per rule, not both behind dispatch flags. If evidence cannot
choose or neither passes within §8's revision budget, pause for a decision.
Do not expand the experiment into more features to avoid that checkpoint.

Only then assign the demonstrated handoffs and expand the selected candidate:
complete C02 across both FK orientations/junctions, fresh/selected sources,
found/missing/foreign targets and single/compound keys. Keep S1–S4 as regressions
while completing C01 basic reads, C03 final assignment, C04 successful output,
rollback, untaken-arm legality and context lifetime falsifiers. Full bulk/read
completion remains G3/G4. Grow the same harness to G1's §5.1 requirements.

G1 hard exit: all admitted cells/faults and 1,000 new seeds pass through A/B plus
real PostgreSQL behavior and restricted batch SQLite; zero legacy implementation
imports or downstream public-verb algorithms. The chosen law has another
applicable position/storage witness, not a special handler for the seed case.
Source checkpoint: cumulative charged production token-LOC target **≤5,000**;
if missed, record §8's review before G2. S1–S4 passing alone does not complete G1.

### G2 — Prove the hard derivations

Complete C05–C07: key transitions and decoys; singular transfer and clear/refill;
supply/modify; disconnect/delete/set; fixed and variant targets; required
membership; same-operation legality. Preserve exact error precedence and the
currently admitted/refused shapes.

For every derivation, provide a pair that fails if the distinction is erased:
before/after fields, observation/requirement, intended/successful values,
pre-clear/post-clear occupancy, and global/correlated identity. Run provider
races for staleness, unique recovery, and singular occupancy. Required MySQL
storage behavior must now execute on MySQL, not merely render MySQL SQL.

Hard exit: all G2 rows/profiles/faults and 5,000 new seeds pass; required analysis
uses the actual admitted instances; no separate OwnWrite syntax interpreter or
verb-specific backend bypass. Source checkpoint: cumulative charged production token-LOC
target **≤9,000**, or a recorded shortfall decision. Any missing semantic
distinction must be resolved in the shared language before continuing.

### G2.5 — Consolidate the foundation before G3

Arnaud authorized targeted private representation changes with G2 behavior
frozen. This checkpoint does not reopen G2's completed evidence, broaden feature
coverage, change public APIs, or authorize cutover. Its execution record is
[g2-polish.md](raptor3-evidence/g2-polish.md).

**Completed 2026-09-08:** all four units passed their exits on frozen source.
Both complete G2 campaigns passed 20,000 seed/profile cells and 60,000 exact
candidate replays with zero skips; fixed/native/generated/transport checks,
fresh replay and independent review also passed. The only typecheck failures
are the two pre-existing Pattern TS2345 errors. The verified source archive and
explicit review accept 4,583 charged LOC versus G2's 4,342 (+241, +5.55%) for
demonstrated ownership gains, without a LOC or package reduction claim.
G2's historical evidence remains unchanged; G3 has not started.

#### Post-G2.5 bounded compression follow-up

The 2026-09-08 follow-up retained one shared membership-predicate algorithm and
lazy per-variant relation binding, rejected the three-line saving from symbolic
`Choice` branch-output composition because it added a parallel whole-assignment
alias interpreter, and reduced the complete charged candidate from 4,583 to
4,563 token-bearing lines. The [source-bound report](raptor3-evidence/g25-compression.md)
records the fixed gates and explicit campaign/provider limits. It does not
relabel historical receipts, start G3, or make a cutover, package, or performance
claim. For this follow-up and subsequent work, the latest model workflow
supersedes the earlier forward-looking instruction below: only Sol 5.6/high
subagents implement and review; the root coordinates.

Use one broad operation context, composed behavioral owners, stable command
definitions, replaceable execution state and ordinary recursive bodies:

- `RelationBody` owns one parent occurrence and resolved slot, semantic verb
  order, paired admitted/source input and supplier continuation. Remove the
  eight-argument relation cascade and returned-supplier threading. Classify
  selector continuation versus actual produced output once in construction.
- Separate stable query/producer selections, attempt observations, retained
  requirements and exact junction captures. Negative existence and junction
  capture do not allocate pretend model-row outputs. One owner constructs the
  captured-key use predicates; remove the second `foundGuard` lookup and runtime
  selector rewriting. Initial absence and retained loss remain distinct errors.
- Construction supplies condition probes, requirements and error values.
  Generic choice execution observes all conditions, activates found-arm legality,
  then selects skip/match and executes or returns the captured row. A retained
  membership requirement includes both the interactive check and atomic use
  predicate/error. Absence is not automatically a reusable observation.
- `Commands` owns construction and its same-tree analysis; composed
  `CommandExecution` owns interpretation and command-attempt state. `Assignments`
  retains symbolic contributions, demands and provenance, while execution owns
  transport bindings. Remove `remember`, the snapshot/restore journal, mutable
  lookup results, `Assignments.transport`, `unbind` and per-field reset loops.
- Command and shared transport state are two composed parts of one replacement.
  Shared code does not import command types. The sole recovery handoff replaces
  both synchronously, before winner re-observation. Each dispatch retains its
  actual attempt identity and outcome. No successor starts over unresolved I/O.
  Acknowledged progress/continuations, admission history, transaction ownership,
  admitted values and the operation's one-recovery allowance do not reset.
- Root and nested selected series share capture, member preparation/analysis and
  ordinary recursive execution. Keep their existing distinct admission owners
  and prepare-all-before-execute timing. Nested placement owns parent publication
  and exact membership protection. Materialize all demanded scratch values that
  cross a supplier prefix, not only the supplier's fields. Supplier modifiers do
  not acquire collection admission merely to make them look like a series.

Exact failed-INSERT recovery and single evaluation per admitted input remain
the only approved compatibility changes. Diagnostic primary-loss policy and
conditional skip-to-match replanning remain unchanged. New bulk families,
suppression, scoped retries, callback/array ownership and recursive reads remain
G3 obligations. The comparison program stays runnable through shared APIs.

| Unit                                               | Dependency       | Sole-owned outcome                                                               | Exit                                                                                                                                      |
| -------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| G2.5-01 — freeze and falsifiers                    | G2 closure       | Integrator: checkpoint/manifest; independent witness author: new polish fixtures | Current source matches frozen G2; every deletion maps to an independent witness, with only genuinely missing cases added                  |
| G2.5-02 — selections and attempt ownership         | G2.5-01 baseline | One production writer: selected commands and shared transport attempt owner      | Stable selections and symbolic assignments execute through one replaceable attempt; focused contracts and review pass                     |
| G2.5-03 — relation and selected-series composition | G2.5-02 handoff  | Same production writer: lexical relation owner and shared series body            | Parameter/supplier cascade and duplicate selected-series loop are gone without changing admission, progress or effect order               |
| G2.5-04 — adversarial qualification                | G2.5-01/02/03    | Integrator: fresh receipts, whole-cost/deletion review, local architecture guide | Complete fixed/native/generated/transport checks, both existing G2 campaigns and external replay pass on final source; no new type errors |

The completed G2.5 workflow used the established Astra/high production,
independent witness and adversarial review streams, with root owning integration
and validation. Arnaud's latest instruction applies to subsequent implementation:
Astra/medium subagents implement; root reviews. This does not relabel the
completed Astra/high work. Shared files have one writer; evidence work and review
can run in parallel, runtime validation cannot overlap imported-source edits.
Do not alter G2's archives or relabel their receipts. New-source evidence gets a
new identity and replay corpus.

Recount the whole charged candidate against G2's **4,342 code-bearing LOC**,
including moved files and retained owners. Seek a net reduction without a new
percentage veto. An increase requires explicit review of demonstrated ownership
gains. Every new owner must remove an identified conflict or duplicated decision.
The snapshot/restore mechanism, overloaded lookup modes and separate selected
series pipelines must be absent. Apply §8's bounded repair/redesign rules; do
not evade them by splitting or renaming a unit. G3 starts only after this exit.

### G2.7 — Resolve execution ownership before G3

Arnaud authorized this narrow checkpoint after G2.5. It clarifies who owns
execution without redesigning the command language, changing a public route or
driver API, or starting G3. The
[ownership ledger](raptor3-evidence/g27-ownership.md) freezes its evidence.
`commands/` is the implementation target; `program/` receives only mechanical
compatibility edits needed to keep the G1 comparison runnable.

The private engine `execute(modelName, operation, rawArgs, binding?)` call gains
these exact optional binding forms:

```ts
type ExecutionBinding =
  | { readonly kind: "borrowed-transaction"; readonly driver: AnyDriver }
  | { readonly kind: "atomic-array" };
```

- Omitted preserves standalone execution through the factory driver. An
  interactive write keeps one operation-owned `withTransaction`; a
  no-transaction driver keeps qualified batch segmentation, acknowledgement,
  progress, and standalone recovery. Reads retain their direct route.
- `borrowed-transaction` executes directly through the exact supplied
  transaction-bound driver. The candidate does not begin, commit, roll back,
  savepoint, disconnect, or replay. The existing driver owns lifecycle and any
  explicit nested savepoint.
- `atomic-array` raises the existing `TransactionError` before admission,
  defaults/transforms, or provider work. It does not
  implement array execution.

`OperationContext` resolves ownership once. Rename its physical-route fact
`atomic` to `usesBatch`: it means only that this operation uses the qualified
batch path, not general atomicity, ownership, replay eligibility, or commit
certainty. Do not add downstream shape validation, driver detection, an
options-boolean matrix, a universal scope class, or another interpreter.
Admission remains once and internal values remain trusted. Command/transport
attempt replacement and operation-lifetime admission, continuation, progress,
acknowledgement, and standalone recovery facts stay with their current owners;
borrowed execution has no replay allowance.

| Unit                                       | Sole-owned outcome                                                                               | Exit                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| G2.7-01 — contract/evidence freeze         | This checkpoint, `g27-ownership.md`, current identities/cost, witness map                        | The unchanged `g1-compare`, `g2-contracts`, `g2-transport`, and `g25-contracts` gates pass; only genuine ownership gaps are assigned forward |
| G2.7-02 — private ownership implementation | Command entry, `OperationContext`, focused ownership witnesses, mechanical program compatibility | Omitted, borrowed, and refused-array calls satisfy this contract and independent Sol 5.6/high review passes                                  |
| G2.7-03 — qualification                    | Final fixed/generated/transport/native provider/campaign/replay/type/cost receipts               | One final identity passes the prescribed closure with no new type errors                                                                     |

Each unit is written by a Sol 5.6/high worker and reviewed after completion by
an independent Sol 5.6/high worker. The root coordinates one final Astra/max
review after all three units. Validation remains serial on stable source.

G3 still owns private candidate composition against the existing public
callback/array contracts, atomic-array packaging, set-oriented and
relation-bearing bulk, suppression, exact scoped retry, bind partitioning,
ancestor re-entry, and recursive composition. The shipped client route does not
change in G3; full C13 integration remains G4 work and cutover remains separately
authorized.

### G3 preparation — accepted six-unit checkpoint before G3

The [preparation ledger](raptor3-evidence/g3-prep.md) is the sole status and
evidence index for this bounded bridge. G3P-01 freezes the actual shipped
behavior [inventory](raptor3-evidence/g3-prep-inventory.md) and qualified G2.7
baseline. G3P-02 proves exact native constraint ownership; G3P-03 proves set
mutation and existing-owner preparation; G3P-04 proves exact suppression,
replay, and lifetimes; G3P-05 proves cross-table selector dependencies, variant
ordering, and the private SQLite recursive-read fit; G3P-06 qualifies the
assembled preparation on one identity.

Preparation may add only the minimum real vertical slices required by those
proofs. It keeps validation at the existing admission owner, extends the broad
`OperationContext` and ordinary recursive command owners, and composes through
`PreparedBatchOperation` and `TransactionOperationOwner`. It adds no public
route or API, second interpreter, transaction protocol, framework, or
speculative `memberPath` refactor. Historical receipts remain immutable. Two
repairs of the same failure or two language redesign rounds across preparation
pause advancement for a decision.

G3P-02 has caller-level evidence-directory red-to-green proof and final native
PostgreSQL/MySQL proof for five constraint cases. Arnaud resolved the
remaining compatibility question: each model has one public selector namespace,
and a compound selector may not reuse a model field, `AND`/`OR`/`NOT`, or
another compound selector name. Definition admission emits I006 once; model key
resolution, operation schemas, and exact recovery trust the admitted namespace.
Mapped columns and provider constraint names remain separate physical facts.
Final-source focused, full-regression, and native qualification passes on the
frozen identities recorded in the [unit report](raptor3-evidence/g3-prep-02-final/g3-prep-02-report.md).
Independent Sol 5.6/high review accepted G3P-02 on its frozen production,
harness, evidence, and matched-cost identities. G3P-03's original qualified
[unit report](raptor3-evidence/g3-prep-03/g3-prep-03-report.md) remains the
immutable handoff that independent review marked REVISE. The two bounded
[review repairs](raptor3-evidence/g3-prep-03-review-repair/g3-prep-03-repair-report.md)
now pass on their own frozen source identity: empty `createMany` owns a complete
zero-query package/result parser, and update-many limit/returning refusal occurs
once before scalar-versus-relation routing. Independent review accepted those
repairs. G3P-04's original qualified [unit report](raptor3-evidence/g3-prep-04/g3-prep-04-report.md)
remains the immutable handoff that independent review marked REVISE. Its three
bounded [review repairs](raptor3-evidence/g3-prep-04-review-repair/g3-prep-04-repair-report.md)
passed on one frozen identity, but review found a residual unsupported
suppression behind a `Choose`. The [second repair](raptor3-evidence/g3-prep-04-review-repair-02/g3-prep-04-repair-02-report.md)
now makes the context-owned capability requirement unconditional across both
arms while preserving ordinary branch-local refusal timing. Recovery authority
still requires the standalone batch proof, and a selected static series still
projects terminal state once in input order. The later [acceptance
attestation](raptor3-evidence/g3-prep-04-review-acceptance.md) records the same
reviewer's verification without mutating a frozen package. G3P-04 is accepted;
G3P-05's original [unit report](raptor3-evidence/g3-prep-05/g3-prep-05-report.md)
remains the immutable handoff that independent review marked REVISE. Its
[review repair](raptor3-evidence/g3-prep-05-review-repair/g3-prep-05-repair-report.md)
feeds selected updateMany/deleteMany effects into the existing dependency
analysis and lowers recursive seed ordering outside the UNION anchor. The
expanded 21-case gate and retained owners pass. The later [acceptance
attestation](raptor3-evidence/g3-prep-05-review-acceptance.md) records the
independent re-review without mutating either frozen package. G3P-06's original
qualification then passed independent review. Final root review accepted its
separate credential-free registration repair; the [final preparation
attestation](raptor3-evidence/g3-prep-final-acceptance.md) records the accepted
six-unit checkpoint. G3 is not started.

G3 begins only after all six prep units and their independent reviews are
accepted. It extends their accepted slices; it does not reopen their ownership
or count a seed as completion of an inventory row. Full query/projection/codecs,
public lifecycle integration, provider qualification, and cutover remain G4 or
later work exactly as specified below. **A partially implemented G3P-02 is not
a G3-prep or G3 pass.**

### Post-G3-preparation fact-ownership checkpoint

This checkpoint must pass before G3-01 or G3-03 starts. Its ordered units are:
consume authoritative clearability; reuse immutable `EngineSchema` views;
separate projection meaning from statement construction; resolve selector
meaning once; remove repeated history copying. One production writer owns the
coupled changes, and each stable unit receives independent review before the
next begins. This plan remains the sole owner of order, acceptance, and the
existing bounded repair/redesign limits; splitting work does not reset them.
The [live ledger](raptor3-evidence/post-g3-fact-ownership.md) records evidence
and implementation detail. All five units are independently accepted after the
bounded review repairs recorded in the ledger. Final checkpoint qualification
is complete, and final root global review accepted the checkpoint. G3 remains
not started.

Schema validation and clearability own topology and legal removal;
`EngineSchema` owns immutable factory-lifetime schema views; `Queries` owns
selector and projection meaning; execution owns observations, bindings,
affected rows, recovery, and progress. Input and provider-result trust
boundaries remain authoritative, and template/member admission scopes remain
distinct. Shared views retain no operation demand, alias, origin, refusal,
scratch reference, or attempt value. Prepared selectors retain symbolic
operands, and projection descriptions retain no query-local alias or SQL.

- Unit 3 prepares one alias-free shape for SELECT, RETURNING, and reference
  projections. It removes SELECT assembly used only to obtain decoder shape but
  retains reads that verify stored output or continuations.
- Unit 4 resolves admitted names, compound selectors, operators, and field
  references once. Analysis performs no SQL lowering; supplier-specific fact
  scope remains distinct, and captured identities rebind symbolic operands per
  execution attempt.
- Unit 5 removes ancestor-prefix copying while preserving branch isolation,
  repeated occurrences, arm-local refusals, semantic mutation order, and
  separate admission scopes. Depth 1, 2, 8, and 32 evidence distinguishes
  necessary dependency comparisons and branch bookkeeping from removed copies.

Each unit must replace its competing interpretation path rather than add a
second compiler, parser, walker, rule registry, or analysis framework. Focused
review must prove preserved variant laziness, refusal timing, decoding,
supplier/dependency behavior, retry/attempt/borrowed isolation, branch history,
and required provider routes applicable to that unit. After all five units pass
independent review, one final stable identity must pass the accepted preparation
fixed/provider/campaign/replay/type/cost/archive inventory before this checkpoint
can be accepted.

The checkpoint introduces no public API, dependency, cutover, or recursive
feature expansion. Its final qualification still includes every behavior and
safe-reuse obligation in the authorized checkpoint contract, not only the
focused witnesses named here.

### G3 — Scopes, series, recursive composition

Complete C08–C11 by extending the accepted G3-preparation slices, whose
immutable parent is the accepted 4,592-line G2.7 source, not from another
foundation rewrite. G3P-06 freezes the prepared source identity and cost;
preparation does not relabel the historical G2.7 qualification. `EngineSchema`
remains factory-scoped; each call receives
one `OperationContext`; admitted command definitions and operation facts remain
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

Extend the S2 instantiation law to the same body at root, nested and series
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
independent Sol 5.6/high adversary. The root coordinates one final review only
after completed G3 implementation and G3-04 evidence; source editing and
validation remain serial on a stable identity.

### G4 — Complete the envelope; qualify the replacement

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

### 6.1 Assignable work units

Each row is one assignable outcome, with prerequisites, owned artifacts, and a
verifiable finish. The paths below are planned, not already implemented. An
assignment names one owner and its exact files before work starts. A unit can
contain several cohesive classes; it is not an instruction to create one class
or abstraction per row. Current unit status is recorded in §10 and the milestone
report; all six G1 units, all four G2 units, and all three G2.7 units are
complete and independently accepted. The final root global G2.7 review is
accepted; G3 has not started.

The **integrator** owns the shared contracts, composition entry, manifest,
milestone report, and final validation. Workers propose changes to those owners;
they do not independently add context fields, parallel value types, or new
execution protocols to unblock themselves. Integrator is a coordination role,
not another production class.

#### G0 units — fixed witnesses and a trustworthy small boundary

| Unit                                                       | Starts after              | Sole-owned output                                                                                                                   | Done when                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G0-01 — blueprint, scope, fixed witnesses and exchange** | Authorization to begin G0 | Integrator: initial `g0.md` with §6's blueprint; `contracts.ts`, `profiles.ts`, fixed `scenarios/contracts/`, `harness/protocol.ts` | Blueprint completion above is satisfied. S1–S4 have exact public cases, properties and supported/refused cells; C01–C13 have future owners; admission owners and decision policy are named. One scenario/observation/replay vocabulary needs no candidate types.                                                                                                                                                                      |
| **G0-02 — baseline and comparable measurements**           | G0-01                     | `g0.json`; assigned census/package/performance fixtures and narrow benchmark adaptation                                             | Audited production ownership/counts let the integrator reconcile the blueprint. Baseline identity and size fixtures reproduce; workloads and adoption budgets are recorded. §7's semantic comparison accepts an equivalent changed-SQL specimen and rejects a wrong-result specimen. Initial old-versus-old timing evidence is recorded honestly; unresolved precision and remaining performance cells are deferred, not G0 blockers. |
| **G0-03 — fixed public oracle and replay**                 | G0-01                     | `harness/` except integrator-owned `protocol.ts`; fixed witness tests                                                               | Fixture-owned raw SQLite seed/dump, legacy public entry, comparator and controlled replay satisfy G0's §5.1 rows on real interactive/restricted-batch SQLite. No general schema generator/shrinker.                                                                                                                                                                                                                                   |
| **G0-04 — integrated fixed-evidence gate**                 | G0-02/03                  | Integrator: manifest, gate/replay entry over existing runners, completed `g0.md`                                                    | The actual command passes 100 schedule seeds, detects G0's injected violations and missing/stale evidence, and records the G0 exit. The report retains the initial forecast and its frozen-baseline reconciliation. Private checker tests alone do not qualify.                                                                                                                                                                       |

G0-02 and G0-03 can run independently after G0-01; G0-04 verifies their
integration. Further harness machinery is owned with the milestone that uses it.

#### G1 units — prove the language before widening the rewrite

| Unit                                               | Starts after                                                 | Sole-owned output                                                                                                        | Done when                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1-01 — bounded representation comparison**      | G0 exit                                                      | One production owner: minimal private candidates, public test entries; integrator: selection/ownership record in `g1.md` | Both representations face S1–S4; measured slice cost is compared with the blueprint. One passing representation is selected with whole-slice cost/rule evidence, or work pauses under §8. Demonstrated handoffs, file ownership and context lifetimes are recorded before production splitting; a forecast alone earns no handoff. |
| **G1-02 — independent slice evidence**             | G0 exit; independent of candidate selection                  | Remaining G1 contract/profile cells, scenarios/regressions, `harness/` extensions except shared `protocol.ts`            | Remaining G1 cells are classified before their production expansion; the same harness gains bounded independent generation/shrinking and G1's falsifiers. No candidate-derived expected answers or special-case exemptions.                                                                                                        |
| **G1-03 — construction and association expansion** | G1-01 selected handoff; applicable cell inventory from G1-02 | Construction/storage files and their law-establishing analysis in the selected ownership map                             | G1 recipes reuse admitted-instance construction and common storage mappings across positions. Contributions/publication have one owner; no duplicated validation or per-verb/storage compiler.                                                                                                                                     |
| **G1-04 — physical lowering expansion**            | G1-01 selected handoff; applicable cell inventory from G1-02 | Lowering files, any separately justified analysis files, narrowly assigned adapter integration                           | Shared dependencies/requirements lower to legal SQLite/PostgreSQL/batch-model execution without repeating facts already established by construction. A separate `ProgramAnalysis.ts` is not required.                                                                                                                              |
| **G1-05 — execution and projection expansion**     | G1-01 selected handoff; applicable cell inventory from G1-02 | Execution/projection files in the selected map                                                                           | Lowered obligations preserve rollback, publication, decoding and context lifetimes; S3/S4 use shared query-output meaning, with no separate target-selection or membership algorithms in the runner.                                                                                                                               |
| **G1-06 — integrated slice checkpoint**            | G1-02/03/04/05                                               | Integrator: selected candidate harness entry, composition, manifest and `g1.md`                                          | Full G1 contract/provider evidence and 1,000 new seeds pass; S1–S4 remain regression witnesses; whole-cost/structural review resolves any miss before G2. Only one candidate representation is on the adoption path.                                                                                                               |

Before G1-01's selection, parallelism is production versus independent evidence,
not construction versus lowering versus execution. After selection, G1-03/04/05
may split only where the executed ownership map has disjoint files; combine
units under one owner if splitting would create forwarding layers or shared
writes. G1-02 shares the same maximum worker budget. Run validation only on
stable snapshots. A scalar create/read demo or typed fixtures alone earns no split.

#### G2–G4 units — expand along verified boundaries

The file names below are responsibility shorthand from §2.1. Before assignment,
resolve them to exact paths in G1-01's selected map. An absent `ProgramAnalysis`
is not a missing deliverable: its necessary laws stay with their demonstrated
construction/lowering owner, never reintroduced to fit this table.

| Unit                                                       | Starts after                                                                             | Sole-owned output                                                                                                                                                                                                                     | Done when                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G2-01 — transition semantics and shared analysis**       | G1 exit; applicable cell inventory from G2-03                                            | Construction/storage and necessary analysis files in the selected map; shared-type changes through integrator                                                                                                                         | C05–C07 have exact before/after, occupancy, correlation and own-effect laws in one semantic structure. New handoff fixtures pass before downstream changes start.                                                                                                                                                                                                            |
| **G2-02 — transition enforcement on providers**            | G2-01 handoff accepted                                                                   | `SqlLowerer.ts`, `Execution.ts`, assigned physical adapter changes                                                                                                                                                                    | Those laws are enforced without a second interpreter; actual MySQL and PostgreSQL behavior covers required transitions and recovery.                                                                                                                                                                                                                                         |
| **G2-03 — adversarial transition witnesses**               | G1 exit                                                                                  | G2 scenarios/regressions, provider-race tests and required extensions of the same harness                                                                                                                                             | Transition cells are classified before expansion. Independent decoy, staleness, clear/refill, supply/modify and wrong-constraint recovery witnesses execute; their new fault cuts/replay are self-tested. May proceed alongside G2-01/02.                                                                                                                                    |
| **G2-04 — integrated transition checkpoint**               | G2-01/02/03                                                                              | Integrator: composition, manifest, `g2.md`                                                                                                                                                                                            | G2 contract/profile evidence and 5,000 new seeds pass; shared-rule/change-impact and size reviews are complete; any advancement decision is recorded.                                                                                                                                                                                                                        |
| **G2.7-01 — contract and evidence freeze**                 | G2.5 follow-up                                                                           | Central plan, `g27-ownership.md`, current identities and whole-owner cost                                                                                                                                                             | The ownership contract, unchanged-source baseline, existing witnesses and only missing falsifiers are frozen without source, harness, runner or manifest edits.                                                                                                                                                                                                              |
| **G2.7-02 — private execution ownership**                  | G2.7-01                                                                                  | Command entry, `OperationContext`, focused ownership witnesses and mechanical program compatibility                                                                                                                                   | Standalone behavior is unchanged; borrowed operations use the exact supplied transaction driver without lifecycle or replay; atomic-array refuses before admission/provider work.                                                                                                                                                                                            |
| **G2.7-03 — ownership qualification**                      | G2.7-02                                                                                  | Final fixed/generated/transport/provider/campaign/replay/type/cost evidence                                                                                                                                                           | One final source identity passes the prescribed closure and independent/global review without widening into G3.                                                                                                                                                                                                                                                              |
| **G3P-01 — shipped-surface inventory**                     | Accepted G2.7 exit                                                                       | Central plan, `g3-prep.md`, remaining-feature inventory, fresh unchanged-source baseline and historical-runner replay evidence                                                                                                        | Every distinguishable shipped behavior or refusal has a unique inventory ID, placement/profile, exact existing witness, candidate status, intended owner, and G3/G4 milestone; independent review accepts the frozen docs and evidence. No production/test/harness/runner edit.                                                                                              |
| **G3P-02 — constraint ownership**                          | Accepted G3P-01                                                                          | Evidence empty-path repair, one unambiguous public selector namespace, native exact-constraint owner and focused falsifiers                                                                                                           | Definition admission refuses model-local selector collisions once; exact schema-key, adapter-name, and normalized driver identity—not message matching or widened inference—own recovery.                                                                                                                                                                                    |
| **G3P-03 — set mutation and preparation**                  | Accepted G3P-02                                                                          | Minimum scalar set-mutation and relation-series preparation slices through the current command/context and transaction-operation owners                                                                                               | Set orientation and prepare-before-execute behavior compose through `PreparedBatchOperation` and `TransactionOperationOwner` without a second series interpreter or transaction protocol.                                                                                                                                                                                    |
| **G3P-04 — suppression, replay and lifetime**              | Accepted G3P-03                                                                          | Exact-root suppression region, replay/progress and closed/late lifetime slices                                                                                                                                                        | Only the admitted root conflict is absorbed; descendants/prerequisites cannot leak; acknowledged work cannot replay; lifetime facts stay with existing owners.                                                                                                                                                                                                               |
| **G3P-05 — dependencies, variant order and recursive fit** | Accepted G3P-04                                                                          | Cross-table selector dependency and variant-order slices; executable private SQLite recursive-read fit                                                                                                                                | Fixed depth-edge/zero/empty/pruning/path-local-cycle fixtures pass at depths 1, 2, 8 and 32 with measured statements/growth and no public `recurse` API.                                                                                                                                                                                                                     |
| **G3P-06 — preparation qualification**                     | Accepted G3P-05                                                                          | Final fixed/provider/campaign/replay/type/cost/archive evidence; commit remains deferred to review                                                                                                                                     | **Accepted.** Independent review accepted the original handoff. Final root review accepted the bounded repair that removes native/fixed Raptor suites from ordinary discovery, retains every supported local suite in the explicit fixed stage, and repeats complete qualification on one repaired harness identity. No commit or push is claimed here.                                                                            |
| **G3-01 — bulk and scoped composition semantics**          | Accepted G3-prep exit; inventory accepted from G3P-01                                    | Same production writer across G3-01/02: `src/query-engine/raptor3/commands/commands.ts`, `relation-body.ts`, `assignments.ts`, `selection.ts`, and necessary `shared/schema.ts` changes                                               | Ordinary record bodies compose into ordered members and set-oriented bulk without new per-position interpreters. Handoffs distinguish borrowed ownership, suppression region, current attempt, and acknowledged prefix.                                                                                                                                                      |
| **G3-02 — bulk and scope execution**                       | G3-01 handoff accepted                                                                   | Same production writer: `src/query-engine/raptor3/commands/execution.ts`, `shared/operation-context.ts`, `shared/query.ts`, `shared/transport-attempt.ts`; exact adapter/driver seam only if an accepted provider witness requires it | Bind partitioning, output transport, suppression and progress satisfy actual substrates; acknowledged effects cannot replay and skipped prerequisites cannot leak. Array packaging composes through existing transaction owners without changing the shipped route.                                                                                                          |
| **G3-03 — depth, recurrence and failure witnesses**        | Accepted G3-prep exit; applicable cells already classified by G3P-01                     | G3 scenarios/regressions, same-harness fault/shrinking extensions, and private transaction/array composition wiring; the accepted G3P-05 recursive fit remains a regression                                                           | Depth/occurrence, bulk counts, binding isolation, closed-scope/late-completion refusal, atomic packaging, skip leakage, wrong retry, committed-prefix replay, healthy suffixes and commit ambiguity are checked independently. G3 extends the accepted prep slices and does not redesign the recursive fit or ship its feature. Witness work may proceed alongside G3-01/02. |
| **G3-04 — integrated composition checkpoint**              | G3-01/02/03; native and composition evidence complete                                    | Integrator: composition, manifest, `g3.md`                                                                                                                                                                                            | G3 provider/contracts and 10,000 new seeds pass on one fresh identity; structural recursion, the recursive-read fit verdict, and whole-cost evidence justify advancement or produce an explicit review. The shipped client still uses the current engine.                                                                                                                    |
| **G4-01 — complete query and projection semantics**        | G3 exit                                                                                  | `ProgramBuilder.ts`, `ProgramAnalysis.ts` if retained, `Projection.ts`; shared-type changes through integrator                                                                                                                        | Complete C01/C12 by extending the shaped/correlated output owners proven in S3/S4. Classify remaining cells and prove each handoff extension; no new aggregate/nested/recursive engine.                                                                                                                                                                                      |
| **G4-02 — complete physical/provider envelope**            | G4-01 read/projection handoff accepted                                                   | `SqlLowerer.ts`, `Execution.ts`, exact assigned adapter/driver boundary changes                                                                                                                                                       | All required profiles and existing fast paths implement that handoff; required provider behavior is executed. Can run alongside the remaining G4-01 implementation after the handoff.                                                                                                                                                                                        |
| **G4-03 — client lifecycle and public type integration**   | G3 exit; any shared handoff change through integrator                                    | Assigned client/extension/cache boundary files, C13/type tests and corresponding harness falsifiers; not shared core files                                                                                                            | Classify remaining C13 cells; public admission, extension/raw/cache behavior and inferred types use the candidate without duplicated lifecycle. Missing events fail the oracle. Can proceed alongside G4-01/02 on verified interfaces.                                                                                                                                       |
| **G4-04 — qualification and adoption review**              | G4-01/02/03                                                                              | Integrator: candidate entry/package fixture, manifest, `g4.md`                                                                                                                                                                        | All G4 hard requirements and 25,000 seeds pass; complete size/performance/structural evidence supports the adoption recommendation; Arnaud decides any target shortfall.                                                                                                                                                                                                     |
| **C-01 — candidate-only cutover verification**             | G4 qualification, resolved adoption reviews, and authority to perform the engine cutover | Integrator: exact client route, legacy deletion targets, architecture documentation and candidate-only evidence                                                                                                                       | §9 candidate-only gates pass without a legacy fallback; public API stays intact; rollback reference is recorded. No automatic release or unrelated cleanup.                                                                                                                                                                                                                  |

G2/G3 intentionally keep the coupled semantic changes under one owner. Parallel
work there is independent witness development and, after each semantic handoff,
physical enforcement—not separate implementations of every relation verb.

### 6.2 Handoffs, parallel execution, and integration rules

These contracts permit a split only after executable evidence; they are not
additional production frameworks or reasons to create more owners:

| Handoff                                 | Single owner                                                            | Must be concrete before dependent streams start                                                                                                                                                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness exchange                        | G0-01 integrator                                                        | Scenario/world and invocation shape, typed observations, controlled I/O events, failure/replay identity; no candidate IR imports                                                                                                                                                               |
| Selected semantic structure and context | G1-01 selection, then integrator                                        | S1–S4 establish shaped outputs versus addressable records, exact producers, instance admission/analysis, assignments, correlation, alternatives/order/scopes and lifetimes. State which facts construction already establishes and which require later analysis.                               |
| Lowering/execution obligations          | G1-01 executed comparison; changes coordinated by the owning components | S1 proves parameters/outputs and legal execution on interactive/batch routes, with rollback/publication. S2 proves that only the actual admitted instance authorizes its effects. Include outcome/ack meaning, parsing and recovery; no public-verb language or opaque future-effect callback. |

Each handoff has a revision, concrete examples, and falsifiers. Freeze only what
the next slice needs. If a consumer finds a missing distinction, send the
counterexample to the integrator; revise one owner, update its falsifiers, and
rebase affected consumers before continuing. No silent local `ContextWithX`,
parallel output vocabulary, or catch-all callback to bypass the shared contract.

Operational rules:

1. Use **one integrator plus up to three worker streams**. This is a maximum,
   not a reason to invent work. Before G1-01 selection, keep production under
   one owner and evidence under another. Start only satisfied prerequisites.
2. Assign disjoint files. Shared `program.ts`, `OperationContext.ts`, the entry,
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

**Readiness boundary:** there is enough specification to start G0-01 without
another open-ended architecture investigation. G0 records a costed blueprint,
resolves the exact baseline and proves fixed evidence; G1-01 tests the forecast
and compares the two representations on S1–S4 before
selecting and handing off one. Later units remain outcome-shaped assignments,
not a commitment to seven classes or three production workers. Their boundaries
must remove independent reasoning, not add interfaces to keep workers busy.

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

Freeze a comparable engine bundle fixture and full public PostgreSQL client
fixtures in G0. Measure their actual bundles separately: gzip sizes are not
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
| G1/G2/G3 cumulative production guideposts                                     | 5,000 / 9,000 / 14,000 token-LOC, respectively                | Early review triggers, not automatic stop-loss verdicts |
| Legacy engine imports/fallbacks; duplicated downstream public-verb algorithms | **0**                                                         | Required architectural property of this candidate       |
| Required contract divergences and required skipped cases                      | **0**                                                         | Hard adoption requirement                               |

A 60% token-LOC reduction remains a stretch objective, not a promised outcome.
G0's source-grounded forecast anticipates the design before code; completed
slices then support measured revisions. Neither changes these targets or
adoption requirements. A candidate that misses 40% can still be adopted for
demonstrated overall gains. A candidate that reaches 40% does not qualify
merely because it is smaller.

### Structural evidence and shortfall review

At G1–G4, record these alongside the size measurements:

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

**Stage-specific policy, approved by Arnaud on 2026-09-07:** G0–G3 are bounded
architecture experiments, not production qualification. Record measured costs,
including regressions and uncertainty, but do not stop those experiments to
resolve small timing variation or satisfy the adoption percentages. Their
purpose is to prove correct behavior and semantic compression. Performance
optimization and complete comparable qualification are required at G4 and again
on the candidate-only package before adoption. The existing 5% time and 10%
peak-memory adoption budgets are not waived by this scheduling decision.
Correctness, public contracts, architectural requirements and safe process
resource limits remain hard gates at every applicable stage. This is a general
stage boundary, not a waiver for one noisy query or a claim that it passed.

Freeze representative workloads in G0 using the installed
[operation-pipeline benchmark](../../benchmarks/operation-pipeline-compare.mjs):
simple reads, scalar mutation, relation read, nested conditional write,
transition, scalar bulk, relation series, and parsing large nested results.
Include cold construction and steady-state preparation; measure provider
latency separately from engine preparation. Add a narrowly required missing
workload, not a new benchmark framework.

G0-02 must adapt its evidence protocol: the current comparator requires identical
SQL/parameters/counts across checkouts and its phase reader enters the legacy
operation representation. Preserve that strict mode for unchanged-SQL work.
For this rewrite, check repeatable physical witnesses **within** each engine;
compare public outcomes, authoritative state and causal contracts **between**
engines. Retain raw SQL/counts as evidence and apply the explicit budgets below.
Do not erase SQL differences, weaken correctness checks, or add per-query waivers.

Use narrow test-only phase adapters where internal entry shapes differ. They
must bracket equivalent work, including input/default preparation and decoding;
moving work across an artificial timing boundary is not an improvement. If a
phase cannot be isolated comparably, measure the common enclosing boundary and
retain end-to-end evidence. No production compatibility layer is required.
G0 must demonstrate an equivalent changed-SQL specimen passes and a wrong-result
specimen fails, and retain an initial old-versus-old calibration. It need not
resolve that calibration to adoption precision before candidate code exists.
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
| A G1/G2/G3 source guidepost or final size target is missed                                                                                       | **PAUSE milestone advancement for a §7 shortfall review.** Keep the target result visible.                                                                                         | Arnaud may accept the measured trade-off, authorize bounded refinement, or abandon. No compulsory two-round attempt to force the percentage; no automatic discard of a useful engine.                                                                                                                                        |
| An agreed performance/adoption budget is missed, or timing evidence remains inconclusive                                                         | **G0–G3: record the cost or uncertainty and continue bounded architecture work. G4/cutover: BLOCK qualification and adoption.** Do not report missing or noisy evidence as a pass. | Resolve performance qualification before adoption. At that stage allow at most **two autonomous bounded performance revisions**; after that, return for a decision. Adoption still requires meeting the existing budget or an explicitly agreed new performance contract.                                                    |
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

G1-01's initial comparison is limited to the two listed representations and
S1–S4. Its redesign rounds count against G1's same total budget, not a fresh
allowance per candidate or subsequent unit. No third design, enlarged feature
matrix or full-harness detour without a decision when that comparison cannot
select a coherent passing shape. Keep unselected experiment evidence outside
the shipped graph; do not retain alternative semantic paths as escape hatches.

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

G0 adds one documented Raptor 3 gate/replay entry over the existing launchers.
It must support a milestone selection, a single saved replay, and the finite
campaign manifest. Its actual invocation is recorded in the G0 report after it
exists; do not present a hypothetical `pnpm test:raptor3` as a working command.
All gate modes are strict. Diagnostic reports can exist, but cannot issue a
passing milestone receipt.

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

## 10. First assignment and progress ledger

**Current status: G0–G2, G2.5, and G2.7-01/02/03 complete. The six-unit
G3-preparation checkpoint is accepted after its independent unit reviews and
final root review of the repaired G3P-06 registration identity. The ordered
post-preparation fact-ownership checkpoint has all five units independently
accepted; final qualification and root global review are complete.
G3 is not started.** The
[G0 report](raptor3-evidence/g0.md) now contains the costed blueprint, fixed
S1–S4 evidence, reconciled baseline and exact validation limitations. All four
G0 units meet the revised exit. Arnaud approved deferring small timing variation
and optimization: the earlier timing block no longer prevents the experiment.
Two of 20 measurement cells resolved, one remained inconclusive and 17 were not
run; those facts and every saved receipt are unchanged. This is an explicit
policy amendment, not a newly passing benchmark or an engine performance claim.

The two small candidate shapes passed S1–S4 and adversarial regressions.
Measured whole-slice cost is 1,815 counted production lines for commands and
1,985 for the program, including shared/retained owners. Independent review
selected commands; [g1.md](raptor3-evidence/g1.md) preserves that checkpoint's
ownership map and receipts. The [G1 closure](raptor3-evidence/g1-closure.md)
records the expanded 2,799-line candidate, final contract/provider checks,
4,000 A/B seed/profile cells, 12,000 exact candidate replays and closed
adversarial findings. The 5,000-line G1 guidepost is met; this is not a measured
whole-engine reduction.
Record early performance observations without treating adoption precision as
an experimental prerequisite. Full qualification remains due at G4. The same
generation/replay harness now serves both A/B lanes; later stages extend it
only for their admitted capabilities. Production splitting follows demonstrated
ownership, not the forecast.

| Stage                                              | Status                                                                                                                                                                                                                                                                    | Required decision                                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Central design and execution plan                  | Structured commands selected by the executed G1-01 comparison                                                                                                                                                                                                             | Preserve the measured ownership map and stage-specific gates                                                                                              |
| G0 — costed blueprint, baseline and fixed evidence | Complete under the approved stage-specific policy: fixed gate/replay, reproduced source/bundle baseline and full CLI suite pass; performance qualification explicitly deferred                                                                                            | Begin the bounded representation experiment; retain inconclusive timing evidence                                                                          |
| G1-01 — representation comparison                  | Complete: 66 tests and 144 replays pass; commands selected; whole-file costs and independent review recorded in [g1.md](raptor3-evidence/g1.md)                                                                                                                           | Expand only commands; retain the program as private comparison evidence, not a second adoption path                                                       |
| G1 — expanded new-language slice                   | Complete: expanded contracts, 1,000 new seeds per A/B profile, live PGlite witnesses, CLI checks and review pass; 2,799 charged production lines                                                                                                                          | G2 investment is earned; preserve G1 as the regression base and classify C05–C07 before expansion                                                         |
| G2 — difficult derivations                         | Complete: 216 fixed comparisons, 18 native PostgreSQL checks and 13 native MySQL checks, 20,000 seed/profile cells and 60,000 exact replays; 4,342 charged lines; [closure](raptor3-evidence/g2-closure.md)                                                               | G3 investment is earned; retain approved single-admission and exact failed-INSERT recovery rules, and classify scope/recursion witnesses before expansion |
| G2.5 — foundation consolidation                    | Complete: final-source gates, 20,000 seed/profile cells, 60,000 exact replays and archive verified; 4,583 charged LOC; [closure and cost review](raptor3-evidence/g2-polish.md)                                                                                           | Accept reviewed +241 LOC for demonstrated ownership gains; preserve private G2 behavior and the recorded evidence limits; G3 not started                  |
| G2.7 — execution ownership                         | Complete: the final 4,592-line source passes the complete fixed/generated/transport/native provider closure, both 10,000-cell campaigns, 60,000 exact replays, external saved-corpus replay, type/cost checks, independent unit reviews, and the final root global review | Preserve the accepted private ownership boundary; G3 remains a separate, not-started stage                                                                |
| G3 preparation — six bounded units                 | Accepted: all six units, bounded review repairs, final qualification, and root global review pass on the recorded frozen identities                                                                                                                                       | Preserve the accepted private composition owners; start G3 only as a separate authorized stage                                                            |
| Post-preparation fact ownership                    | Accepted: all five ordered units, final stable-identity qualification, independent archive audit, and root global review pass                                                                                                                                             | Preserve the accepted fact owners; start G3 only as a separate authorized stage                                                                            |
| G3 — scopes, bulk, recursion                       | Not started                                                                                                                                                                                                                                                               | Composition survives depth and failure                                                                                                                    |
| G4 — full envelope and qualification               | Not started                                                                                                                                                                                                                                                               | Complete measured replacement qualifies                                                                                                                   |
| Cutover/release                                    | Not started                                                                                                                                                                                                                                                               | Candidate-only gates pass; release separately authorized                                                                                                  |

The implementation record claims only the measured, passing G2 slice—not
whole-engine compression, runtime performance or adoption. Harness breadth and
feature breadth now grow together on the selected structure. The evidence
report, not this status summary, owns executed receipts and their limitations.

G2 meets its 9,000-line review guidepost, without a new payload/OwnWrite
interpreter or language redesign round. Two pre-existing Pattern type errors
remain outside this private slice. Conditional skip-to-match replanning remains
a G3 scope obligation. The reproduced diagnostic-primary-loss policy remains
unchanged pending its separate compatibility decision. Neither point is an
unreported acceptance waiver; the closure report records their exact scope.

### 10.1 Learning log — primitive truths after G0–G2

Recorded 2026-09-08 after G2.5 and its bounded compression follow-up. This
records the architectural lessons and current assessment, not new qualification,
an implementation authorization, or a change to milestone scope or budgets.
Several laws already appeared in §2; implementation exposed where the early
representations did not make those laws hold by construction.

1. **A record occurrence is not a row key.** The same database row can be
   selected, changed and revisited at different positions. Its occurrences are
   not interchangeable. An exact producer occurrence plus field is the useful
   reference: demands, dependency and publication can follow that reference.
   Row keys, reference keys and complete membership keys retain their different
   meanings. Publishing only supplier IDs was insufficient; introducing a
   second whole-assignment alias language was not the remedy.
2. **Lifetime is a fundamental boundary.** Admitted inputs and command
   definitions survive a retry; observations and bindings belong to an attempt;
   acknowledged progress survives attempt replacement. Mixing these lifetimes
   caused the snapshot/reset machinery. G2.5 corrected that representation.
   Admission is observable work: a new selected occurrence may require fresh
   admission, but retrying that same admitted occurrence must not repeat its
   defaults or transforms. A broad context removes parameter forwarding; it
   must not flatten these lifetimes or become an ambient current-record cursor.
3. **Selection, observation and retained requirement are different acts.**
   Finding a matching record, capturing what was found, and requiring a fact
   to remain true at the consuming write have different timing and failure
   meanings. Share predicate construction, not the moments at which those
   predicates must be enforced. An earlier absence is not a reusable answer.
   Database-state requirements are not redundant validation of trusted input.
4. **Visibility, atomicity and replay are independent.** What later work can
   observe, which effects commit together, and which work may restart are not
   one transaction flag. The execution lifecycle needs state transitions;
   relation verbs do not each need a state-machine family. Skipping a subtree
   is not retrying an attempt, and neither permits replaying committed work.
5. **Public verbs are recipes, not the primitive truths.** Selection, record
   changes, membership changes and requirements compose into the public verbs.
   A new class per recipe does not compress their rules. The remaining size of
   `RelationBody` shows that recipe compression is incomplete; it does not prove
   that ordinary recursive commands are the wrong foundation.

**Historical implementation assessment after G2.5; superseded by §10.2.** Keep
the occurrence-owned `Assignments` and field references, stable selections with
separate attempt observations, explicit requirements and junction captures,
replaceable command/transport attempts, operation-owned progress, and the shared
selected-series mechanism. These are actual owners in the current source, not
proposed replacements. The three-line whole-assignment alias experiment was
rejected because it added another interpreter; that lesson is semantic cost,
not a numerical size veto.

The execution-ownership contract is the least complete foundation for G3.
`OperationContext.atomic` currently selects the batch route from
`!driver.supportsTransactions`. That serves the qualified private routes; it is
not a complete statement of caller-owned transaction boundaries, permitted
segmentation, subtree suppression or replay scope. G3 must establish those
facts at the boundary that knows them and test their composition through the
existing owners. Do not infer them all from provider capability, widen recovery
implicitly, or invent a universal scope framework before a concrete witness
requires it. The first scope witnesses must distinguish skipped-root effects
from failure after acknowledged progress, using placements the public contract
actually admits.

### 10.2 Learning log — execution ownership after G2.7

Recorded 2026-09-09 after independent unit reviews and the final global review.
This corrects the forward-looking assessment above; it does not rewrite the
historical G0–G2.5 evidence or authorize G3 implementation.

1. `OperationContext` now resolves ownership once. `usesBatch` is true only for
   qualified standalone batch routing; it is not atomicity, borrow, suppression,
   or retry authority. The retired `atomic` spelling is not a current owner.
2. A borrowed operation receives the exact caller-supplied transaction driver
   and performs no lifecycle, savepoint, disconnect, fallback, or replay. The
   driver and existing public transaction owners retain scope identity, nested
   savepoints, scheduling, cleanup, and write-outcome publication.
3. `atomic-array` is intentionally refusal-only. Atomic composition still needs
   the existing operation-owner protocol, correct admission timing, a complete
   native package or sequential interactive execution, and exact result/error
   attribution. Provider batch capability alone proves none of those facts.
4. Suppression is orthogonal to borrowed ownership and has a separately admitted
   exact-root rollback region. A plain borrowed binding grants neither
   suppression nor savepoint authority, while an admitted region may use its
   existing driver-owned rollback mechanism. Only the exact root conflict may
   be absorbed; descendant failure remains fatal.
5. Keep occurrence-owned `Assignments`, stable `Selection`s, explicit
   requirements and junction captures, replaceable command/transport attempts,
   operation-owned progress, and the shared selected-series mechanism. G3 grows
   those owners; it does not restart the foundation or add another interpreter.

The qualified starting source is 4,592 charged code-bearing LOC. The prior
4,563-line compression checkpoint and earlier benchmark receipts remain
historical evidence, not a baseline to relabel. G3 preparation freezes its own
fresh identities and evidence; G3 then extends the accepted prep slices and
retains its 10,000-seed, provider, 14,000-line review, and §8 stop rules. Neither
stage makes a new LOC-reduction, bundle, package, or performance claim here.

## Sources and planning verification

Repository links identify the inspected contract and harness evidence. The
[FoundationDB paper, §4](https://www.foundationdb.org/files/fdb-paper.pdf)
informed controlled nondeterminism, composed fault workloads, replay, and the
explicit separation between simulation and external-system/performance evidence.
The proposed budgets, object ownership, SQLite strategy, and milestone policies
are decisions for this project, not claims made by that paper.

Research record: `/tmp/viborm-raptor3-dst-sources.json`. Planning validation is
limited to source inspection and document/link/diff checks. No engine changes,
DST campaign, provider suite, package benchmark, or release was performed by
writing this plan.
