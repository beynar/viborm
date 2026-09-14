# Raptor 3 — private representation experiment

The central plan in `docs/architecture/raptor3-implementation-plan.md` governs
this explicitly authorized clean-sheet experiment. The shipped engine remains
the public route. This directory is not a production replacement or a fallback.

G1-01 compares structured commands (`commands/`) with a scoped relational
program (`program/`) on the same S1–S4 public recipes. `shared/` may contain
genuinely shared query/projection and boundary work; charge its full cost to
each candidate. Do not make the alternatives cosmetic runners over one hidden
mutation compiler. No per-fixture names, constants, algorithms or copied oracle.

The executed G1-01 checkpoint selected `commands/` as the sole expansion path.
`program/` is retained only as its private comparison specimen. Construction
and same-tree dependency analysis belong to `commands/commands.ts`.
`commands/relation-body.ts` composes one parent's admitted relation body with
its resolved slot, raw provenance, semantic verb order and supplier continuation.
Its size reflects one cohesive relation-composition responsibility; do not split
it into per-verb, per-storage or per-depth owners merely to shorten the file.
`commands/execution.ts` interprets the prepared typed command values. Keep one
writer when changing this construction/execution boundary.

`commands/assignments.ts` owns symbolic final fields, exact demands,
contributions and provenance, never runtime bindings. Captured membership is a
premise, not an implicit request to overwrite the final assignment. All reference
and junction consumers register demands through that owner. A choice forwards
demands to both possible producers without making an untaken arm's values known.

A selected update consumes one stable `Selection`, not parallel model, selector
and captured-row arguments. Query and exact-producer sources are distinct;
`RelationBody` classifies a plain connect's selector versus a producing
operation's output during construction. Interpretation does not rediscover the
public verb. `Queries` owns one membership predicate across alias-to-alias
correlation and captured-source values; `correlation()` and `memberWhere()` only
select that operand form. Positive observations live in `CommandAttempt`;
absence is consumed lexically and is deliberately not cached across re-entry.
Junction capture stores the exact membership pair, not a synthetic row lookup.

`RelationBody` binds membership lazily at the first admitted ordinary verb or
tagged variant and caches it per variant. That binding owns literal requirements;
executed relation construction still owns transition registration. Do not move
schema refusal or input-admission timing earlier while avoiding unused variants.

Schema validation owns definition legality and resolved topology;
`clearableMembership` owns the physical removal answer. The bound `Membership`
view exposes that exact answer. Relation construction and execution retain the
full compound tuple for correlation, but disconnect, parent-held delete cleanup,
and `set` departures write only its authoritative `columns.fields`. A `none`
answer retains the existing runtime absence proof, and a junction keeps deleting
its exact membership row. Direct row-variant clearing reads the resolved carrier
slot before variant orientation; tagged operations retain exact member scope.
Do not reconstruct clearability from scalar nullability in the engine.

`EngineSchema` owns lazy immutable factory-lifetime views for physical field
descriptors, ordered stored fields, exact model/slot/variant membership
orientation, and slot clearability. Reuse original resolved descriptors,
topology, edges, and members; freeze only the newly owned wrappers and arrays.
These caches contain no aliases, operation demands, origins, refusals,
assignments, scratch references, or attempt values.

`Queries.prepareProjection` owns one immutable alias-free projection description
and decoder shape. `lowerProjection` binds that description to fresh statement
aliases for SELECT, RETURNING, recursive reads, and reference-value projection;
`decodeProjection` consumes its shape without rebuilding SQL. When one mutation
uses RETURNING plus a required stored-row continuation, both lowerings reuse the
same prepared description while keeping distinct query-local aliases. Only
`decodeQuery` consumes query-level row-count requirements. Do not assemble a
SELECT merely to obtain decoder shape, re-prepare a continuation's projection,
or remove a SELECT that verifies stored output.

`Queries.prepareSelector` owns one alias-free symbolic selector description and
its dependency facts. `lowerSelector` binds statement-local aliases and current
execution identities without reinterpreting admitted public syntax. A
`Selection` retains the same prepared selector through lookup, capture, and
membership rechecks. Supplier continuations compose their prepared selector
with the member selector through `Queries`; the deliberate supplier-specific
fact choice remains in `RelationBody`. Field references resolve once at query
scope, remain symbolic operands, and never become literal equality,
disjointness, or exact-recovery proof. Do not add a second selector walker,
retain a raw selector as another semantic authority, or cache attempt SQL.

`Commands.analyze` materializes one placement-owned `CommandOccurrence` tree
from immutable command recipes. Reusing a command or `Selection` never reuses
occurrence ancestry, children, refusal, or attempt state. Choice arms and static
or selected-series members remain children of their actual placement. A series
capture and its selected-series target are sibling recipe children of one
lexical parent. Materialization resolves that pair within the parent's local
direct-child correspondence, then recurses with fresh correspondence for each
child; never resolve descendants through one shared replacement map. A
symbolic membership contribution contains finalized recipe meaning but no
runtime owner; the containing dependency write's occurrence is the sole current
placement owner.

Dependency analysis is read-driven over that same occurrence tree. A read
visits logically preceding candidate writes through parent and sibling
ancestry; a new write visits only the later retained reads it can affect.
Thread the already-known branch path through traversal, including known absence,
instead of reconstructing it per node. Opposite choice arms remain incompatible.
Do not add a flat history, copied prefixes, detach/restore suffixes, owner scan,
canonical runtime registry, or cache of traversal position.

One selected-series mechanism serves root and nested placements. A series'
collection filter selects its occurrences;
it is an observation, not a condition every member must still satisfy. Each
member is freshly located by its captured complete row key, then its captured
membership is required before effects. Parent membership carries the existing
`Assignments` occurrence so complete parent identity and consumed reference
fields remain available; do not flatten it into a reference-only value bag.
The root update-template and nested member admission boundaries remain distinct;
prepare and analyze all captured members before executing any member. Supplier
modifiers do not gain collection admission. When a committed prefix can discard
scratch storage, materialize every live demanded binding inside that same prefix
submission, before its acknowledgement, not merely the immediate supplier fields.
Root and nested selected series register through the same `Commands` analysis
owner. The admitted template remains distinct from its exact member occurrences;
template disjointness is not proof that a later member is disjoint. Member
substitution reuses admitted values and never invokes defaults or transforms
again.

Ordered peer series members may observe effects from earlier peer members; an
earlier peer is not a write inside the next member's record body. Derive this
boundary from static-series or selected-series ancestry. Preserve checks within
one member, outer-prefix versus member checks, branch activation, and the union
of member writes seen by later surrounding reads. Prepare and admit every member
before any member effect.

Private relation-bearing root `updateMany({ select })` uses the same selected-
series completion and terminal-reader owner as `createMany`. Read final complete
keys only after all member effects. A missing update row is an operation-specific
`TransactionError`; create-series underflow retains its `QueryEngineError`.
Scalar mutation limits remain set-oriented. Relation-bearing limits cap capture
before member admission, and zero returns after ordinary operation admission but
before SQL or member admission. Adapter capabilities own dialect syntax; A+B
composition adds no third execution path.

Every existing `Choose` arm, including an absent found or missing arm, owns its
conditional refusal until execution observes the choice. An untaken arm cannot
reject an earlier dynamic member, while the taken arm retains the dependency
failure. Do not cache absence, flatten arm reads into the enclosing series, or
add verb- or placement-specific branch flags.

`OperationContext` owns selected-series occurrence path, cardinality, and
acknowledged progress. Prepared commands carry none of those execution facts,
and there is no ambient total-member counter. A failure after a finished series
must keep truthful operation progress without borrowing the finished member's
path or cardinality. Translate a malformed provider result at the existing
driver/scalar boundary before attaching result-phase progress; do not replace
its error identity with a generic record-series failure or replay acknowledged
work.

Fixed and variant slots bind the same membership vocabulary from the resolved
schema index. Public variant tags, stored discriminators and compound reference
fields remain distinct. Private carrier columns are addressed through their
resolved descriptors, not a parallel field registry. A selector-bearing nested
upsert on a selected parent looks up a global target, then requires captured
membership before the found arm; a foreign target is not an absent target.
Reference and junction storage, including variants, share that requirement.
A selector-free singular lookup remains correlated to its parent. Projection
flattens variant arms in schema order.

OwnWrite membership analysis reads actual assignment contributions and their
logical command owners. Membership scope is the existing resolved edge and
selected member identity, not a shared-column intersection or public slot name.
A lookup's own outgoing clear contribution is not an external membership
dependency on that lookup; ignore only that exact owner identity. Always retain
the target read and contributions from every other owner, including another
operation on the same edge or member.
A targetless carrier clear spans that carrier's members; tagged contributions
retain their exact member. Root-phase direct disconnect and a folded connection's
actual Choose occurrence must not be preseeded as the same execution phase.

Junction insertion suppresses only an already existing complete source-and-target
membership tuple. Use the adapter's targeted conflict protocol when available;
the other admitted route selects from the real target row and anti-joins that
exact membership pair. Do not use a target-table self-subquery or broad duplicate
ignore. Unrelated unique and foreign-key failures remain failures. A singular
junction captures its actual complete owner pair; it never deletes by the target
key alone.

A selection's initial absence and loss of an already observed identity are distinct
failure roles. Its retained premise owns the latter error, including a found
connectOrCreate target. A junction capture keeps the original complete guard;
an own-key transition carries only its addressed side through the existing
Assignments occurrence, never a newly requested opposite owner.

Captured physical decimals return to the existing codec's canonical private
text before reuse; public results materialize fresh Decimal values. Root
operation attribution follows the actual root command, not model-name equality
which is also true for a nested self-relation.

The legacy engine's representation-specific instructions do not prescribe the
new language. Its observable contracts still apply. Do not import its compiler,
lowerer, executor, query builders or result engine, or use it for unsupported
candidate cases. Existing schema/validation, resolved topology, parameterized
Sql, dialect adapters and provider transports remain available boundaries.
Keep dialect syntax in adapters and respect advertised transport capabilities.
Construction owns semantic verb ordering: admission can preserve caller key
order. A successful provider acknowledgement owns durable-progress facts;
queued statements or prepared field references are not successful publication.
`EngineSchema` lives with the private factory; `OperationContext`, command trees,
aliases, scratch fields, progress and generated-output continuations live with
one execute call. Upsert eagerly admits each arm's required input, including
UPDATE relations. Selection controls semantic legality and effects, not a second
validation of the same input. A template envelope and each captured member are
separate admission scopes; neither may be silently collapsed into the other.

Conditional upsert filters enter through that same admission boundary. Ordered
ordinary lookups observe their SQL truth before selected found-arm legality and
skip selection. A skipped update returns the captured row, not a newly located
replacement. Atomic skip pins original selector plus complete captured key
before the unmatched predicate; atomic match pins each condition on that key.
Construction supplies those ordered probes, requirements and exact failures;
generic choice execution observes all probes, checks found-arm legality, then
selects skip or match. Eligible INSERT recovery replaces those observations with
the attempt. Conditional skip-to-match replanning is not a qualified retry scope.

Generated fields use exact same-batch scratch where available, or acknowledged
RETURNING segments on the admitted non-CTE capability route. A later batch proves
the producer's actual row key and returned fields inside that batch. Driver error
attribution may use a trustworthy statement index, or a sole continuation with
the existing driver's assertion-collision proof; ambiguous errors stay unchanged.
Confirmed commits and uncertain native dispatch are separate operation-owned
facts. Error translation must preserve both and the earliest trusted phase.

Unique recovery belongs to the exact failed INSERT's Assignments producer and
its selected unique constraint, not another missing branch with the same key.
Only a proven atomic rejection before committed progress or dynamic member
admission may restart once. Recovery reuses admitted values; it never validates
or invokes their transforms again. The legacy retry policy is unchanged.

Execution composes two replaceable regions: `commands/command-attempt.ts` owns
positive row observations, captured junction pairs, runtime field bindings and
exact missing-INSERT associations; `shared/transport-attempt.ts` owns pending
statements, assertion attribution, scratch references and rejection evidence.
The latter imports no command types and also serves the comparison specimen.
One recovery method replaces both regions synchronously, without callbacks or
an await between installations. Dispatch keeps the identity of its own attempt.
Do not reintroduce snapshot/restore, visited-node journals or per-field reset
loops. Admitted values, committed continuations, transaction ownership, admission
history, confirmed/uncertain progress and the one-recovery allowance survive
replacement. A missing winner on recovery propagates the original rejection;
it never authorizes another INSERT.

Named retention: `write-engine/parse-boundary.ts` remains the existing
schema-to-ValidationError admission owner. Both candidates may import it
unchanged; charge the complete file and its engine-owned type dependencies to
both. This exception does not admit legacy query or mutation algorithms.

Public raw arguments enter existing admission at the required time. Internal
values are trusted. Localized assertions are permitted under the central plan;
do not add guards or wrappers to compensate for TypeScript correlation loss.
Use one broad operation context through composition, without mutable ambient
parent/model cursors or classes for each verb, storage orientation or depth.

The private `execute(modelName, operation, rawArgs, binding?)` boundary resolves
execution ownership once in `OperationContext`. With no binding, reads and
writes keep their qualified standalone routes. A `borrowed-transaction` binding
uses the exact supplied transaction driver directly; the candidate does not
open or close a transaction, create a savepoint, disconnect, replay, or fall
back to the factory driver. An `atomic-array` binding is a capability refusal
and must throw `TransactionError` before raw-argument admission or provider
work. `usesBatch` describes only the standalone physical batch route; it is not
an atomicity, lifecycle, recovery, or commit-certainty fact. Keep the retained
program specimen mechanically callable through the same private shape without
adding another ownership model.

The private `prepareBatch(modelName, operation, rawArgs)` boundary enters the
same schema admission and command dispatch with a preparation-owned
`OperationContext`. It may return only the existing `PreparedBatchOperation`.
Preparation queues complete static statements and a result parser; it never
reads, dispatches, opens a lifecycle, or executes a segment. Only the exact
dynamic-planning sentinel becomes `undefined`; validation, construction, and
provider failures surface. Scalar `createMany`, scalar `updateMany`, and
`deleteMany` each lower to one set-oriented statement. A relation-bearing
`updateMany` stays on the ordinary captured-record series in its provider order.
An admitted empty `createMany` is a completed zero-query package whose parser
returns `{ count: 0 }`, or `[]` for the selected form; it is not incomplete
planning and emits no dummy statement. Admitted `updateMany`/`deleteMany`
limits and relation-bearing `updateMany` terminal selection reuse these same
set or captured-series owners. Scalar-return selection, scalar `omit`, relation
`omit`, and relation projection remain refused at their existing boundary; an
incompletely packageable operation still returns only the dynamic-planning
sentinel.
The existing client array owner alone merges package windows or supplies one
borrowed transaction for sequential fallback. Do not add a candidate-owned
array coordinator, transaction protocol, or standalone segment fallback.

G3P-04 admits root-conflict suppression only when the standalone operation owns
the member rollback region. The relation-bearing record series uses the existing
transaction driver's nested `withTransaction` boundary; it suppresses only the
exact annotated root unique failure after successful rollback. A plain
`borrowed-transaction` binding remains refused before member effects even when
its driver supports savepoints: neither the payload nor the binding grants that
authority. G3 public composition must receive a separately admitted rollback
region from the existing callback/array transaction owner. That handoff is not
proved by G3P-04 and must not be inferred from transport capability.

Construction-time suppression refusal belongs to the existing command analysis
pass. A statically constructed suppressed descendant directly requires the
context-owned suppression capability during that traversal. The requirement is
operation-wide across both `Choose` arms even though ordinary branch-local
refusals remain conditional. It fires before the enclosing root can write. The
runtime member boundary reuses the same rule for dynamic series; do not add a
payload walker, public permission, or operation-local policy flag.

Failed-INSERT producer attribution is evidence, not replay authority.
`OperationContext` admits attempt replacement only on the standalone physical
batch route after its exact rejection proof. Borrowed and preparation-owned
execution preserve the original failure and never replace an attempt.

A selected static record series publishes terminal state, not each member's
intermediate state. Retain complete identities only for successful roots, finish
all members, then execute one ordinary projection over their exact predicates;
use the adapter expression owner for input order and the query decoder for the
expected row count. Do not add a UNION-per-member projection, hidden result
carrier, original-key fallback, or identity migration. A later primary-key move
keeps the established refusal.

G3P-05 keeps selector SQL and dependency facts in one `Queries.where`
traversal. A relation read records its resolved model and membership path plus
conjunctive scalar equalities. `Commands.analyze` consumes that same fact for
selected update/delete conflicts and complete-identity disjointness. Negative
or alternative predicates are unknown, not proof of disjointness. Do not add a
second payload walker, relation-filter parser, or model-name-only dependency.
Selected `updateMany` and `deleteMany` series publish their admitted semantic
write to that same analysis pass: the selection read is ordered first, then the
existing record/deletion analyzer accounts for scalar, relation, membership,
and existence effects. Do not infer selected-series safety from the selector
alone.

Variant collection mutation order belongs to `RelationBody`: admit all guards,
clear every configured variant junction once, then apply writes in caller order.
Empty set and unmentioned variants still clear, while targets survive. One
attempt-owned selected-series capture serves updateMany and deleteMany. Direct
clear/write keeps the captured target; a physical batch rechecks the target at
the established mutation boundary. Do not fork a variant interpreter or a
second series protocol.

The private recursive-read fit is one `Queries.recursive(model, traversal)`
operation for one chosen ordinary self-relation. Seeds shape roots; descendant
arguments apply `where`, `select`, `include`, and `orderBy` at every level.
There is no recursive `take`/`skip`, nested edge graph, or public schema. One
adapter-composed recursive CTE carries seed, depth, a complete mapped identity
path, and the ordinary projected value into `OperationContext.read`; the
existing decoder reconstructs path occurrences without global key deduplication.
Seed-local ordering is not emitted inside a recursive UNION anchor. The final
projection orders roots by seed and each seed's admitted order terms, then
orders descendant siblings by the traversal terms.
Keep provider rows flat when useful. Measure statement/bind/provider-row/output
growth separately from source-derived occurrence and transient-copy counts; do
not invent an allocation metric API.

Independent SQLite fixtures own expected results, database state, defaults,
failure timing and causal cuts. Cross-engine comparison is semantic; exact SQL
and event tapes belong only to replay within one candidate. Run validation
serially on a stable source tree under the existing resource ceilings.

Preparation qualification reserves seed ranges rather than changing an
accepted campaign: G2 remains 2000–6999 and the final preparation schedule is
7000–7099. Preserve one parent receipt plus each batch's verified, Vitest, and
compact campaign summary. Large per-batch corpora and progress snapshots are
regenerated from the recorded seeds; only named saved-replay corpora belong in
the durable package. Count provider top-level tests separately from repeated
world executions, and keep PGlite qualification distinct from native
PostgreSQL/MySQL claims. A qualified preparation is still closed until its
independent review and final root review accept the frozen identity.

Credential-free qualification has two distinct owners. The intentional Raptor
fixed stage lists supported local suites from the Raptor manifest; ordinary
extended-local discovery excludes every explicit Raptor fixed and native
suite. A native suite never becomes credential-free merely because its file is
locally discoverable. Pin both retained inclusion and exclusion through the
actual stage selector, not a filename convention.

S1–S4 passing is only the representation checkpoint, not completion of G1.
Early timing precision is deferred to G4; correctness and safe resource bounds
remain mandatory. Do not select, merge, widen or publicly route a candidate
before the measured checkpoint and adversarial review.
