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

`Queries` owns one read language. One prepared predicate vocabulary addresses a
target — a physical column, a JSON value inside one, or an aggregate over one —
so `where` and `having` can never admit different operators or bind an operand
two ways. `prepareOperations`/`prepareOperation` prepare every one of them,
`lowerPredicate`/`lowerOperation` lower them, and `prepareHaving` builds
aggregate targets for that same walker. Do not add a second operator switch.

`Queries.orderTerms` is the one order owner: scalars, `{ sort, nulls }`, to-one
relation paths, collection `_count` and distance are all sort keys, and it marks
the direct scalar keys a cursor may use. An unspelled `nulls` is not a
placement — the bare direction names the provider's own default, and
`totalOrder`, the windowed path and only it, fills the established default,
because the cursor predicate must name the same total order the statement emits.

One page owner, `Queries.page`, computes the total order, the cursor predicate,
the signed window and `distinct` — for the root read (`select`), for the
aggregate input window (`aggregated`) and for every nested to-many node inside
its parent's correlation scope. Nested pagination is that same operator, never a
second engine. `grouped` is the ONE named exception: it emits the raw signed
`take`/`skip` without the page owner, because `groupBy` admits no `cursor` and
no `distinct` (`validation/model/args/aggregate.ts`) and the shipped
`operations/groupby.ts:110-114` emits the raw signed take too. That is parity,
not a divergence; do not widen the exception to a verb that admits a cursor.

`Queries.read` states each read verb's cardinality and public shape over that
one select/projection/decoder: every verb answers `{ query, single, value,
result }`, and the private entry adds only the public `…OrThrow` error identity.
Consumers read those published facts (`commands/index.ts` `publishedFacts`, and
the retained `program/` specimen's single read entry) instead of deriving them;
there is no second `findMany`/`findUnique`/`groupBy` dispatch. A prepared shape
carries every fact the decoder needs, including the direction of a reversed
window (`relationShape`), so a nested negative `take` is restored per parent by
the same decoder rather than by a second reversal site.

`Queries.fieldValue` is the single destination-aware operand owner for filters,
cursors, identities and assignments, and `decodeScalar` — reached only through
`decodeValue` from `decodeQuery`/`decodeProjection` — is the single leaf
decoder. Both reuse the existing validation codecs; neither may be duplicated
per verb or per storage.

`Queries.wholeValue` is the one answer to "does an admitted scalar payload name
a whole value?". A non-plain object is one whole value in EVERY domain — a
`Uint8Array`, `Decimal` or `Date` inherits methods with the same names, and a
`Sql` fragment is not a record either — so only a plain or null-prototype
record's own `set` names the value inside it. Its two consumers read that one
answer: `prepareUpdate`, which also needs to know when the payload names an
operator instead, and `commands/assignments.ts`'s `scalarAssignment`, which
needs only the value. Do not restate the predicate at a consumer.

`Queries.countedMemberships` is the one counted-slot owner: it answers which
memberships a slot counts — one edge for an ordinary relation, EVERY arm for a
variant carrier — and `correlatedCount` sums them through the adapter. The
`_count` projection and the `_count` order term both read it, so a variant
carrier is countable in the projection and in the ordering from one place; no
second correlated-count subquery exists.

`Queries.carriedValue` is the one carrier transport rule for a value that rides
inside a JSON document: a value that is already JSON stays a document, a
`bigint` crosses as text and a `blob` as hex. Its three consumers are the
aggregate carrier, the recursive projection and the relation projection; a
traversal does not spell a weaker rule of its own.

A tagged quantifier addresses the tagged membership: `prepareSlotPredicate`
reads `some: { type: T, is: P }` as "some member of arm `T` satisfying `P`" and
`none: { type: T }` as "no member of arm `T`". `every` is the only one that must
also state the arms it did not name — it is a claim about the WHOLE collection,
so a member of any other arm falsifies it — and it conjoins `none` over every
other configured arm.

Adapter capabilities decide GeoPoint tiers and vector support.
`Queries.distanceExpression` raises the named refusal — the three registered
vector sentences in the shipped order and words
(`builders/distance-builder.ts:142-188`), then the GeoPoint `distance` tier —
and never emulates a tier in JavaScript. One distance expression serves the
filter, the order key and the projected `_distance` leaf, so a provider tier is
asked about once and the output name is stated once.

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

`Queries.updateValue` is the sole interpreter of admitted scalar update
operators. It and `updateAssignment` consume ONE prepared payload
(`prepareUpdate`), so an operator can never be admitted in one spelling and
refused in the other; operation contexts must not reconstruct those operators in
JavaScript. Every operator crosses the adapter's own vocabulary, including
`expressions.integerDivide` — the seam that exists because an integer key's
quotient is the dialect's truncation, not JavaScript's, and the expression form
must name the same value the `SET` clause writes. The one shape with no
expression form is an exact decimal under `multiply`/`divide`, whose assignment
is a guarded coefficient rewrite the provider owns; that refusal is registered.
A payload that names no operator at all answers the shipped
`Unknown update operation:` sentence and identity
(`builders/set-builder.ts:217-219`), before any statement, and never degrades to
a bare `Error`. Internal mutation-target captures stay privately decoded so
later query planning receives canonical scalar values.

`finishOne` and `finishMany` state operation-owned result cardinality. That
cardinality is independent of the number of physical terminal queries, and
both paths consume the same terminal-result decoder. Callers must not infer
semantic cardinality from a single-query versus query-array shape.

Only the root static-series boundary publishes its count or selected rows and
finalizes operation scratch. Nested `executeRecords` returns its count and
identities to the enclosing command; it must not finish terminal results,
flush batch-preparation members, advance root completion, or clear scratch
needed by later siblings. Root and nested series share record execution, not
result or cleanup ownership.

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

Named retention: three modules from the shipped `query-engine/` tree are
imported at runtime, and these are ALL of them, so a legacy scan does not have
to re-derive the list. (Only that tree: `@errors`, `@sql`, `@schema/**`,
`@validation/**`, `@adapters/**` and `@drivers/**` are ordinary boundaries the
brief keeps available, and `@client/client` reaches `route/client-route.ts`.)
`write-engine/parse-boundary.ts` (`shared/schema.ts`) remains the existing
schema-to-ValidationError admission owner. `query-engine/bind-budget.ts`
(`shared/operation-context.ts`) is a pure `Sql` chunker over the driver's
normalized verified bind capacity, shared by `write-engine`, `operations`,
`pattern` and the candidate alike — a neutral boundary, not the shipped engine.
`result/cache-value-codecs.ts` (`route/client-route.ts`) is the official cache
value-codec owner and imports no compiler, lowerer, executor or result parser.
Both candidates may import them unchanged; charge the complete file and its
engine-owned type dependencies to both. This exception does not admit legacy
query or mutation algorithms.

Public raw arguments enter existing admission at the required time. Internal
values are trusted. Localized assertions are permitted under the central plan;
do not add guards or wrappers to compensate for TypeScript correlation loss.
Use one broad operation context through composition, without mutable ambient
parent/model cursors or classes for each verb, storage orientation or depth.

The private `execute(modelName, operation, rawArgs, binding?)` boundary resolves
execution ownership once in `OperationContext`. With no binding, reads and
writes keep their qualified standalone routes. A `borrowed-transaction` binding
uses the exact supplied transaction driver and never disconnects, replays, or
falls back to the factory driver. An `atomic-array` binding is a capability
refusal and must throw `TransactionError` before raw-argument admission or
provider work — it is raised in the constructor, before `admit`. `usesBatch`
describes only the standalone physical batch route; it is not
an atomicity, lifecycle, recovery, or commit-certainty fact. Keep the retained
program specimen mechanically callable through the same private shape without
adding another ownership model.

ONE rule decides the physical envelope, and it lives in `OperationContext.run`:
the envelope opens at the first statement that is not the operation's ONLY
statement. An operation that reaches its terminal statement having issued no
other runs that statement directly — no standalone BEGIN/COMMIT and no savepoint
inside a borrowed transaction — which is the shipped `runStatementAtomic`
condition (`OperationExecutor`'s `compileSingleStatementCandidate` +
`canExecuteDirectly`) restated in this engine's vocabulary. Any other operation
raises the envelope sentinel BEFORE its first round trip and its body is
constructed again inside the region, so nothing has reached the provider at that
point. `dispatch()` is the one site every provider round trip crosses, which is
what lets the rule be stated in a single place and still be the operative
decision. A root `create` or `update` that names no relation and whose prepared
projection is RETURNING-safe folds onto the set-oriented owner
(`Commands.rootCreate` / `rootUpdate` -> `OperationContext.createMany` /
`updateMany`) plus one cardinality decision; that fold is why the frozen fast
path costs 1 statement and 0 transactions for a root `create`, the shipped
count. A verb no longer decides the envelope in one place and the route in
another.

The same rule answers the TRANSPORT and not only the envelope: a set-oriented
mutation that is the operation's ONLY statement runs on the plain execute path
on every driver, a batch-only one included, so `OperationContext.setMutations`
asks the rule before it chooses between `_execute` and `_executeBatch` — which
is where the shipped `runStatementAtomic` sends this exact shape. That is
Arnaud's **D-7** decision (2026-09-15): a one-statement BATCH is what made the
driver seam attribute `statementIndex: 0` (`drivers/driver-diagnostics.ts:35-36`)
to a rejection the shipped engine attributes no index to — for the folded root
write and for every relation-free `createMany`/`updateMany`/`deleteMany` alike —
and with the envelope gone that whole family of candidate-only meta disappears,
at the price he accepted: a folded root single-record write rejected on a
batch-only transport publishes the shipped raw error, with no segment progress
and no `mayHaveCommittedSegment` at all.

A packaged operation has no JavaScript postcondition available, so its
single-row premise becomes a STATEMENT: one `assertions.exists` over the same
selector, queued ahead of the mutation and declared to the array owner, which
aborts the batch and lets this operation reconstruct its own `NotFoundError`.
And a statement-atomic operation has no record series: `failure()` attaches
`recordSeriesProgress` only when the transport actually has one — a prefix
phase, a committed segment, or a segment that may have committed AND a record
series to report it on. A set-oriented statement's window is not a member, so
an UNCERTAIN outcome on it stays internal, which is the shipped single-operation
meta; a window that DID commit is a committed segment like any other and still
reports, witnessed by `g4/unit02/malformed-result-cuts.test.ts` cell 1b and by
`g4/unit02/lone-statement-transport.test.ts` row 6 — the shapes that still have
a series after D-7, since the G2.9 atomic-batch specimen now publishes none.
Internal is not lost: the durable
phase reaches the client's cache rail from the transport that learned it,
through `ExecutionBinding.writeOutcome` (`WriteOutcomeSeam`) — `submit()` for a
batch and `dispatchSetMutations` for the lone statement D-7 leaves outside one,
which are the same two situations the shipped executor notifies from
(`runAtomicBatch` and `runBorrowedStatementAtomic`) — so no consumer reads a
cache signal back out of published progress. The OPERATION's own failure stays
primary whenever the client's listener throws, in ONE composition
(`retainOutcomeFailure`, the shipped `retainWriteOutcomeFailure` restated — the
candidate may not import `@extensions/query`: it pulls in the shipped write
engine's routing table): `stateWriteOutcome` composes where the primary is
already in hand, and the batch transport, which acknowledges before it decodes,
HOLDS the listener's failure and composes it once the operation has answered
(`settleSubmitted`), which is the shipped `runAtomicBatch` order. A missing-row
premise (`published`) is a statement about the world rather than a report about
the transport, so it carries no progress at all — which is the shipped
`NotFoundError` meta, `{ model, operation }`, on every driver.

A `borrowed-transaction` operation owns a region only when its caller SAID so.
`operationRegion` is that grant — the callback-transaction route supplies it
because it opened no scope of its own — and with it the candidate opens exactly
one nested region when the operation needs more than one statement. Without the
grant a borrowed operation owns none: its caller's scope is the unit, every
statement runs directly on the borrowed driver, and a failing one poisons that
scope exactly as the shipped `runStatementAtomic` and `runLinearOn` paths leave
it. `memberRollback` is never mistaken for it — it is MEMBER isolation only, and
a member rollback opens inside whatever scope the operation is currently running
in, because re-entering the caller's grant from inside a region it already
opened is the measured `TransactionError: … cannot be used while its nested
transaction is active`. Both grants are declared on `ExecutionBinding` and read
by `OperationContext.region()`, which is the one owner of this question.

`Queries.returningSafeProjection` is the one owner of "may this projection ride
a `RETURNING`?" — `fields.every(kind === "scalar")` — stated in the module that
owns the field kinds. The physical owner (`OperationContext`) and the root folds
and bulk selection in `commands/commands.ts` all consult it; a physical owner
does not classify a projection the projection owner already understands.

Whether a nested write's unique target selector names its row through the
CONSTRAINT is one predicate, `nestedTargetAddressesConstraint(edge, verb)` in
`commands/selection.ts`, consulted at the three nested target sites in
`relation-body.ts` — the `disconnect`/`delete` lookup, the
`connect`/`connectOrCreate`/`upsert`/`update` selector, and the `set` target —
and nowhere else. The rule is per EDGE KIND because the shipped engine's is: a
JUNCTION target is a discriminator in both phases (`RelationJunctionPart.ts`
`buildFindUnique` at `:1509`, `:1629`, `:1663`, and `JunctionStatements.ts:322-323`
compiling `whereUnique` with `buildWhereUnique`), while a REFERENCE-held target
of `disconnect`/`delete`/`update` is the one family `uniqueSelectorConjuncts`
(`write-engine/shared.ts:671`) recombines into a filter. Root verbs state
`unique: true` themselves — their selector is the root `where`, not a nested
target — and a bulk member's `where` never asks. `SelectionSource.unique` points
at the predicate instead of restating the classification.

The candidate's client route (`route/client-route.ts` `runCandidate`) states
WHICH SITUATION an operation is in and never whether an envelope is needed. A
root operation is `standalone` — no borrowed driver, no grant. An existing array
owner's sequential fallback (`driverOverride`) gets the exact borrowed driver
and NO grant, so the array owner's transaction stays the unit, mirroring the
shipped `runLinearOn`. Inside `$transaction(callback)` the engine is bound to a
transaction driver, the caller opened no scope for this operation, and the route
hands over both grants. Every situation also carries `writeOutcome`, the
client's own cache-invalidation rail — not a fourth situation, just the rail
handed to the only thing that knows when a write became durable. The route
opens, closes and retries nothing, and never falls back to the shipped engine.

One prepared operation per request: `prepare(modelName, operation, rawArgs)` in
`commands/index.ts` admits the raw input exactly ONCE and publishes the admitted
`args` and, for a read verb, the prepared read's own facts; `execute`,
`prepareBatch` and the route's cache codec all read that same handle. The client
lifecycle is admission-first by construction — a cache must key before it can
look up, and an interceptor must see the payload before it calls `proceed()` —
so no consumer re-admits, and nothing publishes a re-rawed payload. Admission
itself stays lazy inside the handle, because the client's own `PendingOperation`
is lazy.

A cached read's value codec is composed from the official owners in
`result/cache-value-codecs.ts` (`compileScalarCodec`, `compileWidenedSumCodec`,
`recordCodec`, `arrayCodec`, `nullableCodec`, `taggedRelationCodec`) through the
leaf's own declaring `Scalar`, carried as `Leaf.scalar` by the read owner. It is
never re-dispatched from a leaf's `type` name, which would be a second
scalar-meaning authority. The leaves with no declaring scalar are the read
owner's OWN values — `_count`, `exist`, a non-decimal `_avg` and `_distance` —
and naming those three is the same classification the shipped compiler makes; a
shape with no fixed codec, such as a recursive read's unbounded depth, is
refused rather than half-encoded.

The private `prepareBatch(modelName, operation, rawArgs)` boundary enters the
same schema admission and command dispatch with a preparation-owned
`OperationContext`. It may return only the existing `PreparedBatchOperation`.
Preparation queues complete static statements and a result parser; it never
reads, dispatches, opens a lifecycle, or executes a segment. Only the exact
dynamic-planning sentinel becomes `undefined`; validation, construction, and
provider failures surface. Scalar `createMany` lowers each maximal contiguous
physical row-shape run to one set-oriented statement, further partitioned only
by `compileBindBudgetChunks` against the driver's normalized verified bind
capacity; terminal identity reads use that same neutral chunk owner. Each
default-only row needs its own
`DEFAULT VALUES` statement. Scalar `updateMany` and `deleteMany` each lower to
one predicate mutation statement. A relation-bearing
`updateMany` stays on the ordinary captured-record series in its provider order.
An admitted empty bulk result—empty `createMany`, or zero-limit `updateMany` /
`deleteMany`—is a completed zero-query package whose parser returns
`{ count: 0 }`, or `[]` for the selected form; it is not incomplete planning
and emits no dummy statement. Other admitted `updateMany`/`deleteMany` limits
and relation-bearing `updateMany` terminal selection reuse the same set or
captured-series owners. Returning adapters package scalar selection and omit
with the mutation. Non-returning adapters prepare mutation and projection
meaning once, then use the operation-owned locked identity capture and bounded
terminal-reader path during interactive execution; preparation returns only the
dynamic-planning sentinel when that readback cannot be statically packaged.
Standalone mutation statement windows on a batch-only driver always enter the
existing `queue()` / `submit()` route. The same route owns atomic dispatch,
acknowledgement, uncertain commit progress, and result-phase failure after an
acknowledged write; no scalar mutation loop dispatches those statements
directly.
The existing client array owner alone merges package windows or supplies one
borrowed transaction for sequential fallback. Do not add a candidate-owned
array coordinator, transaction protocol, or standalone segment fallback.

G3P-04 admits root-conflict suppression only when the operation owns the member
rollback region. A standalone interactive operation uses the existing
transaction driver's nested `withTransaction` boundary; a borrowed operation
must receive the executable `memberRollback` capability from the existing
callback/array transaction owner. Both suppress only the exact annotated root
unique failure after successful rollback. A plain `borrowed-transaction`
binding remains refused before member effects even when its driver supports
savepoints: neither the payload nor transport capability grants that authority.

Construction-time suppression refusal belongs to the existing command analysis
pass. A statically constructed suppressed descendant directly requires the
context-owned suppression capability during that traversal. The requirement is
operation-wide across both `Choose` arms even though ordinary branch-local
refusals remain conditional. It fires before the enclosing root can write. The
runtime member boundary reuses the same rule for dynamic series; do not add a
payload walker, public permission, or operation-local policy flag.

Failed-INSERT producer attribution is evidence, not replay authority. The scope
is stated once, by `OperationContext.recoveryRejection`: it answers `undefined`
unless the ownership is standalone AND the route is the physical batch, so
borrowed and preparation-owned execution preserve the original failure and never
replace an attempt. Its one caller, `CommandExecution.recover`, restarts at most
once, and only for the exact rejected producer's own selected unique constraint.

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

Six observable answers were decided by Arnaud on 2026-09-15 and are contracts
from here on; do not re-open them as divergences, and do not "fix" them toward
the shipped engine.

An exact-decimal primary key under `increment`/`decrement` is SUPPORTED. The
arithmetic is exact in coefficient space, the provider's own assignment names
it, and the registered G3 witness reads it back. `multiply`/`divide` on the
same key stay refused in the shipped engine's sentence, because those two carry
a provider-chosen rounding no engine can name portably. The rule is the
operator's domain, not the field's: keep it in the one owner
(`EngineSchema.keyPortabilityRefusal`) and never add a second sentence. Naming
an exact decimal under `multiply`/`divide` as a symbolic expression is
AUTHORIZED but unwritten: no admitted public request reaches it, so writing it
now would be dead code; the unit-level refusal pin stands until a reachable
shape exists.

Every other row-key shape answers the shipped engine's own sentence, from ONE
owner — `EngineSchema.keyPortabilityRefusal` — asked where the shipped engine
asks it and WHEN the shipped engine asks it. A `number` key under any arithmetic
is refused as non-portable, and a key update naming anything but exactly one
operation — `set` beside an operator, or none at all — is refused for its arity.
The positions are: admission, for a root `update`/`updateMany`
(`EngineSchema.admit`); the found-arm gate of an `upsert` whose update payload
names relations (`commands/commands.ts`, the shipped `updateHasRelations`
gate); and the three NESTED positions `commands/relation-body.ts` already
admits an update payload in — a nested child `update` or `upsert` selector arm,
and an `updateMany` member. A nested `update` and an `updateMany` member refuse
during construction, before any statement, because the shipped engine asserts at
its own compile sites (`RelationWritePart.ts:856`, `:898`). A nested `upsert`
does not: the shipped engine builds the same assertion as a closure
(`RelationUpsertPart.ts:1006`) and invokes it only inside the FOUND arm
(`:468`), so the candidate hands that refusal to the found arm — the arm's own
deferred `Assignments`, raised when execution observes the choice — and an
ABSENT target takes the create arm with its update payload unjudged, on both
engines. A wider placement would refuse a request the shipped engine performs,
which is what `keyPortabilityRefusal`'s docblock means by "an upsert that
CREATES a row the arithmetic never touches".

Two facts, then, not one absolute. At every position the predicate IS asked,
`set` never wins over an accompanying operator, and the sentences are the
shipped ones from the same owner: no per-verb branch, no second walk. And a root
`upsert` whose update payload names NO relation judges the key payload on
NEITHER engine — `UpsertOperation.ts:496` gates `updateLegality` on
`updateHasRelations` and `commands/commands.ts` mirrors it on `namesRelation` —
so `set` wins there on both. That is parity, stated here so the next reader does
not take it for a regression and widen the gate. `connect`, `connectOrCreate`
and a `deleteMany` member carry no update payload and ask nothing. Where the post-transition key value has to be named at analysis (a
child-held relation whose single-member reference key is the key being
rewritten, with the locator's discriminator pinning the pre-value), the
transition owner `EngineSchema.keyTransitionRefusal` answers first, in its own
sentence, so neither arm of an upsert writes.

A multi-statement write as an array member on a batch-only driver is PACKAGED
and committed, not refused. The shipped route's insertId-scratch refusal is
retired: the candidate's package carries the whole write and one native batch
commits it. Do not re-introduce that refusal in the route, and do not re-derive
"does this package use scratch?" anywhere outside the packaging rule.

The query interceptor's `context.input` for `upsert` is the ONE admission —
scalar defaults filled into `create`, assignments normalized to `{ set: … }` in
`update` — on both arms. It is the payload that actually runs, which is the rule
every other verb already obeyed. Never publish a re-rawed arm: reading the
caller's arms back would be a second admission.

A `connect` or `connectOrCreate` stores the LOCATED row's key bytes in the
foreign-key column, in every position (a child-held `create`, a parent-held
`update`, a junction link). Under a case-insensitive collation the stored bytes
may differ from the request's literal, and the located value is the contract:
the bytes written always exist in the parent table.

A batch-only expression publication of a non-`int` field is a registered
`QueryEngineError` naming the model, the field and the operation, with `meta`
`{ model, operation, field }`, raised before any statement of that update is
dispatched. It is a capability boundary with a public identity, not an internal
invariant: keep the identity if the batch scratch ever learns a second domain,
and never let it degrade to a bare `Error`.

A junction `delete` removes the LINK row and then the target, in one region.
The link references the target, so the reverse order is a foreign-key violation
wherever the constraint does not cascade; the shipped engine states the same
order (`RelationJunctionPart.compileDelete`). A `disconnect` places the removal
alone and a reference-held target places its deletion alone — the ordering
belongs to the junction `delete` and to nothing else. The owner is the
`disconnect`/`delete` arm of `RelationBody.relation`
(`commands/relation-body.ts`), which places both commands with the same origin
so the body keeps insertion order; no other verb or edge kind gains a statement.
