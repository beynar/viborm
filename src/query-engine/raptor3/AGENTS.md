# Raptor 3 — the shipped engine

The central plan in `docs/architecture/raptor3-implementation-plan.md` governs
this explicitly authorized clean-sheet rewrite. Since the C-01 cutover
(Arnaud's decision D-10, 2026-09-16) this directory IS the production engine:
`VibORM`'s constructor builds `createCandidateRoute(...)` for every client, so
the route is the one operation owner behind the unchanged public API rather
than a selectable alternative, and the legacy engine it replaced has been
deleted. It is still not a fallback, and nothing here is exported from the
package entry.

> **Provenance citations below name V1 files that no longer exist.** The pattern
> retirement (Arnaud's decision D-15) deleted the `pattern/` experiment and every
> owner it alone kept alive — `builders/`, `operations/`, `result/`'s parser
> tree and all of `write-engine/`. Follow-up F-2 moved the last two survivors to
> their consumers: `parse-boundary.ts` is `shared/parse-boundary.ts` here, and
> `groupby-fields.ts` is `result/groupby-fields.ts`.
> A `file:line` reference to one of them records WHAT V1 did and where the parity
> argument came from; read it in git history (`e8114ed9`), not on disk.

G1-01 compared structured commands (`commands/`) with a scoped relational
program (`program/`) on the same S1–S4 public recipes, and charged `shared/`'s
genuinely shared query/projection and boundary work whole to each candidate.
`shared/` still holds that work; the cost rule now has one payer. The discipline
the comparison imposed on its winner stands: no cosmetic runner over one hidden
mutation compiler, and no per-fixture names, constants, algorithms or copied
oracle.

The executed G1-01 checkpoint selected `commands/` as the sole expansion path.
`program/` was retained after that as its private comparison specimen and was
DELETED at release unit S — 636 lines in two files, reachable from no public API,
carrying a third copy of the dependency refusal, and no longer an ACTIVE
comparison, which is the only form ELEGANCE admits inside the shipped graph.
Read it in git history (`e19b20759`), not on disk; the `commands/` halves of
`tests/raptor3/candidate*.test.ts` are the behavioral witnesses that remain.
Construction and same-tree dependency analysis belong to `commands/commands.ts`.
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
orientation, slot clearability, and the query owner's per-adapter views
(the scalar leaves and the default projection). Reuse original resolved descriptors,
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

*Addendum (R2b, 2026-09-21).* A nested to-many page that carries an ORDER BY
also carries a BOUND, because the aggregate above it reads its rows IN ORDER:
MySQL merges an unlimited derived table into the query that reads it and the
merge takes the ORDER BY with it (the rows then arrive in storage order). The
bound is the caller's own window wherever it asked for one — the offset-only
window already needed this same spelling for its bare OFFSET — and the
adapter's `noLimitValue` where it asked for none; a dialect that keeps a
derived order unbounded declares none (PostgreSQL) and emits nothing. It is not
a second window and not a limit a caller can observe: `take` still decides
which rows come back.

`Queries.read` states each read verb's cardinality and public shape over that
one select/projection/decoder: every verb answers `{ query, single, value,
result }`, and the private entry adds only the public `…OrThrow` error identity.
Consumers read those published facts (`commands/index.ts` `publishedFacts`; the
deleted `program/` specimen's single read entry was the other) instead of
deriving them; there is no second `findMany`/`findUnique`/`groupBy` dispatch. A
prepared shape
carries every fact the decoder needs, including the direction of a reversed
window (`relationShape`), so a nested negative `take` is restored per parent by
the same decoder rather than by a second reversal site.

`Queries.fieldValue` is the single destination-aware operand owner for filters,
cursors, identities and assignments, and `decodeScalar` — reached only through
`decodeValue` from `decodeQuery`/`decodeProjection` — is the single leaf
decoder. Both reuse the existing validation codecs; neither may be duplicated
per verb or per storage.

*Addendum (R2b, 2026-09-21).* A single value bound against a LIST field is one
MEMBER of that field's container (`has` is the operator that asks for one), and
a container carries what it was WRITTEN with. The two scalars whose column
spelling is PHYSICAL consume that fact inside `fieldValue`: a decimal's exact
`DECIMAL(p,s)` operand cast and a datetime's dialect rendering of the instant
(MySQL's naive `DATETIME`, which a JSON container has no column to hold) are
spelled as members instead — the same fact `nativeType` already states for the
decode leaf, which refuses to hand a list's native type to a literal. Every
other scalar crosses a container exactly as it crosses its column. Do not add
an operator-local converter for `has`.

*Addendum (identifier storage, 2026-09-23).* An identifier column's physical
form is the third such fact, and it is a fact of the COLUMN, not of the scalar:
a foreign key DERIVES its domain from the key it references, and a polymorphic
row carrier's id column names the key it stands in for
(`PhysicalField.reference`). `shared/identifier.ts` resolves it once per
(adapter, model, field) onto `Leaf.id`, beside `decimal` and `dateTime`, and
its four consumers read that leaf: `scalarValue` binds a COMPACT identifier
(payload bytes, or a PostgreSQL `uuid`) through `adapter.literals.id` — reached
by `fieldValue` and by a column target's operand, never by an aggregate's
`having` operand, which admission types as a number; `projectedColumn`, the
junction probe and `recursiveIdentity` carry a byte column as lowercase hex
(`transportedIdentifier`, null-guarded because SQLite's `hex(NULL)` is `''`);
`aggregateExpression` runs `MIN`/`MAX` over that transported text
(`aggregatedIdentifier` — PostgreSQL has no `min(uuid)`/`max(bytea)`); and
`decodeScalar` turns every domain field's physical value into the canonical
public string, keeping a text-stored value's own spelling on an INTERNAL read
exactly as the datetime arm does (FC-02B). A text-stored domain takes the
ordinary string arms everywhere and builds the SQL a plain string column
builds. The encode arm's out-of-domain case is an invariant (admission
canonicalizes every identifier operand; a captured key decodes to the
canonical string), and the text-predicate narrowing is admission's alone
(`validation/scalars/string.ts`), so there is no operator switch here for it.

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
same prepared description while keeping distinct query-local aliases. `Queries.assertExpectedRows` is
the ONE owner of a query-level row-count requirement — `decodeQuery` asks it for
a single-statement read and `publishedTerminal` asks it per terminal window,
where the window's own count still is a fact. Do not assemble a
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

**Addendum (FC-03).** An INTERNAL premise about a CAPTURED SET states prepared
meaning, never public syntax. `Queries.excludeIdentities` owns the complement of
a set of captured row identities — "this row is not one of the rows the engine
read" — composed from those identities' own equalities under the one combinator
owner, and both consumers of that fact (`CommandExecution.requireNoAddedMember`,
`OperationContext.requireCapturedSet`) ask it for the answer. A public `where`
payload cannot carry such a premise: N4 lets a model DECLARE a scalar or
relation named `NOT`, `OR` or `AND`, and the declared field wins the key, so a
hand-built `{ NOT: { OR: … } }` was read as that model's own field (the closure
review's executed failure). An empty captured set states no condition and
excludes nothing. What each consumer claims about its own set stays with that
consumer — a LIMITED capture claims no complement at all.

**Addendum (D-65, the captured set's consumption time).** A ROOT selected
UPDATE/DELETE over a captured set carries BOTH facts into its own statement: the
complete captured identity set and the prepared selector the capture ran
(`OperationContext.capturedTarget`, composed at `Queries` from the positive
counterpart of the complement above, `includeIdentities`, under `andSelectors` —
never public `where` syntax). A captured row that no longer satisfies that
selector is not mutated, on either route, and the existing cardinality check
turns the shortfall into the registered `<verb> selected-row cardinality changed
during its locked mutation.` sentence instead of a silent success publishing the
captured rows. The premises `requireCapturedSet` states ahead of the write are
unchanged and answer where they stand; a `limit` is not restated at the write,
because the capture already took that slice and the identity set IS the bound.
Failure and commit stay separate facts: an operation-owned interactive
transaction rolls back at its owner, while a batch that already ACKNOWLEDGED
keeps what it committed and reports it (`atomicity: "segment"`, `phase:
"result"`, `committedSegments`) — a check after dispatch cannot undo the batch it
judges, nothing is replayed and no progress is erased. A NESTED captured series
is the other half of the decision and is BOUNDED rather than enlarged: the
initial filter SELECTS the worklist — the members the complement premise
answered for — and is not a permanent per-member predicate, so an earlier member
may legally change what a later one was selected by, and a member that qualifies
after that boundary stays outside the worklist (no enlargement, no second
recovery; no predicate on a member's own write could see it). What each member
owes AT THE POSITION IT IS CONSUMED — its identity, its parent's, and its
relation membership — is unchanged and still enforced: this is not permission to
delete another parent's member after it moves. No `FOR UPDATE` claim about
phantoms, no serializable isolation, no blanket lock, no scheduler. Witnesses:
`tests/providers/docker/pg-captured-set-concurrency.test.ts` (17 cells on native
PostgreSQL, the default route kept apart from the forced non-RETURNING profile),
with `batch-captured-bulk`, `prepared-set-predicates`, `member-boundary-packaging`
and `published-key` as the credential-free consumers.

**Addendum (the repair prompt §2, the member's requirement is HELD).** "still
enforced" was true of the STATEMENT and not of its lifetime. A batch is one
transaction, not one statement: under READ COMMITTED each statement takes its
own snapshot, so a membership change committed after a premise answered is
visible to the write behind it — and the closure review measured exactly that,
a member moved to another parent between the unit's last premise and its own
ID-addressed DELETE being deleted for the parent that no longer held it. The
requirement is now re-taken where the member is CONSUMED
(`CommandExecution.holdMember`, beside the parent requirement `executeSeries`
already restates there) as a read that HOLDS what it proves for the rest of the
transaction, taken on the row that STORES the membership: a REFERENCE
membership is a column of the member's own row, so one held premise over that
row proves the membership, holds it and proves the row is still there; a
JUNCTION membership is a row of its own that no lock on the member reaches, and
it is taken under its own lock through `Queries.junction`, the read owner the
singular junction capture already uses. A locking read of the member alone does
NOT do: PostgreSQL re-evaluates a blocked write's qualification against the
updated TARGET row but keeps the original snapshot for subqueries over other
tables, so a membership carried into the effect as SQL waits for the racer,
wakes, reads a stale junction and writes anyway (measured both ways in
`g4/release/closure-repair/u2/receipts/13-substrate-probe.log`). Nothing
reselects, retries or replays: the failure is the one that member already owned
— the captured series' membership race for a deletion, the located target's own
sentence for an update — and whatever segment the unit already acknowledged
stands and is reported. The INTERACTIVE route holds the member ROWS already
(its capture reads `FOR UPDATE`), so only the junction row is left to take
there. D-65's bound is untouched: the filter that SELECTED the worklist is
still not re-asked at a member's own write, and a future joiner stays outside
it. The file is 28 cells; the three `driver.shape` pins are `[9, 8]`, the two
statements being the first member's held requirement and its junction row.

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
The latter imports no command types; it also served the comparison specimen
deleted at unit S.
One recovery method replaces both regions synchronously, without callbacks or
an await between installations. Dispatch keeps the identity of its own attempt.
Do not reintroduce snapshot/restore, visited-node journals or per-field reset
loops. Admitted values, committed continuations, transaction ownership, admission
history, confirmed/uncertain progress and the one-recovery allowance survive
replacement. A missing winner on recovery propagates the original rejection;
it never authorizes another INSERT.

Named retention: TWO modules from the shipped `query-engine/` tree are imported
at runtime, and these are ALL of them, so a legacy scan does not have to
re-derive the list. (Only that tree: `@errors`, `@sql`, `@schema/**`,
`@validation/**`, `@adapters/**` and `@drivers/**` are ordinary boundaries the
brief keeps available, and `@client/client` reaches `route/client-route.ts`.)
`query-engine/bind-budget.ts` (`shared/operation-context.ts`) is a pure `Sql`
chunker over the driver's normalized verified bind capacity, shared by the
deleted engines and the candidate alike — a neutral boundary, not the shipped
engine. `result/cache-value-codecs.ts` (`route/client-route.ts`) is the official
cache value-codec owner and imports no compiler, lowerer, executor or result
parser. The schema-to-`ValidationError` admission owner `shared/schema.ts` reads
was the third until follow-up F-2 moved it INTO this tree: it is
`shared/parse-boundary.ts`, the candidate's own source, and no longer a
retention. The candidate may import the two unchanged; charge the complete
file and its engine-owned type dependencies to it. This exception does not
admit legacy query or mutation algorithms.

Public raw arguments enter existing admission at the required time. Internal
values are trusted. Localized assertions are permitted under the central plan;
do not add guards or wrappers to compensate for TypeScript correlation loss.
Use one broad operation context through composition, without mutable ambient
parent/model cursors or classes for each verb, storage orientation or depth.

The private `execute(modelName, operation, rawArgs, binding?)` boundary resolves
execution ownership once in `OperationContext`. With no binding, reads and
writes keep their qualified standalone routes. A `borrowed-transaction` binding
uses the exact supplied transaction driver and never disconnects, replays, or
falls back to the factory driver. There is no `atomic-array` binding: the
array route prepares through `prepareBatch`, `ExecutionBinding` names two
variants, and a kind the type does not name is the compiler's refusal, before
any raw argument is read (N4, census row 31). `usesBatch`
describes only the standalone physical batch route; it is not
an atomicity, lifecycle, recovery, or commit-certainty fact. The `program/`
specimen stayed mechanically callable through that same private shape rather
than gaining a second ownership model; it is deleted, and nothing that replaces
it may add one either.

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
and no `mayHaveCommittedSegment` at all. The converse is the same price read
from the other side and is equally the contract (**D-7.1**, Arnaud 2026-09-16,
"accept the difference"): a root `update` or `delete` rejected before dispatch
on a batch-only driver publishes NO `statementIndex` where the shipped engine
publishes `0`, because the shipped fold is two statements (presence guard plus
mutation, a real batch) and this engine's is ONE statement with a JavaScript
postcondition, so the driver seam has no batch to index. It is a recorded
diagnostic-meta difference, pinned as row 7 of
`tests/raptor3/g4/unit02/lone-statement-transport.test.ts`; do not add a
per-verb branch or a second statement to manufacture the index.

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
primary whenever the client's listener throws, in ONE composition —
`retainWriteOutcomeFailure` at `@errors` (`src/errors/query.ts`), which this
engine imports exactly as the client and `pending-operation.ts` do (FC-05;
the engine's own restatement of it is deleted, and the addendum below records
why the rule lives at that boundary and not at the publication owner): `stateWriteOutcome` composes where the primary is
already in hand, and the batch transport, which acknowledges before it decodes,
HOLDS the listener's failure and composes it once the operation has answered
(`settleSubmitted`), which is the shipped `runAtomicBatch` order. A missing-row
premise (`published`) is a statement about the world rather than a report about
the transport, so it carries no progress at all — which is the shipped
`NotFoundError` meta, `{ model, operation }`, on every driver.

**FC-05 addendum (2026-09-21): why the composition lives at `@errors`.** The
engine's restatement `retainOutcomeFailure` is deleted, so the primary's
identity, its `cause`, the flattening of the publication owner's aggregate and
the listener order are stated once for the whole estate. The paragraph above
carried, until this unit, a stale reason for not importing the publication
owner ("it pulls in the shipped write engine's routing table"). That was written when
that function lived in `@extensions/query` and that module imported
`write-engine/routing`: C-01 deleted those classes and re-pointed the import at
`@query-engine/routed-operations`, so the routing-table hazard is gone. The
import is still one this engine does not take, for a MEASURED reason and not a
cycle: no file under `src/query-engine/raptor3/**` imports `@extensions/*` at
all today, and importing the publication owner would add
`src/extensions/query.ts` and `src/query-engine/routed-operations.ts` to
`shared/operation-context.ts`'s runtime closure (181 → 183). A directory cycle
is NOT what the placement avoids — `src/query-engine/pending-operation.ts`
already imports `executePreparedQuery` from `@extensions/query` at runtime, so
the `src/query-engine` ↔ `src/extensions` cycle is pre-existing and carries the
shipped path. That is why the pure rule moved to the boundary both layers
already depend on rather than being imported from the publication owner. The
composing sites are unchanged and stay four, because their timings differ:
`submit`'s dispatch-failure catch, the carried value's decode catch,
`settleSubmitted` and `stateWriteOutcome`. Pin:
`tests/raptor3/g4/parity/one-write-outcome-composition.test.ts`.

**U3 addendum (2026-09-21): what "the operation has answered" INCLUDES.** The
paragraph above is right that the batch transport holds the listener's failure
and composes it once the operation has answered. Until this unit "answered"
meant only that `submit`'s responses had been extracted and decoded: a captured
mutation's own cardinality — the rows its statement reached, against the rows
the capture named — was judged by its CALLERS, one statement after
`settleSubmitted` had already released the hold. Transport success is not result
success. The settlement therefore called a shortfall an answer that SUCCEEDED
and published the listener's failure alone, losing both the registered
cardinality sentence and the `atomicity: "segment"` progress attached to it —
measured on both verbs by the closure review. The SEMANTIC answer now lives
inside the settlement: `capturedMutation` takes the caller's own answer as
`answered` — the verb keeps its own sentence — and states it INSIDE
`settleSubmitted`'s region, so what follows is the composition this paragraph
already describes — the operation's failure primary, the listener's retained
beside it — while a successful answer beside a failed listener still publishes
the listener's alone. The rule generalises: a settlement region must contain
every judgement that can still turn this operation's answer into a failure, not
only the decode. The composing sites stay FOUR — the region grew, no fifth
composition was added — and nothing is replayed, because a check after dispatch
cannot undo the batch it judges. Pins: the three combined-failure cells of
`tests/providers/docker/pg-captured-set-concurrency.test.ts` (repair prompt §3).

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
a `RETURNING`?" — `fields.every(kind === "scalar" || kind === "sentinel")` — stated in the module that
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
opens and closes no scope of its own, and never falls back to the shipped
engine. It does not follow that nothing is ever attempted twice: the four
bounded recoveries below (§"Which recovery REPLAYS and which RE-PLANS") belong
to the engine, not to the route, and the batch re-entry is armed by READING
`meta.raceable` off the failure its own owner marked — `OperationContext.submit`
gates on `failure.meta.raceable === true` (Arnaud's D-32).

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
`recordCodec`, `arrayCodec`, `nullableCodec`, `taggedRelationCodec`,
`recursiveRelationCodec`) through the
leaf's own declaring `Scalar`, carried as `Leaf.scalar` by the read owner. It is
never re-dispatched from a leaf's `type` name, which would be a second
scalar-meaning authority. The leaves with no declaring scalar are the read
owner's OWN values — `_count`, `exist`, a non-decimal `_avg` and `_distance` —
and naming those three is the same classification the shipped compiler makes. A
recursive slot composes `recursiveRelationCodec` from the node's own row codec and the
prepared slot's cardinality, optionality and normalized depth: one iterative
enter/leave walker on both snapshot and materialization, the repeated key
exactly ABSENT at a numeric cutoff and PRESENT at an exhaustive natural end, a
cyclic value refused as a malformed snapshot, fresh objects and leaves on every
hit (RQ-05, `recursive-query/rq-cache.md`). The cache never
re-derives physical identity or the cycle policy — the decoder answered those.

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
binding owns no such region even when its driver supports savepoints: neither
the payload nor transport capability grants that authority.

Where the operation owns no member rollback region (a batch-only driver
standalone, batch preparation, or a `borrowed-transaction` binding without
`memberRollback`), the skip is DROPPED, never refused (Arnaud, 2026-09-24,
"Warn, drop skipDuplicates"). `OperationContext.admitsSuppression` is the one
rule and the one sentence: it answers whether the member may be skipped and, when
it may not, warns once per client lineage and model (the client's logger when it
routes warnings, `console.warn` otherwise) and the member runs as a plain member.
A duplicate then fails with the ordinary `UniqueConstraintError`, and members an
earlier segment committed stay committed, exactly as for the same `createMany`
without `skipDuplicates`. The rule is asked where the skip would be spent — at
`executeSkippableMember` for a record series and at the MySQL
`recoverableUniqueError` scalar path — so an arm that never runs never warns;
there is no construction-time refusal, payload walker, public permission, or
operation-local policy flag.

Failed-INSERT producer attribution is evidence, not replay authority. The scope
is stated once, by `OperationContext.recoveryRejection`, and that statement is
the one in the parity lane X section below — an ATTRIBUTION and PROGRESS fact,
never a transport fact. Borrowed and preparation-owned execution still preserve
the original failure and never replace an attempt, and a replacement still
restarts at most once, only for the exact rejected producer's own selected
unique constraint. (The earlier wording of this paragraph — "unless the
ownership is standalone AND the route is the physical batch", and "its one
caller, `CommandExecution.recover`" — was made false by U6.4 and is struck: the
allowance is spent by the owner that opened the region as well.)

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

A recursive relation projection (`recurse` on a self relation node in `select`
or `include`) is an ordinary field of the node that asks for it; the private
root-only `Queries.recursive` fit is retired (ledgers under
`docs/architecture/raptor3-evidence/recursive-query/`).
`Queries.lowerRecursiveRelationProjection` lowers it into that relation's
column: a statement-local recursive CTE (`UNION DISTINCT`) that discovers only
complete parent/child identity facts through the resolved membership and the
collection filter, with a depth column only under a numeric cutoff; then one
ordinary projected document per distinct node, and the edge facts ordered per
parent by `Queries.completeOrder` — the ordinary window's one tie-break —
packed into the private `__rq_root`/`__rq_nodes`/`__rq_edges` carrier, whose
root is the outer row's own key (the CTE is evaluated per outer row, so it
carries no root column). The carrier's member names are one module constant
(`RECURSIVE_CARRIER`) and every identity in it — root, node key, edge endpoint
— is encoded by one owner (`Queries.recursiveIdentity`) from the raw key
columns, so the texts the decoder matches agree by construction. Where
the adapter spells `LATERAL` (PostgreSQL, MySQL) that CTE and its two readers
live in a lateral derived table inside the carrier's scalar subquery: MySQL
materializes a correlated CTE that is read twice once per statement and would
hand every later outer row the first row's facts; SQLite has no `LATERAL` and
evaluates the correlated CTE per row as written, once per reader — twice per
carrier (nodes and edges) — where PostgreSQL materializes it once per outer
row.
`Queries.decodeRecursiveCarrier` validates that carrier — every bounded edge
reachable at its recorded level, every bounded hop below the cutoff carrying
the parent's one set of children at the next level, every fact consumed, every
node reached — and unfolds fresh public occurrences iteratively along one
active path seeded by the outer row; the live cache stores and restores them
through `recursiveRelationCodec`. Its carrier checks refuse through
`InvalidScalarResult`, whose `scalarType` names the kind of check
(`recursive depth`, `recursive edge endpoint`, …), so a carrier refused
there reaches the caller as the operation's one malformed-result
`QueryEngineError`, as a malformed ordinary row does (except as a member of
a `$transaction([...])` array on a batch-only transport: the array owner
parses that member's result and, like an ordinary malformed member, it
surfaces as `QueryError` V2001); the FK-cycle refusal, a property of the
data, is its own `QueryEngineError`. The output key
`_distance` has one producer:
`prepareProjection` refuses a scalar or a relation of that name beside a
distance in either order, and `relationShape` refuses a recursive `_distance`
slot whose repeated node selects a distance (the schema-only mirror is
`result/result-shape.ts` `addSelectedRelations`). Measure
statement/bind/provider-row/output growth separately from source-derived
occurrence and transient-copy counts; do not invent an allocation metric API.

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

A generated increment key travels through the batch in the exact identity
scratch (`OperationContext.insert`, the batch arm): the dialect stores it from
the statement that produced it — PostgreSQL through its own RETURNING inside a
data-modifying CTE (`batchRefs.storeReturning`, D-50, offered only while
`capabilities.supportsCteWithMutations` holds), SQLite and MySQL through the
statement-local last insert id (`storeLastInsertId`); the dialect states the
statements in order as `batchRefs.storeInsertedKey`, the engine queues them
and chooses nothing — and every later
statement OF THE SAME DISPATCHED UNIT reads the reference back with the key's
own width (`bigint` keys cast as BIGINT); a later SEGMENT binds the value as a
literal instead, because the scratch died with the unit that made it (D-58). The refusal "G1 atomic output requires exact identity scratch
or segmented RETURNING" is left for a produced field that is not one increment
key on a provider whose RETURNING cannot be segmented; do not widen the scratch
to other produced columns without a ruling.

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

## Parity lane Q — admission, lowering, preparation, assignments, decoding

These are the invariants the D-16 parity units U1–U5 restored (the plan is
`docs/architecture/raptor3-parity-plan.md`; the lane note with every receipt is
`docs/architecture/raptor3-evidence/g4/parity/lane-q-note.md`). They are
contracts from here on.

**An admitted payload is a complete fact; no preparer re-reads public syntax.**
An empty filter object is not a filter: every scalar filter object refuses a
payload that names no operation (`validation/scalars/negatable-filter.ts`), the
JSON filter refuses one that carries only `path`/`mode` and an inert
`insensitive`, and every relation filter that spells quantifiers — to-one,
to-many and the polymorphic COLLECTION — refuses a payload that names none of
them, in its own registered sentence. `where: {}` still matches everything — the rule
is about a FILTER, not about a `where`. A JSON `path` is parsed into segments
at admission, in both spellings, with the six grammar refusals and the one
portable-path rule asked on every dialect; the preparer consumes segments only
and the SQLite adapter's throw stays the defensive backstop it says it is.
`groupBy`'s `by` is admitted as an array, a duplicate member and a grouped
column named like a selected aggregate are refused there, and a default-only
row under `skipDuplicates` is refused wherever the `createMany` verb is
admitted — root, nested in a create, nested in an update, and a polymorphic
collection group. At admission the
subject is named by the ValidationError's issue PATH, not by the sentence: the
per-scalar filter objects are interned per scalar type and cannot know which
field they are validating. A relation filter's schema IS per relation, so those
three sentences keep the slot name.

**A lowered mutation's correlation names the table the statement mutates.** The
unaliased UPDATE/DELETE target is addressable only by its NAME, so
`lowerMutationLimit` lowers its selector with that name and declares it as the
statement's mutation target; a bare column inside a correlated `EXISTS` binds
to the CHILD table wherever both carry the name. The same threaded fact hides a
subquery over the mutated table behind a derived table where
`supportsMutationTargetInSubquery` is false (MySQL ERROR 1093). A raw `Sql`
operand is parenthesised at the one operand owner: a caller's fragment is an
expression, not a token.

**A refusal that classifies the REQUEST is raised before one that classifies
the PROVIDER.** The cursor-eligibility fact reaches the one order walker, so a
`_distance` sort key raises the cursor sentence before `distanceExpression`
consults `supportsVector`; `Queries.page` remains the single raise point for
every other non-scalar key, and the sentence is stated once.

**Polarity is a preparation fact.** `prepareWhere` threads it, each `not` flips
it, and a relation arm's existing `inexact` fact IS its polarity — `none`,
`isNot` and `every` consume their nested predicate under a negation. A bounded
POSITIVE GeoPoint `distance` carries `probe: true` and lowering prepends the
adapter's `withinBounds(geoBoundsForDistance(…))`: the box is implied by the
comparison, so it is a conjunct the provider can answer from the spatial index,
and a conjunct of a NEGATED predicate is a different question.

**A prepared projection always names at least one column, and what it names is
what the caller asked for.** An explicit empty or all-false `select` is the
registered refusal; an empty DEFAULT projection takes the `EMPTY_ROW_RESULT_KEY`
sentinel (a row still exists); a `_count` that counts nothing contributes no
field. A grouped read computes its `by` SET once and hands it to `prepareHaving`
and `groupOrderTerms`, which own the two registered membership sentences. A
tagged polymorphic `_count` filter SELECTS an arm — `where.type` first, then
`is`/`isNot` against that arm's target — and is never a scalar predicate over
one of them; `countedMemberships` publishes the carrier fact it already
computed so nothing classifies the slot twice.

**`Queries.prepareUpdate` is the ONE interpreter of an admitted update
payload.** `Assignments` stores that payload verbatim — it is what the row's own
write submits — and the value inside a `{ set: … }` envelope is read lazily, by
the key-reconciliation readers only (`known`, `equal`, `requireLiteral`,
`stated`, which `CommandAttempt.read` consumes). The envelope exists only in the
update language, so a CREATE's document spelled `{ set: … }` is that document.
Unwrapping at storage time made the one interpreter run twice, which is
`Unknown update operation: z` for a JSON document and a silent rewrite for a
document that carries its own `set`. The physical owner reads the payload with
the SAME question and never a shape test: `OperationContext.update` asks
`wholeValue` whether the payload NAMES a value, and only a payload that names
none — an OPERATION the provider computes — travels through the batch scratch
or meets the scratch's `int`-only refusal. That update PUBLISHES what it
OBSERVED, never what it submitted: the scratch expression and the `RETURNING`
row, with every other field's value stated by the payload through
`Assignments.stated`, so no envelope can reach a dependent as a value.

**A projected scalar's physical form is stated once per (leaf, carrier).**
`carriedValue` consumes the fact `projectedColumn` produced, in the SPELLING it
produced: a decimal scalar crosses a JSON window as a text cast and a decimal
LIST as the adapter's decimal array projection (`CAST(x AS TEXT[])` on
PostgreSQL), because its codec reads an exact value only from that spelling.
Stating the scalar spelling for both is a `numeric[]` arriving as the array
literal `{1.00,2.00}`, which the list codec refuses. **The transport is asked about a value exactly once, at the row
boundary** (Arnaud's D-17): `Queries` holds the driver's `DriverResultParser`
and `decodeScalar` runs driver → adapter → codec for a value the provider
handed over directly, and never for one a JSON window already decoded.
**And about a RESULT exactly once, at the operation's own boundary** (Arnaud's
D-28, the other half of the same contract): `Queries.decodeResult` runs the same
chain one level up — driver `parseResult` → adapter `parseResult` → this
engine's decoder — for the raw rows the operation's terminal statements
answered. It is asked once per OPERATION, never per statement and never per
member: a terminal or a grouped insert split across several windows is a
BIND-BUDGET split of ONE projection, so every window decodes against the same
shape. `publishedProjection` is that boundary's one shape, and its callers are
the terminal boundary (`publishedTerminal`, which serves the live read, the
prepared read, and the batch or live terminal whatever its window count) and the
three set-mutation publications that answer through RETURNING. A set mutation
that publishes an affected-row COUNT instead of rows is not asked: a row count
is a fact of the transport, not a result window. **A window's ROW COUNT is the
one fact it does not share with the operation**: `selectSeries` stamps each
bind-budget window with its own identity count and its own registered refusal,
so `Queries.assertExpectedRows` owns that fact and `publishedTerminal` asks it
per window, on the rows the provider answered, before the middleware is asked
anything — a count taken over the concatenation would compare a whole terminal
with one window's contract, could not raise the short window's refusal at all,
and would judge a middleware that legitimately replaced the operation's rows
against a physical window count. The
decoder owns the JSON VALUE DOMAIN (`bigint` → number when safe, non-finite and
sparse refused, prototype-safe rebuild) and never re-parses. The SQL NULL and
the absent column are answered on the RAW value, before any representation
rule, so a provider that decodes `'null'` into the JSON null document still
writes a NOT NULL `json` column. Object shapes carry nullability — a carrier the
statement always builds cannot decode as `null` — members are read with
`Object.hasOwn`, and the decoder's structural failures are
`InvalidScalarResult`, which `run` publishes as the public `QueryEngineError`.
**And the member LIST of a decoded document is the PROJECTION's fact, not the
row's** (P1, ruling D-61): `prepareProjection` states `shape.fields` once and
freezes it, so `decodeValue` writes the document by walking the shape it already
holds — `Object.keys(shape.fields)`, OWN keys only, exactly as it READS the
provider's — and never rebuilds the members as PAIRS, nor the document around
them, per row. Exactly one array is still allocated per decoded document, the
shape's own key list (FC-05's correction of P1's claim); giving a shape its own
frozen member list would remove that one too, and it is an unmeasured candidate,
not a rule, because no `{ kind: "object" }` shape owns such a list today and
adding one is a mirror at every shape builder. The member write is a plain
assignment because the destination key is a schema identifier
(`schema/identifier.ts`'s `isValidSchemaIdentifier` refuses every own property
name of `Object.prototype`, `__proto__` among them, and `schema/hydration.ts`
asserts it over a model's whole shape at hydration) or one of this engine's own
`_`-prefixed carrier names — the same write the shape BUILDERS take. Rebuilding
the list per row through `Object.entries` + `Object.fromEntries` carried 49 % of
the D-28 cell's CPU and 2.5x the shipped engine's bytes per row
(`docs/architecture/raptor3-evidence/g4/release/p1/note.md`). Do not put it
back, and do not answer a decoder cost by compiling a per-shape decoder beside
the shape: that is a second authority on the projection, which is what this
engine replaced.
**And a `json` FIELD's own output schema runs at that same boundary** (Arnaud's
D-33): `s.json().schema(…)` is a Standard Schema the caller wrote, the engine
replaced ran it on every read (`result/ResultParser.ts:721` into
`scalar-structured-parser.ts:78`), and the accepted cost is one run per JSON
field per row read. The fact travels on the projection's own leaf —
`Leaf.jsonSchema`, filled once per (adapter, model, field) by `Queries.leaf`
beside `decimal`, `dateTime`, `enumValues` and `dimension` — so nothing walks a
projection looking for JSON columns, and `decodeScalar`'s `json` arm asks it
once per VALUE: the JSON value domain, then the schema, then the value domain
again over the schema's OUTPUT, which is what keeps a transforming schema's
answer inside the domain and prototype-safe. The engine is only the CALLER:
`parse` (`validation/index.ts`) is the estate's one owner of that protocol —
asynchronous schemas refused, a throwing schema caught, a malformed result
refused — and a refusal is `InvalidScalarResult("json", "custom output schema
rejected the value")` with NO issue detail, because those messages describe a
STORED document. The cache route materializes from its snapshot, which holds
the DECODED value, and therefore must never run the schema a second time.

**A polymorphic membership the parent claims whose row is gone is refused, not
read as absent.** A variant ROW carrier's arm is lowered as "claimed ⇒ a
document, which is EMPTY when the row is gone; unclaimed ⇒ null", and the one
decoder that owns the arm shape refuses the empty one from the arm's own
selected keys — no private carrier column (Arnaud's D-19). The COLLECTION
orphan and the duplicate singular inverse are answered by a PROBE outside the
arm's row subquery (Arnaud's D-26), stated below.

**A membership is a fact about the junction, so it is probed on the junction.**
A junction-carried variant slot emits ONE correlated integrity probe per
CONFIGURED member — `COUNT(*)` over the member table whose target row does not
exist — beside the arms and outside their row subqueries, so it is answered
whatever `only` selected, including nothing at all: `only` selects what is READ,
never what is TRUE. It rides the slot's own document under
`result-aliases.ts`'s `POLYMORPHIC_COLLECTION_ORPHANS_KEY`, whose leading digit
is what keeps it unreachable for a variant of the same name, and the ONE decoder
arm that already owns the sentence refuses it before any arm is decoded
(Arnaud's D-26). A SINGULAR polymorphic inverse gets the same treatment for the
other integrity fact: its membership count is a sibling scalar subquery ahead of
the row window's `WHERE` and `LIMIT` — which is the only place it can be
answered, since a target filter or the `LIMIT 1` hides the second member — and a
count above one emits a JSON ARRAY where the leaf owes one row object, the shape
the decoder already refuses by name. Existence and membership are execution
semantics (rule 4), so neither is a payload question, and an ordinary pair
table's bytes are unchanged.

**A private alias is not a contract.** The cursor predicate's carrier prefix has
one home, `result-aliases.ts`'s `CURSOR_CARRIER_PREFIX` (Arnaud's D-21), which
the engine and the ordering behaviour module both read; a witness that needs the
statement's outer alias reads it out of the statement it just captured.

## Parity lane X — execution, membership, races, route seam

These eight invariants were restored by the D-16 parity program
(`docs/architecture/raptor3-parity-plan.md`, decisions D-17..D-24), each against
a red estate cell. They are contracts from here on.

A junction side is chosen by the asking SLOT, never by the model. A self
junction names one model on both endpoints and only its two fields tell the
directions apart, so `buildMembershipView` orients with
`opposite === edge.endpoints[1]` — the same identity the foreign-key arm two
lines above it already uses. Deriving the orientation from
`topology.source.model === source` is true for BOTH legs of a self relation and
silently answers the wrong collection.

A nested relation mutation creates a PLANNING READ only when its physical form
cannot express the operation as one correlated statement. A nested
`updateMany`/`deleteMany` on a ROW-HELD membership whose payload names no
relation is one `set` command — one statement, `WHERE fk = parent AND filter`,
no lookup, no `SelectedSeries`, no capture (rule 6's "keep scalar bulk work
set-oriented", the shipped `RelationWritePart.buildUpdateMany`/`buildDeleteMany`).
A junction member set and a relation-bearing `updateMany` still capture, because
one statement cannot express them. The `set` command is a WRITE with no read: it
registers the unknown row-set footprint the shipped `appendTarget(unknown)`
registered, so a LATER read of the same model is still analysed against it.

**An invariant is not a refusal (N4, D-52).** A refusal is a sentence a
caller can reach with an admitted payload and is a `VibORMError`; an
invariant is a state the code cannot be in when it is right, established
upstream by a type or by an earlier owner, and is `EngineInvariantError`
(`shared/invariant.ts`: `assertInvariant(condition, message)` states the fact
in one place; `unreachable(value: never, message)` closes a `switch` over a
closed union so the compiler proves the arm). The refusal census
(`scripts/raptor3-refusal-census.mjs`, its N4 report under
`docs/architecture/raptor3-evidence/g4/release/n4/census.md`, which predates
the recursive feature; the recursive-query gate's last run is
`docs/architecture/raptor3-evidence/recursive-query/gate-3/census.log`) tells the two
apart by CLASS, never by message text; D-54's recursive-read fit, its last
private fit, became the public `recurse` option, and its sentences are counted
with the public ones. Do not add a second enumeration of an admitted
vocabulary inside a lowerer to close a union the admission already closed —
where the type cannot say the invariant, the class carries the distinction.
A declared field named like a combinator (`AND`, `OR`, `NOT`) is that field:
validation lets the model's own entry win the key, and `Queries.combinator`
reads `where` and `having` the same way.

**A dependent read is an ordered observation (N1, D-51).** A nested lookup
whose answer an earlier write of the same operation can change — the overlap
the dependency pass computes in `checkPair` → `readTarget` / `readMembership`
(disjoint, equal, unknown) — is taken at its consumer's execution point, after
that write; the pass spends the fact on placement (`Commands.depend`), not on
a refusal. Execution order is the run order of `CommandExecution.run`: the
`before` children, the record's own write, the captures, the `after` children,
each in body order — where the body order is the relation body's canonical
verb order (`mutationOrder`, `collectionMutationOrder`: a to-many runs
`disconnect, delete, update, upsert, connectOrCreate, set, updateMany,
deleteMany, connect, create, createMany`), relations in declaration order,
and each payload ENTRY of a verb is its own mutation with its own origin (a
set's targets share the set's). The write's and the read's execution points
are the two children of their nearest common ancestor on each path; a
membership contribution executes with the record whose fields carry it (a
parent-held choice publishes the parent's key for the parent's own UPDATE);
the read's point is the occurrence that RUNS it — its early `before` lookup
or its `capture` when one is placed. A mutation never depends on its own
effects, which stand behind its read by construction. A read already behind
its write is marked `Selection.dependent`: on the live route nothing changes
(sequential dispatch already answers it); on the batch route `runSelection`
reads it through the barrier — `OperationContext.flush`, which submits the
queued unit and reads in the same native batch, behind the writes; its
trailing premises step aside as for a planning read (they protect writes not
yet queued) while the premises stated ahead of the queued writes ride with
them, and what the consumer requires of the row rides that batch as a premise
ahead of the read (`ObservationPremise`: the row present, or — an upsert's
found requirement — no row outside the membership, `Queries.outsideWhere`,
NULL-safe), so a target that is not what the consumer needs aborts the batch
before anything commits. The consumer's write then follows in the next batch
— a committed segment on a batch-only transport, D-51's succession of
statements, after which D-25's recovery is gone (`committedProgress`) and a
later integrity failure leaves that segment durable, reported as progress. A
read that would run first — a `before` lookup, a capture, a parent-held
choice whose subtree reads what the parent's own write changes — moves to the
`after` phase, to its consumer's execution point: behind the write, ahead of
the first `after` effect of its own or a later mutation by origin order
(`Link` and `Removal` carry theirs). The one shape no order satisfies is a
read the ancestor's own write CONSUMES (`Assignments.consumes`: a parent-held
target's key, the retired engine's "vacate then supply" answer) — it keeps
the inherited sentence "depends on an earlier … write … Split these
operations", which now names exactly that: an earlier write the read cannot
follow. What a membership read depends on: for a junction, any link, removal
or member set of the same junction table (either side, any parent — a
self-referential inverse is the same rows; the overlap is not computed finer
than the table, because an observation costs a placement, not a refusal); for
a reference, a record write of the member side's foreign key or of the
parent's own referenced key (a key transition, a self-held key); a CREATE
whose written literal for the member-side key — followed through its
producer to a known or located identity, `literalOf` — is null or another
parent's key makes no member of this parent and is disjoint, while an UPDATE
of that key may take a member out and is observed whatever it writes. At the ladder, the one premise that cannot be
re-probed after the rollback is a premise stated over a value this unit
PRODUCED — an observation's requirement bound to the batch reference scratch,
which the rolled-back transaction took with it (`AssertedPremise.readsBatchReference`,
DERIVED at one owner, `OperationContext.readsBatchReference`, for every
assertion a unit carries — its own premises and the continuation guards alike,
though since D-58 only a premise stated INSIDE the unit that made the scratch
can bind it, because a guard rides a later segment and binds a literal,
N5); every other premise is re-probed,
and when every premise ahead of the unit's writes holds now and exactly one
stands behind them, the ladder attributes that one, so the refusal keeps its
correlated identity on an index-free transport. What a placement may still
move is decided per PAIR, by the ancestor's own execution position: `depend`
moves a child while that ancestor has not been entered by
`CommandExecution.run` (`CommandExecution.started`) — true of every freshly
expanded series member, false of the retained record that is running the
series (FC-01, addendum below). The
array route keeps refusing a member that needs a dynamic read (D-46,
`preparesBatch`). Pins: `tests/raptor3/g4/parity/ordered-observation.test.ts`.

**Addendum (FC-01, 2026-09-21): the execution-position rule above replaced an
operation-global veto — "once members are expanded (`Commands.expanded`)
nothing moves any more" — which was FALSE of a series' own members; the flag it
named is gone.** Template analysis places the TEMPLATE's occurrences; `captureSeries`
then builds each member afresh from the admitted payload, and a fresh member's
internal reads were never placed by anyone — so the operation-global veto
refused under `updateMany` the ordered observations `update` executes (the
closure review's executed failure). The rule is the ancestor's own EXECUTION
POSITION: a placement is a position in `ancestor.children`, so `depend` may
still move a child while that ancestor has not been entered by
`CommandExecution.run` (`CommandExecution.started`) — true of every
freshly expanded member, false of the retained record that is running the
series — and the surrounding tree keeps the refusal exactly where it was
already running. Nothing else changes: cross-member placement is still none of
the pass's business (`isSeriesMember` stops the SIBLING scan at the series in
both pairing walks — they still continue above it — so the member that
OBSERVES still claims the earlier member's boundary), a series occurrence
is still expanded once, and the consumed-parent shape still keeps the
inherited sentence. Pins:
`tests/raptor3/g4/parity/fresh-member-placement.test.ts`.

**A transport fact has its own witness per driver (D-53).** PGlite establishes
PostgreSQL SQL behaviour and no driver's TRANSPORT. Three facts are the
transport's, each read from the driver's OWN declaration: SESSION LIFETIME —
does a scratch reference survive from one dispatched unit to the next
(`pinnedSession` / `_canPinSession`, `drivers/driver.ts:201`), which D-50's
batch reference table needs, a TEMP table belonging to a session; FAILURE
ATTRIBUTION — does the transport name the statement of a batch that failed
(`statementIndex`, produced by the shared per-statement loop at
`drivers/driver-transaction-base.ts:659`, and re-derived by CARDINALITY alone
in `findUniqueExecutionContextIndex` when a native batch rejects the whole
request); COMMIT CERTAINTY — is a failed batch guaranteed to leave no writes,
and does the transport identify the durable commit before results are decoded
(`supportsOrderedCommittedSegments`). The question reaches only the drivers a
nested write SEGMENTS on — the standalone physical batch route a driver takes
when it declares no interactive transaction (`usesBatch`'s standalone arm,
`operation-context.ts:389`; its other arm, the array route's
`batch-preparation`, never dispatches a segment because `submit` refuses it,
`operation-context.ts:1261`), so Neon HTTP and D1 and nothing else; every other driver runs the same write
inside one interactive transaction, where one session is the construction. A
driver without a witness for a fact is UNQUALIFIED for every behaviour that
depends on it, and SESSION LIFETIME is the one that no longer has a dependent:
no scratch reference crosses a segment any more (D-58, below), so the table's
"unqualified for a cross-segment scratch" verdict for Neon HTTP and D1 is
qualified on the fixture and stays UNVERIFIED live. Never move a
capability flag without a live witness; a credential-gated one names its
environment variable and skips when it is unset, never fails and never asks.
The table of driver × fact × witness lives in that note, §2, and only there;
this paragraph is the rule. Pins:
`tests/raptor3/g4/parity/transport-witnesses.test.ts`,
`tests/raptor3/g4/parity/transport-seam-pglite.test.ts` (live PGlite), and the
credential-gated `tests/providers/hosted/neon-http-transport.test.ts`.

**D1 addendum (2026-09-24).** A fourth transport fact, TEMPORARY OBJECTS (D1
refuses `CREATE TEMP TABLE`), is recorded with its driver rows and witnesses in
that note, §2, addendum. Unlike the three above it is not read from the
driver's own declaration: the driver passes it to the adapter it builds, and
the adapter spells the scratch DDL; the engine reads nothing new.

**A value crosses a segment as a LITERAL, and every unit owns its own scratch
(D-58).** The D-50 batch reference table is a session-scoped temporary wherever
the transport admits one (on D1 it is an ordinary table, d53/note.md §2
addendum), so its rows belong to the DISPATCHED UNIT and not to the operation: `ensureScratch` mints
one per unit, and `submit` — the one place that assembles a unit and knows
where it ends — reads back every value that unit stored (one `SELECT` per
value, asked of `Queries.scalarQuery`, the composition every scalar this
engine publishes is read back through) and then deletes the unit's rows,
inside the same batch.
`TransportAttempt.carried` holds the literals beside the scratch id, and
`CommandAttempt.read` — the estate's ONE reader of a field's runtime value —
answers the literal in place of the spent expression, so every later statement,
premise and terminal read binds it exactly as a spelled key would. A membership
continuation therefore STATES its query when its guard is built and not when it
is declared (`Continuation.state`, `MembershipParent.where`): a guard rides a
LATER segment, and a query built at declaration time would name the spent
scratch. The operation's terminal statements are the one unit with no next, so
`finishTerminals` closes the scratch there and reads nothing back — a
one-segment nested write costs exactly what it cost before D-58, and a unit
that crosses a boundary costs one SELECT more. There is NO transport branch:
a session-keeping driver runs the identical statements, which is why the same
payload passes on `BatchOnlyDriver` and `SessionlessBatchOnlyDriver`. Do not
re-introduce a reader of `pinnedSession` in the engine, and do not let a
statement name a scratch its own segment did not create. Pins:
`tests/raptor3/g4/parity/transport-witnesses.test.ts` (the three D-58 cells).

**FC-05 addendum (2026-09-21): how the read-back above reached that owner.**
`referenceProjection`, which the paragraph named until this unit, is deleted.
`submit` asks `Queries` for the
scalar-expression query directly: the field's own physical value (`fieldValue`)
aliased to the field, read back through the field's own leaf (`scalarShape`) —
the composition `grouped` and `junction` already state for every scalar they
publish. Preparing a whole user projection to borrow a one-field shape was the
detour, and `Queries.lowerProjectionValues`, which existed only for it, is
deleted with it. Statement count, scratch lifetime, the one-SELECT-per-value
rule and the no-transport-branch rule above are all unchanged.

**The key a provider without RETURNING must already know (M1, D-57).** A driver
whose adapter declares `supportsReturning: false` cannot read back the row its
INSERT wrote, so the engine NAMES that row from what it already holds, and it
holds three things: a key the payload SPELLED, a key the ORM itself produced in
JavaScript at admission, and ONE column the PROVIDER generated and then reported
for the statement that produced it (`insertId` / `LAST_INSERT_ID`,
`OperationContext.insertIdField`; its width is D-50's). The second is the one
worth stating, because it is a schema fact and not a transport one: every
generator except `increment` installs a default CLOSURE
(`schema/scalars/common.ts`'s `generatorDefault` — `uuid`, `ulid`, `nanoid`,
`cuid`, `now`, `updatedAt`, and `s.string().id()`'s own ULID), `.nullable()`
installs `null` and `.default(v)` installs `v`, and a scalar that is neither
defaulted nor optional MUST be supplied (`validation/model/core/create.ts`'s
`mustBeSuppliedOnCreate`) — so a scalar absent from an ADMITTED create payload
is an `increment` column and nothing else, on every create route alike (root,
nested, the upsert's create arm, `connectOrCreate`, `createMany`, a nested
`createMany`). A provider-side DDL default (`gen_random_uuid()`, `NOW()`,
`CURRENT_TIMESTAMP`, written by the migration drivers) is therefore never the
value a row receives: the statement always spells one. There is no builder
spelling for "let the database compute this", so nothing on a non-RETURNING
provider is observed ahead of its INSERT — `SELECT UUID()` would be an ordinary
N1-style observation if a column could be routed to it, and an AUTO_INCREMENT
cannot be: the catalog's next value is a statistic, not a reservation (two
readers are handed the same number). What follows is the exact reach of the two
refusals `Raptor 3 interactive output requires RETURNING or one generated
increment field` and `Driver 'X' cannot locate one selected createMany row after
insertion`: ONE shape, a model with MORE THAN ONE generated column among the
fields the operation must know, which is also #16's shape on the batch route
(D-55). A compound key of a spelled part and one generated part is named; of two
generated parts it is not. No schema this ORM can PUSH to MySQL holds that
table — MySQL is the only `supportsReturning: false` adapter and refuses a
second AUTO_INCREMENT column at DDL time (errno 1075, SQLSTATE 42000) — but the
guard reads the DECLARATION and the adapter capability before any statement is
emitted, so a schema that declares two `.increment()` columns among the fields
the operation must know reaches both sentences on the shipped mysql2 driver
against a table the ORM did not create, or before any push; both are measured
on a capability-forced transport and on the live lane. Do not widen `insertIdField` to a second column
and do not add an adapter seam for a default expression without a ruling: the
first needs a provider that names two, the second a schema spelling that does
not exist. Pins: `tests/raptor3/g4/parity/generated-key-reach.test.ts` and the
credential-gated `tests/providers/docker/mysql2-generated-key.test.ts`; the
measurement is `docs/architecture/raptor3-evidence/g4/release/m1/note.md`.

**The gate's mechanisms (N5).** The retired engine's contract suites are the
gate; every cell that pinned a retired physical detail or a retired refusal is
re-expressed to the shipped answer with its ruling named (D-15 the scalar
RETURNING fold only, §7.2 the `q0` alias, G3P-04, D-46, D-51), and every
mechanism defect is repaired at one owner. A member's boundary is the MEMBER's
and a dispatch commits the whole queue: on a batch-only transport the
packaging boundary `executeMember` would take at a member's end is DEFERRED
while an enclosing write waits (`TransportAttempt.holdsWrite` states the one
distinction the queue makes — a premise commits nothing, everything else is a
write), so a nested `createMany` of literal rows rides its parent's segment
and a duplicate key rolls the operation back as the interactive route does;
and the boundary a later member's OBSERVATION needs is taken by the observing
member (`OperationContext.answer`, the one read outside the queue, when
`holdsOtherMemberWrite` says another record of the series left a write
waiting) — never dropped. D-51 admits that succession of segments as
packaging for the ANSWER: an observing series that fails after its
observation leaves the committed prefix on the batch route where the
interactive route rolls back, the pin states both. One captured pair is one slot transition: two entries that
resolve to the same target carry the same captured owner, `link` spends the
vacate once per pair on both routes, and the direct arm's row-count
postcondition keeps the race it exists for — the first vacate of a pair another
owner took. A target whose membership is stored once — a junction row unique on
the target side, or a reference the target row holds — belongs to exactly one
of the rows an `updateMany` captured, so `connect`, `set` or `connectOrCreate`
naming it across more than one captured row is not executable by any owner:
`captureSeries` states V1's two registered sentences where the captured COUNT
is first known (`exclusiveMemberMove`), which is not ahead of every write: a
capture flushes, and on the batch route a flush commits what is queued before
it, so an enclosing parent's own segment is already durable when the refusal
fires — the two routes answer alike and differ only in what stands committed
behind it (D-51's succession). A `connect` whose located value the parent's own SET
spends carries the row's presence into the write (`lookup.retained`), so a
target that vanishes between the plan-time read and the batch aborts the unit
with the arm's identity sentence (D-29, D-34). A correlated arm locates its
target by the parent's FINAL membership value and its own membership
contribution RESTATES the parent's assignment (`Assignments.restate`) instead of
being judged a second final one; an uncorrelated producer keeps the conflict
refusal. A membership asks whether the producer's create SUPPLIES the
referenced field (`writesField`), never whether its value is a construction-time
literal: a sibling `connect` supplies it from the row it locates, and the
consumer reads it at its own execution point. A CORRELATED arm's value is one
its parent HOLDS, not one its own write requests: the arm's target is the row
the parent's membership already names, so when the arm's write moves the key it
references the provider moves the parent with it (ON UPDATE CASCADE) before the
parent's own statement runs — `Commands.assignMembership` holds it
(`Assignments.hold`) instead of requesting it, and once every `before` child has
run the observation the operation holds of the row is re-addressed from it
(`CommandExecution.run`), so the record's own statement, its later children and
the terminal read all name the row where the cascade left it, every member of a
compound key published, not only the ones the payload spelled. Those three ask
for the row's CURRENT values, one fact read at one owner (`CommandAttempt.read`,
FC-02A); what the operation SAW when it captured the row is a different fact,
kept in `CommandAttempt.rows` for the consumers that need it (a choice's
conditional skip, a `link`'s captured junction pair), and the two are never
substituted for one another. A supplier
earlier in the same body names a different row, and then the row's own
statement is what moves it. PLACEMENT, not verb, decides which key a correlated
lookup names (`RelationBody.correlationParent`): a child-held arm is placed
after the parent's write and names the key that write published; one placed
before it names the parent as it is. A membership read through a field an arm
already moved is an ordered observation of that arm's write (N1), which is what
puts it behind the barrier on the batch route. Pins under
`tests/raptor3/g4/parity/` (`member-boundary-packaging`,
`singular-slot-transition`, `exclusive-member-cardinality`,
`suppressed-membership-target`, `correlated-membership`, `published-key`).

**Addendum (FC-02A).** "The record's own statement, its later children and the
terminal read all name the row where the cascade left it" was true of the
statement and its children and NOT of the read-back a transport WITHOUT
RETURNING has to issue: `OperationContext.update` received the current address
beside the row's ORIGINAL capture and named the obsolete key from it (`UPDATE
did not produce the required record`, reproduced on native MySQL, the one
adapter that declares `supportsReturning: false`). It now takes ONE row — the
values as they stand NOW, read through `CommandAttempt.read` for the model's
keys and for every field the update DEMANDS — and answers all three of its
questions from it: the statement's identity, the batch reference scratch's
arithmetic base, and the read-back's identity. The ORIGINAL observation is a
different fact and stays in `CommandAttempt.rows` for the consumers that need
what was SEEN (a choice's conditional skip, a `link`'s captured junction pair).
Pins: `tests/raptor3/g4/parity/cascaded-current-identity.test.ts` (RETURNING,
non-RETURNING and batch-only) and
`tests/providers/docker/mysql2-cascaded-identity.test.ts` (the native
non-RETURNING transport).

The value a parent-held `connect` writes into its own SET is read WHERE it is
spent: a scalar sub-select over the arm's own prepared selector inside the
mutation (`Queries.locatedValue`, hidden behind a derived table only where
the dialect cannot read the table it mutates), bound by `CommandExecution.folded`;
the probe keeps answering existence, the branch and the batch premise, so a
probe row that changed under the plan cannot move the written key. A located
target whose referenced field reads NULL refuses by name before any write of
the unit (`folded`: writing the lookup's NULL would disconnect the holder the
payload asked to connect). That arm is the only folded one: every other binds
what the probe read, unchanged — a junction writes its captured pair, and a
`connectOrCreate` FOUND arm spends the bytes its own probe returned, which the
scripted transport replies spell (`tests/raptor3/transport/world.ts`). A
created member re-pins its PARENT in every segment after the one that wrote
it — the parent's identity and the value it holds for the edge, the pair
`captureSeries` states, with that owner's sentence — declared at the INSERT
(`Continuation.declaring` keeps it out of its own segment), because a
membership names its parent by value and a committed segment cannot be taken
back. A decoded identity re-bound as an input crosses the same admission
boundary the payload crossed: a `dateTime` or `date` key captured from a row
is a `Date`, and `Queries.scalarValue`'s temporal arms spell it as the INSERT
would spell a `Date` (`admittedTemporal`, `toISOString`), which addresses the
row wherever the column's stored form is instant-valued and wherever the
payload's own spelling was that one. A TEXT-stored `dateTime` a payload wrote
with a different spelling — no milliseconds, a UTC offset — is kept byte for
byte and is still NOT addressable from a capture: a measured residual, pinned
in `captured-identity-domains` and listed in the unit's note §6, not a repair.
`bigint`, `decimal` and `time` already bind, and no other domain can be a key. The engine's one operation identity per client call is
kept by a nested statement (`statementContext` derives the model, never the
verb), so a probe's malformed-scalar decode names the operation's own verb.
A member takes a segment of its own only where a LATER member must observe an
earlier one's row, and the OBSERVING member is what takes it: a read answered
outside the queued unit (`OperationContext.answer`) dispatches first when some
other record of the series left a write waiting, because the dependency pass
places reads against the template and a series' members carry no template
write of each other. An enclosing write DEFERS the boundary a member would
otherwise take at its own end; it never drops it, and a read taken outside
every member claims nothing (an ordered observation is stated inside the unit
on purpose). The generated transport corpus's script models that packaging
from the rule, not from the spelling of the nesting. Pins:
`captured-identity-domains`, the N1 pin's index-free cells, the E1 and E4
contract files.

**Addendum (FC-02C, 2026-09-21) — the two sentences above about the located
NULL are corrected; the rest of the paragraph stands.** The refusal is NOT the
fold's and does not belong to the `connect` arm: *a concrete reference that
becomes a relation must be representable* is the RELATION's requirement, and
the retired engine states it once with the verb fixed at `connect`
(`write-engine/messages.ts:lookupKeyIsNull`) and asserts it from both a plain
`connect` and a parent-held `connectOrCreate`'s FOUND arm
(`RecordUpdateCompiler.assertLookupKeyPresent`). Narrowing it to the folded arm
let a found `connectOrCreate` write the NULL and DISCONNECT the holder (N5's
recorded residual). It now stands at `CommandExecution.supplied` — the method
that was `folded` — outside the fold's gate: every field a choice supplies out
of its LOCATED row is asked, whatever verb located it and however many members
the reference has, ahead of every write of the unit, and the sentence is the
inherited one, `connect`, because what is refused is the CONNECTION and not the
verb that spelled it. The FOLD keeps its own gate and its own claim unchanged:
that arm is still the only folded one, and every other arm still binds what the
probe read. Two placements this requirement does NOT reach, measured and listed
in the unit's note: a `connectOrCreate`'s CREATE arm supplying its own NULL
(owned by `Commands.assignMembership`, whose `producer` for a choice is the
choice's `select` `Assignments`), and the CHILD-held direction, where the
concrete reference is the holder's parent's own value and is spent by the
member's statement. Pins:
`tests/raptor3/g4/parity/reference-representability.test.ts`,
`tests/contracts/engine/write/parent-held-lookup.test.ts`.

**Addendum (R1, 2026-09-21) — the two placements the FC-02C addendum lists as
unreached are the SAME requirement's, and `CommandExecution.supplied` no longer
exists.** The requirement is not a choice's supply; it is the RECORD's. *All
components needed to represent a connection must be present and non-NULL* is
asked where a concrete tuple becomes the row a provider stores —
`CommandExecution.stored`, over the write values of every record statement —
so it reads the ACTUAL value of each component whatever supplied it: a located
row's bytes, an arm this operation itself created, or the PARENT's own current
value (`CommandAttempt.read`, FC-02A). A value this unit produced into its
batch scratch is asked once the boundary has read it back and not before
(D-58); nothing is admitted, defaulted or transformed a second time to obtain
one. WHICH components to ask is the resolved edge's answer and nobody else's:
`Commands.assignMembership` is the one reader of that edge and now says so on
the value it contributes (`FieldValue.relation`, which replaces the
`membership` carrier that had no consumer). That is why an explicit
`disconnect`'s own NULL is untouched — it is a literal this row asked for and
carries no relation — and why only the edge's members are asked rather than
every field the row happens to demand. FC-02C's two recorded residuals close on
that one move, and so do the child-held `create`, `createMany`, `connectOrCreate`
(both arms) and `set`, measured in the unit's note. The FOLD keeps its own gate
and its old name (`CommandExecution.folded`) and states the requirement a
second time for the ONE arm the record cannot ask about: once a parent-held
`connect`'s value is folded into the holder's SET it IS a sub-select, so the
literal the probe read exists there and nowhere after. The two call sites'
coverage is disjoint and was falsified one at a time — dropping the record's
turns 32 cells red and leaves the plain `connect` green, dropping the fold's
turns exactly the plain `connect` red
(`g4/release/closure-final/r1/receipts/falsify-stored.log`,
`falsify-folded.log`). The sentence, its class and its relation meta are the
inherited ones and the census is unmoved (23 candidate / 75 inherited / 193
sites, identical to `cdd787ac8`). Still untouched: a nested `update` arm that
nulls the referenced column under a live member keeps its provider
`ForeignKeyError`. Pins:
`tests/raptor3/g4/parity/reference-representability.test.ts` (26 cells),
`tests/providers/docker/pg-reference-representability.test.ts`,
`tests/providers/docker/mysql2-reference-representability.test.ts`,
`tests/contracts/engine/write/parent-held-lookup.test.ts`.

**FC-02B addendum (2026-09-21), correcting the temporal sentence in the
paragraph above.** The TEXT-stored residual is repaired and is no longer a
measured limit; the sentence "still NOT addressable from a capture … not a
repair" is superseded. A capture of a TEXT-stored `dateTime` never produces a
`Date` for the engine to re-spell: the row decoder already separates an
INTERNAL read from a PUBLIC one — `shared/decimal.ts`'s `decodeDecimalScalar`
keeps the codec's physical form internally and materializes the `Decimal`
publicly — and `Queries.decodeScalar`'s `datetime` arm now takes that same
seam, because a TEXT column's PHYSICAL value IS the spelling
(`encodePhysicalDateTime(iso, "text")` is the identity). So the captured
identity binds the stored bytes, two valid spellings of one instant stay two
distinct addresses and are never conflated, and the public result is still the
`Date`. `admittedTemporal` keeps its one job — spelling a PAYLOAD's `Date` —
and the numeric storage forms (INTEGER epoch milliseconds, REAL Julian day),
`date`, `bigint`, `decimal` and `time` are unchanged and are measured as
controls. Pins: `captured-identity-domains`, the FC-02B cells (the three
spellings, the two-spellings-one-instant cell, the compound and omitted keys,
the nested-create reference value, the three batch-only to-many cells).

A capture that depends on nothing keeps its place ahead of the effects, and
the reason is MEASURED, not stylistic: a capture flushes, and on the batch
route a flush COMMITS everything queued before it — so a capture placed after
a sibling effect makes that effect DURABLE, and a planning refusal the capture
then raises can no longer undo it (`tests/raptor3/post-prep/g29-dependency-boundaries.test.ts`
measures the committed segment). A DEPENDENT capture pays exactly that price by
design (N1): the earlier effect is what it must observe, and on a batch-only
transport the segment it commits is the succession D-51 accepts, reported as
the operation's progress.

A to-one `disconnect: true` or `delete: true` is LAX (DESIGN §5.3: an empty
slot is a no-op) and an explicit member selector is STRICT (a missing target
is the correlated refusal). The relation body decides it where the payload's
form is known — a lax lookup is not `required` and asserts no batch presence
premise — and the consumers answer an absent selection honestly: a deletion
whose selection bound no row emits no statement, and a lax removal names no
target, so it is the set-based membership clear (N2 of the
nesting-and-refusals plan; admission allows only `true`/`false` for a to-one
`delete`, so the strict form lives on the to-many edge).

A premise about an OBSERVATION is asserted where the observation is taken —
before any write of the unit — never where it is consumed (N3 of the
nesting-and-refusals plan). Initial absence and loss after observation are
distinct facts (ELEGANCE §6, Arnaud's D-32): a lookup's `required` says what
an empty slot means (lax or strict), its `retained` what the captured
member's loss between the plan-time read and the batch means — for a LAX
disconnect or delete target, the raceable membership race, stated once by
`membershipRaceFailure` ("a member was added/removed after the plan-time
read; retry to converge"); for a strict one, which names a row by its
selector, the non-raceable identity sentence, because a recovery would
re-read the selector and act on whatever row answers it now (D-34) — and
`runSelection` asserts `retained` right after the capture. A `deleteMany` series asserts each captured member's presence at
capture, beside `requireNoAddedMember`. The deletion and removal commands
assert nothing themselves: a premise placed after the parent's own UPDATE
would make every rejection "uncertain" on a weak batch and forfeit the one
recovery. On the ladder, attribution comes FIRST: the rejected premise is
found by the provider's statement index, else by re-probing each registered
premise after rollback, else as the sole guard. Where the provider said where
it stopped, that position decides `rejectedBeforeAnyWrite`; where only the
re-probe did, its answer is a fresh-state sentence, not a statement about
the past (a premise found false now may have held when the batch ran), so
the "nothing but premises ahead" claim is bounded by the LAST premise in the
batch — a batch whose own committed write falsified an earlier premise is
never read as having dispatched no write — and only then may D-25's recovery
re-plan. What the bound cannot see, an ordinary statement arriving as the
assertion class behind the last premise with writes ahead of it, rests on
the shipped index-free transports' atomicity (D1, Neon); a transport that is
neither atomic nor indexed owes its own witness (D-53) before the claim is
made there. Two registries answer "was this row's presence premised": a
lookup's own `Selection.retained`, which `runSelection` asserts on the spot,
and `attempt.retained` for a row bound by `capture()` (a series member, the
connect path) whose premise its owner queued directly. A premise the ladder
cannot attribute surfaces as the typed floor (DESIGN §7.3 step 4,
`m8-race-retry`): `NestedWriteError` with the assertion code, non-raceable,
one attempt — never the driver-mapped `NestedWriteAssertionError`.

Within one relation body, a `connectOrCreate` entry whose target an earlier
entry PROVABLY creates is that earlier entry's association: first-create-wins
locally and the later entry adopts the row (`docs/architecture/retired/write-engine-ATOM.md` §12), so it opens no second
decision read, no found guard and no missing race pin — its producer is inside
the same operation. The two facts are `PreparedSelector.uniqueValues` and
`Assignments.known`, the pair `CommandExecution.matchesSelectedConstraint`
already reads together.

The one-recovery allowance is an ATTRIBUTION and PROGRESS fact, never a
transport fact. `OperationContext.recoveryRejection` asks only whether this
standalone operation's exact failed INSERT (or its atomic assertion) is the
error in hand and whether anything has been acknowledged — the shipped
`hasCommittedRecordSeriesProgress` (`write-engine/routing.ts:197`), which this
context states once as `committedProgress`: `committedSegments === 0` and
`!mayHaveCommittedSegment`. It no longer asks `usesBatch`, and — Arnaud's
D-25 — it asks about ATTRIBUTION and PROGRESS only. (This SUPERSEDES the earlier
sentence "it answers `undefined` unless the ownership is standalone AND the
route is the physical batch".)

A rejected INSERT is ATTRIBUTED under the bound its OWN route's recovery needs,
and that bound belongs to the site that RECORDS the producer, never to the
classifier that reads it. `submit`'s attribution arm — the BATCH route, whose
recovery is the interpreter's in-place REPLAY of the tree that ran — records the
producer only while no dynamic member has been admitted: that member's defaults
and transforms already ran once against a row that attempt read, and admitted
values are never produced twice (rule 10), so the producer is simply not
recorded and `tests/raptor3/transitions/recovery-boundaries-live*.test.ts`
(`g2-recovery-dynamic-member-admission`, an `atomic-batch` world) pins the
original `UniqueConstraintError` from there. `insert`'s non-batch attribution
carries no such bound, because the recovery IT feeds re-enters a FRESH region
with a FRESH plan — the shape D-25 does not bound. An ATOMIC ASSERTION carries
none either, and for the same reason: it is answered by a fresh plan over the
same admitted arguments — a new occurrence tree that re-reads committed state —
so the new tree admits its own members, and a series occurrence is still
expanded exactly once because the occurrence is new. Restating any of this at
`recoveryRejection` is a second reader of one fact with no answer of its own to
change.

Which recovery REPLAYS and which RE-PLANS is a fact about the ROUTE, not about
the kind of rejection. Exactly one replays: `CommandExecution.recover`, the
in-place path, available only where this operation opened no region of its own
(`replaysInPlace`) — its `complete` loop re-runs the SAME occurrence tree, which
is why a missing winner there is not permission to attempt the INSERT again. The
other three RE-PLAN, because each re-enters the body `commands/index.ts` builds:
the REGION re-entry (`regionAttempt` — the INSERT recovery on every
transaction-capable provider, the shipped `executeRoutedOperation`,
`write-engine/routing.ts:180-208`), the BATCH re-entry (`batchAttempt`, the
raceable assertion — and RACEABLE is read off the premise, not assumed: only a
failure its own owner marked `meta.raceable` arms the re-plan, which is the
estate's existing rule for this question, so a captured row's own presence
guard, declared `raceable: false`, ends the operation instead of retrying it
against whatever row now answers the selector. What separates the two is
IDENTITY, not observation (Arnaud's D-32): a captured MEMBERSHIP is state the
plan discovered, and the rows a singular-junction transfer connects are the ones
the arguments spelled, so both arms of `captureMembership` — the observed pair
that is gone and the slot read empty that is now held — carry the mark and
re-plan from fresh values, while the captured ROW's presence and the series'
parent premise, which are the caller's own identities, do not. The mark alone
never authorises an attempt: `submit` also asks whether this operation holds
committed progress, so a premise proved in a batch that already acknowledged a
segment — or whose rejection a weak transport cannot place — still ends the
operation) and the ENVELOPE restart
(`run`'s deferred arm, which runs
the body once outside the region and again inside it). A re-plan is safe because
admission is memoised one level above the body — `commands/index.ts`'s
`admitted ??= schema.admit(…)` — so the second tree is built from the SAME
admitted arguments — the ROOT admission runs once; a captured member of a
selected series is admitted again by the re-plan, so a member's own defaults
and transforms run once per ATTEMPT (the shipped whole-operation re-run
behaved the same), and rule 10's "never invokes their transforms again" bounds
the in-place replay, not the re-plan (ledger D-30); the
first attempt consumes the plan that answered the envelope question, and any
later one builds its own.

The allowance is spent by the owner that opened the region the rejection
destroyed, and the re-entry carries this operation's own attribution and
correlation id unchanged — an aborted transaction answers no further statement,
which is why a region's recovery is a FRESH one and never a replay inside it.
`CommandExecution` keeps the ONE replacement method for both attempt regions;
the allowance itself is the CONTEXT's (`spendRecovery`), answered once and
`undefined` ever after, because a re-plan builds a new interpreter and a new
interpreter must not bring a second allowance with it. A missing winner still
propagates the original rejection and never authorises another INSERT.

A captured member set is an assertion about every row that is NOT in it. On the
batch route a selected series with a membership edge queues one raceable
`requireAbsent` over "connected ∧ filter ∧ key ∉ captured" in the same batch, so
a member committed between the plan-time read and the atomic unit ABORTS that
unit instead of being silently missed (rule 5, "never cache observed absence");
the one recovery above then re-plans against the larger set and converges. The
guard is the captured set's own negation — it names the keys it captured — never
a second reading of the filter. It rides BEHIND the premise it depends on: the
membership correlates by VALUE, so the series' own parent premise — the one
`executeSeries` asserts for every member — is queued first, at the position
where the captured set is fixed. Without it a parent reference taken over by
another row makes that row's members read as additions to a set they were never
in, and the operation would answer a raceable staleness instead of
`parent record changed across a committed segment`. An interactive transaction
needs none of this: its plan-time read took `FOR UPDATE`.

Addendum (R2c, 2026-09-21, repaired after review), narrowing the sentence
above: the interactive route's plan-time `FOR UPDATE` is what a read takes when
its answer is a row this operation will mutate. A `choose` PROBE is not that
read. It may answer "absent", and the arm it then takes INSERTS the very key it
looked for, so it reads without locking (`Selection.insertsWhenAbsent`, set
where the missing arm exists and consumed by `Selection.query` alone). A lock
cannot protect an absence, and on MySQL asking for one costs the operation its
convergence: a miss on a unique index leaves an X gap lock over the index
supremum, two racers are GRANTED that same gap at once, and the
insert-intention each then requests waits for the other's — the cycle InnoDB
breaks by aborting a whole transaction (`ER_LOCK_DEADLOCK`, measured both ways
in `g4/release/closure-final/r2c/receipts/`). The create arm's arbiter was
never that lock but the unique constraint itself (Pin Rule 2), whose violation
is the retryable signal `CommandExecution.recover` converges on, and whose
attribution `matchesSelectedConstraint` still checks against the selector's own
key. A deadlock stays what the provider called it: `TransactionError` with
`VibORMErrorCode.DEADLOCK`, recovered by nothing.

State plainly what that withdrawal costs, because a statement is chosen before
its own answer is known: the probe reads unlocked in BOTH outcomes, on every
provider, so a row it FINDS is no longer held for the update arm that follows
either. Two readers answer that, and neither is the probe. A CORRELATED nested
`upsert` — one that carries its OWN `where`, which is the to-many arm — states
its found target through a membership confirmation (`foundRequirement`, issued
as `Selection.confirm`) that keeps `forUpdate`: its answer IS the row the found
arm updates, and a row deleted meanwhile makes that read empty and the arm
refuse. A to-ONE nested `upsert` carries no `where`, so nothing builds
that confirmation for it and no such read is issued; it is answered instead by
the demanded target keys the postwave addendum below states. Where no such
confirmation exists — a root `upsert` — the answer is the read the write
already issues of the row it has just written (`OperationContext.update`, the
non-RETURNING stored-row read), which is a CURRENT read for this reason: under
REPEATABLE READ a consistent read answers from the snapshot this transaction
opened plus its OWN changes, so a statement that affected NO row leaves the
snapshot's copy standing and a snapshot read would hand back a row that is not
there, with the update not applied, as a success. It was measured doing exactly
that before the lock was put on it. Never state the protection as "the
plan-time read holds it": say which read is current, and never replace a lock
with a consistent read that cannot see another transaction's commit.
**Addendum (postwave, 2026-09-21, after the integrated review), completing the
paragraph above.** "Two readers answer that" counted the shapes that round had
measured, not the shapes the withdrawal reaches. A third has no reader by
construction: a nested `connectOrCreate` on a CHILD-HELD reference, whose found
arm is the UPDATE that writes the child's foreign key and nothing else. An arm
that asks the provider for nothing back never learns whether it addressed a
row, so `OperationContext.update` issued no read at all — measured on native
MySQL reporting a connection it had not written, after the found target was
removed between the unlocked probe and that UPDATE. The rule: an arm whose
probe did NOT lock its answer (`Selection.insertsWhenAbsent`) demands the
target's own keys. On a provider without RETURNING that is what makes the same
CURRENT stored-row read run and raise `UPDATE did not produce the required
record` (the measured MySQL schedule, the witness cell); on a provider with
RETURNING the arm emits `UPDATE … RETURNING <keys>` and raises `UPDATE RETURNING
did not produce the required record` (exercised on the ordinary path by
`pglite-nested-writes` and `shared-pk-connect-or-create`, not raced). It is
stated once, where
that binding arm is built (`RelationBody.association`), and it reaches only the
arms whose probe withdrew its lock — a child-held `connect`, or a `set`
target, still locks its row and is untouched. Witness:
`tests/providers/docker/mysql2-concurrency-policy.test.ts`, "a CHILD-HELD
connectOrCreate whose found target moves out from under it connects nothing,
visibly".
**Addendum (integrated repair round, 2026-09-21), completing that rule's
reach.** The rule above reaches a THIRD arm, which the round that wrote it did
not count: a nested to-ONE `upsert`. Its create arm withdraws the probe's lock
like any other, and it carries no `where`, so no found membership confirmation
is built for it — its found arm is an ordinary `update` of the probed row
whose payload demands nothing back, and `OperationContext.update` took the
effect path and never asked which row the UPDATE wrote. Measured on native
MySQL before the repair: the operation RESOLVED, returning the renamed parent,
while the profile it was told to update had been deleted between the unlocked
probe and that UPDATE and nothing was written. It is the same rule, at the same
place, stated for the found command that already exists rather than for one
this binding builds. Witness:
`tests/providers/docker/mysql2-concurrency-policy.test.ts`, "a nested to-ONE
upsert whose found target is deleted before the update arm loses nothing
silently".

**Addendum (the shared FOUND-consumption rule, 2026-09-21, after the local
closure review), correcting the three paragraphs above at their cause.** They
counted READERS, and every reader they counted runs AFTER the effect. A read
taken there proves the row still exists. It does not prove the identity, the
membership, the matched condition or the reference that effect just spent were
still the ones the operation was promised, and three native MySQL schedules
measured each of those losses on unchanged source: a holder connected to `b2`,
a row that acquired the referenced key `G` after the probe read it off `b1`
(`ON UPDATE CASCADE`, so no lawful connection to `b1` produces it); a
conditional upsert that wrote `42` after the `count: 7` it matched became `8`;
a nested to-one upsert that wrote a profile after it had been reparented. An
observation is not a lasting requirement (ELEGANCE §6) — and neither is a later
observation of the same row.

So the usual answer is ONE read, taken between the observation and every arm
rather than after the effect: `CommandExecution.confirmFound` issues
`Selection.confirm` — the membership confirmation the correlated to-many arm
already had, with the membership and the condition it proves turned into
arguments. It addresses the located row by IDENTITY, so it can adopt no
replacement record; it keeps `forUpdate`, so under the transaction this
operation is already in the requirement it proves LASTS THROUGH the consuming
effect; and it returns the whole stored row, which then REPLACES the probe's
bytes as this row's binding, so a reference a holder's own INSERT spends is the
current one and never a captured key another row has since acquired. Values
this operation itself produced are untouched: they are read where they are
spent (`CommandAttempt.read`) and nothing here compares against a stale
pre-sibling literal. Where a requirement has been lost the operation raises the
failure it ALREADY owns for that loss — the found membership's sentence, a
`connectOrCreate`'s replacement race, a located target's identity sentence, a
conditional premise's own match failure — and nothing reselects, switches a
selected arm or replays.

One narrow RETURNING path needs no separate read. When the admitted selector is
exactly the complete row key and the immediate FOUND arm is a child-free update
with no membership, condition, transition or assignment input from that
unlocked lookup, the update itself consumes the premise. It returns every
demanded value that survives;
an empty result raises the same deferred found failure. Batch and non-RETURNING
execution, mutable alternate uniques, extended filters and every richer arm
keep the confirmation above.

Three facts this does not change. A probe that may answer ABSENT still locks
nothing, and neither does the confirmation lock an absence: it is issued only
once that probe has FOUND a row and is addressed by that row's identity, so it
never locks the absence the operation is about to INSERT. Where the row has
SINCE gone the confirmation misses — that is the deleted-target family above —
and a locking read whose exact match finds nothing does take the gap in
REPEATABLE READ; what makes that harmless is that the miss raises the arm's own
failure immediately and takes no further lock, so no cycle can form and R2c's
convergence and no-replay policy are unaffected (the whole of R2c stands). The
BATCH route asks for no read here at all — it states the IDENTITY, the
MEMBERSHIP and the matched CONDITION as PREMISES of the atomic unit that
consumes them (`Selection.retained` in `runSelection`, the found record
command's own `requirePresent`, and the condition premises), which are the same
facts proved atomically and abort before any write; the eager
membership read the interactive path used to take for a non-dependent
correlated upsert is gone, because that premise already proves it. And not
every initial selection filter becomes a continuing requirement: D-65's nested
worklist filter remains an admission/capture fact, not a per-member filter.

The readers the paragraphs above named stay where they are, behind this one,
and their unique coverage is nameable: a provider whose select assembly OMITS
`FOR UPDATE` (SQLite, `sqlite-adapter.ts`) takes no lock for the confirmation
to hold, and there the read-back `OperationContext.update` takes for the keys it demands (`UPDATE … RETURNING` where the provider has RETURNING, as SQLite does; the CURRENT stored-row read where it has none) and the target keys `RelationBody` demands of an arm whose probe did not lock are
what answer — witnessed, on that substrate and in that window, by "a target
lost AFTER the confirmation is caught by the reader of last resort"
(`tests/providers/local/sqlite3-found-consumption.test.ts`), which plants its
delete before the first MUTATION of the table rather than before a read: remove
either half and the operation resolves, returning the renamed parent, having
written nothing. Outside that narrow returned-update path, what the rule costs
on the INTERACTIVE found path of an arm whose probe withdrew its lock is one
extra round trip per MATCHED condition
probe — one where the locator is the only requirement, two for an upsert that
carries both `targetWhere` and `setWhere` (`confirmFound` confirms the located
row once per condition probe, each through that probe's own narrowed selector).
Not on a miss, not on the batch route, and not for an arm whose probe still
locks. Witnesses:
`tests/providers/docker/mysql2-found-consumption.test.ts` (the three schedules,
a real lock-HELD schedule, the placements and key shapes, and the controls) and
`tests/providers/docker/mysql2-concurrency-policy.test.ts` §4, whose three
deleted-target rows now plant in front of the confirmation because a plant in
front of the effect would wait on a lock this code correctly takes.

**Addendum (the repair prompt §1, 2026-09-21, correcting the cost sentence and
the latch above).** Outside the returned-update exception, the cost is **ONE**
extra round trip, whatever the arm's requirement is — not one per matched
condition probe. Every matched condition is
a requirement of the SAME consumption of the SAME row, so they are one premise
and one statement: `confirmFound` conjoins the probes that matched
(`Queries.andSelectors` over the prepared selectors those probes already carry,
the locator's base among them) and re-takes the located row once under that
conjunction. Two statements would ask one locked row the same question twice.
What one statement cannot do is name WHICH of two matched conditions a
concurrent commit took away, so the failure is the first condition's — the same
ordering `case "choose"` already speaks with when it reports one unmatched probe
for the skip; exact per-field attribution would need the conditions evaluated
over the confirmed row rather than in its `WHERE`, which no adapter can project
(`g4/release/closure-repair/g1/note.md` §1). Witness:
`tests/raptor3/post-prep/selector-preparation.test.ts`, "reuses one upsert base
selector across both prepared condition probes" — three conjunctions and four
SELECTs before the UPDATE (the locator probe, the two condition probes, the one
confirmation), then the terminal read. And because the confirmation is where an interactive found
arm now first contends, a concurrency test may not latch on the effect BEHIND
it: the competing-upserts interleaving in
`tests/contracts/drivers/behaviors/non-returning-mutation-atomicity-behavior.ts`
latches on the locking read (`isItemLock`, as its root-update and root-delete
neighbours already did), and the lock-HELD control beside it proves the waiter
queues on the holder's `X,REC_NOT_GAP` record lock and then answers over what
the holder COMMITTED.

**Addendum (the repair prompt 2 §2, 2026-09-22, correcting "the failure is the
first condition's" in the addendum above).** One statement still cannot name
WHICH of several matched conditions a concurrent commit took away — and it no
longer claims to. What it lost is the ONE premise it proved, the conjunction, so
that is what it reports: where several conditions were conjoined the sentence
says a MATCHED REQUIREMENT changed and names them as a SET
(`query-engine-v2 top-level upsert matched premise (targetWhere, setWhere)
changed before the atomic batch.`), where before it named the FIRST condition
whichever one had actually gone. Where exactly one condition was matched the
premise IS that condition, and its own precise sentence is unchanged byte for
byte. The failure is decided where the premises are built
(`Choose["conditions"].matched`, the root upsert in `Commands`), so the one
place that raises it (`confirmFound`) states no diagnosis of its own; no round
trip is added to tell the conditions apart, and none was available — asking
after a miss takes further locks after the answer, which is what the
harmlessness argument for a missing confirmation rests on not doing. The BATCH
route is untouched and stays per-field exact, for a reason: there each condition
is its OWN premise statement (one `requirePresent` per probe), so naming the one
that disagreed is a fact that route measured. Witnesses:
`tests/providers/local/sqlite3-found-consumption.test.ts` and
`tests/providers/docker/mysql2-found-consumption.test.ts` — first-only,
second-only and both conditions changing, each asserting ONE confirmation, the
unchanged stored row and no consuming write, beside the single-condition
controls for both spellings, which keep their exact sentences.

**Addendum (the repair prompt §2, what "proved atomically" does and does not
say).** It is true of the UNIT's OUTCOME — a premise that disagrees aborts the
batch before it commits — and not of the window between a premise and the
statement it protects, which under READ COMMITTED are two snapshots of the same
transaction. Where a requirement has to LAST through the effect, the premise is
issued as a HELD read instead (`Selection.captured`'s `held` argument), which is
what a nested captured series now does at each member's consumption position
(the addendum under D-65 above). The found-consumption premises named in this
paragraph keep their unlocked form: no schedule in this tree measures that
window for them, and the note that repaired the nested one names it as a
residual rather than claiming it closed
(`g4/release/closure-repair/u2/note.md` §11).

**Addendum (the repair prompt 2 §1, 2026-09-21, the batch route's half of the
rule — correcting "asks for no read here at all" and the sentence above about
the found-consumption premises' unlocked form).** The batch route still asks for
no READ, and it still states the identity, the membership and the matched
condition as premises. What those premises never stated is the referenced
COLUMN the holder's own statement spends, and on that route nothing re-bound it:
`confirmFound` returned the probe's bytes, so a PARENT-held `connectOrCreate`
spent a literal that another row could have acquired between the plan-time probe
and the batch — measured as a holder connected to `b2` after `b1.code` moved to
`M` and `b2` took `G` (`tests/providers/docker/pg-batch-reference-reuse.test.ts`,
two real connections on the forced batch profile). The answer is the doctrine
this engine already spells for a parent-held `connect`: the value is read WHERE
IT IS SPENT, a scalar sub-select inside the consuming statement
(`Queries.locatedValue`, bound by `CommandExecution.folded`) — but read at the
CAPTURED COMPLETE IDENTITY (`Queries.includeIdentities` over the located row's
key), never at the arm's own selector, because a probe that read unlocked cannot
vouch for a selector a replacement row may since have acquired. Only the
components the HOLDER's own write spends are folded (`spentByHolder`, the one
reader of `Commands.assignMembership`'s own contribution read back), so a
junction's captured pair and a child-held arm's value are untouched. Two things
stand beside it, each with its own coverage: the selection's retained premise is
now a HELD read wherever the probe read unlocked (`Selection.insertsWhenAbsent`
→ `Selection.captured`'s `held`), so a row found by such a probe cannot be
deleted, moved or nulled between the premise and the statement that spends it on
a provider that has a lock to take — proved by a schedule, not a hook: a second
connection's UPDATE of the located row is started after the premise has answered
and is still waiting when the unit's own write goes out. And because the folded
value is a sub-select, the representability requirement
(`CommandExecution.requireRepresentable`) can only be asked of the CAPTURE, so
the same requirement is stated of the row the sub-select will read, as an
ABSENCE premise of the same unit — one per NULLABLE component, each carrying
that component's own sentence, and none at all for a component no schema admits
a NULL in. An absence, so a row that has GONE satisfies it and the loss stays
the presence premise's, with the sentence that premise owns. Nothing else moves:
the interactive route is unchanged, missing-key probes still lock nothing, no
sentence is added, and the uncontended consumption commits its ordinary result
on both batch fixtures.

**Addendum (D-65).** That last sentence names a ROW LOCK, not phantom exclusion:
`FOR UPDATE` holds the members the plan-time read returned, and a member
connected afterwards is a row it never covered. Neither route claims otherwise —
the captured set is the WORKLIST on both — and what the complement buys on the
batch route is the abort-and-converge answer for a member that joined before the
unit, never a promise about every future joiner.

A premise is proved inside the atomic unit that carries the write it protects,
never in an earlier planning batch (Arnaud's D-29). The owner is `flush`, the
one place planning reads become batches: a planning read carries no premise of
its own, so the unit's waiting premises step aside (`withholdPremises`, which
holds the queue's TRAILING premise run and returns it to the head of the next
dispatch), and the read travels with the unit only while the unit is being
dispatched anyway — the values it reads are the ones those statements produce,
which is what a series under a freshly created parent depends on. With nothing
else waiting a planning read is what it is: a read. Proved early, a premise is
answered against a world the write has not reached, and the window every
staleness premise exists for closes before it opens — measured live as the `pg
filtered m2m deleteMany staleness` cell missing its own race. Its companion is
the progress rule: a weak native batch cannot prove rollback by rejecting after
dispatch, but a batch that rejected AT A PREMISE, with nothing but premises
ahead of it, dispatched no write at all — the provider said where it stopped,
and that is the proof. It is what lets the one recovery re-plan on a transport
that acknowledges nothing, and it is asked only where it can DECIDE that
allowance: an operation that has already acknowledged a segment is refused its
recovery by progress alone, and the uncertainty it reports for a later batch
stays the separate fact the estate pins.

A suppressed INSERT suppresses the ROW, not the membership the member declared.
A `skipDuplicates` member whose target row already exists still writes the
membership it declared, against that existing row; on a singular junction that
membership is a TRANSFER, so the member captures the current owner at its own
body position from the key it SPELLS (a `JunctionCapture` with no located
address — the shipped `JunctionTransferAddress.values`), and a later member
naming the same target observes the membership the earlier one moved and is the
exact-pair no-op. A member whose key the provider would generate names the
existing row through the ONE declared unique its payload spells whole — the
shipped `adopt` disposition, E6.8's connectOrCreate adopt
(`junction-create-many-routing.ts:117-131`); two spelled uniques name two rows
and so name none, and a spelled key that names no row writes nothing, because
the row is LOCATED (`locateSuppressed`), never assumed (N5). The MEMBERSHIP, and only it: the member's
nested RECORD writes belong to the row that was never created, so
`adoptSuppressed` replays the membership kinds alone (`link`, `remove`,
`junction` — a `membership` child is always placed `before`, so naming it there
would be a guard with no coverage of its own) — and a member that declares ANY
other effect of its own strands whole, join included, since
`joinWhenTargetExists` is a leaf route no relation-bearing row takes
(`junction-create-many-routing.ts:76-84`) and a skipped root in the series it
does take returned before the member's remaining steps ran
(`OperationExecutor.ts:894`, "if (execution.skippedRoot) return true"). A
`skipDuplicates` member is idempotent against an existing row.

An affected-row count is this operation's answer, not the provider's opinion:
`createMany` refuses a window that acknowledges FEWER rows than were submitted
(`skipDuplicates` is the one shape whose shortfall IS the answer), and does not
police a count ABOVE it, which a duplicate clause or a trigger may legitimately
report.

The DRIVER owns a prepared query's identity. Both internal snapshots of a batch
query carry it through `transferPreparedStatement`, because when observers are
installed the driver DEFERS the statement transform and registers the typed
`Sql` against the object it returned; a snapshot that drops the provenance
silently drops every deferred transform.

The owner that opens a region is the owner that states what its phases proved.
`region()` binds `readyToCommit`/`committed` onto the attribution whenever this
operation carries the client's write-outcome rail, and `withinRegion` maps the
phase the region REACHED onto the failure — `committed` or `may-have-committed`
— attaches it with `attachCommitCertainty`, notifies the matching seam through
`stateWriteOutcome` (which retains a listener failure beside the operation's
own), and notifies `committedSegment` on success. A driver that never separated
commit from success reports no phase and this operation then says nothing; the
route's `!outcome.published` fallback is unchanged.

One preparation answers both array-owner arms. `prepareSingle` publishes the
package for any verb whose plan is ONE statement — the `single` admissibility
`Commands.plan` already states — so a one-statement write is parsed through the
owner's own `parseResult` seam and interceptor onion instead of through the
batch. It is the same package `prepareBatch` would publish, not a second
preparation.

A capability a form NEEDS is asked once, on the construction path, before the
operation's first statement: `OperationContext.requireAtomicUnit`, asked by
`run` exactly when the physical-envelope rule has already ruled the form out of
one statement. A driver with neither transactions nor batch has no atomic unit,
and a batch-only non-returning driver cannot resolve a single-row mutation's
identity inside its own unit. One class (`TransactionError`), one
`meta { driver, operation }`, the two registered sentences, and no provider
dispatch — the position of the shipped `assertRoutedAtomicResolution`.
